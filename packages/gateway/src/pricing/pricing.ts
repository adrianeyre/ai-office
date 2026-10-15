import { readFileSync } from "node:fs";

import type { EventBus } from "@ai-office/events";
import {
  modelPriceSchema,
  pricingErrorCodes,
  type ModelPrice,
  type PriceSource,
} from "@ai-office/shared";
import { z } from "zod";

import type { Usage } from "../usage.ts";
import type { ModelPriceStore, StoredPrice } from "./store.ts";

// Model prices and cost estimates (PRD FR-43, §8 pricing). Each request's
// cost is estimated from its Model's price per million tokens of each type:
// input, output, cache writes and cache reads. A Model's price is, from
// strongest to weakest: the Owner's override in the admin; the price its
// AI Provider publishes, refreshed automatically where one does; the
// pricing table in the repository (`pricing.json`). Estimates are for
// information only (FR-31); Token Caps count tokens, never dollars.

/** The pricing table's file: `packages/gateway/pricing.json`. */
export const pricingTablePath = new URL("../../pricing.json", import.meta.url);

const pricingTableSchema = z.object({
  currency: z.literal("USD"),
  unit: z.literal("per million tokens"),
  updated: z.iso.date(),
  source: z.string(),
  models: z.record(z.string().min(1), modelPriceSchema),
});

/** The pricing table's prices, by Model. Throws when the file is malformed. */
export function readPricingTable(
  path: URL | string = pricingTablePath,
): Readonly<Record<string, ModelPrice>> {
  return pricingTableSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    .models;
}

/**
 * The estimated cost of `usage` at `price`, in US dollars: each token type
 * at its own price. Null when the usage has no counts at all (an error, or
 * token counting).
 */
export function estimateCost(price: ModelPrice, usage: Usage): number | null {
  const counts = [
    [usage.inputTokens, price.input],
    [usage.outputTokens, price.output],
    [usage.cacheCreationInputTokens, price.cacheWrite],
    [usage.cacheReadInputTokens, price.cacheRead],
  ] as const;
  if (counts.every(([tokens]) => tokens === null)) {
    return null;
  }
  const dollars = counts.reduce(
    (total, [tokens, perMillion]) =>
      total + ((tokens ?? 0) * perMillion) / 1_000_000,
    0,
  );
  // Rounded to a millionth of a cent, so sums stay tidy.
  return Math.round(dollars * 1e8) / 1e8;
}

/** Where an AI Provider publishes its Models' prices. */
export interface PublishedPrices {
  /** Names the source in logs, such as `OpenRouter`. */
  readonly name: string;
  /** Its prices now, by the Model names callers use with it. */
  fetchPrices(): Promise<Record<string, ModelPrice>>;
}

/** A Model's price in use, where it comes from, and the one beneath. */
export interface PriceInfo {
  readonly model: string;
  readonly price: ModelPrice;
  readonly source: PriceSource;
  /** The price without the Owner's override; null when there is none. */
  readonly standard: ModelPrice | null;
  /** When the price in use was set or published; null for the table's. */
  readonly updatedAt: Date | null;
}

/** Why a pricing change was refused. */
export class PricingError extends Error {
  readonly code: (typeof pricingErrorCodes)[keyof typeof pricingErrorCodes];

  constructor(
    code: (typeof pricingErrorCodes)[keyof typeof pricingErrorCodes],
    message: string,
  ) {
    super(message);
    this.name = "PricingError";
    this.code = code;
  }
}

/** How each source fared in a refresh. */
export interface RefreshReport {
  /** How many prices were published, in all. */
  readonly published: number;
  readonly failed: readonly {
    readonly source: string;
    readonly error: unknown;
  }[];
}

/** What the Gateway asks of pricing: a cost for each request. */
export interface CostEstimator {
  /** The cost of `usage` with `model`; null when either is unknown. */
  estimate(model: string | null, usage: Usage): number | null;
}

export interface Pricing extends CostEstimator {
  /** Reads the published prices and overrides; until then, only the table's. */
  load(): Promise<void>;
  /** Every Model with a price, by name. */
  list(): PriceInfo[];
  /** Sets the Owner's price for a Model, which wins over every other. */
  setOverride(model: string, price: ModelPrice): Promise<PriceInfo>;
  /** Removes the Owner's price for a Model. */
  clearOverride(model: string): Promise<void>;
  /**
   * Fetches every source's published prices and keeps them in place of the
   * previous ones. A source that fails keeps its previous prices.
   */
  refresh(): Promise<RefreshReport>;
}

export interface PricingOptions {
  /** The pricing table's prices; `readPricingTable()` by default. */
  readonly table?: Readonly<Record<string, ModelPrice>>;
  readonly store: ModelPriceStore;
  /**
   * Where AI Providers publish prices, asked on every refresh: those of the
   * AI Providers the Owner has accounts with.
   */
  readonly sources?: () =>
    readonly PublishedPrices[] | Promise<readonly PublishedPrices[]>;
  /** Each override set or removed is a `config.changed` event. */
  readonly events: Pick<EventBus, "publish">;
  readonly now?: () => Date;
}

