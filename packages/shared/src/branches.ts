import { z } from "zod";

import { avatarSchema } from "./avatar.ts";
import { pipelineStages } from "./pipeline.ts";

// A Floor's AI Office branches, for the Branches page: each branch AI
// Office pushes for an issue (`ai-office/<issue>-<slug>`, PRD FR-19), for a
// one-pull-request Batch's issues (`ai-office/batch-<id>`, ADR 0010) or for
// a Grilling Session's documents (`ai-office/grilling-<id>`, FR-80), as a
// lane off the Floor's default branch, with how far ahead and behind it is,
// its own commits, its issue, pull request and CI, and the Agent working
// on it. Read-only: nothing on the page changes the repository. The server
// and the web app share these.

/** Every branch AI Office makes starts with this. */
export const officeBranchPrefix = "ai-office/";

/** What an AI Office branch is for. */
export type OfficeBranch =
  | { readonly kind: "issue"; readonly issue: number }
  | { readonly kind: "batch"; readonly batchId: number }
  | { readonly kind: "grilling"; readonly sessionId: number };

/**
 * What `name` is for, if AI Office made it: an issue's branch, as
 * `issueBranch()` names it, a one-pull-request Batch's, as `batchBranch()`
 * does, or a Grilling Session's, as `grillingBranch()` does. Undefined for
 * any other branch.
 */
export function officeBranchOf(name: string): OfficeBranch | undefined {
  const batch = /^ai-office\/batch-([1-9]\d*)$/.exec(name);
  if (batch !== null) {
    return { kind: "batch", batchId: Number(batch[1]) };
  }
  const grilling = /^ai-office\/grilling-([1-9]\d*)$/.exec(name);
  if (grilling !== null) {
    return { kind: "grilling", sessionId: Number(grilling[1]) };
  }
  const issue = /^ai-office\/([1-9]\d*)(?:-[a-z0-9][a-z0-9-]*)?$/.exec(name);
  return issue === null
    ? undefined
    : { kind: "issue", issue: Number(issue[1]) };
}

/**
 * When a branch is likely to conflict with the default branch: more than
 * `commits` behind it, or split off it more than `days` ago.
 */
export const behindWarning = { commits: 20, days: 7 } as const;

/** Whether a branch is noticeably behind its default branch, as of `now`. */
export function likelyToConflict(
  branch: { readonly behindBy: number; readonly mergeBaseAt: string },
  now: Date,
): boolean {
  const age = now.getTime() - Date.parse(branch.mergeBaseAt);
  return (
    branch.behindBy > behindWarning.commits ||
    age > behindWarning.days * 24 * 60 * 60 * 1000
  );
}

/** A branch's CI, from the check runs on its head commit. */
export const branchCiStatuses = [
  "none",
  "pending",
  "success",
  "failure",
] as const;
export type BranchCiStatus = (typeof branchCiStatuses)[number];

const count = z.number().int().min(0);
const number = z.number().int().positive();
const time = z.iso.datetime({ offset: true });
/** A page on GitHub: only ever an http(s) address, as it becomes a link. */
const page = z.url({ protocol: /^https?$/ });

/** One commit on a lane, or where a lane split off the default branch. */
export const branchCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** Its subject: the message's first line. */
  message: z.string(),
  /** Its author, as Git has it: the Owner, for AI Office's (ADR 0002). */
  author: z.string(),
  /** Its `Agent:` trailer, naming the Agent that made it; null for none. */
  agent: z.string().nullable(),
  authoredAt: time,
  url: page,
});
export type BranchCommit = z.infer<typeof branchCommitSchema>;

/** Who or what a lane waits on. */
export const branchWorkSchema = z.discriminatedUnion("kind", [
  /** An Agent is working on it now. */
  z.object({
    kind: z.literal("agent"),
    agentId: z.string(),
    name: z.string(),
    /** Its Role's id, or `manager`. */
    role: z.string(),
    /** Its Role's name, as people read it. */
    roleName: z.string(),
    avatar: avatarSchema,
  }),
  /** No Agent is: it waits in a stage of the pipeline. */
  z.object({ kind: z.literal("stage"), stage: z.enum(pipelineStages) }),
]);
export type BranchWork = z.infer<typeof branchWorkSchema>;

/** One AI Office branch, as a lane off the default branch. */
export const branchLaneSchema = z.object({
  name: z.string(),
  /** The branch on GitHub. */
  url: page,
  headSha: z.string(),
  aheadBy: count,
  behindBy: count,
  /** Where it split off the default branch. */
  mergeBase: branchCommitSchema,
  /** Its own commits, oldest first: the newest of them when it has many. */
  commits: z.array(branchCommitSchema),
  /** When its newest commit was made (its merge base's, with none). */
  lastCommitAt: time,
  /** More than `behindWarning` behind the default branch. */
  likelyToConflict: z.boolean(),
  /**
   * The issue it is for: for a Batch's shared branch, the issue being
   * worked on it now; null for a Grilling Session's or a lost issue.
   */
  issue: z.object({ number, title: z.string(), url: page }).nullable(),
  /**
   * The one-pull-request Batch whose shared branch it is (ADR 0010): its
   * issues in the Plan's order, each with where it stands (`closed`, a
   * pipeline stage, or null before it starts).
   */
  batch: z
    .object({
      id: number,
      issues: z.array(
        z.object({
          number,
          stage: z
            .union([z.enum(pipelineStages), z.literal("closed")])
            .nullable(),
        }),
      ),
    })
    .nullable(),
  /** The Grilling Session it holds the documents of. */
  grillingSession: z.object({ id: number, topic: z.string() }).nullable(),
  /** Its open pull request, if it has one. */
  pullRequest: z
    .object({ number, title: z.string(), url: page, draft: z.boolean() })
    .nullable(),
  /** The CI on its head commit. */
  ci: z.enum(branchCiStatuses),
  /** The Agent on it, or the stage it waits in; null when neither. */
  work: branchWorkSchema.nullable(),
});
export type BranchLane = z.infer<typeof branchLaneSchema>;

/** The body of `GET /api/floors/:floorId/branches`. */
export const floorBranchesSchema = z.object({
  floorId: z.string(),
  /** `owner/name` on GitHub. */
  repository: z.string(),
  /** The trunk every lane splits off. */
  defaultBranch: z.object({
    name: z.string(),
    sha: z.string(),
    url: page,
  }),
  /** Newest commit first. */
  lanes: z.array(branchLaneSchema),
  /** When GitHub was last asked. */
  fetchedAt: time,
});
export type FloorBranches = z.infer<typeof floorBranchesSchema>;
