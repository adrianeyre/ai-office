import type { StreamedEvent } from "@ai-office/events/stream";
import type { Role } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { Rect } from "./desk-set.ts";
import {
  floorLayout,
  meetingTable,
  type FloorAgent,
  type FloorLayout,
} from "./floor-layout.ts";
import { pointAlong, walkSeconds, walkSpeed } from "./handoff-walks.ts";
import {
  advanceMeetings,
  arriveAll,
  arrival,
  createMeetingWalker,
  homeward,
  meetingPlaces,
  meetingPlanner,
  meetingPose,
  meetingRoute,
  meetingSignals,
  minimumStay,
  receiveMeeting,
  seatOrder,
  statusUpdateSeconds,
  wrapUpSeconds,
  type Attendance,
  type Attendances,
  type MeetingSignal,
} from "./meeting-walks.ts";
import { placedSize, type ModelPlacement } from "./models.ts";
import { footprint } from "./pieces.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// The Kickoff and the Wrap-up in the Office (PRD FR-60), as data: who goes
// where in the meeting room, the way there over the Floor's waypoints
// (clear of the furniture), the timing of gathering, sitting and walking
// back, and how meetings begin and end as their events arrive.

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

const gather = (
  id: number,
  agentIds: readonly string[],
  kind: MeetingSignal["kind"] = "kickoff",
  batchId = 3,
): MeetingSignal => ({
  type: "gather",
  id,
  floorId: "web-shop",
  batchId,
  kind,
  managerId: "agent-1",
  agentIds,
});

const end = (id: number, batchId = 3): MeetingSignal => ({
  type: "end",
  id,
  floorId: "web-shop",
  batchId,
  kind: "kickoff",
});

describe("meeting signals, from a Floor's events", () => {
  it("a Kickoff gathers and ends; a Wrap-up gathers; the Manager stands apart", () => {
    const stream = (
      id: number,
      event: StreamedEvent["event"],
    ): StreamedEvent => ({
      id,
      occurredAt: "2026-10-10T10:00:00.000Z",
      event,
    });
    expect(
      meetingSignals([
        stream(4, {
          type: "batch.kickoff_started",
          version: 1,
          floorId: "web-shop",
          batchId: 3,
          planVersion: 1,
          agentId: "agent-1",
          agentIds: ["agent-2", "agent-3"],
        }),
        stream(5, {
          type: "batch.acknowledged",
          version: 1,
          floorId: "web-shop",
          batchId: 3,
          planVersion: 1,
          agentId: "agent-2",
          response: "ok",
          by: "model",
        }),
        stream(6, {
          type: "batch.kickoff_ended",
          version: 1,
          floorId: "web-shop",
          batchId: 3,
          agentId: "agent-1",
          concerns: 0,
        }),
        stream(9, {
          type: "batch.finished",
          version: 1,
          floorId: "web-shop",
          batchId: 3,
          agentId: "agent-1",
          agentIds: ["agent-3", "agent-1"],
          issues: [1],
          merged: 1,
          closed: 0,
          blocked: 0,
          notStarted: 0,
          tokens: 10,
        }),
      ]),
    ).toEqual([
      gather(4, ["agent-2", "agent-3"]),
      end(6),
      gather(9, ["agent-3"], "wrap-up"),
    ]);
  });
});

