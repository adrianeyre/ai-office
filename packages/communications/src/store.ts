import {
  communicationsAgent,
  connectionDeliveries,
  connections,
  deleteConnectionDeliveriesBefore,
  googleSignIn,
  type Database,
} from "@ai-office/db";
import {
  avatarSchema,
  connectionRulesSchema,
  connectionStatuses,
  connectionTypes,
  deliveryStatuses,
  detailLevels,
  outboundMessageSchema,
  type Avatar,
  type ConnectionRules,
  type ConnectionStatus,
  type ConnectionType,
  type DeliveryStatus,
  type DetailLevel,
  type OutboundMessage,
} from "@ai-office/shared";
import { and, asc, desc, eq, gt, isNotNull, lte } from "drizzle-orm";

// Where the Communications Agent, the Connections and their outbound queue
// live (PRD FR-90, FR-93, FR-94): the `communications_agent`,
// `connections` and `connection_deliveries` tables, or memory for tests;
// and the Google sign-in the Google Connections publish through (FR-91),
// in `google_sign_in`.

/** The Communications Agent's config (FR-90). */
export interface CommunicationsAgentRecord {
  readonly name: string;
  /** How it looks at the lobby's reception desk; null for the default look. */
  readonly avatar: Avatar | null;
  readonly aiProvider: string;
  /** Its own Model; null uses its AI Provider's default. */
  readonly modelOverride: string | null;
  /** False while it is paused. */
  readonly enabled: boolean;
  readonly createdAt: Date;
}

/** A Connection as the communications package holds it. */
export interface ConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly type: ConnectionType;
  readonly rules: ConnectionRules;
  readonly detailLevel: DetailLevel;
  /** What is not secret, as its type defines it. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Its credentials, sealed with ENCRYPTION_KEY. */
  readonly credentials: string;
  /** What identifies its credentials without giving them away. */
  readonly hint: string;
  readonly paused: boolean;
  readonly status: ConnectionStatus;
  readonly consecutiveFailures: number;
  /** The last event a Digest summarised, or the latest when it began. */
  readonly digestCursor: number;
  /** When the last Digest was made, or its Digest turned on; null before. */
  readonly lastDigestAt: Date | null;
  readonly createdAt: Date;
}

/** What may change about a Connection once it is added. */
export type ConnectionChanges = Partial<
  Pick<
    ConnectionRecord,
    | "name"
    | "rules"
    | "detailLevel"
    | "paused"
    | "status"
    | "consecutiveFailures"
    | "digestCursor"
    | "lastDigestAt"
  >
>;

/** How far a Connection's Digests have got. */
export type DigestProgress = Pick<
  ConnectionRecord,
  "digestCursor" | "lastDigestAt"
>;

/** One delivery to a Connection: queued, sent, or given up. */
export interface DeliveryRecord {
  readonly id: string;
  readonly connectionId: string;
  /** The event it tells of; null for a test. */
  readonly eventId: number | null;
  readonly test: boolean;
  readonly message: OutboundMessage;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly createdAt: Date;
  /** When it is next tried; null unless it is pending. */
  readonly nextAttemptAt: Date | null;
  readonly firstAttemptAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly error: string | null;
}

/** What an attempt changes about a delivery. */
export type DeliveryChanges = Partial<
  Pick<
    DeliveryRecord,
    | "status"
    | "attempts"
    | "nextAttemptAt"
    | "firstAttemptAt"
    | "lastAttemptAt"
    | "deliveredAt"
    | "error"
  >
>;

/** Where the Google sign-in is: signed out, signed in, or its grant revoked. */
export const googleSignInRecordStatuses = [
  "signed_out",
  "signed_in",
  "revoked",
] as const;
export type GoogleSignInRecordStatus =
  (typeof googleSignInRecordStatuses)[number];

/**
 * The Google sign-in (FR-91): the Owner's OAuth client and the tokens of
 * the account signed in through it. The secret and the tokens are sealed
 * with ENCRYPTION_KEY.
 */
