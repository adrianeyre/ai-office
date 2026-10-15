import { describe, expect, it } from "vitest";

import {
  defaultOverloadMs,
  defaultRateLimitMs,
  durationMs,
  outcomeOf,
} from "./detect.ts";

const now = new Date("2026-10-09T12:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

const answer = (
  status: number,
  headers: Record<string, string> = {},
  body: unknown = "",
) => ({
  status,
  headers: new Headers(headers),
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("durations", () => {
  it.each([
    ["1s", 1000],
    ["6m0s", 360_000],
    ["1h2m3.5s", 3_723_500],
    ["250ms", 250],
    ["17", 17_000],
    ["0.5", 500],
    ["2m", 120_000],
  ])("reads %s as %i ms", (text, ms) => {
    expect(durationMs(text)).toBe(ms);
  });

  it.each(["", "soon", "1d", "-1s"])("does not read %j", (text) => {
    expect(durationMs(text)).toBeUndefined();
  });
});

describe("what an AI Provider's answer says about its account", () => {
  it("served, for any success", () => {
    expect(outcomeOf(answer(200), now)).toEqual({ kind: "served" });
    expect(outcomeOf(answer(204), now)).toEqual({ kind: "served" });
  });

  it("refused, for the request's own faults", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(outcomeOf(answer(status), now), String(status)).toEqual({
        kind: "refused",
      });
    }
  });

  it("failed, for server errors and timeouts", () => {
    for (const status of [500, 502, 503, 504, 408]) {
      expect(outcomeOf(answer(status), now), String(status)).toEqual({
        kind: "failed",
      });
    }
  });

  it("failed, for an account out of credit (OpenRouter's and DeepSeek's 402)", () => {
    expect(
      outcomeOf(
        answer(
          402,
          {},
          { error: { code: 402, message: "Insufficient credits" } },
        ),
        now,
      ),
    ).toEqual({ kind: "failed" });
    expect(outcomeOf(answer(402), now)).toEqual({ kind: "failed" });
  });

  describe("Anthropic", () => {
    it("is rate-limited until retry-after", () => {
      expect(
        outcomeOf(
          answer(
            429,
            { "retry-after": "17" },
            {
              type: "error",
              error: { type: "rate_limit_error", message: "Slow down." },
            },
          ),
          now,
        ),
      ).toEqual({ kind: "rate_limited", until: later(17_000) });
    });

    it("is rate-limited until the latest reset of the limits with nothing left", () => {
      expect(
        outcomeOf(
          answer(429, {
            "anthropic-ratelimit-requests-remaining": "12",
            "anthropic-ratelimit-requests-reset": "2026-10-09T12:00:05Z",
            "anthropic-ratelimit-input-tokens-remaining": "0",
            "anthropic-ratelimit-input-tokens-reset": "2026-10-09T12:00:40Z",
            "anthropic-ratelimit-output-tokens-remaining": "0",
            "anthropic-ratelimit-output-tokens-reset": "2026-10-09T12:00:30Z",
          }),
          now,
        ),
      ).toEqual({ kind: "rate_limited", until: later(40_000) });
    });

    it("is rate-limited until a subscription's unified reset", () => {
      // Seconds since the epoch: 14:00 UTC.
      expect(
        outcomeOf(
          answer(429, {
            "retry-after": "60",
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": "1791554400",
          }),
          now,
        ),
      ).toEqual({
        kind: "rate_limited",
        until: new Date("2026-10-09T14:00:00.000Z"),
      });
    });

    it("ignores a window that is still allowed", () => {
      expect(
        outcomeOf(
          answer(429, {
            "anthropic-ratelimit-unified-5h-status": "allowed",
            "anthropic-ratelimit-unified-5h-reset": "1791554400",
          }),
          now,
        ),
      ).toEqual({ kind: "rate_limited", until: later(defaultRateLimitMs) });
    });

    it("is overloaded on a 529, or an overloaded_error whatever its status", () => {
      expect(
        outcomeOf(
          answer(529, {}, { error: { type: "overloaded_error" } }),
          now,
        ),
      ).toEqual({ kind: "overloaded", until: later(defaultOverloadMs) });
      expect(
        outcomeOf(
          answer(
            500,
            { "retry-after": "5" },
            { error: { type: "overloaded_error" } },
          ),
          now,
        ),
      ).toEqual({ kind: "overloaded", until: later(5000) });
    });
  });

  describe("OpenAI-compatible APIs", () => {
    it("are rate-limited until the reset of the exhausted limit", () => {
      expect(
        outcomeOf(
          answer(
            429,
            {
              "x-ratelimit-remaining-requests": "0",
              "x-ratelimit-reset-requests": "1m30s",
              "x-ratelimit-remaining-tokens": "5000",
              "x-ratelimit-reset-tokens": "6m0s",
            },
            {
              error: {
                message: "Rate limit reached.",
                type: "requests",
                code: "rate_limit_exceeded",
              },
            },
          ),
          now,
        ),
      ).toEqual({ kind: "rate_limited", until: later(90_000) });
    });

    it("take retry-after-ms", () => {
      expect(outcomeOf(answer(429, { "retry-after-ms": "2500" }), now)).toEqual(
        { kind: "rate_limited", until: later(2500) },
      );
    });

    it("take retry-after as an HTTP date", () => {
      expect(
        outcomeOf(
          answer(429, { "retry-after": "Fri, 09 Oct 2026 12:02:00 GMT" }),
          now,
        ),
      ).toEqual({ kind: "rate_limited", until: later(120_000) });
    });
  });

  describe("Google (Gemini)", () => {
    it("is rate-limited until RetryInfo's delay, from a list of errors too", () => {
      const error = {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
          details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure" },
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "23s",
            },
          ],
        },
      };
      expect(outcomeOf(answer(429, {}, error), now)).toEqual({
        kind: "rate_limited",
        until: later(23_000),
      });
      expect(outcomeOf(answer(429, {}, [error]), now)).toEqual({
        kind: "rate_limited",
        until: later(23_000),
      });
    });

    it("is overloaded on 503 UNAVAILABLE", () => {
      expect(
        outcomeOf(
          answer(
            503,
            {},
            {
              error: {
                code: 503,
                message: "The model is overloaded. Please try again later.",
                status: "UNAVAILABLE",
              },
            },
          ),
          now,
        ),
      ).toEqual({ kind: "overloaded", until: later(defaultOverloadMs) });
    });
  });

  describe("Kimi, Z.ai and DeepSeek", () => {
    it("are overloaded on Kimi's 429 engine_overloaded_error, until retry-after", () => {
      expect(
        outcomeOf(
          answer(
            429,
            { "retry-after": "5" },
            {
              error: {
                message: "The engine is currently overloaded",
                type: "engine_overloaded_error",
              },
            },
          ),
          now,
        ),
      ).toEqual({ kind: "overloaded", until: later(5000) });
    });

    it("are overloaded on Z.ai's 429 with business code 1305, rate-limited on its 1302", () => {
      const zai = (code: string) =>
        answer(429, {}, { error: { code, message: "…" } });
      expect(outcomeOf(zai("1305"), now)).toEqual({
        kind: "overloaded",
        until: later(defaultOverloadMs),
      });
      expect(outcomeOf(zai("1302"), now)).toEqual({
        kind: "rate_limited",
        until: later(defaultRateLimitMs),
      });
      // Code 1305 means nothing in another status.
      expect(
        outcomeOf(answer(400, {}, { error: { code: "1305" } }), now),
      ).toEqual({ kind: "refused" });
    });

    it("are overloaded on DeepSeek's 503 Server Overloaded", () => {
      expect(
        outcomeOf(
          answer(
            503,
            {},
            {
              error: {
                message: "Server overloaded, please try again later.",
                type: "server_error",
              },
            },
          ),
          now,
        ),
      ).toEqual({ kind: "overloaded", until: later(defaultOverloadMs) });
    });

    it("are rate-limited on Kimi's 429 rate_limit_reached_error", () => {
      expect(
        outcomeOf(
          answer(
            429,
            { "retry-after": "20" },
            { error: { type: "rate_limit_reached_error", message: "…" } },
          ),
          now,
        ),
      ).toEqual({ kind: "rate_limited", until: later(20_000) });
    });
  });

  describe("ChatGPT's Codex backend", () => {
    it("is rate-limited until its usage limit resets", () => {
      const error = (fields: Record<string, unknown>) => ({
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          ...fields,
        },
      });
      expect(
        outcomeOf(answer(429, {}, error({ resets_in_seconds: 1800 })), now),
      ).toEqual({ kind: "rate_limited", until: later(1_800_000) });
      expect(
        outcomeOf(
          answer(429, {}, error({ resets_at: now.getTime() / 1000 + 3600 })),
          now,
        ),
      ).toEqual({ kind: "rate_limited", until: later(3_600_000) });
    });
  });

  it("waits the default when nothing says how long, and never past eight days", () => {
    expect(outcomeOf(answer(429, {}, "not json"), now)).toEqual({
      kind: "rate_limited",
      until: later(defaultRateLimitMs),
    });
    expect(outcomeOf(answer(429, { "retry-after": "99999999" }), now)).toEqual({
      kind: "rate_limited",
      until: later(8 * 24 * 60 * 60 * 1000),
    });
  });
});
