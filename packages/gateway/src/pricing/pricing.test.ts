import { readFileSync } from "node:fs";

import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { aiAccountKindOf, type ModelPrice } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
} from "../test-support.ts";
import type { Usage } from "../usage.ts";
import {
  createPricing,
  estimateCost,
  openRouterPrices,
  PricingError,
  pricingTablePath,
  readPricingTable,
  type PublishedPrices,
} from "./pricing.ts";
import {
  databaseModelPriceStore,
  memoryModelPriceStore,
  type ModelPriceStore,
} from "./store.ts";

// Model prices and cost estimates (PRD FR-43): each token type at its own
// price, and the Owner's override over a published price over the pricing
// table. Every case with a store runs in memory and in Postgres 18.

const opus: ModelPrice = {
  input: 4,
  output: 20,
  cacheWrite: 5,
  cacheRead: 0.2,
};
const usage = (counts: Partial<Usage>): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  ...counts,
});

describe("estimating a cost", () => {
  it("prices each token type at its own price", () => {
    const million = 1_000_000;
    expect(estimateCost(opus, usage({ inputTokens: million }))).toBe(4);
    expect(estimateCost(opus, usage({ outputTokens: million }))).toBe(20);
    expect(
      estimateCost(opus, usage({ cacheCreationInputTokens: million })),
    ).toBe(5);
    expect(estimateCost(opus, usage({ cacheReadInputTokens: million }))).toBe(
      0.2,
    );
    // 120 in, 64 out, 2048 read, 10 written: 0.00048 + 0.00128 + 0.0004096
    // + 0.00005.
    expect(
      estimateCost(
        opus,
        usage({
          inputTokens: 120,
          outputTokens: 64,
          cacheReadInputTokens: 2048,
          cacheCreationInputTokens: 10,
        }),
      ),
    ).toBe(0.0022196);
  });

  it("is null when nothing was counted, and counts a missing type as none", () => {
    expect(estimateCost(opus, usage({}))).toBeNull();
    expect(estimateCost(opus, usage({ outputTokens: 0 }))).toBe(0);
    expect(estimateCost(opus, usage({ inputTokens: 500 }))).toBe(0.002);
  });
});

describe("the pricing table", () => {
  it("is valid, in dollars per million tokens, with every token type", () => {
    const table = readPricingTable();
    const raw = JSON.parse(readFileSync(pricingTablePath, "utf8")) as {
      currency: string;
      unit: string;
    };
    expect(raw).toMatchObject({ currency: "USD", unit: "per million tokens" });
    expect(Object.keys(table)).toEqual(
      expect.arrayContaining([
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-fable-5-1",
      ]),
    );
    expect(table["claude-opus-5-5"]).toEqual(opus);
    for (const price of Object.values(table)) {
      expect(Object.keys(price).sort()).toEqual(
        ["cacheRead", "cacheWrite", "input", "output"].sort(),
      );
      // Cache reads cost less than input, and writes at least as much.
      expect(price.cacheRead).toBeLessThan(price.input);
      expect(price.cacheWrite).toBeGreaterThanOrEqual(price.input);
    }
  });

  it("prices DeepSeek's, Z.ai's, Minimax's and Kimi's Models, and every one Z.ai documents", () => {
    const table = readPricingTable();
    expect(Object.keys(table)).toEqual(
      expect.arrayContaining([
        "deepseek-flash",
        "deepseek-v4-pro",
        "glm-5.3",
        "MiniMax-M3",
        "MiniMax-M2.7",
        "kimi-k3",
        "kimi-k2.7-code",
      ]),
    );
    expect(table["deepseek-v4-pro"]).toEqual({
      input: 1.32,
      output: 3.96,
      cacheWrite: 1.32,
      cacheRead: 0.044,
    });
    expect(table["kimi-k3"]).toEqual({
      input: 3,
      output: 15,
      cacheWrite: 3,
      cacheRead: 0.3,
    });
    const zai = aiAccountKindOf({ aiProvider: "Z.ai", accountType: "api_key" });
    const documented =
      zai !== undefined && "documentedModels" in zai
        ? zai.documentedModels
        : [];
    expect(documented).not.toHaveLength(0);
    for (const { model } of documented) {
      expect(table[model], model).toBeDefined();
    }
  });
});

