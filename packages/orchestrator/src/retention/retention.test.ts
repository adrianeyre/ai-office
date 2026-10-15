import { defaultRetentionSettings } from "@ai-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRetention, type RetentionTargets } from "./retention.ts";

// Retention's job (PRD §7): each rule's cutoff from the periods in force
// and a fake clock, each rule on its own, and its schedule.

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-10T12:00:00.000Z");

/** Targets that remember each cutoff they were given. */
function recordingTargets() {
  const calls: [keyof RetentionTargets, string][] = [];
  const target =
    (name: keyof RetentionTargets) =>
    (before: Date): Promise<number> => {
      calls.push([name, before.toISOString()]);
      return Promise.resolve(calls.length);
    };
  const targets: RetentionTargets = {
    requestBodies: target("requestBodies"),
    requestMetadata: target("requestMetadata"),
    activity: target("activity"),
    connectionDeliveries: target("connectionDeliveries"),
  };
  return { calls, targets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("retention's job", () => {
  it("deletes bodies older than 7 days, records older than 90, activity older than a year and delivery logs older than 90 days, by default", async () => {
    const { calls, targets } = recordingTargets();
    const retention = createRetention({
      settings: () => Promise.resolve(defaultRetentionSettings),
      targets,
      now: () => now,
    });
    const report = await retention.run();
    expect(calls).toEqual([
      ["requestBodies", "2026-10-03T12:00:00.000Z"],
      ["requestMetadata", "2026-07-12T12:00:00.000Z"],
      ["activity", "2025-10-10T12:00:00.000Z"],
      ["connectionDeliveries", "2026-07-12T12:00:00.000Z"],
    ]);
    expect(report.deleted.map(({ rule, count }) => [rule, count])).toEqual([
      ["requestBodiesDays", 1],
      ["requestMetadataDays", 2],
      ["activityDays", 3],
      ["connectionDeliveriesDays", 4],
    ]);
    expect(report.failed).toEqual([]);
  });

  it("deletes Manager chat attachments never sent after a day, whatever the Owner's periods (FR-24)", async () => {
    const { calls, targets } = recordingTargets();
    const retention = createRetention({
      settings: () => Promise.resolve(defaultRetentionSettings),
      targets: {
        ...targets,
        unsentChatAttachments: (before) => {
          calls.push(["unsentChatAttachments", before.toISOString()]);
          return Promise.resolve(2);
        },
      },
      now: () => now,
    });
    const report = await retention.run();
    expect(calls.at(-1)).toEqual([
      "unsentChatAttachments",
      "2026-10-09T12:00:00.000Z",
    ]);
    expect(report.deleted.at(-1)).toMatchObject({
      rule: "unsentChatAttachments",
      count: 2,
    });
  });

  it("uses the periods the Owner set, read afresh each run", async () => {
    const { calls, targets } = recordingTargets();
    let settings = defaultRetentionSettings;
    const retention = createRetention({
      settings: () => Promise.resolve(settings),
      targets,
      now: () => now,
    });
    settings = {
      requestBodiesDays: 1,
      requestMetadataDays: 30,
      activityDays: 60,
      connectionDeliveriesDays: 14,
    };
    await retention.run();
    expect(calls.map(([, before]) => before)).toEqual([
      new Date(now.getTime() - day).toISOString(),
      new Date(now.getTime() - 30 * day).toISOString(),
      new Date(now.getTime() - 60 * day).toISOString(),
      new Date(now.getTime() - 14 * day).toISOString(),
    ]);
  });

  it("runs every rule even when one fails", async () => {
    const { calls, targets } = recordingTargets();
    const failure = new Error("the database went away");
    const retention = createRetention({
      settings: () => Promise.resolve(defaultRetentionSettings),
      targets: {
        ...targets,
        requestMetadata: () => Promise.reject(failure),
      },
      now: () => now,
    });
    const report = await retention.run();
    expect(calls.map(([name]) => name)).toEqual([
      "requestBodies",
      "activity",
      "connectionDeliveries",
    ]);
    expect(report.failed).toEqual([
      { rule: "requestMetadataDays", error: failure },
    ]);
    expect(report.deleted.map(({ rule }) => rule)).toEqual([
      "requestBodiesDays",
      "activityDays",
      "connectionDeliveriesDays",
    ]);
  });

  it("runs at start, then every hour, with the clock as it is then", async () => {
    vi.useFakeTimers({ now });
    const { calls, targets } = recordingTargets();
    const reports: unknown[] = [];
    const retention = createRetention({
      settings: () => Promise.resolve(defaultRetentionSettings),
      targets,
      now: () => new Date(Date.now()),
      onReport: (report) => reports.push(report),
    });
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(reports).toHaveLength(2);
    expect(calls[4]).toEqual([
      "requestBodies",
      new Date(now.getTime() + 60 * 60 * 1000 - 7 * day).toISOString(),
    ]);
    await retention.stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(reports).toHaveLength(2);
  });

  it("tells why a scheduled run could not start, and runs again later", async () => {
    vi.useFakeTimers({ now });
    const { targets } = recordingTargets();
    const errors: unknown[] = [];
    let reads = 0;
    const retention = createRetention({
      settings: () =>
        (reads += 1) === 1
          ? Promise.reject(new Error("no database"))
          : Promise.resolve(defaultRetentionSettings),
      targets,
      onError: (error) => errors.push(error),
      intervalMs: 1000,
    });
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(2);
    expect(errors).toHaveLength(1);
    await retention.stop();
  });
});
