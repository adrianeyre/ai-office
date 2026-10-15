import {
  designReviews,
  handoffs,
  qaReports,
  reviewVerdicts,
  type Database,
} from "@ai-office/db";
import {
  verdictCommentSchema,
  type DesignResult,
  type PipelineStage,
  type QaResult,
  type ReviewVerdict,
} from "@ai-office/shared";
import { and, asc, desc, eq } from "drizzle-orm";

// Where the Review Loop keeps what it needs across rounds and restarts
// (PRD FR-26 to FR-28): each reviewer's verdict in each round, in the
// `review_verdicts` table, the QA Agent's result in each round of QA, in
// `qa_reports`, a designer's in each round of design review, in
// `design_reviews`, and each Handoff's structured summary, in the
// `handoffs` table; or memory for tests.

/** One reviewer's verdict in one round, as posted. */
export interface VerdictRecord {
  readonly floorId: string;
  readonly issue: number;
  readonly pullRequest: number;
  /** The round of the Review Loop, from 1. */
  readonly round: number;
  readonly agentId: string;
  /** The pull request's head commit it reviewed. */
  readonly headSha: string;
  readonly verdict: ReviewVerdict;
  /** The review on GitHub. */
  readonly reviewUrl: string;
  readonly createdAt: Date;
}

/** The QA Agent's result in one round of QA, as commented. */
export interface QaReportRecord {
  readonly floorId: string;
  readonly issue: number;
  readonly pullRequest: number;
  /** The round of QA, from 1. */
  readonly round: number;
  readonly agentId: string;
  /** The pull request's head commit it checked, with any tests it added. */
  readonly headSha: string;
  readonly result: QaResult;
  readonly summary: string;
  /** The steps that reproduce a failure; empty for a pass. */
  readonly steps: string;
  /** Its comment on the pull request. */
  readonly commentUrl: string;
  readonly createdAt: Date;
}

/** A designer's result in one round of design review, as commented. */
export interface DesignReviewRecord {
  readonly floorId: string;
  readonly issue: number;
  readonly pullRequest: number;
  /** The round of design review, from 1. */
  readonly round: number;
  readonly agentId: string;
  /** The pull request's head commit it reviewed, with any changes it made. */
  readonly headSha: string;
  readonly result: DesignResult;
  readonly summary: string;
  /** What it asks the coder to change; empty for a pass. */
  readonly findings: string;
  /** Its comment on the pull request. */
  readonly commentUrl: string;
  readonly createdAt: Date;
}

/** A Handoff's short structured summary (FR-26), never a transcript. */
export interface HandoffSummary {
  readonly changed: string;
  readonly check: string;
  readonly risks: string;
}

/** An issue handed on to a stage, and what it carries. */
export interface HandoffRecord {
  readonly floorId: string;
  readonly issue: number;
  /** The stage it hands the issue to. */
  readonly stage: PipelineStage;
  readonly fromAgentId: string;
  readonly summary: HandoffSummary;
  readonly createdAt: Date;
}

export interface ReviewLoopStore {
  /** Records a verdict, replacing the reviewer's earlier one in that round. */
  recordVerdict(verdict: VerdictRecord): Promise<void>;
  /** Every verdict on an issue, by round, then oldest first. */
  verdicts(floorId: string, issue: number): Promise<VerdictRecord[]>;
  /** Records QA's result, replacing an earlier one in that round. */
  recordQaReport(report: QaReportRecord): Promise<void>;
  /** Every round of QA on an issue, oldest first. */
  qaReports(floorId: string, issue: number): Promise<QaReportRecord[]>;
  /** Records a designer's result, replacing an earlier one in that round. */
  recordDesignReview(review: DesignReviewRecord): Promise<void>;
  /** Every round of design review on an issue, oldest first. */
  designReviews(floorId: string, issue: number): Promise<DesignReviewRecord[]>;
  recordHandoff(handoff: HandoffRecord): Promise<void>;
  /** The latest Handoff of the issue to `stage`, if any. */
  latestHandoff(
    floorId: string,
    issue: number,
    stage: PipelineStage,
  ): Promise<HandoffRecord | undefined>;
}

