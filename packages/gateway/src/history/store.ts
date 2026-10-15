import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  deleteGatewayRequestsBefore,
  gatewayRequestBodies,
  gatewayRequests,
  gatewayUsageDays,
  type Database,
} from "@ai-office/db";
import {
  addTokens,
  noTokens,
  type AnalyticsBucket,
  type GatewayRequestFilter,
  type TokenTotals,
  type TokenUsageRow,
} from "@ai-office/shared";
import {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { GatewayEndpoint, GatewayRequestRecord } from "../request-log.ts";

// Where request history lives (PRD FR-44): `gateway_requests`, with sealed
// bodies in `gateway_request_bodies`, or memory for tests. The store only
// ever sees bodies sealed. Retention (PRD §7) deletes bodies, then
// requests; what deleted requests used stays, a UTC day at a time, in
// `gateway_usage_days`, so token accounting still counts it.

/** A request as history keeps it, with its id. */
export interface StoredRequest extends Omit<GatewayRequestRecord, "bodies"> {
  readonly id: number;
}

/** A request's bodies, each sealed with ENCRYPTION_KEY. */
export interface SealedBodies {
  readonly request: string;
  readonly response: string;
  readonly truncated: boolean;
}

/** Which requests to read: the filters, a time range, and a page. */
export interface HistoryQuery extends GatewayRequestFilter {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** Only requests with a smaller id: the next page. */
  readonly before?: number | undefined;
  readonly limit: number;
}

export interface RequestHistoryStore {
  /**
   * Stores a request, and its bodies when `seal` is given, sealed for the
   * id the request gets. Resolves with the stored request.
   */
  insert(
    record: Omit<GatewayRequestRecord, "bodies">,
    seal?: (id: number) => SealedBodies,
  ): Promise<StoredRequest>;
  /** Requests matching `query`, newest first. */
  list(query: HistoryQuery): Promise<StoredRequest[]>;
  get(
    id: number,
  ): Promise<
    { request: StoredRequest; bodies: SealedBodies | undefined } | undefined
  >;
  /** Requests after `afterId` matching `filter`, oldest first. */
  after(
    afterId: number,
    filter: GatewayRequestFilter,
    limit: number,
  ): Promise<StoredRequest[]>;
  /**
   * The input and output tokens each request served by an AI Account used
   * since `since`, oldest first: what least-used starts from.
   */
  accountUsageSince(since: Date): Promise<AccountUsage[]>;
  /**
   * What each Gateway Key's requests (those retention has kept) added up
   * to: how many, their tokens and estimated cost, and the latest.
   */
  keyUsage(): Promise<KeyUsage[]>;
  /**
   * What requests started in [`from`, `to`) used, added up per Floor,
   * Agent, issue and Owner tool (FR-31, FR-32). Requests retention has
   * deleted count by their UTC day: those of the days starting in
   * [`from`, `to`), which is exact for the days and months Token Caps use.
   */
  tokenUsage(from: Date, to: Date): Promise<TokenUsageRow[]>;
  /**
   * Deletes the bodies of requests started before `before`, keeping the
   * requests (retention, PRD §7). Resolves with how many requests' bodies
   * went.
   */
  deleteBodiesBefore(before: Date): Promise<number>;
  /**
   * Deletes the requests started before `before`, and their bodies, once
   * what they used is added to its UTC day's totals for its caller
   * (retention, PRD §7), so `tokenUsage` still counts it. Resolves with how
   * many requests went.
   */
  deleteBefore(before: Date): Promise<number>;
  /**
   * What requests started in [`from`, `to`) added up to, per `bucket` of
   * time (UTC), AI Account, Model, Floor, Agent, issue and Owner tool: the
   * finest grain analytics roll up from (FR-43); only one AI Account's,
   * when `filter` names it.
   */
  analyticsRows(
    from: Date,
    to: Date,
    bucket: AnalyticsBucket,
    filter?: AnalyticsFilter,
  ): Promise<AnalyticsRow[]>;
}

/**
 * Which requests analytics add up: one AI Account's (its chart in AI
 * Settings, FR-43), by its id, and by its name for the days retention has
 * folded into `gateway_usage_days`, which keep only the name.
 */
export interface AnalyticsFilter {
  readonly aiAccount?: { readonly id: string; readonly name: string };
}

/** Requests in one bucket of time, for one account, Model and caller. */
export interface AnalyticsRow {
  /** When the bucket starts. */
  readonly at: Date;
  /** The AI Account that served them, by name; null for none. */
  readonly account: string | null;
  readonly model: string | null;
  readonly floorId: string | null;
  readonly agentId: string | null;
  readonly issue: number | null;
  readonly ownerTool: string | null;
  readonly requests: number;
  /** Answered with a status of 400 or more. */
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedCostUsd: number;
  /** Their latencies, added up. */
  readonly latencyMs: number;
  /**
   * Their times to first byte, added up, and how many had one. Requests
   * retention has deleted keep neither, so they count as untimed.
   */
  readonly timeToFirstByteMs?: number;
  readonly timedRequests?: number;
  /** Those that were prompt-cache keep-alives (FR-39), and their cost. */
  readonly keepAliveRequests: number;
  readonly keepAliveCostUsd: number;
}

/** When the bucket holding `at` starts, in UTC. */
export function bucketStart(at: Date, bucket: AnalyticsBucket): Date {
  const start = new Date(at);
  if (bucket === "day") {
    start.setUTCHours(0, 0, 0, 0);
  } else {
    start.setUTCMinutes(0, 0, 0);
  }
  return start;
}

/** What analytics groups requests by: a bucket of time, what, who. */
type AnalyticsGroup = Pick<
  AnalyticsRow,
  "at" | "account" | "model" | "floorId" | "agentId" | "issue" | "ownerTool"
>;

const analyticsGroupOf = (
  request: StoredRequest,
  bucket: AnalyticsBucket,
): AnalyticsGroup => ({
  at: bucketStart(request.startedAt, bucket),
  account: request.account,
  model: request.model,
  floorId: request.floorId,
  agentId: request.agentId,
  issue: request.issue,
  ownerTool: request.ownerTool,
});

/** One request, as analytics adds it up. */
const analyticsOf = (request: StoredRequest): AnalyticsRow => ({
  ...analyticsGroupOf(request, "day"),
  requests: 1,
  errors: request.status >= 400 ? 1 : 0,
  inputTokens: request.inputTokens ?? 0,
  outputTokens: request.outputTokens ?? 0,
  cacheReadTokens: request.cacheReadInputTokens ?? 0,
  cacheWriteTokens: request.cacheCreationInputTokens ?? 0,
  estimatedCostUsd: request.estimatedCostUsd ?? 0,
  latencyMs: request.latencyMs,
  timeToFirstByteMs: request.timeToFirstByteMs ?? 0,
  timedRequests: request.timeToFirstByteMs === null ? 0 : 1,
  keepAliveRequests: request.keepAlive === true ? 1 : 0,
  keepAliveCostUsd:
    request.keepAlive === true ? (request.estimatedCostUsd ?? 0) : 0,
});

/** Adds `row` into `rows`, keyed by its group. */
const addAnalytics = (
  rows: Map<string, AnalyticsRow>,
  row: AnalyticsRow,
): void => {
  const { at, account, model, floorId, agentId, issue, ownerTool } = row;
  const key = JSON.stringify({
    at,
    account,
    model,
    floorId,
    agentId,
    issue,
    ownerTool,
  });
  const held = rows.get(key);
  rows.set(
    key,
    held === undefined
      ? {
          ...row,
          timeToFirstByteMs: row.timeToFirstByteMs ?? 0,
          timedRequests: row.timedRequests ?? 0,
        }
      : {
          ...held,
          requests: held.requests + row.requests,
          errors: held.errors + row.errors,
          inputTokens: held.inputTokens + row.inputTokens,
          outputTokens: held.outputTokens + row.outputTokens,
          cacheReadTokens: held.cacheReadTokens + row.cacheReadTokens,
          cacheWriteTokens: held.cacheWriteTokens + row.cacheWriteTokens,
          estimatedCostUsd: held.estimatedCostUsd + row.estimatedCostUsd,
          latencyMs: held.latencyMs + row.latencyMs,
          timeToFirstByteMs:
            (held.timeToFirstByteMs ?? 0) + (row.timeToFirstByteMs ?? 0),
          timedRequests: (held.timedRequests ?? 0) + (row.timedRequests ?? 0),
          keepAliveRequests: held.keepAliveRequests + row.keepAliveRequests,
          keepAliveCostUsd: held.keepAliveCostUsd + row.keepAliveCostUsd,
        },
  );
};

/** Tokens one request used on one AI Account. */
export interface AccountUsage {
  readonly accountId: string;
  readonly tokens: number;
  readonly at: Date;
}

/** What one Gateway Key's requests added up to. */
export interface KeyUsage {
  readonly gatewayKeyId: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Their estimated cost in US dollars, where known (FR-43). */
  readonly estimatedCostUsd: number;
  readonly lastRequestAt: Date;
}

/** A request's input and output tokens, as Token Caps count them. */
const tokensOf = (request: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}): number => (request.inputTokens ?? 0) + (request.outputTokens ?? 0);

