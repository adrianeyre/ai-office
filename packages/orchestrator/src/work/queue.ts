import type { EventBus } from "@ai-office/events";
import {
  defaultIssuePriority,
  sandboxStages,
  type IssuePriority,
  type PipelineStage,
  type Role,
} from "@ai-office/shared";

import type { AgentStore } from "../agents/store.ts";
import type { IntakeQueue, QueuedWork } from "../intake/intake.ts";
import {
  chooseAgent,
  rebalance,
  roleOfWork,
  sandboxStageAt,
  takesWork,
} from "../manager/dispatch.ts";
import {
  queuedStages,
  type WorkItem,
  type WorkOutcome,
  type WorkQueueStore,
} from "./store.ts";

// The work queue (PRD FR-22): work at a sandbox stage runs in a sandbox,
// and no more sandboxes run at once than the office-wide limit (3 by
// default, read afresh each time), nor on one Floor than its own lower
// limit, when it has one (read afresh too). Work beyond them waits, and
// starts by its Floor's priority, then its issue's (from the Manager's
// triage, FR-23), then oldest first, as sandboxes free up. Each piece of it
// is queued for an Agent by the Manager's dispatch (FR-23,
// `manager/dispatch.ts`), which balances work across the Agents of a Role
// and moves waiting work to an Agent that is free, keeping an issue's work
// in the work Role its triage chose; each assignment is an
// `issue.assigned` event. An Agent works one at a time; how many wait for
// each Agent is emitted for the Office (its desk's pile of tickets, FR-62).
// A review round (FR-20, FR-27) is queued too, so it survives a restart,
// but uses no sandbox: it is the Floor's required reviewers' work, for no
// one Agent, and starts whatever the limits. The Manager's watchdog may
// queue work for an Agent it names, and stop running work that has
// stalled, to queue it again (for another Agent) or end it.
//
// Each flow queues the next stage's work as it moves an issue on, which may
// be the stage of work still running: a review round can send an issue back
// to its coder before the coder's own work has ended. That work is queued
// once the running work ends. (After a restart there is nothing to add:
// the running work is queued again, and finds the issue at its stage.)

export interface WorkQueue extends IntakeQueue {
  /**
   * Queues work for an Agent, unless the issue is already queued at that
   * stage; resolves once the search for work to start that it set off is
   * done.
   */
  enqueue(work: QueuedWork): Promise<void>;
  /** Puts work interrupted by a restart back in the queue, then starts work. */
  start(): Promise<void>;
  /** Stops starting work and cancels what is running, waiting for it to end. */
  stop(): Promise<void>;
  /**
   * Looks for work to start now: a limit, an Agent or a Floor's priority
   * may have changed.
   */
  wake(): void;
  /** Resolves when no work is starting or running. */
  idle(): Promise<void>;
  /**
   * Stops running work, as the Manager's watchdog does (FR-23), and
   * resolves once it has ended. With `requeue` the work goes back in the
   * queue, for `agentId` when given (another Agent of its Role); without,
   * it ends as cancelled. False when the work is not running here.
   */
  interrupt(
    id: number,
    options?: { readonly requeue?: boolean; readonly agentId?: string },
  ): Promise<boolean>;
}

/**
 * Does a piece of work: runs its sandbox until it ends or `signal` aborts.
 * `requeued` puts it back in the queue, such as when its Agent was paused
 * at a Token Cap: it starts again once the Agent resumes.
 */
export type ExecuteWork = (
  work: WorkItem,
  signal: AbortSignal,
) => Promise<Exclude<WorkOutcome, "cancelled"> | "requeued">;

/**
 * Does each piece of work by its stage's flow, or by its Role's when it
 * names one (a designer's at `needs-qa`); fails work without one.
 */
