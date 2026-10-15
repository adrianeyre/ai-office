import { seasonalActors, type SeasonalActorId } from "@ai-office/shared";

import type { AnimationName } from "./avatar-animations.ts";
import type { FloorLayout } from "./floor-layout.ts";
import { headingAlong, lengthOf, pointAlong } from "./handoff-walks.ts";
import {
  idleActivities,
  idlePlaceOn,
  idlePlaces,
  mountedLocations,
  seatedLocations,
  type IdleLocation,
} from "./idle-behaviours.ts";
import { liftDoorway, liftWall } from "./lift-layout.ts";
import {
  entrance,
  lobbySize,
  lobbyWaterCooler,
  noticeBoardPosition,
} from "./lobby-layout.ts";
import { distance, walk, type FloorPoint } from "./waypoints.ts";

// The seasonal actors' visits (data only, no three.js): now and then, in
// season, one steps out of the lift, goes round the Office (Santa and the
// Grinch walk, Halloween's frights run, the ghost floats, the Elf and the
// Easter Bunny hop, New Year's drunks stagger) a different way each time,
// stops by a few of the Agents to say one of its lines (Santa gives
// presents, the frights scare them, the drunks sway), has a go at what
// the Floor has to play (darts, pool, table tennis, the punchbag…) or
// wanders off along the way, Santa leaves presents under the tree, and it
// goes back into the lift.

/** Metres a second, by gait. */
export const gaitSpeed = {
  walk: 1.25,
  run: 2.6,
  hop: 1.5,
  stagger: 0.8,
  float: 1.4,
} as const;

/** Seconds an actor stays with each Agent it visits, and at the tree. */
export const stopSeconds = 3;

/** Seconds an actor plays at something on the Floor, such as darts. */
export const playSeconds = 7;

/** How many stops it makes on a Floor (Agents and things to play), at most. */
export const visitsPerTrip = 3;

/** Seconds between visits, at least and at most; the first comes sooner. */
export const visitGap = { first: [15, 45], next: [90, 240] } as const;

/** Inside the lift car, where an actor appears and disappears. */
export const insideLift: FloorPoint = [
  liftDoorway.position[0],
  liftDoorway.position[2] - liftWall.thickness - 0.5,
];

export interface VisitPose {
  readonly position: FloorPoint;
  readonly heading: number;
  readonly animation: AnimationName;
  /** What it says, while it stops. */
  readonly bubble: string | undefined;
}

export type VisitStep =
  | {
      readonly kind: "go";
      readonly path: readonly FloorPoint[];
      readonly seconds: number;
    }
  | {
      readonly kind: "stop";
      readonly at: FloorPoint;
      readonly heading: number;
      readonly animation: AnimationName;
      readonly seconds: number;
      readonly bubble?: string;
    };

/** One actor's trip, from the lift and back. */
export interface Visit {
  readonly actor: SeasonalActorId;
  readonly steps: readonly VisitStep[];
  readonly seconds: number;
}

const movingAnimation: Record<keyof typeof gaitSpeed, AnimationName> = {
  walk: "walk",
  run: "run",
  hop: "hop",
  stagger: "stagger",
  float: "float",
};

/**
 * What an actor says at its stops, one of `lines` at each, and `random`,
 * which picks them, its stops and its way round.
 */
export interface VisitLines {
  readonly lines?: readonly string[] | undefined;
  readonly random?: (() => number) | undefined;
}

/** A line for a stop. */
const lineOf = (
  actor: SeasonalActorId,
  { lines, random = Math.random }: VisitLines,
): string => {
  const said =
    lines !== undefined && lines.length > 0
      ? lines
      : seasonalActors[actor].says;
  return said[Math.floor(random() * said.length)] ?? said[0] ?? "";
};

/** Facing from `from` towards `to`, as the scene's headings go (0 faces +z). */
const facing = (from: FloorPoint, to: FloorPoint) =>
  Math.atan2(to[0] - from[0], to[1] - from[1]);

