import { describe, expect, it } from "vitest";

import type { AnalyticsRow } from "../history/store.ts";
import { breakdownOf, seriesOf } from "./analytics.ts";

// The time to first byte in the analytics: a mean of the requests that had
// one, so requests without one (deleted ones, rolled into their day) do not
// pull it down.

const row = (fields: Partial<AnalyticsRow> = {}): AnalyticsRow => ({
  at: new Date("2026-10-09T00:00:00.000Z"),
  account: "Work",
  model: "claude-opus-5-5",
  floorId: "web-shop",
  agentId: "ada",
  issue: null,
  ownerTool: null,
  requests: 1,
  errors: 0,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
  latencyMs: 100,
  keepAliveRequests: 0,
  keepAliveCostUsd: 0,
  ...fields,
});

const names = {
  floor: (floorId: string) => floorId,
  agent: (agentId: string) => agentId,
};

describe("the time to first byte in the analytics", () => {
  it("is the mean of the requests that had one", () => {
    const series = seriesOf(
      [
        row({ requests: 2, timeToFirstByteMs: 300, timedRequests: 2 }),
        row({ requests: 3 }),
      ],
      new Date("2026-10-09T00:00:00.000Z"),
      new Date("2026-10-10T00:00:00.000Z"),
      "day",
    );
    expect(series.totals.averageTimeToFirstByteMs).toBe(150);
    expect(series.totals.averageLatencyMs).toBe(40);
  });

  it("is none where no request had one, and is broken down too", () => {
    const breakdown = breakdownOf(
      [
        row({ agentId: "ada", timeToFirstByteMs: 80, timedRequests: 1 }),
        row({ agentId: "linus" }),
      ],
      "agent",
      names,
    );
    expect(
      breakdown.items.map(({ key, averageTimeToFirstByteMs }) => [
        key,
        averageTimeToFirstByteMs,
      ]),
    ).toEqual([
      ["ada", 80],
      ["linus", null],
    ]);
  });
});
