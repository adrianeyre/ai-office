import { gatewayKeys, type Database } from "@ai-office/db";
import {
  keyProfileSchema,
  type GatewayKeyAccess,
  type GatewayKeyKind,
  type KeyProfile,
} from "@ai-office/shared";
import { and, desc, eq, isNull } from "drizzle-orm";

// Where Gateway Keys live (PRD FR-46): the `gateway_keys` table, or memory
// for tests. The store sees a key only as its SHA-256, and an Agent's key
// sealed.

/** A Gateway Key as the store holds it. */
export interface GatewayKeyRecord {
  readonly id: string;
  readonly kind: GatewayKeyKind;
  /** The Owner tool's name, or the Agent's when the key was made. */
  readonly name: string;
  /** The Agent it belongs to, and its Floor; null for an Owner tool's. */
  readonly agentId: string | null;
  readonly floorId: string | null;
  /** The SHA-256 of the key, hex-encoded. */
  readonly keyHash: string;
  /** The key's first characters. */
  readonly hint: string;
  /** An Agent's key, sealed with ENCRYPTION_KEY; null for an Owner tool's. */
  readonly sealedKey: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  /** Who uses it: names and time zone; absent until set. */
  readonly profile?: KeyProfile | undefined;
  /** What it may do; absent is `proxy`, the AI Gateway only. */
  readonly access?: GatewayKeyAccess | undefined;
  /** False while disabled; absent is enabled. */
  readonly enabled?: boolean | undefined;
}

export interface GatewayKeyStore {
  /** The keys in use (not revoked), newest first. */
  list(): Promise<GatewayKeyRecord[]>;
  get(id: string): Promise<GatewayKeyRecord | undefined>;
  /** The key with this hash, revoked or not. */
  byHash(keyHash: string): Promise<GatewayKeyRecord | undefined>;
  /** The Agent's key in use, if it has one. */
  forAgent(agentId: string): Promise<GatewayKeyRecord | undefined>;
  /** The Communications Agent's key in use, if it has one. */
  forCommunications(): Promise<GatewayKeyRecord | undefined>;
  /** The Terminal's key in use, if it has one. */
  forTerminal(): Promise<GatewayKeyRecord | undefined>;
  /**
   * Adds an Owner tool's key, unless another one in use has its name; or
   * an Agent's (or the Communications Agent's), revoking (at its
   * `createdAt`) the key it had.
   */
  add(key: GatewayKeyRecord): Promise<"added" | "name_taken">;
  /** Revokes a key in use; undefined if there is none by that id. */
  revoke(id: string, at: Date): Promise<GatewayKeyRecord | undefined>;
  /** Revokes the Agent's key in use; false if it had none. */
  revokeForAgent(agentId: string, at: Date): Promise<boolean>;
  /** Notes that the key authenticated a request at `at`. */
  touch(id: string, at: Date): Promise<void>;
  /** Sets who uses a key in use; undefined if there is none by that id. */
  setProfile(
    id: string,
    profile: KeyProfile,
  ): Promise<GatewayKeyRecord | undefined>;
  /**
   * Sets an Owner tool key's name, what it may do, and whether it is
   * enabled; undefined if there is none by that id in use, `name_taken`
   * if another key in use has the name.
   */
  update(
    id: string,
    changes: {
      readonly name?: string | undefined;
      readonly access?: GatewayKeyAccess | undefined;
      readonly enabled?: boolean | undefined;
    },
  ): Promise<GatewayKeyRecord | "name_taken" | undefined>;
}

/** The changes given, without those left undefined. */
const given = <T extends object>(changes: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as Partial<T>;

const newestFirst = (a: GatewayKeyRecord, b: GatewayKeyRecord): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);

