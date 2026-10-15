// Contract tests for Z.ai AI Accounts (PRD FR-35): its fixtures, in
// `fixtures/zai/`, replayed through a real Gateway serving from a real
// Z.ai API key, as `api-key-contract.ts` describes. Z.ai's API is at
// `/api/paas/v4`, has no Responses, and says it is rate-limited (business
// code 1302) or overloaded (1305) with a 429.
import { describe } from "vitest";

import { describeApiKeyContract } from "./api-key-contract.ts";

describe("Z.ai", () => {
  describeApiKeyContract({
    aiProvider: "Z.ai",
    folder: "zai",
    keys: [
      "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp",
      "fedcba9876543210fedcba9876543210.QrStUvWxYzAbCdEf",
    ],
    apiPath: "/api/paas/v4",
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        inputTokens: 160,
        outputTokens: 40,
        cacheReadInputTokens: 640,
        cacheCreationInputTokens: 0,
        // 160 × $1.40 + 40 × $4.40 + 640 × $0.26, per million.
        estimatedCostUsd: 0.0005664,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        inputTokens: 18,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: 0.0000047,
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
      // Z.ai gives no time: the defaults.
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
    ],
    servesResponses: false,
  });
});