export const executeByStage =
  (
    flows: Partial<Record<PipelineStage, ExecuteWork>>,
    roleFlows: Partial<Record<Role, ExecuteWork>> = {},
  ): ExecuteWork =>
  (work, signal) =>
    (work.role === undefined ? flows[work.stage] : roleFlows[work.role])?.(
      work,
      signal,
    ) ?? Promise.resolve("failed");

export interface WorkQueueOptions {
  readonly store: WorkQueueStore;
  readonly agents: AgentStore;
  readonly events: EventBus;
  /** The office-wide limit on running sandboxes, read before each start. */
  readonly limit: () => Promise<number>;
  /** Does the work. Without it, work is queued but nothing starts. */
  readonly execute?: ExecuteWork;
  /**
   * The Agents paused at a Token Cap (FR-33): no work starts for them, and
   * new work goes to another Agent in the Role if there is one.
   */
  readonly pausedAgents?: () => readonly string[];
  /**
   * The Floors where the Owner stopped everything: no work starts there
   * until they continue.
   */
  readonly stoppedFloors?: () => readonly string[];
  /**
   * An issue's priority, from the Manager's triage (FR-23), read as its
   * work is queued; normal without it.
   */
  readonly issuePriority?: (
    floorId: string,
    issue: number,
  ) => Promise<IssuePriority>;
  /**
   * The work Role chosen for an issue by the Manager's triage (FR-23), if
   * any: its work-Stage work goes only to Agents in that Role.
   */
  readonly issueRole?: (
    floorId: string,
    issue: number,
  ) => Promise<string | null>;
  /** How often to look for work that can start, besides each change. */
  readonly pollMs?: number;
  readonly now?: () => Date;
  /** Told when looking for work, or recording its end, fails. */
  readonly onError?: (error: unknown) => void;
  /**
   * Told when a piece of work has ended here (finished, failed, cancelled
   * or back in the queue), once that is recorded: an Agent leaving its
   * Floor (FR-10) may go then.
   */
  readonly onEnded?: (work: WorkItem) => void;
}