export interface GoogleSignInRecord {
  readonly clientId: string;
  /** Sealed. */
  readonly clientSecret: string;
  readonly status: GoogleSignInRecordStatus;
  /** Sealed; null unless signed in. */
  readonly refreshToken: string | null;
  /** Sealed; null when there is none to use. */
  readonly accessToken: string | null;
  readonly accessTokenExpiresAt: Date | null;
  /** The scopes Google granted at the last sign-in. */
  readonly grantedScopes: readonly string[];
  readonly signedInAt: Date | null;
}

/** Another Connection has the name. */
export class ConnectionNameTakenError extends Error {
  constructor(name: string) {
    super(`A Connection named "${name}" exists.`);
    this.name = "ConnectionNameTakenError";
  }
}

export interface CommunicationsStore {
  /** The Communications Agent; undefined before the first start. */
  agent(): Promise<CommunicationsAgentRecord | undefined>;
  /**
   * Makes the Communications Agent, taking in events after `eventCursor`,
   * unless it exists. Resolves with the one there is.
   */
  createAgent(
    agent: CommunicationsAgentRecord,
    eventCursor: number,
  ): Promise<CommunicationsAgentRecord>;
  updateAgent(
    changes: Partial<
      Pick<
        CommunicationsAgentRecord,
        "name" | "avatar" | "aiProvider" | "modelOverride" | "enabled"
      >
    >,
  ): Promise<CommunicationsAgentRecord | undefined>;
  /** The last event taken in. */
  eventCursor(): Promise<number>;

  /** Every Connection, oldest first. */
  connections(): Promise<ConnectionRecord[]>;
  connection(id: string): Promise<ConnectionRecord | undefined>;
  /** Throws a `ConnectionNameTakenError` when another has its name. */
  addConnection(connection: ConnectionRecord): Promise<void>;
  /** Undefined when there is none by that id; throws as `addConnection` does. */
  updateConnection(
    id: string,
    changes: ConnectionChanges,
  ): Promise<ConnectionRecord | undefined>;
  /** Removes it, with its deliveries; resolves with what it was. */
  removeConnection(id: string): Promise<ConnectionRecord | undefined>;

  /**
   * Queues `deliveries` and moves the event cursor to `eventCursor`, both
   * or neither. A delivery of an event already queued for its Connection
   * is ignored, so each event reaches each Connection at most once.
   */
  enqueue(
    deliveries: readonly DeliveryRecord[],
    eventCursor: number,
  ): Promise<void>;
  /** Adds one delivery to a Connection's log: a test. */
  addDelivery(delivery: DeliveryRecord): Promise<void>;
  /**
   * Pending deliveries due by `at` to Connections that are not paused,
   * the earliest due first.
   */
  due(at: Date, limit: number): Promise<DeliveryRecord[]>;
  updateDelivery(id: string, changes: DeliveryChanges): Promise<void>;
  /** A Connection's deliveries, newest first. */
  deliveries(connectionId: string, limit: number): Promise<DeliveryRecord[]>;
  /**
   * Lets a Connection's held deliveries that are not due until after `at`
   * go at `at`, as when its quiet hours change.
   */
  releaseHeld(connectionId: string, at: Date): Promise<void>;
  /**
   * Lets every pending delivery to a Connection that is not due until
   * after `at` go at `at`, held or waiting to be retried, as when what it
   * failed for is put right (Google signed in to again).
   */
  retryPending(connectionId: string, at: Date): Promise<void>;
  /**
   * Records a Digest (FR-92), all or nothing: moves the Connection's
   * Digest on to `progress`, and with a `digest` to send, queues it and
   * marks the deliveries it summarises, those held for it of events up
   * to its cursor, `summarised`.
   */
  recordDigest(
    connectionId: string,
    progress: DigestProgress & { readonly lastDigestAt: Date },
    digest: DeliveryRecord | undefined,
  ): Promise<void>;
  /**
   * Deletes the finished deliveries (delivered, failed or summarised)
   * queued before `before`, as retention does (PRD §7); resolves with how
   * many went. A pending one stays: it is the queue, not its log.
   */
  deleteDeliveriesBefore(before: Date): Promise<number>;

