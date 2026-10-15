import type { StreamedEvent } from "@ai-office/events/stream";
import type { Role } from "@ai-office/shared";
import { randomAvatar, seededRandom } from "@ai-office/shared/avatar";
import { describe, expect, it } from "vitest";

import { animationSpec } from "./avatar-animations.ts";
import { avatarRig } from "./avatar-rig.ts";
import { deskFacing, type Rect } from "./desk-set.ts";
import {
  floorLayout,
  type FloorAgent,
  type FloorLayout,
} from "./floor-layout.ts";
import {
  advanceHandoffs,
  catchUpPace,
  createHandoffWalker,
  handoffRoute,
  handoffTickets,
  handoffWalk,
  headingOf,
  monitorLight,
  paceOf,
  pointAlong,
  queueHandoff,
  skipHandoffs,
  stepAside,
  walkPose,
  walkSeconds,
  walkSpeed,
  type HandoffQueues,
  type HandoffTicket,
  type WalkPlanner,
} from "./handoff-walks.ts";
import { placedSize, type ModelPlacement } from "./models.ts";
import { footprint } from "./pieces.ts";
import { distance, walk, type FloorPoint } from "./waypoints.ts";

// Handoff walks (PRD FR-59), as data: the way an Agent walks a ticket over
// the Floor's waypoints to the next Agent's desk and back, the walk's
// timing and poses, and each Agent's queue of walks, which hurries and
// then skips Handoffs when they fall behind.

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

const seatOf = (layout: FloorLayout, agentId: string): FloorPoint => {
  const { seat } = defined(
    layout.desks.find((each) => each.agentId === agentId),
  );
  return [seat[0], seat[2]];
};

const near = (a: FloorPoint, b: FloorPoint, within = 1e-6) =>
  distance(a, b) <= within;

/** Whether `point` lies on the segment from `a` to `b`. */
const onSegment = (point: FloorPoint, a: FloorPoint, b: FloorPoint) =>
  Math.abs(distance(a, point) + distance(point, b) - distance(a, b)) < 1e-6;

/** Whether a leg runs along one of the graph's edges (all of it, or part). */
function alongAnEdge(
  layout: FloorLayout,
  from: FloorPoint,
  to: FloorPoint,
): boolean {
  const byId = new Map(
    layout.waypoints.waypoints.map((each) => [each.id, each.position]),
  );
  return layout.waypoints.edges.some(([a, b]) => {
    const start = defined(byId.get(a));
    const end = defined(byId.get(b));
    return onSegment(from, start, end) && onSegment(to, start, end);
  });
}

const modelFootprint = (placement: ModelPlacement): Rect => {
  const [width, , depth] = placedSize(placement);
  const [x, , z] = placement.position;
  return {
    x: [x - width / 2, x + width / 2],
    z: [z - depth / 2, z + depth / 2],
  };
};

/** What an Agent cannot walk through: anything standing between the floor and head height. */
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

/** How far a point is from a rectangle, 0 inside it. */
function clearance([x, z]: FloorPoint, rect: Rect): number {
  const dx = Math.max(rect.x[0] - x, 0, x - rect.x[1]);
  const dz = Math.max(rect.z[0] - z, 0, z - rect.z[1]);
  return Math.hypot(dx, dz);
}

/** Half an Agent's shoulders: how close a path may come to anything. */
const shoulder = 0.2;

/** Every pair of a team's Agents, giver first. */
const pairs = (agents: readonly FloorAgent[]) =>
  agents.flatMap(({ id: from }) =>
    agents.flatMap(({ id: to }) => (from === to ? [] : [[from, to] as const])),
  );

let nextId = 1;
const ticket = (
  fromAgentId: string,
  toAgentId: string,
  more: Partial<HandoffTicket> = {},
): HandoffTicket => ({
  id: nextId++,
  floorId: "web-shop",
  issue: 42,
  stage: "needs-review",
  fromAgentId,
  toAgentId,
  ...more,
});

