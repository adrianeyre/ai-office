import { noTokens, type TokenUsageRow } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createUsageTally, type TalliedRequest } from "./tally.ts";

// The day's and the month's token use, kept in memory for the AI Gateway
// (PRD FR-33): read from the request history once, then each recorded
// request added.

const day = {
  from: new Date("2026-10-09T00:00:00.000Z"),
  to: new Date("2026-10-10T00:00:00.000Z"),
};
const month = {
  from: new Date("2026-10-01T00:00:00.000Z"),
  to: new Date("2026-11-01T00:00:00.000Z"),
};

const tokens = (count: number) => ({
  ...noTokens,
  requests: 1,
  inputTokens: count,
  tokens: count,
});

const ada = { floorId: "web-shop", agentId: "ada", ownerTool: null };

const request = (
  at: string,
  count: number,
  issue: number | null = 4,
): TalliedRequest => ({
  ...ada,
  issue,
  startedAt: new Date(at),
  totals: tokens(count),
});

/** The request history's answer, and each time it was asked. */
const history = (rows: TokenUsageRow[]) => {
  const asked: string[] = [];
  return {
    asked,
    load: (from: Date, to: Date) => {
      asked.push(`${from.toISOString()}/${to.toISOString()}`);
      return Promise.resolve(rows.map((row) => ({ ...row })));
    },
  };
};

describe("the usage tally", () => {
  it("reads each current period from the history once, then adds each request recorded", async () => {
    const source = history([{ ...ada, issue: 4, totals: tokens(100) }]);
    const clock = { now: new Date("2026-10-09T15:00:00.000Z") };
    const tally = createUsageTally({ load: source.load, now: () => clock.now });

    expect(await tally.usage(day.from, day.to)).toEqual([
      { ...ada, issue: 4, totals: tokens(100) },
    ]);
    tally.record(request("2026-10-09T15:01:00.000Z", 50));
    tally.record(request("2026-10-09T15:02:00.000Z", 7, 5));
    expect(await tally.usage(day.from, day.to)).toEqual([
      {
        ...ada,
        issue: 4,
        totals: { ...tokens(150), requests: 2 },
      },
      { ...ada, issue: 5, totals: tokens(7) },
    ]);
    expect(source.asked).toEqual([
      `${day.from.toISOString()}/${day.to.toISOString()}`,
    ]);
  });

  it("does not count a request twice that the history already has", async () => {
    const source = history([]);
    const tally = createUsageTally({
      load: source.load,
      now: () => new Date("2026-10-09T15:00:00.000Z"),
    });
    // Recorded before the month is first read: the real history has it
    // by then, so the tally adds nothing of its own. (This stand-in
    // history leaves it out, to show that.)
    tally.record(request("2026-10-09T14:00:00.000Z", 40));
    expect(await tally.usage(month.from, month.to)).toEqual([]);
  });

  it("starts each new day afresh, and reads other periods from the history", async () => {
    const source = history([{ ...ada, issue: 4, totals: tokens(100) }]);
    const clock = { now: new Date("2026-10-09T23:00:00.000Z") };
    const tally = createUsageTally({ load: source.load, now: () => clock.now });
    await tally.usage(day.from, day.to);
    tally.record(request("2026-10-09T23:30:00.000Z", 10));

    clock.now = new Date("2026-10-10T00:05:00.000Z");
    const tomorrow = {
      from: new Date("2026-10-10T00:00:00.000Z"),
      to: new Date("2026-10-11T00:00:00.000Z"),
    };
    // A new day is read afresh (the stand-in history answers the same).
    expect(await tally.usage(tomorrow.from, tomorrow.to)).toEqual([
      { ...ada, issue: 4, totals: tokens(100) },
    ]);
    // A past period is asked of the history each time.
    await tally.usage(day.from, day.to);
    await tally.usage(day.from, day.to);
    expect(source.asked.slice(1)).toEqual([
      `${tomorrow.from.toISOString()}/${tomorrow.to.toISOString()}`,
      `${day.from.toISOString()}/${day.to.toISOString()}`,
      `${day.from.toISOString()}/${day.to.toISOString()}`,
    ]);
  });

  it("counts a request recorded while its period is being read", async () => {
    let finish: (rows: TokenUsageRow[]) => void = () => undefined;
    const tally = createUsageTally({
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      now: () => new Date("2026-10-09T15:00:00.000Z"),
    });
    const reading = tally.usage(day.from, day.to);
    tally.record(request("2026-10-09T15:00:30.000Z", 25));
    finish([]);
    expect(await reading).toEqual([{ ...ada, issue: 4, totals: tokens(25) }]);
  });

  it("reads a period again if reading it failed", async () => {
    let fail = true;
    const tally = createUsageTally({
      load: () =>
        fail
          ? Promise.reject(new Error("The database is down."))
          : Promise.resolve([]),
      now: () => new Date("2026-10-09T15:00:00.000Z"),
    });
    await expect(tally.usage(day.from, day.to)).rejects.toThrow(
      "The database is down.",
    );
    fail = false;
    await expect(tally.usage(day.from, day.to)).resolves.toEqual([]);
  });
});
