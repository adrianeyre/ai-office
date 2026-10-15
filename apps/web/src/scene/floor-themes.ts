import type { FloorTheme } from "@ai-office/shared";
import type { PaletteToken } from "@ai-office/shared/palette";

import type { Vec3 } from "./camera-rig.ts";
import { chairPieces, type Rect } from "./desk-set.ts";
import type { Surface } from "./materials.ts";
import { modelCatalogue } from "./model-catalogue.ts";
import type { ModelPlacement } from "./models.ts";
import {
  footprint,
  lying,
  piece,
  placePieces,
  standing,
  turnPoint,
  turnSize,
  type Piece,
  type PieceRole,
  type QuarterTurns,
} from "./pieces.ts";

// A Floor's 3D theme (PRD FR-57, FR-99): the props its Floor Template
// dresses it in, such as stock shelves and parcels for an Online store or
// server racks for Infrastructure. A theme is data: a list of props, each
// one of the kinds below, placed and turned in the theme's zone along the
// Floor's left wall, in front of the lounge, beside the desks and clear of
// every walkway. The
// rest of the Floor is the same in every theme; Development's office is a
// break area for the lounge, between the dartboard and the games hall.
//
// Props are built from pieces in the palette's colours, like the rooms,
// and from the asset pack's bookcase and books. They are decoration only:
// no Agent walks to them and nothing waits for them.

/**
 * Where a theme's props stand: from the left wall to just short of the
 * left-most desks' carpet, and from just in front of the lounge (its
 * sofa, fish tank and dartboard, and the walkway beside them, which end
 * by z 4.3) to the front of the smallest Floor (z 8, the gym's
 * depth). The Floor grows forwards, never into it.
 */
export const themeZone: Rect = { x: [-10, -7.5], z: [4.4, 8] };

/** The left wall's inner face, where wall-mounted props hang. */
const wallX = themeZone.x[0];

/** One prop of a theme: its kind, where its origin is, and how it is turned. */
export interface ThemeProp {
  readonly prop: ThemePropKind;
  /** Its origin on the floor: a free-standing prop's centre, or a wall prop's middle at the wall. */
  readonly at: readonly [number, number];
  /** Quarter turns, as a desk's: 1 faces +x, out from the left wall. */
  readonly turns: QuarterTurns;
}

/** What a prop is made of, about its own origin, facing +z. */
interface PropParts {
  readonly pieces: Piece[];
  readonly models: {
    model: ModelPlacement["model"];
    at: Vec3;
    turns?: QuarterTurns;
  }[];
}

const box = (
  name: string,
  token: PaletteToken,
  surface: Surface,
  role: PieceRole,
  size: Vec3,
  position: Vec3,
) => piece(name, "box", token, surface, role, size, position);

/** A box standing on something `base` high, its footprint centred at `x`, `z`. */
const on = (
  base: number,
  name: string,
  token: PaletteToken,
  surface: Surface,
  [width, height, depth]: Vec3,
  [x, z]: readonly [number, number],
  role: PieceRole = "prop",
) =>
  box(
    name,
    token,
    surface,
    role,
    [width, height, depth],
    [x, base + height / 2, z],
  );

/** A parcel: a box of cardboard (birch), with its tape across the top. */
const parcel = (
  name: string,
  base: number,
  [width, height, depth]: Vec3,
  [x, z]: readonly [number, number],
): Piece[] => [
  on(base, name, "desk-top", "paint", [width, height, depth], [x, z]),
  on(
    base + height,
    `${name}, tape`,
    "ceramic",
    "plastic",
    [width + 0.004, 0.004, Math.min(0.06, depth / 3)],
    [x, z],
  ),
];

/** A plain table: a top `height` up on two legs, like a desk's. */
const table = (name: string, [width, height, depth]: Vec3): Piece[] => [
  on(
    height - 0.04,
    `${name}, top`,
    "desk-top",
    "wood",
    [width, 0.04, depth],
    [0, 0],
    "furniture",
  ),
  ...[-1, 1].map((side) =>
    standing(
      `${name}, ${side < 0 ? "left" : "right"} leg`,
      "metal-dark",
      "metal",
      "furniture",
      [0.04, height - 0.04, depth - 0.1],
      [side * (width / 2 - 0.04), 0],
    ),
  ),
];

/** A Floor-standing light or camera's pole on a round foot. */
const stand = (name: string, height: number): Piece[] => [
  standing(
    `${name}, foot`,
    "metal-dark",
    "metal",
    "furniture",
    [0.4, 0.03, 0.4],
    [0, 0],
    "cylinder",
  ),
  standing(
    `${name}, pole`,
    "metal-dark",
    "metal",
    "furniture",
    [0.035, height, 0.035],
    [0, 0],
    "cylinder",
  ),
];

/** Metal shelving: four uprights and `levels` birch shelves, its back at z = 0. */
function shelving(
  name: string,
  [width, height, depth]: Vec3,
  levels: readonly number[],
): Piece[] {
  return [
    ...[-1, 1].flatMap((side) =>
      [0.02, depth - 0.02].map((z) =>
        standing(
          `${name}, upright`,
          "metal-dark",
          "metal",
          "furniture",
          [0.04, height, 0.04],
          [side * (width / 2 - 0.02), z],
        ),
      ),
    ),
    ...levels.map((level) =>
      on(
        level,
        `${name}, shelf`,
        "desk-top",
        "wood",
        [width, 0.03, depth],
        [0, depth / 2],
        "furniture",
      ),
    ),
  ];
}

// The props, each about its origin facing +z. A wall prop's back is at
// z = 0, its origin on the wall; a free-standing prop is centred on its
// origin.

