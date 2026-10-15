import type { StreamedEvent } from "@ai-office/events/stream";

import { deskFacing } from "./desk-set.ts";
import type { FloorDesk, FloorLayout } from "./floor-layout.ts";
import { distance, walk, type FloorPoint } from "./waypoints.ts";

// Handoffs in the Office (PRD FR-59), as data, so the scene only draws
// them. At a Handoff the Agent stands, carries a ticket with the issue's
// number along the Floor's waypoints to beside the next Agent's chair,
// hands it over (the receiving monitor lights up), walks back and sits
// down. The pipeline never waits for it: the event has already happened,
// and the walk catches up. Each Agent walks one Handoff at a time; the
// next waits, and the walk under way hurries while it does. A Handoff
// that falls further behind than that is skipped: its ticket is handed
// over at once, and only the newest is walked.

/** A Handoff, as the Office shows it: the ticket one Agent walks to the next. */
export interface HandoffTicket {
  /** The `handoff` event's id. */
  readonly id: number;
  readonly floorId: string;
  readonly issue: number;
  /** The stage the issue moves to, such as `needs-review`: the ticket's colour. */
  readonly stage: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
}

/** The Handoffs among `events`, oldest first, as tickets. */
export function handoffTickets(
  events: readonly StreamedEvent[],
): HandoffTicket[] {
  return events.flatMap(({ id, event }) =>
    event.type === "handoff"
      ? [
          {
            id,
            floorId: event.floorId,
            issue: event.issue,
            stage: event.stage,
            fromAgentId: event.fromAgentId,
            toAgentId: event.toAgentId,
          },
        ]
      : [],
  );
}

/** How fast an Agent walks: an unhurried office pace, matching the walk's stride. */
export const walkSpeed = 1.25;

/** How far beside its chair an Agent steps to stand up and walk off. */
export const stepAside = 0.55;

/** How long each part of a walk at the desks takes: the animations'. */
export const walkSeconds = {
  standUp: 1.2,
  handOver: 1,
  sitDown: 1.2,
} as const;

/** How much faster a walk plays while the next Handoff waits for it. */
export const catchUpPace = 2;

/**
 * How long a receiving monitor stays lit after a ticket is handed over,
 * and how long, at the end of it, it takes to fade.
 */
export const monitorLight = { seconds: 3, fade: 1 } as const;

/** Which way a direction on the floor faces: an Avatar faces +z, turned about y. */
export const headingOf = ([dx, dz]: FloorPoint) => Math.atan2(dx, dz);

const close = (a: FloorPoint, b: FloorPoint) => distance(a, b) < 1e-6;

/** A path's length, in metres. */
export const lengthOf = (path: readonly FloorPoint[]) =>
  path.reduce(
    (sum, point, index) => sum + distance(path[index - 1] ?? point, point),
    0,
  );

/** Whether `point` lies on the segment from `a` to `b`. */
export function onSegment(
  point: FloorPoint,
  a: FloorPoint,
  b: FloorPoint,
): boolean {
  return (
    Math.abs(distance(a, point) + distance(point, b) - distance(a, b)) < 1e-6
  );
}

/**
 * How an Agent gets from its chair to the walkway its desk's waypoint is
 * on, heading for `towards`: a step aside, clear of the chair, on the side
 * nearer where it is going, then straight back (or forwards) to the
 * walkway, level with the waypoint. Without a turn, the two are the same.
 */
export function stepOff(
  desk: FloorDesk,
  waypoint: FloorPoint,
  towards: FloorPoint,
): FloorPoint[] {
  const [sx, , sz] = desk.seat;
  const facing = deskFacing(desk.turns);
  const forwards: FloorPoint = [Math.sin(facing), Math.cos(facing)];
  const across: FloorPoint = [Math.cos(facing), -Math.sin(facing)];
  const along = (point: FloorPoint, axis: FloorPoint) =>
    (point[0] - sx) * axis[0] + (point[1] - sz) * axis[1];
  const lean = along(towards, across);
  const side = Math.abs(lean) < 0.01 ? 1 : Math.sign(lean);
  const aside: FloorPoint = [
    sx + across[0] * side * stepAside,
    sz + across[1] * side * stepAside,
  ];
  const depth = along(waypoint, forwards);
  const level: FloorPoint = [
    aside[0] + forwards[0] * depth,
    aside[1] + forwards[1] * depth,
  ];
  return close(aside, level) ? [aside] : [aside, level];
}

