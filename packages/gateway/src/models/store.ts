import { modelCatalogue, type Database } from "@ai-office/db";
import type { AiAccountType } from "@ai-office/shared";
import { and, asc, eq } from "drizzle-orm";

// Where the model catalogue lives: the `model_catalogue` table, or memory
// for tests. Each kind of AI Account's Models are replaced together.

/** One Model a kind of AI Account lists. */
export interface CatalogueEntry {
  readonly aiProvider: string;
  readonly accountType: AiAccountType;
  readonly model: string;
  readonly displayName: string | null;
  readonly contextWindow: number | null;
  readonly fetchedAt: Date;
}

export interface ModelCatalogueStore {
  /** Every entry, by AI Provider, account type and Model. */
  list(): Promise<CatalogueEntry[]>;
  /** Replaces one kind's Models with `entries`. */
  replace(
    aiProvider: string,
    accountType: AiAccountType,
    entries: readonly CatalogueEntry[],
  ): Promise<void>;
}

const order = (a: CatalogueEntry, b: CatalogueEntry): number =>
  a.aiProvider.localeCompare(b.aiProvider) ||
  a.accountType.localeCompare(b.accountType) ||
  a.model.localeCompare(b.model);

/** Keeps the catalogue in memory: for tests. */
export function memoryModelCatalogueStore(): ModelCatalogueStore {
  let entries: CatalogueEntry[] = [];
  return {
    list: () => Promise.resolve([...entries].sort(order)),
    replace(aiProvider, accountType, replacements) {
      entries = [
        ...entries.filter(
          (entry) =>
            entry.aiProvider !== aiProvider ||
            entry.accountType !== accountType,
        ),
        ...replacements,
      ];
      return Promise.resolve();
    },
  };
}

/** Keeps the catalogue in the `model_catalogue` table. */
export function databaseModelCatalogueStore(db: Database): ModelCatalogueStore {
  return {
    async list() {
      const rows = await db
        .select()
        .from(modelCatalogue)
        .orderBy(
          asc(modelCatalogue.aiProvider),
          asc(modelCatalogue.accountType),
          asc(modelCatalogue.model),
        );
      return rows.map((row) => ({
        ...row,
        // The table's check constraint allows only these.
        accountType: row.accountType as AiAccountType,
      }));
    },
    async replace(aiProvider, accountType, entries) {
      await db.transaction(async (tx) => {
        await tx
          .delete(modelCatalogue)
          .where(
            and(
              eq(modelCatalogue.aiProvider, aiProvider),
              eq(modelCatalogue.accountType, accountType),
            ),
          );
        if (entries.length > 0) {
          await tx.insert(modelCatalogue).values([...entries]);
        }
      });
    },
  };
}