/** Online store: stock shelves full of parcels and products. */
function stockShelves(variant: number): PropParts {
  const name = `stock shelves ${String(variant)}`;
  const levels = [0.1, 0.62, 1.14, 1.66];
  const depth = 0.5;
  const top = (level: number) => level + 0.03;
  // Each shelf's load from the left: its centre, size and whether it is a
  // parcel (taped cardboard) or a product's box, in a muted accent.
  const loads: readonly (readonly [number, Vec3, PaletteToken | "parcel"])[][] =
    [
      [
        [-0.6, [0.45, 0.35, 0.4], "parcel"],
        [-0.1, [0.4, 0.28, 0.38], "parcel"],
        [0.45, [0.5, 0.4, 0.42], "parcel"],
      ],
      [
        [-0.62, [0.22, 0.3, 0.3], "sofa"],
        [-0.36, [0.22, 0.3, 0.3], "sofa"],
        [0.05, [0.35, 0.25, 0.36], "parcel"],
        [0.5, [0.28, 0.32, 0.3], "chair"],
      ],
      [
        [-0.5, [0.55, 0.3, 0.4], "parcel"],
        [0.15, [0.3, 0.22, 0.3], "ceramic"],
        [0.55, [0.3, 0.38, 0.34], "parcel"],
      ],
      [
        [-0.55, [0.35, 0.26, 0.36], "parcel"],
        [0.0, [0.3, 0.3, 0.3], "plant"],
        [0.45, [0.4, 0.2, 0.38], "parcel"],
      ],
    ];
  // The second unit's shelves hold the same loads, mirrored.
  const flip = variant % 2 === 0 ? -1 : 1;
  return {
    pieces: [
      ...shelving(name, [1.8, 2.0, depth], levels),
      ...loads.flatMap((shelf, index) =>
        shelf.flatMap(([x, size, kind], item) => {
          const at = [flip * x, depth / 2] as const;
          const base = top(levels[index] ?? 0);
          const label = `${name}, shelf ${String(index + 1)} item ${String(item + 1)}`;
          return kind === "parcel"
            ? parcel(label, base, size, at)
            : [on(base, label, kind, "paint", size, at)];
        }),
      ),
    ],
    models: [],
  };
}

/** Online store: parcels stacked on a pallet, ready to go out. */
function palletOfParcels(): PropParts {
  const name = "pallet of parcels";
  const pallet = 0.14;
  return {
    pieces: [
      on(
        0,
        `${name}, pallet`,
        "desk-top",
        "wood",
        [1.2, pallet, 0.8],
        [0, 0],
        "furniture",
      ),
      ...(
        [
          [-0.3, -0.2, [0.55, 0.4, 0.38]],
          [0.3, -0.2, [0.55, 0.4, 0.38]],
          [-0.3, 0.2, [0.55, 0.4, 0.38]],
          [0.3, 0.2, [0.55, 0.4, 0.38]],
        ] as const
      ).flatMap(([x, z, size], index) =>
        parcel(
          `${name}, parcel ${String(index + 1)}`,
          pallet,
          [...size],
          [x, z],
        ),
      ),
      ...parcel(
        `${name}, parcel on top 1`,
        pallet + 0.4,
        [0.5, 0.32, 0.36],
        [-0.25, -0.1],
      ),
      ...parcel(
        `${name}, parcel on top 2`,
        pallet + 0.4,
        [0.4, 0.26, 0.34],
        [0.3, 0.15],
      ),
    ],
    models: [],
  };
}

/** Online store: a packing table, a parcel half packed and flat boxes. */
function packingTable(): PropParts {
  const name = "packing table";
  const height = 0.9;
  return {
    pieces: [
      ...table(name, [1.4, height, 0.7]),
      on(
        height,
        `${name}, open parcel`,
        "desk-top",
        "paint",
        [0.42, 0.26, 0.32],
        [-0.3, 0],
      ),
      on(
        height,
        `${name}, flat boxes`,
        "desk-top",
        "paint",
        [0.6, 0.06, 0.45],
        [0.3, -0.05],
      ),
      lying(
        "x",
        piece(
          `${name}, tape roll`,
          "cylinder",
          "ceramic",
          "plastic",
          "prop",
          [0.05, 0.1, 0.1],
          [0.3, height + 0.11, 0.2],
        ),
      ),
      ...parcel(`${name}, parcel under it`, 0, [0.5, 0.35, 0.4], [0.3, 0]),
    ],
    models: [],
  };
}

/** Content & blog: a printing press, with paper in and printed sheets out. */
function printingPress(): PropParts {
  const name = "printing press";
  const width = 1.5;
  return {
    pieces: [
      on(
        0,
        `${name}, base`,
        "metal-dark",
        "metal",
        [width, 0.55, 0.9],
        [0, 0],
        "furniture",
      ),
      // Its frame either side, and the rollers between them.
      ...[-1, 1].map((side) =>
        on(
          0.55,
          `${name}, ${side < 0 ? "left" : "right"} frame`,
          "metal-dark",
          "metal",
          [0.1, 0.75, 0.8],
          [side * (width / 2 - 0.05), 0],
          "furniture",
        ),
      ),
      ...[
        [0.75, 0.18],
        [0.95, -0.05],
        [1.12, 0.15],
      ].map(([y = 0, z = 0], index) =>
        lying(
          "x",
          piece(
            `${name}, roller ${String(index + 1)}`,
            "cylinder",
            "metal-light",
            "metal",
            "furniture",
            [width - 0.2, 0.2, 0.2],
            [0, y, z],
          ),
        ),
      ),
      // The flywheel on its side, in the press's old red.
      lying(
        "x",
        piece(
          `${name}, flywheel`,
          "cylinder",
          "sofa",
          "plastic",
          "furniture",
          [0.06, 0.9, 0.9],
          [-(width / 2 + 0.04), 0.95, 0],
        ),
      ),
      lying(
        "x",
        piece(
          `${name}, axle`,
          "cylinder",
          "metal-light",
          "metal",
          "furniture",
          [0.12, 0.08, 0.08],
          [-(width / 2 + 0.02), 0.95, 0],
        ),
      ),
      // Paper in at the back, the printed sheets out at the front.
      on(
        1.3,
        `${name}, feed board`,
        "desk-top",
        "wood",
        [width - 0.3, 0.03, 0.4],
        [0, -0.3],
        "furniture",
      ),
      on(
        1.33,
        `${name}, paper in`,
        "paper",
        "paint",
        [0.8, 0.12, 0.3],
        [0, -0.3],
      ),
      on(
        0.55,
        `${name}, delivery tray`,
        "metal-light",
        "metal",
        [width - 0.3, 0.03, 0.35],
        [0, 0.6],
        "furniture",
      ),
      on(
        0.58,
        `${name}, printed sheets`,
        "paper",
        "paint",
        [0.8, 0.08, 0.3],
        [0, 0.6],
      ),
      on(
        0.66,
        `${name}, ink on the top sheet`,
        "ink",
        "paint",
        [0.6, 0.004, 0.2],
        [0, 0.6],
      ),
    ],
    models: [],
  };
}

