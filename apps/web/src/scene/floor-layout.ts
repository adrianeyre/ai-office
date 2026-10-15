import {
  defaultFloorTheme,
  type Agent,
  type DeskDressing,
  type FloorTheme,
  type Role,
} from "@ai-office/shared";
import type { PaletteToken } from "@ai-office/shared/palette";

import type { Vec3 } from "./camera-rig.ts";
import {
  chairPieces,
  deskSet,
  deskSpacing,
  type DeskSet,
  type Rect,
} from "./desk-set.ts";
import { themeLayout } from "./floor-themes.ts";
import { liftCorePieces, liftDoorway, liftWall } from "./lift-layout.ts";
import { modelCatalogue } from "./model-catalogue.ts";
import type { ModelPlacement } from "./models.ts";
import { arcadePosterArt } from "./arcade-posters.ts";
import { posterArt, type PosterArt } from "./posters.ts";
import {
  lying,
  piece,
  placePieces,
  standing,
  turnPoint,
  type Piece,
  type PieceRole,
  type QuarterTurns,
  type Walkway,
} from "./pieces.ts";
import type { FloorPoint, Waypoint, WaypointGraph } from "./waypoints.ts";

// A Floor, generated from its Agents (PRD FR-57). Like the lobby it is a
// cut-away: the back and left walls stand, and the default view looks in
// from the front right. Along the back wall, from the left: the Manager's
// glass office, the meeting room with its whiteboard and table, the
// Floor's wall board and the bookshelf, the lift (where it is in the
// lobby) and the canteen with its coffee machine, kettle, microwave,
// fridge and café table. In front of them a corridor runs the Floor's
// width, past the water cooler; from it the lounge runs along the left
// wall (a fish tank, a sofa and a dartboard). From the lift an aisle runs
// to the front, between the desks on its left and, on its right, the
// printer and the gym: every piece of fitness equipment together on one
// mat (a treadmill, a weight bench, kettlebells, yoga mats, an exercise
// bike, a rowing machine, a punchbag, a weights rack of dumbbells and an
// exercise ball). The desks are rows of up to five, as many rows as the
// team needs, and the Floor grows towards the front to hold them. Across
// the front, in front of the desks, the gym and the theme's props, is the
// games hall (FR-61): a walkway the Floor's width, and beyond it a
// basketball hoop on the left wall, a putting green, the pool table, the
// table tennis table and the foosball table side by side, a chess table,
// bean bags round a television, a piano, a vending machine and an arcade
// machine. It moves forwards with the desks once a large team's rows
// reach it. Framed posters of classic adventure games hang on the walls
// (posters.ts): in the meeting room, along the corridor's end of the left
// wall and over the canteen's counter; and a gallery of classic arcade
// game posters (arcade-posters.ts) on the left wall between the dartboard
// and the basketball hoop.
//
// Every place an Agent walks to has a waypoint, joined by straight edges
// along the walkways: the lift, each desk, the rooms and the amenities.

/** What the layout needs of an Agent. */
/**
 * An Agent as its Floor is laid out and drawn: its desk is for its Role,
 * and it sits there as its Avatar (or, without one, an Avatar seeded from
 * its id), with a marker over it while it is paused (FR-62).
 */
export type FloorAgent = Pick<Agent, "id" | "role"> &
  Partial<Pick<Agent, "avatar" | "enabled" | "stage" | "contractor">> & {
    /**
     * Its Role's desk dressing in the Role library (FR-57, FR-98); the
     * built-in Role's, or a monitor, until the library is known.
     */
    readonly deskDressing?: DeskDressing | undefined;
  };

export const floorCeiling = 3;

/** The Floor's width, x from -10 to 10; its depth depends on the team. */
const halfWidth = 10;
const wallThickness = liftWall.thickness;
const [liftX, , backZ] = liftDoorway.position;
const liftLeft = liftX - liftWall.width / 2;
const liftRight = liftX + liftWall.width / 2;

/** The corridor along the rooms' fronts: 1.5 m, the spec's walkway. */
const corridor = { x: [-9.5, halfWidth], z: [-2, -0.5] } as const;
const corridorZ = (corridor.z[0] + corridor.z[1]) / 2;

/** The aisle from the lift to the front, between the desks and the gym. */
const aisle = { x: [liftX - 0.75, liftX + 0.75] } as const;

/** The Manager's glass office: 4 m × 4 m in the back left corner. */
export const managersOffice = {
  x: [-halfWidth, -6] as const,
  z: [backZ, -2] as const,
  /** Its door in the front wall, the spec's 0.9 m. */
  door: [-7.25, -6.35] as const,
} as const;

/**
 * The red light over the Manager's office door, lit while the Floor has an
 * action Notice (FR-62): a lamp across the glass above the door frame, its
 * face towards the open plan, so it is seen from the default view.
 */
export const managersLight = {
  centre: [
    (managersOffice.door[0] + managersOffice.door[1]) / 2,
    2.36,
    managersOffice.z[1] + 0.06,
  ] as Vec3,
  size: [0.8, 0.24, 0.1] as Vec3,
} as const;

/** The meeting room: 6 m × 4 m beside the office. */
export const meetingRoom = {
  x: [-6, 0] as const,
  z: [backZ, -2] as const,
  door: [-1.05, -0.15] as const,
} as const;

/**
 * The "in session" sign over the meeting room's door, lit while a Grilling
 * Session runs (FR-83): a lamp across the glass above the door frame, like
 * the Manager's red light, its face towards the open plan.
 */
export const inSessionSign = {
  centre: [
    (meetingRoom.door[0] + meetingRoom.door[1]) / 2,
    2.36,
    meetingRoom.z[1] + 0.06,
  ] as Vec3,
  size: [0.8, 0.24, 0.1] as Vec3,
} as const;

/** The whiteboard: 1.8 m × 1.2 m, its bottom edge 0.9 m up, on the meeting room's back wall. */
export const whiteboard = {
  centre: [-3.2, 1.5, backZ] as Vec3,
  width: 1.8,
  height: 1.2,
} as const;

/** The Floor's wall board: 1.6 m × 0.9 m, its centre 1.6 m up. */
export const wallBoard = {
  centre: [1, 1.6, backZ] as Vec3,
  width: 1.6,
  height: 0.9,
} as const;

/**
 * The company logo (`brand.logo`) on the left wall, as the lobby has it
 * behind reception: 2.4 m wide at the logo's 244:64 proportions, its
 * centre 2.1 m up over the open plan (clear of the Manager's office, the
 * water cooler and the desks), 3 mm proud of the wall and facing +x.
 */
export const floorLogo = {
  position: [-halfWidth + 0.003, 2.1, 2] as Vec3,
  size: [2.4, (2.4 * 64) / 244] as const,
  /** Turned from facing +z to facing +x. */
  rotationY: Math.PI / 2,
} as const;

/**
 * A poster on the wall (posters.ts): its art 0.5 m × 0.7 m, in a frame
 * 2.5 cm wider all round and 2 cm deep, with the art 2 mm proud of it.
 */
export const posterSize = {
  art: [0.5, 0.7] as const,
  frame: 0.025,
  depth: 0.02,
} as const;

/** A framed poster, hung. */
export interface WallPoster {
  readonly art: PosterArt;
  /** The middle of its art's face. */
  readonly centre: Vec3;
  /** Turned from facing +z: 0 on the back wall, a quarter turn (facing +x) on the left wall. */
  readonly rotationY: number;
}

/** The back wall's face, under the meeting room's and the canteen's paint. */
const featureWallFace = backZ + 0.02;
const proud = posterSize.depth + 0.002;

/**
 * Where the nine adventure game posters hang (FR-61), in posterArt's order,
 * each clear of the windows, doors, boards, shelves and dartboard, and of
 * the theme's zone, which a theme may dress (floor-themes.ts): four on the
 * meeting room's back wall, two either side of the whiteboard; three along
 * the left wall at the corridor's end, between the Manager's office and
 * the logo, over the water cooler and the fish tank; and two over the
 * canteen's counter, above the coffee machine. Each is seen from the
 * default overview.
 */
const posterPlaces: readonly Omit<WallPoster, "art">[] = [
  ...[-5.22, -4.52, -1.88, -1.18].map((x) => ({
    centre: [x, 1.65, featureWallFace + proud] as Vec3,
    rotationY: 0,
  })),
  ...[-1.45, -0.6, 0.25].map((z) => ({
    centre: [-halfWidth + proud, 1.65, z] as Vec3,
    rotationY: Math.PI / 2,
  })),
  ...[7, 8.2].map((x) => ({
    centre: [x, 1.9, featureWallFace + proud] as Vec3,
    rotationY: 0,
  })),
];

/**
 * Where the eight arcade game posters hang (arcade-posters.ts), in
 * arcadePosterArt's order: a gallery of two rows of four on the left wall,
 * between the dartboard and the basketball hoop. They begin past the
 * theme's zone (z 8), whose props stand against the wall, so the darts
 * players' end of the lounge stays clear, and end short of the hoop's
 * backboard on the smallest Floor (its rim 2.6 m beyond the games hall's
 * walkway, which starts at z 8 at the nearest); a larger team only moves
 * the hoop further forwards. Like the others, each hangs above head
 * height, seen over the furniture from the default overview.
 */
export const arcadePosterPlaces: readonly Omit<WallPoster, "art">[] = [
  2.38, 1.6,
].flatMap((y) =>
  [8.45, 9.07, 9.69, 10.31].map((z) => ({
    centre: [-halfWidth + proud, y, z] as Vec3,
    rotationY: Math.PI / 2,
  })),
);

export const wallPosters: readonly WallPoster[] = [
  ...posterArt.flatMap((art, index) => {
    const place = posterPlaces[index];
    return place === undefined ? [] : [{ art, ...place }];
  }),
  ...arcadePosterArt.flatMap((art, index) => {
    const place = arcadePosterPlaces[index];
    return place === undefined ? [] : [{ art, ...place }];
  }),
];

/** Each poster's frame: a dark box on the wall, behind its art. */
function posterFramePieces(): Piece[] {
  const [width, height] = posterSize.art;
  const { frame, depth } = posterSize;
  return wallPosters.map(({ centre: [x, y, z], rotationY }, index) => {
    const onLeftWall = rotationY !== 0;
    const back = proud - depth / 2;
    return piece(
      `poster frame ${String(index + 1)}`,
      "box",
      "metal-dark",
      "metal",
      "architecture",
      onLeftWall
        ? [depth, height + 2 * frame, width + 2 * frame]
        : [width + 2 * frame, height + 2 * frame, depth],
      onLeftWall ? [x - back, y, z] : [x, y, z - back],
    );
  });
}

