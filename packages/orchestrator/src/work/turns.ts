import { issueWorkTurns, type Database } from "@ai-office/db";
import { and, eq } from "drizzle-orm";

// Ordered work Roles for one issue (PRD FR-25 (1), §5 scenario 11; ADR
// 0003). A Batch's Plan may give an issue an ordered list of work Roles,
// such as a merchandiser then a copywriter. They take turns on the issue's
// one branch: each Role's Agent works it in a sandbox, AI Office pushes
// what it committed and records its Handoff, and the next Role's Agent
// takes it from there, with that Handoff (the walk between desks). Review
// starts once the last Role has worked it. The work queue dispatches the
// issue's work-Stage work to the Role whose turn it is.
//
// When the Review Loop sends the pull request back, the fix goes to the
// work Role whose changes its blocking comments concern: the one Role
// whose commits changed every file they are on. When that is unclear (the
// comments are on files several Roles changed, or none did), it goes to
// the last Role. Anything else that sends the issue back, such as QA, goes
// to the last Role too. A fix goes straight back to review: the turns are
// taken once, before the first review.
//
// An issue whose Plan gives it no Roles (or no Plan) has no turns: the
// Role the Manager's triage chose works it (FR-23).

/** An issue's work Roles, and whose turn it is. */
export interface WorkTurnsRecord {
  readonly floorId: string;
  readonly issue: number;
  /** The Batch whose Plan gave the Roles; null if none. */
  readonly batchId: number | null;
  /** The work Roles (library Roles' ids), in the order they take turns. */
  readonly roles: readonly string[];
  /** The index in `roles` of the Role whose turn it is. */
  readonly turn: number;
  /**
   * Whether the last Role has handed the issue to review: from then on, a
   * turn is a fix, which goes straight back to review.
   */
  readonly reviewing: boolean;
  /** The files each Role's commits changed, by Role id. */
  readonly files: Readonly<Record<string, readonly string[]>>;
  readonly updatedAt: Date;
}

export interface WorkTurnsStore {
  get(floorId: string, issue: number): Promise<WorkTurnsRecord | undefined>;
  /** Keeps an issue's turns, in place of any before. */
  put(record: WorkTurnsRecord): Promise<void>;
}

const key = (floorId: string, issue: number): string =>
  `${floorId}#${String(issue)}`;

const copy = (record: WorkTurnsRecord): WorkTurnsRecord => ({
  ...record,
  roles: [...record.roles],
  files: Object.fromEntries(
    Object.entries(record.files).map(([role, files]) => [role, [...files]]),
  ),
});

/** Keeps turns in memory: for tests. */
export function memoryWorkTurnsStore(): WorkTurnsStore & {
  readonly records: Map<string, WorkTurnsRecord>;
} {
  const records = new Map<string, WorkTurnsRecord>();
  return {
    records,
    get(floorId, issue) {
      const record = records.get(key(floorId, issue));
      return Promise.resolve(record === undefined ? undefined : copy(record));
    },
    put(record) {
      records.set(key(record.floorId, record.issue), copy(record));
      return Promise.resolve();
    },
  };
}

type WorkTurnsRow = typeof issueWorkTurns.$inferSelect;

const toRecord = (row: WorkTurnsRow): WorkTurnsRecord => ({
  floorId: row.floorId,
  issue: row.issue,
  batchId: row.batchId,
  roles: row.roles as string[],
  turn: row.turn,
  reviewing: row.reviewing,
  files: row.files as Record<string, string[]>,
  updatedAt: row.updatedAt,
});

/** Keeps turns in the `issue_work_turns` table. */
export function databaseWorkTurnsStore(db: Database): WorkTurnsStore {
  return {
    async get(floorId, issue) {
      const [row] = await db
        .select()
        .from(issueWorkTurns)
        .where(
          and(
            eq(issueWorkTurns.floorId, floorId),
            eq(issueWorkTurns.issue, issue),
          ),
        );
      return row === undefined ? undefined : toRecord(row);
    },

    async put(record) {
      const values = copy(record);
      await db
        .insert(issueWorkTurns)
        .values(values)
        .onConflictDoUpdate({
          target: [issueWorkTurns.floorId, issueWorkTurns.issue],
          set: {
            batchId: values.batchId,
            roles: values.roles,
            turn: values.turn,
            reviewing: values.reviewing,
            files: values.files,
            updatedAt: values.updatedAt,
          },
        });
    },
  };
}

/** Whose turn is next once the Role whose turn it is delivers. */
export type Delivered =
  /** The next Role takes its turn on the branch. */
  | { readonly next: "role"; readonly role: string }
  /** The last Role (or a fix) is done: on to review. */
  | { readonly next: "review" };

