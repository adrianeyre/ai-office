import {
  recurringGoalRuns,
  recurringGoals,
  type Database,
} from "@ai-office/db";
import {
  recurringGoalFrequencies,
  recurringGoalRunOutcomes,
  type RecurringGoalRunOutcome,
  type RecurringGoalSchedule,
} from "@ai-office/shared";
import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";

// Where each Floor's Recurring Goals and their runs are kept (Scorecards
// PRD, FR-136 to FR-141): the `recurring_goals` and `recurring_goal_runs`
// tables, or memory for tests. A name is unique on its Floor, whatever its
// case.

/** A Recurring Goal as the orchestrator holds it. */
export interface RecurringGoalRecord {
  readonly id: number;
  readonly floorId: string;
  readonly name: string;
  readonly words: string;
  readonly schedule: RecurringGoalSchedule;
  /** Null for the office's daily Token Cap. */
  readonly tokenCap: number | null;
  readonly enabled: boolean;
  /** Its failed runs in a row. */
  readonly failures: number;
  /** When it next comes round; null while it is off. */
  readonly nextRunAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What the Owner writes of a Recurring Goal, and what AI Office keeps. */
export type RecurringGoalFields = Pick<
  RecurringGoalRecord,
  "name" | "words" | "schedule" | "tokenCap" | "enabled"
>;

/** One run of a Recurring Goal. */
export interface RecurringGoalRunRecord {
  readonly id: number;
  readonly goalId: number;
  readonly floorId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly outcome: RecurringGoalRunOutcome;
  readonly reason: string;
  readonly batchId: number | null;
  readonly issues: readonly number[];
  readonly tokens: number;
}

/** How a run ended. */
export type RunEnd = Pick<
  RecurringGoalRunRecord,
  "outcome" | "reason" | "batchId" | "issues" | "tokens"
>;

export interface RecurringGoalStore {
  /** A Floor's Recurring Goals, oldest first. */
  list(floorId: string): Promise<RecurringGoalRecord[]>;
  get(floorId: string, id: number): Promise<RecurringGoalRecord | undefined>;
  /** Adds one; `name_taken` when another on the Floor has its name. */
  create(
    floorId: string,
    fields: RecurringGoalFields & { readonly nextRunAt: Date | null },
    at: Date,
  ): Promise<RecurringGoalRecord | "name_taken">;
  /** Changes one; undefined when there is none, `name_taken` as above. */
  update(
    floorId: string,
    id: number,
    changes: Partial<
      RecurringGoalFields & Pick<RecurringGoalRecord, "failures" | "nextRunAt">
    >,
    at: Date,
  ): Promise<RecurringGoalRecord | undefined | "name_taken">;
  /** Deletes one, and its runs; false when there was none. */
  remove(floorId: string, id: number): Promise<boolean>;
  /** Every Floor's Recurring Goals that are on and due by `at`. */
  due(at: Date): Promise<RecurringGoalRecord[]>;
  startRun(
    goal: RecurringGoalRecord,
    at: Date,
  ): Promise<RecurringGoalRunRecord>;
  endRun(id: number, end: RunEnd, at: Date): Promise<RecurringGoalRunRecord>;
  /** A Recurring Goal's runs, newest first. */
  runs(goalId: number, limit: number): Promise<RecurringGoalRunRecord[]>;
  /** Every issue its runs filed, oldest first (FR-139). */
  filed(goalId: number): Promise<number[]>;
}

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const copyGoal = (goal: RecurringGoalRecord): RecurringGoalRecord => ({
  ...goal,
  schedule: { ...goal.schedule, days: [...goal.schedule.days] },
});

const copyRun = (run: RecurringGoalRunRecord): RecurringGoalRunRecord => ({
  ...run,
  issues: [...run.issues],
});

/** Keeps Recurring Goals and their runs in memory: for tests. */
export function memoryRecurringGoalStore(): RecurringGoalStore & {
  readonly goals: Map<number, RecurringGoalRecord>;
  readonly runList: RecurringGoalRunRecord[];
} {
  const goals = new Map<number, RecurringGoalRecord>();
  const runList: RecurringGoalRunRecord[] = [];
  let nextGoal = 1;
  let nextRun = 1;
  const taken = (floorId: string, name: string, except?: number) =>
    [...goals.values()].some(
      (goal) =>
        goal.floorId === floorId &&
        goal.id !== except &&
        sameName(goal.name, name),
    );
  return {
    goals,
    runList,
    list: (floorId) =>
      Promise.resolve(
        [...goals.values()]
          .filter((goal) => goal.floorId === floorId)
          .sort((a, b) => a.id - b.id)
          .map(copyGoal),
      ),
    get: (floorId, id) => {
      const goal = goals.get(id);
      return Promise.resolve(
        goal?.floorId === floorId ? copyGoal(goal) : undefined,
      );
    },
    create(floorId, fields, at) {
      if (taken(floorId, fields.name)) {
        return Promise.resolve("name_taken" as const);
      }
      const goal: RecurringGoalRecord = {
        id: nextGoal++,
        floorId,
        ...fields,
        failures: 0,
        createdAt: at,
        updatedAt: at,
      };
      goals.set(goal.id, copyGoal(goal));
      return Promise.resolve(copyGoal(goal));
    },
    update(floorId, id, changes, at) {
      const goal = goals.get(id);
      if (goal?.floorId !== floorId) {
        return Promise.resolve(undefined);
      }
      if (changes.name !== undefined && taken(floorId, changes.name, id)) {
        return Promise.resolve("name_taken" as const);
      }
      const updated = copyGoal({ ...goal, ...changes, updatedAt: at });
      goals.set(id, updated);
      return Promise.resolve(copyGoal(updated));
    },
    remove(floorId, id) {
      const goal = goals.get(id);
      if (goal?.floorId !== floorId) {
        return Promise.resolve(false);
      }
      goals.delete(id);
      const kept = runList.filter((run) => run.goalId !== id);
      runList.splice(0, Infinity, ...kept);
      return Promise.resolve(true);
    },
    due: (at) =>
      Promise.resolve(
        [...goals.values()]
          .filter(
            ({ enabled, nextRunAt }) =>
              enabled && nextRunAt !== null && nextRunAt <= at,
          )
          .sort((a, b) => a.id - b.id)
          .map(copyGoal),
      ),
    startRun(goal, at) {
      const run: RecurringGoalRunRecord = {
        id: nextRun++,
        goalId: goal.id,
        floorId: goal.floorId,
        startedAt: at,
        finishedAt: null,
        outcome: "running",
        reason: "",
        batchId: null,
        issues: [],
        tokens: 0,
      };
      runList.push(run);
      return Promise.resolve(copyRun(run));
    },
    endRun(id, end, at) {
      const index = runList.findIndex((run) => run.id === id);
      const run = runList[index];
      if (run === undefined) {
        return Promise.reject(new Error(`No run ${String(id)}.`));
      }
      const ended = { ...run, ...end, issues: [...end.issues], finishedAt: at };
      runList[index] = ended;
      return Promise.resolve(copyRun(ended));
    },
    runs: (goalId, limit) =>
      Promise.resolve(
        runList
          .filter((run) => run.goalId === goalId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map(copyRun),
      ),
    filed: (goalId) =>
      Promise.resolve(
        runList
          .filter((run) => run.goalId === goalId)
          .sort((a, b) => a.id - b.id)
          .flatMap(({ issues }) => issues),
      ),
  };
}

type GoalRow = typeof recurringGoals.$inferSelect;
type RunRow = typeof recurringGoalRuns.$inferSelect;

const toGoal = (row: GoalRow): RecurringGoalRecord => ({
  id: row.id,
  floorId: row.floorId,
  name: row.name,
  words: row.words,
  schedule: {
    frequency:
      recurringGoalFrequencies.find((each) => each === row.frequency) ??
      "daily",
    days: [...row.days].sort((a, b) => a - b),
    time: row.time,
  },
  tokenCap: row.tokenCap,
  enabled: row.enabled,
  failures: row.failures,
  nextRunAt: row.nextRunAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRun = (row: RunRow): RecurringGoalRunRecord => ({
  id: row.id,
  goalId: row.goalId,
  floorId: row.floorId,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  outcome:
    recurringGoalRunOutcomes.find((each) => each === row.outcome) ?? "failed",
  reason: row.reason,
  batchId: row.batchId,
  issues: row.issues,
  tokens: row.tokens,
});

/** Whether `error` is Postgres refusing a second Recurring Goal of one name. */
const isNameTaken = (error: unknown): boolean => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, constraint } = cause as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && constraint === "recurring_goals_name_unique") {
      return true;
    }
  }
  return false;
};

