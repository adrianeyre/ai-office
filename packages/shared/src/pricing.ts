import { z } from "zod";

// Model prices (PRD FR-43, §8 pricing): what the AI Gateway estimates each
// request's cost from, in US dollars per million tokens of each type. The
// pricing table in the repository gives the defaults; an AI Provider's
// published prices replace them where it publishes any; and the Owner's
// override for a Model wins over both. Costs are estimates, shown for
// information only (FR-31).

const dollars = z
  .number({ error: "Each price is a number of dollars." })
  .min(0, { error: "A price cannot be negative." })
  .max(10_000, { error: "That price is too high." });

/** A Model's prices, in US dollars per million tokens. */
export const modelPriceSchema = z.strictObject({
  input: dollars,
  output: dollars,
  /** Tokens written to the prompt cache. */
  cacheWrite: dollars,
  /** Tokens read from the prompt cache. */
  cacheRead: dollars,
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

/** Where the price in use for a Model comes from, weakest first. */
export const priceSources = ["table", "published", "override"] as const;
export type PriceSource = (typeof priceSources)[number];

/** A Model name, as callers ask for it. */
export const modelNameSchema = z
  .string({ error: "Name the Model." })
  .trim()
  .min(1, { error: "Name the Model." })
  .max(200, { error: "Use at most 200 characters for the Model." });

/** A Model's price as `GET /api/gateway/prices` lists it. */
export const modelPriceEntrySchema = z.object({
  model: z.string(),
  /** The price in use. */
  price: modelPriceSchema,
  source: z.enum(priceSources),
  /** The price without the Owner's override; null when there is none. */
  standard: modelPriceSchema.nullable(),
  /** When the price in use was set or published; null for the table's. */
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ModelPriceEntry = z.infer<typeof modelPriceEntrySchema>;

/** The body of `GET /api/gateway/prices`: by Model name. */
export const modelPriceListSchema = z.object({
  prices: z.array(modelPriceEntrySchema),
});

export const pricingErrorCodes = {
  /** The Model has no override to remove. */
  noOverride: "no_price_override",
} as const;
