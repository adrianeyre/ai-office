import { parseGuideline, type GuidelineTask } from "@ai-office/shared";

import { guidelineContentHash, type ApprovedGuideline } from "./approval.ts";
import { chooseGuidelines, guidelinesWithin } from "./choose.ts";
import type { GivenGuidelines } from "./prompt.ts";

// Guidelines for tests: approved Guidelines from their front matter and
// rules, and a task's Guidelines chosen from them as AI Office would.

/** A Guideline the Owner approved, from its front matter lines and rules. */
export function approvedGuideline(
  name: string,
  frontMatter: readonly string[],
  body: string,
): ApprovedGuideline {
  const content =
    frontMatter.length === 0
      ? `${body}\n`
      : ["---", ...frontMatter, "---", "", body, ""].join("\n");
  const parsed = parseGuideline(`${name}.md`, content);
  if (!parsed.ok) {
    throw new Error(parsed.refused.reason);
  }
  return {
    ...parsed.guideline,
    contentHash: guidelineContentHash(content),
    approval: "owner_merge",
    current: true,
  };
}

/** `tech`: always, for every task. */
export const techGuideline = approvedGuideline(
  "tech",
  ["description: The stack and its tools."],
  "Use pnpm, never npm.\nWrite strict TypeScript.",
);

/** `migrations`: for `packages/db/**`. */
export const migrationsGuideline = approvedGuideline(
  "migrations",
  [
    "inclusion: fileMatch",
    'fileMatchPattern: "packages/db/**"',
    "description: How migrations are written.",
  ],
  "Write each migration as plain SQL, never edited once merged.",
);

/** `web`: for the web app's components and styles. */
export const webGuideline = approvedGuideline(
  "web",
  [
    "inclusion: fileMatch",
    "fileMatchPattern:",
    '  - "apps/web/**/*.tsx"',
    '  - "apps/web/**/*.css"',
  ],
  "Every component has a story.",
);

/** `release`: only for an issue labelled `guideline:release`. */
export const releaseGuideline = approvedGuideline(
  "release",
  ["inclusion: manual", "description: Cutting a release."],
  "Bump the version in package.json and add a CHANGELOG entry.",
);

/** A Floor's Guidelines: one of each kind. */
export const floorGuidelines: readonly ApprovedGuideline[] = [
  techGuideline,
  migrationsGuideline,
  webGuideline,
  releaseGuideline,
];

/** A task's Guidelines, as `TaskGuidelines` would give them. */
export function givenGuidelines(
  task: GuidelineTask,
  options: {
    readonly files?: readonly string[];
    readonly labels?: readonly string[];
    readonly budget?: number;
    readonly guidelines?: readonly ApprovedGuideline[];
  } = {},
): GivenGuidelines {
  const chosen = chooseGuidelines(options.guidelines ?? floorGuidelines, {
    task,
    files: options.files ?? [],
    labels: options.labels ?? [],
  });
  const budget = options.budget ?? 12_000;
  const within = guidelinesWithin(chosen.followed, budget);
  return {
    task,
    followed: within.kept,
    listed: chosen.listed,
    leftOut: within.leftOut,
    budget,
  };
}
