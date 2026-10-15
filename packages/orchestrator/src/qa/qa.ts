import type { EventBus } from "@ai-office/events";
import type {
  GitHubApp,
  Issue,
  PullRequest,
  Repository,
} from "@ai-office/github";
import {
  createRedactor,
  qaResultLabels,
  type GitIdentity,
  type PipelineStage,
  type Redactor,
} from "@ai-office/shared";

import {
  baseOf,
  branchOf,
  type BatchBranches,
} from "../batches/one-pull-request.ts";
import {
  pauseReason,
  pauseStatus,
  type Pause,
} from "../context/fresh-start.ts";
import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import { AgentBlockedError } from "../coder/coder.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { TrailerAgent } from "../git/identity.ts";
import { createPushRun } from "../git/push-run.ts";
import type { IntakeQueue } from "../intake/intake.ts";
import type { Notices } from "../notices/notices.ts";
import { keepProposals, type RepositoryMemory } from "../memory/memory.ts";
import {
  keepRoleProposals,
  memoryFiles,
  type SharedMemory,
} from "../memory/shared.ts";
import { nextRoleAt, stageAfter, type Pipeline } from "../pipeline/pipeline.ts";
import { roleOfAgent } from "../roles/roles.ts";
import { memoryRoleStore, type RoleStore } from "../roles/store.ts";
import type {
  ProgressComment,
  ProgressComments,
} from "../progress/progress.ts";
import {
  conflictPositions,
  describeConflict,
  qaConflictOf,
} from "../review/conflict.ts";
import { createEscalation } from "../review/escalation.ts";
import type { ReviewLoopStore } from "../review/store.ts";
import type { SandboxRun, SandboxRunner } from "../sandbox/runner.ts";
import type { ExecuteWork } from "../work/queue.ts";
import type { WorkItem } from "../work/store.ts";
import {
  everyRoundLinks,
  overallRoundCap,
  qaRoundCap,
  roundsSoFar,
} from "./caps.ts";
import { qaFailedHandoff, qaPassedHandoff } from "./handoff.ts";
import { qaPrompt } from "./prompt.ts";
import { parseQaReport, type QaReport } from "./report.ts";

// The QA flow (PRD FR-19, FR-28; §5 scenario 4): work queued at `needs-qa`
// is done by the Floor's QA Agent in a sandbox on the pull request's
// branch, once every required reviewer approved. It takes the reviewers'
// Handoff, runs the Floor's test command, adds tests where the change has
// none (AI Office pushes them), exercises a web UI with Playwright when
// there is one, and reports pass, or fail with the steps that reproduce
// it. The App comments the result on the pull request.
//
// A pass moves the issue on (to docs, or `ready-to-merge` when the Floor
// has no docs Agent), or, on a Floor with a designer, hands it to the
// designer at the same stage, to review its UI (`design/design.ts`). A
// failure goes back to the coder as a Handoff, until
// QA's own Round Cap (3), or the overall cap on the pull request's rounds
// of review and QA together: reaching either hands the pull request to the
// Owner (`needs-human` and an action Notice linking each round), as the
// Review Loop's Round Cap does. Below them, QA failing again, as before,
// what every reviewer approved twice in a row is a conflict between Roles
// (FR-30), handed to the Owner with both positions rather than looping. A
// QA Agent paused at a Token Cap stops at the run's end, as the coder does,
// and its work waits for it. Its prompt has the repository's memory
// (FR-53), and the entries its report proposes for it are kept for the
// Manager to curate. Its sandbox has the office-wide and Role memory
// mounted read-only (FR-54, FR-55), and what its report proposes for its
// Role's memory waits for a decision.

