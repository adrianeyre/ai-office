import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ContractorWalker } from "./contractor-walks.ts";
import type { FloorLayout } from "./floor-layout.ts";
import type { GrillingWalker } from "./grilling-walks.ts";
import type { HandoffWalker } from "./handoff-walks.ts";
import { useMeetingFastForwardStore } from "./meeting-fast-forward.ts";
import {
  meetingPlanner,
  type MeetingSignal,
  type MeetingWalker,
} from "./meeting-walks.ts";
import { useSceneSettings } from "./scene-settings.ts";

// The Kickoff and the Wrap-up on a Floor (PRD FR-60): each meeting that
// begins while the Floor is shown gathers its Agents in the meeting room
// (meeting-walks.ts), and lets them go when it ends. The Agents themselves
// walk in desk-agents.tsx; the whiteboard's panel fills in live from the
// same events. An Agent on a Handoff walk, or at a Grilling Session's
// table (grilling-room.tsx), finishes it before setting off.
// With reduced motion no one walks: everyone stays at their desks.

/** Plays a Floor's meetings as their signals arrive. */
export function MeetingWalks({
  meetings,
  handoffs,
  grilling,
  comings,
  layout,
  signals,
}: {
  meetings: MeetingWalker;
  /**
   * The Floor's Contractors coming and going (ADR 0004): one walking in
   * sits down at its desk before it sets off.
   */
  comings?: Pick<ContractorWalker, "poseOf"> | undefined;
  /** The Floor's Handoff walks: an Agent on one sets off once it is back. */
  handoffs: HandoffWalker;
  /** The Floor's Grilling Session: an Agent at its table sets off once it is back. */
  grilling?: Pick<GrillingWalker, "poseOf"> | undefined;
  layout: Pick<FloorLayout, "desks" | "waypoints" | "meetingSeats">;
  /** The Floor's meeting signals, oldest first. */
  signals: readonly MeetingSignal[];
}) {
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const plan = useMemo(() => meetingPlanner(layout), [layout]);
  const planned = useRef(plan);
  useEffect(() => {
    planned.current = plan;
  });

  const [since] = useState(() => Math.max(0, ...signals.map(({ id }) => id)));
  const received = useRef(since);
  useEffect(() => {
    for (const signal of signals) {
      if (signal.id > received.current) {
        received.current = signal.id;
        if (!reducedMotion) {
          meetings.receive(signal, planned.current);
        }
      }
    }
  }, [signals, meetings, reducedMotion]);

  useFrame((_state, delta) => {
    if (useSceneSettings.getState().reducedMotion) {
      meetings.skipAll();
      return;
    }
    meetings.advance(
      delta,
      (agentId) =>
        handoffs.poseOf(agentId) !== undefined ||
        grilling?.poseOf(agentId) !== undefined ||
        comings?.poseOf(agentId) !== undefined,
    );
  });
  return null;
}

/**
 * Fast forward (meeting-fast-forward.ts): says whether anyone on the Floor
 * is on the way to the meeting room, for the button to know when its job
 * is done, and once the Owner presses it puts everyone on the way in
 * their place, for a meeting or a Grilling Session.
 */
export function MeetingFastForward({
  meetings,
  grilling,
}: {
  meetings: Pick<MeetingWalker, "arriveAll" | "gathering">;
  grilling: Pick<GrillingWalker, "arriveAll" | "gathering">;
}) {
  useFrame(() => {
    const store = useMeetingFastForwardStore.getState();
    let gathering = meetings.gathering() || grilling.gathering();
    if (store.skipping && gathering) {
      meetings.arriveAll();
      grilling.arriveAll();
      gathering = false;
      store.dismiss();
    }
    if (store.gathering !== gathering) {
      store.setGathering(gathering);
    }
  });
  useEffect(
    () => () => {
      useMeetingFastForwardStore.getState().setGathering(false);
    },
    [],
  );
  return null;
}
