import { describe, expect, it } from "vitest";

import {
  nextRecurringRun,
  recurringGoalInputSchema,
  recurringGoalScheduleSchema,
  scheduleText,
  wallClockInstant,
} from "./recurring-goals.ts";

// A Recurring Goal's schedule (Scorecards PRD, FR-136): daily, or weekly on
// chosen days, at a time in the Office's time zone.

const at = (iso: string) => new Date(iso);
const next = (
  schedule: unknown,
  after: string,
  timeZone = "Europe/London",
): string =>
  nextRecurringRun(
    recurringGoalScheduleSchema.parse(schedule),
    at(after),
    timeZone,
  ).toISOString();

describe("when a Recurring Goal next comes round", () => {
  it("comes round daily at its time, today if that is still to come, else tomorrow", () => {
    const daily = { frequency: "daily", time: "09:00" };
    // 2026-11-27 is a Friday; London is on GMT, UTC+0.
    expect(next(daily, "2026-11-27T08:59:00Z")).toBe(
      "2026-11-27T09:00:00.000Z",
    );
    expect(next(daily, "2026-11-27T09:00:00Z")).toBe(
      "2026-11-28T09:00:00.000Z",
    );
    expect(next(daily, "2026-11-27T23:30:00Z")).toBe(
      "2026-11-28T09:00:00.000Z",
    );
  });

  it("comes round weekly on its chosen days only", () => {
    const mondaysAndThursdays = {
      frequency: "weekly",
      days: [4, 1],
      time: "09:00",
    };
    // Friday the 27th: next Monday the 30th, then Thursday 3 December.
    expect(next(mondaysAndThursdays, "2026-11-27T10:00:00Z")).toBe(
      "2026-11-30T09:00:00.000Z",
    );
    expect(next(mondaysAndThursdays, "2026-11-30T09:00:00Z")).toBe(
      "2026-12-03T09:00:00.000Z",
    );
    // A Monday at 08:00: later that day.
    expect(next(mondaysAndThursdays, "2026-11-30T08:00:00Z")).toBe(
      "2026-11-30T09:00:00.000Z",
    );
    // One day a week: a week on, from just after it.
    expect(
      next(
        { frequency: "weekly", days: [1], time: "09:00" },
        "2026-11-30T09:00:01Z",
      ),
    ).toBe("2026-12-07T09:00:00.000Z");
  });

  it("keeps to the Office's time zone, its day and its clocks", () => {
    const daily = { frequency: "daily", time: "09:00" };
    // New York is UTC-5 in November: 09:00 there is 14:00 UTC.
    expect(next(daily, "2026-11-27T13:00:00Z", "America/New_York")).toBe(
      "2026-11-27T14:00:00.000Z",
    );
    // Tokyo is UTC+9: at 23:30 UTC on the 26th it is already the 27th, 08:30.
    expect(next(daily, "2026-11-26T23:30:00Z", "Asia/Tokyo")).toBe(
      "2026-11-27T00:00:00.000Z",
    );
    // A weekday there, not in UTC: Monday 09:00 in Tokyo is Sunday in UTC.
    expect(
      next(
        { frequency: "weekly", days: [1], time: "09:00" },
        "2026-11-27T00:00:00Z",
        "Asia/Tokyo",
      ),
    ).toBe("2026-11-30T00:00:00.000Z");
    // In summer London is on BST, UTC+1.
    expect(next(daily, "2026-07-01T07:00:00Z")).toBe(
      "2026-07-01T08:00:00.000Z",
    );
  });

  it("comes round once on the days the clocks change", () => {
    // London's clocks go forward at 01:00 UTC on 29 March 2026: 01:30
    // that day does not exist, and is 02:30 BST.
    expect(
      wallClockInstant("2026-03-29", "01:30", "Europe/London").toISOString(),
    ).toBe("2026-03-29T01:30:00.000Z");
    expect(
      next({ frequency: "daily", time: "09:00" }, "2026-03-28T09:00:00Z"),
    ).toBe("2026-03-29T08:00:00.000Z");
    // They go back on 25 October: 09:00 is GMT again.
    expect(
      next({ frequency: "daily", time: "09:00" }, "2026-10-24T09:00:00Z"),
    ).toBe("2026-10-25T09:00:00.000Z");
  });
});

describe("a Recurring Goal as the Owner writes it", () => {
  const problems = (value: unknown) => {
    const parsed = recurringGoalInputSchema.safeParse(value);
    return parsed.success
      ? []
      : parsed.error.issues.map(({ message }) => message);
  };
  const goal = {
    name: "Weekly test gaps",
    words: "Find modules without tests and file an issue for each.",
    schedule: { frequency: "weekly", days: [1], time: "09:00" },
  };

  it("is on, at the office's Token Cap, unless the Owner says", () => {
    expect(recurringGoalInputSchema.parse(goal)).toEqual({
      ...goal,
      schedule: { frequency: "weekly", days: [1], time: "09:00" },
      tokenCap: null,
      enabled: true,
    });
  });

  it("needs a day for a weekly one, none for a daily one, and a time on a 24-hour clock", () => {
    expect(
      problems({ ...goal, schedule: { frequency: "weekly", time: "09:00" } }),
    ).toEqual(["Choose at least one day for a weekly Recurring Goal."]);
    expect(
      problems({
        ...goal,
        schedule: { frequency: "daily", days: [1], time: "09:00" },
      }),
    ).toEqual([
      "A daily Recurring Goal comes round every day: choose no days.",
    ]);
    expect(
      problems({ ...goal, schedule: { frequency: "daily", time: "9am" } }),
    ).toEqual(["Give the time as HH:MM, such as 09:00."]);
    expect(
      problems({ ...goal, schedule: { frequency: "monthly", time: "09:00" } }),
    ).toEqual(["A Recurring Goal comes round daily or weekly."]);
    expect(problems({ ...goal, tokenCap: 0 })).toHaveLength(1);
    expect(problems({ ...goal, words: " " })).toEqual([
      "Say what the Goal is.",
    ]);
  });

  it("is said in words", () => {
    expect(scheduleText({ frequency: "daily", days: [], time: "09:00" })).toBe(
      "Daily at 09:00",
    );
    expect(
      scheduleText({ frequency: "weekly", days: [1, 4], time: "17:30" }),
    ).toBe("Mondays and Thursdays at 17:30");
  });
});
