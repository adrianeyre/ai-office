import {
  batchAcknowledgements,
  batches,
  batchIssues,
  plans,
  type Database,
} from "@ai-office/db";
import {
  acknowledgers,
  batchStatuses,
  kickoffResponses,
  planDrafters,
  planSchema,
  wrapUpSchema,
  type Acknowledger,
  type BatchStatus,
  type KickoffResponse,
  type PlanDrafter,
  type PlanItem,
  type PlanLeftOut,
  type PlanOverlap,
  type WrapUp,
} from "@ai-office/shared";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  max,
  sql,
} from "drizzle-orm";

// Where Batches and their Plans are kept (PRD FR-25): the `batches`,
// `plans`, `batch_issues` and `batch_acknowledgements` tables, or memory
// for tests. A Plan is versioned: each version is kept beside the earlier
// ones, and the latest is the Batch's Plan. A finished Batch keeps its
// Wrap-up's results, and each assigned Agent's Kickoff acknowledgement is
// kept once. A Batch whose issues go in one pull request keeps where its
// branch stood as each issue started (ADR 0010).

export interface NewBatch {
  readonly floorId: string;
  /** The issues the Owner named, in the order named. */
  readonly issues: readonly number[];
  readonly status: BatchStatus;
  /** The Floor's Manager, whose Batch it is. */
  readonly agentId: string;
  readonly createdAt: Date;
  /**
   * The Owner's chat message the Manager filed it for (FR-24, ADR 0004);
   * null (or absent) for one handed over by command.
   */
  readonly chatMessageId?: number | null;
  /**
   * Its issues are worked one after another on one branch, and go in one
   * pull request (ADR 0010); false (or absent) for one each.
   */
  readonly onePullRequest?: boolean;
}

export interface BatchRecord extends NewBatch {
  readonly id: number;
  readonly chatMessageId: number | null;
  readonly onePullRequest: boolean;
  /** When its work started; null while it awaits approval. */
  readonly startedAt: Date | null;
  /** When it finished; null until then. */
  readonly finishedAt: Date | null;
  /** Its Wrap-up's results; null until it finishes. */
  readonly wrapUp: WrapUp | null;
}

/** An assigned Agent's acknowledgement of the Plan at the Kickoff. */
export interface AcknowledgementRecord {
  readonly agentId: string;
  readonly planVersion: number;
  readonly response: KickoffResponse;
  /** The concern, for `concern`; null for "OK". */
  readonly concern: string | null;
  readonly by: Acknowledger;
  readonly createdAt: Date;
}

/** What a Plan holds, as `@ai-office/shared`'s `planSchema` has it. */
export interface PlanContent {
  readonly draftedBy: PlanDrafter;
  readonly summary: string;
  /** The Batch's issues, in the order to work them. */
  readonly items: readonly PlanItem[];
  readonly overlaps: readonly PlanOverlap[];
  /** Which issues run at once: groups in the order they run. */
  readonly parallel: readonly (readonly number[])[];
  readonly leftOut: readonly PlanLeftOut[];
  /** The version the Owner edited, which this one replans; none (or null) otherwise. */
  readonly editedFrom?: number | null;
}

export interface PlanRecord extends PlanContent {
  readonly editedFrom: number | null;
  readonly batchId: number;
  readonly version: number;
  /** The Floor's Manager, whose Plan it is. */
  readonly agentId: string;
  readonly createdAt: Date;
}

/** An issue of a Batch whose work has started. */
export interface StartedIssue {
  readonly issue: number;
  readonly startedAt: Date;
  /**
   * In a one-pull-request Batch, the commit its branch was at as the issue
   * started: the issue's work is what came after. Null otherwise, and for
   * the issue that started the branch.
   */
  readonly base: string | null;
}

