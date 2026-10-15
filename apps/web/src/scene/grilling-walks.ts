import type { StreamedEvent } from "@ai-office/events/stream";

import { meetingTable, type FloorLayout } from "./floor-layout.ts";
import { headingOf } from "./handoff-walks.ts";
import {
  arrival,
  done,
  leavesAt,
  meetingAisles,
  meetingPlaces,
  meetingPose,
  meetingRoute,
  minimumStay,
  seatOrder,
  type MeetingPlace,
  type MeetingPose,
  type MeetingRoute,
  type MeetingWalker,
  type Timing,
} from "./meeting-walks.ts";

// A Grilling Session in the Office (PRD FR-83), as data, so the scene only
// draws it. For the whole of a session the Floor meets in the meeting
// room: the Manager sits at the table with the whiteboard behind it, and
// every other Agent of the Floor, those at work in their sandboxes too,
// takes a seat round it (`gatheringPlaces`): the table's other chairs
// first, then the spare chairs a large team has along the room's left
// wall, then standing room on the walkways in front of the table and
// behind it; anyone beyond that stays at its desk. They walk there when
// the session starts (or is resumed), and back to their desks when it
// ends or is paused. A session already running when the Floor is shown
// has them there already, and so does reduced motion, with no walk.
// Agents the Manager sends to find facts (FR-79) show it each time they
// set off and come back with what they found: one seated at the table
// stands behind its chair for a moment; one not there walks to the table,
// stands across it from the Manager for a moment, and walks back to its
// desk. The walks reuse the meetings' (meeting-walks.ts): the same
// waypoints, aisles and timing. As with every animation, work never waits
// for them.

/** A Floor's running Grilling Session, as the Office shows it. */
export interface RunningSession {
  readonly sessionId: number;
  /** The Floor's Manager, who sits at the table. */
  readonly managerId: string;
  /**
   * The Floor's other Agents, in its order, who gather at the table with
   * the Manager; none when left out.
   */
  readonly agentIds?: readonly string[] | undefined;
}

/** An Agent the Manager sent to find a fact, setting off or back with it. */
export interface FactFindingVisit {
  /** The event's id. */
  readonly id: number;
  readonly floorId: string;
  readonly sessionId: number;
  readonly agentId: string;
}

/** The fact-finding visits among `events`, oldest first. */
export function factFindingVisits(
  events: readonly StreamedEvent[],
): FactFindingVisit[] {
  return events.flatMap(({ id, event }): FactFindingVisit[] =>
    event.type === "grilling.fact_finding_started" ||
    event.type === "grilling.fact_finding_stopped"
      ? [
          {
            id,
            floorId: event.floorId,
            sessionId: event.sessionId,
            agentId: event.agentId,
          },
        ]
      : [],
  );
}

/**
 * The meeting seat the Manager takes, as an index into the layout's ten:
 * in the back row, beside the table's middle, so the whiteboard is behind
 * it.
 */
export const grillingSeat = 4;

/** How long a visitor stands at the table, once there. */
export const visitSeconds = 8;

/**
 * Where visitors stand, as offsets along the table from the Manager's
 * seat: across the table from it first, then either side, 0.8 m apart.
 */
export const visitSpots = [0, 0.8, -0.8, 1.6, -1.6] as const;

/**
 * Where the Manager sits for a session: its seat, facing the table, reached
 * along the walkway behind the chairs. Undefined on a layout without it.
 */
export function grillingPlace(
  layout: Pick<FloorLayout, "meetingSeats">,
): MeetingPlace | undefined {
  const seat = layout.meetingSeats[grillingSeat];
  if (seat === undefined) {
    return undefined;
  }
  return {
    at: [seat[0], seat[2]],
    heading: headingOf([0, meetingTable.centre[1] - seat[2]]),
    sits: true,
    from: "meeting room, at the back",
    aisle: meetingAisles.back,
  };
}

/**
 * Where a visitor stands: on the walkway in front of the table's chairs,
 * at its spot along it, facing the Manager across the table.
 */
export function visitPlace(
  layout: Pick<FloorLayout, "meetingSeats">,
  spot: number,
): MeetingPlace | undefined {
  const manager = grillingPlace(layout);
  if (manager === undefined) {
    return undefined;
  }
  const along = visitSpots[spot] ?? 0;
  return {
    at: [manager.at[0] + along, meetingAisles.front],
    heading: headingOf([0, manager.at[1] - meetingAisles.front]),
    sits: false,
    from: "meeting-room",
    aisle: meetingAisles.front,
  };
}

