import {
  defaultPromptCacheKeepAliveSettings,
  keepAliveLeadMs,
  type PromptCacheKeepAliveSettings,
} from "@ai-office/shared";

import {
  withBetas,
  type CapCheck,
  type CapCheckSubject,
  type GatewayAccount,
} from "../gateway.ts";
import { authHeaders } from "../accounts/auth-headers.ts";
import { outcomeOf, type AccountOutcome } from "../limits/detect.ts";
import {
  usageWindowsOf,
  type UsageWindowReadings,
} from "../limits/usage-windows.ts";
import type { CostEstimator } from "../pricing/pricing.ts";
import type { RequestLog } from "../request-log.ts";
import { noUsage, usageFromMessage, type Usage } from "../usage.ts";

// Prompt-cache keep-alive (PRD FR-39). Anthropic keeps a prompt cache for
// its TTL (five minutes unless a breakpoint asks for an hour) from the
// start of the last request that read or wrote it. An Agent that pauses
// longer, for a long test run or a slow build, would pay to write its
// whole conversation again. So, while keep-alive is on, the Gateway
// remembers each Agent session's latest Messages request that an
// Anthropic-format AI Account served with a cache breakpoint, and shortly
// before its cache would expire sends it again as a minimal request:
// `max_tokens: 0`, not streamed, which only reads the cache (refreshing
// its TTL) and generates nothing. It goes to the same account, as the
// agent tool's request went.
//
// - Only active sessions: a session whose Agent has made no request of its
//   own for the idle time is let go, and so is one whose cache expired
//   before it could be kept warm (a request then would write it anew).
// - Bounded per account: each AI Account is sent at most the Owner's
//   number of keep-alives in any hour; a session over the bound waits.
// - Only while the account can serve: one that is paused, held back or
//   signed out is not sent one, and an Agent paused at a Token Cap is let
//   go. A keep-alive the AI Provider does not serve lets its session go.
// - Visible: each keep-alive is recorded as a request, attributed to its
//   Agent, Floor and issue and marked as a keep-alive, so the request
//   history and the analytics show it and what it cost.
//
// Requests that cannot be sent with `max_tokens: 0` (a thinking budget,
// structured outputs, a forced tool choice) are never kept warm.

/** How often the server runs a round: often enough to be in time. */
export const keepAliveRoundMs = 15 * 1000;

const ttlMs = { "5m": 5 * 60 * 1000, "1h": 60 * 60 * 1000 } as const;
const hourMs = 60 * 60 * 1000;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A request's `cache_control` breakpoints, in every place they may be. */
function breakpointsOf(request: Json): Json[] {
  const found: Json[] = [];
  const add = (cache: unknown) => {
    if (isObject(cache) && cache["type"] === "ephemeral") {
      found.push(cache);
    }
  };
  const addBlocks = (blocks: unknown) => {
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (isObject(block)) {
          add(block["cache_control"]);
        }
      }
    }
  };
  add(request["cache_control"]);
  addBlocks(request["system"]);
  addBlocks(request["tools"]);
  if (Array.isArray(request["messages"])) {
    for (const message of request["messages"]) {
      if (isObject(message)) {
        addBlocks(message["content"]);
      }
    }
  }
  return found;
}

/** A Messages request's keep-alive: the request, and how long its cache lasts. */
export interface KeepAliveRequest {
  /** The request with `max_tokens: 0`, not streamed. */
  readonly body: string;
  readonly model: string | null;
  /** The shortest TTL among its breakpoints: when its last one expires. */
  readonly ttlMs: number;
}

/**
 * The keep-alive of a Messages request as it was sent to Anthropic's API;
 * undefined when it has no cache breakpoint, or asks for something
 * `max_tokens: 0` is refused with (a thinking budget, structured outputs,
 * a forced tool choice).
 */
export function keepAliveRequestOf(body: string): KeepAliveRequest | undefined {
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isObject(request)) {
    return undefined;
  }
  const breakpoints = breakpointsOf(request);
  const thinking = request["thinking"];
  const output = request["output_config"];
  const toolChoice = request["tool_choice"];
  if (
    breakpoints.length === 0 ||
    (isObject(thinking) && thinking["type"] === "enabled") ||
    (isObject(output) && output["format"] !== undefined) ||
    (isObject(toolChoice) &&
      (toolChoice["type"] === "any" || toolChoice["type"] === "tool"))
  ) {
    return undefined;
  }
  const kept: Json = { ...request, max_tokens: 0 };
  delete kept["stream"];
  const model = request["model"];
  return {
    body: JSON.stringify(kept),
    model: typeof model === "string" ? model : null,
    ttlMs: breakpoints.every((cache) => cache["ttl"] === "1h")
      ? ttlMs["1h"]
      : ttlMs["5m"],
  };
}

