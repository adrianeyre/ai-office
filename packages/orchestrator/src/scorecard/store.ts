import { scorecardRecords, type Database } from "@ai-office/db";
import {
  issueSizes,
  scorecardOutcomes,
  stages,
  type IssueSize,
  type ScorecardOutcome,
  type Stage,
} from "@ai-office/shared";
import { and, eq, gte, lt } from "drizzle-orm";

// Where the Scorecard's records live (Scorecards PRD, FR-126, FR-127): the
// `scorecard_records` table, or memory for tests. A piece of work's rows
// are written together, in place of any it had: one that is handed to
// the Owner and later merged is recorded as merged.

/** One Agent's part in a piece of work that ended, with one Model. */
export interface ScorecardEntry {
  readonly floorId: string;
  readonly issue: number;
  readonly agentId: string;
  readonly agentName: string;
  /** A library Role's id. */
  readonly role: string;
  readonly stage: Stage;
  readonly contractor: boolean;
  /** The Model that served it; its own, or empty, when it made no request. */
  readonly model: string;
  readonly size: IssueSize | null;
  readonly outcome: ScorecardOutcome;
  readonly roundsToApproval: number | null;
  readonly qaRoundsFailed: number;
  readonly stalls: number;
  readonly failures: number;
  readonly roundsReviewed: number;
  readonly blockingComments: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly endedAt: Date;
}

export interface ScorecardStore {
  /**
   * Records a piece of work's rows, in place of any it had: `entries` may
   * be empty when no Agent worked it.
   */
  record(
    floorId: string,
    issue: number,
    entries: readonly ScorecardEntry[],
  ): Promise<void>;
  /** The rows of work that ended in [`from`, `to`), oldest first. */
  list(from: Date, to: Date): Promise<ScorecardEntry[]>;
  /** The outcome recorded for a piece of work, if it has one. */
  outcomeOf(
    floorId: string,
    issue: number,
  ): Promise<ScorecardOutcome | undefined>;
  /** Deletes the rows of work that ended before `before`; how many went. */
  deleteBefore(before: Date): Promise<number>;
}

/** Keeps the records in memory: for tests. */
export function memoryScorecardStore(): ScorecardStore & {
  readonly entries: ScorecardEntry[];
} {
  const entries: ScorecardEntry[] = [];
  return {
    entries,
    record(floorId, issue, recorded) {
      const kept = entries.filter(
        (entry) => entry.floorId !== floorId || entry.issue !== issue,
      );
      entries.splice(
        0,
        Infinity,
        ...kept,
        ...recorded.map((entry) => ({ ...entry })),
      );
      return Promise.resolve();
    },
    list: (from, to) =>
      Promise.resolve(
        entries
          .filter(({ endedAt }) => endedAt >= from && endedAt < to)
          .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime())
          .map((entry) => ({ ...entry })),
      ),
    outcomeOf: (floorId, issue) =>
      Promise.resolve(
        entries.find(
          (entry) => entry.floorId === floorId && entry.issue === issue,
        )?.outcome,
      ),
    deleteBefore(before) {
      const kept = entries.filter(({ endedAt }) => endedAt >= before);
      const deleted = entries.length - kept.length;
      entries.splice(0, Infinity, ...kept);
      return Promise.resolve(deleted);
    },
  };
}

type Row = typeof scorecardRecords.$inferSelect;

const toEntry = (row: Row): ScorecardEntry => ({
  floorId: row.floorId,
  issue: row.issue,
  agentId: row.agentId,
  agentName: row.agentName,
  role: row.role,
  stage: stages.find((stage) => stage === row.stage) ?? "work",
  contractor: row.contractor,
  model: row.model,
  size: issueSizes.find((size) => size === row.size) ?? null,
  outcome:
    scorecardOutcomes.find((outcome) => outcome === row.outcome) ?? "closed",
  roundsToApproval: row.roundsToApproval,
  qaRoundsFailed: row.qaRoundsFailed,
  stalls: row.stalls,
  failures: row.failures,
  roundsReviewed: row.roundsReviewed,
  blockingComments: row.blockingComments,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  estimatedCostUsd: row.estimatedCostUsd,
  endedAt: row.endedAt,
});

/** Keeps the records in the `scorecard_records` table. */
export function databaseScorecardStore(db: Database): ScorecardStore {
  return {
    record: (floorId, issue, entries) =>
      db.transaction(async (tx) => {
        await tx
          .delete(scorecardRecords)
          .where(
            and(
              eq(scorecardRecords.floorId, floorId),
              eq(scorecardRecords.issue, issue),
            ),
          );
        if (entries.length > 0) {
          await tx
            .insert(scorecardRecords)
            .values(entries.map((entry) => ({ ...entry })));
        }
      }),
    async list(from, to) {
      const rows = await db
        .select()
        .from(scorecardRecords)
        .where(
          and(
            gte(scorecardRecords.endedAt, from),
            lt(scorecardRecords.endedAt, to),
          ),
        )
        .orderBy(scorecardRecords.endedAt);
      return rows.map(toEntry);
    },
    async outcomeOf(floorId, issue) {
      const [row] = await db
        .select({ outcome: scorecardRecords.outcome })
        .from(scorecardRecords)
        .where(
          and(
            eq(scorecardRecords.floorId, floorId),
            eq(scorecardRecords.issue, issue),
          ),
        )
        .limit(1);
      return scorecardOutcomes.find((outcome) => outcome === row?.outcome);
    },
    async deleteBefore(before) {
      const deleted = await db
        .delete(scorecardRecords)
        .where(lt(scorecardRecords.endedAt, before));
      return deleted.rowCount ?? 0;
    },
  };
}
