import type { AgentLook } from "./agent-state.ts";
import type { AnimationName } from "./avatar-animations.ts";
import { deskFacing } from "./desk-set.ts";
import type { FloorLayout, FloorSpot } from "./floor-layout.ts";
import {
  headingAlong,
  headingOf,
  onSegment,
  pointAlong,
  stepOff,
  walkSeconds,
  walkSpeed,
} from "./handoff-walks.ts";
import { distance, walk, type FloorPoint } from "./waypoints.ts";

// Idle behaviours in the Office (PRD FR-61), as data, so the scene only
// draws them. An Agent with nothing to do sits for a while, then plays a
// weighted-random activity: it stretches beside its desk once it has
// finished its work, fetches a coffee from the canteen, works out in the
// gym or chats at the water cooler, and after a long idle leans back in
// its chair with "zzz" over its head. Beyond the PRD's five there are
// dozens more: at its desk (a rubber duck, headphones, a phone call,
// juggling), in the canteen (tea, the microwave, the fridge, lunch at the
// café table, watering the plant), in the lounge (the sofa, the fish tank,
// darts), in the gym (yoga, kettlebells, the treadmill, weights, the
// punchbag, the yoga mats, the exercise bike and the rowing machine),
// round the Floor (the printer, the whiteboard, the wall board, the
// bookshelf) and in the games hall across the Floor's front (table
// tennis, foosball, pool, chess, the bean bags, basketball, putting, the
// piano, the vending machine and the arcade). A bubble over its head
// ("🏓", "📖") says what a pose alone cannot. Each activity is one entry
// in `idleActivities` (where, which animation, how long, how likely, how
// many at once and how many play it together), so a new one is one more
// entry. Each spot holds only so many Agents. A game for two (table
// tennis, darts, chess) sets off with its partners, who wait for each
// other at the table and play out of step, taking turns; when one is
// called away, the others stop too. A new task interrupts any activity at
// once: the Agent is back at its desk the moment it has work, so idling
// never delays work. Every Agent starts in its chair: a Floor's Agents
// sit at their desks when it loads, and one that joins sits at its new
// desk, each resting there before its first activity.

/**
 * Where an activity happens: in the Agent's own chair, standing beside
 * its own desk, or at one of the Floor's amenities.
 */
export type IdleLocation =
  | "chair"
  | "beside the desk"
  | Exclude<FloorSpot, "lift" | "managers-office" | "meeting-room">;

/** When an activity may be chosen. */
export type IdleWhen =
  /** Once, as the Agent becomes idle after working. */
  | "finished"
  /** Whenever the Agent has sat idle for a while. */
  | "idle"
  /** Only once the Agent has been idle for `longIdleSeconds`. */
  | "long idle";

export interface IdleActivity {
  readonly name: string;
  readonly when: IdleWhen;
  readonly location: IdleLocation;
  /** What the Agent plays there. */
  readonly animation: AnimationName;
  /** How long it plays it there, in seconds, not counting the walk. */
  readonly duration: number;
  /** How likely it is, against the others that may be chosen with it. */
  readonly weight: number;
  /**
   * How many Agents may be at its location at once, whatever they are
   * doing there. An Agent's own chair and desk are its alone.
   */
  readonly occupancy: number;
  /**
   * How many Agents play it together, setting off at once for its first
   * places: a game for two. Without it, one, alone.
   */
  readonly together?: number;
  /** Shown over the Agent's head while it is there, such as "zzz". */
  readonly bubble?: string;
}

