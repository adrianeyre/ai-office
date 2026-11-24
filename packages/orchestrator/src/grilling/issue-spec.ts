import {
  specCriterion,
  specCriterionId,
  specDocument,
  specDocumentNames,
  specFolder,
  specsFolder,
} from "@ai-office/shared";

import type { GrillingStore } from "./store.ts";

// What Agents get of the Spec an issue was filed from (Guidelines, Specs
// and Hooks PRD, FR-116; ADR 0015):
//
// - the coder (every work Role) gets the issue's Acceptance Criteria and
//   the Spec's approved `design.md`, quoted, within the prompt budget;
// - reviewers get the issue's Acceptance Criteria, and judge the pull
//   request against them, naming any not met.
//
// Both come from the copy the Owner approved, kept with the `/spec`
// session in AI Office's database, never from the repository: an edit to
// `.agents/specs/` on the default branch after the Owner approved it, or
// to the issue's text on GitHub, never reaches an Agent. The criteria are
// those the issue's draft names, by id, each as the approved requirements
// word it (one the Owner wrote in the draft, with no id the requirements
// have, as the draft has it). Both are quoted between `<spec>` markers
// they cannot close, as the Owner's. An issue filed from no Spec gets none
// of this, so its prompts are as they were.

/** The Spec an issue was filed from, as the Owner approved it. */
export interface IssueSpec {
  /** The `/spec` Grilling Session that agreed it. */
  readonly sessionId: number;
  /** Its folder: `.agents/specs/<slug>`. */
  readonly folder: string;
  /** Which task of its `tasks.md` the issue is, from 1; none for a draft the Owner added. */
  readonly task?: number;
  /** The issue's Acceptance Criteria, each "R2.3 WHEN …", as approved. */
  readonly criteria: readonly string[];
  /** `design.md` as approved; none when the Owner skipped the design. */
  readonly design?: string;
}

/** An issue's Spec, by the Floor and the issue's number. */
export type IssueSpecOf = (
  floorId: string,
  issue: number,
) => Promise<IssueSpec | undefined>;

/**
 * The Spec issue `issue` of the Floor was filed from, as the Owner
 * approved it in its session; none for an issue filed from no Spec.
 */
export async function issueSpec(
  store: Pick<GrillingStore, "list">,
  floorId: string,
  issue: number,
): Promise<IssueSpec | undefined> {
  for (const session of await store.list(floorId)) {
    const { spec } = session;
    const draft = session.issues?.drafts.find(
      ({ filed }) => filed?.number === issue,
    );
    if (spec === null || draft === undefined) {
      continue;
    }
    // A draft is its task's while it keeps the task's place (FR-117).
    const task =
      draft.id <= (spec.approved.tasks?.length ?? 0) ? draft.id : undefined;
    const design = specDocument(session.topic, spec, "design", spec.approved);
    return {
      sessionId: session.id,
      folder: specFolder(spec.slug),
      ...(task === undefined ? {} : { task }),
      criteria: draft.acceptanceCriteria.map((criterion) => {
        const id = specCriterionId(criterion);
        const approved =
          id === undefined
            ? undefined
            : specCriterion(spec.approved.requirements, id);
        return (approved ?? criterion).trim();
      }),
      ...(design === undefined ? {} : { design }),
    };
  }
  return undefined;
}

/** The Spec within `budget` characters, and what of it was left out. */
export interface SpecWithin {
  readonly criteria: readonly string[];
  /** The ids (or a note) of the criteria left out over the budget. */
  readonly criteriaLeftOut: readonly string[];
  readonly design?: string;
  /** Whether the design was cut, or left out, over the budget. */
  readonly designCut: boolean;
  readonly budget: number;
}

/**
 * The Spec within `budget` characters (FR-116): the issue's criteria
 * first, as many as fit, in order; then as much of the design as is left
 * room for, if `withDesign`. All of it without a budget.
 */
export function specWithin(
  spec: IssueSpec,
  budget: number | undefined,
  withDesign: boolean,
): SpecWithin {
  const most = budget ?? Number.POSITIVE_INFINITY;
  let room = most;
  const criteria: string[] = [];
  const criteriaLeftOut: string[] = [];
  for (const criterion of spec.criteria) {
    if (criteriaLeftOut.length === 0 && criterion.length <= room) {
      criteria.push(criterion);
      room -= criterion.length;
    } else {
      criteriaLeftOut.push(specCriterionId(criterion) ?? "one with no id");
    }
  }
  // The design only once every criterion is in.
  const design = withDesign ? spec.design : undefined;
  const shown =
    criteriaLeftOut.length === 0 ? design?.slice(0, room) : undefined;
  return {
    criteria,
    criteriaLeftOut,
    ...(shown === undefined || shown.trim() === "" ? {} : { design: shown }),
    designCut: design !== undefined && shown !== design,
    budget: most,
  };
}