/** The desks' columns, right to left from the aisle: 2.4 m apart. */
const deskColumns = [3.3, 0.9, -1.5, -3.9, -6.3] as const;
export const maxDesksPerRow = deskColumns.length;
/** The first row's desks' centres, just in front of the corridor. */
const firstRowZ = -0.1;
/** From a desk's centre to the middle of the walkway behind its chair. */
const behindChair = 1.7;

/** Spots on every Floor that Agents walk to, by waypoint id. */
export const floorSpots = [
  "lift",
  "managers-office",
  "meeting-room",
  "whiteboard",
  "wall-board",
  "bookshelf",
  "coffee-machine",
  "water-cooler",
  "gym",
  // Amenities only idle Agents go to (idle-behaviours.ts).
  "lounge-sofa",
  "fish-tank",
  "darts",
  "kettle",
  "microwave",
  "fridge",
  "cafe-table",
  "canteen-plant",
  "printer",
  // The gym's, beside the aisle.
  "kettlebells",
  "weight-bench",
  "treadmill",
  "yoga-mats",
  "exercise-bike",
  "rowing-machine",
  "dumbbells",
  "punchbag",
  // The games hall's, from the left wall.
  "basketball",
  "putting-green",
  "pool-table",
  "table-tennis",
  "foosball",
  "chess-table",
  "bean-bags",
  "piano",
  "arcade",
  "vending-machine",
] as const;
export type FloorSpot = (typeof floorSpots)[number];

/** A desk's waypoint id. */
export const deskWaypoint = (agentId: string) => `desk:${agentId}`;

export interface FloorDesk extends DeskSet {
  readonly agentId: string;
  readonly role: Role;
  readonly zone: "open plan" | "manager's office";
  /** The waypoint the Agent walks to, to sit at it. */
  readonly waypoint: string;
}

export interface FloorLayout {
  /** The Floor's extent, wall to open edge. */
  readonly bounds: Rect;
  readonly pieces: readonly Piece[];
  readonly models: readonly ModelPlacement[];
  /** One per Agent, in the order the Agents came. */
  readonly desks: readonly FloorDesk[];
  readonly walkways: readonly Walkway[];
  readonly waypoints: WaypointGraph;
  /** The meeting room's ten seats, on the floor. */
  readonly meetingSeats: readonly Vec3[];
  /**
   * The meeting room's spare chairs along its left wall, on the floor:
   * none unless the team is larger than the table seats (FR-83).
   */
  readonly meetingWallSeats: readonly Vec3[];
  /** Under each desk and chair: Low's soft contact shadows. */
  readonly contactShadows: readonly Rect[];
}

const wall = (name: string, size: Vec3, position: Vec3) =>
  piece(name, "box", "wall", "paint", "architecture", size, position);

/** The height of a glass partition's solid base (the spec: glass from 0.9 m). */
const glassFrom = 0.9;
const doorHeight = 2.1;

/**
 * A glass partition: a solid base to 0.9 m, glass to the ceiling and a
 * frame. It runs along x at `z` (or along z at `x`) from `from` to `to`,
 * with a doorway (the spec's door, 0.9 m × 2.1 m) between `door`'s ends.
 */
function partition(
  name: string,
  along: "x" | "z",
  at: number,
  [from, to]: readonly [number, number],
  door?: readonly [number, number],
): Piece[] {
  const box = (
    part: string,
    token: PaletteToken,
    surface: Piece["surface"],
    length: number,
    thickness: number,
    [bottom, top]: readonly [number, number],
    middle: number,
  ): Piece =>
    piece(
      `${name}, ${part}`,
      "box",
      token,
      surface,
      "architecture",
      along === "x"
        ? [length, top - bottom, thickness]
        : [thickness, top - bottom, length],
      along === "x"
        ? [middle, (top + bottom) / 2, at]
        : [at, (top + bottom) / 2, middle],
    );
  const runs =
    door === undefined
      ? [[from, to]]
      : [
          [from, door[0]],
          [door[1], to],
        ];
  const pieces = runs.flatMap(([start = 0, end = 0], index) => [
    box(
      `base ${String(index + 1)}`,
      "wall",
      "paint",
      end - start,
      0.1,
      [0, glassFrom],
      (start + end) / 2,
    ),
    box(
      `glass ${String(index + 1)}`,
      "glass",
      "glass",
      end - start,
      0.02,
      [glassFrom, floorCeiling],
      (start + end) / 2,
    ),
    ...[start + 0.025, end - 0.025].map((post, side) =>
      box(
        `post ${String(index + 1)}.${String(side + 1)}`,
        "metal-dark",
        "metal",
        0.05,
        0.08,
        [glassFrom, floorCeiling],
        post,
      ),
    ),
  ]);
  if (door === undefined) {
    return pieces;
  }
  const [left, right] = door;
  return [
    ...pieces,
    box(
      "glass over the door",
      "glass",
      "glass",
      right - left,
      0.02,
      [doorHeight, floorCeiling],
      (left + right) / 2,
    ),
    box(
      "door frame, top",
      "metal-dark",
      "metal",
      right - left,
      0.08,
      [doorHeight - 0.05, doorHeight],
      (left + right) / 2,
    ),
    ...[left + 0.025, right - 0.025].map((post, side) =>
      box(
        `door frame ${String(side + 1)}`,
        "metal-dark",
        "metal",
        0.05,
        0.12,
        [0, doorHeight],
        post,
      ),
    ),
  ];
}

/** A board on the back wall, its face towards +z: felt in a wooden frame. */
function wallBoardPieces(): Piece[] {
  const [x, y] = wallBoard.centre;
  const z = backZ;
  const frame = 0.05;
  return [
    piece(
      "wall board, felt",
      "box",
      "floor-carpet",
      "fabric",
      "architecture",
      [wallBoard.width, wallBoard.height, 0.02],
      [x, y, z + 0.01],
    ),
    ...[-1, 1].map((side) =>
      piece(
        `wall board frame, ${side < 0 ? "bottom" : "top"}`,
        "box",
        "desk-top",
        "wood",
        "architecture",
        [wallBoard.width, frame, 0.04],
        [x, y + side * (wallBoard.height / 2 - frame / 2), z + 0.02],
      ),
    ),
    ...[-1, 1].map((side) =>
      piece(
        `wall board frame, ${side < 0 ? "left" : "right"}`,
        "box",
        "desk-top",
        "wood",
        "architecture",
        [frame, wallBoard.height - 2 * frame, 0.04],
        [x + side * (wallBoard.width / 2 - frame / 2), y, z + 0.02],
      ),
    ),
  ];
}

/** The whiteboard on the meeting room's feature wall, with its frame and tray. */
function whiteboardPieces(): Piece[] {
  const [x, y] = whiteboard.centre;
  const z = backZ + 0.02;
  const frame = 0.03;
  return [
    piece(
      "whiteboard",
      "box",
      "paper",
      "paint",
      "architecture",
      [whiteboard.width, whiteboard.height, 0.02],
      [x, y, z + 0.01],
    ),
    ...[-1, 1].map((side) =>
      piece(
        `whiteboard frame, ${side < 0 ? "bottom" : "top"}`,
        "box",
        "metal-light",
        "metal",
        "architecture",
        [whiteboard.width + 2 * frame, frame, 0.03],
        [x, y + side * (whiteboard.height / 2 + frame / 2), z + 0.015],
      ),
    ),
    ...[-1, 1].map((side) =>
      piece(
        `whiteboard frame, ${side < 0 ? "left" : "right"}`,
        "box",
        "metal-light",
        "metal",
        "architecture",
        [frame, whiteboard.height, 0.03],
        [x + side * (whiteboard.width / 2 + frame / 2), y, z + 0.015],
      ),
    ),
    piece(
      "whiteboard tray",
      "box",
      "metal-light",
      "metal",
      "architecture",
      [1, 0.02, 0.07],
      [x, y - whiteboard.height / 2 - frame - 0.01, z + 0.035],
    ),
  ];
}

/** A chair facing `turns` (0: -z), its centre at `x`, `z`. */
const chairAt = (
  name: string,
  at: readonly [number, number],
  turns: QuarterTurns,
) => placePieces(chairPieces(name), turns, at);

const chairRect = ([x, z]: readonly [number, number]): Rect => ({
  x: [x - 0.25, x + 0.25],
  z: [z - 0.25, z + 0.25],
});

const tableCentre = [-3.2, -3.9] as const;
const tableSize = [3.6, 1.2] as const;

/** The meeting room's table: its centre on the floor, and its size. */
export const meetingTable = { centre: tableCentre, size: tableSize } as const;

/** The meeting room's ten chairs: four each side of the table and one at each end. */
const meetingChairs: { at: readonly [number, number]; turns: QuarterTurns }[] =
  [
    ...[-4.55, -3.65, -2.75, -1.85].flatMap((x) => [
      { at: [x, tableCentre[1] - 0.9] as const, turns: 2 as const },
      { at: [x, tableCentre[1] + 0.9] as const, turns: 0 as const },
    ]),
    {
      at: [tableCentre[0] - tableSize[0] / 2 - 0.35, tableCentre[1]],
      turns: 3,
    },
    {
      at: [tableCentre[0] + tableSize[0] / 2 + 0.35, tableCentre[1]],
      turns: 1,
    },
  ];

/**
 * The meeting room's spare chairs, along its left wall behind the table's
 * back row, facing +x (into the room): set out only for a team larger
 * than the table seats, so a Grilling Session can seat it (FR-83). They
 * stand clear of the walks to the table's chairs: the end chair beside
 * them is reached from the front, the back row along the back walkway.
 */
export const meetingWallChairs: readonly {
  readonly at: readonly [number, number];
  readonly turns: QuarterTurns;
}[] = [
  { at: [-5.72, -5.4], turns: 3 },
  { at: [-5.72, -4.7], turns: 3 },
];

/**
 * The spare chairs a team needs: one for each Agent beyond the nine the
 * table seats besides the Manager, up to `meetingWallChairs`.
 */
