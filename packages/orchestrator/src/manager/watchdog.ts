import type { EventBus, EventType } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import {
  createRedactor,
  defaultAgentFailures,
  defaultMaxFailures,
  defaultMaxStallRestarts,
  defaultStallTimeoutMinutes,
  managerActionLabels,
  type ManagerAction,
  type PipelineStage,
  type Redactor,
  type Role,
  type WatchdogTrigger,
} from "@ai-office/shared";

import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { Notices } from "../notices/notices.ts";
import { createPipeline, positionOf } from "../pipeline/pipeline.ts";
import type { ReviewLoopStore } from "../review/store.ts";
import type { WorkQueue } from "../work/queue.ts";
import type { WorkItem, WorkQueueStore } from "../work/store.ts";
import {
  assertManagerMay,
  assertManagerMayMove,
  ManagerAuthorityError,
  managerGitHub,
} from "./authority.ts";
import type { DecisionRecord, DecisionStore } from "./decision-store.ts";
import { freeAgent, roleOfWork, sandboxStageAt } from "./dispatch.ts";

// The Manager's watchdog (PRD FR-23): plain code, no model, that looks over
// each Floor's work every minute and decides what to do about what it
// spots, within the Manager's authority (`authority.ts`):
//
// - **Stalled work**: work running with no sign of progress (its start, or
//   the last event about its issue: output, a tool call, a model call, a
//   review) for longer than the stall timeout (20 minutes by default). It
//   is stopped and given to another free Agent of its Role (reassign), or
//   queued again (retry). Once an issue's work at a stage has stalled more
//   than twice, it is escalated instead: stopped, labelled `needs-human`
//   and the Owner told with an action Notice.
// - **Repeated failures**: an issue whose work at a stage failed is queued
//   again, for another free Agent of the Role if there is one; at 3
//   failures in a row it is escalated the same way. An Agent whose last 3
//   tasks failed, on more than one issue, is paused, and the Owner told.
// - **Loops near their cap**: a Review Loop with one round left before its
//   Round Cap is escalated with an action Notice, so the Owner can step in
//   before it ends at `needs-human`.
//
// Every decision is recorded in the decision log, keyed by the condition it
// answered so it is taken once, and is posted as a comment on the issue and
// a `manager.decision` event. A request beyond the Manager's authority, such
// as merging or raising a cap, is refused: a `manager.action_refused`
// event, and a `ManagerAuthorityError`.

/** A decision for the Manager to take, as the watchdog (or anyone) asks it. */
export interface DecisionRequest {
  readonly floorId: string;
  readonly issue: number;
  /** What to do: refused unless it is within the Manager's authority. */
  readonly action: string;
  readonly trigger: WatchdogTrigger;
  /** The stage of the work it concerns. */
  readonly stage: PipelineStage;
  /** The Role of the work it concerns, when it is not its stage's first. */
  readonly role?: Role;
  /** The running work it stops, if any. */
  readonly workId?: number;
  /** The Agent whose work it takes away (or retries), or that it pauses. */
  readonly fromAgentId?: string;
  /** The Agent to give the work to: for `reassign`. */
  readonly toAgentId?: string;
  /** Where to move the issue: for `relabel`, or `escalate` to the Owner. */
  readonly to?: PipelineStage;
  /** Names the condition it answers, so it is decided once. */
  readonly key: string;
  /** Why, in a sentence, for the comment and any Notice. */
  readonly reason: string;
}

export interface Watchdog {
  /** Looks over every Floor in use once; returns the decisions it took. */
  check(): Promise<DecisionRecord[]>;
  /**
   * Takes one decision as the Floor's Manager: undefined when its
   * condition was decided already. Throws a `ManagerAuthorityError` (and
   * records the refusal) for anything beyond the Manager's authority.
   */
  act(request: DecisionRequest): Promise<DecisionRecord | undefined>;
  /** Checks every interval until stopped. */
  start(): void;
  /** Stops checking, waiting for a check in progress. */
  stop(): Promise<void>;
}

