import type { Vec3 } from "./camera-rig.ts";
import type { Piece } from "./pieces.ts";

// The lift core, as pieces: the same in the lobby and on every Floor, so
// the doors close on one and open on the next at the same place. The
// doorway is in a wall facing +z, its centre on the floor at
// `liftDoorway.position`; the shaft is behind it. The doors and the lamps
// over them move, so they are not pieces: the scene draws them from the
// sizes here.

/** The doorway: the spec's door, 0.9 m × 2.1 m. */
export const liftDoorway = {
  position: [5, 0, -6] as Vec3,
  width: 0.9,
  height: 2.1,
} as const;

/** The wall the doorway is in: how thick, and how wide the core is. */
export const liftWall = { thickness: 0.2, width: 2.8, height: 3 } as const;

/** Each of the two sliding doors, closed; open, each slides into its side. */
export const liftDoor = {
  size: [liftDoorway.width / 2, liftDoorway.height, 0.04] as Vec3,
  /** How far each slides to open, in metres. */
  travel: liftDoorway.width / 2 - 0.02,
} as const;

/** The lamps over the doors: one per stop, the car's lit. */
export const liftLamps = {
  /** The most lamps; stops beyond them have none. */
  max: 8,
  spacing: 0.1,
  size: [0.06, 0.06, 0.015] as Vec3,
  /** Height of their centres above the floor. */
  height: 2.42,
  /** Under a stop's lamp, a red marker when it has an action Notice. */
  markerSize: [0.04, 0.025, 0.015] as Vec3,
  markerHeight: 2.34,
} as const;

/** The lit call button beside the doors, which calls the lift. */
export const liftCallButton = {
  position: [
    liftDoorway.position[0] + 0.8,
    1.1,
    liftDoorway.position[2] + 0.03,
  ] as Vec3,
  size: [0.07, 0.07, 0.02] as Vec3,
} as const;

const [doorX, , wallZ] = liftDoorway.position;
const wallCentreZ = wallZ - liftWall.thickness / 2;
const frame = 0.1;
const pillarWidth = (liftWall.width - liftDoorway.width) / 2 - frame;
const shaftDepth = 1.4;
const shaftZ = wallZ - liftWall.thickness - shaftDepth / 2;

/** The lift core's fixed pieces: the wall round the doorway, its frame and the car. */
export const liftCorePieces: readonly Piece[] = [
  ...[-1, 1].map((side): Piece => ({
    name: `lift wall, ${side < 0 ? "left" : "right"}`,
    shape: "box",
    token: "wall",
    surface: "paint",
    role: "architecture",
    size: [pillarWidth, liftWall.height, liftWall.thickness],
    position: [
      doorX + side * (liftWall.width / 2 - pillarWidth / 2),
      liftWall.height / 2,
      wallCentreZ,
    ],
  })),
  {
    name: "lift wall, over the doors",
    shape: "box",
    token: "wall",
    surface: "paint",
    role: "architecture",
    size: [
      liftDoorway.width + 2 * frame,
      liftWall.height - liftDoorway.height - frame,
      liftWall.thickness,
    ],
    position: [
      doorX,
      (liftWall.height + liftDoorway.height + frame) / 2,
      wallCentreZ,
    ],
  },
  ...[-1, 1].map((side): Piece => ({
    name: `lift door frame, ${side < 0 ? "left" : "right"}`,
    shape: "box",
    token: "metal-dark",
    surface: "metal",
    role: "architecture",
    size: [frame, liftDoorway.height + frame, liftWall.thickness + 0.06],
    position: [
      doorX + side * (liftDoorway.width / 2 + frame / 2),
      (liftDoorway.height + frame) / 2,
      wallCentreZ,
    ],
  })),
  {
    name: "lift door frame, top",
    shape: "box",
    token: "metal-dark",
    surface: "metal",
    role: "architecture",
    size: [liftDoorway.width, frame, liftWall.thickness + 0.06],
    position: [doorX, liftDoorway.height + frame / 2, wallCentreZ],
  },
  // The shaft behind the wall, plastered like it, its roof at the ceiling's
  // height.
  ...[-1, 1].map((side): Piece => ({
    name: `lift shaft, ${side < 0 ? "left" : "right"}`,
    shape: "box",
    token: "wall",
    surface: "paint",
    role: "architecture",
    size: [0.1, liftWall.height, shaftDepth],
    position: [
      doorX + side * (liftDoorway.width / 2 + 0.25),
      liftWall.height / 2,
      shaftZ,
    ],
  })),
  {
    name: "lift shaft, back",
    shape: "box",
    token: "wall",
    surface: "paint",
    role: "architecture",
    size: [liftDoorway.width + 0.6, liftWall.height, 0.1],
    position: [doorX, liftWall.height / 2, shaftZ - shaftDepth / 2 - 0.05],
  },
  {
    name: "lift shaft, roof",
    shape: "box",
    token: "wall",
    surface: "paint",
    role: "architecture",
    size: [liftDoorway.width + 0.6, 0.1, shaftDepth + 0.2],
    position: [doorX, liftWall.height - 0.05, shaftZ - 0.05],
  },
  {
    name: "lift door sill",
    shape: "box",
    token: "metal-dark",
    surface: "metal",
    role: "architecture",
    size: [liftDoorway.width, 0.02, liftWall.thickness + 0.06],
    position: [doorX, 0.01, wallCentreZ],
  },
  {
    name: "lift car floor",
    shape: "box",
    token: "metal-dark",
    surface: "metal",
    role: "architecture",
    size: [liftDoorway.width + 0.4, 0.04, shaftDepth],
    position: [doorX, 0.02, shaftZ],
  },
  {
    name: "lift car light",
    shape: "box",
    token: "lamp",
    surface: "lamp",
    role: "architecture",
    size: [liftDoorway.width, 0.02, shaftDepth - 0.4],
    position: [doorX, liftWall.height - 0.11, shaftZ],
  },
  {
    name: "lift call panel",
    shape: "box",
    token: "metal-light",
    surface: "metal",
    role: "architecture",
    size: [0.16, 0.36, 0.02],
    position: [
      liftCallButton.position[0],
      liftCallButton.position[1],
      wallZ + 0.01,
    ],
  },
];

/** The sign over the lamps naming where the lift is: "Lobby" or the Floor's name. */
export const liftSign = {
  position: [
    liftDoorway.position[0],
    2.72,
    liftDoorway.position[2] + 0.015,
  ] as Vec3,
  size: [1.6, 0.34] as const,
} as const;
