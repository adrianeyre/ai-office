import type { UsageWindow } from "@ai-office/shared";

// An AI Account's usage windows (PRD FR-36, FR-43), as its AI Provider
// reports them with each answer. A Claude subscription reports its
// five-hour and weekly windows in `anthropic-ratelimit-unified-5h-*` and
// `anthropic-ratelimit-unified-7d-*`: the share used (`-utilization`, a
// fraction, 1 when full) and when it resets (`-reset`, seconds since the
// epoch). Anthropic does not document these; they are what Claude Code
// reads.
//
// A ChatGPT subscription (Codex's backend) reports up to two windows in
// `x-codex-primary-*` and `x-codex-secondary-*`: the share used
// (`-used-percent`, already a percentage), the window's length
// (`-window-minutes`) and when it resets (`-reset-at`, seconds since the
// epoch, or `-reset-after-seconds` from now). The primary one is usually
// the five-hour window and the secondary the weekly one, but not always (a
// Pro plan has been seen with a weekly primary), so each is placed by its
// length where it says it; a window of neither length is left out. OpenAI
// does not document these either; they are what Codex reads
// (`codex-rs/codex-api/src/rate_limits.rs`). Other AI Providers' accounts
// report none that fit: xAI's and OpenAI's `x-ratelimit-*` headers count
// requests and tokens a minute, not a plan's windows.

/**
 * A window's share used, in percent, and when it resets: null when no
 * window is running (a Claude subscription's usage endpoint says so of a
 * five-hour window no request has started), so none can be counted yet.
 */
export interface WindowReading {
  readonly utilization: number;
  readonly resetsAt: Date | null;
}

export type UsageWindowReadings = Partial<Record<UsageWindow, WindowReading>>;

const anthropicWindows: Record<UsageWindow, string> = {
  five_hour: "anthropic-ratelimit-unified-5h",
  weekly: "anthropic-ratelimit-unified-7d",
};

/** The usage windows an answer's headers report; none for most. */
export function usageWindowsOf(
  headers: Headers,
  now: Date = new Date(),
): UsageWindowReadings {
  return { ...codexWindowsOf(headers, now), ...anthropicWindowsOf(headers) };
}

/** A Claude subscription's windows, from `anthropic-ratelimit-unified-*`. */
function anthropicWindowsOf(headers: Headers): UsageWindowReadings {
  const readings: UsageWindowReadings = {};
  for (const [window, prefix] of Object.entries(anthropicWindows) as [
    UsageWindow,
    string,
  ][]) {
    const utilization = headers.get(`${prefix}-utilization`)?.trim();
    const reset = headers.get(`${prefix}-reset`)?.trim();
    if (
      utilization === undefined ||
      reset === undefined ||
      !/^\d+(\.\d+)?$/.test(utilization) ||
      !/^\d{9,11}(\.\d+)?$/.test(reset)
    ) {
      continue;
    }
    readings[window] = {
      // Kept to a tenth of a percent.
      utilization: Math.round(Number(utilization) * 1000) / 10,
      resetsAt: new Date(Number(reset) * 1000),
    };
  }
  return readings;
}

/** A Codex window's length, in minutes, by the window it is. */
const codexWindowMinutes: Record<UsageWindow, number> = {
  five_hour: 5 * 60,
  weekly: 7 * 24 * 60,
};

/** Which window a Codex window of `minutes` is; undefined for neither. */
const codexWindowOf = (minutes: number): UsageWindow | undefined =>
  (Object.entries(codexWindowMinutes) as [UsageWindow, number][]).find(
    // Within a tenth either way, should a plan's window be a little off.
    ([, length]) => Math.abs(minutes - length) <= length / 10,
  )?.[0];

const numberPattern = /^\d+(\.\d+)?$/;

/** A ChatGPT subscription's windows, from `x-codex-primary-*` and `-secondary-*`. */
function codexWindowsOf(headers: Headers, now: Date): UsageWindowReadings {
  const readings: UsageWindowReadings = {};
  for (const [slot, fallback] of [
    ["primary", "five_hour"],
    ["secondary", "weekly"],
  ] as const) {
    const prefix = `x-codex-${slot}`;
    const used = headers.get(`${prefix}-used-percent`)?.trim();
    const minutes = headers.get(`${prefix}-window-minutes`)?.trim();
    const resetAt = headers.get(`${prefix}-reset-at`)?.trim();
    const resetAfter = headers.get(`${prefix}-reset-after-seconds`)?.trim();
    if (used === undefined || !numberPattern.test(used)) {
      continue;
    }
    const window =
      minutes === undefined
        ? fallback
        : numberPattern.test(minutes)
          ? codexWindowOf(Number(minutes))
          : undefined;
    // A time counted from now moves with the clock and the answer's
    // latency, so it is kept to the minute: otherwise each answer would
    // look like a new reset, and be kept in the history.
    const resetsAt =
      resetAt !== undefined && /^\d{9,11}(\.\d+)?$/.test(resetAt)
        ? new Date(Number(resetAt) * 1000)
        : resetAfter !== undefined && numberPattern.test(resetAfter)
          ? new Date(
              Math.round((now.getTime() + Number(resetAfter) * 1000) / 60_000) *
                60_000,
            )
          : undefined;
    // The first to claim a window keeps it.
    if (
      window === undefined ||
      resetsAt === undefined ||
      readings[window] !== undefined
    ) {
      continue;
    }
    readings[window] = {
      // Kept to a tenth of a percent, as a Claude subscription's are.
      utilization: Math.round(Number(used) * 10) / 10,
      resetsAt,
    };
  }
  return readings;
}

