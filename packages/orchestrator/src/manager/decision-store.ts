import { managerDecisions, type Database } from "@ai-office/db";
import type {
  ManagerAction,
  PipelineStage,
  WatchdogTrigger,
} from "@ai-office/shared";
import { and, asc, eq } from "drizzle-orm";

// The Manager's decision log (PRD FR-23): each decision its watchdog took,
// in the `manager_decisions` table, or memory for tests. Each is keyed by
// the condition it answered, so it is decided once, across restarts too.

/** One decision the Manager took about an issue's work. */
export interface DecisionRecord {
  readonly floorId: string;
  readonly issue: number;
  /** The Manager that decided. */
  readonly agentId: string;
  readonly action: ManagerAction;
  readonly trigger: WatchdogTrigger;
  /** The stage of the work it concerns. */
  readonly stage: PipelineStage;
  /** The Agent whose work it took away, or that it paused. */
  readonly fromAgentId: string | null;
  /** The Agent it gave the work to. */
  readonly toAgentId: string | null;
  /** The stage it moved the issue to. */
  readonly toStage: PipelineStage | null;
  /** The condition it answered, such as one stalled run of some work. */
  readonly key: string;
  /** Why, as the comment on the issue says it. */
  readonly reason: string;
  readonly createdAt: Date;
}

export interface DecisionStore {
  /** Whether the condition `key` names has been decided on the Floor. */
  decided(floorId: string, key: string): Promise<boolean>;
  /** Records a decision; false when its condition was decided already. */
  record(decision: DecisionRecord): Promise<boolean>;
  /** An issue's decisions, oldest first. */
  list(floorId: string, issue: number): Promise<DecisionRecord[]>;
}

/** Keeps decisions in memory: for tests. */
export function memoryDecisionStore(): DecisionStore & {
  readonly decisions: DecisionRecord[];
} {
  const decisions: DecisionRecord[] = [];
  const decided = (floorId: string, key: string) =>
    decisions.some(
      (decision) => decision.floorId === floorId && decision.key === key,
    );
  return {
    decisions,
    decided: (floorId, key) => Promise.resolve(decided(floorId, key)),
    record(decision) {
      if (decided(decision.floorId, decision.key)) {
        return Promise.resolve(false);
      }
      decisions.push({ ...decision });
      return Promise.resolve(true);
    },
    list: (floorId, issue) =>
      Promise.resolve(
        decisions
          .filter(
            (decision) =>
              decision.floorId === floorId && decision.issue === issue,
          )
          .map((decision) => ({ ...decision })),
      ),
  };
}

type DecisionRow = typeof managerDecisions.$inferSelect;

const toRecord = (row: DecisionRow): DecisionRecord => ({
  floorId: row.floorId,
  issue: row.issue,
  agentId: row.agentId,
  action: row.action as ManagerAction,
  trigger: row.trigger as WatchdogTrigger,
  stage: row.stage as PipelineStage,
  fromAgentId: row.fromAgentId,
  toAgentId: row.toAgentId,
  toStage: row.toStage as PipelineStage | null,
  key: row.key,
  reason: row.reason,
  createdAt: row.createdAt,
});

/** Keeps decisions in the `manager_decisions` table. */
export function databaseDecisionStore(db: Database): DecisionStore {
  return {
    async decided(floorId, key) {
      const [row] = await db
        .select({ id: managerDecisions.id })
        .from(managerDecisions)
        .where(
          and(
            eq(managerDecisions.floorId, floorId),
            eq(managerDecisions.key, key),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async record(decision) {
      // The unique index refuses a condition decided already.
      const rows = await db
        .insert(managerDecisions)
        .values(decision)
        .onConflictDoNothing()
        .returning({ id: managerDecisions.id });
      return rows.length > 0;
    },

    async list(floorId, issue) {
      const rows = await db
        .select()
        .from(managerDecisions)
        .where(
          and(
            eq(managerDecisions.floorId, floorId),
            eq(managerDecisions.issue, issue),
          ),
        )
        .orderBy(asc(managerDecisions.createdAt), asc(managerDecisions.id));
      return rows.map(toRecord);
    },
  };
}