/** The idle activities (PRD FR-61): the PRD's five first, then the rest. */
export const idleActivities: readonly IdleActivity[] = [
  {
    name: "stretch",
    when: "finished",
    location: "beside the desk",
    animation: "stretch",
    duration: 6.4,
    weight: 1,
    occupancy: 1,
  },
  {
    name: "coffee",
    when: "idle",
    location: "coffee-machine",
    animation: "drink",
    duration: 16,
    weight: 3,
    occupancy: 2,
  },
  {
    name: "workout",
    when: "idle",
    location: "gym",
    animation: "work-out",
    duration: 20,
    weight: 2,
    occupancy: 2,
  },
  {
    name: "water-cooler chat",
    when: "idle",
    location: "water-cooler",
    animation: "chat",
    duration: 18,
    weight: 3,
    occupancy: 3,
  },
  {
    name: "doze",
    when: "long idle",
    location: "chair",
    animation: "sleep",
    duration: 44,
    weight: 4,
    occupancy: 1,
    bubble: "zzz",
  },
  {
    name: "rubber-duck debugging",
    when: "idle",
    location: "chair",
    animation: "sit",
    duration: 14,
    weight: 2,
    occupancy: 1,
    bubble: "🦆",
  },
  {
    name: "music on headphones",
    when: "idle",
    location: "chair",
    animation: "wait",
    duration: 18,
    weight: 2,
    occupancy: 1,
    bubble: "🎧",
  },
  {
    name: "daydream",
    when: "idle",
    location: "chair",
    animation: "wait",
    duration: 12,
    weight: 2,
    occupancy: 1,
    bubble: "💭",
  },
  {
    name: "scroll the phone",
    when: "idle",
    location: "chair",
    animation: "sit",
    duration: 12,
    weight: 2,
    occupancy: 1,
    bubble: "📱",
  },
  {
    name: "snack at the desk",
    when: "idle",
    location: "chair",
    animation: "sit",
    duration: 12,
    weight: 1,
    occupancy: 1,
    bubble: "🍪",
  },
  {
    name: "phone call",
    when: "idle",
    location: "beside the desk",
    animation: "chat",
    duration: 16,
    weight: 2,
    occupancy: 1,
    bubble: "📞",
  },
  {
    name: "juggle",
    when: "idle",
    location: "beside the desk",
    animation: "hand-over",
    duration: 10,
    weight: 1,
    occupancy: 1,
    bubble: "🤹",
  },
  {
    name: "tidy the desk",
    when: "idle",
    location: "beside the desk",
    animation: "carry",
    duration: 10,
    weight: 1,
    occupancy: 1,
    bubble: "🧹",
  },
  {
    name: "air guitar",
    when: "idle",
    location: "beside the desk",
    animation: "chat",
    duration: 8,
    weight: 1,
    occupancy: 1,
    bubble: "🎸",
  },
  {
    name: "touch the toes",
    when: "idle",
    location: "beside the desk",
    animation: "stretch",
    duration: 6.4,
    weight: 1,
    occupancy: 1,
    bubble: "🙆",
  },
  {
    name: "espresso chat",
    when: "idle",
    location: "coffee-machine",
    animation: "chat",
    duration: 14,
    weight: 2,
    occupancy: 2,
    bubble: "☕",
  },
  {
    name: "make tea",
    when: "idle",
    location: "kettle",
    animation: "drink",
    duration: 16,
    weight: 2,
    occupancy: 1,
    bubble: "🍵",
  },
  {
    name: "heat up lunch",
    when: "idle",
    location: "microwave",
    animation: "idle",
    duration: 14,
    weight: 1,
    occupancy: 1,
    bubble: "⏲",
  },
  {
    name: "fridge raid",
    when: "idle",
    location: "fridge",
    animation: "idle",
    duration: 10,
    weight: 2,
    occupancy: 1,
    bubble: "🥪",
  },
  {
    name: "lunch at the café table",
    when: "idle",
    location: "cafe-table",
    animation: "sit",
    duration: 30,
    weight: 2,
    occupancy: 2,
    bubble: "🍝",
  },
  {
    name: "tea break",
    when: "idle",
    location: "cafe-table",
    animation: "sit",
    duration: 20,
    weight: 1,
    occupancy: 2,
    bubble: "🍵",
  },
  {
    name: "water the plant",
    when: "idle",
    location: "canteen-plant",
    animation: "hand-over",
    duration: 10,
    weight: 1,
    occupancy: 1,
    bubble: "💧",
  },
  {
    name: "refill a water bottle",
    when: "idle",
    location: "water-cooler",
    animation: "drink",
    duration: 10,
    weight: 2,
    occupancy: 3,
    bubble: "💧",
  },
  {
    name: "nap on the sofa",
    when: "long idle",
    location: "lounge-sofa",
    animation: "sleep",
    duration: 40,
    weight: 3,
    occupancy: 2,
    bubble: "zzz",
  },
  {
    name: "read on the sofa",
    when: "idle",
    location: "lounge-sofa",
    animation: "sit",
    duration: 24,
    weight: 2,
    occupancy: 2,
    bubble: "📖",
  },
  {
    name: "handheld game",
    when: "idle",
    location: "lounge-sofa",
    animation: "type",
    duration: 20,
    weight: 2,
    occupancy: 2,
    bubble: "🎮",
  },
  {
    name: "put the feet up",
    when: "idle",
    location: "lounge-sofa",
    animation: "wait",
    duration: 18,
    weight: 2,
    occupancy: 2,
    bubble: "😌",
  },
  {
    name: "feed the fish",
    when: "idle",
    location: "fish-tank",
    animation: "hand-over",
    duration: 10,
    weight: 2,
    occupancy: 1,
    bubble: "🐟",
  },
  {
    name: "watch the fish",
    when: "idle",
    location: "fish-tank",
    animation: "idle",
    duration: 14,
    weight: 1,
    occupancy: 1,
    bubble: "🐠",
  },
  {
    name: "darts",
    when: "idle",
    location: "darts",
    animation: "throw",
    duration: 24,
    weight: 2,
    occupancy: 2,
    together: 2,
    bubble: "🎯",
  },
  {
    name: "table tennis",
    when: "idle",
    location: "table-tennis",
    animation: "swing",
    duration: 28,
    weight: 3,
    occupancy: 2,
    together: 2,
    bubble: "🏓",
  },
  {
    name: "vending-machine snack",
    when: "idle",
    location: "vending-machine",
    animation: "idle",
    duration: 10,
    weight: 2,
    occupancy: 1,
    bubble: "🍫",
  },
  {
    name: "arcade game",
    when: "idle",
    location: "arcade",
    animation: "idle",
    duration: 20,
    weight: 2,
    occupancy: 1,
    bubble: "🕹",
  },
  {
    name: "yoga",
    when: "idle",
    location: "gym",
    animation: "stretch",
    duration: 16,
    weight: 2,
    occupancy: 2,
    bubble: "🧘",
  },
  {
    name: "skipping",
    when: "idle",
    location: "gym",
    animation: "work-out",
    duration: 14,
    weight: 1,
    occupancy: 2,
    bubble: "🏃",
  },
  {
    name: "kettlebell swings",
    when: "idle",
    location: "kettlebells",
    animation: "work-out",
    duration: 16,
    weight: 1,
    occupancy: 1,
    bubble: "🏋",
  },
  {
    name: "catch the breath",
    when: "idle",
    location: "weight-bench",
    animation: "sit",
    duration: 12,
    weight: 1,
    occupancy: 1,
    bubble: "💦",
  },
  {
    name: "collect the printouts",
    when: "idle",
    location: "printer",
    animation: "carry",
    duration: 10,
    weight: 2,
    occupancy: 1,
    bubble: "📄",
  },
  {
    name: "unjam the printer",
    when: "idle",
    location: "printer",
    animation: "idle",
    duration: 14,
    weight: 1,
    occupancy: 1,
    bubble: "🖨",
  },
  {
    name: "doodle on the whiteboard",
    when: "idle",
    location: "whiteboard",
    animation: "hand-over",
    duration: 16,
    weight: 2,
    occupancy: 2,
    bubble: "✏",
  },
  {
    name: "read the wall board",
    when: "idle",
    location: "wall-board",
    animation: "idle",
    duration: 12,
    weight: 2,
    occupancy: 2,
    bubble: "📌",
  },
  {
    name: "browse the bookshelf",
    when: "idle",
    location: "bookshelf",
    animation: "carry",
    duration: 14,
    weight: 2,
    occupancy: 1,
    bubble: "📚",
  },
  // At the desk, and the darts and the gym's treadmill.
  {
    name: "fly a paper plane",
    when: "idle",
    location: "beside the desk",
    animation: "throw",
    duration: 8,
    weight: 1,
    occupancy: 1,
    bubble: "✈",
  },
  {
    name: "do the crossword",
    when: "idle",
    location: "chair",
    animation: "sit",
    duration: 16,
    weight: 1,
    occupancy: 1,
    bubble: "📰",
  },
  {
    name: "darts practice",
    when: "idle",
    location: "darts",
    animation: "throw",
    duration: 14,
    weight: 1,
    occupancy: 2,
    bubble: "🎯",
  },
  {
    name: "jog on the treadmill",
    when: "idle",
    location: "treadmill",
    animation: "walk",
    duration: 20,
    weight: 2,
    occupancy: 1,
    bubble: "🏃",
  },
  // The games hall: foosball, pool, chess, the bean bags and their
  // television, basketball, the putting green and the piano.
  {
    name: "foosball",
    when: "idle",
    location: "foosball",
    animation: "foosball",
    duration: 26,
    weight: 3,
    occupancy: 4,
    together: 2,
    bubble: "⚽",
  },
  {
    name: "foosball doubles",
    when: "idle",
    location: "foosball",
    animation: "foosball",
    duration: 30,
    weight: 2,
    occupancy: 4,
    together: 4,
    bubble: "⚽",
  },
  {
    name: "pool",
    when: "idle",
    location: "pool-table",
    animation: "pool",
    duration: 36,
    weight: 3,
    occupancy: 2,
    together: 2,
    bubble: "🎱",
  },
  {
    name: "pool trick shots",
    when: "idle",
    location: "pool-table",
    animation: "pool",
    duration: 18,
    weight: 1,
    occupancy: 2,
    bubble: "🎱",
  },
  {
    name: "chess",
    when: "idle",
    location: "chess-table",
    animation: "sit",
    duration: 40,
    weight: 2,
    occupancy: 2,
    together: 2,
    bubble: "♟",
  },
  {
    name: "card game",
    when: "idle",
    location: "chess-table",
    animation: "sit",
    duration: 26,
    weight: 2,
    occupancy: 2,
    together: 2,
    bubble: "🃏",
  },
  {
    name: "jigsaw puzzle",
    when: "idle",
    location: "chess-table",
    animation: "sit",
    duration: 24,
    weight: 1,
    occupancy: 2,
    bubble: "🧩",
  },
  {
    name: "console game for two",
    when: "idle",
    location: "bean-bags",
    animation: "type",
    duration: 30,
    weight: 3,
    occupancy: 2,
    together: 2,
    bubble: "🎮",
  },
  {
    name: "watch the match together",
    when: "idle",
    location: "bean-bags",
    animation: "sit",
    duration: 30,
    weight: 1,
    occupancy: 2,
    together: 2,
    bubble: "📺",
  },
  {
    name: "watch a film",
    when: "idle",
    location: "bean-bags",
    animation: "sit",
    duration: 30,
    weight: 1,
    occupancy: 2,
    bubble: "🍿",
  },
  {
    name: "read on a bean bag",
    when: "idle",
    location: "bean-bags",
    animation: "sit",
    duration: 24,
    weight: 2,
    occupancy: 2,
    bubble: "📗",
  },
  {
    name: "strum the guitar",
    when: "idle",
    location: "bean-bags",
    animation: "sit",
    duration: 18,
    weight: 1,
    occupancy: 2,
    bubble: "🎸",
  },
  {
    name: "nap on a bean bag",
    when: "long idle",
    location: "bean-bags",
    animation: "sleep",
    duration: 40,
    weight: 2,
    occupancy: 2,
    bubble: "zzz",
  },
  {
    name: "shoot hoops",
    when: "idle",
    location: "basketball",
    animation: "shoot",
    duration: 18,
    weight: 2,
    occupancy: 2,
    bubble: "🏀",
  },
  {
    name: "game of horse",
    when: "idle",
    location: "basketball",
    animation: "shoot",
    duration: 26,
    weight: 2,
    occupancy: 2,
    together: 2,
    bubble: "🏀",
  },
  {
    name: "putting practice",
    when: "idle",
    location: "putting-green",
    animation: "putt",
    duration: 18,
    weight: 2,
    occupancy: 2,
    bubble: "⛳",
  },
  {
    name: "play the piano",
    when: "idle",
    location: "piano",
    animation: "type",
    duration: 20,
    weight: 2,
    occupancy: 2,
    bubble: "🎹",
  },
  {
    name: "piano duet",
    when: "idle",
    location: "piano",
    animation: "type",
    duration: 24,
    weight: 1,
    occupancy: 2,
    together: 2,
    bubble: "🎶",
  },
  // The rest of the gym: weights, the punchbag, the yoga mats, the
  // exercise bike and the rowing machine.
  {
    name: "dumbbell curls",
    when: "idle",
    location: "dumbbells",
    animation: "lift",
    duration: 16,
    weight: 2,
    occupancy: 2,
    bubble: "💪",
  },
  {
    name: "lift with a spotter",
    when: "idle",
    location: "dumbbells",
    animation: "lift",
    duration: 20,
    weight: 1,
    occupancy: 2,
    together: 2,
    bubble: "🏋",
  },
  {
    name: "punchbag",
    when: "idle",
    location: "punchbag",
    animation: "punch",
    duration: 14,
    weight: 2,
    occupancy: 1,
    bubble: "🥊",
  },
  {
    name: "sun salutations",
    when: "idle",
    location: "yoga-mats",
    animation: "stretch",
    duration: 16,
    weight: 2,
    occupancy: 2,
    bubble: "🌅",
  },
  {
    name: "meditate",
    when: "idle",
    location: "yoga-mats",
    animation: "idle",
    duration: 20,
    weight: 2,
    occupancy: 2,
    bubble: "🕉",
  },
  {
    name: "partner stretches",
    when: "idle",
    location: "yoga-mats",
    animation: "stretch",
    duration: 16,
    weight: 1,
    occupancy: 2,
    together: 2,
    bubble: "🤸",
  },
  {
    name: "exercise bike",
    when: "idle",
    location: "exercise-bike",
    animation: "pedal",
    duration: 20,
    weight: 2,
    occupancy: 1,
    bubble: "🚴",
  },
  {
    name: "rowing machine",
    when: "idle",
    location: "rowing-machine",
    animation: "row",
    duration: 20,
    weight: 2,
    occupancy: 1,
    bubble: "🚣",
  },
];

