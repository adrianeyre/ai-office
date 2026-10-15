import type { FloorWallBoard, Notice } from "@ai-office/shared";

import type { AnimationName } from "./avatar-animations.ts";
import type { FloorAgent } from "./floor-layout.ts";
import type { MonitorScreen } from "./monitor-preview.ts";

// What each Agent's state looks like in the Office (PRD FR-62), as data, so
// the scene only draws it: typing while it works; leaning back, hands
// behind the head, while its work waits on review; a marker over its head
// while it is paused or capped; and a pile of tickets on its desk, one for
// each task that waits for it. A Floor with an action Notice open has a
// red light at the Manager's office.

/** The most tickets a pile shows, however long the queue (the art direction's). */
export const maxTicketsShown = 10;

/**
 * A marker over an Agent's head: paused in the Agent editor, or paused at
 * a Token Cap. Each is its own shape, so neither is told by colour alone.
 */
export type AgentMarker = "paused" | "capped";

/** What the Office knows of one Agent's state. */
export interface AgentState {
  /** At work now: from its status or its sandbox starting (its monitor's). */
  readonly working: boolean;
  /** False while the Owner has paused it in the Agent editor. */
  readonly enabled: boolean;
  /** Paused at a Token Cap. */
  readonly capped: boolean;
  /** How many of the issues it handed to review wait on their verdicts. */
  readonly awaitingReview: number;
  /** How many tasks wait for it. */
  readonly queued: number;
}

/** How an Agent at its desk looks. */
export interface AgentLook {
  /** Typing while it works, waiting on review, or sitting back. */
  readonly animation: Extract<AnimationName, "type" | "wait" | "sit">;
  /** Over its head; none while it is neither paused nor capped. */
  readonly marker: AgentMarker | undefined;
  /** The tickets on its desk: its queue, up to `maxTicketsShown`. */
  readonly tickets: number;
}

/**
 * How an Agent in a state looks. Work wins: a paused Agent finishing its
 * task still types, under its marker. One at a Token Cap is stopped, and
 * never types. Otherwise it waits on review while any of its issues is
 * there, and sits back while none is. A cap is the marker shown over a
 * pause, being the one the Owner has to act on.
 */
export function agentLook(state: AgentState): AgentLook {
  const working = state.working && !state.capped;
  return {
    animation: working ? "type" : state.awaitingReview > 0 ? "wait" : "sit",
    marker: state.capped ? "capped" : state.enabled ? undefined : "paused",
    tickets: Math.min(Math.max(state.queued, 0), maxTicketsShown),
  };
}

/**
 * How each of a Floor's Agents looks, by its id: from the team (paused or
 * not), its monitors (working or not) and its wall board (queues, issues
 * at review, Token Cap pauses). An Agent the board does not list yet, or
 * every one until the board is read, has nothing queued, nothing at review
 * and no cap.
 */
export function agentLooks({
  team,
  monitors,
  board,
}: {
  readonly team: readonly FloorAgent[];
  readonly monitors: ReadonlyMap<string, MonitorScreen>;
  readonly board: FloorWallBoard | undefined;
}): ReadonlyMap<string, AgentLook> {
  const entries = new Map(
    (board?.agents ?? []).map((entry) => [entry.agentId, entry]),
  );
  return new Map(
    team.map(({ id, enabled }) => {
      const entry = entries.get(id);
      return [
        id,
        agentLook({
          working: monitors.get(id)?.working === true,
          enabled: enabled !== false,
          capped: entry?.capped === true,
          awaitingReview: entry?.awaitingReview.length ?? 0,
          queued: entry?.waiting ?? 0,
        }),
      ];
    }),
  );
}

/** Whether a Floor has an action Notice open: the Manager's office's red light. */
export const floorNeedsOwner = (
  notices: readonly Pick<Notice, "kind" | "floorId">[],
  floorId: string,
): boolean =>
  notices.some(
    (notice) => notice.kind === "action" && notice.floorId === floorId,
  );
