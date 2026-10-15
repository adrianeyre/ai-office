import type { StreamedEvent } from "@ai-office/events/stream";

import type { FloorLayout } from "./floor-layout.ts";
import {
  headingAlong,
  lengthOf,
  pointAlong,
  routeFromDesk,
  walkSeconds,
  walkSpeed,
} from "./handoff-walks.ts";
import { liftDoorway, liftWall } from "./lift-layout.ts";
import type { MeetingPose } from "./meeting-walks.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// Contractors coming and going in the Office (PRD FR-10, FR-57; ADR 0004),
// as data, so the scene only draws them. A Contractor the Manager adds
// steps out of the lift and walks to the desk of its own it was given,
// where it sits down; one that leaves gets up, walks back to the lift and
// steps in, and only then does its desk go. The events have happened (its
// `agent.removed` comes before its walk ends), so the Floor keeps a leaving
// Contractor's desk until the walk is done (`holds`); one whose walk ends
// before the Floor's team drops it waits inside the lift, out of sight,
// until it does. An Agent the Owner
// adds or removes appears and goes as before. With reduced motion there
// are no walks: a Contractor is at its desk at once, and gone at once.

/** What a Floor's Contractor events tell the Office. */
export interface ContractorSignal {
  readonly type: "arrive" | "leave";
  /** The event's id. */
  readonly id: number;
  readonly floorId: string;
  readonly agentId: string;
}

/** The Contractor signals among `events`, oldest first. */
export function contractorSignals(
  events: readonly StreamedEvent[],
): ContractorSignal[] {
  return events.flatMap(({ id, event }): ContractorSignal[] =>
    event.type === "contractor.added" || event.type === "contractor.left"
      ? [
          {
            type: event.type === "contractor.added" ? "arrive" : "leave",
            id,
            floorId: event.floorId,
            agentId: event.agentId,
          },
        ]
      : [],
  );
}

/** Where a Contractor stands inside the lift car, behind its doors. */
export const insideLift: FloorPoint = [
  liftDoorway.position[0],
  liftDoorway.position[2] - liftWall.thickness - 0.5,
];

/** The way between an Agent's chair and the inside of the lift. */
export interface LiftRoute {
  /** From its seat at its desk, along the waypoints, into the lift. */
  readonly path: readonly FloorPoint[];
  readonly length: number;
  /** Which way it faces at its desk. */
  readonly seatHeading: number;
}

/**
 * The way from an Agent's chair into the lift: off its chair, along the
 * waypoints to the lift's, and through the doors. Walked the other way to
 * arrive. Undefined when it has no desk, or no way there.
 */
export function liftRoute(
  layout: Pick<FloorLayout, "desks" | "waypoints">,
  agentId: string,
): LiftRoute | undefined {
  const out = routeFromDesk(layout, agentId, "lift");
  if (out === undefined) {
    return undefined;
  }
  const path = [...out.path, insideLift];
  return { path, length: lengthOf(path), seatHeading: out.seatHeading };
}

/** One Contractor's walk in or out, and how far into it. */
export interface ContractorWalk {
  readonly type: ContractorSignal["type"];
  readonly route: LiftRoute;
  /** Seconds since it set off. */
  readonly elapsed: number;
}

/** How long a walk takes: in, to sitting down; out, from standing up. */
export function walkLength(walk: Pick<ContractorWalk, "type" | "route">) {
  const walking = walk.route.length / walkSpeed;
  return walk.type === "arrive"
    ? walking + walkSeconds.sitDown
    : walkSeconds.standUp + walking;
}

/** Whether a walk is over: seated at its desk, or gone into the lift. */
export const walkDone = (walk: ContractorWalk): boolean =>
  walk.elapsed >= walkLength(walk);