/** One request's tokens, as token accounting adds them up. */
export const requestTokens = (request: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly estimatedCostUsd: number | null;
}): TokenTotals => ({
  requests: 1,
  inputTokens: request.inputTokens ?? 0,
  outputTokens: request.outputTokens ?? 0,
  cacheReadTokens: request.cacheReadInputTokens ?? 0,
  cacheWriteTokens: request.cacheCreationInputTokens ?? 0,
  tokens: tokensOf(request),
  estimatedCostUsd: request.estimatedCostUsd ?? 0,
});

/** The status range a status filter means. */
const statusRange = (
  status: GatewayRequestFilter["status"],
): [number, number] | undefined =>
  status === undefined
    ? undefined
    : typeof status === "number"
      ? [status, status]
      : [Number(status[0]) * 100, Number(status[0]) * 100 + 99];

/** The fields a search looks in. */
const searched = (request: StoredRequest): (string | null)[] => [
  request.endpoint,
  request.model,
  request.account,
  request.ownerTool,
  request.agentId,
  request.floorId,
  request.upstreamRequestId,
];

/** Whether `request` matches `filter`. */
export function matchesRequestFilter(
  request: StoredRequest,
  filter: GatewayRequestFilter,
): boolean {
  const range = statusRange(filter.status);
  const q = filter.q?.toLowerCase();
  return (
    (range === undefined ||
      (request.status >= range[0] && request.status <= range[1])) &&
    (filter.endpoint === undefined || request.endpoint === filter.endpoint) &&
    (filter.model === undefined || request.model === filter.model) &&
    (filter.accountId === undefined ||
      request.accountId === filter.accountId) &&
    (filter.agentId === undefined || request.agentId === filter.agentId) &&
    (filter.floorId === undefined || request.floorId === filter.floorId) &&
    (filter.ownerTool === undefined ||
      request.ownerTool === filter.ownerTool) &&
    (filter.session === undefined ||
      (request.session ?? null) === filter.session) &&
    (q === undefined ||
      searched(request).some((value) => value?.toLowerCase().includes(q)))
  );
}

