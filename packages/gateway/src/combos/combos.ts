import { randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  aiProviderOfModel,
  aiProviderTakes,
  comboErrorCodes,
  defaultComboSettings,
  modelFamilyOf,
  type AddComboRequest,
  type ComboErrorCode,
  type ComboSettings,
  type ComboSlot,
  type ComboUpdate,
} from "@ai-office/shared";

import type { Combo, ComboChanges, ComboStore } from "./store.ts";

// Combos (PRD FR-40): the Owner's named, ordered fallback chains of (AI
// Account, Model) slots, each assigned to model families. While Combos are
// on, a request for a Model of a family an enabled Combo is assigned to
// waterfalls through its slots (the AI Accounts' `select` does that); the
// strategy, and the Model asked for, apply to every other request. No two
// enabled Combos share a family, so a request has at most one. They are
// kept in memory once read, since every request asks: only these change
// them.

/** Why a Combo was refused. */
export class ComboError extends Error {
  readonly code: ComboErrorCode;

  constructor(code: ComboErrorCode, message: string) {
    super(message);
    this.name = "ComboError";
    this.code = code;
  }
}

/**
 * How the AI Gateway tells one slot from another while it retries a
 * request: an AI Account may be in a Combo twice, with two Models.
 */
export const comboSlotKey = (accountId: string, model: string): string =>
  `${accountId}\u0000${model}`;

/** The AI Accounts a slot may name: their ids and AI Providers. */
export interface ComboAccounts {
  list(): Promise<
    readonly {
      readonly id: string;
      readonly name: string;
      readonly aiProvider: string;
    }[]
  >;
}

export interface Combos {
  /** Every Combo, oldest first. */
  list(): Promise<Combo[]>;
  add(request: AddComboRequest): Promise<Combo>;
  /** Renames it, reassigns it, changes its slots, enables or disables it. */
  update(id: string, update: ComboUpdate): Promise<Combo>;
  remove(id: string): Promise<void>;
  /**
   * The Combo a request for `model` waterfalls through: the enabled one
   * assigned to its family, while Combos are on; undefined otherwise.
   */
  forModel(model: string): Promise<Combo | undefined>;
}