  /** The Google sign-in; undefined before an OAuth client is entered. */
  googleSignIn(): Promise<GoogleSignInRecord | undefined>;
  saveGoogleSignIn(record: GoogleSignInRecord): Promise<void>;
}

/**
 * Whether `delivery` is held for quiet hours (FR-92): pending, never
 * attempted, and put off past when it was queued.
 */
const isHeld = (delivery: DeliveryRecord): boolean =>
  delivery.status === "pending" &&
  delivery.attempts === 0 &&
  delivery.nextAttemptAt !== null &&
  delivery.nextAttemptAt.getTime() > delivery.createdAt.getTime();

const newestFirst = (a: DeliveryRecord, b: DeliveryRecord): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

/** Keeps everything in memory: for tests. */
export function memoryCommunicationsStore(): CommunicationsStore & {
  readonly deliveryRecords: Map<string, DeliveryRecord>;
} {
  let agent: CommunicationsAgentRecord | undefined;
  let google: GoogleSignInRecord | undefined;
  let cursor = 0;
  const all = new Map<string, ConnectionRecord>();
  const deliveryRecords = new Map<string, DeliveryRecord>();
  const copy = <T>(value: T): T => structuredClone(value);
  const nameTaken = (name: string, except?: string) =>
    [...all.values()].some(
      (connection) => connection.name === name && connection.id !== except,
    );

  return {
    deliveryRecords,
    agent: () => Promise.resolve(agent === undefined ? undefined : copy(agent)),
    createAgent(record, eventCursor) {
      if (agent === undefined) {
        agent = copy(record);
        cursor = eventCursor;
      }
      return Promise.resolve(copy(agent));
    },
    updateAgent(changes) {
      if (agent !== undefined) {
        agent = { ...agent, ...changes };
      }
      return Promise.resolve(agent === undefined ? undefined : copy(agent));
    },
    eventCursor: () => Promise.resolve(cursor),

    connections: () =>
      Promise.resolve(
        [...all.values()]
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .map(copy),
      ),
    connection(id) {
      const connection = all.get(id);
      return Promise.resolve(
        connection === undefined ? undefined : copy(connection),
      );
    },
    addConnection(connection) {
      if (nameTaken(connection.name)) {
        return Promise.reject(new ConnectionNameTakenError(connection.name));
      }
      all.set(connection.id, copy(connection));
      return Promise.resolve();
    },
    updateConnection(id, changes) {
      const connection = all.get(id);
      if (connection === undefined) {
        return Promise.resolve(undefined);
      }
      if (changes.name !== undefined && nameTaken(changes.name, id)) {
        return Promise.reject(new ConnectionNameTakenError(changes.name));
      }
      const changed = { ...connection, ...copy(changes) };
      all.set(id, changed);
      return Promise.resolve(copy(changed));
    },
    removeConnection(id) {
      const connection = all.get(id);
      all.delete(id);
      for (const [deliveryId, delivery] of deliveryRecords) {
        if (delivery.connectionId === id) {
          deliveryRecords.delete(deliveryId);
        }
      }
      return Promise.resolve(connection);
    },

    enqueue(deliveries, eventCursor) {
      for (const delivery of deliveries) {
        const queued = [...deliveryRecords.values()].some(
          (other) =>
            other.connectionId === delivery.connectionId &&
            other.eventId === delivery.eventId,
        );
        if (!queued && all.has(delivery.connectionId)) {
          deliveryRecords.set(delivery.id, copy(delivery));
        }
      }
      cursor = Math.max(cursor, eventCursor);
      return Promise.resolve();
    },
    addDelivery(delivery) {
      deliveryRecords.set(delivery.id, copy(delivery));
      return Promise.resolve();
    },
    due(at, limit) {
      return Promise.resolve(
        [...deliveryRecords.values()]
          .filter(
            (delivery) =>
              delivery.status === "pending" &&
              delivery.nextAttemptAt !== null &&
              delivery.nextAttemptAt.getTime() <= at.getTime() &&
              all.get(delivery.connectionId)?.paused === false,
          )
          .sort(
            (a, b) =>
              (a.nextAttemptAt?.getTime() ?? 0) -
                (b.nextAttemptAt?.getTime() ?? 0) ||
              a.createdAt.getTime() - b.createdAt.getTime() ||
              (a.eventId ?? 0) - (b.eventId ?? 0) ||
              a.id.localeCompare(b.id),
          )
          .slice(0, limit)
          .map(copy),
      );
    },
    updateDelivery(id, changes) {
      const delivery = deliveryRecords.get(id);
      if (delivery !== undefined) {
        deliveryRecords.set(id, { ...delivery, ...copy(changes) });
      }
      return Promise.resolve();
    },
    deliveries(connectionId, limit) {
      return Promise.resolve(
        [...deliveryRecords.values()]
          .filter((delivery) => delivery.connectionId === connectionId)
          .sort(newestFirst)
          .slice(0, limit)
          .map(copy),
      );
    },
    releaseHeld(connectionId, at) {
      for (const [id, delivery] of deliveryRecords) {
        if (
          delivery.connectionId === connectionId &&
          isHeld(delivery) &&
          (delivery.nextAttemptAt?.getTime() ?? 0) > at.getTime()
        ) {
          deliveryRecords.set(id, { ...delivery, nextAttemptAt: at });
        }
      }
      return Promise.resolve();
    },
    retryPending(connectionId, at) {
      for (const [id, delivery] of deliveryRecords) {
        if (
          delivery.connectionId === connectionId &&
          delivery.status === "pending" &&
          (delivery.nextAttemptAt?.getTime() ?? 0) > at.getTime()
        ) {
          deliveryRecords.set(id, { ...delivery, nextAttemptAt: at });
        }
      }
      return Promise.resolve();
    },
    recordDigest(connectionId, progress, digest) {
      const connection = all.get(connectionId);
      if (connection === undefined) {
        return Promise.resolve();
      }
      all.set(connectionId, { ...connection, ...copy(progress) });
      if (digest !== undefined) {
        for (const [id, delivery] of deliveryRecords) {
          if (
            delivery.connectionId === connectionId &&
            delivery.eventId !== null &&
            delivery.eventId <= progress.digestCursor &&
            isHeld(delivery)
          ) {
            deliveryRecords.set(id, {
              ...delivery,
              status: "summarised",
              nextAttemptAt: null,
            });
          }
        }
        deliveryRecords.set(digest.id, copy(digest));
      }
      return Promise.resolve();
    },
    deleteDeliveriesBefore(before) {
      let deleted = 0;
      for (const [id, delivery] of deliveryRecords) {
        if (delivery.status !== "pending" && delivery.createdAt < before) {
          deliveryRecords.delete(id);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
    googleSignIn: () =>
      Promise.resolve(google === undefined ? undefined : copy(google)),
    saveGoogleSignIn(record) {
      google = copy(record);
      return Promise.resolve();
    },
  };
}

/** Whether `error` is Postgres refusing a second Connection of one name. */
const isNameTaken = (error: unknown): boolean => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, constraint } = cause as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && constraint === "connections_name_unique") {
      return true;
    }
  }
  return false;
};