export interface HandoffRoute {
  /**
   * From the giver's seat to beside the receiver's chair: off its chair to
   * its walkway, along the Floor's waypoints, and off the receiver's
   * walkway to beside its chair. Walked back the other way.
   */
  readonly path: readonly FloorPoint[];
  /** Its length, in metres. */
  readonly length: number;
  /** Which way the giver faces in its chair. */
  readonly seatHeading: number;
  /** Which way it faces as it hands over: towards the receiver's seat. */
  readonly handOverHeading: number;
}

/**
 * The way a Handoff is walked on a Floor, from one Agent's desk to
 * another's; undefined when either has no desk there, they are the same
 * Agent, or no waypoints join them.
 */
export function handoffRoute(
  layout: Pick<FloorLayout, "desks" | "waypoints">,
  fromAgentId: string,
  toAgentId: string,
): HandoffRoute | undefined {
  const giver = layout.desks.find(({ agentId }) => agentId === fromAgentId);
  const receiver = layout.desks.find(({ agentId }) => agentId === toAgentId);
  if (giver === undefined || receiver === undefined || giver === receiver) {
    return undefined;
  }
  const way = walk(layout.waypoints, giver.waypoint, receiver.waypoint);
  const first = way?.[0];
  const last = way?.at(-1);
  if (way === undefined || first === undefined || last === undefined) {
    return undefined;
  }
  const points = way.map(({ position }) => position);
  const out = stepOff(giver, first.position, (way[1] ?? last).position);
  const into = stepOff(
    receiver,
    last.position,
    (way.at(-2) ?? first).position,
  ).reverse();
  // Joining the walkway past the desk's own waypoint, on the way to the
  // next, the Agent goes straight on rather than back to it.
  const outOn = out.at(-1);
  const intoOn = into[0];
  const second = points[1];
  const penultimate = points.at(-2);
  if (
    outOn !== undefined &&
    second !== undefined &&
    onSegment(outOn, first.position, second)
  ) {
    points.shift();
  }
  if (
    intoOn !== undefined &&
    penultimate !== undefined &&
    points.length > 0 &&
    onSegment(intoOn, penultimate, last.position)
  ) {
    points.pop();
  }
  const seat = (desk: FloorDesk): FloorPoint => [desk.seat[0], desk.seat[2]];
  const path = [seat(giver), ...out, ...points, ...into].filter(
    (point, index, all) => {
      const before = all[index - 1];
      return before === undefined || !close(before, point);
    },
  );
  const end = path.at(-1) ?? seat(giver);
  const [rx, rz] = seat(receiver);
  return {
    path,
    length: lengthOf(path),
    seatHeading: deskFacing(giver.turns),
    handOverHeading: headingOf([rx - end[0], rz - end[1]]),
  };
}

/**
 * The way from an Agent's chair to one of the Floor's waypoints: off its
 * chair to its walkway, then along the waypoints, going straight on past
 * its desk's own waypoint rather than back to it. Undefined when it has no
 * desk there, or no waypoints join them.
 */
export function routeFromDesk(
  layout: Pick<FloorLayout, "desks" | "waypoints">,
  agentId: string,
  to: string,
): { readonly path: FloorPoint[]; readonly seatHeading: number } | undefined {
  const desk = layout.desks.find((each) => each.agentId === agentId);
  if (desk === undefined) {
    return undefined;
  }
  const way = walk(layout.waypoints, desk.waypoint, to);
  const first = way?.[0];
  const last = way?.at(-1);
  if (way === undefined || first === undefined || last === undefined) {
    return undefined;
  }
  const points = way.map(({ position }) => position);
  const out = stepOff(desk, first.position, (way[1] ?? last).position);
  const outOn = out.at(-1);
  const second = points[1];
  if (
    outOn !== undefined &&
    second !== undefined &&
    onSegment(outOn, first.position, second)
  ) {
    points.shift();
  }
  const seat: FloorPoint = [desk.seat[0], desk.seat[2]];
  return {
    path: [seat, ...out, ...points].filter((point, index, all) => {
      const before = all[index - 1];
      return before === undefined || !close(before, point);
    }),
    seatHeading: deskFacing(desk.turns),
  };
}

/** Where a path is, `along` metres from its start (clamped to it). */
export function pointAlong(
  path: readonly FloorPoint[],
  along: number,
): FloorPoint {
  let left = Math.max(along, 0);
  for (const [index, to] of path.entries()) {
    const from = path[index - 1];
    if (from === undefined) {
      continue;
    }
    const length = distance(from, to);
    if (left <= length) {
      const share = length === 0 ? 0 : left / length;
      return [
        from[0] + (to[0] - from[0]) * share,
        from[1] + (to[1] - from[1]) * share,
      ];
    }
    left -= length;
  }
  return path.at(-1) ?? [0, 0];
}

