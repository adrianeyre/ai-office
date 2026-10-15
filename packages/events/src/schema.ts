import {
  aiAccountLimitReasons,
  connectionTypes,
  issuePriorities,
  maxCommandIssues,
  maxMemoryEntries,
  maxMemoryEntryLength,
  maxMemoryProposals,
  memoryCurationReasons,
  memoryCurators,
  maxOfficeMemoryLength,
  maxRoleMemoryReasonLength,
  roleMemoryDeciders,
  planDrafters,
  acknowledgers,
  kickoffResponses,
  maxKickoffConcernLength,
  managerActions,
  qaResults,
  designResults,
  reviewVerdicts,
  roleIdSchema,
  routeJudges,
  skillSources,
  stages,
  floorTemplateSources,
  templateIdSchema,
  tokenHealths,
  usageWindows,
  triageJudges,
  triageOutcomes,
  watchdogTriggers,
  grillingSessionStatuses,
  contractorKinds,
  daySchema,
  statusUpdateTriggers,
} from "@ai-office/shared";
import { z } from "zod";

// Every event AI Office emits (PRD §8, FR-52), as one Zod discriminated
// union on `type`. The Activity Feed, the monitors, the wall boards and the
// animations are all projections of these.
//
// Each event carries the `version` of its type's schema. To change a type
// incompatibly, add its next version beside the old one, as a nested
// `z.discriminatedUnion("version", [v1, v2])` in place of the single
// schema, and publish the new one: stored events of the old version still
// parse, so the log can always be read back.
//
// Events hold names, ids and counts; never a credential. Whatever they do
// hold is redacted by the bus before it is stored or delivered.
//
// This module uses only Zod and `@ai-office/shared`, so the web app can
// import it (`@ai-office/events/schema`).

const floorId = z.string().min(1);
const agentId = z.string().min(1);
/** A GitHub issue (or pull request) number on the Floor's repository. */
const issue = z.number().int().positive();
const count = z.number().int().min(0);
/** The most Agents a Status update gathers: a Floor's, with room to spare. */
const maxStatusUpdateAgents = 200;

/** The most text one streamed event carries; longer text is cut. */
export const maxStreamText = 8000;

/** What an Agent is doing, as the Office shows it (PRD FR-62). */
export const agentStatuses = [
  "idle",
  "working",
  "waiting",
  "paused",
  "capped",
  "blocked",
  "errored",
] as const;

/** A Token Cap's level (PRD FR-32). */
export const capLevels = ["office", "floor", "agent", "issue"] as const;

const event = <Type extends string, Shape extends z.ZodRawShape>(
  type: Type,
  shape: Shape,
) => z.strictObject({ type: z.literal(type), version: z.literal(1), ...shape });

// Floors
/** The Floor Template something came from (FR-97), as it was then. */
const fromTemplate = z.strictObject({
  id: templateIdSchema,
  name: z.string().min(1),
});
const floorCreated = event("floor.created", {
  floorId,
  name: z.string().min(1),
  /** `owner/name` on GitHub. */
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /**
   * The Floor Template it was set up from; absent on Floors added before
   * Floor Templates, which count as Development.
   */
  template: fromTemplate.optional(),
});
const floorArchived = event("floor.archived", { floorId });
/**
 * The Owner stopped everything on a Floor from the Meeting Room: its
 * running work went back in the queue, and none starts until it continues.
 */
const floorStopped = event("floor.stopped", { floorId });
/** The Owner let a stopped Floor's Agents carry on with their work. */
const floorContinued = event("floor.continued", { floorId });
/**
 * The Owner renamed a Floor (FR-7): what the Office shows for it. Its id,
 * and so its addresses, stay as they were.
 */
const floorRenamed = event("floor.renamed", {
  floorId,
  name: z.string().min(1),
  previousName: z.string().min(1),
});

// Agents
const agentCreated = event("agent.created", {
  floorId,
  agentId,
  name: z.string().min(1),
  /** Its Role: a library Role's id, or `manager`. */
  role: z.string().min(1),
  aiProvider: z.string().min(1),
  /** Empty on any AI Provider: it is given one when a task starts. */
  model: z.string(),
});
const agentRemoved = event("agent.removed", { floorId, agentId });
const agentStatusChanged = event("agent.status_changed", {
  floorId,
  agentId,
  status: z.enum(agentStatuses),
  issue: issue.optional(),
  reason: z.string().optional(),
});
/** How many tasks wait for the Agent: the pile of tickets on its desk (FR-62). */
const agentQueueChanged = event("agent.queue_changed", {
  floorId,
  agentId,
  queued: count,
});
/** PRD FR-86, FR-87. */
const agentFreshStart = event("agent.fresh_start", {
  floorId,
  agentId,
  issue: issue.optional(),
  trigger: z.enum(["threshold", "manual"]),
  /** The Context Usage that led to it, from 0 to 1. */
  contextUsage: z.number().min(0).max(1),
});

/**
 * An Agent's Context Usage changed (PRD FR-84, FR-85): the input tokens of
 * its latest model call in its current session over its Model's context
 * window, sent when its whole percentage changes; or its session ended.
 */
