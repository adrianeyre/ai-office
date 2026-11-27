import { z } from "zod";

import { defaultTimeZone, isTimeZone } from "./people.ts";
import { addDays, dayIn, weekdayOf } from "./status-update.ts";
import { tokenCapSchema } from "./token-caps.ts";

// Recurring Goals (Scorecards PRD, FR-136 to FR-141; ADR 0018): a Goal the
// Owner saves on a Floor with a schedule, daily or weekly on chosen days,
// at a time in the Office's time zone (the Owner's profile's). Each time it
// comes round, the Floor's Manager works its words as a Goal from the
// Owner: it may send one research Contractor (FR-138), files issues by the
// path a chat request's issues take (ADR 0004), never again one an earlier
// run filed that is still open (FR-139), and proposes a Plan, which waits
// on the whiteboard for the Owner's approval: a Recurring Goal is the only
// Goal that does not stand as its Plan's approval. Only the Owner makes,
// changes, runs or deletes one, as for Hooks (ADR 0016). The server, the
// web app and the orchestrator share these.

/** How often a Recurring Goal comes round (FR-136): never by cron. */
export const recurringGoalFrequencies = ["daily", "weekly"] as const;
export type RecurringGoalFrequency = (typeof recurringGoalFrequencies)[number];

/** The days of the week, 0 for Sunday to 6 for Saturday. */
export const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The most characters of a Recurring Goal's words. */
export const maxRecurringGoalWords = 2000;
/** The most Recurring Goals one Floor has. */
export const maxRecurringGoals = 20;
/** How many failed runs in a row turn a Recurring Goal off (FR-140). */
export const recurringGoalFailuresToTurnOff = 3;

/** The Floor admin card's anchor, which Recurring Goals' Notices link to. */
export const recurringGoalsCardId = "recurring-goals";

/** The Floor admin's Recurring Goals card. */
export const floorRecurringGoalsPath = (floorId: string): string =>
  `/floor-settings/${encodeURIComponent(floorId)}#${recurringGoalsCardId}`;

/** A time of day, `HH:MM` on a 24-hour clock. */
export const timeOfDaySchema = z
  .string({ error: "Give the time as HH:MM, such as 09:00." })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
    error: "Give the time as HH:MM, such as 09:00.",
  });

/** When a Recurring Goal comes round (FR-136). */
export const recurringGoalScheduleSchema = z
  .strictObject({
    frequency: z.enum(recurringGoalFrequencies, {
      error: "A Recurring Goal comes round daily or weekly.",
    }),
    /** For a weekly one, the days it comes round: 0 is Sunday. */
    days: z
      .array(z.number().int().min(0).max(6), {
        error: "The days are numbers from 0 (Sunday) to 6 (Saturday).",
      })
      .max(7)
      .default([]),
    /** The time of day, in the Office's time zone. */
    time: timeOfDaySchema,
  })
  .superRefine((schedule, context) => {
    if (schedule.frequency === "weekly" && schedule.days.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["days"],
        message: "Choose at least one day for a weekly Recurring Goal.",
      });
    }
    if (schedule.frequency === "daily" && schedule.days.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["days"],
        message:
          "A daily Recurring Goal comes round every day: choose no days.",
      });
    }
  })
  .transform((schedule) => ({
    ...schedule,
    days: [...new Set(schedule.days)].sort((a, b) => a - b),
  }));
export type RecurringGoalSchedule = z.infer<typeof recurringGoalScheduleSchema>;

/** A Recurring Goal as the Owner writes it, and configuration export has it. */
export const recurringGoalInputSchema = z.strictObject({
  name: z
    .string({ error: "Give the Recurring Goal a name." })
    .trim()
    .min(1, { error: "Give the Recurring Goal a name." })
    .max(100, { error: "Use at most 100 characters for the name." }),
  /** The Goal's words, as the Owner would type them after /goal. */
  words: z
    .string({ error: "Say what the Goal is." })
    .trim()
    .min(1, { error: "Say what the Goal is." })
    .max(maxRecurringGoalWords, {
      error: `Use at most ${String(maxRecurringGoalWords)} characters for the Goal.`,
    }),
  schedule: recurringGoalScheduleSchema,
  /**
   * The most tokens one run may use, the Manager's calls and its research
   * Contractor's together (FR-138); null for the office's daily Token Cap,
   * which an issue's work is held to unless it has its own.
   */
  tokenCap: tokenCapSchema.default(null),
  enabled: z.boolean().default(true),
});
export type RecurringGoalInput = z.infer<typeof recurringGoalInputSchema>;

/** `PATCH /api/floors/:floorId/recurring-goals/:goalId`: what to change. */
export const recurringGoalUpdateSchema = z
  .strictObject({
    name: recurringGoalInputSchema.shape.name,
    words: recurringGoalInputSchema.shape.words,
    schedule: recurringGoalScheduleSchema,
    tokenCap: tokenCapSchema,
    enabled: z.boolean(),
  })
  .partial()
  .refine((update) => Object.keys(update).length > 0, {
    error: "Change at least one setting.",
  });
export type RecurringGoalUpdate = z.infer<typeof recurringGoalUpdateSchema>;

