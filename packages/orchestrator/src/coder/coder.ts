import type { EventBus } from "@ai-office/events";
import type { GitHubApp, Issue, Repository } from "@ai-office/github";
import type { GitIdentity } from "@ai-office/shared";

import {
  pauseReason,
  pauseStatus,
  type Pause,
} from "../context/fresh-start.ts";
import { modelOf } from "../agents/agents.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { IntakeQueue } from "../intake/intake.ts";
import {
  baseOf,
  branchOf,
  closes,
  writeBatchPullRequest,
  type BatchBranch,
  type BatchBranches,
} from "../batches/one-pull-request.ts";
import { liveViewUrl } from "../agents/live-view.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { runGit } from "../git/command.ts";
import { agentTrailer, type TrailerAgent } from "../git/identity.ts";
import type { Published } from "../git/publish.ts";
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
import {
  blockingComments,
  coderHandoff,
  reviewersHandoff,
  type BlockingComment,
} from "../review/handoff.ts";
import type { ReviewLoopStore } from "../review/store.ts";
import { qaRoundCap } from "../qa/caps.ts";
import { qaFailedHandoff } from "../qa/handoff.ts";
import { designRoundCap } from "../design/caps.ts";
import { designChangesHandoff } from "../design/handoff.ts";
import type { SandboxRun, SandboxRunner } from "../sandbox/runner.ts";
import type { ExecuteWork } from "../work/queue.ts";
import type { WorkItem } from "../work/store.ts";
import {
  afterDelivery,
  type Delivered,
  type WorkTurns,
  type WorkTurnsRecord,
} from "../work/turns.ts";
import { coderPrompt, type CoderPromptInput } from "./prompt.ts";

// The coder flow (PRD FR-18, FR-19, FR-21, FR-68 to FR-70; §5 scenario 2;
// ADR 0002): work queued at `needs-work` is done by the Floor's coder
// Agent in a sandbox. Its Agent holds the issue (`in-progress`) and works
// it from a prompt built from the issue, the Floor's settings and the
// commit rules. When it finishes, AI Office pushes the branch as the
// GitHub App (each new commit authored and committed as the Owner, with
// the Agent's trailer), opens one pull request for the issue with
// `Closes #N`, moves the issue to `needs-review`, queues its review round
// and raises an info Notice. Before review, the branch is rebased onto the
// default branch as GitHub has it, so it builds on the work merged since
// it began, such as an earlier issue of its Batch it overlaps (FR-25.5);
// when that conflicts, it is pushed as it was, and its Handoff says so. When it cannot, it lets the issue go and
// raises an action Notice saying why the Agent is blocked. Work sent back
// by reviewers (the Review Loop) or by QA has what they found in its
// prompt, with their Handoff. When its Agent was paused at a Token Cap
// (FR-33), the run's end is the safe point: what it committed is pushed,
// the issue is let go, and the work waits in the queue until the Agent
// resumes. Its prompt has the repository's memory (FR-53), and the
// entries its Handoff proposes for it are kept for the Manager to curate.
// Its sandbox has the office-wide and Role memory mounted read-only (FR-54,
// FR-55), and the entries its Handoff proposes for its Role's memory wait
// for the Manager or the Owner to decide.
//
// An issue whose Batch's Plan gives it several work Roles (FR-25 (1)) is
// worked by each in turn on its one branch: when a Role that is not the
// last finishes, AI Office pushes what it committed (not rebased: that is
// for review), keeps its Handoff, lets the issue go at `needs-work`, and
// queues its work again, for the next Role's Agent. That Agent takes the
// Handoff with its prompt, and the Handoff is published as it starts (the
// ticket's walk between desks, FR-59). After the last Role, it goes to
// review as above. The files each Role's commits change are kept, so the
// Review Loop can send a fix to the Role they concern.
//
// An issue of a Batch handed over "in one PR" (ADR 0010) is worked on its
// Batch's branch, after the issues before it, and goes into the Batch's one
// pull request rather than one of its own: opened as the first of them goes
// to review, and written again as each joins it, with `Closes #N` for each.
// Its branch is not rebased before review: earlier issues' commits, which
// their reviewers approved as they are, stay as they are.

