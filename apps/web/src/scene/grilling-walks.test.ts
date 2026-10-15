import type { StreamedEvent } from "@ai-office/events/stream";
import type { Role } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { Rect } from "./desk-set.ts";
import {
  floorLayout,
  meetingRoom,
  meetingTable,
  meetingWallChairs,
  whiteboard,
  type FloorAgent,
  type FloorLayout,
} from "./floor-layout.ts";
import {
  createGrillingWalker,
  factFindingVisits,
  gatheringPlaces,
  gatheringSeats,
  grillingPlace,
  grillingPlanner,
  grillingSeat,
  meetingRoomWalks,
  standBack,
  standingSpots,
  visitPlace,
  visitSeconds,
  visitSpots,
  type FactFindingVisit,
  type GrillingWalker,
} from "./grilling-walks.ts";
import { pointAlong } from "./handoff-walks.ts";
import { arrival, homeward, minimumStay } from "./meeting-walks.ts";
import { placedSize, type ModelPlacement } from "./models.ts";
import { footprint } from "./pieces.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// A Grilling Session in the Office (PRD FR-83), as data: the Manager's
// seat at the meeting room's table with the whiteboard behind it, the
// visitors' spots across the table, the ways there (clear of the
// furniture), and the timing of walking there and back as the session
// starts, pauses, resumes and ends, and as fact-finding Agents set off and
// come back.

const workRoles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];

/** A team of `size` Agents: the Manager first, then the Roles in turn. */
const team = (size: number): FloorAgent[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    role:
      index === 0
        ? "manager"
        : (workRoles[(index - 1) % workRoles.length] ?? "coder"),
  }));

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

const modelFootprint = (placement: ModelPlacement): Rect => {
  const [width, , depth] = placedSize(placement);
  const [x, , z] = placement.position;
  return {
    x: [x - width / 2, x + width / 2],
    z: [z - depth / 2, z + depth / 2],
  };
};

/** What an Agent cannot walk through: anything between the floor and head height. */
const obstacles = (layout: FloorLayout): { name: string; rect: Rect }[] => [
  ...layout.pieces
    .filter(
      ({ position: [, y], size: [, height] }) =>
        y + height / 2 > 0.05 && y - height / 2 < 1.9,
    )
    .map((piece) => ({ name: piece.name, rect: footprint(piece) })),
  ...layout.models
    .filter(({ position }) => position[1] < 1.9)
    .map((placement) => ({
      name: placement.name,
      rect: modelFootprint(placement),
    })),
];

function clearance([x, z]: FloorPoint, rect: Rect): number {
  const dx = Math.max(rect.x[0] - x, 0, x - rect.x[1]);
  const dz = Math.max(rect.z[0] - z, 0, z - rect.z[1]);
  return Math.hypot(dx, dz);
}

/** Half an Agent's shoulders: how close a path may come to anything. */
const shoulder = 0.2;

const seatOf = (layout: FloorLayout, agentId: string): FloorPoint => {
  const desk = defined(layout.desks.find((each) => each.agentId === agentId));
  return [desk.seat[0], desk.seat[2]];
};

const stream = (id: number, event: StreamedEvent["event"]): StreamedEvent => ({
  id,
  occurredAt: "2026-10-10T10:00:00.000Z",
  event,
});

const visit = (id: number, agentId: string): FactFindingVisit => ({
  id,
  floorId: "web-shop",
  sessionId: 1,
  agentId,
});

describe("fact-finding visits, from a Floor's events", () => {
  it("an Agent setting off and coming back is a visit each time; nothing else is", () => {
    expect(
      factFindingVisits([
        stream(4, {
          type: "grilling.fact_finding_started",
          version: 1,
          floorId: "web-shop",
          agentId: "agent-2",
          sessionId: 1,
          sandboxId: "sbx-1",
        }),
        stream(5, {
          type: "grilling.session_changed",
          version: 1,
          floorId: "web-shop",
          agentId: "agent-1",
          sessionId: 1,
          change: "round",
          status: "active",
          round: 1,
          openQuestions: 2,
          decisions: 0,
        }),
        stream(7, {
          type: "grilling.fact_finding_stopped",
          version: 1,
          floorId: "web-shop",
          agentId: "agent-2",
          sessionId: 1,
          sandboxId: "sbx-1",
          outcome: "found",
        }),
      ]),
    ).toEqual([visit(4, "agent-2"), visit(7, "agent-2")]);
  });
});

