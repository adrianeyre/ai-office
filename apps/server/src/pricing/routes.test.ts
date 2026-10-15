import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createPricing,
  databaseModelPriceStore,
  memoryModelPriceStore,
  type ModelPriceStore,
} from "@ai-office/gateway";
import {
  apiErrorSchema,
  modelPriceEntrySchema,
  modelPriceListSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Model prices API (PRD FR-43): the price in use for each Model, from
// the pricing table unless the Owner overrides it, which wins. Each case
// runs in memory and in Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
}

async function setUp(store: ModelPriceStore, bus: EventBus): Promise<Setup> {
  const pricing = createPricing({
    table: {
      "claude-opus-5-5": {
        input: 4,
        output: 20,
        cacheWrite: 5,
        cacheRead: 0.2,
      },
    },
    store,
    events: bus,
    now: () => new Date("2026-10-09T12:00:00.000Z"),
  });
  await pricing.load();
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    pricing,
  });
  return { server, owner: await signIn(server), bus };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const list = async (setup: Setup) =>
  modelPriceListSchema.parse(
    (await request(setup, "GET", "/api/gateway/prices")).json(),
  ).prices;

const price = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "lists the pricing table's prices",
    async (setup) => {
      expect(await list(setup)).toEqual([
        {
          model: "claude-opus-5-5",
          price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
          source: "table",
          standard: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
          updatedAt: null,
        },
      ]);
    },
  ],
  [
    "overrides a Model's price, then goes back to the table's",
    async (setup) => {
      const set = await request(
        setup,
        "PUT",
        "/api/gateway/prices/claude-opus-5-5",
        price,
      );
      expect(set.statusCode).toBe(200);
      expect(modelPriceEntrySchema.parse(set.json())).toEqual({
        model: "claude-opus-5-5",
        price,
        source: "override",
        standard: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
        updatedAt: "2026-10-09T12:00:00.000Z",
      });
      expect((await list(setup))[0]?.source).toBe("override");

      const cleared = await request(
        setup,
        "DELETE",
        "/api/gateway/prices/claude-opus-5-5",
      );
      expect(cleared.statusCode).toBe(204);
      expect((await list(setup))[0]?.source).toBe("table");
      const again = await request(
        setup,
        "DELETE",
        "/api/gateway/prices/claude-opus-5-5",
      );
      expect(again.statusCode).toBe(404);
      expect(apiErrorSchema.parse(again.json()).error).toBe(
        "no_price_override",
      );
      const keys = (await setup.bus.eventsAfter(0)).flatMap(({ event }) =>
        event.type === "config.changed" ? [event.keys] : [],
      );
      expect(keys).toEqual([
        ["modelPrices.claude-opus-5-5"],
        ["modelPrices.claude-opus-5-5"],
      ]);
    },
  ],
  [
    "prices a Model with a slash in its name",
    async (setup) => {
      const set = await request(
        setup,
        "PUT",
        `/api/gateway/prices/${encodeURIComponent("openai/gpt-5.5")}`,
        price,
      );
      expect(set.statusCode).toBe(200);
      expect((await list(setup)).map(({ model }) => model)).toEqual([
        "claude-opus-5-5",
        "openai/gpt-5.5",
      ]);
    },
  ],
  [
    "refuses a price that is not four amounts of dollars",
    async (setup) => {
      for (const body of [
        { ...price, input: -1 },
        { input: 1, output: 2 },
        { ...price, extra: 1 },
        { ...price, output: "10" },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/gateway/prices/claude-opus-5-5",
          body,
        );
        expect(response.statusCode).toBe(400);
      }
      expect((await list(setup))[0]?.source).toBe("table");
    },
  ],
];

describe("the Model prices API, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const setup = await setUp(
        memoryModelPriceStore(),
        createEventBus({ store: memoryEventStore() }),
      );
      await run(setup);
      await setup.server.close();
    });
  }
});

describe("the Model prices API, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseModelPriceStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      await run(setup);
      await setup.server.close();
    });
  }
});
