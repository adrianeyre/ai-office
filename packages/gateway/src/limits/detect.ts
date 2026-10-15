import { modelFamilyOf } from "@ai-office/shared";

// What an AI Provider's answer says about the AI Account that sent it (PRD
// FR-38, FR-39): served; rate-limited or overloaded, and until when; failed
// (a server error, which counts towards the account's circuit breaker); or
// refused, which is the request's fault, not the account's. It is read from
// the status, the headers and the error body, as each AI Provider writes
// them:
// - Anthropic: `429 rate_limit_error` and `529 overloaded_error`, with
//   `retry-after`, the `anthropic-ratelimit-*-reset` times (RFC 3339) of
//   the limits with nothing remaining, and a subscription's
//   `anthropic-ratelimit-unified-reset` (seconds since the epoch);
// - OpenAI-compatible APIs (xAI, and others): 429 with `retry-after` or
//   `retry-after-ms`, and `x-ratelimit-reset-requests` / `-tokens` as
//   durations (`1s`, `6m0s`, `250ms`);
// - Google (Gemini): 429 `RESOURCE_EXHAUSTED` with a `RetryInfo`
//   `retryDelay` in the error's details, and 503 `UNAVAILABLE` when the
//   model is overloaded;
// - ChatGPT's Codex backend (a subscription): 429 `usage_limit_reached`,
//   with `resets_in_seconds`, or `resets_at` (seconds since the epoch), in
//   the error;
// - Kimi and Z.ai say they are overloaded with a 429: Kimi's
//   `engine_overloaded_error`, Z.ai's business code `1305`; DeepSeek with
//   `503 Server Overloaded`;
// - OpenRouter and DeepSeek answer 402 when the account has no credit
//   left, which is the account's failure, not the request's.
// A rate limit that says it is for one model family only (FR-38) leaves
// the account's other families be: Google's `QuotaFailure` naming a
// `model` in its quota's dimensions, or a Claude subscription's
// `anthropic-ratelimit-unified-representative-claim` naming a weekly
// Opus or Sonnet limit (`seven_day_opus`, `seven_day_sonnet`; Anthropic
// does not document it).
// A served answer may say its account is past its plan's limit and was
// served on extra usage (FR-41): a Claude subscription's
// `anthropic-ratelimit-unified-status: rejected` with
// `anthropic-ratelimit-unified-overage-status` `allowed` (or
// `allowed_warning`), until `anthropic-ratelimit-unified-reset`. These are
// what Claude Code reads; Anthropic does not document them either.

/** What one answer says about the account that gave it. */
export type AccountOutcome =
  | {
      readonly kind: "served";
      /**
       * When it was served on extra usage: until its plan's limit resets.
       */
      readonly extraUsageUntil?: Date;
    }
  | {
      readonly kind: "rate_limited";
      readonly until: Date;
      /**
       * The model family the limit is for, when the answer says it is for
       * one only; otherwise the whole account is limited.
       */
      readonly modelFamily?: string;
    }
  | { readonly kind: "overloaded"; readonly until: Date }
  | { readonly kind: "failed" }
  | { readonly kind: "refused" };

/** How long a limit lasts when the AI Provider does not say. */
export const defaultRateLimitMs = 60 * 1000;
export const defaultOverloadMs = 30 * 1000;
/** How long a plan's limit lasts when the AI Provider does not say. */
export const defaultPlanLimitMs = 60 * 60 * 1000;
/** No limit is believed to last longer than this. */
const longestLimitMs = 8 * 24 * 60 * 60 * 1000;

/** `1s`, `6m0s`, `1h2m3.5s`, `250ms` or plain seconds, in milliseconds. */
export function durationMs(value: string): number | undefined {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text) * 1000;
  }
  const parts =
    /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(
      text,
    );
  if (parts === null || text === "") {
    return undefined;
  }
  const [, hours, minutes, seconds, millis] = parts;
  return (
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1000 +
    Number(millis ?? 0)
  );
}