export interface QaFlowOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  readonly github: GitHubApp;
  readonly pipeline: Pipeline;
  readonly notices: Notices;
  readonly events: EventBus;
  readonly runner: SandboxRunner;
  /** Who a Floor's commits are by (FR-68). */
  readonly gitIdentity: (floorId: string) => Promise<GitIdentity>;
  /** Each AI Provider's default Model, for commits' `Agent:` trailers. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /** Where branches are made ready to push, one directory each. */
  readonly scratchDir: string;
  /** Where to push a repository; its GitHub page plus `.git` by default. */
  readonly pushUrl?: (repository: Repository) => string;
  /** The Review Loop's verdicts, QA's results and Handoffs. */
  readonly reviews: ReviewLoopStore;
  /** Where the next stage's work, or the coder's fix, is queued. */
  readonly queue?: IntakeQueue;
  /** Keeps the issue told of the Agent's progress (FR-21), if given. */
  readonly progress?: ProgressComments;
  /** Whether an Agent is paused at a Token Cap (FR-33). */
  readonly capPaused?: (agentId: string) => boolean;
  /** Removes credentials from what is posted on GitHub. */
  readonly redactor?: Redactor;
  /** The repository's memory: read for the prompt, and proposed to (FR-53). */
  readonly memory?: RepositoryMemory;
  /**
   * The office-wide and Role memory: mounted into the sandbox, and the
   * Role's proposed to (FR-54, FR-55).
   */
  readonly sharedMemory?: SharedMemory;
  /**
   * The office Role library (FR-98): each task reads its Agent's Role
   * from it as the task starts. The built-in Roles when absent.
   */
  readonly roles?: Pick<RoleStore, "get">;
  readonly now?: () => Date;
  /** Told of what went wrong after the work was done or given up. */
  readonly onError?: (error: unknown) => void;
  /**
   * The Batches handed over "in one PR" (ADR 0010): their issues are
   * worked on their Batch's branch and pull request.
   */
  readonly batchBranches?: BatchBranches;
}

/** How a round of QA ended. */
export type QaOutcome =
  /** Its checks passed: on to the next stage. */
  | "passed"
  /** They failed, below the caps: back to the coder. */
  | "failed"
  /** They failed at QA's Round Cap, or the overall cap: to the Owner. */
  | "capped"
  /** They failed, as before, what every reviewer approved twice: to the Owner. */
  | "conflict";

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

/** QA's comment on the pull request: its result, summary and steps. */
export function qaCommentOf(
  agent: TrailerAgent,
  round: { readonly number: number; readonly cap: number },
  report: QaReport,
  added: number,
): string {
  return [
    `**${qaResultLabels[report.result]}** by ${agent.name} (QA, ${agent.aiProvider} ${agent.model}) in AI Office, QA round ${String(round.number)} of ${String(round.cap)}.`,
    "",
    report.summary,
    ...(added === 0
      ? []
      : [
          "",
          `Tests added: ${String(added)} ${added === 1 ? "commit" : "commits"} on this branch.`,
        ]),
    ...(report.result === "pass"
      ? []
      : [
          "",
          "### Steps to reproduce",
          "",
          report.steps === "" ? "None given." : report.steps,
        ]),
  ].join("\n");
}

