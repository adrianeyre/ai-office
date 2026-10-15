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

/** Failures in a row of an issue's work at a stage before escalating. */
export const defaultMaxFailures = 3;

/** Restarts of an issue's stalled work at a stage before escalating. */
export const defaultMaxStallRestarts = 2;

/** Failed tasks in a row, on more than one issue, that pause an Agent. */
export const defaultAgentFailures = 3;