/** The watchdog's limits; each has a default. */
export interface WatchdogLimits {
  /** How long running work may show no progress before it has stalled. */
  readonly stallTimeoutMs: number;
  /** Failures in a row of an issue's work at a stage before escalating. */
  readonly maxFailures: number;
  /** Stalls of an issue's work at a stage that are retried; then escalated. */
  readonly maxStallRestarts: number;
  /** Failed tasks in a row, on more than one issue, that pause an Agent. */
  readonly agentFailures: number;
}

export const defaultWatchdogLimits: WatchdogLimits = {
  stallTimeoutMs: defaultStallTimeoutMinutes * 60 * 1000,
  maxFailures: defaultMaxFailures,
  maxStallRestarts: defaultMaxStallRestarts,
  agentFailures: defaultAgentFailures,
};

export interface WatchdogOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  /** The GitHub App; the Manager uses it only as `managerGitHub` allows. */
  readonly github: GitHubApp;
  /** Where work is queued again, or stopped. */
  readonly queue: Pick<WorkQueue, "enqueue" | "interrupt" | "wake">;
  /** The work queue's records, read. */
  readonly work: Pick<WorkQueueStore, "active" | "recent">;
  readonly reviews: ReviewLoopStore;
  readonly notices: Notices;
  readonly events: EventBus;
  readonly decisions: DecisionStore;
  /** The Agents paused at a Token Cap: never free to take work. */
  readonly pausedAgents?: () => readonly string[];
  readonly limits?: Partial<WatchdogLimits>;
  /** Removes credentials from what is written to the issue. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** How often to check, besides each call to `check`; a minute. */
  readonly intervalMs?: number;
  /** Told when a check, a comment or a Notice fails. */
  readonly onError?: (error: unknown) => void;
}

/** Marks the Manager's decision comments on an issue. */
export const decisionCommentMarker = "<!-- ai-office:manager -->";

/** How much of a Floor's latest work the watchdog reads. */
const historyLimit = 200;

/** Events that show work on an issue is moving. */
const progressEvents: EventType[] = [
  "sandbox.started",
  "sandbox.text",
  "sandbox.tool_call",
  "sandbox.diff",
  "model_call.completed",
  "review.posted",
  "branch.pushed",
  "handoff",
];

const issueKey = (floorId: string, issue: number): string =>
  `${floorId}#${String(issue)}`;

const title = (text: string): string =>
  text.length <= 200 ? text : `${text.slice(0, 199)}…`;

/**
 * The work Role that `item`'s work-Stage work stays in when the watchdog
 * reassigns it (FR-23): its Agent's, since dispatch gave it to an Agent in
 * the Role the Manager's triage chose. Work that names its Role (a
 * designer's review at QA) stays in that Role. None at other stages.
 */
const workRoleOf = (
  team: readonly AgentRecord[],
  item: Pick<WorkItem, "stage" | "agentId" | "role">,
): string | null =>
  roleOfWork(item) ??
  (sandboxStageAt(item.stage) === "work"
    ? (team.find(({ id }) => id === item.agentId)?.role ?? null)
    : null);

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