export interface BatchStore {
  /** Keeps a new Batch with its first Plan (version 1), together. */
  create(
    batch: NewBatch,
    plan: PlanContent,
  ): Promise<{ readonly batch: BatchRecord; readonly plan: PlanRecord }>;
  get(id: number): Promise<BatchRecord | undefined>;
  /** A Floor's Batches, newest first. */
  list(floorId: string, limit: number): Promise<BatchRecord[]>;
  /** The Batches awaiting approval or in progress, oldest first: a Floor's, or every Floor's. */
  open(floorId?: string): Promise<BatchRecord[]>;
  /** Keeps the next version of a Batch's Plan. */
  addPlan(
    batchId: number,
    plan: PlanContent,
    agentId: string,
    at: Date,
  ): Promise<PlanRecord>;
  /** A Batch's Plans, oldest version first. */
  plans(batchId: number): Promise<PlanRecord[]>;
  latestPlan(batchId: number): Promise<PlanRecord | undefined>;
  /** Marks the Batch's work started, unless it has already started: false then. */
  markInProgress(id: number, at: Date): Promise<boolean>;
  /**
   * Records that work on one of its issues started, unless it had: false
   * then. `base` is where a one-pull-request Batch's branch stood.
   */
  markStarted(
    batchId: number,
    issue: number,
    at: Date,
    base?: string | null,
  ): Promise<boolean>;
  /** The issues of a Batch whose work has started: oldest first, then by number. */
  started(batchId: number): Promise<StartedIssue[]>;
  /** Marks a Batch in progress finished, with its Wrap-up; false if it was not in progress. */
  markFinished(id: number, at: Date, wrapUp: WrapUp): Promise<boolean>;
  /** The Batches that finished at or after `since`, oldest first. */
  finishedSince(since: Date): Promise<BatchRecord[]>;
  /**
   * Whether the issue is in a Batch a chat request started on the Floor
   * (P2-3): its pull request then always goes to the Owner.
   */
  chatIssue(floorId: string, issue: number): Promise<boolean>;
  /** Keeps an Agent's Kickoff acknowledgement, unless it has one: false then. */
  acknowledge(
    batchId: number,
    acknowledgement: AcknowledgementRecord,
  ): Promise<boolean>;
  /** A Batch's Kickoff acknowledgements, oldest first. */
  acknowledgements(batchId: number): Promise<AcknowledgementRecord[]>;
}

const copyPlan = (plan: PlanRecord): PlanRecord => structuredClone(plan);

