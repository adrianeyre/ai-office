// Contract tests for the Owner's own Ollama server (PRD FR-35): its
// fixtures, in `fixtures/ollama/`, replayed through a real Gateway serving
// from a real Ollama endpoint added without a key, as `api-key-contract.ts`
// describes. Ollama's OpenAI-compatible API is at `/v1`, and it is sent no
// credential at all. Its Models are named `model:tag`, and cost nothing:
// none is in the pricing table. A Model it has not pulled is a `404`, the
// request's fault; a runner that dies is a `500`, a failure.
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

describe("Ollama", () => {
  describeApiKeyContract({
    aiProvider: "Ollama",
    accountType: "endpoint",
    folder: "ollama",
    keys: null,
    apiPath: "/v1",
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        inputTokens: 26,
        outputTokens: 12,
        ...unpriced,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        inputTokens: 14,
        outputTokens: 4,
        ...unpriced,
      },
      "chat-completions-model-not-found.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 404,
        ...unanswered,
      },
      "chat-completions-runner-failed.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 500,
        ...unanswered,
      },
    },
    // A failure is tried as often as the Gateway tries.
    attempts: { "chat-completions-runner-failed.json": 3 },
    failures: [
      { fixture: "chat-completions-runner-failed.json", reason: null },
    ],
    servesResponses: false,
  });
});