/**
 * `record` once the Role whose turn it is delivered, having changed
 * `files`: the next Role's turn, until the last Role's; then review.
 */
export function afterDelivery(
  record: WorkTurnsRecord,
  files: readonly string[],
  at: Date,
): { record: WorkTurnsRecord; delivered: Delivered } {
  const role = record.roles[record.turn];
  const changed =
    role === undefined
      ? record.files
      : {
          ...record.files,
          [role]: [...new Set([...(record.files[role] ?? []), ...files])],
        };
  const last = record.roles.length - 1;
  const next = record.roles[record.turn + 1];
  if (!record.reviewing && next !== undefined) {
    return {
      record: {
        ...record,
        turn: record.turn + 1,
        files: changed,
        updatedAt: at,
      },
      delivered: { next: "role", role: next },
    };
  }
  return {
    record: {
      ...record,
      turn: last,
      reviewing: true,
      files: changed,
      updatedAt: at,
    },
    delivered: { next: "review" },
  };
}

/**
 * The Role a Review Loop fix goes to: the one Role whose commits changed
 * each file the blocking comments (`paths`) are on; or, when that is
 * unclear, the last. `clear` says which.
 */
export function fixRole(
  record: Pick<WorkTurnsRecord, "roles" | "files">,
  paths: readonly string[],
): { role: string; clear: boolean } {
  const last = record.roles.at(-1) ?? "";
  const concerned = new Set<string>();
  for (const path of new Set(paths)) {
    const changedBy = record.roles.filter((role) =>
      (record.files[role] ?? []).includes(path),
    );
    const [only] = changedBy;
    if (changedBy.length !== 1 || only === undefined) {
      return { role: last, clear: false };
    }
    concerned.add(only);
  }
  const [role] = concerned;
  return concerned.size === 1 && role !== undefined
    ? { role, clear: true }
    : { role: last, clear: false };
}

export interface WorkTurns {
  /**
   * Gives an issue the work Roles its Batch's Plan names, in order: the
   * first takes the first turn. Replaces any turns it had.
   */
  plan(
    floorId: string,
    issue: number,
    roles: readonly string[],
    batchId: number | null,
  ): Promise<void>;
  /** An issue's turns; undefined when no Plan gave it work Roles. */
  get(floorId: string, issue: number): Promise<WorkTurnsRecord | undefined>;
  /**
   * The work Role whose turn it is on an issue, for the work queue to
   * dispatch its work-Stage work to; null when it has no turns.
   */
  role(floorId: string, issue: number): Promise<string | null>;
  /**
   * Records that the Role whose turn it is delivered, having changed
   * `files`; answers who is next: the next Role, or review.
   */
  delivered(
    floorId: string,
    issue: number,
    files: readonly string[],
  ): Promise<Delivered | undefined>;
  /**
   * The Review Loop sends the issue back with blocking comments on
   * `paths`: the fix is the turn of the Role whose changes they concern,
   * or the last Role's. Undefined when the issue has no turns.
   */
  sendBack(
    floorId: string,
    issue: number,
    paths: readonly string[],
  ): Promise<{ role: string; clear: boolean } | undefined>;
}

export function createWorkTurns(options: {
  readonly store: WorkTurnsStore;
  readonly now?: () => Date;
}): WorkTurns {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  return {
    async plan(floorId, issue, roles, batchId) {
      if (roles.length === 0) {
        throw new Error("An issue's turns need at least one work Role.");
      }
      await store.put({
        floorId,
        issue,
        batchId,
        roles: [...roles],
        turn: 0,
        reviewing: false,
        files: {},
        updatedAt: now(),
      });
    },

    get: (floorId, issue) => store.get(floorId, issue),

    async role(floorId, issue) {
      const record = await store.get(floorId, issue);
      return record?.roles[record.turn] ?? null;
    },

    async delivered(floorId, issue, files) {
      const record = await store.get(floorId, issue);
      if (record === undefined) {
        return undefined;
      }
      const after = afterDelivery(record, files, now());
      await store.put(after.record);
      return after.delivered;
    },

    async sendBack(floorId, issue, paths) {
      const record = await store.get(floorId, issue);
      if (record === undefined) {
        return undefined;
      }
      const fix = fixRole(record, paths);
      await store.put({
        ...record,
        turn: Math.max(0, record.roles.indexOf(fix.role)),
        reviewing: true,
        updatedAt: now(),
      });
      return fix;
    },
  };
}
