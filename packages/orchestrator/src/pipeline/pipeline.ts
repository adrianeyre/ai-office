import type { EventBus } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import {
  designerRole,
  inProgressLabel,
  isPipelineStage,
  stageLabels as labelOfStage,
  stageOfLabel,
  type PipelineStage,
  type Role,
  type Stage,
} from "@ai-office/shared";

// The work pipeline (PRD FR-18): an issue moves through stage labels,
// `needs-work` → `needs-review` → `needs-qa` → `needs-docs` →
// `ready-to-merge`, or out to `needs-human`, and carries `in-progress`
// while an Agent holds it. The first four are the Stages' labels (ADR
// 0003): work, review, QA and docs. The labels on GitHub are the source of truth:
// every move reads them first, is refused unless it is in `transitions`,
// is applied on GitHub, and is then recorded as an event.

/** Why a move was refused. */
export const pipelineErrorCodes = {
  /** The move is not one the pipeline allows from where the issue is. */
  illegalTransition: "illegal_transition",
  /** An Agent already holds the issue. */
  held: "held",
  /** Nobody holds the issue, so there is nothing to release. */
  notHeld: "not_held",
  /** The issue is at no stage, or one where no Agent works. */
  notWorkable: "not_workable",
  /** The issue has more than one stage label, so where it is is unclear. */
  conflictingLabels: "conflicting_labels",
} as const;
export type PipelineErrorCode =
  (typeof pipelineErrorCodes)[keyof typeof pipelineErrorCodes];

export class PipelineError extends Error {
  readonly code: PipelineErrorCode;

  constructor(code: PipelineErrorCode, message: string) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
  }
}

/**
 * Every move the pipeline allows, by where the issue is (`null`: not in the
 * pipeline yet). Forward through the stages, skipping QA or docs when a
 * Floor has no Agent for them; back to `needs-work` when a reviewer or QA
 * wants changes (the Review Loop); back to `needs-review` from
 * `ready-to-merge` when the Merge Policy finds commits pushed after the
 * reviewers approved (P1-1); and out to `needs-human` from anywhere but
 * where it already is. Only the Owner moves an issue out of
 * `needs-human`, on GitHub.
 */
export const transitions: ReadonlyMap<
  PipelineStage | null,
  readonly PipelineStage[]
> = new Map<PipelineStage | null, readonly PipelineStage[]>([
  [null, ["needs-work"]],
  ["needs-work", ["needs-review", "needs-human"]],
  [
    "needs-review",
    ["needs-work", "needs-qa", "needs-docs", "ready-to-merge", "needs-human"],
  ],
  ["needs-qa", ["needs-work", "needs-docs", "ready-to-merge", "needs-human"]],
  ["needs-docs", ["ready-to-merge", "needs-human"]],
  ["ready-to-merge", ["needs-review", "needs-human"]],
  ["needs-human", []],
]);

/** The Stages an issue may still pass through after each, in order. */
const laterStages = {
  "needs-review": ["qa", "docs"],
  "needs-qa": ["docs"],
  "needs-docs": [],
} as const satisfies Record<string, readonly Stage[]>;

/**
 * The Roles whose Agents work a sandbox stage (FR-18, FR-19) after its
 * Stage's own Agents, in turn, on the one stage label (ADR 0003): at QA,
 * the QA Stage's Agents check the change, then a designer, on a Floor with
 * one, reviews its UI against the repository's style guide (FR-10). Work
 * for one of these names its Role (`QueuedWork`'s `role`).
 */
export const stageRoles: Readonly<
  Partial<Record<PipelineStage, readonly Role[]>>
> = {
  "needs-qa": [designerRole],
};

/**
 * The first of `stage`'s later Roles (`stageRoles`) that the Floor has an
 * Agent in among `roles`, after `after` when given; undefined when there
 * is none.
 */
export function nextRoleAt(
  stage: PipelineStage,
  roles: readonly Role[],
  after?: Role,
): Role | undefined {
  const order = stageRoles[stage] ?? [];
  return order
    .slice(after === undefined ? 0 : order.indexOf(after) + 1)
    .find((role) => roles.includes(role));
}

/**
 * The Role to queue work at `stage` for, as `QueuedWork` names it: none
 * when the Floor has an Agent in the label's Stage among `stages`, whose
 * work the queue assumes; `designer` at QA on a Floor with a designer but
 * no QA Agent.
 */
export const roleOfQueued = (
  stage: PipelineStage,
  stages: readonly (Stage | null)[],
  roles: readonly Role[],
): { readonly role?: Role } => {
  const own = stageOfLabel(stage);
  if (own !== undefined && stages.includes(own)) {
    return {};
  }
  const role = nextRoleAt(stage, roles);
  return role === undefined ? {} : { role };
};

/**
 * Where an issue goes once `stage` passes it (FR-18): on to QA, then docs,
 * then `ready-to-merge`, skipping QA or docs when the Floor has no Agent
 * in that Stage among `stages` (its Agents' Roles' Stages, paused Agents'
 * included: their work waits for them) and none in a Role that works its
 * label after it among `roles` (a designer, at QA). It goes by Stage, not
 * by a Role's name (ADR 0003), but for the Roles `stageRoles` names.
 */
export function stageAfter(
  stage: "needs-review" | "needs-qa" | "needs-docs",
  stages: readonly (Stage | null)[],
  roles: readonly Role[] = [],
): PipelineStage {
  const next = laterStages[stage].find(
    (each) =>
      stages.includes(each) ||
      nextRoleAt(labelOfStage[each], roles) !== undefined,
  );
  return next === undefined ? "ready-to-merge" : labelOfStage[next];
}