/** The places Agents sit at, rather than stand: their chairs and seats. */
export const seatedLocations: readonly IdleLocation[] = [
  "chair",
  "lounge-sofa",
  "cafe-table",
  "weight-bench",
  "chess-table",
  "bean-bags",
  "piano",
  "exercise-bike",
  "rowing-machine",
];

/** The places Agents step up onto, standing: the treadmill's belt. */
export const mountedLocations: readonly IdleLocation[] = ["treadmill"];

/** How long an idle Agent sits before its next activity: between these, at random. */
export const restSeconds = { min: 20, max: 60 } as const;

/**
 * How long an Agent is idle, once it finishes its work or joins the
 * Floor, before a partner may take it off to a game.
 */
export const settleSeconds = restSeconds.min / 2;

/** How long an Agent is idle before it may doze. */
export const longIdleSeconds = 180;

/** Where an Agent stands (or sits) at a spot, and which way it faces. */
export interface IdlePlace {
  readonly at: FloorPoint;
  readonly heading: number;
  /**
   * The points it walks through from the spot's waypoint first, to come
   * at it square or to go round a table to its far side.
   */
  readonly via?: readonly FloorPoint[];
  /**
   * How far through its animation's loop it plays there, as a share of
   * it: partners at a game play out of step, taking turns.
   */
  readonly phase?: number;
  /**
   * In the games hall, which moves forwards as the desks need room: its
   * z (and its way's) is from the hall's walkway, where its waypoint is.
   */
  readonly inHall?: boolean;
}