export interface CoderFlowOptions {
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
  /** AI Office's address, for links to an Agent's live view. */
  readonly publicUrl?: string;
  /** Where the review round is queued once the pull request is ready. */
  readonly queue?: IntakeQueue;
  /** The Review Loop's verdicts and Handoffs (FR-26, FR-27). */
  readonly reviews?: ReviewLoopStore;
  readonly now?: () => Date;
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
  /**
   * The turns of the work Roles an issue's Plan gives it (FR-25 (1)):
   * whether to hand it to the next Role or on to review.
   */
  readonly turns?: Pick<WorkTurns, "get" | "delivered">;
  /**
   * The Batches handed over "in one PR" (ADR 0010): their issues are worked
   * on their Batch's branch, into its one pull request. None without it.
   */
  readonly batchBranches?: BatchBranches;
  /** Told of what went wrong after the work was done or given up. */
  readonly onError?: (error: unknown) => void;
}

/** Why an Agent could not finish its work: the reason the Owner reads. */
export class AgentBlockedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentBlockedError";
  }
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

/** The files the run's own commits changed, each once, in order. */
async function changedFiles(
  run: SandboxRun,
  signal: AbortSignal,
): Promise<string[]> {
  const files = new Set<string>();
  for (const sha of run.commits) {
    const listed = await runGit(
      "list the files a commit changed",
      ["show", "--no-renames", "--name-only", "--format=", sha],
      { cwd: run.workspace, signal },
    );
    for (const file of listed.split("\n")) {
      if (file.trim() !== "") {
        files.add(file.trim());
      }
    }
  }
  return [...files];
}

