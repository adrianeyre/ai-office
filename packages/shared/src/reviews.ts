import { z } from "zod";

// A reviewer Agent's verdict (PRD FR-20, FR-27): approve or changes
// requested, plus comments, each tagged `blocking` or `nit`, on a file and
// a line. A reviewer must answer with exactly this; anything else is not a
// verdict. The orchestrator checks it, and the web app shows it.

export const reviewVerdicts = ["approve", "changes_requested"] as const;
export type ReviewVerdictKind = (typeof reviewVerdicts)[number];

/** `blocking` must be fixed before the pull request moves on; a `nit` need not be. */
export const reviewSeverities = ["blocking", "nit"] as const;
export type ReviewSeverity = (typeof reviewSeverities)[number];

export const reviewVerdictLabels: Record<ReviewVerdictKind, string> = {
  approve: "Approve",
  changes_requested: "Changes requested",
};

/**
 * What the QA Agent found (FR-28): its checks pass, or they fail, with the
 * steps that reproduce the failure.
 */
export const qaResults = ["pass", "fail"] as const;
export type QaResult = (typeof qaResults)[number];

export const qaResultLabels: Record<QaResult, string> = {
  pass: "QA passed",
  fail: "QA failed",
};

/**
 * What a designer Agent found (FR-10, FR-18) in the screenshots of a pull
 * request's UI: it passes the repository's style guide (perhaps after
 * changes the designer committed itself), or it has changes for the coder.
 */
export const designResults = ["pass", "changes"] as const;
export type DesignResult = (typeof designResults)[number];

export const designResultLabels: Record<DesignResult, string> = {
  pass: "Design approved",
  changes: "Design changes requested",
};

/** The most comments one verdict carries. */
export const maxReviewComments = 50;

export const verdictCommentSchema = z.strictObject({
  severity: z.enum(reviewSeverities, {
    error: 'A comment\'s severity is "blocking" or "nit".',
  }),
  /** The file, from the repository's root, as the diff names it. */
  path: z
    .string({ error: "A comment names its file in path." })
    .trim()
    .min(1, { error: "A comment names its file in path." })
    .max(500, { error: "A comment's path is at most 500 characters." }),
  /** The line in the new version of the file. */
  line: z
    .number({ error: "A comment's line is a whole number from 1." })
    .int({ error: "A comment's line is a whole number from 1." })
    .min(1, { error: "A comment's line is a whole number from 1." }),
  body: z
    .string({ error: "A comment says what is wrong in body." })
    .trim()
    .min(1, { error: "A comment says what is wrong in body." })
    .max(4000, { error: "A comment's body is at most 4000 characters." }),
});
export type VerdictComment = z.infer<typeof verdictCommentSchema>;

export const reviewVerdictSchema = z
  .strictObject({
    verdict: z.enum(reviewVerdicts, {
      error: 'The verdict is "approve" or "changes_requested".',
    }),
    /** What the reviewer found, in a few sentences. */
    summary: z
      .string({ error: "Give a summary of the review." })
      .trim()
      .min(1, { error: "Give a summary of the review." })
      .max(4000, { error: "The summary is at most 4000 characters." }),
    comments: z
      .array(verdictCommentSchema, { error: "comments is a list." })
      .max(maxReviewComments, {
        error: `Make at most ${String(maxReviewComments)} comments.`,
      }),
  })
  .superRefine((review, context) => {
    const blocking = review.comments.some(
      ({ severity }) => severity === "blocking",
    );
    // A verdict that contradicts its comments says nothing the loop can act on.
    if (review.verdict === "approve" && blocking) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message:
          "An approval has no blocking comments: make them nits, or request changes.",
      });
    }
    if (review.verdict === "changes_requested" && !blocking) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message:
          "Changes requested needs at least one blocking comment saying what to change; with only nits, approve.",
      });
    }
  });
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
