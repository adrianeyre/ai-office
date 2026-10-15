import { Readable, Transform, pipeline } from "node:stream";

import {
  aiOfficeHeaders,
  toolCallScreenPath,
  aiProviderAgentTools,
  communicationsAgentId,
  defaultGatewayRetrySettings,
  retryDelayMs,
  type AgentTool,
  type GatewayRetrySettings,
  type PromptCacheTtl,
} from "@ai-office/shared";
import { ownerFetch } from "@ai-office/shared/internal-hosts-guard";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ZodError } from "zod";

import {
  AccountsUnavailableError,
  ForcedAccountError,
} from "./balancing/balancing.ts";
import { authHeaders } from "./accounts/auth-headers.ts";
import { CloudRequestError, type CloudSigner } from "./cloud/cloud.ts";
import { comboSlotKey } from "./combos/combos.ts";
import type { Fixture, FixtureRecorder } from "./fixtures.ts";
import { startKeyCheck } from "./key-checks.ts";
import type { GatewayCaller, GatewayKeyAuthenticator } from "./keys/keys.ts";
import type { ObservedRequest } from "./keep-alive/keep-alive.ts";
import type { CostEstimator } from "./pricing/pricing.ts";
import { withPromptCacheTtl } from "./prompt-cache.ts";
import {
  credentialsSent,
  scrubbed,
  scrubbedHeaders,
  scrubbing,
} from "./scrub.ts";
import { outcomeOf, type AccountOutcome } from "./limits/detect.ts";
import { rateLimitsOf, type RateLimitReadings } from "./limits/rate-limits.ts";
import {
  usageWindowsOf,
  type UsageWindowReadings,
} from "./limits/usage-windows.ts";
import type { GatewayEndpoint, RequestLog } from "./request-log.ts";
import {
  anthropicError,
  messagesRequestSchema,
  type AnthropicMessage,
} from "./translate/anthropic.ts";
import {
  chatStreamFromMessages,
  chatToMessages,
  messageToChat,
  type StreamTranslator,
} from "./translate/chat.ts";
import {
  TranslationError,
  type TranslationContext,
} from "./translate/common.ts";
import {
  chatToMessage,
  messagesStreamFromChat,
  messagesToChat,
} from "./translate/messages.ts";
import {
  chatRequestSchema,
  compactRequestSchema,
  openAiError,
  openAiErrorType,
  responsesRequestSchema,
} from "./translate/openai.ts";
import {
  OpenAiStreamUsageReader,
  usageFromOpenAiBody,
} from "./translate/openai-usage.ts";
import {
  compactToMessages,
  messageToCompaction,
  messageToResponse,
  responsesStreamFromMessages,
  responsesToMessages,
} from "./translate/responses.ts";
import { SseReader } from "./translate/sse.ts";
import {
  StreamUsageReader,
  noUsage,
  usageFromMessage,
  type Usage,
} from "./usage.ts";
import { noWork, type AgentWork } from "./work.ts";

/**
 * The API an AI Account speaks: Anthropic Messages, or OpenAI's Chat
 * Completions and Responses.
 */
export type ApiFormat = "anthropic" | "openai";

/** An AI Account, ready to forward a request to. */
export interface GatewayAccount {
  /** Its row in `ai_accounts`; null for one that is not stored there. */
  readonly id: string | null;
  /** How the account is named in records and logs; never the key. */
  readonly name: string;
  /**
   * Its API key, or a subscription's access token; empty for an endpoint
   * that asks for no key, which is then sent none.
   */
  readonly apiKey: string;
  /** `https://api.anthropic.com`, a custom endpoint, or a stand-in for tests. */
  readonly baseUrl: string;
  /** The API it speaks; Anthropic Messages when absent. */
  readonly apiFormat?: ApiFormat;
  /**
   * Where its API's paths start, in place of `/v1`: `/v1` when absent,
   * `/v1beta/openai` for Google's OpenAI-compatible API.
   */
  readonly apiPath?: string;
  /**
   * How it presents `apiKey` to Anthropic's API: as `x-api-key` (an API
   * key, the default), as a bearer token (a subscription's), or as both
   * (an Anthropic-compatible endpoint's, which may read either).
   */
  readonly authorization?: "x-api-key" | "bearer" | "both";
  /** `anthropic-beta` flags every request it serves needs. */
  readonly betas?: readonly string[];
  /**
   * Headers every request it serves carries, in place of the caller's:
   * the ChatGPT account a subscription's token is for.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A cloud platform's account (AWS Bedrock, Google Vertex AI; FR-35):
   * each Messages request is reshaped for the platform and signed with
   * its credentials, in place of `apiKey`.
   */
  readonly cloud?: CloudSigner;
}

/**
 * The Combo slot (FR-40) a request is served from: its Model serves the
 * request in place of the one asked for.
 */
export interface ComboChoice {
  /** The Combo's name, for logs. */
  readonly name: string;
  readonly model: string;
  /** How many slots it has: each may be tried before the request fails. */
  readonly slots: number;
}

/**
 * The AI Account chosen for a request, the Combo slot that chose it, and
 * the Model it is sent when that is not the one asked for: a slot's, a
 * mapping's or alias's, or the account's forced Model (FR-40, FR-41).
 */
export type ChosenAccount = GatewayAccount & {
  readonly combo?: ComboChoice;
  readonly model?: string;
};

/** What the Gateway knows of a request when it chooses its account. */
export interface AccountRequest {
  /**
   * The agent tool that sent it, when it is one AI Office knows, and it
   * reaches the account unchanged: a subscription serves only its own.
   */
  readonly agentTool: AgentTool | null;
  /** The session it belongs to (FR-37), kept on one account; none if absent. */
  readonly sessionKey?: string | null;
  /**
   * The AI Account, by id or name, it must be served from (FR-38), before
   * any strategy; a `ForcedAccountError` when that one cannot.
   */
  readonly forcedAccount?: string | null;
  /**
   * Accounts (by id) already tried for this request, retrying: another is
   * chosen while there is one (FR-39). A Combo's slots are named by
   * `comboSlotKey` instead, since one account may be in two.
   */
  readonly avoid?: readonly string[];
  /**
   * The Model it asks for: one of a known AI Provider is served only by
   * that AI Provider's accounts.
   */
  readonly model?: string | null;
  /**
   * The endpoint it came to: an account that cannot serve it (Gemini's has
   * no Responses API) is left out.
   */
  readonly endpoint?: GatewayEndpoint;
}

/** Where the Gateway finds the AI Account to serve each request from. */
export interface AccountSource {
  /**
   * The account for the request, and the Combo slot that chose it if one
   * did (FR-40); undefined when none is available, or an
   * `AccountsUnavailableError` when those that could are held back.
   */
  select(request: AccountRequest): Promise<ChosenAccount | undefined>;
  /**
   * Told what each answer said about the account that gave it, so a
   * rate-limited, overloaded or failing account is held back (FR-39).
   */
  report?(
    account: GatewayAccount,
    outcome: AccountOutcome,
    usage?: UsageWindowReadings,
    rateLimits?: RateLimitReadings,
  ): Promise<void>;
}

/** Always the same account, or none: for tests. */
export const staticAccounts = (
  account: GatewayAccount | undefined,
): AccountSource => ({
  select: () => Promise.resolve(account),
});

