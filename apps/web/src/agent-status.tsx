import type { Agent, FloorWallBoard, WallBoardIssue } from "@ai-office/shared";

import { agentLook } from "./scene/agent-state.ts";
import { GitHubLink, StageBadge } from "./scene/wall-board-panel.tsx";

// An Agent's state and its current issue in words (PRD FR-12, FR-62,
// FR-63), from its Floor's wall board: the 2D Office and the Floor admin's
// Agents table both say them so.

/**
 * An Agent's state in words, as the Office shows it at its desk (FR-62):
 * working, waiting on review or idle; paused, or paused at a Token Cap;
 * leaving once its task ends (FR-10); and how many tasks wait for it.
 */
export function agentStateText(
  agent: Pick<Agent, "id" | "enabled"> & Partial<Pick<Agent, "leavingAt">>,
  board: FloorWallBoard | undefined,
): string {
  const entry = board?.agents.find(({ agentId }) => agentId === agent.id);
  const look = agentLook({
    working:
      board?.issues.some(
        ({ status, agentIds }) =>
          status === "working" && agentIds.includes(agent.id),
      ) ?? false,
    enabled: agent.enabled,
    capped: entry?.capped ?? false,
    awaitingReview: entry?.awaitingReview.length ?? 0,
    queued: entry?.waiting ?? 0,
  });
  const waiting = entry?.waiting ?? 0;
  return [
    { type: "Working", wait: "Waiting on review", sit: "Idle" }[look.animation],
    look.marker === "capped"
      ? "paused at a Token Cap"
      : look.marker === "paused"
        ? "paused"
        : undefined,
    agent.leavingAt === undefined || agent.leavingAt === null
      ? undefined
      : "leaving once its task ends",
    waiting > 0
      ? `${String(waiting)} ${waiting === 1 ? "task waits" : "tasks wait"}`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

/** An issue in progress: its number, stage, whether it is worked, its PR. */
export function IssueSummary({ issue }: { issue: WallBoardIssue }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <GitHubLink href={issue.url}>#{issue.issue}</GitHubLink>
      <StageBadge stage={issue.stage} />
      <span className="text-xs text-muted-foreground">
        {issue.status === "working" ? "Working" : "Waiting"}
      </span>
      {issue.pullRequest !== null && (
        <GitHubLink href={issue.pullRequest.url}>
          PR #{issue.pullRequest.number}
        </GitHubLink>
      )}
    </span>
  );
}
