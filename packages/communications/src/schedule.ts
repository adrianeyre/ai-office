import type {
  ConnectionRules,
  DigestSchedule,
  OutboundMessage,
  QuietHours,
} from "@ai-office/shared";

// When a Connection is quiet, and when its Digest falls due (PRD FR-92),
// on the clock of the time zone the Owner chose, through `Intl` so that
// summer time is followed without a time-zone library.

const hourMs = 60 * 60 * 1000;

/** A wall clock's reading. */
interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** What the clocks of `timeZone` read at `at`. */
function wallClock(at: Date, timeZone: string): WallClock {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(at)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  return {
    year: parts["year"] ?? 1970,
    month: parts["month"] ?? 1,
    day: parts["day"] ?? 1,
    hour: parts["hour"] ?? 0,
    minute: parts["minute"] ?? 0,
    second: parts["second"] ?? 0,
  };
}

/** How far ahead of UTC `timeZone` is at `at`. */
function offsetMs(at: Date, timeZone: string): number {
  const clock = wallClock(at, timeZone);
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return asUtc - (at.getTime() - at.getUTCMilliseconds());
}

/** The moment the clocks of `timeZone` read this date and time. */
function zoned(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  const first = offsetMs(new Date(guess), timeZone);
  const second = offsetMs(new Date(guess - first), timeZone);
  return new Date(guess - second);
}

/** `07:30` as minutes after midnight. */
const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** The first moment after `after` that the clocks of `timeZone` read `time`. */
export function nextLocalTime(
  time: string,
  timeZone: string,
  after: Date,
): Date {
  const clock = wallClock(after, timeZone);
  for (let days = 0; days <= 2; days += 1) {
    // Date.UTC carries a 32nd into the next month.
    const date = new Date(
      Date.UTC(clock.year, clock.month - 1, clock.day + days),
    );
    const candidate = zoned(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      minutesOf(time),
      timeZone,
    );
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }
  // Never reached: a day later always is.
  return new Date(after.getTime() + 24 * hourMs);
}

/** Whether `at` falls in the quiet hours. */
export function isQuiet(hours: QuietHours, at: Date): boolean {
  const clock = wallClock(at, hours.timeZone);
  const now = clock.hour * 60 + clock.minute;
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** When the Digest after one made at `since` falls due. */
export function nextDigestAt(schedule: DigestSchedule, since: Date): Date {
  return schedule.frequency === "hourly"
    ? new Date(Math.floor(since.getTime() / hourMs) * hourMs + hourMs)
    : nextLocalTime(schedule.at, schedule.timeZone, since);
}

/**
 * When a Connection's next Digest is made, as of `at`: when it falls due,
 * or at once if it is overdue, but never in quiet hours, which it waits
 * out.
 */
export function digestMadeAt(
  rules: Pick<ConnectionRules, "quietHours" | "digest">,
  since: Date,
  at: Date,
): Date | undefined {
  if (rules.digest === undefined) {
    return undefined;
  }
  const due = nextDigestAt(rules.digest, since);
  const made = due.getTime() > at.getTime() ? due : at;
  const hours = rules.quietHours;
  return hours !== undefined && isQuiet(hours, made)
    ? nextLocalTime(hours.end, hours.timeZone, made)
    : made;
}

/**
 * Until when a message is held (FR-92); undefined when it goes now. In
 * quiet hours a message is held for the Connection's next Digest, which
 * summarises it instead, or without one until quiet hours end. Action
 * Notices go at once when the Owner lets them through, and a Digest is
 * held only until quiet hours end.
 */
export function heldUntil(
  rules: Pick<ConnectionRules, "quietHours" | "digest">,
  lastDigestAt: Date,
  message: Pick<OutboundMessage, "kind">,
  at: Date,
): Date | undefined {
  const hours: QuietHours | undefined = rules.quietHours;
  if (
    hours === undefined ||
    message.kind === "test" ||
    (message.kind === "action_notice" && hours.actionNotices) ||
    !isQuiet(hours, at)
  ) {
    return undefined;
  }
  return (
    (message.kind === "digest"
      ? undefined
      : digestMadeAt(rules, lastDigestAt, at)) ??
    nextLocalTime(hours.end, hours.timeZone, at)
  );
}