/** Content & blog: bundles of the printed paper, tied up. */
function paperBundles(): PropParts {
  const name = "paper bundles";
  const bundle = (
    index: number,
    base: number,
    x: number,
    z: number,
  ): Piece[] => [
    on(
      base,
      `${name}, bundle ${String(index)}`,
      "paper",
      "paint",
      [0.42, 0.22, 0.3],
      [x, z],
    ),
    on(
      base + 0.05,
      `${name}, bundle ${String(index)} band`,
      "ink",
      "paint",
      [0.43, 0.04, 0.31],
      [x, z],
    ),
  ];
  return {
    pieces: [
      ...bundle(1, 0, -0.25, 0),
      ...bundle(2, 0.22, -0.22, 0.02),
      ...bundle(3, 0, 0.25, 0.05),
    ],
    models: [],
  };
}

/** Documentation and Content & blog: a bookcase against the wall, full of books. */
function bookcaseOfBooks(): PropParts {
  const { size, shelves } = modelCatalogue.bookcase;
  const [first, second, third] = shelves;
  return {
    pieces: [],
    models: [
      { model: "bookcase", at: [0, 0, size[2] / 2] },
      ...(
        [
          [-0.2, first],
          [0.18, first],
          [-0.15, second],
          [0.2, second],
          [0.05, third],
        ] as const
      ).map(([x, shelf]) => ({
        model: "books" as const,
        at: [x, shelf, size[2] / 2 + 0.02] as Vec3,
      })),
    ],
  };
}

/** Documentation: a rolling library ladder against the bookcases. */
function libraryLadder(): PropParts {
  const name = "library ladder";
  const height = 2.2;
  return {
    pieces: [
      ...[-0.2, 0.2].map((x) =>
        standing(
          `${name}, rail`,
          "desk-top",
          "wood",
          "furniture",
          [0.05, height, 0.05],
          [x, 0],
        ),
      ),
      ...[0.35, 0.7, 1.05, 1.4, 1.75].map((y, index) =>
        box(
          `${name}, rung ${String(index + 1)}`,
          "desk-top",
          "wood",
          "furniture",
          [0.4, 0.03, 0.04],
          [0, y, 0],
        ),
      ),
    ],
    models: [],
  };
}

/** Documentation: a reading table with a lamp and a book open on it. */
function readingTable(): PropParts {
  const name = "reading table";
  const height = 0.74;
  return {
    pieces: [
      ...table(name, [1.0, height, 0.6]),
      on(
        height,
        `${name}, open book`,
        "paper",
        "paint",
        [0.32, 0.03, 0.22],
        [0.1, 0.05],
      ),
      on(
        height,
        `${name}, lamp foot`,
        "metal-dark",
        "metal",
        [0.14, 0.02, 0.14],
        [-0.32, -0.15],
      ),
      standing(
        `${name}, lamp stem`,
        "metal-dark",
        "metal",
        "prop",
        [0.025, 0.4, 0.025],
        [-0.32, -0.15],
        "cylinder",
      ),
      piece(
        `${name}, lamp shade`,
        "cylinder",
        "lamp",
        "lamp",
        "prop",
        [0.22, 0.08, 0.14],
        [-0.32, height + 0.42, -0.12],
      ),
      ...chairPieces(`${name}, chair`).map((each) => ({
        ...each,
        position: [
          each.position[0],
          each.position[1],
          each.position[2] + 0.55,
        ] as Vec3,
      })),
    ],
    models: [],
  };
}

/** Data & analytics: a dashboard on the wall, its charts glowing on its screen. */
function wallDashboard(variant: number): PropParts {
  const name = `wall dashboard ${String(variant)}`;
  const width = 1.4;
  const height = 0.85;
  const middle = 1.7;
  const face = 0.06;
  const bottom = middle - height / 2 + 0.1;
  // Each dashboard shows its own: bars, a donut and a trend of points.
  const bars: readonly (readonly [number, number, PaletteToken])[] = [
    [-0.55, 0.22, "screen-glow"],
    [-0.42, 0.38, "screen-glow"],
    [-0.29, 0.3, "stage-qa"],
    [-0.16, 0.5, "screen-glow"],
    [-0.03, 0.44, "stage-work"],
  ];
  const trend: readonly (readonly [number, number])[] = [
    [0.12, 0.12],
    [0.22, 0.2],
    [0.32, 0.16],
    [0.42, 0.3],
    [0.52, 0.42],
  ];
  return {
    pieces: [
      box(
        `${name}, bezel`,
        "metal-dark",
        "metal",
        "prop",
        [width + 0.08, height + 0.08, 0.04],
        [0, middle, 0.02],
      ),
      box(
        `${name}, screen`,
        "screen-off",
        "screen",
        "prop",
        [width, height, 0.01],
        [0, middle, 0.045],
      ),
      ...bars.map(([x, tall, token], index) =>
        box(
          `${name}, bar ${String(index + 1)}`,
          variant === 2 ? "state-ok" : token,
          "screen",
          "prop",
          [0.09, tall, 0.008],
          [x, bottom + tall / 2, face],
        ),
      ),
      ...(variant === 2
        ? trend.map(([x, y], index) =>
            box(
              `${name}, point ${String(index + 1)}`,
              "state-warning",
              "screen",
              "prop",
              [0.05, 0.05, 0.008],
              [x, bottom + y, face],
            ),
          )
        : [
            lying(
              "z",
              piece(
                `${name}, donut`,
                "cylinder",
                "screen-glow",
                "screen",
                "prop",
                [0.36, 0.36, 0.008],
                [0.32, middle, face],
              ),
            ),
            lying(
              "z",
              piece(
                `${name}, donut's hole`,
                "cylinder",
                "screen-off",
                "screen",
                "prop",
                [0.18, 0.18, 0.012],
                [0.32, middle, face + 0.002],
              ),
            ),
            box(
              `${name}, donut's share`,
              "stage-review",
              "screen",
              "prop",
              [0.09, 0.09, 0.012],
              [0.41, middle + 0.09, face + 0.002],
            ),
          ]),
    ],
    models: [],
  };
}

