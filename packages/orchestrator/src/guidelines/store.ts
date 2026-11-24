import {
  approvedGuidelines,
  guidelineChanges,
  type Database,
} from "@ai-office/db";
import { guidelineApprovals, type GuidelineApproval } from "@ai-office/shared";
import { and, asc, eq } from "drizzle-orm";

// Where the versions of a Floor's Guidelines the Owner approved live, and
// those that wait for the Owner's approval or that the Owner dismissed
// (Guidelines, Specs and Hooks PRD, FR-103; ADR 0014): the
// `approved_guidelines` and `guideline_changes` tables, or memory for
// tests. Each version is known by the SHA-256 of its whole file.

/** A version of a Guideline the Owner approved, and how. */
export interface GuidelineApprovalRecord {
  /** The Guideline's name: its file name without `.md`. */
  readonly name: string;
  readonly contentHash: string;
  readonly approval: GuidelineApproval;
  readonly approvedAt: Date;
}

/** What a version of a Guideline that reached its default branch waits for. */
export const guidelineChangeStatuses = ["awaiting", "dismissed"] as const;
export type GuidelineChangeStatus = (typeof guidelineChangeStatuses)[number];

/** A version of a Guideline the Owner has not approved. */
export interface GuidelineChangeRecord {
  readonly name: string;
  readonly contentHash: string;
  /** The last commit that changed the file to it, as last checked. */
  readonly commitSha: string | null;
  readonly status: GuidelineChangeStatus;
  readonly seenAt: Date;
  readonly dismissedAt: Date | null;
}

/** A version of a Guideline, by name, hash and its whole file. */
export interface GuidelineVersion {
  readonly name: string;
  readonly contentHash: string;
  readonly content: string;
}

export interface GuidelineStore {
  /** Every version of the Floor's Guidelines the Owner approved, oldest first. */
  approvals(floorId: string): Promise<GuidelineApprovalRecord[]>;
  /** An approved version's whole file; undefined when it is not approved. */
  approvedContent(
    floorId: string,
    name: string,
    contentHash: string,
  ): Promise<string | undefined>;
  /**
   * Keeps a version as approved, and how; false when it was approved
   * already, which it stays as it was.
   */
  approve(
    floorId: string,
    version: GuidelineVersion & { readonly approval: GuidelineApproval },
    at: Date,
  ): Promise<boolean>;
  /** Every version of the Floor's Guidelines not approved when it was seen. */
  changes(floorId: string): Promise<GuidelineChangeRecord[]>;
  /** A version's whole file, as it was seen; undefined when it was not. */
  changeContent(
    floorId: string,
    name: string,
    contentHash: string,
  ): Promise<string | undefined>;
  /**
   * Keeps a version as awaiting approval, changed last by `commitSha`;
   * false when it was known already, when only its commit is updated and
   * it keeps its status.
   */
  recordChange(
    floorId: string,
    change: GuidelineVersion & { readonly commitSha: string | null },
    at: Date,
  ): Promise<boolean>;
  /** Marks an awaiting version dismissed; false unless it was awaiting. */
  dismiss(
    floorId: string,
    name: string,
    contentHash: string,
    at: Date,
  ): Promise<boolean>;
}

const key = (floorId: string, name: string, contentHash: string): string =>
  JSON.stringify([floorId, name, contentHash]);

/** Keeps them in memory: for tests. */
export function memoryGuidelineStore(): GuidelineStore {
  const approved = new Map<
    string,
    GuidelineApprovalRecord & { readonly floorId: string; content: string }
  >();
  const changes = new Map<
    string,
    {
      floorId: string;
      name: string;
      contentHash: string;
      content: string;
      commitSha: string | null;
      status: GuidelineChangeStatus;
      seenAt: Date;
      dismissedAt: Date | null;
    }
  >();
  return {
    approvals(floorId) {
      return Promise.resolve(
        [...approved.values()]
          .filter((record) => record.floorId === floorId)
          .map(({ name, contentHash, approval, approvedAt }) => ({
            name,
            contentHash,
            approval,
            approvedAt,
          })),
      );
    },
    approvedContent(floorId, name, contentHash) {
      return Promise.resolve(
        approved.get(key(floorId, name, contentHash))?.content,
      );
    },
    approve(floorId, version, at) {
      const id = key(floorId, version.name, version.contentHash);
      if (approved.has(id)) {
        return Promise.resolve(false);
      }
      approved.set(id, {
        floorId,
        name: version.name,
        contentHash: version.contentHash,
        content: version.content,
        approval: version.approval,
        approvedAt: at,
      });
      return Promise.resolve(true);
    },
    changes(floorId) {
      return Promise.resolve(
        [...changes.values()]
          .filter((record) => record.floorId === floorId)
          .map(
            ({
              name,
              contentHash,
              commitSha,
              status,
              seenAt,
              dismissedAt,
            }) => ({
              name,
              contentHash,
              commitSha,
              status,
              seenAt,
              dismissedAt,
            }),
          ),
      );
    },
    changeContent(floorId, name, contentHash) {
      return Promise.resolve(
        changes.get(key(floorId, name, contentHash))?.content,
      );
    },
    recordChange(floorId, change, at) {
      const id = key(floorId, change.name, change.contentHash);
      const known = changes.get(id);
      if (known !== undefined) {
        known.commitSha = change.commitSha;
        return Promise.resolve(false);
      }
      changes.set(id, {
        floorId,
        name: change.name,
        contentHash: change.contentHash,
        content: change.content,
        commitSha: change.commitSha,
        status: "awaiting",
        seenAt: at,
        dismissedAt: null,
      });
      return Promise.resolve(true);
    },
    dismiss(floorId, name, contentHash, at) {
      const known = changes.get(key(floorId, name, contentHash));
      if (known?.status !== "awaiting") {
        return Promise.resolve(false);
      }
      known.status = "dismissed";
      known.dismissedAt = at;
      return Promise.resolve(true);
    },
  };
}