export interface CombosOptions {
  readonly store: ComboStore;
  /** The AI Accounts a slot may name. */
  readonly accounts: ComboAccounts;
  /** Each change is a `config.changed` event, naming what changed. */
  readonly events: Pick<EventBus, "publish">;
  /** Whether Combos are on, asked on every request: off by default. */
  readonly settings?: () => ComboSettings;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The fields of a Combo the Owner sets. */
type ComboFields = Pick<Combo, "name" | "modelFamilies" | "slots" | "enabled">;

export function createCombos(options: CombosOptions): Combos {
  const { store, accounts, events } = options;
  const settings = options.settings ?? (() => defaultComboSettings);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  let cached: Promise<Combo[]> | undefined;
  const load = (): Promise<Combo[]> => {
    cached ??= store.list().catch((error: unknown) => {
      // Read again next time.
      cached = undefined;
      throw error;
    });
    return cached;
  };

  const changed = (keys: string[]) =>
    events.publish({
      type: "config.changed",
      version: 1,
      scope: "gateway",
      keys,
    });

  const notFound = (id: string) =>
    new ComboError(comboErrorCodes.comboNotFound, `There is no Combo "${id}".`);
  const nameTaken = (name: string) =>
    new ComboError(
      comboErrorCodes.comboNameTaken,
      `There is already a Combo named "${name}".`,
    );

  /** Refuses slots that could never serve, or that repeat one another. */
  const checkSlots = async (slots: readonly ComboSlot[]): Promise<void> => {
    const known = new Map(
      (await accounts.list()).map((account) => [account.id, account]),
    );
    const seen = new Set<string>();
    for (const [index, slot] of slots.entries()) {
      const place = `Slot ${String(index + 1)}`;
      const account = known.get(slot.aiAccountId);
      if (account === undefined) {
        throw new ComboError(
          comboErrorCodes.unknownAiAccount,
          `${place} names an AI Account that does not exist.`,
        );
      }
      if (!aiProviderTakes(account.aiProvider, slot.model)) {
        throw new ComboError(
          comboErrorCodes.slotModelMismatch,
          `${place}'s Model ${slot.model} is ${aiProviderOfModel(slot.model) ?? ""}'s, but ${account.name} is a ${account.aiProvider} account.`,
        );
      }
      const key = comboSlotKey(slot.aiAccountId, slot.model);
      if (seen.has(key)) {
        throw new ComboError(
          comboErrorCodes.duplicateSlot,
          `${place} repeats an earlier slot: ${account.name} with ${slot.model}.`,
        );
      }
      seen.add(key);
    }
  };

  /** Refuses a name another Combo has: the store refuses it too, later. */
  const checkName = async (name: string, id: string | null) => {
    if (
      (await load()).some((other) => other.name === name && other.id !== id)
    ) {
      throw nameTaken(name);
    }
  };

  /** Refuses an enabled Combo assigned to a family another enabled one has. */
  const checkFamilies = async (combo: ComboFields, id: string | null) => {
    if (!combo.enabled) {
      return;
    }
    for (const other of await load()) {
      if (other.id === id || !other.enabled) {
        continue;
      }
      const shared = combo.modelFamilies.find((family) =>
        other.modelFamilies.includes(family),
      );
      if (shared !== undefined) {
        throw new ComboError(
          comboErrorCodes.modelFamilyTaken,
          `The enabled Combo "${other.name}" is already assigned to ${shared}. Disable it first, or assign this one elsewhere.`,
        );
      }
    }
  };

  return {
    async list() {
      return [...(await load())];
    },

    async add(request) {
      const fields: ComboFields = {
        name: request.name,
        modelFamilies: request.modelFamilies,
        slots: request.slots,
        enabled: request.enabled,
      };
      await checkName(fields.name, null);
      await checkSlots(fields.slots);
      await checkFamilies(fields, null);
      const at = now();
      const combo: Combo = {
        id: newId(),
        ...fields,
        createdAt: at,
        updatedAt: at,
      };
      if ((await store.add(combo)) === "name_taken") {
        throw nameTaken(combo.name);
      }
      cached = undefined;
      await changed(["combos.added"]);
      return combo;
    },

    async update(id, update) {
      const current = (await load()).find((combo) => combo.id === id);
      if (current === undefined) {
        throw notFound(id);
      }
      const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
        JSON.stringify(a) === JSON.stringify(b);
      const changes: Omit<ComboChanges, "updatedAt"> = {
        ...(update.name !== undefined && update.name !== current.name
          ? { name: update.name }
          : {}),
        ...(update.modelFamilies !== undefined &&
        !sameList(update.modelFamilies, current.modelFamilies)
          ? { modelFamilies: update.modelFamilies }
          : {}),
        ...(update.slots !== undefined && !sameList(update.slots, current.slots)
          ? { slots: update.slots }
          : {}),
        ...(update.enabled !== undefined && update.enabled !== current.enabled
          ? { enabled: update.enabled }
          : {}),
      };
      const keys = Object.keys(changes);
      if (keys.length === 0) {
        return current;
      }
      if (changes.name !== undefined) {
        await checkName(changes.name, id);
      }
      if (changes.slots !== undefined) {
        await checkSlots(changes.slots);
      }
      await checkFamilies({ ...current, ...changes }, id);
      const updated = await store.update(id, { ...changes, updatedAt: now() });
      cached = undefined;
      if (updated === undefined) {
        throw notFound(id);
      }
      if (updated === "name_taken") {
        throw nameTaken(update.name ?? "");
      }
      // Which settings changed, never their values.
      await changed(keys.map((key) => `combos.${key}`));
      return updated;
    },

    async remove(id) {
      const removed = await store.remove(id);
      cached = undefined;
      if (!removed) {
        throw notFound(id);
      }
      await changed(["combos.deleted"]);
    },

    async forModel(model) {
      if (!settings().enabled) {
        return undefined;
      }
      const family = modelFamilyOf(model);
      return (await load()).find(
        (combo) => combo.enabled && combo.modelFamilies.includes(family),
      );
    },
  };
}