/** Data & analytics: a round table for looking at the numbers together. */
function analysisTable(): PropParts {
  const name = "analysis table";
  const height = 0.74;
  return {
    pieces: [
      piece(
        `${name}, top`,
        "cylinder",
        "desk-top",
        "wood",
        "furniture",
        [1.1, 0.04, 1.1],
        [0, height - 0.02, 0],
      ),
      standing(
        `${name}, post`,
        "metal-dark",
        "metal",
        "furniture",
        [0.08, height - 0.04, 0.08],
        [0, 0],
        "cylinder",
      ),
      standing(
        `${name}, foot`,
        "metal-dark",
        "metal",
        "furniture",
        [0.5, 0.03, 0.5],
        [0, 0],
        "cylinder",
      ),
      on(
        height,
        `${name}, printed chart`,
        "paper",
        "paint",
        [0.3, 0.005, 0.21],
        [-0.2, 0.15],
      ),
      on(
        height + 0.005,
        `${name}, chart's bars`,
        "stage-work",
        "paint",
        [0.16, 0.002, 0.08],
        [-0.2, 0.15],
      ),
      ...[-1, 1].flatMap((side, index) => [
        piece(
          `${name}, stool ${String(index + 1)} seat`,
          "cylinder",
          "chair",
          "fabric",
          "furniture",
          [0.36, 0.06, 0.36],
          [side * 0.85, 0.62, 0],
        ),
        standing(
          `${name}, stool ${String(index + 1)} post`,
          "metal-dark",
          "metal",
          "furniture",
          [0.05, 0.59, 0.05],
          [side * 0.85, 0],
          "cylinder",
        ),
      ]),
    ],
    models: [{ model: "laptop", at: [0.18, height, -0.1], turns: 2 }],
  };
}

/** Infrastructure: a server rack, its servers' status lights lit. */
function serverRack(): PropParts {
  const name = "server rack";
  const [width, height, depth] = [0.6, 2.0, 0.75];
  const front = depth;
  return {
    pieces: [
      on(
        0,
        `${name}, cabinet`,
        "metal-dark",
        "metal",
        [width, height, depth],
        [0, depth / 2],
        "furniture",
      ),
      ...[0.35, 0.75, 1.15, 1.55].flatMap((y, index) => [
        box(
          `${name}, server ${String(index + 1)}`,
          "metal-light",
          "metal",
          "prop",
          [width - 0.1, 0.2, 0.02],
          [0, y, front + 0.01],
        ),
        box(
          `${name}, server ${String(index + 1)} light`,
          index === 2 ? "screen-glow" : "state-ok",
          "lamp",
          "prop",
          [0.05, 0.03, 0.012],
          [width / 2 - 0.12, y + 0.05, front + 0.026],
        ),
      ]),
    ],
    models: [],
  };
}

/** Infrastructure: the cable tray over the racks along the wall. */
function cableTray(): PropParts {
  const name = "cable tray";
  const length = 3.1;
  return {
    pieces: [
      box(
        `${name}, tray`,
        "metal-light",
        "metal",
        "prop",
        [length, 0.06, 0.3],
        [0, 2.45, 0.4],
      ),
      box(
        `${name}, cables`,
        "chair",
        "fabric",
        "prop",
        [length, 0.05, 0.18],
        [0, 2.5, 0.4],
      ),
      ...[-1, 1].map((side) =>
        box(
          `${name}, hanger`,
          "metal-dark",
          "metal",
          "prop",
          [0.03, 0.52, 0.03],
          [side * (length / 2 - 0.2), 2.74, 0.4],
        ),
      ),
    ],
    models: [],
  };
}

/** Infrastructure: a raised floor of tiles under the racks. */
function raisedFloor(): PropParts {
  const [x0, x1] = themeZone.x;
  const [z0, z1] = themeZone.z;
  return {
    pieces: [
      standing(
        "raised floor",
        "metal-light",
        "paint",
        "architecture",
        [z1 - z0, 0.02, x1 - x0],
        [0, 0],
      ),
    ],
    models: [],
  };
}

/** Website & marketing: a photo studio's paper backdrop, its roll on the wall. */
function backdrop(): PropParts {
  const name = "backdrop";
  const width = 2.4;
  return {
    pieces: [
      lying(
        "x",
        piece(
          `${name}, roll`,
          "cylinder",
          "metal-dark",
          "metal",
          "furniture",
          [width + 0.2, 0.14, 0.14],
          [0, 2.6, 0.1],
        ),
      ),
      box(
        `${name}, paper`,
        "wall-feature",
        "paint",
        "prop",
        [width, 2.55, 0.02],
        [0, 1.3, 0.04],
      ),
      box(
        `${name}, sweep`,
        "wall-feature",
        "paint",
        "prop",
        [width, 0.02, 1.4],
        [0, 0.01, 0.75],
      ),
    ],
    models: [],
  };
}

/** Website & marketing: a studio light, a softbox on a stand. */
function softbox(): PropParts {
  const name = "softbox";
  return {
    pieces: [
      ...stand(name, 1.7),
      box(
        `${name}, box`,
        "metal-dark",
        "metal",
        "prop",
        [0.5, 0.5, 0.3],
        [0, 1.85, -0.02],
      ),
      box(
        `${name}, diffuser`,
        "lamp",
        "lamp",
        "prop",
        [0.46, 0.46, 0.02],
        [0, 1.85, 0.14],
      ),
    ],
    models: [],
  };
}

/** Website & marketing: a camera on its tripod, its lens towards the backdrop. */
function cameraOnTripod(): PropParts {
  const name = "camera";
  return {
    pieces: [
      ...stand(name, 1.3),
      box(
        `${name}, body`,
        "metal-dark",
        "metal",
        "prop",
        [0.16, 0.11, 0.1],
        [0, 1.36, 0],
      ),
      lying(
        "z",
        piece(
          `${name}, lens`,
          "cylinder",
          "ink",
          "plastic",
          "prop",
          [0.08, 0.08, 0.12],
          [0, 1.36, -0.11],
        ),
      ),
    ],
    models: [],
  };
}

/** Website & marketing: a product on a plinth, ready to be photographed. */
function productPlinth(): PropParts {
  const name = "product plinth";
  return {
    pieces: [
      on(
        0.02,
        `${name}, plinth`,
        "ceramic",
        "plastic",
        [0.45, 0.55, 0.45],
        [0, 0],
        "furniture",
      ),
      on(
        0.57,
        `${name}, product`,
        "sofa",
        "plastic",
        [0.14, 0.26, 0.14],
        [-0.06, 0],
      ),
      piece(
        `${name}, product's lid`,
        "cylinder",
        "ink",
        "plastic",
        "prop",
        [0.08, 0.06, 0.08],
        [-0.06, 0.86, 0],
      ),
      on(
        0.57,
        `${name}, product's box`,
        "paper",
        "paint",
        [0.16, 0.1, 0.12],
        [0.12, 0.08],
      ),
    ],
    models: [],
  };
}

