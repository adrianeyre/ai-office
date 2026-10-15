import {
  builtInRole,
  managerRole,
  type DeskDressing,
  type Role,
  type Stage,
} from "@ai-office/shared";
import type { PaletteToken } from "@ai-office/shared/palette";

import type { Vec3 } from "./camera-rig.ts";
import type { ModelPlacement } from "./models.ts";
import {
  piece,
  placePieces,
  standing,
  turnPoint,
  turnSize,
  type Piece,
  type QuarterTurns,
} from "./pieces.ts";

// A desk set (PRD FR-57): the desk, its chair and monitor, and its Role's
// dressing on top, at the sizes of docs/reference/art-direction.md's Desks
// table. It is laid out about the desk's centre with the Agent's side
// towards +z, the Agent facing -z, then turned and moved into place.

/** The desk top: 1.4 m × 0.7 m, 3 cm thick, its top 0.74 m up. */
export const desk = {
  width: 1.4,
  depth: 0.7,
  top: 0.74,
  thickness: 0.03,
} as const;

/** The monitor's 0.55 m × 0.33 m screen, its top 1.15 m up, 0.45 m from the desk's front edge. */
export const monitor = {
  width: 0.55,
  height: 0.33,
  top: 1.15,
  fromFrontEdge: 0.45,
} as const;

/** How deep a monitor's screen is, front to back. */
export const screenDepth = 0.03;

/** The chair: seat 0.46 m up and 0.5 m square, its back to 0.95 m. */
export const chair = { seat: 0.46, size: 0.5, back: 0.95 } as const;

/** Desks are 2.4 m apart side by side, and rows 2.8 m front to back. */
export const deskSpacing = { across: 2.4, rows: 2.8 } as const;

/** From the desk's centre to the chair's, on the Agent's side. */
export const chairOffset = desk.depth / 2 + chair.size / 2 + 0.1;

/** Which way an Agent at a desk turned by `turns` faces: Avatars face +z. */
export const deskFacing = (turns: QuarterTurns) =>
  Math.PI + (turns * Math.PI) / 2;

/**
 * The spot on the desk's left (the Agent's left) kept clear for the pile
 * of tickets of FR-62: A4, 0.21 m × 0.297 m.
 */
export const ticketPile = {
  centre: [-0.48, 0.12] as const,
  size: [0.21, 0.297] as const,
} as const;

/** Each Stage's colour. */
const stageTokens: Readonly<Record<Stage, PaletteToken>> = {
  work: "stage-work",
  review: "stage-review",
  qa: "stage-qa",
  docs: "stage-docs",
};

/**
 * Whose desk it is: an Agent's Role, with the Stage and desk dressing the
 * Role library gives that Role (FR-98). Either left out is the built-in
 * Role's, and a Role the Office knows nothing of gets a monitor.
 */
export interface DeskRole {
  readonly role: Role;
  /** Null for the Manager, which has no Stage. */
  readonly stage?: Stage | null | undefined;
  readonly deskDressing?: DeskDressing | undefined;
}

/**
 * The colour of a Role's Stage, for its desk's stripe and mug; the Manager
 * has none.
 */
export const roleStageToken = (owner: DeskRole): PaletteToken | undefined => {
  const stage =
    owner.role === managerRole
      ? undefined
      : owner.stage === undefined
        ? builtInRole(owner.role)?.stage
        : owner.stage;
  return stage === undefined || stage === null ? undefined : stageTokens[stage];
};

/** How a desk is dressed: its Role's desk dressing, or the Manager's. */
type DeskLook = DeskDressing | typeof managerRole;

const deskLookOf = (owner: DeskRole): DeskLook =>
  owner.role === managerRole
    ? managerRole
    : (owner.deskDressing ??
      builtInRole(owner.role)?.deskDressing ??
      "monitor");

const deskTopY = desk.top - desk.thickness / 2;
const frontEdge = desk.depth / 2;
const monitorZ = frontEdge - monitor.fromFrontEdge;
/** Something lying on the desk top, `height` tall, its centre at `x`, `z`. */
const onDesk = (height: number, x: number, z: number): Vec3 => [
  x,
  desk.top + height / 2,
  z,
];

