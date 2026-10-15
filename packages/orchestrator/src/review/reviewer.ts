import type { EventBus } from "@ai-office/events";
import type {
  GitHubApp,
  Issue,
  PullRequest,
  PullRequestFile,
  ReviewComment,
} from "@ai-office/github";
import {
  createRedactor,
  reviewVerdictLabels,
  type Redactor,
  type ReviewVerdict,
  type VerdictComment,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { DecisionModel } from "../decision-model/decision-model.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { IntakeQueue } from "../intake/intake.ts";
import {
  baseOf,
  branchOf,
  type BatchBranches,
} from "../batches/one-pull-request.ts";
import type { RepositoryMemory } from "../memory/memory.ts";
import type { SharedMemory } from "../memory/shared.ts";
import type { ModelClient, ModelMessage } from "../models/client.ts";
import type { Notices } from "../notices/notices.ts";
import {
  roleOfQueued,
  stageAfter,
  type Pipeline,
} from "../pipeline/pipeline.ts";
import { roleOfAgent } from "../roles/roles.ts";
import { memoryRoleStore, type RoleStore } from "../roles/store.ts";
import { everyRoundLinks } from "../qa/caps.ts";
import type { ExecuteWork } from "../work/queue.ts";
import type { WorkItem } from "../work/store.ts";
import {
  conflictPositions,
  describeConflict,
  reviewConflictOf,
  type Conflict,
} from "./conflict.ts";
import { commentableLines } from "./diff.ts";
import { createEscalation, reviewRoundLinks } from "./escalation.ts";
import { approvalHandoff, reviewersHandoff } from "./handoff.ts";
import {
  maxFileCharacters,
  notShownInFull,
  retryMessage,
  reviewerPrompt,
} from "./prompt.ts";
import type {
  HandoffSummary,
  ReviewLoopStore,
  VerdictRecord,
} from "./store.ts";
import {
  changedLines,
  describedBlocking,
  describeStall,
  judgedStall,
  stallOf,
  type Stall,
} from "./stall.ts";
import type { WorkTurns } from "../work/turns.ts";
import { parseVerdict } from "./verdict.ts";

// The reviewer flow (PRD FR-20, FR-27; ADR 0002): work queued at
// `needs-review` is a review round by every one of the Floor's required
// reviewer Agents. Reviewers use no sandbox: each makes model calls through
// the AI Gateway with its own Gateway Key, given the issue, the pull
// request's diff and the files it changes, and must answer with a verdict
// that `reviewVerdictSchema` accepts. An answer that is not one is sent
// back once, saying why; a second is escalated with an action Notice. Each
// verdict is posted on the pull request as a review by the GitHub App,
// with its comments inline where the diff allows. Each reviewer's prompt
// has the repository's memory (FR-53), and the office-wide and reviewers'
// Role memory (FR-54, FR-55), read once a round.
//
// The Review Loop (FR-26 to FR-28; §5 scenarios 3 and 4): every verdict is
// kept with its round. When every required reviewer approves with no
// blocking comments (nits alone approve), the issue moves on to
// `needs-qa` (or past QA and docs, when the Floor has no Agent for them,
// to the Merge Policy at `ready-to-merge`), and the next stage's work is
// queued. A round the Merge Policy sent back from `ready-to-merge`, for
// commits pushed after the reviewers approved (P1-1), goes back there once
// they approve: the stages after review have passed already, and those
// commits are theirs. Otherwise, below the Floor's Round
// Cap, it goes back to `needs-work` with the reviewers' Handoff, and the
// coder fixes the blocking comments only; its next delivery is the next
// round. At the Round Cap the issue and its pull request go to
// `needs-human`, and an action Notice links each round. A round that
// stalls goes there early, saying why: its blocking comments mostly repeat
// the previous round's, or the fix since then barely changed the diff (or,
// while the Decision Model is on, Jev judges it repeating or stalled). So
// does a round whose blocking comments reject the coder's fix for what QA
// required, a conflict between Roles (FR-30), with both positions.
// Each Handoff is emitted as an event when its receiving Agents take it:
// the coder's to each reviewer as a round starts, the reviewers' to the
// coder as it starts its fix. When the issue's Plan gave it several work
// Roles in turn (FR-25 (1)), the fix goes to the work Role whose changes
// the blocking comments concern, or to the last Role when that is unclear
// (`fixRole`).
//
// An issue of a Batch handed over "in one PR" (ADR 0010) is reviewed on
// its Batch's one pull request, but only its own work is shown: the diff
// from where the shared branch stood as it started, so its reviewers judge
// this issue, not the ones before it. Their comments go on the pull
// request's own diff, where it has those lines.

export interface ReviewFlowOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  readonly github: GitHubApp;
  readonly pipeline: Pipeline;
  readonly notices: Notices;
  readonly events: EventBus;
  /** Makes reviewers' model calls, through the AI Gateway. */
  readonly models: ModelClient;
  /** Each AI Provider's default Model, for reviewers without their own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /** Whether an Agent is paused at a Token Cap (FR-33). */
  readonly capPaused?: (agentId: string) => boolean;
  /**
   * Whether a round is stalled or repeating, as Jev judges it while the
   * Decision Model is on (FR-17); AI Office's rules judge otherwise.
   */
  readonly decisionModel?: Pick<DecisionModel, "reviewLoop">;
  /** The Review Loop's verdicts and Handoffs. */
  readonly reviews: ReviewLoopStore;
  /**
   * Where the next stage's work is queued: the coder's fix when a round
   * sends the work back, or the stage after review when it approves.
   */
  readonly queue?: IntakeQueue;
  /** Removes credentials from what is posted on GitHub. */
  readonly redactor?: Redactor;
  /** The repository's memory, which each reviewer reads (FR-53). */
  readonly memory?: Pick<RepositoryMemory, "read">;
  /**
   * The office-wide and reviewers' Role memory, quoted in each reviewer's
   * prompt (FR-54, FR-55).
   */
  readonly sharedMemory?: Pick<SharedMemory, "forAgent">;
  /**
   * The office Role library (FR-98): each reviewer's Role is read from it
   * every round. The built-in Roles when absent.
   */
  readonly roles?: Pick<RoleStore, "get">;
  /**
   * The turns of the work Roles an issue's Plan gave it (FR-25 (1)): which
   * of them a fix goes back to.
   */
  readonly turns?: Pick<WorkTurns, "sendBack">;
  readonly now?: () => Date;
  /**
   * The Batches handed over "in one PR" (ADR 0010): their issues are
   * reviewed on their Batch's pull request, each its own work.
   */
  readonly batchBranches?: BatchBranches;
  /** Told of what went wrong after the work was done or given up. */
  readonly onError?: (error: unknown) => void;
}

