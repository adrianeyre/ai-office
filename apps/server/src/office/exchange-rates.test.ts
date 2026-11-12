import { describe, expect, it } from "vitest";

import {
  createExchangeRates,
  officeCostFormat,
  type ExchangeRates,
} from "./exchange-rates.ts";

const answer = {
  result: "success",
  time_last_update_unix: 1_762_905_600,
  rates: { USD: 1, GBP: 0.76, EUR: 0.86 },
};

const hour = 60 * 60 * 1000;
const minute = 60 * 1000;

function setUp(respond: () => Response | Promise<Response>) {
  let time = Date.UTC(2026, 10, 12, 9, 0, 0);
  const asked: string[] = [];
  const rates = createExchangeRates({
    now: () => new Date(time),
    fetch: (input) => {
      asked.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(respond());
    },
  });
  return {
    rates,
    asked,
    later: (ms: number) => {
      time += ms;
    },
  };
}

describe("the day's exchange rates", () => {
  it("are fetched when first asked for, and kept for a day", async () => {
    const { rates, asked, later } = setUp(() => Response.json(answer));

    expect(await rates.current()).toEqual({
      rates: { USD: 1, GBP: 0.76, EUR: 0.86 },
      updatedAt: new Date("2025-11-12T00:00:00.000Z"),
    });
    later(23 * hour);
    await rates.current();
    expect(asked).toEqual(["https://open.er-api.com/v6/latest/USD"]);
    later(2 * hour);
    await rates.current();
    expect(asked).toHaveLength(2);
  });

  it("are fetched once however many ask at once", async () => {
    const { rates, asked } = setUp(() => Response.json(answer));

    await Promise.all([rates.current(), rates.current(), rates.current()]);
    expect(asked).toHaveLength(1);
  });

  it("are none while they cannot be fetched, and not asked for again for ten minutes", async () => {
    const { rates, asked, later } = setUp(
      () => new Response("down", { status: 503 }),
    );

    expect(await rates.current()).toBeUndefined();
    later(9 * minute);
    expect(await rates.current()).toBeUndefined();
    expect(asked).toHaveLength(1);
    later(2 * minute);
    await rates.current();
    expect(asked).toHaveLength(2);
  });

  it("stay as last fetched when a later fetch fails", async () => {
    let up = true;
    const { rates, later } = setUp(() =>
      up ? Response.json(answer) : Response.json({ result: "error" }),
    );

    await rates.current();
    up = false;
    later(25 * hour);
    expect((await rates.current())?.rates["GBP"]).toBe(0.76);
  });
});

describe("costs the server writes itself", () => {
  const table: ExchangeRates = {
    current: () =>
      Promise.resolve({ rates: { USD: 1, GBP: 0.75 }, updatedAt: new Date() }),
  };

  it("are in the office's currency at the day's rate", async () => {
    const format = await officeCostFormat(
      () => Promise.resolve({ currency: "GBP", manualRate: null }),
      table,
    )();
    expect(format(2)).toBe("£1.50");
  });

  it("are at the Owner's own rate when they give one", async () => {
    const format = await officeCostFormat(
      () => Promise.resolve({ currency: "GBP", manualRate: 0.5 }),
      table,
    )();
    expect(format(2)).toBe("£1.00");
  });

  it("are in US dollars while the rate is not known", async () => {
    const format = await officeCostFormat(
      () => Promise.resolve({ currency: "EUR", manualRate: null }),
      table,
    )();
    expect(format(2)).toBe("$2.00");
  });
});
