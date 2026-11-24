import {
  confirmSpecPhaseText,
  maxSpecCriteria,
  maxSpecRequirements,
  maxSpecTasks,
  nextSpecPhase,
  reopenSpecPhaseText,
  skipSpecDesignText,
  specCriterion,
  specDocument,
  specDocumentPath,
  specFolder,
  specPhaseBefore,
  specPhases,
  type GrillingIssues,
  type GrillingSpec,
  type SpecPhase,
} from "@ai-office/shared";

import type { FileToCommit } from "../git/commit-file.ts";
import type { GrillingSessionRecord } from "./session.ts";
import { openInRound } from "./session.ts";

// A `/spec` session's rules, in plain code (Guidelines, Specs and Hooks
// PRD, FR-113; ADR 0015). The session runs the Grilling Session's rounds
// in three phases (requirements, design, tasks), the Manager's Model
// drafting the current phase's document as it goes. The Owner moves it on
// in their own words, never the Model:
// - "confirm requirements" / "confirm design" / "confirm tasks" keeps the
//   phase's draft as its approved copy, once no open questions remain and
//   there is a draft, and moves to the next phase;
// - "skip design", while the design is drafted, goes straight to the
//   tasks, with no design.md;
// - "reopen requirements" (or the design) goes back to that phase: its
//   approved copy and those after it are dropped, as are the later
//   phases' drafts, which are drafted again; questions still open are
//   withdrawn.
// The session's branch holds exactly the approved documents
// (`specFiles`), so each confirmation commits its document and a reopened
// phase's documents leave the branch until confirmed again. The approved
// tasks become the session's issue drafts (`specIssueDrafts`), one each,
// in their order, with no model asked.

/** The Spec of a `/spec` session; an error for any other. */
export function specOf(
  session: Pick<GrillingSessionRecord, "id" | "spec">,
): GrillingSpec {
  if (session.spec === null) {
    throw new Error(
      `Grilling Session ${String(session.id)} is not a /spec session.`,
    );
  }
  return session.spec;
}

/** "the requirements", "the design", "the tasks". */
export const phaseName = (phase: SpecPhase): string => `the ${phase}`;

/** What the Owner says to end the current phase: "confirm requirements" or, for the design, "skip design" too. */
export function specConfirmWords(phase: SpecPhase): string {
  return phase === "design"
    ? `"${confirmSpecPhaseText(phase)}", or "${skipSpecDesignText}"`
    : `"${confirmSpecPhaseText(phase)}"`;
}

/** Why the Owner cannot confirm `phase` now; undefined when they can. */
export function confirmProblem(
  session: GrillingSessionRecord,
  phase: SpecPhase,
): string | undefined {
  const spec = specOf(session);
  if (phase !== spec.phase) {
    return specPhaseBefore(phase, spec.phase)
      ? `${capitalised(phaseName(phase))} ${phase === "design" && spec.designSkipped ? "were skipped" : "are confirmed already"}; the Spec is on ${phaseName(spec.phase)}. Say "${reopenSpecPhaseText(phase)}" to draft ${phase === "design" ? "it" : "them"} again.`
      : `The Spec is on ${phaseName(spec.phase)}: ${phaseName(phase)} come after ${phaseName(spec.phase)} are confirmed.`;
  }
  if (spec.drafts[phase] === null) {
    return `${capitalised(phaseName(phase))} ${phase === "design" ? "is" : "are"} not drafted yet: answer the open questions, or send a message for the draft.`;
  }
  const open = openInRound(session);
  if (open.length > 0 || !session.awaitingConfirmation) {
    return `${capitalised(phaseName(phase))} still ${phase === "design" ? "has" : "have"} questions to settle: answer the open ones first.`;
  }
  return undefined;
}

/** Why the Owner cannot skip the design now; undefined when they can. */
export function skipProblem(
  session: GrillingSessionRecord,
): string | undefined {
  const spec = specOf(session);
  if (spec.phase === "requirements") {
    return `The Spec is on the requirements: say "${confirmSpecPhaseText("requirements")}" first, then "${skipSpecDesignText}".`;
  }
  if (spec.phase === "tasks") {
    return spec.designSkipped
      ? "The design is skipped already."
      : `The design is confirmed already; say "${reopenSpecPhaseText("design")}" to draft it again first.`;
  }
  return undefined;
}