/**
 * The table's seats the Agents take for a session, besides the Manager's:
 * the meetings' order (`seatOrder`), without the Manager's seat.
 */
export const gatheringSeats: readonly number[] = seatOrder.filter(
  (seat) => seat !== grillingSeat,
);

/**
 * The x a spare chair's Agent walks along, level with its chair, from the
 * back walkway: between the spare chairs and the table's back row.
 */
export const spareChairLane = -5.25;

/**
 * Where Agents beyond every chair stand, as x along the meeting room's
 * walkways: in front of the table first, then behind it, 0.6 m apart.
 */
export const standingSpots = [-5, -4.4, -3.8, -3.2, -2.6, -2, -1.4] as const;

/**
 * Where everyone goes for a session: the Manager to its seat
 * (`grillingPlace`); the other Agents, in order, to the table's other
 * seats, then the spare chairs along the left wall, then standing room on
 * the walkway in front of the table, then the one behind it, facing the
 * table. Those beyond all that stay at their desks.
 */
export function gatheringPlaces(
  layout: Pick<FloorLayout, "meetingSeats" | "meetingWallSeats" | "waypoints">,
  managerId: string,
  agentIds: readonly string[],
): Map<string, MeetingPlace> {
  const others = [...new Set(agentIds)].filter((each) => each !== managerId);
  const atTable = others.slice(0, gatheringSeats.length);
  const places = meetingPlaces(layout, managerId, atTable, gatheringSeats);
  places.delete(managerId);
  const manager = grillingPlace(layout);
  const gathered = new Map<string, MeetingPlace>(
    manager === undefined ? [] : [[managerId, manager]],
  );
  for (const [agentId, place] of places) {
    gathered.set(agentId, place);
  }
  const [, cz] = meetingTable.centre;
  const spare: MeetingPlace[] = layout.meetingWallSeats.map(([x, , z]) => ({
    at: [x, z],
    heading: headingOf([1, 0]),
    sits: true,
    from: "meeting room, at the back",
    aisle: meetingAisles.back,
    lane: spareChairLane,
  }));
  const stand = (aisle: number, from: MeetingPlace["from"]) =>
    standingSpots.map((x): MeetingPlace => ({
      at: [x, aisle],
      heading: headingOf([0, cz - aisle]),
      sits: false,
      from,
      aisle,
    }));
  const rest = [
    ...spare,
    ...stand(meetingAisles.front, "meeting-room"),
    ...stand(meetingAisles.back, "meeting room, at the back"),
  ];
  others.slice(atTable.length).forEach((agentId, index) => {
    const place = rest[index];
    if (place !== undefined) {
      gathered.set(agentId, place);
    }
  });
  return gathered;
}

/** How a session's walks are planned on the Floor as it is laid out now. */
export interface GrillingPlanner {
  /** The Manager's way to its seat; undefined when it cannot walk there. */
  readonly seat: (managerId: string) => MeetingRoute | undefined;
  /**
   * Everyone's ways to their places for `running`, by Agent: those with
   * no way there are left out.
   */
  readonly gather: (running: RunningSession) => Map<string, MeetingRoute>;
  /** A visitor's way to its spot. */
  readonly visit: (agentId: string, spot: number) => MeetingRoute | undefined;
}

/** The planner for a Floor as `layout` lays it out. */
export function grillingPlanner(
  layout: Pick<
    FloorLayout,
    "desks" | "waypoints" | "meetingSeats" | "meetingWallSeats"
  >,
): GrillingPlanner {
  const route = (agentId: string, place: MeetingPlace | undefined) =>
    place === undefined ? undefined : meetingRoute(layout, agentId, place);
  return {
    seat: (managerId) => route(managerId, grillingPlace(layout)),
    gather: ({ managerId, agentIds = [] }) => {
      const routes = new Map<string, MeetingRoute>();
      for (const [agentId, place] of gatheringPlaces(
        layout,
        managerId,
        agentIds,
      )) {
        const way = route(agentId, place);
        if (way !== undefined) {
          routes.set(agentId, way);
        }
      }
      return routes;
    },
    visit: (agentId, spot) => route(agentId, visitPlace(layout, spot)),
  };
}

/** One walk to the table and back, and how far into it. */
export interface GrillingWalk extends Timing {
  /** Whether it has set off: it waits while its Agent is busy elsewhere. */
  readonly started: boolean;
}

