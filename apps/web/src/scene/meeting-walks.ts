import type { StreamedEvent } from "@ai-office/events/stream";

import type { AnimationName } from "./avatar-animations.ts";
import { meetingTable, type FloorLayout } from "./floor-layout.ts";
import {
  headingAlong,
  headingOf,
  lengthOf,
  pointAlong,
  routeFromDesk,
  walkSeconds,
  walkSpeed,
} from "./handoff-walks.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// The Kickoff and the Wrap-up in the Office (PRD FR-60), as data, so the
// scene only draws them. At a Kickoff the Agents a Plan assigns get up,
// walk to the meeting room and take a seat at the table, the Manager
// standing at the whiteboard, while the whiteboard fills in; when the
// Kickoff ends they walk back to their desks. At a Wrap-up they gather
// again while the whiteboard shows the results, for a while. As with
// every animation, work never waits for it (FR-59): the events have
// happened, and the walks catch up. An Agent on a Handoff walk finishes it
// before it sets off; a Handoff from an Agent in the meeting room is
// handed over at once. A Status update (FR-23a) gathers the whole Floor
// the same way, the Manager at the whiteboard, while each Agent gives its
// rundown in turn (status-update-panel.tsx), and ends by itself once each
// has had its turn.

/** What happens in the meeting room. */
export type MeetingKind = "kickoff" | "wrap-up" | "status-update";

/** What a Floor's meeting events tell the Office. */
export type MeetingSignal =
  | {
      readonly type: "gather";
      /** The event's id. */
      readonly id: number;
      readonly floorId: string;
      /** The Batch's id; for a Status update, its event's, as it has none. */
      readonly batchId: number;
      readonly kind: MeetingKind;
      /** The Floor's Manager, who stands at the whiteboard. */
      readonly managerId: string;
      /** The Agents who take a seat, in order. */
      readonly agentIds: readonly string[];
    }
  | {
      readonly type: "end";
      readonly id: number;
      readonly floorId: string;
      readonly batchId: number;
      readonly kind: MeetingKind;
    };

/** The meeting signals among `events`, oldest first. */
export function meetingSignals(
  events: readonly StreamedEvent[],
): MeetingSignal[] {
  return events.flatMap(({ id, event }): MeetingSignal[] => {
    switch (event.type) {
      case "batch.kickoff_started":
      case "batch.finished":
        return [
          {
            type: "gather",
            id,
            floorId: event.floorId,
            batchId: event.batchId,
            kind: event.type === "batch.finished" ? "wrap-up" : "kickoff",
            managerId: event.agentId,
            agentIds: event.agentIds.filter((each) => each !== event.agentId),
          },
        ];
      case "status_update.given":
        return [
          {
            type: "gather",
            id,
            floorId: event.floorId,
            batchId: id,
            kind: "status-update",
            managerId: event.agentId,
            agentIds: event.agentIds.filter((each) => each !== event.agentId),
          },
        ];
      case "batch.kickoff_ended":
        return [
          {
            type: "end",
            id,
            floorId: event.floorId,
            batchId: event.batchId,
            kind: "kickoff",
          },
        ];
      default:
        return [];
    }
  });
}

/** How long the Agents stay gathered for a Wrap-up, once seated. */
export const wrapUpSeconds = 20;

/** How long each Agent speaks at a Status update. */
export const statusUpdateTurnSeconds = 5;

/**
 * How long the Floor stays gathered for a Status update of `speakers`, once
 * seated: a turn each, as long as a Wrap-up at least and never past a
 * minute and a half.
 */
export const statusUpdateSeconds = (speakers: number): number =>
  Math.min(90, Math.max(wrapUpSeconds, speakers * statusUpdateTurnSeconds));

/** The least time a meeting keeps its Agents at the table, so it is seen. */
export const minimumStay = 6;

/** Where an attendee stands or sits in the meeting room, and how it gets there. */
export interface MeetingPlace {
  /** Where it sits (or stands, at the whiteboard). */
  readonly at: FloorPoint;
  readonly heading: number;
  /** Whether it sits: everyone but the Manager. */
  readonly sits: boolean;
  /** The waypoint it walks to before going to its place. */
  readonly from: "meeting-room" | "meeting room, at the back" | "whiteboard";
  /**
   * The walkway it follows from there, level with its place: in front of
   * the table or behind it, clear of the chairs (a z on the floor).
   */
  readonly aisle: number;
  /**
   * Where it leaves the walkway, when its place is not straight off it (a
   * spare chair along a wall, past another): an x it walks along, level
   * with its place, before stepping in.
   */
  readonly lane?: number | undefined;
}