const facing = (at: FloorPoint, towards: FloorPoint): IdlePlace => ({
  at,
  heading: headingOf([towards[0] - at[0], towards[1] - at[1]]),
});

/** A place in the games hall, its z from the hall's walkway. */
const inHall = (
  at: FloorPoint,
  heading: number,
  more: Pick<IdlePlace, "via" | "phase"> = {},
): IdlePlace => ({ at, heading, inHall: true, ...more });

/** Round the water cooler, facing each other. */
const coolerCircle: FloorPoint = [-8.7, -1.15];

/**
 * Where Agents stand at each amenity, in the order they are taken: at the
 * canteen's counter, facing the coffee machine; on the gym's mat, facing
 * the open plan; and round the water cooler, facing each other.
 */
export const idlePlaces: Readonly<
  Record<
    Exclude<IdleLocation, "chair" | "beside the desk">,
    readonly IdlePlace[]
  >
> = {
  "coffee-machine": [
    { at: [7.5, -4.8], heading: Math.PI },
    { at: [8.2, -4.8], heading: Math.PI },
  ],
  gym: [
    { at: [7.1, 1.4], heading: 0 },
    { at: [8.2, 1.4], heading: 0 },
  ],
  "water-cooler": [
    facing([-9.2, -1.3], coolerCircle),
    facing([-8.4, -1.55], coolerCircle),
    facing([-8.5, -0.65], coolerCircle),
  ],
  // The canteen: the kettle and the microwave on the counter, the fridge,
  // the café table's two chairs and the plant by the corridor.
  kettle: [{ at: [6.95, -4.85], heading: Math.PI }],
  microwave: [{ at: [8.85, -4.8], heading: Math.PI }],
  fridge: [{ at: [9.5, -4.85], heading: Math.PI }],
  "cafe-table": [
    { at: [9.2, -4.15], heading: 0, via: [[8.55, -4.15]] },
    { at: [9.2, -2.65], heading: Math.PI, via: [[8.55, -2.65]] },
  ],
  "canteen-plant": [{ at: [7.35, -2.45], heading: -Math.PI / 2 }],
  // The lounge: the sofa's two seats, the fish tank, and the darts' throw
  // line with a place to wait a turn.
  "lounge-sofa": [
    { at: [-9.35, 1.5], heading: Math.PI / 2, via: [[-8.6, 1.5]] },
    { at: [-9.35, 2.5], heading: Math.PI / 2, via: [[-8.6, 2.5]] },
  ],
  "fish-tank": [{ at: [-9, 0.2], heading: -Math.PI / 2 }],
  darts: [
    { at: [-7.85, 3.85], heading: -Math.PI / 2 },
    { ...facing([-7.85, 3.1], [-10, 3.85]), phase: 0.5 },
  ],
  // The gym (floor-layout.ts' `gym`), beside the aisle: its kettlebells,
  // its weight bench, sat on sideways, and its treadmill, stepped up onto,
  // facing its console; the yoga mats, side by side; the exercise bike's
  // and the rowing machine's seats, come at from behind; the punchbag; and
  // before the weights rack, the far place reached round the near one.
  kettlebells: [{ at: [9, 3.3], heading: Math.PI / 2 }],
  "weight-bench": [
    { at: [7.4, 2.9], heading: -Math.PI / 2, via: [[6.85, 2.9]] },
  ],
  treadmill: [{ at: [9.25, 1.55], heading: Math.PI }],
  "yoga-mats": [
    { at: [8.05, 2.9], heading: 0 },
    { at: [8.7, 2.9], heading: 0, phase: 0.5 },
  ],
  "exercise-bike": [{ at: [6.95, 5.75], heading: 0, via: [[6.95, 5.2]] }],
  "rowing-machine": [{ at: [7.75, 5.7], heading: 0, via: [[7.75, 5.15]] }],
  punchbag: [{ at: [8.8, 5.9], heading: Math.PI / 2 }],
  dumbbells: [
    { at: [8.6, 6.75], heading: 0 },
    { at: [9.3, 6.75], heading: 0, via: [[8.4, 6.2]], phase: 0.5 },
  ],
  // Round the Floor: the printer, the whiteboard, the wall board and the
  // bookshelf, each facing it.
  printer: [{ at: [5.5, 3], heading: Math.PI / 2 }],
  whiteboard: [
    { at: [-2.6, -5.55], heading: Math.PI },
    { at: [-3.6, -5.55], heading: Math.PI },
  ],
  "wall-board": [
    { at: [0.7, -5], heading: Math.PI },
    { at: [1.4, -5], heading: Math.PI },
  ],
  bookshelf: [{ at: [2.7, -5.15], heading: Math.PI }],
  // The games hall (floor-layout.ts' `gamesHall`), from the left wall:
  // the basketball hoop's shooters, side by side; the putting green's
  // tee; the pool table's long side and its end; either end of the table
  // tennis table, the far end half a swing behind, as the ball reaches
  // it; the foosball table's four handles, the first two on opposite
  // sides, the far ones reached round its ends; the chess table's two
  // chairs; the bean bags, facing their television; the piano's bench;
  // and before the arcade machine and the vending machine.
  basketball: [
    inHall([-7.55, 2.25], -Math.PI / 2),
    inHall([-7.55, 2.95], -Math.PI / 2, { phase: 0.5 }),
  ],
  "putting-green": [
    inHall([-5.75, 4.2], Math.PI / 2, { via: [[-6.3, 4.2]] }),
    inHall([-5.75, 4.9], Math.PI / 2, { via: [[-6.3, 4.9]], phase: 0.5 }),
  ],
  "pool-table": [
    inHall([-5, 1.45], 0),
    inHall([-2.95, 2.6], -Math.PI / 2, { via: [[-2.95, 0.3]], phase: 0.5 }),
  ],
  "table-tennis": [
    inHall([-2.35, 2.4], Math.PI / 2, { via: [[-2.35, 0]] }),
    inHall([0.75, 2.4], -Math.PI / 2, { via: [[0.75, 0]], phase: 0.5 }),
  ],
  foosball: [
    inHall([1.38, 1.35], 0),
    inHall([2.02, 3.45], Math.PI, {
      via: [
        [2.75, 0.6],
        [2.75, 3.45],
      ],
      phase: 0.5,
    }),
    inHall([2.02, 1.35], 0, { phase: 0.25 }),
    inHall([1.38, 3.45], Math.PI, {
      via: [
        [0.55, 0.6],
        [0.55, 3.45],
      ],
      phase: 0.75,
    }),
  ],
  "chess-table": [
    inHall([3.3, 2.4], Math.PI / 2, { via: [[3.3, 1.55]] }),
    inHall([4.5, 2.4], -Math.PI / 2, { via: [[4.5, 1.55]] }),
  ],
  "bean-bags": [
    inHall([5.35, 2.1], 0, { via: [[5.35, 1.15]] }),
    inHall([6.25, 2.1], 0, { via: [[6.25, 1.15]] }),
  ],
  piano: [inHall([7.1, 1.49], 0), inHall([7.8, 1.49], 0)],
  arcade: [inHall([8.85, 2.9], Math.PI / 2)],
  "vending-machine": [inHall([8.95, 1.6], Math.PI / 2)],
};

