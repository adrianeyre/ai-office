import { z } from "zod";

import { maxAnalyticsDays } from "./analytics.ts";
import { stages } from "./roles.ts";
import { issueSizes } from "./triage.ts";

// The Scorecard (Scorecards PRD, FR-126 to FR-131, FR-135): how the work of
// each Agent, Role and Model turned out. When a piece of work ends (its
// issue merged or closed, or handed to the Owner) AI Office records it, a
// row for each Agent that worked a Stage of it and each Model that served
// that Agent's requests, in a store of its own (`scorecard_records`), kept
// for its own retention period. The Scorecard section of Analytics adds
// them up over the Analytics range, by Agent, Role, Model, Floor or Size.

/** How a piece of work ended. */
export const scorecardOutcomes = [
  "merged",
  "closed",
  "handed_to_owner",
] as const;
export type ScorecardOutcome = (typeof scorecardOutcomes)[number];

export const scorecardOutcomeLabels: Record<ScorecardOutcome, string> = {
  merged: "Merged",
  closed: "Closed",
  handed_to_owner: "Handed to the Owner",
};

/** What the Scorecard can be broken down by (FR-130, FR-135). */
export const scorecardDimensions = [
  "agent",
  "role",
  "model",
  "floor",
  "size",
] as const;
export type ScorecardDimension = (typeof scorecardDimensions)[number];

export const scorecardDimensionLabels: Record<ScorecardDimension, string> = {
  agent: "Agent",
  role: "Role",
  model: "Model",
  floor: "Floor",
  size: "Size",
};

const count = z.number().int().min(0);

/**
 * One Agent's part in a piece of work that ended, with one Model that
 * served it (FR-126): what the Scorecard is added up from.
 */
export const scorecardRecordSchema = z.object({
  floorId: z.string().min(1),
  issue: z.number().int().positive(),
  agentId: z.string().min(1),
  /** Its name and Role (a library Role's id) when the work ended. */
  agentName: z.string().min(1),
  role: z.string().min(1),
  /** Its Role's Stage. */
  stage: z.enum(stages),
  /** Whether it was a Contractor (ADR 0004). */
  contractor: z.boolean(),
  /**
   * The Model that served its requests, as the AI Gateway recorded it;
   * its configured Model, or empty, when it made none.
   */
  model: z.string(),
  /** The issue's Size, from its triage (FR-135); null when it had none. */
  size: z.enum(issueSizes).nullable(),
  outcome: z.enum(scorecardOutcomes),
  // The issue's own course, the same on each of its rows.
  /** Review Loop rounds until every reviewer approved; null if none did. */
  roundsToApproval: z.number().int().positive().nullable(),
  /** QA rounds that failed. */
  qaRoundsFailed: count,
  // Charged to this Agent alone, on its first row.
  /** The watchdog's stalls and failures while it held the work. */
  stalls: count,
  failures: count,
  /** As a reviewer: the rounds it reviewed, and its blocking comments. */
  roundsReviewed: count,
  blockingComments: count,
  // What its requests on the issue used, with this Model.
  inputTokens: count,
  outputTokens: count,
  estimatedCostUsd: z.number().min(0),
  endedAt: z.iso.datetime({ offset: true }),
});
export type ScorecardRecord = z.infer<typeof scorecardRecordSchema>;

/**
 * The query of `GET /api/analytics/scorecard`: the Analytics range, its
 * "by", and, from an Agent's card (FR-131), only that Agent's records.
 */
export const scorecardQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    by: z.enum(scorecardDimensions).default("agent"),
    agentId: z.string().min(1).max(200).optional(),
  })
  .superRefine((query, context) => {
    const span = Date.parse(query.to) - Date.parse(query.from);
    if (span <= 0) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "The range must end after it starts.",
      });
    } else if (span > maxAnalyticsDays * 24 * 60 * 60 * 1000) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: `The Scorecard reads at most ${String(maxAnalyticsDays)} days at a time.`,
      });
    }
  });
export type ScorecardQuery = z.infer<typeof scorecardQuerySchema>;

/** What a group of records came to, by its key. */
const groupShape = {
  /** An Agent's id, a Role's id, a Model, a Floor's id or a Size. */
  key: z.string(),
  /** How the Scorecard names it. */
  label: z.string(),
  /** The Floor it belongs to, for an Agent. */
  floorId: z.string().nullable(),
  /** The pieces of work it had a part in. */
  issues: count,
};

/** One group's Scorecard for work, QA and docs (FR-128). */
export const scorecardWorkItemSchema = z.object({
  ...groupShape,
  issuesMerged: count,
  /** Mean Review Loop rounds until approval; null when none was approved. */
  meanRoundsToApproval: z.number().min(0).nullable(),
  qaRoundsFailed: count,
  stalls: count,
  failures: count,
  handedToOwner: count,
  tokens: count,
  estimatedCostUsd: z.number().min(0),
  /** Tokens and estimated cost per merged issue; null with none merged. */
  tokensPerMergedIssue: z.number().min(0).nullable(),
  costPerMergedIssue: z.number().min(0).nullable(),
});
export type ScorecardWorkItem = z.infer<typeof scorecardWorkItemSchema>;

/** One group's Scorecard for reviewers (FR-129). */
export const scorecardReviewItemSchema = z.object({
  ...groupShape,
  roundsReviewed: count,
  blockingComments: count,
  /** Blocking comments per round reviewed; null with none reviewed. */
  blockingPerRound: z.number().min(0).nullable(),
  tokens: count,
  estimatedCostUsd: z.number().min(0),
});
export type ScorecardReviewItem = z.infer<typeof scorecardReviewItemSchema>;

/** The body of `GET /api/analytics/scorecard`. */
export const scorecardSchema = z.object({
  by: z.enum(scorecardDimensions),
  /** Work, QA and docs Agents' records, most issues merged first. */
  work: z.array(scorecardWorkItemSchema),
  /** Reviewers' records, most rounds reviewed first. */
  review: z.array(scorecardReviewItemSchema),
});
export type Scorecard = z.infer<typeof scorecardSchema>;

/**
 * An Agent's one-line Scorecard for its card (FR-131): its work over the
 * last 30 days.
 */
export const agentScorecardSchema = z.object({
  agentId: z.string(),
  /** Days it covers, back from now. */
  days: z.number().int().positive(),
  stage: z.enum(stages).nullable(),
  issues: count,
  issuesMerged: count,
  meanRoundsToApproval: z.number().min(0).nullable(),
  costPerMergedIssue: z.number().min(0).nullable(),
  roundsReviewed: count,
  blockingPerRound: z.number().min(0).nullable(),
});
export type AgentScorecard = z.infer<typeof agentScorecardSchema>;

/** The body of `GET /api/floors/:floorId/scorecards`: each Agent's line. */
export const agentScorecardListSchema = z.object({
  scorecards: z.array(agentScorecardSchema),
});

/** How many days an Agent's card covers (FR-131). */
export const agentScorecardDays = 30;
