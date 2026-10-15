// Contract tests for Minimax AI Accounts (PRD FR-35): its fixtures, in
// `fixtures/minimax/`, replayed through a real Gateway serving from a real
// MiniMax API key, as `api-key-contract.ts` describes. MiniMax's API is at
// `/v1`, and writes its errors as Anthropic does
// (`{"type":"error","error":{"type":"rate_limit_error"}}`).
import { describe } from "vitest";

import { describeApiKeyContract } from "./api-key-contract.ts";

describe("Minimax", () => {
  describeApiKeyContract({
    aiProvider: "Minimax",
    folder: "minimax",
    keys: [
      "eyJhbGciOiJSUzI1NiJ9.eyJHcm91cE5hbWUiOiJvd25lciJ9.c2lnbmF0dXJlMDE",
      "eyJhbGciOiJSUzI1NiJ9.eyJHcm91cE5hbWUiOiJzcGFyZSJ9.c2lnbmF0dXJlMDI",
    ],
    apiPath: "/v1",
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        inputTokens: 138,
        outputTokens: 12,
        cacheReadInputTokens: 512,
        cacheCreationInputTokens: 0,
        // 138 × $0.30 + 12 × $1.20 + 512 × $0.06, per million.
        estimatedCostUsd: 0.00008652,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        inputTokens: 17,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: 0.0000099,
      },
      "responses.json": {
        endpoint: "responses",
        streamed: false,
        status: 200,
        inputTokens: 26,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: 0.0000138,
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
    },
    failures: [
      {
        fixture: "chat-completions-rate-limited.json",
        reason: "rate_limited",
        seconds: 60,
      },
    ],
    servesResponses: true,
  });
});