/**
 * The agent tool a request comes from (PRD FR-16): Claude Code, for a
 * Messages request from its `claude-cli/…` user agent; Codex, for a
 * Responses request (or compaction) from its `codex_cli_rs/…` user agent,
 * or another of its originators' (`codex_exec/…`, as `codex exec` runs in
 * sandboxes); and opencode, for a Chat Completions or Responses request
 * from its `opencode/…` one. Other tools' requests come from none. A subscription serves only its own
 * tool's requests, passed through unchanged, so the endpoint must be the
 * one the tool speaks to its AI Provider.
 */
export function agentToolOf(
  endpoint: GatewayEndpoint,
  headers: FastifyRequest["headers"],
): AgentTool | null {
  const userAgent = headers["user-agent"] ?? "";
  if (
    (endpoint === "messages" || endpoint === "count_tokens") &&
    /^claude-cli\/\d/.test(userAgent)
  ) {
    return "Claude Code";
  }
  if (
    (endpoint === "responses" || endpoint === "responses_compact") &&
    /^codex_[a-z_]+\/\d/.test(userAgent)
  ) {
    return "Codex";
  }
  if (
    (endpoint === "chat_completions" || endpoint === "responses") &&
    /^opencode\/\d/.test(userAgent)
  ) {
    return "opencode";
  }
  return null;
}

/**
 * The agent tool a request is served as (FR-35; pen-testing G1-5): the one
 * its User-Agent claims (`agentToolOf`), only when its caller runs that
 * tool, since any caller can send any User-Agent. An Agent runs its AI
 * Provider's (FR-16), as AI Office knows it, never as its call says; one
 * whose AI Provider is not known runs none. The Communications Agent has
 * no sandbox and runs none (FR-90). An Owner tool is the Owner's own, and
 * is taken at its word.
 */
export function servedAs(
  caller: GatewayCaller,
  claimed: AgentTool | null,
): AgentTool | null {
  switch (caller.kind) {
    case "owner_tool":
      return claimed;
    case "communications":
      return null;
    case "agent": {
      const runs =
        caller.aiProvider === undefined
          ? undefined
          : (aiProviderAgentTools as Partial<Record<string, AgentTool>>)[
              caller.aiProvider
            ];
      return runs !== undefined && runs === claimed ? claimed : null;
    }
  }
}

export interface GatewayOptions {
  readonly logger: FastifyBaseLogger;
  /**
   * The AI Accounts, asked for one on every request, so changes apply at
   * once. When none is available the request is a 503.
   */
  readonly accounts: AccountSource;
  /**
   * Tells who is calling from the Gateway Key a request presents (FR-46).
   * A request without a key in use is refused with a 401.
   */
  readonly keys: GatewayKeyAuthenticator;
  readonly requestLog: RequestLog;
  /** Recorder mode: saves every request/response pair as a fixture. */
  readonly fixtureRecorder?: FixtureRecorder | undefined;
  /** The clock translated responses are stamped with, and limits timed by. */
  readonly now?: () => Date;
  /**
   * How often, and after how long, a request is tried again (FR-39),
   * asked as each request arrives: three attempts, waiting 500 ms, then
   * twice as long, by default.
   */
  readonly retries?: () => Pick<
    GatewayRetrySettings,
    "attempts" | "delayMs" | "multiplier"
  >;
  /** Waits before trying an account again; stops early when aborted. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Estimates each request's cost from its Model's price (FR-43). */
  readonly pricing?: CostEstimator;
  /**
   * Whether to keep each request's and response's bodies (FR-44), asked
   * as each request arrives; never by default.
   */
  readonly storeBodies?: () => boolean;
  /**
   * Asked before each of an Agent's calls (FR-33): the Token Cap it is
   * refused at, if its Agent is paused at one; then the call is refused
   * with a cap error and goes nowhere.
   */
  readonly capCheck?: (subject: CapCheckSubject) => Promise<CapCheck>;
  /**
   * Asked before each of the Communications Agent's calls (FR-90): the
   * office Token Cap it is refused at, if it has reached one.
   */
  readonly communicationsCapCheck?: () => Promise<CapCheck>;
  /**
   * Asked before each call of an Owner tool's, the Terminal's included
   * (FR-33; pen-testing G1-3): the Token Cap it is refused at, if it has
   * reached one.
   */
  readonly ownerToolCapCheck?: (ownerTool: string) => Promise<CapCheck>;
  /**
   * The work AI Office gave each Agent (FR-42; pen-testing G1-1), which
   * its calls count against whatever they name. Without it, an Agent's
   * calls count against no issue.
   */
  readonly work?: Pick<AgentWork, "of">;
  /**
   * The TTL given to every prompt-cache breakpoint of a request to
   * Anthropic's Messages API (§6.8), asked as each request arrives; as
   * the caller sent it by default.
   */
  readonly promptCacheTtl?: () => PromptCacheTtl;
  /**
   * Prompt-cache keep-alive (FR-39), shown each Agent's Messages request
   * that an Anthropic-format AI Account served, once it has finished.
   */
  readonly keepAlive?: {
    observe(request: ObservedRequest): void;
  };
  /**
   * How AI Providers are reached: through the Owner's outbound proxy, when
   * one is set (FR-35, `createUpstreamFetch`). By default `fetch`, refusing
   * an AI Account whose endpoint is, or resolves to, an internal address
   * the Owner did not allow (`ownerFetch`, ADR 0007).
   */
  readonly fetch?: typeof fetch;
  /**
   * AI Office's tool-call screen (FR-17, P1-8), which an Agent's sandbox
   * asks before each of its agent tool's calls runs: given the Agent its
   * Gateway Key belongs to, the session its header names and what the
   * tool's hook posted, the hook's answer. Without it, the route is not
   * served. Only an Agent's own key reaches it.
   */
  readonly toolCallScreen?: (request: {
    readonly agentId: string;
    readonly floorId: string;
    readonly session: string | null;
    readonly body: unknown;
  }) => Promise<object>;
}

/** An Agent's call, as Token Caps see it. */
export interface CapCheckSubject {
  readonly floorId: string;
  readonly agentId: string;
  /**
   * The issue AI Office gave the work it is for (FR-42); undefined for
   * none. Never one the call names (pen-testing G1-1).
   */
  readonly issue: number | undefined;
}

/** Why a call is refused at a Token Cap; undefined when it is not. */
export type CapCheck = { readonly message: string } | undefined;

/** The answer's header naming why AI Office refused a call itself. */
export const refusalHeader = "x-ai-office-refusal";

/**
 * Takes a caller's turn (pen-testing G1-2): a Token Cap is checked before a
 * call and counted once the call is recorded, so a capped caller's calls
 * run one at a time, each once the one before it has been counted.
 * However many it sends at once, its use stops within one call of its
 * cap. Resolves with the function that ends the turn.
 */
function turns(): (who: string) => Promise<() => void> {
  /** Each caller's latest turn, which ends when it is over. */
  const latest = new Map<string, Promise<void>>();
  return async (who) => {
    const before = latest.get(who);
    let end = (): void => undefined;
    const mine = new Promise<void>((resolve) => {
      end = resolve;
    });
    latest.set(who, mine);
    await before;
    return () => {
      if (latest.get(who) === mine) {
        latest.delete(who);
      }
      end();
    };
  };
}

/** Waits `ms`, or until `signal` aborts. */
const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** The most of each body kept for request history. */
export const maxStoredBodyBytes = 1024 * 1024;

/**
 * Request headers whose values are credentials, shown as redacted; and the
 * token of AI Office's own work, which is good only while its call runs.
 */
const credentialHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  aiOfficeHeaders.work,
]);

/** The caller's headers for request history: credentials redacted. */
function shownHeaders(
  headers: FastifyRequest["headers"],
): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      shown[name] = credentialHeaders.has(name)
        ? "[REDACTED]"
        : Array.isArray(value)
          ? value.join(", ")
          : value;
    }
  }
  return shown;
}

