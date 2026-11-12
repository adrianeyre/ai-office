import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

// The day's exchange rates, for showing costs (kept in US dollars) in the
// office's currency. They come from ExchangeRate-API's open endpoint, which
// needs no key and publishes what one US dollar is worth in some 160
// currencies once a day. Nothing about the office is sent: it is a plain
// GET of the day's table, through the outbound proxy when one is set.
// Fetched when first asked for, then again once they are a day old;
// a failed fetch is not tried again for ten minutes, and the last rates
// fetched stand in meanwhile.

/** Where the day's rates come from: US dollars to every currency. */
export const exchangeRatesUrl = "https://open.er-api.com/v6/latest/USD";

/** The day's rates: what one US dollar is worth in each currency. */
export interface ExchangeRateTable {
  readonly rates: Readonly<Record<string, number>>;
  /** When their publisher last updated them. */
  readonly updatedAt: Date;
}

export interface ExchangeRates {
  /** The day's rates, or the last fetched; undefined while there are none. */
  current(): Promise<ExchangeRateTable | undefined>;
}

export interface ExchangeRatesOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly logger?: Pick<FastifyBaseLogger, "warn">;
  readonly url?: string;
  /** How old rates may be before they are fetched again: a day. */
  readonly maxAgeMs?: number;
  /** How long after a failed fetch before another: ten minutes. */
  readonly retryAfterMs?: number;
  /** How long a fetch may take: five seconds. */
  readonly timeoutMs?: number;
}

const answerSchema = z.object({
  result: z.literal("success"),
  time_last_update_unix: z.number(),
  rates: z.record(z.string(), z.number().positive()),
});

export function createExchangeRates(
  options: ExchangeRatesOptions = {},
): ExchangeRates {
  const fetchRates = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const url = options.url ?? exchangeRatesUrl;
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const retryAfterMs = options.retryAfterMs ?? 10 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let table: ExchangeRateTable | undefined;
  /** When the rates in `table` were fetched. */
  let fetchedAt = 0;
  let failedAt: number | undefined;
  let inFlight: Promise<ExchangeRateTable | undefined> | undefined;

  const refresh = async (): Promise<ExchangeRateTable | undefined> => {
    try {
      const response = await fetchRates(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `The exchange rates answered ${String(response.status)}.`,
        );
      }
      const answer = answerSchema.parse(await response.json());
      table = {
        rates: { ...answer.rates, USD: 1 },
        updatedAt: new Date(answer.time_last_update_unix * 1000),
      };
      fetchedAt = now().getTime();
      failedAt = undefined;
    } catch (error) {
      failedAt = now().getTime();
      options.logger?.warn(
        { err: error },
        "The day's exchange rates could not be fetched.",
      );
    }
    return table;
  };

  return {
    async current() {
      const at = now().getTime();
      const fresh = table !== undefined && at - fetchedAt < maxAgeMs;
      const resting = failedAt !== undefined && at - failedAt < retryAfterMs;
      if (fresh || resting) {
        return table;
      }
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

/**
 * How the server writes an estimated cost (kept in US dollars) where it
 * writes one itself, in Batch reports and calendar events: in the office's
 * currency at the Owner's own rate or the day's, as the web app shows it;
 * in US dollars while neither is known.
 */
export function officeCostFormat(
  currency: () => Promise<{
    readonly currency: string;
    readonly manualRate: number | null;
  }>,
  exchangeRates: ExchangeRates,
): () => Promise<(usd: number) => string> {
  return async () => {
    const settings = await currency();
    const rate =
      settings.currency === "USD"
        ? 1
        : (settings.manualRate ??
          (await exchangeRates.current())?.rates[settings.currency]);
    const code = rate === undefined ? "USD" : settings.currency;
    const format = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    });
    return (usd) => format.format(usd * (rate ?? 1));
  };
}