/** Where a Contractor is on its walk, which way it faces, and what it plays. */
export function contractorPose(walk: ContractorWalk): MeetingPose {
  const { path, length, seatHeading } = walk.route;
  const seat = path[0] ?? insideLift;
  const walking = length / walkSpeed;
  if (walk.type === "arrive") {
    if (walk.elapsed < walking) {
      const along = length - walk.elapsed * walkSpeed;
      return {
        position: pointAlong(path, along),
        heading: headingAlong(path, along) + Math.PI,
        animation: "walk",
      };
    }
    return { position: seat, heading: seatHeading, animation: "sit-down" };
  }
  if (walk.elapsed < walkSeconds.standUp) {
    return { position: seat, heading: seatHeading, animation: "stand-up" };
  }
  const along = Math.min(
    (walk.elapsed - walkSeconds.standUp) * walkSpeed,
    length,
  );
  return {
    position: pointAlong(path, along),
    heading: headingAlong(path, along),
    animation: "walk",
  };
}

/** How long a Contractor gone from the team keeps its desk, waiting for its walk out. */
export const awaitSeconds = 5;

/** How long an arrival waits for its desk to be laid out before it is dropped. */
export const deskWaitSeconds = 30;

/** How long one that walked out waits in the lift for the team to drop it. */
export const inLiftSeconds = 60;

/** Where each of a Floor's Contractors is, coming or going, by its id. */
export type ContractorState =
  /** Arrived, waiting for its desk to be laid out. */
  | { readonly kind: "awaiting-desk"; readonly waited: number }
  /** Gone from the team, waiting for its signal to walk out. */
  | { readonly kind: "awaiting-walk"; readonly waited: number }
  | { readonly kind: "walking"; readonly walk: ContractorWalk };

export type ContractorStates = ReadonlyMap<string, ContractorState>;

/** The way an Agent walks between its desk and the lift, as the Floor is laid out now. */
export type LiftPlanner = (agentId: string) => LiftRoute | undefined;

/**
 * The states once `signal` arrives: an arrival walks in from the lift as
 * soon as its desk is laid out; a leaving walks out from its desk, which
 * the Floor keeps meanwhile. One with no way to walk is just there, or gone.
 */
export function receiveContractor(
  states: ContractorStates,
  signal: ContractorSignal,
  plan: LiftPlanner,
): ContractorStates {
  const next = new Map(states);
  const route = plan(signal.agentId);
  if (signal.type === "arrive") {
    next.set(
      signal.agentId,
      route === undefined
        ? { kind: "awaiting-desk", waited: 0 }
        : { kind: "walking", walk: { type: "arrive", route, elapsed: 0 } },
    );
    return next;
  }
  if (route === undefined) {
    next.delete(signal.agentId);
  } else {
    next.set(signal.agentId, {
      kind: "walking",
      walk: { type: "leave", route, elapsed: 0 },
    });
  }
  return next;
}

/**
 * The states `seconds` later: walks go on and end, an arrival whose desk
 * is now laid out sets off, and what waits too long is dropped.
 */
export function advanceContractors(
  states: ContractorStates,
  seconds: number,
  plan: LiftPlanner,
): ContractorStates {
  const next = new Map<string, ContractorState>();
  for (const [agentId, state] of states) {
    if (state.kind === "walking") {
      const walk = { ...state.walk, elapsed: state.walk.elapsed + seconds };
      // One that walked out waits in the lift until the team drops it.
      const over =
        walk.type === "leave"
          ? walk.elapsed >= walkLength(walk) + inLiftSeconds
          : walkDone(walk);
      if (!over) {
        next.set(agentId, { kind: "walking", walk });
      }
      continue;
    }
    const waited = state.waited + seconds;
    if (state.kind === "awaiting-desk") {
      const route = plan(agentId);
      if (route !== undefined) {
        next.set(agentId, {
          kind: "walking",
          walk: { type: "arrive", route, elapsed: 0 },
        });
      } else if (waited < deskWaitSeconds) {
        next.set(agentId, { kind: "awaiting-desk", waited });
      }
      continue;
    }
    if (waited < awaitSeconds) {
      next.set(agentId, { kind: "awaiting-walk", waited });
    }
  }
  return next;
}