/** Design system: a wall of colour swatches, the palette's own. */
function swatchWall(): PropParts {
  const name = "swatch wall";
  const rows: readonly (readonly PaletteToken[])[] = [
    ["stage-work", "stage-review", "stage-qa", "stage-docs"],
    ["sofa", "chair", "plant", "desk-top"],
    ["wall-feature", "floor-carpet", "metal-light", "ink"],
  ];
  return {
    pieces: [
      box(
        `${name}, board`,
        "paper",
        "paint",
        "prop",
        [1.9, 1.15, 0.02],
        [0, 1.65, 0.01],
      ),
      ...rows.flatMap((row, rowIndex) =>
        row.map((token, column) =>
          box(
            `${name}, swatch ${String(rowIndex + 1)}.${String(column + 1)}`,
            token,
            "paint",
            "prop",
            [0.36, 0.26, 0.012],
            [-0.66 + column * 0.44, 2.0 - rowIndex * 0.34, 0.026],
          ),
        ),
      ),
    ],
    models: [],
  };
}

/** Design system: an easel with a canvas of colour blocks. */
function easel(): PropParts {
  const name = "easel";
  return {
    pieces: [
      ...[-0.3, 0.3].map((x) =>
        standing(
          `${name}, leg`,
          "desk-top",
          "wood",
          "furniture",
          [0.04, 1.75, 0.04],
          [x, 0.05],
        ),
      ),
      standing(
        `${name}, back leg`,
        "desk-top",
        "wood",
        "furniture",
        [0.04, 1.6, 0.04],
        [0, -0.35],
      ),
      box(
        `${name}, ledge`,
        "desk-top",
        "wood",
        "furniture",
        [0.75, 0.03, 0.08],
        [0, 0.85, 0.08],
      ),
      box(
        `${name}, canvas`,
        "paper",
        "paint",
        "prop",
        [0.8, 0.62, 0.03],
        [0, 1.18, 0.08],
      ),
      box(
        `${name}, block 1`,
        "stage-work",
        "paint",
        "prop",
        [0.3, 0.24, 0.006],
        [-0.18, 1.3, 0.098],
      ),
      box(
        `${name}, block 2`,
        "sofa",
        "paint",
        "prop",
        [0.24, 0.3, 0.006],
        [0.18, 1.12, 0.098],
      ),
      box(
        `${name}, block 3`,
        "plant",
        "paint",
        "prop",
        [0.3, 0.12, 0.006],
        [-0.18, 1.02, 0.098],
      ),
    ],
    models: [],
  };
}

/** Design system: plinths with the forms components are made of. */
function formPlinths(): PropParts {
  const name = "form plinths";
  const plinths: readonly (readonly [
    number,
    number,
    Piece["shape"],
    PaletteToken,
  ])[] = [
    [-0.6, 0.9, "sphere", "stage-review"],
    [0, 0.7, "cylinder", "stage-work"],
    [0.6, 0.5, "box", "stage-docs"],
  ];
  return {
    pieces: plinths.flatMap(([x, height, shape, token], index) => [
      on(
        0,
        `${name}, plinth ${String(index + 1)}`,
        "ceramic",
        "plastic",
        [0.4, height, 0.4],
        [x, 0],
        "furniture",
      ),
      piece(
        `${name}, form ${String(index + 1)}`,
        shape,
        token,
        "plastic",
        "prop",
        [0.26, 0.26, 0.26],
        [x, height + 0.13, 0],
      ),
    ]),
    models: [],
  };
}

/** Design system: a big table with sheets of layouts and a fan of swatches. */
function layoutTable(): PropParts {
  const name = "layout table";
  const height = 0.9;
  return {
    pieces: [
      ...table(name, [1.6, height, 0.9]),
      on(
        height,
        `${name}, sheet 1`,
        "paper",
        "paint",
        [0.42, 0.004, 0.3],
        [-0.4, 0.05],
      ),
      on(
        height,
        `${name}, sheet 2`,
        "paper",
        "paint",
        [0.42, 0.004, 0.3],
        [0.1, -0.1],
      ),
      on(
        height + 0.004,
        `${name}, layout's header`,
        "stage-work",
        "paint",
        [0.36, 0.002, 0.06],
        [0.1, -0.2],
      ),
      ...(["sofa", "chair", "plant"] as const).map((token, index) =>
        on(
          height + index * 0.006,
          `${name}, swatch ${String(index + 1)}`,
          token,
          "paint",
          [0.06, 0.006, 0.2],
          [0.5 + index * 0.05, 0.1],
        ),
      ),
    ],
    models: [],
  };
}

/** Mobile app: a wall of phones and tablets on charge. */
function deviceWall(): PropParts {
  const name = "device wall";
  const width = 2.4;
  const phones = [0, 1, 2].flatMap((row) =>
    [0, 1, 2, 3, 4, 5].map((column) => {
      const lit = (row + column) % 3 !== 1;
      return box(
        `${name}, phone ${String(row + 1)}.${String(column + 1)}`,
        lit ? "screen-glow" : "screen-off",
        "screen",
        "prop",
        [0.08, 0.16, 0.012],
        [-1.0 + column * 0.3, 2.05 - row * 0.32, 0.04],
      );
    }),
  );
  return {
    pieces: [
      box(
        `${name}, board`,
        "ceramic",
        "plastic",
        "prop",
        [width, 1.15, 0.03],
        [0, 1.72, 0.015],
      ),
      ...phones,
      ...[0.95, 0.55].map((y, index) =>
        box(
          `${name}, tablet ${String(index + 1)}`,
          index === 0 ? "screen-glow" : "screen-off",
          "screen",
          "prop",
          [0.22, 0.3, 0.012],
          [y + 0.2, 1.9 - index * 0.4, 0.04],
        ),
      ),
    ],
    models: [],
  };
}

/** Mobile app: a test bench of phones on stands, against the wall. */
function testBench(): PropParts {
  const name = "test bench";
  const height = 0.74;
  return {
    pieces: [
      ...table(name, [1.6, height, 0.6]).map((each) => ({
        ...each,
        position: [
          each.position[0],
          each.position[1],
          each.position[2] + 0.3,
        ] as Vec3,
      })),
      ...[-0.55, -0.2, 0.15, 0.5].flatMap((x, index) => [
        on(
          height,
          `${name}, stand ${String(index + 1)}`,
          "metal-dark",
          "metal",
          [0.08, 0.02, 0.08],
          [x, 0.32],
        ),
        box(
          `${name}, phone ${String(index + 1)}`,
          index % 2 === 0 ? "screen-glow" : "screen-off",
          "screen",
          "prop",
          [0.075, 0.15, 0.01],
          [x, height + 0.1, 0.32],
        ),
      ]),
    ],
    models: [],
  };
}

