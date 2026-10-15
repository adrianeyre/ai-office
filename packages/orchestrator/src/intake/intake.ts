import type { EventBus } from "@ai-office/events";
import {
  isGitHubError,
  type GitHubApp,
  type Issue,
  type RepositoryClient,
} from "@ai-office/github";
import {
  defaultIntakeIntervalSeconds,
  intakeLabel,
  pipelineLabels,
  renamedPipelineLabels,
  roleLabel,
  type IntakeSettings,
  type PipelineStage,
  type Role,
} from "@ai-office/shared";

import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { Triage } from "../manager/triage.ts";
import { positionOf, type Pipeline } from "../pipeline/pipeline.ts";
import { createRounds } from "../rounds.ts";
import { approvedIssue, UnapprovedIssueError } from "./approved.ts";

// Issue intake (PRD FR-8): every interval (60 seconds by default), for each
// Floor in use, AI Office finds the open issues labelled `ai-office` that
// are not in the pipeline yet, moves each to `needs-work` and queues it.
// Issue text is untrusted (PRD §4): an issue is taken in only if the Owner
// opened it, or the Owner applied the `ai-office` label personally (the
// label's latest `labeled` event is theirs), and its text is the text the
// Owner approved (`approved.ts`): one edited by someone else after the
// Owner's label is not taken in until the Owner labels it again. With the
// Manager's triage
// (FR-23), an issue goes into the pipeline only once it is clear enough to
// work; one that is not waits for the Owner, out of the pipeline, as does
// one whose work Role the Owner is asked to choose. Each Floor's repository
// gets the pipeline's labels, and a `role:<name>` label for each work Role
// on its team, which forces that Role (ADR 0003). An issue an open Batch
// holds (FR-25), waiting for its Plan's approval or for the issues it
// depends on, is the Batch's to start, not intake's. With the GitHub App's
// webhooks on, a webhook starts a round at once; polling carries on, in
// case a delivery is lost.

/**
 * Renames the labels the pipeline has renamed on a Floor's repository
 * (ADR 0003: `needs-code` is now `needs-work`), with the new label's
 * colour and description, before the new ones are made: a renamed label
 * stays on its issues, so they keep their place in the pipeline. Answers
 * the old names renamed. A repository that has the new label already
 * keeps both, and its issues their old label.
 */
export async function renameRetiredLabels(
  repository: Pick<RepositoryClient, "renameLabel">,
): Promise<string[]> {
  const renamed: string[] = [];
  for (const { from, to } of renamedPipelineLabels) {
    try {
      if (await repository.renameLabel(from, to)) {
        renamed.push(from);
      }
    } catch (error) {
      if (!isGitHubError(error, 422)) {
        throw error;
      }
    }
  }
  return renamed;
}

/** Work for an Agent: an issue at a stage. */
export interface QueuedWork {
  readonly floorId: string;
  readonly issue: number;
  readonly stage: PipelineStage;
  /**
   * The Agent to give it to, as the Manager's watchdog chooses one (FR-23);
   * by the Manager's dispatch rules otherwise.
   */
  readonly agentId?: string;
  /**
   * The Role whose Agent does it, when it is not the stage's first
   * (`stageRoles`): a designer's review at `needs-qa`, after QA's.
   */
  readonly role?: Role;
}

/** Where picked-up issues wait for an Agent. */
export interface IntakeQueue {
  enqueue(work: QueuedWork): Promise<void>;
}

/** Keeps queued work in memory, once per issue and stage. */
export function memoryIntakeQueue(): IntakeQueue & {
  readonly items: QueuedWork[];
} {
  const items: QueuedWork[] = [];
  return {
    items,
    enqueue(work) {
      if (
        !items.some(
          ({ floorId, issue, stage }) =>
            floorId === work.floorId &&
            issue === work.issue &&
            stage === work.stage,
        )
      ) {
        items.push({ ...work });
      }
      return Promise.resolve();
    },
  };
}