const copyVerdict = (record: VerdictRecord): VerdictRecord => ({
  ...record,
  verdict: {
    ...record.verdict,
    comments: record.verdict.comments.map((comment) => ({ ...comment })),
  },
});

/** Keeps verdicts, QA's and designers' results and Handoffs in memory: for tests. */
export function memoryReviewLoopStore(): ReviewLoopStore & {
  readonly handoffs: HandoffRecord[];
} {
  const verdicts: VerdictRecord[] = [];
  const reports: QaReportRecord[] = [];
  const designs: DesignReviewRecord[] = [];
  const handed: HandoffRecord[] = [];
  return {
    handoffs: handed,
    recordDesignReview(review) {
      const index = designs.findIndex(
        (known) =>
          known.floorId === review.floorId &&
          known.issue === review.issue &&
          known.round === review.round,
      );
      if (index === -1) {
        designs.push({ ...review });
      } else {
        designs[index] = { ...review };
      }
      return Promise.resolve();
    },
    designReviews: (floorId, issue) =>
      Promise.resolve(
        designs
          .filter(
            (review) => review.floorId === floorId && review.issue === issue,
          )
          .sort((a, b) => a.round - b.round)
          .map((review) => ({ ...review })),
      ),
    recordQaReport(report) {
      const index = reports.findIndex(
        (known) =>
          known.floorId === report.floorId &&
          known.issue === report.issue &&
          known.round === report.round,
      );
      if (index === -1) {
        reports.push({ ...report });
      } else {
        reports[index] = { ...report };
      }
      return Promise.resolve();
    },
    qaReports: (floorId, issue) =>
      Promise.resolve(
        reports
          .filter(
            (report) => report.floorId === floorId && report.issue === issue,
          )
          .sort((a, b) => a.round - b.round)
          .map((report) => ({ ...report })),
      ),
    recordVerdict(record) {
      const index = verdicts.findIndex(
        (known) =>
          known.floorId === record.floorId &&
          known.issue === record.issue &&
          known.round === record.round &&
          known.agentId === record.agentId,
      );
      if (index === -1) {
        verdicts.push(copyVerdict(record));
      } else {
        verdicts[index] = copyVerdict(record);
      }
      return Promise.resolve();
    },
    verdicts: (floorId, issue) =>
      Promise.resolve(
        verdicts
          .filter(
            (record) => record.floorId === floorId && record.issue === issue,
          )
          .sort(
            (a, b) =>
              a.round - b.round ||
              a.createdAt.getTime() - b.createdAt.getTime(),
          )
          .map(copyVerdict),
      ),
    recordHandoff(handoff) {
      handed.push({ ...handoff, summary: { ...handoff.summary } });
      return Promise.resolve();
    },
    latestHandoff: (floorId, issue, stage) => {
      const latest = handed
        .filter(
          (handoff) =>
            handoff.floorId === floorId &&
            handoff.issue === issue &&
            handoff.stage === stage,
        )
        .at(-1);
      return Promise.resolve(
        latest === undefined
          ? undefined
          : { ...latest, summary: { ...latest.summary } },
      );
    },
  };
}

/**
 * Keeps verdicts in `review_verdicts`, QA's results in `qa_reports`,
 * designers' in `design_reviews` and Handoffs in `handoffs`.
 */