/**
 * Already at the end of `route`, seated or standing, with no walk: as if
 * there a while, so it gets up at once when the session ends.
 */
const placed = (route: MeetingRoute): GrillingWalk => ({
  route,
  elapsed: arrival(route) + minimumStay,
  started: true,
  endedAt: undefined,
});

/** Setting off for the end of `route`, once its Agent is free. */
const setOff = (route: MeetingRoute): GrillingWalk => ({
  route,
  elapsed: 0,
  started: false,
  endedAt: undefined,
});

/** `walk`, `seconds` later; it waits to set off while its Agent is `busy`. */
const moved = (
  walk: GrillingWalk,
  seconds: number,
  busy: boolean,
): GrillingWalk =>
  !walk.started && busy
    ? walk
    : { ...walk, started: true, elapsed: walk.elapsed + seconds };

/** Whether `walk` has its Agent in its place, and staying there. */
const there = (walk: GrillingWalk) =>
  walk.started &&
  walk.endedAt === undefined &&
  walk.elapsed >= arrival(walk.route);

/** How far behind its chair a seated Agent stands up to, finding facts. */
export const standBack = 0.4;

/** A Floor's Grilling Session, kept as the scene plays it. */
export interface GrillingWalker {
  /**
   * The Floor's running session, or none: its Manager and Agents walk to
   * the table, or back to their desks. With `walk` false they are put
   * there (or back) at once.
   */
  readonly session: (
    running: RunningSession | undefined,
    plan: GrillingPlanner,
    options: { readonly walk: boolean },
  ) => void;
  /**
   * A fact-finding Agent sets off, or comes back: one at the table stands
   * up behind its chair for a moment; any other visits the Manager.
   */
  readonly visit: (
    visit: FactFindingVisit,
    managerId: string | undefined,
    plan: GrillingPlanner,
  ) => void;
  /** `seconds` later; one not yet set off waits while its Agent is `busy`. */
  readonly advance: (
    seconds: number,
    busy: (agentId: string) => boolean,
  ) => void;
  /**
   * No one walks (reduced motion): everyone gathered is at the table while
   * a session runs, and every visitor at its desk.
   */
  readonly settle: () => void;
  /**
   * Fast forward (meeting-fast-forward.ts): everyone on the way to the
   * table is in their place at once; visitors and those leaving walk on.
   */
  readonly arriveAll: () => void;
  /** Whether anyone is on the way to the table. */
  readonly gathering: () => boolean;
  /** Where an Agent is; undefined at its desk, or waiting to set off. */
  readonly poseOf: (agentId: string) => MeetingPose | undefined;
  /** Whether an Agent is at the table, on its way, or waiting to set off. */
  readonly attending: (agentId: string) => boolean;
}