export function createWorkQueue(options: WorkQueueOptions): WorkQueue {
  const { store, events, execute } = options;
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  /** The last queue length emitted for each Agent. */
  const emitted = new Map<string, number>();
  const emitQueueLength = async (
    floorId: string,
    agentId: string | null,
  ): Promise<void> => {
    if (agentId === null) {
      return;
    }
    const queued = (await store.active()).filter(
      (item) => item.agentId === agentId && item.status === "queued",
    ).length;
    if (emitted.get(agentId) === queued) {
      return;
    }
    emitted.set(agentId, queued);
    await events.publish({
      type: "agent.queue_changed",
      version: 1,
      floorId,
      agentId,
      queued,
    });
  };

  const paused = (): readonly string[] => options.pausedAgents?.() ?? [];

  /** Records the Manager's dispatch of an issue's work to an Agent. */
  const assigned = (
    floorId: string,
    issue: number,
    agentId: string,
  ): Promise<unknown> =>
    events.publish({
      type: "issue.assigned",
      version: 1,
      floorId,
      issue,
      agentId,
    });

  /** The work Role chosen for an issue, for its work at `stage`. */
  const roleFor = async (
    floorId: string,
    issue: number,
    stage: PipelineStage,
  ): Promise<string | null> =>
    sandboxStageAt(stage) === "work"
      ? ((await options.issueRole?.(floorId, issue)) ?? null)
      : null;

  /** The Agent the Manager dispatches new work to. */
  const assign = async (work: QueuedWork): Promise<string | null> =>
    chooseAgent(
      work.stage,
      await options.agents.list(work.floorId),
      await store.active(),
      paused(),
      roleOfWork(work) ?? (await roleFor(work.floorId, work.issue, work.stage)),
    );

  /**
   * Moves waiting work to the Agents that are free (the Manager's
   * dispatch), and gives the sandbox Agents paused in the Agent editor,
   * leaving their Floor or removed from it that have work waiting: no work
   * starts for them.
   */
  const balance = async (): Promise<string[]> => {
    const active = await store.active();
    const floorIds = new Set(
      active
        .filter(
          (item) =>
            item.status === "queued" &&
            sandboxStageAt(item.stage) !== undefined,
        )
        .map(({ floorId }) => floorId),
    );
    const disabled: string[] = [];
    for (const floorId of floorIds) {
      const agents = await options.agents.list(floorId);
      disabled.push(
        ...agents
          .filter(
            (agent) =>
              !takesWork(agent) &&
              agent.stage !== null &&
              sandboxStages.includes(agent.stage),
          )
          .map(({ id }) => id),
      );
      const onFloor = active.filter((item) => item.floorId === floorId);
      // An Agent removed from its Floor starts nothing more: its waiting
      // work moves to another once one is free.
      disabled.push(
        ...onFloor
          .filter(
            ({ status, agentId }) =>
              status === "queued" &&
              agentId !== null &&
              !agents.some(({ id }) => id === agentId),
          )
          .flatMap(({ agentId }) => (agentId === null ? [] : [agentId])),
      );
      const roles = new Map<number, string | null>();
      for (const item of onFloor) {
        if (item.status === "queued" && !roles.has(item.issue)) {
          roles.set(
            item.issue,
            await roleFor(floorId, item.issue, "needs-work"),
          );
        }
      }
      const moves = rebalance(agents, onFloor, paused(), (issue) =>
        roles.get(issue),
      );
      for (const move of moves) {
        if (!(await store.reassign(move.id, move.from, move.to))) {
          continue;
        }
        await assigned(move.floorId, move.issue, move.to);
        await emitQueueLength(move.floorId, move.from);
        await emitQueueLength(move.floorId, move.to);
      }
    }
    return disabled;
  };

  let started = false;
  let timer: NodeJS.Timeout | undefined;
  const running = new Map<number, AbortController>();
  const executions = new Set<Promise<void>>();
  /** Each running piece of work's execution, by id. */
  const ending = new Map<number, Promise<void>>();
  /** How work the Manager's watchdog stopped goes on, by id. */
  const interruptions = new Map<
    number,
    { readonly requeue?: boolean; readonly agentId?: string }
  >();
  let pumping: Promise<void> | undefined;
  /** Whether something changed during a search, so it must search again. */
  let again = false;
  const searchAgain = (): boolean => again && started;

  /** Resolves once no search for work to start is running. */
  const searched = async (): Promise<void> => {
    while (pumping !== undefined) {
      await pumping;
    }
  };

  /** Work to queue once the running work (by id) for its stage ends. */
  const followUps = new Map<number, QueuedWork[]>();

  const enqueue = async (work: QueuedWork): Promise<void> => {
    if (!queuedStages.includes(work.stage)) {
      throw new Error(
        `Work at ${work.stage} is no Agent's to do, so it is not queued.`,
      );
    }
    const agentId =
      sandboxStageAt(work.stage) === undefined
        ? null
        : (work.agentId ?? (await assign(work)));
    const priority =
      (await options.issuePriority?.(work.floorId, work.issue)) ??
      defaultIssuePriority;
    const added = await store.add(
      {
        floorId: work.floorId,
        issue: work.issue,
        stage: work.stage,
        agentId,
        // The stage's own Agents are assumed, so only a Role that works
        // its label after them (a designer's review at QA) is named.
        ...(roleOfWork(work) === undefined ? {} : { role: work.role }),
        priority,
      },
      now(),
    );
    if (added !== undefined) {
      if (added.agentId !== null) {
        await assigned(added.floorId, added.issue, added.agentId);
      }
      await emitQueueLength(added.floorId, added.agentId);
      pump();
      // Resolved once the search it started has dispatched it, so each
      // Agent's queue length is told in the order its work changed.
      await searched();
      return;
    }
    const busy = (await store.active()).find(
      (item) =>
        item.status === "running" &&
        item.floorId === work.floorId &&
        item.issue === work.issue &&
        item.stage === work.stage,
    );
    if (busy !== undefined) {
      followUps.set(busy.id, [...(followUps.get(busy.id) ?? []), work]);
    }
  };

  const launch = (item: WorkItem, work: ExecuteWork): void => {
    const controller = new AbortController();
    running.set(item.id, controller);
    const execution = (async () => {
      let outcome: WorkOutcome | "requeued";
      try {
        outcome = await work(item, controller.signal);
      } catch {
        outcome = "failed";
      }
      const interruption = interruptions.get(item.id);
      interruptions.delete(item.id);
      if (controller.signal.aborted) {
        outcome = interruption?.requeue === true ? "requeued" : "cancelled";
      }
      try {
        if (outcome === "requeued") {
          await store.requeue(item.id);
          const to = interruption?.agentId;
          if (
            to !== undefined &&
            to !== item.agentId &&
            (await store.reassign(item.id, item.agentId, to))
          ) {
            await assigned(item.floorId, item.issue, to);
            await emitQueueLength(item.floorId, to);
          }
          await emitQueueLength(item.floorId, item.agentId);
        } else {
          await store.end(item.id, outcome, now());
        }
      } catch (error) {
        report(error);
      }
      running.delete(item.id);
      try {
        options.onEnded?.(item);
      } catch (error) {
        report(error);
      }
      const follow = followUps.get(item.id) ?? [];
      followUps.delete(item.id);
      // Requeued or cancelled work runs again itself.
      if (outcome === "finished" || outcome === "failed") {
        for (const next of follow) {
          await enqueue(next).catch(report);
        }
      }
    })();
    executions.add(execution);
    ending.set(item.id, execution);
    void execution.finally(() => {
      executions.delete(execution);
      ending.delete(item.id);
      pump();
    });
  };

  /** Starts work while sandboxes are free; one search at a time. */
  const pump = (): void => {
    if (!started || execute === undefined) {
      return;
    }
    if (pumping !== undefined) {
      again = true;
      return;
    }
    pumping = (async () => {
      do {
        again = false;
        const disabled = await balance();
        for (;;) {
          const limit = await options.limit();
          const held = [...paused(), ...disabled];
          const item = await store.claimNext(
            limit,
            now(),
            held,
            options.stoppedFloors?.() ?? [],
          );
          if (item === undefined) {
            break;
          }
          // An Agent paused while the claim looked may hold what it found,
          // work queued since among it: a review round its Floor's newly
          // paused reviewer must do. Put it back, and look again.
          if (paused().some((id) => !held.includes(id))) {
            await store.requeue(item.id);
            continue;
          }
          launch(item, execute);
          await emitQueueLength(item.floorId, item.agentId);
        }
      } while (searchAgain());
    })()
      .catch(report)
      .finally(() => {
        pumping = undefined;
        // Asked to look again after the search's last check: look now.
        if (searchAgain()) {
          pump();
        }
      });
  };

  const schedule = (): void => {
    clearTimeout(timer);
    if (started) {
      timer = setTimeout(() => {
        pump();
        schedule();
      }, options.pollMs ?? 30_000);
    }
  };

  return {
    enqueue,

    async start() {
      if (started) {
        return;
      }
      await store.requeueRunning();
      started = true;
      schedule();
      pump();
    },

    async stop() {
      started = false;
      clearTimeout(timer);
      await pumping;
      for (const controller of running.values()) {
        controller.abort(new Error("AI Office is stopping."));
      }
      await Promise.all(executions);
    },

    wake: pump,

    async idle() {
      while (pumping !== undefined || executions.size > 0) {
        await Promise.all([pumping, ...executions]);
      }
    },

    async interrupt(id, how = {}) {
      const controller = running.get(id);
      const execution = ending.get(id);
      if (controller === undefined || execution === undefined) {
        return false;
      }
      interruptions.set(id, how);
      controller.abort(new Error("The Manager interrupted this work."));
      await execution;
      return true;
    },
  };
}
