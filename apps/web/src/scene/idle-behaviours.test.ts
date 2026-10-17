import type { Role } from "@ai-office/shared";
import { randomAvatar, seededRandom } from "@ai-office/shared/avatar";
import { describe, expect, it } from "vitest";

import { agentLook } from "./agent-state.ts";
import { animationSpec } from "./avatar-animations.ts";
import { avatarRig } from "./avatar-rig.ts";
import type { Rect } from "./desk-set.ts";
import {
  floorLayout,
  type FloorAgent,
  type FloorLayout,
} from "./floor-layout.ts";
import {
  pointAlong,
  stepAside,
  walkSeconds,
  walkSpeed,
} from "./handoff-walks.ts";
import {
  advanceIdle,
  chooseActivity,
  createIdleBehaviours,
  idleActivities,
  calledOff,
  idlePlaceOn,
  idlePlaces,
  idlePose,
  idleStateOf,
  idleTrip,
  longIdleSeconds,
  mountedLocations,
  restSeconds,
  seatedLocations,
  startingAt,
  type IdleActivity,
  type IdleAgents,
  type IdlePlanner,
  type IdleState,
  type IdleTrip,
} from "./idle-behaviours.ts";
import { placedSize, type ModelPlacement } from "./models.ts";
import { footprint } from "./pieces.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// Idle behaviours (PRD FR-61), as data: the activities, the weighted
// choice between them, each spot's occupancy limit, the trips there and
// back, and a new task interrupting any of them at once.

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

const activity = (name: string): IdleActivity =>
  defined(idleActivities.find((each) => each.name === name));

const seatOf = (layout: FloorLayout, agentId: string): FloorPoint => {
  const { seat } = defined(
    layout.desks.find((each) => each.agentId === agentId),
  );
  return [seat[0], seat[2]];
};

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

/** Half an Agent's shoulders: how close it may come to anything. */
const shoulder = 0.2;

/** A random source that gives `values` in turn, then the last for ever. */
const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
};

/** Every Agent in one state. */
const allIn = (ids: readonly string[], state: IdleState) =>
  new Map(ids.map((id) => [id, state] as const));

const layout = floorLayout(team(6));
const ids = layout.desks.map(({ agentId }) => agentId);
const plan: IdlePlanner = (agentId, chosen, place) =>
  idleTrip(layout, agentId, chosen, place);

/** Steps the idling on by `seconds`, a tenth of a second at a time. */
function run(
  agents: IdleAgents,
  seconds: number,
  states: ReadonlyMap<string, IdleState>,
  random: () => number,
  activities: readonly IdleActivity[] = idleActivities,
): IdleAgents {
  let now = agents;
  for (let step = 0; step < Math.round(seconds / 0.1); step += 1) {
    now = advanceIdle(now, 0.1, states, plan, random, activities);
  }
  return now;
}

/** The PRD's five, first in the list. */
const prdFive = idleActivities.slice(0, 5);

describe("the idle activities", () => {
  it("start with the PRD's five: a stretch after finishing, a coffee, the gym, the water cooler and a doze after a long idle", () => {
    expect(
      prdFive.map(({ name, when, location, animation }) => ({
        name,
        when,
        location,
        animation,
      })),
    ).toEqual([
      {
        name: "stretch",
        when: "finished",
        location: "beside the desk",
        animation: "stretch",
      },
      {
        name: "coffee",
        when: "idle",
        location: "coffee-machine",
        animation: "drink",
      },
      { name: "workout", when: "idle", location: "gym", animation: "work-out" },
      {
        name: "water-cooler chat",
        when: "idle",
        location: "water-cooler",
        animation: "chat",
      },
      {
        name: "doze",
        when: "long idle",
        location: "chair",
        animation: "sleep",
      },
    ]);
    expect(activity("doze").bubble).toBe("zzz");
  });

  it("are at least 30 more besides, each its own, each saying what it is with a bubble", () => {
    const more = idleActivities.slice(5);
    expect(more.length).toBeGreaterThanOrEqual(30);
    const names = idleActivities.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const each of more) {
      expect(each.bubble, each.name).toBeTruthy();
      expect(each.when, each.name).not.toBe("finished");
    }
    // Every amenity an idle Agent goes to has something to do there.
    for (const location of Object.keys(idlePlaces)) {
      expect(
        idleActivities.some((each) => each.location === location),
        location,
      ).toBe(true);
    }
  });

  it("each last a while, may be chosen and hold at least one Agent", () => {
    for (const each of idleActivities) {
      expect(each.duration).toBeGreaterThan(0);
      expect(each.weight).toBeGreaterThan(0);
      expect(Number.isInteger(each.occupancy)).toBe(true);
      expect(each.occupancy).toBeGreaterThanOrEqual(1);
    }
  });

  it("are seated in the chair and at the other seats, and standing everywhere else, as their animations are", () => {
    const rig = avatarRig(randomAvatar(seededRandom("idle")));
    for (const each of idleActivities) {
      expect(animationSpec(each.animation, rig).seated, each.name).toBe(
        seatedLocations.includes(each.location),
      );
    }
  });

  it("have a place for every Agent each spot's occupancy limit lets in", () => {
    for (const each of idleActivities) {
      if (each.location !== "chair" && each.location !== "beside the desk") {
        expect(idlePlaces[each.location].length).toBeGreaterThanOrEqual(
          each.occupancy,
        );
      }
    }
  });
});

