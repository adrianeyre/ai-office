import { guidelineProposals, type Database } from "@ai-office/db";
import {
  guidelineProposalStatuses,
  type GuidelineProposalStatus,
} from "@ai-office/shared";
import { and, asc, eq } from "drizzle-orm";

// Where the Guidelines Agents propose wait for the Owner (Guidelines,
// Specs and Hooks PRD, FR-110, FR-111): the `guideline_proposals` table,
// or memory for tests. Each is the whole file proposed, redacted, by the
// SHA-256 of it; the same version of a Guideline waits once per Floor.
// Only the Owner settles one: opened as a pull request, or rejected.

/** A Guideline an Agent proposed, and what became of it. */
export interface GuidelineProposalRecord {
  readonly id: number;
  readonly floorId: string;
  /** The Guideline it adds or changes: its file name without `.md`. */
  readonly name: string;
  readonly contentHash: string;
  /** The whole file proposed, front matter and all. */
  readonly content: string;
  /** The Agent that proposed it. */
  readonly agentId: string;
  /** The issue whose Handoff, or QA report, proposed it. */
  readonly issue: number;
  readonly status: GuidelineProposalStatus;
  readonly createdAt: Date;
  /** When the Owner opened or rejected it; null while it waits. */
  readonly decidedAt: Date | null;
  /** The pull request it was opened as; null unless `opened`. */
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
  } | null;
}

/** A proposal to keep. */
export type NewGuidelineProposal = Pick<
  GuidelineProposalRecord,
  | "floorId"
  | "name"
  | "contentHash"
  | "content"
  | "agentId"
  | "issue"
  | "createdAt"
>;

export interface GuidelineProposalStore {
  /**
   * Keeps a proposal, waiting for the Owner; undefined when the same
   * version of that Guideline waits on the Floor already.
   */
  propose(
    proposal: NewGuidelineProposal,
  ): Promise<GuidelineProposalRecord | undefined>;
  /** The Floor's proposals waiting for the Owner, oldest first. */
  waiting(floorId: string): Promise<GuidelineProposalRecord[]>;
  /** One of the Floor's proposals, whatever became of it. */
  get(
    floorId: string,
    id: number,
  ): Promise<GuidelineProposalRecord | undefined>;
  /** Marks it opened as `pullRequest`; false unless it was waiting. */
  open(
    floorId: string,
    id: number,
    pullRequest: { readonly number: number; readonly url: string },
    at: Date,
  ): Promise<boolean>;
  /** Marks it rejected; false unless it was waiting. */
  reject(floorId: string, id: number, at: Date): Promise<boolean>;
}

/** Keeps them in memory: for tests. */
export function memoryGuidelineProposalStore(): GuidelineProposalStore {
  const records = new Map<number, GuidelineProposalRecord>();
  let next = 1;
  const settle = (
    floorId: string,
    id: number,
    change: Pick<
      GuidelineProposalRecord,
      "status" | "decidedAt" | "pullRequest"
    >,
  ): Promise<boolean> => {
    const known = records.get(id);
    if (known?.floorId !== floorId || known.status !== "proposed") {
      return Promise.resolve(false);
    }
    records.set(id, { ...known, ...change });
    return Promise.resolve(true);
  };
  return {
    propose(proposal) {
      const waiting = [...records.values()].some(
        (record) =>
          record.floorId === proposal.floorId &&
          record.name === proposal.name &&
          record.contentHash === proposal.contentHash &&
          record.status === "proposed",
      );
      if (waiting) {
        return Promise.resolve(undefined);
      }
      const record: GuidelineProposalRecord = {
        ...proposal,
        id: next,
        status: "proposed",
        decidedAt: null,
        pullRequest: null,
      };
      next += 1;
      records.set(record.id, record);
      return Promise.resolve(record);
    },
    waiting(floorId) {
      return Promise.resolve(
        [...records.values()].filter(
          (record) =>
            record.floorId === floorId && record.status === "proposed",
        ),
      );
    },
    get(floorId, id) {
      const record = records.get(id);
      return Promise.resolve(record?.floorId === floorId ? record : undefined);
    },
    open: (floorId, id, pullRequest, at) =>
      settle(floorId, id, { status: "opened", decidedAt: at, pullRequest }),
    reject: (floorId, id, at) =>
      settle(floorId, id, {
        status: "rejected",
        decidedAt: at,
        pullRequest: null,
      }),
  };
}

const statusOf = (value: string): GuidelineProposalStatus => {
  const status = guidelineProposalStatuses.find((each) => each === value);
  if (status === undefined) {
    throw new Error(`Unknown Guideline proposal status "${value}".`);
  }
  return status;
};

type Row = typeof guidelineProposals.$inferSelect;

const recordOf = (row: Row): GuidelineProposalRecord => ({
  id: row.id,
  floorId: row.floorId,
  name: row.name,
  contentHash: row.contentHash,
  content: row.content,
  agentId: row.agentId,
  issue: row.issue,
  status: statusOf(row.status),
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
  pullRequest:
    row.pullRequest === null || row.url === null
      ? null
      : { number: row.pullRequest, url: row.url },
});

/** Keeps them in `guideline_proposals`. */
export function databaseGuidelineProposalStore(
  db: Database,
): GuidelineProposalStore {
  const waitingRow = (floorId: string, id: number) =>
    and(
      eq(guidelineProposals.floorId, floorId),
      eq(guidelineProposals.id, id),
      eq(guidelineProposals.status, "proposed"),
    );
  return {
    async propose(proposal) {
      const [row] = await db
        .insert(guidelineProposals)
        .values({ ...proposal, status: "proposed" })
        .onConflictDoNothing()
        .returning();
      return row === undefined ? undefined : recordOf(row);
    },
    async waiting(floorId) {
      const rows = await db
        .select()
        .from(guidelineProposals)
        .where(
          and(
            eq(guidelineProposals.floorId, floorId),
            eq(guidelineProposals.status, "proposed"),
          ),
        )
        .orderBy(asc(guidelineProposals.id));
      return rows.map(recordOf);
    },
    async get(floorId, id) {
      const [row] = await db
        .select()
        .from(guidelineProposals)
        .where(
          and(
            eq(guidelineProposals.floorId, floorId),
            eq(guidelineProposals.id, id),
          ),
        );
      return row === undefined ? undefined : recordOf(row);
    },
    async open(floorId, id, pullRequest, at) {
      const opened = await db
        .update(guidelineProposals)
        .set({
          status: "opened",
          decidedAt: at,
          pullRequest: pullRequest.number,
          url: pullRequest.url,
        })
        .where(waitingRow(floorId, id))
        .returning({ id: guidelineProposals.id });
      return opened.length > 0;
    },
    async reject(floorId, id, at) {
      const rejected = await db
        .update(guidelineProposals)
        .set({ status: "rejected", decidedAt: at })
        .where(waitingRow(floorId, id))
        .returning({ id: guidelineProposals.id });
      return rejected.length > 0;
    },
  };
}