export function createQaFlow(options: QaFlowOptions): ExecuteWork {
  const { floors, github, pipeline, notices, events, reviews } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const escalate = createEscalation({ github, pipeline, notices });
  const pushRun = createPushRun(options);
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  const status = (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
    value: "working" | "idle" | "blocked" | "capped" | "paused",
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

  /** Raises "Agent blocked" for the issue, naming why. */
  const blocked = async (
    floor: FloorRecord,
    issue: Issue,
    text: string,
    agent?: AgentRecord,
    pullRequest?: PullRequest,
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

  /** Lets the issue go, leaving it at its stage. */
  const letGo = async (
    floor: FloorRecord,
    issue: number,
    agent: AgentRecord,
  ): Promise<void> => {
    await pipeline
      .position(floor, issue)
      .then(({ held }) =>
        held ? pipeline.release(floor, issue, agent.id) : undefined,
      )
      .catch(report);
  };

  /**
   * Ends the round on what QA found: on to the next stage, back to the
   * coder, or to the Owner at a cap.
   */
  const conclude = async (input: {
    readonly floor: FloorRecord;
    readonly issue: Issue;
    readonly pullRequest: PullRequest;
    readonly agent: AgentRecord;
    readonly round: number;
    readonly found: QaReport;
    readonly added: number;
  }): Promise<{
    readonly outcome: QaOutcome;
    readonly stage: PipelineStage;
  }> => {
    const { floor, issue, pullRequest, agent, round, found, added } = input;
    if (found.result === "pass") {
      const team = await options.agents.list(floor.id);
      const stages = team.map(({ stage }) => stage);
      const roles = team.map(({ role }) => role);
      // A designer reviews the UI next, on the same stage.
      const designer = nextRoleAt("needs-qa", roles);
      const next =
        designer === undefined
          ? stageAfter("needs-qa", stages, roles)
          : "needs-qa";
      const reviewers = await reviews.latestHandoff(
        floor.id,
        issue.number,
        "needs-qa",
      );
      await reviews.recordHandoff({
        floorId: floor.id,
        issue: issue.number,
        stage: next,
        fromAgentId: agent.id,
        summary: qaPassedHandoff({
          round,
          qa: agent.name,
          report: found,
          added,
          reviewers: reviewers?.summary,
        }),
        createdAt: now(),
      });
      if (designer === undefined) {
        await pipeline.move(floor, issue.number, next, { agentId: agent.id });
      } else {
        await pipeline.release(floor, issue.number, agent.id);
      }
      // The designer's work, docs', or the Merge Policy's at ready-to-merge.
      await options.queue?.enqueue({
        floorId: floor.id,
        issue: issue.number,
        stage: next,
        ...(designer === undefined ? {} : { role: designer }),
      });
      return { outcome: "passed", stage: next };
    }

    const verdicts = await reviews.verdicts(floor.id, issue.number);
    const reports = await reviews.qaReports(floor.id, issue.number);
    const pr = `PR #${String(pullRequest.number)} (#${String(issue.number)})`;
    const cap =
      round >= qaRoundCap
        ? `QA Round Cap reached: ${pr} still fails QA after ${String(round)} ${round === 1 ? "round" : "rounds"}.`
        : roundsSoFar(verdicts, reports) >= overallRoundCap(floor.roundCap)
          ? `Overall cap reached: ${pr} still fails after ${String(roundsSoFar(verdicts, reports))} rounds of review and QA.`
          : undefined;
    if (cap !== undefined) {
      await escalate({
        floor,
        issue,
        pullRequest,
        reason: cap,
        links: everyRoundLinks(verdicts, reports, pullRequest.htmlUrl),
        agentId: agent.id,
      });
      return { outcome: "capped", stage: "needs-human" };
    }
    // QA and the reviewers disagree: the Owner decides, seeing both.
    const conflict = qaConflictOf({ verdicts, reports });
    if (conflict !== undefined) {
      const team = await options.agents.list(floor.id);
      await escalate({
        floor,
        issue,
        pullRequest,
        reason: describeConflict(conflict, pr),
        links: everyRoundLinks(verdicts, reports, pullRequest.htmlUrl),
        positions: conflictPositions({
          conflict,
          verdicts,
          reports,
          nameOf: (agentId) =>
            team.find(({ id }) => id === agentId)?.name ?? "A reviewer",
        }),
        agentId: agent.id,
      });
      return { outcome: "conflict", stage: "needs-human" };
    }
    // The coder fixes what fails, on the same branch.
    await reviews.recordHandoff({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-work",
      fromAgentId: agent.id,
      summary: qaFailedHandoff({
        round,
        roundCap: qaRoundCap,
        qa: agent.name,
        report: found,
        added,
      }),
      createdAt: now(),
    });
    await pipeline.move(floor, issue.number, "needs-work", {
      agentId: agent.id,
    });
    await options.queue?.enqueue({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-work",
    });
    return { outcome: "failed", stage: "needs-work" };
  };

  /**
   * The work's end while its Agent is paused at a Token Cap: the issue is
   * let go and the work waits in the queue until the Agent resumes.
   */
  const pausedAt = async (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
    progress: ProgressComment | undefined,
    pause: Pause = { kind: "token_cap" },
  ): Promise<"requeued"> => {
    const reason = pauseReason(agent.name, pause);
    await letGo(floor, issue, agent);
    void progress?.finish({ outcome: "paused", reason });
    await status(floor, agent, issue, pauseStatus(pause), reason).catch(report);
    return "requeued";
  };

  return async (work: WorkItem, signal: AbortSignal) => {
    if (work.stage !== "needs-qa") {
      throw new Error(`The QA flow works needs-qa, not ${work.stage}.`);
    }
    const floor = await floors.get(work.floorId);
    // An archived Floor's work stops (FR-9).
    if (floor?.archivedAt !== null) {
      return "failed";
    }
    const client = github.repository(floor.repository);
    const issue = await client.getIssue(work.issue);
    const agent = (await options.agents.list(floor.id)).find(
      ({ id }) => id === work.agentId,
    );
    if (agent === undefined) {
      await blocked(
        floor,
        issue,
        `Agent blocked: no QA Agent can check #${String(issue.number)}. Add or resume one on this Floor.`,
      );
      return "failed";
    }
    const position = await pipeline.position(floor, issue.number);
    if (position.stage !== "needs-qa") {
      // It moved on (or out) since it was queued: nothing to do.
      return "finished";
    }
    // Its own branch, or its Batch's when it goes in one pull request.
    const { branch, batch } = await branchOf(
      options.batchBranches,
      floor.id,
      issue,
    );
    const [pullRequest] = await client.listPullRequests({ head: branch });
    if (pullRequest === undefined) {
      await blocked(
        floor,
        issue,
        `Agent blocked: #${String(issue.number)} is waiting for QA, but has no open pull request.`,
        agent,
      );
      return "failed";
    }
    // A restart may have left it held for this same work.
    if (!position.held) {
      await pipeline.hold(floor, issue.number, agent.id);
    }
    const role = await roleOfAgent(options.roles ?? memoryRoleStore(), agent);
    const trailer: TrailerAgent = {
      name: agent.name,
      role: agent.role,
      aiProvider: agent.aiProvider,
      model: modelOf(agent, await options.defaultModels?.()) ?? "",
    };
    await status(floor, agent, issue.number, "working");
    // A round interrupted by a restart is the same round again.
    const round = (await reviews.qaReports(floor.id, issue.number)).length + 1;
    // The reviewers' Handoff reaches QA as it starts.
    const handed = await reviews.latestHandoff(
      floor.id,
      issue.number,
      "needs-qa",
    );
    if (handed !== undefined) {
      await events.publish({
        type: "handoff",
        version: 1,
        floorId: floor.id,
        issue: issue.number,
        fromAgentId: handed.fromAgentId,
        toAgentId: agent.id,
        stage: "needs-qa",
        summary: handed.summary,
      });
    }
    const progress = options.progress?.start({
      floor,
      issue: issue.number,
      agent,
      stage: "needs-qa",
    });

    const memory = await options.memory?.read(floor);
    const agentMemory = await options.sharedMemory?.forAgent(
      floor.id,
      agent.role,
    );
    let run: SandboxRun | undefined;
    try {
      run = await options.runner.run({
        floor: {
          id: floor.id,
          repository: floor.repository,
          defaultBranch: floor.defaultBranch,
          setupCommand: floor.setupCommand,
        },
        agent: {
          id: agent.id,
          role: agent.role,
          aiProvider: agent.aiProvider,
          model: trailer.model,
          effort: agent.effort,
        },
        issue: { number: issue.number, title: issue.title },
        branch,
        prompt: qaPrompt({
          role,
          floor,
          agent: { ...trailer, extraInstructions: agent.extraInstructions },
          issue,
          branch,
          ...(batch === undefined
            ? {}
            : {
                shared: {
                  batchId: batch.batchId,
                  since: baseOf(batch, issue.number) ?? null,
                },
              }),
          pullRequest: pullRequest.number,
          round: { number: round, cap: qaRoundCap },
          ...(handed === undefined ? {} : { handoff: handed.summary }),
          ...(memory === undefined ? {} : { memory }),
          ...(agentMemory === undefined ? {} : { agentMemory }),
        }),
        ...(agentMemory === undefined
          ? {}
          : { memory: memoryFiles(agentMemory) }),
        gitIdentity: await options.gitIdentity(floor.id),
        signal,
      });
      const push = async () =>
        run === undefined || run.commits.length === 0
          ? undefined
          : await pushRun({
              floor,
              agentId: agent.id,
              trailer,
              issue: issue.number,
              run,
              signal,
            });
      if (run.escalated) {
        // Paused at the Fresh Start cap (FR-86): keep the tests it added.
        await push();
        return await pausedAt(floor, agent, issue.number, progress, {
          kind: "fresh_starts",
          count: run.freshStarts,
        });
      }
      if (options.capPaused?.(agent.id) === true) {
        // Paused at a Token Cap while it worked: keep the tests it added.
        await push();
        return await pausedAt(floor, agent, issue.number, progress);
      }
      const found = parseQaReport(run.lastText);
      if (found === undefined) {
        throw new AgentBlockedError(
          `${agent.name} gave no QA result on PR #${String(pullRequest.number)}.`,
        );
      }
      // The tests it added go on the pull request's branch first.
      const published = await push();
      const added = published?.commits.length ?? 0;
      const comment = await client.createComment(
        pullRequest.number,
        redactor.redactText(
          qaCommentOf(
            trailer,
            { number: round, cap: qaRoundCap },
            found,
            added,
          ),
        ),
      );
      await reviews.recordQaReport({
        floorId: floor.id,
        issue: issue.number,
        pullRequest: pullRequest.number,
        round,
        agentId: agent.id,
        headSha: published?.sha ?? pullRequest.head.sha,
        result: found.result,
        summary: found.summary,
        steps: found.steps,
        commentUrl: comment.htmlUrl,
        createdAt: now(),
      });
      await events.publish({
        type: "qa.reported",
        version: 1,
        floorId: floor.id,
        agentId: agent.id,
        issue: issue.number,
        pullRequest: pullRequest.number,
        round,
        result: found.result,
        url: comment.htmlUrl,
      });
      await keepProposals(
        options.memory,
        {
          floorId: floor.id,
          issue: issue.number,
          agentId: agent.id,
          text: run.lastText,
          tag: "qa-report",
        },
        report,
      );
      await keepRoleProposals(
        options.sharedMemory,
        {
          floorId: floor.id,
          issue: issue.number,
          agentId: agent.id,
          role: agent.role,
          text: run.lastText,
          tag: "qa-report",
        },
        report,
      );
      const ended = await conclude({
        floor,
        issue,
        pullRequest,
        agent,
        round,
        found,
        added,
      });
      void progress?.finish({
        outcome: "qa",
        passed: found.result === "pass",
        stage: ended.stage,
        pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
      });
      await status(floor, agent, issue.number, "idle");
      return "finished";
    } catch (error) {
      // The issue is let go either way, so the next attempt can hold it.
      await letGo(floor, issue.number, agent);
      if (signal.aborted) {
        void progress?.finish({ outcome: "stopped" });
        // AI Office is stopping: the work is queued again when it starts.
        await status(floor, agent, issue.number, "idle").catch(report);
        throw error;
      }
      if (options.capPaused?.(agent.id) === true) {
        // Its agent tool stopped at the Gateway's refusal: not blocked.
        return await pausedAt(floor, agent, issue.number, progress);
      }
      const reason = reasonOf(error);
      void progress?.finish({ outcome: "blocked", reason });
      await status(floor, agent, issue.number, "blocked", reason).catch(report);
      await blocked(
        floor,
        issue,
        `Agent blocked: ${agent.name} on QA of #${String(issue.number)}: ${reason}`,
        agent,
        pullRequest,
      );
      return "failed";
    } finally {
      await run?.discard().catch(report);
    }
  };
}
