import type { AnimationName } from "./avatar-animations.ts";
import {
  headingAlong,
  lengthOf,
  pointAlong,
  walkSeconds,
  walkSpeed,
} from "./handoff-walks.ts";
import {
  entrance,
  lobbySize,
  lobbySofaSeat,
  lobbyWaterCooler,
  noticeBoardPosition,
  receptionSeat,
} from "./lobby-layout.ts";
import type { FloorPoint } from "./waypoints.ts";

// The lobby's people, as pure data and functions like the Floors' idle
// behaviours (idle-behaviours.ts), so they are tested without WebGL. The
// receptionist, who is the Communications Agent in its own name and
// Avatar (FR-96), sits behind the reception desk, greets the Owner as the
// Office opens, then mostly types, and now and then leans back, fetches a
// drink from the water cooler, stretches or reads the Notice Board. Now and
// then a visitor waits on the sofa: sitting, listening to music, dozing or
// fetching a drink, and after a while leaves by the entrance, to come back
// later. Each plays one routine after another, chosen at random.

/** Where one of the lobby's people is, which way they face, and what they play. */
export interface LobbyPose {
  readonly position: FloorPoint;
  readonly heading: number;
  readonly animation: AnimationName;
  /** Over their head while they hold it, such as "zzz". */
  readonly bubble: string | undefined;
}

/** One step of a routine: holding a pose, walking a path, or away. */
export type RoutineStep =
  | {
      readonly kind: "hold";
      readonly at: FloorPoint;
      readonly heading: number;
      readonly animation: AnimationName;
      readonly seconds: number;
      readonly bubble?: string;
    }
  | {
      readonly kind: "walk";
      readonly path: readonly FloorPoint[];
      readonly seconds: number;
    }
  | { readonly kind: "away"; readonly seconds: number };

/** What one of the lobby's people does next, step by step. */
export interface Routine {
  readonly name: string;
  readonly steps: readonly RoutineStep[];
  /** Seconds it takes, all its steps together. */
  readonly seconds: number;
}

const routine = (name: string, steps: readonly RoutineStep[]): Routine => ({
  name,
  steps,
  seconds: steps.reduce((sum, step) => sum + step.seconds, 0),
});

const hold = (
  at: FloorPoint,
  heading: number,
  animation: AnimationName,
  seconds: number,
  bubble?: string,
): RoutineStep => ({
  kind: "hold",
  at,
  heading,
  animation,
  seconds,
  ...(bubble === undefined ? {} : { bubble }),
});

const walking = (path: readonly FloorPoint[]): RoutineStep => ({
  kind: "walk",
  path,
  seconds: lengthOf(path) / walkSpeed,
});

const backwards = (path: readonly FloorPoint[]) => [...path].reverse();

/** Where a routine has them, `elapsed` seconds in; undefined while away. */
export function routinePose(
  { steps }: Routine,
  elapsed: number,
): LobbyPose | undefined {
  let left = Math.max(0, elapsed);
  let last: RoutineStep | undefined;
  for (const step of steps) {
    last = step;
    if (left < step.seconds) {
      return stepPose(step, left);
    }
    left -= step.seconds;
  }
  return last === undefined ? undefined : stepPose(last, last.seconds);
}

function stepPose(step: RoutineStep, elapsed: number): LobbyPose | undefined {
  switch (step.kind) {
    case "away":
      return undefined;
    case "hold":
      return {
        position: step.at,
        heading: step.heading,
        animation: step.animation,
        bubble: step.bubble,
      };
    case "walk": {
      const along = Math.min(elapsed * walkSpeed, lengthOf(step.path));
      return {
        position: pointAlong(step.path, along),
        heading: headingAlong(step.path, along),
        animation: "walk",
        bubble: undefined,
      };
    }
  }
}

/** Seconds between `min` and `max`, at random. */
const between = (random: () => number, min: number, max: number) =>
  min + (max - min) * random();