/** Keeps Gateway Keys in memory: for tests. */
export function memoryGatewayKeyStore(): GatewayKeyStore & {
  readonly keys: Map<string, GatewayKeyRecord>;
} {
  const keys = new Map<string, GatewayKeyRecord>();
  const inUse = () => [...keys.values()].filter((key) => !key.revokedAt);
  const revokeKey = (key: GatewayKeyRecord, at: Date) => {
    const revoked = { ...key, revokedAt: at };
    keys.set(key.id, revoked);
    return revoked;
  };
  return {
    keys,
    list: () => Promise.resolve(inUse().sort(newestFirst)),
    get: (id) => Promise.resolve(keys.get(id)),
    byHash: (keyHash) =>
      Promise.resolve([...keys.values()].find((k) => k.keyHash === keyHash)),
    forAgent: (agentId) =>
      Promise.resolve(inUse().find((key) => key.agentId === agentId)),
    forCommunications: () =>
      Promise.resolve(inUse().find((key) => key.kind === "communications")),
    forTerminal: () =>
      Promise.resolve(inUse().find((key) => key.kind === "terminal")),
    add(key) {
      if (keys.has(key.id)) {
        return Promise.reject(new Error(`Gateway Key ${key.id} exists.`));
      }
      if (
        key.kind === "owner_tool" &&
        inUse().some(({ kind, name }) => kind === key.kind && name === key.name)
      ) {
        return Promise.resolve("name_taken");
      }
      for (const old of inUse()) {
        if (
          (key.agentId !== null && old.agentId === key.agentId) ||
          ((key.kind === "communications" || key.kind === "terminal") &&
            old.kind === key.kind)
        ) {
          revokeKey(old, key.createdAt);
        }
      }
      keys.set(key.id, key);
      return Promise.resolve("added");
    },
    revoke(id, at) {
      const key = keys.get(id);
      // Unknown, or revoked already.
      if (key?.revokedAt !== null) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(revokeKey(key, at));
    },
    revokeForAgent(agentId, at) {
      const key = inUse().find((k) => k.agentId === agentId);
      if (key !== undefined) {
        revokeKey(key, at);
      }
      return Promise.resolve(key !== undefined);
    },
    touch(id, at) {
      const key = keys.get(id);
      if (key !== undefined) {
        keys.set(id, { ...key, lastUsedAt: at });
      }
      return Promise.resolve();
    },
    setProfile(id, profile) {
      const key = keys.get(id);
      if (key?.revokedAt !== null) {
        return Promise.resolve(undefined);
      }
      const updated = { ...key, profile: { ...profile } };
      keys.set(id, updated);
      return Promise.resolve(updated);
    },
    update(id, changes): Promise<GatewayKeyRecord | "name_taken" | undefined> {
      const key = keys.get(id);
      if (key?.revokedAt !== null) {
        return Promise.resolve(undefined);
      }
      if (
        changes.name !== undefined &&
        inUse().some(
          (other) =>
            other.id !== id &&
            other.kind === "owner_tool" &&
            other.name === changes.name,
        )
      ) {
        return Promise.resolve("name_taken" as const);
      }
      const updated = { ...key, ...given(changes) } as GatewayKeyRecord;
      keys.set(id, updated);
      return Promise.resolve(updated);
    },
  };
}

type GatewayKeyRow = typeof gatewayKeys.$inferSelect;

const toRecord = ({ profile, ...row }: GatewayKeyRow): GatewayKeyRecord => ({
  ...row,
  profile: keyProfileSchema.safeParse(profile).data,
  access: row.access === "proxy_and_ui" ? "proxy_and_ui" : "proxy",
  enabled: row.enabled,
  kind:
    row.kind === "agent" ||
    row.kind === "communications" ||
    row.kind === "terminal"
      ? row.kind
      : "owner_tool",
});

/** Whether `error` is Postgres refusing a second Owner tool of one name. */
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
    if (code === "23505" && constraint === "gateway_keys_owner_tool_name") {
      return true;
    }
  }
  return false;
};