describe("the way a Handoff is walked", () => {
  const sizes = Array.from({ length: 11 }, (_, index) => index + 2);

  it.each(sizes)(
    "goes from each of %i Agents' seats over the waypoints to beside every other's chair",
    (size) => {
      const agents = team(size);
      const layout = floorLayout(agents);
      for (const [from, to] of pairs(agents)) {
        const route = defined(handoffRoute(layout, from, to));
        const { path } = route;
        const label = `${from} to ${to}`;
        // From the giver's seat to beside the receiver's chair.
        expect(near(defined(path[0]), seatOf(layout, from)), label).toBe(true);
        expect(
          distance(defined(path.at(-1)), seatOf(layout, to)),
          label,
        ).toBeCloseTo(stepAside, 6);
        // Off its chair in at most two legs (aside, then to the walkway),
        // along the graph's edges, and into the receiver's in at most two.
        const legs = path.slice(1).map((to, index) => {
          const start = defined(path[index]);
          return { start, end: to, along: alongAnEdge(layout, start, to) };
        });
        const firstOn = legs.findIndex(({ along }) => along);
        const lastOn = legs.findLastIndex(({ along }) => along);
        expect(firstOn, label).toBeGreaterThanOrEqual(1);
        expect(firstOn, label).toBeLessThanOrEqual(2);
        expect(legs.length - 1 - lastOn, label).toBeGreaterThanOrEqual(1);
        expect(legs.length - 1 - lastOn, label).toBeLessThanOrEqual(2);
        for (const leg of legs.slice(firstOn, lastOn + 1)) {
          expect(leg.along, label).toBe(true);
        }
        // Its length is its legs', and no longer than the shortest way
        // between the desks' waypoints and the steps on and off it.
        expect(route.length).toBeCloseTo(
          legs.reduce((sum, { start, end }) => sum + distance(start, end), 0),
          6,
        );
        const giver = defined(layout.desks.find((d) => d.agentId === from));
        const receiver = defined(layout.desks.find((d) => d.agentId === to));
        const graphWay = defined(
          walk(layout.waypoints, giver.waypoint, receiver.waypoint),
        );
        const graphLength = graphWay
          .slice(1)
          .reduce(
            (sum, each, index) =>
              sum + distance(defined(graphWay[index]).position, each.position),
            0,
          );
        const stepOn = (leg: number) =>
          legs
            .slice(0, leg)
            .reduce((sum, { start, end }) => sum + distance(start, end), 0);
        const stepOff = legs
          .slice(lastOn + 1)
          .reduce((sum, { start, end }) => sum + distance(start, end), 0);
        expect(route.length, label).toBeLessThanOrEqual(
          graphLength + 2 * (stepOn(firstOn) + stepOff) + 1e-6,
        );
        // It faces its desk in its chair, and the receiver as it hands over.
        expect(route.seatHeading).toBe(deskFacing(giver.turns));
        const end = defined(path.at(-1));
        const [rx, rz] = seatOf(layout, to);
        expect(route.handOverHeading).toBeCloseTo(
          headingOf([rx - end[0], rz - end[1]]),
          9,
        );
      }
    },
  );

  it.each([2, 5, 6, 12])(
    "keeps every walk of %i Agents' Floor clear of furniture and walls, once off the chairs",
    (size) => {
      const agents = team(size);
      const layout = floorLayout(agents);
      const blocking = obstacles(layout);
      for (const [from, to] of pairs(agents)) {
        const { path, length } = defined(handoffRoute(layout, from, to));
        const seats = [seatOf(layout, from), seatOf(layout, to)];
        // Only what is within a shoulder of the way's bounds can be too close.
        const xs = path.map(([x]) => x);
        const zs = path.map(([, z]) => z);
        const bounds: Rect = {
          x: [Math.min(...xs), Math.max(...xs)],
          z: [Math.min(...zs), Math.max(...zs)],
        };
        const nearby = blocking.filter(
          ({ rect }) =>
            rect.x[0] < bounds.x[1] + shoulder &&
            rect.x[1] > bounds.x[0] - shoulder &&
            rect.z[0] < bounds.z[1] + shoulder &&
            rect.z[1] > bounds.z[0] - shoulder,
        );
        for (let along = 0; along <= length; along += 0.05) {
          const at = pointAlong(path, along);
          // Rising from the chair (and standing by the receiver's), the
          // Agent is at its chair; everywhere else it is clear.
          if (seats.some((seat) => distance(seat, at) < 0.45)) {
            continue;
          }
          expect(at[0]).toBeGreaterThan(layout.bounds.x[0]);
          expect(at[0]).toBeLessThan(layout.bounds.x[1]);
          expect(at[1]).toBeGreaterThan(layout.bounds.z[0]);
          expect(at[1]).toBeLessThan(layout.bounds.z[1]);
          const nearest = nearby.reduce(
            (best, each) => {
              const gap = clearance(at, each.rect);
              return gap < best.gap ? { gap, name: each.name } : best;
            },
            { gap: Infinity, name: "" },
          );
          if (nearest.gap < shoulder) {
            expect.fail(
              `${from} to ${to}, ${along.toFixed(2)} m in, passes ${nearest.name}`,
            );
          }
        }
      }
    },
  );

  it("goes straight along the row to a neighbour, never doubling back past its own desk", () => {
    const layout = floorLayout(team(6));
    // agent-2 and agent-3 sit side by side in the first row.
    const route = defined(handoffRoute(layout, "agent-2", "agent-3"));
    const [, aside, onWalkway] = route.path;
    expect(defined(aside)[1]).toBeCloseTo(seatOf(layout, "agent-2")[1], 9);
    expect(defined(onWalkway)[0]).toBeCloseTo(defined(aside)[0], 9);
    // Along the walkway, every step is the same way.
    const steps = route.path
      .slice(2, -1)
      .slice(1)
      .map(([x], index) => Math.sign(x - defined(route.path[index + 2])[0]));
    expect(steps.length).toBeGreaterThan(0);
    expect(new Set(steps).size).toBe(1);
    // Two desks 2.4 m apart: aside, 1 m back, along between the two
    // steps aside, then 1 m in to beside the neighbour's chair.
    expect(route.length).toBeCloseTo(
      stepAside + 1 + (2.4 - 2 * stepAside) + 1,
      6,
    );
  });

  it("walks to and from the Manager's glass office", () => {
    const layout = floorLayout(team(4));
    for (const [from, to] of [
      ["agent-2", "agent-1"],
      ["agent-1", "agent-3"],
    ] as const) {
      const route = defined(handoffRoute(layout, from, to));
      const ids = new Set(
        layout.waypoints.waypoints
          .filter(({ position }) =>
            route.path.some((point) => near(point, position)),
          )
          .map(({ id }) => id),
      );
      expect(ids).toContain("managers-office");
      expect(ids).toContain("managers-office-door");
    }
  });

  it("has no way for an Agent to itself, or for an Agent not on the Floor", () => {
    const layout = floorLayout(team(4));
    expect(handoffRoute(layout, "agent-2", "agent-2")).toBeUndefined();
    expect(handoffRoute(layout, "agent-2", "someone-else")).toBeUndefined();
    expect(handoffRoute(layout, "someone-else", "agent-2")).toBeUndefined();
  });

  it("finds a point along the way and clamps to its ends", () => {
    const path: FloorPoint[] = [
      [0, 0],
      [3, 0],
      [3, 4],
    ];
    expect(pointAlong(path, -1)).toEqual([0, 0]);
    expect(pointAlong(path, 1.5)).toEqual([1.5, 0]);
    expect(pointAlong(path, 5)).toEqual([3, 2]);
    expect(pointAlong(path, 99)).toEqual([3, 4]);
  });
});

