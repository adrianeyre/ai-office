// Contract tests for OpenAI-compatible endpoints (PRD FR-35): its
// fixtures, in `fixtures/openai-compatible/`, replayed through a real
// Gateway serving from a real endpoint whose URL the Owner gave with its
// own path (`…/openai/v1`, as OPENAI_BASE_URL is given), as
// `api-key-contract.ts` describes. Requests go after that path, with the
// key as a bearer token. It is sent any Model asked of it: its Models
// (here `llama-3.3-70b-versatile`) are named as its owner likes, and none
// has a price. A `429` holds it back for its `retry-after`; a `502` is a
// failure.
import { describe } from "vitest";

import { describeApiKeyContract } from "./api-key-contract.ts";

const unanswered = {
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  estimatedCostUsd: null,
} as const;

describe("OpenAI-compatible endpoints", () => {
  describeApiKeyContract({
    aiProvider: "OpenAI-compatible",
    accountType: "endpoint",
    folder: "openai-compatible",
    keys: [
      "sk-endpoint-0123456789abcdef0123456789abcdef",
      "sk-endpoint-fedcba9876543210fedcba9876543210",
    ],
    endpointPath: "/openai/v1",
    apiPath: "/openai/v1",
    anyModel: true,
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        // 2048 prompt tokens, 1024 read from the cache.
        inputTokens: 1024,
        outputTokens: 64,
        cacheReadInputTokens: 1024,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: null,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        inputTokens: 16,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: null,
      },
      "responses.json": {
        endpoint: "responses",
        streamed: false,
        status: 200,
        inputTokens: 22,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: null,
      },
      "chat-completions-rate-limited.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 429,
        ...unanswered,
      },
      "chat-completions-bad-gateway.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 502,
        ...unanswered,
      },
    },
    attempts: { "chat-completions-bad-gateway.json": 3 },
    failures: [
      {
        fixture: "chat-completions-rate-limited.json",
        reason: "rate_limited",
        seconds: 7,
      },
      { fixture: "chat-completions-bad-gateway.json", reason: null },
    ],
    servesResponses: true,
  });
});