const agentContextUsage = event("agent.context_usage", {
  floorId,
  agentId,
  issue: issue.optional(),
  /** False once its session has ended: there is nothing to show. */
  active: z.boolean(),
  /** The latest call's Model and input tokens, cached ones included. */
  model: z.string().min(1).optional(),
  inputTokens: count.optional(),
  /** Its Model's context window from the catalogue; null when unknown. */
  contextWindow: z.number().int().positive().nullable().optional(),
  /** From 0 to 1; null when unknown or the session has ended. */
  contextUsage: z.number().min(0).max(1).nullable(),
});

// Issues (PRD FR-8, FR-18)
const issuePickedUp = event("issue.picked_up", {
  floorId,
  issue,
  title: z.string(),
  url: z.url(),
});
/**
 * The Manager's triage of an issue (PRD FR-23): clear to work at a
 * priority, or unclear and waiting for the Owner.
 */
const issueTriaged = event("issue.triaged", {
  floorId,
  issue,
  /** The Floor's Manager. */
  agentId,
  outcome: z.enum(triageOutcomes),
  priority: z.enum(issuePriorities),
  judgedBy: z.enum(triageJudges),
});
/**
 * The work Role chosen for an issue on a Floor with several (PRD FR-23,
 * ADR 0003): by the Manager's triage, a `role:<name>` label, or the Owner
 * on the Notice that asked them.
 */