/** What one round of intake did, Floor by Floor. */
export interface IntakeReport {
  readonly pickedUp: readonly { floorId: string; issue: number }[];
  /** Issues labelled `ai-office` by someone who is not the Owner. */
  readonly ignored: readonly { floorId: string; issue: number }[];
  /** The Owner's issues the Manager's triage found unclear: they wait. */
  readonly waiting: readonly { floorId: string; issue: number }[];
  /** Floors (or single issues) intake could not finish this round. */
  readonly failed: readonly {
    floorId: string;
    issue?: number;
    error: unknown;
  }[];
}

export interface Intake {
  /** Takes in every Floor's new issues once. */
  poll(): Promise<IntakeReport>;
  /** Polls now, then every interval, until stopped. */
  start(): void;
  /**
   * Polls again now, once any round in progress is done, as when the Owner
   * has chosen a waiting issue's work Role: nothing, unless started.
   */
  wake(): void;
  /** Stops polling, waiting for a round in progress to finish. */
  stop(): Promise<void>;
  /**
   * Polls now, as a GitHub webhook asks (FR-8), or straight after the
   * round running; the interval starts again from it. Resolves once that
   * round has finished. Nothing happens unless started.
   */
  trigger(): Promise<void>;
  /**
   * Checks the Floor's repository for every pipeline label and its work
   * Roles' `role:<name>` labels again in the next round, as when one was
   * deleted on GitHub.
   */
  recheckLabels(floorId: string): void;
}

export interface IntakeOptions {
  readonly floors: FloorStore;
  readonly github: GitHubApp;
  readonly pipeline: Pipeline;
  readonly queue: IntakeQueue;
  readonly events: EventBus;
  /** The Owner's login and the interval, read afresh for every round. */
  readonly settings: () => Promise<IntakeSettings>;
  /**
   * The Manager's triage, before an issue goes into the pipeline. Without
   * it, every one of the Owner's issues is picked up as it is.
   */
  readonly triage?: Triage;
  /**
   * The issues a Floor's open Batches hold back (FR-25): intake leaves
   * them for their Batch to start.
   */
  readonly held?: (floorId: string) => Promise<ReadonlySet<number>>;
  /** Told of each round that did something or failed somewhere. */
  readonly onReport?: (report: IntakeReport) => void;
}

