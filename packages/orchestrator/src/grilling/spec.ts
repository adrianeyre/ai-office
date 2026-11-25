import {
  acceptanceCriteriaProblems,
  acceptanceCriterionForms,
  acceptanceCriterionProblemLine,
  confirmSpecPhaseText,
  issueFilingOrder,
  maxSpecCriteria,
  maxSpecRequirements,
  maxSpecTasks,
  newGrillingSpec,
  nextSpecPhase,
  reopenSpecPhaseText,
  skipSpecDesignText,
  specCriterion,
  specDocument,
  specDocumentPath,
  specFolder,
  specPhaseBefore,
  specPhases,
  specTasksDocument,
  type GrillingIssueDraft,
  type GrillingIssues,
  type GrillingSpec,
  type SpecPhase,
  type SpecRequirements,
  type SpecTask,
  type SpecTaskIssue,
} from "@ai-office/shared";

import type { FileToCommit } from "../git/commit-file.ts";
import type { GrillingSessionRecord } from "./session.ts";
import { openInRound } from "./session.ts";
import type { GrillingStore } from "./store.ts";

// A `/spec` session's rules, in plain code (Guidelines, Specs and Hooks
// PRD, FR-113; ADR 0015). The session runs the Grilling Session's rounds
// in three phases (requirements, design, tasks), the Manager's Model
// drafting the current phase's document as it goes. The Owner moves it on
// in their own words, never the Model:
// - "confirm requirements" / "confirm design" / "confirm tasks" keeps the
//   phase's draft as its approved copy, once no open questions remain and
//   there is a draft, and moves to the next phase; the requirements only
//   once every Acceptance Criterion passes the checker (FR-114), the
//   refusal naming each one that fails and why;
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
//
// `/spec amend <slug>` (FR-117) starts a session that amends the Spec as
// the Owner approved it last (`amendedSpec`): back at the requirements,
// with each approved document loaded as its phase's draft, so the Owner
// changes what moved on and confirms each phase again. A task the amended
// tasks keep unchanged keeps the issue filed for it: `tasks.md` links it,
// and it is not drafted again (`carriedIssues`).

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
  const failing = draftCriteriaProblems(spec);
  return failing === undefined
    ? undefined
    : [
        `The requirements cannot be confirmed yet: ${failing}`,
        "",
        "Say what to change, or ask for them to be fixed, and the Manager drafts them again.",
      ].join("\n");
}

/**
 * The draft requirements' failing Acceptance Criteria, while the Spec is
 * on the requirements (`criteriaProblems`); undefined otherwise.
 */
const draftCriteriaProblems = (spec: GrillingSpec): string | undefined =>
  spec.phase === "requirements" && spec.drafts.requirements !== null
    ? criteriaProblems(spec.drafts.requirements)
    : undefined;

/**
 * Every Acceptance Criterion of `requirements` that fails the checker
 * (FR-114), as a sentence and a line each, saying why; undefined when
 * every one passes.
 */
export function criteriaProblems(
  requirements: SpecRequirements,
): string | undefined {
  const problems = acceptanceCriteriaProblems(requirements);
  if (problems.length === 0) {
    return undefined;
  }
  return [
    `${problems.length === 1 ? "1 Acceptance Criterion fails" : `${String(problems.length)} Acceptance Criteria fail`} the check. Each is one testable statement starting with an id of its own, R<requirement>.<number> (R2.3 is one of requirement 2's), in the form ${acceptanceCriterionForms}.`,
    "",
    ...problems.map(acceptanceCriterionProblemLine),
  ].join("\n");
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
  session: Pick<GrillingSessionRecord, "topic" | "id" | "spec" | "issues">,
): FileToCommit[] {
  const spec = specOf(session);
  return specPhases.flatMap((phase) => {
    const content =
      phase === "tasks" && spec.approved.tasks !== null
        ? specTasksDocument(
            session.topic,
            spec.slug,
            spec.approved.tasks,
            specTaskIssues(session),
          )
        : specDocument(session.topic, spec, phase, spec.approved);
    return content === undefined
      ? []
      : [{ path: specDocumentPath(spec.slug, phase), content }];
  });
}

/**
 * The issue filed for each approved task, by its place (FR-117): the
 * draft of its number (1 for the first task), once filed; or, in a
 * session amending a Spec, the issue a task the amendment kept unchanged
 * had already. A task whose draft the Owner dropped has none.
 */
export function specTaskIssues(
  session: Pick<GrillingSessionRecord, "spec" | "issues">,
): (SpecTaskIssue | undefined)[] {
  const tasks = session.spec?.approved.tasks ?? [];
  const drafts = session.issues?.drafts ?? [];
  const carried =
    session.spec === null ? [] : carriedIssues(session.spec, tasks);
  return tasks.map((_task, index) => {
    const filed = drafts.find(({ id }) => id === index + 1)?.filed;
    return filed == null
      ? carried[index]
      : { number: filed.number, url: filed.url };
  });
}