/** Keeps Batches in memory: for tests. */
export function memoryBatchStore(): BatchStore & {
  readonly batches: Map<number, BatchRecord>;
} {
  const records = new Map<number, BatchRecord>();
  const versions = new Map<number, PlanRecord[]>();
  const startedIssues = new Map<number, StartedIssue[]>();
  const acknowledged = new Map<number, AcknowledgementRecord[]>();
  let nextId = 1;

  const planOf = (
    batchId: number,
    plan: PlanContent,
    agentId: string,
    version: number,
    at: Date,
  ): PlanRecord =>
    structuredClone({
      ...plan,
      editedFrom: plan.editedFrom ?? null,
      batchId,
      version,
      agentId,
      createdAt: at,
    });

  return {
    batches: records,

    create(batch, plan) {
      const record: BatchRecord = {
        ...batch,
        chatMessageId: batch.chatMessageId ?? null,
        onePullRequest: batch.onePullRequest ?? false,
        issues: [...batch.issues],
        id: nextId,
        startedAt: batch.status === "in_progress" ? batch.createdAt : null,
        finishedAt: null,
        wrapUp: null,
      };
      nextId += 1;
      records.set(record.id, record);
      const first = planOf(record.id, plan, batch.agentId, 1, batch.createdAt);
      versions.set(record.id, [first]);
      return Promise.resolve({ batch: { ...record }, plan: copyPlan(first) });
    },

    chatIssue(floorId, issue) {
      return Promise.resolve(
        [...records.values()].some(
          (record) =>
            record.floorId === floorId &&
            record.chatMessageId !== null &&
            record.issues.includes(issue),
        ),
      );
    },

    get(id) {
      const record = records.get(id);
      return Promise.resolve(
        record === undefined ? undefined : structuredClone(record),
      );
    },

    list(floorId, limit) {
      return Promise.resolve(
        [...records.values()]
          .filter((record) => record.floorId === floorId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map((record) => structuredClone(record)),
      );
    },

    open(floorId) {
      return Promise.resolve(
        [...records.values()]
          .filter(
            (record) =>
              record.status !== "finished" &&
              (floorId === undefined || record.floorId === floorId),
          )
          .sort((a, b) => a.id - b.id)
          .map((record) => structuredClone(record)),
      );
    },

    addPlan(batchId, plan, agentId, at) {
      const kept = versions.get(batchId);
      if (kept === undefined) {
        return Promise.reject(
          new Error(`There is no Batch ${String(batchId)}.`),
        );
      }
      const next = planOf(batchId, plan, agentId, kept.length + 1, at);
      kept.push(next);
      return Promise.resolve(copyPlan(next));
    },

    plans: (batchId) =>
      Promise.resolve((versions.get(batchId) ?? []).map(copyPlan)),

    latestPlan(batchId) {
      const latest = versions.get(batchId)?.at(-1);
      return Promise.resolve(
        latest === undefined ? undefined : copyPlan(latest),
      );
    },

    markInProgress(id, at) {
      const record = records.get(id);
      if (record === undefined || record.status === "in_progress") {
        return Promise.resolve(false);
      }
      records.set(id, { ...record, status: "in_progress", startedAt: at });
      return Promise.resolve(true);
    },

    markFinished(id, at, wrapUp) {
      const record = records.get(id);
      if (record?.status !== "in_progress") {
        return Promise.resolve(false);
      }
      records.set(id, {
        ...record,
        status: "finished",
        finishedAt: at,
        wrapUp: structuredClone(wrapUp),
      });
      return Promise.resolve(true);
    },

    finishedSince(since) {
      return Promise.resolve(
        [...records.values()]
          .filter(
            ({ finishedAt }) =>
              finishedAt !== null && finishedAt.getTime() >= since.getTime(),
          )
          .sort((a, b) => a.id - b.id)
          .map((record) => structuredClone(record)),
      );
    },

    acknowledge(batchId, acknowledgement) {
      const list = acknowledged.get(batchId) ?? [];
      if (list.some(({ agentId }) => agentId === acknowledgement.agentId)) {
        return Promise.resolve(false);
      }
      acknowledged.set(batchId, [...list, { ...acknowledgement }]);
      return Promise.resolve(true);
    },

    acknowledgements: (batchId) =>
      Promise.resolve(
        (acknowledged.get(batchId) ?? [])
          .map((each) => ({ ...each }))
          // As Postgres orders them: oldest first, then by Agent id.
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
          ),
      ),

    markStarted(batchId, issue, at, base = null) {
      const issues = startedIssues.get(batchId) ?? [];
      if (issues.some((started) => started.issue === issue)) {
        return Promise.resolve(false);
      }
      startedIssues.set(batchId, [...issues, { issue, startedAt: at, base }]);
      return Promise.resolve(true);
    },

    started: (batchId) =>
      Promise.resolve(
        (startedIssues.get(batchId) ?? [])
          .map((started) => ({ ...started }))
          .sort(
            (a, b) =>
              a.startedAt.getTime() - b.startedAt.getTime() ||
              a.issue - b.issue,
          ),
      ),
  };
}

type BatchRow = typeof batches.$inferSelect;
type PlanRow = typeof plans.$inferSelect;

const statusOf = (status: string): BatchStatus => {
  const known = batchStatuses.find((candidate) => candidate === status);
  if (known === undefined) {
    throw new Error(`A Batch has an unknown status, ${status}.`);
  }
  return known;
};

const drafterOf = (drafter: string): PlanDrafter => {
  const known = planDrafters.find((candidate) => candidate === drafter);
  if (known === undefined) {
    throw new Error(`A Plan has an unknown drafter, ${drafter}.`);
  }
  return known;
};