describe("who goes where in the meeting room", () => {
  const layout = floorLayout(team(12));

  it("the Manager stands at the whiteboard, facing the table; the others take the seats, the front row first", () => {
    const agents = team(12)
      .slice(1)
      .map(({ id }) => id);
    const places = meetingPlaces(layout, "agent-1", agents);
    const manager = defined(places.get("agent-1"));
    expect(manager).toMatchObject({ sits: false, from: "whiteboard" });
    expect(manager.at).toEqual([-1.9, -5.45]);
    expect(manager.heading).toBeCloseTo(0);
    // Ten seats: the eleventh stays at its desk.
    expect(places.size).toBe(11);
    expect(places.has("agent-12")).toBe(false);
    const seats = agents
      .slice(0, 10)
      .map((agentId) => defined(places.get(agentId)).at);
    expect(seats).toEqual(
      seatOrder.map((index) => {
        const [x, , z] = defined(layout.meetingSeats[index]);
        return [x, z];
      }),
    );
    // The front row (facing the whiteboard) first, nearest the door first.
    expect(seats.slice(0, 4)).toEqual([
      [-1.85, -3],
      [-2.75, -3],
      [-3.65, -3],
      [-4.55, -3],
    ]);
    // Each faces the table: the rows across it, the ends along it.
    const [cx, cz] = meetingTable.centre;
    for (const agentId of agents.slice(0, 10)) {
      const { at, heading } = defined(places.get(agentId));
      const towards = [Math.sin(heading), Math.cos(heading)] as const;
      const toTable = [cx - at[0], cz - at[1]] as const;
      expect(towards[0] * toTable[0] + towards[1] * toTable[1]).toBeGreaterThan(
        0,
      );
      expect(Math.abs(towards[0]) < 1e-9 || Math.abs(towards[1]) < 1e-9).toBe(
        true,
      );
    }
  });

  it("a Manager named among the Agents still stands at the whiteboard", () => {
    const places = meetingPlaces(layout, "agent-1", ["agent-1", "agent-2"]);
    expect(places.get("agent-1")?.sits).toBe(false);
    expect(places.get("agent-2")?.at).toEqual([-1.85, -3]);
  });
});

