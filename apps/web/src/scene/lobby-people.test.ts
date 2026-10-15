import { describe, expect, it } from "vitest";

import {
  createLobbyPerson,
  greetingSeconds,
  receptionistFirstRoutine,
  receptionistGreeting,
  receptionistRoutine,
  routinePose,
  stillPoses,
  visitorFirstRoutine,
  visitorLeaves,
  visitorRoutine,
  type Routine,
} from "./lobby-people.ts";
import { lobbySofaSeat, receptionSeat } from "./lobby-layout.ts";

/** A random source that gives `values` in turn, then repeats the last. */
const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
};

/** The routine named `name`; it must be one of them. */
function named(routines: ReadonlyMap<string, Routine>, name: string): Routine {
  const found = routines.get(name);
  if (found === undefined) {
    throw new Error(`There is no "${name}" routine.`);
  }
  return found;
}

/** Every routine `make` can give, by name, sampled across its choices. */
function routinesOf(make: (random: () => number) => Routine) {
  const found = new Map<string, Routine>();
  for (let pick = 0; pick < 1; pick += 0.01) {
    const routine = make(sequence(pick, 0.5));
    found.set(routine.name, routine);
  }
  return found;
}

describe("the receptionist", () => {
  it("greets the Owner from the desk first", () => {
    expect(receptionistGreeting.seconds).toBe(greetingSeconds);
    expect(routinePose(receptionistGreeting, 1)).toMatchObject({
      position: receptionSeat,
      animation: "sit",
    });
  });

  it("types, leans back, fetches water, stretches and reads the Notice Board", () => {
    const routines = routinesOf(receptionistRoutine);
    expect([...routines.keys()].sort()).toEqual([
      "lean back",
      "notice board",
      "stretch",
      "type",
      "water cooler",
    ]);
    expect(routinePose(named(routines, "type"), 3)?.animation).toBe("type");
  });

  it("walks to the water cooler, drinks, and comes back to sit down", () => {
    const trip = named(routinesOf(receptionistRoutine), "water cooler");
    const animations = new Set<string>();
    for (let at = 0; at < trip.seconds; at += 0.1) {
      const pose = routinePose(trip, at);
      if (pose !== undefined) {
        animations.add(pose.animation);
      }
    }
    expect([...animations]).toEqual(["stand-up", "walk", "drink", "sit-down"]);
    expect(routinePose(trip, trip.seconds)?.position).toEqual(receptionSeat);
  });
});

describe("the receptionist, as the lobby opens again", () => {
  it("is seated at the desk throughout the first routine, never getting up", () => {
    for (const roll of [0, 0.5, 0.8, 0.99]) {
      const first = receptionistFirstRoutine(sequence(roll));
      for (const at of [0, first.seconds / 2, first.seconds - 0.01]) {
        const pose = routinePose(first, at);
        expect(pose?.position).toEqual(receptionSeat);
        expect(["type", "wait"]).toContain(pose?.animation);
      }
    }
  });
});

describe("the visitor", () => {
  it("is seated on the sofa as the lobby opens, whatever the dice say", () => {
    for (const roll of [0, 0.1, 0.6, 0.9, 0.99]) {
      const first = visitorFirstRoutine(sequence(roll));
      for (const at of [0, first.seconds / 2]) {
        expect(routinePose(first, at)).toMatchObject({
          position: lobbySofaSeat,
          animation: "sit",
        });
      }
    }
  });

  it("sits, listens to music, dozes, fetches a drink, stretches or leaves", () => {
    const routines = routinesOf(visitorRoutine);
    expect([...routines.keys()].sort()).toEqual([
      "doze",
      "leave",
      "music",
      "sit",
      "stretch",
      "water cooler",
    ]);
    expect(routinePose(named(routines, "doze"), 1)?.bubble).toBe("zzz");
  });

  it("leaves by the entrance, is away a while, and comes back to the sofa", () => {
    const leave = visitorLeaves(sequence(0));
    const poses = Array.from(
      { length: Math.ceil(leave.seconds * 10) },
      (_, i) => routinePose(leave, i / 10),
    );
    expect(poses).toContain(undefined);
    expect(routinePose(leave, leave.seconds)?.position).toEqual(lobbySofaSeat);
  });
});

describe("a person in the lobby", () => {
  it("plays one routine after another", () => {
    const next = { name: "next", steps: [], seconds: 5 } as Routine;
    const person = createLobbyPerson(receptionistGreeting, () => next);
    expect(person.routine()).toBe(receptionistGreeting);
    person.advance(greetingSeconds - 1);
    expect(person.routine()).toBe(receptionistGreeting);
    person.advance(2);
    expect(person.routine()).toBe(next);
  });

  it("stays still in place with reduced motion", () => {
    expect(stillPoses.receptionist.position).toEqual(receptionSeat);
    expect(stillPoses.visitor.position).toEqual(lobbySofaSeat);
  });
});