const issueRouted = event("issue.routed", {
  floorId,
  issue,
  /** The Floor's Manager. */
  agentId,
  role: roleIdSchema,
  /** The Role's name, as it was then. */
  roleName: z.string().min(1),
  routedBy: z.enum(routeJudges),
});
const issueAssigned = event("issue.assigned", { floorId, issue, agentId });
const issueLabelChanged = event("issue.label_changed", {
  floorId,
  issue,
  /** The Agent that moved it; absent when AI Office itself did. */
  agentId: agentId.optional(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});

// The Manager's watchdog (PRD FR-23): each decision it takes, which is
// also a comment on the issue, and each action refused as beyond its
// authority (merging, changing repository settings, raising a cap).
const managerDecision = event("manager.decision", {
  floorId,
  issue,
  /** The Floor's Manager. */
  agentId,
  action: z.enum(managerActions),
  trigger: z.enum(watchdogTriggers),
  /** The stage of the work it concerns, such as `needs-work`. */
  stage: z.string().min(1),
  /** The Agent whose work it took away, or paused. */
  fromAgentId: agentId.optional(),
  /** The Agent it gave the work to. */
  toAgentId: agentId.optional(),
  /** The stage it moved the issue to, such as `needs-human`. */
  to: z.string().min(1).optional(),
});
// Contractors (PRD FR-10, FR-24, ADR 0004): an Agent a Manager adds to its
// Floor for one Batch, at a desk of its own, and which leaves once no
// running Batch needs it, unless the Owner keeps it on the team. Its
// `agent.created` and `agent.removed` events come too.
const contractorAdded = event("contractor.added", {
  floorId,
  /** The Contractor. */
  agentId,
  name: z.string().min(1),
  /** Its Role: a library Role's id, or its one-off Role's. */
  role: z.string().min(1),
  /** Its Role's name, as people read it. */
  roleName: z.string().min(1),
  /** Whether its Role is a one-off the Manager wrote for its task. */
  oneOff: z.boolean(),
  kind: z.enum(contractorKinds),
  /** The Batch it was added for; absent for research. */
  batchId: z.number().int().positive().optional(),
  /** The Floor's Manager, who added it. */
  managerId: agentId,
});
/** The Owner kept a Contractor on the team: it is an ordinary Agent now. */
const contractorKept = event("contractor.kept", { floorId, agentId });
/** A Contractor left its Floor: its desk goes with it. */
const contractorLeft = event("contractor.left", {
  floorId,
  agentId,
  name: z.string().min(1),
  /** The Batch it was added for; absent for research. */
  batchId: z.number().int().positive().optional(),
});
// An issue the Manager filed for one of the Owner's chat requests (FR-24,
// ADR 0004), labelled `ai-office`, which only its Batch starts.
const managerIssueFiled = event("manager.issue_filed", {
  floorId,
  issue,
  /** The Floor's Manager. */
  agentId,
  title: z.string().min(1),
  url: z.string().min(1),
  /** The Owner's chat message it was filed for. */
  messageId: z.number().int().positive(),
});
// Batches (PRD FR-25): the Owner hands a Manager a Batch, whose Plan it
// drafts (each version of it), and whose work then starts.
const batchId = z.number().int().positive();
const batchIssues = z.array(issue).min(1).max(maxCommandIssues);
const batchPlanned = event("batch.planned", {
  floorId,
  batchId,
  /** The Plan's version: 1 for the Manager's first draft. */
  planVersion: z.number().int().positive(),
  /** The Floor's Manager. */
  agentId,
  draftedBy: z.enum(planDrafters),
  /** The Batch's issues, in the Plan's order. */
  issues: batchIssues,
  /** The version the Owner edited on the whiteboard, which this replans. */
  editedFrom: z.number().int().positive().optional(),
});
// The Owner approves a Batch's Plan on the whiteboard (FR-25.3); its work
// then starts (`batch.started`).
const batchApproved = event("batch.approved", {
  floorId,
  batchId,
  /** The version of its Plan approved. */
  planVersion: z.number().int().positive(),
  /** The Floor's Manager, whose Plan it is. */
  agentId,
});
const batchStarted = event("batch.started", {
  floorId,
  batchId,
  /** The Floor's Manager. */
  agentId,
  /** The issues whose work started with it; the rest wait for others. */
  issues: z.array(issue).max(maxCommandIssues),
});
// The Kickoff (FR-25.2, FR-60): the Plan's assigned Agents gather in the
// meeting room, where the Manager presents the Plan; each acknowledges it
// once, "OK" or one concern; then they go back to their desks.
const batchKickoffStarted = event("batch.kickoff_started", {
  floorId,
  batchId,
  /** The version of the Plan presented. */
  planVersion: z.number().int().positive(),
  /** The Floor's Manager, who presents it. */
  agentId,
  /** The Agents the Plan assigns, who acknowledge it. */
  agentIds: z.array(agentId).max(maxCommandIssues),
});
const batchAcknowledged = event("batch.acknowledged", {
  floorId,
  batchId,
  planVersion: z.number().int().positive(),
  /** The Agent acknowledging. */
  agentId,
  response: z.enum(kickoffResponses),
  /** The concern, one line, for `concern`. */
  concern: z.string().min(1).max(maxKickoffConcernLength).optional(),
  by: z.enum(acknowledgers),
});
const batchKickoffEnded = event("batch.kickoff_ended", {
  floorId,
  batchId,
  /** The Floor's Manager. */
  agentId,
  /** How many Agents raised a concern. */
  concerns: count,
});
// The Wrap-up (FR-25.6, FR-60): every issue of the Batch is closed or
// blocked, and its results are presented, the Agents gathered again.
const batchFinished = event("batch.finished", {
  floorId,
  batchId,
  /** The Floor's Manager. */
  agentId,
  /** The Agents the Plan assigned, who gather for the Wrap-up. */
  agentIds: z.array(agentId).max(maxCommandIssues),
  /** The Batch's issues. */
  issues: batchIssues,
  merged: count,
  closed: count,
  blocked: count,
  notStarted: count,
  /** Tokens the Batch's issues used. */
  tokens: count,
});
// A Status update (FR-23a): the Floor gathers in the meeting room and each
// Agent says what it did on the last working day (or, hourly, in the last
// hour) and plans today. What they say is in the Manager chat; the event
// holds the days and who.
const statusUpdateGiven = event("status_update.given", {
  floorId,
  /** The Floor's Manager, who stands at the whiteboard. */
  agentId,
  /** The Floor's other Agents, who sit at the table and speak in turn. */
  agentIds: z.array(agentId).max(maxStatusUpdateAgents),
  /** The Owner's day it was given on, `YYYY-MM-DD`. */
  day: daySchema,
  /** The day it reports on; for an hourly one, the day it was given. */
  reportedDay: daySchema,
  trigger: z.enum(statusUpdateTriggers),
  /** Its message in the Manager chat. */
  messageId: z.number().int().positive(),
});
// Repository memory (PRD FR-53, FR-56): an Agent proposes entries in its
// Handoff, and the Floor's Manager curates them into a pull request. Every
// change to memory is in the Activity Feed.
const memoryProposed = event("memory.proposed", {
  floorId,
  agentId,
  issue,
  /** The entries proposed, each one line, redacted. */
  entries: z
    .array(z.string().min(1).max(maxMemoryEntryLength))
    .min(1)
    .max(maxMemoryProposals),
});
const memoryCurated = event("memory.curated", {
  floorId,
  /** The Floor's Manager. */
  agentId,
  reason: z.enum(memoryCurationReasons),
  /** The Batch that ended, for `batch`. */
  batchId: batchId.optional(),
  curatedBy: z.enum(memoryCurators),
  /** The entries the memory keeps, and how many came and went. */
  entries: z.number().int().min(0).max(maxMemoryEntries),
  added: count,
  removed: count,
  /** The proposals it took. */
  proposals: count,
  /** The pull request it opened or updated; none when nothing changed. */
  pullRequest: issue.optional(),
  url: z.url().optional(),
});
// Office-wide and Role memory (PRD FR-54, FR-55, FR-56): the Owner edits
// the office-wide memory; Agents propose Role memory in their Handoffs, the
// Floor's Manager recommends or rejects each entry, and only the Owner
// accepts one (ADR 0005), or rejects it. Every
// change is in the Activity Feed. The office-wide memory's text stays in
// the office admin: its event counts what changed.
const memoryOfficeChanged = event("memory.office_changed", {
  /** Lines added and removed, compared line by line. */
  added: count,
  removed: count,
  /** How long it is now. */
  characters: z.number().int().min(0).max(maxOfficeMemoryLength),
});
const roleMemoryEntry = z.string().min(1).max(maxMemoryEntryLength);
const memoryRoleProposed = event("memory.role_proposed", {
  floorId,
  agentId,
  issue,
  role: roleIdSchema,
  /** The entries kept for a decision, each one line. */
  entries: z.array(roleMemoryEntry).max(maxMemoryProposals),
  /** How many were refused for looking like a credential. */
  refused: z.number().int().min(0).max(maxMemoryProposals),
});
const memoryRoleChanged = event("memory.role_changed", {
  floorId,
  role: roleIdSchema,
  entryId: z.number().int().positive(),
  text: roleMemoryEntry,
  /**
   * `recommended`: the Manager recommends it to the Owner, who alone
   * accepts (ADR 0005); `removed`: the Owner took an accepted entry out.
   */
  change: z.enum(["recommended", "accepted", "rejected", "removed"]),
  by: z.enum(roleMemoryDeciders),
  /** The Floor's Manager, when it decided. */
  agentId: agentId.optional(),
  reason: z.string().min(1).max(maxRoleMemoryReasonLength).optional(),
});
const managerActionRefused = event("manager.action_refused", {
  floorId,
  issue: issue.optional(),
  /** The Floor's Manager. */
  agentId,
  /** What it was asked to do, such as `merge` or `raise_cap`. */
  action: z.string().min(1).max(100),
});

// Sandboxes (PRD FR-19)
const sandboxStarted = event("sandbox.started", {
  floorId,
  agentId,
  issue,
  sandboxId: z.string().min(1),
  branch: z.string().min(1),
});
const sandboxStopped = event("sandbox.stopped", {
  floorId,
  agentId,
  issue,
  sandboxId: z.string().min(1),
  /** `fresh_start`: ended for a Fresh Start, a new session following. */
  outcome: z.enum([
    "finished",
    "failed",
    "cancelled",
    "timed_out",
    "fresh_start",
  ]),
  exitCode: z.number().int().nullable(),
});

// A Grilling Session's course (PRD FR-78, FR-82, FR-83), as the Manager
// chat keeps it: started, paused, resumed, a round asked, answers or
// decisions settled within a round, and ended. The Office shows the
// Manager in the meeting room while one runs, with the round and the
// decisions on the whiteboard behind it. They hold counts, never a
// question, an answer or a decision.
export const grillingSessionChanges = [
  "started",
  "paused",
  "resumed",
  "round",
  "settled",
  "ended",
] as const;
export type GrillingSessionChange = (typeof grillingSessionChanges)[number];
const grillingSessionChanged = event("grilling.session_changed", {
  floorId,
  /** The Floor's Manager, who runs the session. */
  agentId,
  sessionId: z.number().int().positive(),
  change: z.enum(grillingSessionChanges),
  /** The session's status once changed. */
  status: z.enum(grillingSessionStatuses),
  /** The latest round asked; 0 before the first. */
  round: count,
  /** The questions of that round still open. */
  openQuestions: count,
  /** The decisions settled so far. */
  decisions: count,
});
// A Grilling Session's fact-finding (PRD FR-79): the Manager, or an Agent
// it delegates to, reads the Floor's code, docs and issues in a read-only
// sandbox to answer one of the Manager's own questions, for no issue.
// Nothing from it is pushed, and its clone is deleted.
const grillingFactFindingStarted = event("grilling.fact_finding_started", {
  floorId,
  /** The Agent sent to find the fact: the Manager, or one it delegated to. */
  agentId,
  sessionId: z.number().int().positive(),
  sandboxId: z.string().min(1),
});
const grillingFactFindingStopped = event("grilling.fact_finding_stopped", {
  floorId,
  agentId,
  sessionId: z.number().int().positive(),
  sandboxId: z.string().min(1),
  /** `found`: it answered; `unanswered`: it finished without an answer. */
  outcome: z.enum(["found", "unanswered", "failed", "cancelled", "timed_out"]),
});
// A Grilling Session's documents (PRD FR-80): as decisions settle, AI
// Office, as the GitHub App, commits the PRD, ADRs, glossary and process
// docs on the session's own branch; when the session ends it opens one
// pull request with all of them. They hold no document text.
const grillingDocumentsWritten = event("grilling.documents_written", {
  floorId,
  /** The Floor's Manager, whose commit it is. */
  agentId,
  sessionId: z.number().int().positive(),
  /** Such as `ai-office/grilling-3`. */
  branch: z.string().min(1),
  /** The commit the branch now points at. */
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** How many files it changed. */
  files: count,
});
const grillingPullRequestOpened = event("grilling.pull_request_opened", {
  floorId,
  agentId,
  sessionId: z.number().int().positive(),
  branch: z.string().min(1),
  pullRequest: issue,
  url: z.url(),
});
// A Grilling Session's issues (PRD FR-81): the GitHub App filed one of the
// issues the Owner approved, labelled `ai-office`, after those it is
// blocked by.
const grillingIssueFiled = event("grilling.issue_filed", {
  floorId,
  /** The Floor's Manager, who drafted it. */
  agentId,
  sessionId: z.number().int().positive(),
  issue,
  title: z.string(),
  url: z.url(),
  /** The issues filed before it that it is blocked by. */
  blockedBy: z.array(issue),
});

// What the Agent in a sandbox says and does, streamed live (PRD FR-58: the
// monitor shows its terminal output and tool calls).
const sandboxShape = {
  floorId,
  agentId,
  issue,
  sandboxId: z.string().min(1),
};
const sandboxText = event("sandbox.text", {
  ...sandboxShape,
  text: z.string().max(maxStreamText),
});
const sandboxToolCall = event("sandbox.tool_call", {
  ...sandboxShape,
  /** The tool, such as `Bash`. */
  name: z.string().min(1),
  /** Its main argument, such as the command, cut to fit. */
  args: z.string().max(maxStreamText),
});

/**
 * A file the Agent changed (PRD FR-58: the monitor shows its diffs), as
 * the change's lines: `-` for each removed, `+` for each added, and `@@`
 * between separate changes to the file.
 */
const sandboxDiff = event("sandbox.diff", {
  ...sandboxShape,
  /** The file, as the agent tool named it. */
  path: z.string().min(1).max(1000),
  diff: z.string().max(maxStreamText),
  /** How many lines were added and removed, counting any cut from `diff`. */
  added: count,
  removed: count,
});

// Branches and pull requests (PRD FR-19, FR-21, FR-52): AI Office pushes
// each issue's branch and opens its pull request, as the GitHub App.
/** What GitHub tells AI Office of a Floor's repository by webhook. */
export const repositoryChanges = [
  "push",
  "pull_request",
  "check_run",
  "check_suite",
] as const;
/**
 * GitHub sent a webhook (FR-8) saying a Floor's repository changed: a
 * push, a pull request, a check run or a check suite. It says only when
 * to look again, as every webhook does; nothing of its payload is kept.
 */
const repositoryChanged = event("repository.changed", {
  floorId,
  change: z.enum(repositoryChanges),
});
const branchPushed = event("branch.pushed", {
  floorId,
  agentId,
  issue,
  /** Such as `ai-office/4-add-a-basket`. */
  branch: z.string().min(1),
  /** The commit the branch now points at. */
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** How many new commits it carries. */
  commits: count,
  /**
   * Before review, what rebasing it onto the default branch as GitHub had
   * it did (FR-25.5): nothing to do, rebased, or given up on conflicts.
   */
  rebase: z
    .object({
      outcome: z.enum(["up_to_date", "rebased", "conflict"]),
      /** The default branch, such as `main`. */
      onto: z.string().min(1),
      /** The default branch's commit it was compared with. */
      base: z.string().regex(/^[0-9a-f]{40,64}$/),
      /** The files that conflicted, for a conflict. */
      files: z.array(z.string().min(1).max(1000)).max(100).optional(),
    })
    .optional(),
});
const pullRequestOpened = event("pull_request.opened", {
  floorId,
  agentId,
  issue,
  pullRequest: issue,
  url: z.url(),
  branch: z.string().min(1),
});
// The Merge Policy (PRD FR-29, FR-49): the GitHub App merges a pull
// request, automatically as the Floor's Merge Policy lets it (`app`), or
// as the Owner approved it from its Notice (`owner`).
const pullRequestMerged = event("pull_request.merged", {
  floorId,
  issue,
  pullRequest: issue,
  url: z.url(),
  /** The merge commit. */
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  by: z.enum(["app", "owner"]),
});

// Reviews (PRD FR-20, FR-27): a reviewer Agent's verdict, posted on the
// pull request by the GitHub App.
const reviewPosted = event("review.posted", {
  floorId,
  agentId,
  issue,
  pullRequest: issue,
  /** The round of the Review Loop, from 1. */
  round: z.number().int().positive(),
  verdict: z.enum(reviewVerdicts),
  /** How many of its comments are blocking, and how many nits. */
  blocking: count,
  nits: count,
  /** The review on GitHub. */
  url: z.url(),
});

// QA (PRD FR-28): the QA Agent's result for a round of QA, commented on
// the pull request by the GitHub App.
const qaReported = event("qa.reported", {
  floorId,
  agentId,
  issue,
  pullRequest: issue,
  /** The round of QA, from 1. */
  round: z.number().int().positive(),
  result: z.enum(qaResults),
  /** The comment on GitHub. */
  url: z.url(),
});

// Design review (PRD FR-10, FR-18): a designer Agent's result for a round
// of reviewing the screenshots of a pull request's UI, commented on the
// pull request by the GitHub App.
const designReported = event("design.reported", {
  floorId,
  agentId,
  issue,
  pullRequest: issue,
  /** The round of design review, from 1. */
  round: z.number().int().positive(),
  result: z.enum(designResults),
  /** The comment on GitHub. */
  url: z.url(),
});

// Handoffs (PRD FR-26): a short structured summary, never a transcript.
const handoff = event("handoff", {
  floorId,
  issue,
  fromAgentId: agentId,
  toAgentId: agentId,
  /** The stage the issue moves to, such as `needs-review`. */
  stage: z.string().min(1),
  summary: z.strictObject({
    changed: z.string(),
    check: z.string(),
    risks: z.string(),
  }),
});

// Model calls through the AI Gateway (PRD FR-42), summarised.
const modelCallCompleted = event("model_call.completed", {
  floorId: floorId.optional(),
  agentId: agentId.optional(),
  /** The Owner tool that made it, for a call not made by an Agent. */
  ownerTool: z.string().min(1).optional(),
  issue: issue.optional(),
  aiAccount: z.string().nullable(),
  aiProvider: z.string().min(1),
  model: z.string().nullable(),
  status: z.number().int(),
  latencyMs: count,
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  cacheReadTokens: count.nullable(),
  cacheWriteTokens: count.nullable(),
});

// Notices (PRD FR-48, FR-49)
const noticeRaised = event("notice.raised", {
  noticeId: z.string().min(1),
  kind: z.enum(["action", "info"]),
  title: z.string().min(1),
  floorId: floorId.optional(),
  agentId: agentId.optional(),
  issue: issue.optional(),
});
const noticeDismissed = event("notice.dismissed", {
  noticeId: z.string().min(1),
  floorId: floorId.optional(),
});
const noticeActedOn = event("notice.acted_on", {
  noticeId: z.string().min(1),
  floorId: floorId.optional(),
  /** Such as `approve_and_merge`, `raise_cap` or `resume`. */
  action: z.string().min(1),
});

// Token Caps (PRD FR-33): a warning at 80%, then reached at 100%.
const capShape = {
  level: z.enum(capLevels),
  period: z.enum(["daily", "monthly"]),
  floorId: floorId.optional(),
  agentId: agentId.optional(),
  ownerTool: z.string().min(1).optional(),
  issue: issue.optional(),
  /** Tokens used in the period so far. */
  used: count,
  cap: count,
};
const capWarning = event("cap.warning", capShape);
const capReached = event("cap.reached", capShape);

// AI Accounts (PRD FR-36): an OAuth account's token health, each time it
// changes: refreshed, expiring, expired, or needing the Owner to sign in
// again. Never the token.
const aiAccountTokenHealth = event("ai_account.token_health", {
  aiAccountId: z.string().min(1),
  /** The account's name, as the Owner knows it. */
  name: z.string().min(1),
  health: z.enum(tokenHealths),
  /** When the access token expires. */
  expiresAt: z.iso.datetime({ offset: true }),
  /** True when a refresh was refused: the Owner must sign in again. */
  reauthenticationNeeded: z.boolean(),
});

// AI Accounts (PRD FR-38, FR-39, FR-49): the AI Gateway starting or
// stopping holding an account back (rate-limited, overloaded or failing),
// and whether its AI Provider has an account left to serve it.
const aiAccountLimitChanged = event("ai_account.limit_changed", {
  aiAccountId: z.string().min(1),
  /** The account's name, as the Owner knows it. */
  name: z.string().min(1),
  aiProvider: z.string().min(1),
  /** Why it is held back now; null once it is not. */
  reason: z.enum(aiAccountLimitReasons).nullable(),
  /** Until when; null once it is not held back. */
  until: z.iso.datetime({ offset: true }).nullable(),
  /** False when no account of its AI Provider is left to serve. */
  providerAvailable: z.boolean(),
});

// AI Accounts (PRD FR-39): auto-refresh's minimal request to an account
// whose usage windows reset, to start a new one at once, and whether it
// did. It is sent once per window.
const aiAccountWindowRefreshed = event("ai_account.window_refreshed", {
  aiAccountId: z.string().min(1),
  /** The account's name, as the Owner knows it. */
  name: z.string().min(1),
  /** The windows that had reset. */
  windows: z.array(z.enum(usageWindows)).min(1),
  /** Whether its AI Provider served the request, starting a new window. */
  served: z.boolean(),
  /** When the new five-hour window resets, if the answer said. */
  resetsAt: z.iso.datetime({ offset: true }).nullable(),
});

// Configuration changes (PRD FR-52): which settings, never their values.
const configChanged = event("config.changed", {
  scope: z.enum([
    "office",
    "floor",
    "agent",
    "gateway",
    "security",
    "communications",
    "google",
  ]),
  floorId: floorId.optional(),
  agentId: agentId.optional(),
  keys: z.array(z.string().min(1)).min(1),
});

// Connections (PRD FR-93, FR-94): each one added, changed or removed, and
// each time one starts failing (5 deliveries in a row) or recovers, or a
// delivery is given up after 24 hours. Never its credentials, and never a
// successful delivery, which only its own log holds.
const connectionId = z.string().min(1);
const connectionName = z.string().min(1);
const connectionAdded = event("connection.added", {
  connectionId,
  name: connectionName,
  connectionType: z.enum(connectionTypes),
});
const connectionChanged = event("connection.changed", {
  connectionId,
  name: connectionName,
  /** What changed: `name`, `rules` or `paused`. */
  keys: z.array(z.string().min(1)).min(1),
  /** Whether it is paused now, when `paused` changed. */
  paused: z.boolean().optional(),
});
const connectionRemoved = event("connection.removed", {
  connectionId,
  name: connectionName,
});
const connectionFailing = event("connection.failing", {
  connectionId,
  name: connectionName,
  /** Failed deliveries in a row. */
  failures: count,
  /**
   * Why, when it is not that deliveries failed: Google refused the
   * Owner's Google sign-in, which marks every Google Connection failing.
   */
  reason: z.literal("google_sign_in_revoked").optional(),
  /** The action Notice raised about it. */
  noticeId: z.string().min(1),
});
const connectionRecovered = event("connection.recovered", {
  connectionId,
  name: connectionName,
});
const connectionDeliveryExpired = event("connection.delivery_expired", {
  connectionId,
  name: connectionName,
  deliveryId: z.string().min(1),
  attempts: z.number().int().positive(),
});

// Google sign-in (PRD FR-91): the Owner signs in to one Google account for
// the Google Connections, granting the scopes their services need; and
// Google refusing its refresh token (the grant revoked, or expired), which
// marks every Google Connection failing. The OAuth client's change is a
// `config.changed` with the scope `google`. Never a token or a secret.
const googleSignedIn = event("google.signed_in", {
  /** The scopes Google granted. */
  scopes: z.array(z.string().min(1)).max(20),
});
const googleSignedOut = event("google.signed_out", {});
const googleGrantRevoked = event("google.grant_revoked", {
  /** How many Google Connections it marked failing. */
  connections: count,
});

// The office Skill library (PRD FR-72, FR-76): every add, change and
// removal. A Skill is named; its contents stay in the library.
const skillId = z.string().min(1);
const skillName = z.string().min(1);
const skillAdded = event("skill.added", {
  skillId,
  name: skillName,
  source: z.enum(skillSources),
  /** Whether it starts enabled: an imported Skill waits for review. */
  enabled: z.boolean(),
  /**
   * The Floor Template that brought it into the library, as a Floor was
   * added from it; absent for a Skill the Owner added.
   */
  template: fromTemplate.optional(),
});
const skillChanged = event("skill.changed", {
  skillId,
  name: skillName,
  /**
   * `edited`: its files changed; `reviewed`: the Owner reviewed its full
   * contents, which enables it; `enabled` and `disabled`: turned on or off.
   */
  change: z.enum(["edited", "reviewed", "enabled", "disabled"]),
});
const skillRemoved = event("skill.removed", { skillId, name: skillName });

// The office Role library (PRD FR-98, FR-101): every Role made, changed
// and deleted. A Role is named; its instructions stay in the library.
const roleName = z.string().min(1);
const roleCreated = event("role.created", {
  roleId: roleIdSchema,
  name: roleName,
  stage: z.enum(stages),
  /** The Role it was duplicated from; null for one made from scratch. */
  duplicatedFrom: roleIdSchema.nullable(),
  /**
   * The Floor Template that brought it into the library, as a Floor was
   * added from it; absent for a Role the Owner made.
   */
  template: fromTemplate.optional(),
});
const roleChanged = event("role.changed", {
  roleId: roleIdSchema,
  name: roleName,
  /** Which of its fields changed, never their values. */
  keys: z.array(z.string().min(1)).min(1),
  /** How many Agents fill it: the change reaches each from its next task. */
  agents: count,
});
const roleRemoved = event("role.removed", {
  roleId: roleIdSchema,
  name: roleName,
});

// The Owner's own Floor Templates (PRD FR-101): every template added,
// changed and removed. A template is named; its contents stay in AI Office.
const floorTemplateAdded = event("floor_template.added", {
  templateId: templateIdSchema,
  name: z.string().min(1),
  /** Where it came from (never `built-in`, which ship with AI Office). */
  source: z.enum(floorTemplateSources),
  /** The template it was duplicated from, as it was then; null otherwise. */
  duplicatedFrom: fromTemplate.nullable(),
  /** The Floor whose set-up it was saved from; null otherwise. */
  floorId: floorId.nullable(),
  /** Whether a Floor can be added from it: an imported one waits for review. */
  enabled: z.boolean(),
});
const floorTemplateChanged = event("floor_template.changed", {
  templateId: templateIdSchema,
  name: z.string().min(1),
  /**
   * `edited`: the Owner changed it, naming which parts (`keys`);
   * `reviewed`: the Owner read its full contents and enabled it;
   * `replaced`: a configuration import brought new contents, which wait
   * for review.
   */
  change: z.enum(["edited", "reviewed", "replaced"]),
  /** Which of its parts changed, never what they say. */
  keys: z.array(z.string().min(1)),
});
const floorTemplateRemoved = event("floor_template.removed", {
  templateId: templateIdSchema,
  name: z.string().min(1),
});

// Sign-ins (PRD FR-4)
const signInShape = {
  ip: z.string().min(1),
  userAgent: z.string().nullable(),
  secondFactor: z.enum(["totp", "recovery_code"]).optional(),
};
const signInSucceeded = event("sign_in.succeeded", signInShape);
const signInFailed = event("sign_in.failed", signInShape);
const signInLockedOut = event("sign_in.locked_out", {
  ip: z.string().min(1),
  lockoutSeconds: z.number().int().positive(),
});
const signedOut = event("signed_out", { everywhere: z.boolean() });

// Gateway Keys not in use, presented at /v1 on the app's port, limited per
// client as sign-ins are (pen-testing I2-3)
const gatewayKeyFailed = event("gateway_key.failed", {
  ip: z.string().min(1),
  userAgent: z.string().nullable(),
});
const gatewayKeyLockedOut = event("gateway_key.locked_out", {
  ip: z.string().min(1),
  lockoutSeconds: z.number().int().positive(),
});

/** Any event AI Office emits. */
export const officeEventSchema = z.discriminatedUnion("type", [
  floorCreated,
  floorArchived,
  floorStopped,
  floorContinued,
  floorRenamed,
  agentCreated,
  agentRemoved,
  agentStatusChanged,
  agentQueueChanged,
  agentFreshStart,
  agentContextUsage,
  issuePickedUp,
  issueTriaged,
  issueRouted,
  issueAssigned,
  issueLabelChanged,
  managerDecision,
  managerActionRefused,
  managerIssueFiled,
  contractorAdded,
  contractorKept,
  contractorLeft,
  batchPlanned,
  batchApproved,
  batchStarted,
  batchKickoffStarted,
  batchAcknowledged,
  batchKickoffEnded,
  batchFinished,
  statusUpdateGiven,
  memoryProposed,
  memoryCurated,
  memoryOfficeChanged,
  memoryRoleProposed,
  memoryRoleChanged,
  sandboxStarted,
  sandboxStopped,
  sandboxText,
  sandboxToolCall,
  sandboxDiff,
  grillingSessionChanged,
  grillingFactFindingStarted,
  grillingFactFindingStopped,
  grillingDocumentsWritten,
  grillingPullRequestOpened,
  grillingIssueFiled,
  repositoryChanged,
  branchPushed,
  pullRequestOpened,
  pullRequestMerged,
  reviewPosted,
  qaReported,
  designReported,
  handoff,
  modelCallCompleted,
  noticeRaised,
  noticeDismissed,
  noticeActedOn,
  capWarning,
  capReached,
  aiAccountTokenHealth,
  aiAccountLimitChanged,
  aiAccountWindowRefreshed,
  configChanged,
  connectionAdded,
  connectionChanged,
  connectionRemoved,
  connectionFailing,
  connectionRecovered,
  connectionDeliveryExpired,
  googleSignedIn,
  googleSignedOut,
  googleGrantRevoked,
  skillAdded,
  skillChanged,
  skillRemoved,
  roleCreated,
  roleChanged,
  roleRemoved,
  floorTemplateAdded,
  floorTemplateChanged,
  floorTemplateRemoved,
  signInSucceeded,
  signInFailed,
  signInLockedOut,
  signedOut,
  gatewayKeyFailed,
  gatewayKeyLockedOut,
]);

export type OfficeEvent = z.infer<typeof officeEventSchema>;
export type EventType = OfficeEvent["type"];
export type EventOfType<Type extends EventType> = Extract<
  OfficeEvent,
  { type: Type }
>;

/** Every event type, in the order the union lists them. */
export const eventTypes = officeEventSchema.options.map(
  (option) => option.shape.type.value,
) as readonly EventType[];

/** An event as the log holds it: redacted, with its id and time. */
export interface StoredEvent {
  /** Grows with every event stored; a stream resumes after it. */
  readonly id: number;
  readonly occurredAt: Date;
  readonly event: OfficeEvent;
}

/** What an event is about, for filtering. */
export interface EventSubject {
  readonly floorId: string | null;
  /** Every Agent it concerns: a Handoff concerns two. */
  readonly agentIds: readonly string[];
  readonly issue: number | null;
}

export function subjectOf(event: OfficeEvent): EventSubject {
  const fields = event as Partial<
    Record<"floorId" | "agentId" | "fromAgentId" | "toAgentId", string>
  > & { issue?: number };
  return {
    floorId: fields.floorId ?? null,
    agentIds: [fields.agentId, fields.fromAgentId, fields.toAgentId].filter(
      (id): id is string => id !== undefined,
    ),
    issue: fields.issue ?? null,
  };
}

/** Which events a subscriber or a stream wants; every field narrows it. */
export interface EventFilter {
  readonly floorId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly issue?: number | undefined;
  /** Any of these types; every type when absent or empty. */
  readonly types?: readonly EventType[] | undefined;
}

export function matchesFilter(
  event: OfficeEvent,
  filter: EventFilter = {},
): boolean {
  const subject = subjectOf(event);
  return (
    (filter.floorId === undefined || subject.floorId === filter.floorId) &&
    (filter.agentId === undefined ||
      subject.agentIds.includes(filter.agentId)) &&
    (filter.issue === undefined || subject.issue === filter.issue) &&
    (filter.types === undefined ||
      filter.types.length === 0 ||
      filter.types.includes(event.type))
  );
}