/** A body as kept for request history: cut at `maxStoredBodyBytes`. */
function keptBody(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxStoredBodyBytes
    ? { text, truncated: false }
    : {
        text: bytes.subarray(0, maxStoredBodyBytes).toString("utf8"),
        truncated: true,
      };
}

// Anthropic accepts request bodies up to 32 MB.
const bodyLimit = 32 * 1024 * 1024;

// Request headers that are never forwarded: hop-by-hop headers, the
// caller's own credentials (the AI Account's key replaces them) and
// `accept-encoding` (identity is asked for, so bodies pass through as sent).
const droppedRequestHeaders = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "upgrade",
  "content-length",
  "accept-encoding",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  // AI Office's own: what the request is for, and how it is routed, which
  // is no AI Provider's business.
  ...Object.values(aiOfficeHeaders),
]);

// Response headers that are not passed back: hop-by-hop headers, and those
// that describe the upstream connection rather than the body.
const droppedResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "set-cookie",
]);

function forwardedHeaders(
  headers: FastifyRequest["headers"],
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !droppedRequestHeaders.has(name)) {
      forwarded[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return forwarded;
}

function returnedHeaders(headers: Headers): Record<string, string> {
  const returned: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!droppedResponseHeaders.has(name)) {
      returned[name] = value;
    }
  });
  return returned;
}

/**
 * The Gateway Key a request presents: as `x-api-key` (as Anthropic's
 * clients send an API key) or as a bearer token (as they send
 * `ANTHROPIC_AUTH_TOKEN`, and as OpenAI's clients send theirs).
 */
function presentedKey(headers: FastifyRequest["headers"]): string | undefined {
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey !== "") {
    return apiKey;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? "");
  return match?.[1];
}

/**
 * Who made a request, as `gateway_requests` attributes it (FR-42). The
 * Communications Agent belongs to no Floor: its requests carry its own
 * Agent id, `communications`, and no Floor.
 */
const attribution = (caller: GatewayCaller) => {
  switch (caller.kind) {
    case "agent":
      return {
        gatewayKeyId: caller.keyId,
        agentId: caller.agentId,
        floorId: caller.floorId,
        ownerTool: null,
      };
    case "communications":
      return {
        gatewayKeyId: caller.keyId,
        agentId: communicationsAgentId,
        floorId: null,
        ownerTool: null,
      };
    case "owner_tool":
      return {
        gatewayKeyId: caller.keyId,
        agentId: null,
        floorId: null,
        ownerTool: caller.name,
      };
  }
};

/** A header's value, if the request sent it once and not empty. */
const headerValue = (
  headers: FastifyRequest["headers"],
  name: string,
): string | undefined => {
  const value = headers[name];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
};

/**
 * How a request is routed (FR-37, FR-38): its session, by the caller's
 * Gateway Key and the session it names, or the key alone; and the AI
 * Account it forces, which only an Owner tool may.
 */
function routingOf(
  caller: GatewayCaller,
  headers: FastifyRequest["headers"],
): { sessionKey: string; forcedAccount: string | null } {
  const session = headerValue(headers, aiOfficeHeaders.session);
  return {
    sessionKey:
      session === undefined
        ? caller.keyId
        : `${caller.keyId}:${session.slice(0, maxSessionLength)}`,
    forcedAccount:
      caller.kind === "owner_tool"
        ? (headerValue(headers, aiOfficeHeaders.account) ?? null)
        : null,
  };
}

