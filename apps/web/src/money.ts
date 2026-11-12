import {
  currencyResponseSchema,
  usdRate,
  type CurrencyResponse,
} from "@ai-office/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { getJson } from "./api.ts";

// Costs in the office's currency (General Settings). Every cost comes from
// the server in US dollars, as AI Providers price their Models; each one is
// shown converted at the Owner's own exchange rate or the day's. While the
// rate is not known (the server has none yet, or the settings have not
// loaded), costs are shown in US dollars, as they are kept, never in
// another currency's symbol at the wrong value.

/** The office's currency and the day's rates (`GET /api/office/currency`). */
export const currencyQuery = queryOptions({
  queryKey: ["office", "currency"],
  queryFn: () => getJson("/api/office/currency", currencyResponseSchema),
  // The day's rates change once a day; the currency when the Owner says.
  staleTime: 60 * 60 * 1000,
});

/** How costs are shown: in which currency, and what a US dollar is worth. */
export interface Money {
  /** The ISO 4217 code costs are shown in. */
  readonly currency: string;
  /** What one US dollar is worth in `currency`. */
  readonly rate: number;
  /** What one unit of each other currency is worth in US dollars, if known. */
  readonly usdPer: (currency: string) => number | undefined;
}

/** Costs as they are kept: US dollars. */
export const usDollars: Money = {
  currency: "USD",
  rate: 1,
  usdPer: (currency) => (currency === "USD" ? 1 : undefined),
};

/** How the office's settings say costs are shown; US dollars until known. */
export function moneyOf(settings: CurrencyResponse | undefined): Money {
  const rate = settings === undefined ? undefined : usdRate(settings);
  if (settings === undefined || rate === undefined) {
    return usDollars;
  }
  const { rates } = settings;
  return {
    currency: settings.currency,
    rate,
    usdPer: (currency) => {
      if (currency === "USD") {
        return 1;
      }
      if (currency === settings.currency) {
        return 1 / rate;
      }
      const per = rates?.[currency];
      return per === undefined ? undefined : 1 / per;
    },
  };
}

/** How costs are shown on this page, from the office's currency. */
export function useMoney(): Money {
  const { data } = useQuery(currencyQuery);
  return moneyOf(data);
}

const formats = new Map<string, Intl.NumberFormat>();
/** A currency format, made once: `$` for US dollars, `£`, `€`, `CA$`… */
function currencyFormat(
  currency: string,
  fractionDigits?: { min: number; max: number },
): Intl.NumberFormat {
  const key = `${currency}:${String(fractionDigits?.min)}:${String(fractionDigits?.max)}`;
  let format = formats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      ...(fractionDigits === undefined
        ? {}
        : {
            minimumFractionDigits: fractionDigits.min,
            maximumFractionDigits: fractionDigits.max,
          }),
    });
    formats.set(key, format);
  }
  return format;
}

/** How many decimal places a currency is usually shown with: 2, 0 for yen. */
const usualDigits = (currency: string): number =>
  currencyFormat(currency).resolvedOptions().maximumFractionDigits ?? 2;

/**
 * A cost kept in US dollars, in the office's currency, to its usual
 * decimal places: `£1,234.56`, `¥1,235`.
 */
export function formatMoney(usd: number, money: Money): string {
  return currencyFormat(money.currency).format(usd * money.rate);
}

/**
 * A total, as the analytics show one: `£0` for none, `<£0.01` for less
 * than the currency's smallest usual amount, otherwise as `formatMoney`.
 */
export function formatTotal(usd: number, money: Money): string {
  const amount = usd * money.rate;
  const digits = usualDigits(money.currency);
  if (amount === 0) {
    return currencyFormat(money.currency, { min: 0, max: 0 }).format(0);
  }
  const smallest = 10 ** -digits;
  if (amount < smallest) {
    return `<${currencyFormat(money.currency).format(smallest)}`;
  }
  return currencyFormat(money.currency).format(amount);
}

/**
 * A small cost or price, to as many as six decimal places and no more
 * than it needs, as one request's cost or a price per million tokens is
 * shown: `£0.000123`, `£3`.
 */
export function formatPrecise(usd: number, money: Money): string {
  return currencyFormat(money.currency, { min: 0, max: 6 }).format(
    usd * money.rate,
  );
}

/**
 * An amount in another currency (an AI Provider's balance), in the
 * office's currency when the rate between them is known; otherwise in its
 * own.
 */
export function formatForeign(
  amount: number,
  currency: string,
  money: Money,
): string {
  const usdPer = money.usdPer(currency);
  if (usdPer === undefined) {
    try {
      return currencyFormat(currency).format(amount);
    } catch {
      // Not a currency the browser knows.
      return `${amount.toFixed(2)} ${currency}`;
    }
  }
  return formatMoney(amount * usdPer, money);
}

/** The office's currency's name: "British pounds", "euros"… */
export function currencyName(currency: string): string {
  try {
    return (
      new Intl.DisplayNames(["en-GB"], { type: "currency" }).of(currency) ??
      currency
    );
  } catch {
    return currency;
  }
}
