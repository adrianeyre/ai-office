import { z } from "zod";

// Load balancing (PRD FR-37, FR-38): how the AI Gateway chooses which AI
// Account serves each request, chosen at runtime in the office admin. The
// server and the web app share these.

/**
 * The strategies (FR-37):
 * - `session` keeps each Agent session (or Owner tool) on one account for
 *   a window from when it started there, starting new ones on the account
 *   with the fewest sessions;
 * - `session_affinity` keeps each session on its account for as long as it
 *   is in use (each call renews it; it lapses after the session window
 *   without one), starting new ones on the least-used account;
 * - `drain_soonest` starts each new session on the account whose usage
 *   window resets first, so its capacity is used before it would be lost,
 *   keeping sessions on their accounts as session-affinity does;
 * - `drain_soonest_strict` sends every request to the account whose usage
 *   window resets first, moving sessions as soon as another resets sooner;
 * - `least_used` sends each request to the account that has used the
 *   fewest tokens lately.
 */
export const loadBalancingStrategies = [
  "session",
  "session_affinity",
  "drain_soonest",
  "drain_soonest_strict",
  "least_used",
] as const;
export type LoadBalancingStrategy = (typeof loadBalancingStrategies)[number];

export const loadBalancingStrategyLabels: Record<
  LoadBalancingStrategy,
  string
> = {
  session: "Session",
  session_affinity: "Session affinity",
  drain_soonest: "Drain soonest",
  drain_soonest_strict: "Drain soonest (strict)",
  least_used: "Least used",
};

/** The shortest and longest session window, in minutes. */
export const minSessionWindowMinutes = 1;
export const maxSessionWindowMinutes = 7 * 24 * 60;

/** `GET` and `PUT /api/office/load-balancing`. */
export const loadBalancingSettingsSchema = z.strictObject({
  strategy: z.enum(loadBalancingStrategies, {
    error:
      "Choose session, session_affinity, drain_soonest, drain_soonest_strict or least_used.",
  }),
  /**
   * How long a session stays on its account: from when it started there
   * (session), or since its last call (session-affinity and drain-soonest).
   */
  sessionWindowMinutes: z
    .number({ error: "The session window is a whole number of minutes." })
    .int({ error: "The session window is a whole number of minutes." })
    .min(minSessionWindowMinutes, {
      error: `The session window is at least ${String(minSessionWindowMinutes)} minute.`,
    })
    .max(maxSessionWindowMinutes, {
      error: `The session window is at most ${String(maxSessionWindowMinutes)} minutes (7 days).`,
    }),
});
export type LoadBalancingSettings = z.infer<typeof loadBalancingSettingsSchema>;

/** Until the Owner chooses: sessions, for five hours (FR-37). */
export const defaultLoadBalancingSettings: LoadBalancingSettings = {
  strategy: "session",
  sessionWindowMinutes: 5 * 60,
};

/**
 * The window least-used counts tokens over: five hours, as long as
 * subscriptions' usage windows.
 */
export const leastUsedWindowMs = 5 * 60 * 60 * 1000;

/**
 * Usage throttling (FR-38): optional pacing gates on each AI Account's
 * five-hour and weekly usage windows, applied after the strategy chose.
 * With a gate on, an account whose window is being used faster than an
 * even pace (plus `pacingHeadroomPercent`) is held back until the pace
 * catches up with it, so a window is spread over its length rather than
 * spent at its start. Accounts whose AI Provider reports no windows (API
 * keys) are never paced. Both off until the Owner turns them on.
 */
export const usageThrottlingSettingsSchema = z.strictObject({
  fiveHourPacing: z.boolean({
    error: "Say whether the five-hour pacing gate is on.",
  }),
  weeklyPacing: z.boolean({
    error: "Say whether the weekly pacing gate is on.",
  }),
});
export type UsageThrottlingSettings = z.infer<
  typeof usageThrottlingSettingsSchema
>;

export const defaultUsageThrottlingSettings: UsageThrottlingSettings = {
  fiveHourPacing: false,
  weeklyPacing: false,
};

/**
 * How far ahead of an even pace a window may be, in percentage points:
 * an hour into a five-hour window (20%), up to 30% of it may be used.
 */
export const pacingHeadroomPercent = 10;

/** How long each usage window is. */
export const usageWindowLengthsMs = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
} as const;