/** A chair facing -z about its own centre: seat, back, post and base. */
export function chairPieces(name: string): Piece[] {
  const seatThickness = 0.08;
  return [
    piece(
      `${name}, seat`,
      "box",
      "chair",
      "fabric",
      "furniture",
      [chair.size, seatThickness, chair.size],
      [0, chair.seat - seatThickness / 2, 0],
    ),
    piece(
      `${name}, back`,
      "box",
      "chair",
      "fabric",
      "furniture",
      [chair.size, chair.back - chair.seat, 0.06],
      [0, (chair.back + chair.seat) / 2, chair.size / 2 - 0.03],
    ),
    standing(
      `${name}, post`,
      "metal-dark",
      "metal",
      "furniture",
      [0.06, chair.seat - seatThickness, 0.06],
      [0, 0],
      "cylinder",
    ),
    standing(
      `${name}, base`,
      "metal-dark",
      "metal",
      "furniture",
      [chair.size, 0.04, chair.size],
      [0, 0],
      "cylinder",
    ),
  ];
}

/** A designer's two screens' centres, side by side on one stand. */
const dualScreens = [-0.29, 0.29] as const;

/** The centres of a Role's screens across its desk, from the Agent's left. */
const screenXs = (owner: DeskRole): readonly number[] =>
  deskLookOf(owner) === "dual-monitors" ? dualScreens : [0];

/**
 * Monitors facing the Agent, one centred at each of `xs`, on one stand
 * and foot: a dual-monitor stand holds two side by side, their screens'
 * middle on its post.
 */
function monitorPieces(name: string, xs: readonly number[]): Piece[] {
  const bottom = monitor.top - monitor.height;
  const middle = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const postTop = xs.length > 1 ? monitor.top - monitor.height / 2 : bottom;
  return [
    ...xs.map((x) =>
      piece(
        `${name}, ${xs.length > 1 ? (x < middle ? "left " : "right ") : ""}screen`,
        "box",
        "screen-off",
        "screen",
        "prop",
        [monitor.width, monitor.height, screenDepth],
        [x, monitor.top - monitor.height / 2, monitorZ],
      ),
    ),
    piece(
      `${name}, stand`,
      "box",
      "metal-dark",
      "metal",
      "prop",
      [0.05, postTop - desk.top + 0.02, 0.04],
      [middle, (postTop + desk.top) / 2, monitorZ - 0.04],
    ),
    piece(
      `${name}, foot`,
      "box",
      "metal-dark",
      "metal",
      "prop",
      [0.2, 0.012, 0.15],
      onDesk(0.012, middle, monitorZ - 0.03),
    ),
  ];
}

const keyboard = (name: string, x = 0): Piece =>
  piece(
    `${name}, keyboard`,
    "box",
    "ceramic",
    "plastic",
    "prop",
    [0.44, 0.02, 0.14],
    onDesk(0.02, x, 0.17),
  );

const mug = (name: string, token: PaletteToken, x: number, z: number): Piece =>
  piece(
    `${name}, mug`,
    "cylinder",
    token,
    "plastic",
    "prop",
    [0.08, 0.1, 0.08],
    onDesk(0.1, x, z),
  );

/** A flat thing on the desk: paper, a tablet, a phone. */
const flat = (
  name: string,
  token: PaletteToken,
  surface: Piece["surface"],
  [width, height, depth]: Vec3,
  x: number,
  z: number,
): Piece =>
  piece(
    name,
    "box",
    token,
    surface,
    "prop",
    [width, height, depth],
    [x, desk.top + height / 2, z],
  );

interface Dressing {
  readonly pieces: Piece[];
  readonly models: { model: ModelPlacement["model"]; at: Vec3 }[];
}