/**
 * The meeting room's walkways, in front of the table's chairs and behind
 * them: 1.5 m and 1.55 m from the table's middle, clear of the chairs' backs
 * and the walls.
 */
export const meetingAisles = {
  front: meetingTable.centre[1] + 1.5,
  back: meetingTable.centre[1] - 1.55,
} as const;

/**
 * The order the seats are taken in, as indices into the layout's ten
 * meeting seats: the front row facing the whiteboard, nearest the door
 * first; then the ends; then the back row.
 */
export const seatOrder = [7, 5, 3, 1, 9, 8, 6, 4, 2, 0] as const;

/**
 * Where each attendee goes: the Manager to the whiteboard, the others to
 * the seats in `order` (`seatOrder` unless told). Those beyond the room's
 * seats stay at their desks.
 */
export function meetingPlaces(
  layout: Pick<FloorLayout, "meetingSeats" | "waypoints">,
  managerId: string,
  agentIds: readonly string[],
  order: readonly number[] = seatOrder,
): Map<string, MeetingPlace> {
  const places = new Map<string, MeetingPlace>();
  const [cx, cz] = meetingTable.centre;
  const board = layout.waypoints.waypoints.find(
    ({ id }) => id === "whiteboard",
  );
  if (board !== undefined) {
    places.set(managerId, {
      at: board.position,
      heading: headingOf([0, cz - board.position[1]]),
      sits: false,
      from: "whiteboard",
      aisle: board.position[1],
    });
  }
  const seated = agentIds.filter((each) => each !== managerId);
  seated.forEach((agentId, index) => {
    const taken = order[index];
    const seat = taken === undefined ? undefined : layout.meetingSeats[taken];
    if (seat === undefined || places.has(agentId)) {
      return;
    }
    const at: FloorPoint = [seat[0], seat[2]];
    const end = Math.abs(at[1] - cz) < meetingTable.size[1] / 2;
    const behind = !end && at[1] < cz;
    places.set(agentId, {
      at,
      heading: end ? headingOf([cx - at[0], 0]) : headingOf([0, cz - at[1]]),
      sits: true,
      from: behind ? "meeting room, at the back" : "meeting-room",
      aisle: behind ? meetingAisles.back : meetingAisles.front,
    });
  });
  return places;
}

/** The way an Agent walks to its place in the meeting room, and back. */
export interface MeetingRoute {
  /** From its seat at its desk to its place in the meeting room. */
  readonly path: readonly FloorPoint[];
  readonly length: number;
  /** Which way it faces at its desk. */
  readonly seatHeading: number;
  readonly place: MeetingPlace;
}

/**
 * The way from an Agent's desk to its place: off its chair, along the
 * waypoints to the meeting room, then onto the room's walkway (in front
 * of the table, or behind it), along it level with its place, and in to
 * it.
 * Undefined when it has no desk, or no way there.
 */
export function meetingRoute(
  layout: Pick<FloorLayout, "desks" | "waypoints">,
  agentId: string,
  place: MeetingPlace,
): MeetingRoute | undefined {
  const toRoom = routeFromDesk(layout, agentId, place.from);
  const entry = toRoom?.path.at(-1);
  if (toRoom === undefined || entry === undefined) {
    return undefined;
  }
  const path = [
    ...toRoom.path,
    [entry[0], place.aisle] as const,
    ...(place.lane === undefined
      ? [[place.at[0], place.aisle] as const]
      : [
          [place.lane, place.aisle] as const,
          [place.lane, place.at[1]] as const,
        ]),
    place.at,
  ].filter((point, index, all) => {
    const before = all[index - 1];
    return before === undefined || distance(before, point) > 1e-6;
  });
  return {
    path,
    length: lengthOf(path),
    seatHeading: toRoom.seatHeading,
    place,
  };
}

/** One Agent's part in a meeting, and how far into it. */
export interface Attendance {
  readonly floorId: string;
  readonly batchId: number;
  readonly kind: MeetingKind;
  readonly route: MeetingRoute;
  /** Seconds since it began to stand; 0 while it waits to set off. */
  readonly elapsed: number;
  /** Whether it has set off: it waits while it is on a Handoff walk. */
  readonly started: boolean;
  /** When (in `elapsed`) the meeting ended for it; undefined while it lasts. */
  readonly endedAt: number | undefined;
}

/** How long an attendance takes to reach its place, and to sit. */
export function arrival(route: MeetingRoute): number {
  return (
    walkSeconds.standUp +
    route.length / walkSpeed +
    (route.place.sits ? walkSeconds.sitDown : 0)
  );
}

/** How far into a walk to the meeting room and back: what timing it needs. */
export type Timing = Pick<Attendance, "route" | "elapsed" | "endedAt">;