/** How far ahead and behind a walker looks to turn: it rounds each corner. */
const turnReach = 0.25;

/** Which way a path heads `along` metres from its start, rounding its corners. */
export function headingAlong(
  path: readonly FloorPoint[],
  along: number,
): number {
  const length = lengthOf(path);
  const from = pointAlong(path, Math.min(along - turnReach, length - 0.01));
  const to = pointAlong(path, Math.max(along + turnReach, 0.01));
  return headingOf([to[0] - from[0], to[1] - from[1]]);
}

/** One Handoff's walk, timed. */
export interface HandoffWalk {
  readonly ticket: HandoffTicket;
  readonly route: HandoffRoute;
  /** Seconds from standing up to the ticket leaving its hand. */
  readonly handOverAt: number;
  /** Seconds from standing up to sitting back down. */
  readonly duration: number;
}

export function handoffWalk(
  ticket: HandoffTicket,
  route: HandoffRoute,
): HandoffWalk {
  const walking = route.length / walkSpeed;
  const handOverAt = walkSeconds.standUp + walking + walkSeconds.handOver;
  return {
    ticket,
    route,
    handOverAt,
    duration: handOverAt + walking + walkSeconds.sitDown,
  };
}

/** Where a walking Agent is, which way it faces, and what it plays. */
export interface WalkPose {
  readonly position: FloorPoint;
  readonly heading: number;
  readonly animation: "stand-up" | "carry" | "hand-over" | "walk" | "sit-down";
  /** The ticket in its hands: from setting off until it is handed over. */
  readonly carrying: boolean;
}

/** A walk, `elapsed` seconds after its Agent began to stand. */
export function walkPose(walk: HandoffWalk, elapsed: number): WalkPose {
  const { path, length, seatHeading, handOverHeading } = walk.route;
  const seat = path[0] ?? [0, 0];
  const walking = length / walkSpeed;
  const there = walkSeconds.standUp + walking;
  if (elapsed < walkSeconds.standUp) {
    return {
      position: seat,
      heading: seatHeading,
      animation: "stand-up",
      carrying: false,
    };
  }
  if (elapsed < there) {
    const along = (elapsed - walkSeconds.standUp) * walkSpeed;
    return {
      position: pointAlong(path, along),
      heading: headingAlong(path, along),
      animation: "carry",
      carrying: true,
    };
  }
  if (elapsed < walk.handOverAt) {
    return {
      position: pointAlong(path, length),
      heading: handOverHeading,
      animation: "hand-over",
      carrying: true,
    };
  }
  if (elapsed < walk.handOverAt + walking) {
    const along = length - (elapsed - walk.handOverAt) * walkSpeed;
    return {
      position: pointAlong(path, along),
      heading: headingAlong(path, along) + Math.PI,
      animation: "walk",
      carrying: false,
    };
  }
  return {
    position: seat,
    heading: seatHeading,
    animation: "sit-down",
    carrying: false,
  };
}

/** The walk an Agent is on, and how far into it. */
export interface WalkUnderWay {
  readonly walk: HandoffWalk;
  readonly elapsed: number;
  readonly handedOver: boolean;
}

/** One Agent's Handoffs: the one it is walking, and the next, waiting. */
export interface AgentWalks {
  readonly current: WalkUnderWay;
  readonly next: HandoffTicket | undefined;
}

/** Each walking Agent's Handoffs, by its id. */
export type HandoffQueues = ReadonlyMap<string, AgentWalks>;

/** How a ticket is walked; undefined when it cannot be, and is handed over at once. */
export type WalkPlanner = (ticket: HandoffTicket) => HandoffWalk | undefined;

export interface QueueStep {
  readonly queues: HandoffQueues;
  /** The tickets handed over in this step, walked or skipped, in order. */
  readonly handedOver: readonly HandoffTicket[];
}

/** The pace an Agent's walk plays at: hurried while another waits for it. */
export const paceOf = (walks: AgentWalks) =>
  walks.next === undefined ? 1 : catchUpPace;

/**
 * The queues once `ticket` arrives. Its Agent sets off at once if it is
 * not walking; otherwise the ticket waits for the walk under way. Only one
 * waits: one already waiting has fallen behind, and is skipped, handed
 * over at once, for the newer.
 */