/** Why the Owner cannot reopen `phase` now; undefined when they can. */
export function reopenProblem(
  session: GrillingSessionRecord,
  phase: SpecPhase,
): string | undefined {
  const spec = specOf(session);
  if (phase === spec.phase) {
    return `The Spec is on ${phaseName(phase)} already.`;
  }
  if (!specPhaseBefore(phase, spec.phase)) {
    return `The Spec is on ${phaseName(spec.phase)}: ${phaseName(phase)} ${phase === "design" ? "has" : "have"} not been drafted yet.`;
  }
  return undefined;
}

/** A question still open is withdrawn: the phase it was asked for is over. */
const withdrawOpen = (
  session: GrillingSessionRecord,
): GrillingSessionRecord["questions"] =>
  session.questions.map((question) =>
    question.status === "open"
      ? { ...question, status: "withdrawn" as const }
      : question,
  );

/**
 * The Owner confirmed the current phase: its draft is the approved copy,
 * and the Spec moves to the next phase (none after the tasks).
 */
export function confirmSpecPhase(
  session: GrillingSessionRecord,
  at: Date,
): GrillingSessionRecord {
  const spec = specOf(session);
  const { phase } = spec;
  const next = nextSpecPhase(phase);
  return {
    ...session,
    awaitingConfirmation: next === undefined && session.awaitingConfirmation,
    spec: {
      ...spec,
      phase: next ?? phase,
      approved: { ...spec.approved, [phase]: spec.drafts[phase] },
      confirmedAt: { ...spec.confirmedAt, [phase]: at.toISOString() },
    },
    updatedAt: at,
  };
}

/** The Owner skipped the design: the Spec has none, and its tasks are drafted next. */
export function skipSpecDesign(
  session: GrillingSessionRecord,
  at: Date,
): GrillingSessionRecord {
  const spec = specOf(session);
  return {
    ...session,
    awaitingConfirmation: false,
    questions: withdrawOpen(session),
    spec: {
      ...spec,
      phase: "tasks",
      approved: { ...spec.approved, design: null },
      designSkipped: true,
      confirmedAt: { ...spec.confirmedAt, design: at.toISOString() },
    },
    updatedAt: at,
  };
}

/**
 * The Owner reopened `phase`: it is drafted again from its last draft,
 * and every later phase from nothing. No approved copy from `phase` on is
 * kept, nor the design skipped if `phase` comes before the tasks.
 */
export function reopenSpecPhase(
  session: GrillingSessionRecord,
  phase: SpecPhase,
  at: Date,
): GrillingSessionRecord {
  const spec = specOf(session);
  const from = specPhases.indexOf(phase);
  /** Each phase's value from `each` up to `last`, null after it. */
  const upTo = <Each extends Readonly<Record<SpecPhase, unknown>>>(
    each: Each,
    last: number,
  ): { [Phase in SpecPhase]: Each[Phase] | null } => ({
    requirements: last >= 0 ? each.requirements : null,
    design: last >= 1 ? each.design : null,
    tasks: last >= 2 ? each.tasks : null,
  });
  return {
    ...session,
    awaitingConfirmation: false,
    questions: withdrawOpen(session),
    spec: {
      ...spec,
      phase,
      // The reopened phase is redrafted from its draft; later ones afresh.
      drafts: upTo(spec.drafts, from),
      approved: upTo(spec.approved, from - 1),
      designSkipped: from > specPhases.indexOf("design") && spec.designSkipped,
      confirmedAt: upTo(spec.confirmedAt, from - 1),
    },
    updatedAt: at,
  };
}

/** Whether any of the Spec's documents is approved. */
export const specHasApproved = (spec: GrillingSpec): boolean =>
  specPhases.some((phase) => spec.approved[phase] !== null);

/**
 * The Spec's files on the session's branch: each approved document, as
 * plain code writes it, in `.agents/specs/<slug>/`.
 */
export function specFiles(
  session: Pick<GrillingSessionRecord, "topic" | "id" | "spec">,
): FileToCommit[] {
  const spec = specOf(session);
  return specPhases.flatMap((phase) => {
    const content = specDocument(session.topic, spec, phase, spec.approved);
    return content === undefined
      ? []
      : [{ path: specDocumentPath(spec.slug, phase), content }];
  });
}

