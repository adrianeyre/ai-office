import type { StreamedEvent } from "@ai-office/events/stream";
import { noTokens, type FloorTokenUsage } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  aboveHeads,
  compactTokens,
  dailyCapState,
  freshStartSignals,
  tokensThisMonthText,
  tokensTodayText,
} from "./above-head.ts";

// What floats above each Agent's head (PRD FR-62, FR-85), as data: its
// tokens today in a few characters, coloured against its daily Token Cap,
// and its Context Usage while it has a session going.

describe("compactTokens", () => {
  it("writes tokens short: 999, 1.2k, 128k, 3.4M", () => {
    expect(compactTokens(999)).toBe("999");
    expect(compactTokens(1_200)).toBe("1.2k");
    expect(compactTokens(128_000)).toBe("128k");
    expect(compactTokens(3_400_000)).toBe("3.4M");
  });

  it("never shows more than was used, rounding down", () => {
    expect(compactTokens(0)).toBe("0");
    expect(compactTokens(1_000)).toBe("1k");
    expect(compactTokens(1_299)).toBe("1.2k");
    expect(compactTokens(9_999)).toBe("9.9k");
    expect(compactTokens(10_000)).toBe("10k");
    expect(compactTokens(128_999)).toBe("128k");
    expect(compactTokens(999_999)).toBe("999k");
    expect(compactTokens(1_000_000)).toBe("1M");
    expect(compactTokens(12_345_678)).toBe("12M");
    expect(compactTokens(2_500_000_000)).toBe("2.5B");
  });

  it("labels today's and this month's tokens", () => {
    expect(tokensTodayText(128_000)).toBe("128k today");
    expect(tokensThisMonthText(3_400_000, 100_000_000)).toBe(
      "3.4M of 100M this month",
    );
    expect(tokensThisMonthText(3_400_000, null)).toBe("3.4M this month");
  });
});

describe("dailyCapState", () => {
  const cap = 1_000_000;

  it("is neutral at 79% of the daily cap, amber from 80% and through 99%, red at 100%", () => {
    expect(dailyCapState(790_000, cap)).toBe("neutral");
    expect(dailyCapState(799_999, cap)).toBe("neutral");
    expect(dailyCapState(800_000, cap)).toBe("warning");
    expect(dailyCapState(990_000, cap)).toBe("warning");
    expect(dailyCapState(999_999, cap)).toBe("warning");
    expect(dailyCapState(1_000_000, cap)).toBe("reached");
    expect(dailyCapState(1_200_000, cap)).toBe("reached");
  });

  it("stays neutral for an Agent with no cap, however much it used", () => {
    expect(dailyCapState(0, null)).toBe("neutral");
    expect(dailyCapState(5_000_000_000, null)).toBe("neutral");
  });
});

/** A Floor's token usage: each Agent's use against its caps. */
const tokenUsage = (
  agents: { agentId: string; today: number; month: number }[],
): FloorTokenUsage => ({
  floorId: "web-shop",
  caps: { daily: null, monthly: null },
  agentDefaults: {
    daily: { level: "office", cap: 5_000_000 },
    monthly: { level: "office", cap: 100_000_000 },
  },
  usage: { daily: noTokens, monthly: noTokens },
  agents: agents.map(({ agentId, today, month }) => ({
    agentId,
    usage: { daily: noTokens, monthly: noTokens },
    caps: {
      daily: { level: "agent", cap: 1_000_000, used: today },
      monthly: { level: "office", cap: 100_000_000, used: month },
    },
  })),
  issues: [],
});

describe("aboveHeads", () => {
  it("gives each Agent its Context Usage while it has a session going, and its tokens", () => {
    const displays = aboveHeads({
      agentIds: ["ada", "dieter", "new"],
      contextUsage: [
        {
          agentId: "ada",
          floorId: "web-shop",
          issue: 4,
          model: "claude-opus-5-5",
          inputTokens: 124_000,
          contextWindow: 200_000,
          contextUsage: 0.62,
          updatedAt: "2026-10-10T09:00:00.000Z",
        },
      ],
      tokenUsage: tokenUsage([
        { agentId: "ada", today: 128_000, month: 3_400_000 },
        { agentId: "dieter", today: 850_000, month: 9_000_000 },
      ]),
    });
    expect(displays.get("ada")).toEqual({
      contextUsage: 0.62,
      tokens: {
        today: 128_000,
        dailyCap: 1_000_000,
        thisMonth: 3_400_000,
        monthlyCap: 100_000_000,
      },
    });
    // Idle: no session, so no bar; its tokens still show.
    expect(displays.get("dieter")?.contextUsage).toBeUndefined();
    expect(displays.get("dieter")?.tokens?.today).toBe(850_000);
    // Not in the usage read yet: nothing used, against its Floor's caps.
    expect(displays.get("new")?.tokens).toEqual({
      today: 0,
      dailyCap: 5_000_000,
      thisMonth: 0,
      monthlyCap: 100_000_000,
    });
  });

  it("keeps an unknown Context Usage unknown, and shows no tokens until they are read", () => {
    const displays = aboveHeads({
      agentIds: ["ada"],
      contextUsage: [
        {
          agentId: "ada",
          floorId: "web-shop",
          issue: null,
          model: "mystery-1",
          inputTokens: 1_000,
          contextWindow: null,
          contextUsage: null,
          updatedAt: "2026-10-10T09:00:00.000Z",
        },
      ],
      tokenUsage: undefined,
    });
    expect(displays.get("ada")).toEqual({
      contextUsage: null,
      tokens: undefined,
    });
  });
});

describe("freshStartSignals", () => {
  it("picks the Fresh Starts out of a Floor's events, oldest first", () => {
    const events: StreamedEvent[] = [
      {
        id: 7,
        occurredAt: "2026-10-10T09:00:00.000Z",
        event: {
          type: "agent.fresh_start",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          issue: 4,
          trigger: "threshold",
          contextUsage: 0.86,
        },
      },
      {
        id: 8,
        occurredAt: "2026-10-10T09:00:01.000Z",
        event: {
          type: "agent.context_usage",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          active: false,
          contextUsage: null,
        },
      },
      {
        id: 9,
        occurredAt: "2026-10-10T09:00:02.000Z",
        event: {
          type: "agent.fresh_start",
          version: 1,
          floorId: "web-shop",
          agentId: "grace",
          trigger: "manual",
          contextUsage: 0.4,
        },
      },
    ];
    expect(freshStartSignals(events)).toEqual([
      { id: 7, agentId: "ada", contextUsage: 0.86 },
      { id: 9, agentId: "grace", contextUsage: 0.4 },
    ]);
  });
});