/**
 * Where an Agent takes its place at a spot on the Floor: as `idlePlaces`
 * has it, or in the games hall, from the hall's walkway (the z of the
 * spot's waypoint there), wherever the desks have put it. Undefined for
 * a place the spot has not got.
 */
export function idlePlaceOn(
  waypoints: FloorLayout["waypoints"],
  location: Exclude<IdleLocation, "chair" | "beside the desk">,
  place: number,
): IdlePlace | undefined {
  const spot = idlePlaces[location][place];
  if (spot?.inHall !== true) {
    return spot;
  }
  const hallZ = waypoints.waypoints.find(({ id }) => id === location)
    ?.position[1];
  if (hallZ === undefined) {
    return undefined;
  }
  const moved = ([x, z]: FloorPoint): FloorPoint => [x, z + hallZ];
  return {
    ...spot,
    at: moved(spot.at),
    ...(spot.via === undefined ? {} : { via: spot.via.map(moved) }),
  };
}

/** The places at a location: one, the Agent's own, for its chair or desk. */
const placesAt = (location: IdleLocation): number =>
  location === "chair" || location === "beside the desk"
    ? 1
    : idlePlaces[location].length;

/** One activity, planned: the way there and back, and how long it all takes. */
export interface IdleTrip {
  readonly activity: IdleActivity;
  /** The index of its place at its location. */
  readonly place: number;
  /** From the seat to where the activity is; only the seat in the chair. */
  readonly path: readonly FloorPoint[];
  /** Its length, in metres. */
  readonly length: number;
  /** Which way the Agent faces in its chair. */
  readonly seatHeading: number;
  /** Which way it faces at the activity. */
  readonly placeHeading: number;
  /** How far through its animation's loop it plays there (`IdlePlace.phase`). */
  readonly phase: number;
  /** Seconds from the start to reaching its place. */
  readonly arrivesAt: number;
  /**
   * Seconds from the start to the activity beginning: as it arrives, or,
   * at a game, once its partners have arrived too.
   */
  readonly startsAt: number;
  /** Seconds from the start to the activity ending. */
  readonly endsAt: number;
  /** Seconds from the start to being back in its chair. */
  readonly duration: number;
}

const lengthOf = (path: readonly FloorPoint[]) =>
  path.reduce(
    (sum, point, index) => sum + distance(path[index - 1] ?? point, point),
    0,
  );

/**
 * The trip an Agent makes for an activity at a place: none in its chair;
 * a step aside from its chair beside its desk; or off its chair to its
 * walkway, along the Floor's waypoints to the amenity's, and on to its
 * place. Undefined when the Agent has no desk on the Floor, or no
 * waypoints lead there.
 */
