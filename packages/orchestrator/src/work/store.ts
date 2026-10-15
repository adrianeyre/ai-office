import { floors, workQueue, type Database } from "@ai-office/db";
import {
  issuePriorities,
  type IssuePriority,
  type PipelineStage,
  type Role,
} from "@ai-office/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { FloorStore } from "../floors/store.ts";

// Where the work queue lives (PRD FR-22): in the `work_queue` table, so
// queued work survives a restart, or in memory for tests.

/** The stages whose work runs in a sandbox (FR-19), within the limit. */
export const sandboxStages: readonly PipelineStage[] = [
  "needs-work",
  "needs-qa",
  "needs-docs",
];

/**
 * The stages with work to queue: the sandbox stages, review rounds, which
 * make model calls without a sandbox (FR-20), and the Merge Policy's gate
 * at `ready-to-merge` (FR-29), which only asks GitHub. Those two start
 * whatever the limit.
 */
export const queuedStages: readonly PipelineStage[] = [
  ...sandboxStages,
  "needs-review",
  "ready-to-merge",
];

const runsInSandbox = (stage: PipelineStage): boolean =>
  sandboxStages.includes(stage);

export type WorkStatus =
  "queued" | "running" | "finished" | "failed" | "cancelled";

/** How a piece of work ended. */
export type WorkOutcome = Extract<
  WorkStatus,
  "finished" | "failed" | "cancelled"
>;