describe("a Handoff walk", () => {
  const layout = floorLayout(team(6));
  const given = ticket("agent-2", "agent-5");
  const route = defined(handoffRoute(layout, "agent-2", "agent-5"));
  const plan = handoffWalk(given, route);
  const walking = route.length / walkSpeed;

  it("times the parts at the desks by the animations they play, and walks there and back", () => {
    // Any Avatar: every body's animations last as long.
    const someRig = avatarRig(randomAvatar(seededRandom("agent-2")));
    expect(walkSeconds.standUp).toBe(
      animationSpec("stand-up", someRig).duration,
    );
    expect(walkSeconds.handOver).toBe(
      animationSpec("hand-over", someRig).duration,
    );
    expect(walkSeconds.sitDown).toBe(
      animationSpec("sit-down", someRig).duration,
    );
    expect(plan.handOverAt).toBeCloseTo(
      walkSeconds.standUp + walking + walkSeconds.handOver,
      9,
    );
    expect(plan.duration).toBeCloseTo(
      plan.handOverAt + walking + walkSeconds.sitDown,
      9,
    );
  });

  it("stands, carries the ticket there, hands it over, walks back and sits down", () => {
    const seat = seatOf(layout, "agent-2");
    const end = defined(route.path.at(-1));

    const rising = walkPose(plan, 0.5);
    expect(rising.animation).toBe("stand-up");
    expect(near(rising.position, seat)).toBe(true);
    expect(rising.heading).toBe(route.seatHeading);
    expect(rising.carrying).toBe(false);

    // Carrying it, at walking pace, facing the way it goes.
    const halfway = walkSeconds.standUp + walking / 2;
    const out = walkPose(plan, halfway);
    expect(out.animation).toBe("carry");
    expect(out.carrying).toBe(true);
    const outPoint = pointAlong(route.path, route.length / 2);
    expect(near(out.position, outPoint)).toBe(true);
    const ahead = pointAlong(route.path, route.length / 2 + 0.05);
    const behind = pointAlong(route.path, route.length / 2 - 0.05);
    expect(
      Math.cos(
        out.heading - headingOf([ahead[0] - behind[0], ahead[1] - behind[1]]),
      ),
    ).toBeGreaterThan(0.7);

    const handing = walkPose(plan, plan.handOverAt - 0.5);
    expect(handing.animation).toBe("hand-over");
    expect(handing.carrying).toBe(true);
    expect(near(handing.position, end)).toBe(true);
    expect(handing.heading).toBe(route.handOverHeading);

    // Back the same way, empty-handed, facing home.
    const back = walkPose(plan, plan.handOverAt + walking / 2);
    expect(back.animation).toBe("walk");
    expect(back.carrying).toBe(false);
    expect(near(back.position, outPoint)).toBe(true);
    expect(Math.cos(back.heading - out.heading)).toBeLessThan(-0.7);

    const sitting = walkPose(plan, plan.duration - 0.5);
    expect(sitting.animation).toBe("sit-down");
    expect(near(sitting.position, seat)).toBe(true);
    expect(sitting.heading).toBe(route.seatHeading);
  });

  it("moves at walking pace every step of the way", () => {
    let before = walkPose(plan, walkSeconds.standUp).position;
    const step = 0.1;
    for (
      let time = walkSeconds.standUp + step;
      time < plan.handOverAt - walkSeconds.handOver;
      time += step
    ) {
      const { position } = walkPose(plan, time);
      expect(distance(before, position)).toBeLessThanOrEqual(
        walkSpeed * step + 1e-9,
      );
      before = position;
    }
  });
});