export function idleTrip(
  layout: Pick<FloorLayout, "desks" | "waypoints">,
  agentId: string,
  activity: IdleActivity,
  place: number,
): IdleTrip | undefined {
  const desk = layout.desks.find((each) => each.agentId === agentId);
  if (desk === undefined) {
    return undefined;
  }
  const seat: FloorPoint = [desk.seat[0], desk.seat[2]];
  const seatHeading = deskFacing(desk.turns);
  const trip = (
    path: readonly FloorPoint[],
    placeHeading: number,
    phase = 0,
  ): IdleTrip => {
    const length = lengthOf(path);
    const standing = path.length > 1;
    const arrivesAt = standing ? walkSeconds.standUp + length / walkSpeed : 0;
    return startingAt(
      {
        activity,
        place,
        path,
        length,
        seatHeading,
        placeHeading,
        phase,
        arrivesAt,
        startsAt: arrivesAt,
        endsAt: 0,
        duration: 0,
      },
      arrivesAt,
    );
  };
  if (activity.location === "chair") {
    return trip([seat], seatHeading);
  }
  const ownWaypoint = layout.waypoints.waypoints.find(
    ({ id }) => id === desk.waypoint,
  );
  if (ownWaypoint === undefined) {
    return undefined;
  }
  if (activity.location === "beside the desk") {
    const [aside] = stepOff(desk, ownWaypoint.position, ownWaypoint.position);
    return aside === undefined ? undefined : trip([seat, aside], seatHeading);
  }
  const spot = idlePlaceOn(layout.waypoints, activity.location, place);
  const way = walk(layout.waypoints, desk.waypoint, activity.location);
  const first = way?.[0];
  const last = way?.at(-1);
  if (
    spot === undefined ||
    way === undefined ||
    first === undefined ||
    last === undefined
  ) {
    return undefined;
  }
  const points = way.map(({ position }) => position);
  const out = stepOff(desk, first.position, (way[1] ?? last).position);
  // Joining the walkway past the desk's own waypoint, on the way to the
  // next, the Agent goes straight on rather than back to it.
  const outOn = out.at(-1);
  const second = points[1];
  if (
    outOn !== undefined &&
    second !== undefined &&
    onSegment(outOn, first.position, second)
  ) {
    points.shift();
  }
  const path = [seat, ...out, ...points, ...(spot.via ?? []), spot.at].filter(
    (point, index, all) => {
      const before = all[index - 1];
      return before === undefined || distance(before, point) > 1e-6;
    },
  );
  return trip(path, spot.heading, spot.phase);
}

/**
 * A trip with its activity beginning at `startsAt` (no sooner than it
 * arrives): the partners at a game begin together, once the last of them
 * is there, and so finish together.
 */
export function startingAt(trip: IdleTrip, startsAt: number): IdleTrip {
  const begins = Math.max(startsAt, trip.arrivesAt);
  const endsAt = begins + trip.activity.duration;
  const standing = trip.path.length > 1;
  return {
    ...trip,
    startsAt: begins,
    endsAt,
    duration: standing
      ? endsAt + trip.length / walkSpeed + walkSeconds.sitDown
      : endsAt,
  };
}

/**
 * How far into a trip an Agent is once it is called off, `elapsed` into
 * it, its game's partner having been called away: on its way back from
 * where it is. One at its place, playing or waiting, sets off back at
 * once; one walking there turns round where it is; one still getting up
 * sits back down.
 */
export function calledOff(trip: IdleTrip, elapsed: number): number {
  const back = trip.endsAt + trip.length / walkSpeed;
  if (elapsed >= trip.endsAt) {
    return elapsed;
  }
  if (elapsed >= trip.arrivesAt) {
    return trip.endsAt;
  }
  if (trip.path.length < 2 || elapsed < walkSeconds.standUp) {
    return back;
  }
  const along = (elapsed - walkSeconds.standUp) * walkSpeed;
  return trip.endsAt + (trip.length - along) / walkSpeed;
}

/** Where an idle Agent is, which way it faces, and what it plays. */
export interface IdlePose {
  readonly position: FloorPoint;
  readonly heading: number;
  readonly animation: AnimationName;
  /** Over its head, such as "zzz", while it is at the activity. */
  readonly bubble: string | undefined;
  /** How far through its animation's loop it starts it, as a share of it. */
  readonly phase?: number;
}

/** A trip, `elapsed` seconds after it began. */
export function idlePose(trip: IdleTrip, elapsed: number): IdlePose {
  const { path, length, seatHeading, placeHeading, activity } = trip;
  const seat = path[0] ?? [0, 0];
  const atSeat = (animation: AnimationName): IdlePose => ({
    position: seat,
    heading: seatHeading,
    animation,
    bubble: undefined,
  });
  if (elapsed >= trip.startsAt && elapsed < trip.endsAt) {
    return {
      position: path.at(-1) ?? seat,
      heading: placeHeading,
      animation: activity.animation,
      bubble: activity.bubble,
      phase: trip.phase,
    };
  }
  if (elapsed >= trip.arrivesAt && elapsed < trip.startsAt) {
    // There first, waiting for its partners: sat in its seat, or standing.
    return {
      position: path.at(-1) ?? seat,
      heading: placeHeading,
      animation: seatedLocations.includes(activity.location) ? "sit" : "idle",
      bubble: undefined,
    };
  }
  if (path.length < 2) {
    return atSeat("sit");
  }
  if (elapsed < walkSeconds.standUp) {
    return atSeat("stand-up");
  }
  if (elapsed < trip.arrivesAt) {
    const along = (elapsed - walkSeconds.standUp) * walkSpeed;
    return {
      position: pointAlong(path, along),
      heading: headingAlong(path, along),
      animation: "walk",
      bubble: undefined,
    };
  }
  const back = trip.endsAt + length / walkSpeed;
  if (elapsed < back) {
    const along = length - (elapsed - trip.endsAt) * walkSpeed;
    return {
      position: pointAlong(path, along),
      heading: headingAlong(path, along) + Math.PI,
      animation: "walk",
      bubble: undefined,
    };
  }
  return atSeat("sit-down");
}