const approvalOf = (value: string): GuidelineApproval => {
  const approval = guidelineApprovals.find((each) => each === value);
  if (approval === undefined) {
    throw new Error(`Unknown Guideline approval "${value}".`);
  }
  return approval;
};

const statusOf = (value: string): GuidelineChangeStatus =>
  value === "dismissed" ? "dismissed" : "awaiting";

/** Keeps them in `approved_guidelines` and `guideline_changes`. */
export function databaseGuidelineStore(db: Database): GuidelineStore {
  const approvedRow = (floorId: string, name: string, contentHash: string) =>
    and(
      eq(approvedGuidelines.floorId, floorId),
      eq(approvedGuidelines.name, name),
      eq(approvedGuidelines.contentHash, contentHash),
    );
  const changeRow = (floorId: string, name: string, contentHash: string) =>
    and(
      eq(guidelineChanges.floorId, floorId),
      eq(guidelineChanges.name, name),
      eq(guidelineChanges.contentHash, contentHash),
    );
  return {
    async approvals(floorId) {
      const rows = await db
        .select({
          name: approvedGuidelines.name,
          contentHash: approvedGuidelines.contentHash,
          approval: approvedGuidelines.approval,
          approvedAt: approvedGuidelines.approvedAt,
        })
        .from(approvedGuidelines)
        .where(eq(approvedGuidelines.floorId, floorId))
        .orderBy(asc(approvedGuidelines.approvedAt));
      return rows.map((row) => ({
        ...row,
        approval: approvalOf(row.approval),
      }));
    },
    async approvedContent(floorId, name, contentHash) {
      const [row] = await db
        .select({ content: approvedGuidelines.content })
        .from(approvedGuidelines)
        .where(approvedRow(floorId, name, contentHash));
      return row?.content;
    },
    async approve(floorId, version, at) {
      const inserted = await db
        .insert(approvedGuidelines)
        .values({
          floorId,
          name: version.name,
          contentHash: version.contentHash,
          content: version.content,
          approval: version.approval,
          approvedAt: at,
        })
        .onConflictDoNothing()
        .returning({ name: approvedGuidelines.name });
      return inserted.length > 0;
    },
    async changes(floorId) {
      const rows = await db
        .select({
          name: guidelineChanges.name,
          contentHash: guidelineChanges.contentHash,
          commitSha: guidelineChanges.commitSha,
          status: guidelineChanges.status,
          seenAt: guidelineChanges.seenAt,
          dismissedAt: guidelineChanges.dismissedAt,
        })
        .from(guidelineChanges)
        .where(eq(guidelineChanges.floorId, floorId))
        .orderBy(asc(guidelineChanges.seenAt));
      return rows.map((row) => ({ ...row, status: statusOf(row.status) }));
    },
    async changeContent(floorId, name, contentHash) {
      const [row] = await db
        .select({ content: guidelineChanges.content })
        .from(guidelineChanges)
        .where(changeRow(floorId, name, contentHash));
      return row?.content;
    },
    async recordChange(floorId, change, at) {
      const inserted = await db
        .insert(guidelineChanges)
        .values({
          floorId,
          name: change.name,
          contentHash: change.contentHash,
          content: change.content,
          commitSha: change.commitSha,
          status: "awaiting",
          seenAt: at,
        })
        .onConflictDoNothing()
        .returning({ name: guidelineChanges.name });
      if (inserted.length > 0) {
        return true;
      }
      await db
        .update(guidelineChanges)
        .set({ commitSha: change.commitSha })
        .where(changeRow(floorId, change.name, change.contentHash));
      return false;
    },
    async dismiss(floorId, name, contentHash, at) {
      const dismissed = await db
        .update(guidelineChanges)
        .set({ status: "dismissed", dismissedAt: at })
        .where(
          and(
            changeRow(floorId, name, contentHash),
            eq(guidelineChanges.status, "awaiting"),
          ),
        )
        .returning({ name: guidelineChanges.name });
      return dismissed.length > 0;
    },
  };
}
