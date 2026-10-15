import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  liftRoute,
  withLeaving,
  type ContractorSignal,
  type ContractorWalker,
  type LiftPlanner,
} from "./contractor-walks.ts";
import type { FloorAgent, FloorLayout } from "./floor-layout.ts";
import { useSceneSettings } from "./scene-settings.ts";

// Contractors coming and going on a Floor in the scene (PRD FR-10, FR-57;
// ADR 0004): `ContractorArrivals` walks each Contractor signal that comes
// while the Floor is shown (contractor-walks.ts), and `useLeavingTeam`
// keeps a leaving Contractor's desk until its walk to the lift is done.

/**
 * Walks the Contractor signals that arrive while the Floor is shown, and
 * tells the Floor (`onHeld`) whenever the Contractors it keeps for their
 * walks out change. With reduced motion there are no walks (PRD §7).
 */
export function ContractorArrivals({
  walker,
  layout,
  signals,
  onHeld,
  held,
}: {
  walker: ContractorWalker;
  layout: Pick<FloorLayout, "desks" | "waypoints">;
  /** The Floor's Contractor signals, oldest first. */
  signals: readonly ContractorSignal[];
  /** The Contractors the Floor keeps for their walks out. */
  held: readonly string[];
  /** Told when those it keeps change. */
  onHeld: () => void;
}) {
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const plan = useMemo<LiftPlanner>(
    () => (agentId) => liftRoute(layout, agentId),
    [layout],
  );
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
          walker.receive(signal, planned.current);
        }
      }
    }
  }, [signals, walker, reducedMotion]);
  const keeping = useRef(held);
  useEffect(() => {
    keeping.current = held;
  });
  useFrame((_state, delta) => {
    if (useSceneSettings.getState().reducedMotion) {
      walker.skipAll();
    } else {
      walker.advance(delta, planned.current);
    }
    if (keeping.current.some((agentId) => !walker.holds(agentId))) {
      onHeld();
    }
  });
  return null;
}

/**
 * The team a Floor lays out (ADR 0004): its Agents, with each Contractor
 * gone from them kept at its desk while it walks to the lift. A
 * Contractor that leaves is told to `walker` as missing, so its desk is
 * kept a moment for its walk even before its signal comes. With reduced
 * motion it goes at once.
 */
export function useLeavingTeam(
  team: readonly FloorAgent[],
  walker: ContractorWalker,
): {
  readonly shown: readonly FloorAgent[];
  readonly held: readonly string[];
  readonly settle: () => void;
} {
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const [version, setVersion] = useState(0);
  // The team last laid out, worked out again as the team, the walks or
  // reduced motion change (derived state, kept as React keeps it).
  const [shown, setShown] = useState(team);
  const [from, setFrom] = useState({ team, version, reducedMotion });
  let current = shown;
  if (
    from.team !== team ||
    from.version !== version ||
    from.reducedMotion !== reducedMotion
  ) {
    if (!reducedMotion) {
      for (const agent of shown) {
        if (
          agent.contractor != null &&
          !team.some(({ id }) => id === agent.id)
        ) {
          walker.missing(agent.id);
        }
      }
    }
    current = reducedMotion
      ? team
      : withLeaving(team, shown, (agentId) => walker.holds(agentId));
    setFrom({ team, version, reducedMotion });
    setShown(current);
  }
  const held = useMemo(
    () =>
      current
        .filter((agent) => !team.some(({ id }) => id === agent.id))
        .map(({ id }) => id),
    [current, team],
  );
  const settle = useCallback(() => {
    setVersion((before) => before + 1);
  }, []);
  return { shown: current, held, settle };
}
