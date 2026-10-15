import type { EventBus } from "@ai-office/events";
import type { GitHubApp, Issue, Repository } from "@ai-office/github";
import type { GitIdentity } from "@ai-office/shared";

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
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { TrailerAgent } from "../git/identity.ts";
import type { IntakeQueue } from "../intake/intake.ts";
import { createPushRun } from "../git/push-run.ts";
import type { Notices } from "../notices/notices.ts";
import { keepProposals, type RepositoryMemory } from "../memory/memory.ts";
import {
  keepRoleProposals,
  memoryFiles,
  type SharedMemory,
} from "../memory/shared.ts";
import type { Pipeline } from "../pipeline/pipeline.ts";
import { roleOfAgent } from "../roles/roles.ts";
import { memoryRoleStore, type RoleStore } from "../roles/store.ts";
import type {
  ProgressComment,
  ProgressComments,
} from "../progress/progress.ts";
import { maxHandoffPart, parseHandoff } from "../review/handoff.ts";
import type { HandoffSummary, ReviewLoopStore } from "../review/store.ts";
import type { SandboxRun, SandboxRunner } from "../sandbox/runner.ts";
import type { ExecuteWork } from "../work/queue.ts";
import type { WorkItem } from "../work/store.ts";
import { docsPrompt } from "./prompt.ts";

// The docs flow (PRD FR-18, FR-19): work queued at `needs-docs`, once a
// pull request has passed review and QA, is done by the Floor's docs Agent
// (a small Model by default) in a sandbox on the pull request's branch. It
// takes the Handoff QA left, updates the README, the changelog and the
// docstrings for the change, and AI Office pushes what it committed as the
// Owner's commits. Then the issue moves to `ready-to-merge`, with the docs
// Agent's Handoff, and the Merge Policy's work is queued. A Floor without a docs Agent never reaches this stage
// (`stageAfter` skips it). A docs Agent paused at a Token Cap stops at the
// run's end, as the coder does, and its work waits for it. Its prompt has
// the repository's memory (FR-53), and the entries its Handoff proposes
// for it are kept for the Manager to curate. Its sandbox has the
// office-wide and Role memory mounted read-only (FR-54, FR-55), and what
// its Handoff proposes for its Role's memory waits for a decision.

export interface DocsFlowOptions {
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
  /** The Handoffs it takes and leaves. */
  readonly reviews: ReviewLoopStore;
  /** Where the Merge Policy's work is queued, at `ready-to-merge`. */
  readonly queue?: IntakeQueue;
  /** Keeps the issue told of the Agent's progress (FR-21), if given. */
  readonly progress?: ProgressComments;
  /** Whether an Agent is paused at a Token Cap (FR-33). */
  readonly capPaused?: (agentId: string) => boolean;
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

const part = (text: string): string =>
  text.length <= maxHandoffPart
    ? text
    : `${text.slice(0, maxHandoffPart - 1)}…`;

/**
 * The docs Agent's Handoff on to `ready-to-merge`: its own words, or its
 * commits', with what it took for the rest.
 */
export function docsHandoff(input: {
  /** The docs Agent's last text, with its `<handoff>` block if it wrote one. */
  readonly text: string | null;
  /** The subjects of the commits it made. */
  readonly subjects: readonly string[];
  /** The Handoff it took. */
  readonly took: HandoffSummary | undefined;
}): HandoffSummary {
  const own = parseHandoff(input.text);
  const commits = input.subjects.filter((subject) => subject !== "");
  return {
    changed:
      own.changed ??
      part(
        commits.length === 0
          ? "Nothing needed documenting."
          : `${String(commits.length)} documentation ${commits.length === 1 ? "commit" : "commits"}: ${commits.join("; ")}.`,
      ),
    check:
      own.check ??
      input.took?.check ??
      "That the documentation matches the change.",
    risks: own.risks ?? input.took?.risks ?? "None reported.",
  };
}

export function createDocsFlow(options: DocsFlowOptions): ExecuteWork {
  const { floors, github, pipeline, notices, events, reviews } = options;
  const now = options.now ?? (() => new Date());
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
  ): Promise<void> => {
    await notices
      .raise({
        kind: "action",
        title: title(text),
        floorId: floor.id,
        ...(agent === undefined ? {} : { agentId: agent.id }),
        issue: { number: issue.number, url: issue.htmlUrl },
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

  /** The work's end while its Agent is paused at a Token Cap. */
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
    if (work.stage !== "needs-docs") {
      throw new Error(`The docs flow works needs-docs, not ${work.stage}.`);
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
        `Agent blocked: no docs Agent can document #${String(issue.number)}. Add or resume one on this Floor.`,
      );
      return "failed";
    }
    const position = await pipeline.position(floor, issue.number);
    if (position.stage !== "needs-docs") {
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
        `Agent blocked: #${String(issue.number)} is waiting for docs, but has no open pull request.`,
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
    // QA's Handoff (or the reviewers', without QA) reaches it as it starts.
    const handed = await reviews.latestHandoff(
      floor.id,
      issue.number,
      "needs-docs",
    );
    if (handed !== undefined) {
      await events.publish({
        type: "handoff",
        version: 1,
        floorId: floor.id,
        issue: issue.number,
        fromAgentId: handed.fromAgentId,
        toAgentId: agent.id,
        stage: "needs-docs",
        summary: handed.summary,
      });
    }
    const progress = options.progress?.start({
      floor,
      issue: issue.number,
      agent,
      stage: "needs-docs",
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
        prompt: docsPrompt({
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
      // What it documented goes on the pull request's branch.
      const published =
        run.commits.length === 0
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
        // Paused at the Fresh Start cap (FR-86): what it committed is kept.
        return await pausedAt(floor, agent, issue.number, progress, {
          kind: "fresh_starts",
          count: run.freshStarts,
        });
      }
      if (options.capPaused?.(agent.id) === true) {
        // Paused at a Token Cap while it worked: what it committed is kept.
        return await pausedAt(floor, agent, issue.number, progress);
      }
      await reviews.recordHandoff({
        floorId: floor.id,
        issue: issue.number,
        stage: "ready-to-merge",
        fromAgentId: agent.id,
        summary: docsHandoff({
          text: run.lastText,
          subjects: published?.subjects ?? [],
          took: handed?.summary,
        }),
        createdAt: now(),
      });
      await keepProposals(
        options.memory,
        {
          floorId: floor.id,
          issue: issue.number,
          agentId: agent.id,
          text: run.lastText,
          tag: "handoff",
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
          tag: "handoff",
        },
        report,
      );
      await pipeline.move(floor, issue.number, "ready-to-merge", {
        agentId: agent.id,
      });
      await options.queue?.enqueue({
        floorId: floor.id,
        issue: issue.number,
        stage: "ready-to-merge",
      });
      void progress?.finish({
        outcome: "pull_request",
        stage: "ready-to-merge",
        pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
        opened: false,
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
        `Agent blocked: ${agent.name} on docs of #${String(issue.number)}: ${reason}`,
        agent,
      );
      return "failed";
    } finally {
      await run?.discard().catch(report);
    }
  };
}