export function createPricing(options: PricingOptions): Pricing {
  const table = options.table ?? readPricingTable();
  const { store, events } = options;
  const now = options.now ?? (() => new Date());
  let published = new Map<string, StoredPrice>();
  const overrides = new Map<string, StoredPrice>();
  // Which source published each Model's price, so a failed source keeps
  // its own.
  const publishedBy = new Map<string, string>();

  const info = (model: string): PriceInfo | undefined => {
    const override = overrides.get(model);
    const fromSource = published.get(model);
    const fromTable = table[model];
    const standard = fromSource?.price ?? fromTable ?? null;
    if (override !== undefined) {
      return {
        model,
        price: override.price,
        source: "override",
        standard,
        updatedAt: override.updatedAt,
      };
    }
    if (fromSource !== undefined) {
      return {
        model,
        price: fromSource.price,
        source: "published",
        standard,
        updatedAt: fromSource.updatedAt,
      };
    }
    return fromTable === undefined
      ? undefined
      : { model, price: fromTable, source: "table", standard, updatedAt: null };
  };

  const changed = (model: string) =>
    events.publish({
      type: "config.changed",
      version: 1,
      scope: "gateway",
      keys: [`modelPrices.${model}`],
    });

  return {
    async load() {
      const stored = await store.list();
      published = new Map(
        stored
          .filter(({ source }) => source === "published")
          .map((price) => [price.model, price]),
      );
      overrides.clear();
      for (const price of stored) {
        if (price.source === "override") {
          overrides.set(price.model, price);
        }
      }
    },

    estimate(model, usage) {
      const found = model === null ? undefined : info(model);
      return found === undefined ? null : estimateCost(found.price, usage);
    },

    list() {
      const models = new Set([
        ...Object.keys(table),
        ...published.keys(),
        ...overrides.keys(),
      ]);
      return [...models]
        .sort((a, b) => a.localeCompare(b))
        .flatMap((model) => {
          const found = info(model);
          return found === undefined ? [] : [found];
        });
    },

    async setOverride(model, price) {
      const stored: StoredPrice = {
        model,
        source: "override",
        price,
        updatedAt: now(),
      };
      await store.set(stored);
      overrides.set(model, stored);
      await changed(model);
      return {
        model,
        price,
        source: "override",
        standard: published.get(model)?.price ?? table[model] ?? null,
        updatedAt: stored.updatedAt,
      };
    },

    async clearOverride(model) {
      if (!(await store.remove(model, "override"))) {
        throw new PricingError(
          pricingErrorCodes.noOverride,
          `There is no price of yours for ${model}.`,
        );
      }
      overrides.delete(model);
      await changed(model);
    },

    async refresh() {
      const failed: { source: string; error: unknown }[] = [];
      const next = new Map<string, StoredPrice>();
      const nextBy = new Map<string, string>();
      const at = now();
      for (const source of (await options.sources?.()) ?? []) {
        try {
          for (const [model, price] of Object.entries(
            await source.fetchPrices(),
          )) {
            next.set(model, {
              model,
              source: "published",
              price,
              updatedAt: at,
            });
            nextBy.set(model, source.name);
          }
        } catch (error) {
          failed.push({ source: source.name, error });
          // Its previous prices stay until it answers again.
          for (const [model, by] of publishedBy) {
            const kept = published.get(model);
            if (by === source.name && kept !== undefined && !next.has(model)) {
              next.set(model, kept);
              nextBy.set(model, by);
            }
          }
        }
      }
      await store.replacePublished([...next.values()]);
      published = next;
      publishedBy.clear();
      for (const [model, by] of nextBy) {
        publishedBy.set(model, by);
      }
      return { published: next.size, failed };
    },
  };
}

const openRouterModelsSchema = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      pricing: z
        .looseObject({
          prompt: z.string().optional(),
          completion: z.string().optional(),
          input_cache_read: z.string().optional(),
          input_cache_write: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

/** A per-token price in dollars as a per-million price; undefined if none. */
const perMillion = (perToken: string | undefined): number | undefined => {
  const value = Number(perToken);
  return perToken === undefined || !Number.isFinite(value) || value < 0
    ? undefined
    : Math.round(value * 1e6 * 1e6) / 1e6;
};

/**
 * OpenRouter's published prices (its public Models list), by the Model
 * names used with it, such as `anthropic/claude-sonnet-4.5`. Models priced
 * per request, or at a variable price, are left out.
 */
export function openRouterPrices(
  options: {
    readonly url?: string;
    readonly fetch?: typeof fetch;
  } = {},
): PublishedPrices {
  const url = options.url ?? "https://openrouter.ai/api/v1/models";
  const get = options.fetch ?? fetch;
  return {
    name: "OpenRouter",
    async fetchPrices() {
      const response = await get(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          `OpenRouter's Models list answered ${String(response.status)}.`,
        );
      }
      const { data } = openRouterModelsSchema.parse(await response.json());
      const prices: Record<string, ModelPrice> = {};
      for (const model of data) {
        const input = perMillion(model.pricing?.prompt);
        const output = perMillion(model.pricing?.completion);
        if (input === undefined || output === undefined) {
          continue;
        }
        prices[model.id] = {
          input,
          output,
          cacheWrite: perMillion(model.pricing?.input_cache_write) ?? input,
          cacheRead: perMillion(model.pricing?.input_cache_read) ?? input,
        };
      }
      return prices;
    },
  };
}

/**
 * The published prices of the AI Providers named, for those that publish
 * any: OpenRouter, so far, fetched with `fetch` (through the outbound
 * proxy, FR-35). Prices are refreshed only for AI Providers the Owner has
 * accounts with, so nothing is fetched for anyone else.
 */
export function publishedPricesFor(
  aiProviders: readonly string[],
  options: { readonly fetch?: typeof fetch } = {},
): PublishedPrices[] {
  return aiProviders.includes("OpenRouter")
    ? [
        openRouterPrices(
          options.fetch === undefined ? {} : { fetch: options.fetch },
        ),
      ]
    : [];
}
