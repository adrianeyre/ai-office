import { z } from "zod";

import { pipelineStages, type PipelineStage } from "./pipeline.ts";

// A Floor's wall board (PRD FR-50, FR-57): every issue in progress on the
// Floor, with the Agent working it, its stage and links, and the Floor's
// queues and the rounds its issues have used. Its Notices and its tokens
// against caps come from their own APIs. The server and the web app share
// these.

const count = z.number().int().min(0);
const number = z.number().int().positive();

/** Work at a stage is being done now, or waits for an Agent. */
export const wallBoardWorkStatuses = ["working", "waiting"] as const;
export type WallBoardWorkStatus = (typeof wallBoardWorkStatuses)[number];

/** Each stage, as the wall board names it. */
export const stageNames: Readonly<Record<PipelineStage, string>> = {
  "needs-work": "Work",
  "needs-review": "Review",
  "needs-qa": "QA",
  "needs-docs": "Docs",
  "ready-to-merge": "Ready to merge",
  "needs-human": "Needs the Owner",
};

/** One issue in progress: its work at one stage. */
export const wallBoardIssueSchema = z.object({
  issue: number,
  /** The issue on GitHub. */
  url: z.url(),
  stage: z.enum(pipelineStages),
  status: z.enum(wallBoardWorkStatuses),
  /**
   * The Agents working it, or that it waits for: one Agent, or a review
   * round's required reviewers. Empty when no Agent fits.
   */
  agentIds: z.array(z.string()),
  /** Its pull request, once one is open. */
  pullRequest: z.object({ number, url: z.url() }).nullable(),
  /** The rounds of its Review Loop so far, against the Floor's Round Cap. */
  reviewRounds: count,
  /** The rounds of QA so far, against QA's Round Cap. */
  qaRounds: count,
});
export type WallBoardIssue = z.infer<typeof wallBoardIssueSchema>;

/** The body of `GET /api/floors/:floorId/wall-board`. */
export const floorWallBoardSchema = z.object({
  floorId: z.string(),
  /** The Floor's Round Cap for its Review Loops. */
  roundCap: number,
  /** QA's own Round Cap. */
  qaRoundCap: number,
  /** Every issue in progress: working first, then waiting, oldest first. */
  issues: z.array(wallBoardIssueSchema),
  /** The work waiting and working at each stage, in the pipeline's order. */
  queues: z.array(
    z.object({
      stage: z.enum(pipelineStages),
      waiting: count,
      working: count,
    }),
  ),
  /**
   * Each of the Floor's Agents, oldest first, as the Office shows it (FR-62):
   * how much work waits for it (its pile of tickets), the issues it handed
   * to review that wait on their verdicts, and whether it is paused at a
   * Token Cap.
   */
  agents: z.array(
    z.object({
      agentId: z.string(),
      waiting: count,
      awaitingReview: z.array(number),
      capped: z.boolean(),
    }),
  ),
});
export type FloorWallBoard = z.infer<typeof floorWallBoardSchema>;