/** A request an Agent made, served by an Anthropic-format AI Account. */
export interface ObservedRequest {
  readonly startedAt: Date;
  /** Its session (FR-37): its Gateway Key, and the session it named. */
  readonly sessionKey: string;
  readonly gatewayKeyId: string;
  readonly agentId: string;
  readonly floorId: string;
  readonly issue: number | null;
  readonly pullRequest: number | null;
  /** The AI Account that served it. */
  readonly accountId: string;
  /** Where it was sent on that account's API (`/v1/messages?…`). */
  readonly path: string;
  /** The headers it was sent with: never a credential. */
  readonly headers: Readonly<Record<string, string>>;
  /** Its body, as it was sent. */
  readonly body: string;
}

/** What keep-alive needs of the AI Accounts. */
export interface KeepAliveAccounts {
  /** The account, ready to send to, while it can serve; else undefined. */
  keepAliveAccount(
    id: string,
    model: string | null,
  ): Promise<GatewayAccount | undefined>;
  /** Told what each answer said, as for any request (FR-39). */
  report(
    account: GatewayAccount,
    outcome: AccountOutcome,
    usage?: UsageWindowReadings,
  ): Promise<void>;
}

export interface PromptCacheKeepAliveOptions {
  readonly accounts: KeepAliveAccounts;
  /** Where each keep-alive is recorded, as every request is. */
  readonly requestLog: RequestLog;
  /** Asked as each request is seen and each round runs: off by default. */
  readonly settings?: () => PromptCacheKeepAliveSettings;
  /** Each keep-alive's estimated cost (FR-43). */
  readonly pricing?: CostEstimator;
  /** Whether the Agent is paused at a Token Cap (FR-33). */
  readonly capCheck?: (subject: CapCheckSubject) => Promise<CapCheck>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** What a round of keep-alive did. */
export interface KeepAliveReport {
  /** Keep-alives the AI Provider served. */
  readonly served: number;
  /** Keep-alives that were not served, and why. */
  readonly failed: { readonly agentId: string; readonly error: unknown }[];
  /** Sessions due, left waiting: their account at its bound, or held back. */
  readonly waiting: number;
  /** Sessions let go: idle, expired, or their Agent paused at a cap. */
  readonly stopped: number;
}

export interface PromptCacheKeepAlive {
  /** Sees an Agent's request once it has been served. */
  observe(request: ObservedRequest): void;
  /** Sends each session that is due its keep-alive: every `keepAliveRoundMs`. */
  run(): Promise<KeepAliveReport>;
  /** How many sessions are being kept warm. */
  sessions(): number;
}

interface Session {
  /** Its Agent's latest request, and that request's keep-alive. */
  observed: ObservedRequest;
  request: KeepAliveRequest;
  /** When its Agent's own latest request started. */
  lastRequestAt: number;
  /** When its cache was last read or written: a request's start. */
  warmAt: number;
  sending: boolean;
}

export function createPromptCacheKeepAlive(
  options: PromptCacheKeepAliveOptions,
): PromptCacheKeepAlive {
  const { accounts, requestLog, pricing, capCheck } = options;
  const settings =
    options.settings ?? (() => defaultPromptCacheKeepAliveSettings);
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  /** Each session's latest request, by its session and Model. */
  const sessions = new Map<string, Session>();
  /** When each account was sent each keep-alive in the last hour. */
  const sent = new Map<string, number[]>();

  const sentInLastHour = (accountId: string, at: number): number[] => {
    const times = (sent.get(accountId) ?? []).filter((t) => t > at - hourMs);
    sent.set(accountId, times);
    return times;
  };

  /** A keep-alive's answer, recorded as a request and told to the accounts. */
  const keepWarm = async (
    key: string,
    session: Session,
    account: GatewayAccount,
    report: { served: number; failed: KeepAliveReport["failed"] },
  ): Promise<void> => {
    const { observed, request } = session;
    /** Lets the session go, unless a newer request has taken it over. */
    const letGo = () => {
      if (session.observed === observed) {
        sessions.delete(key);
      }
    };
    const startedAt = now();
    const start = performance.now();
    let firstByteAt: number | undefined;
    let status = 502;
    let usage: Usage = noUsage;
    let upstreamRequestId: string | null = null;
    let responseHeaders: Record<string, string> | null = null;
    try {
      const response = await send(
        `${account.baseUrl.replace(/\/+$/, "")}${observed.path}`,
        {
          method: "POST",
          headers: {
            ...observed.headers,
            accept: "application/json",
            "accept-encoding": "identity",
            ...authHeaders({ ...account, apiFormat: "anthropic" }),
            ...withBetas(observed.headers["anthropic-beta"], account.betas),
            ...account.headers,
          },
          body: request.body,
          signal: AbortSignal.timeout(60_000),
          // Its credential goes to its own endpoint only (pen-testing G1-7).
          redirect: "manual",
        },
      );
      firstByteAt = performance.now();
      const text = await response.text();
      status = response.status;
      upstreamRequestId =
        response.headers.get("request-id") ??
        response.headers.get("x-request-id");
      responseHeaders = {};
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") {
          responseHeaders[name] = value;
        }
      }
      const outcome = outcomeOf(
        { status, headers: response.headers, body: text },
        now(),
      );
      await accounts.report(
        account,
        outcome,
        usageWindowsOf(response.headers, now()),
      );
      if (outcome.kind === "served") {
        usage = usageFromMessage(text);
        session.warmAt = Math.max(session.warmAt, startedAt.getTime());
        report.served += 1;
      } else {
        letGo();
        report.failed.push({
          agentId: observed.agentId,
          error: new Error(
            `The AI Provider answered a keep-alive with ${String(status)}.`,
          ),
        });
      }
    } catch (error) {
      // Unreachable: the error never holds the credential, only the URL.
      await accounts.report(account, { kind: "failed" }).catch(() => undefined);
      letGo();
      report.failed.push({ agentId: observed.agentId, error });
    }
    await requestLog.record({
      startedAt,
      account: account.name,
      accountId: account.id,
      gatewayKeyId: observed.gatewayKeyId,
      agentId: observed.agentId,
      floorId: observed.floorId,
      ownerTool: null,
      issue: observed.issue,
      pullRequest: observed.pullRequest,
      endpoint: "messages",
      model: request.model,
      streamed: false,
      status,
      latencyMs: Math.round(performance.now() - start),
      ...usage,
      upstreamRequestId,
      estimatedCostUsd: pricing?.estimate(request.model, usage) ?? null,
      timeToFirstByteMs:
        firstByteAt === undefined ? null : Math.round(firstByteAt - start),
      requestHeaders: observed.headers,
      responseHeaders,
      keepAlive: true,
    });
  };

  return {
    observe(observed) {
      if (!settings().enabled) {
        return;
      }
      const request = keepAliveRequestOf(observed.body);
      if (request === undefined) {
        return;
      }
      const key = `${observed.sessionKey}\n${request.model ?? ""}`;
      const at = observed.startedAt.getTime();
      const current = sessions.get(key);
      if (current === undefined) {
        sessions.set(key, {
          observed,
          request,
          lastRequestAt: at,
          warmAt: at,
          sending: false,
        });
        return;
      }
      // An earlier request finishing after a later one leaves the later
      // one's prefix to keep warm.
      if (at >= current.lastRequestAt) {
        current.observed = observed;
        current.request = request;
        current.lastRequestAt = at;
        current.warmAt = Math.max(at, current.warmAt);
      }
    },

    async run() {
      const report = {
        served: 0,
        failed: [] as KeepAliveReport["failed"],
        waiting: 0,
        stopped: 0,
      };
      const { enabled, idleMinutes, maxPerAccountPerHour } = settings();
      if (!enabled) {
        report.stopped = sessions.size;
        sessions.clear();
        sent.clear();
        return report;
      }
      const at = now().getTime();
      const idleMs = idleMinutes * 60 * 1000;
      const sending: Promise<void>[] = [];
      for (const [key, session] of sessions) {
        if (session.sending) {
          continue;
        }
        const expiresAt = session.warmAt + session.request.ttlMs;
        if (at - session.lastRequestAt >= idleMs || at >= expiresAt) {
          sessions.delete(key);
          report.stopped += 1;
          continue;
        }
        if (at < expiresAt - keepAliveLeadMs) {
          continue;
        }
        const { accountId } = session.observed;
        const times = sentInLastHour(accountId, at);
        if (times.length >= maxPerAccountPerHour) {
          report.waiting += 1;
          continue;
        }
        // Counted, and marked, before anything is awaited, so neither this
        // round's other sessions nor an overlapping round go past the bound.
        times.push(at);
        session.sending = true;
        let dispatched = false;
        // A session that waits gives its slot back. The account's times
        // are looked up again, as a later count may have replaced them.
        const release = () => {
          const current = sentInLastHour(accountId, at);
          const index = current.indexOf(at);
          if (index !== -1) {
            current.splice(index, 1);
          }
        };
        sending.push(
          (async () => {
            try {
              const account = await accounts.keepAliveAccount(
                accountId,
                session.request.model,
              );
              if (account === undefined) {
                release();
                report.waiting += 1;
                return;
              }
              const refusal = await capCheck?.({
                floorId: session.observed.floorId,
                agentId: session.observed.agentId,
                issue: session.observed.issue ?? undefined,
              });
              if (refusal !== undefined) {
                release();
                sessions.delete(key);
                report.stopped += 1;
                return;
              }
              dispatched = true;
              await keepWarm(key, session, account, report);
            } catch (error) {
              if (!dispatched) {
                release();
              }
              report.failed.push({ agentId: session.observed.agentId, error });
            } finally {
              session.sending = false;
            }
          })(),
        );
      }
      await Promise.all(sending);
      return report;
    },

    sessions: () => sessions.size,
  };
}
