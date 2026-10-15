import type { Database } from "@ai-office/db";

import { databaseRequestHistoryStore } from "./history/store.ts";
import type { Usage } from "./usage.ts";

/** Which of the Gateway's endpoints a request came to. */
export type GatewayEndpoint =
  | "messages"
  | "count_tokens"
  | "chat_completions"
  | "responses"
  | "responses_compact"
  | "systemone";

/** One request through the AI Gateway, as `gateway_requests` stores it. */
export interface GatewayRequestRecord extends Usage {
  readonly startedAt: Date;
  /** The AI Account that served it; null when none was available. */
  readonly account: string | null;
  /** Its row in `ai_accounts`, when it has one. */
  readonly accountId: string | null;
  readonly endpoint: GatewayEndpoint;
  readonly model: string | null;
  readonly streamed: boolean;
  readonly status: number;
  readonly latencyMs: number;
  readonly upstreamRequestId: string | null;
  /** The Gateway Key it presented (FR-42). */
  readonly gatewayKeyId: string | null;
  /** The Agent that made it, and its Floor; null for an Owner tool. */
  readonly agentId: string | null;
  readonly floorId: string | null;
  /** The Owner tool that made it; null for an Agent. */
  readonly ownerTool: string | null;
  /**
   * The issue and pull request it was for, as its caller named them in
   * `aiOfficeHeaders`; null when it did not (FR-42).
   */
  readonly issue: number | null;
  readonly pullRequest: number | null;
  /**
   * The Agent session it belongs to, as its caller named it in
   * `aiOfficeHeaders.session` (a sandbox's run); null when it named none.
   * Context Usage is measured per session (FR-84).
   */
  readonly session?: string | null;
  /** Its estimated cost in US dollars (FR-43); null when unknown. */
  readonly estimatedCostUsd: number | null;
  /** From the request arriving to the AI Provider's answer starting. */
  readonly timeToFirstByteMs: number | null;
  /** The caller's headers, credentials redacted, and the answer's. */
  readonly requestHeaders: Readonly<Record<string, string>> | null;
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  /**
   * Whether the AI Gateway sent it itself, to keep the prompt cache of the
   * Agent it is attributed to warm (FR-39); false when absent.
   */
  readonly keepAlive?: boolean;
  /**
   * The request's and answer's bodies, in clear, only while body storage
   * is on (FR-44); whoever stores them must seal them.
   */
  readonly bodies?: {
    readonly request: string;
    readonly response: string;
    readonly truncated: boolean;
  };
}

/** Where the Gateway records each request once its response has finished. */
export interface RequestLog {
  record(entry: GatewayRequestRecord): Promise<void>;
}

/**
 * Records into the `gateway_requests` table, without bodies: request
 * history (`createRequestHistory`) keeps those, sealed.
 */
export function databaseRequestLog(db: Database): RequestLog {
  const store = databaseRequestHistoryStore(db);
  return {
    async record(entry) {
      const record: {
        -readonly [K in keyof GatewayRequestRecord]: GatewayRequestRecord[K];
      } = { ...entry };
      delete record.bodies;
      await store.insert(record);
    },
  };
}

/** Keeps records in memory, for tests. */
export function memoryRequestLog(): RequestLog & {
  readonly records: GatewayRequestRecord[];
} {
  const records: GatewayRequestRecord[] = [];
  return {
    records,
    record(entry) {
      records.push(entry);
      return Promise.resolve();
    },
  };
}