/** One of `values`, as the table's check constraint allows only these. */
const oneOf = <Value extends string>(
  values: readonly Value[],
  value: string,
  what: string,
): Value => {
  const known = values.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new Error(`A Connection has an unknown ${what}, ${value}.`);
  }
  return known;
};

type ConnectionRow = typeof connections.$inferSelect;
type DeliveryRow = typeof connectionDeliveries.$inferSelect;

const toConnection = (row: ConnectionRow): ConnectionRecord => ({
  id: row.id,
  name: row.name,
  type: oneOf(connectionTypes, row.type, "type"),
  rules: connectionRulesSchema.parse(row.rules),
  detailLevel: oneOf(detailLevels, row.detailLevel, "detail level"),
  settings: row.settings as Record<string, unknown>,
  credentials: row.credentials,
  hint: row.hint,
  paused: row.paused,
  status: oneOf(connectionStatuses, row.status, "status"),
  consecutiveFailures: row.consecutiveFailures,
  digestCursor: row.digestCursor,
  lastDigestAt: row.lastDigestAt,
  createdAt: row.createdAt,
});

const toDelivery = (row: DeliveryRow): DeliveryRecord => ({
  id: row.id,
  connectionId: row.connectionId,
  eventId: row.eventId,
  test: row.test,
  message: outboundMessageSchema.parse(row.message),
  status: oneOf(deliveryStatuses, row.status, "delivery status"),
  attempts: row.attempts,
  createdAt: row.createdAt,
  nextAttemptAt: row.nextAttemptAt,
  firstAttemptAt: row.firstAttemptAt,
  lastAttemptAt: row.lastAttemptAt,
  deliveredAt: row.deliveredAt,
  error: row.error,
});

