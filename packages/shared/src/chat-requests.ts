import { z } from "zod";

import { maxPlanFileLength, maxPlanFiles } from "./batches.ts";
import { maxCommandIssues, maxIssueNumber } from "./manager-chat.ts";
import { maxRoleInstructions } from "./roles.ts";

// A request the Owner makes in the Manager chat (PRD FR-24, ADR 0004). The
// Manager acts as the orchestrator: for each plain message its Model
// decides whether it is a request to change the repository, which becomes
// a Batch of issues the Manager files (plan, then go); research that
// changes nothing, which a research Contractor does in a read-only clone;
// or too unclear to act on, when it asks one clarifying question. A
// question, a status or a discussion gets an ordinary reply, with none of
// this. The Model answers a decision as one JSON object in a fenced block
// opened by `chatRequestFence`, which this schema checks; anything else
// is its reply. The orchestrator, the server and the event schema share
// these.
//
// A Batch may work the Floor's existing issues as well as file new ones
// (ADR 0012): the Owner names them by number ("issues 1 to 10") or
// describes them ("the login issues"), and the Model gives their numbers,
// with how it read each description. Plain code then adds every number
// the Owner typed, so none is dropped (`typedIssues`), and refuses a
// request for more than `maxRequestIssues` issues in all. A request asking
// for "one PR" goes in one pull request (ADR 0010).

/** The line a decision's fenced block opens with. */
export const chatRequestFence = "```request";

/** The most issues one request works, existing and new together. */
export const maxRequestIssues = 10;
/** The most one-off Roles it writes for one request. */
export const maxRequestRoles = 5;
/** The most questions one research Contractor is sent with. */
export const maxResearchQuestions = 3;
/** The longest one-off Role name: an Agent's name, with room for " 99". */
export const maxOneOffRoleNameLength = 36;

const text = (what: string, max: number) =>
  z
    .string({ error: `Give ${what}.` })
    .trim()
    .min(1, { error: `Give ${what}.` })
    .max(max, { error: `${what} is at most ${String(max)} characters.` });

/**
 * A one-off Role the Manager writes for a Contractor's task (ADR 0004):
 * always in the work Stage, in no Role library, gone when the Contractor
 * leaves.
 */
export const oneOffRoleSchema = z.strictObject({
  /** Such as "Migration writer": the Contractor is named after it. */
  name: text("the Role's name", maxOneOffRoleNameLength).regex(
    /^[\p{L}\p{N}][\p{L}\p{N} '&-]*$/u,
    {
      error:
        "A Role's name is words: letters, digits, spaces, hyphens and apostrophes.",
    },
  ),
  /** One line on what it does. */
  description: text("the Role's description", 300),
  /** What its Contractor is told about its task. */
  instructions: text("the Role's instructions", maxRoleInstructions),
});
export type OneOffRole = z.infer<typeof oneOffRoleSchema>;

/** One issue the Manager files for a request. */
export const requestIssueSchema = z.strictObject({
  title: text("the issue's title", 200),
  /** What to build, end to end. */
  body: text("what to build", 20_000),
  acceptanceCriteria: z
    .array(text("an acceptance criterion", 500), {
      error: "acceptanceCriteria is a list.",
    })
    .min(1, { error: "Give each issue at least one acceptance criterion." })
    .max(20),
  /** Positions in the list (1 for the first) of earlier issues it builds on. */
  dependsOn: z
    .array(
      z
        .number({ error: "dependsOn lists positions in your list." })
        .int({ error: "dependsOn lists positions in your list." })
        .positive({ error: "dependsOn lists positions in your list." }),
    )
    .max(maxRequestIssues),
  /** The repository's files it is likely to change. */
  files: z.array(text("a file path", maxPlanFileLength)).max(maxPlanFiles, {
    error: `Name at most ${String(maxPlanFiles)} files for an issue.`,
  }),
  /** The work Role that works it: a library work Role's name, or one of `roles`. */
  role: text("the issue's work Role", 100),
});
export type RequestIssue = z.infer<typeof requestIssueSchema>;

const existingIssueSchema = z
  .number({ error: "existingIssues lists issue numbers." })
  .int({ error: "existingIssues lists issue numbers." })
  .positive({ error: "existingIssues lists issue numbers." })
  .max(maxIssueNumber, { error: "existingIssues lists issue numbers." });

/** How the Model read one of the Owner's descriptions of existing issues. */
export const requestReadingSchema = z.strictObject({
  /** The Owner's words, such as "the login issues". */
  words: text("the Owner's words", 200),
  /** The existing issues it read them as. */
  issues: z.array(existingIssueSchema).max(maxCommandIssues),
});
export type RequestReading = z.infer<typeof requestReadingSchema>;

/** What the Manager's Model decided about a chat message it did not just answer. */
export const chatRequestSchema = z.discriminatedUnion(
  "decision",
  [
    /** Too unclear to act on: one question for the Owner, and nothing filed. */
    z.strictObject({
      decision: z.literal("clarify"),
      question: text("the question", 2000),
    }),
    /** An investigation that changes nothing, for a research Contractor. */
    z.strictObject({
      decision: z.literal("research"),
      /** A sentence to the Owner on what is being looked into. */
      message: text("a message to the Owner", 2000),
      role: oneOffRoleSchema,
      questions: z
        .array(text("a question", 1000))
        .min(1, { error: "Ask at least one question." })
        .max(maxResearchQuestions, {
          error: `Ask at most ${String(maxResearchQuestions)} questions.`,
        }),
    }),
    /**
     * Repository work, as one Batch: the Floor's existing issues to work,
     * and the new issues to file. At least one of either.
     */
    z.strictObject({
      decision: z.literal("batch"),
      /** The Plan in two or three sentences, for the Owner. */
      message: text("the Plan's summary", 2000),
      roles: z.array(oneOffRoleSchema).max(maxRequestRoles, {
        error: `Write at most ${String(maxRequestRoles)} one-off Roles.`,
      }),
      /**
       * The existing issues to work, by number, in order (ADR 0012): those
       * the Owner named, and those their descriptions name. Room for more
       * than a request may work, so a request for too many is refused in
       * the Owner's words rather than misread.
       */
      existingIssues: z
        .array(existingIssueSchema)
        .max(maxCommandIssues, {
          error: `Name at most ${String(maxCommandIssues)} existing issues.`,
        })
        .optional(),
      /** How each of the Owner's descriptions was read, such as "the login issues". */
      readings: z.array(requestReadingSchema).max(maxRequestIssues).optional(),
      /** The new issues to file, after the existing ones. */
      issues: z.array(requestIssueSchema).max(maxRequestIssues, {
        error: `File at most ${String(maxRequestIssues)} issues for one request.`,
      }),
      /**
       * Whether the Owner asked for it all in one pull request (ADR 0010);
       * it goes in one only when their own words say so too.
       */
      onePullRequest: z.boolean().optional(),
    }),
  ],
  { error: 'decision is "batch", "research" or "clarify".' },
);
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * Whether what the Manager is about to do for a chat request is what the
 * Owner asked for (P2-3): the answer of a check that is given only the
 * Owner's own words and the Manager's plan, quoted as untrusted. Without
 * `bound: true`, nothing is filed and no one is added.
 */
export const requestBindingSchema = z.discriminatedUnion(
  "bound",
  [
    z.strictObject({ bound: z.literal(true) }),
    z.strictObject({
      bound: z.literal(false),
      /** Why, in a sentence for the Owner. */
      reason: text("the reason", 500),
    }),
  ],
  { error: "bound is true or false." },
);
export type RequestBinding = z.infer<typeof requestBindingSchema>;
