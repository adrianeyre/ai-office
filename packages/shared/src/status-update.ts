import { z } from "zod";

import { defaultTimeZone, isTimeZone } from "./people.ts";

// A Floor's Status update (PRD FR-23a): the whole Floor gathers in the
// meeting room and each Agent says what it did on the last working day and
// what it plans today; an hourly one, given while the Floor's Agents work,
// says what each did in the last hour instead. Days are the Owner's (their
// profile's time zone), written as `YYYY-MM-DD`.

/** How a Status update's chat message opens: "Status update on web-shop". */
export const statusUpdateHeading = "Status update on";

/**
 * Why a Status update was given: the Owner's button, the day's own, or
 * the hour's, while the Floor's Agents work, which reports on the last
 * hour.
 */
export const statusUpdateTriggers = ["owner", "daily", "hourly"] as const;
export type StatusUpdateTrigger = (typeof statusUpdateTriggers)[number];

/** A day, `YYYY-MM-DD`. */
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The day it is at `at` in `timeZone`: `2026-10-12`. */
export function dayIn(at: Date, timeZone: string): string {
  const zone = isTimeZone(timeZone) ? timeZone : defaultTimeZone;
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** `day` moved by `days` calendar days. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, date + days))
    .toISOString()
    .slice(0, 10);
}

/** The day of the week of `day`: 0 for Sunday to 6 for Saturday. */
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/** The milliseconds `timeZone` is ahead of UTC at `at`. */
function offsetAt(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  const wall = Date.UTC(
    parts["year"] ?? 0,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** When `day` starts in `timeZone`, as an instant. */
export function dayStart(day: string, timeZone: string): Date {
  const zone = isTimeZone(timeZone) ? timeZone : defaultTimeZone;
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const midnightUtc = Date.UTC(year, month - 1, date);
  // Twice: the offset at midnight can differ from the offset at the guess
  // on a day the clocks change.
  let start = midnightUtc - offsetAt(new Date(midnightUtc), zone);
  start = midnightUtc - offsetAt(new Date(start), zone);
  return new Date(start);
}

/** How far back a Status update looks for the last day with work. */
export const statusUpdateLookBackDays = 7;

/**
 * The day a Status update reports on, from `today`: yesterday, or, when
 * nothing happened then, the latest day before it with something done
 * (Friday, on a Monday after a quiet weekend), looking back a week. When
 * nothing happened all week it is the last weekday before today.
 */
export function reportedDay(
  today: string,
  busy: (day: string) => boolean,
): string {
  for (let back = 1; back <= statusUpdateLookBackDays; back += 1) {
    const day = addDays(today, -back);
    if (busy(day)) {
      return day;
    }
  }
  let day = addDays(today, -1);
  while (weekdayOf(day) === 0 || weekdayOf(day) === 6) {
    day = addDays(day, -1);
  }
  return day;
}

/** One Agent's part of a Status update. */
export const statusUpdateEntrySchema = z.object({
  agentId: z.string().min(1),
  name: z.string(),
  /** Its Role's name, such as "coder". */
  role: z.string(),
  /**
   * What it did on the day reported on (in the last hour, for an hourly
   * one), each in a sentence.
   */
  did: z.array(z.string()),
  /** What it plans today. */
  today: z.array(z.string()),
});
export type StatusUpdateEntry = z.infer<typeof statusUpdateEntrySchema>;

/** A Floor's Status update, as the Office shows it. */
export const statusUpdateSchema = z.object({
  floorId: z.string().min(1),
  /** The event that gave it: the Office's walks follow it. */
  eventId: z.number().int().nonnegative(),
  trigger: z.enum(statusUpdateTriggers),
  /** The Owner's day it was given on. */
  day: daySchema,
  /** The day it reports on; for an hourly one, the day it was given. */
  reportedDay: daySchema,
  givenAt: z.iso.datetime(),
  /** The Manager first, then the Floor's other Agents. */
  entries: z.array(statusUpdateEntrySchema),
});
export type StatusUpdate = z.infer<typeof statusUpdateSchema>;

/**
 * What asking for a Status update answers: the one given, or none (the
 * day's, given already; or a Floor with no Manager, or archived). The
 * latest one given answers the same way: none since the server started.
 */
export const statusUpdateAnswerSchema = z.object({
  statusUpdate: statusUpdateSchema.nullable(),
});

/** "Friday 9 October", the day as the chat names it. */
export function dayName(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}
