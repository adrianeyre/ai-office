import { hookPushHeads, hookRuns, hooks, type Database } from "@ai-office/db";
import {
  hookRunStatuses,
  hookStages,
  hookTriggers,
  type HookRunStatus,
  type HookStage,
  type HookTrigger,
} from "@ai-office/shared";
import { and, asc, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";

// Where each Floor's Hooks live (Guidelines, Specs and Hooks PRD, FR-118 to
// FR-121; ADR 0016): the `hooks`, `hook_runs` and `hook_push_heads` tables,
// or memory for tests. A Hook is made and changed only by the Owner; its
// runs are kept with it, the newest `keptHookRuns` of them, and go with it.

/** A Hook as the orchestrator holds it. */
export interface HookRecord {
  readonly id: number;
  readonly floorId: string;
  readonly name: string;
  readonly trigger: HookTrigger;
  /** The Stage label watched, for a `stage` Hook; null otherwise. */
  readonly stage: HookStage | null;
  readonly labels: readonly string[];
  readonly filePatterns: readonly string[];
  /** The Agent that runs it; null when any Agent in `role` does. */
  readonly agentId: string | null;
  readonly role: string | null;
  readonly skillName: string;
  readonly runsPerHour: number;
  readonly enabled: boolean;
  /** Its failed runs in a row since its last success, or since it changed. */
  readonly failures: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What the Owner sets of a Hook: everything but its id, failures and times. */
export type HookFields = Omit<
  HookRecord,
  "id" | "floorId" | "failures" | "createdAt" | "updatedAt"
>;

/** One run of a Hook. */
export interface HookRunRecord {
  readonly id: number;
  readonly hookId: number;
  readonly floorId: string;
  /** The Agent that ran it; null when none could be found to. */
  readonly agentId: string | null;
  readonly trigger: HookTrigger;
  readonly issue: number | null;
  readonly pullRequest: number | null;
  readonly status: HookRunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly error: string | null;
  readonly result: string | null;
  readonly commentUrl: string | null;
}

export type NewHookRun = Pick<
  HookRunRecord,
  | "hookId"
  | "floorId"
  | "agentId"
  | "trigger"
  | "issue"
  | "pullRequest"
  | "startedAt"
>;

export type HookRunEnd = Pick<
  HookRunRecord,
  "error" | "result" | "commentUrl"
> & {
  readonly status: Exclude<HookRunStatus, "running">;
  readonly finishedAt: Date;
};

/** How many of a Hook's latest runs are kept. */
export const keptHookRuns = 100;

export interface HookStore {
  /** The Floor's Hooks, oldest first. */
  list(floorId: string): Promise<HookRecord[]>;
  get(floorId: string, id: number): Promise<HookRecord | undefined>;
  /** Adds a Hook, on; `name_taken` when another on its Floor has its name. */
  create(
    floorId: string,
    fields: HookFields,
    at: Date,
  ): Promise<HookRecord | "name_taken">;
  /**
   * Changes a Hook to `fields`, its failures in a row starting again from
   * none; `name_taken` as for `create`, undefined when there is no such Hook.
   */
  update(
    floorId: string,
    id: number,
    fields: HookFields,
    at: Date,
  ): Promise<HookRecord | "name_taken" | undefined>;
  /** Deletes a Hook and its runs; undefined when there was none. */
  remove(floorId: string, id: number): Promise<HookRecord | undefined>;
  /**
   * Counts one more failed run in a row, and turns the Hook off once there
   * are `turnOffAt`: what it is now, undefined when there is no such Hook.
   */
  recordFailure(
    floorId: string,
    id: number,
    turnOffAt: number,
    at: Date,
  ): Promise<HookRecord | undefined>;
  /** A run succeeded: its failures in a row start again from none. */
  recordSuccess(floorId: string, id: number): Promise<void>;
  /** The Floors with a push Hook that is on. */
  floorsWatchingPushes(): Promise<string[]>;

  startRun(run: NewHookRun): Promise<HookRunRecord>;
  finishRun(id: number, end: HookRunEnd): Promise<HookRunRecord | undefined>;
  /** A Hook's latest runs, newest first. */
  runs(hookId: number, limit: number): Promise<HookRunRecord[]>;
  /** How many runs of a Hook started after `since`. */
  runsSince(hookId: number, since: Date): Promise<number>;
  /** Whether a Hook ever ran on a pull request. */
  ranOnPullRequest(hookId: number, pullRequest: number): Promise<boolean>;
  /**
   * Ends every run still going, as failed with `error`: those AI Office
   * stopped in the middle of. Answers how many.
   */
  failRunning(error: string, at: Date): Promise<number>;

  /** The default branch's head a Floor's push Hooks last saw. */
  pushHead(floorId: string): Promise<string | undefined>;
  setPushHead(floorId: string, sha: string, at: Date): Promise<void>;
}

/** Keeps them in memory: for tests. */
export function memoryHookStore(): HookStore & {
  readonly hooks: Map<number, HookRecord>;
  readonly hookRuns: Map<number, HookRunRecord>;
} {
  const records = new Map<number, HookRecord>();
  const runRecords = new Map<number, HookRunRecord>();
  const heads = new Map<string, string>();
  let nextHook = 1;
  let nextRun = 1;
  const taken = (floorId: string, name: string, except?: number) =>
    [...records.values()].some(
      (hook) =>
        hook.floorId === floorId &&
        hook.id !== except &&
        hook.name.toLowerCase() === name.toLowerCase(),
    );
  const ofHook = (hookId: number) =>
    [...runRecords.values()]
      .filter((run) => run.hookId === hookId)
      .sort((a, b) => b.id - a.id);
  return {
    hooks: records,
    hookRuns: runRecords,
    list(floorId) {
      return Promise.resolve(
        [...records.values()]
          .filter((hook) => hook.floorId === floorId)
          .sort((a, b) => a.id - b.id),
      );
    },
    get(floorId, id) {
      const hook = records.get(id);
      return Promise.resolve(hook?.floorId === floorId ? hook : undefined);
    },
    create(floorId, fields, at) {
      if (taken(floorId, fields.name)) {
        return Promise.resolve("name_taken");
      }
      const hook: HookRecord = {
        ...fields,
        labels: [...fields.labels],
        filePatterns: [...fields.filePatterns],
        id: nextHook,
        floorId,
        failures: 0,
        createdAt: at,
        updatedAt: at,
      };
      nextHook += 1;
      records.set(hook.id, hook);
      return Promise.resolve(hook);
    },
    update(floorId, id, fields, at) {
      const known = records.get(id);
      if (known?.floorId !== floorId) {
        return Promise.resolve(undefined);
      }
      if (taken(floorId, fields.name, id)) {
        return Promise.resolve("name_taken");
      }
      const hook: HookRecord = {
        ...known,
        ...fields,
        labels: [...fields.labels],
        filePatterns: [...fields.filePatterns],
        failures: 0,
        updatedAt: at,
      };
      records.set(id, hook);
      return Promise.resolve(hook);
    },
    remove(floorId, id) {
      const known = records.get(id);
      if (known?.floorId !== floorId) {
        return Promise.resolve(undefined);
      }
      records.delete(id);
      for (const run of ofHook(id)) {
        runRecords.delete(run.id);
      }
      return Promise.resolve(known);
    },
    recordFailure(floorId, id, turnOffAt, at) {
      const known = records.get(id);
      if (known?.floorId !== floorId) {
        return Promise.resolve(undefined);
      }
      const failures = known.failures + 1;
      const turnOff = known.enabled && failures >= turnOffAt;
      const hook: HookRecord = {
        ...known,
        failures,
        ...(turnOff ? { enabled: false, updatedAt: at } : {}),
      };
      records.set(id, hook);
      return Promise.resolve(hook);
    },
    recordSuccess(floorId, id) {
      const known = records.get(id);
      if (known?.floorId === floorId) {
        records.set(id, { ...known, failures: 0 });
      }
      return Promise.resolve();
    },
    floorsWatchingPushes() {
      return Promise.resolve([
        ...new Set(
          [...records.values()]
            .filter(({ trigger, enabled }) => enabled && trigger === "push")
            .map(({ floorId }) => floorId),
        ),
      ]);
    },
    startRun(run) {
      const record: HookRunRecord = {
        ...run,
        id: nextRun,
        status: "running",
        finishedAt: null,
        error: null,
        result: null,
        commentUrl: null,
      };
      nextRun += 1;
      runRecords.set(record.id, record);
      for (const old of ofHook(run.hookId).slice(keptHookRuns)) {
        if (old.status !== "running") {
          runRecords.delete(old.id);
        }
      }
      return Promise.resolve(record);
    },
    finishRun(id, end) {
      const known = runRecords.get(id);
      if (known?.status !== "running") {
        return Promise.resolve(undefined);
      }
      const record: HookRunRecord = { ...known, ...end };
      runRecords.set(id, record);
      return Promise.resolve(record);
    },
    runs(hookId, limit) {
      return Promise.resolve(ofHook(hookId).slice(0, limit));
    },
    runsSince(hookId, since) {
      return Promise.resolve(
        ofHook(hookId).filter(({ startedAt }) => startedAt > since).length,
      );
    },
    ranOnPullRequest(hookId, pullRequest) {
      return Promise.resolve(
        ofHook(hookId).some((run) => run.pullRequest === pullRequest),
      );
    },
    failRunning(error, at) {
      let count = 0;
      for (const run of runRecords.values()) {
        if (run.status === "running") {
          runRecords.set(run.id, {
            ...run,
            status: "failed",
            finishedAt: at,
            error,
          });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    pushHead(floorId) {
      return Promise.resolve(heads.get(floorId));
    },
    setPushHead(floorId, sha) {
      heads.set(floorId, sha);
      return Promise.resolve();
    },
  };
}

const oneOf = <Value extends string>(
  values: readonly Value[],
  value: string,
  what: string,
): Value => {
  const found = values.find((each) => each === value);
  if (found === undefined) {
    throw new Error(`Unknown ${what} "${value}".`);
  }
  return found;
};

type HookRow = typeof hooks.$inferSelect;
type RunRow = typeof hookRuns.$inferSelect;

const hookOf = (row: HookRow): HookRecord => ({
  id: row.id,
  floorId: row.floorId,
  name: row.name,
  trigger: oneOf(hookTriggers, row.trigger, "Hook trigger"),
  stage: row.stage === null ? null : oneOf(hookStages, row.stage, "Stage"),
  labels: row.labels,
  filePatterns: row.filePatterns,
  agentId: row.agentId,
  role: row.role,
  skillName: row.skillName,
  runsPerHour: row.runsPerHour,
  enabled: row.enabled,
  failures: row.failures,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const runOf = (row: RunRow): HookRunRecord => ({
  id: row.id,
  hookId: row.hookId,
  floorId: row.floorId,
  agentId: row.agentId,
  trigger: oneOf(hookTriggers, row.trigger, "Hook trigger"),
  issue: row.issue,
  pullRequest: row.pullRequest,
  status: oneOf(hookRunStatuses, row.status, "Hook run status"),
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  error: row.error,
  result: row.result,
  commentUrl: row.commentUrl,
});

/** Whether `error` is Postgres refusing a second Hook of one name. */
const isNameTaken = (error: unknown): boolean => {
  const cause = (error as { cause?: unknown }).cause ?? error;
  const { code, constraint } = cause as {
    code?: unknown;
    constraint?: unknown;
  };
  return code === "23505" && constraint === "hooks_name_unique";
};

const columnsOf = (fields: HookFields) => ({
  name: fields.name,
  trigger: fields.trigger,
  stage: fields.stage,
  labels: [...fields.labels],
  filePatterns: [...fields.filePatterns],
  agentId: fields.agentId,
  role: fields.role,
  skillName: fields.skillName,
  runsPerHour: fields.runsPerHour,
  enabled: fields.enabled,
});

/** Keeps them in `hooks`, `hook_runs` and `hook_push_heads`. */
export function databaseHookStore(db: Database): HookStore {
  const ofFloor = (floorId: string, id: number) =>
    and(eq(hooks.floorId, floorId), eq(hooks.id, id));
  return {
    async list(floorId) {
      const rows = await db
        .select()
        .from(hooks)
        .where(eq(hooks.floorId, floorId))
        .orderBy(asc(hooks.id));
      return rows.map(hookOf);
    },
    async get(floorId, id) {
      const [row] = await db.select().from(hooks).where(ofFloor(floorId, id));
      return row === undefined ? undefined : hookOf(row);
    },
    async create(floorId, fields, at) {
      try {
        const [row] = await db
          .insert(hooks)
          .values({
            ...columnsOf(fields),
            floorId,
            failures: 0,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (row === undefined) {
          throw new Error("The Hook was not added.");
        }
        return hookOf(row);
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },
    async update(floorId, id, fields, at) {
      try {
        const [row] = await db
          .update(hooks)
          .set({ ...columnsOf(fields), failures: 0, updatedAt: at })
          .where(ofFloor(floorId, id))
          .returning();
        return row === undefined ? undefined : hookOf(row);
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },
    async remove(floorId, id) {
      const [row] = await db
        .delete(hooks)
        .where(ofFloor(floorId, id))
        .returning();
      return row === undefined ? undefined : hookOf(row);
    },
    async recordFailure(floorId, id, turnOffAt, at) {
      const failures = sql`${hooks.failures} + 1`;
      const turnOff = sql`${hooks.enabled} AND ${hooks.failures} + 1 >= ${turnOffAt}`;
      const [row] = await db
        .update(hooks)
        .set({
          failures,
          enabled: sql`${hooks.enabled} AND NOT (${turnOff})`,
          updatedAt: sql`CASE WHEN ${turnOff} THEN ${at.toISOString()}::timestamptz ELSE ${hooks.updatedAt} END`,
        })
        .where(ofFloor(floorId, id))
        .returning();
      return row === undefined ? undefined : hookOf(row);
    },
    async recordSuccess(floorId, id) {
      await db.update(hooks).set({ failures: 0 }).where(ofFloor(floorId, id));
    },
    async floorsWatchingPushes() {
      const rows = await db
        .selectDistinct({ floorId: hooks.floorId })
        .from(hooks)
        .where(and(eq(hooks.trigger, "push"), eq(hooks.enabled, true)));
      return rows.map(({ floorId }) => floorId);
    },
    async startRun(run) {
      const [row] = await db
        .insert(hookRuns)
        .values({ ...run, status: "running" })
        .returning();
      if (row === undefined) {
        throw new Error("The Hook's run was not kept.");
      }
      const kept = db
        .select({ id: hookRuns.id })
        .from(hookRuns)
        .where(eq(hookRuns.hookId, run.hookId))
        .orderBy(desc(hookRuns.id))
        .limit(keptHookRuns);
      await db
        .delete(hookRuns)
        .where(
          and(
            eq(hookRuns.hookId, run.hookId),
            notInArray(hookRuns.id, kept),
            inArray(hookRuns.status, ["succeeded", "failed"]),
          ),
        );
      return runOf(row);
    },
    async finishRun(id, end) {
      const [row] = await db
        .update(hookRuns)
        .set(end)
        .where(and(eq(hookRuns.id, id), eq(hookRuns.status, "running")))
        .returning();
      return row === undefined ? undefined : runOf(row);
    },
    async runs(hookId, limit) {
      const rows = await db
        .select()
        .from(hookRuns)
        .where(eq(hookRuns.hookId, hookId))
        .orderBy(desc(hookRuns.id))
        .limit(limit);
      return rows.map(runOf);
    },
    async runsSince(hookId, since) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(hookRuns)
        .where(and(eq(hookRuns.hookId, hookId), gt(hookRuns.startedAt, since)));
      return row?.count ?? 0;
    },
    async ranOnPullRequest(hookId, pullRequest) {
      const [row] = await db
        .select({ id: hookRuns.id })
        .from(hookRuns)
        .where(
          and(
            eq(hookRuns.hookId, hookId),
            eq(hookRuns.pullRequest, pullRequest),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    async failRunning(error, at) {
      const rows = await db
        .update(hookRuns)
        .set({ status: "failed", finishedAt: at, error })
        .where(eq(hookRuns.status, "running"))
        .returning({ id: hookRuns.id });
      return rows.length;
    },
    async pushHead(floorId) {
      const [row] = await db
        .select({ sha: hookPushHeads.sha })
        .from(hookPushHeads)
        .where(eq(hookPushHeads.floorId, floorId));
      return row?.sha;
    },
    async setPushHead(floorId, sha, at) {
      await db
        .insert(hookPushHeads)
        .values({ floorId, sha, seenAt: at })
        .onConflictDoUpdate({
          target: hookPushHeads.floorId,
          set: { sha, seenAt: at },
        });
    },
  };
}