/** Whether `path` is one of a Spec's documents in its folder. */
export const inSpecFolder = (spec: GrillingSpec, path: string): boolean =>
  path.startsWith(`${specFolder(spec.slug)}/`);

/**
 * The session's issue drafts, from the approved tasks (FR-113): one per
 * task, in their order, each quoting the Acceptance Criteria it meets as
 * written in the approved requirements (or naming one they lack), and
 * blocked by the tasks it depends on. Undefined until the tasks are
 * approved.
 */
export function specIssueDrafts(
  session: Pick<GrillingSessionRecord, "id" | "spec">,
  at: Date,
): GrillingIssues | undefined {
  const spec = specOf(session);
  const tasks = spec.approved.tasks;
  if (tasks === null) {
    return undefined;
  }
  const folder = specFolder(spec.slug);
  return {
    drafts: tasks.map((task, index) => ({
      id: index + 1,
      title: task.title,
      whatToBuild: [
        task.description.trim(),
        "",
        `Task ${String(index + 1)} of the Spec in \`${folder}/\`${spec.designSkipped || spec.approved.design === null ? "" : ", built as its design.md says"}.`,
      ].join("\n"),
      acceptanceCriteria: task.meets.map(
        (id) => specCriterion(spec.approved.requirements, id) ?? id,
      ),
      blockedBy: task.dependsOn.filter((other) => other <= index),
      prdSections: [],
      adrs: [],
      filed: null,
    })),
    draftedAt: at.toISOString(),
    approvedAt: null,
    problem: null,
  };
}

/** "The requirements", from "the requirements". */
const capitalised = (text: string): string =>
  `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

/**
 * The Spec in the session section, from its stored data: where it is
 * kept, its phase, every approved document word for word, and the current
 * phase's draft.
 */
export function specSection(session: GrillingSessionRecord): string[] {
  const spec = specOf(session);
  const approved = specPhases.flatMap((phase) => {
    const text = specDocument(session.topic, spec, phase, spec.approved);
    return text === undefined
      ? []
      : [
          `#### ${specDocumentPath(spec.slug, phase)}, as the Owner approved it`,
          "",
          text.trimEnd(),
          "",
        ];
  });
  const draft = specDocument(session.topic, spec, spec.phase, spec.drafts);
  return [
    "### The Spec",
    "",
    `This session writes a Spec in \`${specFolder(spec.slug)}/\`, one phase at a time: requirements, then design, then tasks. AI Office commits each document on the session's branch once the Owner confirms it, and opens one pull request with them when the session ends. It writes no PRD, ADRs, glossary or process docs.`,
    "",
    `The Spec is on ${phaseName(spec.phase)}.${spec.designSkipped ? " The Owner skipped the design: there is no design.md." : ""} Only the Owner moves it on, by saying ${specConfirmWords(spec.phase)}; they may reopen an earlier phase, whose later phases are then drafted again.`,
    "",
    ...(approved.length === 0
      ? ["Nothing is approved yet.", ""]
      : [
          "The approved documents follow, word for word. They are settled: build on them, and do not change them in this phase.",
          "",
          ...approved,
        ]),
    `#### Your draft of ${phaseName(spec.phase)}`,
    "",
    draft === undefined ? "None yet." : draft.trimEnd(),
  ];
}

