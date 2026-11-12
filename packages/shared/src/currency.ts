import { z } from "zod";

// The currency AI Office shows costs in (General Settings). Every cost is
// estimated, and kept, in US dollars, as AI Providers price their Models
// (FR-43); the web app shows each one in the office's currency at the
// day's exchange rate, or at the Owner's own rate when they give one.
// British pounds until set.

/**
 * The world's currencies in use, by ISO 4217 code: every circulating
 * national and regional currency (not funds, metals or test codes).
 */
export const currencyCodes = [
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BHD",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CLP",
  "CNY",
  "COP",
  "CRC",
  "CUP",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GHS",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "IQD",
  "IRR",
  "ISK",
  "JMD",
  "JOD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KPW",
  "KRW",
  "KWD",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "LYD",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRU",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "OMR",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLE",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TND",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "UYU",
  "UZS",
  "VES",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XCD",
  "XCG",
  "XOF",
  "XPF",
  "YER",
  "ZAR",
  "ZMW",
  "ZWG",
] as const;
export type CurrencyCode = (typeof currencyCodes)[number];

/** The currency costs are shown in until the Owner chooses one. */
export const defaultCurrency: CurrencyCode = "GBP";

/** The most a US dollar may be said to be worth in any currency. */
export const maxExchangeRate = 1_000_000_000;

/** `PUT /api/office/currency`: the office's currency, and its own rate. */
export const currencySettingsSchema = z.strictObject({
  currency: z.enum(currencyCodes, {
    error: "Choose a currency from the list.",
  }),
  /**
   * What one US dollar is worth in `currency`, when the Owner says so;
   * null for the day's rate.
   */
  manualRate: z
    .number({ error: "An exchange rate is a number." })
    .positive({ error: "An exchange rate is more than 0." })
    .max(maxExchangeRate, {
      error: `An exchange rate is at most ${maxExchangeRate.toLocaleString("en-GB")}.`,
    })
    .nullable(),
});
export type CurrencySettings = z.infer<typeof currencySettingsSchema>;

export const defaultCurrencySettings: CurrencySettings = {
  currency: defaultCurrency,
  manualRate: null,
};

/**
 * `GET /api/office/currency`: the settings, with the day's exchange rates
 * (what one US dollar is worth in each currency, by code) and when they
 * were published, or null while none could be fetched.
 */
export const currencyResponseSchema = currencySettingsSchema.extend({
  rates: z.record(z.string(), z.number().positive()).nullable(),
  ratesUpdatedAt: z.iso.datetime().nullable(),
});
export type CurrencyResponse = z.infer<typeof currencyResponseSchema>;

/**
 * What one US dollar is worth in the office's currency: the Owner's own
 * rate, or the day's; 1 for US dollars; undefined when neither is known.
 */
export function usdRate(
  settings: Pick<CurrencyResponse, "currency" | "manualRate" | "rates">,
): number | undefined {
  if (settings.currency === "USD") {
    return 1;
  }
  return settings.manualRate ?? settings.rates?.[settings.currency];
}