export function createGrillingWalker(floorId: string): GrillingWalker {
  let running: RunningSession | undefined;
  let planned: GrillingPlanner | undefined;
  /** Everyone gathered for the session, the Manager first. */
  const gathered = new Map<string, GrillingWalk>();
  /** Seconds each gathered Agent has left standing, finding facts. */
  const standing = new Map<string, number>();
  const visits = new Map<string, GrillingWalk & { readonly spot: number }>();

  /** Where each of the session's Agents goes, as planned now. */
  const wanted = (): ReadonlyMap<string, MeetingRoute> =>
    running === undefined || planned === undefined
      ? new Map()
      : planned.gather(running);

  /** Every gathered Agent sets off home; with `walk` false, is home at once. */
  const disperse = (walk: boolean, except?: ReadonlyMap<string, unknown>) => {
    for (const [agentId, each] of gathered) {
      if (except?.has(agentId) === true) {
        continue;
      }
      standing.delete(agentId);
      if (!walk || !each.started) {
        gathered.delete(agentId);
      } else if (each.endedAt === undefined) {
        gathered.set(agentId, { ...each, endedAt: each.elapsed });
      }
    }
  };

  return {
    session(next, plan, { walk }) {
      running = next;
      planned = plan;
      const routes = wanted();
      disperse(walk, routes);
      for (const [agentId, route] of routes) {
        const current = gathered.get(agentId);
        if (!walk) {
          gathered.set(agentId, placed(route));
          continue;
        }
        if (current === undefined) {
          // A visitor gathered: the visit is over, and it takes its place.
          visits.delete(agentId);
          gathered.set(agentId, setOff(route));
          continue;
        }
        const leaving = leavesAt(current);
        if (leaving !== undefined && current.elapsed < leaving) {
          // Resumed before it got up to leave: it stays.
          gathered.set(agentId, { ...current, endedAt: undefined });
        }
        // On its way back, it turns round once home (`advance`).
      }
    },
    visit(visit, managerId, plan) {
      if (
        visit.floorId !== floorId ||
        visit.agentId === managerId ||
        visit.agentId === running?.managerId
      ) {
        return;
      }
      const seated = gathered.get(visit.agentId);
      if (seated !== undefined) {
        if (seated.endedAt === undefined) {
          standing.set(visit.agentId, visitSeconds);
        }
        return;
      }
      const current = visits.get(visit.agentId);
      if (current !== undefined) {
        const leaving = leavesAt(current) ?? 0;
        if (current.elapsed < leaving) {
          // Still there, or on its way: it stays a while longer.
          visits.set(visit.agentId, {
            ...current,
            endedAt: Math.max(leaving, current.elapsed + visitSeconds),
          });
        }
        return;
      }
      const taken = new Set([...visits.values()].map(({ spot }) => spot));
      const spot = visitSpots.findIndex((_, index) => !taken.has(index));
      const route = spot === -1 ? undefined : plan.visit(visit.agentId, spot);
      if (route === undefined) {
        return;
      }
      visits.set(visit.agentId, {
        route,
        elapsed: 0,
        started: false,
        endedAt: arrival(route) + visitSeconds,
        spot,
      });
    },
    advance(seconds, busy) {
      const routes = wanted();
      for (const [agentId, each] of gathered) {
        const walk = moved(each, seconds, busy(agentId));
        if (done(walk)) {
          // Home; resumed meanwhile, it sets off again.
          gathered.delete(agentId);
          const route = routes.get(agentId);
          if (route !== undefined) {
            gathered.set(agentId, setOff(route));
          }
        } else {
          gathered.set(agentId, walk);
        }
      }
      for (const [agentId, left] of standing) {
        const walk = gathered.get(agentId);
        if (walk === undefined || !there(walk) || left <= seconds) {
          standing.delete(agentId);
        } else {
          standing.set(agentId, left - seconds);
        }
      }
      for (const [agentId, visit] of visits) {
        const next = { ...visit, ...moved(visit, seconds, busy(agentId)) };
        if (done(next)) {
          visits.delete(agentId);
        } else {
          visits.set(agentId, next);
        }
      }
    },
    settle() {
      visits.clear();
      standing.clear();
      const routes = wanted();
      disperse(false, routes);
      for (const [agentId, route] of routes) {
        const current = gathered.get(agentId);
        if (current === undefined || !there(current)) {
          gathered.set(agentId, placed(route));
        }
      }
    },
    arriveAll() {
      for (const [agentId, walk] of gathered) {
        if (walk.endedAt === undefined && !there(walk)) {
          gathered.set(agentId, {
            ...walk,
            started: true,
            elapsed: arrival(walk.route),
          });
        }
      }
    },
    gathering: () =>
      [...gathered.values()].some(
        (walk) => walk.endedAt === undefined && !there(walk),
      ),
    poseOf(agentId) {
      const walk = gathered.get(agentId) ?? visits.get(agentId);
      if (walk?.started !== true) {
        return undefined;
      }
      const pose = meetingPose(walk);
      if (!standing.has(agentId) || pose.animation !== "sit") {
        return pose;
      }
      // Up behind its chair, facing the table.
      const [x, z] = pose.position;
      return {
        position: [
          x - Math.sin(pose.heading) * standBack,
          z - Math.cos(pose.heading) * standBack,
        ],
        heading: pose.heading,
        animation: "idle",
      };
    },
    attending: (agentId) => gathered.has(agentId) || visits.has(agentId),
  };
}

/** Who is where in the meeting room. */
export type MeetingRoomWalks = Pick<MeetingWalker, "poseOf" | "attending">;

/**
 * The meetings (FR-60) and the Grilling Session together: what takes a
 * Floor's Agents to the meeting room, the session's first. An Agent at the
 * session's table is in the meeting room, for Handoffs and idling as for
 * a Kickoff.
 */
export const meetingRoomWalks = (
  meetings: MeetingRoomWalks,
  grilling: MeetingRoomWalks,
): MeetingRoomWalks => ({
  poseOf: (agentId) => grilling.poseOf(agentId) ?? meetings.poseOf(agentId),
  attending: (agentId) =>
    grilling.attending(agentId) || meetings.attending(agentId),
});