/**
 * Plans every ticket as a walk of 2.25 m each way: the ticket is handed
 * over 4 s after the Agent begins to stand, and it is back in its chair
 * at 7 s.
 */
const fixedPlan: WalkPlanner = (each) =>
  handoffWalk(each, {
    path: [
      [0, 0],
      [2.25, 0],
    ],
    length: 2.25,
    seatHeading: 0,
    handOverHeading: 0,
  });
const handOverAt = 4;
const duration = 7;
const noRoute: WalkPlanner = () => undefined;

describe("each Agent's queue of Handoff walks", () => {
  const start = (...tickets: HandoffTicket[]) => {
    let queues: HandoffQueues = new Map();
    const handedOver: HandoffTicket[] = [];
    for (const each of tickets) {
      const step = queueHandoff(queues, each, fixedPlan);
      queues = step.queues;
      handedOver.push(...step.handedOver);
    }
    return { queues, handedOver };
  };
  const advance = (queues: HandoffQueues, seconds: number) =>
    advanceHandoffs(queues, seconds, fixedPlan);

  it("sets off at once, hands the ticket over on arriving, and is done once back", () => {
    const first = ticket("coder", "reviewer");
    const { queues, handedOver } = start(first);
    expect(handedOver).toEqual([]);
    expect(queues.get("coder")?.current.walk.ticket).toBe(first);

    const there = advance(queues, 3.9);
    expect(there.handedOver).toEqual([]);
    const given = advance(there.queues, 0.2);
    expect(given.handedOver).toEqual([first]);
    // Handed over once only.
    const back = advance(given.queues, 2.5);
    expect(back.handedOver).toEqual([]);
    expect(back.queues.has("coder")).toBe(true);
    const done = advance(back.queues, 1);
    expect(done.queues.has("coder")).toBe(false);
  });

  it("hands a ticket over at once when it cannot be walked", () => {
    const first = ticket("coder", "reviewer");
    const step = queueHandoff(new Map(), first, noRoute);
    expect(step.handedOver).toEqual([first]);
    expect(step.queues.size).toBe(0);
  });

  it("queues the next Handoff behind the walk under way, which hurries while it waits", () => {
    const first = ticket("coder", "reviewer-1");
    const second = ticket("coder", "reviewer-2");
    const { queues, handedOver } = start(first, second);
    expect(handedOver).toEqual([]);
    const walks = defined(queues.get("coder"));
    expect(walks.next).toBe(second);
    // Hurrying, at twice the pace, the first walk ends in half its time…
    expect(paceOf(walks)).toBe(2);
    expect(
      advance(queues, duration / 2 - 0.1).queues.get("coder")?.current.walk
        .ticket,
    ).toBe(first);
    const first5 = advance(queues, duration / 2);
    expect(first5.handedOver).toEqual([first]);
    // …and the second sets off, at its own pace now nothing waits.
    const now = defined(first5.queues.get("coder"));
    expect(now.current.walk.ticket).toBe(second);
    expect(now.current.elapsed).toBe(0);
    expect(paceOf(now)).toBe(1);
    const given = advance(first5.queues, handOverAt);
    expect(given.handedOver).toEqual([second]);
  });

  it("skips forward when it falls behind: a waiting Handoff is handed over at once for a newer one", () => {
    const tickets = Array.from({ length: 10 }, (_, index) =>
      ticket("coder", `reviewer-${String(index + 1)}`),
    );
    const { queues, handedOver } = start(...tickets);
    // The first is walked, the newest waits, and every one between is
    // handed over the moment a newer one comes.
    expect(handedOver).toEqual(tickets.slice(1, -1));
    expect(queues.get("coder")?.current.walk.ticket).toBe(tickets[0]);
    expect(queues.get("coder")?.next).toBe(tickets.at(-1));
    // Every ticket is handed over within two walks, however many came:
    // the first hurried, then the newest.
    let state = queues;
    const later: HandoffTicket[] = [];
    for (let time = 0; time < duration / catchUpPace + duration; time += 0.25) {
      const step = advance(state, 0.25);
      state = step.queues;
      later.push(...step.handedOver);
    }
    expect(later).toEqual([tickets[0], tickets.at(-1)]);
    expect(state.size).toBe(0);
  });

  it("never holds more than the walk under way and one waiting, however fast they come", () => {
    let queues: HandoffQueues = new Map();
    let handed = 0;
    for (let index = 0; index < 500; index += 1) {
      const step = queueHandoff(queues, ticket("coder", "reviewer"), fixedPlan);
      const advanced = advance(step.queues, 0.05);
      queues = advanced.queues;
      handed += step.handedOver.length + advanced.handedOver.length;
      const walks = defined(queues.get("coder"));
      expect(walks.current.elapsed).toBeLessThan(duration);
    }
    // At most two not yet handed over: the one walking and the one waiting.
    expect(500 - handed).toBeLessThanOrEqual(2);
  });

  it("walks each Agent's Handoffs in its own queue, side by side", () => {
    const coders = ticket("coder", "reviewer");
    const qas = ticket("qa", "docs");
    const { queues } = start(coders, qas);
    expect(paceOf(defined(queues.get("coder")))).toBe(1);
    expect(paceOf(defined(queues.get("qa")))).toBe(1);
    const given = advance(queues, handOverAt);
    expect(given.handedOver).toEqual([coders, qas]);
  });

  it("hands every ticket over at once when skipped, under way and waiting", () => {
    const first = ticket("coder", "reviewer-1");
    const second = ticket("coder", "reviewer-2");
    const third = ticket("qa", "docs");
    const { queues } = start(first, second, third);
    const underWay = advance(queues, 1);
    const skipped = skipHandoffs(underWay.queues);
    expect(skipped.handedOver).toEqual([first, second, third]);
    expect(skipped.queues.size).toBe(0);
    // A ticket already handed over is not handed over again.
    const half = advance(start(first).queues, 5);
    expect(half.handedOver).toEqual([first]);
    expect(skipHandoffs(half.queues).handedOver).toEqual([]);
  });
});

