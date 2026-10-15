import { z } from "zod";

import { maxCommandIssues, maxIssueNumber } from "./manager-chat.ts";

// Batches and Plans (PRD FR-25, §5 scenario 1). A Batch is the set of
// issues the Owner hands a Floor's Manager in one command, such as
// "complete issues 1 to 5". The Manager reads the issues and drafts a
// Plan: the order to work them in, which depend on which, the files each
// is likely to change (issues that share one run one after another), who
// works each, and so which run in parallel. Plans are versioned: each
// change to a Batch's Plan is a new version, and the earlier ones are
// kept. With the Floor's plan approval on (the default), work waits for
// the Owner to approve the Plan on the Floor's whiteboard, where they can
// first edit it (reorder, drop and annotate its issues), and the Manager
// replans; with it off, work starts at once. On a Floor with several work
// Roles, a Plan may give an issue an ordered list of them (a merchandiser,
// then a copywriter), which take turns on its one branch, each handing it
// to the next, before review; the Owner can reorder or remove them on the
// whiteboard too (FR-25 (1), ADR 0003). At the Kickoff each Agent the Plan
// assigns acknowledges it once, with "OK" or one concern; when every issue
// is done or blocked the Batch finishes, and its Wrap-up presents the
// results. The server, the web app and the orchestrator share these.

/**
 * Where a Batch is:
 * - `awaiting_approval`: its Plan waits for the Owner's approval (FR-25.3);
 * - `in_progress`: its work has started, each issue once the issues it
 *   depends on are done;
 * - `finished`: every issue is closed or blocked, and its Wrap-up has
 *   presented the results (FR-25.6).
 */
export const batchStatuses = [
  "awaiting_approval",
  "in_progress",
  "finished",
] as const;
export type BatchStatus = (typeof batchStatuses)[number];

export const batchStatusLabels: Record<BatchStatus, string> = {
  awaiting_approval: "Awaiting approval",
  in_progress: "In progress",
  finished: "Finished",
};

/** Who drafted a Plan: the Manager's Model, or AI Office's own rules. */
export const planDrafters = ["model", "rules"] as const;
export type PlanDrafter = (typeof planDrafters)[number];

/** The most files a Plan names for one issue. */
export const maxPlanFiles = 20;
/** The longest file path a Plan names. */
export const maxPlanFileLength = 300;
/** The longest note on one of a Plan's issues. */
export const maxPlanNoteLength = 500;
/** The longest summary of a Plan. */
export const maxPlanSummaryLength = 2000;
/** The longest annotation the Owner writes on one of a Plan's issues. */
export const maxPlanAnnotationLength = 500;
/** The most work Roles a Plan gives one issue, to take turns on its branch. */
export const maxPlanRoles = 5;

const issueNumberSchema = z.number().int().positive().max(maxIssueNumber);

/** One issue of the Plan the Manager's Model drafts, as it must answer it. */
const draftIssueSchema = z.strictObject({
  issue: z
    .number({ error: "issue is the issue's number." })
    .int({ error: "issue is the issue's number." })
    .positive({ error: "issue is the issue's number." }),
  /** The issues in the Batch to finish before this one starts. */
  dependsOn: z
    .array(
      z
        .number({ error: "dependsOn lists issue numbers." })
        .int({ error: "dependsOn lists issue numbers." })
        .positive({ error: "dependsOn lists issue numbers." }),
      { error: "dependsOn is a list of issue numbers." },
    )
    .max(maxCommandIssues),
  /** The repository's files it is likely to change. */
  files: z
    .array(
      z
        .string({ error: "Each file is a path in the repository." })
        .trim()
        .min(1, { error: "A file path cannot be empty." })
        .max(maxPlanFileLength, {
          error: `A file path is at most ${String(maxPlanFileLength)} characters.`,
        }),
      { error: "files is a list of paths." },
    )
    .max(maxPlanFiles, {
      error: `Name at most ${String(maxPlanFiles)} files for an issue.`,
    }),
  /** The name of the coder to work it; null to let AI Office choose. */
  agent: z
    .string({ error: "agent is a coder's name, or null." })
    .trim()
    .min(1, { error: "agent is a coder's name, or null." })
    .nullable(),
  /**
   * The work Roles to work it, by name, in the order they take turns on its
   * branch; one by default. Left out, or empty, the Manager's triage
   * chooses its one Role as the issue starts.
   */
  roles: z
    .array(
      z
        .string({ error: "Each of roles is a work Role's name." })
        .trim()
        .min(1, { error: "Each of roles is a work Role's name." }),
      { error: "roles is a list of work Roles' names." },
    )
    .max(maxPlanRoles, {
      error: `Give an issue at most ${String(maxPlanRoles)} work Roles.`,
    })
    .optional(),
  /** Why the issue is where it is, in a sentence; may be empty. */
  note: z
    .string({ error: "note is a sentence, or empty." })
    .trim()
    .max(maxPlanNoteLength, {
      error: `A note is at most ${String(maxPlanNoteLength)} characters.`,
    }),
});