interface Setup {
  readonly store: ModelPriceStore;
  readonly bus: EventBus;
  readonly sources: PublishedPrices[];
  readonly pricing: () => ReturnType<typeof createPricing>;
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const table = {
  "claude-opus-5-5": opus,
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
  },
};

const source = (
  name: string,
  prices: () => Promise<Record<string, ModelPrice>>,
): PublishedPrices => ({ name, fetchPrices: prices });

const setUp = (store: ModelPriceStore, bus: EventBus): Setup => {
  const sources: PublishedPrices[] = [];
  return {
    store,
    bus,
    sources,
    pricing: () =>
      createPricing({
        table,
        store,
        sources: () => sources,
        events: bus,
        now: () => new Date("2026-10-09T12:00:00.000Z"),
      }),
  };
};

const million = usage({ inputTokens: 1_000_000 });

const cases: Case[] = [
  [
    "uses the pricing table, and knows no price for other Models",
    async ({ pricing }) => {
      const prices = pricing();
      await prices.load();
      expect(prices.estimate("claude-opus-5-5", million)).toBe(4);
      expect(prices.estimate("gpt-5.5", million)).toBeNull();
      expect(prices.estimate(null, million)).toBeNull();
      expect(prices.list().map(({ model, source }) => [model, source])).toEqual(
        [
          ["claude-haiku-5-5", "table"],
          ["claude-opus-5-5", "table"],
        ],
      );
    },
  ],
  [
    "lets the Owner's override win over the table and published prices",
    async (setup) => {
      setup.sources.push(
        source("Published", () =>
          Promise.resolve({ "claude-opus-5-5": { ...opus, input: 3 } }),
        ),
      );
      const prices = setup.pricing();
      await prices.load();
      await prices.refresh();
      expect(prices.estimate("claude-opus-5-5", million)).toBe(3);

      const set = await prices.setOverride("claude-opus-5-5", {
        ...opus,
        input: 2.5,
      });
      expect(set).toEqual({
        model: "claude-opus-5-5",
        price: { ...opus, input: 2.5 },
        source: "override",
        standard: { ...opus, input: 3 },
        updatedAt: new Date("2026-10-09T12:00:00.000Z"),
      });
      expect(prices.estimate("claude-opus-5-5", million)).toBe(2.5);
      // A refresh does not undo it.
      await prices.refresh();
      expect(prices.estimate("claude-opus-5-5", million)).toBe(2.5);

      // It survives a restart.
      const restarted = setup.pricing();
      await restarted.load();
      expect(restarted.estimate("claude-opus-5-5", million)).toBe(2.5);

      await restarted.clearOverride("claude-opus-5-5");
      expect(restarted.estimate("claude-opus-5-5", million)).toBe(3);
      await expect(
        restarted.clearOverride("claude-opus-5-5"),
      ).rejects.toBeInstanceOf(PricingError);

      const changes = (await setup.bus.eventsAfter(0)).map(
        ({ event }) => event,
      );
      expect(changes).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["modelPrices.claude-opus-5-5"],
        },
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["modelPrices.claude-opus-5-5"],
        },
      ]);
    },
  ],
  [
    "prices a Model that is in no table by the Owner's override",
    async ({ pricing }) => {
      const prices = pricing();
      await prices.load();
      await prices.setOverride("gpt-5.5", {
        input: 1.25,
        output: 10,
        cacheWrite: 1.25,
        cacheRead: 0.125,
      });
      expect(prices.estimate("gpt-5.5", usage({ outputTokens: 1000 }))).toBe(
        0.01,
      );
      expect(
        prices.list().find(({ model }) => model === "gpt-5.5"),
      ).toMatchObject({ source: "override", standard: null });
    },
  ],
  [
    "refreshes published prices, keeping a failed source's last ones",
    async (setup) => {
      let fail = false;
      setup.sources.push(
        source("Router", () =>
          fail
            ? Promise.reject(new Error("unreachable"))
            : Promise.resolve({
                "vendor/model-a": opus,
                "claude-haiku-5-5": { ...opus, input: 0.2 },
              }),
        ),
        source("Other", () =>
          Promise.resolve({ "other/model-b": { ...opus, output: 7 } }),
        ),
      );
      const prices = setup.pricing();
      await prices.load();
      expect(await prices.refresh()).toEqual({ published: 3, failed: [] });
      expect(prices.estimate("vendor/model-a", million)).toBe(4);
      expect(prices.estimate("claude-haiku-5-5", million)).toBe(0.2);

      fail = true;
      const report = await prices.refresh();
      expect(report.published).toBe(3);
      expect(report.failed.map(({ source: name }) => name)).toEqual(["Router"]);
      expect(prices.estimate("vendor/model-a", million)).toBe(4);

      // Kept in the store, for the next start.
      const restarted = setup.pricing();
      await restarted.load();
      expect(
        restarted.list().find(({ model }) => model === "other/model-b"),
      ).toMatchObject({
        source: "published",
        standard: { ...opus, output: 7 },
      });
    },
  ],
];

