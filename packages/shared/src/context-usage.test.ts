import { describe, expect, it } from "vitest";

import {
  contextUsageBand,
  contextUsageBandTokens,
  contextUsageOf,
  contextUsageText,
} from "./context-usage.ts";

// Context Usage (PRD FR-84, FR-85): a call's input tokens over its Model's
// context window, and the colour it is shown in.

describe("contextUsageBand", () => {
  it("is green below 60%, amber from 60% and red from 85%", () => {
    expect(contextUsageBand(0)).toBe("green");
    expect(contextUsageBand(0.59)).toBe("green");
    expect(contextUsageBand(0.6)).toBe("amber");
    expect(contextUsageBand(0.84)).toBe("amber");
    expect(contextUsageBand(0.85)).toBe("red");
    expect(contextUsageBand(1)).toBe("red");
  });

  it("puts the bands' edges where whole tokens land on them", () => {
    // 59%, 60%, 84% and 85% of a 200,000-token window.
    const window = 200_000;
    expect(contextUsageBand(contextUsageOf(118_000, window))).toBe("green");
    expect(contextUsageBand(contextUsageOf(119_999, window))).toBe("green");
    expect(contextUsageBand(contextUsageOf(120_000, window))).toBe("amber");
    expect(contextUsageBand(contextUsageOf(168_000, window))).toBe("amber");
    expect(contextUsageBand(contextUsageOf(169_999, window))).toBe("amber");
    expect(contextUsageBand(contextUsageOf(170_000, window))).toBe("red");
  });

  it("is unknown, not green, when the usage is not known", () => {
    expect(contextUsageBand(null)).toBe("unknown");
    expect(contextUsageBand(Number.NaN)).toBe("unknown");
    expect(contextUsageBandTokens.unknown).toBe("state-neutral");
  });
});

describe("contextUsageOf", () => {
  it("divides the input tokens by the context window", () => {
    expect(contextUsageOf(50_000, 200_000)).toBe(0.25);
    expect(contextUsageOf(0, 200_000)).toBe(0);
  });

  it("is null, not 0, without a context window", () => {
    expect(contextUsageOf(50_000, null)).toBeNull();
    expect(contextUsageOf(50_000, 0)).toBeNull();
  });

  it("counts a call larger than the catalogue's window as full", () => {
    expect(contextUsageOf(250_000, 200_000)).toBe(1);
  });
});

describe("contextUsageText", () => {
  it("writes whole percentages, rounded down, or Unknown", () => {
    expect(contextUsageText(0.849)).toBe("84%");
    expect(contextUsageText(0.85)).toBe("85%");
    expect(contextUsageText(0.29)).toBe("29%");
    expect(contextUsageText(null)).toBe("Unknown");
  });
});