/** What sits on a Role's desk, about the desk's centre (FR-57). */
function dressing(name: string, owner: DeskRole): Dressing {
  const stage = roleStageToken(owner) ?? "ceramic";
  switch (deskLookOf(owner)) {
    case "dual-monitors":
      // Dual monitors and a drawing tablet with its pen.
      return {
        pieces: [
          ...monitorPieces(`${name}, monitors`, screenXs(owner)),
          keyboard(name, -0.1),
          flat(
            `${name}, drawing tablet`,
            "screen-off",
            "plastic",
            [0.32, 0.012, 0.22],
            0.44,
            0.17,
          ),
          flat(
            `${name}, pen`,
            stage,
            "plastic",
            [0.012, 0.012, 0.15],
            0.64,
            0.17,
          ),
        ],
        models: [],
      };
    case "printouts":
      // A stack of printouts with a pen in the Stage's colour.
      return {
        pieces: [
          ...monitorPieces(`${name}, monitor`, [0]),
          keyboard(name, -0.05),
          flat(
            `${name}, printouts`,
            "paper",
            "paint",
            [0.21, 0.025, 0.297],
            0.45,
            0.1,
          ),
          piece(
            `${name}, pen`,
            "box",
            stage,
            "plastic",
            "prop",
            [0.14, 0.012, 0.012],
            // On top of the printouts.
            [0.45, desk.top + 0.031, 0.1],
          ),
          mug(name, stage, 0.55, -0.2),
        ],
        models: [],
      };
    case "test-devices":
      // Test devices: a laptop, a tablet and a phone.
      return {
        pieces: [
          ...monitorPieces(`${name}, monitor`, [0]),
          keyboard(name, -0.1),
          flat(
            `${name}, test tablet`,
            "screen-off",
            "screen",
            [0.18, 0.012, 0.25],
            -0.5,
            -0.2,
          ),
          flat(
            `${name}, test phone`,
            "screen-off",
            "screen",
            [0.075, 0.01, 0.15],
            -0.3,
            -0.2,
          ),
        ],
        models: [{ model: "laptop", at: [0.45, desk.top, 0.06] }],
      };
    case "books":
      // Books and an open notebook, with a pen in the Stage's colour.
      return {
        pieces: [
          ...monitorPieces(`${name}, monitor`, [0]),
          keyboard(name, -0.1),
          flat(
            `${name}, notebook`,
            "paper",
            "paint",
            [0.3, 0.012, 0.21],
            0.45,
            0.17,
          ),
          piece(
            `${name}, pen`,
            "box",
            stage,
            "plastic",
            "prop",
            [0.012, 0.012, 0.14],
            // On the notebook.
            [0.56, desk.top + 0.018, 0.17],
          ),
        ],
        models: [{ model: "books", at: [0.48, desk.top, -0.2] }],
      };
    case "notebooks":
      // A copywriter's notebooks: two shut, one on the other, the top one
      // in the Stage's colour, and one open beside them.
      return {
        pieces: [
          ...monitorPieces(`${name}, monitor`, [0]),
          keyboard(name, -0.1),
          flat(
            `${name}, notebook`,
            "chair",
            "fabric",
            [0.15, 0.02, 0.21],
            0.52,
            -0.15,
          ),
          piece(
            `${name}, notebook on top`,
            "box",
            stage,
            "fabric",
            "prop",
            [0.15, 0.02, 0.21],
            // On the other, a little askew.
            [0.5, desk.top + 0.03, -0.13],
          ),
          flat(
            `${name}, open notebook`,
            "paper",
            "paint",
            [0.3, 0.012, 0.21],
            0.45,
            0.17,
          ),
        ],
        models: [],
      };
    case "product-samples":
      // A merchandiser's product samples: a boxed product, a smaller box
      // on it in the Stage's colour, and a jar.
      return {
        pieces: [
          ...monitorPieces(`${name}, monitor`, [0]),
          keyboard(name, -0.1),
          flat(
            `${name}, product box`,
            "desk-top",
            "paint",
            [0.22, 0.12, 0.16],
            0.5,
            -0.17,
          ),
          piece(
            `${name}, small product box`,
            "box",
            stage,
            "paint",
            "prop",
            [0.12, 0.07, 0.1],
            // On the product box.
            [0.48, desk.top + 0.12 + 0.035, -0.17],
          ),
          piece(
            `${name}, sample jar`,
            "cylinder",
            "sofa",
            "plastic",
            "prop",
            [0.08, 0.12, 0.08],
            onDesk(0.12, 0.5, 0.15),
          ),
        ],
        models: [],
      };
    case "manager":
      // A desk lamp, in the glass office.
      return {
        pieces: [
          ...monitorPieces(`${name}, monitor`, [0]),
          keyboard(name),
          mug(name, stage, 0.48, 0.15),
          piece(
            `${name}, desk lamp stem`,
            "cylinder",
            "metal-dark",
            "metal",
            "prop",
            [0.03, 0.35, 0.03],
            onDesk(0.35, 0.55, -0.2),
          ),
          piece(
            `${name}, desk lamp shade`,
            "sphere",
            "lamp",
            "lamp",
            "prop",
            [0.16, 0.09, 0.16],
            [0.55, desk.top + 0.36, -0.15],
          ),
        ],
        models: [],
      };
    case "monitor":
      return {
        pieces: [
          ...monitorPieces(`${name}, monitor`, [0]),
          keyboard(name),
          mug(name, stage, 0.5, 0.15),
        ],
        models: [],
      };
  }
}

/** A rectangle of floor, from `min` to `max` on x and z. */
export interface Rect {
  readonly x: readonly [number, number];
  readonly z: readonly [number, number];
}