/** When (in `elapsed`) the Agent gets up to leave; undefined while the meeting lasts. */
export function leavesAt(attendance: Timing): number | undefined {
  return attendance.endedAt === undefined
    ? undefined
    : Math.max(attendance.endedAt, arrival(attendance.route) + minimumStay);
}

/** How long, from getting up to leave, until it is back in its chair. */
export function homeward(route: MeetingRoute): number {
  return (
    (route.place.sits ? walkSeconds.standUp : 0) +
    route.length / walkSpeed +
    walkSeconds.sitDown
  );
}

/** Where an attendee is, which way it faces, and what it plays. */
export interface MeetingPose {
  readonly position: FloorPoint;
  readonly heading: number;
  readonly animation: Extract<
    AnimationName,
    "stand-up" | "walk" | "sit-down" | "sit" | "idle"
  >;
}

/** Where an attendee is, `elapsed` seconds after it began to stand. */
export function meetingPose(attendance: Timing): MeetingPose {
  const { route, elapsed } = attendance;
  const { path, length, seatHeading, place } = route;
  const desk = path[0] ?? place.at;
  const walking = length / walkSpeed;
  const there = walkSeconds.standUp + walking;
  if (elapsed < walkSeconds.standUp) {
    return { position: desk, heading: seatHeading, animation: "stand-up" };
  }
  if (elapsed < there) {
    const along = (elapsed - walkSeconds.standUp) * walkSpeed;
    return {
      position: pointAlong(path, along),
      heading: headingAlong(path, along),
      animation: "walk",
    };
  }
  const leaving = leavesAt(attendance);
  const atPlace = (animation: MeetingPose["animation"]): MeetingPose => ({
    position: place.at,
    heading: place.heading,
    animation,
  });
  if (leaving === undefined || elapsed < leaving) {
    if (place.sits && elapsed < arrival(route)) {
      return atPlace("sit-down");
    }
    return atPlace(place.sits ? "sit" : "idle");
  }
  const since = elapsed - leaving;
  const rise = place.sits ? walkSeconds.standUp : 0;
  if (since < rise) {
    return atPlace("stand-up");
  }
  if (since < rise + walking) {
    const along = length - (since - rise) * walkSpeed;
    return {
      position: pointAlong(path, along),
      heading: headingAlong(path, along) + Math.PI,
      animation: "walk",
    };
  }
  return { position: desk, heading: seatHeading, animation: "sit-down" };
}

/** Whether an attendance is over: the Agent is back in its chair. */
export function done(attendance: Timing): boolean {
  const leaving = leavesAt(attendance);
  return (
    leaving !== undefined &&
    attendance.elapsed >= leaving + homeward(attendance.route)
  );
}

/** Each attending Agent's part, by its id. */
export type Attendances = ReadonlyMap<string, Attendance>;

/** How a meeting is planned on the Floor as it is laid out now. */
export interface MeetingPlanner {
  /** Where each attendee goes. */
  readonly places: (
    managerId: string,
    agentIds: readonly string[],
  ) => ReadonlyMap<string, MeetingPlace>;
  /** An attendee's way to its place; undefined when it cannot walk there. */
  readonly route: (
    agentId: string,
    place: MeetingPlace,
  ) => MeetingRoute | undefined;
}

/**
 * The attendances once `signal` arrives. A gathering sends each attendee
 * to its place (one already in the meeting room stays, for the new
 * meeting); a Wrap-up ends by itself, `wrapUpSeconds` after its Agents are
 * seated. An end lets that meeting's attendees go.
 */
export function receiveMeeting(
  attendances: Attendances,
  signal: MeetingSignal,
  plan: MeetingPlanner,
): Attendances {
  const next = new Map(attendances);
  if (signal.type === "end") {
    for (const [agentId, attendance] of attendances) {
      if (
        attendance.batchId === signal.batchId &&
        attendance.kind === signal.kind &&
        attendance.endedAt === undefined
      ) {
        next.set(agentId, { ...attendance, endedAt: attendance.elapsed });
      }
    }
    return next;
  }
  for (const [agentId, place] of plan.places(
    signal.managerId,
    signal.agentIds,
  )) {
    const current = attendances.get(agentId);
    const leaving = current === undefined ? undefined : leavesAt(current);
    // A Kickoff ends with its event; the others by themselves.
    const stay =
      signal.kind === "wrap-up"
        ? wrapUpSeconds
        : signal.kind === "status-update"
          ? statusUpdateSeconds(signal.agentIds.length + 1)
          : undefined;
    const ending = (route: MeetingRoute, elapsed: number) =>
      stay === undefined ? undefined : Math.max(elapsed, arrival(route)) + stay;
    if (
      current !== undefined &&
      (leaving === undefined || current.elapsed < leaving)
    ) {
      // Still in the meeting room (or on its way): it stays for this one.
      next.set(agentId, {
        ...current,
        batchId: signal.batchId,
        kind: signal.kind,
        endedAt: ending(current.route, current.elapsed),
      });
      continue;
    }
    if (current !== undefined) {
      // On its way back: this meeting goes on without it.
      continue;
    }
    const route = plan.route(agentId, place);
    if (route === undefined) {
      continue;
    }
    next.set(agentId, {
      floorId: signal.floorId,
      batchId: signal.batchId,
      kind: signal.kind,
      route,
      elapsed: 0,
      started: false,
      endedAt: ending(route, 0),
    });
  }
  return next;
}

