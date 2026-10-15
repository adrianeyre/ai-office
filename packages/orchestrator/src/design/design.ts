import type { Issue, PullRequest } from "@ai-office/github";
import {
  createRedactor,
  designerRole,
  designResultLabels,
  type PipelineStage,
} from "@ai-office/shared";

import { baseOf, branchOf } from "../batches/one-pull-request.ts";
import { modelOf } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { AgentBlockedError } from "../coder/coder.ts";
import type { FloorRecord } from "../floors/store.ts";
import type { TrailerAgent } from "../git/identity.ts";
import { createPushRun } from "../git/push-run.ts";
import { roleOfWork } from "../manager/dispatch.ts";
import { keepProposals } from "../memory/memory.ts";
import { keepRoleProposals, memoryFiles } from "../memory/shared.ts";
import { stageAfter } from "../pipeline/pipeline.ts";
import type { ProgressComment, ProgressSummary } from "../progress/progress.ts";
import { everyRoundLinks } from "../qa/caps.ts";
import type { QaFlowOptions } from "../qa/qa.ts";
import { createEscalation } from "../review/escalation.ts";
import type { SandboxRun } from "../sandbox/runner.ts";
import type { ExecuteWork } from "../work/queue.ts";
import type { WorkItem } from "../work/store.ts";
import { designRoundCap } from "./caps.ts";
import { designChangesHandoff, designPassedHandoff } from "./handoff.ts";
import { designPrompt } from "./prompt.ts";
import { parseDesignReport, type DesignReport } from "./report.ts";

// The designer flow (PRD FR-10, FR-18, FR-19): on a Floor with a designer,
// work at `needs-qa` is the designer's once the QA Agent has passed it (or,
// on a Floor without QA, once its reviewers approved it), on the same stage
// label (ADR 0003). In a sandbox on the pull request's branch, it takes the
// Handoff left for it, finds the repository's style guide, takes
// screenshots of what the change touches with Playwright, and reviews them
// against the guide. Small styling fixes it commits itself (AI Office
// pushes them); what it cannot fix it reports as changes for the coder.
// The App comments its result on the pull request.
//
// A pass moves the issue on (to docs, or `ready-to-merge`). Changes go back
// to the coder as a Handoff, which is then reviewed, checked by QA and
// looked at by the designer again, until the designer's own Round Cap (3):
// changes asked for in its last round hand the pull request to the Owner
// (`needs-human` and an action Notice linking each round), as QA's Round
// Cap does. A designer paused at a Token Cap stops at the run's end, as the
// QA Agent does, and its work waits for it. Its prompt has the repository's
// memory (FR-53) and its sandbox the office-wide and Role memory (FR-54,
// FR-55); what its report proposes for either is kept.

/** The designer flow takes what the QA flow does. */
export type DesignFlowOptions = QaFlowOptions;

/** How a round of design review ended. */
export type DesignOutcome =
  /** The UI passes the style guide: on to the next stage. */
  | "passed"
  /** It needs changes, below the designer's Round Cap: back to the coder. */
  | "changes"
  /** It still needs changes at the designer's Round Cap: to the Owner. */
  | "capped";

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

/** The designer's comment on the pull request: its result, summary and findings. */
export function designCommentOf(
  agent: TrailerAgent,
  round: { readonly number: number; readonly cap: number },
  report: DesignReport,
  committed: number,
): string {
  return [
    `**${designResultLabels[report.result]}** by ${agent.name} (designer, ${agent.aiProvider} ${agent.model}) in AI Office, design round ${String(round.number)} of ${String(round.cap)}.`,
    "",
    report.summary,
    ...(committed === 0
      ? []
      : [
          "",
          `Design fixes made: ${String(committed)} ${committed === 1 ? "commit" : "commits"} on this branch.`,
        ]),
    ...(report.result === "pass"
      ? []
      : [
          "",
          "### Changes for the coder",
          "",
          report.findings === "" ? "None given." : report.findings,
        ]),
  ].join("\n");
}