export const spareMeetingChairs = (openPlan: number) =>
  meetingWallChairs.slice(
    0,
    Math.max(0, openPlan - (meetingChairs.length - 1)),
  );

function meetingRoomPieces(): Piece[] {
  const [x, z] = tableCentre;
  return [
    piece(
      "meeting room, feature wall",
      "box",
      "wall-feature",
      "paint",
      "architecture",
      [meetingRoom.x[1] - meetingRoom.x[0], floorCeiling, 0.02],
      [
        (meetingRoom.x[0] + meetingRoom.x[1]) / 2,
        floorCeiling / 2,
        backZ + 0.01,
      ],
    ),
    ...whiteboardPieces(),
    ...partition(
      "meeting room front",
      "x",
      meetingRoom.z[1],
      [meetingRoom.x[0], meetingRoom.x[1]],
      meetingRoom.door,
    ),
    ...partition("meeting room side", "z", meetingRoom.x[1], [
      backZ,
      meetingRoom.z[1],
    ]),
    piece(
      "meeting table, top",
      "box",
      "desk-top",
      "wood",
      "furniture",
      [tableSize[0], 0.04, tableSize[1]],
      [x, 0.72, z],
    ),
    ...[-1, 1].map((side) =>
      standing(
        `meeting table, ${side < 0 ? "left" : "right"} foot`,
        "metal-dark",
        "metal",
        "furniture",
        [0.1, 0.7, 0.8],
        [x + side * 1.3, z],
      ),
    ),
    ...meetingChairs.flatMap(({ at, turns }, index) =>
      chairAt(`meeting chair ${String(index + 1)}`, at, turns),
    ),
  ];
}

const managerDeskCentre = [-8.2, -4.4] as const;

function managersOfficePieces(): Piece[] {
  return [
    ...partition(
      "Manager's office front",
      "x",
      managersOffice.z[1],
      [managersOffice.x[0], managersOffice.x[1]],
      managersOffice.door,
    ),
    ...partition("Manager's office side", "z", managersOffice.x[1], [
      backZ,
      managersOffice.z[1],
    ]),
  ];
}

const counter = { x: [6.6, 8.8], depth: 0.6, height: 0.9 } as const;
const cafeTable = [9.2, -3.4] as const;

function canteenPieces(): Piece[] {
  const counterX = (counter.x[0] + counter.x[1]) / 2;
  const counterZ = backZ + counter.depth / 2;
  const width = counter.x[1] - counter.x[0];
  return [
    piece(
      "canteen, feature wall",
      "box",
      "wall-feature",
      "paint",
      "architecture",
      [halfWidth - liftRight, floorCeiling, 0.02],
      [(liftRight + halfWidth) / 2, floorCeiling / 2, backZ + 0.01],
    ),
    standing(
      "canteen counter",
      "wall",
      "paint",
      "furniture",
      [width, counter.height - 0.04, counter.depth],
      [counterX, counterZ],
    ),
    piece(
      "canteen counter, worktop",
      "box",
      "desk-top",
      "wood",
      "furniture",
      [width + 0.02, 0.04, counter.depth + 0.02],
      [counterX, counter.height - 0.02, counterZ],
    ),
    piece(
      "kettle",
      "cylinder",
      "metal-light",
      "metal",
      "prop",
      [0.16, 0.22, 0.16],
      [6.85, counter.height + 0.11, counterZ],
    ),
    piece(
      "microwave",
      "box",
      "ink",
      "plastic",
      "prop",
      [0.5, 0.3, 0.38],
      [8.5, counter.height + 0.15, counterZ - 0.05],
    ),
    piece(
      "microwave, door",
      "box",
      "screen-off",
      "screen",
      "prop",
      [0.3, 0.2, 0.01],
      [8.45, counter.height + 0.15, counterZ + 0.145],
    ),
    piece(
      "canteen mug",
      "cylinder",
      "ceramic",
      "plastic",
      "prop",
      [0.08, 0.1, 0.08],
      [7.95, counter.height + 0.05, counterZ + 0.1],
    ),
    piece(
      "café table, top",
      "cylinder",
      "desk-top",
      "wood",
      "furniture",
      [0.8, 0.04, 0.8],
      [cafeTable[0], 0.72, cafeTable[1]],
    ),
    standing(
      "café table, post",
      "metal-dark",
      "metal",
      "furniture",
      [0.08, 0.7, 0.08],
      cafeTable,
      "cylinder",
    ),
    standing(
      "café table, foot",
      "metal-dark",
      "metal",
      "furniture",
      [0.45, 0.03, 0.45],
      cafeTable,
      "cylinder",
    ),
    ...chairAt("café chair 1", [cafeTable[0], cafeTable[1] - 0.75], 2),
    ...chairAt("café chair 2", [cafeTable[0], cafeTable[1] + 0.75], 0),
  ];
}

/**
 * The gym beside the aisle (FR-61): every piece of fitness equipment on
 * one mat, from the corridor to the games hall. Its back half, off the
 * walkway into it, has the treadmill, the weight bench, the kettlebells
 * and the yoga mats; its front half, off the walkway through it, the
 * exercise bike and the rowing machine (their riders facing the front),
 * the punchbag, the weights rack of dumbbells and an exercise ball.
 */
export const gym = {
  x: [6.6, halfWidth] as const,
  z: [0, 7.9] as const,
  treadmill: [9.3, 1.3] as const,
  weightBench: [7.4, 3.2] as const,
  kettlebellRack: [9.55, 3.3] as const,
  /** The two yoga mats, along z, side by side: their middles. */
  yogaMats: [
    [8.05, 2.9],
    [8.7, 2.9],
  ] as const,
  /** The exercise bike and the rowing machine: their middles. */
  exerciseBike: [6.95, 6.1] as const,
  rowingMachine: [7.75, 6.45] as const,
  /** The punchbag's centre; its stand is behind it, at +x. */
  punchbag: [9.45, 5.9] as const,
  weightsRack: [8.95, 7.55] as const,
  exerciseBall: [6.95, 7.45] as const,
  /** Into its back half, from the aisle. */
  walkwayIn: { x: [aisle.x[1], 8.8] as const, z: [0.45, 1.95] as const },
  /** Through it, from the aisle, between its two halves. */
  walkwayThrough: {
    x: [aisle.x[1], halfWidth] as const,
    z: [3.85, 5.35] as const,
  },
} as const;

/**
 * The recumbent exercise bike about its middle, facing +x: its rider sits
 * back on its seat, behind the pedals and the flywheel.
 */
function exerciseBikePieces(): Piece[] {
  return [
    piece(
      "exercise bike, seat",
      "box",
      "chair",
      "fabric",
      "furniture",
      [0.4, 0.08, 0.4],
      [-0.35, 0.42, 0],
    ),
    piece(
      "exercise bike, backrest",
      "box",
      "chair",
      "fabric",
      "furniture",
      [0.08, 0.45, 0.4],
      [-0.57, 0.7, 0],
    ),
    standing(
      "exercise bike, frame",
      "metal-dark",
      "metal",
      "furniture",
      [1.3, 0.12, 0.12],
      [0, 0],
    ),
    standing(
      "exercise bike, seat post",
      "metal-dark",
      "metal",
      "furniture",
      [0.08, 0.38, 0.08],
      [-0.35, 0],
    ),
    standing(
      "exercise bike, column",
      "metal-dark",
      "metal",
      "furniture",
      [0.1, 0.6, 0.1],
      [0.5, 0],
    ),
    piece(
      "exercise bike, console",
      "box",
      "screen-glow",
      "screen",
      "furniture",
      [0.06, 0.12, 0.2],
      [0.48, 0.66, 0],
    ),
    lying(
      "z",
      piece(
        "exercise bike, flywheel",
        "cylinder",
        "metal-light",
        "metal",
        "furniture",
        [0.32, 0.32, 0.06],
        [0.5, 0.3, 0],
      ),
    ),
    ...[-1, 1].flatMap((side) => [
      piece(
        `exercise bike, ${side < 0 ? "left" : "right"} pedal`,
        "box",
        "ink",
        "plastic",
        "furniture",
        [0.1, 0.03, 0.05],
        [0.25, 0.3, side * 0.13],
      ),
      piece(
        `exercise bike, ${side < 0 ? "left" : "right"} grip`,
        "box",
        "metal-dark",
        "metal",
        "furniture",
        [0.25, 0.03, 0.03],
        [-0.3, 0.55, side * 0.235],
      ),
    ]),
  ];
}

/** The rowing machine about its middle, facing +x: its seat on a rail, before its flywheel. */
function rowingMachinePieces(): Piece[] {
  return [
    piece(
      "rowing machine, rail",
      "box",
      "metal-dark",
      "metal",
      "furniture",
      [2, 0.06, 0.14],
      [0, 0.36, 0],
    ),
    ...[-1, 1].map((side) =>
      standing(
        `rowing machine, ${side < 0 ? "back" : "front"} foot`,
        "metal-dark",
        "metal",
        "furniture",
        [0.08, 0.33, 0.5],
        [side * 0.95, 0],
      ),
    ),
    piece(
      "rowing machine, seat",
      "box",
      "ink",
      "plastic",
      "furniture",
      [0.32, 0.06, 0.3],
      [-0.75, 0.42, 0],
    ),
    ...[-1, 1].map((side) =>
      piece(
        `rowing machine, ${side < 0 ? "left" : "right"} footrest`,
        "box",
        "ink",
        "plastic",
        "furniture",
        [0.12, 0.05, 0.12],
        [0.15, 0.42, side * 0.12],
      ),
    ),
    lying(
      "z",
      piece(
        "rowing machine, flywheel",
        "cylinder",
        "metal-light",
        "metal",
        "furniture",
        [0.46, 0.46, 0.12],
        [0.75, 0.4, 0],
      ),
    ),
    piece(
      "rowing machine, handle",
      "box",
      "metal-light",
      "metal",
      "furniture",
      [0.05, 0.03, 0.45],
      [0.45, 0.55, 0],
    ),
  ];
}