// A Claude subscription's usage endpoint (`/api/oauth/usage`, what Claude
// Code's `/usage` shows) reports the same windows without a request having
// to be made through the account: `five_hour` and `seven_day`, each with
// its share used in percent and when it resets (RFC 3339), or a reset of
// null while no window is running (since October 2026, its five-hour one
// until a request starts it). Newer answers may carry them only in
// `limits`, as `session` and `weekly_all`.
// Anthropic does not document it either.
//
// A ChatGPT subscription's usage endpoint (`/backend-api/wham/usage`, what
// Codex's `/status` shows) reports its windows in `rate_limit`, as
// `primary_window` and `secondary_window`: the share used (`used_percent`),
// the window's length (`limit_window_seconds`) and when it resets
// (`reset_at`, seconds since the epoch, or `reset_after_seconds` from now),
// each placed by its length as its headers' are. OpenAI does not document
// it either; it is what Codex reads (`codex-rs/backend-client`).

const bodyWindows: Record<UsageWindow, { field: string; kind: string }> = {
  five_hour: { field: "five_hour", kind: "session" },
  weekly: { field: "seven_day", kind: "weekly_all" },
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * A window's reading from its share used (percent) and reset time; a
 * reset of null is a window not running.
 */
const readingOf = (
  utilization: unknown,
  resetsAt: unknown,
): WindowReading | undefined => {
  if (
    typeof utilization !== "number" ||
    !Number.isFinite(utilization) ||
    utilization < 0 ||
    (typeof resetsAt !== "string" && resetsAt !== null)
  ) {
    return undefined;
  }
  if (resetsAt === null) {
    return { utilization: Math.round(utilization * 10) / 10, resetsAt: null };
  }
  const at = new Date(resetsAt);
  return Number.isNaN(at.getTime())
    ? undefined
    : { utilization: Math.round(utilization * 10) / 10, resetsAt: at };
};

/** A number no less than 0, or undefined. */
const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** A ChatGPT subscription's windows, from its usage endpoint's `rate_limit`. */
function codexBodyWindowsOf(
  rateLimit: Record<string, unknown>,
  now: Date,
): UsageWindowReadings {
  const readings: UsageWindowReadings = {};
  for (const [field, fallback] of [
    ["primary_window", "five_hour"],
    ["secondary_window", "weekly"],
  ] as const) {
    const snapshot = recordOf(rateLimit[field]);
    const used = countOf(snapshot?.["used_percent"]);
    if (snapshot === undefined || used === undefined) {
      continue;
    }
    const seconds = countOf(snapshot["limit_window_seconds"]);
    const window =
      seconds === undefined ? fallback : codexWindowOf(seconds / 60);
    const resetAt = countOf(snapshot["reset_at"]);
    const resetAfter = countOf(snapshot["reset_after_seconds"]);
    // Kept to the minute when counted from now, as its headers' are.
    const resetsAt =
      resetAt !== undefined && resetAt > 0
        ? new Date(resetAt * 1000)
        : resetAfter !== undefined
          ? new Date(
              Math.round((now.getTime() + resetAfter * 1000) / 60_000) * 60_000,
            )
          : undefined;
    // The first to claim a window keeps it.
    if (
      window === undefined ||
      resetsAt === undefined ||
      readings[window] !== undefined
    ) {
      continue;
    }
    readings[window] = { utilization: Math.round(used * 10) / 10, resetsAt };
  }
  return readings;
}

/** The usage windows a subscription's usage endpoint reports. */
export function usageWindowsOfBody(
  body: unknown,
  now: Date = new Date(),
): UsageWindowReadings {
  const usage = recordOf(body);
  const readings: UsageWindowReadings = {};
  if (usage === undefined) {
    return readings;
  }
  const rateLimit = recordOf(usage["rate_limit"]);
  if (rateLimit !== undefined) {
    return codexBodyWindowsOf(rateLimit, now);
  }
  const limits = Array.isArray(usage["limits"]) ? usage["limits"] : [];
  for (const [window, { field, kind }] of Object.entries(bodyWindows) as [
    UsageWindow,
    { field: string; kind: string },
  ][]) {
    const flat = recordOf(usage[field]);
    const limit = limits.map(recordOf).find((each) => each?.["kind"] === kind);
    const reading =
      readingOf(flat?.["utilization"], flat?.["resets_at"]) ??
      readingOf(limit?.["percent"], limit?.["resets_at"]);
    if (reading !== undefined) {
      readings[window] = reading;
    }
  }
  return readings;
}
