import { describe, expect, it } from "vitest";

import {
  currencyCodes,
  currencySettingsSchema,
  defaultCurrencySettings,
  usdRate,
} from "./currency.ts";

describe("the office's currency", () => {
  it("is British pounds, at the day's rate, until set", () => {
    expect(defaultCurrencySettings).toEqual({
      currency: "GBP",
      manualRate: null,
    });
  });

  it("is any of the world's currencies, each once", () => {
    expect(new Set(currencyCodes).size).toBe(currencyCodes.length);
    for (const code of ["GBP", "USD", "EUR", "JPY", "INR", "ZAR"]) {
      expect(currencyCodes).toContain(code);
    }
    // Every one is a currency the browser can show.
    for (const code of currencyCodes) {
      expect(() =>
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: code,
        }).format(1),
      ).not.toThrow();
    }
  });

  it("refuses a currency not in the list, and a rate of 0 or less", () => {
    expect(
      currencySettingsSchema.safeParse({ currency: "XYZ", manualRate: null })
        .success,
    ).toBe(false);
    expect(
      currencySettingsSchema.safeParse({ currency: "EUR", manualRate: 0 })
        .success,
    ).toBe(false);
    expect(
      currencySettingsSchema.safeParse({ currency: "EUR", manualRate: 0.92 })
        .data,
    ).toEqual({ currency: "EUR", manualRate: 0.92 });
  });
});

describe("usdRate", () => {
  const rates = { USD: 1, GBP: 0.79, EUR: 0.92 };

  it("is the day's rate for the currency", () => {
    expect(usdRate({ currency: "GBP", manualRate: null, rates })).toBe(0.79);
  });

  it("is the Owner's own rate when they give one", () => {
    expect(usdRate({ currency: "GBP", manualRate: 0.8, rates })).toBe(0.8);
    expect(usdRate({ currency: "GBP", manualRate: 0.8, rates: null })).toBe(
      0.8,
    );
  });

  it("is 1 for US dollars, rates or not", () => {
    expect(usdRate({ currency: "USD", manualRate: null, rates: null })).toBe(1);
  });

  it("is unknown without a rate", () => {
    expect(
      usdRate({ currency: "GBP", manualRate: null, rates: null }),
    ).toBeUndefined();
    expect(
      usdRate({ currency: "KPW", manualRate: null, rates }),
    ).toBeUndefined();
  });
});
