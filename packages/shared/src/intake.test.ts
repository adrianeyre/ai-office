import { describe, expect, it } from "vitest";

import { githubLoginSchema, intakeSettingsSchema } from "./intake.ts";

describe("intake settings", () => {
  it("takes GitHub logins as GitHub allows them", () => {
    for (const login of ["adrianeyre", "a", "Ada-Lovelace", "x1-2-3"]) {
      expect(githubLoginSchema.parse(login)).toBe(login);
    }
    expect(githubLoginSchema.parse("  adrianeyre ")).toBe("adrianeyre");
    for (const login of [
      "",
      "-ada",
      "ada-",
      "ada--lovelace",
      "ada_lovelace",
      "ai-office[bot]",
      "a".repeat(40),
    ]) {
      expect(githubLoginSchema.safeParse(login).success).toBe(false);
    }
  });

  it("checks between every 10 seconds and every hour, in whole seconds", () => {
    const settings = (intervalSeconds: number) =>
      intakeSettingsSchema.safeParse({
        ownerLogin: "adrianeyre",
        intervalSeconds,
      }).success;
    expect(settings(10)).toBe(true);
    expect(settings(60)).toBe(true);
    expect(settings(3600)).toBe(true);
    expect(settings(9)).toBe(false);
    expect(settings(3601)).toBe(false);
    expect(settings(60.5)).toBe(false);
  });
});
