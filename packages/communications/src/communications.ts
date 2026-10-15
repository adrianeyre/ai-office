import { randomUUID } from "node:crypto";

import type { EventBus, EventType } from "@ai-office/events";
import {
  communicationsRole,
  connectionErrorCodes,
  createRedactor,
  defaultAiProvider,
  defaultCommunicationsAgentAvatar,
  defaultDetailLevel,
  defaultRulesFor,
  failingAfterFailures,
  initialDefaultModels,
  isCalendar,
  isGoogleConnection,
  isPublishingDestination,
  isWorkLog,
  rulesFor,
  type AddConnectionRequest,
  type Avatar,
  type ConnectionErrorCode,
  type ConnectionType,
  type DetailLevel,
  type NewNotice,
  type OutboundMessage,
  type Redactor,
  type UpdateCommunicationsAgentRequest,
  type UpdateConnectionRequest,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";

import {
  calendarEventTypes,
  calendarMessage,
  calendarPublicationFor,
  type CalendarPublication,
} from "./calendar.ts";
import {
  digestCounts,
  digestData,
  templateDigest,
  type DigestWriter,
} from "./digest.ts";
import {
  atDetailLevel,
  connectionPath,
  messageFor,
  officeUrl,
  passesFloors,
  passesRules,
  testMessage,
  triggerEventTypes,
  type EventMessage,
  type NoticeView,
} from "./messages.ts";
import type { GoogleAuth } from "./google.ts";
import {
  changelogMessage,
  publicationFor,
  reportMessage,
  workLogFor,
  type CompletedIssue,
  type Publication,
  type PublicationSources,
  type WorkLogPublication,
} from "./publications.ts";
import {
  reportData,
  templateReportSummary,
  type BatchReport,
  type ReportWriter,
} from "./report.ts";
import { digestMadeAt, heldUntil } from "./schedule.ts";
import {
  ConnectionNameTakenError,
  type CommunicationsAgentRecord,
  type CommunicationsStore,
  type ConnectionRecord,
  type DeliveryRecord,
} from "./store.ts";
import {
  DeliveryError,
  type ConnectionTransport,
} from "./transports/transport.ts";

// The Communications Agent (PRD §6.17, FR-90 to FR-94): it reads the event
// bus and writes only to Connections. Each event that a Connection's rules
// let through is queued for it in Postgres, at most once, from the last
// event taken in, so a restart loses nothing. A worker sends what is due,
// retrying failures with exponential backoff for up to 24 hours. After 5
// failures in a row a Connection is failing, and an action Notice says so,
// which is never sent to that Connection. While the Agent is paused,
// deliveries wait.
//
// Each Connection is told at its detail level, and everything queued is
// redacted (FR-95). In a Connection's quiet hours, deliveries are held
// until they end, unless they are action Notices the Owner lets through;
// a Digest made first summarises them instead (FR-92). Digests fall due
// hourly or daily, never in quiet hours, and are written from structured
// data by the Communications Agent's Model through the AI Gateway (FR-90).
//
// Publishing destinations (Confluence, Notion, Google Docs, Slides and
// Drive) are sent each finished Batch's Wrap-up report within their
// Floors, and those that keep one (Confluence, Notion, Google Docs) with a
// running changelog an entry per merged pull request (`publications.ts`). A report's summary
// is written by the Communications Agent's Model from structured data, or
// a template; the report is redacted before its Markdown is written, so
// escaping never hides a credential from the redactor. A work log (Google
// Sheets) is sent a row per completed issue within its Floors, and with
// its Notices rule a row per Notice. A calendar (Google Calendar) is sent
// each Batch within its Floors as it starts and as it finishes, for its
// one event per Batch (`calendar.ts`). Google Connections publish through
// the Owner's Google sign-in: when Google refuses it, every one is marked
// failing at once, and after a new sign-in what waits for them is tried
// again straight away.

/** Why a Communications operation was refused; `code` is one of `connectionErrorCodes`. */
export class CommunicationsError extends Error {
  readonly code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = "CommunicationsError";
    this.code = code;
  }
}

/** The credentials each type of Connection takes. */
export type CredentialsOf<Type extends ConnectionType> = Extract<
  AddConnectionRequest,
  { type: Type }
>["credentials"];

/** A transport for each type of Connection. */
export type Transports = {
  readonly [Type in ConnectionType]: ConnectionTransport<CredentialsOf<Type>>;
};

/** How failed deliveries are retried (FR-94). */
export interface RetryPolicy {
  /** The wait after the first failure; 30 seconds by default. */
  readonly initialDelayMs: number;
  /** Each wait after that is this many times the one before; 2. */
  readonly multiplier: number;
  /** The longest wait; an hour. */
  readonly maxDelayMs: number;
  /** A delivery is given up this long after its first attempt; 24 hours. */
  readonly giveUpAfterMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  initialDelayMs: 30_000,
  multiplier: 2,
  maxDelayMs: 60 * 60 * 1000,
  giveUpAfterMs: 24 * 60 * 60 * 1000,
};