/** Deliveries held for quiet hours, as `isHeld` tells them. */
const held = and(
  eq(connectionDeliveries.status, "pending"),
  eq(connectionDeliveries.attempts, 0),
  gt(connectionDeliveries.nextAttemptAt, connectionDeliveries.createdAt),
);

const agentColumns = {
  name: communicationsAgent.name,
  avatar: communicationsAgent.avatar,
  aiProvider: communicationsAgent.aiProvider,
  modelOverride: communicationsAgent.modelOverride,
  enabled: communicationsAgent.enabled,
  createdAt: communicationsAgent.createdAt,
};

type AgentRow = Omit<CommunicationsAgentRecord, "avatar"> & {
  readonly avatar: unknown;
};

/** The Communications Agent from its row: an Avatar no longer valid is the default look. */
const toAgent = (row: AgentRow): CommunicationsAgentRecord => {
  const avatar = avatarSchema.safeParse(row.avatar);
  return { ...row, avatar: avatar.success ? avatar.data : null };
};

/** Keeps everything in its tables. */
export function databaseCommunicationsStore(db: Database): CommunicationsStore {
  const agent = async () => {
    const [row] = await db.select(agentColumns).from(communicationsAgent);
    return row === undefined ? undefined : toAgent(row);
  };

  return {
    agent,

    async createAgent(record, eventCursor) {
      await db
        .insert(communicationsAgent)
        .values({ id: 1, ...record, eventCursor })
        .onConflictDoNothing();
      const created = await agent();
      if (created === undefined) {
        throw new Error("The Communications Agent was not made.");
      }
      return created;
    },

    async updateAgent(changes) {
      const [row] = await db
        .update(communicationsAgent)
        .set(changes)
        .where(eq(communicationsAgent.id, 1))
        .returning(agentColumns);
      return row === undefined ? undefined : toAgent(row);
    },

    async eventCursor() {
      const [row] = await db
        .select({ eventCursor: communicationsAgent.eventCursor })
        .from(communicationsAgent);
      return row?.eventCursor ?? 0;
    },

    async connections() {
      const rows = await db
        .select()
        .from(connections)
        .orderBy(asc(connections.createdAt), asc(connections.id));
      return rows.map(toConnection);
    },

    async connection(id) {
      const [row] = await db
        .select()
        .from(connections)
        .where(eq(connections.id, id));
      return row === undefined ? undefined : toConnection(row);
    },

    async addConnection(connection) {
      try {
        await db.insert(connections).values(connection);
      } catch (error) {
        if (isNameTaken(error)) {
          throw new ConnectionNameTakenError(connection.name);
        }
        throw error;
      }
    },

    async updateConnection(id, changes) {
      try {
        const [row] = await db
          .update(connections)
          .set(changes)
          .where(eq(connections.id, id))
          .returning();
        return row === undefined ? undefined : toConnection(row);
      } catch (error) {
        if (isNameTaken(error) && changes.name !== undefined) {
          throw new ConnectionNameTakenError(changes.name);
        }
        throw error;
      }
    },

    async removeConnection(id) {
      const [row] = await db
        .delete(connections)
        .where(eq(connections.id, id))
        .returning();
      return row === undefined ? undefined : toConnection(row);
    },

    async enqueue(deliveries, eventCursor) {
      await db.transaction(async (tx) => {
        if (deliveries.length > 0) {
          await tx
            .insert(connectionDeliveries)
            .values([...deliveries])
            .onConflictDoNothing({
              target: [
                connectionDeliveries.connectionId,
                connectionDeliveries.eventId,
              ],
            });
        }
        await tx
          .update(communicationsAgent)
          .set({ eventCursor })
          .where(eq(communicationsAgent.id, 1));
      });
    },

    async addDelivery(delivery) {
      await db.insert(connectionDeliveries).values(delivery);
    },

    async due(at, limit) {
      const rows = await db
        .select({ delivery: connectionDeliveries })
        .from(connectionDeliveries)
        .innerJoin(
          connections,
          eq(connections.id, connectionDeliveries.connectionId),
        )
        .where(
          and(
            eq(connectionDeliveries.status, "pending"),
            lte(connectionDeliveries.nextAttemptAt, at),
            eq(connections.paused, false),
          ),
        )
        .orderBy(
          asc(connectionDeliveries.nextAttemptAt),
          asc(connectionDeliveries.createdAt),
          asc(connectionDeliveries.eventId),
          asc(connectionDeliveries.id),
        )
        .limit(limit);
      return rows.map(({ delivery }) => toDelivery(delivery));
    },

    async updateDelivery(id, changes) {
      await db
        .update(connectionDeliveries)
        .set(changes)
        .where(eq(connectionDeliveries.id, id));
    },

    async deliveries(connectionId, limit) {
      const rows = await db
        .select()
        .from(connectionDeliveries)
        .where(eq(connectionDeliveries.connectionId, connectionId))
        .orderBy(
          desc(connectionDeliveries.createdAt),
          desc(connectionDeliveries.id),
        )
        .limit(limit);
      return rows.map(toDelivery);
    },

    async releaseHeld(connectionId, at) {
      await db
        .update(connectionDeliveries)
        .set({ nextAttemptAt: at })
        .where(
          and(
            eq(connectionDeliveries.connectionId, connectionId),
            held,
            gt(connectionDeliveries.nextAttemptAt, at),
          ),
        );
    },

    async retryPending(connectionId, at) {
      await db
        .update(connectionDeliveries)
        .set({ nextAttemptAt: at })
        .where(
          and(
            eq(connectionDeliveries.connectionId, connectionId),
            eq(connectionDeliveries.status, "pending"),
            gt(connectionDeliveries.nextAttemptAt, at),
          ),
        );
    },

    async recordDigest(connectionId, progress, digest) {
      await db.transaction(async (tx) => {
        await tx
          .update(connections)
          .set(progress)
          .where(eq(connections.id, connectionId));
        if (digest === undefined) {
          return;
        }
        await tx
          .update(connectionDeliveries)
          .set({ status: "summarised", nextAttemptAt: null })
          .where(
            and(
              eq(connectionDeliveries.connectionId, connectionId),
              isNotNull(connectionDeliveries.eventId),
              lte(connectionDeliveries.eventId, progress.digestCursor),
              held,
            ),
          );
        await tx.insert(connectionDeliveries).values(digest);
      });
    },
    deleteDeliveriesBefore: (before) =>
      deleteConnectionDeliveriesBefore(db, before),

    async googleSignIn() {
      const [row] = await db
        .select()
        .from(googleSignIn)
        .where(eq(googleSignIn.id, 1));
      if (row === undefined) {
        return undefined;
      }
      const status = googleSignInRecordStatuses.find(
        (candidate) => candidate === row.status,
      );
      if (status === undefined) {
        throw new Error(
          `The Google sign-in has an unknown status, ${row.status}.`,
        );
      }
      return {
        clientId: row.clientId,
        clientSecret: row.clientSecret,
        status,
        refreshToken: row.refreshToken,
        accessToken: row.accessToken,
        accessTokenExpiresAt: row.accessTokenExpiresAt,
        grantedScopes: Array.isArray(row.grantedScopes)
          ? row.grantedScopes.filter(
              (scope): scope is string => typeof scope === "string",
            )
          : [],
        signedInAt: row.signedInAt,
      };
    },

    async saveGoogleSignIn(record) {
      const values = { ...record, grantedScopes: [...record.grantedScopes] };
      await db
        .insert(googleSignIn)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: googleSignIn.id, set: values });
    },
  };
}