/** A time given as RFC 3339, an HTTP date, or seconds since the epoch. */
function timeOf(value: string): Date | undefined {
  const text = value.trim();
  if (/^\d{9,11}(\.\d+)?$/.test(text)) {
    return new Date(Number(text) * 1000);
  }
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The error object in an error body: `{error}`, or Google's `[{error}]`. */
function errorOf(body: string): Record<string, unknown> | undefined {
  let parsed = parseJson(body);
  if (Array.isArray(parsed)) {
    parsed = parsed[0];
  }
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
    return undefined;
  }
  const { error } = parsed;
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
}

/** Every word the error uses to say what it is: its type, code and status. */
function errorWords(error: Record<string, unknown> | undefined): string[] {
  return ["type", "code", "status"]
    .map((field) => error?.[field])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
}

/** Google's `RetryInfo` delay, from an error's details. */
function retryDelayOf(
  error: Record<string, unknown> | undefined,
): number | undefined {
  const details = error?.["details"];
  if (!Array.isArray(details)) {
    return undefined;
  }
  for (const detail of details) {
    const delay = (detail as { retryDelay?: unknown } | null)?.retryDelay;
    if (typeof delay === "string") {
      const ms = durationMs(delay);
      if (ms !== undefined) {
        return ms;
      }
    }
  }
  return undefined;
}

/**
 * The model family a rate limit is for, when the answer says it is for one
 * only: a Google quota whose dimensions name a model, or a Claude
 * subscription's weekly Opus or Sonnet limit.
 */
export function limitedModelFamily(
  headers: Headers,
  error: Record<string, unknown> | undefined,
): string | undefined {
  const claim = headers
    .get("anthropic-ratelimit-unified-representative-claim")
    ?.trim()
    .toLowerCase();
  const tier = claim === undefined ? null : /_(opus|sonnet|haiku)$/.exec(claim);
  if (tier !== null) {
    return `claude-${tier[1] ?? ""}`;
  }
  const details = error?.["details"];
  for (const detail of Array.isArray(details) ? details : []) {
    const violations = (detail as { violations?: unknown } | null)?.violations;
    for (const violation of Array.isArray(violations) ? violations : []) {
      const model = (
        violation as { quotaDimensions?: { model?: unknown } } | null
      )?.quotaDimensions?.model;
      if (typeof model === "string" && model.trim() !== "") {
        return modelFamilyOf(model);
      }
    }
  }
  return undefined;
}

/**
 * When the account may be tried again: the latest of everything the answer
 * says is exhausted (a later reset means an earlier one would fail again),
 * or `fallbackMs` from now when it says nothing.
 */