/** The shortest wait before a retry, whatever a service asks. */
const minimumRetryDelayMs = 1000;

/** The Communications Agent, as the office admin shows it. */
export interface CommunicationsAgentInfo extends CommunicationsAgentRecord {
  readonly role: typeof communicationsRole;
  /** How it looks: its own Avatar, or the default look. */
  readonly avatar: Avatar;
  /** Its own Model or its AI Provider's default; null when it has neither. */
  readonly model: string | null;
}

/** A Connection, as the office admin shows it: never its credentials. */
export interface ConnectionInfo extends Omit<
  ConnectionRecord,
  "credentials" | "settings" | "digestCursor" | "lastDigestAt"
> {
  /** What is not secret about it, one line each. */
  readonly details: readonly string[];
  /** Its latest delivery or test; null before any. */
  readonly lastDelivery: DeliveryRecord | null;
}

export interface ConnectionTestOutcome {
  readonly delivered: boolean;
  /** Why it was not, redacted. */
  readonly error: string | null;
  readonly connection: ConnectionInfo;
}

export interface Communications {
  /** The Communications Agent, made at first start (FR-90). */
  agent(): Promise<CommunicationsAgentInfo>;
  updateAgent(
    changes: UpdateCommunicationsAgentRequest,
  ): Promise<CommunicationsAgentInfo>;
  /** Every Connection, oldest first. */
  list(): Promise<ConnectionInfo[]>;
  get(connectionId: string): Promise<ConnectionInfo>;
  add(request: AddConnectionRequest): Promise<ConnectionInfo>;
  /** Renames it, changes its rules, or pauses or resumes it. */
  update(
    connectionId: string,
    changes: UpdateConnectionRequest,
  ): Promise<ConnectionInfo>;
  remove(connectionId: string): Promise<void>;
  /** Sends a test message at once, and says how it went (FR-93). */
  sendTest(connectionId: string): Promise<ConnectionTestOutcome>;
  /** A Connection's deliveries and tests, newest first. */
  deliveries(connectionId: string, limit?: number): Promise<DeliveryRecord[]>;
  /** Queues deliveries for every event not yet taken in. */
  takeIn(): Promise<void>;
  /**
   * Attempts every delivery that is due; resolves with how many (by the
   * last run, when one was already under way).
   */
  deliverDue(): Promise<number>;
  /** Takes in what was missed, then follows the bus and sends as things fall due. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CommunicationsOptions {
  readonly store: CommunicationsStore;
  readonly events: EventBus;
  /** Seals each Connection's credentials (ENCRYPTION_KEY). */
  readonly encryptor: Encryptor;
  readonly transports: Transports;
  /** Where AI Office is reached (PUBLIC_URL), for links back to it. */
  readonly publicUrl: string;
  /** A Floor's name, for messages. */
  readonly floorName: (floorId: string) => Promise<string | undefined>;
  /** A Notice, for its links. */
  readonly notice: (noticeId: string) => Promise<NoticeView | undefined>;
  /** A finished Batch, for its Wrap-up report (FR-92). */
  readonly batchReport?: (
    floorId: string,
    batchId: number,
  ) => Promise<BatchReport | undefined>;
  /** An issue's title as AI Office knows it, for a changelog entry. */
  readonly issueTitle?: (
    floorId: string,
    issue: number,
  ) => Promise<string | undefined>;
  /** What AI Office recorded of a completed issue, for a work log's row. */
  readonly completedIssue?: (
    floorId: string,
    issue: number,
  ) => Promise<CompletedIssue | undefined>;
  /**
   * The Google sign-in the Google Connections publish through: told of,
   * its grant being revoked marks them failing (FR-91, FR-94).
   */
  readonly google?: Pick<GoogleAuth, "onRevoked" | "onSignedIn">;
  /** Raises a Notice: "Connection failing" (FR-94). */
  readonly raiseNotice: (notice: NewNotice) => Promise<{ readonly id: string }>;
  /** Each AI Provider's default Model. */
  readonly defaultModels?: () => Promise<Partial<Record<string, string>>>;
  /**
   * Writes "titles and summaries" Digests with the Communications Agent's
   * Model, through the AI Gateway; without one, or when it fails, they
   * come from a template.
   */
  readonly digestWriter?: DigestWriter;
  /**
   * Writes "titles and summaries" Wrap-up reports' summaries with the
   * Communications Agent's Model, through the AI Gateway; without one, or
   * when it fails, they come from a template.
   */
  readonly reportWriter?: ReportWriter;
  /** The Communications Agent's name when it is made. */
  readonly agentName?: () => string;
  /** Removes credentials from every message and error kept. */
  readonly redactor?: Redactor;
  readonly retry?: Partial<RetryPolicy>;
  /** How often the worker looks for due deliveries; 2 seconds by default. */
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly newId?: (prefix: "connection" | "delivery") => string;
  /** Told when taking in or sending fails; it is tried again. */
  readonly onError?: (error: unknown) => void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `task`, run once at a time: a call while it runs asks for one more run
 * after it, and resolves when that is done, with every run's results
 * combined. `idle` waits for any run.
 */
function oneAtATime<Result>(
  task: () => Promise<Result>,
  combine: (a: Result, b: Result) => Result,
): {
  readonly run: () => Promise<Result>;
  readonly idle: () => Promise<unknown>;
} {
  let running: Promise<Result> | undefined;
  // Set by a call while a run is under way.
  const asked = { again: false };
  const askedAgain = (): boolean => asked.again;
  const loop = async (): Promise<Result> => {
    try {
      asked.again = false;
      let result: Result = await task();
      while (askedAgain()) {
        asked.again = false;
        result = combine(result, await task());
      }
      return result;
    } finally {
      running = undefined;
    }
  };
  return {
    run: () => {
      if (running !== undefined) {
        asked.again = true;
        return running;
      }
      running = loop();
      return running;
    },
    idle: () => (running ?? Promise.resolve()).catch(() => undefined),
  };
}

/** `changes` without the fields it leaves alone. */
const definedOf = <Changes extends object>(
  changes: Changes,
): { [Key in keyof Changes]?: Exclude<Changes[Key], undefined> } =>
  Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as { [Key in keyof Changes]?: Exclude<Changes[Key], undefined> };

/** The context a Connection's credentials are sealed with. */
export const connectionCredentialsContext = (connectionId: string): string =>
  `connection.credentials:${connectionId}`;

/** The events deliveries are queued from: messages' and calendars'. */
const takenInTypes: readonly EventType[] = [
  ...new Set<EventType>([...triggerEventTypes, ...calendarEventTypes]),
];

export function createCommunications(
  options: CommunicationsOptions,
): Communications {
  const { store, events, encryptor, transports, publicUrl } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const newId =
    options.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const defaultModels =
    options.defaultModels ??
    (() =>
      Promise.resolve(initialDefaultModels as Partial<Record<string, string>>));
  const retry = { ...defaultRetryPolicy, ...options.retry };
  const pollMs = options.pollMs ?? 2000;
  const report = (error: unknown) => {
    options.onError?.(error);
  };
  const sources = {
    publicUrl,
    floorName: options.floorName,
    notice: options.notice,
  };
  const publicationSources: PublicationSources = {
    publicUrl,
    floorName: options.floorName,
    ...(options.batchReport === undefined
      ? {}
      : { batchReport: options.batchReport }),
    ...(options.issueTitle === undefined
      ? {}
      : { issueTitle: options.issueTitle }),
    ...(options.completedIssue === undefined
      ? {}
      : { completedIssue: options.completedIssue }),
  };

  // The Communications Agent is made once, at first start, taking in only
  // events from then on.
  let made: Promise<void> | undefined;
  const ensureAgent = (): Promise<void> => {
    made ??= (async () => {
      if ((await store.agent()) !== undefined) {
        return;
      }
      const [latest] = await events.history({ limit: 1 });
      await store.createAgent(
        {
          name: options.agentName?.() ?? "Reception",
          avatar: null,
          aiProvider: defaultAiProvider,
          modelOverride: null,
          enabled: true,
          createdAt: now(),
        },
        latest?.id ?? 0,
      );
    })().catch((error: unknown) => {
      made = undefined;
      throw error;
    });
    return made;
  };

  const agentInfo = async (): Promise<CommunicationsAgentInfo> => {
    await ensureAgent();
    const agent = await store.agent();
    if (agent === undefined) {
      throw new Error("The Communications Agent is missing.");
    }
    return {
      ...agent,
      role: communicationsRole,
      avatar: agent.avatar ?? defaultCommunicationsAgentAvatar,
      model:
        agent.modelOverride ??
        (await defaultModels())[agent.aiProvider] ??
        null,
    };
  };

  const transportOf = (type: ConnectionType) =>
    transports[type] as ConnectionTransport<unknown>;

  /** The id of the latest event on the bus; 0 before any. */
  const latestEventId = async (): Promise<number> =>
    (await events.history({ limit: 1 }))[0]?.id ?? 0;

  const infoOf = async (
    connection: ConnectionRecord,
  ): Promise<ConnectionInfo> => {
    const [lastDelivery] = await store.deliveries(connection.id, 1);
    return {
      id: connection.id,
      name: connection.name,
      type: connection.type,
      rules: connection.rules,
      detailLevel: connection.detailLevel,
      hint: connection.hint,
      paused: connection.paused,
      status: connection.status,
      consecutiveFailures: connection.consecutiveFailures,
      createdAt: connection.createdAt,
      details: transportOf(connection.type).details(connection.settings),
      lastDelivery: lastDelivery ?? null,
    };
  };

  const find = async (connectionId: string): Promise<ConnectionRecord> => {
    const connection = await store.connection(connectionId);
    if (connection === undefined) {
      throw new CommunicationsError(
        connectionErrorCodes.connectionNotFound,
        `There is no Connection "${connectionId}".`,
      );
    }
    return connection;
  };

  const nameTaken = (name: string) =>
    new CommunicationsError(
      connectionErrorCodes.nameTaken,
      `Another Connection is named "${name}".`,
    );

  /** Opens a Connection's credentials and sends one delivery with them. */
  const send = async (
    connection: ConnectionRecord,
    delivery: Pick<DeliveryRecord, "id" | "message" | "test">,
  ): Promise<void> => {
    const transport = transportOf(connection.type);
    const credentials = transport.credentials.parse(
      JSON.parse(
        encryptor.decrypt(
          connection.credentials,
          connectionCredentialsContext(connection.id),
        ),
      ),
    );
    // Whatever goes wrong, nothing kept or logged repeats them.
    redactor.register(
      ...(transport.secrets?.(credentials) ??
        Object.values(credentials as Record<string, unknown>).filter(
          (value): value is string => typeof value === "string",
        )),
    );
    await transport.send(
      {
        id: delivery.id,
        connectionId: connection.id,
        message: delivery.message,
        test: delivery.test,
      },
      { credentials, settings: connection.settings },
    );
  };

  const errorText = (error: unknown): string =>
    redactor
      .redactText(
        error instanceof DeliveryError
          ? error.message
          : `The delivery failed: ${messageOf(error)}`,
      )
      .slice(0, 500);

  /** After a delivery arrives: a failing Connection has recovered. */
  const succeeded = async (connectionId: string): Promise<void> => {
    const connection = await store.connection(connectionId);
    if (connection === undefined || connection.consecutiveFailures === 0) {
      return;
    }
    await store.updateConnection(connectionId, {
      consecutiveFailures: 0,
      status: "ok",
    });
    if (connection.status === "failing") {
      await events.publish({
        type: "connection.recovered",
        version: 1,
        connectionId,
        name: connection.name,
      });
    }
  };

  /** Marks a Connection failing, with an action Notice saying `why` (FR-94). */
  const markFailing = async (
    connection: ConnectionRecord,
    failures: number,
    why: string,
    reason?: "google_sign_in_revoked",
  ): Promise<void> => {
    // The Notice links to the Connection, which is how it is never sent
    // there: a Notice about a Connection skips that Connection.
    const notice = await options.raiseNotice({
      kind: "action",
      title: `Connection "${connection.name}" is failing: ${why}`,
      links: [
        {
          label: "Open the Connection",
          url: officeUrl(publicUrl, connectionPath(connection.id)),
        },
      ],
    });
    await store.updateConnection(connection.id, {
      consecutiveFailures: failures,
      status: "failing",
    });
    await events.publish({
      type: "connection.failing",
      version: 1,
      connectionId: connection.id,
      name: connection.name,
      failures,
      noticeId: notice.id,
      ...(reason === undefined ? {} : { reason }),
    });
  };

  /** After a delivery fails: the fifth in a row makes the Connection failing. */
  const failed = async (connectionId: string): Promise<void> => {
    const connection = await store.connection(connectionId);
    if (connection === undefined) {
      return;
    }
    const failures = connection.consecutiveFailures + 1;
    if (connection.status === "failing" || failures < failingAfterFailures) {
      await store.updateConnection(connectionId, {
        consecutiveFailures: failures,
      });
      return;
    }
    await markFailing(
      connection,
      failures,
      `${String(failures)} deliveries in a row failed`,
    );
  };

  // Google refused the Owner's sign-in (FR-91): every Google Connection is
  // failing from now, not after 5 deliveries each, and a new sign-in lets
  // what waits for them go at once.
  options.google?.onRevoked(async () => {
    for (const connection of await store.connections()) {
      if (isGoogleConnection(connection.type) && connection.status === "ok") {
        await markFailing(
          connection,
          connection.consecutiveFailures,
          "Google refused AI Office's sign-in. Sign in to Google again",
          "google_sign_in_revoked",
        );
      }
    }
  });
  options.google?.onSignedIn(async () => {
    for (const connection of await store.connections()) {
      if (isGoogleConnection(connection.type)) {
        await store.retryPending(connection.id, now());
      }
    }
    wake();
  });

  const backoffMs = (attempts: number): number =>
    Math.min(
      retry.initialDelayMs * retry.multiplier ** Math.max(0, attempts - 1),
      retry.maxDelayMs,
    );

  /**
   * One attempt at a queued delivery: `attempted`, or `held` for quiet
   * hours (FR-92), or `skipped` while its Connection is paused or gone.
   */
  const attempt = async (
    delivery: DeliveryRecord,
  ): Promise<"attempted" | "held" | "skipped"> => {
    const connection = await store.connection(delivery.connectionId);
    if (connection === undefined || connection.paused) {
      return "skipped";
    }
    const at = now();
    const held = heldUntil(
      connection.rules,
      connection.lastDigestAt ?? connection.createdAt,
      delivery.message,
      at,
    );
    if (held !== undefined) {
      await store.updateDelivery(delivery.id, { nextAttemptAt: held });
      return "held";
    }
    const firstAttemptAt = delivery.firstAttemptAt ?? at;
    const attempts = delivery.attempts + 1;
    try {
      await send(connection, delivery);
    } catch (error) {
      const wait =
        error instanceof DeliveryError && error.retryAfterMs !== undefined
          ? Math.max(error.retryAfterMs, minimumRetryDelayMs)
          : backoffMs(attempts);
      const next = new Date(at.getTime() + wait);
      const givenUp =
        next.getTime() > firstAttemptAt.getTime() + retry.giveUpAfterMs;
      await store.updateDelivery(delivery.id, {
        status: givenUp ? "failed" : "pending",
        attempts,
        firstAttemptAt,
        lastAttemptAt: at,
        nextAttemptAt: givenUp ? null : next,
        error: errorText(error),
      });
      if (givenUp) {
        await events.publish({
          type: "connection.delivery_expired",
          version: 1,
          connectionId: connection.id,
          name: connection.name,
          deliveryId: delivery.id,
          attempts,
        });
      }
      await failed(connection.id);
      return "attempted";
    }
    await store.updateDelivery(delivery.id, {
      status: "delivered",
      attempts,
      firstAttemptAt,
      lastAttemptAt: at,
      nextAttemptAt: null,
      deliveredAt: now(),
      error: null,
    });
    await succeeded(connection.id);
    return "attempted";
  };

  /** The Digest's text: from the Agent's Model, or a template (FR-90). */
  const digestText = async (
    data: ReturnType<typeof digestData>,
  ): Promise<string> => {
    const writer = options.digestWriter;
    if (writer === undefined || data.items.length === 0) {
      return templateDigest(data);
    }
    const agent = await agentInfo();
    if (agent.model === null) {
      return templateDigest(data);
    }
    try {
      // What the Model reads is redacted too: a title can hold a secret.
      return await writer.write({
        agentName: agent.name,
        model: agent.model,
        data: redactor.redact(data),
      });
    } catch (error) {
      report(error);
      return templateDigest(data);
    }
  };

  /** Makes a Connection's Digest of what happened since the last one. */
  const makeDigest = async (
    connection: ConnectionRecord,
    since: Date,
    at: Date,
  ): Promise<void> => {
    let cursor = connection.digestCursor;
    const made: EventMessage[] = [];
    for (;;) {
      const batch = await events.eventsAfter(
        cursor,
        { types: triggerEventTypes },
        100,
      );
      if (batch.length === 0) {
        break;
      }
      for (const stored of batch) {
        cursor = stored.id;
        const message = await messageFor(stored, sources);
        if (
          message !== undefined &&
          message.aboutConnectionId !== connection.id &&
          passesFloors(connection.rules, message)
        ) {
          made.push(message);
        }
      }
    }
    const progress = { digestCursor: cursor, lastDigestAt: at };
    // Nothing happened: nothing is sent.
    if (made.length === 0) {
      await store.recordDigest(connection.id, progress, undefined);
      return;
    }
    const data = digestData(made, connection.detailLevel, { since, until: at });
    const message = redactor.redact({
      kind: "digest" as const,
      title: `Digest: ${digestCounts(data)}`,
      summary: (await digestText(data)).slice(0, 3000),
      floor: null,
      aiOfficeUrl: officeUrl(publicUrl, "/activity"),
      githubUrl: null,
      occurredAt: at.toISOString(),
    });
    await store.recordDigest(connection.id, progress, {
      id: newId("delivery"),
      connectionId: connection.id,
      eventId: null,
      test: false,
      message,
      status: "pending",
      attempts: 0,
      createdAt: at,
      nextAttemptAt: at,
      firstAttemptAt: null,
      lastAttemptAt: null,
      deliveredAt: null,
      error: null,
    });
  };

  /** Makes every Digest that is due, outside its Connection's quiet hours. */
  const makeDueDigests = async (): Promise<void> => {
    const at = now();
    for (const connection of await store.connections()) {
      if (connection.paused) {
        continue;
      }
      const since = connection.lastDigestAt ?? connection.createdAt;
      const made = digestMadeAt(connection.rules, since, at);
      if (made !== undefined && made.getTime() <= at.getTime()) {
        await makeDigest(connection, since, at);
      }
    }
  };

  const delivering = oneAtATime(
    async (): Promise<number> => {
      let sent = 0;
      let digests = false;
      for (;;) {
        // Paused, nothing is sent: deliveries wait until it resumes (FR-90).
        const agent = await store.agent();
        if (agent?.enabled !== true) {
          return sent;
        }
        if (!digests) {
          digests = true;
          await makeDueDigests();
        }
        const due = await store.due(now(), 20);
        if (due.length === 0) {
          return sent;
        }
        const outcomes = [];
        for (const delivery of due) {
          outcomes.push(await attempt(delivery));
        }
        sent += outcomes.filter((outcome) => outcome === "attempted").length;
        // Nothing moved on: it is left for the next run.
        if (outcomes.every((outcome) => outcome === "skipped")) {
          return sent;
        }
      }
    },
    (a, b) => a + b,
  );

  /** A report's summary: from the Agent's Model, or a template (FR-90). */
  const reportSummary = async (
    batchReport: BatchReport,
    detailLevel: DetailLevel,
  ): Promise<string> => {
    const writer = options.reportWriter;
    if (writer === undefined || detailLevel === "links_only") {
      return templateReportSummary(batchReport, detailLevel);
    }
    const agent = await agentInfo();
    if (agent.model === null) {
      return templateReportSummary(batchReport, detailLevel);
    }
    try {
      return await writer.write({
        agentName: agent.name,
        model: agent.model,
        data: reportData(batchReport),
      });
    } catch (error) {
      report(error);
      return templateReportSummary(batchReport, detailLevel);
    }
  };

  /**
   * What `publication` sends each publishing destination it is for, at its
   * detail level, redacted: a report within its Floors, a changelog entry
   * only with its changelog on.
   */
  const publicationsTo = async (
    publication: Publication,
    connections: readonly ConnectionRecord[],
    occurredAt: Date,
  ): Promise<Map<string, OutboundMessage>> => {
    const made = new Map<DetailLevel, OutboundMessage>();
    const messageAt = async (detailLevel: DetailLevel) => {
      const ready = made.get(detailLevel);
      if (ready !== undefined) {
        return ready;
      }
      let message: OutboundMessage;
      if (publication.kind === "report") {
        // Redacted before its Markdown is written: escaping could split a
        // credential so the redactor no longer matched it.
        const batchReport = redactor.redact(publication.report);
        const summary = redactor.redactText(
          await reportSummary(batchReport, detailLevel),
        );
        message = redactor.redact(
          reportMessage(
            batchReport,
            detailLevel,
            summary,
            publication.aiOfficeUrl,
            occurredAt,
          ),
        );
      } else {
        message = redactor.redact(
          changelogMessage(publication.message, detailLevel, occurredAt),
        );
      }
      made.set(detailLevel, message);
      return message;
    };
    const messages = new Map<string, OutboundMessage>();
    for (const connection of connections) {
      if (
        passesFloors(connection.rules, publication) &&
        (publication.kind === "report" || connection.rules.changelog === true)
      ) {
        messages.set(connection.id, await messageAt(connection.detailLevel));
      }
    }
    return messages;
  };

  /**
   * What a Batch's start or finish sends each calendar it is for, within
   * its Floors, at its detail level, redacted (FR-92, FR-95).
   */
  const calendarMessagesTo = (
    publication: CalendarPublication,
    connections: readonly ConnectionRecord[],
    occurredAt: Date,
  ): Map<string, OutboundMessage> => {
    // Redacted before its Markdown is written, as a report is.
    const redacted = redactor.redact(publication);
    const messages = new Map<string, OutboundMessage>();
    for (const connection of connections) {
      if (passesFloors(connection.rules, publication)) {
        messages.set(
          connection.id,
          redactor.redact(
            calendarMessage(redacted, connection.detailLevel, occurredAt),
          ),
        );
      }
    }
    return messages;
  };

  /**
   * What a work log is sent of an event (FR-92): a completed issue's row
   * within its Floors; or, with its Notices rule, a Notice's, unless the
   * Notice is about that Connection.
   */
  const workLogMessage = (
    connection: ConnectionRecord,
    row: WorkLogPublication | undefined,
    made: EventMessage | undefined,
  ): Omit<OutboundMessage, "occurredAt"> | undefined => {
    if (row !== undefined) {
      return passesFloors(connection.rules, row) ? row.message : undefined;
    }
    const notice =
      made !== undefined &&
      (made.message.kind === "action_notice" ||
        made.message.kind === "info_notice");
    return notice &&
      connection.rules.notices === true &&
      connection.id !== made.aboutConnectionId &&
      passesFloors(connection.rules, made)
      ? made.message
      : undefined;
  };

  /** A new delivery of `message` to a Connection, due now. */
  const deliveryOf = (
    connectionId: string,
    eventId: number,
    message: OutboundMessage,
  ): DeliveryRecord => ({
    id: newId("delivery"),
    connectionId,
    eventId,
    test: false,
    message,
    status: "pending",
    attempts: 0,
    createdAt: now(),
    nextAttemptAt: now(),
    firstAttemptAt: null,
    lastAttemptAt: null,
    deliveredAt: null,
    error: null,
  });

  const takingIn = oneAtATime(
    async (): Promise<boolean> => {
      await ensureAgent();
      let queued = false;
      for (;;) {
        const cursor = await store.eventCursor();
        const batch = await events.eventsAfter(
          cursor,
          { types: takenInTypes },
          100,
        );
        if (batch.length === 0) {
          break;
        }
        const connections = await store.connections();
        for (const stored of batch) {
          // Only Connections that were there, and are not paused, are sent it.
          const open = connections.filter(
            (connection) =>
              !connection.paused &&
              connection.createdAt.getTime() <= stored.occurredAt.getTime(),
          );
          const notifying = open.filter(
            ({ type }) => !isPublishingDestination(type),
          );
          const workLogs = open.filter(({ type }) => isWorkLog(type));
          const calendars = open.filter(({ type }) => isCalendar(type));
          const publishing = open.filter(
            ({ type }) =>
              isPublishingDestination(type) &&
              !isWorkLog(type) &&
              !isCalendar(type),
          );
          const made =
            notifying.length === 0 && workLogs.length === 0
              ? undefined
              : await messageFor(stored, sources);
          const publication =
            publishing.length === 0
              ? undefined
              : await publicationFor(stored, publicationSources);
          const row =
            workLogs.length === 0
              ? undefined
              : await workLogFor(stored, publicationSources);
          const calendarPublication =
            calendars.length === 0
              ? undefined
              : await calendarPublicationFor(stored, publicationSources);
          const deliveries: DeliveryRecord[] = [
            ...(made === undefined
              ? []
              : notifying
                  .filter(
                    (connection) =>
                      connection.id !== made.aboutConnectionId &&
                      passesRules(connection.rules, made),
                  )
                  .map((connection) =>
                    deliveryOf(
                      connection.id,
                      stored.id,
                      redactor.redact(
                        atDetailLevel(
                          {
                            ...made.message,
                            occurredAt: stored.occurredAt.toISOString(),
                          },
                          connection.detailLevel,
                        ),
                      ),
                    ),
                  )),
            ...(publication === undefined
              ? []
              : [
                  ...(await publicationsTo(
                    publication,
                    publishing,
                    stored.occurredAt,
                  )),
                ].map(([connectionId, message]) =>
                  deliveryOf(connectionId, stored.id, message),
                )),
            ...(calendarPublication === undefined
              ? []
              : [
                  ...calendarMessagesTo(
                    calendarPublication,
                    calendars,
                    stored.occurredAt,
                  ),
                ].map(([connectionId, message]) =>
                  deliveryOf(connectionId, stored.id, message),
                )),
            ...workLogs.flatMap((connection) => {
              const message = workLogMessage(connection, row, made);
              return message === undefined
                ? []
                : [
                    deliveryOf(
                      connection.id,
                      stored.id,
                      redactor.redact(
                        atDetailLevel(
                          {
                            ...message,
                            occurredAt: stored.occurredAt.toISOString(),
                          },
                          connection.detailLevel,
                        ),
                      ),
                    ),
                  ];
            }),
          ];
          await store.enqueue(deliveries, stored.id);
          queued ||= deliveries.length > 0;
        }
      }
      return queued;
    },
    (a, b) => a || b,
  );

  const takeIn = async (): Promise<void> => {
    await takingIn.run();
  };
  const deliverDue = delivering.run;
  const wake = () => {
    void deliverDue().catch(report);
  };

  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  return {
    agent: agentInfo,

    async updateAgent(changes) {
      const before = await agentInfo();
      const keys = (Object.keys(changes) as (keyof typeof changes)[]).filter(
        (key) =>
          key === "avatar"
            ? JSON.stringify(changes.avatar) !== JSON.stringify(before.avatar)
            : changes[key] !== before[key],
      );
      // A new AI Provider without a Model of its own uses its default.
      const modelOverride =
        changes.aiProvider !== undefined &&
        changes.aiProvider !== before.aiProvider &&
        changes.modelOverride === undefined
          ? { modelOverride: null }
          : {};
      if (keys.length > 0) {
        await store.updateAgent({ ...definedOf(changes), ...modelOverride });
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "communications",
          keys,
        });
      }
      if (changes.enabled === true) {
        wake();
      }
      return agentInfo();
    },