export function createCoderFlow(options: CoderFlowOptions): ExecuteWork {
  const { floors, github, pipeline, notices, events } = options;
  const now = options.now ?? (() => new Date());
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

  const pullRequestBody = (
    floor: FloorRecord,
    agent: AgentRecord,
    trailer: TrailerAgent,
    issue: number,
  ): string => {
    const liveView =
      options.publicUrl === undefined
        ? ""
        : ` ([live view](${liveViewUrl(options.publicUrl, floor.id, agent.id)}))`;
    return [
      `Closes #${String(issue)}`,
      "",
      `Worked by ${agentTrailer(trailer).replace(/^Agent: /, "")} in AI Office${liveView}.`,
      "",
    ].join("\n");
  };

  const pushRun = createPushRun(options);
  const push = (
    floor: FloorRecord,
    agent: AgentRecord,
    trailer: TrailerAgent,
    issue: Issue,
    run: SandboxRun,
    signal: AbortSignal,
    rebase = false,
  ): Promise<Published> =>
    pushRun({
      floor,
      agentId: agent.id,
      trailer,
      issue: issue.number,
      run,
      rebase,
      signal,
    });

  /** Pushes the work, opens (or finds) its pull request, moves it on. */
  const deliver = async (
    floor: FloorRecord,
    agent: AgentRecord,
    trailer: TrailerAgent,
    issue: Issue,
    run: SandboxRun,
    fixing: readonly BlockingComment[],
    fixingQa: string | undefined,
    fixingDesign: string | undefined,
    signal: AbortSignal,
    files: readonly string[],
    batch: BatchBranch | undefined,
  ): Promise<{
    readonly pullRequest: { readonly number: number; readonly url: string };
    readonly opened: boolean;
  }> => {
    if (run.commits.length === 0) {
      throw new AgentBlockedError(
        `${agent.name} finished without committing anything.`,
      );
    }
    // Before review, onto the work merged since it began (FR-25.5); never a
    // shared branch, whose earlier issues were approved as they are.
    const published = await push(
      floor,
      agent,
      trailer,
      issue,
      run,
      signal,
      batch === undefined,
    );
    const client = github.repository(floor.repository);
    const subject = {
      floorId: floor.id,
      agentId: agent.id,
      issue: issue.number,
    };

    // One pull request per issue (FR-21), or per Batch handed over "in one
    // PR" (ADR 0010): later work updates it.
    let pullRequest: { readonly number: number; readonly htmlUrl: string };
    let open: boolean;
    let joined: boolean;
    if (batch === undefined) {
      const [found] = await client.listPullRequests({ head: run.branch });
      pullRequest =
        found ??
        (await client.createPullRequest({
          title: issue.title,
          body: pullRequestBody(floor, agent, trailer, issue.number),
          head: run.branch,
          base: floor.defaultBranch,
        }));
      open = found !== undefined;
      joined = !open;
    } else {
      const written = await writeBatchPullRequest({
        client,
        ...(options.reviews === undefined ? {} : { reviews: options.reviews }),
        floorId: floor.id,
        base: floor.defaultBranch,
        batch,
      });
      pullRequest = written;
      open = !written.opened;
      // Each issue joins the Batch's pull request once, with its `Closes #N`.
      joined = written.opened || !closes(written.before, issue.number);
    }
    if (joined) {
      await events.publish({
        type: "pull_request.opened",
        version: 1,
        ...subject,
        pullRequest: pullRequest.number,
        url: pullRequest.htmlUrl,
        branch: run.branch,
      });
    }
    // The coder's Handoff, which the reviewers take with the next round.
    await options.reviews?.recordHandoff({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-review",
      fromAgentId: agent.id,
      summary: coderHandoff({
        text: run.lastText,
        subjects: published.subjects,
        issue,
        fixing,
        ...(fixingQa === undefined ? {} : { fixingQa }),
        ...(fixingDesign === undefined ? {} : { fixingDesign }),
        ...(published.rebase === undefined ? {} : { rebase: published.rebase }),
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
    // The last of its work Roles (or a fix) is done: on to review.
    await options.turns?.delivered(floor.id, issue.number, files);
    await pipeline.move(floor, issue.number, "needs-review", {
      agentId: agent.id,
    });
    await options.queue?.enqueue({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-review",
    });
    await notices.raise({
      kind: "info",
      title: title(
        `PR #${String(pullRequest.number)} ${open ? "updated" : "opened"}: ${issue.title}`,
      ),
      floorId: floor.id,
      agentId: agent.id,
      issue: { number: issue.number, url: issue.htmlUrl },
      pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
    });
    return {
      pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
      opened: !open,
    };
  };

  /**
   * Hands the issue to the next of its work Roles (FR-25 (1), FR-26): the
   * branch is pushed as it is, the Agent's Handoff is kept for the next
   * Role's Agent, the issue is let go at `needs-work`, and its work queued
   * again, which the work queue gives to the next Role once this ends.
   */
  const handOn = async (
    floor: FloorRecord,
    agent: AgentRecord,
    trailer: TrailerAgent,
    issue: Issue,
    run: SandboxRun,
    files: readonly string[],
    signal: AbortSignal,
  ): Promise<void> => {
    if (run.commits.length === 0) {
      throw new AgentBlockedError(
        `${agent.name} finished without committing anything.`,
      );
    }
    const published = await push(floor, agent, trailer, issue, run, signal);
    await options.reviews?.recordHandoff({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-work",
      fromAgentId: agent.id,
      summary: coderHandoff({
        text: run.lastText,
        subjects: published.subjects,
        issue,
        fixing: [],
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
    await options.turns?.delivered(floor.id, issue.number, files);
    await pipeline.release(floor, issue.number, agent.id);
    await options.queue?.enqueue({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-work",
    });
  };

  /** A work Role's name, from the library; its id if it has gone. */
  const roleName = async (id: string): Promise<string> =>
    (await (options.roles ?? memoryRoleStore()).get(id))?.name ?? id;

  /**
   * What the prompt says of the issue's turns, while its work Roles take
   * them (FR-25 (1)): every Role in order, whose turn it is, and the
   * Handoff of the Role before, which is published now, as this Agent
   * takes it.
   */
  const turnsOf = async (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
    turns: WorkTurnsRecord,
  ): Promise<CoderPromptInput["turns"]> => {
    const roles = await Promise.all(turns.roles.map(roleName));
    if (turns.turn === 0) {
      return { roles, turn: 0 };
    }
    const handed = await options.reviews?.latestHandoff(
      floor.id,
      issue,
      "needs-work",
    );
    if (handed === undefined) {
      return { roles, turn: turns.turn };
    }
    await events.publish({
      type: "handoff",
      version: 1,
      floorId: floor.id,
      issue,
      fromAgentId: handed.fromAgentId,
      toAgentId: agent.id,
      stage: "needs-work",
      summary: handed.summary,
    });
    const from = (await options.agents.list(floor.id)).find(
      ({ id }) => id === handed.fromAgentId,
    );
    return {
      roles,
      turn: turns.turn,
      from: {
        name: from?.name ?? "The Agent before you",
        handoff: handed.summary,
      },
    };
  };

  /**
   * What the reviewers sent back, when the issue's last round had blocking
   * comments: those comments and the reviewers' Handoff, which the coder
   * takes now (FR-26, FR-27). Undefined for work from the issue alone.
   */
  const reviewFeedback = async (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
  ) => {
    if (options.reviews === undefined) {
      return undefined;
    }
    const verdicts = await options.reviews.verdicts(floor.id, issue);
    const round = Math.max(0, ...verdicts.map((verdict) => verdict.round));
    const last = verdicts.filter((verdict) => verdict.round === round);
    const onFloor = await options.agents.list(floor.id);
    const nameOf = (agentId: string) =>
      onFloor.find(({ id }) => id === agentId)?.name ?? "A reviewer";
    const comments = blockingComments(last, nameOf);
    const from =
      last.find(({ verdict }) => verdict.verdict === "changes_requested") ??
      last[0];
    if (comments.length === 0 || from === undefined) {
      return undefined;
    }
    const handed = await options.reviews.latestHandoff(
      floor.id,
      issue,
      "needs-work",
    );
    const handoff =
      handed?.summary ??
      reviewersHandoff({
        round,
        roundCap: floor.roundCap,
        verdicts: last,
        nameOf,
      });
    await events.publish({
      type: "handoff",
      version: 1,
      floorId: floor.id,
      issue,
      fromAgentId: handed?.fromAgentId ?? from.agentId,
      toAgentId: agent.id,
      stage: "needs-work",
      summary: handoff,
    });
    return { round, roundCap: floor.roundCap, comments, handoff };
  };

  /**
   * What QA sent back, when its latest round failed after the issue's last
   * round of review: what it found, how to reproduce it, and its Handoff,
   * which the coder takes now (FR-26, FR-28).
   */
  const qaFeedback = async (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
  ) => {
    if (options.reviews === undefined) {
      return undefined;
    }
    const latest = (await options.reviews.qaReports(floor.id, issue)).at(-1);
    if (latest?.result !== "fail") {
      return undefined;
    }
    const verdicts = await options.reviews.verdicts(floor.id, issue);
    if (verdicts.some(({ createdAt }) => createdAt > latest.createdAt)) {
      return undefined;
    }
    const handed = await options.reviews.latestHandoff(
      floor.id,
      issue,
      "needs-work",
    );
    const qa =
      (await options.agents.list(floor.id)).find(
        ({ id }) => id === latest.agentId,
      )?.name ?? "QA";
    const handoff =
      handed?.summary ??
      qaFailedHandoff({
        round: latest.round,
        roundCap: qaRoundCap,
        qa,
        report: latest,
        added: 0,
      });
    await events.publish({
      type: "handoff",
      version: 1,
      floorId: floor.id,
      issue,
      fromAgentId: handed?.fromAgentId ?? latest.agentId,
      toAgentId: agent.id,
      stage: "needs-work",
      summary: handoff,
    });
    return {
      round: latest.round,
      roundCap: qaRoundCap,
      summary: latest.summary,
      steps: latest.steps,
      handoff,
    };
  };

  /**
   * What a designer sent back, when its latest round asked for changes
   * after the issue's last round of review: what it found, the changes to
   * make, and its Handoff, which the coder takes now (FR-10, FR-26).
   */
  const designFeedback = async (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
  ) => {
    if (options.reviews === undefined) {
      return undefined;
    }
    const latest = (await options.reviews.designReviews(floor.id, issue)).at(
      -1,
    );
    if (latest?.result !== "changes") {
      return undefined;
    }
    const verdicts = await options.reviews.verdicts(floor.id, issue);
    if (verdicts.some(({ createdAt }) => createdAt > latest.createdAt)) {
      return undefined;
    }
    const handed = await options.reviews.latestHandoff(
      floor.id,
      issue,
      "needs-work",
    );
    const designer =
      (await options.agents.list(floor.id)).find(
        ({ id }) => id === latest.agentId,
      )?.name ?? "The designer";
    const handoff =
      handed?.summary ??
      designChangesHandoff({
        round: latest.round,
        roundCap: designRoundCap,
        designer,
        report: latest,
        committed: 0,
      });
    await events.publish({
      type: "handoff",
      version: 1,
      floorId: floor.id,
      issue,
      fromAgentId: handed?.fromAgentId ?? latest.agentId,
      toAgentId: agent.id,
      stage: "needs-work",
      summary: handoff,
    });
    return {
      round: latest.round,
      roundCap: designRoundCap,
      summary: latest.summary,
      findings: latest.findings,
      handoff,
    };
  };

  /**
   * The work's end while its Agent is paused at a Token Cap: the issue is
   * let go and the work goes back in the queue, to start again when the
   * Agent resumes. The cap's Notice tells the Owner.
   */
  const pausedAt = async (
    floor: FloorRecord,
    agent: AgentRecord,
    issue: number,
    progress: ProgressComment | undefined,
    pause: Pause = { kind: "token_cap" },
  ): Promise<"requeued"> => {
    const reason = pauseReason(agent.name, pause);
    await pipeline
      .position(floor, issue)
      .then(({ held }) =>
        held ? pipeline.release(floor, issue, agent.id) : undefined,
      )
      .catch(report);
    void progress?.finish({ outcome: "paused", reason });
    await status(floor, agent, issue, pauseStatus(pause), reason).catch(report);
    return "requeued";
  };

  return async (work: WorkItem, signal: AbortSignal) => {
    if (work.stage !== "needs-work") {
      throw new Error(`The coder flow works needs-work, not ${work.stage}.`);
    }
    const floor = await floors.get(work.floorId);
    // An archived Floor's work stops (FR-9).
    if (floor?.archivedAt !== null) {
      return "failed";
    }
    const issue = await github
      .repository(floor.repository)
      .getIssue(work.issue);
    const agent = (await options.agents.list(floor.id)).find(
      ({ id }) => id === work.agentId,
    );
    if (agent === undefined) {
      await notices.raise({
        kind: "action",
        title: title(
          `Agent blocked: no coder Agent can work #${String(issue.number)}. Add or resume one on this Floor.`,
        ),
        floorId: floor.id,
        issue: { number: issue.number, url: issue.htmlUrl },
      });
      return "failed";
    }

    const position = await pipeline.position(floor, issue.number);
    if (position.stage !== "needs-work") {
      // It moved on (or out) since it was queued: nothing to do.
      return "finished";
    }
    // A restart may have left it held for this same work.
    if (!position.held) {
      await pipeline.hold(floor, issue.number, agent.id);
    }
    const role = await roleOfAgent(options.roles ?? memoryRoleStore(), agent);
    // Its own branch, or its Batch's when it goes in one pull request.
    const { branch, batch } = await branchOf(
      options.batchBranches,
      floor.id,
      issue,
    );
    const trailer: TrailerAgent = {
      name: agent.name,
      role: agent.role,
      aiProvider: agent.aiProvider,
      model: modelOf(agent, await options.defaultModels?.()) ?? "",
    };
    await status(floor, agent, issue.number, "working");
    // While its work Roles take their turns, there is no review yet.
    const turns = await options.turns?.get(floor.id, issue.number);
    const taking = turns === undefined || turns.reviewing ? undefined : turns;
    const turnLines =
      taking === undefined
        ? undefined
        : await turnsOf(floor, agent, issue.number, taking);
    const feedback =
      taking === undefined
        ? await reviewFeedback(floor, agent, issue.number)
        : undefined;
    const fromQa =
      taking === undefined && feedback === undefined
        ? await qaFeedback(floor, agent, issue.number)
        : undefined;
    const fromDesign =
      taking === undefined && feedback === undefined && fromQa === undefined
        ? await designFeedback(floor, agent, issue.number)
        : undefined;
    // Written in the background, within GitHub's limits: never awaited.
    const progress = options.progress?.start({
      floor,
      issue: issue.number,
      agent,
      stage: "needs-work",
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
        prompt: coderPrompt({
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
          ...(feedback === undefined ? {} : { feedback }),
          ...(fromQa === undefined ? {} : { qaFeedback: fromQa }),
          ...(turnLines === undefined ? {} : { turns: turnLines }),
          ...(fromDesign === undefined ? {} : { designFeedback: fromDesign }),
          ...(memory === undefined ? {} : { memory }),
          ...(agentMemory === undefined ? {} : { agentMemory }),
        }),
        ...(agentMemory === undefined
          ? {}
          : { memory: memoryFiles(agentMemory) }),
        gitIdentity: await options.gitIdentity(floor.id),
        signal,
      });
      if (run.escalated) {
        // Paused at the Fresh Start cap (FR-86): keep what it committed.
        if (run.commits.length > 0) {
          await push(floor, agent, trailer, issue, run, signal);
        }
        return await pausedAt(floor, agent, issue.number, progress, {
          kind: "fresh_starts",
          count: run.freshStarts,
        });
      }
      if (options.capPaused?.(agent.id) === true) {
        // Paused at a Token Cap while it worked: keep what it committed.
        if (run.commits.length > 0) {
          await push(floor, agent, trailer, issue, run, signal);
        }
        return await pausedAt(floor, agent, issue.number, progress);
      }
      const files = await changedFiles(run, signal);
      const next: Delivered | undefined =
        turns === undefined
          ? undefined
          : afterDelivery(turns, files, now()).delivered;
      if (next?.next === "role") {
        await handOn(floor, agent, trailer, issue, run, files, signal);
        void progress?.finish({
          outcome: "handed_on",
          role: await roleName(next.role),
        });
        await status(floor, agent, issue.number, "idle");
        return "finished";
      }
      const delivered = await deliver(
        floor,
        agent,
        trailer,
        issue,
        run,
        feedback?.comments ?? [],
        fromQa?.summary,
        fromDesign?.summary,
        signal,
        files,
        batch,
      );
      void progress?.finish({
        outcome: "pull_request",
        stage: "needs-review",
        ...delivered,
      });
      await status(floor, agent, issue.number, "idle");
      return "finished";
    } catch (error) {
      // The issue is let go either way, so the next attempt can hold it.
      await pipeline
        .position(floor, issue.number)
        .then(({ held }) =>
          held ? pipeline.release(floor, issue.number, agent.id) : undefined,
        )
        .catch(report);
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
      await notices
        .raise({
          kind: "action",
          title: title(
            `Agent blocked: ${agent.name} on #${String(issue.number)}: ${reason}`,
          ),
          floorId: floor.id,
          agentId: agent.id,
          issue: { number: issue.number, url: issue.htmlUrl },
        })
        .catch(report);
      return "failed";
    } finally {
      await run?.discard().catch(report);
    }
  };
}
