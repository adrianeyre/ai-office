import type { EventBus, EventType, OfficeEvent } from "@ai-office/events";
import {
  agentWithRole,
  type ManagerChatTask,
  type ManagerChatTaskState,
  type WrapUpOutcome,
} from "@ai-office/shared";

import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { BatchRecord, BatchStore } from "../batches/store.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { WorkItem, WorkQueueStore } from "../work/store.ts";
import type { ResearchRun } from "./requests.ts";

// The Manager chat's live task list (PRD FR-24, ADR 0004), as Claude
// Code's shows what its sub-agents are doing: each piece of work the
// Owner's chat requests spun off, with where it stands and the Agent
// working it, whose live view it opens. For each chat request's Batch,
// open or finished within the day, there is one task per issue of its
// Plan, one per Contractor added for it, and one per research run. Where
// each stands is plain code, from the issue's pipeline label (the latest
// `issue.label_changed`), its merge, the work queue and the Batch's
// Wrap-up; no model is asked. When any of it changes, the chat is told
// (`changed`), so the clients fetch the list again.

export interface ChatTasksOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly batches: Pick<BatchStore, "list" | "latestPlan">;
  readonly agents: Pick<AgentStore, "list">;
  readonly work: Pick<WorkQueueStore, "active">;
  readonly events: Pick<EventBus, "history" | "subscribe">;
  /** The chat's research runs, as the chat requests record them. */
  readonly research?: { researchRuns(floorId: string): ResearchRun[] };
  /** Told when a Floor's tasks may have changed: the chat tells its clients. */
  readonly changed?: (floorId: string) => void;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface ChatTasks {
  /** The Floor's chat tasks, newest request first. */
  list(floorId: string): Promise<ManagerChatTask[]>;
  /** Starts telling `changed` as the event log moves on; idempotent. */
  start(): void;
  stop(): void;
}

/** How long a finished request's tasks stay on the list: a day. */
export const finishedTaskMs = 24 * 60 * 60 * 1000;

/** How many of a Floor's latest Batches are looked through. */
const recentBatches = 50;

/** The events after which a Floor's tasks may stand differently. */
export const taskEventTypes: readonly EventType[] = [
  "issue.label_changed",
  "issue.assigned",
  "issue.picked_up",
  "agent.queue_changed",
  "agent.status_changed",
  "pull_request.opened",
  "pull_request.merged",
  "contractor.added",
  "contractor.kept",
  "contractor.left",
  "manager.issue_filed",
  "batch.planned",
  "batch.started",
  "batch.finished",
];

const reviewStages = new Set([
  "needs-review",
  "needs-qa",
  "needs-docs",
  "ready-to-merge",
]);

const wrapUpState: Record<WrapUpOutcome, ManagerChatTaskState> = {
  merged: "done",
  closed: "done",
  blocked: "blocked",
  // The Batch finished without it: it waits for the Owner.
  not_started: "blocked",
};

/**
 * Where an issue of an open Batch stands: merged is done; at `needs-human`
 * (or `blocked`) it is blocked; its work running at `needs-work` is
 * running; at review, QA, docs or the merge gate it is in review; else it
 * waits.
 */
export function issueState(input: {
  readonly merged: boolean;
  /** Its latest pipeline label; null when it has none. */
  readonly label: string | null;
  /** Its work queued or running. */
  readonly work: readonly Pick<WorkItem, "stage" | "status">[];
}): ManagerChatTaskState {
  if (input.merged) {
    return "done";
  }
  if (input.label === "needs-human" || input.label === "blocked") {
    return "blocked";
  }
  if (
    input.work.some(
      ({ stage, status }) => stage === "needs-work" && status === "running",
    )
  ) {
    return "running";
  }
  if (input.label !== null && reviewStages.has(input.label)) {
    return "in_review";
  }
  return "queued";
}

