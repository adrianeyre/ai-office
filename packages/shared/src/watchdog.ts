import { z } from "zod";

import { aiProviders } from "./agents.ts";

// The Manager's watchdog and its authority (PRD FR-23): in plain code, it
// spots work that has stalled, work that keeps failing, and Review Loops
// close to their Round Cap. It may retry, reassign, relabel, pause or
// escalate with a Notice, and nothing more: it may never merge, change
// repository settings or raise any cap, whoever asks. Every decision is a
// comment on the issue and a `manager.decision` event; every refusal a
// `manager.action_refused` event.

/** What the Manager may do on its own authority. */
export const managerActions = [
  "retry",
  "reassign",
  "relabel",
  "pause",
  "escalate",
] as const;
export type ManagerAction = (typeof managerActions)[number];

/** What the Manager may never do: each is refused by a permission check. */
export const forbiddenManagerActions = [
  "merge",
  "change_repository_settings",
  "raise_cap",
] as const;
export type ForbiddenManagerAction = (typeof forbiddenManagerActions)[number];

export const isManagerAction = (action: string): action is ManagerAction =>
  (managerActions as readonly string[]).includes(action);

export const managerActionLabels: Record<ManagerAction, string> = {
  retry: "Retried",
  reassign: "Reassigned",
  relabel: "Relabelled",
  pause: "Paused an Agent",
  escalate: "Escalated",
};

/**
 * What led to a decision: work that `stalled` (no sign of progress past
 * its timeout), work `failing` again and again, or a Review Loop
 * `near_cap`.
 */
export const watchdogTriggers = ["stalled", "failing", "near_cap"] as const;
export type WatchdogTrigger = (typeof watchdogTriggers)[number];

/** How long running work may show no progress before it has stalled. */
export const defaultStallTimeoutMinutes = 20;
/** The shortest and longest stall timeout the Owner may set, in minutes. */
export const minStallTimeoutMinutes = 5;
export const maxStallTimeoutMinutes = 240;

/** How long a sandbox may run in all before it is killed. */
export const defaultSandboxTimeLimitMinutes = 60;
/** The shortest and longest sandbox time limit the Owner may set. */
export const minSandboxTimeLimitMinutes = 10;
export const maxSandboxTimeLimitMinutes = 480;

/** Failures in a row of an issue's work at a stage before escalating. */
export const defaultMaxFailures = 3;

/** Restarts of an issue's stalled work at a stage before escalating. */
export const defaultMaxStallRestarts = 2;

/** Failed tasks in a row, on more than one issue, that pause an Agent. */
export const defaultAgentFailures = 3;

// The watchdog's time limits (FR-23, FR-22), set at runtime in General
// Settings: the stall timeout and the sandbox time limit, office-wide, and
// optionally each AI Provider's own, so a slower local one (Ollama, say)
// can be given longer. The server and the web app share these.

const minutes = (what: string, min: number, max: number) =>
  z
    .number({ error: `${what} is a whole number of minutes.` })
    .int({ error: `${what} is a whole number of minutes.` })
    .min(min, { error: `${what} is at least ${String(min)} minutes.` })
    .max(max, { error: `${what} is at most ${String(max)} minutes.` });

const stallTimeoutMinutesSchema = minutes(
  "The stall timeout",
  minStallTimeoutMinutes,
  maxStallTimeoutMinutes,
);
const sandboxTimeLimitMinutesSchema = minutes(
  "The sandbox time limit",
  minSandboxTimeLimitMinutes,
  maxSandboxTimeLimitMinutes,
);

/** An AI Provider's own limits; each absent one is the office's. */
export const watchdogOverrideSchema = z.strictObject({
  stallTimeoutMinutes: stallTimeoutMinutesSchema.optional(),
  sandboxTimeLimitMinutes: sandboxTimeLimitMinutesSchema.optional(),
});
export type WatchdogOverride = z.infer<typeof watchdogOverrideSchema>;

/** `GET` and `PUT /api/office/watchdog`. */
export const watchdogSettingsSchema = z.strictObject({
  /** How long running work may show no progress before it has stalled. */
  stallTimeoutMinutes: stallTimeoutMinutesSchema,
  /** How long a sandbox may run in all before it is killed. */
  sandboxTimeLimitMinutes: sandboxTimeLimitMinutesSchema,
  /** Each AI Provider's own limits, for its Agents; none by default. */
  providers: z.partialRecord(
    z.enum(aiProviders, { error: "Choose one of the AI Providers." }),
    watchdogOverrideSchema,
  ),
});
export type WatchdogSettings = z.infer<typeof watchdogSettingsSchema>;

/** Until the Owner chooses: 20 minutes to stall, an hour per sandbox. */
export const defaultWatchdogSettings: WatchdogSettings = {
  stallTimeoutMinutes: defaultStallTimeoutMinutes,
  sandboxTimeLimitMinutes: defaultSandboxTimeLimitMinutes,
  providers: {},
};

/**
 * The limits for an Agent of `aiProvider`: its AI Provider's own where it
 * has them, the office's otherwise.
 */
export const watchdogLimitsFor = (
  settings: WatchdogSettings,
  aiProvider: string | undefined,
): { stallTimeoutMinutes: number; sandboxTimeLimitMinutes: number } => {
  const own =
    aiProvider === undefined
      ? undefined
      : (settings.providers as Partial<Record<string, WatchdogOverride>>)[
          aiProvider
        ];
  return {
    stallTimeoutMinutes:
      own?.stallTimeoutMinutes ?? settings.stallTimeoutMinutes,
    sandboxTimeLimitMinutes:
      own?.sandboxTimeLimitMinutes ?? settings.sandboxTimeLimitMinutes,
  };
};
