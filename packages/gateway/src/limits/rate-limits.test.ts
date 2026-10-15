import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readFixture } from "../fixtures.ts";
import { rateLimitsOf } from "./rate-limits.ts";

// An API key's per-minute rate limits from its answers' headers (FR-36),
// read from the fixtures each AI Provider's answers are replayed from.

const headersOf = async (path: string) =>
  new Headers(
    (
      await readFixture(
        fileURLToPath(new URL(`../../fixtures/${path}`, import.meta.url)),
      )
    ).response.headers,
  );

const now = new Date("2026-10-09T12:00:00.000Z");

describe("rateLimitsOf", () => {
  it("reads Anthropic's requests, input and output tokens, each with its RFC 3339 reset", async () => {
    expect(
      rateLimitsOf(await headersOf("limits/anthropic-rate-limited.json"), now),
    ).toEqual({
      requests: {
        limit: 50,
        remaining: 31,
        resetsAt: new Date("2026-10-09T12:00:02Z"),
      },
      inputTokens: {
        limit: 30_000,
        remaining: 0,
        resetsAt: new Date("2026-10-09T12:01:00Z"),
      },
      outputTokens: {
        limit: 8000,
        remaining: 7200,
        resetsAt: new Date("2026-10-09T12:00:01Z"),
      },
    });
  });

  it("reads Anthropic's combined tokens limit, the most restrictive in force", () => {
    expect(
      rateLimitsOf(
        new Headers({
          "anthropic-ratelimit-tokens-limit": "450000",
          "anthropic-ratelimit-tokens-remaining": "449000",
          "anthropic-ratelimit-tokens-reset": "2026-10-09T12:00:30Z",
        }),
        now,
      ),
    ).toEqual({
      tokens: {
        limit: 450_000,
        remaining: 449_000,
        resetsAt: new Date("2026-10-09T12:00:30Z"),
      },
    });
  });

  it("leaves out a limit that gives no limit: a served answer with what remains only", async () => {
    expect(
      rateLimitsOf(await headersOf("limits/anthropic-served.json"), now),
    ).toEqual({});
  });

  it("reads xAI's OpenAI-style requests and tokens, with no reset when none is given", async () => {
    expect(
      rateLimitsOf(await headersOf("xai/chat-completions.json"), now),
    ).toEqual({
      requests: { limit: 480, remaining: 479, resetsAt: undefined },
      tokens: { limit: 2_000_000, remaining: 1_999_640, resetsAt: undefined },
    });
  });

  it("reads OpenAI-style resets as durations from now", async () => {
    expect(
      rateLimitsOf(
        await headersOf("xai/chat-completions-rate-limited.json"),
        now,
      ),
    ).toEqual({
      requests: {
        limit: 480,
        remaining: 0,
        resetsAt: new Date("2026-10-09T12:00:45.000Z"),
      },
      tokens: {
        limit: 2_000_000,
        remaining: 1_200_000,
        resetsAt: new Date("2026-10-09T12:00:02.000Z"),
      },
    });
    expect(
      rateLimitsOf(
        new Headers({
          "x-ratelimit-limit-tokens": "150000",
          "x-ratelimit-remaining-tokens": "149984",
          "x-ratelimit-reset-tokens": "6m0s",
        }),
        now,
      ).tokens?.resetsAt,
    ).toEqual(new Date("2026-10-09T12:06:00.000Z"));
  });

  it("reports nothing for AI Providers that send no rate-limit headers", async () => {
    for (const path of [
      "deepseek/chat-completions.json",
      "kimi/chat-completions.json",
      "zai/chat-completions.json",
      "minimax/chat-completions.json",
      "openrouter/chat-completions.json",
      "gemini/chat-completions.json",
    ]) {
      expect(rateLimitsOf(await headersOf(path), now), path).toEqual({});
    }
    expect(
      rateLimitsOf(
        new Headers({
          "x-ratelimit-limit-requests": "many",
          "x-ratelimit-remaining-requests": "12",
        }),
        now,
      ),
    ).toEqual({});
  });
});