/** Builds a trip along `legs`, stopping at the end of each but the last. */
function trip(
  actor: SeasonalActorId,
  legs: readonly {
    readonly path: readonly FloorPoint[];
    /** What it faces (or which way) as it stops, what it does there, and how long. */
    readonly stop?: {
      readonly towards: FloorPoint | { readonly heading: number };
      readonly animation: AnimationName;
      readonly bubble?: string;
      readonly seconds?: number;
    };
  }[],
): Visit {
  const speed = gaitSpeed[seasonalActors[actor].gait];
  const steps: VisitStep[] = [];
  for (const { path, stop } of legs) {
    if (path.length > 1) {
      steps.push({ kind: "go", path, seconds: lengthOf(path) / speed });
    }
    const end = path.at(-1);
    if (stop !== undefined && end !== undefined) {
      steps.push({
        kind: "stop",
        at: end,
        heading:
          "heading" in stop.towards
            ? stop.towards.heading
            : facing(end, stop.towards),
        animation: stop.animation,
        seconds: stop.seconds ?? stopSeconds,
        ...(stop.bubble === undefined ? {} : { bubble: stop.bubble }),
      });
    }
  }
  return {
    actor,
    steps,
    seconds: steps.reduce((sum, step) => sum + step.seconds, 0),
  };
}

/** What an actor does as it stops by an Agent. */
const stopAnimation = (actor: SeasonalActorId): AnimationName => {
  if (actor === "santa" || actor === "elf") {
    return "hand-over";
  }
  switch (seasonalActors[actor].gait) {
    case "run":
      return "scare";
    case "stagger":
      return "sway";
    case "walk":
      return "scare";
    case "hop":
      return "hop";
    case "float":
      return "scare";
  }
};

/** The waypoints along `walk`'s route, as points; none if there is none. */
const route = (layout: FloorLayout, from: string, to: string): FloorPoint[] =>
  (walk(layout.waypoints, from, to) ?? []).map(({ position }) => position);

/** Joins paths end to start, dropping a point that repeats the one before. */
const joined = (...paths: readonly (readonly FloorPoint[])[]): FloorPoint[] =>
  paths.flat().filter((point, index, all) => {
    const before = all[index - 1];
    return before === undefined || distance(before, point) > 1e-6;
  });

/** `items` in a random order. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const order = [...items];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const here = order[index];
    const there = order[other];
    if (here !== undefined && there !== undefined) {
      order[index] = there;
      order[other] = here;
    }
  }
  return order;
}

/** Something on a Floor an actor may have a go at: where, and what it plays. */
export interface Plaything {
  readonly location: Exclude<IdleLocation, "chair" | "beside the desk">;
  readonly animation: AnimationName;
  readonly bubble: string | undefined;
}

/**
 * What an actor may play at on a Floor: each amenity the Agents stand at
 * (darts, pool, table tennis, the punchbag, the basketball hoop…), with
 * its first such activity's animation, if the Floor has its waypoint.
 * Seats and the treadmill are left to the Agents.
 */
export function playthings(
  layout: Pick<FloorLayout, "waypoints">,
): Plaything[] {
  const here = new Set(layout.waypoints.waypoints.map(({ id }) => id));
  const found = new Map<Plaything["location"], Plaything>();
  for (const { location, animation, bubble, when } of idleActivities) {
    if (
      when === "idle" &&
      location !== "chair" &&
      location !== "beside the desk" &&
      !seatedLocations.includes(location) &&
      !mountedLocations.includes(location) &&
      here.has(location) &&
      !found.has(location)
    ) {
      found.set(location, { location, animation, bubble });
    }
  }
  return [...found.values()];
}

/** One of a Floor visit's stops: by an Agent's desk, or at a plaything. */
type FloorStop =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "play"; readonly plaything: Plaything };

