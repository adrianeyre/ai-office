import { z } from "zod";

import { grillingIssuesSchema } from "./grilling-issues.ts";

// Grilling Sessions (PRD §6.15, FR-77, FR-78, FR-79, FR-80, FR-82):
// started in the Manager chat with the built-in `/grilling` Skill, the
// Manager interviews the Owner in rounds of numbered questions, each with
// its recommended answer, until no open questions remain and the Owner
// confirms. Facts it finds itself, in a read-only sandbox on the Floor's
// repository, rather than asking the Owner (FR-79). As decisions settle,
// the Floor's documents are kept current on a branch of their own (FR-80):
// the PRD's outline, ADRs, glossary terms and process docs, which one pull
// request proposes when the session ends. A session's settled decisions,
// its questions, its glossary terms, the facts found and its documents are
// kept as structured data, not only as chat text, so they can be put back
// into the Manager's prompt word for word (FR-88). Answers are read in
// plain code: "3: Postgres", "3: recommended", "recommended to all". The
// server, the web app and the orchestrator share these.

/** The built-in Skill that starts a Grilling Session: `/grilling [topic]`. */
export const grillingSkillName = "grilling";

// The other built-in Skills that start a Grilling Session, adapted from
// Matt Pocock's skills (MIT): each runs the same rounds, with its own
// instructions loaded beside `/grilling`'s.

/**
 * `/grill-with-docs <topic>`: grilling with domain modelling, sharpening
 * the glossary and recording ADRs as it goes.
 */
export const grillWithDocsSkillName = "grill-with-docs";
/**
 * `/wayfinder <idea>`: names the destination first, then asks
 * breadth-first across the whole space; its issues are the decision and
 * build tickets.
 */
export const wayfinderSkillName = "wayfinder";
/**
 * `/to-tickets <paths or description>`: breaks an existing plan (PRDs and
 * ADRs it names) into vertical-slice issues. It writes no documents.
 */
export const toTicketsSkillName = "to-tickets";
/**
 * `/to-spec [topic]`: writes the PRD from the conversation so far, asking
 * only about the seams to test at.
 */
export const toSpecSkillName = "to-spec";

/** Every built-in Skill that starts a Grilling Session, `/grilling` first. */
export const grillingSkillNames = [
  grillingSkillName,
  grillWithDocsSkillName,
  wayfinderSkillName,
  toTicketsSkillName,
  toSpecSkillName,
] as const;
export type GrillingSkillName = (typeof grillingSkillNames)[number];

export const isGrillingSkillName = (name: string): name is GrillingSkillName =>
  (grillingSkillNames as readonly string[]).includes(name);

/**
 * Whether a session started by `skill` writes documents (FR-80): every one
 * but `/to-tickets`, which breaks documents already written into issues.
 */
export const grillingWritesDocuments = (skill: GrillingSkillName): boolean =>
  skill !== toTicketsSkillName;

/** The longest topic `/grilling` takes. */
export const maxGrillingTopicLength = 500;
/** The most questions one round may add. */
export const maxGrillingQuestionsPerTurn = 20;
/** The longest question, recommended answer, decision or definition. */
export const maxGrillingTextLength = 2000;
/** The most facts one turn may ask to be found (FR-79). */
export const maxGrillingFactsPerTurn = 5;
/** The longest answer to a fact that is kept; a longer one is cut. */
export const maxGrillingFactLength = 4000;
/** The longest section of the PRD's outline, ADR part or process doc. */
export const maxGrillingDocumentTextLength = 8000;
/** The most documents `/to-tickets` reads into its session. */
export const maxGrillingSources = 5;
/** The longest document `/to-tickets` keeps; a longer one is cut. */
export const maxGrillingSourceLength = 40_000;

// Where a session's documents go in the Floor's repository (FR-80).
/** The PRDs' directory. */
export const grillingPrdDirectory = "docs/product-requirements-document";
/** The ADRs' directory. */
export const grillingAdrDirectory = "docs/architectural-decision-record";
/** The glossary, each term written as soon as it is settled. */
export const grillingGlossaryPath = "GLOSSARY.md";
/** The process docs' directory. */
export const grillingProcessDirectory = "docs/processes";

