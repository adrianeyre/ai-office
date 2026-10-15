import type { Vec3 } from "./camera-rig.ts";
import { liftCorePieces, liftDoorway, liftWall } from "./lift-layout.ts";
import { boardSize } from "./notice-board-preview.ts";
import { piece, standing, type Piece, type Walkway } from "./pieces.ts";

// The lobby (PRD FR-57): the entrance, the Communications Agent's
// reception desk (FR-96), the office-wide Notice Board on the back wall,
// a waiting area, a water cooler and the lift. It is a cut-away: the back and left walls
// stand, the front and right are open to the default view, which looks
// down from the front right. 16 m × 12 m, centred on the origin.

export const lobbySize = { width: 16, depth: 12, ceiling: 3 } as const;

const halfWidth = lobbySize.width / 2;
const halfDepth = lobbySize.depth / 2;
const wallThickness = liftWall.thickness;
const backWallZ = -halfDepth - wallThickness / 2;
const leftWallX = -halfWidth - wallThickness / 2;

/** The entrance: double glass doors in the left wall, two of the spec's 0.9 m doors. */
export const entrance = {
  z: [1.6, 3.4] as const,
  height: 2.1,
} as const;

/** The Notice Board on the back wall: its centre, facing +z (1.6 m × 0.9 m, centre 1.6 m up). */
export const noticeBoardPosition: Vec3 = [1.2, 1.6, -halfDepth];

/** Where the reception desk is: the middle of its counter's front, on the floor. */
export const receptionPosition: Vec3 = [-4, 0, -2.9];

/** The feature wall behind reception: a panel on the back wall, centred on the desk. */
export const featureWall = { width: 5, thickness: 0.02 } as const;

/**
 * The company logo (`brand.logo`) on the feature wall behind reception, as
 * a real lobby has it: centred on the desk, 2.8 m wide at the logo's 244:64
 * proportions, its centre 2.1 m up (well clear of the counter's 1.08 m top),
 * and 3 mm proud of the feature wall so the two never flicker into each other.
 */
export const receptionLogo = {
  position: [
    receptionPosition[0],
    2.1,
    -halfDepth + featureWall.thickness + 0.003,
  ] as Vec3,
  size: [2.8, (2.8 * 64) / 244] as const,
} as const;

const wall = (name: string, size: Vec3, position: Vec3) =>
  piece(name, "box", "wall", "paint", "architecture", size, position);

const [liftX] = liftDoorway.position;
const liftLeft = liftX - liftWall.width / 2;
const liftRight = liftX + liftWall.width / 2;

const architecture: Piece[] = [
  piece(
    "floor",
    "box",
    "floor-wood",
    "wood",
    "architecture",
    [lobbySize.width, 0.1, lobbySize.depth],
    [0, -0.05, 0],
  ),
  // The back wall, on either side of the lift core.
  wall(
    "back wall",
    [liftLeft + halfWidth, lobbySize.ceiling, wallThickness],
    [(liftLeft - halfWidth) / 2, lobbySize.ceiling / 2, backWallZ],
  ),
  wall(
    "back wall, right of the lift",
    [halfWidth - liftRight, lobbySize.ceiling, wallThickness],
    [(liftRight + halfWidth) / 2, lobbySize.ceiling / 2, backWallZ],
  ),
  piece(
    "feature wall behind reception",
    "box",
    "wall-feature",
    "paint",
    "architecture",
    [featureWall.width, lobbySize.ceiling, featureWall.thickness],
    [
      receptionPosition[0],
      lobbySize.ceiling / 2,
      -halfDepth + featureWall.thickness / 2,
    ],
  ),
  // The left wall, on either side of the entrance, and over it.
  wall(
    "left wall",
    [
      wallThickness,
      lobbySize.ceiling,
      entrance.z[0] + halfDepth + wallThickness,
    ],
    [
      leftWallX,
      lobbySize.ceiling / 2,
      (entrance.z[0] - halfDepth - wallThickness) / 2,
    ],
  ),
  wall(
    "left wall, in front of the entrance",
    [wallThickness, lobbySize.ceiling, halfDepth - entrance.z[1]],
    [leftWallX, lobbySize.ceiling / 2, (entrance.z[1] + halfDepth) / 2],
  ),
  wall(
    "left wall, over the entrance",
    [
      wallThickness,
      lobbySize.ceiling - entrance.height,
      entrance.z[1] - entrance.z[0],
    ],
    [
      leftWallX,
      (lobbySize.ceiling + entrance.height) / 2,
      (entrance.z[0] + entrance.z[1]) / 2,
    ],
  ),
  // The entrance's glass doors, in a dark frame.
  ...[0, 1].map((door) =>
    piece(
      `entrance door ${String(door + 1)}`,
      "box",
      "glass",
      "glass",
      "architecture",
      [0.03, entrance.height - 0.06, 0.86],
      [
        leftWallX,
        (entrance.height - 0.06) / 2,
        entrance.z[0] + 0.45 + door * 0.9,
      ],
    ),
  ),
  ...[entrance.z[0] + 0.02, 2.5, entrance.z[1] - 0.02].map((z, index) =>
    piece(
      `entrance door frame ${String(index + 1)}`,
      "box",
      "metal-dark",
      "metal",
      "architecture",
      [0.1, entrance.height, 0.04],
      [leftWallX, entrance.height / 2, z],
    ),
  ),
  piece(
    "entrance door frame, top",
    "box",
    "metal-dark",
    "metal",
    "architecture",
    [0.1, 0.06, entrance.z[1] - entrance.z[0]],
    [leftWallX, entrance.height - 0.03, (entrance.z[0] + entrance.z[1]) / 2],
  ),
  standing(
    "entrance mat",
    "floor-carpet",
    "fabric",
    "architecture",
    [1.6, 0.01, entrance.z[1] - entrance.z[0]],
    [-halfWidth + 0.8, (entrance.z[0] + entrance.z[1]) / 2],
  ),
  standing(
    "rug under the waiting area",
    "floor-carpet",
    "fabric",
    "architecture",
    [3.6, 0.01, 2.2],
    [4.2, 4.7],
  ),
];