/**
 * The Plan the Manager's Model drafts for a Batch, as it must answer it:
 * every issue once, in the order to work them.
 */
export const planDraftSchema = z.strictObject({
  summary: z
    .string({ error: "Give the Plan's summary." })
    .trim()
    .min(1, { error: "Give the Plan's summary." })
    .max(maxPlanSummaryLength, {
      error: `The summary is at most ${String(maxPlanSummaryLength)} characters.`,
    }),
  issues: z
    .array(draftIssueSchema, { error: "issues is a list." })
    .min(1, { error: "Plan every issue in the Batch." })
    .max(maxCommandIssues),
});
export type PlanDraft = z.infer<typeof planDraftSchema>;

/** One issue of a Plan, as AI Office keeps it. */
export const planItemSchema = z.object({
  issue: issueNumberSchema,
  /** Its title on GitHub, as the Manager read it (redacted). */
  title: z.string(),
  /**
   * The issues in the Batch to finish (close, by a merged pull request)
   * before work on it starts: those it builds on, and any earlier issue it
   * shares a likely file with.
   */
  dependsOn: z.array(issueNumberSchema),
  /** The repository's files it is likely to change. */
  files: z.array(z.string()),
  /**
   * The coder it is given to, in its first work Role when it has `roles`;
   * null when the Floor has none to give it to.
   */
  agentId: z.string().nullable(),
  /**
   * The work Roles (library Roles' ids) that work it, in turn, on its one
   * branch, each handing it to the next, before review starts after the
   * last (FR-25 (1)). Absent or empty, the Manager's triage gives it one as
   * it starts (FR-23).
   */
  roles: z.array(z.string()).max(maxPlanRoles).optional(),
  /** Why it is where it is, in a sentence; may be empty. */
  note: z.string(),
  /** The Owner's annotation on it, from the whiteboard (redacted), if any. */
  annotation: z.string().optional(),
});
export type PlanItem = z.infer<typeof planItemSchema>;

/** Two issues likely to change the same files: they run one after another. */
export const planOverlapSchema = z.object({
  /** The earlier issue in the Plan's order, then the later. */
  issues: z.tuple([issueNumberSchema, issueNumberSchema]),
  files: z.array(z.string()).min(1),
});
export type PlanOverlap = z.infer<typeof planOverlapSchema>;

/** An issue the Owner named that the Batch leaves out, and why. */
export const planLeftOutSchema = z.object({
  issue: issueNumberSchema,
  reason: z.string(),
});
export type PlanLeftOut = z.infer<typeof planLeftOutSchema>;