export function createDesignFlow(options: DesignFlowOptions): ExecuteWork {
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
   * Ends the round on what the designer found: on to the next stage, back
   * to the coder, or to the Owner at its Round Cap.
   */
  const conclude = async (input: {
    readonly floor: FloorRecord;
    readonly issue: Issue;
    readonly pullRequest: PullRequest;
    readonly agent: AgentRecord;
    readonly round: number;
    readonly found: DesignReport;
    readonly committed: number;
  }): Promise<{
    readonly outcome: DesignOutcome;
    readonly stage: PipelineStage;
  }> => {
    const { floor, issue, pullRequest, agent, round, found, committed } = input;
    if (found.result === "pass") {
      const team = await options.agents.list(floor.id);
      const next = stageAfter(
        "needs-qa",
        team.map(({ stage }) => stage),
        team.map(({ role }) => role),
      );
      const qa = await reviews.latestHandoff(
        floor.id,
        issue.number,
        "needs-qa",
      );
      await reviews.recordHandoff({
        floorId: floor.id,
        issue: issue.number,
        stage: next,
        fromAgentId: agent.id,
        summary: designPassedHandoff({
          round,
          designer: agent.name,
          report: found,
          committed,
          qa: qa?.summary,
        }),
        createdAt: now(),
      });
      await pipeline.move(floor, issue.number, next, { agentId: agent.id });
      // Docs' work, or the Merge Policy's at ready-to-merge.
      await options.queue?.enqueue({
        floorId: floor.id,
        issue: issue.number,
        stage: next,
      });
      return { outcome: "passed", stage: next };
    }

    if (round >= designRoundCap) {
      await escalate({
        floor,
        issue,
        pullRequest,
        reason: `Design Round Cap reached: PR #${String(pullRequest.number)} (#${String(issue.number)}) still needs design changes after ${String(round)} ${round === 1 ? "round" : "rounds"}.`,
        links: everyRoundLinks(
          await reviews.verdicts(floor.id, issue.number),
          await reviews.qaReports(floor.id, issue.number),
          pullRequest.htmlUrl,
          await reviews.designReviews(floor.id, issue.number),
        ),
        agentId: agent.id,
      });
      return { outcome: "capped", stage: "needs-human" };
    }
    // The coder makes the changes asked for, on the same branch.
    await reviews.recordHandoff({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-work",
      fromAgentId: agent.id,
      summary: designChangesHandoff({
        round,
        roundCap: designRoundCap,
        designer: agent.name,
        report: found,
        committed,
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
    return { outcome: "changes", stage: "needs-work" };
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
  ): Promise<"requeued"> => {
    const reason = `${agent.name} was paused at its Token Cap`;
    await letGo(floor, issue, agent);
    void progress?.finish({ outcome: "paused", reason });
    await status(floor, agent, issue, "capped", reason).catch(report);
    return "requeued";
  };

  return async (work: WorkItem, signal: AbortSignal) => {
    if (roleOfWork(work) !== designerRole) {
      throw new Error(
        `The designer flow works a designer's needs-qa, not ${work.role ?? "its"} ${work.stage}.`,
      );
    }
    const floor = await floors.get(work.floorId);
    // An archived Floor's work stops (FR-9).
    if (floor?.archivedAt !== null) {
      return "failed";
    }
    const client = github.repository(floor.repository);
    const issue = await client.getIssue(work.issue);
    const team = await options.agents.list(floor.id);
    const agent = team.find(({ id }) => id === work.agentId);
    if (agent === undefined) {
      await blocked(
        floor,
        issue,
        `Agent blocked: no designer Agent can review the UI of #${String(issue.number)}. Add or resume one on this Floor.`,
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
        `Agent blocked: #${String(issue.number)} is waiting for its design review, but has no open pull request.`,
        agent,
      );
      return "failed";
    }
    // A restart may have left it held for this same work.
    if (!position.held) {
      await pipeline.hold(floor, issue.number, agent.id);
    }
    const trailer: TrailerAgent = {
      name: agent.name,
      role: agent.role,
      aiProvider: agent.aiProvider,
      model: modelOf(agent, await options.defaultModels?.()) ?? "",
    };
    await status(floor, agent, issue.number, "working");
    // A round interrupted by a restart is the same round again.
    const round =
      (await reviews.designReviews(floor.id, issue.number)).length + 1;
    // QA's Handoff (or the reviewers', without QA) reaches it as it starts.
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
        prompt: designPrompt({
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
          afterQa: team.some(({ stage }) => stage === "qa"),
          round: { number: round, cap: designRoundCap },
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
      if (options.capPaused?.(agent.id) === true) {
        // Paused at a Token Cap while it worked: keep the fixes it made.
        await push();
        return await pausedAt(floor, agent, issue.number, progress);
      }
      const found = parseDesignReport(run.lastText);
      if (found === undefined) {
        throw new AgentBlockedError(
          `${agent.name} gave no design review on PR #${String(pullRequest.number)}.`,
        );
      }
      // The fixes it made go on the pull request's branch first.
      const published = await push();
      const committed = published?.commits.length ?? 0;
      const comment = await client.createComment(
        pullRequest.number,
        redactor.redactText(
          designCommentOf(
            trailer,
            { number: round, cap: designRoundCap },
            found,
            committed,
          ),
        ),
      );
      await reviews.recordDesignReview({
        floorId: floor.id,
        issue: issue.number,
        pullRequest: pullRequest.number,
        round,
        agentId: agent.id,
        headSha: published?.sha ?? pullRequest.head.sha,
        result: found.result,
        summary: found.summary,
        findings: found.findings,
        commentUrl: comment.htmlUrl,
        createdAt: now(),
      });
      await events.publish({
        type: "design.reported",
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
          tag: "design-review",
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
          tag: "design-review",
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
        committed,
      });
      const summary: ProgressSummary = {
        outcome: "design",
        approved: found.result === "pass",
        stage: ended.stage,
        pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
      };
      void progress?.finish(summary);
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
        `Agent blocked: ${agent.name} on the design review of #${String(issue.number)}: ${reason}`,
        agent,
        pullRequest,
      );
      return "failed";
    } finally {
      await run?.discard().catch(report);
    }
  };
}