/** The punchbag about its centre, hung from its stand's arm behind it, at +x. */
function punchbagPieces(): Piece[] {
  return [
    standing(
      "punchbag stand, base",
      "metal-dark",
      "metal",
      "furniture",
      [0.6, 0.03, 0.6],
      [0.2, 0],
    ),
    standing(
      "punchbag stand, post",
      "metal-dark",
      "metal",
      "furniture",
      [0.08, 2.5, 0.08],
      [0.42, 0],
    ),
    piece(
      "punchbag stand, arm",
      "box",
      "metal-dark",
      "metal",
      "furniture",
      [0.46, 0.06, 0.06],
      [0.21, 2.45, 0],
    ),
    piece(
      "punchbag, chain",
      "cylinder",
      "metal-light",
      "metal",
      "furniture",
      [0.015, 0.32, 0.015],
      [0, 2.26, 0],
    ),
    piece(
      "punchbag",
      "cylinder",
      "state-critical",
      "fabric",
      "furniture",
      [0.38, 1, 0.38],
      [0, 1.6, 0],
    ),
  ];
}

/** The weights rack about its middle: two shelves of dumbbells on their uprights. */
function weightsRackPieces(): Piece[] {
  return [
    ...(
      [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const
    ).map(([sx, sz], index) =>
      standing(
        `weights rack, upright ${String(index + 1)}`,
        "metal-dark",
        "metal",
        "furniture",
        [0.04, 0.8, 0.04],
        [sx * 0.63, sz * 0.2],
      ),
    ),
    ...[0.35, 0.7].flatMap((y, shelf) => [
      piece(
        `weights rack, shelf ${String(shelf + 1)}`,
        "box",
        "metal-light",
        "metal",
        "furniture",
        [1.3, 0.03, 0.45],
        [0, y, 0],
      ),
      ...[-0.45, -0.15, 0.15, 0.45].flatMap((dx, index) => {
        const name = `dumbbell ${String(shelf * 4 + index + 1)}`;
        const size = 0.09 + (shelf === 0 ? 0.03 : 0) + index * 0.006;
        return [
          lying(
            "z",
            piece(
              name,
              "cylinder",
              "metal-light",
              "metal",
              "prop",
              [0.025, 0.025, 0.3],
              [dx, y + 0.015 + size / 2, 0],
            ),
          ),
          ...[-1, 1].map((side) =>
            lying(
              "z",
              piece(
                `${name}, weight ${side < 0 ? "behind" : "ahead"}`,
                "cylinder",
                "ink",
                "metal",
                "prop",
                [size, size, 0.05],
                [dx, y + 0.015 + size / 2, side * 0.12],
              ),
            ),
          ),
        ];
      }),
    ]),
  ];
}

function gymPieces(): Piece[] {
  const { treadmill } = gym;
  // Its deck is low, so an Agent jogging on its belt stands on it.
  const deck = 0.06;
  const [benchX, benchZ] = gym.weightBench;
  const [rackX, rackZ] = gym.kettlebellRack;
  return [
    // The mat under it all, just short of the Floor's open edge.
    standing(
      "gym mat",
      "floor-carpet",
      "fabric",
      "architecture",
      [gym.x[1] - 0.1 - gym.x[0], 0.01, gym.z[1] - gym.z[0]],
      [(gym.x[0] + gym.x[1] - 0.1) / 2, (gym.z[0] + gym.z[1]) / 2],
    ),
    // A treadmill, its runner facing -z.
    standing(
      "treadmill, deck",
      "metal-dark",
      "metal",
      "furniture",
      [0.8, deck, 1.8],
      treadmill,
    ),
    piece(
      "treadmill, belt",
      "box",
      "ink",
      "fabric",
      "furniture",
      [0.6, 0.01, 1.6],
      [treadmill[0], deck + 0.005, treadmill[1]],
    ),
    ...[-1, 1].map((side) =>
      standing(
        `treadmill, ${side < 0 ? "left" : "right"} upright`,
        "metal-light",
        "metal",
        "furniture",
        [0.05, 1.15, 0.05],
        [treadmill[0] + side * 0.35, treadmill[1] - 0.8],
      ),
    ),
    piece(
      "treadmill, console",
      "box",
      "metal-dark",
      "metal",
      "furniture",
      [0.75, 0.08, 0.3],
      [treadmill[0], 1.15, treadmill[1] - 0.7],
    ),
    // A weight bench, and a rack of kettlebells.
    piece(
      "weight bench, pad",
      "box",
      "chair",
      "fabric",
      "furniture",
      [0.3, 0.1, 1.2],
      [benchX, 0.45, benchZ],
    ),
    standing(
      "weight bench, frame",
      "metal-dark",
      "metal",
      "furniture",
      [0.1, 0.4, 1],
      gym.weightBench,
    ),
    standing(
      "kettlebell rack",
      "metal-light",
      "metal",
      "furniture",
      [0.45, 0.5, 0.9],
      gym.kettlebellRack,
    ),
    ...[-0.3, 0, 0.3].map((offset, index) =>
      piece(
        `kettlebell ${String(index + 1)}`,
        "sphere",
        "metal-dark",
        "metal",
        "prop",
        [0.2, 0.2, 0.2],
        [rackX, 0.6, rackZ + offset],
      ),
    ),
    // The yoga mats, between the bench and the kettlebells, on the mat.
    ...gym.yogaMats.map(([x, z], index) =>
      piece(
        `yoga mat ${String(index + 1)}`,
        "box",
        index === 0 ? "stage-qa" : "stage-docs",
        "fabric",
        "architecture",
        [0.6, 0.006, 1.8],
        [x, 0.013, z],
      ),
    ),
    // The bike and the rower turned to face the front (+z), the punchbag
    // with its stand at the Floor's edge, and the weights rack at the back.
    ...placePieces(exerciseBikePieces(), 3, gym.exerciseBike),
    ...placePieces(rowingMachinePieces(), 3, gym.rowingMachine),
    ...placePieces(punchbagPieces(), 0, gym.punchbag),
    ...placePieces(weightsRackPieces(), 0, gym.weightsRack),
    standing(
      "exercise ball",
      "sofa",
      "plastic",
      "prop",
      [0.65, 0.65, 0.65],
      gym.exerciseBall,
      "sphere",
    ),
  ];
}

/** The water cooler at the corridor's end: 0.35 m × 0.35 m × 1.1 m. */
const waterCooler = [-9.75, corridorZ] as const;

function waterCoolerPieces(): Piece[] {
  const [x, z] = waterCooler;
  return [
    standing(
      "water cooler",
      "ceramic",
      "plastic",
      "prop",
      [0.35, 0.75, 0.35],
      [x, z],
    ),
    piece(
      "water cooler, bottle",
      "cylinder",
      "glass",
      "glass",
      "prop",
      [0.28, 0.35, 0.28],
      [x, 0.925, z],
    ),
    piece(
      "water cooler, tap",
      "box",
      "metal-dark",
      "metal",
      "prop",
      [0.04, 0.04, 0.04],
      [x + 0.19, 0.62, z],
    ),
  ];
}

/**
 * The lounge along the left wall, in front of the corridor: a fish tank
 * on its cabinet, a sofa under the logo and a dartboard, with a walkway
 * beside them (x from -9 to -7.5) clear of the desks.
 */
export const lounge = {
  fishTank: [-9.775, 0.2] as const,
  sofa: { at: [-9.525, 2] as const, length: 2 },
  /** The dartboard's centre on the wall, 1.73 m up as the rules say. */
  dartboard: [-halfWidth + 0.02, 1.73, 3.85] as Vec3,
  walkway: { x: [-9, -7.5] as const, z: [corridor.z[1], 4.3] as const },
} as const;

/**
 * A dartboard's rings, by their outer radii in metres, as the rules have
 * them: the bull, the outer bull, the trebles' and the doubles' rings,
 * and the board to its rim.
 */
export const dartboardRings = {
  bull: 0.0064,
  outerBull: 0.016,
  treble: [0.099, 0.107],
  double: [0.162, 0.17],
  board: 0.226,
} as const;

/**
 * The dartboard on the lounge's wall, facing +x (FR-61): a black board,
 * its twenty segments black and cream in turn, the doubles and trebles
 * red on the black and green on the cream, the green outer bull and the
 * red bull, and three darts in it. Each ring is a layer of slices a
 * little proud of the one under it, so only its band shows.
 */
function dartboardPieces(): Piece[] {
  const [x, y, z] = lounge.dartboard;
  const { bull, outerBull, treble, double, board } = dartboardRings;
  const baseDepth = 0.04;
  const layerDepth = 0.003;
  const face = x + baseDepth / 2;
  // The 20 at the top: its segment centred straight up.
  const segment = (2 * Math.PI) / 20;
  const layer = (
    name: string,
    token: PaletteToken,
    radius: number,
    depth: number,
    arc?: readonly [number, number],
  ): Piece => ({
    ...lying(
      "x",
      piece(
        name,
        "cylinder",
        token,
        "fabric",
        "prop",
        [layerDepth, 2 * radius, 2 * radius],
        [face + (depth - 0.5) * layerDepth, y, z],
      ),
    ),
    ...(arc === undefined ? {} : { arc }),
  });
  const slices = (
    ring: string,
    radius: number,
    depth: number,
    tokens: readonly [PaletteToken, PaletteToken],
  ) =>
    Array.from({ length: 20 }, (_, index) =>
      layer(
        `dartboard, ${ring} ${String(index + 1)}`,
        tokens[index % 2] ?? "ink",
        radius,
        depth,
        [Math.PI / 2 - segment / 2 + index * segment, segment],
      ),
    );
  return [
    {
      ...lying(
        "x",
        piece(
          "dartboard",
          "cylinder",
          "ink",
          "fabric",
          "prop",
          [baseDepth, 2 * board, 2 * board],
          [x, y, z],
        ),
      ),
    },
    ...slices("double", double[1], 1, ["state-critical", "plant"]),
    ...slices("single", double[0], 2, ["ink", "ceramic"]),
    ...slices("treble", treble[1], 3, ["state-critical", "plant"]),
    ...slices("inner single", treble[0], 4, ["ink", "ceramic"]),
    layer("dartboard, outer bull", "plant", outerBull, 5),
    layer("dartboard, bull", "state-critical", bull, 6),
    // Three darts in the board, from the last throw.
    ...(
      [
        [0.05, 0.02],
        [-0.03, -0.06],
        [0.1, -0.03],
      ] as const
    ).flatMap(([dy, dz], index) => [
      lying(
        "x",
        piece(
          `dart in the board ${String(index + 1)}`,
          "cylinder",
          "metal-light",
          "metal",
          "prop",
          [0.07, 0.008, 0.008],
          [face + 0.035, y + dy, z + dz],
        ),
      ),
      piece(
        `dart in the board ${String(index + 1)}, flight`,
        "box",
        "state-warning",
        "plastic",
        "prop",
        [0.025, 0.03, 0.003],
        [face + 0.075, y + dy, z + dz],
      ),
    ]),
  ];
}

function loungePieces(): Piece[] {
  const [tankX, tankZ] = lounge.fishTank;
  const [sofaX, sofaZ] = lounge.sofa.at;
  const sofaSeat = 0.42;
  const [, , dartZ] = lounge.dartboard;
  return [
    standing(
      "fish tank, cabinet",
      "metal-dark",
      "metal",
      "furniture",
      [0.45, 0.7, 0.8],
      [tankX, tankZ],
    ),
    piece(
      "fish tank",
      "box",
      "glass",
      "glass",
      "prop",
      [0.4, 0.42, 0.76],
      [tankX, 0.91, tankZ],
    ),
    piece(
      "fish tank, gravel",
      "box",
      "light-ground",
      "paint",
      "prop",
      [0.38, 0.04, 0.74],
      [tankX, 0.72, tankZ],
    ),
    ...(
      [
        [0.06, 0.95, -0.15, "state-warning"],
        [-0.05, 0.85, 0.12, "sofa"],
        [0.04, 1.0, 0.22, "stage-work"],
      ] as const
    ).map(([dx, y, dz, token], index) =>
      piece(
        `fish ${String(index + 1)}`,
        "sphere",
        token,
        "plastic",
        "prop",
        [0.03, 0.05, 0.09],
        [tankX + dx, y, tankZ + dz],
      ),
    ),
    piece(
      "fish tank, weed",
      "cylinder",
      "plant",
      "plastic",
      "prop",
      [0.04, 0.3, 0.04],
      [tankX - 0.1, 0.89, tankZ - 0.25],
    ),
    // The sofa faces +x, its back to the wall, low under the logo.
    standing(
      "lounge sofa, seat",
      "sofa",
      "fabric",
      "furniture",
      [0.85, sofaSeat, lounge.sofa.length],
      [sofaX, sofaZ],
    ),
    piece(
      "lounge sofa, back",
      "box",
      "sofa",
      "fabric",
      "furniture",
      [0.2, 0.45, lounge.sofa.length],
      [sofaX - 0.33, sofaSeat + 0.225, sofaZ],
    ),
    ...[-1, 1].map((side) =>
      standing(
        `lounge sofa, ${side < 0 ? "back" : "front"} arm`,
        "sofa",
        "fabric",
        "furniture",
        [0.85, 0.62, 0.2],
        [sofaX, sofaZ + side * (lounge.sofa.length / 2 + 0.1)],
      ),
    ),
    piece(
      "lounge sofa, cushion",
      "box",
      "stage-qa",
      "fabric",
      "prop",
      [0.12, 0.3, 0.35],
      [sofaX - 0.17, sofaSeat + 0.17, sofaZ - 0.6],
    ),
    ...dartboardPieces(),
    piece(
      "darts throw line",
      "box",
      "state-warning",
      "paint",
      "architecture",
      [0.04, 0.005, 0.6],
      [-7.65, 0.0025, dartZ],
    ),
  ];
}

/** The printer beside the aisle, between the desks' aisle and the gym. */
export const printerAt = [6.2, 3] as const;

function printerPieces(): Piece[] {
  const [x, z] = printerAt;
  return [
    standing(
      "printer, stand",
      "metal-dark",
      "metal",
      "furniture",
      [0.5, 0.75, 0.5],
      [x, z],
    ),
    piece(
      "printer",
      "box",
      "metal-light",
      "plastic",
      "prop",
      [0.55, 0.3, 0.45],
      [x, 0.9, z],
    ),
    piece(
      "printer, paper",
      "box",
      "paper",
      "paint",
      "prop",
      [0.03, 0.02, 0.21],
      [x - 0.28, 0.86, z],
    ),
  ];
}

/**
 * The games hall across the Floor's front (FR-61): its walkway, the
 * Floor's width, starts in front of the gym and the theme's zone, or of
 * the desks once a large team's rows reach further. Its amenities stand
 * beyond the walkway, each placed from the walkway's middle line
 * (idle-behaviours.ts places its Agents the same way): the table games
 * together, the table tennis table between the pool table and the
 * foosball table, and the vending and arcade machines at the far end.
 */
export const gamesHall = {
  /** The nearest its walkway starts: the gym's front, and the theme zone's. */
  from: 8,
  /** From the walkway's back edge to its middle line. */
  walkway: 0.75,
  /** From the walkway's middle line to the Floor's front. */
  depth: 5.2,
  /** The basketball hoop on the left wall: the rim's centre. */
  hoop: { x: -9.69, y: 2.3, z: 2.6 },
  poolTable: { at: [-4.6, 2.6] as const, size: [2.3, 1.3] as const },
  puttingGreen: { at: [-4.4, 4.55] as const, size: [3.2, 1.1] as const },
  /** Along x, a player at either end. */
  tableTennis: { at: [-0.8, 2.4] as const, size: [2.2, 1.2] as const },
  foosball: { at: [1.7, 2.4] as const, size: [1.2, 0.72] as const },
  chessTable: [3.9, 2.4] as const,
  beanBags: [
    [5.35, 2.1],
    [6.25, 2.1],
  ] as const,
  television: [5.8, 3.5] as const,
  piano: [7.45, 2.5] as const,
  /** The vending machine and the arcade machine, facing -x. */
  vendingMachine: [9.65, 1.6] as const,
  arcade: [9.65, 2.9] as const,
} as const;

/** The games hall's waypoint where the aisle meets its walkway. */
const hallJunction = "games hall, by the aisle";

/** The games hall's chess chairs, from the walkway's middle line: facing each other across the table. */
const chessChairs: { at: readonly [number, number]; turns: QuarterTurns }[] = [
  { at: [gamesHall.chessTable[0] - 0.6, gamesHall.chessTable[1]], turns: 3 },
  { at: [gamesHall.chessTable[0] + 0.6, gamesHall.chessTable[1]], turns: 1 },
];

/** The games hall's amenities, its walkway's middle line at `hallZ`. */
function gamesHallPieces(hallZ: number): Piece[] {
  const at = ([x, z]: readonly [number, number]) => [x, z + hallZ] as const;
  const { hoop } = gamesHall;
  const hoopZ = hoop.z + hallZ;
  // A box at `[x, z]` from the walkway, its centre `y` up.
  const box = (
    name: string,
    token: PaletteToken,
    surface: Piece["surface"],
    role: PieceRole,
    size: Vec3,
    [x, y, z]: Vec3,
  ) => piece(name, "box", token, surface, role, size, [x, y, z + hallZ]);
  const basketball: Piece[] = [
    box(
      "basketball hoop, backboard",
      "paper",
      "paint",
      "furniture",
      [0.04, 0.7, 1.1],
      [-halfWidth + 0.03, 2.6, hoop.z],
    ),
    box(
      "basketball hoop, target",
      "state-critical",
      "paint",
      "furniture",
      [0.01, 0.3, 0.4],
      [-halfWidth + 0.055, 2.5, hoop.z],
    ),
    box(
      "basketball hoop, bracket",
      "metal-dark",
      "metal",
      "furniture",
      [0.1, 0.04, 0.06],
      [-halfWidth + 0.1, hoop.y, hoop.z],
    ),
    // The rim and its net, open bands, so the ball has a hole to drop through.
    {
      ...piece(
        "basketball hoop, rim",
        "cylinder",
        "state-critical",
        "metal",
        "furniture",
        [0.46, 0.03, 0.46],
        [hoop.x, hoop.y, hoopZ],
      ),
      open: true,
    },
    {
      ...piece(
        "basketball hoop, net",
        "cylinder",
        "paper",
        "fabric",
        "furniture",
        [0.4, 0.28, 0.4],
        [hoop.x, hoop.y - 0.155, hoopZ],
      ),
      open: true,
    },
    // The court's lane and free-throw line, painted on the floor.
    box(
      "basketball court, lane",
      "sofa",
      "paint",
      "architecture",
      [2.1, 0.004, 1.5],
      [-halfWidth + 1.05, 0.002, hoop.z],
    ),
    box(
      "basketball court, free-throw line",
      "paper",
      "paint",
      "architecture",
      [0.05, 0.005, 1.5],
      [-halfWidth + 2.1, 0.0025, hoop.z],
    ),
    ...[0.6, 0.85].map((dz, index) =>
      piece(
        `basketball ${String(index + 1)}`,
        "sphere",
        "sofa",
        "plastic",
        "prop",
        [0.24, 0.24, 0.24],
        [-halfWidth + 0.2, 0.12, hoopZ + dz + 0.3],
      ),
    ),
  ];

  const {
    at: [poolX, poolZ],
    size: [poolLength, poolWidth],
  } = gamesHall.poolTable;
  const pool: Piece[] = [
    box(
      "pool table, felt",
      "plant",
      "fabric",
      "furniture",
      [poolLength - 0.2, 0.04, poolWidth - 0.2],
      [poolX, 0.8, poolZ],
    ),
    box(
      "pool table, body",
      "desk-top",
      "wood",
      "furniture",
      [poolLength - 0.15, 0.25, poolWidth - 0.15],
      [poolX, 0.655, poolZ],
    ),
    ...[-1, 1].flatMap((side) => [
      box(
        `pool table, ${side < 0 ? "near" : "far"} cushion`,
        "desk-top",
        "wood",
        "furniture",
        [poolLength, 0.08, 0.1],
        [poolX, 0.82, poolZ + side * (poolWidth / 2 - 0.05)],
      ),
      box(
        `pool table, ${side < 0 ? "left" : "right"} cushion`,
        "desk-top",
        "wood",
        "furniture",
        [0.1, 0.08, poolWidth - 0.2],
        [poolX + side * (poolLength / 2 - 0.05), 0.82, poolZ],
      ),
    ]),
    ...(
      [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const
    ).map(([sx, sz], index) =>
      standing(
        `pool table, leg ${String(index + 1)}`,
        "desk-top",
        "wood",
        "furniture",
        [0.14, 0.53, 0.14],
        at([
          poolX + sx * (poolLength / 2 - 0.25),
          poolZ + sz * (poolWidth / 2 - 0.2),
        ]),
      ),
    ),
    ...(
      [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 1],
        [0, 1],
        [1, 1],
      ] as const
    ).map(([sx, sz], index) =>
      box(
        `pool table, pocket ${String(index + 1)}`,
        "ink",
        "plastic",
        "furniture",
        [0.11, 0.012, 0.11],
        [
          poolX + sx * (poolLength / 2 - 0.13),
          0.826,
          poolZ + sz * (poolWidth / 2 - 0.13),
        ],
      ),
    ),
    // The cue ball, and the rack of colours at the far end.
    ...(
      [
        [-0.55, 0, "paper"],
        [0.45, 0, "state-critical"],
        [0.51, -0.035, "state-warning"],
        [0.51, 0.035, "stage-work"],
        [0.57, -0.07, "ink"],
        [0.57, 0, "stage-review"],
        [0.57, 0.07, "state-ok"],
      ] as const
    ).map(([dx, dz, token], index) =>
      piece(
        `pool ball ${String(index + 1)}`,
        "sphere",
        token,
        "plastic",
        "prop",
        [0.057, 0.057, 0.057],
        [poolX + dx, 0.849, poolZ + dz + hallZ],
      ),
    ),
  ];

  const {
    at: [greenX, greenZ],
    size: [greenLength, greenWidth],
  } = gamesHall.puttingGreen;
  const holeX = greenX + greenLength / 2 - 0.35;
  const putting: Piece[] = [
    box(
      "putting green",
      "state-ok",
      "fabric",
      "architecture",
      [greenLength, 0.012, greenWidth],
      [greenX, 0.006, greenZ],
    ),
    box(
      "putting green, hole",
      "ink",
      "paint",
      "architecture",
      [0.11, 0.004, 0.11],
      [holeX, 0.013, greenZ],
    ),
    box(
      "putting green, flagstick",
      "metal-light",
      "metal",
      "prop",
      [0.015, 0.7, 0.015],
      [holeX, 0.36, greenZ],
    ),
    box(
      "putting green, flag",
      "state-critical",
      "fabric",
      "prop",
      [0.01, 0.12, 0.2],
      [holeX, 0.65, greenZ + 0.1],
    ),
    ...[-0.35, 0.35].map((dz, index) =>
      piece(
        `golf ball ${String(index + 1)}`,
        "sphere",
        "paper",
        "plastic",
        "prop",
        [0.043, 0.043, 0.043],
        [greenX - greenLength / 2 + 0.45, 0.0215, greenZ + dz + hallZ],
      ),
    ),
  ];

  // The foosball table: its rods across the field, each team's handles
  // on its own side, and its little players on the rods.
  const {
    at: [footX, footZ],
    size: [footLength, footWidth],
  } = gamesHall.foosball;
  const rodY = 0.97;
  // From one goal to the other: goalie, defence, attack, midfield, and
  // their opponents' in turn; true for the near side's team.
  const rods = [
    [1, true],
    [2, true],
    [3, false],
    [5, true],
    [5, false],
    [3, true],
    [2, false],
    [1, false],
  ] as const;
  const rodX = (index: number) =>
    footX - footLength / 2 + 0.11 + (index * (footLength - 0.22)) / 7;
  const foosball: Piece[] = [
    box(
      "foosball table, cabinet",
      "desk-top",
      "wood",
      "furniture",
      [footLength, 0.3, footWidth],
      [footX, 0.75, footZ],
    ),
    box(
      "foosball table, pitch",
      "state-ok",
      "paint",
      "furniture",
      [footLength - 0.08, 0.01, footWidth - 0.08],
      [footX, 0.905, footZ],
    ),
    ...(
      [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const
    ).map(([sx, sz], index) =>
      standing(
        `foosball table, leg ${String(index + 1)}`,
        "metal-dark",
        "metal",
        "furniture",
        [0.08, 0.6, 0.08],
        at([
          footX + sx * (footLength / 2 - 0.08),
          footZ + sz * (footWidth / 2 - 0.08),
        ]),
      ),
    ),
    ...[-1, 1].map((side) =>
      box(
        `foosball table, ${side < 0 ? "left" : "right"} goal`,
        "ink",
        "plastic",
        "furniture",
        [0.02, 0.06, 0.2],
        [footX + side * (footLength / 2 + 0.01), 0.93, footZ],
      ),
    ),
    piece(
      "foosball",
      "sphere",
      "paper",
      "plastic",
      "prop",
      [0.03, 0.03, 0.03],
      [footX + 0.08, 0.925, footZ + hallZ + 0.05],
    ),
    ...rods.flatMap(([players, near], index) => {
      const x = rodX(index);
      const handle = near ? -1 : 1;
      return [
        lying(
          "z",
          piece(
            `foosball rod ${String(index + 1)}`,
            "cylinder",
            "metal-light",
            "metal",
            "furniture",
            [0.018, 0.018, footWidth + 0.36],
            [x, rodY, footZ + hallZ + handle * 0.06],
          ),
        ),
        lying(
          "z",
          piece(
            `foosball rod ${String(index + 1)}, handle`,
            "cylinder",
            "ink",
            "plastic",
            "furniture",
            [0.035, 0.035, 0.11],
            [x, rodY, footZ + hallZ + handle * (footWidth / 2 + 0.2)],
          ),
        ),
        ...Array.from({ length: players }, (_, player) =>
          box(
            `foosball rod ${String(index + 1)}, player ${String(player + 1)}`,
            near ? "stage-work" : "state-critical",
            "plastic",
            "prop",
            [0.025, 0.08, 0.03],
            [
              x,
              rodY - 0.02,
              footZ + ((player + 0.5) / players - 0.5) * (footWidth - 0.16),
            ],
          ),
        ),
      ];
    }),
  ];

  const [chessX, chessZ] = gamesHall.chessTable;
  const chess: Piece[] = [
    box(
      "chess table, top",
      "desk-top",
      "wood",
      "furniture",
      [0.62, 0.03, 0.62],
      [chessX, 0.715, chessZ],
    ),
    standing(
      "chess table, post",
      "metal-dark",
      "metal",
      "furniture",
      [0.08, 0.7, 0.08],
      at(gamesHall.chessTable),
      "cylinder",
    ),
    standing(
      "chess table, foot",
      "metal-dark",
      "metal",
      "furniture",
      [0.4, 0.03, 0.4],
      at(gamesHall.chessTable),
      "cylinder",
    ),
    box(
      "chessboard",
      "paper",
      "paint",
      "prop",
      [0.36, 0.008, 0.36],
      [chessX, 0.734, chessZ],
    ),
    // Its dark squares, four by four: each a quarter of the board's.
    ...Array.from({ length: 8 }, (_, index) => {
      const row = Math.floor(index / 2);
      const column = (index % 2) * 2 + (row % 2);
      return box(
        `chessboard, dark square ${String(index + 1)}`,
        "ink",
        "paint",
        "prop",
        [0.09, 0.004, 0.09],
        [chessX - 0.135 + column * 0.09, 0.74, chessZ - 0.135 + row * 0.09],
      );
    }),
    ...(
      [
        [-0.1, 0.05, "paper", 0.07],
        [-0.12, -0.08, "paper", 0.05],
        [0.11, -0.02, "ink", 0.07],
        [0.07, 0.12, "ink", 0.05],
      ] as const
    ).map(([dx, dz, token, height], index) =>
      piece(
        `chess piece ${String(index + 1)}`,
        "cylinder",
        token,
        "plastic",
        "prop",
        [0.025, height, 0.025],
        [chessX + dx, 0.742 + height / 2, chessZ + dz + hallZ],
      ),
    ),
    ...chessChairs.flatMap(({ at: seat, turns }, index) =>
      chairAt(`chess chair ${String(index + 1)}`, at(seat), turns),
    ),
  ];

  const [tvX, tvZ] = gamesHall.television;
  const lounging: Piece[] = [
    ...gamesHall.beanBags.map(([x, z], index) =>
      standing(
        `bean bag ${String(index + 1)}`,
        index === 0 ? "stage-review" : "state-warning",
        "fabric",
        "furniture",
        [0.75, 0.5, 0.75],
        at([x, z]),
        "sphere",
      ),
    ),
    standing(
      "television stand",
      "desk-top",
      "wood",
      "furniture",
      [1.3, 0.45, 0.4],
      at(gamesHall.television),
    ),
    box(
      "television",
      "ink",
      "plastic",
      "furniture",
      [1.14, 0.66, 0.04],
      [tvX, 0.85, tvZ + 0.03],
    ),
    box(
      "television, screen",
      "screen-glow",
      "screen",
      "furniture",
      [1.06, 0.58, 0.01],
      [tvX, 0.85, tvZ + 0.005],
    ),
    box(
      "games console",
      "ink",
      "plastic",
      "prop",
      [0.3, 0.06, 0.22],
      [tvX + 0.4, 0.48, tvZ - 0.05],
    ),
    // A guitar on its stand beside the television.
    piece(
      "guitar, body",
      "sphere",
      "sofa",
      "wood",
      "prop",
      [0.34, 0.42, 0.11],
      [tvX + 0.85, 0.3, tvZ + hallZ],
    ),
    piece(
      "guitar, upper bout",
      "sphere",
      "sofa",
      "wood",
      "prop",
      [0.26, 0.28, 0.1],
      [tvX + 0.85, 0.58, tvZ + hallZ],
    ),
    box(
      "guitar, neck",
      "desk-top",
      "wood",
      "prop",
      [0.055, 0.45, 0.035],
      [tvX + 0.85, 0.94, tvZ],
    ),
    box(
      "guitar, headstock",
      "ink",
      "wood",
      "prop",
      [0.07, 0.12, 0.03],
      [tvX + 0.85, 1.22, tvZ],
    ),
  ];

  // The upright piano, in wood with a black lid, its keys at a desk's
  // height, and its bench.
  const [pianoX, pianoZ] = gamesHall.piano;
  const keysZ = pianoZ - 0.48;
  const piano: Piece[] = [
    box(
      "piano",
      "sofa",
      "wood",
      "furniture",
      [1.45, 1.17, 0.5],
      [pianoX, 0.585, pianoZ],
    ),
    box(
      "piano, lid",
      "ink",
      "plastic",
      "furniture",
      [1.49, 0.04, 0.54],
      [pianoX, 1.19, pianoZ],
    ),
    box(
      "piano, keybed",
      "ink",
      "plastic",
      "furniture",
      [1.45, 0.08, 0.3],
      [pianoX, 0.69, keysZ + 0.05],
    ),
    box(
      "piano, keys",
      "paper",
      "plastic",
      "furniture",
      [1.3, 0.02, 0.15],
      [pianoX, 0.74, keysZ],
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      box(
        `piano, black key ${String(index + 1)}`,
        "ink",
        "plastic",
        "furniture",
        [0.016, 0.015, 0.09],
        [pianoX - 0.6 + index * 0.11, 0.755, keysZ - 0.025],
      ),
    ),
    ...[-1, 1].map((side) =>
      standing(
        `piano, ${side < 0 ? "left" : "right"} leg`,
        "ink",
        "plastic",
        "furniture",
        [0.06, 0.65, 0.06],
        at([pianoX + side * 0.66, keysZ + 0.1]),
      ),
    ),
    box(
      "piano, music",
      "paper",
      "paint",
      "prop",
      [0.4, 0.26, 0.01],
      [pianoX, 0.95, pianoZ - 0.26],
    ),
    standing(
      "piano bench",
      "ink",
      "plastic",
      "furniture",
      [1.1, 0.44, 0.36],
      at([pianoX, keysZ - 0.53]),
    ),
  ];

  // The table tennis table, along x between the pool table and the
  // foosball table: its net across the middle, a bat at either end.
  const {
    at: [tableX, tableZ],
    size: [tableLength, tableWidth],
  } = gamesHall.tableTennis;
  const tableTennis: Piece[] = [
    box(
      "table tennis table, top",
      "state-ok",
      "paint",
      "furniture",
      [tableLength, 0.04, tableWidth],
      [tableX, 0.74, tableZ],
    ),
    box(
      "table tennis table, centre line",
      "paper",
      "paint",
      "furniture",
      [tableLength, 0.002, 0.02],
      [tableX, 0.761, tableZ],
    ),
    box(
      "table tennis table, net",
      "paper",
      "fabric",
      "furniture",
      [0.02, 0.15, tableWidth + 0.1],
      [tableX, 0.835, tableZ],
    ),
    ...[-1, 1].map((side) =>
      standing(
        `table tennis table, ${side < 0 ? "left" : "right"} legs`,
        "metal-dark",
        "metal",
        "furniture",
        [0.1, 0.72, tableWidth - 0.2],
        at([tableX + side * (tableLength / 2 - 0.3), tableZ]),
      ),
    ),
    ...[-1, 1].map((side) =>
      piece(
        `table tennis bat, ${side < 0 ? "left" : "right"}`,
        "cylinder",
        "state-critical",
        "plastic",
        "prop",
        [0.15, 0.01, 0.15],
        [tableX + side * 0.6, 0.765, tableZ + hallZ + 0.3 * side],
      ),
    ),
  ];

  // The vending machine and the arcade machine at the hall's far end,
  // facing -x, back to the Floor's open edge.
  const [vendX, vendZ] = gamesHall.vendingMachine;
  const [arcadeX, arcadeZ] = gamesHall.arcade;
  const machines: Piece[] = [
    standing(
      "vending machine",
      "stage-work",
      "plastic",
      "furniture",
      [0.7, 1.8, 0.9],
      at(gamesHall.vendingMachine),
    ),
    box(
      "vending machine, window",
      "screen-glow",
      "screen",
      "furniture",
      [0.02, 1.1, 0.55],
      [vendX - 0.36, 1.15, vendZ - 0.1],
    ),
    standing(
      "arcade machine",
      "ink",
      "plastic",
      "furniture",
      [0.7, 1.7, 0.75],
      at(gamesHall.arcade),
    ),
    box(
      "arcade machine, screen",
      "screen-glow",
      "screen",
      "furniture",
      [0.02, 0.45, 0.55],
      [arcadeX - 0.36, 1.35, arcadeZ],
    ),
    box(
      "arcade machine, controls",
      "stage-review",
      "plastic",
      "furniture",
      [0.2, 0.06, 0.6],
      [arcadeX - 0.4, 1.0, arcadeZ],
    ),
  ];

  return [
    ...basketball,
    ...pool,
    ...putting,
    ...tableTennis,
    ...foosball,
    ...chess,
    ...lounging,
    ...piano,
    ...machines,
  ];
}

const bookcaseAt = [2.7, backZ + modelCatalogue.bookcase.size[2] / 2] as const;

/** The bookshelf for memory, against the back wall: its centre on the floor, and its size. */
export const bookshelf = {
  at: [bookcaseAt[0], 0, bookcaseAt[1]] as Vec3,
  size: modelCatalogue.bookcase.size,
} as const;

function bookshelfModels(): ModelPlacement[] {
  const [x, z] = bookcaseAt;
  const [first, second, third] = modelCatalogue.bookcase.shelves;
  return [
    {
      name: "bookshelf",
      model: "bookcase",
      position: [x, 0, z],
      turns: 0,
      role: "furniture",
    },
    ...(
      [
        [-0.2, first],
        [0.15, first],
        [0.1, second],
        [-0.15, third],
      ] as const
    ).map(([offset, shelf], index): ModelPlacement => ({
      name: `books on the shelf ${String(index + 1)}`,
      model: "books",
      position: [x + offset, shelf, z + 0.02],
      turns: 0,
      role: "prop",
    })),
  ];
}

const managersBookcaseAt = [
  -6.6,
  backZ + modelCatalogue.bookcase.size[2] / 2,
] as const;

/**
 * The bookshelf in the Manager's office, for the Floor's Skills (FR-73):
 * against the office's back wall, right of the Manager's desk. Its centre
 * on the floor, and its size.
 */
export const managersBookshelf = {
  at: [managersBookcaseAt[0], 0, managersBookcaseAt[1]] as Vec3,
  size: modelCatalogue.bookcase.size,
} as const;

function managersBookshelfModels(): ModelPlacement[] {
  const [x, z] = managersBookcaseAt;
  const [first, second, third] = modelCatalogue.bookcase.shelves;
  return [
    {
      name: "bookshelf in the Manager's office",
      model: "bookcase",
      position: [x, 0, z],
      turns: 0,
      role: "furniture",
    },
    ...(
      [
        [0.15, first],
        [-0.15, second],
        [0.2, third],
      ] as const
    ).map(([offset, shelf], index): ModelPlacement => ({
      name: `books on the Manager's shelf ${String(index + 1)}`,
      model: "books",
      position: [x + offset, shelf, z + 0.02],
      turns: 0,
      role: "prop",
    })),
  ];
}

const amenityModels: ModelPlacement[] = [
  ...bookshelfModels(),
  ...managersBookshelfModels(),
  {
    name: "coffee machine",
    model: "coffee-machine",
    position: [7.5, counter.height, backZ + 0.25],
    turns: 0,
    role: "prop",
  },
  {
    name: "fridge",
    model: "fridge",
    position: [9.5, 0, backZ + 0.4],
    turns: 0,
    role: "furniture",
  },
  {
    name: "plant in the Manager's office",
    model: "potted-plant",
    position: [-9.55, 0, -2.55],
    turns: 0,
    role: "prop",
  },
  {
    name: "plant in the canteen",
    model: "potted-plant",
    position: [6.75, 0, -2.45],
    turns: 1,
    role: "prop",
  },
];

/** The rows the open plan needs, and how many desks each holds. */
export function deskGrid(count: number): { rows: number; columns: number } {
  if (count === 0) {
    return { rows: 0, columns: 0 };
  }
  const rows = Math.ceil(count / maxDesksPerRow);
  return { rows, columns: Math.ceil(count / rows) };
}

const roundUp = (value: number, step: number) => Math.ceil(value / step) * step;

/**
 * A Floor's layout for its Agents, in the order they are listed, dressed in
 * its 3D theme (floor-themes.ts) beside the desks.
 */
export function floorLayout(
  agents: readonly FloorAgent[],
  theme: FloorTheme = defaultFloorTheme,
): FloorLayout {
  const themed = themeLayout(theme);
  const manager = agents.find(({ role }) => role === "manager");
  const openPlan = agents.filter((agent) => agent !== manager);
  const { rows, columns } = deskGrid(openPlan.length);
  const rowZ = (row: number) => firstRowZ + row * deskSpacing.rows;
  const walkwayZ = (row: number) => rowZ(row) + behindChair;

  const desks: FloorDesk[] = agents.map((agent) => {
    if (agent === manager) {
      return {
        ...deskSet(`desk of ${agent.id}`, agent, managerDeskCentre, 2),
        agentId: agent.id,
        role: agent.role,
        zone: "manager's office",
        waypoint: deskWaypoint(agent.id),
      };
    }
    const index = openPlan.indexOf(agent);
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      ...deskSet(
        `desk of ${agent.id}`,
        agent,
        [deskColumns[column] ?? 0, rowZ(row)],
        0,
      ),
      agentId: agent.id,
      role: agent.role,
      zone: "open plan",
      waypoint: deskWaypoint(agent.id),
    };
  });
  const openDesks = desks.filter(({ zone }) => zone === "open plan");

  // The rows' walkways, behind the chairs, from the left-most desk to the aisle.
  const leftEdge = Math.min(
    aisle.x[0],
    ...openDesks.map(({ footprint }) => footprint.x[0]),
  );
  const rowWalkways: Walkway[] = Array.from({ length: rows }, (_, row) => ({
    name: `behind row ${String(row + 1)}`,
    x: [leftEdge, aisle.x[0]],
    z: [walkwayZ(row) - 0.75, walkwayZ(row) + 0.75],
  }));
  const deskZoneEnd = rows === 0 ? corridor.z[1] : walkwayZ(rows - 1) + 0.75;
  // The games hall's walkway's middle line, in front of everything else.
  const hallStart = Math.max(gamesHall.from, deskZoneEnd);
  const hallZ = hallStart + gamesHall.walkway;
  const front = Math.max(
    gym.z[1] + 0.5,
    gamesHall.from,
    roundUp(deskZoneEnd + 0.5, 0.5),
    roundUp(hallZ + gamesHall.depth, 0.5),
  );
  const bounds: Rect = { x: [-halfWidth, halfWidth], z: [backZ, front] };

  const architecture: Piece[] = [
    piece(
      "floor",
      "box",
      "floor-wood",
      "wood",
      "architecture",
      [2 * halfWidth, 0.1, front - backZ],
      [0, -0.05, (front + backZ) / 2],
    ),
    ...(rows === 0
      ? []
      : [
          standing(
            "carpet under the desks",
            "floor-carpet",
            "fabric",
            "architecture",
            [aisle.x[0] - (leftEdge - 0.3), 0.01, deskZoneEnd - corridor.z[1]],
            [
              (aisle.x[0] + leftEdge - 0.3) / 2,
              (deskZoneEnd + corridor.z[1]) / 2,
            ],
          ),
        ]),
    // The back wall on either side of the lift core, and the left wall.
    wall(
      "back wall",
      [liftLeft + halfWidth, floorCeiling, wallThickness],
      [(liftLeft - halfWidth) / 2, floorCeiling / 2, backZ - wallThickness / 2],
    ),
    wall(
      "back wall, right of the lift",
      [halfWidth - liftRight, floorCeiling, wallThickness],
      [
        (liftRight + halfWidth) / 2,
        floorCeiling / 2,
        backZ - wallThickness / 2,
      ],
    ),
    wall(
      "left wall",
      [wallThickness, floorCeiling, front - backZ + wallThickness],
      [
        -halfWidth - wallThickness / 2,
        floorCeiling / 2,
        (front + backZ - wallThickness) / 2,
      ],
    ),
  ];

  const spare = spareMeetingChairs(openPlan.length);
  const pieces: Piece[] = [
    ...architecture,
    ...liftCorePieces,
    ...managersOfficePieces(),
    ...meetingRoomPieces(),
    ...spare.flatMap(({ at, turns }, index) =>
      chairAt(`meeting room, spare chair ${String(index + 1)}`, at, turns),
    ),
    ...wallBoardPieces(),
    ...canteenPieces(),
    ...gymPieces(),
    ...waterCoolerPieces(),
    ...loungePieces(),
    ...printerPieces(),
    ...posterFramePieces(),
    ...gamesHallPieces(hallZ),
    ...themed.pieces,
    ...desks.flatMap((each) => each.pieces),
  ];
  const models: ModelPlacement[] = [
    ...amenityModels,
    ...themed.models,
    ...desks.flatMap((each) => each.models),
  ];

  const walkways: Walkway[] = [
    { name: "from the lift", x: aisle.x, z: [backZ, corridor.z[0]] },
    { name: "the corridor", x: corridor.x, z: corridor.z },
    { name: "the aisle", x: aisle.x, z: [corridor.z[1], hallStart] },
    {
      name: "the games hall",
      x: [-halfWidth + 0.2, halfWidth],
      z: [hallStart, hallStart + 2 * gamesHall.walkway],
    },
    {
      name: "to the wall board and bookshelf",
      x: [0.2, 3.4],
      z: [-5.4, corridor.z[0]],
    },
    {
      name: "into the canteen",
      x: [7.05, 8.55],
      z: [backZ + counter.depth + 0.05, corridor.z[0]],
    },
    { name: "into the gym", ...gym.walkwayIn },
    { name: "the lounge", ...lounge.walkway },
    { name: "through the gym", ...gym.walkwayThrough },
    ...rowWalkways,
  ];

  // The waypoints: the corridor's, each with a way off it; the aisle's,
  // one for the gym and one for each row; and each desk's.
  const point = (id: string, position: FloorPoint): Waypoint => ({
    id,
    position,
  });
  const corridorStops: [string, number][] = [
    ["water-cooler", -9],
    ["corridor by the Manager's office", -6.8],
    ["corridor by the meeting room", -0.6],
    ["corridor by the wall board", wallBoard.centre[0]],
    ["corridor by the bookshelf", bookcaseAt[0]],
    ["corridor by the lift", liftX],
    ["corridor by the canteen", 7.5],
  ];
  const aisleStops: [string, number][] = [
    ["aisle by the gym", 1.2],
    ...Array.from({ length: rows }, (_, row): [string, number] => [
      `aisle by row ${String(row + 1)}`,
      walkwayZ(row),
    ]),
    [hallJunction, hallZ],
  ];
  // The games hall's spots, along its walkway from the left wall, with
  // the aisle's end among them.
  const hallStops: [string, number][] = [
    ["basketball", -7.55],
    ["putting-green", -6.3],
    ["pool-table", -4.6],
    ["table-tennis", gamesHall.tableTennis.at[0]],
    ["foosball", gamesHall.foosball.at[0]],
    ["chess-table", gamesHall.chessTable[0]],
    [hallJunction, liftX],
    ["bean-bags", gamesHall.television[0]],
    ["piano", gamesHall.piano[0] - 0.35],
    ["arcade", 8.6],
    ["vending-machine", 8.95],
  ];
  // The gym's machines, along the walkway through it from the aisle.
  const machineStops: [string, number][] = [
    ["aisle by the gym's machines", liftX],
    ["exercise-bike", gym.exerciseBike[0]],
    ["rowing-machine", gym.rowingMachine[0]],
    ["dumbbells", 8.4],
    ["punchbag", 8.8],
  ];
  const throughGymZ = (gym.walkwayThrough.z[0] + gym.walkwayThrough.z[1]) / 2;
  const managerDesk = desks.find(({ zone }) => zone === "manager's office");
  const waypoints: Waypoint[] = [
    point("lift", [liftX, backZ + 0.8]),
    ...corridorStops.map(([id, x]) => point(id, [x, corridorZ])),
    ...aisleStops.map(([id, z]) => point(id, [liftX, z])),
    point("managers-office-door", [-6.8, managersOffice.z[1]]),
    point("managers-office", [-6.8, -3]),
    point("meeting-room-door", [-0.6, meetingRoom.z[1]]),
    point("meeting-room", [-0.5, -2.6]),
    point("meeting room, at the back", [-0.5, -5.45]),
    point("whiteboard", [-1.9, -5.45]),
    point("wall-board", [wallBoard.centre[0], -4.6]),
    point("bookshelf", [bookcaseAt[0], -4.8]),
    point("coffee-machine", [7.5, -4.8]),
    point("gym", [7.6, 1.2]),
    // The idle amenities': from the water cooler along the lounge; off the
    // aisle to the printer and the gym's machines; in the canteen and the
    // gym.
    point("fish-tank", [-8.9, 0.2]),
    point("lounge-sofa", [-8.25, 2]),
    point("darts", [-7.9, 3.4]),
    point("printer", [liftX, printerAt[1]]),
    ...machineStops.map(([id, x]) => point(id, [x, throughGymZ])),
    point("kettle", [6.95, -4.85]),
    point("microwave", [8.85, -4.8]),
    point("fridge", [9.5, -4.85]),
    point("cafe-table", [8.55, -3.4]),
    point("canteen-plant", [7.6, -2.45]),
    point("kettlebells", [8.45, 2.4]),
    point("weight-bench", [6.85, 2]),
    point("treadmill", [8.35, 1.7]),
    point("yoga-mats", [8.35, 2.05]),
    ...hallStops
      .filter(([id]) => id !== hallJunction)
      .map(([id, x]) => point(id, [x, hallZ])),
    ...(managerDesk === undefined
      ? []
      : [point(managerDesk.waypoint, [-7.1, managerDesk.seat[2]])]),
    ...openDesks.map((each) =>
      point(each.waypoint, [each.seat[0], each.seat[2] + behindChair - 0.7]),
    ),
  ];
  const chain = (ids: readonly string[]) =>
    ids.flatMap((id, index) => {
      const next = ids[index + 1];
      return next === undefined ? [] : [[id, next] as const];
    });
  const edges: (readonly [string, string])[] = [
    ...chain(corridorStops.map(([id]) => id)),
    ["lift", "corridor by the lift"],
    ...chain(["corridor by the lift", ...aisleStops.map(([id]) => id)]),
    ["aisle by the gym", "gym"],
    ...chain(["water-cooler", "fish-tank", "lounge-sofa", "darts"]),
    ["aisle by the gym", "printer"],
    // The gym's machines are off the aisle wherever an Agent joins it.
    ...["aisle by the gym", ...aisleStops.slice(1).map(([id]) => id)].map(
      (id) => [id, "aisle by the gym's machines"] as const,
    ),
    ...chain(machineStops.map(([id]) => id)),
    ["coffee-machine", "kettle"],
    ...chain(["coffee-machine", "microwave", "fridge"]),
    ["corridor by the canteen", "cafe-table"],
    ["corridor by the canteen", "canteen-plant"],
    ["gym", "kettlebells"],
    ["gym", "weight-bench"],
    ["gym", "treadmill"],
    ["gym", "yoga-mats"],
    ...chain(hallStops.map(([id]) => id)),
    ...chain([
      "corridor by the Manager's office",
      "managers-office-door",
      "managers-office",
    ]),
    ...(managerDesk === undefined
      ? []
      : [["managers-office", managerDesk.waypoint] as const]),
    ...chain([
      "corridor by the meeting room",
      "meeting-room-door",
      "meeting-room",
      "meeting room, at the back",
      "whiteboard",
    ]),
    ["corridor by the wall board", "wall-board"],
    ["corridor by the bookshelf", "bookshelf"],
    ["corridor by the canteen", "coffee-machine"],
    ...Array.from({ length: rows }, (_, row) =>
      chain([
        `aisle by row ${String(row + 1)}`,
        ...openDesks
          .filter(
            (each) =>
              Math.abs(each.seat[2] + behindChair - 0.7 - walkwayZ(row)) < 0.01,
          )
          .sort((a, b) => b.seat[0] - a.seat[0])
          .map(({ waypoint }) => waypoint),
      ]),
    ).flat(),
  ];

  const meetingSeats = meetingChairs.map(({ at }) =>
    turnPoint([0, 0, 0], 0, at),
  );
  const contactShadows: Rect[] = [
    ...desks.flatMap((each) => [each.desk, each.chair]),
    ...meetingChairs.map(({ at }) => chairRect(at)),
    ...spare.map(({ at }) => chairRect(at)),
    chairRect([cafeTable[0], cafeTable[1] - 0.75]),
    chairRect([cafeTable[0], cafeTable[1] + 0.75]),
    ...chessChairs.map(({ at: [x, z] }) => chairRect([x, z + hallZ])),
    ...themed.contactShadows,
  ];

  return {
    bounds,
    pieces,
    models,
    desks,
    walkways,
    waypoints: { waypoints, edges },
    meetingSeats,
    meetingWallSeats: spare.map(({ at }) => turnPoint([0, 0, 0], 0, at)),
    contactShadows,
  };
}