/** Mobile app: a ring light for filming the screens. */
function ringLight(): PropParts {
  const name = "ring light";
  return {
    pieces: [
      ...stand(name, 1.4),
      lying(
        "z",
        piece(
          `${name}, ring`,
          "cylinder",
          "lamp",
          "lamp",
          "prop",
          [0.42, 0.42, 0.03],
          [0, 1.6, 0],
        ),
      ),
      lying(
        "z",
        piece(
          `${name}, phone holder`,
          "cylinder",
          "metal-dark",
          "metal",
          "prop",
          [0.22, 0.22, 0.034],
          [0, 1.6, 0],
        ),
      ),
    ],
    models: [],
  };
}

/**
 * Mobile app: a charging cart of tablets, standing in its slots. Its
 * cabinet is enamelled, as the fridge is: brushed steel reads almost black
 * in the Office's dim environment light.
 */
function chargingCart(): PropParts {
  const name = "charging cart";
  return {
    pieces: [
      on(
        0.08,
        `${name}, cabinet`,
        "ceramic",
        "plastic",
        [0.9, 0.8, 0.5],
        [0, 0],
        "furniture",
      ),
      ...[-0.3, 0.3].flatMap((x) =>
        [-0.18, 0.18].map((z) =>
          standing(
            `${name}, wheel`,
            "ink",
            "plastic",
            "furniture",
            [0.08, 0.08, 0.08],
            [x, z],
            "sphere",
          ),
        ),
      ),
      ...[-0.3, -0.18, -0.06, 0.06, 0.18, 0.3].map((x, index) =>
        on(
          0.88,
          `${name}, tablet ${String(index + 1)}`,
          index % 2 === 0 ? "screen-off" : "metal-dark",
          index % 2 === 0 ? "screen" : "metal",
          [0.015, 0.22, 0.3],
          [x, 0],
        ),
      ),
    ],
    models: [],
  };
}

// Development: the lounge's break area, between the dartboard and the
// games hall, so the left wall and the floor in front of it are not bare.

/** Development: a chalk scoreboard for the darts, beside the dartboard. */
function dartsScoreboard(): PropParts {
  const name = "darts scoreboard";
  const middle = 1.6;
  const face = 0.039;
  // Each column's chalked scores, from the top: how long each line is.
  const scores = [0.2, 0.14, 0.18, 0.1, 0.16];
  return {
    pieces: [
      box(
        `${name}, frame`,
        "desk-top",
        "wood",
        "prop",
        [0.76, 0.96, 0.03],
        [0, middle, 0.015],
      ),
      box(
        `${name}, board`,
        "chair",
        "paint",
        "prop",
        [0.68, 0.88, 0.01],
        [0, middle, 0.032],
      ),
      box(
        `${name}, heading`,
        "paper",
        "paint",
        "prop",
        [0.5, 0.02, 0.004],
        [0, middle + 0.35, face],
      ),
      box(
        `${name}, divider`,
        "paper",
        "paint",
        "prop",
        [0.01, 0.62, 0.004],
        [0, middle - 0.04, face],
      ),
      ...[-0.17, 0.17].flatMap((x, column) =>
        scores.map((width, row) =>
          box(
            `${name}, score ${String(column + 1)}.${String(row + 1)}`,
            "paper",
            "paint",
            "prop",
            [column === 0 ? width : 0.3 - width, 0.015, 0.004],
            [x, middle + 0.22 - row * 0.12, face],
          ),
        ),
      ),
      box(
        `${name}, chalk tray`,
        "desk-top",
        "wood",
        "prop",
        [0.6, 0.02, 0.05],
        [0, middle - 0.47, 0.04],
      ),
      box(
        `${name}, chalk`,
        "paper",
        "paint",
        "prop",
        [0.06, 0.012, 0.012],
        [0.15, middle - 0.454, 0.04],
      ),
    ],
    models: [],
  };
}

/** Development: a round clock on the wall, at ten past two. */
function wallClock(): PropParts {
  const name = "wall clock";
  const middle = 2.3;
  const face = 0.049;
  return {
    pieces: [
      lying(
        "z",
        piece(
          `${name}, rim`,
          "cylinder",
          "metal-dark",
          "metal",
          "prop",
          [0.36, 0.36, 0.04],
          [0, middle, 0.02],
        ),
      ),
      lying(
        "z",
        piece(
          `${name}, face`,
          "cylinder",
          "paper",
          "paint",
          "prop",
          [0.31, 0.31, 0.008],
          [0, middle, 0.043],
        ),
      ),
      // The hours' marks at twelve, three, six and nine.
      ...(
        [
          [0, 0.12, 0.012, 0.03],
          [0.12, 0, 0.03, 0.012],
          [0, -0.12, 0.012, 0.03],
          [-0.12, 0, 0.03, 0.012],
        ] as const
      ).map(([x, y, width, height], index) =>
        box(
          `${name}, mark ${String(index + 1)}`,
          "ink",
          "paint",
          "prop",
          [width, height, 0.004],
          [x, middle + y, face],
        ),
      ),
      box(
        `${name}, hour hand`,
        "ink",
        "paint",
        "prop",
        [0.06, 0.016, 0.004],
        [0.03, middle + 0.012, face + 0.002],
      ),
      box(
        `${name}, minute hand`,
        "ink",
        "paint",
        "prop",
        [0.012, 0.11, 0.004],
        [0.012, middle + 0.05, face + 0.004],
      ),
    ],
    models: [],
  };
}

/** A trophy on something `base` high at `x`, `z`: a cup on a stem on a plinth. */
const trophy = (
  name: string,
  base: number,
  tall: number,
  [x, z]: readonly [number, number],
): Piece[] => [
  on(
    base,
    `${name}, plinth`,
    "metal-dark",
    "metal",
    [0.09, 0.04, 0.09],
    [x, z],
  ),
  on(
    base + 0.04,
    `${name}, stem`,
    "state-warning",
    "plastic",
    [0.025, tall, 0.025],
    [x, z],
  ),
  piece(
    `${name}, cup`,
    "cylinder",
    "state-warning",
    "plastic",
    "prop",
    [0.11, 0.1, 0.11],
    [x, base + 0.04 + tall + 0.05, z],
  ),
];