const [boardX, boardY, boardZ] = noticeBoardPosition;
const boardFrame = 0.05;

// The board's felt and its wooden frame; the cards pinned to it change with
// the Notices, so the scene draws them (notice-board-preview.ts).
const noticeBoard: Piece[] = [
  piece(
    "Notice Board, felt",
    "box",
    "floor-carpet",
    "fabric",
    "architecture",
    [boardSize.width, boardSize.height, 0.02],
    [boardX, boardY, boardZ + 0.01],
  ),
  ...[-1, 1].map((side) =>
    piece(
      `Notice Board frame, ${side < 0 ? "bottom" : "top"}`,
      "box",
      "desk-top",
      "wood",
      "architecture",
      [boardSize.width, boardFrame, 0.04],
      [
        boardX,
        boardY + side * (boardSize.height / 2 - boardFrame / 2),
        boardZ + 0.02,
      ],
    ),
  ),
  ...[-1, 1].map((side) =>
    piece(
      `Notice Board frame, ${side < 0 ? "left" : "right"}`,
      "box",
      "desk-top",
      "wood",
      "architecture",
      [boardFrame, boardSize.height - 2 * boardFrame, 0.04],
      [
        boardX + side * (boardSize.width / 2 - boardFrame / 2),
        boardY,
        boardZ + 0.02,
      ],
    ),
  ),
];

const [receptionX, , receptionZ] = receptionPosition;
const counterWidth = 2.8;
// The Communications Agent sits behind the counter, facing +z.
const workTopZ = receptionZ - 0.12 - 0.35;
const chairZ = workTopZ - 0.75;

/** The top of the reception counter's ledge, over the counter's front. */
const ledgeTop = 1.08;
const ledgeZ = receptionZ - 0.15;

/**
 * The out-tray the Communications Agent drops an envelope into for each
 * message it sends (FR-96): on the counter's ledge to its right, where the
 * lobby sees it over the counter, with a few letters in already. `top` is
 * the letters' top, where envelopes land.
 */
export const outTray = {
  centre: [receptionX - 0.75, ledgeTop + 0.03, ledgeZ] as Vec3,
  size: [0.32, 0.06, 0.24] as Vec3,
  top: ledgeTop + 0.06 + 0.012,
} as const;

/**
 * Where the Communications Agent's hands are over the desk as it sends a
 * message, before the envelope drops into the out-tray.
 */
export const receptionHands: Vec3 = [receptionX - 0.2, 0.95, workTopZ];

/**
 * The red marker a failing Connection shows on the reception desk (FR-96):
 * a sign standing on the counter's ledge, its centre `centre`, at the end
 * away from the out-tray, where the default view sees it over the counter.
 */
export const receptionMarker = {
  centre: [receptionX + 1.1, ledgeTop + 0.05 + 0.09, ledgeZ] as Vec3,
  radius: 0.09,
  thickness: 0.02,
  /** The post from the ledge's top to the sign's foot. */
  post: [0.02, 0.05, 0.02] as Vec3,
} as const;

