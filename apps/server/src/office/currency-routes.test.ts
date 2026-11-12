import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { memoryStores } from "@ai-office/orchestrator";
import { currencyResponseSchema } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";
import type { ExchangeRates } from "./exchange-rates.ts";

// The currency costs are shown in (General Settings): British pounds until
// the Owner chooses another, with the day's exchange rates.

async function setUp(exchangeRates?: ExchangeRates) {
  const bus = createEventBus({ store: memoryEventStore() });
  const server = await buildApp({
    logger: createLogger({
      level: "silent",
      secrets: [],
      destination: { write: () => undefined },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores: memoryStores(),
    github: createFakeGitHub(),
    ...(exchangeRates === undefined ? {} : { exchangeRates }),
  });
  const owner = await signIn(server);
  const call = (method: "GET" | "PUT", payload?: object) =>
    server.inject({
      method,
      url: "/api/office/currency",
      headers: owner.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  return { server, bus, call };
}

const rates: ExchangeRates = {
  current: () =>
    Promise.resolve({
      rates: { USD: 1, GBP: 0.76, EUR: 0.86 },
      updatedAt: new Date("2026-11-12T00:00:00.000Z"),
    }),
};

describe("the office's currency", () => {
  it("is British pounds until set, with the day's rates", async () => {
    const { call } = await setUp(rates);
    const response = await call("GET");

    expect(response.statusCode).toBe(200);
    expect(currencyResponseSchema.parse(response.json())).toEqual({
      currency: "GBP",
      manualRate: null,
      rates: { USD: 1, GBP: 0.76, EUR: 0.86 },
      ratesUpdatedAt: "2026-11-12T00:00:00.000Z",
    });
  });

  it("has no rates while none could be fetched", async () => {
    const { call } = await setUp();

    expect((await call("GET")).json()).toEqual({
      currency: "GBP",
      manualRate: null,
      rates: null,
      ratesUpdatedAt: null,
    });
  });

  it("is set by the Owner, with a rate of their own if they give one, recording which changed", async () => {
    const { call, bus } = await setUp(rates);
    const set = await call("PUT", { currency: "JPY", manualRate: 150 });

    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ currency: "JPY", manualRate: 150 });
    expect((await call("GET")).json()).toMatchObject({
      currency: "JPY",
      manualRate: 150,
    });
    expect((await bus.eventsAfter(0)).map(({ event }) => event)).toContainEqual(
      {
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["currency.currency", "currency.manualRate"],
      },
    );
  });

  it("refuses a currency not in the list, or a rate that is not a positive number", async () => {
    const { call } = await setUp(rates);
    for (const payload of [
      {},
      { currency: "XYZ", manualRate: null },
      { currency: "EUR", manualRate: -1 },
      { currency: "EUR", manualRate: "0.9" },
      { currency: "EUR" },
      { currency: "EUR", manualRate: null, extra: true },
    ]) {
      const response = await call("PUT", payload);
      expect({ payload, status: response.statusCode }).toEqual({
        payload,
        status: 400,
      });
    }
  });

  it("is only the signed-in Owner's", async () => {
    const { server } = await setUp(rates);
    const response = await server.inject({
      method: "GET",
      url: "/api/office/currency",
    });

    expect(response.statusCode).toBe(401);
  });
});
