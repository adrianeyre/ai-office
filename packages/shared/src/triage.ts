import { z } from "zod";

// The Manager's triage (PRD FR-23): before work starts on a picked-up
// issue, the Manager checks it is clear enough to work (acceptance criteria
// present, scope bounded) and sets its priority, which the work queue
// dispatches by. An issue that is not clear waits for the Owner, with an
// action Notice (FR-49) and a comment on the issue. When the Floor has more
// than one work Role, the triage also picks the Role to work it (ADR 0003).

/** An issue's priority, lowest first. */
export const issuePriorities = ["low", "normal", "high"] as const;
export type IssuePriority = (typeof issuePriorities)[number];

/** What an issue gets when nothing judged its priority. */
export const defaultIssuePriority: IssuePriority = "normal";

export const issuePriorityLabels: Record<IssuePriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};

/** Whether the issue may be worked, or waits for the Owner. */
export const triageOutcomes = ["clear", "unclear"] as const;
export type TriageOutcome = (typeof triageOutcomes)[number];

/**
 * Who judged: the Manager's Model, the Decision Model when it is on
 * (FR-17), AI Office's own rules in plain code, or the Owner.
 */
export const triageJudges = [
  "model",
  "decision_model",
  "rules",
  "owner",
] as const;
export type TriageJudge = (typeof triageJudges)[number];

/** The action on an unclear issue's Notice that has it worked as it is. */
export const triageActions = {
  workAsItIs: "work_issue_as_it_is",
} as const;

/** The most questions one triage asks the Owner. */
export const maxTriageQuestions = 5;

/** The most work Roles one triage lists for an issue. */
export const maxTriageRoles = 10;

/** The Manager's judgement of an issue, as its Model must answer it. */
export const triageVerdictSchema = z
  .strictObject({
    clear: z.boolean({
      error: "clear is true when the issue can be worked, false otherwise.",
    }),
    priority: z.enum(issuePriorities, {
      error: 'The priority is "high", "normal" or "low".',
    }),
    /** Why, in a sentence or two. */
    reason: z
      .string({ error: "Give the reason for your judgement." })
      .trim()
      .min(1, { error: "Give the reason for your judgement." })
      .max(1000, { error: "The reason is at most 1000 characters." }),
    /** What the Owner must answer before work starts; none when clear. */
    questions: z
      .array(
        z
          .string({ error: "Each question is a sentence." })
          .trim()
          .min(1, { error: "A question cannot be empty." })
          .max(500, { error: "A question is at most 500 characters." }),
        { error: "questions is a list." },
      )
      .max(maxTriageQuestions, {
        error: `Ask at most ${String(maxTriageQuestions)} questions.`,
      }),
    /**
     * When the Floor has several work Roles: the ids of those that could
     * work the issue, best first. One when the Manager can tell which;
     * more when it cannot tell between them.
     */
    roles: z
      .array(z.string({ error: "Each Role is its id." }).trim().min(1), {
        error: "roles is a list of Role ids.",
      })
      .max(maxTriageRoles, {
        error: `List at most ${String(maxTriageRoles)} Roles.`,
      })
      .optional(),
    /** Why those Roles, in a sentence or two. */
    roleReason: z
      .string({ error: "Give the reason for the Roles you chose." })
      .trim()
      .min(1, { error: "Give the reason for the Roles you chose." })
      .max(1000, { error: "The roleReason is at most 1000 characters." })
      .optional(),
  })
  .superRefine((verdict, context) => {
    // An unclear issue waits for the Owner, who needs to know what to answer.
    if (!verdict.clear && verdict.questions.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message:
          "An issue that is not clear needs at least one question for the Owner.",
      });
    }
    if (verdict.clear && verdict.questions.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message:
          "A clear issue asks no questions: leave questions empty, or set clear to false.",
      });
    }
  });
export type TriageVerdict = z.infer<typeof triageVerdictSchema>;
