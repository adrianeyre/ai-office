import { memoryCurations, memoryProposals, type Database } from "@ai-office/db";
import {
  memoryCurationReasons,
  memoryCurators,
  type MemoryCurationReason,
  type MemoryCurator,
} from "@ai-office/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

// Where repository memory's proposals and curations are kept (PRD FR-53):
// the `memory_proposals` and `memory_curations` tables, or memory for
// tests. The memory itself lives in each Floor's repository. A proposal
// waits until a curation takes it; each Batch is curated once.

export interface NewProposal {
  readonly floorId: string;
  /** The issue whose Handoff proposed it. */
  readonly issue: number;
  /** The Agent that proposed it. */
  readonly agentId: string;
  /** One line, redacted. */
  readonly text: string;
  readonly createdAt: Date;
}

export interface ProposalRecord extends NewProposal {
  readonly id: number;
  /** The curation that took it; null while it waits. */
  readonly curationId: number | null;
}

export interface NewCuration {
  readonly floorId: string;
  readonly reason: MemoryCurationReason;
  /** The Batch that ended, for `batch`; null otherwise. */
  readonly batchId: number | null;
  readonly curatedBy: MemoryCurator;
  /** The Floor's Manager. */
  readonly agentId: string;
  readonly summary: string;
  /** How many entries the memory keeps. */
  readonly entries: number;
  /** The pull request opened or updated; null when nothing changed. */
  readonly pullRequest: number | null;
  readonly createdAt: Date;
}

export interface CurationRecord extends NewCuration {
  readonly id: number;
}

export interface MemoryStore {
  /** Keeps new proposals, waiting for a curation. */
  propose(proposals: readonly NewProposal[]): Promise<ProposalRecord[]>;
  /** A Floor's proposals waiting for a curation, oldest first. */
  pending(floorId: string): Promise<ProposalRecord[]>;
  /** Every proposal a curation took, oldest first. */
  taken(curationId: number): Promise<ProposalRecord[]>;
  /** The Floors with proposals waiting. */
  floorsWithPending(): Promise<string[]>;
  /**
   * Keeps a curation, and marks the proposals it took (those still
   * waiting); undefined, keeping nothing, when its Batch was curated
   * already.
   */
  recordCuration(
    curation: NewCuration,
    proposalIds: readonly number[],
  ): Promise<CurationRecord | undefined>;
  /** A Floor's latest curation. */
  latestCuration(floorId: string): Promise<CurationRecord | undefined>;
  /** Those of the Batches that were curated. */
  curatedBatches(batchIds: readonly number[]): Promise<Set<number>>;
}

/** Keeps proposals and curations in memory: for tests. */
export function memoryMemoryStore(): MemoryStore & {
  readonly proposals: ProposalRecord[];
  readonly curations: CurationRecord[];
} {
  const proposals: ProposalRecord[] = [];
  const curations: CurationRecord[] = [];
  return {
    proposals,
    curations,
    propose(news) {
      const kept = news.map((proposal, index) => ({
        ...proposal,
        id: proposals.length + index + 1,
        curationId: null,
      }));
      proposals.push(...kept);
      return Promise.resolve(kept.map((record) => ({ ...record })));
    },
    pending: (floorId) =>
      Promise.resolve(
        proposals
          .filter(
            (proposal) =>
              proposal.floorId === floorId && proposal.curationId === null,
          )
          .map((proposal) => ({ ...proposal })),
      ),
    taken: (curationId) =>
      Promise.resolve(
        proposals
          .filter((proposal) => proposal.curationId === curationId)
          .map((proposal) => ({ ...proposal })),
      ),
    floorsWithPending: () =>
      Promise.resolve([
        ...new Set(
          proposals
            .filter(({ curationId }) => curationId === null)
            .map(({ floorId }) => floorId),
        ),
      ]),
    recordCuration(curation, proposalIds) {
      if (
        curation.batchId !== null &&
        curations.some(({ batchId }) => batchId === curation.batchId)
      ) {
        return Promise.resolve(undefined);
      }
      const record: CurationRecord = { ...curation, id: curations.length + 1 };
      curations.push(record);
      proposals.forEach((proposal, index) => {
        if (proposal.curationId === null && proposalIds.includes(proposal.id)) {
          proposals[index] = { ...proposal, curationId: record.id };
        }
      });
      return Promise.resolve({ ...record });
    },
    latestCuration: (floorId) => {
      const latest = curations
        .filter((curation) => curation.floorId === floorId)
        .at(-1);
      return Promise.resolve(latest === undefined ? undefined : { ...latest });
    },
    curatedBatches: (batchIds) =>
      Promise.resolve(
        new Set(
          curations
            .map(({ batchId }) => batchId)
            .filter(
              (batchId): batchId is number =>
                batchId !== null && batchIds.includes(batchId),
            ),
        ),
      ),
  };
}

