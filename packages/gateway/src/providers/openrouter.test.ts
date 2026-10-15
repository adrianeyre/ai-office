// Contract tests for OpenRouter AI Accounts (PRD FR-35): its fixtures, in
// `fixtures/openrouter/`, replayed through a real Gateway serving from a
// real OpenRouter API key, as `api-key-contract.ts` describes. OpenRouter's
// API is at `/api/v1`; it names every vendor's Models `vendor/model`,
// counts prompt tokens written to the cache apart, publishes its prices
// through its Models list (FR-43), and is out of credit with a 402. It
// also answers Jev's typed questions, the Decision Model's (FR-17).
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { describe } from "vitest";

import { readFixture } from "../fixtures.ts";
import { createPricing, openRouterPrices } from "../pricing/pricing.ts";
import { memoryModelPriceStore } from "../pricing/store.ts";
import { describeApiKeyContract } from "./api-key-contract.ts";

const models = await readFixture(
  fileURLToPath(
    new URL("../../fixtures/models/openrouter.json", import.meta.url),
  ),
);

/** OpenRouter's published prices, from its Models list, and no table. */
async function publishedPricing() {
  const pricing = createPricing({
    table: {},
    store: memoryModelPriceStore(),
    sources: () => [
      openRouterPrices({
        fetch: () =>
          Promise.resolve(
            new Response(models.response.body, {
              headers: { "content-type": "application/json" },
            }),
          ),
      }),
    ],
    events: createEventBus({ store: memoryEventStore() }),
  });
  await pricing.refresh();
  return pricing;
}

describe("OpenRouter", () => {
  describeApiKeyContract({
    aiProvider: "OpenRouter",
    folder: "openrouter",
    keys: [
      "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
      "sk-or-v1-fedcba9876543210fedcba9876543210fedcba9876543210fedcba98",
    ],
    apiPath: "/api/v1",
    pricing: publishedPricing,
    expectations: {
      "chat-completions.json": {
        endpoint: "chat_completions",
        streamed: false,
        status: 200,
        inputTokens: 200,
        outputTokens: 14,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 0,
        // At OpenRouter's published prices for anthropic/claude-sonnet-4.5:
        // 200 × $3 + 14 × $15 + 1000 × $0.30, per million.
        estimatedCostUsd: 0.00111,
      },
      "chat-completions-streaming.json": {
        endpoint: "chat_completions",
        streamed: true,
        status: 200,
        // 40 prompt tokens, 32 of them written to the cache.
        inputTokens: 8,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 32,
        // Its Models list does not price anthropic/claude-haiku-4.5.
        estimatedCostUsd: null,
      },
      "responses.json": {
        endpoint: "responses",
        streamed: false,
        status: 200,
        inputTokens: 12,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: null,
      },
      // Jev's typed questions, for the Decision Model (FR-17). Its Models
      // list leaves Jev out, so it has no published price.
      "systemone.json": {
        endpoint: "systemone",
        streamed: false,
        status: 200,
        inputTokens: 412,
        outputTokens: 38,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: null,
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
      "chat-completions-no-credits.json": {
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
    attempts: { "chat-completions-no-credits.json": 3 },
    failures: [
      {
        fixture: "chat-completions-rate-limited.json",
        reason: "rate_limited",
        seconds: 12,
      },
      { fixture: "chat-completions-no-credits.json", reason: null },
    ],
    servesResponses: true,
  });
});
