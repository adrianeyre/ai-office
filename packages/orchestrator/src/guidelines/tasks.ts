import type { EventBus } from "@ai-office/events";
import {
  floorGuidelinesPath,
  guidelinesBudget,
  type GuidelineTask,
} from "@ai-office/shared";

import type { BatchStore } from "../batches/store.ts";
import type { FloorRecord } from "../floors/store.ts";
import type { Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";
import type { ApprovedGuideline, GuidelineApprovals } from "./approval.ts";
import { choosesByPlan, chooseGuidelines, guidelinesWithin } from "./choose.ts";
import { holdsGuidelines, type GivenGuidelines } from "./prompt.ts";

// Each task's Guidelines (Guidelines, Specs and Hooks PRD, FR-105 to
// FR-108): the Floor's Guidelines in the versions the Owner approved, as
// its latest read settled them (at intake and before each task), chosen
// for the task by its Stage, the files it is about and the issue's
// `guideline:<name>` labels, within its prompt budget. The work Stage and
// the designer go by the files the Batch's Plan expects the issue to
// change, found here; review, QA and docs by the pull request's, which
// they give.
//
// A task whose Guidelines are over its budget leaves the largest
// `fileMatch` ones out first, and `guideline.over_budget` names them. The
// Floor then has one action Notice, "Guidelines on <floor> exceed the
// 12,000-character budget", until its Guidelines change: taken off the
// Notice Board then, and raised again by the next task still over. One the
// Owner dismissed is not raised again until they change.
//
// A Floor without Guidelines gives no task anything, so its prompts are as
// they were.

/** The action of the Notice: it opens the Floor admin's Guidelines. */
export const guidelinesBudgetAction = "open_guidelines_budget";

/** The Notice's title: the Floor's Guidelines are over a prompt's budget. */
export const guidelinesOverBudgetTitle = (floorName: string, budget: number) =>
  `Guidelines on ${floorName} exceed the ${budget.toLocaleString("en-GB")}-character budget`;

/** What a task is, for its Guidelines. */
export interface GuidelinesRequest {
  readonly floor: FloorRecord;
  readonly task: GuidelineTask;
  /** The Agent the task is for. */
  readonly agentId?: string;
  /** The issue it is for, with its labels; none for the Manager's chat. */
  readonly issue?: {
    readonly number: number;
    readonly labels: readonly string[];
  };
  /**
   * The files the pull request changes, for review, QA and docs. The work
   * Stage's and designer's come from the Plan.
   */
  readonly files?: readonly string[];
  /**
   * The most characters of Guidelines its prompt carries, its Model's
   * prompt budget's; `guidelinesBudget` when absent.
   */
  readonly budget?: number;
}

export interface TaskGuidelines {
  /**
   * The task's Guidelines, chosen and within its budget; undefined when
   * it is given none, so its prompt is as it would be without Guidelines.
   */
  forTask(request: GuidelinesRequest): Promise<GivenGuidelines | undefined>;
  /** Removes the Notice's action handler. */
  stop(): void;
}

export interface TaskGuidelinesOptions {
  readonly approvals: Pick<GuidelineApprovals, "approved">;
  readonly notices: Notices;
  readonly events: EventBus;
  /**
   * The files the Plan of the issue's Batch expects it to change; none
   * without a Plan.
   */
  readonly planFiles?: (
    floorId: string,
    issue: number,
  ) => Promise<readonly string[]>;
  /**
   * Told of a read that failed, when the task goes on without Guidelines,
   * and of an event or Notice that could not be kept.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * The files the newest open Batch's latest Plan expects an issue to
 * change; none when no open Batch holds it.
 */
export const plannedFiles =
  (store: Pick<BatchStore, "open" | "latestPlan">) =>
  async (floorId: string, issue: number): Promise<readonly string[]> => {
    for (const batch of (await store.open(floorId)).toReversed()) {
      const item = (await store.latestPlan(batch.id))?.items.find(
        (each) => each.issue === issue,
      );
      if (item !== undefined) {
        return item.files;
      }
    }
    return [];
  };

/** Which versions of which Guidelines a Floor gives, as one string. */
const versionsOf = (approved: readonly ApprovedGuideline[]): string =>
  approved
    .map(({ name, contentHash }) => `${name}:${contentHash}`)
    .sort()
    .join("\n");

const isBudgetNotice = (notice: NoticeRecord): boolean =>
  notice.actions.some(({ id }) => id === guidelinesBudgetAction);

export function createTaskGuidelines(
  options: TaskGuidelinesOptions,
): TaskGuidelines {
  const { approvals, notices, events } = options;

  /** Notices being taken off the board because the Guidelines changed. */
  const resolving = new Set<string>();
  /** The versions each Floor's Notice was raised (or kept) for. */
  const raisedFor = new Map<string, string>();

  const unregister = notices.registerAction(
    guidelinesBudgetAction,
    (notice) => {
      if (resolving.has(notice.id)) {
        return Promise.resolve();
      }
      return Promise.reject(
        new Error(
          "This Notice goes once the Floor's Guidelines change: shorten them, or split one up, so that each task's fit. Dismiss it to keep them as they are.",
        ),
      );
    },
  );

  /** One Floor's Notice is kept at a time. */
  const locks = new Map<string, Promise<unknown>>();
  const exclusive = <Value>(
    floorId: string,
    work: () => Promise<Value>,
  ): Promise<Value> => {
    const next = (locks.get(floorId) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    locks.set(floorId, settled);
    void settled.then(() => {
      if (locks.get(floorId) === settled) {
        locks.delete(floorId);
      }
    });
    return next;
  };

  /**
   * Takes the Floor's Notice off the board once its Guidelines changed
   * since it was raised; raises one, when `over`, unless it has one for
   * these versions (or the Owner dismissed that one).
   */
  const keepNotice = (
    floor: FloorRecord,
    versions: string,
    over: number | undefined,
  ): Promise<void> =>
    exclusive(floor.id, async () => {
      const raised = raisedFor.get(floor.id);
      if (raised !== undefined && raised !== versions) {
        raisedFor.delete(floor.id);
        const open = (await notices.open({ floorId: floor.id })).filter(
          isBudgetNotice,
        );
        for (const notice of open) {
          resolving.add(notice.id);
          try {
            await notices.act(notice.id, guidelinesBudgetAction);
          } finally {
            resolving.delete(notice.id);
          }
        }
      }
      if (over === undefined || raisedFor.has(floor.id)) {
        return;
      }
      const open = (await notices.open({ floorId: floor.id })).filter(
        isBudgetNotice,
      );
      if (open.length === 0) {
        await notices.raise({
          kind: "action",
          title: guidelinesOverBudgetTitle(floor.name, over),
          floorId: floor.id,
          actions: [
            {
              id: guidelinesBudgetAction,
              label: "Open Guidelines",
              href: floorGuidelinesPath(floor.id),
            },
          ],
        });
      }
      raisedFor.set(floor.id, versions);
    });

  return {
    async forTask(request) {
      const { floor, task } = request;
      let approved: readonly ApprovedGuideline[];
      try {
        approved = await approvals.approved(floor);
      } catch (error) {
        options.onError?.(error);
        return undefined;
      }
      const versions = versionsOf(approved);
      if (approved.length === 0) {
        // None now: a Notice raised before goes.
        if (raisedFor.has(floor.id)) {
          await keepNotice(floor, versions, undefined).catch((error: unknown) =>
            options.onError?.(error),
          );
        }
        return undefined;
      }
      const files =
        choosesByPlan(task) && request.issue !== undefined
          ? ((await options
              .planFiles?.(floor.id, request.issue.number)
              .catch((error: unknown) => {
                options.onError?.(error);
                return [];
              })) ?? [])
          : (request.files ?? []);
      const chosen = chooseGuidelines(approved, {
        task,
        files,
        labels: request.issue?.labels ?? [],
      });
      const budget = request.budget ?? guidelinesBudget;
      const within = guidelinesWithin(chosen.followed, budget);
      const given: GivenGuidelines = {
        task,
        followed: within.kept,
        listed: chosen.listed,
        leftOut: within.leftOut,
        budget,
      };
      // The event and the Notice never hold the task up.
      try {
        if (within.leftOut.length > 0) {
          await events.publish({
            type: "guideline.over_budget",
            version: 1,
            floorId: floor.id,
            task,
            ...(request.agentId === undefined
              ? {}
              : { agentId: request.agentId }),
            ...(request.issue === undefined
              ? {}
              : { issue: request.issue.number }),
            budget,
            characters: within.characters,
            leftOut: within.leftOut.map(({ name }) => name),
          });
        }
        await keepNotice(
          floor,
          versions,
          within.leftOut.length > 0 ? budget : undefined,
        );
      } catch (error) {
        options.onError?.(error);
      }
      return holdsGuidelines(given) ? given : undefined;
    },

    stop() {
      unregister();
    },
  };
}
