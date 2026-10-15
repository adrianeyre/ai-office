// Contract tests for Kimi AI Accounts (PRD FR-35): its fixtures, in
// `fixtures/kimi/`, replayed through a real Gateway serving from a real
// Kimi (Moonshot AI) API key, as `api-key-contract.ts` describes. Kimi's
// API is at `/v1`; it counts the prompt tokens written to its cache apart
// (`cache_write_tokens`), and says it is rate-limited or overloaded with a
// 429 and a `retry-after`.
import { describe } from "vitest";

import { describeApiKeyContract } from "./api-key-contract.ts";

describe("Kimi", () => {
  describeApiKeyContract({
    aiProvider: "Kimi",
    folder: "kimi",
    keys: [
      "sk-kimi0123456789abcdef0123456789abcdef0123456789",
      "sk-kimifedcba9876543210fedcba9876543210fedcba98",
    ],
    apiPath: "/v1",
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        // 2048 prompt tokens: 1536 read from the cache, 256 written to it.
        inputTokens: 256,
        outputTokens: 64,
        cacheReadInputTokens: 1536,
        cacheCreationInputTokens: 256,
        // 256 × $3 + 64 × $15 + 1536 × $0.30 + 256 × $3, per million.
        estimatedCostUsd: 0.0029568,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        inputTokens: 16,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: 0.0000312,
      },
      "responses.json": {
        endpoint: "responses",
        streamed: false,
        status: 200,
        inputTokens: 22,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: 0.000141,
      },
      "chat-completions-rate-limited.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 429,
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        estimatedCostUsd: null,
      },
      "chat-completions-overloaded.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 429,
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        estimatedCostUsd: null,
      },
    },
    failures: [
      // Each for its retry-after.
      {
        fixture: "chat-completions-rate-limited.json",
        reason: "rate_limited",
        seconds: 20,
      },
      {
        fixture: "chat-completions-overloaded.json",
        reason: "overloaded",
        seconds: 5,
      },
    ],
    servesResponses: true,
  });
});