/** How far a walker near the lift opens its doors: fully within a metre and a half. */
export const liftDoorsReach = { open: 1.5, closed: 2.5 } as const;

/** How open the lift's doors are for the Contractors walking by: 0 shut, 1 open. */
export function liftDoorsFor(states: ContractorStates): number {
  let open = 0;
  for (const state of states.values()) {
    if (state.kind !== "walking" || walkDone(state.walk)) {
      continue;
    }
    const away = distance(contractorPose(state.walk).position, [
      liftDoorway.position[0],
      liftDoorway.position[2],
    ]);
    const share =
      (liftDoorsReach.closed - away) /
      (liftDoorsReach.closed - liftDoorsReach.open);
    open = Math.max(open, Math.min(Math.max(share, 0), 1));
  }
  return open;
}

/** A Floor's Contractors coming and going, kept as the scene plays them. */
export interface ContractorWalker {
  /** A signal arrives: walked, or (for another Floor's) ignored. */
  readonly receive: (signal: ContractorSignal, plan: LiftPlanner) => void;
  /** `seconds` later. */
  readonly advance: (seconds: number, plan: LiftPlanner) => void;
  /**
   * A Contractor gone from the team: its desk is kept a moment for its
   * walk out, unless it has walked already, when it is gone for good.
   */
  readonly missing: (agentId: string) => void;
  /** No walks: everyone at their desks, or gone, at once (reduced motion). */
  readonly skipAll: () => void;
  /** Where a Contractor is on its walk; undefined at its desk. */
  readonly poseOf: (agentId: string) => MeetingPose | undefined;
  /** Whether a Contractor is coming or going, so not free for anything else. */
  readonly attending: (agentId: string) => boolean;
  /** Whether the Floor keeps a Contractor gone from its team, for its walk out. */
  readonly holds: (agentId: string) => boolean;
  /** How open the lift's doors are for those walking through them. */
  readonly liftDoors: () => number;
}

export function createContractorWalker(floorId: string): ContractorWalker {
  let states: ContractorStates = new Map();
  /** Those gone for good: never kept again. */
  const gone = new Set<string>();
  return {
    receive(signal, plan) {
      if (signal.floorId === floorId) {
        states = receiveContractor(states, signal, plan);
      }
    },
    advance(seconds, plan) {
      states = advanceContractors(states, seconds, plan);
    },
    missing(agentId) {
      const state = states.get(agentId);
      if (state === undefined && !gone.has(agentId)) {
        states = new Map(states).set(agentId, {
          kind: "awaiting-walk",
          waited: 0,
        });
      } else if (
        state?.kind === "walking" &&
        state.walk.type === "leave" &&
        walkDone(state.walk)
      ) {
        const next = new Map(states);
        next.delete(agentId);
        states = next;
        gone.add(agentId);
      }
    },
    skipAll() {
      if (states.size > 0) {
        states = new Map();
      }
    },
    poseOf(agentId) {
      const state = states.get(agentId);
      return state?.kind === "walking" ? contractorPose(state.walk) : undefined;
    },
    attending: (agentId) => states.get(agentId)?.kind === "walking",
    holds(agentId) {
      const state = states.get(agentId);
      return (
        state?.kind === "awaiting-walk" ||
        (state?.kind === "walking" &&
          state.walk.type === "leave" &&
          !walkDone(state.walk))
      );
    },
    liftDoors: () => liftDoorsFor(states),
  };
}

/**
 * The team the Floor lays out: `team`, with each Contractor gone from it
 * that the Floor still `holds` for its walk out, back where it was in
 * `shown`, the team last laid out, so no other desk moves meanwhile.
 */
export function withLeaving<Agent extends { readonly id: string }>(
  team: readonly Agent[],
  shown: readonly Agent[],
  holds: (agentId: string) => boolean,
): Agent[] {
  const next = [...team];
  shown.forEach((agent, index) => {
    if (!team.some(({ id }) => id === agent.id) && holds(agent.id)) {
      next.splice(Math.min(index, next.length), 0, agent);
    }
  });
  return next;
}
