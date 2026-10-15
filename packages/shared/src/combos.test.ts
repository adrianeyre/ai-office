import { describe, expect, it } from "vitest";

import {
  addComboRequestSchema,
  comboSettingsSchema,
  comboUpdateSchema,
  defaultComboSettings,
  maxComboSlots,
} from "./combos.ts";

// Combos' settings and requests (PRD FR-40).

const slot = { aiAccountId: "account-1", model: "claude-opus-5-5" };

describe("the switch for every Combo", () => {
  it("is off by default, and only says whether Combos are on", () => {
    expect(defaultComboSettings).toEqual({ enabled: false });
    expect(comboSettingsSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(comboSettingsSchema.safeParse({}).success).toBe(false);
    expect(
      comboSettingsSchema.safeParse({ enabled: true, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("a Combo", () => {
  it("names its model families as modelFamilyOf does, once each", () => {
    expect(
      addComboRequestSchema.parse({
        name: "  Opus chain ",
        modelFamilies: ["claude-opus-5-5", "claude-opus", "gpt-4o-2024-08-06"],
        slots: [slot],
        enabled: true,
      }),
    ).toEqual({
      name: "Opus chain",
      modelFamilies: ["claude-opus", "gpt-4o"],
      slots: [slot],
      enabled: true,
    });
  });

  it("needs a name, a family and between one and the most slots", () => {
    const valid = {
      name: "Opus chain",
      modelFamilies: ["claude-opus"],
      slots: [slot],
      enabled: true,
    };
    for (const body of [
      { ...valid, name: " " },
      { ...valid, modelFamilies: [] },
      { ...valid, modelFamilies: [" "] },
      { ...valid, slots: [] },
      {
        ...valid,
        slots: Array.from({ length: maxComboSlots + 1 }, (_, index) => ({
          aiAccountId: `account-${String(index)}`,
          model: "claude-opus-5-5",
        })),
      },
      { ...valid, slots: [{ aiAccountId: "", model: "claude-opus-5-5" }] },
      { ...valid, slots: [{ aiAccountId: "account-1", model: "" }] },
      { ...valid, slots: [{ ...slot, priority: 1 }] },
      { ...valid, enabled: undefined },
      { ...valid, extra: 1 },
    ]) {
      expect(addComboRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(addComboRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("changes only what an update names", () => {
    expect(comboUpdateSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(comboUpdateSchema.safeParse({ slots: [] }).success).toBe(false);
  });
});