/** Whether two tasks say the same: title, description and criteria met. */
const sameTask = (
  task: Pick<SpecTask, "title" | "description" | "meets">,
  other: Pick<SpecTask, "title" | "description" | "meets">,
): boolean =>
  task.title.trim() === other.title.trim() &&
  task.description.trim() === other.description.trim() &&
  task.meets.join(",") === other.meets.join(",");

/**
 * In a session amending a Spec (FR-117), the issue each of `tasks` keeps
 * from the Spec it amends, by place: a task the amendment left as it was
 * (its title, description and criteria) keeps the issue filed for it,
 * each issue once. None for a new or changed task, or a new Spec.
 */
export function carriedIssues(
  spec: GrillingSpec,
  tasks: readonly SpecTask[],
): (SpecTaskIssue | undefined)[] {
  const earlier = [...(spec.amends?.tasks ?? [])];
  return tasks.map((task) => {
    const index = earlier.findIndex((before) => sameTask(task, before));
    if (index < 0) {
      return undefined;
    }
    const [kept] = earlier.splice(index, 1);
    return kept?.issue;
  });
}

/**
 * The Spec of a session amending the one `earlier` approved (FR-117): in
 * the same folder, back at the requirements, with each document `earlier`
 * approved loaded as its phase's draft and nothing approved yet, and the
 * issues its tasks had, which tasks kept unchanged keep.
 */
export function amendedSpec(
  earlier: Pick<GrillingSessionRecord, "id" | "spec" | "issues">,
): GrillingSpec {
  const spec = specOf(earlier);
  const issues = specTaskIssues(earlier);
  return {
    ...newGrillingSpec(spec.slug),
    drafts: {
      requirements: spec.approved.requirements,
      design: spec.approved.design,
      tasks: spec.approved.tasks,
    },
    amends: {
      sessionId: earlier.id,
      tasks: (spec.approved.tasks ?? []).flatMap(
        ({ title, description, meets }, index) => {
          const issue = issues[index];
          return issue === undefined
            ? []
            : [{ title, description, meets: [...meets], issue: { ...issue } }];
        },
      ),
    },
  };
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
  // An amendment's unchanged tasks keep their issues (FR-117).
  const carried = carriedIssues(spec, tasks);
  return {
    drafts: tasks.flatMap((task, index) => {
      if (carried[index] !== undefined) {
        return [];
      }
      const built = task.dependsOn.flatMap((other) => {
        const issue = other <= index ? carried[other - 1] : undefined;
        return issue === undefined
          ? []
          : [`task ${String(other)} (#${String(issue.number)})`];
      });
      return [
        {
          id: index + 1,
          title: task.title,
          whatToBuild: [
            task.description.trim(),
            "",
            `Task ${String(index + 1)} of the Spec in \`${folder}/\`${spec.designSkipped || spec.approved.design === null ? "" : ", built as its design.md says"}.${built.length === 0 ? "" : ` It builds on ${built.join(" and ")}, filed before the Spec was amended.`}`,
          ].join("\n"),
          acceptanceCriteria: task.meets.map(
            (id) => specCriterion(spec.approved.requirements, id) ?? id,
          ),
          blockedBy: task.dependsOn.filter(
            (other) => other <= index && carried[other - 1] === undefined,
          ),
          prdSections: [],
          adrs: [],
          filed: null,
        },
      ];
    }),
    draftedAt: at.toISOString(),
    approvedAt: null,
    problem: null,
  };
}

/** A draft as it would be filed: everything but whether it was. */
const draftContent = (draft: GrillingIssueDraft) => ({
  id: draft.id,
  title: draft.title.trim(),
  whatToBuild: draft.whatToBuild.trim(),
  acceptanceCriteria: draft.acceptanceCriteria.map((criterion) =>
    criterion.trim(),
  ),
  blockedBy: [...new Set(draft.blockedBy)].sort((a, b) => a - b),
  prdSections: draft.prdSections.map((section) => section.trim()),
  adrs: draft.adrs.map((adr) => adr.trim()),
});

/**
 * Whether the Owner edited the Spec's issue drafts after confirming its
 * tasks (FR-115): any draft changed, added, dropped or reordered from
 * those the confirmed tasks make. Then the Spec's Batch follows the
 * Floor's plan approval, rather than standing approved by the tasks.
 */
export function specDraftsEdited(
  session: Pick<GrillingSessionRecord, "id" | "spec" | "issues">,
): boolean {
  const confirmed = specIssueDrafts(session, new Date(0));
  const drafts = session.issues?.drafts;
  if (confirmed === undefined || drafts === undefined) {
    return true;
  }
  return (
    JSON.stringify(drafts.map(draftContent)) !==
    JSON.stringify(confirmed.drafts.map(draftContent))
  );
}

/** One issue of a Spec's Batch: its number, and the issues it waits on. */
export interface SpecBatchIssue {
  readonly issue: number;
  readonly dependsOn: readonly number[];
}

/**
 * The issues filed for a Spec's drafts, in the order its Batch's Plan
 * works them (FR-115): the drafts' order, which is `tasks.md`'s unless
 * the Owner reordered them, each after those it is blocked by, and
 * depending on the issues filed for them. Drafts not filed are left out.
 */