/** How a round ended the Review Loop, or did not. */
export type RoundOutcome =
  /** Every required reviewer approved: on to QA. */
  | "approved"
  /** Blocking comments, below the Round Cap: back to the coder. */
  | "changes_requested"
  /** Blocking comments at the Round Cap: to the Owner. */
  | "round_cap"
  /** Blocking comments that repeat, or a fix that barely changed: to the Owner early. */
  | "stalled"
  /** Blocking comments on the coder's fix for what QA required: to the Owner. */
  | "conflict";

/** A reviewer whose answers were not verdicts, twice. */
export class InvalidVerdictError extends Error {
  readonly agent: AgentRecord;
  /** What was wrong with its second answer. */
  readonly problem: string;

  constructor(agent: AgentRecord, problem: string) {
    super(`${agent.name} gave no valid verdict: ${problem}`);
    this.name = "InvalidVerdictError";
    this.agent = agent;
    this.problem = problem;
  }
}

/** The most tokens one reviewer's answer may use. */
const maxAnswerTokens = 8192;
/** The most files whose text a reviewer is given. */
const maxContentFiles = 20;
/** The longest reason a Notice's title carries. */
const maxReason = 150;

const reasonOf = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();
  return message.length <= maxReason
    ? message
    : `${message.slice(0, maxReason - 1)}…`;
};

