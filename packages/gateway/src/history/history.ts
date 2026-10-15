import type {
  AnalyticsBucket,
  GatewayRequestFilter,
  Redactor,
  TokenUsageRow,
} from "@ai-office/shared";
import { createRedactor } from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";

import type { RequestLog } from "../request-log.ts";
import {
  matchesRequestFilter,
  type AccountUsage,
  type KeyUsage,
  type AnalyticsFilter,
  type AnalyticsRow,
  type HistoryQuery,
  type RequestHistoryStore,
  type StoredRequest,
} from "./store.ts";

// Request history (PRD FR-44): every request through the AI Gateway,
// searchable and filterable, each with its headers (credentials redacted),
// timings, tokens, cost, AI Account and Agent. While the Owner has body
// storage on, the request's and answer's bodies are kept too, each sealed
// with ENCRYPTION_KEY for its own request; reading one back redacts it.
// Each request recorded is told to the live request stream's subscribers.

/** One request with its bodies, in clear and redacted, if they were kept. */
export interface RequestDetail extends StoredRequest {
  readonly bodies: {
    readonly request: string;
    readonly response: string;
    readonly truncated: boolean;
  } | null;
}

export type RequestListener = (request: StoredRequest) => void;

export interface RequestHistory extends RequestLog {
  /** Requests matching `query`, newest first, and where the next page starts. */
  list(
    query: HistoryQuery,
  ): Promise<{ requests: StoredRequest[]; nextBefore: number | null }>;
  get(id: number): Promise<RequestDetail | undefined>;
  /** Requests after `afterId` matching `filter`, oldest first: to resume. */
  after(
    afterId: number,
    filter: GatewayRequestFilter,
    limit?: number,
  ): Promise<StoredRequest[]>;
  /** Tokens each AI Account's requests used since `since` (least-used). */
  accountUsageSince(since: Date): Promise<AccountUsage[]>;
  /** What each Gateway Key's kept requests added up to. */
  keyUsage(): Promise<KeyUsage[]>;
  /**
   * What requests started in [`from`, `to`) used, per Floor, Agent, issue
   * and Owner tool: what token accounting adds up (FR-31, FR-32).
   */
  tokenUsage(from: Date, to: Date): Promise<TokenUsageRow[]>;
  /** The finest grain analytics roll up from (FR-43), for one account or all. */
  analyticsRows(
    from: Date,
    to: Date,
    bucket: AnalyticsBucket,
    filter?: AnalyticsFilter,
  ): Promise<AnalyticsRow[]>;
  /** Tells `listener` each request recorded from now on that matches. */
  subscribe(
    listener: RequestListener,
    filter?: GatewayRequestFilter,
  ): () => void;
}

export interface RequestHistoryOptions {
  readonly store: RequestHistoryStore;
  /** Seals bodies at rest (ENCRYPTION_KEY). */
  readonly encryptor: Encryptor;
  /** Removes credentials from headers and from bodies read back. */
  readonly redactor?: Redactor;
  /** Told when a subscriber throws; the others still hear of the request. */
  readonly onListenerError?: (error: unknown) => void;
}

/** The context a body is sealed with: it opens only for its own request. */
export const bodyContext = (id: number, part: "request" | "response") =>
  `gateway_request.body:${String(id)}:${part}`;

export function createRequestHistory(
  options: RequestHistoryOptions,
): RequestHistory {
  const { store, encryptor } = options;
  const redactor = options.redactor ?? createRedactor();
  const subscribers = new Set<{
    readonly listener: RequestListener;
    readonly filter: GatewayRequestFilter;
  }>();

  return {
    async record(entry) {
      const { bodies, ...record } = entry;
      const stored = await store.insert(
        {
          ...record,
          requestHeaders:
            record.requestHeaders === null
              ? null
              : redactor.redact({ ...record.requestHeaders }),
          responseHeaders:
            record.responseHeaders === null
              ? null
              : redactor.redact({ ...record.responseHeaders }),
        },
        bodies === undefined
          ? undefined
          : (id) => ({
              request: encryptor.encrypt(
                bodies.request,
                bodyContext(id, "request"),
              ),
              response: encryptor.encrypt(
                bodies.response,
                bodyContext(id, "response"),
              ),
              truncated: bodies.truncated,
            }),
      );
      for (const { listener, filter } of [...subscribers]) {
        if (matchesRequestFilter(stored, filter)) {
          try {
            listener(stored);
          } catch (error) {
            options.onListenerError?.(error);
          }
        }
      }
    },

    async list(query) {
      const requests = await store.list(query);
      return {
        requests,
        nextBefore:
          requests.length === query.limit
            ? (requests.at(-1)?.id ?? null)
            : null,
      };
    },

    async get(id) {
      const found = await store.get(id);
      if (found === undefined) {
        return undefined;
      }
      const { request, bodies } = found;
      return {
        ...request,
        bodies:
          bodies === undefined
            ? null
            : {
                request: redactor.redactText(
                  encryptor.decrypt(bodies.request, bodyContext(id, "request")),
                ),
                response: redactor.redactText(
                  encryptor.decrypt(
                    bodies.response,
                    bodyContext(id, "response"),
                  ),
                ),
                truncated: bodies.truncated,
              },
      };
    },

    after(afterId, filter, limit = 500) {
      return store.after(afterId, filter, limit);
    },

    accountUsageSince: (since) => store.accountUsageSince(since),
    keyUsage: () => store.keyUsage(),
    tokenUsage: (from, to) => store.tokenUsage(from, to),
    analyticsRows: (from, to, bucket, filter) =>
      store.analyticsRows(from, to, bucket, filter),

    subscribe(listener, filter = {}) {
      const subscriber = { listener, filter };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}