/** What a `/spec` turn is asked for of its current phase's document. */
export function specInstructions(session: GrillingSessionRecord): string[] {
  const spec = specOf(session);
  const write: Record<SpecPhase, string> = {
    requirements: `- \`spec.requirements\`: the whole requirements, \`{introduction, requirements}\`, each requirement \`{title, story, criteria}\`: \`story\` is one user story ("As a …, I want …, so that …"), and \`criteria\` its Acceptance Criteria, each one testable statement starting with its id, \`R<requirement>.<criterion>\` (R2.3 is requirement 2's third), in the form "R2.3 WHEN <trigger> THE SYSTEM SHALL <response>", or its "IF … THEN … SHALL", "WHILE … SHALL" or "WHERE … SHALL" forms. At most ${String(maxSpecRequirements)} requirements of at most ${String(maxSpecCriteria)} criteria each.`,
    design: `- \`spec.design\`: the whole design, \`{overview, architecture, data, errorHandling, testing}\`, each in Markdown: how it fits the system as it is, the data it keeps and changes, what can go wrong and what then happens, and how each Acceptance Criterion will be tested. Build on the approved requirements; design nothing they do not ask for.`,
    tasks: `- \`spec.tasks\`: the whole list, in the order they should be built, at most ${String(maxSpecTasks)}, each \`{title, description, meets, dependsOn}\`: a vertical slice that can be built, reviewed and merged on its own; \`meets\` the ids of the approved Acceptance Criteria it meets (every criterion met by some task); \`dependsOn\` the numbers of earlier tasks it needs first (1 for the first). Each task becomes one issue.`,
  };
  return [
    write[spec.phase],
    "- Give the draft again, whole, whenever answers change it; leave `spec` empty when it is unchanged. AI Office keeps only the current phase's document.",
    `- Once the draft is complete and nothing is left to ask, leave \`questions\` empty: AI Office asks the Owner to say ${specConfirmWords(spec.phase)}.`,
    "- `outline`, `adrs`, `processes`, `terms` and `guidelines`: leave them empty. This session writes only its Spec; AI Office drops any.",
  ];
}

/**
 * What a turn of a phase not yet drafted starts with: the Owner moved the
 * Spec on, so the turn drafts the new phase. None otherwise.
 */
export function specTurnLead(session: GrillingSessionRecord): string[] {
  const spec = specOf(session);
  if (spec.phase === "requirements" || spec.drafts[spec.phase] !== null) {
    return [];
  }
  const before =
    spec.phase === "tasks" && spec.designSkipped
      ? 'The Owner confirmed the requirements and said "skip design": there is no design.'
      : `The Owner confirmed ${spec.phase === "tasks" ? "the design" : "the requirements"}.`;
  return [
    `${before} Now draft ${phaseName(spec.phase)} from the approved documents above, asking the Owner only what ${phaseName(spec.phase)} need${spec.phase === "design" ? "s" : ""} them to decide.`,
    "",
  ];
}

/** The example of a turn's `spec`, for the current phase. */
export function specExample(session: GrillingSessionRecord): unknown {
  const spec = specOf(session);
  if (spec.phase === "requirements") {
    return {
      requirements: {
        introduction: "What the feature is for, in a paragraph.",
        requirements: [
          {
            title: "A short name",
            story: "As a <role>, I want <goal>, so that <benefit>.",
            criteria: [
              "R1.1 WHEN <trigger> THE SYSTEM SHALL <response>.",
              "R1.2 IF <condition> THEN THE SYSTEM SHALL <response>.",
            ],
          },
        ],
      },
    };
  }
  if (spec.phase === "design") {
    return {
      design: {
        overview: "The design in a paragraph.",
        architecture: "The parts and how they fit.",
        data: "What is kept, and its shape.",
        errorHandling: "What can go wrong, and what then happens.",
        testing: "How each criterion is tested.",
      },
    };
  }
  return {
    tasks: [
      {
        title: "Short and imperative",
        description: "What this slice builds, end to end.",
        meets: ["R1.1"],
        dependsOn: [],
      },
    ],
  };
}

/** What the chat says once a `/spec` phase has nothing left to ask. */
export function specConfirmationText(
  message: string,
  session: GrillingSessionRecord,
): string {
  const spec = specOf(session);
  const drafted = spec.drafts[spec.phase] !== null;
  return [
    ...(message.trim() === "" ? [] : [message.trim(), ""]),
    drafted
      ? `${capitalised(phaseName(spec.phase))} ${spec.phase === "design" ? "is" : "are"} drafted, and no open questions remain. Reply ${specConfirmWords(spec.phase)}${spec.phase === "tasks" ? ": they become the session's issue drafts, and the pull request with the Spec is opened" : ` to move on to ${phaseName(nextSpecPhase(spec.phase) ?? spec.phase)}`}, or say what to change.`
      : `No open questions remain, but ${phaseName(spec.phase)} ${spec.phase === "design" ? "is" : "are"} not drafted yet: send a message to have ${spec.phase === "design" ? "it" : "them"} drafted.`,
  ].join("\n");
}

/** Where a `/spec` session stands, in a sentence. */
export function specStanding(session: GrillingSessionRecord): string {
  const spec = specOf(session);
  return `The Spec is on ${phaseName(spec.phase)}.`;
}