const title = (text: string): string =>
  text.length <= 200 ? text : `${text.slice(0, 199)}…`;

const severityLabel = (comment: VerdictComment): string =>
  comment.severity === "blocking" ? "Blocking" : "Nit";

/**
 * The review as posted: the verdict, its reviewer and summary in the body,
 * each comment inline when it is on a line of the diff, and in the body
 * when it is not, as GitHub takes inline comments only there.
 */
export function reviewOf(
  agent: {
    readonly name: string;
    readonly aiProvider: string;
    readonly model: string;
  },
  verdict: ReviewVerdict,
  files: readonly PullRequestFile[],
): { readonly body: string; readonly comments: ReviewComment[] } {
  const lines = new Map(
    files.map((file) => [
      file.path,
      file.status === "removed"
        ? new Set<number>()
        : commentableLines(file.patch),
    ]),
  );
  const inline = verdict.comments.filter(
    ({ path, line }) => lines.get(path)?.has(line) === true,
  );
  const elsewhere = verdict.comments.filter(
    (comment) => !inline.includes(comment),
  );
  const count = (severity: VerdictComment["severity"]) =>
    verdict.comments.filter((comment) => comment.severity === severity).length;
  const body = [
    `**${reviewVerdictLabels[verdict.verdict]}** by ${agent.name} (reviewer, ${agent.aiProvider} ${agent.model}) in AI Office.`,
    "",
    verdict.summary,
    "",
    `Blocking: ${String(count("blocking"))} · Nits: ${String(count("nit"))}`,
    ...(elsewhere.length === 0
      ? []
      : [
          "",
          "Comments on lines outside the diff:",
          "",
          ...elsewhere.map(
            (comment) =>
              `- **${severityLabel(comment)}** \`${comment.path}\` line ${String(comment.line)}: ${comment.body}`,
          ),
        ]),
  ].join("\n");
  return {
    body,
    comments: inline.map((comment) => ({
      path: comment.path,
      line: comment.line,
      body: `**${severityLabel(comment)}:** ${comment.body}`,
    })),
  };
}

