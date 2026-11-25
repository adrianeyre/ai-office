import { posix } from "node:path";

import {
  guidelinesLabelled,
  type Guideline,
  type GuidelineInclusion,
  type GuidelineTask,
} from "@ai-office/shared";

// Which of a Floor's approved Guidelines a task gets (Guidelines, Specs and
// Hooks PRD, FR-105, FR-108), in plain code:
//
// - `always`: every task, the Manager's included.
// - `fileMatch`: for the work Stage and the designer, those whose patterns
//   match a file the Batch's Plan expects the issue to change; for review,
//   QA and docs, a file the pull request changes. The work Stage and the
//   designer also get the rest of the Floor's `fileMatch` Guidelines,
//   listed by their patterns and description, to read before changing a
//   matching file.
// - `manual`: when the issue has a `guideline:<name>` label.
// - The Manager's triage, Plan and chat follow the `always` ones, and are
//   told the names and descriptions of the rest.
//
// The Guidelines a task follows share one budget of characters (12,000 by
// default, `promptBudgetFor`). Over it, `fileMatch` Guidelines are left out
// first, then `manual` ones, then `always` ones, the largest first within
// each, and by name between two of a size: the same Guidelines give the
// same choice every time.

/** A path as Git names it, from the top of the repository. */
const normalised = (path: string): string =>
  path
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");

/**
 * Whether a repository path matches a Guideline's glob, as Node's
 * `path.matchesGlob` reads it (`*`, `**`, `?`, `[…]` and `{a,b}`), from the
 * top of the repository.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const glob = normalised(pattern);
  const file = normalised(path);
  if (glob === "" || file === "") {
    return false;
  }
  try {
    return posix.matchesGlob(file, glob);
  } catch {
    // A glob Node cannot read matches nothing.
    return false;
  }
}

/** Whether any of `files` matches any of a Guideline's patterns. */
export const matchesAnyFile = (
  guideline: Pick<Guideline, "fileMatchPatterns">,
  files: readonly string[],
): boolean =>
  guideline.fileMatchPatterns.some((pattern) =>
    files.some((file) => matchesPattern(pattern, file)),
  );

/** The Manager's tasks: triage, the Plan and the chat. */
export const isManagerTask = (task: GuidelineTask): boolean =>
  task === "triage" || task === "plan" || task === "chat";

/**
 * Whether a task chooses its `fileMatch` Guidelines by the files its
 * Batch's Plan expects the issue to change, and is given the rest of them
 * to read as it needs: the work Stage and the designer.
 */
export const choosesByPlan = (task: GuidelineTask): boolean =>
  task === "work" || task === "design";

/** What a task is, for choosing its Guidelines. */
export interface GuidelineChoice {
  readonly task: GuidelineTask;
  /**
   * The files that choose its `fileMatch` Guidelines: those the Plan
   * expects the issue to change (work, design), or those the pull request
   * changes (review, QA, docs). None for the Manager's.
   */
  readonly files: readonly string[];
  /** The issue's labels: `guideline:<name>` asks for a `manual` one. */
  readonly labels: readonly string[];
}

/** A task's Guidelines, by name within each list. */
export interface ChosenGuidelines<Chosen extends Guideline> {
  /** Those it follows, in full. */
  readonly followed: readonly Chosen[];
  /**
   * Those it is only told of: for the work Stage and the designer, the
   * other `fileMatch` ones, to read before changing a matching file; for
   * the Manager, every one but the `always` ones, by name and
   * description. None otherwise.
   */
  readonly listed: readonly Chosen[];
}

/** Chooses a task's Guidelines from the Floor's approved ones (FR-105). */
export function chooseGuidelines<Chosen extends Guideline>(
  guidelines: readonly Chosen[],
  choice: GuidelineChoice,
): ChosenGuidelines<Chosen> {
  const byName = [...guidelines].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (isManagerTask(choice.task)) {
    return {
      followed: byName.filter(({ inclusion }) => inclusion === "always"),
      listed: byName.filter(({ inclusion }) => inclusion !== "always"),
    };
  }
  const labelled = new Set(guidelinesLabelled(choice.labels));
  const followed: Chosen[] = [];
  const listed: Chosen[] = [];
  for (const guideline of byName) {
    if (
      guideline.inclusion === "always" ||
      (guideline.inclusion === "manual" && labelled.has(guideline.name)) ||
      (guideline.inclusion === "fileMatch" &&
        matchesAnyFile(guideline, choice.files))
    ) {
      followed.push(guideline);
    } else if (
      guideline.inclusion === "fileMatch" &&
      choosesByPlan(choice.task)
    ) {
      listed.push(guideline);
    }
  }
  return { followed, listed };
}

/** The characters a Guideline takes of the budget: its whole file. */
export const guidelineCharacters = (guideline: Pick<Guideline, "content">) =>
  guideline.content.length;

/** Which go first over the budget: the lower, the sooner. */
const keptLongest: Readonly<Record<GuidelineInclusion, number>> = {
  fileMatch: 0,
  manual: 1,
  always: 2,
};

/** Guidelines within a budget, and those left out. */
export interface GuidelinesWithin<Chosen extends Guideline> {
  /** Those kept, in the order given. */
  readonly kept: readonly Chosen[];
  /** Those left out, in the order they went: largest first. */
  readonly leftOut: readonly Chosen[];
  /** The characters all of them had together, before any was left out. */
  readonly characters: number;
}

/**
 * The Guidelines of `followed` that fit in `budget` characters together
 * (FR-108): over it, `fileMatch` ones go first, then `manual`, then
 * `always`, the largest first within each, by name between two of a
 * size, until the rest fit.
 */
export function guidelinesWithin<Chosen extends Guideline>(
  followed: readonly Chosen[],
  budget: number,
): GuidelinesWithin<Chosen> {
  const characters = followed.reduce(
    (sum, guideline) => sum + guidelineCharacters(guideline),
    0,
  );
  if (characters <= budget) {
    return { kept: [...followed], leftOut: [], characters };
  }
  const order = [...followed].sort(
    (a, b) =>
      keptLongest[a.inclusion] - keptLongest[b.inclusion] ||
      guidelineCharacters(b) - guidelineCharacters(a) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const leftOut = new Set<Chosen>();
  let total = characters;
  for (const guideline of order) {
    if (total <= budget) {
      break;
    }
    leftOut.add(guideline);
    total -= guidelineCharacters(guideline);
  }
  return {
    kept: followed.filter((guideline) => !leftOut.has(guideline)),
    leftOut: order.filter((guideline) => leftOut.has(guideline)),
    characters,
  };
}
