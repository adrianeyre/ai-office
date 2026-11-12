import { describe, expect, it } from "vitest";

import {
  currencyName,
  formatForeign,
  formatMoney,
  formatPrecise,
  formatTotal,
  moneyOf,
  toOfficeAmount,
  toUsdAmount,
  usDollars,
} from "./money.ts";

const rates = { USD: 1, GBP: 0.75, EUR: 0.86, JPY: 150, CNY: 7.2 };
const pounds = moneyOf({
  currency: "GBP",
  manualRate: null,
  rates,
  ratesUpdatedAt: null,
});
const yen = moneyOf({
  currency: "JPY",
  manualRate: null,
  rates,
  ratesUpdatedAt: null,
});

describe("costs in the office's currency", () => {
  it("are converted from US dollars at the day's rate", () => {
    expect(formatMoney(2, pounds)).toBe("£1.50");
    expect(formatMoney(1234.5, yen)).toBe("¥185,175");
  });

  it("are converted at the Owner's own rate when they give one", () => {
    const own = moneyOf({
      currency: "GBP",
      manualRate: 0.8,
      rates,
      ratesUpdatedAt: null,
    });
    expect(formatMoney(10, own)).toBe("£8.00");
  });

  it("are shown in US dollars while the rate is not known", () => {
    expect(
      moneyOf({
        currency: "GBP",
        manualRate: null,
        rates: null,
        ratesUpdatedAt: null,
      }),
    ).toBe(usDollars);
    expect(moneyOf(undefined)).toBe(usDollars);
    expect(formatMoney(1.5, usDollars)).toBe("$1.50");
  });

  it("show totals as the analytics do", () => {
    expect(formatTotal(0, pounds)).toBe("£0");
    expect(formatTotal(0.001, pounds)).toBe("<£0.01");
    expect(formatTotal(1000, pounds)).toBe("£750.00");
    expect(formatTotal(0.001, yen)).toBe("<¥1");
    expect(formatTotal(0, usDollars)).toBe("$0");
    expect(formatTotal(0.001, usDollars)).toBe("<$0.01");
  });

  it("show small costs and prices to six decimal places", () => {
    expect(formatPrecise(0.000123, usDollars)).toBe("$0.000123");
    expect(formatPrecise(3, pounds)).toBe("£2.25");
    expect(formatPrecise(4, usDollars)).toBe("$4");
    expect(formatPrecise(0.0004, pounds)).toBe("£0.0003");
  });

  it("show another currency's amount in the office's, when the rate is known", () => {
    expect(formatForeign(72, "CNY", pounds)).toBe("£7.50");
    expect(formatForeign(10, "USD", pounds)).toBe("£7.50");
    expect(formatForeign(10, "GBP", pounds)).toBe("£10.00");
    // No rate: in its own currency.
    expect(formatForeign(10, "CNY", usDollars)).toBe("CN¥10.00");
    expect(formatForeign(10, "credits", usDollars)).toBe("10.00 credits");
  });

  it("names the currency", () => {
    expect(currencyName("GBP")).toBe("British Pound");
  });
});

describe("prices given in the office's currency", () => {
  const live = moneyOf({
    currency: "GBP",
    manualRate: null,
    rates: { USD: 1, GBP: 0.752421 },
    ratesUpdatedAt: null,
  });

  it("are shown converted, to six significant figures", () => {
    expect(toOfficeAmount(3, live)).toBe(2.25726);
    expect(toOfficeAmount(3, usDollars)).toBe(3);
  });

  it("are kept in US dollars, to six decimal places", () => {
    expect(toUsdAmount(1.5, pounds)).toBe(2);
    expect(toUsdAmount(2.25726, live)).toBe(2.999996);
    expect(toUsdAmount(3, usDollars)).toBe(3);
  });
});
