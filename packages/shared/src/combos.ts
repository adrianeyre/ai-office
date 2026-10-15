import { z } from "zod";

import { modelFamilyOf } from "./ai-accounts.ts";
import { modelNameSchema } from "./pricing.ts";

// Combos (PRD FR-40): named, ordered fallback chains of (AI Account,
// Model) slots, each assigned to one or more model families. While Combos
// are on (off until the Owner turns them on), a request for a Model of a
// family an enabled Combo is assigned to waterfalls through its slots in
// order: the first slot whose AI Account can serve it does, with the
// slot's Model in place of the one asked for, and the next slot serves
// when it fails. Slots whose account is paused, gone, held back or cannot
// serve the request are skipped. The server and the web app share these.

/** The most slots one Combo may have, and model families it may cover. */
export const maxComboSlots = 20;
export const maxComboModelFamilies = 20;

/** `GET` and `PUT /api/office/combos`: the switch for every Combo. */
export const comboSettingsSchema = z.strictObject({
  enabled: z.boolean({ error: "Say whether Combos are on." }),
});
export type ComboSettings = z.infer<typeof comboSettingsSchema>;

/** Off until the Owner turns them on: requests route as they always do. */
export const defaultComboSettings: ComboSettings = { enabled: false };

/** One link of a Combo's chain: an AI Account, and the Model it serves. */
export const comboSlotSchema = z.strictObject({
  aiAccountId: z
    .string({ error: "Choose an AI Account for every slot." })
    .trim()
    .min(1, { error: "Choose an AI Account for every slot." }),
  model: modelNameSchema,
});
export type ComboSlot = z.infer<typeof comboSlotSchema>;

const comboNameSchema = z
  .string({ error: "Name the Combo." })
  .trim()
  .min(1, { error: "Name the Combo." })
  .max(100, { error: "Use at most 100 characters for the Combo's name." });

/**
 * The model families a Combo is assigned to, each as `modelFamilyOf` names
 * it, so a Model's name (`claude-opus-5-5`) stands for its family
 * (`claude-opus`). Duplicates are dropped.
 */
const modelFamiliesSchema = z
  .array(
    z
      .string({ error: "Name each model family." })
      .trim()
      .min(1, { error: "Name each model family." })
      .max(200, { error: "Use at most 200 characters for a model family." })
      .transform(modelFamilyOf),
    { error: "Assign the Combo to at least one model family." },
  )
  .min(1, { error: "Assign the Combo to at least one model family." })
  .max(maxComboModelFamilies, {
    error: `Assign a Combo to at most ${String(maxComboModelFamilies)} model families.`,
  })
  .transform((families) => [...new Set(families)]);

const slotsSchema = z
  .array(comboSlotSchema, { error: "Give the Combo at least one slot." })
  .min(1, { error: "Give the Combo at least one slot." })
  .max(maxComboSlots, {
    error: `Give a Combo at most ${String(maxComboSlots)} slots.`,
  });

/** `POST /api/gateway/combos`. */
export const addComboRequestSchema = z.strictObject({
  name: comboNameSchema,
  modelFamilies: modelFamiliesSchema,
  /** In the order they are tried: the first serves while it can. */
  slots: slotsSchema,
  enabled: z.boolean({ error: "Say whether the Combo is enabled." }),
});
export type AddComboRequest = z.infer<typeof addComboRequestSchema>;

/** `PATCH /api/gateway/combos/:id`: what changes; the rest stays. */
export const comboUpdateSchema = z.strictObject({
  name: comboNameSchema.optional(),
  modelFamilies: modelFamiliesSchema.optional(),
  slots: slotsSchema.optional(),
  enabled: z.boolean({ error: "Say whether the Combo is enabled." }).optional(),
});
export type ComboUpdate = z.infer<typeof comboUpdateSchema>;

/** A Combo, as the API sends it. */
export const comboSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelFamilies: z.array(z.string()),
  slots: z.array(z.object({ aiAccountId: z.string(), model: z.string() })),
  enabled: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ComboEntry = z.infer<typeof comboSchema>;

/** `GET /api/gateway/combos`, oldest first. */
export const comboListSchema = z.object({ combos: z.array(comboSchema) });

/** Why a Combo was refused. */
export const comboErrorCodes = {
  comboNotFound: "combo_not_found",
  /** Another Combo already has that name. */
  comboNameTaken: "combo_name_taken",
  /** Another enabled Combo is already assigned to one of its families. */
  modelFamilyTaken: "combo_model_family_taken",
  /** A slot names an AI Account that does not exist. */
  unknownAiAccount: "combo_unknown_ai_account",
  /** A slot's Model is another AI Provider's than its account's. */
  slotModelMismatch: "combo_slot_model_mismatch",
  /** Two slots are the same AI Account and Model. */
  duplicateSlot: "combo_duplicate_slot",
} as const;
export type ComboErrorCode =
  (typeof comboErrorCodes)[keyof typeof comboErrorCodes];
