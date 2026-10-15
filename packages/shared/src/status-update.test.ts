import { describe, expect, it } from "vitest";

import {
  addDays,
  dayIn,
  dayName,
  dayStart,
  reportedDay,
  statusUpdateSchema,
  weekdayOf,
} from "./status-update.ts";

// A Status update's days (FR-23a), the Owner's: 2026-10-12 is a Monday.

describe("the Owner's days", () => {
  it("is the day in the Owner's time zone, not UTC's", () => {
    const late = new Date("2026-10-11T23:30:00Z");
    expect(dayIn(late, "Europe/London")).toBe("2026-10-12");
    expect(dayIn(late, "America/New_York")).toBe("2026-10-11");
    expect(dayIn(late, "Not/AZone")).toBe("2026-10-12");
  });

  it("starts at the zone's midnight, on a day the clocks change too", () => {
    expect(dayStart("2026-10-12", "Europe/London").toISOString()).toBe(
      "2026-10-11T23:00:00.000Z",
    );
    // The clocks go back at 2am on 25 October: the day starts in summer time.
    expect(dayStart("2026-10-25", "Europe/London").toISOString()).toBe(
      "2026-10-24T23:00:00.000Z",
    );
    expect(dayStart("2026-10-26", "Europe/London").toISOString()).toBe(
      "2026-10-26T00:00:00.000Z",
    );
    expect(dayStart("2026-10-12", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-11T18:30:00.000Z",
    );
  });

  it("counts days and weekdays on the calendar", () => {
    expect(addDays("2026-10-12", -3)).toBe("2026-10-09");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekdayOf("2026-10-12")).toBe(1);
    expect(weekdayOf("2026-10-10")).toBe(6);
    expect(dayName("2026-10-09")).toBe("Friday 9 October");
  });
});

describe("the day a Status update reports on", () => {
  const busyOn =
    (...days: string[]) =>
    (day: string) =>
      days.includes(day);

  it("is yesterday when something happened then", () => {
    expect(reportedDay("2026-10-14", busyOn("2026-10-13"))).toBe("2026-10-13");
  });

  it("is Friday on a Monday after a quiet weekend", () => {
    expect(reportedDay("2026-10-12", busyOn("2026-10-09"))).toBe("2026-10-09");
  });

  it("is the weekend's day when work went on over it", () => {
    expect(reportedDay("2026-10-12", busyOn("2026-10-09", "2026-10-10"))).toBe(
      "2026-10-10",
    );
  });

  it("is the latest day with work in the week before", () => {
    expect(reportedDay("2026-10-14", busyOn("2026-10-09"))).toBe("2026-10-09");
  });

  it("is the last weekday when nothing happened all week", () => {
    expect(reportedDay("2026-10-12", busyOn())).toBe("2026-10-09");
    expect(reportedDay("2026-10-11", busyOn())).toBe("2026-10-09");
    expect(reportedDay("2026-10-14", busyOn())).toBe("2026-10-13");
    // A week ago is too long ago.
    expect(reportedDay("2026-10-14", busyOn("2026-10-06"))).toBe("2026-10-13");
  });
});

describe("a Status update", () => {
  const given = {
    floorId: "web-shop",
    eventId: 12,
    trigger: "owner",
    day: "2026-10-12",
    reportedDay: "2026-10-09",
    givenAt: "2026-10-12T08:30:00.000Z",
    entries: [],
  };

  it("is the Owner's, the day's own, or the hour's while Agents work", () => {
    for (const trigger of ["owner", "daily", "hourly"]) {
      expect(statusUpdateSchema.parse({ ...given, trigger }).trigger).toBe(
        trigger,
      );
    }
    expect(
      statusUpdateSchema.safeParse({ ...given, trigger: "weekly" }).success,
    ).toBe(false);
  });
});
