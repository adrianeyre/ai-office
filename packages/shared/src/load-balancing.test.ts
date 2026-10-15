import { describe, expect, it } from "vitest";

import { modelFamilyOf } from "./ai-accounts.ts";
import {
  defaultUsageThrottlingSettings,
  usageThrottlingSettingsSchema,
} from "./load-balancing.ts";

// Model families and usage throttling's settings (PRD FR-38).

describe("a Model's family", () => {
  it("is Claude's tier, whatever its version or date", () => {
    expect(modelFamilyOf("claude-opus-5-5")).toBe("claude-opus");
    expect(modelFamilyOf("claude-opus-4-1-20250805")).toBe("claude-opus");
    expect(modelFamilyOf("claude-3-5-sonnet-20241022")).toBe("claude-sonnet");
    expect(modelFamilyOf(" Claude-Haiku-5-5 ")).toBe("claude-haiku");
    expect(modelFamilyOf("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet");
  });

  it("is another Model itself, without a date it is pinned to", () => {
    expect(modelFamilyOf("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(modelFamilyOf("gpt-5-codex")).toBe("gpt-5-codex");
    expect(modelFamilyOf("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(modelFamilyOf("grok-4-0709")).toBe("grok-4-0709");
  });
});

describe("usage throttling's settings", () => {
  it("are both pacing gates, off by default", () => {
    expect(defaultUsageThrottlingSettings).toEqual({
      fiveHourPacing: false,
      weeklyPacing: false,
    });
    expect(
      usageThrottlingSettingsSchema.safeParse({
        fiveHourPacing: true,
        weeklyPacing: false,
      }).success,
    ).toBe(true);
    for (const settings of [
      {},
      { fiveHourPacing: true },
      { fiveHourPacing: "yes", weeklyPacing: false },
      { fiveHourPacing: true, weeklyPacing: false, extra: 1 },
    ]) {
      expect(usageThrottlingSettingsSchema.safeParse(settings).success).toBe(
        false,
      );
    }
  });
});