type ProposalRow = typeof memoryProposals.$inferSelect;
type CurationRow = typeof memoryCurations.$inferSelect;

const reasonOf = (reason: string): MemoryCurationReason => {
  const known = memoryCurationReasons.find((candidate) => candidate === reason);
  if (known === undefined) {
    throw new Error(`A memory curation has an unknown reason, ${reason}.`);
  }
  return known;
};

const curatorOf = (curator: string): MemoryCurator => {
  const known = memoryCurators.find((candidate) => candidate === curator);
  if (known === undefined) {
    throw new Error(`A memory curation has an unknown curator, ${curator}.`);
  }
  return known;
};

const proposalOf = (row: ProposalRow): ProposalRecord => ({
  id: row.id,
  floorId: row.floorId,
  issue: row.issue,
  agentId: row.agentId,
  text: row.text,
  createdAt: row.createdAt,
  curationId: row.curationId,
});

const curationOf = (row: CurationRow): CurationRecord => ({
  id: row.id,
  floorId: row.floorId,
  reason: reasonOf(row.reason),
  batchId: row.batchId,
  curatedBy: curatorOf(row.curatedBy),
  agentId: row.agentId,
  summary: row.summary,
  entries: row.entries,
  pullRequest: row.pullRequest,
  createdAt: row.createdAt,
});

/** Keeps proposals and curations in `memory_proposals` and `memory_curations`. */
export function databaseMemoryStore(db: Database): MemoryStore {
  return {
    async propose(news) {
      if (news.length === 0) {
        return [];
      }
      const rows = await db
        .insert(memoryProposals)
        .values(news.map((proposal) => ({ ...proposal })))
        .returning();
      return rows.map(proposalOf).sort((a, b) => a.id - b.id);
    },

    async pending(floorId) {
      const rows = await db
        .select()
        .from(memoryProposals)
        .where(
          and(
            eq(memoryProposals.floorId, floorId),
            isNull(memoryProposals.curationId),
          ),
        )
        .orderBy(asc(memoryProposals.id));
      return rows.map(proposalOf);
    },

    async taken(curationId) {
      const rows = await db
        .select()
        .from(memoryProposals)
        .where(eq(memoryProposals.curationId, curationId))
        .orderBy(asc(memoryProposals.id));
      return rows.map(proposalOf);
    },

    async floorsWithPending() {
      const rows = await db
        .selectDistinct({ floorId: memoryProposals.floorId })
        .from(memoryProposals)
        .where(isNull(memoryProposals.curationId))
        .orderBy(asc(memoryProposals.floorId));
      return rows.map(({ floorId }) => floorId);
    },

    recordCuration: (curation, proposalIds) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(memoryCurations)
          .values({ ...curation })
          .onConflictDoNothing({ target: memoryCurations.batchId })
          .returning();
        if (row === undefined) {
          return undefined;
        }
        if (proposalIds.length > 0) {
          await tx
            .update(memoryProposals)
            .set({ curationId: row.id })
            .where(
              and(
                inArray(memoryProposals.id, [...proposalIds]),
                isNull(memoryProposals.curationId),
              ),
            );
        }
        return curationOf(row);
      }),

    async latestCuration(floorId) {
      const [row] = await db
        .select()
        .from(memoryCurations)
        .where(eq(memoryCurations.floorId, floorId))
        .orderBy(desc(memoryCurations.id))
        .limit(1);
      return row === undefined ? undefined : curationOf(row);
    },

    async curatedBatches(batchIds) {
      if (batchIds.length === 0) {
        return new Set();
      }
      const rows = await db
        .select({ batchId: memoryCurations.batchId })
        .from(memoryCurations)
        .where(
          and(
            isNotNull(memoryCurations.batchId),
            inArray(memoryCurations.batchId, [...batchIds]),
          ),
        );
      return new Set(
        rows
          .map(({ batchId }) => batchId)
          .filter((batchId): batchId is number => batchId !== null),
      );
    },
  };
}
