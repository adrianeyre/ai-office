// Contract tests for DeepSeek AI Accounts (PRD FR-35): its fixtures, in
// `fixtures/deepseek/`, replayed through a real Gateway serving from a real
// DeepSeek API key, as `api-key-contract.ts` describes. DeepSeek's API
// has no `/v1` in its paths; it counts cache hits apart, prices them at
// its pricing-table prices, and is overloaded with a 503 and out of
// credit with a 402.
import { describe } from "vitest";

import { describeApiKeyContract } from "./api-key-contract.ts";

describe("DeepSeek", () => {
  describeApiKeyContract({
    aiProvider: "DeepSeek",
    folder: "deepseek",
    keys: [
      "sk-0123456789abcdef0123456789abcdef",
      "sk-fedcba9876543210fedcba9876543210",
    ],
    apiPath: "",
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        // 1500 prompt tokens, 1024 of them cache hits.
        inputTokens: 476,
        outputTokens: 120,
        cacheReadInputTokens: 1024,
        cacheCreationInputTokens: 0,
        // 476 × $1.32 + 120 × $3.96 + 1024 × $0.044, per million.
        estimatedCostUsd: 0.00114858,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        inputTokens: 20,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        // 20 × $0.30 + 5 × $1.20, per million.
        estimatedCostUsd: 0.000012,
      },
      "responses.json": {
        endpoint: "responses",
        streamed: false,
        status: 200,
        inputTokens: 30,
        outputTokens: 6,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: 0.0000162,
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
        status: 503,
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        estimatedCostUsd: null,
      },
      "chat-completions-insufficient-balance.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 402,
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        estimatedCostUsd: null,
      },
    },
    // Out of credit: a failure, tried again, as the only account.
    attempts: { "chat-completions-insufficient-balance.json": 3 },
    failures: [
      // DeepSeek gives no time: the defaults.
      {
        fixture: "chat-completions-rate-limited.json",
        reason: "rate_limited",
        seconds: 60,
      },
      {
        fixture: "chat-completions-overloaded.json",
        reason: "overloaded",
        seconds: 30,
      },
      { fixture: "chat-completions-insufficient-balance.json", reason: null },
    ],
    servesResponses: true,
  });
});