/** Keeps Gateway Keys in the `gateway_keys` table. */
export function databaseGatewayKeyStore(db: Database): GatewayKeyStore {
  return {
    async list() {
      const rows = await db
        .select()
        .from(gatewayKeys)
        .where(isNull(gatewayKeys.revokedAt))
        .orderBy(desc(gatewayKeys.createdAt), gatewayKeys.id);
      return rows.map(toRecord);
    },

    async get(id) {
      const [row] = await db
        .select()
        .from(gatewayKeys)
        .where(eq(gatewayKeys.id, id));
      return row === undefined ? undefined : toRecord(row);
    },

    async byHash(keyHash) {
      const [row] = await db
        .select()
        .from(gatewayKeys)
        .where(eq(gatewayKeys.keyHash, keyHash));
      return row === undefined ? undefined : toRecord(row);
    },

    async forAgent(agentId) {
      const [row] = await db
        .select()
        .from(gatewayKeys)
        .where(
          and(eq(gatewayKeys.agentId, agentId), isNull(gatewayKeys.revokedAt)),
        );
      return row === undefined ? undefined : toRecord(row);
    },

    async forCommunications() {
      const [row] = await db
        .select()
        .from(gatewayKeys)
        .where(
          and(
            eq(gatewayKeys.kind, "communications"),
            isNull(gatewayKeys.revokedAt),
          ),
        );
      return row === undefined ? undefined : toRecord(row);
    },

    async forTerminal() {
      const [row] = await db
        .select()
        .from(gatewayKeys)
        .where(
          and(eq(gatewayKeys.kind, "terminal"), isNull(gatewayKeys.revokedAt)),
        );
      return row === undefined ? undefined : toRecord(row);
    },

    async add(key) {
      try {
        // An Agent's old key is revoked in the same transaction, so it
        // always has exactly one in use.
        await db.transaction(async (tx) => {
          if (key.kind === "communications" || key.kind === "terminal") {
            await tx
              .update(gatewayKeys)
              .set({ revokedAt: key.createdAt })
              .where(
                and(
                  eq(gatewayKeys.kind, key.kind),
                  isNull(gatewayKeys.revokedAt),
                ),
              );
          }
          if (key.agentId !== null) {
            await tx
              .update(gatewayKeys)
              .set({ revokedAt: key.createdAt })
              .where(
                and(
                  eq(gatewayKeys.agentId, key.agentId),
                  isNull(gatewayKeys.revokedAt),
                ),
              );
          }
          await tx.insert(gatewayKeys).values(key);
        });
        return "added";
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },

    async revoke(id, at) {
      const [row] = await db
        .update(gatewayKeys)
        .set({ revokedAt: at })
        .where(and(eq(gatewayKeys.id, id), isNull(gatewayKeys.revokedAt)))
        .returning();
      return row === undefined ? undefined : toRecord(row);
    },

    async revokeForAgent(agentId, at) {
      const rows = await db
        .update(gatewayKeys)
        .set({ revokedAt: at })
        .where(
          and(eq(gatewayKeys.agentId, agentId), isNull(gatewayKeys.revokedAt)),
        )
        .returning({ id: gatewayKeys.id });
      return rows.length > 0;
    },

    async touch(id, at) {
      await db
        .update(gatewayKeys)
        .set({ lastUsedAt: at })
        .where(eq(gatewayKeys.id, id));
    },

    async setProfile(id, profile) {
      const [row] = await db
        .update(gatewayKeys)
        .set({ profile })
        .where(and(eq(gatewayKeys.id, id), isNull(gatewayKeys.revokedAt)))
        .returning();
      return row === undefined ? undefined : toRecord(row);
    },

    async update(id, changes) {
      try {
        const [row] = await db
          .update(gatewayKeys)
          .set(given(changes))
          .where(and(eq(gatewayKeys.id, id), isNull(gatewayKeys.revokedAt)))
          .returning();
        return row === undefined ? undefined : toRecord(row);
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },
  };
}