    async list() {
      return Promise.all((await store.connections()).map(infoOf));
    },

    async get(connectionId) {
      return infoOf(await find(connectionId));
    },

    async add(request) {
      // Its first events are those after the Agent was made.
      await ensureAgent();
      const transport = transportOf(request.type);
      const credentials = transport.credentials.parse(request.credentials);
      const id = newId("connection");
      const { hint, settings } = transport.describe(credentials);
      const connection: ConnectionRecord = {
        id,
        name: request.name,
        type: request.type,
        rules: rulesFor(
          request.type,
          request.rules ?? defaultRulesFor(request.type),
        ),
        detailLevel: request.detailLevel ?? defaultDetailLevel,
        settings,
        credentials: encryptor.encrypt(
          JSON.stringify(credentials),
          connectionCredentialsContext(id),
        ),
        hint,
        paused: false,
        status: "ok",
        consecutiveFailures: 0,
        // Its first Digest tells of what happens from now on.
        digestCursor: await latestEventId(),
        lastDigestAt: null,
        createdAt: now(),
      };
      try {
        await store.addConnection(connection);
      } catch (error) {
        if (error instanceof ConnectionNameTakenError) {
          throw nameTaken(request.name);
        }
        throw error;
      }
      await events.publish({
        type: "connection.added",
        version: 1,
        connectionId: id,
        name: connection.name,
        connectionType: connection.type,
      });
      return infoOf(connection);
    },