const reception: Piece[] = [
  standing(
    "reception counter, front",
    "desk-top",
    "wood",
    "furniture",
    [counterWidth, 1.05, 0.12],
    [receptionX, receptionZ - 0.06],
  ),
  piece(
    "reception counter, ledge",
    "box",
    "desk-top",
    "wood",
    "furniture",
    [counterWidth, 0.03, 0.3],
    [receptionX, 1.065, receptionZ - 0.15],
  ),
  piece(
    "reception desk, top",
    "box",
    "desk-top",
    "wood",
    "furniture",
    [counterWidth, 0.03, 0.7],
    [receptionX, 0.725, workTopZ],
  ),
  ...[-1, 1].map((side) =>
    standing(
      `reception desk, ${side < 0 ? "left" : "right"} end`,
      "desk-top",
      "wood",
      "furniture",
      [0.04, 0.71, 0.7],
      [receptionX + side * (counterWidth / 2 - 0.02), workTopZ],
    ),
  ),
  // The monitor faces the Agent, its top 1.15 m up, 0.45 m from the desk's front edge.
  piece(
    "reception monitor",
    "box",
    "screen-off",
    "screen",
    "prop",
    [0.55, 0.33, 0.03],
    [receptionX, 0.985, workTopZ - 0.35 + 0.45],
  ),
  piece(
    "reception monitor stand",
    "box",
    "metal-dark",
    "metal",
    "prop",
    [0.05, 0.1, 0.05],
    [receptionX, 0.79, workTopZ - 0.35 + 0.49],
  ),
  // The out-tray the Communications Agent drops envelopes into (FR-96).
  piece(
    "out-tray",
    "box",
    "metal-light",
    "metal",
    "prop",
    outTray.size,
    outTray.centre,
  ),
  piece(
    "out-tray, letters",
    "box",
    "paper",
    "paint",
    "prop",
    [0.24, 0.012, 0.18],
    [outTray.centre[0], outTray.top - 0.006, outTray.centre[2]],
  ),
  piece(
    "desk lamp, stem",
    "cylinder",
    "metal-dark",
    "metal",
    "prop",
    [0.03, 0.35, 0.03],
    [receptionX + 1.05, 0.915, workTopZ - 0.15],
  ),
  piece(
    "desk lamp, shade",
    "sphere",
    "lamp",
    "lamp",
    "prop",
    [0.16, 0.09, 0.16],
    [receptionX + 1.05, 1.1, workTopZ - 0.1],
  ),
  // The chair: seat 0.46 m up, 0.5 m × 0.5 m, its back to 0.95 m.
  piece(
    "reception chair, seat",
    "box",
    "chair",
    "fabric",
    "furniture",
    [0.5, 0.08, 0.5],
    [receptionX, 0.42, chairZ],
  ),
  piece(
    "reception chair, back",
    "box",
    "chair",
    "fabric",
    "furniture",
    [0.5, 0.49, 0.06],
    [receptionX, 0.705, chairZ - 0.25],
  ),
  standing(
    "reception chair, post",
    "metal-dark",
    "metal",
    "furniture",
    [0.06, 0.38, 0.06],
    [receptionX, chairZ],
    "cylinder",
  ),
  standing(
    "reception chair, base",
    "metal-dark",
    "metal",
    "furniture",
    [0.5, 0.04, 0.5],
    [receptionX, chairZ],
    "cylinder",
  ),
];

/** Where the receptionist sits: their chair behind the desk, facing +z. */
export const receptionSeat = [receptionX, chairZ] as const;

const sofaSeat = 0.42;

/** A sofa, its seat's centre at `x`, `z`, facing `facing` (+z is towards the front). */
function sofa(
  name: string,
  [x, z]: readonly [number, number],
  facing: "-z" | "-x",
): Piece[] {
  const along = facing === "-z";
  const size = (length: number, depth: number, height: number): Vec3 =>
    along ? [length, height, depth] : [depth, height, length];
  const at = (offsetAlong: number, offsetBack: number) =>
    along
      ? ([x + offsetAlong, z + offsetBack] as const)
      : ([x + offsetBack, z + offsetAlong] as const);
  return [
    standing(
      `${name}, seat`,
      "sofa",
      "fabric",
      "furniture",
      size(2, 0.85, sofaSeat),
      at(0, 0),
    ),
    piece(
      `${name}, back`,
      "box",
      "sofa",
      "fabric",
      "furniture",
      size(2, 0.2, 0.45),
      ((): Vec3 => {
        const [backX, backZ] = at(0, 0.35);
        return [backX, sofaSeat + 0.225, backZ];
      })(),
    ),
    ...[-1, 1].map((side) =>
      standing(
        `${name}, ${side < 0 ? "left" : "right"} arm`,
        "sofa",
        "fabric",
        "furniture",
        size(0.2, 0.85, 0.62),
        at(side * 1.1, 0),
      ),
    ),
  ];
}