export function resetOf(
  headers: Headers,
  error: Record<string, unknown> | undefined,
  now: Date,
  fallbackMs: number,
): Date {
  const at = now.getTime();
  const times: number[] = [];
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs !== null && /^\d+(\.\d+)?$/.test(retryAfterMs.trim())) {
    times.push(at + Number(retryAfterMs));
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = /^\d+(\.\d+)?$/.test(retryAfter.trim())
      ? Number(retryAfter) * 1000
      : undefined;
    const time = seconds === undefined ? timeOf(retryAfter) : undefined;
    if (seconds !== undefined) {
      times.push(at + seconds);
    } else if (time !== undefined) {
      times.push(time.getTime());
    }
  }
  // Anthropic's limits and OpenAI's, each with what remains of it: only
  // those with nothing left say when the account can serve again.
  headers.forEach((value, name) => {
    // `requests`, `tokens`, `input-tokens`, `output-tokens`, and a
    // subscription's `unified` (with a status rather than what remains).
    const anthropic = /^anthropic-ratelimit-(.+)-reset$/.exec(name);
    const openAi = /^x-ratelimit-reset-(.+)$/.exec(name);
    if (anthropic !== null) {
      const [, limit = ""] = anthropic;
      const remaining = headers.get(`anthropic-ratelimit-${limit}-remaining`);
      const status = headers.get(`anthropic-ratelimit-${limit}-status`);
      const exhausted =
        remaining === null
          ? status === null || status === "rejected"
          : Number(remaining) <= 0;
      const time = timeOf(value);
      if (exhausted && time !== undefined) {
        times.push(time.getTime());
      }
    } else if (openAi !== null) {
      const [, limit = ""] = openAi;
      const remaining = headers.get(`x-ratelimit-remaining-${limit}`);
      const ms = durationMs(value);
      if ((remaining === null || Number(remaining) <= 0) && ms !== undefined) {
        times.push(at + ms);
      }
    }
  });
  const delay = retryDelayOf(error);
  if (delay !== undefined) {
    times.push(at + delay);
  }
  // ChatGPT's usage limit says when the plan's window resets: in so many
  // seconds (free of any clock skew), or else at a time.
  const resetsIn = error?.["resets_in_seconds"];
  const resetsAt = error?.["resets_at"];
  if (typeof resetsIn === "number" && resetsIn > 0) {
    times.push(at + resetsIn * 1000);
  } else if (typeof resetsAt === "number" && resetsAt > 0) {
    times.push(resetsAt * 1000);
  }
  const latest = Math.max(...times.filter((time) => time > at));
  return new Date(
    Number.isFinite(latest)
      ? Math.min(latest, at + longestLimitMs)
      : at + fallbackMs,
  );
}

/**
 * Until when a served answer's account is on extra usage (its plan's limit
 * reached, extra usage allowed); undefined when it is not.
 */
export function extraUsageUntil(headers: Headers, now: Date): Date | undefined {
  const status = headers.get("anthropic-ratelimit-unified-status")?.trim();
  const overage = headers
    .get("anthropic-ratelimit-unified-overage-status")
    ?.trim();
  if (
    status !== "rejected" ||
    (overage !== "allowed" && overage !== "allowed_warning")
  ) {
    return undefined;
  }
  const reset = headers.get("anthropic-ratelimit-unified-reset");
  const at = reset === null ? undefined : timeOf(reset);
  return at !== undefined && at > now
    ? new Date(Math.min(at.getTime(), now.getTime() + longestLimitMs))
    : new Date(now.getTime() + defaultPlanLimitMs);
}

/** What an AI Provider's answer says about the account that gave it. */
export function outcomeOf(
  answer: {
    readonly status: number;
    readonly headers: Headers;
    /** The body, read only for an error. */
    readonly body: string;
  },
  now: Date,
): AccountOutcome {
  const { status, headers } = answer;
  if (status >= 200 && status < 300) {
    const until = extraUsageUntil(headers, now);
    return until === undefined
      ? { kind: "served" }
      : { kind: "served", extraUsageUntil: until };
  }
  const error = errorOf(answer.body);
  const words = errorWords(error);
  const message =
    typeof error?.["message"] === "string"
      ? error["message"].toLowerCase()
      : "";
  const overloaded =
    status === 529 ||
    words.includes("overloaded_error") ||
    words.includes("engine_overloaded_error") ||
    (status === 429 && words.includes("1305")) ||
    (status === 503 &&
      (words.includes("unavailable") || message.includes("overloaded")));
  if (overloaded) {
    return {
      kind: "overloaded",
      until: resetOf(headers, error, now, defaultOverloadMs),
    };
  }
  const rateLimited =
    status === 429 ||
    words.some((word) =>
      [
        "rate_limit_error",
        "rate_limit_exceeded",
        "resource_exhausted",
      ].includes(word),
    );
  if (rateLimited) {
    const modelFamily = limitedModelFamily(headers, error);
    return {
      kind: "rate_limited",
      until: resetOf(headers, error, now, defaultRateLimitMs),
      ...(modelFamily === undefined ? {} : { modelFamily }),
    };
  }
  return status >= 500 || status === 408 || status === 402
    ? { kind: "failed" }
    : { kind: "refused" };
}