    async update(connectionId, requested) {
      const before = await find(connectionId);
      // A publishing destination keeps only its Floors and changelog.
      const changes =
        requested.rules === undefined
          ? requested
          : { ...requested, rules: rulesFor(before.type, requested.rules) };
      const keys = (Object.keys(changes) as (keyof typeof changes)[]).filter(
        (key) => JSON.stringify(changes[key]) !== JSON.stringify(before[key]),
      );
      if (keys.length === 0) {
        return infoOf(before);
      }
      // A Digest turned on tells of what happens from now on.
      const digestBegins =
        changes.rules?.digest !== undefined && before.rules.digest === undefined
          ? { digestCursor: await latestEventId(), lastDigestAt: now() }
          : {};
      let after: ConnectionRecord | undefined;
      try {
        after = await store.updateConnection(connectionId, {
          ...definedOf(changes),
          ...digestBegins,
        });
      } catch (error) {
        if (error instanceof ConnectionNameTakenError) {
          throw nameTaken(changes.name ?? before.name);
        }
        throw error;
      }
      if (after === undefined) {
        return infoOf(await find(connectionId));
      }
      await events.publish({
        type: "connection.changed",
        version: 1,
        connectionId,
        name: after.name,
        keys,
        ...(keys.includes("paused") ? { paused: after.paused } : {}),
      });
      // What new quiet hours or a new Digest no longer hold is looked at
      // again now.
      if (
        changes.rules !== undefined &&
        JSON.stringify([changes.rules.quietHours, changes.rules.digest]) !==
          JSON.stringify([before.rules.quietHours, before.rules.digest])
      ) {
        await store.releaseHeld(connectionId, now());
        wake();
      }
      if (changes.paused === false) {
        wake();
      }
      return infoOf(after);
    },

