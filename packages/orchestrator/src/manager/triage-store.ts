import { issueTriage, type Database } from "@ai-office/db";
import type { IssuePriority, TriageJudge } from "@ai-office/shared";
import { and, eq } from "drizzle-orm";

// Where the Manager's triage of each issue is kept (PRD FR-23): the
// `issue_triage` table, or memory for tests. One record per issue: its
// latest triage, with the work Role chosen for it (ADR 0003).

/**
 * `clear`: it may be worked. `waiting`: for the Owner's answer. `routing`:
 * clear, but waiting for the Owner to choose which work Role works it.
 */
export type TriageStatus = "clear" | "waiting" | "routing";

export interface TriageRecord {
  readonly floorId: string;
  readonly issue: number;
  readonly status: TriageStatus;
  readonly priority: IssuePriority;
  readonly judgedBy: TriageJudge;
  /** The Manager whose triage it was. */
  readonly agentId: string | null;
  /** A SHA-256 of the issue's title and body as they were judged. */
  readonly fingerprint: string;
  /** The action Notice asking the Owner, while it waits. */
  readonly noticeId: string | null;
  /**
   * The work Role chosen to work it (a library Role's id); null until one
   * is, and on a Floor with no work Agents.
   */
  readonly role: string | null;
  /** The work Roles the Owner is asked to choose from, while `routing`. */
  readonly candidates: readonly string[];
  readonly triagedAt: Date;
}

export interface TriageStore {
  get(floorId: string, issue: number): Promise<TriageRecord | undefined>;
  /** Keeps an issue's latest triage, in place of any before it. */
  put(record: TriageRecord): Promise<void>;
}

const key = (floorId: string, issue: number): string =>
  `${floorId}#${String(issue)}`;

/** Keeps triage in memory: for tests. */
export function memoryTriageStore(): TriageStore & {
  readonly records: Map<string, TriageRecord>;
} {
  const records = new Map<string, TriageRecord>();
  return {
    records,
    get: (floorId, issue) => {
      const record = records.get(key(floorId, issue));
      return Promise.resolve(
        record === undefined
          ? undefined
          : { ...record, candidates: [...record.candidates] },
      );
    },
    put(record) {
      records.set(key(record.floorId, record.issue), {
        ...record,
        candidates: [...record.candidates],
      });
      return Promise.resolve();
    },
  };
}

type TriageRow = typeof issueTriage.$inferSelect;

const toRecord = (row: TriageRow): TriageRecord => ({
  floorId: row.floorId,
  issue: row.issue,
  status: row.status as TriageStatus,
  priority: row.priority as IssuePriority,
  judgedBy: row.judgedBy as TriageJudge,
  agentId: row.agentId,
  fingerprint: row.fingerprint,
  noticeId: row.noticeId,
  role: row.role,
  candidates: row.candidates as string[],
  triagedAt: row.triagedAt,
});

/** Keeps triage in the `issue_triage` table. */
export function databaseTriageStore(db: Database): TriageStore {
  return {
    async get(floorId, issue) {
      const [row] = await db
        .select()
        .from(issueTriage)
        .where(
          and(eq(issueTriage.floorId, floorId), eq(issueTriage.issue, issue)),
        );
      return row === undefined ? undefined : toRecord(row);
    },

    async put(record) {
      await db
        .insert(issueTriage)
        .values({ ...record, candidates: [...record.candidates] })
        .onConflictDoUpdate({
          target: [issueTriage.floorId, issueTriage.issue],
          set: {
            status: record.status,
            priority: record.priority,
            judgedBy: record.judgedBy,
            agentId: record.agentId,
            fingerprint: record.fingerprint,
            noticeId: record.noticeId,
            role: record.role,
            candidates: [...record.candidates],
            triagedAt: record.triagedAt,
          },
        });
    },
  };
}