/** One of `choices`, each as likely as its weight. */
function pick<T>(
  random: () => number,
  choices: readonly (readonly [weight: number, value: T])[],
): T {
  const total = choices.reduce((sum, [weight]) => sum + weight, 0);
  let left = random() * total;
  for (const [weight, value] of choices) {
    left -= weight;
    if (left < 0) {
      return value;
    }
  }
  const last = choices.at(-1);
  if (last === undefined) {
    throw new Error("Nothing to pick from.");
  }
  return last[1];
}

/** Faces +z, as an Avatar does unturned: towards the front of the lobby. */
const facingFront = 0;
/** Faces -z: towards the back wall. */
const facingBack = Math.PI;

// The receptionist's places: their chair, beside the desk's right end (clear
// of it), at the water cooler and before the Notice Board.
const seat: FloorPoint = receptionSeat;
const besideDesk: FloorPoint = [receptionSeat[0] + 1.7, receptionSeat[1]];
const atCooler: FloorPoint = [
  lobbyWaterCooler[0] - 0.3,
  lobbyWaterCooler[1] + 0.55,
];
const atBoard: FloorPoint = [
  noticeBoardPosition[0],
  noticeBoardPosition[2] + 1.2,
];

const getUp = () => hold(seat, facingFront, "stand-up", walkSeconds.standUp);
const sitDown = () => hold(seat, facingFront, "sit-down", walkSeconds.sitDown);

/** How long the receptionist greets the Owner as the Office opens. */
export const greetingSeconds = 8;

/** The receptionist's first routine: at the desk, greeting the Owner. */
export const receptionistGreeting: Routine = routine("greet", [
  hold(seat, facingFront, "sit", greetingSeconds),
]);

/**
 * The receptionist's first routine when the lobby opens without a
 * greeting: seated at the desk, typing or leaning back, so they are never
 * seen getting up or walking as the lobby comes into view.
 */
export function receptionistFirstRoutine(random: () => number): Routine {
  return random() < 0.75
    ? routine("type", [
        hold(seat, facingFront, "type", between(random, 15, 40)),
      ])
    : routine("lean back", [
        hold(seat, facingFront, "wait", between(random, 6, 12)),
      ]);
}

/** The receptionist's next routine, chosen at random. */
export function receptionistRoutine(random: () => number): Routine {
  const out = (to: FloorPoint) => [seat, besideDesk, to];
  return pick<() => Routine>(random, [
    [
      6,
      () =>
        routine("type", [
          hold(seat, facingFront, "type", between(random, 15, 40)),
        ]),
    ],
    [
      2,
      () =>
        routine("lean back", [
          hold(seat, facingFront, "wait", between(random, 6, 12)),
        ]),
    ],
    [
      2,
      () =>
        routine("water cooler", [
          getUp(),
          walking(out(atCooler)),
          hold(atCooler, facingBack, "drink", between(random, 8, 14)),
          walking(backwards(out(atCooler))),
          sitDown(),
        ]),
    ],
    [
      1,
      () =>
        routine("stretch", [
          getUp(),
          walking([seat, besideDesk]),
          hold(besideDesk, facingFront, "stretch", 6.4),
          walking([besideDesk, seat]),
          sitDown(),
        ]),
    ],
    [
      1,
      () =>
        routine("notice board", [
          getUp(),
          walking(out(atBoard)),
          hold(atBoard, facingBack, "idle", between(random, 6, 10)),
          walking(backwards(out(atBoard))),
          sitDown(),
        ]),
    ],
  ])();
}

