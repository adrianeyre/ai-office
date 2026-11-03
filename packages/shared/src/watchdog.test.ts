import { describe, expect, it } from "vitest";

import {
  defaultWatchdogSettings,
  watchdogLimitsFor,
  watchdogSettingsSchema,
} from "./watchdog.ts";

// The watchdog's time limits (PRD FR-23, FR-22): the stall
// timeout and the sandbox time limit, office-wide and per AI Provider.

const problems = (body: unknown) => {
  const parsed = watchdogSettingsSchema.safeParse(body);
  return parsed.success
    ? []
    : parsed.error.issues.map(({ message }) => message);
};

describe("the watchdog's time limits", () => {
  it("are 20 minutes to stall and an hour per sandbox, for every AI Provider, by default", () => {
    expect(defaultWatchdogSettings).toEqual({
      stallTimeoutMinutes: 20,
      sandboxTimeLimitMinutes: 60,
      providers: {},
    });
    expect(watchdogLimitsFor(defaultWatchdogSettings, "Ollama")).toEqual({
      stallTimeoutMinutes: 20,
      sandboxTimeLimitMinutes: 60,
    });
  });

  it("are an AI Provider's own where it has them, the office's otherwise", () => {
    const settings = {
      stallTimeoutMinutes: 15,
      sandboxTimeLimitMinutes: 45,
      providers: { Ollama: { stallTimeoutMinutes: 90 } },
    };
    expect(watchdogLimitsFor(settings, "Ollama")).toEqual({
      stallTimeoutMinutes: 90,
      sandboxTimeLimitMinutes: 45,
    });
    expect(watchdogLimitsFor(settings, "Claude")).toEqual({
      stallTimeoutMinutes: 15,
      sandboxTimeLimitMinutes: 45,
    });
    expect(watchdogLimitsFor(settings, undefined)).toEqual({
      stallTimeoutMinutes: 15,
      sandboxTimeLimitMinutes: 45,
    });
  });

  it("take a stall timeout of 5 to 240 minutes and a sandbox time limit of 10 to 480", () => {
    const at = (stall: number, sandbox: number) => ({
      stallTimeoutMinutes: stall,
      sandboxTimeLimitMinutes: sandbox,
      providers: {},
    });
    expect(problems(at(5, 10))).toEqual([]);
    expect(problems(at(240, 480))).toEqual([]);
    expect(problems(at(4, 10))).toEqual([
      "The stall timeout is at least 5 minutes.",
    ]);
    expect(problems(at(241, 10))).toEqual([
      "The stall timeout is at most 240 minutes.",
    ]);
    expect(problems(at(20, 9))).toEqual([
      "The sandbox time limit is at least 10 minutes.",
    ]);
    expect(problems(at(20, 481))).toEqual([
      "The sandbox time limit is at most 480 minutes.",
    ]);
    expect(problems(at(20.5, 60))).toEqual([
      "The stall timeout is a whole number of minutes.",
    ]);
    // An AI Provider's own limits are bound the same way.
    expect(
      problems({
        ...at(20, 60),
        providers: { Ollama: { sandboxTimeLimitMinutes: 600 } },
      }),
    ).toEqual(["The sandbox time limit is at most 480 minutes."]);
    expect(
      problems({ ...at(20, 60), providers: { Llama: {} } }).length,
    ).toBeGreaterThan(0);
    expect(problems({ stallTimeoutMinutes: 20 }).length).toBeGreaterThan(0);
  });
});