/** A plant in a pot, its footprint centred at `x`, `z`. */
function plant(name: string, [x, z]: readonly [number, number]): Piece[] {
  return [
    standing(
      `${name}, pot`,
      "ceramic",
      "plastic",
      "prop",
      [0.4, 0.45, 0.4],
      [x, z],
      "cylinder",
    ),
    piece(
      `${name}, leaves`,
      "sphere",
      "plant",
      "plastic",
      "prop",
      [0.7, 0.8, 0.7],
      [x, 0.85, z],
    ),
    piece(
      `${name}, top leaves`,
      "sphere",
      "plant",
      "plastic",
      "prop",
      [0.45, 0.5, 0.45],
      [x + 0.1, 1.3, z + 0.08],
    ),
  ];
}

const waitingArea: Piece[] = [
  ...sofa("sofa by the front", [3.2, 5.2], "-z"),
  ...sofa("sofa by the side", [7.2, 4.3], "-x"),
  piece(
    "coffee table, top",
    "box",
    "desk-top",
    "wood",
    "furniture",
    [1, 0.04, 0.6],
    [5.2, 0.4, 4.4],
  ),
  standing(
    "coffee table, base",
    "metal-dark",
    "metal",
    "furniture",
    [0.8, 0.38, 0.4],
    [5.2, 4.4],
  ),
  piece(
    "mug",
    "cylinder",
    "ceramic",
    "plastic",
    "prop",
    [0.08, 0.1, 0.08],
    [5, 0.47, 4.35],
  ),
  piece(
    "magazine",
    "box",
    "paper",
    "paint",
    "prop",
    [0.3, 0.01, 0.22],
    [5.4, 0.425, 4.5],
  ),
];

/** Where the visitor sits: the left of the sofa by the front, facing -z. */
export const lobbySofaSeat = [2.7, 5.15] as const;

/** The water cooler against the back wall, between reception and the Notice Board. */
export const lobbyWaterCooler = [-1.8, -halfDepth + 0.3] as const;

const waterCooler: Piece[] = [
  standing(
    "water cooler",
    "ceramic",
    "plastic",
    "prop",
    [0.35, 0.75, 0.35],
    [lobbyWaterCooler[0], lobbyWaterCooler[1]],
  ),
  piece(
    "water cooler, bottle",
    "cylinder",
    "glass",
    "glass",
    "prop",
    [0.28, 0.35, 0.28],
    [lobbyWaterCooler[0], 0.925, lobbyWaterCooler[1]],
  ),
  piece(
    "water cooler, tap",
    "box",
    "metal-dark",
    "metal",
    "prop",
    [0.04, 0.04, 0.04],
    [lobbyWaterCooler[0], 0.62, lobbyWaterCooler[1] + 0.19],
  ),
];

const plants: Piece[] = [
  ...plant("plant by reception", [-7.3, -5.4]),
  ...plant("plant by the Notice Board", [-0.6, -5.45]),
  ...plant("plant by the lift", [7.4, -5.4]),
  ...plant("plant by the entrance", [-7.4, 5.4]),
];

/** Every fixed piece of the lobby, the lift core's included. */
export const lobbyPieces: readonly Piece[] = [
  ...architecture,
  ...noticeBoard,
  ...liftCorePieces,
  ...reception,
  ...waitingArea,
  ...waterCooler,
  ...plants,
];

/**
 * The lobby's walkways, at least 1.5 m wide (the spec's World scale), kept
 * clear of furniture and props: from the entrance to the lift, and to the
 * Notice Board and reception.
 */
export const lobbyWalkways: readonly Walkway[] = [
  { name: "from the entrance", x: [-halfWidth, liftX + 0.75], z: entrance.z },
  {
    name: "to the lift doors",
    x: [liftX - 0.75, liftX + 0.75],
    z: [-halfDepth, entrance.z[1]],
  },
  {
    name: "to the Notice Board",
    x: [noticeBoardPosition[0] - 1, noticeBoardPosition[0] + 1],
    z: [-halfDepth, entrance.z[0]],
  },
  {
    name: "to reception",
    x: [receptionX - counterWidth / 2, receptionX + counterWidth / 2],
    z: [receptionZ, entrance.z[0]],
  },
];