/**
 * The documents `/to-tickets` reads from what it was given: each path
 * under the PRDs' or the ADRs' directory, with or without a leading `@`,
 * once, in order, at most `maxGrillingSources`. The rest is description.
 */
export function grillingSourcePaths(text: string): string[] {
  const paths = text
    .split(/\s+/)
    .map((word) => word.replace(/^[@`'"(]+/, "").replace(/[`'",;:.)]+$/, ""))
    .filter(
      (word) =>
        [grillingPrdDirectory, grillingAdrDirectory].some((directory) =>
          word.startsWith(`${directory}/`),
        ) &&
        word
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
    );
  return [...new Set(paths)].slice(0, maxGrillingSources);
}

/** The branch a session's documents are kept on: `ai-office/grilling-3`. */
export const grillingBranch = (sessionId: number): string =>
  `ai-office/grilling-${String(sessionId)}`;

/**
 * A session is `active` (its questions are being asked and answered),
 * `paused` (kept, to be resumed) or `ended` (the Owner confirmed it).
 */
export const grillingSessionStatuses = ["active", "paused", "ended"] as const;
export type GrillingSessionStatus = (typeof grillingSessionStatuses)[number];

/**
 * A question is `open` until the Owner answers it (`answered`), or the
 * Manager withdraws it because earlier answers made it moot (`withdrawn`).
 */
export const grillingQuestionStatuses = [
  "open",
  "answered",
  "withdrawn",
] as const;
export type GrillingQuestionStatus = (typeof grillingQuestionStatuses)[number];

const timestampSchema = z.iso.datetime({ offset: true });
const numberSchema = z.number().int().positive();

/** One of the Manager's questions, numbered across the session. */
export const grillingQuestionSchema = z.object({
  number: numberSchema,
  /**
   * The round it was asked in; null while it waits for the questions it
   * depends on to be settled.
   */
  round: numberSchema.nullable(),
  text: z.string(),
  /** The Manager's recommended answer. */
  recommended: z.string(),
  /** The questions that must be settled before it is asked. */
  dependsOn: z.array(numberSchema),
  status: z.enum(grillingQuestionStatuses),
  /** The Owner's answer, as settled: the recommended one when accepted. */
  answer: z.string().nullable(),
  /** Whether the Owner accepted the recommended answer. */
  acceptedRecommended: z.boolean(),
  answeredAt: timestampSchema.nullable(),
});
export type GrillingQuestion = z.infer<typeof grillingQuestionSchema>;

/** A decision the session settled, in the Manager's words, kept word for word. */
export const grillingDecisionSchema = z.object({
  number: numberSchema,
  text: z.string(),
  /** The questions whose answers settled it. */
  questions: z.array(numberSchema),
  /** The round whose answers settled it. */
  round: numberSchema,
  settledAt: timestampSchema,
});
export type GrillingDecision = z.infer<typeof grillingDecisionSchema>;

/** A glossary term the session settled, as GLOSSARY.md would hold it. */
export const grillingTermSchema = z.object({
  term: z.string(),
  definition: z.string(),
  /** Words to avoid in its place. */
  avoid: z.array(z.string()),
});
export type GrillingTerm = z.infer<typeof grillingTermSchema>;

/**
 * A fact is `found` when the Agent sent to find it answered from the
 * repository, and `failed` when it gave no answer (its sandbox failed or
 * ran out of time), which `answer` then says.
 */
export const grillingFactStatuses = ["found", "failed"] as const;
export type GrillingFactStatus = (typeof grillingFactStatuses)[number];

/**
 * A fact the Manager had found in the Floor's code, docs and issues rather
 * than asking the Owner (FR-79), numbered across the session.
 */
export const grillingFactSchema = z.object({
  number: numberSchema,
  /** What the Manager asked to be found. */
  question: z.string(),
  /** What was found, word for word; or, when `failed`, why nothing was. */
  answer: z.string(),
  status: z.enum(grillingFactStatuses),
  /** The Agent that found it: the Manager, or one it delegated to. */
  agentId: z.string(),
  /** The latest round asked when it was found; 0 before the first. */
  round: z.number().int().nonnegative(),
  foundAt: timestampSchema,
});
export type GrillingFact = z.infer<typeof grillingFactSchema>;

/** A session as the list shows it. */
export const grillingSessionSummarySchema = z.object({
  id: numberSchema,
  floorId: z.string(),
  /** What `/grilling` was given; empty when it was given nothing. */
  topic: z.string(),
  /** The built-in Skill that started it: `grilling` for one kept before there were others. */
  skill: z.enum(grillingSkillNames).default(grillingSkillName),
  status: z.enum(grillingSessionStatuses),
  /** The latest round asked; 0 before the first. */
  round: z.number().int().nonnegative(),
  /** No open questions remain, and the Manager waits for the Owner to confirm. */
  awaitingConfirmation: z.boolean(),
  /** How many questions are open, asked or waiting to be. */
  openQuestions: z.number().int().nonnegative(),
  /** How many decisions are settled. */
  decisionCount: z.number().int().nonnegative(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  pausedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
});
export type GrillingSessionSummary = z.infer<
  typeof grillingSessionSummarySchema
>;

/** A section of the PRD's live outline: its heading and what it says. */
export const grillingSectionSchema = z.object({
  heading: z.string(),
  text: z.string(),
});
export type GrillingSection = z.infer<typeof grillingSectionSchema>;

/**
 * An ADR the session settled (FR-80): only for a decision that is hard to
 * reverse, surprising and the result of a real trade-off, each of which
 * it says why.
 */
export const grillingAdrSchema = z.object({
  title: z.string(),
  /** The decision and its context, as the ADR's opening paragraphs. */
  decision: z.string(),
  /** The options considered and why each was not chosen. */
  options: z.array(z.string()),
  consequences: z.array(z.string()),
  hardToReverse: z.string(),
  surprising: z.string(),
  tradeOff: z.string(),
});
export type GrillingAdr = z.infer<typeof grillingAdrSchema>;

/** A process doc the session settled: how some work gets done. */
export const grillingProcessSchema = z.object({
  title: z.string(),
  text: z.string(),
});
export type GrillingProcess = z.infer<typeof grillingProcessSchema>;

/**
 * Where a session's documents stand on GitHub (FR-80): the branch they
 * are kept on, the files and commit last written, and the one pull
 * request opened when the session ended. Null until first written.
 */
export const grillingDocumentsSchema = z.object({
  branch: z.string(),
  /** The files written, by path in the repository. */
  files: z.array(z.string()),
  /** The branch's head as last written. */
  commit: z.string().nullable(),
  writtenAt: timestampSchema.nullable(),
  pullRequest: z.object({ number: numberSchema, url: z.string() }).nullable(),
  /** Why the documents could not be written last time, if they could not. */
  problem: z.string().nullable(),
});
export type GrillingDocuments = z.infer<typeof grillingDocumentsSchema>;

/**
 * A document of the Floor's repository that `/to-tickets` read into its
 * session when it started, redacted and cut to `maxGrillingSourceLength`:
 * untrusted data the Manager reads, never instructions.
 */
export const grillingSourceSchema = z.object({
  /** Its path in the repository, under the PRDs' or ADRs' directory. */
  path: z.string(),
  /** Its text at the default branch; null when there is no such file. */
  content: z.string().nullable(),
  /** Whether its text was cut short. */
  truncated: z.boolean(),
});
export type GrillingSource = z.infer<typeof grillingSourceSchema>;

/**
 * A session in full: its questions, decisions, terms, facts, its
 * documents (the PRD's outline, ADRs and process docs, and where they are
 * kept) and the issues drafted from them (FR-81).
 */
export const grillingSessionSchema = grillingSessionSummarySchema.extend({
  questions: z.array(grillingQuestionSchema),
  decisions: z.array(grillingDecisionSchema),
  terms: z.array(grillingTermSchema),
  facts: z.array(grillingFactSchema),
  outline: z.array(grillingSectionSchema),
  adrs: z.array(grillingAdrSchema),
  processes: z.array(grillingProcessSchema),
  documents: grillingDocumentsSchema.nullable(),
  issues: grillingIssuesSchema.nullable(),
  /** The documents `/to-tickets` read; empty for every other session. */
  sources: z.array(grillingSourceSchema).default([]),
});
export type GrillingSession = z.infer<typeof grillingSessionSchema>;

/** `GET /api/floors/:floorId/grilling-sessions`: newest first. */
export const grillingSessionListSchema = z.object({
  sessions: z.array(grillingSessionSummarySchema),
});
export type GrillingSessionList = z.infer<typeof grillingSessionListSchema>;

/**
 * The session a chat message belongs to: every message of a session
 * names it, and a message that asks a round names that round too, so the
 * chat shows its questions as cards.
 */
export const grillingMessageRefSchema = z.object({
  sessionId: numberSchema,
  /** The round whose questions it asks; null for the session's other messages. */
  round: numberSchema.nullable(),
});
export type GrillingMessageRef = z.infer<typeof grillingMessageRefSchema>;

export const grillingErrorCodes = {
  /** The Floor has no Grilling Session of that id. */
  sessionNotFound: "grilling_session_not_found",
  /** The session has no draft issues to edit, or they are filed already. */
  issuesNotEditable: "grilling_issues_not_editable",
  /** The edited drafts cannot be filed as they are. */
  issuesInvalid: "grilling_issues_invalid",
} as const;
export type GrillingErrorCode =
  (typeof grillingErrorCodes)[keyof typeof grillingErrorCodes];

// One of the Manager's turns in a session, as its Model writes it as JSON:
// the decisions the answers settled, glossary terms, open questions the
// answers made moot, and the next questions with their recommended answers
// and prerequisites. AI Office numbers the questions and asks those whose
// prerequisites are settled. A turn may instead ask for facts to be found
// in the repository first (FR-79), naming an Agent to delegate each to.
// It also keeps the documents current (FR-80): sections of the PRD's
// outline, ADRs and process docs, each replacing one of the same heading
// or title.
const text = (what: string) =>
  z
    .string({ error: `${what} is text.` })
    .trim()
    .min(1, { error: `${what} is not empty.` })
    .max(maxGrillingTextLength, {
      error: `${what} is at most ${String(maxGrillingTextLength)} characters.`,
    });
const numbers = z.array(z.number().int().positive()).max(100).default([]);
const documentText = (what: string) =>
  z
    .string({ error: `${what} is text.` })
    .trim()
    .min(1, { error: `${what} is not empty.` })
    .max(maxGrillingDocumentTextLength, {
      error: `${what} is at most ${String(maxGrillingDocumentTextLength)} characters.`,
    });
/** An ADR's reason, which may be left out: an ADR without all three is not kept. */
const reason = z.string().trim().max(maxGrillingTextLength).default("");

export const grillingTurnSchema = z.object({
  /** A few words to the Owner before the questions; may be empty. */
  message: z.string().max(maxGrillingTextLength).default(""),
  decisions: z
    .array(
      z.object({
        text: text("A decision"),
        /** The questions whose answers settled it. */
        questions: numbers,
      }),
    )
    .max(50)
    .default([]),
  terms: z
    .array(
      z.object({
        term: text("A term").max(200),
        definition: text("A definition"),
        avoid: z.array(text("A word to avoid").max(200)).max(20).default([]),
      }),
    )
    .max(50)
    .default([]),
  /** Open questions the answers made moot. */
  withdraw: numbers,
  questions: z
    .array(
      z.object({
        text: text("A question"),
        recommended: text("A recommended answer"),
        /** Earlier questions that must be settled before it is asked. */
        dependsOn: numbers,
      }),
    )
    .max(maxGrillingQuestionsPerTurn)
    .default([]),
  /**
   * Facts to find in the Floor's code, docs and issues before the round
   * is asked: AI Office finds them, then asks for the turn again.
   */
  facts: z
    .array(
      z.object({
        question: text("A fact to find"),
        /** The Floor's Agent to send; the Manager finds it itself without. */
        agent: z.string().trim().max(100).optional(),
      }),
    )
    .max(maxGrillingFactsPerTurn)
    .default([]),
  /** Sections of the PRD's outline, each replacing one of its heading. */
  outline: z
    .array(
      z.object({
        heading: text("A heading").max(200),
        text: documentText("A section"),
      }),
    )
    .max(30)
    .default([]),
  /** ADRs, each replacing one of its title; kept only with all three reasons. */
  adrs: z
    .array(
      z.object({
        title: text("An ADR's title").max(200),
        decision: documentText("An ADR's decision"),
        options: z.array(text("An option considered")).max(10).default([]),
        consequences: z.array(text("A consequence")).max(20).default([]),
        hardToReverse: reason,
        surprising: reason,
        tradeOff: reason,
      }),
    )
    .max(10)
    .default([]),
  /** Process docs, each replacing one of its title. */
  processes: z
    .array(
      z.object({
        title: text("A process doc's title").max(200),
        text: documentText("A process doc"),
      }),
    )
    .max(10)
    .default([]),
});
export type GrillingTurn = z.infer<typeof grillingTurnSchema>;

/** One answer: the Owner's own words, or null for the recommended answer. */
export interface GrillingAnswer {
  readonly number: number;
  readonly answer: string | null;
}

/** The answers one of the Owner's messages gives. */
export interface GrillingAnswers {
  readonly answers: readonly GrillingAnswer[];
  /** "recommended to all": every question left open takes its recommended answer. */
  readonly restRecommended: boolean;
  /**
   * The message was only "recommended": the recommended answer for the
   * one question open, if exactly one is.
   */
  readonly bare: boolean;
}

const tidy = (text: string): string =>
  text
    .trim()
    .replace(/[.!]+$/, "")
    .trim()
    .toLowerCase();

const restRecommendedPattern =
  /^(?:(?:i\s+)?accept\s+)?(?:the\s+)?(?:recommended(?:\s+answers?)?\s+(?:to|for)\s+(?:all|everything|the\s+rest|the\s+others|all\s+the\s+rest|all\s+others)|all\s+recommended)$/;
const recommendedPattern =
  /^(?:(?:i\s+)?accept(?:\s+the)?\s+)?(?:the\s+)?recommended(?:\s+answer)?$/;
const numberedPattern =
  /^(?:q(?:uestion)?\s*)?#?(\d{1,6})\s*(?:[:.)–—-]\s*|\s+(?=recommended\b))([\s\S]*)$/i;

/** Whether `text` says "recommended to all" (or "all recommended"). */
export const isRestRecommended = (text: string): boolean =>
  restRecommendedPattern.test(tidy(text));

/** Whether an answer is "recommended": take the recommended answer. */
export const isRecommended = (text: string): boolean =>
  recommendedPattern.test(tidy(text));

/**
 * Reads the Owner's answers from a message, in plain code: one per line,
 * "3: Postgres", "3. Postgres", "Q3) Postgres", "3: recommended", and a
 * line "recommended to all" for every question left open. Lines that
 * follow an answer without a number of their own continue it. Undefined
 * for a message that answers nothing, which the Manager reads instead.
 */
export function readGrillingAnswers(text: string): GrillingAnswers | undefined {
  const trimmed = text.trim();
  if (isRestRecommended(trimmed)) {
    return { answers: [], restRecommended: true, bare: false };
  }
  if (isRecommended(trimmed)) {
    return { answers: [], restRecommended: true, bare: true };
  }
  const answers = new Map<number, string[]>();
  let current: string[] | undefined;
  let restRecommended = false;
  for (const line of trimmed.split(/\r?\n/)) {
    if (isRestRecommended(line)) {
      restRecommended = true;
      current = undefined;
      continue;
    }
    const numbered = numberedPattern.exec(line.trim());
    if (numbered?.[1] !== undefined) {
      const number = Number(numbered[1]);
      if (number > 0) {
        current = [numbered[2] ?? ""];
        // The last answer to a question is the one kept.
        answers.delete(number);
        answers.set(number, current);
        continue;
      }
    }
    current?.push(line);
  }
  if (answers.size === 0 && !restRecommended) {
    return undefined;
  }
  return {
    answers: [...answers].map(([number, lines]) => {
      const answer = lines.join("\n").trim();
      return {
        number,
        answer: answer === "" || isRecommended(answer) ? null : answer,
      };
    }),
    restRecommended,
    bare: false,
  };
}

/**
 * The message the question cards send: each answer on its own line,
 * "3: recommended" for one accepted, and "recommended to all" last when
 * the rest take theirs. `readGrillingAnswers` reads it back.
 */
export function composeGrillingAnswers(
  answers: readonly GrillingAnswer[],
  restRecommended = false,
): string {
  return [
    ...answers.map(
      ({ number, answer }) =>
        `${String(number)}: ${answer === null ? "recommended" : answer.trim()}`,
    ),
    ...(restRecommended ? ["recommended to all"] : []),
  ].join("\n");
}

/** What the Owner can say to a session itself, read in plain code. */
export type GrillingControl =
  | { readonly kind: "pause" }
  /** The session numbered, or the latest paused one. */
  | { readonly kind: "resume"; readonly session: number | null }
  | { readonly kind: "confirm" }
  /**
   * The Owner ends the session now, with questions still open if any
   * are (FR-83a): the running one, or the latest paused one.
   */
  | { readonly kind: "end" }
  /**
   * The Manager drafts the issues of an ended session again (FR-81): the
   * session numbered, or the latest ended one.
   */
  | { readonly kind: "draft-issues"; readonly session: number | null }
  /** The Owner approves the draft issues, and the App files them (FR-81). */
  | { readonly kind: "file-issues"; readonly session: number | null };

const pausePattern =
  /^(?:please\s+)?pause\s+(?:the\s+)?(?:grilling(?:\s+session)?|session)(?:\s+please)?$/;
const resumePattern =
  /^(?:please\s+)?resume\s+(?:the\s+)?(?:grilling(?:\s+session)?|session)(?:\s+#?(\d{1,15}))?(?:\s+please)?$/;
const ofSession =
  "(?:\\s+(?:of|for|from)\\s+(?:the\\s+)?(?:grilling\\s+)?session\\s+#?(\\d{1,15}))?";
const draftIssuesPattern = new RegExp(
  `^(?:please\\s+)?(?:re-?)?draft\\s+(?:the\\s+)?issues(?:\\s+again)?${ofSession}(?:\\s+again)?(?:,?\\s+please)?$`,
);
const fileIssuesPattern = new RegExp(
  `^(?:please\\s+)?(?:(?:approve\\s+and\\s+)?file|approve)\\s+(?:the\\s+)?issues${ofSession}(?:,?\\s+please)?$`,
);
const endPattern =
  /^(?:please\s+)?(?:end|finish|stop)\s+(?:the\s+)?(?:grilling(?:\s+session)?|session)(?:\s+now)?(?:\s+please)?$/;
const confirmPattern =
  /^(?:yes[,\s]*)?(?:i\s+)?confirm(?:ed)?(?:\s*(?:,|and)\s*end(?:\s+(?:the\s+)?(?:grilling\s+)?session)?)?$/;

/**
 * "pause the session"; "resume the session" (the latest paused one) or
 * "resume session 3"; "confirm" (the session ends once no open questions
 * remain); "end the session" (it ends now, whatever is still open); and, for an ended session's issues, "draft the issues of
 * session 3" and "file the issues of session 3" (the latest ended session
 * without a number). Undefined for anything else.
 */
export function readGrillingControl(text: string): GrillingControl | undefined {
  const said = tidy(text).replaceAll(/\s+/g, " ");
  if (pausePattern.test(said)) {
    return { kind: "pause" };
  }
  if (endPattern.test(said)) {
    return { kind: "end" };
  }
  const resume = resumePattern.exec(said);
  if (resume !== null) {
    return {
      kind: "resume",
      session: resume[1] === undefined ? null : Number(resume[1]),
    };
  }
  for (const [pattern, kind] of [
    [draftIssuesPattern, "draft-issues"],
    [fileIssuesPattern, "file-issues"],
  ] as const) {
    const issues = pattern.exec(said);
    if (issues !== null) {
      return {
        kind,
        session: issues[1] === undefined ? null : Number(issues[1]),
      };
    }
  }
  return confirmPattern.test(said) ? { kind: "confirm" } : undefined;
}

/** What the session list's buttons send: "pause the session", "resume session 3". */
export const pauseGrillingText = "pause the session";
/** What End session sends (FR-83a): the session ends now. */
export const endGrillingText = "end the session";
export const resumeGrillingText = (session: number): string =>
  `resume session ${String(session)}`;
/** What the session's Issues send: "draft the issues of session 3" (FR-81). */
export const draftGrillingIssuesText = (session: number): string =>
  `draft the issues of session ${String(session)}`;
/** "file the issues of session 3": the Owner approves the drafts (FR-81). */
export const fileGrillingIssuesText = (session: number): string =>
  `file the issues of session ${String(session)}`;