/** A rectangle about the origin, turned and moved like the pieces. */
function turnRect(
  rect: Rect,
  turns: QuarterTurns,
  at: readonly [number, number],
): Rect {
  const corners = [
    turnPoint([rect.x[0], 0, rect.z[0]], turns, at),
    turnPoint([rect.x[1], 0, rect.z[1]], turns, at),
  ];
  const xs = corners.map(([x]) => x);
  const zs = corners.map(([, , z]) => z);
  return {
    x: [Math.min(...xs), Math.max(...xs)],
    z: [Math.min(...zs), Math.max(...zs)],
  };
}

export interface DeskSet {
  readonly pieces: Piece[];
  readonly models: ModelPlacement[];
  /** The floor the desk and its chair take up. */
  readonly footprint: Rect;
  /** The desk top's and the chair's own rectangles, for contact shadows. */
  readonly desk: Rect;
  readonly chair: Rect;
  /** The centre of the chair's seat, on the floor. */
  readonly seat: Vec3;
  /** The way the Agent faces at the desk. */
  readonly turns: QuarterTurns;
  /**
   * The desk's screens, one or a designer's two side by side: the middle
   * of them, and their size together. They face the Agent's chair.
   */
  readonly screens: { readonly centre: Vec3; readonly size: Vec3 };
  /**
   * Each screen's own centre, from the Agent's left to its right: one, or
   * a designer's two. Each is a monitor's `width` by `height`, its face
   * `screenDepth / 2` towards the chair.
   */
  readonly screenCentres: readonly Vec3[];
}

/** How wide a Role's screens are together, side to side. */
const screensWidth = (owner: DeskRole) =>
  deskLookOf(owner) === "dual-monitors"
    ? dualScreens[1] - dualScreens[0] + monitor.width
    : monitor.width;

/**
 * A Role's desk set, named `name`, its desk's centre at `at` on the floor
 * and turned by `turns` (0: the Agent faces -z).
 */
export function deskSet(
  name: string,
  role: DeskRole,
  at: readonly [number, number],
  turns: QuarterTurns,
): DeskSet {
  const { pieces: dressed, models } = dressing(name, role);
  const stripe = roleStageToken(role);
  const local: Piece[] = [
    piece(
      `${name}, desk top`,
      "box",
      "desk-top",
      "wood",
      "furniture",
      [desk.width, desk.thickness, desk.depth],
      [0, deskTopY, 0],
    ),
    ...[-1, 1].map((side) =>
      standing(
        `${name}, desk ${side < 0 ? "left" : "right"} leg`,
        "metal-dark",
        "metal",
        "furniture",
        [0.04, desk.top - desk.thickness, desk.depth - 0.1],
        [side * (desk.width / 2 - 0.04), 0],
      ),
    ),
    // The Stage's stripe along the desk's front edge.
    ...(stripe === undefined
      ? []
      : [
          piece(
            `${name}, stripe`,
            "box",
            stripe,
            "paint",
            "furniture",
            [desk.width, desk.thickness, 0.012],
            [0, deskTopY, frontEdge + 0.006],
          ),
        ]),
    ...dressed,
    ...chairPieces(`${name}, chair`).map((each) => ({
      ...each,
      position: [
        each.position[0],
        each.position[1],
        each.position[2] + chairOffset,
      ] as Vec3,
    })),
  ];
  const deskRect: Rect = {
    x: [-desk.width / 2, desk.width / 2],
    z: [-desk.depth / 2, desk.depth / 2 + 0.012],
  };
  const chairRect: Rect = {
    x: [-chair.size / 2, chair.size / 2],
    z: [chairOffset - chair.size / 2, chairOffset + chair.size / 2],
  };
  return {
    pieces: placePieces(local, turns, at),
    models: models.map(({ model, at: position }) => ({
      name: `${name}, ${model}`,
      model,
      position: turnPoint(position, turns, at),
      turns,
      role: "prop",
    })),
    footprint: turnRect(
      { x: deskRect.x, z: [deskRect.z[0], chairRect.z[1]] },
      turns,
      at,
    ),
    desk: turnRect(deskRect, turns, at),
    chair: turnRect(chairRect, turns, at),
    seat: turnPoint([0, 0, chairOffset], turns, at),
    turns,
    screens: {
      centre: turnPoint(
        [0, monitor.top - monitor.height / 2, monitorZ],
        turns,
        at,
      ),
      size: turnSize([screensWidth(role), monitor.height, screenDepth], turns),
    },
    screenCentres: screenXs(role).map((x) =>
      turnPoint([x, monitor.top - monitor.height / 2, monitorZ], turns, at),
    ),
  };
}