/** How a run went (FR-140, FR-141). */
export const recurringGoalRunOutcomes = [
  "running",
  "planned",
  "skipped",
  "failed",
] as const;
export type RecurringGoalRunOutcome = (typeof recurringGoalRunOutcomes)[number];

/** Why a run was skipped (FR-140). */
export const recurringGoalSkipReasons = [
  "plan_awaiting_approval",
  "batch_running",
  "manager_paused",
  "manager_has_no_model",
  "nothing_new",
] as const;
export type RecurringGoalSkipReason = (typeof recurringGoalSkipReasons)[number];

export const recurringGoalSkipText: Readonly<
  Record<RecurringGoalSkipReason, string>
> = {
  plan_awaiting_approval: "its last Plan still awaits your approval",
  batch_running: "its last Batch is still running",
  manager_paused: "the Manager is paused",
  manager_has_no_model: "the Manager has no Model",
  nothing_new:
    "every issue it would file was filed by an earlier run and is still open",
};

/** One run of a Recurring Goal, as the card shows it. */
export const recurringGoalRunSchema = z.object({
  id: z.number().int().positive(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  outcome: z.enum(recurringGoalRunOutcomes),
  /** Why it was skipped or failed; empty otherwise. */
  reason: z.string(),
  /** The Batch whose Plan it proposed, if it did. */
  batchId: z.number().int().positive().nullable(),
  /** The issues it filed. */
  issues: z.array(z.number().int().positive()),
  /** The tokens it used, its Manager's calls and Contractor's together. */
  tokens: z.number().int().min(0),
});
export type RecurringGoalRun = z.infer<typeof recurringGoalRunSchema>;

/** A Recurring Goal as `GET /api/floors/:floorId/recurring-goals` lists it. */
export const recurringGoalSchema = z.object({
  id: z.number().int().positive(),
  floorId: z.string(),
  name: z.string(),
  words: z.string(),
  schedule: z.object({
    frequency: z.enum(recurringGoalFrequencies),
    days: z.array(z.number().int().min(0).max(6)),
    time: z.string(),
  }),
  tokenCap: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  /** Its failed runs in a row; three turn it off (FR-140). */
  failures: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
  /** When it next comes round; null while it is off. */
  nextRunAt: z.iso.datetime({ offset: true }).nullable(),
  /** Its latest run, if it has run. */
  lastRun: recurringGoalRunSchema.nullable(),
});
export type RecurringGoal = z.infer<typeof recurringGoalSchema>;

export const recurringGoalListSchema = z.object({
  recurringGoals: z.array(recurringGoalSchema),
  /** The Office's time zone, which every schedule is in. */
  timeZone: z.string(),
});

/** Codes in the `error` field of the Recurring Goals API's errors. */
export const recurringGoalErrorCodes = {
  notFound: "recurring_goal_not_found",
  nameTaken: "recurring_goal_name_taken",
  tooMany: "too_many_recurring_goals",
  /** Run now while it is running already. */
  running: "recurring_goal_running",
} as const;

/** `09:00` as minutes from midnight. */
const minutesOf = (time: string): number => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

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

/**
 * The instant it is `time` on `day` in `timeZone`. On the morning the
 * clocks go forward, a time that does not exist is the same time after
 * the change (02:30 becomes 03:30); when they go back, the first of the
 * two.
 */
export function wallClockInstant(
  day: string,
  time: string,
  timeZone: string,
): Date {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date) + minutesOf(time) * 60_000;
  let at = wall - offsetAt(new Date(wall), timeZone);
  at = wall - offsetAt(new Date(at), timeZone);
  return new Date(at);
}

/**
 * When `schedule` next comes round strictly after `after`, in `timeZone`
 * (the Office's): the next of its days, at its time there.
 */
export function nextRecurringRun(
  schedule: Pick<RecurringGoalSchedule, "frequency" | "days" | "time">,
  after: Date,
  timeZone: string,
): Date {
  const zone = isTimeZone(timeZone) ? timeZone : defaultTimeZone;
  const today = dayIn(after, zone);
  // A week and a day: every weekday at least once, whatever the clocks do.
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const day = addDays(today, ahead);
    if (
      schedule.frequency === "weekly" &&
      !schedule.days.includes(weekdayOf(day))
    ) {
      continue;
    }
    const at = wallClockInstant(day, schedule.time, zone);
    if (at > after) {
      return at;
    }
  }
  throw new Error("A weekly Recurring Goal has no days to come round on.");
}

/** "Daily at 09:00", "Mondays and Thursdays at 09:00". */
export function scheduleText(
  schedule: Pick<RecurringGoalSchedule, "frequency" | "days" | "time">,
): string {
  if (schedule.frequency === "daily") {
    return `Daily at ${schedule.time}`;
  }
  const days = schedule.days.map((day) => `${weekdayNames[day] ?? ""}s`);
  const list =
    days.length <= 1
      ? (days[0] ?? "")
      : `${days.slice(0, -1).join(", ")} and ${days.at(-1) ?? ""}`;
  return `${list} at ${schedule.time}`;
}