/**
 * An actor's trip round a Floor, a different way each time: out of the
 * lift, to `visitsPerTrip` stops in a random order, some by its Agents'
 * desks (`agents`, in the order chosen) to say its piece and the rest at
 * things to play (darts, pool…), now and then by way of somewhere else on
 * the Floor; Santa to the tree too; and back into the lift.
 */
export function floorVisit(
  layout: FloorLayout,
  actor: SeasonalActorId,
  agents: readonly string[],
  tree?: FloorPoint,
  lines: VisitLines = {},
): Visit {
  const random = lines.random ?? Math.random;
  const says = () => lineOf(actor, lines);
  const byId = new Map(
    layout.waypoints.waypoints.map(({ id, position }) => [id, position]),
  );
  const desks = layout.desks.filter(({ agentId }) => agents.includes(agentId));
  const order = agents
    .map((id) => desks.find(({ agentId }) => agentId === id))
    .filter((desk) => desk !== undefined);
  const toPlay = shuffled(playthings(layout), random);
  // At least one Agent, when there is one, and one plaything, when there
  // is one; the rest either.
  const agentStops = Math.min(
    order.length,
    toPlay.length === 0
      ? visitsPerTrip
      : 1 + Math.floor(random() * (visitsPerTrip - 1)),
  );
  const stops = shuffled<FloorStop>(
    [
      ...order
        .slice(0, agentStops)
        .map(({ agentId }): FloorStop => ({ kind: "agent", agentId })),
      ...toPlay
        .slice(0, visitsPerTrip - agentStops)
        .map((plaything): FloorStop => ({ kind: "play", plaything })),
    ],
    random,
  );
  // Where to wander by on the way: anywhere on the Floor's walkways.
  const anywhere = layout.waypoints.waypoints
    .map(({ id }) => id)
    .filter((id) => id !== "lift");
  /** From waypoint `from` to `to`, by somewhere else half the time. */
  const wander = (from: string, to: string): FloorPoint[] => {
    const by = anywhere[Math.floor(random() * anywhere.length)];
    if (random() < 0.5 && by !== undefined && by !== from && by !== to) {
      const there = route(layout, from, by);
      const on = route(layout, by, to);
      if (there.length > 0 && on.length > 0) {
        return joined(there, on);
      }
    }
    return route(layout, from, to);
  };
  const legs: Parameters<typeof trip>[1][number][] = [];
  let at = "lift";
  // The way off a plaything's place, back to its waypoint.
  let back: FloorPoint[] = [];
  for (const stop of stops) {
    if (stop.kind === "agent") {
      const desk = order.find(({ agentId }) => agentId === stop.agentId);
      if (desk === undefined) {
        continue;
      }
      legs.push({
        path: joined(back, wander(at, desk.waypoint)),
        stop: {
          towards: [desk.seat[0], desk.seat[2]],
          animation: stopAnimation(actor),
          bubble: says(),
        },
      });
      at = desk.waypoint;
      back = [];
    } else {
      const { location, animation, bubble } = stop.plaything;
      const place = idlePlaceOn(
        layout.waypoints,
        location,
        Math.floor(random() * idlePlaces[location].length),
      );
      if (place === undefined) {
        continue;
      }
      const via = place.via ?? [];
      legs.push({
        path: joined(back, wander(at, location), via, [place.at]),
        stop: {
          towards: { heading: place.heading },
          animation,
          bubble: bubble === undefined ? says() : `${bubble} ${says()}`,
          seconds: playSeconds,
        },
      });
      at = location;
      back = [place.at, ...[...via].reverse()];
      const waypoint = byId.get(location);
      if (waypoint !== undefined) {
        back.push(waypoint);
      }
    }
  }
  if (actor === "santa" && tree !== undefined) {
    // The waypoint nearest the tree, and presents left under it.
    const nearest = layout.waypoints.waypoints.reduce((best, each) =>
      distance(each.position, tree) < distance(best.position, tree)
        ? each
        : best,
    );
    legs.push({
      path: joined(back, route(layout, at, nearest.id)),
      stop: { towards: tree, animation: "hand-over", bubble: says() },
    });
    at = nearest.id;
    back = [];
  }
  const lift = byId.get("lift");
  return trip(actor, [
    { path: lift === undefined ? [insideLift] : [insideLift, lift] },
    ...legs,
    { path: joined(back, route(layout, at, "lift"), [insideLift]) },
  ]);
}