describe("a Floor's Handoff walker", () => {
  it("walks its own Floor's Handoffs, ignoring another's", () => {
    const walker = createHandoffWalker("web-shop");
    walker.receive(ticket("coder", "reviewer", { floorId: "blog" }), fixedPlan);
    expect(walker.poseOf("coder")).toBeUndefined();
    walker.receive(ticket("coder", "reviewer"), fixedPlan);
    expect(walker.poseOf("coder")).toMatchObject({
      animation: "stand-up",
      pace: 1,
    });
    walker.advance(2, fixedPlan);
    expect(walker.poseOf("coder")?.animation).toBe("carry");
    expect([...walker.carried().keys()]).toEqual(["coder"]);
  });

  it("lights the receiving monitor as the ticket is handed over, then lets it fade", () => {
    const walker = createHandoffWalker("web-shop");
    walker.receive(ticket("coder", "reviewer"), fixedPlan);
    walker.advance(3.9, fixedPlan);
    expect(walker.lit()).toBe(false);
    expect(walker.light("reviewer")).toBe(0);
    walker.advance(0.1, fixedPlan);
    expect(walker.lit()).toBe(true);
    expect(walker.light("reviewer")).toBe(1);
    expect(walker.light("coder")).toBe(0);
    expect(walker.carried().size).toBe(0);
    walker.advance(monitorLight.seconds - monitorLight.fade / 2, fixedPlan);
    expect(walker.light("reviewer")).toBeCloseTo(0.5, 6);
    walker.advance(monitorLight.fade, fixedPlan);
    expect(walker.light("reviewer")).toBe(0);
    expect(walker.lit()).toBe(false);
  });

  it("lights the monitor at once for a ticket that is not walked", () => {
    const walker = createHandoffWalker("web-shop");
    walker.receive(ticket("coder", "reviewer"), noRoute);
    expect(walker.poseOf("coder")).toBeUndefined();
    expect(walker.light("reviewer")).toBe(1);
  });

  it("skips every walk at once, lighting each receiving monitor", () => {
    const walker = createHandoffWalker("web-shop");
    walker.receive(ticket("coder", "reviewer-1"), fixedPlan);
    walker.receive(ticket("coder", "reviewer-2"), fixedPlan);
    expect(walker.poseOf("coder")?.pace).toBe(catchUpPace);
    walker.skipAll();
    expect(walker.poseOf("coder")).toBeUndefined();
    expect(walker.light("reviewer-1")).toBe(1);
    expect(walker.light("reviewer-2")).toBe(1);
  });
});

describe("Handoff tickets from the event stream", () => {
  it("takes each Handoff's issue, stage and Agents, and nothing else", () => {
    const events: StreamedEvent[] = [
      {
        id: 7,
        occurredAt: "2026-10-09T12:00:00.000Z",
        event: {
          type: "agent.queue_changed",
          version: 1,
          floorId: "web-shop",
          agentId: "ada",
          queued: 1,
        },
      },
      {
        id: 8,
        occurredAt: "2026-10-09T12:00:01.000Z",
        event: {
          type: "handoff",
          version: 1,
          floorId: "web-shop",
          issue: 14,
          fromAgentId: "ada",
          toAgentId: "bo",
          stage: "needs-review",
          summary: { changed: "x", check: "y", risks: "z" },
        },
      },
    ];
    expect(handoffTickets(events)).toEqual([
      {
        id: 8,
        floorId: "web-shop",
        issue: 14,
        stage: "needs-review",
        fromAgentId: "ada",
        toAgentId: "bo",
      },
    ]);
  });
});
