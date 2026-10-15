import { describe, expect, it } from "vitest";

import {
  addTokens,
  capPeriods,
  noTokens,
  periodBounds,
  resolveTokenCap,
  type CapLevels,
} from "./token-caps.ts";

// Token Caps (PRD FR-32): the most specific cap set applies, period by
// period; and the periods they count over (UTC days and months).

const office = { daily: 1_000, monthly: 20_000 };

describe("resolveTokenCap", () => {
  it("uses the office's default when nothing more specific is set", () => {
    for (const levels of [
      { office },
      {
        office,
        floor: { daily: null, monthly: null },
        agent: { daily: null, monthly: null },
        issue: { daily: null, monthly: null },
      },
    ] satisfies CapLevels[]) {
      expect(resolveTokenCap(levels, "daily")).toEqual({
        level: "office",
        cap: 1_000,
      });
      expect(resolveTokenCap(levels, "monthly")).toEqual({
        level: "office",
        cap: 20_000,
      });
    }
  });

  it("lets the issue beat the Agent, the Agent its Floor, and the Floor the office", () => {
    const floor = { daily: 800, monthly: 15_000 };
    const agent = { daily: 600, monthly: 12_000 };
    const issue = { daily: 400, monthly: 9_000 };
    const cases: [CapLevels, string, number][] = [
      [{ office, floor }, "floor", 800],
      [{ office, agent }, "agent", 600],
      [{ office, floor, agent }, "agent", 600],
      [{ office, issue }, "issue", 400],
      [{ office, floor, issue }, "issue", 400],
      [{ office, agent, issue }, "issue", 400],
      [{ office, floor, agent, issue }, "issue", 400],
    ];
    for (const [levels, level, cap] of cases) {
      expect(resolveTokenCap(levels, "daily")).toEqual({ level, cap });
    }
  });

  it("applies the most specific cap whether it is higher or lower", () => {
    // An Agent allowed more than its Floor's default is allowed more.
    expect(
      resolveTokenCap(
        {
          office,
          floor: { daily: 500, monthly: null },
          agent: { daily: 5_000, monthly: null },
        },
        "daily",
      ),
    ).toEqual({ level: "agent", cap: 5_000 });
  });

  it("resolves each period on its own", () => {
    const levels: CapLevels = {
      office,
      floor: { daily: 700, monthly: null },
      agent: { daily: null, monthly: 11_000 },
      issue: { daily: null, monthly: null },
    };
    expect(resolveTokenCap(levels, "daily")).toEqual({
      level: "floor",
      cap: 700,
    });
    expect(resolveTokenCap(levels, "monthly")).toEqual({
      level: "agent",
      cap: 11_000,
    });
    expect(
      resolveTokenCap(
        { ...levels, issue: { daily: 50, monthly: null } },
        "monthly",
      ),
    ).toEqual({ level: "agent", cap: 11_000 });
  });
});

describe("periodBounds", () => {
  it("is the UTC day and month holding the moment", () => {
    const at = new Date("2026-10-09T23:59:59.999Z");
    expect(periodBounds("daily", at)).toEqual({
      from: new Date("2026-10-09T00:00:00.000Z"),
      to: new Date("2026-10-10T00:00:00.000Z"),
    });
    expect(periodBounds("monthly", at)).toEqual({
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
    });
  });

  it("rolls over the year, and knows short months", () => {
    expect(periodBounds("monthly", new Date("2026-12-31T12:00:00Z"))).toEqual({
      from: new Date("2026-12-01T00:00:00.000Z"),
      to: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(periodBounds("daily", new Date("2028-02-29T00:00:00Z"))).toEqual({
      from: new Date("2028-02-29T00:00:00.000Z"),
      to: new Date("2028-03-01T00:00:00.000Z"),
    });
    expect(capPeriods).toEqual(["daily", "monthly"]);
  });
});

describe("addTokens", () => {
  it("adds every count, and nothing changes nothing", () => {
    const one = {
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      tokens: 15,
      estimatedCostUsd: 0.5,
    };
    expect(addTokens(one, one)).toEqual({
      requests: 2,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 40,
      tokens: 30,
      estimatedCostUsd: 1,
    });
    expect(addTokens(noTokens, one)).toEqual(one);
  });
});
