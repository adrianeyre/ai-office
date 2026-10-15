import type { RateLimitKind } from "@ai-office/shared";

import { durationMs } from "./detect.ts";

// An API key's rate limits (PRD FR-36), as its AI Provider reports them
// with each answer, served or not, for the AI Accounts card's "left this
// minute" bars. Two families of headers are read:
// - Anthropic's `anthropic-ratelimit-{requests,tokens,input-tokens,
//   output-tokens}-{limit,remaining,reset}`, the reset in RFC 3339
//   (https://platform.claude.com/docs/en/api/rate-limits). Its token
//   counts are rounded to the nearest thousand, and `tokens` is the most
//   restrictive limit in force.
// - OpenAI's `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`, the
//   reset a duration such as `1s` or `6m0s`
//   (https://developers.openai.com/api/docs/guides/rate-limits), which
//   xAI's API sends too (seen on its answers; xAI does not document them).
// OpenRouter sends `X-RateLimit-*` only on its own 429s, DeepSeek, Kimi,
// Z.ai, MiniMax and Gemini none that are documented: their accounts report
// nothing here. A limit is kept only when both its limit and what remains
// are given as numbers.

/** One rate limit as an answer gives it. */
export interface RateLimitReading {
  readonly limit: number;
  readonly remaining: number;
  /** Undefined when the answer did not say. */
  readonly resetsAt: Date | undefined;
}

export type RateLimitReadings = Partial<
  Record<RateLimitKind, RateLimitReading>
>;

const anthropicNames: Record<RateLimitKind, string> = {
  requests: "requests",
  tokens: "tokens",
  inputTokens: "input-tokens",
  outputTokens: "output-tokens",
};

const count = (value: string | null): number | undefined => {
  const text = value?.trim();
  return text === undefined || !/^\d+(\.\d+)?$/.test(text)
    ? undefined
    : Number(text);
};

const rfc3339 = (value: string | null): Date | undefined => {
  if (value === null) {
    return undefined;
  }
  const at = new Date(value.trim());
  return Number.isNaN(at.getTime()) ? undefined : at;
};

/** The rate limits an answer's headers report; none for most. */
export function rateLimitsOf(
  headers: Headers,
  now: Date = new Date(),
): RateLimitReadings {
  const readings: Record<string, RateLimitReading> = {};
  for (const [kind, name] of Object.entries(anthropicNames)) {
    const prefix = `anthropic-ratelimit-${name}`;
    const limit = count(headers.get(`${prefix}-limit`));
    const remaining = count(headers.get(`${prefix}-remaining`));
    if (limit !== undefined && remaining !== undefined) {
      readings[kind] = {
        limit,
        remaining,
        resetsAt: rfc3339(headers.get(`${prefix}-reset`)),
      };
    }
  }
  for (const kind of ["requests", "tokens"] as const) {
    const limit = count(headers.get(`x-ratelimit-limit-${kind}`));
    const remaining = count(headers.get(`x-ratelimit-remaining-${kind}`));
    if (
      readings[kind] !== undefined ||
      limit === undefined ||
      remaining === undefined
    ) {
      continue;
    }
    const reset = headers.get(`x-ratelimit-reset-${kind}`);
    const after = reset === null ? undefined : durationMs(reset);
    readings[kind] = {
      limit,
      remaining,
      resetsAt:
        after === undefined ? undefined : new Date(now.getTime() + after),
    };
  }
  return readings;
}
