import { z } from "zod";

// Request history (PRD FR-44): every request through the AI Gateway, as
// the admin lists it, shows one, and streams new ones live, and the
// Gateway's own log lines. Headers come redacted; bodies are kept only
// while the Owner has body storage on, and are encrypted at rest.

/**
 * The Gateway's endpoints, as requests are recorded against them:
 * `systemone` is the Decision Model's (FR-17), Jev's typed questions.
 */
export const gatewayEndpoints = [
  "messages",
  "count_tokens",
  "chat_completions",
  "responses",
  "responses_compact",
  "systemone",
] as const;
export type GatewayEndpointName = (typeof gatewayEndpoints)[number];

const count = z.number().int().nullable();

/** One request, as the request list shows it. */
export const gatewayRequestSummarySchema = z.object({
  id: z.number().int(),
  startedAt: z.iso.datetime({ offset: true }),
  endpoint: z.string(),
  model: z.string().nullable(),
  streamed: z.boolean(),
  status: z.number().int(),
  /** From the request arriving to the answer's last byte. */
  latencyMs: z.number().int(),
  /** From the request arriving to the AI Provider's answer starting. */
  timeToFirstByteMs: z.number().int().nullable(),
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
  estimatedCostUsd: z.number().nullable(),
  /** The AI Account that served it, by name, and its id while it exists. */
  account: z.string().nullable(),
  aiAccountId: z.string().nullable(),
  /** Who made it: an Agent on a Floor, or one of the Owner's tools. */
  agentId: z.string().nullable(),
  floorId: z.string().nullable(),
  ownerTool: z.string().nullable(),
  /** The issue and pull request it was for, when its caller said. */
  issue: z.number().int().nullable(),
  pullRequest: z.number().int().nullable(),
  upstreamRequestId: z.string().nullable(),
  /**
   * Whether the AI Gateway sent it itself, to keep its Agent's prompt
   * cache warm (FR-39), on behalf of the Agent it names.
   */
  keepAlive: z.boolean(),
});
export type GatewayRequestSummary = z.infer<typeof gatewayRequestSummarySchema>;

/** The body of `GET /api/gateway/requests`: newest first, a page at a time. */
export const gatewayRequestListSchema = z.object({
  requests: z.array(gatewayRequestSummarySchema),
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: z.number().int().nullable(),
});

/** The body of `GET /api/gateway/requests/:id`. */
export const gatewayRequestDetailSchema = gatewayRequestSummarySchema.extend({
  /** The caller's headers, credentials redacted; null if not kept. */
  requestHeaders: z.record(z.string(), z.string()).nullable(),
  /** The answer's headers; null if not kept. */
  responseHeaders: z.record(z.string(), z.string()).nullable(),
  /** The bodies, redacted, while body storage was on; null otherwise. */
  bodies: z
    .object({
      request: z.string(),
      response: z.string(),
      /** True when a body was longer than the Gateway keeps. */
      truncated: z.boolean(),
    })
    .nullable(),
});
export type GatewayRequestDetail = z.infer<typeof gatewayRequestDetailSchema>;

/** A status filter: a class (`4xx`) or one status (`429`). */
export const gatewayStatusFilterSchema = z.union([
  z.enum(["2xx", "3xx", "4xx", "5xx"]),
  z.coerce.number().int().min(100).max(599),
]);

/** The filters of the request list and the live request stream. */
export const gatewayRequestFilterSchema = z.object({
  /** Words found in the Model, account, Owner tool, Agent, Floor or ids. */
  q: z.string().trim().min(1).max(200).optional(),
  status: gatewayStatusFilterSchema.optional(),
  endpoint: z.enum(gatewayEndpoints).optional(),
  model: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  floorId: z.string().min(1).optional(),
  ownerTool: z.string().min(1).optional(),
  /** The session its caller named, such as a direct chat's. */
  session: z.string().min(1).max(200).optional(),
});
export type GatewayRequestFilter = z.infer<typeof gatewayRequestFilterSchema>;

/** The query of `GET /api/gateway/requests`. */
export const gatewayRequestQuerySchema = gatewayRequestFilterSchema.extend({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type GatewayRequestQuery = z.infer<typeof gatewayRequestQuerySchema>;

/** One line of the Gateway's log, as the live log stream sends it. */
export const gatewayLogLineSchema = z.object({
  /** Grows with every line; the stream resumes after it. */
  id: z.number().int(),
  time: z.iso.datetime({ offset: true }),
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  /** The line's other fields, redacted. */
  fields: z.record(z.string(), z.unknown()),
});
export type GatewayLogLine = z.infer<typeof gatewayLogLineSchema>;

/** `GET` and `PUT /api/office/request-bodies`: whether bodies are kept. */
export const requestBodiesSettingsSchema = z.strictObject({
  store: z.boolean({ error: "Say whether to keep bodies: true or false." }),
});
export type RequestBodiesSettings = z.infer<typeof requestBodiesSettingsSchema>;

/**
 * AI Office's own request headers, which the Gateway reads and never
 * forwards:
 * - `issue` and `pullRequest` name what a request is for (FR-42); a
 *   sandbox's agent tool sends them on every model call. The Gateway
 *   records them only from an Owner tool: an Agent's calls count against
 *   the work AI Office gave it, whatever they name (pen-testing G1-1).
 * - `work` carries the token of work AI Office opened for one of its own
 *   calls for an Agent (a review, a Manager's judgement), which names that
 *   call's issue and pull request to the Gateway.
 * - `session` names the Agent session (a sandbox run) a request is part
 *   of, which the session strategy keeps on one AI Account (FR-37).
 * - `account` forces the AI Account, by id or name, that serves a request
 *   (FR-38): for the Owner's manual routing and internal probes, so only
 *   honoured from an Owner tool's Gateway Key.
 */
export const aiOfficeHeaders = {
  issue: "x-ai-office-issue",
  pullRequest: "x-ai-office-pull-request",
  session: "x-ai-office-session",
  account: "x-ai-office-account",
  work: "x-ai-office-work",
} as const;

/**
 * Where a sandbox's agent tool asks AI Office's tool-call screen about a
 * call before it runs (FR-17, P1-8), on the Gateway with its Agent's own
 * Gateway Key and its session's header: the only route besides the model
 * calls an Agent's key reaches.
 */
export const toolCallScreenPath = "/v1/ai-office/tool-calls";