describe("where a session sits in the meeting room", () => {
  const layout = floorLayout(team(6));

  it("the Manager sits in the back row, facing the table, with the whiteboard behind it", () => {
    const place = defined(grillingPlace(layout));
    const [x, , z] = defined(layout.meetingSeats[grillingSeat]);
    expect(place).toMatchObject({ at: [x, z], sits: true });
    // Facing +z, the table; its back to the whiteboard on the back wall.
    expect(Math.sin(place.heading)).toBeCloseTo(0);
    expect(Math.cos(place.heading)).toBeCloseTo(1);
    expect(z).toBeLessThan(meetingTable.centre[1]);
    expect(Math.abs(x - whiteboard.centre[0])).toBeLessThan(
      whiteboard.width / 2,
    );
  });

  it("visitors stand across the table from it, facing it, 0.8 m apart", () => {
    const manager = defined(grillingPlace(layout));
    const spots = visitSpots.map((_, spot) =>
      defined(visitPlace(layout, spot)),
    );
    spots.forEach(({ at }, spot) => {
      expect(at[0] - manager.at[0]).toBeCloseTo(visitSpots[spot] ?? NaN);
    });
    expect([...visitSpots]).toEqual([0, 0.8, -0.8, 1.6, -1.6]);
    for (const { at, heading, sits } of spots) {
      expect(sits).toBe(false);
      expect(at[1]).toBeGreaterThan(
        meetingTable.centre[1] + meetingTable.size[1] / 2,
      );
      expect(Math.cos(heading)).toBeCloseTo(-1);
    }
  });

  it.each([2, 6, 12])(
    "for a team of %i: the Manager's way to its seat, and each Agent's to each spot, clear of furniture and walls once off its chairs",
    (size) => {
      const agents = team(size);
      const layout = floorLayout(agents);
      const plan = grillingPlanner(layout);
      const blocking = obstacles(layout);
      const routes = [
        { agentId: "agent-1", route: defined(plan.seat("agent-1")) },
        ...agents.slice(1).flatMap(({ id }) =>
          visitSpots.map((_, spot) => ({
            agentId: id,
            route: defined(plan.visit(id, spot)),
          })),
        ),
      ];
      for (const { agentId, route } of routes) {
        expect(route.path[0]).toEqual(seatOf(layout, agentId));
        expect(route.path.at(-1)).toEqual(route.place.at);
        for (let along = 0; along <= route.length; along += 0.05) {
          const at = pointAlong(route.path, along);
          if (
            distance(seatOf(layout, agentId), at) < 0.45 ||
            (route.place.sits && distance(route.place.at, at) < 0.6)
          ) {
            continue;
          }
          const nearest = blocking.reduce(
            (best, each) => {
              const gap = clearance(at, each.rect);
              return gap < best.gap ? { gap, name: each.name } : best;
            },
            { gap: Infinity, name: "" },
          );
          if (nearest.gap < shoulder) {
            expect.fail(
              `${agentId}, ${along.toFixed(2)} m in, passes ${nearest.name}`,
            );
          }
        }
      }
    },
  );
});