/** Weighted-random choice: each candidate as likely as its weight. */
export function chooseActivity<T extends { readonly weight: number }>(
  candidates: readonly T[],
  random: () => number,
): T | undefined {
  const weighed = candidates.filter(({ weight }) => weight > 0);
  const total = weighed.reduce((sum, { weight }) => sum + weight, 0);
  let left = random() * total;
  for (const candidate of weighed) {
    left -= candidate.weight;
    if (left < 0) {
      return candidate;
    }
  }
  return weighed.at(-1);
}

/** What an Agent is up to, as idle behaviours see it. */
export type IdleState =
  /** At work: when it next becomes idle, it has finished. */
  | "working"
  /** Not at work, but not free either: waiting on review, queued, paused, capped, on a Handoff walk or in a meeting. */
  | "busy"
  /** Nothing to do. */
  | "idle";

/**
 * An Agent's idle state from how it looks and whether it is away on work:
 * on a Handoff walk, or gathered for a meeting (away-pose.ts). It has
 * nothing to do only while it sits back with no marker and no tickets on
 * its desk; an Agent the Office has no look for yet sits back too.
 */
export function idleStateOf(
  look: AgentLook | undefined,
  awayOnWork: boolean,
): IdleState {
  if (awayOnWork) {
    return "busy";
  }
  if (look === undefined) {
    return "idle";
  }
  if (look.animation === "type") {
    return "working";
  }
  return look.animation === "sit" &&
    look.marker === undefined &&
    look.tickets === 0
    ? "idle"
    : "busy";
}

/** One Agent's idling. */
export interface IdleAgent {
  /** Seconds idle without a break. */
  readonly idleFor: number;
  /** Seconds before it next chooses an activity. */
  readonly restLeft: number;
  /** It has just finished working, and has not yet had its finishing activity. */
  readonly finished: boolean;
  /** The activity it is on, how far into it, and who it plays it with. */
  readonly doing:
    | {
        readonly trip: IdleTrip;
        readonly elapsed: number;
        /** At a game, the others playing it; none once it is called off. */
        readonly partners?: readonly string[];
        /**
         * Called back to its desk by the Owner ("Return to desks"): on its
         * way back, and a full rest once there.
         */
        readonly recalled?: boolean;
      }
    | undefined;
}

/** Each of a Floor's Agents' idling, by its id. */
export type IdleAgents = ReadonlyMap<string, IdleAgent>;

/** Plans an activity at one of its location's places; undefined when it cannot be. */
export type IdlePlanner = (
  agentId: string,
  activity: IdleActivity,
  place: number,
) => IdleTrip | undefined;

const rest = (random: () => number) =>
  restSeconds.min + random() * (restSeconds.max - restSeconds.min);

/** Who an activity's location is shared with: an Agent's chair and desk are its own. */
const occupancyKey = (agentId: string, location: IdleLocation) =>
  location === "chair" || location === "beside the desk"
    ? `${location}:${agentId}`
    : location;

/**
 * The idling `seconds` later, with each Agent in `states` (any other has
 * left the Floor). An Agent that is not idle stops at once, whatever it
 * was doing; one that has just finished working does its finishing
 * activity first; one whose rest is over chooses among the activities
 * that may be chosen now and have room, by weight. An activity that ends
 * starts a new rest.
 */
export function advanceIdle(
  agents: IdleAgents,
  seconds: number,
  states: ReadonlyMap<string, IdleState>,
  plan: IdlePlanner,
  random: () => number,
  activities: readonly IdleActivity[] = idleActivities,
): IdleAgents {
  const next = new Map<string, IdleAgent>();
  // Where Agents are, by location: the places taken.
  const taken = new Map<string, Set<number>>();
  const take = (agentId: string, trip: IdleTrip) => {
    const key = occupancyKey(agentId, trip.activity.location);
    const places = taken.get(key) ?? new Set<number>();
    places.add(trip.place);
    taken.set(key, places);
  };
  const starting: string[] = [];

  // First, those that stop, and those that carry on.
  for (const [agentId, state] of states) {
    const before = agents.get(agentId);
    if (before === undefined) {
      next.set(agentId, {
        idleFor: 0,
        restLeft: rest(random),
        finished: state === "working",
        doing: undefined,
      });
      continue;
    }
    if (state !== "idle") {
      const wasIdle = before.idleFor > 0 || before.doing !== undefined;
      next.set(agentId, {
        idleFor: 0,
        restLeft: wasIdle ? rest(random) : before.restLeft,
        finished: before.finished || state === "working",
        doing: undefined,
      });
      continue;
    }
    const idleFor = before.idleFor + seconds;
    if (before.doing !== undefined) {
      const elapsed = before.doing.elapsed + seconds;
      if (elapsed < before.doing.trip.duration) {
        take(agentId, before.doing.trip);
        next.set(agentId, {
          ...before,
          idleFor,
          doing: { ...before.doing, elapsed },
        });
      } else {
        next.set(agentId, {
          ...before,
          idleFor,
          restLeft:
            before.doing.recalled === true ? restSeconds.max : rest(random),
          doing: undefined,
        });
      }
      continue;
    }
    next.set(agentId, {
      ...before,
      idleFor,
      restLeft: before.finished ? before.restLeft : before.restLeft - seconds,
    });
    if (before.finished || before.restLeft - seconds <= 0) {
      starting.push(agentId);
    }
  }

  // A game is called off for every player once one of them has gone:
  // the rest head back from wherever they are.
  for (const [agentId, agent] of next) {
    const doing = agent.doing;
    if (doing?.partners === undefined) {
      continue;
    }
    const lost = doing.partners.some(
      (partner) =>
        next.get(partner)?.doing?.trip.activity !== doing.trip.activity,
    );
    if (lost) {
      next.set(agentId, {
        ...agent,
        doing: {
          trip: doing.trip,
          elapsed: calledOff(doing.trip, doing.elapsed),
        },
      });
    }
  }

  // Then those that start something, where there is room, with partners
  // free to play a game with them: idle, and settled in since they last
  // worked (or joined the Floor).
  const freePartners = (agentId: string) =>
    [...next].flatMap(([id, other]) =>
      id !== agentId &&
      states.get(id) === "idle" &&
      other.doing === undefined &&
      !other.finished &&
      other.idleFor >= settleSeconds
        ? [id]
        : [],
    );
  for (const agentId of starting) {
    const agent = next.get(agentId);
    // One taken off as a partner since has its game already.
    if (agent === undefined || agent.doing !== undefined) {
      continue;
    }
    const partners = freePartners(agentId);
    const freePlaces = (activity: IdleActivity) => {
      const here = taken.get(occupancyKey(agentId, activity.location));
      return Array.from(
        { length: placesAt(activity.location) },
        (_, index) => index,
      ).filter((index) => here?.has(index) !== true);
    };
    const open = activities.filter((activity) => {
      const due = agent.finished
        ? activity.when === "finished"
        : activity.when === "idle" ||
          (activity.when === "long idle" && agent.idleFor >= longIdleSeconds);
      const here = taken.get(occupancyKey(agentId, activity.location));
      const players = activity.together ?? 1;
      return (
        due &&
        (here?.size ?? 0) + players <= activity.occupancy &&
        freePlaces(activity).length >= players &&
        partners.length >= players - 1
      );
    });
    const activity = chooseActivity(open, random);
    const party =
      activity === undefined
        ? []
        : [agentId, ...partners.slice(0, (activity.together ?? 1) - 1)];
    const places = activity === undefined ? [] : freePlaces(activity);
    const trips = party.map((id, index) => {
      const place = places[index];
      return activity === undefined || place === undefined
        ? undefined
        : plan(id, activity, place);
    });
    const planned = trips.filter((trip) => trip !== undefined);
    if (activity === undefined || planned.length !== party.length) {
      next.set(agentId, {
        ...agent,
        finished: false,
        restLeft: rest(random),
      });
      continue;
    }
    // Partners begin together, once the last is at the table.
    const begins = Math.max(...planned.map(({ arrivesAt }) => arrivesAt));
    party.forEach((id, index) => {
      const each = next.get(id);
      const trip = planned[index];
      if (each === undefined || trip === undefined) {
        return;
      }
      const together = startingAt(trip, begins);
      take(id, together);
      next.set(id, {
        ...each,
        finished: false,
        doing: {
          trip: together,
          elapsed: 0,
          ...(party.length > 1
            ? { partners: party.filter((other) => other !== id) }
            : {}),
        },
      });
    });
  }
  return next;
}