/** The lobby's way round: out of the lift, down to the walkway, along it and back. */
const lobbyDoor: FloorPoint = [
  liftDoorway.position[0],
  liftDoorway.position[2] + 0.8,
];
/** The walkway from the entrance across the lobby: its middle, front to back. */
const lobbyWalkway = (entrance.z[0] + entrance.z[1]) / 2;
const lobbyCorner: FloorPoint = [liftDoorway.position[0], lobbyWalkway];
const receptionDesk: FloorPoint = [-4, -2.9];
/** Where Santa stands to leave presents under the lobby's tree. */
const lobbyTreeStop: FloorPoint = [5.5, -3.4];

/** Somewhere in the lobby an actor stops: where, what it faces, and what it does. */
interface LobbyStop {
  readonly at: FloorPoint;
  readonly towards: FloorPoint;
  readonly animation?: AnimationName;
}

/**
 * Where an actor may stop in the lobby, each reached from the walkway
 * across it: reception, the Notice Board, the water cooler, by the
 * entrance and by the sofa.
 */
export const lobbyStops: Readonly<Record<string, LobbyStop>> = {
  reception: { at: [-4, lobbyWalkway - 0.3], towards: receptionDesk },
  "notice board": {
    at: [noticeBoardPosition[0], noticeBoardPosition[2] + 1.2],
    towards: [noticeBoardPosition[0], noticeBoardPosition[2]],
  },
  "water cooler": {
    at: [lobbyWaterCooler[0] + 0.3, lobbyWaterCooler[1] + 0.6],
    towards: [lobbyWaterCooler[0], lobbyWaterCooler[1]],
    animation: "drink",
  },
  entrance: {
    at: [-lobbySize.width / 2 + 1.3, lobbyWalkway],
    towards: [-lobbySize.width / 2, lobbyWalkway],
  },
  sofa: { at: [2.7, 4.3], towards: [2.7, 5.15] },
};

/**
 * An actor's trip round the lobby, a different way each time: out of the
 * lift, along the walkway to one to three of `lobbyStops` in a random
 * order, saying its piece at each, Santa to the tree first, and back.
 */
export function lobbyVisit(
  actor: SeasonalActorId,
  tree?: FloorPoint,
  lines: VisitLines = {},
): Visit {
  const random = lines.random ?? Math.random;
  const says = () => lineOf(actor, lines);
  const chosen = shuffled(Object.values(lobbyStops), random).slice(
    0,
    1 + Math.floor(random() * 3),
  );
  // Along the walkway a little to one side or the other each time.
  const lane = () => lobbyWalkway + (random() - 0.5) * 0.6;
  const legs: Parameters<typeof trip>[1][number][] = [];
  let from: FloorPoint = lobbyDoor;
  if (actor === "santa" && tree !== undefined) {
    legs.push(
      {
        path: [lobbyDoor, lobbyTreeStop],
        stop: { towards: tree, animation: "hand-over", bubble: says() },
      },
      { path: [lobbyTreeStop, lobbyDoor] },
    );
  }
  let onWalkway: FloorPoint = [lobbyCorner[0], lane()];
  legs.push({ path: [from, onWalkway] });
  from = onWalkway;
  for (const stop of chosen) {
    const below: FloorPoint = [stop.at[0], lane()];
    legs.push({
      path: joined([from, below, stop.at]),
      stop: {
        towards: stop.towards,
        animation: stop.animation ?? stopAnimation(actor),
        bubble: says(),
      },
    });
    from = stop.at;
    onWalkway = below;
    legs.push({ path: joined([from, onWalkway]) });
    from = onWalkway;
  }
  return trip(actor, [
    { path: [insideLift, lobbyDoor] },
    ...legs,
    { path: joined([from, [lobbyCorner[0], from[1]], lobbyDoor, insideLift]) },
  ]);
}

