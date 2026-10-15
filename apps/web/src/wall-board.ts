import type { EventType } from "@ai-office/events/schema";
import {
  floorWallBoardSchema,
  type CapUse,
  type FloorTokenUsage,
  type FloorWallBoard,
  type Notice,
  type WallBoardIssue,
} from "@ai-office/shared";
import type { PaletteToken } from "@ai-office/shared/palette";
import {
  queryOptions,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import { getJson } from "./api.ts";
import { useEventStream, type EventStreamOptions } from "./event-stream.ts";
import { refreshFloorsOn } from "./floors.ts";
import { noticeEventTypes, noticesQuery } from "./notices.ts";
import { floorTokenUsageQuery } from "./token-caps.tsx";

// A Floor's wall board (PRD FR-50, FR-57) as queries, kept live by the
// Floor's event stream: its issues in progress and queues (`GET
// /api/floors/:floorId/wall-board`), its tokens against caps, and, from
// them and its Notices, the Floor's health.

/** A Floor's issues in progress and its queues. */
export const wallBoardQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "wall-board"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/wall-board`,
        floorWallBoardSchema,
      ),
  });

/** The events that change what a wall board shows. */
export const wallBoardEventTypes: readonly EventType[] = [
  ...noticeEventTypes,
  "issue.picked_up",
  "issue.assigned",
  "issue.label_changed",
  "agent.queue_changed",
  "agent.status_changed",
  "agent.created",
  "agent.removed",
  "sandbox.started",
  "sandbox.stopped",
  "pull_request.opened",
  "pull_request.merged",
  "review.posted",
  "qa.reported",
  "model_call.completed",
  "cap.warning",
  "cap.reached",
  "config.changed",
];

/** How often tokens are read again while nothing else says they changed. */
export const tokenRefreshMs = 60_000;

/**
 * Keeps a Floor's wall board current while mounted, on one stream of the
 * Floor's events: each that changes it reads it again, with its Notices
 * and tokens, and so does each (re)connection of the stream, in case
 * something changed while it was down. `onEvent` hears each event too.
 */
export function useLiveWallBoard(
  floorId: string,
  options: Pick<EventStreamOptions, "onEvent"> = {},
): void {
  const queryClient = useQueryClient();
  const { status } = useEventStream(
    { floorId, types: wallBoardEventTypes },
    {
      onEvent: (event, client) => {
        refreshWallBoard(client, floorId);
        // A change to the Floor's settings, such as its name.
        refreshFloorsOn(event.event, client);
        options.onEvent?.(event, client);
      },
    },
  );
  useEffect(() => {
    if (status === "open") {
      refreshWallBoard(queryClient, floorId);
    }
  }, [status, queryClient, floorId]);
}

/** Reads a Floor's wall board, Notices and tokens again. */
function refreshWallBoard(client: QueryClient, floorId: string): void {
  void client.invalidateQueries(wallBoardQuery(floorId));
  void client.invalidateQueries(noticesQuery(floorId));
  void client.invalidateQueries(floorTokenUsageQuery(floorId));
}

/** How a Floor is doing: fine, worth watching, or needing the Owner. */
export type HealthLevel = "ok" | "warning" | "critical";

export interface FloorHealth {
  readonly level: HealthLevel;
  /** In words, beside its colour. */
  readonly label: string;
  /** Why, most pressing first; empty when all is well. */
  readonly reasons: readonly string[];
}

export const healthTokens: Readonly<Record<HealthLevel, PaletteToken>> = {
  ok: "state-ok",
  warning: "state-warning",
  critical: "state-critical",
};

const healthLabels: Readonly<Record<HealthLevel, string>> = {
  ok: "Running smoothly",
  warning: "Worth watching",
  critical: "Needs you",
};

/** A cap's share used, as the Office colours it (FR-62). */
export type CapState = "neutral" | "warning" | "reached";

/** Neutral below 80% of the cap, a warning from 80%, reached at 100%. */
export function capState({
  cap,
  used,
}: Pick<CapUse, "cap" | "used">): CapState {
  return used >= cap ? "reached" : used >= cap * 0.8 ? "warning" : "neutral";
}

export const capStateTokens: Readonly<Record<CapState, PaletteToken>> = {
  neutral: "state-neutral",
  warning: "state-warning",
  reached: "state-critical",
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${String(count)} ${count === 1 ? one : many}`;

const periodWords = { daily: "daily", monthly: "monthly" } as const;

/**
 * A Floor's health, from its open Notices, its issues in progress and its
 * Agents' tokens against their caps:
 * - it needs the Owner while it has an action Notice open, or an Agent has
 *   reached a Token Cap;
 * - it is worth watching while an Agent is at 80% of a cap or more, an
 *   issue has one round of review or QA left, or work waits with no Agent
 *   to do it;
 * - otherwise it is running smoothly.
 */
export function floorHealth({
  notices,
  board,
  usage,
  agentName,
}: {
  readonly notices: readonly Notice[];
  readonly board: FloorWallBoard;
  readonly usage: FloorTokenUsage;
  readonly agentName: (agentId: string) => string;
}): FloorHealth {
  const critical: string[] = [];
  const warning: string[] = [];
  const actions = notices.filter(({ kind }) => kind === "action").length;
  if (actions > 0) {
    critical.push(`${plural(actions, "action Notice")} open.`);
  }
  for (const { agentId, caps } of usage.agents) {
    for (const period of ["daily", "monthly"] as const) {
      const state = capState(caps[period]);
      if (state === "reached") {
        critical.push(
          `${agentName(agentId)} has reached its ${periodWords[period]} Token Cap.`,
        );
      } else if (state === "warning") {
        warning.push(
          `${agentName(agentId)} has used ${String(Math.floor((caps[period].used / caps[period].cap) * 100))}% of its ${periodWords[period]} Token Cap.`,
        );
      }
    }
  }
  for (const { issue, reviewRounds, qaRounds, agentIds } of board.issues) {
    if (reviewRounds > 0 && reviewRounds >= board.roundCap - 1) {
      warning.push(
        `#${String(issue)} has used ${String(reviewRounds)} of ${plural(board.roundCap, "review round")}.`,
      );
    }
    if (qaRounds > 0 && qaRounds >= board.qaRoundCap - 1) {
      warning.push(
        `#${String(issue)} has used ${String(qaRounds)} of ${plural(board.qaRoundCap, "QA round")}.`,
      );
    }
    if (agentIds.length === 0) {
      warning.push(`#${String(issue)} waits with no Agent to work it.`);
    }
  }
  const level: HealthLevel =
    critical.length > 0 ? "critical" : warning.length > 0 ? "warning" : "ok";
  return {
    level,
    label: healthLabels[level],
    reasons: [...critical, ...warning],
  };
}

/**
 * The issue an Agent is on (PRD FR-63), from its Floor's wall board: the
 * one it is working, or else the oldest waiting for it; undefined when it
 * has none. A review round's issue is each of its reviewers'.
 */
export function currentIssueOf(
  board: FloorWallBoard,
  agentId: string,
): WallBoardIssue | undefined {
  // The board lists work being worked first, then waiting work, oldest first.
  return board.issues.find(({ agentIds }) => agentIds.includes(agentId));
}