/**
 * The attendances `seconds` later. One that has not set off waits while
 * its Agent is `busy` (on a Handoff walk); one that is done is dropped.
 */
export function advanceMeetings(
  attendances: Attendances,
  seconds: number,
  busy: (agentId: string) => boolean,
): Attendances {
  const next = new Map<string, Attendance>();
  for (const [agentId, attendance] of attendances) {
    if (!attendance.started && busy(agentId)) {
      next.set(agentId, attendance);
      continue;
    }
    const moved: Attendance = {
      ...attendance,
      started: true,
      elapsed: attendance.elapsed + seconds,
    };
    if (!done(moved)) {
      next.set(agentId, moved);
    }
  }
  return next;
}

/** Whether an attendee is still on its way to its place, or waiting to set off. */
export function onTheWay(attendance: Timing): boolean {
  return attendance.endedAt === undefined
    ? attendance.elapsed < arrival(attendance.route)
    : attendance.elapsed <
        Math.min(arrival(attendance.route), attendance.endedAt);
}

/**
 * Fast forward (meeting-fast-forward.ts): every attendee on its way is in
 * its place at once, with its whole stay still ahead; one already there,
 * or on its way back, is left be.
 */
export function arriveAll(attendances: Attendances): Attendances {
  const next = new Map<string, Attendance>();
  for (const [agentId, attendance] of attendances) {
    const arrived = arrival(attendance.route);
    next.set(
      agentId,
      onTheWay(attendance)
        ? {
            ...attendance,
            started: true,
            elapsed: arrived,
            // An end that came while it walked waits until it is there.
            endedAt:
              attendance.endedAt === undefined
                ? undefined
                : Math.max(attendance.endedAt, arrived),
          }
        : attendance,
    );
  }
  return next;
}

/** A Floor's meetings, kept as the scene plays them. */
export interface MeetingWalker {
  /** A signal arrives: walked, or (for another Floor's) ignored. */
  readonly receive: (signal: MeetingSignal, plan: MeetingPlanner) => void;
  /** `seconds` later. */
  readonly advance: (
    seconds: number,
    busy: (agentId: string) => boolean,
  ) => void;
  /** Everyone back at their desks at once (reduced motion). */
  readonly skipAll: () => void;
  /** Everyone on the way to the meeting room there at once (fast forward). */
  readonly arriveAll: () => void;
  /** Whether anyone is on the way to the meeting room. */
  readonly gathering: () => boolean;
  /** Where an Agent is in a meeting; undefined at its desk, or waiting to set off. */
  readonly poseOf: (agentId: string) => MeetingPose | undefined;
  /** Whether an Agent is in a meeting, or waiting to go to one. */
  readonly attending: (agentId: string) => boolean;
}

export function createMeetingWalker(floorId: string): MeetingWalker {
  let attendances: Attendances = new Map();
  return {
    receive(signal, plan) {
      if (signal.floorId === floorId) {
        attendances = receiveMeeting(attendances, signal, plan);
      }
    },
    advance(seconds, busy) {
      attendances = advanceMeetings(attendances, seconds, busy);
    },
    skipAll() {
      attendances = new Map();
    },
    arriveAll() {
      attendances = arriveAll(attendances);
    },
    gathering: () => [...attendances.values()].some(onTheWay),
    poseOf(agentId) {
      const attendance = attendances.get(agentId);
      return attendance?.started === true ? meetingPose(attendance) : undefined;
    },
    attending: (agentId) => attendances.has(agentId),
  };
}

/**
 * The planner for a Floor as `layout` lays it out: `meetingPlaces` and
 * `meetingRoute`.
 */
export const meetingPlanner = (
  layout: Pick<FloorLayout, "desks" | "waypoints" | "meetingSeats">,
): MeetingPlanner => ({
  places: (managerId, agentIds) => meetingPlaces(layout, managerId, agentIds),
  route: (agentId, place) => meetingRoute(layout, agentId, place),
});