/** Where an actor is, `elapsed` seconds into its trip; undefined once it is over. */
export function visitPose(
  visit: Visit,
  elapsed: number,
): VisitPose | undefined {
  if (elapsed >= visit.seconds) {
    return undefined;
  }
  let left = Math.max(0, elapsed);
  const moving = movingAnimation[seasonalActors[visit.actor].gait];
  const speed = gaitSpeed[seasonalActors[visit.actor].gait];
  for (const step of visit.steps) {
    if (left < step.seconds) {
      if (step.kind === "stop") {
        return {
          position: step.at,
          heading: step.heading,
          animation: step.animation,
          bubble: step.bubble,
        };
      }
      const along = Math.min(left * speed, lengthOf(step.path));
      return {
        position: pointAlong(step.path, along),
        heading: headingAlong(step.path, along),
        animation: moving,
        bubble: undefined,
      };
    }
    left -= step.seconds;
  }
  return undefined;
}

/** How open an actor near the lift holds its doors, 0 to 1. */
export function visitLiftDoors(pose: VisitPose | undefined): number {
  if (pose === undefined) {
    return 0;
  }
  const doorway: FloorPoint = [
    liftDoorway.position[0],
    liftDoorway.position[2],
  ];
  const away = distance(pose.position, doorway);
  return away <= 1.5 ? 1 : away >= 2.5 ? 0 : 2.5 - away;
}

/**
 * The way an actor has come so far, `elapsed` seconds into its trip: from
 * inside the lift to where it is now.
 */
export function travelled(visit: Visit, elapsed: number): FloorPoint[] {
  const speed = gaitSpeed[seasonalActors[visit.actor].gait];
  const points: FloorPoint[] = [];
  let left = Math.max(0, elapsed);
  for (const step of visit.steps) {
    if (step.kind === "stop") {
      if (points.length === 0) {
        points.push(step.at);
      }
      if (left < step.seconds) {
        return points;
      }
    } else {
      const along = Math.min(left * speed, lengthOf(step.path));
      let walked = 0;
      for (const [index, point] of step.path.entries()) {
        const previous = step.path[index - 1];
        walked += previous === undefined ? 0 : distance(previous, point);
        if (walked > along) {
          break;
        }
        points.push(point);
      }
      if (left < step.seconds) {
        points.push(pointAlong(step.path, along));
        return points;
      }
    }
    left -= step.seconds;
  }
  return points;
}

/**
 * An actor sent away mid-trip: from where it is, back the way it came to
 * the lift, unless `back` gives a shorter way from the way it came.
 */
export function leavingVisit(
  visit: Visit,
  elapsed: number,
  back?: (way: readonly FloorPoint[]) => FloorPoint[] | undefined,
): Visit | undefined {
  const way = travelled(visit, elapsed);
  if (way.length === 0) {
    return undefined;
  }
  const path = back?.(way) ?? [...way].reverse();
  return trip(visit.actor, [{ path }]);
}

/**
 * The way back to the lift on a Floor for an actor sent away, `way` the
 * way it came: back to the waypoint it last passed, then the shortest way
 * to the lift. Undefined if that was not a waypoint.
 */
export function floorWayBack(
  layout: FloorLayout,
  way: readonly FloorPoint[],
): FloorPoint[] | undefined {
  const here = way.at(-1);
  const passed = way.at(-2);
  const waypoint = layout.waypoints.waypoints.find(
    ({ position }) => passed !== undefined && distance(position, passed) < 1e-6,
  );
  if (here === undefined || waypoint === undefined) {
    return undefined;
  }
  return [here, ...route(layout, waypoint.id, "lift"), insideLift];
}