export function queueHandoff(
  queues: HandoffQueues,
  ticket: HandoffTicket,
  plan: WalkPlanner,
): QueueStep {
  const walks = queues.get(ticket.fromAgentId);
  const next = new Map(queues);
  if (walks === undefined) {
    const walk = plan(ticket);
    if (walk === undefined) {
      return { queues, handedOver: [ticket] };
    }
    next.set(ticket.fromAgentId, {
      current: { walk, elapsed: 0, handedOver: false },
      next: undefined,
    });
    return { queues: next, handedOver: [] };
  }
  next.set(ticket.fromAgentId, { ...walks, next: ticket });
  return {
    queues: next,
    handedOver: walks.next === undefined ? [] : [walks.next],
  };
}

/**
 * The queues `seconds` later. Each walk moves on at its pace, handing its
 * ticket over as it passes the hand-over; a walk that ends starts the
 * ticket waiting for it, if there is one.
 */
export function advanceHandoffs(
  queues: HandoffQueues,
  seconds: number,
  plan: WalkPlanner,
): QueueStep {
  const next = new Map<string, AgentWalks>();
  const handedOver: HandoffTicket[] = [];
  for (const [agentId, walks] of queues) {
    const { walk, handedOver: given } = walks.current;
    const elapsed = walks.current.elapsed + seconds * paceOf(walks);
    if (!given && elapsed >= walk.handOverAt) {
      handedOver.push(walk.ticket);
    }
    if (elapsed < walk.duration) {
      next.set(agentId, {
        ...walks,
        current: {
          walk,
          elapsed,
          handedOver: given || elapsed >= walk.handOverAt,
        },
      });
      continue;
    }
    if (walks.next !== undefined) {
      const step = queueHandoff(new Map(), walks.next, plan);
      const started = step.queues.get(agentId);
      if (started !== undefined) {
        next.set(agentId, started);
      }
      handedOver.push(...step.handedOver);
    }
  }
  return { queues: next, handedOver };
}

/** Every ticket in `queues` handed over at once: walks under way and waiting. */
export function skipHandoffs(queues: HandoffQueues): QueueStep {
  return {
    queues: new Map(),
    handedOver: [...queues.values()].flatMap(({ current, next }) => [
      ...(current.handedOver ? [] : [current.walk.ticket]),
      ...(next === undefined ? [] : [next]),
    ]),
  };
}

/** A Floor's Handoff walks, kept as the scene plays them. */
export interface HandoffWalker {
  /** A ticket arrives: walked, queued, or (for another Floor's) ignored. */
  readonly receive: (ticket: HandoffTicket, plan: WalkPlanner) => void;
  /** `seconds` later. */
  readonly advance: (seconds: number, plan: WalkPlanner) => void;
  /** Every ticket handed over at once (reduced motion). */
  readonly skipAll: () => void;
  /** Where an Agent is on its walk, and its pace; undefined at its desk. */
  readonly poseOf: (
    agentId: string,
  ) => (WalkPose & { readonly pace: number }) | undefined;
  /** The tickets being carried now, by the carrying Agent's id. */
  readonly carried: () => ReadonlyMap<string, HandoffTicket>;
  /**
   * How lit an Agent's monitor is from a ticket handed to it: 1 as it
   * arrives, fading to 0 at the end of `monitorLight.seconds`.
   */
  readonly light: (agentId: string) => number;
  /** Whether any monitor is lit by a Handoff. */
  readonly lit: () => boolean;
}

export function createHandoffWalker(floorId: string): HandoffWalker {
  let queues: HandoffQueues = new Map();
  const lights = new Map<string, number>();
  const apply = (step: QueueStep) => {
    queues = step.queues;
    for (const { toAgentId } of step.handedOver) {
      lights.set(toAgentId, monitorLight.seconds);
    }
  };
  return {
    receive(ticket, plan) {
      if (ticket.floorId === floorId) {
        apply(queueHandoff(queues, ticket, plan));
      }
    },
    advance(seconds, plan) {
      for (const [agentId, left] of lights) {
        if (left <= seconds) {
          lights.delete(agentId);
        } else {
          lights.set(agentId, left - seconds);
        }
      }
      apply(advanceHandoffs(queues, seconds, plan));
    },
    skipAll() {
      apply(skipHandoffs(queues));
    },
    poseOf(agentId) {
      const walks = queues.get(agentId);
      return walks === undefined
        ? undefined
        : {
            ...walkPose(walks.current.walk, walks.current.elapsed),
            pace: paceOf(walks),
          };
    },
    carried() {
      const result = new Map<string, HandoffTicket>();
      for (const [agentId, { current }] of queues) {
        if (walkPose(current.walk, current.elapsed).carrying) {
          result.set(agentId, current.walk.ticket);
        }
      }
      return result;
    },
    light(agentId) {
      const left = lights.get(agentId) ?? 0;
      return Math.min(left / monitorLight.fade, 1);
    },
    lit: () => lights.size > 0,
  };
}