describe("a session, timed", () => {
  const layout = floorLayout(team(4));
  const plan = grillingPlanner(layout);
  const seated = defined(grillingPlace(layout)).at;
  const desk = (agentId: string) => seatOf(layout, agentId);
  const toSeat = defined(plan.seat("agent-1"));
  const running = { sessionId: 1, managerId: "agent-1" };
  const idle = () => false;
  const at = (walker: GrillingWalker, agentId: string) =>
    walker.poseOf(agentId)?.position ?? desk(agentId);
  const play = (walker: GrillingWalker, seconds: number) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) {
      walker.advance(0.1, idle);
    }
  };

  it("the Manager walks to the table when a session starts, sits there however long it runs, and walks back when it ends", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: true });
    expect(walker.attending("agent-1")).toBe(true);
    play(walker, 3);
    expect(walker.poseOf("agent-1")?.animation).toBe("walk");
    play(walker, arrival(toSeat));
    expect(walker.poseOf("agent-1")).toMatchObject({
      position: seated,
      animation: "sit",
    });
    play(walker, 600);
    expect(at(walker, "agent-1")).toEqual(seated);

    walker.session(undefined, plan, { walk: true });
    // Seated a long while, it gets up at once.
    play(walker, 0.5);
    expect(walker.poseOf("agent-1")?.animation).toBe("stand-up");
    play(walker, homeward(toSeat));
    expect(walker.poseOf("agent-1")).toBeUndefined();
    expect(walker.attending("agent-1")).toBe(false);
  });

  it("fast forward puts the Manager at the table at once, and the session still ends with a walk back", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: true });
    expect(walker.gathering()).toBe(true);
    play(walker, 1);
    walker.arriveAll();
    expect(walker.gathering()).toBe(false);
    expect(walker.poseOf("agent-1")).toMatchObject({
      position: seated,
      animation: "sit",
    });

    walker.session(undefined, plan, { walk: true });
    // Leaving, it is not gathering, and fast forward leaves it be.
    expect(walker.gathering()).toBe(false);
    walker.arriveAll();
    play(walker, minimumStay + 0.5);
    expect(walker.poseOf("agent-1")?.animation).not.toBe("sit");
  });

  it("a session already running is shown with the Manager seated, and paused it walks back", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: false });
    expect(walker.poseOf("agent-1")).toMatchObject({
      position: seated,
      animation: "sit",
    });
    // Seated before the Floor was shown, it gets up at once.
    walker.session(undefined, plan, { walk: true });
    play(walker, 3);
    expect(distance(at(walker, "agent-1"), seated)).toBeGreaterThan(0.3);
    play(walker, homeward(toSeat));
    expect(walker.attending("agent-1")).toBe(false);
  });

  it("paused and resumed before it gets up, the Manager stays; resumed on its way back, it walks back to the table once home", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: true });
    play(walker, arrival(toSeat));
    walker.session(undefined, plan, { walk: true });
    walker.session(running, plan, { walk: true });
    play(walker, minimumStay + homeward(toSeat));
    expect(at(walker, "agent-1")).toEqual(seated);

    walker.session(undefined, plan, { walk: true });
    play(walker, minimumStay + 2);
    expect(walker.poseOf("agent-1")?.animation).toBe("walk");
    walker.session(running, plan, { walk: true });
    play(walker, homeward(toSeat));
    // Home, it set off again.
    expect(walker.attending("agent-1")).toBe(true);
    play(walker, arrival(toSeat) + 1);
    expect(at(walker, "agent-1")).toEqual(seated);
  });

  it("waits to set off while the Manager is busy elsewhere, and a session over before it set off is never walked", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: true });
    for (let step = 0; step < 50; step += 1) {
      walker.advance(0.1, () => true);
    }
    expect(walker.poseOf("agent-1")).toBeUndefined();
    expect(walker.attending("agent-1")).toBe(true);
    walker.session(undefined, plan, { walk: true });
    expect(walker.attending("agent-1")).toBe(false);
  });

  it("a fact-finding Agent visits the Manager across the table for a moment, then walks back; again when it comes back", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: false });
    walker.visit(visit(4, "agent-2"), "agent-1", plan);
    const route = defined(plan.visit("agent-2", 0));
    play(walker, arrival(route) + visitSeconds / 2);
    expect(walker.poseOf("agent-2")).toMatchObject({
      position: route.place.at,
      animation: "idle",
    });
    play(walker, visitSeconds / 2 + homeward(route) + 0.2);
    expect(walker.attending("agent-2")).toBe(false);
    expect(at(walker, "agent-1")).toEqual(seated);

    // Back with what it found: it visits again.
    walker.visit(visit(9, "agent-2"), "agent-1", plan);
    play(walker, arrival(route));
    expect(at(walker, "agent-2")).toEqual(route.place.at);
  });

  it("two visitors take two spots; one sent again while there stays longer; the Manager finding facts itself, or another Floor's, makes no visit", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: false });
    walker.visit(visit(4, "agent-2"), "agent-1", plan);
    walker.visit(visit(5, "agent-3"), "agent-1", plan);
    walker.visit(visit(6, "agent-1"), "agent-1", plan);
    walker.visit({ ...visit(7, "agent-4"), floorId: "other" }, "agent-1", plan);
    const first = defined(plan.visit("agent-2", 0));
    const second = defined(plan.visit("agent-3", 1));
    play(walker, Math.max(arrival(first), arrival(second)) + 1);
    expect(at(walker, "agent-2")).toEqual(first.place.at);
    expect(at(walker, "agent-3")).toEqual(second.place.at);
    expect(walker.attending("agent-4")).toBe(false);
    expect(at(walker, "agent-1")).toEqual(seated);

    walker.visit(visit(8, "agent-2"), "agent-1", plan);
    play(walker, visitSeconds - 0.5);
    expect(at(walker, "agent-2")).toEqual(first.place.at);
    expect(distance(at(walker, "agent-3"), second.place.at)).toBeGreaterThan(0);
  });

  it("settled (reduced motion): the Manager at the table while a session runs, and no one visiting", () => {
    const walker = createGrillingWalker("web-shop");
    walker.session(running, plan, { walk: true });
    walker.visit(visit(4, "agent-2"), "agent-1", plan);
    play(walker, 2);
    walker.settle();
    expect(walker.poseOf("agent-1")).toMatchObject({
      position: seated,
      animation: "sit",
    });
    expect(walker.attending("agent-2")).toBe(false);
    walker.session(undefined, plan, { walk: false });
    walker.settle();
    expect(walker.attending("agent-1")).toBe(false);
  });
});