/** Development: two shelves of the team's trophies, a signed ball and a team photo. */
function trophyShelves(): PropParts {
  const name = "trophy shelves";
  const width = 1.1;
  const depth = 0.22;
  const levels = [1.45, 1.85] as const;
  const [lower, upper] = levels.map((level) => level + 0.015) as [
    number,
    number,
  ];
  return {
    pieces: [
      ...levels.flatMap((level) => [
        box(
          `${name}, shelf`,
          "desk-top",
          "wood",
          "prop",
          [width, 0.03, depth],
          [0, level, depth / 2],
        ),
        ...[-1, 1].map((side) =>
          box(
            `${name}, bracket`,
            "metal-dark",
            "metal",
            "prop",
            [0.03, 0.12, depth - 0.04],
            [side * (width / 2 - 0.1), level - 0.075, (depth - 0.04) / 2],
          ),
        ),
      ]),
      ...trophy(`${name}, trophy 1`, lower, 0.06, [-0.35, 0.11]),
      ...trophy(`${name}, trophy 2`, lower, 0.14, [-0.05, 0.11]),
      ...trophy(`${name}, trophy 3`, lower, 0.08, [0.3, 0.11]),
      piece(
        `${name}, signed ball`,
        "sphere",
        "sofa",
        "plastic",
        "prop",
        [0.2, 0.2, 0.2],
        [-0.33, upper + 0.1, 0.11],
      ),
      box(
        `${name}, team photo, frame`,
        "metal-dark",
        "metal",
        "prop",
        [0.26, 0.2, 0.02],
        [0.08, upper + 0.1, 0.06],
      ),
      box(
        `${name}, team photo`,
        "light-ground",
        "paint",
        "prop",
        [0.21, 0.15, 0.004],
        [0.08, upper + 0.1, 0.072],
      ),
      ...trophy(`${name}, trophy 4`, upper, 0.05, [0.38, 0.11]),
    ],
    models: [],
  };
}

/**
 * Development: a string of pennants, each a slice of a thin disc hung
 * point down from the string. A slice's arc is about the axis its disc
 * lies along once turned onto the left wall (x), about which up is a
 * quarter turn: so it hangs only there.
 */
function pennants(): PropParts {
  const name = "pennants";
  const string = 2.5;
  const length = 0.18;
  const spread = 0.5;
  const colours: readonly PaletteToken[] = [
    "state-critical",
    "state-warning",
    "stage-work",
    "state-ok",
    "stage-docs",
    "stage-review",
  ];
  return {
    pieces: [
      box(
        `${name}, string`,
        "ink",
        "fabric",
        "prop",
        [1.04, 0.01, 0.01],
        [0, string, 0.02],
      ),
      ...colours.map((token, index): Piece => ({
        ...lying(
          "z",
          piece(
            `${name}, pennant ${String(index + 1)}`,
            "cylinder",
            token,
            "fabric",
            "prop",
            [2 * length, 2 * length, 0.004],
            [-0.42 + index * 0.168, string - length, 0.026],
          ),
        ),
        arc: [Math.PI / 2 - spread / 2, spread],
      })),
    ],
    models: [],
  };
}

/** Development: a slatted bench against the wall, a sports bag on it and a ball under it. */
function bench(): PropParts {
  const name = "bench";
  const length = 1.4;
  const seat = 0.45;
  return {
    pieces: [
      ...[-0.13, 0, 0.13].map((z) =>
        on(
          seat - 0.03,
          `${name}, slat`,
          "desk-top",
          "wood",
          [length, 0.03, 0.12],
          [0, z],
          "furniture",
        ),
      ),
      ...[-1, 1].map((side) =>
        standing(
          `${name}, ${side < 0 ? "left" : "right"} leg`,
          "metal-dark",
          "metal",
          "furniture",
          [0.05, seat - 0.03, 0.36],
          [side * (length / 2 - 0.1), 0],
        ),
      ),
      on(
        seat,
        `${name}, sports bag`,
        "stage-work",
        "fabric",
        [0.42, 0.2, 0.24],
        [0.35, 0],
      ),
      standing(
        `${name}, spare ball`,
        "sofa",
        "plastic",
        "prop",
        [0.24, 0.24, 0.24],
        [-0.3, 0.02],
        "sphere",
      ),
    ],
    models: [],
  };
}

/** Development: a low table on a rug, with magazines, a mug and a board game on it. */
function coffeeTable(): PropParts {
  const name = "coffee table";
  const height = 0.42;
  return {
    pieces: [
      standing(
        `${name}, rug`,
        "stage-qa",
        "fabric",
        "architecture",
        [1.7, 0.008, 1.5],
        [0, -0.45],
      ),
      ...table(name, [1.0, height, 0.55]),
      on(
        height,
        `${name}, magazine 1`,
        "stage-docs",
        "paint",
        [0.22, 0.01, 0.3],
        [-0.28, 0.02],
      ),
      on(
        height + 0.01,
        `${name}, magazine 2`,
        "paper",
        "paint",
        [0.22, 0.01, 0.3],
        [-0.25, 0.05],
      ),
      piece(
        `${name}, mug`,
        "cylinder",
        "ceramic",
        "plastic",
        "prop",
        [0.08, 0.1, 0.08],
        [0.05, height + 0.05, -0.1],
      ),
      on(
        height,
        `${name}, board game`,
        "stage-review",
        "paint",
        [0.3, 0.05, 0.3],
        [0.3, 0.05],
      ),
    ],
    models: [],
  };
}

/** Development: a potted plant, as the canteen has. */
function pottedPlant(): PropParts {
  return { pieces: [], models: [{ model: "potted-plant", at: [0, 0, 0] }] };
}

/** Every kind of prop, by name. */
const props = {
  "stock shelves 1": () => stockShelves(1),
  "stock shelves 2": () => stockShelves(2),
  "pallet of parcels": palletOfParcels,
  "packing table": packingTable,
  "printing press": printingPress,
  "paper bundles": paperBundles,
  bookcase: bookcaseOfBooks,
  "library ladder": libraryLadder,
  "reading table": readingTable,
  "wall dashboard 1": () => wallDashboard(1),
  "wall dashboard 2": () => wallDashboard(2),
  "analysis table": analysisTable,
  "server rack": serverRack,
  "cable tray": cableTray,
  "raised floor": raisedFloor,
  backdrop,
  softbox,
  "camera on a tripod": cameraOnTripod,
  "product plinth": productPlinth,
  "swatch wall": swatchWall,
  easel,
  "form plinths": formPlinths,
  "layout table": layoutTable,
  "device wall": deviceWall,
  "test bench": testBench,
  "ring light": ringLight,
  "charging cart": chargingCart,
  "darts scoreboard": dartsScoreboard,
  "wall clock": wallClock,
  "trophy shelves": trophyShelves,
  pennants,
  bench,
  "coffee table": coffeeTable,
  "potted plant": pottedPlant,
} as const satisfies Record<string, () => PropParts>;