export function databaseReviewLoopStore(db: Database): ReviewLoopStore {
  return {
    async recordDesignReview(review) {
      const values = {
        pullRequest: review.pullRequest,
        agentId: review.agentId,
        headSha: review.headSha,
        result: review.result,
        summary: review.summary,
        findings: review.findings,
        commentUrl: review.commentUrl,
        createdAt: review.createdAt,
      };
      await db
        .insert(designReviews)
        .values({
          floorId: review.floorId,
          issue: review.issue,
          round: review.round,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            designReviews.floorId,
            designReviews.issue,
            designReviews.round,
          ],
          set: values,
        });
    },

    async designReviews(floorId, issue) {
      const rows = await db
        .select()
        .from(designReviews)
        .where(
          and(
            eq(designReviews.floorId, floorId),
            eq(designReviews.issue, issue),
          ),
        )
        .orderBy(asc(designReviews.round));
      return rows.map((row) => ({
        floorId: row.floorId,
        issue: row.issue,
        pullRequest: row.pullRequest,
        round: row.round,
        agentId: row.agentId,
        headSha: row.headSha,
        result: row.result === "pass" ? "pass" : "changes",
        summary: row.summary,
        findings: row.findings,
        commentUrl: row.commentUrl,
        createdAt: row.createdAt,
      }));
    },

    async recordQaReport(report) {
      const values = {
        pullRequest: report.pullRequest,
        agentId: report.agentId,
        headSha: report.headSha,
        result: report.result,
        summary: report.summary,
        steps: report.steps,
        commentUrl: report.commentUrl,
        createdAt: report.createdAt,
      };
      await db
        .insert(qaReports)
        .values({
          floorId: report.floorId,
          issue: report.issue,
          round: report.round,
          ...values,
        })
        .onConflictDoUpdate({
          target: [qaReports.floorId, qaReports.issue, qaReports.round],
          set: values,
        });
    },

    async qaReports(floorId, issue) {
      const rows = await db
        .select()
        .from(qaReports)
        .where(and(eq(qaReports.floorId, floorId), eq(qaReports.issue, issue)))
        .orderBy(asc(qaReports.round));
      return rows.map((row) => ({
        floorId: row.floorId,
        issue: row.issue,
        pullRequest: row.pullRequest,
        round: row.round,
        agentId: row.agentId,
        headSha: row.headSha,
        result: row.result === "pass" ? "pass" : "fail",
        summary: row.summary,
        steps: row.steps,
        commentUrl: row.commentUrl,
        createdAt: row.createdAt,
      }));
    },

    async recordVerdict(record) {
      const values = {
        pullRequest: record.pullRequest,
        headSha: record.headSha,
        verdict: record.verdict.verdict,
        summary: record.verdict.summary,
        comments: record.verdict.comments,
        reviewUrl: record.reviewUrl,
        createdAt: record.createdAt,
      };
      await db
        .insert(reviewVerdicts)
        .values({
          floorId: record.floorId,
          issue: record.issue,
          round: record.round,
          agentId: record.agentId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            reviewVerdicts.floorId,
            reviewVerdicts.issue,
            reviewVerdicts.round,
            reviewVerdicts.agentId,
          ],
          set: values,
        });
    },

    async verdicts(floorId, issue) {
      const rows = await db
        .select()
        .from(reviewVerdicts)
        .where(
          and(
            eq(reviewVerdicts.floorId, floorId),
            eq(reviewVerdicts.issue, issue),
          ),
        )
        .orderBy(
          asc(reviewVerdicts.round),
          asc(reviewVerdicts.createdAt),
          asc(reviewVerdicts.id),
        );
      return rows.map((row) => ({
        floorId: row.floorId,
        issue: row.issue,
        pullRequest: row.pullRequest,
        round: row.round,
        agentId: row.agentId,
        headSha: row.headSha,
        verdict: {
          verdict: row.verdict === "approve" ? "approve" : "changes_requested",
          summary: row.summary,
          comments: verdictCommentSchema.array().parse(row.comments),
        },
        reviewUrl: row.reviewUrl,
        createdAt: row.createdAt,
      }));
    },

    async recordHandoff(handoff) {
      await db.insert(handoffs).values({
        floorId: handoff.floorId,
        issue: handoff.issue,
        stage: handoff.stage,
        fromAgentId: handoff.fromAgentId,
        changed: handoff.summary.changed,
        toCheck: handoff.summary.check,
        risks: handoff.summary.risks,
        createdAt: handoff.createdAt,
      });
    },

    async latestHandoff(floorId, issue, stage) {
      const [row] = await db
        .select()
        .from(handoffs)
        .where(
          and(
            eq(handoffs.floorId, floorId),
            eq(handoffs.issue, issue),
            eq(handoffs.stage, stage),
          ),
        )
        .orderBy(desc(handoffs.createdAt), desc(handoffs.id))
        .limit(1);
      return row === undefined
        ? undefined
        : {
            floorId: row.floorId,
            issue: row.issue,
            stage: row.stage as PipelineStage,
            fromAgentId: row.fromAgentId,
            summary: {
              changed: row.changed,
              check: row.toCheck,
              risks: row.risks,
            },
            createdAt: row.createdAt,
          };
    },
  };
}