/** One piece of work for an Agent: an issue at a stage. */
export interface WorkItem {
  readonly id: number;
  readonly floorId: string;
  readonly issue: number;
  readonly stage: PipelineStage;
  /** The Agent it waits for; null when no Agent fits. */
  readonly agentId: string | null;
  /**
   * The Role whose Agent does it, when it is not its stage's first: a
   * designer's review at `needs-qa`. Absent for the stage's own Role.
   */
  readonly role?: Role;
  readonly status: WorkStatus;
  /** Its issue's priority, from the Manager's triage (FR-23). */
  readonly priority: IssuePriority;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface NewWork {
  readonly floorId: string;
  readonly issue: number;
  readonly stage: PipelineStage;
  readonly agentId: string | null;
  /** The Role whose Agent does it, when it is not its stage's first. */
  readonly role?: Role;
  readonly priority: IssuePriority;
}

export interface WorkQueueStore {
  /**
   * Queues work, unless the issue is already queued or running at that
   * stage: then nothing is added and undefined is returned.
   */
  add(work: NewWork, at: Date): Promise<WorkItem | undefined>;
  /**
   * Gives queued work to another Agent (the Manager's dispatch, FR-23),
   * unless it has started or been given to someone else meanwhile: false
   * then.
   */
  reassign(id: number, from: string | null, to: string): Promise<boolean>;
  /**
   * Marks the next work to start as running and returns it. Sandbox work
   * starts only while fewer than `limit` pieces of it are running, and
   * fewer than its Floor's own concurrency limit, when it has one, on its
   * Floor (FR-22); review work starts whatever the limits. The next is the queued work on the
   * highest-priority Floor in use, of its highest-priority issue, oldest
   * first, whose Agent is not already running something: an Agent works
   * one task at a time. Work for the Agents in
   * `paused` waits, and so does a review round while any of its Floor's
   * required reviewers is in `paused`. Every piece of work on a Floor in
   * `stopped` waits: the Owner stopped everything there.
   */
  claimNext(
    limit: number,
    at: Date,
    paused?: readonly string[],
    stopped?: readonly string[],
  ): Promise<WorkItem | undefined>;
  /** Records how running work ended. */
  end(id: number, outcome: WorkOutcome, at: Date): Promise<void>;
  /** Puts running work back in the queue, to start again later. */
  requeue(id: number): Promise<void>;
  /** The work queued or running, oldest first. */
  active(): Promise<WorkItem[]>;
  /**
   * A Floor's latest `limit` pieces of work, whatever their status, newest
   * first: what the Manager's watchdog reads (FR-23).
   */
  recent(floorId: string, limit: number): Promise<WorkItem[]>;
  /** Puts work left running (by a server that stopped) back in the queue. */
  requeueRunning(): Promise<number>;
}

const byAge = (a: WorkItem, b: WorkItem): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;

/** Higher for an issue that should start sooner. */
const rankOf = (priority: IssuePriority): number =>
  issuePriorities.indexOf(priority);

/** Keeps the queue in memory, with Floors' priorities from `floors`. */
export function memoryWorkQueueStore(
  floorStore: FloorStore,
): WorkQueueStore & { readonly items: Map<number, WorkItem> } {
  const items = new Map<number, WorkItem>();
  let nextId = 1;
  const isActive = (item: WorkItem) =>
    item.status === "queued" || item.status === "running";

  return {
    items,
    add(work, at) {
      if (
        [...items.values()].some(
          (item) =>
            isActive(item) &&
            item.floorId === work.floorId &&
            item.issue === work.issue &&
            item.stage === work.stage,
        )
      ) {
        return Promise.resolve(undefined);
      }
      const item: WorkItem = {
        id: nextId++,
        ...work,
        status: "queued",
        createdAt: at,
        startedAt: null,
        finishedAt: null,
      };
      items.set(item.id, item);
      return Promise.resolve({ ...item });
    },
    reassign(id, from, to) {
      const item = items.get(id);
      if (item?.status !== "queued" || item.agentId !== from) {
        return Promise.resolve(false);
      }
      items.set(id, { ...item, agentId: to });
      return Promise.resolve(true);
    },
    async claimNext(limit, at, paused = [], stopped = []) {
      const all = [...items.values()];
      const running = all.filter(({ status }) => status === "running");
      const inSandboxes = running.filter(({ stage }) => runsInSandbox(stage));
      const full = inSandboxes.length >= limit;
      const floorsInUse = await floorStore.list();
      const priorities = new Map(
        floorsInUse.map(({ id, priority }) => [id, priority]),
      );
      const floorsFull = new Set(
        floorsInUse
          .filter(
            ({ id, concurrencyLimit }) =>
              concurrencyLimit !== null &&
              inSandboxes.filter(({ floorId }) => floorId === id).length >=
                concurrencyLimit,
          )
          .map(({ id }) => id),
      );
      const reviewersPaused = new Set(
        floorsInUse
          .filter(({ requiredReviewerAgentIds }) =>
            requiredReviewerAgentIds.some((id) => paused.includes(id)),
          )
          .map(({ id }) => id),
      );
      const busy = new Set(running.map(({ agentId }) => agentId));
      const [next] = all
        .filter(
          (item) =>
            item.status === "queued" &&
            priorities.has(item.floorId) &&
            !stopped.includes(item.floorId) &&
            !(
              (full || floorsFull.has(item.floorId)) &&
              runsInSandbox(item.stage)
            ) &&
            !(
              item.stage === "needs-review" && reviewersPaused.has(item.floorId)
            ) &&
            (item.agentId === null ||
              (!busy.has(item.agentId) && !paused.includes(item.agentId))),
        )
        .sort(
          (a, b) =>
            (priorities.get(b.floorId) ?? 0) -
              (priorities.get(a.floorId) ?? 0) ||
            rankOf(b.priority) - rankOf(a.priority) ||
            byAge(a, b),
        );
      if (next === undefined) {
        return undefined;
      }
      const claimed: WorkItem = { ...next, status: "running", startedAt: at };
      items.set(claimed.id, claimed);
      return { ...claimed };
    },
    end(id, outcome, at) {
      const item = items.get(id);
      if (item !== undefined) {
        items.set(id, { ...item, status: outcome, finishedAt: at });
      }
      return Promise.resolve();
    },
    requeue(id) {
      const item = items.get(id);
      if (item?.status === "running") {
        items.set(id, { ...item, status: "queued", startedAt: null });
      }
      return Promise.resolve();
    },
    active: () =>
      Promise.resolve(
        [...items.values()]
          .filter(isActive)
          .sort(byAge)
          .map((item) => ({ ...item })),
      ),
    recent: (floorId, limit) =>
      Promise.resolve(
        [...items.values()]
          .filter((item) => item.floorId === floorId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map((item) => ({ ...item })),
      ),
    requeueRunning() {
      let count = 0;
      for (const item of items.values()) {
        if (item.status === "running") {
          items.set(item.id, { ...item, status: "queued", startedAt: null });
          count++;
        }
      }
      return Promise.resolve(count);
    },
  };
}

type WorkRow = typeof workQueue.$inferSelect;

const toItem = (row: WorkRow): WorkItem => ({
  id: row.id,
  floorId: row.floorId,
  issue: row.issue,
  stage: row.stage as PipelineStage,
  agentId: row.agentId,
  ...(row.role === null ? {} : { role: row.role }),
  status: row.status as WorkStatus,
  priority: row.priority as IssuePriority,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

/** Serialises claims across connections (and servers on one database). */
const claimLock = 0x5a4e_4251;

/** Keeps the queue in the `work_queue` table. */
export function databaseWorkQueueStore(db: Database): WorkQueueStore {
  return {
    async add(work, at) {
      // The partial unique index refuses a second active row for a stage.
      const [row] = await db
        .insert(workQueue)
        .values({ ...work, status: "queued", createdAt: at })
        .onConflictDoNothing()
        .returning();
      return row === undefined ? undefined : toItem(row);
    },

    async reassign(id, from, to) {
      const rows = await db
        .update(workQueue)
        .set({ agentId: to })
        .where(
          and(
            eq(workQueue.id, id),
            eq(workQueue.status, "queued"),
            from === null
              ? isNull(workQueue.agentId)
              : eq(workQueue.agentId, from),
          ),
        )
        .returning({ id: workQueue.id });
      return rows.length > 0;
    },

    claimNext: (limit, at, paused = [], stopped = []) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${claimLock})`);
        const [counted] = await tx
          .select({ running: sql<number>`count(*)::int` })
          .from(workQueue)
          .where(
            and(
              eq(workQueue.status, "running"),
              inArray(workQueue.stage, [...sandboxStages]),
            ),
          );
        const full = (counted?.running ?? 0) >= limit;
        const pausedIds = sql`ARRAY[${sql.join(
          paused.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`;
        const [next] = await tx
          .select({ id: workQueue.id })
          .from(workQueue)
          .innerJoin(floors, eq(floors.id, workQueue.floorId))
          .where(
            and(
              eq(workQueue.status, "queued"),
              isNull(floors.archivedAt),
              stopped.length === 0
                ? undefined
                : notInArray(workQueue.floorId, [...stopped]),
              full
                ? notInArray(workQueue.stage, [...sandboxStages])
                : undefined,
              // Within its Floor's own limit, when it has one.
              or(
                notInArray(workQueue.stage, [...sandboxStages]),
                isNull(floors.concurrencyLimit),
                sql`(SELECT count(*) FROM work_queue AS floor_running WHERE floor_running.status = 'running' AND floor_running.floor_id = ${workQueue.floorId} AND floor_running.stage IN (${sql.join(
                  sandboxStages.map((stage) => sql`${stage}`),
                  sql`, `,
                )})) < ${floors.concurrencyLimit}`,
              ),
              paused.length === 0
                ? undefined
                : or(
                    ne(workQueue.stage, "needs-review"),
                    sql`NOT (${floors.requiredReviewerAgentIds} && ${pausedIds})`,
                  ),
              or(
                isNull(workQueue.agentId),
                and(
                  sql`NOT EXISTS (SELECT 1 FROM work_queue AS busy WHERE busy.status = 'running' AND busy.agent_id = ${workQueue.agentId})`,
                  paused.length === 0
                    ? undefined
                    : notInArray(workQueue.agentId, [...paused]),
                ),
              ),
            ),
          )
          .orderBy(
            desc(floors.priority),
            desc(
              sql`CASE ${workQueue.priority} WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END`,
            ),
            asc(workQueue.createdAt),
            asc(workQueue.id),
          )
          .limit(1);
        if (next === undefined) {
          return undefined;
        }
        const [row] = await tx
          .update(workQueue)
          .set({ status: "running", startedAt: at })
          .where(eq(workQueue.id, next.id))
          .returning();
        return row === undefined ? undefined : toItem(row);
      }),

    async end(id, outcome, at) {
      await db
        .update(workQueue)
        .set({ status: outcome, finishedAt: at })
        .where(eq(workQueue.id, id));
    },

    async requeue(id) {
      await db
        .update(workQueue)
        .set({ status: "queued", startedAt: null })
        .where(and(eq(workQueue.id, id), eq(workQueue.status, "running")));
    },

    async active() {
      const rows = await db
        .select()
        .from(workQueue)
        .where(inArray(workQueue.status, ["queued", "running"]))
        .orderBy(asc(workQueue.createdAt), asc(workQueue.id));
      return rows.map(toItem);
    },

    async recent(floorId, limit) {
      const rows = await db
        .select()
        .from(workQueue)
        .where(eq(workQueue.floorId, floorId))
        .orderBy(desc(workQueue.id))
        .limit(limit);
      return rows.map(toItem);
    },

    async requeueRunning() {
      const rows = await db
        .update(workQueue)
        .set({ status: "queued", startedAt: null })
        .where(eq(workQueue.status, "running"))
        .returning({ id: workQueue.id });
      return rows.length;
    },
  };
}