/** The `anthropic-beta` header with `betas` added, if there are any. */
export function withBetas(
  sent: string | undefined,
  betas: readonly string[] | undefined,
): Record<string, string> {
  if (betas === undefined || betas.length === 0) {
    return {};
  }
  const flags = (sent ?? "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag !== "");
  return {
    "anthropic-beta": [...new Set([...flags, ...betas])].join(","),
  };
}

/** An issue or pull request number a request names in `header`, if any. */
function attributedNumber(
  headers: FastifyRequest["headers"],
  header: string,
): number | null {
  const value = headers[header];
  if (typeof value !== "string" || !/^\s*[1-9][0-9]{0,8}\s*$/.test(value)) {
    return null;
  }
  return Number(value);
}

/** The longest session name kept. */
const maxSessionLength = 200;

/**
 * The issue and pull request a request is for (FR-42), and the session it
 * belongs to (FR-37, FR-84), when it says. An Owner tool's are what it
 * names; an Agent's are the work AI Office gave it, whatever it names
 * (pen-testing G1-1), as `work` tells.
 */
const workOf = (
  caller: GatewayCaller,
  headers: FastifyRequest["headers"],
  work: Pick<AgentWork, "of"> | undefined,
) => {
  const session =
    headerValue(headers, aiOfficeHeaders.session)?.slice(0, maxSessionLength) ??
    null;
  if (caller.kind === "owner_tool") {
    return {
      issue: attributedNumber(headers, aiOfficeHeaders.issue),
      pullRequest: attributedNumber(headers, aiOfficeHeaders.pullRequest),
      session,
    };
  }
  const agentId =
    caller.kind === "agent" ? caller.agentId : communicationsAgentId;
  return {
    ...(work?.of(agentId, headerValue(headers, aiOfficeHeaders.work)) ??
      noWork),
    session,
  };
};

const parseJson = (body: Buffer | string): unknown => {
  try {
    return JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The path a request to `path` (`/v1/…`) takes on an account's API: its
 * API's own start in place of `/v1`.
 */
const accountPath = (account: GatewayAccount, path: string): string =>
  `${(account.apiPath ?? "/v1").replace(/\/+$/, "")}${path.replace(/^\/v1(?=\/|$)/, "")}`;

/** Where a request to `path` (`/v1/…`) goes for an account. */
const upstreamUrl = (account: GatewayAccount, path: string): string =>
  `${account.baseUrl.replace(/\/+$/, "")}${accountPath(account, path)}`;

/** A request as it is sent to an account: what it is, and how it signs. */
interface SentRequest {
  readonly url: string;
  /** Its path on the account's API, as recorded. */
  readonly path: string;
  readonly body: Buffer;
  /** The account's credential, or a cloud platform's signature: never recorded. */
  readonly auth: Readonly<Record<string, string>>;
}

/** The `model` the caller asked for. */
function requestedModel(body: Buffer): string | null {
  const parsed = parseJson(body);
  return typeof parsed === "object" &&
    parsed !== null &&
    "model" in parsed &&
    typeof parsed.model === "string"
    ? parsed.model
    : null;
}

/** The API format each endpoint's callers speak, and its path. */
const endpoints: Record<
  GatewayEndpoint,
  { readonly format: ApiFormat; readonly path: string }
> = {
  messages: { format: "anthropic", path: "/v1/messages" },
  count_tokens: { format: "anthropic", path: "/v1/messages/count_tokens" },
  chat_completions: { format: "openai", path: "/v1/chat/completions" },
  responses: { format: "openai", path: "/v1/responses" },
  responses_compact: { format: "openai", path: "/v1/responses/compact" },
  // Jev's typed questions, the Decision Model's (FR-17): errors in
  // OpenAI's shape, as OpenRouter, which serves them, answers.
  systemone: { format: "openai", path: "/v1/systemone" },
};

/** Anthropic's error type for an HTTP status. */
const anthropicErrorType = (status: number): string =>
  status === 401
    ? "authentication_error"
    : status === 403
      ? "permission_error"
      : status === 404
        ? "not_found_error"
        : status === 429
          ? "rate_limit_error"
          : status === 529
            ? "overloaded_error"
            : status >= 500
              ? "api_error"
              : "invalid_request_error";

/** An error body in the caller's format. */
const errorBody = (
  format: ApiFormat,
  status: number,
  message: string,
  param: string | null = null,
) =>
  format === "anthropic"
    ? anthropicError(anthropicErrorType(status), message)
    : openAiError(openAiErrorType(status), message, param);

/** Why a request body does not match its schema, as OpenAI words it. */
function schemaProblem(error: ZodError): { message: string; param: string } {
  const [issue] = error.issues;
  const path = issue?.path.map(String).join(".") ?? "";
  if (issue?.code === "unrecognized_keys") {
    const [key] = issue.keys;
    return {
      message: `Unrecognized request argument supplied: ${key ?? ""}`,
      param: [path, key].filter(Boolean).join("."),
    };
  }
  return {
    message: `Invalid value for '${path}': ${issue?.message ?? "invalid"}.`,
    param: path,
  };
}

/** The error an AI Provider sent, read from its body in its own format. */
function upstreamError(body: string): {
  type: string | undefined;
  message: string;
} {
  const parsed = parseJson(body);
  const error =
    typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null
      ? (parsed.error as { type?: unknown; message?: unknown })
      : undefined;
  return {
    type: typeof error?.type === "string" ? error.type : undefined,
    message:
      typeof error?.message === "string"
        ? error.message
        : "The AI Provider refused the request.",
  };
}

/** How one request reaches its AI Account, and how its answer comes back. */
type Plan =
  | {
      readonly kind: "passthrough";
      readonly upstreamPath: string;
      readonly body: Buffer;
      /** Which reader finds the usage in the response. */
      readonly usage: "anthropic" | "chat" | "responses";
    }
  | {
      readonly kind: "translate";
      readonly upstreamPath: string;
      readonly body: Buffer;
      readonly streamed: boolean;
      /** A whole successful response from the AI Provider, translated. */
      readonly whole: (upstream: Record<string, unknown>) => {
        body: unknown;
        usage: Usage;
      };
      readonly stream: () => StreamTranslator;
    };

const json = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value), "utf8");

/**
 * `body` asking for `model` in place of the Model it names: a Combo's slot
 * serves with its own Model (FR-40), and a mapping, an alias or a forced
 * Model sends another (FR-41). Unchanged when it already does.
 */
function withModel(body: Buffer, model: string): Buffer {
  const parsed = parseJson(body);
  return typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "model" in parsed &&
    parsed.model !== model
    ? json({ ...parsed, model })
    : body;
}

/**
 * How a request to `endpoint` reaches an account speaking `accountFormat`:
 * unchanged when it speaks the caller's format, translated otherwise.
 * Throws a `TranslationError` or a `ZodError` for a request that cannot
 * be translated.
 */
function planFor(
  endpoint: GatewayEndpoint,
  accountFormat: ApiFormat,
  body: Buffer,
  context: TranslationContext,
): Plan {
  const { format, path } = endpoints[endpoint];
  if (format === accountFormat) {
    return {
      kind: "passthrough",
      upstreamPath: path,
      body,
      // Jev's answers count `input_tokens` and `output_tokens` in `usage`,
      // as a Response does.
      usage:
        format === "anthropic"
          ? "anthropic"
          : endpoint === "chat_completions"
            ? "chat"
            : "responses",
    };
  }
  const parsed = parseJson(body);
  switch (endpoint) {
    case "chat_completions": {
      const request = chatRequestSchema.parse(parsed);
      const includeUsage = request.stream_options?.include_usage === true;
      return {
        kind: "translate",
        upstreamPath: "/v1/messages",
        body: json(chatToMessages(request)),
        streamed: request.stream === true,
        whole: (upstream) =>
          messageToChat(upstream as unknown as AnthropicMessage, context),
        stream: () => chatStreamFromMessages(context, { includeUsage }),
      };
    }
    case "responses": {
      const translation = responsesToMessages(
        responsesRequestSchema.parse(parsed),
      );
      return {
        kind: "translate",
        upstreamPath: "/v1/messages",
        body: json(translation.request),
        streamed: translation.request.stream === true,
        whole: (upstream) =>
          messageToResponse(
            upstream as unknown as AnthropicMessage,
            translation,
            context,
          ),
        stream: () => responsesStreamFromMessages(translation, context),
      };
    }
    case "responses_compact": {
      const request = compactRequestSchema.parse(parsed);
      return {
        kind: "translate",
        upstreamPath: "/v1/messages",
        body: json(compactToMessages(request).request),
        streamed: false,
        whole: (upstream) =>
          messageToCompaction(
            upstream as unknown as AnthropicMessage,
            request,
            context,
          ),
        stream: () => {
          throw new Error("A compaction is never streamed.");
        },
      };
    }
    case "messages": {
      const request = messagesRequestSchema.parse(parsed);
      return {
        kind: "translate",
        upstreamPath: "/v1/chat/completions",
        body: json(messagesToChat(request)),
        streamed: request.stream === true,
        whole: (upstream) => chatToMessage(upstream),
        stream: () => messagesStreamFromChat(),
      };
    }
    case "count_tokens":
      throw new TranslationError(
        "Token counting is not available from this AI Account.",
      );
    case "systemone":
      throw new TranslationError(
        "Decisions are not available from this AI Account.",
      );
  }
}

/** The schema an OpenAI-format endpoint's requests are checked against. */
const openAiSchemas = {
  chat_completions: chatRequestSchema,
  responses: responsesRequestSchema,
  responses_compact: compactRequestSchema,
} as const;

/**
 * The AI Gateway's HTTP server, without listening (PRD FR-34):
 * - Anthropic Messages (`POST /v1/messages` and `/v1/messages/count_tokens`);
 * - OpenAI Chat Completions (`POST /v1/chat/completions`);
 * - OpenAI Responses (`POST /v1/responses` and `/v1/responses/compact`);
 * - Jev's typed questions (`POST /v1/systemone`), for the Decision Model
 *   (FR-17), passed through to an AI Account that answers them.
 *
 * A request in the format its AI Account speaks passes through unchanged,
 * streamed or not, with usage read from it on the way. Otherwise it is
 * translated to the account's format, and the answer back to the caller's,
 * streamed as it arrives. Every request is recorded once its response has
 * finished.
 */
export async function buildGateway(
  options: GatewayOptions,
): Promise<FastifyInstance> {
  const {
    accounts,
    keys,
    requestLog,
    fixtureRecorder,
    pricing,
    capCheck,
    communicationsCapCheck,
    ownerToolCapCheck,
    keepAlive,
    work,
  } = options;
  const storeBodies = options.storeBodies ?? (() => false);
  const promptCacheTtl =
    options.promptCacheTtl ?? ((): PromptCacheTtl => "as_sent");
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? (() => defaultGatewayRetrySettings);
  const sleep = options.sleep ?? sleepFor;
  const upstreamFetch = options.fetch ?? ownerFetch();
  const takeTurn = turns();
  /** Tells the accounts what an answer said; a failure to is only logged. */
  const tellOutcome = async (
    account: GatewayAccount,
    outcome: AccountOutcome,
    log: FastifyBaseLogger,
    headers?: Headers,
  ): Promise<void> => {
    try {
      // With the usage windows and rate limits the answer reported, if
      // any (FR-36).
      await accounts.report?.(
        account,
        outcome,
        headers === undefined ? undefined : usageWindowsOf(headers, now()),
        headers === undefined ? undefined : rateLimitsOf(headers, now()),
      );
    } catch (error) {
      log.error(
        { err: error, account: account.name },
        "An AI Account's state could not be saved.",
      );
    }
  };
  const app = Fastify({
    loggerInstance: options.logger,
    bodyLimit,
    // Every request is recorded in gateway_requests instead.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Bodies are forwarded as the bytes that arrived, whatever their type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  // Who presented each request's Gateway Key, checked as the request
  // arrives (an `onRequest` hook), before its body is read.
  const callers = new WeakMap<FastifyRequest, GatewayCaller>();
  /**
   * Every request presents a Gateway Key in use (ADR 0001). One that does
   * not is refused before anything else, its body unread (pen-testing
   * I2-2), so a caller without a key never has the Gateway buffer up to
   * `bodyLimit` of it; and not recorded: it belongs to no one. A client
   * its limit says has tried too many keys not in use is refused before
   * its key is checked (I2-3). Each route answers in its own callers'
   * format.
   */
  const requireKey =
    (refusal: {
      readonly route: string;
      readonly body: (status: number, message: string) => unknown;
      readonly unauthorised: (keyPresented: boolean) => string;
    }) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const key = presentedKey(request.headers);
      const check = key === undefined ? undefined : startKeyCheck(request.raw);
      if (check?.allowed === false) {
        request.log.warn(
          { endpoint: refusal.route },
          "A request was refused unchecked: its client presented too many Gateway Keys not in use.",
        );
        return reply
          .code(429)
          .header("retry-after", String(check.retryAfterSeconds))
          .send(
            refusal.body(
              429,
              `Too many Gateway Keys not in use were presented from here: try again in ${String(check.retryAfterSeconds)} seconds.`,
            ),
          );
      }
      let caller: GatewayCaller | undefined;
      try {
        caller = key === undefined ? undefined : await keys.authenticate(key);
      } catch (error) {
        request.log.error({ err: error }, "Gateway Keys could not be read.");
        return reply
          .code(503)
          .send(
            refusal.body(
              503,
              "The AI Gateway could not check its Gateway Keys.",
            ),
          );
      }
      if (caller === undefined) {
        check?.failed();
        request.log.warn(
          { endpoint: refusal.route, presentedKey: key !== undefined },
          "A request without a Gateway Key in use was refused.",
        );
        return reply
          .code(401)
          .send(refusal.body(401, refusal.unauthorised(key !== undefined)));
      }
      check?.succeeded();
      callers.set(request, caller);
      return undefined;
    };
  const noSuchRoute = (reply: FastifyReply) =>
    reply
      .code(404)
      .send(
        anthropicError("not_found_error", "The AI Gateway has no such route."),
      );
  // A path no route serves is answered before its body is read too.
  app.addHook("onRequest", async (request, reply) =>
    request.is404 ? noSuchRoute(reply) : undefined,
  );

  app.get("/health", async () => {
    // Any account serving any caller, Claude Code's subscriptions too.
    const available = async () =>
      (await accounts.select({ agentTool: null })) ??
      (await accounts.select({ agentTool: "Claude Code" }));
    return {
      status: "ok",
      account:
        (await available().catch(() => undefined)) === undefined
          ? "none"
          : "available",
    };
  });

  const handle =
    (endpoint: GatewayEndpoint) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const startedAt = new Date();
      const start = performance.now();
      const { format: clientFormat } = endpoints[endpoint];
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      const queryStart = request.url.indexOf("?");
      const search = queryStart === -1 ? "" : request.url.slice(queryStart);
      // Checked by `requireKey` before the body was read.
      const caller = callers.get(request);
      if (caller === undefined) {
        throw new Error("A Gateway request reached its route unchecked.");
      }
      const who = {
        ...attribution(caller),
        ...workOf(caller, request.headers, work),
      };
      let account: ChosenAccount | undefined;
      // What is sent to the AI Provider, once it is known: for fixtures.
      const exchange: { request?: Fixture["request"] } = {};
      // Whether this request's bodies are kept, decided as it arrives.
      const storing = storeBodies();
      // When the AI Provider's answer started arriving.
      const timing: { firstByteAt?: number } = {};
      // The session of a Messages request sent to an Anthropic-format
      // account, which keep-alive may keep warm once it is served.
      let keptWarm: { sessionKey: string } | undefined;

      // Runs once the response has been sent (or the caller has gone), so
      // nothing here adds to the caller's latency.
      // Ends a capped caller's turn, once it has one: when its call is
      // recorded, so the next is checked against its tokens.
      let endTurn: (() => void) | undefined;
      let finished = false;
      const finish = (result: {
        status: number;
        streamed: boolean;
        responseHeaders: Record<string, string>;
        /** The AI Provider's response, as it sent it. */
        upstreamBody: () => string;
        /** The answer, as the caller got it. */
        clientBody: () => string;
        usage: () => Usage;
        upstreamRequestId: string | null;
      }): void => {
        finished = true;
        const latencyMs = Math.round(performance.now() - start);
        const completed = reply.raw.writableFinished;
        // The Model that served: a Combo slot's, a mapping's or the
        // account's forced one, in place of the one asked.
        const model = account?.model ?? requestedModel(body);
        const usage = result.usage();
        const status = completed ? result.status : 499;
        const sentHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) {
            sentHeaders[name] = Array.isArray(value)
              ? value.join(", ")
              : String(value);
          }
        }
        const kept = storing
          ? {
              request: keptBody(body.toString("utf8")),
              response: keptBody(result.clientBody()),
            }
          : undefined;
        request.log.info(
          {
            endpoint,
            model,
            status,
            latencyMs,
            account: account?.name ?? null,
            ...(account?.combo === undefined
              ? {}
              : { combo: account.combo.name }),
            agentId: who.agentId,
            ownerTool: who.ownerTool,
            issue: who.issue,
          },
          "A Gateway request finished.",
        );
        void requestLog
          .record({
            startedAt,
            account: account?.name ?? null,
            accountId: account?.id ?? null,
            ...who,
            endpoint,
            model,
            streamed: result.streamed,
            // 499: the caller closed the connection before the end.
            status,
            latencyMs,
            ...usage,
            upstreamRequestId: result.upstreamRequestId,
            estimatedCostUsd: pricing?.estimate(model, usage) ?? null,
            timeToFirstByteMs:
              timing.firstByteAt === undefined
                ? null
                : Math.round(timing.firstByteAt - start),
            requestHeaders: shownHeaders(request.headers),
            responseHeaders: sentHeaders,
            ...(kept === undefined
              ? {}
              : {
                  bodies: {
                    request: kept.request.text,
                    response: kept.response.text,
                    truncated:
                      kept.request.truncated || kept.response.truncated,
                  },
                }),
          })
          .catch((error: unknown) => {
            request.log.error(
              { err: error },
              "Could not record a Gateway request.",
            );
          })
          .finally(() => {
            endTurn?.();
          });
        if (
          keepAlive !== undefined &&
          keptWarm !== undefined &&
          completed &&
          status >= 200 &&
          status < 300 &&
          who.agentId !== null &&
          who.floorId !== null &&
          account?.id != null &&
          exchange.request !== undefined
        ) {
          keepAlive.observe({
            startedAt,
            sessionKey: keptWarm.sessionKey,
            gatewayKeyId: who.gatewayKeyId,
            agentId: who.agentId,
            floorId: who.floorId,
            issue: who.issue,
            pullRequest: who.pullRequest,
            accountId: account.id,
            path: exchange.request.path,
            headers: exchange.request.headers,
            body: exchange.request.body,
          });
        }
        if (fixtureRecorder && completed && exchange.request !== undefined) {
          // What crossed the wire to and from the AI Provider.
          const fixture: Fixture = {
            request: exchange.request,
            response: {
              status: result.status,
              headers: result.responseHeaders,
              body: result.upstreamBody(),
            },
          };
          fixtureRecorder.save(fixture).catch((error: unknown) => {
            request.log.error({ err: error }, "Could not save a fixture.");
          });
        }
      };

      const refuse = (
        status: number,
        message: string,
        param: string | null = null,
        headers: Record<string, string> = {},
      ) => {
        const sent = errorBody(clientFormat, status, message, param);
        reply.raw.once("close", () => {
          finish({
            status,
            streamed: false,
            responseHeaders: { "content-type": "application/json" },
            upstreamBody: () => "",
            clientBody: () => JSON.stringify(sent),
            usage: () => noUsage,
            upstreamRequestId: null,
          });
        });
        return reply.code(status).headers(headers).send(sent);
      };

      // A capped caller's calls run one at a time (pen-testing G1-2): this
      // one waits until the caller's call before it has been counted.
      const capped =
        caller.kind === "agent" && capCheck !== undefined
          ? caller.agentId
          : caller.kind === "communications" &&
              communicationsCapCheck !== undefined
            ? communicationsAgentId
            : caller.kind === "owner_tool" && ownerToolCapCheck !== undefined
              ? `owner_tool:${caller.name}`
              : undefined;
      if (capped !== undefined) {
        const waiting = { gone: false };
        const leave = () => {
          waiting.gone = true;
        };
        reply.raw.once("close", leave);
        const end = await takeTurn(capped);
        reply.raw.off("close", leave);
        if (waiting.gone) {
          // The caller went while it waited: nothing was sent anywhere.
          end();
          return reply;
        }
        endTurn = end;
        // An answer that ends without being recorded ends the turn too.
        reply.raw.once("close", () => {
          setImmediate(() => {
            if (!finished) {
              end();
            }
          });
        });
      }

      // An Agent at its Token Cap is refused before anything else (FR-33),
      // with an error its agent tool does not retry: it stops there, and
      // AI Office has paused it.
      if (capCheck !== undefined && caller.kind === "agent") {
        let refusal: CapCheck;
        try {
          refusal = await capCheck({
            floorId: caller.floorId,
            agentId: caller.agentId,
            issue: who.issue ?? undefined,
          });
        } catch (error) {
          request.log.error({ err: error }, "Token Caps could not be read.");
          return refuse(503, "The AI Gateway could not check Token Caps.");
        }
        if (refusal !== undefined) {
          request.log.info(
            { endpoint, agentId: caller.agentId, issue: who.issue },
            "A call was refused at a Token Cap.",
          );
          return refuse(403, refusal.message, null, {
            [refusalHeader]: "token_cap",
          });
        }
      }

      // The Communications Agent's calls count against the office's Token
      // Caps (FR-90): at one, its next call is refused in the same way.
      if (
        communicationsCapCheck !== undefined &&
        caller.kind === "communications"
      ) {
        let refusal: CapCheck;
        try {
          refusal = await communicationsCapCheck();
        } catch (error) {
          request.log.error({ err: error }, "Token Caps could not be read.");
          return refuse(503, "The AI Gateway could not check Token Caps.");
        }
        if (refusal !== undefined) {
          request.log.info(
            { endpoint, agentId: communicationsAgentId },
            "A call was refused at a Token Cap.",
          );
          return refuse(403, refusal.message, null, {
            [refusalHeader]: "token_cap",
          });
        }
      }

      // An Owner tool's calls, the Terminal's too, count against the
      // office's Token Caps (FR-33; pen-testing G1-3): at one, its next
      // call is refused in the same way.
      if (ownerToolCapCheck !== undefined && caller.kind === "owner_tool") {
        let refusal: CapCheck;
        try {
          refusal = await ownerToolCapCheck(caller.name);
        } catch (error) {
          request.log.error({ err: error }, "Token Caps could not be read.");
          return refuse(503, "The AI Gateway could not check Token Caps.");
        }
        if (refusal !== undefined) {
          request.log.info(
            { endpoint, ownerTool: caller.name },
            "A call was refused at a Token Cap.",
          );
          return refuse(403, refusal.message, null, {
            [refusalHeader]: "token_cap",
          });
        }
      }

      // An OpenAI-format request is checked before anything else, whatever
      // the account: unknown top-level fields are refused, as OpenAI does.
      if (endpoint in openAiSchemas) {
        const parsed = parseJson(body);
        if (parsed === undefined) {
          return refuse(400, "The request body is not valid JSON.");
        }
        const checked =
          openAiSchemas[endpoint as keyof typeof openAiSchemas].safeParse(
            parsed,
          );
        if (!checked.success) {
          const { message, param } = schemaProblem(checked.error);
          return refuse(400, message, param);
        }
      }

      // The AI Account is chosen, and the request sent, until an account
      // answers with anything but a rate limit, an overload or a server
      // error, or the attempts run out (FR-39). Each such answer is told to
      // the accounts, which hold that account back; the next attempt goes to
      // another account if there is one, at once, or else back to one
      // already tried after a wait that grows each time. A forced account
      // is tried once; a Combo's slots each get their turn (FR-40), however
      // few the attempts. When nothing is left to try, the caller gets the
      // last answer, or the reason no account can serve.
      const retry = retries();
      // The agent tool it is served as: what its User-Agent claims, only
      // when its caller runs that tool (pen-testing G1-5).
      const agentTool = servedAs(
        caller,
        agentToolOf(endpoint, request.headers),
      );
      const routing = routingOf(caller, request.headers);
      const attempts = routing.forcedAccount === null ? retry.attempts : 1;
      const tried: string[] = [];
      // Accounts the AI Provider said are rate-limited or overloaded, which
      // are not tried again before their reset.
      const heldBack = new Set<string>();
      let backoffs = 0;
      // If the caller goes away, stop the upstream request too.
      const abort = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) {
          abort.abort();
        }
      });
      const callerGone = () => {
        finish({
          status: 499,
          streamed: false,
          responseHeaders: {},
          upstreamBody: () => "",
          clientBody: () => "",
          usage: () => noUsage,
          upstreamRequestId: null,
        });
        return reply;
      };
      /** The answer the caller gets, and how it came. */
      let final:
        | {
            readonly account: ChosenAccount;
            readonly route: Plan;
            readonly accountFormat: ApiFormat;
            readonly headers: Record<string, string>;
            readonly sent: SentRequest;
            readonly upstream: Response;
          }
        | undefined;
      /** The last answer that was not good enough, while trying others. */
      let lastFailure: typeof final;

      for (let attempt = 1; ; attempt += 1) {
        let chosen: ChosenAccount | undefined;
        try {
          chosen = await accounts.select({
            agentTool,
            ...routing,
            avoid: tried,
            model: requestedModel(body),
            endpoint,
          });
        } catch (error) {
          if (lastFailure !== undefined) {
            final = lastFailure;
            break;
          }
          if (error instanceof ForcedAccountError) {
            return refuse(503, error.message);
          }
          if (error instanceof AccountsUnavailableError) {
            return refuse(
              error.status,
              error.message,
              null,
              error.retryAt === undefined
                ? {}
                : {
                    "retry-after": String(
                      Math.max(
                        1,
                        Math.ceil(
                          (error.retryAt.getTime() - now().getTime()) / 1000,
                        ),
                      ),
                    ),
                  },
            );
          }
          request.log.error(
            { err: error },
            "The AI Accounts could not be read.",
          );
          return refuse(503, "The AI Gateway could not read its AI Accounts.");
        }
        if (chosen === undefined) {
          if (lastFailure !== undefined) {
            final = lastFailure;
            break;
          }
          return refuse(503, "No AI Account is available.");
        }
        // A Combo's slot is its account with its Model: the account may be
        // in another slot with another.
        const accountKey =
          chosen.combo === undefined
            ? (chosen.id ?? chosen.name)
            : comboSlotKey(chosen.id ?? chosen.name, chosen.combo.model);
        if (heldBack.has(accountKey) && lastFailure !== undefined) {
          final = lastFailure;
          break;
        }
        account = chosen;
        const accountFormat = chosen.apiFormat ?? "anthropic";

        let route: Plan;
        try {
          route = planFor(
            endpoint,
            accountFormat,
            chosen.model === undefined ? body : withModel(body, chosen.model),
            { now: now() },
          );
          if (accountFormat === "anthropic") {
            route = {
              ...route,
              body: withPromptCacheTtl(route.body, promptCacheTtl()),
            };
          }
        } catch (error) {
          if (error instanceof TranslationError) {
            return refuse(400, error.message, error.param);
          }
          if (error instanceof ZodError) {
            const { message, param } = schemaProblem(error);
            return refuse(400, message, param);
          }
          throw error;
        }

        const headers =
          route.kind === "passthrough"
            ? forwardedHeaders(request.headers)
            : {
                "content-type": "application/json",
                accept: route.streamed
                  ? "text/event-stream"
                  : "application/json",
                ...(accountFormat === "anthropic"
                  ? { "anthropic-version": "2023-06-01" }
                  : {}),
                ...(typeof request.headers["user-agent"] === "string"
                  ? { "user-agent": request.headers["user-agent"] }
                  : {}),
              };
        const upstreamPath = `${route.upstreamPath}${
          route.kind === "passthrough" ? search : ""
        }`;

        // Back to an account already tried: wait, longer each time.
        if (tried.includes(accountKey)) {
          backoffs += 1;
          await sleep(retryDelayMs(retry, backoffs), abort.signal);
          if (abort.signal.aborted) {
            return callerGone();
          }
        }
        tried.push(accountKey);
        const canRetry =
          attempt <
          (chosen.combo === undefined
            ? attempts
            : Math.max(attempts, chosen.combo.slots));

        // A cloud platform's account reshapes and signs the request just
        // before it goes, so its signature is fresh (FR-35).
        let sent: SentRequest;
        if (chosen.cloud === undefined) {
          const url = upstreamUrl(chosen, upstreamPath);
          sent = {
            url,
            // On its host: an endpoint's own path (`/openai/v1`) included.
            path: url.slice(new URL(url).origin.length),
            body: route.body,
            auth: authHeaders({
              ...chosen,
              apiFormat: accountFormat,
            }),
          };
        } else {
          try {
            const prepared = await chosen.cloud.prepare(
              route.upstreamPath,
              route.body,
            );
            sent = { ...prepared, auth: prepared.headers };
          } catch (error) {
            if (error instanceof CloudRequestError) {
              return refuse(400, error.message);
            }
            // Its credentials could not sign: as if it could not be reached.
            request.log.warn(
              { err: error, account: chosen.name, attempt },
              "An AI Account's cloud credentials could not sign a request.",
            );
            await tellOutcome(chosen, { kind: "failed" }, request.log);
            if (canRetry) {
              continue;
            }
            if (lastFailure !== undefined) {
              final = lastFailure;
              break;
            }
            return refuse(
              502,
              "The AI Gateway could not sign in to the AI Provider with this AI Account's credentials.",
            );
          }
        }
        exchange.request = {
          method: "POST",
          path: sent.path,
          headers,
          body: sent.body.toString("utf8"),
        };

        let upstream: Response;
        try {
          upstream = await upstreamFetch(sent.url, {
            method: "POST",
            headers: {
              ...headers,
              "accept-encoding": "identity",
              ...sent.auth,
              ...withBetas(headers["anthropic-beta"], chosen.betas),
              ...chosen.headers,
            },
            body: new Uint8Array(sent.body),
            signal: abort.signal,
            // The account's credential and the request go to its own
            // endpoint only (pen-testing G1-7): a redirect is not followed.
            redirect: "manual",
          });
        } catch (error) {
          if (abort.signal.aborted) {
            // The caller went away first; there is nothing left to send.
            return callerGone();
          }
          request.log.warn(
            { err: error, account: chosen.name, attempt },
            "The AI Provider could not be reached.",
          );
          await tellOutcome(chosen, { kind: "failed" }, request.log);
          if (canRetry) {
            continue;
          }
          if (lastFailure !== undefined) {
            final = lastFailure;
            break;
          }
          return refuse(502, "The AI Gateway could not reach the AI Provider.");
        }

        // A redirect is the AI Provider sending the request elsewhere: it is
        // neither followed nor passed on, since the caller's client would
        // follow it with its Gateway Key (pen-testing G1-7). It counts as
        // an AI Provider that could not be reached.
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel().catch(() => undefined);
          request.log.warn(
            { account: chosen.name, status: upstream.status, attempt },
            "The AI Provider answered with a redirect, which is not followed.",
          );
          await tellOutcome(chosen, { kind: "failed" }, request.log);
          if (canRetry) {
            continue;
          }
          if (lastFailure !== undefined) {
            final = lastFailure;
            break;
          }
          return refuse(
            502,
            "The AI Provider answered with a redirect, which the AI Gateway does not follow.",
          );
        }

        if (upstream.ok) {
          void tellOutcome(
            chosen,
            { kind: "served" },
            request.log,
            upstream.headers,
          );
          final = {
            account: chosen,
            route,
            accountFormat,
            headers,
            sent,
            upstream,
          };
          break;
        }
        // An error is short: it is read whole, to tell what it says about
        // the account, and kept to send on if nothing better comes.
        const text = await upstream.text().catch(() => "");
        const outcome = outcomeOf(
          { status: upstream.status, headers: upstream.headers, body: text },
          now(),
        );
        const failure = {
          account: chosen,
          route,
          accountFormat,
          headers,
          sent,
          upstream: new Response(text, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
          }),
        };
        if (outcome.kind === "refused") {
          void tellOutcome(chosen, outcome, request.log, upstream.headers);
          final = failure;
          break;
        }
        request.log.warn(
          {
            account: chosen.name,
            status: upstream.status,
            outcome: outcome.kind,
            attempt,
            ...("until" in outcome
              ? { until: outcome.until.toISOString() }
              : {}),
          },
          canRetry
            ? "An AI Account could not serve a request; trying again."
            : "An AI Account could not serve a request.",
        );
        await tellOutcome(chosen, outcome, request.log, upstream.headers);
        if (outcome.kind !== "failed") {
          heldBack.add(accountKey);
        }
        if (!canRetry) {
          final = failure;
          break;
        }
        lastFailure = failure;
      }

      account = final.account;
      const { route, accountFormat, upstream } = final;
      if (
        accountFormat === "anthropic" &&
        route.upstreamPath === "/v1/messages" &&
        // A cloud platform's account is not kept warm (yet).
        final.account.cloud === undefined
      ) {
        keptWarm = { sessionKey: routing.sessionKey };
      }
      exchange.request = {
        method: "POST",
        path: final.sent.path,
        headers: final.headers,
        body: final.sent.body.toString("utf8"),
      };
      const { name } = account;
      timing.firstByteAt = performance.now();

      const upstreamStreamed = (
        upstream.headers.get("content-type") ?? ""
      ).includes("text/event-stream");
      // Nothing the AI Provider sent back reaches the caller with the
      // account's credential in it (pen-testing G1-6): its headers, its
      // body, passed through or translated, whole or streamed.
      const credentials = credentialsSent(account.apiKey, final.sent.auth);
      const responseHeaders = scrubbedHeaders(
        returnedHeaders(upstream.headers),
        credentials,
      );
      const sentRequestId =
        upstream.headers.get("request-id") ??
        upstream.headers.get("x-request-id");
      const upstreamRequestId =
        sentRequestId === null ? null : scrubbed(sentRequestId, credentials);
      const chunks: Buffer[] = [];
      const upstreamBody = () => Buffer.concat(chunks).toString("utf8");
      const brokeOff = (error: Error | null) => {
        if (error && !abort.signal.aborted) {
          request.log.warn(
            { err: error, account: name },
            "The AI Provider's response broke off.",
          );
        }
      };

      if (route.kind === "passthrough") {
        // Bodies are kept only when something needs them afterwards: the
        // usage of a non-streamed response, or a fixture.
        const keepBody =
          !upstreamStreamed || fixtureRecorder !== undefined || storing;
        const streamUsage = !upstreamStreamed
          ? undefined
          : route.usage === "anthropic"
            ? new StreamUsageReader()
            : new OpenAiStreamUsageReader(route.usage);
        const tap = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            streamUsage?.push(chunk);
            if (keepBody) {
              chunks.push(chunk);
            }
            callback(null, chunk);
          },
        });
        const usage = (): Usage => {
          if (streamUsage !== undefined) {
            return streamUsage.usage;
          }
          if (route.usage !== "anthropic") {
            return usageFromOpenAiBody(route.usage, upstreamBody());
          }
          return endpoint === "messages"
            ? usageFromMessage(upstreamBody())
            : noUsage;
        };
        reply.raw.once("close", () => {
          finish({
            status: upstream.status,
            streamed: upstreamStreamed,
            responseHeaders,
            upstreamBody,
            clientBody: () => scrubbed(upstreamBody(), credentials),
            usage,
            upstreamRequestId,
          });
        });
        reply.code(upstream.status).headers(responseHeaders);
        if (upstream.body === null) {
          return reply.send();
        }
        const scrub = scrubbing(credentials);
        pipeline(Readable.fromWeb(upstream.body), tap, scrub, brokeOff);
        return reply.send(scrub);
      }

      // Translated: the answer is written in the caller's format.
      const answerHeaders: Record<string, string> = {};
      if (upstreamRequestId !== null) {
        answerHeaders["x-request-id"] = upstreamRequestId;
      }
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter !== null) {
        answerHeaders["retry-after"] = scrubbed(retryAfter, credentials);
      }

      if (!upstream.ok || !upstreamStreamed) {
        const text = await upstream.text();
        chunks.push(Buffer.from(text, "utf8"));
        let status = upstream.status;
        let sent: unknown;
        let usage: Usage = noUsage;
        const whole = upstream.ok ? parseJson(text) : undefined;
        if (!upstream.ok) {
          // The AI Provider's error, in the caller's format.
          const error = upstreamError(text);
          sent =
            clientFormat === "anthropic"
              ? anthropicError(
                  accountFormat === "anthropic" && error.type !== undefined
                    ? error.type
                    : anthropicErrorType(status),
                  error.message,
                )
              : openAiError(openAiErrorType(status), error.message);
        } else if (typeof whole === "object" && whole !== null) {
          ({ body: sent, usage } = route.whole(
            whole as Record<string, unknown>,
          ));
        } else {
          status = 502;
          sent = errorBody(
            clientFormat,
            502,
            "The AI Provider's response could not be read.",
          );
        }
        const answer = scrubbed(JSON.stringify(sent), credentials);
        reply.raw.once("close", () => {
          finish({
            status,
            streamed: false,
            responseHeaders,
            upstreamBody,
            clientBody: () => answer,
            usage: () => usage,
            upstreamRequestId,
          });
        });
        return reply
          .code(status)
          .headers(answerHeaders)
          .type("application/json")
          .send(answer);
      }

      const translator = route.stream();
      const reader = new SseReader();
      const keepUpstream = fixtureRecorder !== undefined;
      // The translated answer, kept when bodies are stored.
      const answered: string[] = [];
      const send = (out: string): string | undefined => {
        if (storing) {
          answered.push(out);
        }
        return out === "" ? undefined : out;
      };
      const translate = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (keepUpstream) {
            chunks.push(chunk);
          }
          const out = reader
            .push(chunk)
            .flatMap((event) => translator.push(event))
            .join("");
          callback(null, send(out));
        },
        flush(callback) {
          const out = [
            ...reader.end().flatMap((event) => translator.push(event)),
            ...translator.end(),
          ].join("");
          callback(null, send(out));
        },
      });
      reply.raw.once("close", () => {
        finish({
          status: upstream.status,
          streamed: true,
          responseHeaders,
          upstreamBody,
          clientBody: () => scrubbed(answered.join(""), credentials),
          usage: () => translator.usage,
          upstreamRequestId,
        });
      });
      reply.code(upstream.status).headers({
        ...answerHeaders,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      if (upstream.body === null) {
        return reply.send("");
      }
      const scrub = scrubbing(credentials);
      pipeline(Readable.fromWeb(upstream.body), translate, scrub, brokeOff);
      return reply.send(scrub);
    };

  for (const [endpoint, { path, format }] of Object.entries(endpoints)) {
    app.post(
      path,
      {
        onRequest: requireKey({
          route: endpoint,
          body: (status, message) => errorBody(format, status, message),
          unauthorised: (keyPresented) =>
            keyPresented
              ? "That Gateway Key is not in use."
              : "A Gateway Key is required: send it as x-api-key or as a bearer token.",
        }),
      },
      handle(endpoint as GatewayEndpoint),
    );
  }

  // The tool-call screen, for an Agent's sandbox to ask before a call runs
  // (P1-8). Its answer is the agent tool's hook's; a refusal here (no key,
  // not an Agent's) makes the hook block the call. It reaches no AI
  // Account, so it is not a model call and is not recorded as one.
  const { toolCallScreen } = options;
  if (toolCallScreen !== undefined) {
    const onRequest = requireKey({
      route: "tool_call_screen",
      body: (status, message) =>
        anthropicError(anthropicErrorType(status), message),
      unauthorised: () => "A Gateway Key in use is required.",
    });
    app.post(toolCallScreenPath, { onRequest }, async (request, reply) => {
      const caller = callers.get(request);
      if (caller === undefined) {
        throw new Error(
          "A tool-call screen request reached its route unchecked.",
        );
      }
      if (caller.kind !== "agent") {
        return reply
          .code(403)
          .send(
            anthropicError(
              "permission_error",
              "Only an Agent's sandbox asks the tool-call screen.",
            ),
          );
      }
      const body = Buffer.isBuffer(request.body)
        ? parseJson(request.body)
        : undefined;
      return reply.code(200).send(
        await toolCallScreen({
          agentId: caller.agentId,
          floorId: caller.floorId,
          session:
            headerValue(request.headers, aiOfficeHeaders.session)?.slice(
              0,
              maxSessionLength,
            ) ?? null,
          body,
        }),
      );
    });
  }

  app.setNotFoundHandler((_request, reply) => noSuchRoute(reply));

  return app;
}