/** A Floor's idle behaviours, kept as the scene plays them. */
export interface IdleBehaviours {
  /** `seconds` later, with each Agent's state. */
  readonly advance: (
    seconds: number,
    states: ReadonlyMap<string, IdleState>,
    plan: IdlePlanner,
  ) => void;
  /** Every activity stopped, every Agent back in its chair (reduced motion). */
  readonly stopAll: () => void;
  /**
   * The Owner calls everyone back to their desks ("Return to desks"):
   * each activity is called off, its Agent walking back from wherever it
   * is (or, with `walk` false, in its chair at once), and every Agent's
   * rest starts again from a full one, so no one wanders straight off.
   */
  readonly recall: (walk: boolean) => void;
  /** Whether an Agent is away on an activity, not on its way back from a recall. */
  readonly wandering: (agentId: string) => boolean;
  /** Where an Agent is on its activity; undefined in its chair, sitting back. */
  readonly poseOf: (
    agentId: string,
  ) => (IdlePose & { readonly pace: number }) | undefined;
  /** The bubbles over Agents' heads now, such as "zzz", by Agent id. */
  readonly bubbles: () => ReadonlyMap<string, string>;
  /**
   * Who is playing at a spot now, by their place there: the activity,
   * and how long it has been played (for the table tennis ball).
   */
  readonly playing: (
    location: IdleLocation,
  ) => ReadonlyMap<number, IdlePlaying>;
}

/** An Agent playing an activity at its place, so far. */
export interface IdlePlaying {
  readonly agentId: string;
  readonly activity: string;
  /** Seconds since it began. */
  readonly seconds: number;
}

export function createIdleBehaviours(
  random: () => number = Math.random,
  activities: readonly IdleActivity[] = idleActivities,
): IdleBehaviours {
  let agents: IdleAgents = new Map();
  return {
    advance(seconds, states, plan) {
      agents = advanceIdle(agents, seconds, states, plan, random, activities);
    },
    stopAll() {
      agents = new Map(
        [...agents].map(([agentId, agent]) => [
          agentId,
          { ...agent, idleFor: 0, finished: false, doing: undefined },
        ]),
      );
    },
    recall(walk) {
      agents = new Map(
        [...agents].map(([agentId, agent]) => [
          agentId,
          {
            idleFor: 0,
            restLeft: restSeconds.max,
            finished: false,
            doing:
              !walk || agent.doing === undefined
                ? undefined
                : {
                    trip: agent.doing.trip,
                    elapsed: calledOff(agent.doing.trip, agent.doing.elapsed),
                    recalled: true,
                  },
          },
        ]),
      );
    },
    wandering(agentId) {
      const doing = agents.get(agentId)?.doing;
      return doing !== undefined && doing.recalled !== true;
    },
    poseOf(agentId) {
      const doing = agents.get(agentId)?.doing;
      return doing === undefined
        ? undefined
        : { ...idlePose(doing.trip, doing.elapsed), pace: 1 };
    },
    bubbles() {
      const result = new Map<string, string>();
      for (const [agentId, { doing }] of agents) {
        const bubble =
          doing === undefined
            ? undefined
            : idlePose(doing.trip, doing.elapsed).bubble;
        if (bubble !== undefined) {
          result.set(agentId, bubble);
        }
      }
      return result;
    },
    playing(location) {
      const result = new Map<number, IdlePlaying>();
      for (const [agentId, { doing }] of agents) {
        if (
          doing?.trip.activity.location === location &&
          doing.elapsed >= doing.trip.startsAt &&
          doing.elapsed < doing.trip.endsAt
        ) {
          result.set(doing.trip.place, {
            agentId,
            activity: doing.trip.activity.name,
            seconds: doing.elapsed - doing.trip.startsAt,
          });
        }
      }
      return result;
    },
  };
}