describe("the way to the meeting room", () => {
  it.each([2, 6, 12])(
    "for every Agent of a team of %i: from its desk to its place, clear of furniture and walls once off its chairs",
    (size) => {
      const agents = team(size);
      const layout = floorLayout(agents);
      const blocking = obstacles(layout);
      const places = meetingPlaces(
        layout,
        "agent-1",
        agents.slice(1).map(({ id }) => id),
      );
      for (const [agentId, place] of places) {
        const route = defined(meetingRoute(layout, agentId, place));
        expect(route.path[0]).toEqual(seatOf(layout, agentId));
        expect(route.path.at(-1)).toEqual(place.at);
        for (let along = 0; along <= route.length; along += 0.05) {
          const at = pointAlong(route.path, along);
          // Rising from its desk's chair, or sitting down in the meeting
          // room's, the Agent is at that chair.
          if (
            distance(seatOf(layout, agentId), at) < 0.45 ||
            (place.sits && distance(place.at, at) < 0.6)
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

  it("none for an Agent with no desk on the Floor", () => {
    const layout = floorLayout(team(3));
    const place = defined(
      meetingPlaces(layout, "agent-1", ["agent-2"]).get("agent-2"),
    );
    expect(meetingRoute(layout, "someone-else", place)).toBeUndefined();
  });
});

describe("a meeting, timed", () => {
  const layout = floorLayout(team(4));
  const plan = meetingPlanner(layout);
  const attendance = (agentId: string): Attendance => {
    const place = defined(
      plan.places("agent-1", ["agent-2", "agent-3"]).get(agentId),
    );
    return {
      floorId: "web-shop",
      batchId: 3,
      kind: "kickoff",
      route: defined(plan.route(agentId, place)),
      elapsed: 0,
      started: true,
      endedAt: undefined,
    };
  };

  it("stands, walks there at walking pace, sits down and stays seated until the meeting ends; then stands, walks back and sits at its desk", () => {
    const one = attendance("agent-2");
    const { route } = one;
    const walking = route.length / walkSpeed;
    const at = (elapsed: number, endedAt?: number) =>
      meetingPose({ ...one, elapsed, endedAt });
    expect(at(0)).toMatchObject({
      animation: "stand-up",
      position: route.path[0],
    });
    expect(at(walkSeconds.standUp + walking / 2).animation).toBe("walk");
    expect(at(walkSeconds.standUp + walking + 0.1)).toMatchObject({
      animation: "sit-down",
      position: route.place.at,
      heading: route.place.heading,
    });
    expect(arrival(route)).toBeCloseTo(
      walkSeconds.standUp + walking + walkSeconds.sitDown,
    );
    // However long the meeting lasts, it stays seated.
    expect(at(arrival(route) + 600).animation).toBe("sit");
    // It ended at 100 s: it stands, walks home facing home, and sits down.
    const leave = 100;
    expect(at(leave + 0.1, leave).animation).toBe("stand-up");
    const back = at(leave + walkSeconds.standUp + walking / 2, leave);
    expect(back.animation).toBe("walk");
    expect(
      at(leave + walkSeconds.standUp + walking + 0.1, leave),
    ).toMatchObject({ animation: "sit-down", position: route.path[0] });
    expect(homeward(route)).toBeCloseTo(
      walkSeconds.standUp + walking + walkSeconds.sitDown,
    );
    // Never faster than walking pace.
    let before = at(0).position;
    for (
      let elapsed = 0.05;
      elapsed < leave + homeward(route);
      elapsed += 0.05
    ) {
      const now = at(elapsed, leave).position;
      expect(distance(before, now)).toBeLessThanOrEqual(
        walkSpeed * 0.05 + 1e-9,
      );
      before = now;
    }
  });

  it("a meeting that ends before the Agent arrives keeps it at the table for a moment, so it is seen", () => {
    const one = attendance("agent-2");
    const pose = meetingPose({
      ...one,
      elapsed: arrival(one.route) + minimumStay - 0.1,
      endedAt: 1,
    });
    expect(pose.animation).toBe("sit");
  });

  it("the Manager stands at the whiteboard: it never sits there", () => {
    const manager = attendance("agent-1");
    expect(meetingPose({ ...manager, elapsed: 120 }).animation).toBe("idle");
  });
});

describe("meetings as their signals arrive", () => {
  const layout = floorLayout(team(4));
  const plan = meetingPlanner(layout);
  const run = (attendances: Attendances, seconds: number) =>
    advanceMeetings(attendances, seconds, () => false);

  it("a Kickoff gathers its Agents and the Manager until it ends; then each goes back and is done", () => {
    let attendances = receiveMeeting(
      new Map(),
      gather(4, ["agent-2", "agent-3"]),
      plan,
    );
    expect([...attendances.keys()].sort()).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
    ]);
    attendances = run(attendances, 60);
    expect(meetingPose(defined(attendances.get("agent-2"))).animation).toBe(
      "sit",
    );
    // Another Batch's end does not end this Kickoff.
    attendances = receiveMeeting(attendances, end(5, 99), plan);
    attendances = run(attendances, 600);
    expect(attendances.size).toBe(3);
    attendances = receiveMeeting(attendances, end(6), plan);
    attendances = run(attendances, 1);
    expect(meetingPose(defined(attendances.get("agent-2"))).animation).toBe(
      "stand-up",
    );
    attendances = run(attendances, 120);
    expect(attendances.size).toBe(0);
  });

  it("a Wrap-up ends by itself once its Agents have sat for a while", () => {
    let attendances = receiveMeeting(
      new Map(),
      gather(9, ["agent-2"], "wrap-up"),
      plan,
    );
    const seated = arrival(defined(attendances.get("agent-2")).route);
    attendances = run(attendances, seated + wrapUpSeconds - 0.5);
    expect(meetingPose(defined(attendances.get("agent-2"))).animation).toBe(
      "sit",
    );
    attendances = run(attendances, 1);
    expect(meetingPose(defined(attendances.get("agent-2"))).animation).toBe(
      "stand-up",
    );
  });

  it("a Status update gathers the whole Floor, a turn each, then everyone walks back and sits at their desk (FR-23a)", () => {
    const [signal] = meetingSignals([
      {
        id: 12,
        occurredAt: "2026-10-12T08:30:00.000Z",
        event: {
          type: "status_update.given",
          version: 1,
          floorId: "web-shop",
          agentId: "agent-1",
          agentIds: ["agent-2", "agent-3", "agent-4"],
          day: "2026-10-12",
          reportedDay: "2026-10-09",
          trigger: "daily",
          messageId: 41,
        },
      },
    ]);
    expect(signal).toEqual({
      type: "gather",
      id: 12,
      floorId: "web-shop",
      batchId: 12,
      kind: "status-update",
      managerId: "agent-1",
      agentIds: ["agent-2", "agent-3", "agent-4"],
    });
    let attendances = receiveMeeting(new Map(), defined(signal), plan);
    expect([...attendances.keys()].sort()).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
    // Four speakers, five seconds each: as long as a Wrap-up.
    expect(statusUpdateSeconds(4)).toBe(wrapUpSeconds);
    expect(statusUpdateSeconds(8)).toBe(40);
    expect(statusUpdateSeconds(100)).toBe(90);
    const seated = arrival(defined(attendances.get("agent-2")).route);
    attendances = run(attendances, seated + wrapUpSeconds - 0.5);
    expect(meetingPose(defined(attendances.get("agent-2"))).animation).toBe(
      "sit",
    );
    attendances = run(attendances, 120);
    // Everyone is back at their desk, seated: no attendance is left.
    expect(attendances.size).toBe(0);
  });

  it("an Agent on a Handoff walk sets off once it is back; one still in the room stays for the next meeting", () => {
    let attendances = receiveMeeting(
      new Map(),
      gather(4, ["agent-2", "agent-3"]),
      plan,
    );
    attendances = advanceMeetings(attendances, 5, (id) => id === "agent-3");
    expect(attendances.get("agent-3")).toMatchObject({
      started: false,
      elapsed: 0,
    });
    expect(attendances.get("agent-2")).toMatchObject({
      started: true,
      elapsed: 5,
    });
    // The Wrap-up of the same Batch, while they are still there.
    attendances = run(attendances, 60);
    attendances = receiveMeeting(
      attendances,
      gather(9, ["agent-2"], "wrap-up"),
      plan,
    );
    const kept = defined(attendances.get("agent-2"));
    expect(kept).toMatchObject({ kind: "wrap-up", elapsed: 65 });
    expect(kept.endedAt).toBe(65 + wrapUpSeconds);
  });

  it("fast forward seats everyone on the way at once, with their whole Status update still ahead", () => {
    let attendances = receiveMeeting(
      new Map(),
      gather(7, ["agent-2", "agent-3"], "status-update"),
      plan,
    );
    attendances = run(attendances, 1);
    attendances = arriveAll(attendances);
    const seated = defined(attendances.get("agent-2"));
    expect(seated.elapsed).toBe(arrival(seated.route));
    expect(meetingPose(seated).animation).toBe("sit");
    expect(meetingPose(defined(attendances.get("agent-1"))).animation).toBe(
      "idle",
    );
    // The meeting lasts as long as it would have from there.
    attendances = run(attendances, statusUpdateSeconds(3) - 0.5);
    expect(meetingPose(defined(attendances.get("agent-2"))).animation).toBe(
      "sit",
    );
  });

  it("fast forward leaves one already there, or on its way back, be", () => {
    let attendances = receiveMeeting(new Map(), gather(4, ["agent-2"]), plan);
    attendances = run(attendances, 60);
    expect(arriveAll(attendances)).toEqual(attendances);
    attendances = receiveMeeting(attendances, end(6), plan);
    attendances = run(attendances, minimumStay + 1);
    expect(arriveAll(attendances)).toEqual(attendances);
  });

  it("a walker says whether anyone is on the way, and fast forwards them", () => {
    const walker = createMeetingWalker("web-shop");
    expect(walker.gathering()).toBe(false);
    walker.receive(gather(5, ["agent-2"]), plan);
    expect(walker.gathering()).toBe(true);
    walker.arriveAll();
    expect(walker.gathering()).toBe(false);
    expect(walker.poseOf("agent-2")?.animation).toBe("sit");
  });

  it("a walker ignores another Floor's meetings, and with reduced motion everyone is back at once", () => {
    const walker = createMeetingWalker("web-shop");
    walker.receive({ ...gather(4, ["agent-2"]), floorId: "blog" }, plan);
    expect(walker.attending("agent-2")).toBe(false);
    walker.receive(gather(5, ["agent-2"]), plan);
    expect(walker.attending("agent-2")).toBe(true);
    // Waiting to set off, it is at its desk.
    expect(walker.poseOf("agent-2")).toBeUndefined();
    walker.advance(walkSeconds.standUp + 1, () => false);
    expect(walker.poseOf("agent-2")?.animation).toBe("walk");
    walker.skipAll();
    expect(walker.attending("agent-2")).toBe(false);
    expect(walker.poseOf("agent-2")).toBeUndefined();
  });
});