describe("prices kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(
        setUp(
          memoryModelPriceStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      ),
    );
  }
});

describe("prices kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(
        setUp(
          databaseModelPriceStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      ),
    );
  }
});

describe("OpenRouter's published prices", () => {
  it("reads its Models list, per token, as prices per million tokens", async () => {
    const asked: string[] = [];
    const prices = await openRouterPrices({
      url: "https://openrouter.test/api/v1/models",
      fetch: (url) => {
        asked.push(url as string);
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: "anthropic/claude-sonnet-5.5",
                name: "Claude Sonnet 5.5",
                pricing: {
                  prompt: "0.000002",
                  completion: "0.00001",
                  request: "0",
                  input_cache_read: "0.0000002",
                  input_cache_write: "0.0000025",
                },
              },
              {
                id: "openai/gpt-5.5",
                pricing: { prompt: "0.00000125", completion: "0.00001" },
              },
              {
                id: "openrouter/auto",
                pricing: { prompt: "-1", completion: "-1" },
              },
              { id: "no/pricing" },
            ],
          }),
        );
      },
    }).fetchPrices();
    expect(asked).toEqual(["https://openrouter.test/api/v1/models"]);
    expect(prices).toEqual({
      "anthropic/claude-sonnet-5.5": {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      },
      "openai/gpt-5.5": {
        input: 1.25,
        output: 10,
        cacheRead: 1.25,
        cacheWrite: 1.25,
      },
    });
  });

  it("fails when the list cannot be had", async () => {
    await expect(
      openRouterPrices({
        fetch: () => Promise.resolve(new Response("", { status: 503 })),
      }).fetchPrices(),
    ).rejects.toThrow("answered 503");
  });
});

describe("the Gateway's request records", () => {
  it("carry each request's estimated cost", async () => {
    const upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "message",
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 10_000,
            cache_creation_input_tokens: 0,
          },
        }),
      );
    });
    const requestLog = memoryRequestLog();
    const pricing = createPricing({
      table,
      store: memoryModelPriceStore(),
      events: createEventBus({ store: memoryEventStore() }),
    });
    const gateway = await startGateway({ upstream, requestLog, pricing });
    try {
      for (const model of ["claude-opus-5-5", "unknown-model"]) {
        await (
          await fetch(`${gateway.url}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": gatewayKey,
            },
            body: JSON.stringify({ model }),
          })
        ).text();
      }
      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(2);
      });
      // 1000 × $4 + 500 × $20 + 10 000 × $0.20, per million.
      expect(
        requestLog.records.map(({ model, estimatedCostUsd }) => ({
          model,
          estimatedCostUsd,
        })),
      ).toEqual([
        { model: "claude-opus-5-5", estimatedCostUsd: 0.016 },
        { model: "unknown-model", estimatedCostUsd: null },
      ]);
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });
});
