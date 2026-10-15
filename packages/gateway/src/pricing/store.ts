import { modelPrices, type Database } from "@ai-office/db";
import type { ModelPrice } from "@ai-office/shared";
import { and, eq } from "drizzle-orm";

// Where prices other than the pricing table's live: the `model_prices`
// table, or memory for tests. `published` prices come from AI Providers;
// `override` prices are the Owner's.

export type StoredPriceSource = "published" | "override";

export interface StoredPrice {
  readonly model: string;
  readonly source: StoredPriceSource;
  readonly price: ModelPrice;
  readonly updatedAt: Date;
}

export interface ModelPriceStore {
  list(): Promise<StoredPrice[]>;
  /** Sets one Model's price from `source`, replacing any it had. */
  set(price: StoredPrice): Promise<void>;
  /** Removes one Model's price from `source`; false if it had none. */
  remove(model: string, source: StoredPriceSource): Promise<boolean>;
  /** Replaces every published price with `prices`. */
  replacePublished(prices: readonly StoredPrice[]): Promise<void>;
}

const keyOf = (model: string, source: StoredPriceSource) =>
  `${source}\u0000${model}`;

/** Keeps prices in memory: for tests. */
export function memoryModelPriceStore(): ModelPriceStore {
  const prices = new Map<string, StoredPrice>();
  return {
    list: () => Promise.resolve([...prices.values()]),
    set(price) {
      prices.set(keyOf(price.model, price.source), price);
      return Promise.resolve();
    },
    remove: (model, source) =>
      Promise.resolve(prices.delete(keyOf(model, source))),
    replacePublished(published) {
      for (const [key, price] of prices) {
        if (price.source === "published") {
          prices.delete(key);
        }
      }
      for (const price of published) {
        prices.set(keyOf(price.model, "published"), price);
      }
      return Promise.resolve();
    },
  };
}

type Row = typeof modelPrices.$inferSelect;

const toPrice = (row: Row): StoredPrice => ({
  model: row.model,
  source: row.source === "override" ? "override" : "published",
  price: {
    input: row.input,
    output: row.output,
    cacheWrite: row.cacheWrite,
    cacheRead: row.cacheRead,
  },
  updatedAt: row.updatedAt,
});

const toRow = (price: StoredPrice) => ({
  model: price.model,
  source: price.source,
  ...price.price,
  updatedAt: price.updatedAt,
});

/** Keeps prices in the `model_prices` table. */
export function databaseModelPriceStore(db: Database): ModelPriceStore {
  return {
    async list() {
      return (await db.select().from(modelPrices)).map(toPrice);
    },
    async set(price) {
      const row = toRow(price);
      await db
        .insert(modelPrices)
        .values(row)
        .onConflictDoUpdate({
          target: [modelPrices.model, modelPrices.source],
          set: row,
        });
    },
    async remove(model, source) {
      const removed = await db
        .delete(modelPrices)
        .where(
          and(eq(modelPrices.model, model), eq(modelPrices.source, source)),
        )
        .returning({ model: modelPrices.model });
      return removed.length > 0;
    },
    async replacePublished(published) {
      await db.transaction(async (tx) => {
        await tx.delete(modelPrices).where(eq(modelPrices.source, "published"));
        if (published.length > 0) {
          await tx.insert(modelPrices).values(published.map(toRow));
        }
      });
    },
  };
}