/** One version of a Batch's Plan. */
export const planSchema = z.object({
  batchId: z.number().int().positive(),
  /** 1 for the Manager's first draft, then one more for each change. */
  version: z.number().int().positive(),
  draftedBy: z.enum(planDrafters),
  /** The Floor's Manager, whose Plan it is. */
  agentId: z.string(),
  /** The Plan in a few sentences, for the Owner. */
  summary: z.string(),
  /** The Batch's issues, in the order to work them. */
  items: z.array(planItemSchema),
  overlaps: z.array(planOverlapSchema),
  /**
   * Which issues run in parallel: groups in the order they run, each
   * group's issues at once. An issue's group follows every group holding
   * an issue it depends on.
   */
  parallel: z.array(z.array(issueNumberSchema)),
  leftOut: z.array(planLeftOutSchema),
  /**
   * The version the Owner edited on the whiteboard, which the Manager
   * replanned as this one; null for a Plan the Owner did not edit.
   */
  editedFrom: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Plan = z.infer<typeof planSchema>;

/** The longest concern an Agent raises at a Kickoff. */
export const maxKickoffConcernLength = 300;

/** How an Agent answers the Plan at the Kickoff (FR-25.2). */
export const kickoffResponses = ["ok", "concern"] as const;
export type KickoffResponse = (typeof kickoffResponses)[number];

/**
 * Who acknowledged: the Agent's own Model, or AI Office's rules for it
 * (an "OK"), when the Agent is paused, has no Model or its call failed.
 */
export const acknowledgers = ["model", "rules"] as const;
export type Acknowledger = (typeof acknowledgers)[number];

/**
 * One assigned Agent's acknowledgement of the Plan at the Kickoff
 * (FR-25.2): "OK" or one concern, once. Agents do not converse.
 */
export const acknowledgementSchema = z.object({
  agentId: z.string(),
  /** The version of the Plan presented. */
  planVersion: z.number().int().positive(),
  response: z.enum(kickoffResponses),
  /** The concern, redacted, one line; null for "OK". */
  concern: z.string().max(maxKickoffConcernLength).nullable(),
  by: z.enum(acknowledgers),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

/**
 * What came of one of a Batch's issues, as its Wrap-up presents it:
 * - `merged`: closed by its merged pull request;
 * - `closed`: closed without a merged pull request;
 * - `blocked`: handed to the Owner at `needs-human`;
 * - `not_started`: never started, as an issue it depends on is blocked.
 */
export const wrapUpOutcomes = [
  "merged",
  "closed",
  "blocked",
  "not_started",
] as const;
export type WrapUpOutcome = (typeof wrapUpOutcomes)[number];

export const wrapUpOutcomeLabels: Record<WrapUpOutcome, string> = {
  merged: "Merged",
  closed: "Closed",
  blocked: "Blocked",
  not_started: "Not started",
};

const tokenCount = z.number().int().min(0);

/** One issue of a Batch, as its Wrap-up presents it (FR-25.6). */
export const wrapUpIssueSchema = z.object({
  issue: issueNumberSchema,
  /** Its title, as the Plan has it (redacted). */
  title: z.string(),
  outcome: z.enum(wrapUpOutcomes),
  /** Its pull request; null when it has none. */
  pullRequest: z
    .object({ number: issueNumberSchema, url: z.string() })
    .nullable(),
  /** The coder the Plan gave it to; null for none. */
  agentId: z.string().nullable(),
  /** Rounds of the Review Loop and of QA it took. */
  rounds: z.object({ review: tokenCount, qa: tokenCount }),
  /** Tokens its model calls used (input plus output, FR-31). */
  tokens: tokenCount,
  /** For information only (FR-31): its priced model calls. */
  estimatedCostUsd: z.number().min(0),
});
export type WrapUpIssue = z.infer<typeof wrapUpIssueSchema>;

/** A finished Batch's results, as its Wrap-up presents them (FR-25.6). */
export const wrapUpSchema = z.object({
  /** The version of the Plan it finished on. */
  planVersion: z.number().int().positive(),
  /** Its Plan's issues, in the Plan's order. */
  issues: z.array(wrapUpIssueSchema),
  /** The issues the Batch left out, and why. */
  leftOut: z.array(planLeftOutSchema),
  totals: z.object({
    merged: tokenCount,
    closed: tokenCount,
    blocked: tokenCount,
    notStarted: tokenCount,
    tokens: tokenCount,
    estimatedCostUsd: z.number().min(0),
  }),
});
export type WrapUp = z.infer<typeof wrapUpSchema>;

/** A Batch, with its latest Plan. */
export const batchSchema = z.object({
  id: z.number().int().positive(),
  floorId: z.string(),
  /** The issues the Owner named, in the order named. */
  issues: z.array(issueNumberSchema),
  status: z.enum(batchStatuses),
  /** The Floor's Manager, whose Batch it is. */
  agentId: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  /** When its work started; null while it awaits approval. */
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  /** The issues whose work has started, in the order they started. */
  started: z.array(issueNumberSchema),
  /**
   * Its issues are worked one after another on one branch and go in one
   * pull request, as "complete issues 1 to 5 in one PR" asks (ADR 0010).
   */
  onePullRequest: z.boolean(),
  plan: planSchema,
  /** The Kickoff's acknowledgements, one per assigned Agent, as they came. */
  acknowledgements: z.array(acknowledgementSchema),
  /** When it finished; null until then. */
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Its Wrap-up's results; null until it finishes. */
  wrapUp: wrapUpSchema.nullable(),
});
export type Batch = z.infer<typeof batchSchema>;

/** `GET /api/floors/:floorId/batches`: newest first. */
export const batchListSchema = z.object({ batches: z.array(batchSchema) });
export type BatchList = z.infer<typeof batchListSchema>;

/** `GET /api/floors/:floorId/batches/:batchId`: every version of its Plan. */
export const batchDetailSchema = z.object({
  batch: batchSchema,
  /** Oldest version first. */
  plans: z.array(planSchema),
});
export type BatchDetail = z.infer<typeof batchDetailSchema>;

/**
 * `POST /api/floors/:floorId/batches/:batchId/plan`: the Owner's edits to
 * the Plan awaiting approval, made on the whiteboard (FR-25.3). `items` is
 * the issues to keep, in the new order, each with the Owner's annotation
 * (empty for none) and, for an issue the Plan gives work Roles, those to
 * keep in the order they take turns; an issue of the Plan left out of it
 * is dropped from the Batch. The Manager then replans, as the next version.
 */
export const planEditSchema = z.strictObject({
  /** The version edited: the Plan's latest, or the edit is refused. */
  version: z.number().int().positive(),
  items: z
    .array(
      z.strictObject({
        issue: issueNumberSchema,
        annotation: z
          .string()
          .trim()
          .max(maxPlanAnnotationLength, {
            error: `An annotation is at most ${String(maxPlanAnnotationLength)} characters.`,
          }),
        /**
         * The issue's work Roles to keep (ids), in their new order: some or
         * all of those the Plan gives it, at least one. Absent: as they are.
         */
        roles: z
          .array(z.string().min(1))
          .min(1, {
            error:
              "Keep at least one work Role: an issue cannot drop every Role.",
          })
          .max(maxPlanRoles)
          .optional(),
      }),
    )
    .min(1, {
      error: "Keep at least one issue: a Plan cannot drop every issue.",
    })
    .max(maxCommandIssues),
});
export type PlanEdit = z.infer<typeof planEditSchema>;

/**
 * `POST /api/floors/:floorId/batches/:batchId/approve`: the Owner approves
 * the Plan, and work starts as it says (FR-25.3).
 */
export const planApprovalSchema = z.strictObject({
  /** The version approved: the Plan's latest, or the approval is refused. */
  version: z.number().int().positive(),
});
export type PlanApproval = z.infer<typeof planApprovalSchema>;

/** Where the Owner reads a Floor's Plans, and edits and approves them: its whiteboard. */
export const whiteboardPath = (floorId: string, batchId?: number): string =>
  `/floors/${encodeURIComponent(floorId)}/whiteboard${
    batchId === undefined ? "" : `?batch=${String(batchId)}`
  }`;

export const batchErrorCodes = {
  /** The Floor has no such Batch. */
  batchNotFound: "batch_not_found",
  /** The Batch's Plan is no longer awaiting approval: its work has started. */
  notAwaitingApproval: "batch_not_awaiting_approval",
  /** The Plan has a newer version than the one edited or approved. */
  planChanged: "plan_changed",
  /** The edit does not fit the Plan, such as an issue not in it. */
  invalidPlanEdit: "invalid_plan_edit",
} as const;
export type BatchErrorCode =
  (typeof batchErrorCodes)[keyof typeof batchErrorCodes];