const sameLogin = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Whether the Owner opened the issue, or applied its `ai-office` label
 * personally (the label's latest `labeled` event is theirs): only then may
 * it be worked (PRD §4).
 */
export async function fromOwner(
  github: GitHubApp,
  floor: Pick<FloorRecord, "repository">,
  issue: Pick<Issue, "number" | "author">,
  owner: string,
): Promise<boolean> {
  if (sameLogin(issue.author, owner)) {
    return true;
  }
  const labelling = (
    await github.repository(floor.repository).labelEvents(issue.number)
  ).filter(
    ({ action, label }) =>
      action === "labeled" && sameLogin(label, intakeLabel),
  );
  const latest = labelling.at(-1);
  return latest !== undefined && sameLogin(latest.actor, owner);
}

/**
 * Puts an issue into the pipeline at `needs-work` and queues its work:
 * for `agentId` when given (as a Batch's Plan gives it, FR-25), by the
 * Manager's dispatch rules otherwise.
 */
export async function pickUpIssue(
  using: {
    readonly pipeline: Pipeline;
    readonly events: EventBus;
    readonly queue: IntakeQueue;
  },
  floor: FloorRecord,
  issue: Pick<Issue, "number" | "title" | "htmlUrl">,
  agentId?: string,
): Promise<void> {
  await using.pipeline.move(floor, issue.number, "needs-work");
  await using.events.publish({
    type: "issue.picked_up",
    version: 1,
    floorId: floor.id,
    issue: issue.number,
    title: issue.title,
    url: issue.htmlUrl,
  });
  await using.queue.enqueue({
    floorId: floor.id,
    issue: issue.number,
    stage: "needs-work",
    ...(agentId === undefined ? {} : { agentId }),
  });
}

export function createIntake(options: IntakeOptions): Intake {
  const { github, pipeline, queue, events } = options;
  /**
   * Floors whose repository has every pipeline label, under its current
   * name, this process.
   */
  const labelled = new Set<string>();
  /** The `role:<name>` labels made this process, by Floor. */
  const roleLabelled = new Set<string>();

  const ensureLabels = async (floor: FloorRecord): Promise<void> => {
    const repository = github.repository(floor.repository);
    if (!labelled.has(floor.id)) {
      await renameRetiredLabels(repository);
      for (const label of pipelineLabels) {
        await repository.ensureLabel(label);
      }
      labelled.add(floor.id);
    }
    // The team may have changed since: a work Role new to it gets its
    // label. A Contractor's one-off Role gets none: no label gives it work.
    for (const role of (await options.triage?.workRoles(floor)) ?? []) {
      if (role.oneOff === true) {
        continue;
      }
      const label = roleLabel(role);
      const key = `${floor.id}\n${label.name}`;
      if (!roleLabelled.has(key)) {
        await repository.ensureLabel(label);
        roleLabelled.add(key);
      }
    }
  };

  const poll = async (): Promise<IntakeReport> => {
    const report = {
      pickedUp: [] as { floorId: string; issue: number }[],
      ignored: [] as { floorId: string; issue: number }[],
      waiting: [] as { floorId: string; issue: number }[],
      failed: [] as { floorId: string; issue?: number; error: unknown }[],
    };
    const { ownerLogin } = await options.settings();
    // Archived Floors are not listed: their intake has stopped (FR-9).
    for (const floor of await options.floors.list()) {
      let issues: Issue[];
      try {
        await ensureLabels(floor);
        issues = await github
          .repository(floor.repository)
          .listIssues({ labels: [intakeLabel] });
      } catch (error) {
        report.failed.push({ floorId: floor.id, error });
        continue;
      }
      let held: ReadonlySet<number>;
      try {
        held = (await options.held?.(floor.id)) ?? new Set();
      } catch (error) {
        report.failed.push({ floorId: floor.id, error });
        continue;
      }
      // Oldest first, as they were opened.
      for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
        try {
          // Issues already in the pipeline are its business, not intake's.
          if (positionOf(issue.number, issue.labels).stage !== null) {
            continue;
          }
          // A Batch starts its own issues, as its Plan says.
          if (held.has(issue.number)) {
            continue;
          }
          if (!(await fromOwner(github, floor, issue, ownerLogin))) {
            report.ignored.push({ floorId: floor.id, issue: issue.number });
            continue;
          }
          // The text the Owner approved, not an edit since (P1-5).
          let approved: Issue;
          try {
            approved = await approvedIssue(
              github.repository(floor.repository),
              issue.number,
              ownerLogin,
            );
          } catch (error) {
            if (!(error instanceof UnapprovedIssueError)) {
              throw error;
            }
            report.ignored.push({ floorId: floor.id, issue: issue.number });
            continue;
          }
          if (
            options.triage !== undefined &&
            !(await options.triage.check(floor, approved)).proceed
          ) {
            report.waiting.push({ floorId: floor.id, issue: issue.number });
            continue;
          }
          await pickUpIssue({ pipeline, queue, events }, floor, approved);
          report.pickedUp.push({ floorId: floor.id, issue: issue.number });
        } catch (error) {
          report.failed.push({ floorId: floor.id, issue: issue.number, error });
        }
      }
    }
    return report;
  };

  const rounds = createRounds({
    async run() {
      try {
        const report = await poll();
        if (report.pickedUp.length > 0 || report.failed.length > 0) {
          options.onReport?.(report);
        }
      } catch (error) {
        options.onReport?.({
          pickedUp: [],
          ignored: [],
          waiting: [],
          failed: [{ floorId: "*", error }],
        });
      }
    },
    async intervalMs() {
      const { intervalSeconds } = await options.settings().catch(() => ({
        intervalSeconds: defaultIntakeIntervalSeconds,
      }));
      return intervalSeconds * 1000;
    },
  });

  return {
    poll,
    start() {
      rounds.start({ now: true });
    },
    wake() {
      void rounds.trigger();
    },
    stop: () => rounds.stop(),
    trigger: () => rounds.trigger(),
    recheckLabels(floorId) {
      labelled.delete(floorId);
      for (const key of roleLabelled) {
        if (key.startsWith(`${floorId}\n`)) {
          roleLabelled.delete(key);
        }
      }
    },
  };
}