// The visitor's places: on the sofa by the front, just in front of it, at
// the water cooler beside the receptionist's spot, and the entrance.
const sofa: FloorPoint = lobbySofaSeat;
const offSofa: FloorPoint = [lobbySofaSeat[0], lobbySofaSeat[1] - 0.7];
const visitorAtCooler: FloorPoint = [
  lobbyWaterCooler[0] + 0.3,
  lobbyWaterCooler[1] + 0.55,
];
const door: FloorPoint = [
  -lobbySize.width / 2,
  (entrance.z[0] + entrance.z[1]) / 2,
];
const inside: FloorPoint = [door[0] + 1.2, door[1]];
const sofaFromDoor: readonly FloorPoint[] = [
  door,
  inside,
  [offSofa[0], inside[1]],
  offSofa,
  sofa,
];

/** The visitor, on the sofa, does one thing; or gets up and leaves. */
export function visitorRoutine(random: () => number): Routine {
  const standUp = hold(sofa, facingBack, "stand-up", walkSeconds.standUp);
  const sitBack = hold(sofa, facingBack, "sit-down", walkSeconds.sitDown);
  const toCooler = [sofa, offSofa, visitorAtCooler];
  return pick<() => Routine>(random, [
    [
      4,
      () =>
        routine("sit", [
          hold(sofa, facingBack, "sit", between(random, 10, 25)),
        ]),
    ],
    [
      3,
      () =>
        routine("music", [
          hold(sofa, facingBack, "wait", between(random, 10, 20), "♪"),
        ]),
    ],
    [
      2,
      () =>
        routine("doze", [
          hold(sofa, facingBack, "sleep", between(random, 15, 30), "zzz"),
        ]),
    ],
    [
      2,
      () =>
        routine("water cooler", [
          standUp,
          walking(toCooler),
          hold(visitorAtCooler, facingBack, "drink", between(random, 8, 14)),
          walking(backwards(toCooler)),
          sitBack,
        ]),
    ],
    [
      1,
      () =>
        routine("stretch", [
          standUp,
          walking([sofa, offSofa]),
          hold(offSofa, facingBack, "stretch", 6.4),
          walking([offSofa, sofa]),
          sitBack,
        ]),
    ],
    [1, () => visitorLeaves(random)],
  ])();
}

/** The visitor leaves by the entrance, stays away a while and comes back. */
export function visitorLeaves(random: () => number): Routine {
  return routine("leave", [
    hold(sofa, facingBack, "stand-up", walkSeconds.standUp),
    walking(backwards(sofaFromDoor)),
    { kind: "away", seconds: between(random, 60, 180) },
    walking(sofaFromDoor),
    hold(sofa, facingBack, "sit-down", walkSeconds.sitDown),
  ]);
}

/** As the lobby opens: on the sofa already, seated, a while before anything else. */
export function visitorFirstRoutine(random: () => number): Routine {
  return routine("sit", [
    hold(sofa, facingBack, "sit", between(random, 5, 15)),
  ]);
}

/** One of the lobby's people, playing one routine after another. */
export interface LobbyPerson {
  /** Moves them on by a frame's `seconds`. */
  advance(seconds: number): void;
  /** Where they are; undefined while away. */
  pose(): LobbyPose | undefined;
  /** The routine under way. */
  routine(): Routine;
}

/** Someone who starts with `first`, then takes each next routine from `next`. */
export function createLobbyPerson(
  first: Routine,
  next: () => Routine,
): LobbyPerson {
  let current = first;
  let elapsed = 0;
  return {
    advance(seconds) {
      elapsed += Math.max(0, seconds);
      // A long frame (a hidden tab) may end more than one routine.
      for (let guard = 0; elapsed >= current.seconds && guard < 100; guard++) {
        elapsed -= current.seconds;
        current = next();
      }
    },
    pose: () => routinePose(current, elapsed),
    routine: () => current,
  };
}

/** The lobby's people as reduced motion shows them: still, in their places. */
export const stillPoses = {
  receptionist: {
    position: seat,
    heading: facingFront,
    animation: "type",
    bubble: undefined,
  },
  visitor: {
    position: sofa,
    heading: facingBack,
    animation: "sit",
    bubble: undefined,
  },
} as const satisfies Record<string, LobbyPose>;