export function createChatTasks(options: ChatTasksOptions): ChatTasks {
  const { batches, agents, work, events } = options;
  const now = options.now ?? (() => new Date());
  let unsubscribe: (() => void) | undefined;

  const issueUrl = (floor: FloorRecord, issue: number): string =>
    `https://github.com/${floor.repository}/issues/${String(issue)}`;

  /** Where an issue stands, by the event log: its label and its merge. */
  const issueHistory = async (floorId: string, issue: number) => {
    const [latest] = await events.history({
      filter: {
        floorId,
        issue,
        types: ["issue.label_changed", "pull_request.merged"],
      },
      limit: 1,
    });
    const event: OfficeEvent | undefined = latest?.event;
    return {
      merged: event?.type === "pull_request.merged",
      label: event?.type === "issue.label_changed" ? event.to : null,
    };
  };

  const issueTasks = async (
    floor: FloorRecord,
    batch: BatchRecord,
    messageId: number,
    active: readonly WorkItem[],
    named: (
      agentId: string | null,
    ) => Pick<ManagerChatTask, "agentId" | "agentName">,
  ): Promise<ManagerChatTask[]> => {
    const plan = await batches.latestPlan(batch.id);
    if (plan === undefined) {
      return [];
    }
    return Promise.all(
      plan.items.map(async (item): Promise<ManagerChatTask> => {
        const working = active.filter(({ issue }) => issue === item.issue);
        const outcome = batch.wrapUp?.issues.find(
          ({ issue }) => issue === item.issue,
        )?.outcome;
        const state =
          outcome === undefined
            ? issueState({
                ...(await issueHistory(floor.id, item.issue)),
                work: working,
              })
            : wrapUpState[outcome];
        const running =
          working.find(({ status }) => status === "running") ?? working[0];
        return {
          id: `issue:${String(item.issue)}`,
          kind: "issue",
          title: `#${String(item.issue)} ${item.title}`.trim(),
          state,
          messageId,
          batchId: batch.id,
          issue: item.issue,
          url: issueUrl(floor, item.issue),
          ...named(
            state === "done"
              ? item.agentId
              : (running?.agentId ?? item.agentId),
          ),
        };
      }),
    );
  };

  return {
    async list(floorId) {
      const floor = await options.floors.get(floorId);
      if (floor === undefined) {
        return [];
      }
      const since = now().getTime() - finishedTaskMs;
      const chatBatches = (await batches.list(floorId, recentBatches)).filter(
        (batch) =>
          batch.chatMessageId !== null &&
          (batch.finishedAt === null || batch.finishedAt.getTime() >= since),
      );
      const runs = (options.research?.researchRuns(floorId) ?? []).filter(
        (run) => run.finishedAt === null || run.finishedAt.getTime() >= since,
      );
      if (chatBatches.length === 0 && runs.length === 0) {
        return [];
      }
      const team = await agents.list(floorId);
      const byId = new Map<string, AgentRecord>(
        team.map((agent) => [agent.id, agent]),
      );
      const named = (agentId: string | null) => {
        const agent = agentId === null ? undefined : byId.get(agentId);
        return {
          agentId: agent?.id ?? null,
          agentName: agent === undefined ? null : agentWithRole(agent),
        };
      };
      const active = (await work.active()).filter(
        (item) => item.floorId === floorId,
      );
      // Each Contractor of these Batches: staying (its Batch is on its
      // record once the Batch is made), or gone (`contractor.left` says
      // which Batch it was added for).
      const batchIds = new Set(chatBatches.map(({ id }) => id));
      const left =
        chatBatches.length === 0
          ? []
          : (
              await events.history({
                filter: { floorId, types: ["contractor.left"] },
                from: new Date(
                  Math.min(
                    ...chatBatches.map(({ createdAt }) => createdAt.getTime()),
                  ),
                ),
                limit: 500,
              })
            ).flatMap(({ event }) =>
              event.type === "contractor.left" &&
              event.batchId !== undefined &&
              batchIds.has(event.batchId) &&
              !byId.has(event.agentId)
                ? [event]
                : [],
            );

      const tasks: ManagerChatTask[] = [];
      for (const batch of chatBatches) {
        const messageId = batch.chatMessageId ?? 0;
        tasks.push(
          ...(await issueTasks(floor, batch, messageId, active, named)),
        );
        /** A Contractor's task; one gone has no live view to open. */
        const contractor = (
          id: string,
          name: string,
          state: ManagerChatTaskState,
        ): ManagerChatTask => ({
          id: `contractor:${id}`,
          kind: "contractor",
          title: name,
          state,
          messageId,
          batchId: batch.id,
          issue: null,
          url: null,
          agentId: state === "done" ? null : id,
          agentName: name,
        });
        // Those gone first, as they came first; the log is newest first.
        for (const gone of left
          .filter(({ batchId }) => batchId === batch.id)
          .reverse()) {
          tasks.push(contractor(gone.agentId, gone.name, "done"));
        }
        for (const agent of team) {
          if (agent.contractor?.batchId === batch.id) {
            tasks.push(
              contractor(
                agent.id,
                agent.name,
                agent.leavingAt === null ? "running" : "done",
              ),
            );
          }
        }
      }
      for (const run of runs) {
        const researcher = named(run.agentId);
        tasks.push({
          id: `research:${String(run.id)}`,
          kind: "research",
          title: run.title,
          state: run.finishedAt === null ? "running" : "done",
          messageId: run.messageId,
          batchId: null,
          issue: null,
          url: null,
          agentId: researcher.agentId,
          agentName: researcher.agentName ?? run.agentName,
        });
      }
      // Newest request first; each request's tasks in their order.
      return tasks
        .map((task, index) => ({ task, index }))
        .sort(
          (a, b) => b.task.messageId - a.task.messageId || a.index - b.index,
        )
        .map(({ task }) => task);
    },

    start() {
      if (unsubscribe !== undefined || options.changed === undefined) {
        return;
      }
      const changed = options.changed;
      unsubscribe = events.subscribe(
        ({ event }) => {
          if ("floorId" in event && typeof event.floorId === "string") {
            try {
              changed(event.floorId);
            } catch (error) {
              options.onError?.(error);
            }
          }
        },
        { types: taskEventTypes },
      );
    },

    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