/** Keeps Recurring Goals in `recurring_goals` and `recurring_goal_runs`. */
export function databaseRecurringGoalStore(db: Database): RecurringGoalStore {
  const columns = (
    changes: Partial<
      RecurringGoalFields & Pick<RecurringGoalRecord, "failures" | "nextRunAt">
    >,
  ): Partial<typeof recurringGoals.$inferInsert> => {
    const { schedule, ...rest } = changes;
    return {
      ...rest,
      ...(schedule === undefined
        ? {}
        : {
            frequency: schedule.frequency,
            days: [...schedule.days],
            time: schedule.time,
          }),
    };
  };
  return {
    async list(floorId) {
      const rows = await db
        .select()
        .from(recurringGoals)
        .where(eq(recurringGoals.floorId, floorId))
        .orderBy(recurringGoals.id);
      return rows.map(toGoal);
    },
    async get(floorId, id) {
      const [row] = await db
        .select()
        .from(recurringGoals)
        .where(
          and(eq(recurringGoals.floorId, floorId), eq(recurringGoals.id, id)),
        );
      return row === undefined ? undefined : toGoal(row);
    },
    async create(floorId, fields, at) {
      try {
        const [row] = await db
          .insert(recurringGoals)
          .values({
            floorId,
            name: fields.name,
            words: fields.words,
            frequency: fields.schedule.frequency,
            days: [...fields.schedule.days],
            time: fields.schedule.time,
            tokenCap: fields.tokenCap,
            enabled: fields.enabled,
            nextRunAt: fields.nextRunAt,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (row === undefined) {
          throw new Error("The Recurring Goal was not kept.");
        }
        return toGoal(row);
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },
    async update(floorId, id, changes, at) {
      try {
        const [row] = await db
          .update(recurringGoals)
          .set({ ...columns(changes), updatedAt: at })
          .where(
            and(eq(recurringGoals.floorId, floorId), eq(recurringGoals.id, id)),
          )
          .returning();
        return row === undefined ? undefined : toGoal(row);
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },
    async remove(floorId, id) {
      const deleted = await db
        .delete(recurringGoals)
        .where(
          and(eq(recurringGoals.floorId, floorId), eq(recurringGoals.id, id)),
        )
        .returning({ id: recurringGoals.id });
      return deleted.length > 0;
    },
    async due(at) {
      const rows = await db
        .select()
        .from(recurringGoals)
        .where(
          and(
            eq(recurringGoals.enabled, true),
            isNotNull(recurringGoals.nextRunAt),
            lte(recurringGoals.nextRunAt, at),
          ),
        )
        .orderBy(recurringGoals.id);
      return rows.map(toGoal);
    },
    async startRun(goal, at) {
      const [row] = await db
        .insert(recurringGoalRuns)
        .values({
          goalId: goal.id,
          floorId: goal.floorId,
          startedAt: at,
          outcome: "running",
        })
        .returning();
      if (row === undefined) {
        throw new Error("The run was not kept.");
      }
      return toRun(row);
    },
    async endRun(id, end, at) {
      const [row] = await db
        .update(recurringGoalRuns)
        .set({ ...end, issues: [...end.issues], finishedAt: at })
        .where(eq(recurringGoalRuns.id, id))
        .returning();
      if (row === undefined) {
        throw new Error(`No run ${String(id)}.`);
      }
      return toRun(row);
    },
    async runs(goalId, limit) {
      const rows = await db
        .select()
        .from(recurringGoalRuns)
        .where(eq(recurringGoalRuns.goalId, goalId))
        .orderBy(desc(recurringGoalRuns.id))
        .limit(limit);
      return rows.map(toRun);
    },
    async filed(goalId) {
      const rows = await db
        .select({
          issue: sql<number>`unnest(${recurringGoalRuns.issues})`.mapWith(
            Number,
          ),
        })
        .from(recurringGoalRuns)
        .where(eq(recurringGoalRuns.goalId, goalId))
        .orderBy(recurringGoalRuns.id);
      return rows.map(({ issue }) => issue);
    },
  };
}