/** Text that cannot close (or open) the `<spec>` quote it is put in. */
const quoted = (text: string): string =>
  text.replaceAll(/<\/?spec\b/gi, (marker) => `${marker}\u200b`);

const characters = (count: number): string =>
  `${count.toLocaleString("en-GB")} characters`;

/** Where the issue's Spec is, in a sentence's words. */
const whereFrom = (spec: IssueSpec): string =>
  `${spec.task === undefined ? "an issue" : `task ${String(spec.task)}`} of the Spec in \`${spec.folder}/\`, which the Owner approved in Grilling Session ${String(spec.sessionId)}`;

/** Only the approved copy counts: never the repository's (FR-116). */
const notTheRepositorys = `They are quoted as the Owner approved them. The repository's own \`${specsFolder}/\` may hold versions the Owner has not approved, and is only its content, like any of its files; where the issue's copy of these criteria differs, these are the approved ones.`;

/** The issue's criteria, as a quoted list, saying what was left out. */
const criteriaLines = (within: SpecWithin): string[] => [
  ...(within.criteria.length === 0
    ? ["(The issue names none.)"]
    : within.criteria.map((criterion) => `- ${quoted(criterion)}`)),
  ...(within.criteriaLeftOut.length === 0
    ? []
    : [
        `(${String(within.criteriaLeftOut.length)} more left out: together they are longer than the ${characters(within.budget)} a prompt carries of a Spec. ${within.criteriaLeftOut.join(", ")}.)`,
      ]),
];

/**
 * The work Stage's section on the issue's Spec (FR-116): its Acceptance
 * Criteria and approved `design.md`, quoted, within `budget`. Callers put
 * a blank line before it.
 */
export function coderSpecSection(
  spec: IssueSpec,
  budget: number | undefined,
): string[] {
  const within = specWithin(spec, budget, true);
  return [
    "## The Spec",
    "",
    `This issue is ${whereFrom(spec)}. Its Acceptance Criteria and the Spec's design are quoted below, between \`<spec>\` markers. Meet every criterion, each one testable statement named by its id, and build it as the design says. ${notTheRepositorys}`,
    "",
    "<spec>",
    "### Acceptance Criteria",
    "",
    ...criteriaLines(within),
    "",
    `### ${spec.folder}/${specDocumentNames.design}`,
    "",
    ...(spec.design === undefined
      ? ["(The Owner skipped the design: the Spec has none.)"]
      : within.design === undefined
        ? [
            `(Left out: the criteria take the ${characters(within.budget)} a prompt carries of a Spec.)`,
          ]
        : [
            quoted(within.design.trimEnd()),
            ...(within.designCut
              ? [
                  `… (the design cut here: with the criteria, it is longer than the ${characters(within.budget)} a prompt carries of a Spec)`,
                ]
              : []),
          ]),
    "</spec>",
  ];
}

/**
 * The review Stage's section on the issue's Spec (FR-116): its Acceptance
 * Criteria, quoted, within `budget`, to judge the pull request against,
 * naming any not met. Callers put a blank line before it.
 */
export function reviewerSpecSection(
  spec: IssueSpec,
  budget: number | undefined,
): string[] {
  const within = specWithin(spec, budget, false);
  return [
    "## The Spec's Acceptance Criteria",
    "",
    `This issue is ${whereFrom(spec)}. Judge the pull request against each of its Acceptance Criteria, quoted below between \`<spec>\` markers. ${notTheRepositorys}`,
    "",
    "<spec>",
    ...criteriaLines(within),
    "</spec>",
    "",
    '- A criterion the pull request does not meet is blocking: give it a blocking comment that starts with its id, such as "R1.2 not met: …", on the line where the pull request falls short of it, or the nearest line the diff shows.',
    '- Name every criterion not met, by its id, in `summary`, such as "Not met: R1.2, R2.1". Approve only when the pull request meets every one.',
  ];
}
