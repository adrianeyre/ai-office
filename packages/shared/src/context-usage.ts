import { z } from "zod";

import type { PaletteToken } from "./palette.ts";

// Context Usage (PRD FR-84, FR-85): how full an Agent's working context is,
// the share of its Model's context window its latest model call used. The
// server measures it as model calls pass through the AI Gateway; the 2D
// views and the 3D displays show it in the same colours.

/** Its colour band: green below 60%, amber from 60%, red from 85%. */
export const contextUsageBands = ["green", "amber", "red", "unknown"] as const;
export type ContextUsageBand = (typeof contextUsageBands)[number];

/** Where amber and red start, as shares of the context window. */
export const contextUsageAmberFrom = 0.6;
export const contextUsageRedFrom = 0.85;

/**
 * The band of a Context Usage from 0 to 1; `unknown` when it is not known,
 * such as when the model catalogue has no context window for the Model.
 */
export function contextUsageBand(usage: number | null): ContextUsageBand {
  if (usage === null || !Number.isFinite(usage)) {
    return "unknown";
  }
  return usage >= contextUsageRedFrom
    ? "red"
    : usage >= contextUsageAmberFrom
      ? "amber"
      : "green";
}

/** Each band's colour in the Office palette. */
export const contextUsageBandTokens: Readonly<
  Record<ContextUsageBand, PaletteToken>
> = {
  green: "state-ok",
  amber: "state-warning",
  red: "state-critical",
  unknown: "state-neutral",
};

/**
 * A Context Usage from `inputTokens` of a `contextWindow`, from 0 to 1;
 * null when the window is unknown (never 0%). A call larger than the
 * catalogue's window counts as full.
 */
export function contextUsageOf(
  inputTokens: number,
  contextWindow: number | null,
): number | null {
  if (contextWindow === null || contextWindow <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, inputTokens / contextWindow));
}

/**
 * A Context Usage in whole percent, rounded down (`0.29` is 29, not the
 * 28 floating point would give).
 */
export const contextUsagePercent = (usage: number): number =>
  Math.floor(usage * 100 + 1e-9);

/** A Context Usage as people read it: `42%`, or `Unknown`. */
export const contextUsageText = (usage: number | null): string =>
  usage === null ? "Unknown" : `${String(contextUsagePercent(usage))}%`;

/**
 * One Agent's Context Usage in its current session, as
 * `GET /api/floors/:floorId/context-usage` lists it.
 */
export const agentContextUsageSchema = z.object({
  agentId: z.string(),
  floorId: z.string(),
  /** The issue its latest model call was for; null when it named none. */
  issue: z.number().int().positive().nullable(),
  /** The Model of its latest model call. */
  model: z.string(),
  /** That call's input tokens, cached ones included. */
  inputTokens: z.number().int().min(0),
  /** The Model's context window from the catalogue; null when unknown. */
  contextWindow: z.number().int().positive().nullable(),
  /** From 0 to 1; null when the context window is unknown. */
  contextUsage: z.number().min(0).max(1).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AgentContextUsage = z.infer<typeof agentContextUsageSchema>;

/**
 * The body of `GET /api/floors/:floorId/context-usage`: each of the Floor's
 * Agents with a session going. An Agent without one is not listed.
 */
export const floorContextUsageSchema = z.object({
  agents: z.array(agentContextUsageSchema),
});
export type FloorContextUsage = z.infer<typeof floorContextUsageSchema>;

/**
 * The Context Usage, in percent, at which a sandbox Agent makes a Fresh
 * Start unless its Floor or itself says otherwise (FR-86).
 */
export const defaultFreshStartThreshold = 85;

/** A Fresh Start threshold, in whole percent. */
export const freshStartThresholdSchema = z
  .number({ error: "The Fresh Start threshold is a whole percentage." })
  .int({ error: "The Fresh Start threshold is a whole percentage." })
  .min(10, { error: "The Fresh Start threshold is at least 10%." })
  .max(100, { error: "The Fresh Start threshold is at most 100%." });

/**
 * How many Fresh Starts one task may make (FR-86): the next one pauses
 * the Agent and raises an action Notice instead.
 */
export const defaultFreshStartCap = 3;

/** The body of `POST /api/floors/:floorId/agents/:agentId/fresh-start`. */
export const freshStartResponseSchema = z.object({
  /** The session being ended, as the Agent writes its summary. */
  session: z.string(),
});
export type FreshStartResponse = z.infer<typeof freshStartResponseSchema>;

export const freshStartErrorCodes = {
  /** The Agent has no sandbox session going: there is nothing to end. */
  noSession: "no_session",
} as const;
export type FreshStartErrorCode =
  (typeof freshStartErrorCodes)[keyof typeof freshStartErrorCodes];

const summaryItem = z.string().trim().min(1).max(500);
const summaryList = z.array(summaryItem).max(30);

/**
 * The summary an Agent writes for itself at a Fresh Start (FR-86), which
 * its next session starts from.
 */
export const freshStartSummarySchema = z.strictObject({
  /** What is finished. */
  done: summaryList,
  /** What was under way when the session ended. */
  inProgress: summaryList,
  /** What to do next, in order. */
  nextSteps: summaryList,
  /** Decisions made, and why, so the next session keeps them. */
  decisions: summaryList,
  /** The files it changed or was working on. */
  filesTouched: z.array(z.string().trim().min(1).max(300)).max(200),
});
export type FreshStartSummary = z.infer<typeof freshStartSummarySchema>;
