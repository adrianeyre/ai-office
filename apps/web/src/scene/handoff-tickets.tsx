import { isPipelineStage } from "@ai-office/shared";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Group } from "three";

import { cn } from "@/lib/utils.ts";

import type { FloorLayout } from "./floor-layout.ts";
import {
  handoffRoute,
  handoffWalk,
  type HandoffTicket,
  type HandoffWalker,
  type WalkPlanner,
} from "./handoff-walks.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { backgroundOf, stageTokens } from "./stage-colours.ts";

// Handoffs on a Floor (PRD FR-59): each new Handoff is walked by its Agent
// (handoff-walks.ts), and the ticket it carries is labelled with the
// issue's number in HTML over the canvas (no text in the scene, PRD §7),
// coloured by the stage it goes to. The Agents themselves walk in
// desk-agents.tsx, and the receiving monitors light up in
// monitor-screens.tsx. With reduced motion nothing walks: each ticket is
// handed over at once.

/** Where a carried ticket's label floats: over the ticket in the Agent's hands. */
export const ticketLabelAt = { ahead: 0.35, height: 1.3 } as const;

/** A ticket's label: the issue's number, in its stage's colour. */
export function ticketLabel(ticket: Pick<HandoffTicket, "issue" | "stage">): {
  readonly text: string;
  readonly className: string;
} {
  const token = isPipelineStage(ticket.stage)
    ? stageTokens[ticket.stage]
    : undefined;
  return {
    text: `#${String(ticket.issue)}`,
    className:
      token === undefined
        ? "bg-office-paper text-office-ink"
        : backgroundOf(token),
  };
}

/** Puts a ticket's label where its Agent is carrying it. */
function placeLabel(group: Group, walker: HandoffWalker, agentId: string) {
  const pose = walker.poseOf(agentId);
  if (pose === undefined) {
    return;
  }
  const [x, z] = pose.position;
  group.position.set(
    x + Math.sin(pose.heading) * ticketLabelAt.ahead,
    ticketLabelAt.height,
    z + Math.cos(pose.heading) * ticketLabelAt.ahead,
  );
}

const keyOf = (carried: ReadonlyMap<string, HandoffTicket>) =>
  [...carried].map(([agentId, { id }]) => `${agentId}:${String(id)}`).join();

/**
 * Walks a Floor's Handoffs as they arrive, and labels the tickets carried.
 * Only Handoffs that arrive once it is on the Floor are walked: those
 * before have been and gone.
 */
export function HandoffWalks({
  walker,
  layout,
  handoffs,
  inMeeting,
  labelsIn,
}: {
  walker: HandoffWalker;
  layout: Pick<FloorLayout, "desks" | "waypoints">;
  /** The Floor's Handoffs, oldest first. */
  handoffs: readonly HandoffTicket[];
  /**
   * Whether an Agent is in a meeting (FR-60): a Handoff from it is handed
   * over at once, not walked.
   */
  inMeeting?: ((agentId: string) => boolean) | undefined;
  /** Where the labels go in the page; beside the canvas by default. */
  labelsIn?: RefObject<HTMLElement> | undefined;
}) {
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const plan = useMemo<WalkPlanner>(
    () => (ticket) => {
      if (reducedMotion || inMeeting?.(ticket.fromAgentId) === true) {
        return undefined;
      }
      const route = handoffRoute(layout, ticket.fromAgentId, ticket.toAgentId);
      return route === undefined ? undefined : handoffWalk(ticket, route);
    },
    [layout, reducedMotion, inMeeting],
  );
  const planned = useRef(plan);
  useEffect(() => {
    planned.current = plan;
  });

  const [since] = useState(() => Math.max(0, ...handoffs.map(({ id }) => id)));
  const received = useRef(since);
  useEffect(() => {
    for (const ticket of handoffs) {
      if (ticket.id > received.current) {
        received.current = ticket.id;
        walker.receive(ticket, planned.current);
      }
    }
  }, [handoffs, walker]);

  const [carried, setCarried] = useState<ReadonlyMap<string, HandoffTicket>>(
    () => new Map(),
  );
  const carriedKey = useRef("");
  const labels = useRef(new Map<string, Group>());
  useFrame((_state, delta) => {
    if (useSceneSettings.getState().reducedMotion) {
      walker.skipAll();
    }
    walker.advance(delta, planned.current);
    const now = walker.carried();
    const key = keyOf(now);
    if (key !== carriedKey.current) {
      carriedKey.current = key;
      setCarried(now);
    }
    for (const [agentId, group] of labels.current) {
      placeLabel(group, walker, agentId);
    }
  });

  return (
    <group name="handoff-tickets">
      {[...carried].map(([agentId, ticket]) => {
        const label = ticketLabel(ticket);
        return (
          <group
            key={`${agentId}:${String(ticket.id)}`}
            name={`handoff-ticket-${agentId}`}
            ref={(group) => {
              if (group === null) {
                labels.current.delete(agentId);
              } else {
                labels.current.set(agentId, group);
                placeLabel(group, walker, agentId);
              }
            }}
          >
            <Html
              center
              zIndexRange={[0, 0]}
              style={{ pointerEvents: "none" }}
              {...(labelsIn === undefined ? {} : { portal: labelsIn })}
            >
              <span
                aria-hidden
                data-handoff-ticket={ticket.issue}
                className={cn(
                  "rounded-sm px-1.5 py-0.5 font-mono text-xs font-semibold whitespace-nowrap shadow-sm",
                  label.className,
                )}
              >
                {label.text}
              </span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
