import type { EventBus } from "@ai-office/events";
import {
  floorErrorCodes,
  pipelineStages,
  type FloorWallBoard,
  type WallBoardIssue,
} from "@ai-office/shared";

import type { AgentStore } from "../agents/store.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { qaRoundCap } from "../qa/caps.ts";
import type { ReviewLoopStore } from "../review/store.ts";
import {
  queuedStages,
  type WorkItem,
  type WorkQueueStore,
} from "../work/store.ts";

// A Floor's wall board (PRD FR-50, FR-57): every issue in progress, with
// the Agent working it (or that it waits for), its stage, its pull request
// and the rounds it has used, and the Floor's queues, by stage and by
// Agent. It is read from the work queue, the Review Loop's records and the
// events that name each issue's address and pull request. Its Notices and
// its tokens against caps are read from their own services. Each Agent's
// entry also says what the Office shows of it (FR-62): the issues it
// handed to review that wait on their verdicts, and whether it is paused
// at a Token Cap.

export interface WallBoard {
  /** A Floor's wall board, archived or not. */
  floorBoard(floorId: string): Promise<FloorWallBoard>;
}

export interface WallBoardOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  readonly work: Pick<WorkQueueStore, "active">;
  readonly reviews: Pick<
    ReviewLoopStore,
    "verdicts" | "qaReports" | "latestHandoff"
  >;
  readonly events: Pick<EventBus, "history">;
  /** Whether an Agent is paused at a Token Cap; none is without it. */
  readonly capPaused?: (agentId: string) => boolean;
}

/** Working first, then waiting; oldest first within each. */
const boardOrder = (a: WorkItem, b: WorkItem): number =>
  Number(a.status !== "running") - Number(b.status !== "running") ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  a.id - b.id;

export function createWallBoard(options: WallBoardOptions): WallBoard {
  const { floors, agents, work, reviews, events } = options;
  const capPaused = options.capPaused ?? (() => false);

  /** The issue's address on GitHub, as intake saw it. */
  const issueUrl = async (floor: FloorRecord, issue: number) => {
    const [pickedUp] = await events.history({
      filter: { floorId: floor.id, issue, types: ["issue.picked_up"] },
      limit: 1,
    });
    return pickedUp?.event.type === "issue.picked_up"
      ? pickedUp.event.url
      : `https://github.com/${floor.repository}/issues/${String(issue)}`;
  };

  /** The issue's latest pull request, as the App opened it. */
  const pullRequestOf = async (floorId: string, issue: number) => {
    const [opened] = await events.history({
      filter: { floorId, issue, types: ["pull_request.opened"] },
      limit: 1,
    });
    return opened?.event.type === "pull_request.opened"
      ? { number: opened.event.pullRequest, url: opened.event.url }
      : null;
  };

  /**
   * Each issue at review and the Agent that handed it there: its coder,
   * waiting on the reviewers' verdicts.
   */
  const handedToReview = async (
    floorId: string,
    items: readonly WorkItem[],
  ): Promise<{ issue: number; agentId: string }[]> =>
    (
      await Promise.all(
        items
          .filter(({ stage }) => stage === "needs-review")
          .map(async ({ issue }) => {
            const handed = await reviews.latestHandoff(
              floorId,
              issue,
              "needs-review",
            );
            return handed === undefined
              ? []
              : [{ issue, agentId: handed.fromAgentId }];
          }),
      )
    ).flat();

  const issueOf = async (
    floor: FloorRecord,
    item: WorkItem,
  ): Promise<WallBoardIssue> => {
    const [url, pullRequest, verdicts, reports] = await Promise.all([
      issueUrl(floor, item.issue),
      pullRequestOf(floor.id, item.issue),
      reviews.verdicts(floor.id, item.issue),
      reviews.qaReports(floor.id, item.issue),
    ]);
    return {
      issue: item.issue,
      url,
      stage: item.stage,
      status: item.status === "running" ? "working" : "waiting",
      agentIds:
        item.agentId !== null
          ? [item.agentId]
          : item.stage === "needs-review"
            ? [...floor.requiredReviewerAgentIds]
            : [],
      pullRequest,
      reviewRounds: new Set(verdicts.map(({ round }) => round)).size,
      qaRounds: reports.length,
    };
  };

  return {
    async floorBoard(floorId) {
      const floor = await floors.get(floorId);
      if (floor === undefined) {
        throw new FloorError(
          floorErrorCodes.floorNotFound,
          `There is no Floor "${floorId}".`,
        );
      }
      const [active, team] = await Promise.all([
        work.active(),
        agents.list(floorId),
      ]);
      const onFloor = active
        .filter((item) => item.floorId === floorId)
        .sort(boardOrder);
      const waitingFor = (agentId: string) =>
        onFloor.filter(
          (item) => item.status === "queued" && item.agentId === agentId,
        ).length;
      const inReview = await handedToReview(floorId, onFloor);
      return {
        floorId,
        roundCap: floor.roundCap,
        qaRoundCap,
        issues: await Promise.all(onFloor.map((item) => issueOf(floor, item))),
        queues: pipelineStages
          .filter((stage) => queuedStages.includes(stage))
          .map((stage) => ({
            stage,
            waiting: onFloor.filter(
              (item) => item.stage === stage && item.status === "queued",
            ).length,
            working: onFloor.filter(
              (item) => item.stage === stage && item.status === "running",
            ).length,
          })),
        agents: team.map(({ id }) => ({
          agentId: id,
          waiting: waitingFor(id),
          awaitingReview: inReview
            .filter(({ agentId }) => agentId === id)
            .map(({ issue }) => issue),
          capped: capPaused(id),
        })),
      };
    },
  };
}