export function createWatchdog(options: WatchdogOptions): Watchdog {
  const { floors, agents, queue, work, reviews, notices, events } = options;
  const limits = { ...defaultWatchdogLimits, ...options.limits };
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const github = managerGitHub(options.github);
  const pipeline = createPipeline({ github, events });
  const paused = (): readonly string[] => options.pausedAgents?.() ?? [];
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  /** When each issue's work last showed progress, this process. */
  const progress = new Map<string, Date>();
  const unsubscribe = events.subscribe(
    ({ event }) => {
      const { floorId, issue } = event as {
        floorId?: string;
        issue?: number;
      };
      if (floorId !== undefined && issue !== undefined) {
        progress.set(issueKey(floorId, issue), now());
      }
    },
    { types: progressEvents },
  );

  const managerOf = (team: readonly AgentRecord[]): AgentRecord | undefined =>
    team.find(({ role }) => role === "manager");

  const nameOf = (team: readonly AgentRecord[], agentId: string | null) =>
    team.find(({ id }) => id === agentId)?.name ?? "an Agent";

  /** What the Manager did, as the comment on the issue says it. */
  const describe = (
    request: DecisionRequest & { readonly action: ManagerAction },
    team: readonly AgentRecord[],
  ): string => {
    const stage = `\`${request.stage}\``;
    const from = request.fromAgentId ?? null;
    switch (request.action) {
      case "retry":
        return `queued this issue's work at ${stage} again${
          from === null ? "" : `, for ${nameOf(team, from)}`
        }`;
      case "reassign":
        return `gave this issue's work at ${stage} to ${nameOf(team, request.toAgentId ?? null)}${
          from === null ? "" : `, from ${nameOf(team, from)}`
        }`;
      case "relabel":
        return `moved this issue from ${stage} to \`${request.to ?? ""}\``;
      case "pause":
        return `paused ${nameOf(team, from)}, who worked this issue at ${stage}. Resume ${nameOf(team, from)} in the Agent editor once the cause is fixed`;
      case "escalate":
        return request.to === undefined
          ? "asked the Owner to look at this issue"
          : `handed this issue to the Owner, labelled \`${request.to}\``;
    }
  };

  /** The comment that logs a decision on the issue (FR-23). */
  const commentFor = (
    manager: AgentRecord,
    request: DecisionRequest & { readonly action: ManagerAction },
    team: readonly AgentRecord[],
  ): string =>
    redactor.redactText(
      [
        decisionCommentMarker,
        `### Manager: ${managerActionLabels[request.action].toLowerCase()}`,
        "",
        `${manager.name} (the Manager) ${describe(request, team)}.`,
        "",
        `> ${request.reason.replaceAll(/\s+/g, " ")}`,
        "",
      ].join("\n"),
    );

  /** The Agent the work may be reassigned to, checked. */
  const assignee = (
    request: DecisionRequest,
    team: readonly AgentRecord[],
  ): string => {
    const agent = team.find(({ id }) => id === request.toAgentId);
    if (
      agent === undefined ||
      !agent.enabled ||
      (roleOfWork(request) === undefined
        ? agent.stage === null || agent.stage !== sandboxStageAt(request.stage)
        : agent.role !== roleOfWork(request))
    ) {
      throw new Error(
        `Work at ${request.stage} on #${String(request.issue)} cannot be given to that Agent.`,
      );
    }
    return agent.id;
  };

  /** Stops running work, if the request names some, as `how` says. */
  const stop = async (
    request: DecisionRequest,
    how: { readonly requeue?: boolean; readonly agentId?: string } = {},
  ): Promise<boolean> =>
    request.workId !== undefined &&
    (await queue.interrupt(request.workId, how));

  /** Does what the request asks, which the Manager may do. */
  const carryOut = async (
    floor: FloorRecord,
    manager: AgentRecord,
    request: DecisionRequest & { readonly action: ManagerAction },
    team: readonly AgentRecord[],
  ): Promise<void> => {
    const queued = {
      floorId: floor.id,
      issue: request.issue,
      stage: request.stage,
      ...(request.role === undefined ? {} : { role: request.role }),
    };
    switch (request.action) {
      case "retry": {
        // For the same Agent while it may work; by dispatch otherwise.
        const same = team.find(
          ({ id, enabled }) => id === request.fromAgentId && enabled,
        );
        if (!(await stop(request, { requeue: true }))) {
          await queue.enqueue({
            ...queued,
            ...(same === undefined ? {} : { agentId: same.id }),
          });
        }
        return;
      }
      case "reassign": {
        const agentId = assignee(request, team);
        if (!(await stop(request, { requeue: true, agentId }))) {
          await queue.enqueue({ ...queued, agentId });
        }
        return;
      }
      case "relabel":
      case "escalate": {
        if (request.to === undefined) {
          if (request.action === "relabel") {
            throw new Error("A relabel names the stage to move the issue to.");
          }
        } else {
          assertManagerMayMove(request.to);
          await stop(request);
          await pipeline.move(floor, request.issue, request.to, {
            agentId: manager.id,
          });
        }
        if (request.action === "escalate") {
          const issue = await github
            .repository(floor.repository)
            .getIssue(request.issue);
          await notices.raise({
            kind: "action",
            title: title(
              `${manager.name} escalated #${String(request.issue)}: ${request.reason}`,
            ),
            floorId: floor.id,
            agentId: request.fromAgentId ?? manager.id,
            issue: { number: issue.number, url: issue.htmlUrl },
          });
        }
        return;
      }
      case "pause": {
        const agent = team.find(({ id }) => id === request.fromAgentId);
        if (agent === undefined || agent.role === "manager") {
          throw new Error("A pause names an Agent on the Floor to pause.");
        }
        if (agent.enabled) {
          await agents.update({ ...agent, enabled: false });
          await events.publish({
            type: "config.changed",
            version: 1,
            scope: "agent",
            floorId: floor.id,
            agentId: agent.id,
            keys: ["enabled"],
          });
          queue.wake();
        }
        const issue = await github
          .repository(floor.repository)
          .getIssue(request.issue);
        await notices.raise({
          kind: "action",
          title: title(
            `${manager.name} paused ${agent.name}: ${request.reason}. Resume ${agent.name} in the Agent editor.`,
          ),
          floorId: floor.id,
          agentId: agent.id,
          issue: { number: issue.number, url: issue.htmlUrl },
        });
        return;
      }
    }
  };

  const act = async (
    request: DecisionRequest,
  ): Promise<DecisionRecord | undefined> => {
    const floor = await floors.get(request.floorId);
    if (floor?.archivedAt !== null) {
      throw new Error(`There is no Floor "${request.floorId}" in use.`);
    }
    const team = await agents.list(floor.id);
    const manager = managerOf(team);
    if (manager === undefined) {
      throw new Error(`The Floor "${floor.name}" has no Manager.`);
    }
    try {
      // The permission check: nothing beyond the Manager's authority runs.
      assertManagerMay(request.action);
      const allowed = { ...request, action: request.action };
      if (await options.decisions.decided(floor.id, request.key)) {
        return undefined;
      }
      await carryOut(floor, manager, allowed, team);
      const record: DecisionRecord = {
        floorId: floor.id,
        issue: request.issue,
        agentId: manager.id,
        action: allowed.action,
        trigger: request.trigger,
        stage: request.stage,
        fromAgentId: request.fromAgentId ?? null,
        toAgentId: request.toAgentId ?? null,
        toStage: request.to ?? null,
        key: request.key,
        reason: redactor.redactText(request.reason),
        createdAt: now(),
      };
      await options.decisions.record(record);
      // Every decision is a comment on the issue (FR-23); a comment GitHub
      // refuses never undoes it.
      await github
        .repository(floor.repository)
        .createComment(request.issue, commentFor(manager, allowed, team))
        .catch(report);
      await events.publish({
        type: "manager.decision",
        version: 1,
        floorId: floor.id,
        issue: request.issue,
        agentId: manager.id,
        action: record.action,
        trigger: record.trigger,
        stage: record.stage,
        ...(request.fromAgentId === undefined
          ? {}
          : { fromAgentId: request.fromAgentId }),
        ...(request.toAgentId === undefined
          ? {}
          : { toAgentId: request.toAgentId }),
        ...(request.to === undefined ? {} : { to: request.to }),
      });
      return record;
    } catch (error) {
      if (error instanceof ManagerAuthorityError) {
        await events.publish({
          type: "manager.action_refused",
          version: 1,
          floorId: floor.id,
          issue: request.issue,
          agentId: manager.id,
          action: error.action.slice(0, 100),
        });
      }
      throw error;
    }
  };

  // What the watchdog spots, Floor by Floor.

  /** Running work with no progress past the stall timeout. */
  const stalls = async (
    floor: FloorRecord,
    team: readonly AgentRecord[],
    active: readonly WorkItem[],
  ): Promise<DecisionRequest[]> => {
    const requests: DecisionRequest[] = [];
    /** Agents given work in this check: no longer free. */
    const chosen: string[] = [];
    const minutes = Math.round(limits.stallTimeoutMs / 60_000);
    for (const item of active) {
      // The Merge Policy's work waits on CI, not on an Agent, and bounds
      // its own wait.
      if (
        item.status !== "running" ||
        item.startedAt === null ||
        item.stage === "ready-to-merge"
      ) {
        continue;
      }
      const seen = progress.get(issueKey(floor.id, item.issue));
      const last = Math.max(item.startedAt.getTime(), seen?.getTime() ?? 0);
      if (now().getTime() - last < limits.stallTimeoutMs) {
        continue;
      }
      // Its stalls at this stage since it was last handed to the Owner.
      const before = (await options.decisions.list(floor.id, item.issue))
        .filter(
          ({ trigger, stage }) => trigger === "stalled" && stage === item.stage,
        )
        .map(({ action }) => action);
      const stalled = before.length - before.lastIndexOf("escalate") - 1;
      const whose =
        item.agentId === null
          ? "The review"
          : `${nameOf(team, item.agentId)}'s work`;
      const base = {
        floorId: floor.id,
        issue: item.issue,
        trigger: "stalled",
        stage: item.stage,
        ...(item.role === undefined ? {} : { role: item.role }),
        workId: item.id,
        ...(item.agentId === null ? {} : { fromAgentId: item.agentId }),
        key: `stalled:${String(item.id)}:${String(item.startedAt.getTime())}`,
      } as const;
      if (stalled >= limits.maxStallRestarts) {
        requests.push({
          ...base,
          action: "escalate",
          to: "needs-human",
          reason: `its work at ${item.stage} stalled ${plural(stalled + 1, "time")}, the last after ${plural(minutes, "minute")} with no progress`,
        });
        continue;
      }
      const reason = `${whose} on it at ${item.stage} showed no progress for ${plural(minutes, "minute")}`;
      const other = freeAgent(
        item.stage,
        team,
        active,
        [...paused(), ...chosen],
        item.agentId,
        workRoleOf(team, item),
      );
      if (other !== null) {
        chosen.push(other);
      }
      requests.push(
        item.agentId !== null && other !== null
          ? { ...base, action: "reassign", toAgentId: other, reason }
          : { ...base, action: "retry", reason },
      );
    }
    return requests;
  };

  /** Ended work, newest first, as each Agent's and each issue's run of it. */
  const ended = (recent: readonly WorkItem[]) =>
    recent.filter(({ status }) => status === "finished" || status === "failed");

  /** Agents whose last tasks all failed, on more than one issue. */
  const failingAgents = (
    floor: FloorRecord,
    team: readonly AgentRecord[],
    recent: readonly WorkItem[],
  ): DecisionRequest[] =>
    team.flatMap((agent) => {
      if (!agent.enabled || agent.role === "manager") {
        return [];
      }
      const last = ended(recent)
        .filter(({ agentId }) => agentId === agent.id)
        .slice(0, limits.agentFailures);
      const [latest] = last;
      if (
        latest === undefined ||
        last.length < limits.agentFailures ||
        last.some(({ status }) => status !== "failed") ||
        new Set(last.map(({ issue }) => issue)).size < 2
      ) {
        return [];
      }
      return [
        {
          floorId: floor.id,
          issue: latest.issue,
          action: "pause",
          trigger: "failing",
          stage: latest.stage,
          fromAgentId: agent.id,
          key: `agent_failing:${agent.id}:${String(latest.id)}`,
          reason: `${agent.name}'s last ${plural(last.length, "task")} failed, on ${plural(new Set(last.map(({ issue }) => issue)).size, "issue")}`,
        },
      ];
    });

  /** Issues whose work at a stage failed, with nothing queued again. */
  const failures = async (
    floor: FloorRecord,
    team: readonly AgentRecord[],
    active: readonly WorkItem[],
    recent: readonly WorkItem[],
  ): Promise<DecisionRequest[]> => {
    const runs = new Map<string, WorkItem[]>();
    for (const item of recent) {
      const key = `${String(item.issue)}|${item.stage}`;
      runs.set(key, [...(runs.get(key) ?? []), item]);
    }
    const requests: DecisionRequest[] = [];
    /** Agents given work in this check: no longer free. */
    const chosen: string[] = [];
    // The oldest failure first: it has waited longest.
    for (const run of [...runs.values()].reverse()) {
      const [latest] = run;
      if (latest?.status !== "failed") {
        continue;
      }
      const streak = run.findIndex(({ status }) => status !== "failed");
      const failed = streak === -1 ? run.length : streak;
      const key = `failing:${String(latest.id)}`;
      if (await options.decisions.decided(floor.id, key)) {
        continue;
      }
      // Still at that stage, open, and held by no one: it waits for work.
      const issue = await github
        .repository(floor.repository)
        .getIssue(latest.issue);
      const position = positionOf(issue.number, issue.labels);
      if (
        issue.state !== "open" ||
        position.stage !== latest.stage ||
        position.held
      ) {
        continue;
      }
      const base = {
        floorId: floor.id,
        issue: latest.issue,
        trigger: "failing",
        stage: latest.stage,
        ...(latest.role === undefined ? {} : { role: latest.role }),
        ...(latest.agentId === null ? {} : { fromAgentId: latest.agentId }),
        key,
      } as const;
      if (failed >= limits.maxFailures) {
        requests.push({
          ...base,
          action: "escalate",
          to: "needs-human",
          reason: `its work at ${latest.stage} failed ${plural(failed, "time")} in a row`,
        });
        continue;
      }
      const reason = `its work at ${latest.stage} failed${
        failed === 1 ? "" : ` ${plural(failed, "time")} in a row`
      }`;
      const other = freeAgent(
        latest.stage,
        team,
        active,
        [...paused(), ...chosen],
        latest.agentId,
        workRoleOf(team, latest),
      );
      if (other !== null) {
        chosen.push(other);
      }
      requests.push(
        latest.agentId !== null && other !== null
          ? { ...base, action: "reassign", toAgentId: other, reason }
          : { ...base, action: "retry", reason },
      );
    }
    return requests;
  };

  /** Review Loops sent back to the coder with one round left. */
  const nearCap = async (
    floor: FloorRecord,
    active: readonly WorkItem[],
  ): Promise<DecisionRequest[]> => {
    const requests: DecisionRequest[] = [];
    for (const item of active) {
      if (item.stage !== "needs-work") {
        continue;
      }
      const verdicts = await reviews.verdicts(floor.id, item.issue);
      const round = Math.max(0, ...verdicts.map((verdict) => verdict.round));
      const sentBack = verdicts.some(
        (verdict) =>
          verdict.round === round &&
          verdict.verdict.verdict === "changes_requested",
      );
      if (round === 0 || !sentBack || floor.roundCap - round !== 1) {
        continue;
      }
      requests.push({
        floorId: floor.id,
        issue: item.issue,
        action: "escalate",
        trigger: "near_cap",
        stage: "needs-review",
        key: `near_cap:${String(item.issue)}:${String(round)}`,
        reason: `round ${String(round)} of its Review Loop asked for changes, so one round is left before its Round Cap of ${String(floor.roundCap)}`,
      });
    }
    return requests;
  };

  /** Takes each request, reporting any that fails; returns those taken. */
  const takeAll = async (
    requests: readonly DecisionRequest[],
  ): Promise<DecisionRecord[]> => {
    const taken: DecisionRecord[] = [];
    for (const request of requests) {
      try {
        const record = await act(request);
        if (record !== undefined) {
          taken.push(record);
        }
      } catch (error) {
        report(error);
      }
    }
    return taken;
  };

  const check = async (): Promise<DecisionRecord[]> => {
    const taken: DecisionRecord[] = [];
    const allActive = await work.active();
    for (const floor of await floors.list()) {
      try {
        const team = await agents.list(floor.id);
        if (managerOf(team) === undefined) {
          continue;
        }
        const active = allActive.filter(({ floorId }) => floorId === floor.id);
        const recent = await work.recent(floor.id, historyLimit);
        taken.push(...(await takeAll(await stalls(floor, team, active))));
        // Agents that keep failing are paused before their work is retried.
        taken.push(...(await takeAll(failingAgents(floor, team, recent))));
        const rest = await agents.list(floor.id);
        const current = (await work.active()).filter(
          ({ floorId }) => floorId === floor.id,
        );
        taken.push(
          ...(await takeAll(await failures(floor, rest, current, recent))),
        );
        taken.push(...(await takeAll(await nearCap(floor, current))));
      } catch (error) {
        report(error);
      }
    }
    return taken;
  };

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<unknown> = Promise.resolve();

  const tick = (): void => {
    round = (async () => {
      await check().catch(report);
      if (running) {
        timer = setTimeout(tick, options.intervalMs ?? 60_000);
      }
    })();
  };

  return {
    check,
    act,
    start() {
      if (running) {
        return;
      }
      running = true;
      timer = setTimeout(tick, options.intervalMs ?? 60_000);
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      unsubscribe();
      await round;
    },
  };
}