describe("the whole Floor gathered for a session", () => {
  const everyone = (size: number) => {
    const agents = team(size);
    return {
      agents,
      running: {
        sessionId: 1,
        managerId: "agent-1",
        agentIds: agents.slice(1).map(({ id }) => id),
      },
    };
  };
  const inRoom = ([x, z]: FloorPoint) =>
    x > meetingRoom.x[0] &&
    x < meetingRoom.x[1] &&
    z > meetingRoom.z[0] &&
    z < meetingRoom.z[1];

  it("seats the Manager in its seat and every Agent round the table, each in a place of its own", () => {
    const { agents, running } = everyone(6);
    const layout = floorLayout(agents);
    const places = gatheringPlaces(layout, "agent-1", running.agentIds);
    expect([...places.keys()]).toEqual(agents.map(({ id }) => id));
    expect(places.get("agent-1")).toEqual(grillingPlace(layout));
    const seats = gatheringSeats.map((index) => {
      const [x, , z] = defined(layout.meetingSeats[index]);
      return `${String(x)},${String(z)}`;
    });
    expect(gatheringSeats).not.toContain(grillingSeat);
    for (const { id } of agents.slice(1)) {
      const place = defined(places.get(id));
      expect(place.sits).toBe(true);
      expect(seats).toContain(place.at.join());
    }
    // A small team needs no spare chairs.
    expect(layout.meetingWallSeats).toEqual([]);
  });

  it.each([11, 12, 13, 20, 26, 40])(
    "a team of %i: chairs round the table, then spare chairs along the wall, then standing room; anyone beyond stays at its desk",
    (size) => {
      const { agents, running } = everyone(size);
      const layout = floorLayout(agents);
      const others = size - 1;
      expect(layout.meetingWallSeats).toHaveLength(
        Math.min(meetingWallChairs.length, Math.max(0, others - 9)),
      );
      expect(
        layout.pieces.filter(({ name }) =>
          name.startsWith("meeting room, spare chair"),
        ).length,
      ).toBeGreaterThanOrEqual(layout.meetingWallSeats.length);
      const places = gatheringPlaces(layout, "agent-1", running.agentIds);
      const capacity =
        gatheringSeats.length +
        meetingWallChairs.length +
        2 * standingSpots.length;
      expect(places.size).toBe(1 + Math.min(others, capacity));
      const spots = [...places.values()].map(({ at }) => at.join());
      expect(new Set(spots).size).toBe(spots.length);
      const seated = [...places.values()].filter(({ sits }) => sits).length;
      expect(seated).toBe(
        1 + Math.min(others, gatheringSeats.length + meetingWallChairs.length),
      );
      for (const { at } of places.values()) {
        expect(inRoom(at), at.join()).toBe(true);
      }
    },
  );

  it.each([4, 12, 13, 26])(
    "a team of %i: everyone's way to its place, clear of furniture and walls once off its chairs",
    (size) => {
      const { agents, running } = everyone(size);
      const layout = floorLayout(agents);
      const routes = grillingPlanner(layout).gather(running);
      expect(routes.size).toBe(
        gatheringPlaces(layout, "agent-1", running.agentIds).size,
      );
      const blocking = obstacles(layout);
      for (const [agentId, route] of routes) {
        expect(route.path[0]).toEqual(seatOf(layout, agentId));
        expect(route.path.at(-1)).toEqual(route.place.at);
        for (let along = 0; along <= route.length; along += 0.05) {
          const at = pointAlong(route.path, along);
          if (
            distance(seatOf(layout, agentId), at) < 0.45 ||
            (route.place.sits && distance(route.place.at, at) < 0.6)
          ) {
            continue;
          }
          const nearest = blocking.reduce(
            (best, each) => {
              const gap = clearance(at, each.rect);
              return gap < best.gap ? { gap, name: each.name } : best;
            },
            { gap: Infinity, name: "" },
          );
          if (nearest.gap < shoulder) {
            expect.fail(
              `${agentId}, ${along.toFixed(2)} m in, passes ${nearest.name}`,
            );
          }
        }
      }
    },
  );

  describe("timed", () => {
    const { agents, running } = everyone(5);
    const layout = floorLayout(agents);
    const plan = grillingPlanner(layout);
    const routes = plan.gather(running);
    const ids = agents.map(({ id }) => id);
    const longest = Math.max(...[...routes.values()].map(arrival));
    const longestHome = Math.max(...[...routes.values()].map(homeward));
    const placeOf = (agentId: string) => defined(routes.get(agentId)).place;
    const play = (
      walker: GrillingWalker,
      seconds: number,
      busy = () => false,
    ) => {
      for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) {
        walker.advance(0.1, busy);
      }
    };

    it("everyone walks to the table as the session starts, sits there while it runs, and walks back when it pauses or ends", () => {
      const walker = createGrillingWalker("web-shop");
      walker.session(running, plan, { walk: true });
      for (const id of ids) {
        expect(walker.attending(id)).toBe(true);
      }
      play(walker, 3);
      for (const id of ids) {
        expect(walker.poseOf(id)?.animation, id).toBe("walk");
      }
      play(walker, longest + 600);
      for (const id of ids) {
        expect(walker.poseOf(id), id).toMatchObject({
          position: placeOf(id).at,
          animation: "sit",
        });
      }
      walker.session(undefined, plan, { walk: true });
      play(walker, 0.5);
      for (const id of ids) {
        expect(walker.poseOf(id)?.animation, id).toBe("stand-up");
      }
      play(walker, longestHome);
      for (const id of ids) {
        expect(walker.attending(id), id).toBe(false);
      }
    });

    it("resumed, everyone comes back; an Agent added meanwhile joins; one gone is let go", () => {
      const walker = createGrillingWalker("web-shop");
      const fewer = { ...running, agentIds: running.agentIds.slice(0, 2) };
      walker.session(fewer, plan, { walk: false });
      expect(walker.attending("agent-4")).toBe(false);
      walker.session(running, plan, { walk: true });
      play(walker, longest + 1);
      expect(walker.poseOf("agent-4")?.position).toEqual(placeOf("agent-4").at);
      walker.session(fewer, plan, { walk: true });
      play(walker, minimumStay + longestHome);
      expect(walker.attending("agent-4")).toBe(false);
      expect(walker.poseOf("agent-2")?.position).toEqual(placeOf("agent-2").at);
    });

    it("an Agent busy on a Handoff walk sets off once it is back", () => {
      const walker = createGrillingWalker("web-shop");
      walker.session(running, plan, { walk: true });
      play(walker, 5, () => true);
      expect(walker.poseOf("agent-2")).toBeUndefined();
      expect(walker.attending("agent-2")).toBe(true);
      play(walker, longest + 1);
      expect(walker.poseOf("agent-2")?.position).toEqual(placeOf("agent-2").at);
    });

    it("an Agent at the table sent to find facts stands up behind its chair for a moment, then sits again", () => {
      const walker = createGrillingWalker("web-shop");
      walker.session(running, plan, { walk: false });
      walker.visit(visit(4, "agent-2"), "agent-1", plan);
      play(walker, visitSeconds / 2);
      const pose = defined(walker.poseOf("agent-2"));
      expect(pose.animation).toBe("idle");
      expect(distance(pose.position, placeOf("agent-2").at)).toBeCloseTo(
        standBack,
      );
      play(walker, visitSeconds / 2 + 0.2);
      expect(walker.poseOf("agent-2")).toMatchObject({
        position: placeOf("agent-2").at,
        animation: "sit",
      });
    });

    it("settled (reduced motion): everyone at the table while it runs, at their desks once it ends", () => {
      const walker = createGrillingWalker("web-shop");
      walker.session(running, plan, { walk: true });
      walker.visit(visit(4, "agent-2"), "agent-1", plan);
      play(walker, 2);
      walker.settle();
      for (const id of ids) {
        expect(walker.poseOf(id), id).toMatchObject({
          position: placeOf(id).at,
          animation: "sit",
        });
      }
      walker.session(undefined, plan, { walk: false });
      walker.settle();
      for (const id of ids) {
        expect(walker.attending(id), id).toBe(false);
      }
    });

    it("a big team beyond the room's places: those left over still visit the table to report what they found", () => {
      const big = everyone(40);
      const bigLayout = floorLayout(big.agents);
      const bigPlan = grillingPlanner(bigLayout);
      const walker = createGrillingWalker("web-shop");
      walker.session(big.running, bigPlan, { walk: false });
      const left = defined(big.running.agentIds.at(-1));
      expect(walker.attending(left)).toBe(false);
      walker.visit(visit(4, left), "agent-1", bigPlan);
      const route = defined(bigPlan.visit(left, 0));
      play(walker, arrival(route) + 1);
      expect(walker.poseOf(left)?.position).toEqual(route.place.at);
    });
  });
});

describe("the meeting room's walks together", () => {
  it("shows the session's pose before a meeting's, and counts either as being in the meeting room", () => {
    const pose = (x: number) => ({
      position: [x, 0] as FloorPoint,
      heading: 0,
      animation: "sit" as const,
    });
    const together = meetingRoomWalks(
      {
        poseOf: (agentId) =>
          agentId === "a" || agentId === "b" ? pose(1) : undefined,
        attending: (agentId) =>
          agentId === "a" || agentId === "b" || agentId === "c",
      },
      {
        poseOf: (agentId) => (agentId === "a" ? pose(2) : undefined),
        attending: (agentId) => agentId === "a" || agentId === "d",
      },
    );
    expect(together.poseOf("a")?.position).toEqual([2, 0]);
    expect(together.poseOf("b")?.position).toEqual([1, 0]);
    expect(together.poseOf("e")).toBeUndefined();
    expect(["a", "b", "c", "d", "e"].map(together.attending)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