describe("choosing an idle activity", () => {
  const options = [
    { name: "a", weight: 1 },
    { name: "b", weight: 3 },
    { name: "never", weight: 0 },
  ];

  it("gives each candidate a share of the draw as wide as its weight", () => {
    expect(chooseActivity(options, () => 0)?.name).toBe("a");
    expect(chooseActivity(options, () => 0.2499)?.name).toBe("a");
    expect(chooseActivity(options, () => 0.25)?.name).toBe("b");
    expect(chooseActivity(options, () => 0.9999)?.name).toBe("b");
  });

  it("picks each as often as its weight, over many draws", () => {
    const random = seededRandom("weighted choice");
    const counts = new Map<string, number>();
    const draws = 20_000;
    for (let draw = 0; draw < draws; draw += 1) {
      const name = defined(chooseActivity(idleActivities, random)).name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const total = idleActivities.reduce((sum, { weight }) => sum + weight, 0);
    for (const { name, weight } of idleActivities) {
      expect((counts.get(name) ?? 0) / draws).toBeCloseTo(weight / total, 1);
    }
  });

  it("never picks one weighted 0, and picks nothing from nothing", () => {
    for (let value = 0; value < 1; value += 0.01) {
      expect(chooseActivity(options, () => value)?.name).not.toBe("never");
    }
    expect(chooseActivity<{ weight: number }>([], () => 0.5)).toBeUndefined();
    expect(chooseActivity([{ weight: 0 }], () => 0.5)).toBeUndefined();
  });
});

describe("an Agent's idle state", () => {
  const look = (state: Partial<Parameters<typeof agentLook>[0]> = {}) =>
    agentLook({
      working: false,
      enabled: true,
      capped: false,
      awaitingReview: 0,
      queued: 0,
      ...state,
    });

  it("is idle only with nothing to do: not working, waiting, queued, paused, capped or walking", () => {
    expect(idleStateOf(look(), false)).toBe("idle");
    expect(idleStateOf(undefined, false)).toBe("idle");
    expect(idleStateOf(look({ working: true }), false)).toBe("working");
    expect(idleStateOf(look({ awaitingReview: 1 }), false)).toBe("busy");
    expect(idleStateOf(look({ queued: 2 }), false)).toBe("busy");
    expect(idleStateOf(look({ enabled: false }), false)).toBe("busy");
    expect(idleStateOf(look({ capped: true }), false)).toBe("busy");
    expect(idleStateOf(look(), true)).toBe("busy");
  });
});

describe("the trip to an idle activity", () => {
  it.each([2, 5, 6, 9, 12, 21])(
    "for each of %i Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair",
    (size) => {
      const floor = floorLayout(team(size));
      const blocking = obstacles(floor);
      for (const { agentId } of floor.desks) {
        const seat = seatOf(floor, agentId);
        for (const each of idleActivities) {
          const places =
            each.location === "chair" || each.location === "beside the desk"
              ? 1
              : idlePlaces[each.location].length;
          for (let place = 0; place < places; place += 1) {
            const trip = defined(idleTrip(floor, agentId, each, place));
            expect(trip.path[0]).toEqual(seat);
            if (
              each.location !== "chair" &&
              each.location !== "beside the desk"
            ) {
              expect(trip.path.at(-1)).toEqual(
                idlePlaceOn(floor.waypoints, each.location, place)?.at,
              );
            }
            // Only what is within a shoulder of the trip's bounds can be too close.
            const xs = trip.path.map(([x]) => x);
            const zs = trip.path.map(([, z]) => z);
            const nearby = blocking.filter(
              ({ rect }) =>
                rect.x[0] < Math.max(...xs) + shoulder &&
                rect.x[1] > Math.min(...xs) - shoulder &&
                rect.z[0] < Math.max(...zs) + shoulder &&
                rect.z[1] > Math.min(...zs) - shoulder,
            );
            const end = defined(trip.path.at(-1));
            const sits =
              each.location !== "chair" &&
              (seatedLocations.includes(each.location) ||
                mountedLocations.includes(each.location));
            for (let along = 0; along <= trip.length + 1e-9; along += 0.05) {
              const at = pointAlong(trip.path, along);
              // Rising from its chair, the Agent is at its chair, and
              // settling into a seat (the sofa, a café chair) or stepping
              // onto the treadmill, at that seat; everywhere else it is
              // clear.
              if (
                distance(at, seat) < 0.45 ||
                (sits && distance(at, end) < 0.6)
              ) {
                continue;
              }
              expect(at[0]).toBeGreaterThan(floor.bounds.x[0]);
              expect(at[0]).toBeLessThan(floor.bounds.x[1]);
              expect(at[1]).toBeGreaterThan(floor.bounds.z[0]);
              expect(at[1]).toBeLessThan(floor.bounds.z[1]);
              for (const { name, rect } of nearby) {
                const gap = clearance(at, rect);
                if (gap < shoulder) {
                  throw new Error(
                    `${agentId}'s trip to ${each.name} (place ${String(place)}) passes ${name} ${gap.toFixed(2)} m away at (${at[0].toFixed(2)}, ${at[1].toFixed(2)}).`,
                  );
                }
              }
            }
          }
        }
      }
    },
    // Every trip from every desk: slow under a full parallel run, and over
    // 30 s for 21 Agents on a slower machine.
    120_000,
  );

  it("keeps the Agents at one spot apart", () => {
    for (const places of Object.values(idlePlaces)) {
      for (const [index, { at }] of places.entries()) {
        for (const other of places.slice(index + 1)) {
          expect(distance(at, other.at)).toBeGreaterThanOrEqual(0.6);
        }
      }
    }
  });

  it("stays in the chair for a doze, and steps aside to stretch", () => {
    const [, coder] = ids;
    const seat = seatOf(layout, defined(coder));
    const doze = defined(idleTrip(layout, defined(coder), activity("doze"), 0));
    expect(doze.path).toEqual([seat]);
    expect(doze.startsAt).toBe(0);
    expect(doze.duration).toBe(activity("doze").duration);
    expect(idlePose(doze, 1)).toMatchObject({
      position: seat,
      animation: "sleep",
      bubble: "zzz",
    });

    const stretch = defined(
      idleTrip(layout, defined(coder), activity("stretch"), 0),
    );
    expect(stretch.path).toHaveLength(2);
    expect(stretch.length).toBeCloseTo(stepAside, 6);
    expect(stretch.placeHeading).toBe(stretch.seatHeading);
    expect(idlePose(stretch, stretch.startsAt + 1).animation).toBe("stretch");
  });

  it("stands up, walks there, plays its activity, walks back and sits down", () => {
    const [, coder] = ids;
    const seat = seatOf(layout, defined(coder));
    const trip = defined(
      idleTrip(layout, defined(coder), activity("coffee"), 0),
    );
    const there = defined(trip.path.at(-1));
    const walking = trip.length / walkSpeed;
    expect(trip.startsAt).toBeCloseTo(walkSeconds.standUp + walking, 6);
    expect(trip.endsAt).toBeCloseTo(
      trip.startsAt + activity("coffee").duration,
      6,
    );
    expect(trip.duration).toBeCloseTo(
      trip.endsAt + walking + walkSeconds.sitDown,
      6,
    );
    expect(idlePose(trip, 0.5)).toMatchObject({
      position: seat,
      animation: "stand-up",
    });
    const going = idlePose(trip, walkSeconds.standUp + walking / 2);
    expect(going.animation).toBe("walk");
    expect(distance(going.position, seat)).toBeGreaterThan(0.3);
    const drinking = idlePose(trip, trip.startsAt + 1);
    expect(drinking).toMatchObject({
      position: there,
      heading: trip.placeHeading,
      animation: "drink",
      bubble: undefined,
    });
    expect(idlePose(trip, trip.endsAt + walking / 2).animation).toBe("walk");
    expect(idlePose(trip, trip.duration - 0.5)).toMatchObject({
      position: seat,
      heading: trip.seatHeading,
      animation: "sit-down",
    });
  });

  it("is none for an Agent with no desk on the Floor", () => {
    expect(idleTrip(layout, "someone else", activity("coffee"), 0)).toBe(
      undefined,
    );
  });
});

describe("idling", () => {
  it("sits for a rest first, then goes off on an activity", () => {
    const [, coder] = ids;
    const states = allIn([defined(coder)], "idle");
    const random = sequence(0.5);
    const rest = restSeconds.min + 0.5 * (restSeconds.max - restSeconds.min);
    let agents = advanceIdle(new Map(), 0, states, plan, random);
    agents = run(agents, rest - 1, states, random);
    expect(agents.get(defined(coder))?.doing).toBeUndefined();
    agents = run(agents, 1.2, states, random);
    expect(agents.get(defined(coder))?.doing).toBeDefined();
  });

  it("stretches first once it has finished its work, before anything else", () => {
    const [, coder] = ids;
    const id = defined(coder);
    let agents = advanceIdle(
      new Map(),
      0,
      allIn([id], "working"),
      plan,
      sequence(0.5),
    );
    agents = advanceIdle(agents, 0.1, allIn([id], "idle"), plan, sequence(0.5));
    expect(agents.get(id)?.doing?.trip.activity.name).toBe("stretch");
    // And only once: after it, a rest, then the others.
    agents = run(agents, 20, allIn([id], "idle"), sequence(0.5));
    expect(agents.get(id)?.doing).toBeUndefined();
    expect(agents.get(id)?.finished).toBe(false);
  });

  it("dozes only after a long idle", () => {
    const [, coder] = ids;
    const id = defined(coder);
    const states = allIn([id], "idle");
    // Always the last open activity: the doze, once it may be chosen.
    const random = sequence(0, 0.9999);
    let agents = advanceIdle(new Map(), 0, states, plan, random, prdFive);
    const chosen: string[] = [];
    for (let second = 0; second < longIdleSeconds + 80; second += 0.5) {
      agents = advanceIdle(agents, 0.5, states, plan, random, prdFive);
      const name = agents.get(id)?.doing?.trip.activity.name;
      if (name !== undefined && chosen.at(-1) !== name) {
        chosen.push(name);
      }
      if (name === "doze") {
        expect(agents.get(id)?.idleFor).toBeGreaterThanOrEqual(longIdleSeconds);
      }
    }
    expect(chosen).toContain("water-cooler chat");
    expect(chosen.at(-1)).toBe("doze");
  });
});

describe("a Floor's Agents at the start", () => {
  it("are every one seated at its desk, whatever its state, and rest there before any activity", () => {
    for (const state of ["idle", "working", "busy"] as const) {
      const behaviours = createIdleBehaviours(sequence(0));
      const states = allIn(ids, state);
      behaviours.advance(0, states, plan);
      for (const id of ids) {
        expect(behaviours.poseOf(id), `${id} ${state}`).toBeUndefined();
      }
      for (let second = 0; second < restSeconds.min - 0.5; second += 0.5) {
        behaviours.advance(0.5, states, plan);
      }
      for (const id of ids) {
        expect(behaviours.poseOf(id), `${id} ${state}`).toBeUndefined();
      }
    }
  });

  it("seat an Agent that joins at its new desk, not taken off to a game at once", () => {
    const [, first, second] = ids.map(defined);
    const tennis = [activity("table tennis")];
    const random = sequence(0);
    // The first idles alone, its rests the shortest: no one to play with
    // at the end of its first, and its second about to end.
    const alone = allIn([defined(first)], "idle");
    let agents = advanceIdle(new Map(), 0, alone, plan, random, tennis);
    agents = run(agents, 2 * restSeconds.min - 1, alone, random, tennis);
    expect(agents.get(defined(first))?.doing).toBeUndefined();
    // The second joins just before: the first's next try finds it still
    // settling in, so neither goes.
    const both = allIn([defined(first), defined(second)], "idle");
    agents = advanceIdle(agents, 0, both, plan, random, tennis);
    agents = run(agents, 2, both, random, tennis);
    expect(agents.get(defined(first))?.doing).toBeUndefined();
    expect(agents.get(defined(second))?.doing).toBeUndefined();
    // Settled in, it is a partner for the next game.
    agents = run(agents, restSeconds.min + 1, both, random, tennis);
    expect(agents.get(defined(second))?.doing?.trip.activity.name).toBe(
      "table tennis",
    );
  });
});

describe("a game for two or more", () => {
  const games = idleActivities.filter(({ together }) => (together ?? 1) > 1);

  it("is table tennis, darts, foosball (for four too), pool, chess and more, each with room and places for its players", () => {
    const names = games.map(({ name }) => name);
    for (const name of [
      "table tennis",
      "darts",
      "foosball",
      "foosball doubles",
      "pool",
      "chess",
    ]) {
      expect(names, name).toContain(name);
    }
    expect(activity("foosball doubles").together).toBe(4);
    for (const each of games) {
      const players = each.together ?? 1;
      expect(each.occupancy, each.name).toBeGreaterThanOrEqual(players);
      if (each.location !== "chair" && each.location !== "beside the desk") {
        expect(idlePlaces[each.location].length).toBeGreaterThanOrEqual(
          players,
        );
      }
    }
  });

  /** Two idle Agents, the first choosing table tennis once its rest is over. */
  function rally() {
    const [, first, second] = ids.map(defined);
    const pair = [defined(first), defined(second)] as const;
    const states = allIn(pair, "idle");
    const random = sequence(0);
    const tennis = [activity("table tennis")];
    let agents = advanceIdle(new Map(), 0, states, plan, random, tennis);
    agents = run(agents, restSeconds.min + 0.2, states, random, tennis);
    return { pair, states, random, tennis, agents };
  }

  it("sets off with its partner, each to its own end, and begins once both are there", () => {
    const { pair, agents } = rally();
    const [one, two] = pair.map((id) => defined(agents.get(id)?.doing));
    expect(one?.trip.activity.name).toBe("table tennis");
    expect(two?.trip.activity.name).toBe("table tennis");
    expect(new Set([one?.trip.place, two?.trip.place])).toEqual(
      new Set([0, 1]),
    );
    expect(one?.partners).toEqual([pair[1]]);
    expect(two?.partners).toEqual([pair[0]]);
    const [a, b] = [defined(one).trip, defined(two).trip];
    expect(a.startsAt).toBeCloseTo(b.startsAt, 6);
    expect(a.endsAt).toBeCloseTo(b.endsAt, 6);
    expect(a.startsAt).toBeCloseTo(Math.max(a.arrivesAt, b.arrivesAt), 6);
    // The first there waits, standing at its end, with no bubble yet.
    const [early] = [a, b].sort((x, y) => x.arrivesAt - y.arrivesAt);
    const waiting = defined(early);
    if (waiting.arrivesAt < waiting.startsAt) {
      expect(
        idlePose(waiting, (waiting.arrivesAt + waiting.startsAt) / 2),
      ).toMatchObject({ animation: "idle", bubble: undefined });
    }
    // Then they swing, out of step: the far end half a loop behind.
    const playing = idlePose(a, a.startsAt + 1);
    expect(playing.animation).toBe("swing");
    expect(playing.bubble).toBe("🏓");
    const far = a.place === 1 ? a : b;
    expect(idlePose(far, far.startsAt + 1).phase).toBe(0.5);
  });

  it("is reported as played at its places, for the ball", () => {
    const behaviours = createIdleBehaviours(sequence(0), [
      activity("table tennis"),
    ]);
    const [, first, second] = ids.map(defined);
    const states = allIn([defined(first), defined(second)], "idle");
    let seen = false;
    for (let second = 0; second < 120 && !seen; second += 0.1) {
      behaviours.advance(0.1, states, plan);
      const players = behaviours.playing("table-tennis");
      if (players.size === 2) {
        seen = true;
        const [zero, one] = [players.get(0), players.get(1)];
        expect(zero?.activity).toBe("table tennis");
        expect(zero?.seconds).toBeCloseTo(one?.seconds ?? NaN, 6);
      }
    }
    expect(seen).toBe(true);
  });

  it("is never played alone: with no partner free, it is not chosen", () => {
    const [, first, second] = ids.map(defined);
    const states = new Map([
      [defined(first), "idle" as const],
      [defined(second), "working" as const],
    ]);
    const random = sequence(0);
    const tennis = [activity("table tennis")];
    let agents = advanceIdle(new Map(), 0, states, plan, random, tennis);
    agents = run(agents, restSeconds.max * 3, states, random, tennis);
    expect(agents.get(defined(first))?.doing).toBeUndefined();
  });

  it("is called off for its partner when one is called away: it heads back from where it is", () => {
    const game = rally();
    const { pair, random, tennis } = game;
    let { agents } = game;
    const trip = defined(agents.get(pair[0])?.doing).trip;
    agents = run(agents, trip.startsAt + 2, game.states, random, tennis);
    const before = defined(agents.get(pair[1])?.doing);
    expect(idlePose(before.trip, before.elapsed).animation).toBe("swing");
    const called = new Map([
      [pair[0], "working" as const],
      [pair[1], "idle" as const],
    ]);
    agents = advanceIdle(agents, 0, called, plan, random, tennis);
    expect(agents.get(pair[0])?.doing).toBeUndefined();
    const after = defined(agents.get(pair[1])?.doing);
    expect(after.partners).toBeUndefined();
    expect(after.elapsed).toBeCloseTo(after.trip.endsAt, 6);
    // On its way back the moment it can be.
    expect(idlePose(after.trip, after.elapsed + 0.1).animation).toBe("walk");
  });

  it("turns a partner walking there round where it is", () => {
    const [, coder] = ids;
    const trip = defined(plan(defined(coder), activity("pool"), 1));
    const halfway = walkSeconds.standUp + trip.length / walkSpeed / 2;
    const going = idlePose(trip, halfway);
    const back = calledOff(trip, halfway);
    const coming = idlePose(trip, back);
    expect(distance(coming.position, going.position)).toBeLessThan(1e-6);
    expect(coming.animation).toBe("walk");
    // Once at its place, or done, it heads back, or carries on back.
    expect(calledOff(trip, trip.startsAt + 1)).toBe(trip.endsAt);
    expect(calledOff(trip, trip.endsAt + 1)).toBe(trip.endsAt + 1);
  });

  it("starts together and so ends together: a later start moves its end", () => {
    const [, coder] = ids;
    const trip = defined(plan(defined(coder), activity("chess"), 0));
    const later = startingAt(trip, trip.arrivesAt + 5);
    expect(later.startsAt).toBeCloseTo(trip.startsAt + 5, 6);
    expect(later.endsAt).toBeCloseTo(trip.endsAt + 5, 6);
    expect(later.duration).toBeCloseTo(trip.duration + 5, 6);
    // Never before it gets there.
    expect(startingAt(trip, 0).startsAt).toBe(trip.arrivesAt);
  });

  it("takes four to foosball doubles, one at each handle", () => {
    const four = ids.slice(1, 5);
    const states = allIn(four, "idle");
    const random = sequence(0);
    const doubles = [activity("foosball doubles")];
    let agents = advanceIdle(new Map(), 0, states, plan, random, doubles);
    agents = run(agents, restSeconds.min + 0.2, states, random, doubles);
    const places = four.map((id) => agents.get(id)?.doing?.trip.place);
    expect(new Set(places)).toEqual(new Set([0, 1, 2, 3]));
    for (const id of four) {
      expect(agents.get(id)?.doing?.partners).toHaveLength(3);
    }
  });
});

describe("the games hall", () => {
  const hallLocations = (
    Object.keys(idlePlaces) as (keyof typeof idlePlaces)[]
  ).filter((location) => idlePlaces[location].some(({ inHall }) => inHall));

  it("has its amenities' places from its walkway, which moves forwards once a large team's desks reach it", () => {
    // The games, and none of the gym, which stays where it is.
    expect([...hallLocations].sort()).toEqual(
      [
        "foosball",
        "pool-table",
        "table-tennis",
        "chess-table",
        "bean-bags",
        "basketball",
        "putting-green",
        "piano",
        "arcade",
        "vending-machine",
      ].sort(),
    );
    const small = floorLayout(team(6));
    const large = floorLayout(team(26));
    const shift =
      defined(idlePlaceOn(large.waypoints, "pool-table", 0)).at[1] -
      defined(idlePlaceOn(small.waypoints, "pool-table", 0)).at[1];
    expect(shift).toBeGreaterThan(1);
    for (const location of hallLocations) {
      for (const floor of [small, large]) {
        idlePlaces[location].forEach((_, index) => {
          const { at } = defined(idlePlaceOn(floor.waypoints, location, index));
          expect(at[1]).toBeGreaterThan(
            Math.max(...floor.desks.map(({ footprint }) => footprint.z[1])),
          );
          expect(at[1]).toBeLessThan(floor.bounds.z[1]);
        });
      }
    }
  });
});

describe("each spot's occupancy limit", () => {
  const coffeeOnly = [activity("coffee")];

  it("lets no more Agents in than it holds, each at a place of its own", () => {
    const states = allIn(ids, "idle");
    const random = sequence(0);
    let agents = advanceIdle(new Map(), 0, states, plan, random, coffeeOnly);
    agents = run(agents, restSeconds.min + 0.2, states, random, coffeeOnly);
    const there = [...agents.values()].flatMap(({ doing }) =>
      doing === undefined ? [] : [doing.trip.place],
    );
    expect(there).toHaveLength(activity("coffee").occupancy);
    expect(new Set(there).size).toBe(there.length);
  });

  it("counts every Agent at the spot, whatever it is doing there", () => {
    const [first, second, third] = [0, 1, 2].map((index) =>
      defined(ids[index]),
    ) as [string, string, string];
    const chat = activity("water-cooler chat");
    const gossip: IdleActivity = {
      ...chat,
      name: "gossip",
      animation: "idle",
      occupancy: 2,
    };
    const states = allIn([first, second, third], "idle");
    const random = sequence(0);
    // Two chatting at the cooler; the third, wanting to gossip there,
    // finds it full, and the chat (room for three) is not on offer.
    let agents = advanceIdle(new Map(), 0, states, plan, random, [chat]);
    agents = run(
      agents,
      restSeconds.min + 0.2,
      allIn([first, second], "idle"),
      random,
      [chat],
    );
    agents = run(agents, restSeconds.min + 0.2, states, random, [gossip]);
    expect(agents.get(third)?.doing).toBeUndefined();
    expect(agents.get(first)?.doing?.trip.activity.name).toBe(
      "water-cooler chat",
    );
  });

  it("frees its place as soon as an Agent leaves it, for the next to take", () => {
    const states = allIn(ids, "idle");
    const random = sequence(0);
    let agents = advanceIdle(new Map(), 0, states, plan, random, coffeeOnly);
    agents = run(agents, restSeconds.min + 0.2, states, random, coffeeOnly);
    const [leaving] =
      [...agents].find(([, { doing }]) => doing?.trip.place === 0) ?? [];
    const busy = new Map(states);
    busy.set(defined(leaving), "working");
    agents = advanceIdle(agents, 0.1, busy, plan, random, coffeeOnly);
    const at = (now: IdleAgents) =>
      [...now.values()].flatMap(({ doing }) =>
        doing === undefined ? [] : [doing.trip.place],
      );
    expect(at(agents)).toEqual([1]);
    // Those turned away rested; the first whose rest is over takes place 0,
    // while the other is still at the machine.
    agents = run(agents, restSeconds.min, busy, random, coffeeOnly);
    const places = [...agents]
      .filter(([id]) => id !== leaving)
      .flatMap(([, { doing }]) =>
        doing === undefined ? [] : [doing.trip.place],
      )
      .sort();
    expect(places).toEqual([0, 1]);
  });

  it("never limits an Agent's own chair or desk", () => {
    const states = allIn(ids, "idle");
    const random = sequence(0);
    const stretch = { ...activity("stretch"), when: "idle" as const };
    let agents = advanceIdle(new Map(), 0, states, plan, random, [stretch]);
    agents = run(agents, restSeconds.min + 0.2, states, random, [stretch]);
    expect(
      [...agents.values()].filter(({ doing }) => doing !== undefined),
    ).toHaveLength(ids.length);
  });
});

describe("a new task", () => {
  const [, coder] = ids;
  const id = defined(coder);

  /** The coder on its way to the coffee machine, `seconds` into the trip. */
  function onTrip(seconds: number): { agents: IdleAgents; trip: IdleTrip } {
    const states = allIn([id], "idle");
    const random = sequence(0);
    let agents = advanceIdle(new Map(), 0, states, plan, random, [
      activity("coffee"),
    ]);
    agents = run(agents, restSeconds.min + 0.05, states, random, [
      activity("coffee"),
    ]);
    agents = run(agents, seconds, states, random, [activity("coffee")]);
    return { agents, trip: defined(agents.get(id)?.doing?.trip) };
  }

  it.each([
    ["standing up", () => 0.5, "stand-up"],
    ["walking there", () => walkSeconds.standUp + 1, "walk"],
    ["at the coffee machine", (trip: IdleTrip) => trip.startsAt + 1, "drink"],
    ["walking back", (trip: IdleTrip) => trip.endsAt + 1, "walk"],
  ] as const)(
    "brings the Agent back to its chair at once while it is %s",
    (_phase, when, animation) => {
      const coffee = defined(plan(id, activity("coffee"), 0));
      const { agents } = onTrip(when(coffee));
      const doing = defined(agents.get(id)?.doing);
      expect(idlePose(doing.trip, doing.elapsed).animation).toBe(animation);
      for (const state of ["working", "busy"] as const) {
        // No time passes: the same instant.
        const after = advanceIdle(
          agents,
          0,
          allIn([id], state),
          plan,
          sequence(0),
        );
        expect(after.get(id)?.doing).toBeUndefined();
      }
    },
  );

  it('wakes a dozing Agent, and its "zzz" goes', () => {
    const behaviours = createIdleBehaviours(sequence(0.9999), prdFive);
    const states = allIn([id], "idle");
    for (let second = 0; second < longIdleSeconds + 120; second += 0.5) {
      behaviours.advance(0.5, states, plan);
      if (behaviours.bubbles().size > 0) {
        break;
      }
    }
    expect(behaviours.bubbles().get(id)).toBe("zzz");
    expect(behaviours.poseOf(id)?.animation).toBe("sleep");
    behaviours.advance(0, allIn([id], "working"), plan);
    expect(behaviours.poseOf(id)).toBeUndefined();
    expect(behaviours.bubbles().size).toBe(0);
  });

  it("is never kept waiting: once interrupted, the Agent has no activity until it is idle again", () => {
    const { agents } = onTrip(15);
    let after = advanceIdle(
      agents,
      0,
      allIn([id], "working"),
      plan,
      sequence(0),
    );
    after = run(after, 120, allIn([id], "working"), sequence(0));
    expect(after.get(id)?.doing).toBeUndefined();
    expect(after.get(id)?.idleFor).toBe(0);
    // Its work done, it stretches.
    after = advanceIdle(after, 0.1, allIn([id], "idle"), plan, sequence(0));
    expect(after.get(id)?.doing?.trip.activity.name).toBe("stretch");
  });

  it("stops every activity with reduced motion", () => {
    const behaviours = createIdleBehaviours(sequence(0));
    const states = allIn(ids, "idle");
    for (let second = 0; second < restSeconds.min + 1; second += 0.5) {
      behaviours.advance(0.5, states, plan);
    }
    expect(ids.some((each) => behaviours.poseOf(each) !== undefined)).toBe(
      true,
    );
    behaviours.stopAll();
    expect(ids.every((each) => behaviours.poseOf(each) === undefined)).toBe(
      true,
    );
  });

  it("called back by the Owner, an Agent walks back from its activity, then rests a full rest before it idles again", () => {
    const behaviours = createIdleBehaviours(sequence(0), [activity("coffee")]);
    const states = allIn([id], "idle");
    for (let second = 0; second < restSeconds.min + 8; second += 0.1) {
      behaviours.advance(0.1, states, plan);
    }
    expect(behaviours.wandering(id)).toBe(true);
    const away = defined(behaviours.poseOf(id));
    behaviours.recall(true);
    // On its way back, not wandering: it turns round where it is.
    expect(behaviours.wandering(id)).toBe(false);
    behaviours.advance(0.1, states, plan);
    const back = defined(behaviours.poseOf(id));
    expect(back.animation).toBe("walk");
    expect(distance(back.position, away.position)).toBeLessThan(0.2);
    // Back in its chair, walking all the way.
    for (
      let second = 0;
      second < 120 && behaviours.poseOf(id) !== undefined;
      second += 0.1
    ) {
      expect(behaviours.poseOf(id)?.animation).toMatch(/^(walk|sit-down)$/);
      behaviours.advance(0.1, states, plan);
    }
    expect(behaviours.poseOf(id)).toBeUndefined();
    // A full rest, from back in its chair: the shortest rest would have
    // had it up again by now.
    for (let second = 0; second < restSeconds.max - 1; second += 0.1) {
      behaviours.advance(0.1, states, plan);
      expect(behaviours.poseOf(id)).toBeUndefined();
    }
    for (let second = 0; second < 2; second += 0.1) {
      behaviours.advance(0.1, states, plan);
    }
    expect(behaviours.wandering(id)).toBe(true);
  });

  it("called back with reduced motion, an Agent is in its chair at once", () => {
    const behaviours = createIdleBehaviours(sequence(0), [activity("coffee")]);
    const states = allIn([id], "idle");
    for (let second = 0; second < restSeconds.min + 8; second += 0.1) {
      behaviours.advance(0.1, states, plan);
    }
    behaviours.recall(false);
    expect(behaviours.poseOf(id)).toBeUndefined();
    expect(behaviours.wandering(id)).toBe(false);
  });

  it("forgets an Agent that has left the Floor", () => {
    const { agents } = onTrip(5);
    expect(advanceIdle(agents, 0.1, new Map(), plan, sequence(0)).size).toBe(0);
  });
});