/** Keeps request history in memory: for tests. */
export function memoryRequestHistoryStore(): RequestHistoryStore & {
  readonly bodies: Map<number, SealedBodies>;
} {
  const requests: StoredRequest[] = [];
  const bodies = new Map<number, SealedBodies>();
  // What deleted requests used, per UTC day, AI Account, Model and caller.
  const days = new Map<string, AnalyticsRow>();
  let lastId = 0;
  const callerOf = (request: StoredRequest) => ({
    floorId: request.floorId,
    agentId: request.agentId,
    issue: request.issue,
    ownerTool: request.ownerTool,
  });
  return {
    bodies,
    insert(record, seal) {
      lastId += 1;
      const stored = { ...record, id: lastId };
      requests.push(stored);
      if (seal !== undefined) {
        bodies.set(stored.id, seal(stored.id));
      }
      return Promise.resolve(stored);
    },
    list(query) {
      return Promise.resolve(
        requests
          .filter(
            (request) =>
              matchesRequestFilter(request, query) &&
              (query.before === undefined || request.id < query.before) &&
              (query.from === undefined || request.startedAt >= query.from) &&
              (query.to === undefined || request.startedAt <= query.to),
          )
          .reverse()
          .slice(0, query.limit),
      );
    },
    get(id) {
      const request = requests.find((stored) => stored.id === id);
      return Promise.resolve(
        request === undefined ? undefined : { request, bodies: bodies.get(id) },
      );
    },
    after(afterId, filter, limit) {
      return Promise.resolve(
        requests
          .filter(
            (request) =>
              request.id > afterId && matchesRequestFilter(request, filter),
          )
          .slice(0, limit),
      );
    },
    accountUsageSince(since) {
      return Promise.resolve(
        requests.flatMap((request) =>
          request.accountId !== null &&
          request.startedAt > since &&
          tokensOf(request) > 0
            ? [
                {
                  accountId: request.accountId,
                  tokens: tokensOf(request),
                  at: request.startedAt,
                },
              ]
            : [],
        ),
      );
    },
    keyUsage() {
      const usage = new Map<string, KeyUsage>();
      for (const request of requests) {
        if (request.gatewayKeyId === null) {
          continue;
        }
        const before = usage.get(request.gatewayKeyId);
        usage.set(request.gatewayKeyId, {
          gatewayKeyId: request.gatewayKeyId,
          requests: (before?.requests ?? 0) + 1,
          inputTokens: (before?.inputTokens ?? 0) + (request.inputTokens ?? 0),
          outputTokens:
            (before?.outputTokens ?? 0) + (request.outputTokens ?? 0),
          estimatedCostUsd:
            (before?.estimatedCostUsd ?? 0) + (request.estimatedCostUsd ?? 0),
          lastRequestAt:
            before === undefined || request.startedAt > before.lastRequestAt
              ? request.startedAt
              : before.lastRequestAt,
        });
      }
      return Promise.resolve([...usage.values()]);
    },
    tokenUsage(from, to) {
      const rows = new Map<string, TokenUsageRow>();
      const add = ({ totals, ...caller }: TokenUsageRow) => {
        const key = JSON.stringify(caller);
        rows.set(key, {
          ...caller,
          totals: addTokens(rows.get(key)?.totals ?? noTokens, totals),
        });
      };
      for (const request of requests) {
        if (request.startedAt >= from && request.startedAt < to) {
          add({ ...callerOf(request), totals: requestTokens(request) });
        }
      }
      for (const row of days.values()) {
        if (row.at >= from && row.at < to) {
          add({
            floorId: row.floorId,
            agentId: row.agentId,
            issue: row.issue,
            ownerTool: row.ownerTool,
            totals: {
              requests: row.requests,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cacheReadTokens: row.cacheReadTokens,
              cacheWriteTokens: row.cacheWriteTokens,
              tokens: row.inputTokens + row.outputTokens,
              estimatedCostUsd: row.estimatedCostUsd,
            },
          });
        }
      }
      return Promise.resolve([...rows.values()]);
    },
    deleteBodiesBefore(before) {
      let deleted = 0;
      for (const request of requests) {
        if (request.startedAt < before && bodies.delete(request.id)) {
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
    deleteBefore(before) {
      const kept: StoredRequest[] = [];
      for (const request of requests) {
        if (request.startedAt >= before) {
          kept.push(request);
          continue;
        }
        bodies.delete(request.id);
        // A day's totals keep no time to first byte.
        addAnalytics(days, {
          ...analyticsOf(request),
          timeToFirstByteMs: 0,
          timedRequests: 0,
        });
      }
      const deleted = requests.length - kept.length;
      requests.splice(0, requests.length, ...kept);
      return Promise.resolve(deleted);
    },
    analyticsRows(from, to, bucket, filter = {}) {
      const { aiAccount } = filter;
      const rows = new Map<string, AnalyticsRow>();
      for (const request of requests) {
        if (
          request.startedAt >= from &&
          request.startedAt < to &&
          (aiAccount === undefined || request.accountId === aiAccount.id)
        ) {
          addAnalytics(rows, {
            ...analyticsOf(request),
            ...analyticsGroupOf(request, bucket),
          });
        }
      }
      // Deleted requests count by their day, in a day's bucket alone.
      if (bucket === "day") {
        for (const row of days.values()) {
          if (
            row.at >= from &&
            row.at < to &&
            (aiAccount === undefined || row.account === aiAccount.name)
          ) {
            addAnalytics(rows, row);
          }
        }
      }
      return Promise.resolve([...rows.values()]);
    },
  };
}

type Row = typeof gatewayRequests.$inferSelect;

const headers = (value: unknown): Readonly<Record<string, string>> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, string>)
    : null;

const toStored = (row: Row): StoredRequest => ({
  id: row.id,
  startedAt: row.startedAt,
  account: row.account,
  accountId: row.aiAccountId,
  endpoint: row.endpoint as GatewayEndpoint,
  model: row.model,
  streamed: row.streamed,
  status: row.status,
  latencyMs: row.latencyMs,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadInputTokens: row.cacheReadInputTokens,
  cacheCreationInputTokens: row.cacheCreationInputTokens,
  upstreamRequestId: row.upstreamRequestId,
  gatewayKeyId: row.gatewayKeyId,
  agentId: row.agentId,
  floorId: row.floorId,
  ownerTool: row.ownerTool,
  issue: row.issue,
  pullRequest: row.pullRequest,
  session: row.session,
  estimatedCostUsd: row.estimatedCostUsd,
  timeToFirstByteMs: row.timeToFirstByteMs,
  requestHeaders: headers(row.requestHeaders),
  responseHeaders: headers(row.responseHeaders),
  keepAlive: row.keepAlive,
});

/** The SQL conditions a filter means. */
function conditions(filter: GatewayRequestFilter): SQL[] {
  const where: SQL[] = [];
  const range = statusRange(filter.status);
  if (range !== undefined) {
    where.push(between(gatewayRequests.status, range[0], range[1]));
  }
  if (filter.endpoint !== undefined) {
    where.push(eq(gatewayRequests.endpoint, filter.endpoint));
  }
  if (filter.model !== undefined) {
    where.push(eq(gatewayRequests.model, filter.model));
  }
  if (filter.accountId !== undefined) {
    where.push(eq(gatewayRequests.aiAccountId, filter.accountId));
  }
  if (filter.agentId !== undefined) {
    where.push(eq(gatewayRequests.agentId, filter.agentId));
  }
  if (filter.floorId !== undefined) {
    where.push(eq(gatewayRequests.floorId, filter.floorId));
  }
  if (filter.ownerTool !== undefined) {
    where.push(eq(gatewayRequests.ownerTool, filter.ownerTool));
  }
  if (filter.session !== undefined) {
    where.push(eq(gatewayRequests.session, filter.session));
  }
  if (filter.q !== undefined) {
    const pattern = `%${filter.q.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const any = or(
      ...[
        gatewayRequests.endpoint,
        gatewayRequests.model,
        gatewayRequests.account,
        gatewayRequests.ownerTool,
        gatewayRequests.agentId,
        gatewayRequests.floorId,
        gatewayRequests.upstreamRequestId,
      ].map((column) => ilike(column, pattern)),
    );
    if (any !== undefined) {
      where.push(any);
    }
  }
  return where;
}

const withoutId = (record: Omit<GatewayRequestRecord, "bodies">) => {
  const { accountId, ...rest } = record;
  return { ...rest, aiAccountId: accountId };
};

/** Keeps request history in `gateway_requests` and `gateway_request_bodies`. */
export function databaseRequestHistoryStore(db: Database): RequestHistoryStore {
  return {
    async insert(record, seal) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(gatewayRequests)
          .values(withoutId(record))
          .returning();
        if (row === undefined) {
          throw new Error("The request was not stored.");
        }
        if (seal !== undefined) {
          const sealed = seal(row.id);
          await tx.insert(gatewayRequestBodies).values({
            requestId: row.id,
            requestBody: sealed.request,
            responseBody: sealed.response,
            truncated: sealed.truncated,
          });
        }
        return toStored(row);
      });
    },

    async list(query) {
      const where = conditions(query);
      if (query.before !== undefined) {
        where.push(lt(gatewayRequests.id, query.before));
      }
      if (query.from !== undefined) {
        where.push(gte(gatewayRequests.startedAt, query.from));
      }
      if (query.to !== undefined) {
        where.push(lte(gatewayRequests.startedAt, query.to));
      }
      const rows = await db
        .select()
        .from(gatewayRequests)
        .where(and(...where))
        .orderBy(desc(gatewayRequests.id))
        .limit(query.limit);
      return rows.map(toStored);
    },

    async get(id) {
      const [row] = await db
        .select()
        .from(gatewayRequests)
        .where(eq(gatewayRequests.id, id));
      if (row === undefined) {
        return undefined;
      }
      const [bodies] = await db
        .select()
        .from(gatewayRequestBodies)
        .where(eq(gatewayRequestBodies.requestId, id));
      return {
        request: toStored(row),
        bodies:
          bodies === undefined
            ? undefined
            : {
                request: bodies.requestBody,
                response: bodies.responseBody,
                truncated: bodies.truncated,
              },
      };
    },

    async after(afterId, filter, limit) {
      const rows = await db
        .select()
        .from(gatewayRequests)
        .where(and(gt(gatewayRequests.id, afterId), ...conditions(filter)))
        .orderBy(asc(gatewayRequests.id))
        .limit(limit);
      return rows.map(toStored);
    },

    async accountUsageSince(since) {
      const rows = await db
        .select({
          accountId: gatewayRequests.aiAccountId,
          inputTokens: gatewayRequests.inputTokens,
          outputTokens: gatewayRequests.outputTokens,
          at: gatewayRequests.startedAt,
        })
        .from(gatewayRequests)
        .where(
          and(
            gt(gatewayRequests.startedAt, since),
            isNotNull(gatewayRequests.aiAccountId),
          ),
        )
        .orderBy(asc(gatewayRequests.id));
      return rows.flatMap((row) =>
        row.accountId === null || tokensOf(row) === 0
          ? []
          : [{ accountId: row.accountId, tokens: tokensOf(row), at: row.at }],
      );
    },

    async keyUsage() {
      const sum = (column: AnyPgColumn) =>
        sql<string>`coalesce(sum(${column}), 0)`.mapWith(Number);
      const rows = await db
        .select({
          gatewayKeyId: gatewayRequests.gatewayKeyId,
          requests: sql<string>`count(*)`.mapWith(Number),
          inputTokens: sum(gatewayRequests.inputTokens),
          outputTokens: sum(gatewayRequests.outputTokens),
          estimatedCostUsd: sum(gatewayRequests.estimatedCostUsd),
          lastRequestAt: sql<Date>`max(${gatewayRequests.startedAt})`.mapWith(
            (value: string | Date) => new Date(value),
          ),
        })
        .from(gatewayRequests)
        .where(isNotNull(gatewayRequests.gatewayKeyId))
        .groupBy(gatewayRequests.gatewayKeyId);
      return rows.flatMap(({ gatewayKeyId, ...usage }) =>
        gatewayKeyId === null ? [] : [{ gatewayKeyId, ...usage }],
      );
    },

    async tokenUsage(from, to) {
      // Sums of integers are bigints, which come back as strings.
      const total = (column: AnyPgColumn) =>
        sql<string>`coalesce(sum(${column}), 0)`.mapWith(Number);
      const rows = await db
        .select({
          floorId: gatewayRequests.floorId,
          agentId: gatewayRequests.agentId,
          issue: gatewayRequests.issue,
          ownerTool: gatewayRequests.ownerTool,
          requests: sql<string>`count(*)`.mapWith(Number),
          inputTokens: total(gatewayRequests.inputTokens),
          outputTokens: total(gatewayRequests.outputTokens),
          cacheReadTokens: total(gatewayRequests.cacheReadInputTokens),
          cacheWriteTokens: total(gatewayRequests.cacheCreationInputTokens),
          estimatedCostUsd:
            sql<string>`coalesce(sum(${gatewayRequests.estimatedCostUsd}), 0)`.mapWith(
              Number,
            ),
        })
        .from(gatewayRequests)
        .where(
          and(
            gte(gatewayRequests.startedAt, from),
            lt(gatewayRequests.startedAt, to),
          ),
        )
        .groupBy(
          gatewayRequests.floorId,
          gatewayRequests.agentId,
          gatewayRequests.issue,
          gatewayRequests.ownerTool,
        );
      // What deleted requests used, by the days in the range.
      const daily = await db
        .select({
          floorId: gatewayUsageDays.floorId,
          agentId: gatewayUsageDays.agentId,
          issue: gatewayUsageDays.issue,
          ownerTool: gatewayUsageDays.ownerTool,
          requests: total(gatewayUsageDays.requests),
          inputTokens: total(gatewayUsageDays.inputTokens),
          outputTokens: total(gatewayUsageDays.outputTokens),
          cacheReadTokens: total(gatewayUsageDays.cacheReadTokens),
          cacheWriteTokens: total(gatewayUsageDays.cacheWriteTokens),
          estimatedCostUsd: total(gatewayUsageDays.estimatedCostUsd),
        })
        .from(gatewayUsageDays)
        .where(
          and(gte(gatewayUsageDays.day, from), lt(gatewayUsageDays.day, to)),
        )
        .groupBy(
          gatewayUsageDays.floorId,
          gatewayUsageDays.agentId,
          gatewayUsageDays.issue,
          gatewayUsageDays.ownerTool,
        );
      const usage = new Map<string, TokenUsageRow>();
      for (const { floorId, agentId, issue, ownerTool, ...totals } of [
        ...rows,
        ...daily,
      ]) {
        const caller = { floorId, agentId, issue, ownerTool };
        const key = JSON.stringify(caller);
        usage.set(key, {
          ...caller,
          totals: addTokens(usage.get(key)?.totals ?? noTokens, {
            ...totals,
            tokens: totals.inputTokens + totals.outputTokens,
          }),
        });
      }
      return [...usage.values()];
    },

    async deleteBodiesBefore(before) {
      const deleted = await db
        .delete(gatewayRequestBodies)
        .where(
          inArray(
            gatewayRequestBodies.requestId,
            db
              .select({ id: gatewayRequests.id })
              .from(gatewayRequests)
              .where(lt(gatewayRequests.startedAt, before)),
          ),
        );
      return deleted.rowCount ?? 0;
    },

    deleteBefore: (before) => deleteGatewayRequestsBefore(db, before),

    async analyticsRows(from, to, bucket, filter = {}) {
      const { aiAccount } = filter;
      const total = (column: AnyPgColumn) =>
        sql<string>`coalesce(sum(${column}), 0)`.mapWith(Number);
      // The unit is one of two words, written into the query rather than
      // passed, so the grouping and the selection are the same expression.
      const at = sql<Date>`date_trunc(${sql.raw(bucket === "hour" ? "'hour'" : "'day'")}, ${gatewayRequests.startedAt}, 'UTC')`;
      const rows = await db
        .select({
          at: at.mapWith((value: Date | string) => new Date(value)),
          account: gatewayRequests.account,
          model: gatewayRequests.model,
          floorId: gatewayRequests.floorId,
          agentId: gatewayRequests.agentId,
          issue: gatewayRequests.issue,
          ownerTool: gatewayRequests.ownerTool,
          requests: sql<string>`count(*)`.mapWith(Number),
          errors:
            sql<string>`count(*) FILTER (WHERE ${gatewayRequests.status} >= 400)`.mapWith(
              Number,
            ),
          inputTokens: total(gatewayRequests.inputTokens),
          outputTokens: total(gatewayRequests.outputTokens),
          cacheReadTokens: total(gatewayRequests.cacheReadInputTokens),
          cacheWriteTokens: total(gatewayRequests.cacheCreationInputTokens),
          estimatedCostUsd:
            sql<string>`coalesce(sum(${gatewayRequests.estimatedCostUsd}), 0)`.mapWith(
              Number,
            ),
          latencyMs: total(gatewayRequests.latencyMs),
          timeToFirstByteMs: total(gatewayRequests.timeToFirstByteMs),
          timedRequests:
            sql<string>`count(${gatewayRequests.timeToFirstByteMs})`.mapWith(
              Number,
            ),
          keepAliveRequests:
            sql<string>`count(*) FILTER (WHERE ${gatewayRequests.keepAlive})`.mapWith(
              Number,
            ),
          keepAliveCostUsd:
            sql<string>`coalesce(sum(${gatewayRequests.estimatedCostUsd}) FILTER (WHERE ${gatewayRequests.keepAlive}), 0)`.mapWith(
              Number,
            ),
        })
        .from(gatewayRequests)
        .where(
          and(
            gte(gatewayRequests.startedAt, from),
            lt(gatewayRequests.startedAt, to),
            aiAccount === undefined
              ? undefined
              : eq(gatewayRequests.aiAccountId, aiAccount.id),
          ),
        )
        .groupBy(
          at,
          gatewayRequests.account,
          gatewayRequests.model,
          gatewayRequests.floorId,
          gatewayRequests.agentId,
          gatewayRequests.issue,
          gatewayRequests.ownerTool,
        );
      if (bucket === "hour") {
        return rows;
      }
      // Deleted requests count by their day, in a day's bucket alone; a
      // day may be partly kept and partly deleted.
      const daily = await db
        .select({
          at: gatewayUsageDays.day,
          account: gatewayUsageDays.account,
          model: gatewayUsageDays.model,
          floorId: gatewayUsageDays.floorId,
          agentId: gatewayUsageDays.agentId,
          issue: gatewayUsageDays.issue,
          ownerTool: gatewayUsageDays.ownerTool,
          requests: gatewayUsageDays.requests,
          errors: gatewayUsageDays.errors,
          inputTokens: gatewayUsageDays.inputTokens,
          outputTokens: gatewayUsageDays.outputTokens,
          cacheReadTokens: gatewayUsageDays.cacheReadTokens,
          cacheWriteTokens: gatewayUsageDays.cacheWriteTokens,
          estimatedCostUsd: gatewayUsageDays.estimatedCostUsd,
          latencyMs: gatewayUsageDays.latencyMs,
          keepAliveRequests: gatewayUsageDays.keepAliveRequests,
          keepAliveCostUsd: gatewayUsageDays.keepAliveCostUsd,
        })
        .from(gatewayUsageDays)
        .where(
          and(
            gte(gatewayUsageDays.day, from),
            lt(gatewayUsageDays.day, to),
            aiAccount === undefined
              ? undefined
              : eq(gatewayUsageDays.account, aiAccount.name),
          ),
        );
      const all = new Map<string, AnalyticsRow>();
      for (const row of [...rows, ...daily]) {
        addAnalytics(all, row);
      }
      return [...all.values()];
    },
  };
}