const batchOf = (row: BatchRow): BatchRecord => ({
  id: row.id,
  floorId: row.floorId,
  issues: row.issues,
  status: statusOf(row.status),
  agentId: row.agentId,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  wrapUp: row.wrapUp === null ? null : wrapUpSchema.parse(row.wrapUp),
  chatMessageId: row.chatMessageId,
  onePullRequest: row.onePullRequest,
});

type AcknowledgementRow = typeof batchAcknowledgements.$inferSelect;

const acknowledgementOf = (row: AcknowledgementRow): AcknowledgementRecord => {
  const response = kickoffResponses.find((each) => each === row.response);
  const by = acknowledgers.find((each) => each === row.acknowledgedBy);
  if (response === undefined || by === undefined) {
    throw new Error(
      `An acknowledgement is unknown: ${row.response} by ${row.acknowledgedBy}.`,
    );
  }
  return {
    agentId: row.agentId,
    planVersion: row.planVersion,
    response,
    concern: row.concern,
    by,
    createdAt: row.createdAt,
  };
};

const {
  items: itemsSchema,
  overlaps: overlapsSchema,
  parallel: parallelSchema,
  leftOut: leftOutSchema,
} = planSchema.shape;

const planOf = (row: PlanRow): PlanRecord => ({
  batchId: row.batchId,
  version: row.version,
  draftedBy: drafterOf(row.draftedBy),
  agentId: row.agentId,
  summary: row.summary,
  items: itemsSchema.parse(row.items),
  overlaps: overlapsSchema.parse(row.overlaps),
  parallel: parallelSchema.parse(row.parallel),
  leftOut: leftOutSchema.parse(row.leftOut),
  editedFrom: row.editedFrom,
  createdAt: row.createdAt,
});

const planValues = (
  batchId: number,
  version: number,
  plan: PlanContent,
  agentId: string,
  at: Date,
) => ({
  batchId,
  version,
  draftedBy: plan.draftedBy,
  agentId,
  summary: plan.summary,
  items: plan.items,
  overlaps: plan.overlaps,
  parallel: plan.parallel,
  leftOut: plan.leftOut,
  editedFrom: plan.editedFrom ?? null,
  createdAt: at,
});

