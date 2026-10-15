import { gatewayModelMappings, type Database } from "@ai-office/db";
import type { AiAccountType } from "@ai-office/shared";
import { asc, eq } from "drizzle-orm";

// Where model mappings and aliases (PRD FR-41) live: the
// `gateway_model_mappings` table, or memory for tests. The store only
// refuses a name already mapped for the same kind of AI Account (or as an
// alias); whether a mapping makes sense is the mappings' own business.

/** A model mapping as it is stored. */
export interface ModelMapping {
  readonly id: string;
  /** The name callers ask for: a Model, or an alias. */
  readonly from: string;
  /** The Model sent instead. */
  readonly to: string;
  /** The kind of AI Account it applies to; both null for an alias. */
  readonly aiProvider: string | null;
  readonly accountType: AiAccountType | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ModelMappingFields = Pick<
  ModelMapping,
  "from" | "to" | "aiProvider" | "accountType"
>;

export interface ModelMappingStore {
  list(): Promise<ModelMapping[]>;
  add(mapping: ModelMapping): Promise<"added" | "taken">;
  /** The mapping as changed; undefined if there is none with that id. */
  replace(
    id: string,
    fields: ModelMappingFields & Pick<ModelMapping, "updatedAt">,
  ): Promise<ModelMapping | "taken" | undefined>;
  /** False if there was none with that id. */
  remove(id: string): Promise<boolean>;
}

/** Whether two mappings map the same name for the same kind. */
export const sameName = (a: ModelMappingFields, b: ModelMappingFields) =>
  a.from === b.from &&
  a.aiProvider === b.aiProvider &&
  a.accountType === b.accountType;

/** Keeps model mappings in memory: for tests. */
export function memoryModelMappingStore(): ModelMappingStore {
  const mappings = new Map<string, ModelMapping>();
  const taken = (fields: ModelMappingFields, id: string) =>
    [...mappings.values()].some(
      (other) => other.id !== id && sameName(other, fields),
    );
  return {
    list: () => Promise.resolve([...mappings.values()].map((m) => ({ ...m }))),
    add(mapping) {
      if (taken(mapping, mapping.id)) {
        return Promise.resolve("taken");
      }
      mappings.set(mapping.id, { ...mapping });
      return Promise.resolve("added");
    },
    replace(id, fields) {
      const current = mappings.get(id);
      if (current === undefined) {
        return Promise.resolve(undefined);
      }
      if (taken(fields, id)) {
        return Promise.resolve("taken");
      }
      const updated = { ...current, ...fields };
      mappings.set(id, updated);
      return Promise.resolve({ ...updated });
    },
    remove: (id) => Promise.resolve(mappings.delete(id)),
  };
}

type Row = typeof gatewayModelMappings.$inferSelect;

const toMapping = (row: Row): ModelMapping => ({
  ...row,
  // The table's check constraint allows only these.
  accountType: row.accountType as AiAccountType | null,
});

/** Whether `error` is Postgres refusing a name already mapped. */
const isTaken = (error: unknown): boolean => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, constraint } = cause as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && constraint === "gateway_model_mappings_from_idx") {
      return true;
    }
  }
  return false;
};

/** Keeps model mappings in the `gateway_model_mappings` table. */
export function databaseModelMappingStore(db: Database): ModelMappingStore {
  return {
    async list() {
      return (
        await db
          .select()
          .from(gatewayModelMappings)
          .orderBy(
            asc(gatewayModelMappings.createdAt),
            asc(gatewayModelMappings.id),
          )
      ).map(toMapping);
    },
    async add(mapping) {
      try {
        await db.insert(gatewayModelMappings).values(mapping);
        return "added";
      } catch (error) {
        if (isTaken(error)) {
          return "taken";
        }
        throw error;
      }
    },
    async replace(id, fields) {
      try {
        const [row] = await db
          .update(gatewayModelMappings)
          .set(fields)
          .where(eq(gatewayModelMappings.id, id))
          .returning();
        return row === undefined ? undefined : toMapping(row);
      } catch (error) {
        if (isTaken(error)) {
          return "taken";
        }
        throw error;
      }
    },
    async remove(id) {
      const removed = await db
        .delete(gatewayModelMappings)
        .where(eq(gatewayModelMappings.id, id))
        .returning({ id: gatewayModelMappings.id });
      return removed.length > 0;
    },
  };
}
