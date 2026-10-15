import { mergePolicyOverrides } from "./floors.ts";

// The work pipeline's labels (PRD FR-18). An issue's labels on GitHub are
// the source of truth for where it is: one stage label, plus `in-progress`
// while an Agent holds it. The first four are the Stages' labels (ADR
// 0003): `needs-work`, `needs-review`, `needs-qa` and `needs-docs`. Issues come in labelled `ai-office` (FR-8), and
// may override their Floor's Merge Policy with a label of their own (FR-29).

/** The label that asks AI Office to work an issue. */
export const intakeLabel = "ai-office";

/** The label an issue has while an Agent holds it. */
export const inProgressLabel = "in-progress";

/** Where an issue is in the pipeline, in order, then the way out. */
export const pipelineStages = [
  "needs-work",
  "needs-review",
  "needs-qa",
  "needs-docs",
  "ready-to-merge",
  "needs-human",
] as const;
export type PipelineStage = (typeof pipelineStages)[number];

export const isPipelineStage = (label: string): label is PipelineStage =>
  (pipelineStages as readonly string[]).includes(label);

/** A label AI Office creates on each Floor's repository. */
export interface PipelineLabel {
  readonly name: string;
  /** Six hex digits, without `#`. */
  readonly color: string;
  readonly description: string;
}

/** Every label the pipeline uses, as each Floor's repository gets them. */
export const pipelineLabels: readonly PipelineLabel[] = [
  {
    name: intakeLabel,
    color: "5319e7",
    description: "AI Office: work this issue",
  },
  {
    name: "needs-work",
    color: "1d76db",
    description: "AI Office: waiting for its work",
  },
  {
    name: "needs-review",
    color: "0e8a16",
    description: "AI Office: waiting for review",
  },
  {
    name: "needs-qa",
    color: "fbca04",
    description: "AI Office: waiting for QA",
  },
  {
    name: "needs-docs",
    color: "c5def5",
    description: "AI Office: waiting for docs",
  },
  {
    name: "ready-to-merge",
    color: "2ea44f",
    description: "AI Office: passed its pipeline",
  },
  {
    name: "needs-human",
    color: "d93f0b",
    description: "AI Office: handed to the Owner",
  },
  {
    name: inProgressLabel,
    color: "bfd4f2",
    description: "AI Office: an Agent is working on it",
  },
  {
    name: mergePolicyOverrides.auto_merge,
    color: "0e8a16",
    description: "AI Office: merge automatically once every check passes",
  },
  {
    name: mergePolicyOverrides.send_to_me,
    color: "d4c5f9",
    description: "AI Office: send the pull request to the Owner to merge",
  },
];

/**
 * Labels the pipeline has renamed, old name first (ADR 0003: `needs-code`
 * became `needs-work`). A Floor's repository has its old label renamed, so
 * its issues keep it under the new name.
 */
export const renamedPipelineLabels: readonly {
  readonly from: string;
  readonly to: PipelineLabel;
}[] = pipelineLabels
  .filter(({ name }) => name === "needs-work")
  .map((to) => ({ from: "needs-code", to }));
