// Contract tests for Ollama Cloud AI Accounts (PRD FR-35): its fixtures,
// in `fixtures/ollama-cloud/`, replayed through a real Gateway serving
// from a real Ollama Cloud API key, as `api-key-contract.ts` describes.
// ollama.com's OpenAI-compatible API is at `/v1`, with the key as a bearer
// token. Its Models are named `model:tag`, and are paid for by plan, not by
// token, so none has a price. Its usage limits are a `429` (held back for
// the default minute, as it gives no `retry-after`), and a `502` a failure.
import { describe } from "vitest";

import { describeApiKeyContract } from "./api-key-contract.ts";

const unpriced = {
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  estimatedCostUsd: null,
} as const;
const unanswered = {
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  estimatedCostUsd: null,
} as const;

describe("Ollama Cloud", () => {
  describeApiKeyContract({
    aiProvider: "Ollama",
    folder: "ollama-cloud",
    keys: [
      "0f1e2d3c4b5a69788796a5b4c3d2e1f0.ollamaCloudKeyOne0123456789",
      "a1b2c3d4e5f60718293a4b5c6d7e8f90.ollamaCloudKeyTwo0123456789",
    ],
    apiPath: "/v1",
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        inputTokens: 72,
        outputTokens: 18,
        ...unpriced,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        inputTokens: 15,
        outputTokens: 4,
        ...unpriced,
      },
      "chat-completions-rate-limited.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 429,
        ...unanswered,
      },
      "chat-completions-unavailable.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 502,
        ...unanswered,
      },
    },
    attempts: { "chat-completions-unavailable.json": 3 },
    failures: [
      {
        fixture: "chat-completions-rate-limited.json",
        reason: "rate_limited",
        seconds: 60,
      },
      { fixture: "chat-completions-unavailable.json", reason: null },
    ],
    servesResponses: false,
  });
});