export function createReviewFlow(options: ReviewFlowOptions): ExecuteWork {
  const { floors, github, pipeline, notices, events, models, reviews } =
    options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const library = options.roles ?? memoryRoleStore();
  const escalate = createEscalation({ github, pipeline, notices });
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  const status = (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
    value: "working" | "idle" | "blocked" | "capped",
    reason?: string,
  ) =>
    events.publish({
      type: "agent.status_changed",
      version: 1,
      floorId: floor.id,
      agentId: agent.id,
      status: value,
      ...(value === "idle" ? {} : { issue }),
      ...(reason === undefined ? {} : { reason }),
    });

  /**
   * What a reviewer reads: the changed files, and their text on the branch.
   * With `since`, on a shared branch, only the changes after it: the
   * issue's own.
   */
  const changes = async (
    floor: FloorRecord,
    pullRequest: PullRequest,
    since?: string,
  ) => {
    const client = github.repository(floor.repository);
    const files: PullRequestFile[] =
      since === undefined
        ? await client.listPullRequestFiles(pullRequest.number)
        : (await client.compareCommits(since, pullRequest.head.sha)).map(
            ({ path, status, patch }) => ({ path, status, patch }),
          );
    const readable = files
      .filter(({ status, patch }) => status !== "removed" && patch !== null)
      .slice(0, maxContentFiles);
    const contents = (
      await Promise.all(
        readable.map(async ({ path }) => {
          const text = await client.getFileContent(path, pullRequest.head.sha);
          return text === undefined || text.includes("\u0000")
            ? undefined
            : { path, text: text.slice(0, maxFileCharacters + 1) };
        }),
      )
    ).filter((content) => content !== undefined);
    return { files, contents };
  };

  /** What every reviewer in a round shares. */
  interface Round {
    readonly floor: FloorRecord;
    readonly issue: Issue;
    readonly pullRequest: PullRequest;
    /** The round of the Review Loop, from 1. */
    readonly number: number;
    readonly changed: Awaited<ReturnType<typeof changes>>;
    /** The pull request's own files, whose diff comments may go on. */
    readonly commentable: readonly PullRequestFile[];
    /** On a shared branch, where the issue's own work begins. */
    readonly since: string | undefined;
    /** The coder's Handoff for this round, if it left one. */
    readonly handoff: HandoffSummary | undefined;
    /** The repository's memory, if it has any. */
    readonly memory: string | undefined;
    readonly defaults: DefaultModels | undefined;
    readonly signal: AbortSignal;
  }

  /** One reviewer's verdict: asked for, checked, asked again once. */
  const verdictOf = async (
    round: Round,
    agent: AgentRecord,
    model: string,
  ): Promise<ReviewVerdict> => {
    const { floor, issue, pullRequest } = round;
    // Its Role as the library has it now, and that Role's memory.
    const role = await roleOfAgent(library, agent);
    const agentMemory = await options.sharedMemory?.forAgent(
      floor.id,
      agent.role,
    );
    const prompt = reviewerPrompt({
      floor,
      agent: { ...agent, model },
      role,
      issue,
      pullRequest: {
        number: pullRequest.number,
        title: pullRequest.title,
        branch: pullRequest.head.name,
        ...(round.since === undefined ? {} : { since: round.since }),
      },
      round: { number: round.number, cap: floor.roundCap },
      ...(round.handoff === undefined ? {} : { handoff: round.handoff }),
      ...(round.memory === undefined ? {} : { memory: round.memory }),
      ...(agentMemory === undefined ? {} : { agentMemory }),
      ...round.changed,
    });
    const messages: ModelMessage[] = [{ role: "user", content: prompt.user }];
    const ask = () =>
      models.complete(
        {
          agentId: agent.id,
          model,
          system: prompt.system,
          messages,
          maxTokens: maxAnswerTokens,
          issue: issue.number,
          pullRequest: pullRequest.number,
        },
        round.signal,
      );
    const first = await ask();
    const parsed = parseVerdict(first.text);
    if (parsed.ok) {
      return parsed.verdict;
    }
    messages.push(
      { role: "assistant", content: first.text },
      { role: "user", content: retryMessage(parsed.problem) },
    );
    const second = parseVerdict((await ask()).text);
    if (second.ok) {
      return second.verdict;
    }
    throw new InvalidVerdictError(agent, second.problem);
  };

  /** One reviewer reviews, the App posts its verdict, and it is kept. */
  const review = async (
    round: Round,
    agent: AgentRecord,
  ): Promise<VerdictRecord> => {
    const { floor, issue, pullRequest } = round;
    const model = modelOf(agent, round.defaults) ?? "";
    const verdict = await verdictOf(round, agent, model);
    const posted = reviewOf(
      { name: agent.name, aiProvider: agent.aiProvider, model },
      verdict,
      round.commentable,
    );
    const created = await github
      .repository(floor.repository)
      .createReview(pullRequest.number, {
        body: redactor.redactText(posted.body),
        comments: posted.comments.map((comment) => ({
          ...comment,
          body: redactor.redactText(comment.body),
        })),
        commitSha: pullRequest.head.sha,
      });
    const record: VerdictRecord = {
      floorId: floor.id,
      issue: issue.number,
      pullRequest: pullRequest.number,
      round: round.number,
      agentId: agent.id,
      headSha: pullRequest.head.sha,
      verdict,
      reviewUrl: created.htmlUrl,
      createdAt: now(),
    };
    await reviews.recordVerdict(record);
    const count = (severity: VerdictComment["severity"]) =>
      verdict.comments.filter((comment) => comment.severity === severity)
        .length;
    await events.publish({
      type: "review.posted",
      version: 1,
      floorId: floor.id,
      agentId: agent.id,
      issue: issue.number,
      pullRequest: pullRequest.number,
      round: round.number,
      verdict: verdict.verdict,
      blocking: count("blocking"),
      nits: count("nit"),
      url: created.htmlUrl,
    });
    return record;
  };

  /**
   * Whether the issue came to this round from `ready-to-merge`: the Merge
   * Policy sent it back for commits pushed after the reviewers approved
   * (P1-1). Read from its latest move to `needs-review` in the Activity
   * Feed; when that is not found, it is not, and the stages after review
   * run again.
   */
  const sentBackToReview = async (
    floor: FloorRecord,
    issue: number,
  ): Promise<boolean> => {
    const [moved] = (
      await events.history({
        filter: { floorId: floor.id, issue, types: ["issue.label_changed"] },
        limit: 100,
      })
    ).flatMap(({ event }) =>
      event.type === "issue.label_changed" && event.to === "needs-review"
        ? [event]
        : [],
    );
    return moved?.from === "ready-to-merge";
  };

  /**
   * Whether a round with blocking comments has stalled (FR-28): its
   * blocking comments mostly repeat the previous round's, or the fix
   * between their head commits barely changed the diff. While the
   * Decision Model is on, Jev judges (FR-17); the rules, when it cannot.
   */
  const stalled = async (
    round: Round,
    verdicts: readonly VerdictRecord[],
  ): Promise<Stall | undefined> => {
    const { floor, issue, pullRequest } = round;
    const previous = (await reviews.verdicts(floor.id, issue.number)).filter(
      ({ round: number }) => number === round.number - 1,
    );
    const [before] = previous;
    // A round the Merge Policy sent back follows an approval, not a fix
    // of blocking comments: there is no loop yet to stall.
    if (before === undefined || (await sentBackToReview(floor, issue.number))) {
      return undefined;
    }
    const fixed = await github
      .repository(floor.repository)
      .compareCommits(before.headSha, pullRequest.head.sha);
    const judged = await options.decisionModel?.reviewLoop(floor.id, {
      issue: issue.number,
      pullRequest: pullRequest.number,
      round: round.number,
      previous: describedBlocking(previous),
      current: describedBlocking(verdicts),
      fixLines: changedLines(fixed),
    });
    if (judged !== undefined) {
      return judgedStall(judged);
    }
    return stallOf({
      current: verdicts,
      previous,
      fixLines: changedLines(fixed),
    });
  };

  /**
   * Whether a round with blocking comments rejects what QA required
   * (FR-30): the previous round approved, QA then failed it, and the
   * blocking comments are mostly on what the coder changed since.
   */
  const conflicted = async (
    round: Round,
    verdicts: readonly VerdictRecord[],
  ): Promise<Conflict | undefined> => {
    const { floor, issue, pullRequest } = round;
    const previous = (await reviews.verdicts(floor.id, issue.number)).filter(
      ({ round: number }) => number === round.number - 1,
    );
    const qa = (await reviews.qaReports(floor.id, issue.number)).at(-1);
    if (previous.length === 0 || qa?.result !== "fail") {
      return undefined;
    }
    const fixed = await github
      .repository(floor.repository)
      .compareCommits(qa.headSha, pullRequest.head.sha);
    return reviewConflictOf({ current: verdicts, previous, qa, fixed });
  };

  /**
   * Ends the round (FR-27, FR-28): on to QA when every reviewer approved,
   * back to the coder below the Round Cap, or to the Owner at it.
   */
  const conclude = async (
    round: Round,
    reviewers: readonly AgentRecord[],
    verdicts: readonly VerdictRecord[],
  ): Promise<RoundOutcome> => {
    const { floor, issue, pullRequest } = round;
    const nameOf = (agentId: string) =>
      reviewers.find(({ id }) => id === agentId)?.name ?? "A reviewer";
    const blocking = verdicts.some(({ verdict }) =>
      verdict.comments.some(({ severity }) => severity === "blocking"),
    );
    const [first] = verdicts;
    const from =
      verdicts.find(({ verdict }) => verdict.verdict === "changes_requested") ??
      first;
    if (from === undefined) {
      throw new Error("A round ends with every required reviewer's verdict.");
    }

    if (!blocking) {
      // Nits alone approve. On to QA, or docs, or ready-to-merge, as the
      // Floor's team has them; the Handoff waits for the next stage's Agent
      // (a designer's at QA, on a Floor with a designer but no QA Agent).
      // Back to ready-to-merge when the Merge Policy sent it here.
      const team = await options.agents.list(floor.id);
      const stages = team.map(({ stage }) => stage);
      const roles = team.map(({ role }) => role);
      const next = (await sentBackToReview(floor, issue.number))
        ? "ready-to-merge"
        : stageAfter("needs-review", stages, roles);
      await reviews.recordHandoff({
        floorId: floor.id,
        issue: issue.number,
        stage: next,
        fromAgentId: from.agentId,
        summary: approvalHandoff({
          round: round.number,
          verdicts,
          nameOf,
          coder: round.handoff,
        }),
        createdAt: now(),
      });
      await pipeline.move(floor, issue.number, next, {
        agentId: from.agentId,
      });
      // QA's or docs' work, or the Merge Policy's at ready-to-merge.
      await options.queue?.enqueue({
        floorId: floor.id,
        issue: issue.number,
        stage: next,
        ...roleOfQueued(next, stages, roles),
      });
      return "approved";
    }

    if (round.number < floor.roundCap) {
      // The reviewers and QA disagree: the Owner decides, seeing both.
      const conflict = await conflicted(round, verdicts);
      if (conflict !== undefined) {
        const history = await reviews.verdicts(floor.id, issue.number);
        const reports = await reviews.qaReports(floor.id, issue.number);
        await escalate({
          floor,
          issue,
          pullRequest,
          reason: describeConflict(
            conflict,
            `PR #${String(pullRequest.number)} (#${String(issue.number)})`,
          ),
          links: everyRoundLinks(history, reports, pullRequest.htmlUrl),
          positions: conflictPositions({
            conflict,
            verdicts: history,
            reports,
            nameOf,
          }),
          agentId: from.agentId,
        });
        return "conflict";
      }
      // A loop that is not converging goes to the Owner early, as at the
      // cap, saying why.
      const stall = await stalled(round, verdicts);
      if (stall !== undefined) {
        await escalate({
          floor,
          issue,
          pullRequest,
          reason: `Review Loop stalled: PR #${String(pullRequest.number)} (#${String(issue.number)}) escalated at round ${String(round.number)} of ${String(floor.roundCap)}: ${describeStall(stall, round.number - 1)}.`,
          links: reviewRoundLinks(
            await reviews.verdicts(floor.id, issue.number),
            pullRequest.htmlUrl,
          ),
          agentId: from.agentId,
        });
        return "stalled";
      }
      // The coder fixes the blocking comments only, on the same branch: of
      // several work Roles, the one whose changes they concern.
      await options.turns?.sendBack(
        floor.id,
        issue.number,
        verdicts.flatMap(({ verdict }) =>
          verdict.comments
            .filter(({ severity }) => severity === "blocking")
            .map(({ path }) => path),
        ),
      );
      await reviews.recordHandoff({
        floorId: floor.id,
        issue: issue.number,
        stage: "needs-work",
        fromAgentId: from.agentId,
        summary: reviewersHandoff({
          round: round.number,
          roundCap: floor.roundCap,
          verdicts,
          nameOf,
        }),
        createdAt: now(),
      });
      await pipeline.move(floor, issue.number, "needs-work", {
        agentId: from.agentId,
      });
      await options.queue?.enqueue({
        floorId: floor.id,
        issue: issue.number,
        stage: "needs-work",
      });
      return "changes_requested";
    }

    // The Round Cap: the Owner takes it from here, with every round linked.
    await escalate({
      floor,
      issue,
      pullRequest,
      reason: `Round Cap reached: PR #${String(pullRequest.number)} (#${String(issue.number)}) still has blocking comments after ${String(round.number)} ${round.number === 1 ? "round" : "rounds"}.`,
      links: reviewRoundLinks(
        await reviews.verdicts(floor.id, issue.number),
        pullRequest.htmlUrl,
      ),
      agentId: from.agentId,
    });
    return "round_cap";
  };

  /** Lets the issue go, leaving it at its stage. */
  const letGo = async (floor: FloorRecord, issue: number): Promise<void> => {
    await pipeline
      .position(floor, issue)
      .then(({ held }) => (held ? pipeline.release(floor, issue) : undefined))
      .catch(report);
  };

  /** Raises "Agent blocked" for the round, naming why. */
  const blocked = async (
    floor: FloorRecord,
    issue: Issue,
    pullRequest: PullRequest | undefined,
    text: string,
    agent?: AgentRecord,
  ): Promise<void> => {
    await notices
      .raise({
        kind: "action",
        title: title(text),
        floorId: floor.id,
        ...(agent === undefined ? {} : { agentId: agent.id }),
        issue: { number: issue.number, url: issue.htmlUrl },
        ...(pullRequest === undefined
          ? {}
          : {
              pullRequest: {
                number: pullRequest.number,
                url: pullRequest.htmlUrl,
              },
            }),
      })
      .catch(report);
  };

  return async (work: WorkItem, signal: AbortSignal) => {
    if (work.stage !== "needs-review") {
      throw new Error(
        `The reviewer flow works needs-review, not ${work.stage}.`,
      );
    }
    const floor = await floors.get(work.floorId);
    // An archived Floor's work stops (FR-9).
    if (floor?.archivedAt !== null) {
      return "failed";
    }
    const client = github.repository(floor.repository);
    const issue = await client.getIssue(work.issue);
    const position = await pipeline.position(floor, issue.number);
    if (position.stage !== "needs-review") {
      // It moved on (or out) since it was queued: nothing to do.
      return "finished";
    }

    // Every required reviewer reviews (FR-27).
    const onFloor = await options.agents.list(floor.id);
    const reviewers = floor.requiredReviewerAgentIds
      .map((id) => onFloor.find((agent) => agent.id === id))
      .filter((agent) => agent?.enabled === true) as AgentRecord[];
    if (reviewers.length === 0) {
      await blocked(
        floor,
        issue,
        undefined,
        `Agent blocked: no required reviewer Agent can review #${String(issue.number)}. Name one in the Floor's settings, or resume one.`,
      );
      return "failed";
    }
    const { branch, batch } = await branchOf(
      options.batchBranches,
      floor.id,
      issue,
    );
    const since = batch === undefined ? undefined : baseOf(batch, issue.number);
    const [pullRequest] = await client.listPullRequests({ head: branch });
    if (pullRequest === undefined) {
      await blocked(
        floor,
        issue,
        undefined,
        `Agent blocked: #${String(issue.number)} is waiting for review, but has no open pull request.`,
      );
      return "failed";
    }

    // The round: the one under way at this head commit (after a restart,
    // or a reviewer that failed), or the next.
    const history = await reviews.verdicts(floor.id, issue.number);
    const atHead = history.filter(
      ({ headSha }) => headSha === pullRequest.head.sha,
    );
    const number =
      atHead.at(-1)?.round ??
      Math.max(0, ...history.map(({ round }) => round)) + 1;
    const done = (agent: AgentRecord) =>
      atHead.find(
        ({ round, agentId }) => round === number && agentId === agent.id,
      );
    const pending = reviewers.filter((agent) => done(agent) === undefined);

    // A restart may have left it held for this same work.
    if (!position.held) {
      await pipeline.hold(floor, issue.number, reviewers[0]?.id ?? "");
    }
    for (const agent of pending) {
      await status(floor, agent, issue.number, "working").catch(report);
    }
    const settled = async (value: "idle" | "blocked", reason?: string) => {
      for (const agent of pending) {
        await status(floor, agent, issue.number, value, reason).catch(report);
      }
    };

    try {
      const handed = await reviews.latestHandoff(
        floor.id,
        issue.number,
        "needs-review",
      );
      if (handed !== undefined && atHead.length === 0) {
        // The coder's Handoff reaches each reviewer as the round starts.
        for (const agent of reviewers) {
          await events.publish({
            type: "handoff",
            version: 1,
            floorId: floor.id,
            issue: issue.number,
            fromAgentId: handed.fromAgentId,
            toAgentId: agent.id,
            stage: "needs-review",
            summary: handed.summary,
          });
        }
      }
      const changed = await changes(floor, pullRequest, since);
      const round: Round = {
        floor,
        issue,
        pullRequest,
        number,
        changed,
        commentable:
          since === undefined
            ? changed.files
            : await client.listPullRequestFiles(pullRequest.number),
        since,
        handoff: handed?.summary,
        memory: await options.memory?.read(floor),
        defaults: await options.defaultModels?.(),
        signal,
      };
      // An approval counts only for a pull request the reviewer is shown
      // in full (P1-11): one too large to show goes to the Owner, before
      // any reviewer is asked, so no approval is recorded for it.
      const unshown = notShownInFull(round.changed.files);
      if (unshown !== undefined) {
        await escalate({
          floor,
          issue,
          pullRequest,
          reason: `Too large to review: PR #${String(pullRequest.number)} (#${String(issue.number)}) cannot be shown to a reviewer in full (${unshown}), so it is yours to review.`,
          links: [
            {
              label: `PR #${String(pullRequest.number)}`,
              url: pullRequest.htmlUrl,
            },
          ],
          ...(reviewers[0] === undefined ? {} : { agentId: reviewers[0].id }),
        });
        await settled("idle");
        return "finished";
      }
      const outcomes = await Promise.allSettled(
        pending.map((agent) => review(round, agent)),
      );
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (failure !== undefined) {
        throw failure.reason;
      }
      // This round's verdict from every reviewer: now, or before.
      const fresh = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
      const verdicts = reviewers
        .map(
          (agent) =>
            fresh.find(({ agentId }) => agentId === agent.id) ?? done(agent),
        )
        .filter((verdict) => verdict !== undefined);
      await conclude(round, reviewers, verdicts);
      await settled("idle");
      return "finished";
    } catch (error) {
      // The issue is let go either way, so the next attempt can hold it.
      await letGo(floor, issue.number);
      if (signal.aborted) {
        // AI Office is stopping: the work is queued again when it starts.
        await settled("idle");
        throw error;
      }
      const capped = pending.filter(
        ({ id }) => options.capPaused?.(id) === true,
      );
      if (capped.length > 0) {
        // Refused at a Token Cap: the round waits until they resume.
        await settled("idle");
        for (const agent of capped) {
          await status(
            floor,
            agent,
            issue.number,
            "capped",
            `${agent.name} was paused at its Token Cap`,
          ).catch(report);
        }
        return "requeued";
      }
      if (error instanceof InvalidVerdictError) {
        const reason = reasonOf(error.problem);
        await settled("idle");
        await status(floor, error.agent, issue.number, "blocked", reason).catch(
          report,
        );
        await blocked(
          floor,
          issue,
          pullRequest,
          `Agent blocked: ${error.agent.name} gave no valid verdict on PR #${String(pullRequest.number)} (#${String(issue.number)}), twice. ${reason}`,
          error.agent,
        );
        return "failed";
      }
      const reason = reasonOf(error);
      await settled("blocked", reason);
      await blocked(
        floor,
        issue,
        pullRequest,
        `Agent blocked: the review of PR #${String(pullRequest.number)} (#${String(issue.number)}) failed: ${reason}`,
      );
      return "failed";
    }
  };
}