/** Keeps Batches in the `batches`, `plans` and `batch_issues` tables. */
export function databaseBatchStore(db: Database): BatchStore {
  return {
    create: (batch, plan) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(batches)
          .values({
            floorId: batch.floorId,
            issues: [...batch.issues],
            status: batch.status,
            agentId: batch.agentId,
            createdAt: batch.createdAt,
            startedAt: batch.status === "in_progress" ? batch.createdAt : null,
            chatMessageId: batch.chatMessageId ?? null,
            onePullRequest: batch.onePullRequest ?? false,
          })
          .returning();
        if (row === undefined) {
          throw new Error("The Batch was not stored.");
        }
        const [planRow] = await tx
          .insert(plans)
          .values(planValues(row.id, 1, plan, batch.agentId, batch.createdAt))
          .returning();
        if (planRow === undefined) {
          throw new Error("The Batch's Plan was not stored.");
        }
        return { batch: batchOf(row), plan: planOf(planRow) };
      }),

    async chatIssue(floorId, issue) {
      const [row] = await db
        .select({ id: batches.id })
        .from(batches)
        .where(
          and(
            eq(batches.floorId, floorId),
            isNotNull(batches.chatMessageId),
            sql`${issue} = ANY(${batches.issues})`,
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async get(id) {
      const [row] = await db.select().from(batches).where(eq(batches.id, id));
      return row === undefined ? undefined : batchOf(row);
    },

    async list(floorId, limit) {
      const rows = await db
        .select()
        .from(batches)
        .where(eq(batches.floorId, floorId))
        .orderBy(desc(batches.id))
        .limit(limit);
      return rows.map(batchOf);
    },

    async open(floorId) {
      const rows = await db
        .select()
        .from(batches)
        .where(
          and(
            inArray(batches.status, ["awaiting_approval", "in_progress"]),
            floorId === undefined ? undefined : eq(batches.floorId, floorId),
          ),
        )
        .orderBy(asc(batches.id));
      return rows.map(batchOf);
    },

    addPlan: (batchId, plan, agentId, at) =>
      db.transaction(async (tx) => {
        // One version at a time per Batch: its row is locked meanwhile.
        await tx.execute(
          sql`SELECT 1 FROM ${batches} WHERE ${batches.id} = ${batchId} FOR UPDATE`,
        );
        const [latest] = await tx
          .select({ version: max(plans.version) })
          .from(plans)
          .where(eq(plans.batchId, batchId));
        const [row] = await tx
          .insert(plans)
          .values(
            planValues(batchId, (latest?.version ?? 0) + 1, plan, agentId, at),
          )
          .returning();
        if (row === undefined) {
          throw new Error("The Plan was not stored.");
        }
        return planOf(row);
      }),

    async plans(batchId) {
      const rows = await db
        .select()
        .from(plans)
        .where(eq(plans.batchId, batchId))
        .orderBy(asc(plans.version));
      return rows.map(planOf);
    },

    async latestPlan(batchId) {
      const [row] = await db
        .select()
        .from(plans)
        .where(eq(plans.batchId, batchId))
        .orderBy(desc(plans.version))
        .limit(1);
      return row === undefined ? undefined : planOf(row);
    },

    async markInProgress(id, at) {
      const rows = await db
        .update(batches)
        .set({ status: "in_progress", startedAt: at })
        .where(and(eq(batches.id, id), eq(batches.status, "awaiting_approval")))
        .returning({ id: batches.id });
      return rows.length > 0;
    },

    async markStarted(batchId, issue, at, base = null) {
      const rows = await db
        .insert(batchIssues)
        .values({ batchId, issue, startedAt: at, baseSha: base })
        .onConflictDoNothing()
        .returning({ issue: batchIssues.issue });
      return rows.length > 0;
    },

    async started(batchId) {
      const rows = await db
        .select({
          issue: batchIssues.issue,
          startedAt: batchIssues.startedAt,
          base: batchIssues.baseSha,
        })
        .from(batchIssues)
        .where(eq(batchIssues.batchId, batchId))
        .orderBy(asc(batchIssues.startedAt), asc(batchIssues.issue));
      return rows;
    },

    async markFinished(id, at, wrapUp) {
      const rows = await db
        .update(batches)
        .set({ status: "finished", finishedAt: at, wrapUp })
        .where(and(eq(batches.id, id), eq(batches.status, "in_progress")))
        .returning({ id: batches.id });
      return rows.length > 0;
    },

    async finishedSince(since) {
      const rows = await db
        .select()
        .from(batches)
        .where(gte(batches.finishedAt, since))
        .orderBy(asc(batches.id));
      return rows.map(batchOf);
    },

    async acknowledge(batchId, acknowledgement) {
      const rows = await db
        .insert(batchAcknowledgements)
        .values({
          batchId,
          agentId: acknowledgement.agentId,
          planVersion: acknowledgement.planVersion,
          response: acknowledgement.response,
          concern: acknowledgement.concern,
          acknowledgedBy: acknowledgement.by,
          createdAt: acknowledgement.createdAt,
        })
        .onConflictDoNothing()
        .returning({ agentId: batchAcknowledgements.agentId });
      return rows.length > 0;
    },

    async acknowledgements(batchId) {
      const rows = await db
        .select()
        .from(batchAcknowledgements)
        .where(eq(batchAcknowledgements.batchId, batchId))
        .orderBy(
          asc(batchAcknowledgements.createdAt),
          asc(batchAcknowledgements.agentId),
        );
      return rows.map(acknowledgementOf);
    },
  };
}