export function specBatchIssues(
  issues: Pick<GrillingIssues, "drafts">,
): SpecBatchIssue[] {
  const order = issueFilingOrder(issues.drafts) ?? issues.drafts;
  const filedFor = new Map(
    issues.drafts.map(({ id, filed }) => [id, filed?.number]),
  );
  return order.flatMap(({ filed, blockedBy }) =>
    filed === null
      ? []
      : [
          {
            issue: filed.number,
            dependsOn: blockedBy.flatMap((id) => {
              const number = filedFor.get(id);
              return number === undefined ? [] : [number];
            }),
          },
        ],
  );
}

/** The issues filed from the Floor's Specs (FR-115): clear by construction. */
export async function specIssues(
  store: Pick<GrillingStore, "list">,
  floorId: string,
): Promise<ReadonlySet<number>> {
  return new Set(
    (await store.list(floorId)).flatMap(({ spec, issues }) =>
      spec === null
        ? []
        : (issues?.drafts.flatMap(({ filed }) =>
            filed === null ? [] : [filed.number],
          ) ?? []),
    ),
  );
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
    ...amendSection(spec),
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
    ...draftCriteriaSection(spec),
  ];
}

/**
 * What the session section says of an amendment (FR-117): the Spec was
 * approved before, and code has moved on since; each draft starts as the
 * approved document. None for a new Spec.
 */
function amendSection(spec: GrillingSpec): string[] {
  if (spec.amends === undefined) {
    return [];
  }
  return [
    `This session amends the Spec the Owner approved in Grilling Session ${String(spec.amends.sessionId)}, as the code has moved on since. Each phase's draft starts as that session's approved document: ask the Owner what has changed, keep what still holds, and give the whole draft again with their changes. The Owner confirms each phase again, changed or not, and the pull request updates the Spec's files. Once the requirements change, bring the design and the tasks in line with them. A task kept exactly as it was keeps the issue filed for it; a new or changed task becomes a new issue.`,
    "",
  ];
}

/**
 * The draft requirements' Acceptance Criteria that fail the checker, for
 * the Manager to fix in its next draft; none when they pass, or on a
 * later phase.
 */
function draftCriteriaSection(spec: GrillingSpec): string[] {
  const failing = draftCriteriaProblems(spec);
  return failing === undefined
    ? []
    : [
        "",
        "#### Acceptance Criteria in your draft that fail the check",
        "",
        failing,
        "",
        "The Owner cannot confirm the requirements until every one passes: fix each in your next draft, giving the requirements again, whole.",
      ];
}

/** What a `/spec` turn is asked for of its current phase's document. */
export function specInstructions(session: GrillingSessionRecord): string[] {
  const spec = specOf(session);
  const write: Record<SpecPhase, string> = {
    requirements: `- \`spec.requirements\`: the whole requirements, \`{introduction, requirements}\`, each requirement \`{title, story, criteria}\`: \`story\` is one user story ("As a …, I want …, so that …"), and \`criteria\` its Acceptance Criteria, each one testable statement starting with its id, \`R<requirement>.<criterion>\` (R2.3 is requirement 2's third), in the form "R2.3 WHEN <trigger> THE SYSTEM SHALL <response>", or its "IF <condition> THEN THE SYSTEM SHALL <response>", "WHILE <state> THE SYSTEM SHALL <response>" or "WHERE <option> THE SYSTEM SHALL <response>" forms. At most ${String(maxSpecRequirements)} requirements of at most ${String(maxSpecCriteria)} criteria each.
- AI Office checks every criterion in plain code, and the Owner cannot confirm the requirements while any fails: its id starts with a capital R and its own requirement's number, and no other criterion has it; its keywords (WHEN, IF, THEN, WHILE, WHERE, THE SYSTEM SHALL) are in capitals; and it says SHALL once, one behaviour per criterion. Anything that is not such a statement (context, notes, examples) goes in the story or the introduction, never in \`criteria\`.`,
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
  const failing = draftCriteriaProblems(spec);
  return [
    ...(message.trim() === "" ? [] : [message.trim(), ""]),
    failing !== undefined
      ? `The requirements are drafted, and no open questions remain, but they cannot be confirmed yet: ${failing}\n\nSay what to change, or ask for them to be fixed, and the Manager drafts them again.`
      : drafted
        ? `${capitalised(phaseName(spec.phase))} ${spec.phase === "design" ? "is" : "are"} drafted, and no open questions remain. Reply ${specConfirmWords(spec.phase)}${spec.phase === "tasks" ? ": they become the session's issue drafts, and the pull request with the Spec is opened" : ` to move on to ${phaseName(nextSpecPhase(spec.phase) ?? spec.phase)}`}, or say what to change.`
        : `No open questions remain, but ${phaseName(spec.phase)} ${spec.phase === "design" ? "is" : "are"} not drafted yet: send a message to have ${spec.phase === "design" ? "it" : "them"} drafted.`,
  ].join("\n");
}

/** Where a `/spec` session stands, in a sentence. */
export function specStanding(session: GrillingSessionRecord): string {
  const spec = specOf(session);
  return `The Spec is on ${phaseName(spec.phase)}.`;
}