export const canMove = (
  from: PipelineStage | null,
  to: PipelineStage,
): boolean => transitions.get(from)?.includes(to) ?? false;

/** The stages where an Agent works the issue, and so may hold it. */
const workableStages: readonly PipelineStage[] = [
  "needs-work",
  "needs-review",
  "needs-qa",
  "needs-docs",
];

/** Where an issue is in the pipeline, as its labels say. */
export interface PipelinePosition {
  /** Its stage; null when it is not in the pipeline yet. */
  readonly stage: PipelineStage | null;
  /** Whether an Agent holds it (`in-progress`). */
  readonly held: boolean;
}

const stageLabels = (labels: readonly string[]): PipelineStage[] =>
  labels.filter(isPipelineStage);

const hasLabel = (labels: readonly string[], label: string): boolean =>
  labels.some((name) => name.toLowerCase() === label.toLowerCase());

/** Where `labels` put an issue; throws `conflicting_labels` for two stages. */
export function positionOf(
  issue: number,
  labels: readonly string[],
): PipelinePosition {
  const stages = stageLabels(labels);
  if (stages.length > 1) {
    throw new PipelineError(
      pipelineErrorCodes.conflictingLabels,
      `Issue #${String(issue)} has more than one stage label (${stages.join(", ")}).`,
    );
  }
  return {
    stage: stages[0] ?? null,
    held: hasLabel(labels, inProgressLabel),
  };
}

/** The Floor an issue is on: its id and its repository. */
export interface FloorRef {
  readonly id: string;
  /** `owner/name` on GitHub. */
  readonly repository: string;
}

export interface Pipeline {
  /** Where the issue is now, read from GitHub. */
  position(floor: FloorRef, issue: number): Promise<PipelinePosition>;
  /**
   * Moves the issue to `to`, releasing any hold. Refuses a move that
   * `transitions` does not allow from where the issue is.
   */
  move(
    floor: FloorRef,
    issue: number,
    to: PipelineStage,
    options?: { readonly agentId?: string },
  ): Promise<PipelinePosition>;
  /** An Agent takes the issue (`in-progress`), at a stage it can work. */
  hold(floor: FloorRef, issue: number, agentId: string): Promise<void>;
  /** The Agent lets the issue go, leaving it at its stage. */
  release(floor: FloorRef, issue: number, agentId?: string): Promise<void>;
}

export interface PipelineOptions {
  readonly github: GitHubApp;
  readonly events: EventBus;
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { github, events } = options;

  const labelsOf = async (floor: FloorRef, issue: number) =>
    (await github.repository(floor.repository).getIssue(issue)).labels;

  const changed = (
    floor: FloorRef,
    issue: number,
    from: string | null,
    to: string | null,
    agentId: string | undefined,
  ) =>
    events.publish({
      type: "issue.label_changed",
      version: 1,
      floorId: floor.id,
      issue,
      ...(agentId === undefined ? {} : { agentId }),
      from,
      to,
    });

  const releaseLabel = async (
    floor: FloorRef,
    issue: number,
    agentId: string | undefined,
  ) => {
    await github
      .repository(floor.repository)
      .removeLabel(issue, inProgressLabel);
    await changed(floor, issue, inProgressLabel, null, agentId);
  };

  return {
    async position(floor, issue) {
      return positionOf(issue, await labelsOf(floor, issue));
    },

    async move(floor, issue, to, { agentId } = {}) {
      const labels = await labelsOf(floor, issue);
      const stages = stageLabels(labels);
      // A move that stopped after adding `to` is finished, not refused.
      const resumed =
        stages.length === 2 && stages.includes(to)
          ? stages.find((stage) => stage !== to)
          : undefined;
      const from =
        resumed !== undefined && canMove(resumed, to)
          ? resumed
          : positionOf(issue, labels).stage;
      if (!canMove(from, to)) {
        throw new PipelineError(
          pipelineErrorCodes.illegalTransition,
          `Issue #${String(issue)} cannot move from ${from ?? "outside the pipeline"} to ${to}.`,
        );
      }
      const repository = github.repository(floor.repository);
      // Added before the old stage goes: an interrupted move leaves both,
      // which the next attempt finishes, never neither.
      await repository.addLabels(issue, [to]);
      if (from !== null) {
        await repository.removeLabel(issue, from);
      }
      await changed(floor, issue, from, to, agentId);
      if (hasLabel(labels, inProgressLabel)) {
        await releaseLabel(floor, issue, agentId);
      }
      return { stage: to, held: false };
    },

    async hold(floor, issue, agentId) {
      const { stage, held } = positionOf(issue, await labelsOf(floor, issue));
      if (stage === null || !workableStages.includes(stage)) {
        throw new PipelineError(
          pipelineErrorCodes.notWorkable,
          `Issue #${String(issue)} is ${stage ?? "not in the pipeline"}, where no Agent works it.`,
        );
      }
      if (held) {
        throw new PipelineError(
          pipelineErrorCodes.held,
          `Issue #${String(issue)} is already in progress.`,
        );
      }
      await github
        .repository(floor.repository)
        .addLabels(issue, [inProgressLabel]);
      await changed(floor, issue, null, inProgressLabel, agentId);
    },

    async release(floor, issue, agentId) {
      const { held } = positionOf(issue, await labelsOf(floor, issue));
      if (!held) {
        throw new PipelineError(
          pipelineErrorCodes.notHeld,
          `Issue #${String(issue)} is not in progress.`,
        );
      }
      await releaseLabel(floor, issue, agentId);
    },
  };
}
