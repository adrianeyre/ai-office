import { gatewayCombos, type Database } from "@ai-office/db";
import type { ComboSlot } from "@ai-office/shared";
import { asc, eq } from "drizzle-orm";

// Where Combos (PRD FR-40) live: the `gateway_combos` table, or memory for
// tests. Checking a Combo makes sense is the Combos' own business; the
// store only refuses a name another Combo has.

/** A Combo as it is stored. */
export interface Combo {
  readonly id: string;
  readonly name: string;
  /** The model families it is assigned to, as `modelFamilyOf` names them. */
  readonly modelFamilies: readonly string[];
  /** In the order they are tried. */
  readonly slots: readonly ComboSlot[];
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ComboChanges = Partial<
  Pick<Combo, "name" | "modelFamilies" | "slots" | "enabled">
> &
  Pick<Combo, "updatedAt">;

export interface ComboStore {
  /** Every Combo, oldest first. */
  list(): Promise<Combo[]>;
  add(combo: Combo): Promise<"added" | "name_taken">;
  /** The Combo as changed; undefined if there is none with that id. */
  update(
    id: string,
    changes: ComboChanges,
  ): Promise<Combo | "name_taken" | undefined>;
  /** False if there was none with that id. */
  remove(id: string): Promise<boolean>;
}

const copy = (combo: Combo): Combo => ({
  ...combo,
  modelFamilies: [...combo.modelFamilies],
  slots: combo.slots.map((slot) => ({ ...slot })),
});

/** Keeps Combos in memory: for tests. */
export function memoryComboStore(): ComboStore {
  const combos = new Map<string, Combo>();
  const nameTaken = (name: string, id: string) =>
    [...combos.values()].some(
      (combo) => combo.name === name && combo.id !== id,
    );
  return {
    list: () =>
      Promise.resolve(
        [...combos.values()]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(copy),
      ),
    add(combo) {
      if (nameTaken(combo.name, combo.id)) {
        return Promise.resolve("name_taken");
      }
      combos.set(combo.id, copy(combo));
      return Promise.resolve("added");
    },
    update(id, changes) {
      const current = combos.get(id);
      if (current === undefined) {
        return Promise.resolve(undefined);
      }
      if (changes.name !== undefined && nameTaken(changes.name, id)) {
        return Promise.resolve("name_taken");
      }
      const updated = copy({ ...current, ...changes });
      combos.set(id, updated);
      return Promise.resolve(copy(updated));
    },
    remove: (id) => Promise.resolve(combos.delete(id)),
  };
}

type Row = typeof gatewayCombos.$inferSelect;

const toCombo = (row: Row): Combo => ({
  id: row.id,
  name: row.name,
  modelFamilies: row.modelFamilies,
  slots: row.slots as ComboSlot[],
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Whether `error` is Postgres refusing a name another Combo has. */
const isNameTaken = (error: unknown): boolean => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, constraint } = cause as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && constraint === "gateway_combos_name_unique") {
      return true;
    }
  }
  return false;
};

/** Keeps Combos in the `gateway_combos` table. */
export function databaseComboStore(db: Database): ComboStore {
  return {
    async list() {
      return (
        await db
          .select()
          .from(gatewayCombos)
          .orderBy(asc(gatewayCombos.createdAt), asc(gatewayCombos.id))
      ).map(toCombo);
    },
    async add(combo) {
      try {
        await db.insert(gatewayCombos).values({
          ...combo,
          modelFamilies: [...combo.modelFamilies],
        });
        return "added";
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },
    async update(id, changes) {
      try {
        const [row] = await db
          .update(gatewayCombos)
          .set({
            ...changes,
            modelFamilies:
              changes.modelFamilies === undefined
                ? undefined
                : [...changes.modelFamilies],
          })
          .where(eq(gatewayCombos.id, id))
          .returning();
        return row === undefined ? undefined : toCombo(row);
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },
    async remove(id) {
      const removed = await db
        .delete(gatewayCombos)
        .where(eq(gatewayCombos.id, id))
        .returning({ id: gatewayCombos.id });
      return removed.length > 0;
    },
  };
}
