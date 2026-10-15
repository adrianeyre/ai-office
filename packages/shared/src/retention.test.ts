import { describe, expect, it } from "vitest";

import {
  defaultRetentionSettings,
  historyKindRetention,
  historyKinds,
  retentionCutoff,
  retentionMinDays,
  retentionSettingsSchema,
} from "./retention.ts";
import { storageCategoryInfo, storagePruneRequestSchema } from "./storage.ts";

// Retention's settings (PRD §7).

describe("retention's settings", () => {
  it("default to 7 days of bodies, 90 of metadata, a year of activity and 90 days of delivery logs", () => {
    expect(defaultRetentionSettings).toEqual({
      requestBodiesDays: 7,
      requestMetadataDays: 90,
      activityDays: 365,
      connectionDeliveriesDays: 90,
    });
    expect(retentionSettingsSchema.parse(defaultRetentionSettings)).toEqual(
      defaultRetentionSettings,
    );
  });

  it("are whole days, within bounds", () => {
    const problems = (settings: unknown) => {
      const parsed = retentionSettingsSchema.safeParse(settings);
      return parsed.success
        ? []
        : parsed.error.issues.map(({ message }) => message);
    };
    expect(
      problems({ ...defaultRetentionSettings, requestBodiesDays: 0 }),
    ).toEqual([]);
    expect(
      problems({ ...defaultRetentionSettings, requestBodiesDays: -1 }),
    ).toEqual(["A request's bodies is kept for 0 days or more."]);
    expect(
      problems({ ...defaultRetentionSettings, requestMetadataDays: 31 }),
    ).toEqual(["A request's record is kept for at least 32 days."]);
    expect(
      problems({ ...defaultRetentionSettings, requestMetadataDays: 1.5 }),
    ).toEqual(["A request's record is a whole number of days."]);
    expect(problems({ ...defaultRetentionSettings, activityDays: 7 })).toEqual([
      "The Activity Feed is kept for at least 30 days.",
    ]);
    expect(
      problems({ ...defaultRetentionSettings, activityDays: 3651 }),
    ).toEqual(["The Activity Feed is kept for at most 3650 days."]);
    expect(
      problems({ ...defaultRetentionSettings, connectionDeliveriesDays: 0 }),
    ).toEqual(["A Connection's delivery log is kept for at least 1 day."]);
    expect(
      problems({ ...defaultRetentionSettings, connectionDeliveriesDays: 1 }),
    ).toEqual([]);
    expect(problems({ ...defaultRetentionSettings, extra: 1 })).toHaveLength(1);
  });

  it("keep bodies no longer than the requests they belong to", () => {
    const parsed = retentionSettingsSchema.safeParse({
      ...defaultRetentionSettings,
      requestBodiesDays: 60,
      requestMetadataDays: 40,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["requestBodiesDays"]);
  });
});

describe("each kind of history", () => {
  it("keeps the same minimum, and suggests retention's default, in Storage", () => {
    for (const kind of historyKinds) {
      const { rule, minDays } = historyKindRetention[kind];
      expect(storageCategoryInfo[kind]).toMatchObject({
        rule,
        minDays,
        suggestedDays: defaultRetentionSettings[rule],
      });
      // A rule keeps at least what every kind it deletes keeps.
      expect(retentionMinDays[rule]).toBeGreaterThanOrEqual(minDays);
      // Deleting by hand stops at the same day retention does.
      expect(
        storagePruneRequestSchema.safeParse({
          category: kind,
          olderThanDays: minDays,
        }).success,
      ).toBe(true);
      if (minDays > 0) {
        expect(
          storagePruneRequestSchema.safeParse({
            category: kind,
            olderThanDays: minDays - 1,
          }).success,
        ).toBe(false);
      }
    }
    expect(retentionMinDays).toEqual({
      requestBodiesDays: 0,
      requestMetadataDays: 32,
      activityDays: 30,
      connectionDeliveriesDays: 1,
    });
  });

  it("is suggested for PRD §7's periods", () => {
    expect(
      Object.fromEntries(
        historyKinds.map((kind) => [
          kind,
          storageCategoryInfo[kind].suggestedDays,
        ]),
      ),
    ).toEqual({
      activity: 365,
      request_bodies: 7,
      requests: 90,
      usage_history: 90,
      sign_ins: 365,
      connection_deliveries: 90,
    });
  });
});

describe("a retention cutoff", () => {
  it("is that many whole days before now", () => {
    expect(
      retentionCutoff(new Date("2026-10-10T12:00:00.000Z"), 7).toISOString(),
    ).toBe("2026-10-03T12:00:00.000Z");
  });
});