    async remove(connectionId) {
      const removed = await store.removeConnection(connectionId);
      if (removed === undefined) {
        throw new CommunicationsError(
          connectionErrorCodes.connectionNotFound,
          `There is no Connection "${connectionId}".`,
        );
      }
      await events.publish({
        type: "connection.removed",
        version: 1,
        connectionId,
        name: removed.name,
      });
    },

    async sendTest(connectionId) {
      const connection = await find(connectionId);
      const at = now();
      const delivery = {
        id: newId("delivery"),
        message: testMessage(publicUrl, connectionId, at),
        test: true,
      };
      let error: string | null = null;
      try {
        await send(connection, delivery);
      } catch (caught) {
        error = errorText(caught);
      }
      await store.addDelivery({
        ...delivery,
        connectionId,
        eventId: null,
        status: error === null ? "delivered" : "failed",
        attempts: 1,
        createdAt: at,
        nextAttemptAt: null,
        firstAttemptAt: at,
        lastAttemptAt: at,
        deliveredAt: error === null ? now() : null,
        error,
      });
      return {
        delivered: error === null,
        error,
        connection: await infoOf(await find(connectionId)),
      };
    },

    async deliveries(connectionId, limit = 50) {
      await find(connectionId);
      return store.deliveries(connectionId, limit);
    },

    takeIn,
    deliverDue,

    async start() {
      await ensureAgent();
      // What an event queues is sent at once.
      unsubscribe = events.subscribe(
        () => {
          void takingIn
            .run()
            .then((queued) => {
              if (queued) {
                wake();
              }
            })
            .catch(report);
        },
        { types: takenInTypes },
      );
      await takeIn().catch(report);
      wake();
      timer = setInterval(() => {
        void takeIn()
          .then(() => deliverDue())
          .catch(report);
      }, pollMs);
      timer.unref();
    },

    async stop() {
      clearInterval(timer);
      unsubscribe?.();
      // What is in hand finishes; anything else waits in the queue.
      await Promise.all([takingIn.idle(), delivering.idle()]);
    },
  };
}