export type ThemePropKind = keyof typeof props;

/** Along the left wall, facing into the room. */
const onWall = (prop: ThemePropKind, z: number): ThemeProp => ({
  prop,
  at: [wallX, z],
  turns: 1,
});

/** Standing free, centred at `x`, `z`. */
const at = (
  prop: ThemePropKind,
  x: number,
  z: number,
  turns: QuarterTurns = 1,
): ThemeProp => ({ prop, at: [x, z], turns });

/**
 * Eight racks in two rows facing each other across a narrow aisle: five
 * along the wall, and three opposite them, facing the wall.
 */
const racks: ThemeProp[] = [
  ...[4.75, 5.37, 5.99, 6.61, 7.23].map((z) => onWall("server rack", z)),
  ...[5.37, 5.99, 6.61].map((z) => ({
    prop: "server rack" as const,
    at: [-8.0, z] as const,
    turns: 3 as const,
  })),
];

/**
 * Each theme's props (FR-57): what its Floor Template's Floor looks like
 * beside the desks. Development's office is a break area for the lounge:
 * a scoreboard beside the dartboard, a clock, a shelf of trophies and
 * pennants on the wall, over a bench, a coffee table and a plant.
 */
export const floorThemeProps: Readonly<
  Record<FloorTheme, readonly ThemeProp[]>
> = {
  office: [
    onWall("darts scoreboard", 4.9),
    onWall("wall clock", 5.75),
    onWall("trophy shelves", 6.5),
    onWall("pennants", 7.35),
    at("bench", -9.75, 6.35),
    at("coffee table", -8.75, 6.35),
    at("potted plant", -9.65, 7.55, 0),
  ],
  stockroom: [
    onWall("stock shelves 1", 5.3),
    onWall("stock shelves 2", 7.1),
    at("packing table", -8.25, 5.2),
    at("pallet of parcels", -8.7, 7.5, 0),
  ],
  studio: [
    onWall("backdrop", 5.75),
    at("product plinth", -9.3, 5.75),
    at("softbox", -8.6, 4.65, 0),
    at("softbox", -8.6, 6.85, 2),
    at("camera on a tripod", -7.9, 5.75, 1),
  ],
  editorial: [
    onWall("bookcase", 4.85),
    onWall("bookcase", 5.8),
    at("printing press", -9.0, 7.1),
    at("paper bundles", -8.1, 5.0, 0),
  ],
  library: [
    onWall("bookcase", 4.85),
    onWall("bookcase", 5.75),
    onWall("bookcase", 6.65),
    onWall("bookcase", 7.55),
    at("library ladder", -9.55, 5.3),
    at("reading table", -8.6, 7.4, 1),
  ],
  atelier: [
    onWall("swatch wall", 5.4),
    at("layout table", -8.4, 5.3),
    at("easel", -8.2, 7.3, 1),
    at("form plinths", -9.55, 7.15),
  ],
  observatory: [
    onWall("wall dashboard 1", 5.15),
    onWall("wall dashboard 2", 6.65),
    at("analysis table", -8.4, 6.0),
  ],
  "data-centre": [
    { prop: "raised floor", at: [-8.75, 6.2], turns: 1 },
    ...racks,
    onWall("cable tray", 5.99),
  ],
  "device-lab": [
    onWall("device wall", 5.7),
    onWall("test bench", 5.7),
    at("ring light", -8.3, 5.7, 3),
    at("charging cart", -8.4, 7.4),
  ],
};

/** A theme's props, laid out: their pieces, models and what stands on the floor. */
export interface ThemeLayout {
  readonly pieces: readonly Piece[];
  readonly models: readonly ModelPlacement[];
  /** Under each prop that stands on the floor: Low's soft contact shadow. */
  readonly contactShadows: readonly Rect[];
}

/** The footprint of `rects` together. */
const around = (rects: readonly Rect[]): Rect => ({
  x: [
    Math.min(...rects.map(({ x }) => x[0])),
    Math.max(...rects.map(({ x }) => x[1])),
  ],
  z: [
    Math.min(...rects.map(({ z }) => z[0])),
    Math.max(...rects.map(({ z }) => z[1])),
  ],
});

/** A theme's props, placed on the Floor. */
export function themeLayout(theme: FloorTheme): ThemeLayout {
  const placed = floorThemeProps[theme].map(
    ({ prop, at: origin, turns }, index) => {
      const parts = props[prop]();
      const prefix = `${theme} ${String(index + 1)}: `;
      const pieces = placePieces(
        parts.pieces.map((each) => ({
          ...each,
          name: `${prefix}${each.name}`,
        })),
        turns,
        origin,
      );
      const models = parts.models.map(
        ({ model, at: position, turns: own = 0 }): ModelPlacement => ({
          name: `${prefix}${prop}, ${model}`,
          model,
          position: turnPoint(position, turns, origin),
          turns: ((own + turns) % 4) as QuarterTurns,
          role: model === "bookcase" ? "furniture" : "prop",
        }),
      );
      // What stands on the floor casts a contact shadow; what hangs on the
      // wall, and the floor's own covering, do not.
      const grounded = [
        ...pieces
          .filter(
            (each) =>
              each.role !== "architecture" &&
              each.position[1] - each.size[1] / 2 < 0.05,
          )
          .map(footprint),
        ...models
          .filter(({ position }) => position[1] < 0.05)
          .map((each): Rect => {
            const [width, , depth] = turnSize(
              modelCatalogue[each.model].size,
              each.turns,
            );
            const [x, , z] = each.position;
            return {
              x: [x - width / 2, x + width / 2],
              z: [z - depth / 2, z + depth / 2],
            };
          }),
      ];
      return {
        pieces,
        models,
        shadow: grounded.length === 0 ? undefined : around(grounded),
      };
    },
  );
  return {
    pieces: placed.flatMap(({ pieces }) => pieces),
    models: placed.flatMap(({ models }) => models),
    contactShadows: placed.flatMap(({ shadow }) =>
      shadow === undefined ? [] : [shadow],
    ),
  };
}
