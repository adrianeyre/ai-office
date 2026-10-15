import type { SeasonalEventId } from "@ai-office/shared";
import { seededRandom } from "@ai-office/shared/avatar";
import type { PaletteToken } from "@ai-office/shared/palette";

import type { Vec3 } from "./camera-rig.ts";
import type { Tint, UnboundShape } from "./avatar-parts.ts";
import type { Rect } from "./desk-set.ts";
import {
  floorCeiling,
  meetingTable,
  type FloorLayout,
} from "./floor-layout.ts";
import { liftDoorway, liftWall } from "./lift-layout.ts";
import { lobbyPieces, lobbySize, lobbyWalkways } from "./lobby-layout.ts";
import { footprint, type Piece } from "./pieces.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// The seasonal events' decorations (data only, no three.js): for each
// event on, a tree or pumpkins or eggs or balloons at spots kept clear of
// the walkways and every path, strings of fairy lights round the walls
// near the ceiling, things hanging overhead (at Christmas tinsel round
// every wall and across the ceiling, with baubles, stars and snowflakes
// everywhere), Easter eggs hidden all round the floor, clear of every
// path, and nibbles, Christmas party food or Halloween food on the meeting
// room table. The Owner may leave out Christmas's trees, lights or
// decorations, Halloween's decorations (gravestones, bats and its lights)
// or pumpkins, Easter's eggs and New Year's decorations. Shapes are the
// Avatar kit's, drawn as one
// mesh; the lights are small glowing bulbs in palette tokens, which
// twinkle.

/** A decoration's shapes and its fairy lights. */
export interface Decor {
  readonly shapes: readonly UnboundShape[];
  /** Shapes up by the ceiling, which cast no shadows. */
  readonly overhead?: readonly UnboundShape[];
  readonly lights: readonly {
    readonly token: PaletteToken;
    readonly at: Vec3;
  }[];
}

type Input = UnboundShape extends infer Each
  ? Each extends UnboundShape
    ? Omit<Each, "finish" | "detail"> & Partial<Pick<Each, "finish" | "detail">>
    : never
  : never;

const shape = (input: Input): UnboundShape => ({
  finish: "plastic",
  detail: "small",
  ...input,
});

const add = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 => [
  ax + bx,
  ay + by,
  az + bz,
];

const swatch = (colour: string): Tint => ({ swatch: colour });

/** Which of the events' decorations are up. */
export interface DecorChoices {
  /** The Christmas trees, with their presents. */
  readonly trees: boolean;
  /** Christmas's fairy lights, round the walls and on the trees. */
  readonly lights: boolean;
  /** Christmas's tinsel, baubles, stars and snowflakes. */
  readonly christmasDecorations: boolean;
  /** Halloween's gravestones, bats and orange and purple lights. */
  readonly halloweenDecorations: boolean;
  /** Halloween's pumpkins, lit from inside. */
  readonly pumpkins: boolean;
  /** Easter eggs all round the floor. */
  readonly eggs: boolean;
  /** New Year's balloons, streamers and lights. */
  readonly newYearDecorations: boolean;
}

/** Every decoration up. */
export const allDecorations: DecorChoices = {
  trees: true,
  lights: true,
  christmasDecorations: true,
  halloweenDecorations: true,
  pumpkins: true,
  eggs: true,
  newYearDecorations: true,
};

const none: Decor = { shapes: [], lights: [] };

/** Where the lobby's big tree stands: right of the lift, clear of every walkway. */
export const lobbyTreeSpot = [6.9, -3.4] as const;
/** How far the lobby's tree spreads from its trunk. */
export const lobbyTreeRadius = 1.05;
/** Where each Floor's tree stands: by the back wall, clear of every path. */
export const floorTreeSpot = [3.9, -5] as const;

/** Spots for small decorations, each clear 0.25 m round of every walkway. */
export const lobbySpots: readonly (readonly [number, number])[] = [
  [-6.4, -5.4],
  [-7.4, -2],
  [-7.4, 0.4],
  [-6.6, 5.2],
  [7, -2],
  [7, -0.8],
  [-4, 5],
  [-5.6, 4.4],
];

/** Spots for small decorations on a Floor, clear of its paths for any team. */
export const floorSpots: readonly (readonly [number, number])[] = [
  [0.8, -5.4],
  [1.6, -5.4],
  [6, -5.2],
  [-9.4, -5],
  [-9.2, 4.6],
  [8.8, 3.6],
  [9.2, -1.2],
];

/** A Christmas tree, `height` tall: tiers of green, baubles, a star, presents. */
function christmasTree(
  [x, z]: readonly [number, number],
  height: number,
  radius: number,
): Decor {
  const tiers = 4;
  const trunk = height * 0.12;
  const shapes: UnboundShape[] = [
    shape({
      name: "tree pot",
      kind: "frustum",
      tint: "stage-docs",
      from: [x, 0, z],
      to: [x, trunk, z],
      radii: [radius * 0.35, radius * 0.4],
    }),
  ];
  const tierHeight = (height - trunk) / tiers;
  for (let tier = 0; tier < tiers; tier += 1) {
    const bottom = trunk + tier * tierHeight * 0.8;
    const width = radius * (1 - tier * 0.2);
    shapes.push(
      shape({
        name: `tree tier ${String(tier + 1)}`,
        kind: "frustum",
        tint: "plant",
        finish: "fabric",
        detail: "large",
        from: [x, bottom, z],
        to: [x, bottom + tierHeight * 1.35, z],
        radii: [width, 0.02],
      }),
    );
  }
  const baubleTints: Tint[] = [
    "state-critical",
    "state-warning",
    "stage-work",
    "metal-light",
    "stage-review",
  ];
  const lights: { token: PaletteToken; at: Vec3 }[] = [];
  const lightTokens: PaletteToken[] = [
    "lamp",
    "state-critical",
    "state-ok",
    "stage-work",
    "state-warning",
  ];
  const turns = 5 + Math.round(radius * 3);
  const count = Math.round(height * 14 * Math.max(1, radius / 0.5));
  for (let index = 0; index < count; index += 1) {
    const along = index / count;
    const y = trunk + 0.1 + along * (height - trunk - 0.3);
    const r = radius * (1 - along) * 0.92 + 0.04;
    const angle = along * turns * Math.PI * 2;
    const at: Vec3 = [x + Math.cos(angle) * r, y, z + Math.sin(angle) * r];
    if (index % 3 === 0) {
      shapes.push(
        shape({
          name: `bauble ${String(index)}`,
          kind: "ellipsoid",
          tint: baubleTints[index % baubleTints.length] ?? "state-critical",
          finish: "metal",
          detail: "tiny",
          at: add(at, [0, -0.04, 0]),
          radii: [
            0.045 * radius + 0.02,
            0.045 * radius + 0.02,
            0.045 * radius + 0.02,
          ],
        }),
      );
    } else {
      lights.push({
        token: lightTokens[index % lightTokens.length] ?? "lamp",
        at,
      });
    }
  }
  lights.push({ token: "state-warning", at: [x, height + 0.04, z] });
  shapes.push(
    shape({
      name: "star",
      kind: "ellipsoid",
      tint: "state-warning",
      finish: "metal",
      at: [x, height + 0.04, z],
      radii: [0.045 * height, 0.045 * height, 0.015 * height],
    }),
  );
  // Presents under the tree, in front of it.
  const wraps: [Tint, Tint][] = [
    ["state-critical", "state-warning"],
    ["stage-work", "paper"],
    ["state-ok", "state-critical"],
    ["stage-review", "state-warning"],
  ];
  const presents = Math.max(4, Math.round(radius * 8));
  Array.from(
    { length: presents },
    (_, index) =>
      wraps[index % wraps.length] ??
      (["state-critical", "state-warning"] as [Tint, Tint]),
  ).forEach(([wrap, ribbon], index) => {
    // Round the front half of the tree, facing the room.
    const angle = Math.PI * (0.1 + (index / presents) * 0.8);
    const size = 0.18 + (index % 2) * 0.08 + (index % 3) * radius * 0.03;
    const at: Vec3 = [
      x + Math.cos(angle) * radius * 0.85,
      size / 2,
      z + Math.sin(angle) * radius * 0.7,
    ];
    shapes.push(
      shape({
        name: `present ${String(index + 1)}`,
        kind: "box",
        tint: wrap,
        finish: "fabric",
        at,
        rotation: [0, angle, 0],
        size: [size, size, size],
      }),
      shape({
        name: `present ${String(index + 1)} ribbon`,
        kind: "box",
        tint: ribbon,
        finish: "fabric",
        at: add(at, [0, 0.002, 0]),
        rotation: [0, angle, 0],
        size: [size * 0.2, size + 0.006, size + 0.006],
      }),
    );
  });
  return { shapes, lights };
}

/** A carved pumpkin, glowing inside. */
function pumpkin([x, z]: readonly [number, number], size: number): Decor {
  const orange = swatch("#e67e22");
  return {
    shapes: [
      ...[-1, 0, 1].map((rib) =>
        shape({
          name: `pumpkin ${String(rib + 2)}`,
          kind: "ellipsoid",
          tint: orange,
          at: [x + rib * size * 0.32, size * 0.42, z],
          radii: [size * 0.42, size * 0.42, size * 0.5],
        }),
      ),
      shape({
        name: "pumpkin stalk",
        kind: "capsule",
        tint: "plant",
        from: [x, size * 0.8, z],
        to: [x + size * 0.05, size * 0.98, z],
        radii: [size * 0.06, size * 0.05],
      }),
      ...[-1, 1].map((side) =>
        shape({
          name: `pumpkin eye ${String(side)}`,
          kind: "box",
          tint: "ink",
          detail: "tiny",
          at: [x + side * size * 0.2, size * 0.55, z + size * 0.49],
          rotation: [0, 0, Math.PI / 4],
          size: [size * 0.14, size * 0.14, 0.01],
        }),
      ),
      shape({
        name: "pumpkin grin",
        kind: "box",
        tint: "ink",
        detail: "tiny",
        at: [x, size * 0.3, z + size * 0.47],
        size: [size * 0.45, size * 0.08, 0.01],
      }),
    ],
    lights: [{ token: "state-warning", at: [x, size * 0.45, z + size * 0.3] }],
  };
}

/** A gravestone, rounded on top. */
function gravestone([x, z]: readonly [number, number]): Decor {
  return {
    shapes: [
      shape({
        name: "gravestone",
        kind: "box",
        tint: "state-neutral",
        finish: "fabric",
        at: [x, 0.25, z],
        size: [0.4, 0.5, 0.1],
      }),
      shape({
        name: "gravestone top",
        kind: "capsule",
        tint: "state-neutral",
        finish: "fabric",
        from: [x - 0.12, 0.5, z],
        to: [x + 0.12, 0.5, z],
        radii: [0.08, 0.08],
        flatten: 0.6,
      }),
    ],
    lights: [],
  };
}

/** A bat hanging from the ceiling. */
function bat(at: Vec3, turn: number): UnboundShape[] {
  const black = swatch("#1c1c1c");
  return [
    shape({
      name: "bat",
      kind: "ellipsoid",
      tint: black,
      detail: "tiny",
      at,
      radii: [0.04, 0.05, 0.035],
    }),
    ...[-1, 1].map((side) =>
      shape({
        name: `bat wing ${String(side)}`,
        kind: "ellipsoid",
        tint: black,
        detail: "tiny",
        at: add(at, [
          side * Math.cos(turn) * 0.11,
          0.02,
          side * Math.sin(turn) * 0.11,
        ]),
        rotation: [0, -turn, side * 0.35],
        radii: [0.1, 0.012, 0.05],
      }),
    ),
  ];
}

/** A basket of Easter eggs. */
function eggBasket([x, z]: readonly [number, number]): Decor {
  const pastels = ["#f4a6b7", "#9fd3ff", "#ffe066", "#81b29a", "#c9b6e4"];
  return {
    shapes: [
      shape({
        name: "basket",
        kind: "frustum",
        tint: swatch("#b07d4f"),
        finish: "fabric",
        from: [x, 0, z],
        to: [x, 0.16, z],
        radii: [0.16, 0.22],
      }),
      shape({
        name: "basket handle",
        kind: "torus",
        tint: swatch("#b07d4f"),
        finish: "fabric",
        at: [x, 0.16, z],
        radius: 0.2,
        tube: 0.012,
        arc: 0.5,
      }),
      ...pastels.map((colour, index) => {
        const angle = (index / pastels.length) * Math.PI * 2;
        return shape({
          name: `egg ${String(index + 1)}`,
          kind: "ellipsoid",
          tint: swatch(colour),
          detail: "tiny",
          at: [x + Math.cos(angle) * 0.1, 0.18, z + Math.sin(angle) * 0.1],
          rotation: [0.3 * Math.cos(angle), 0, 0.3 * Math.sin(angle)],
          radii: [0.045, 0.06, 0.045],
        });
      }),
    ],
    lights: [],
  };
}

/** A cluster of balloons on strings, tied to a weight. */
function balloons([x, z]: readonly [number, number], index: number): Decor {
  const colours = ["#d98e04", "#b9bec4", "#d64f8f", "#2e6fd8", "#81b29a"];
  return {
    shapes: [
      shape({
        name: "balloon weight",
        kind: "box",
        tint: "metal-dark",
        at: [x, 0.04, z],
        size: [0.08, 0.08, 0.08],
      }),
      ...[0, 1, 2].flatMap((balloon) => {
        const angle = (balloon / 3) * Math.PI * 2 + index;
        const top: Vec3 = [
          x + Math.cos(angle) * 0.18,
          1.6 + balloon * 0.12,
          z + Math.sin(angle) * 0.18,
        ];
        return [
          shape({
            name: `balloon string ${String(balloon + 1)}`,
            kind: "capsule",
            tint: "paper",
            detail: "tiny",
            from: [x, 0.08, z],
            to: add(top, [0, -0.17, 0]),
            radii: [0.003, 0.003],
          }),
          shape({
            name: `balloon ${String(balloon + 1)}`,
            kind: "ellipsoid",
            tint: swatch(
              colours[(index + balloon) % colours.length] ?? "#d98e04",
            ),
            finish: "metal",
            at: top,
            radii: [0.14, 0.17, 0.14],
          }),
        ];
      }),
    ],
    lights: [],
  };
}

/** A streamer hanging from the ceiling. */
function streamer(at: Vec3, colour: string): UnboundShape {
  return shape({
    name: "streamer",
    kind: "box",
    tint: swatch(colour),
    finish: "fabric",
    detail: "tiny",
    at: add(at, [0, -0.25, 0]),
    rotation: [0, 0.6, 0],
    size: [0.04, 0.5, 0.004],
  });
}

/** Points along a line sagging `sag` metres in the middle of each span of `span` metres. */
function swag(from: Vec3, to: Vec3, sag: number, span: number, every = 0.3) {
  const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
  const count = Math.max(2, Math.round(length / every));
  return Array.from({ length: count + 1 }, (_, index): Vec3 => {
    const t = index / count;
    return [
      from[0] + (to[0] - from[0]) * t,
      from[1] - sag * Math.abs(Math.sin(((t * length) / span) * Math.PI)),
      from[2] + (to[2] - from[2]) * t,
    ];
  });
}

const tinselColours = ["#d4af37", "#c0392b", "#b9bec4", "#2e8b57"] as const;

/** A rope of tinsel, swagged from `from` to `to`: shiny, a little fluffy. */
function tinsel(
  from: Vec3,
  to: Vec3,
  colour: string,
  sag: number,
  span: number,
): UnboundShape[] {
  const points = swag(from, to, sag, span, 0.4);
  // Square links, which glint like tinsel and cost a box each: tilted to
  // the sag (about z, first), then turned along the wall (about y).
  return points.slice(1).map((point, index) => {
    const start = points[index] ?? point;
    const [dx, dy, dz] = [
      point[0] - start[0],
      point[1] - start[1],
      point[2] - start[2],
    ];
    const level = Math.hypot(dx, dz);
    return shape({
      name: "tinsel",
      kind: "box",
      tint: swatch(colour),
      finish: "plastic",
      detail: "tiny",
      at: [
        (start[0] + point[0]) / 2,
        (start[1] + point[1]) / 2,
        (start[2] + point[2]) / 2,
      ],
      rotation: [0, Math.atan2(-dz, dx), Math.atan2(dy, level)],
      size: [Math.hypot(level, dy) + 0.02, 0.05, 0.05],
    });
  });
}

/** A thread from `from` straight down to `to`. */
const thread = (name: string, from: Vec3, to: Vec3): UnboundShape =>
  shape({
    name,
    kind: "box",
    tint: "paper",
    detail: "tiny",
    at: [from[0], (from[1] + to[1]) / 2, from[2]],
    size: [0.005, from[1] - to[1], 0.005],
  });

/** A bauble hanging on a thread from the ceiling at `at`, `drop` below it. */
function hangingBauble(at: Vec3, drop: number, colour: string): UnboundShape[] {
  const end = add(at, [0, -drop, 0]);
  return [
    thread("bauble thread", at, end),
    shape({
      name: "hanging bauble",
      kind: "ellipsoid",
      tint: swatch(colour),
      finish: "plastic",
      detail: "tiny",
      at: add(end, [0, -0.07, 0]),
      radii: [0.07, 0.07, 0.07],
    }),
  ];
}

/** A gold star or a white snowflake, hanging from the ceiling at `at`. */
function hangingStar(
  at: Vec3,
  snowflake: boolean,
  turn: number,
): UnboundShape[] {
  const centre = add(at, [0, -0.35, 0]);
  const arms = snowflake ? 3 : 5;
  return [
    thread("star thread", at, add(centre, [0, 0.12, 0])),
    ...Array.from({ length: arms }, (_, arm) =>
      shape({
        name: snowflake ? "snowflake" : "hanging star",
        kind: "box",
        tint: snowflake ? "paper" : swatch("#d4af37"),
        finish: snowflake ? "fabric" : "plastic",
        detail: "tiny",
        at: centre,
        rotation: [0, turn, (arm / arms) * Math.PI],
        size: snowflake ? [0.24, 0.025, 0.01] : [0.2, 0.05, 0.015],
      }),
    ),
  ];
}

/**
 * Christmas's decorations for a room within `x` and `z`, its ceiling at
 * `top`: tinsel round every wall, three ropes deep, and baubles, stars
 * and snowflakes hanging everywhere above heads. `gaps` are the stretches of
 * the back wall to leave clear (the lift); a Floor, seen cut away, has no
 * front wall.
 */
function christmasDecorations(
  x: readonly [number, number],
  z: readonly [number, number],
  top: number,
  gaps: readonly (readonly [number, number])[],
  frontWall = true,
): Decor {
  const inset = 0.05;
  const [left, right] = x;
  const [back, front] = z;
  const shapes: UnboundShape[] = [];
  // Round the walls: the back in pieces round its gaps.
  const backRuns: [number, number][] = [];
  let from = left + 0.2;
  for (const [start, end] of [...gaps].sort((a, b) => a[0] - b[0])) {
    backRuns.push([from, start]);
    from = end;
  }
  backRuns.push([from, right - 0.2]);
  const walls: [Vec3, Vec3][] = [
    ...backRuns
      .filter(([a, b]) => b - a > 0.4)
      .map(([a, b]): [Vec3, Vec3] => [
        [a, 0, back + inset],
        [b, 0, back + inset],
      ]),
    [
      [right - inset, 0, back + 0.2],
      [right - inset, 0, front - 0.2],
    ],
    ...(frontWall
      ? [
          [
            [right - 0.2, 0, front - inset],
            [left + 0.2, 0, front - inset],
          ] as [Vec3, Vec3],
        ]
      : []),
    [
      [left + inset, 0, front - 0.2],
      [left + inset, 0, back + 0.2],
    ],
  ];
  walls.forEach(([a, b], wall) => {
    [0, 1, 2].forEach((rope) => {
      const y = top - 0.08 - rope * 0.05;
      shapes.push(
        ...tinsel(
          [a[0], y, a[2]],
          [b[0], y, b[2]],
          tinselColours[(wall + rope) % tinselColours.length] ?? "#d4af37",
          0.18 + rope * 0.14,
          1.2 + rope * 0.5,
        ),
      );
    });
  });
  // Hanging everywhere, on a grid finer than the bats', above heads.
  const colours = ["#c0392b", "#d4af37", "#2e6fd8", "#b9bec4", "#2e8b57"];
  let index = 0;
  for (let px = left + 0.7; px < right - 0.4; px += 1.3) {
    for (let pz = back + 0.7; pz < front - 0.4; pz += 1.3) {
      const at: Vec3 = [px, top, pz];
      if (index % 4 === 1) {
        shapes.push(...hangingStar(at, false, index));
      } else if (index % 4 === 3) {
        shapes.push(...hangingStar(at, true, index));
      } else {
        shapes.push(
          ...hangingBauble(
            at,
            0.15 + (index % 3) * 0.12,
            colours[index % colours.length] ?? "#c0392b",
          ),
        );
      }
      index += 1;
    }
  }
  // Overhead, so it casts no shadows to speckle the floor.
  return { shapes: [], lights: [], overhead: shapes };
}

/** Fairy lights along a wall, sagging between hooks, `every` metres apart. */
function lightString(
  from: Vec3,
  to: Vec3,
  tokens: readonly PaletteToken[],
  every = 0.35,
): Decor["lights"] {
  const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
  const count = Math.max(2, Math.round(length / every));
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    const swag = Math.sin(((t * length) / 1.6) * Math.PI);
    return {
      token: tokens[index % tokens.length] ?? "lamp",
      at: [
        from[0] + (to[0] - from[0]) * t,
        from[1] - 0.12 * Math.abs(swag),
        from[2] + (to[2] - from[2]) * t,
      ] as Vec3,
    };
  });
}

/** Each event's fairy lights, by token. */
const lightTokens: Readonly<Record<SeasonalEventId, readonly PaletteToken[]>> =
  {
    christmas: [
      "state-critical",
      "state-ok",
      "lamp",
      "stage-work",
      "state-warning",
    ],
    halloween: ["state-warning", "stage-review"],
    easter: ["stage-docs", "screen-glow", "state-warning", "state-ok"],
    "new-year": ["state-warning", "lamp", "metal-light"],
  };

/** How far an Easter egg keeps from every path's middle: an Agent's shoulders and more. */
export const eggClearance = 0.5;

/** How many Easter eggs a room has, at most. */
export const eggsPerRoom = 90;

/** How far a point is from the segment from `a` to `b`. */
function fromSegment(
  [x, z]: FloorPoint,
  [ax, az]: FloorPoint,
  [bx, bz]: FloorPoint,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(
    0,
    Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
  );
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

const around = ([x, z]: readonly [number, number], half: number): Rect => ({
  x: [x - half, x + half],
  z: [z - half, z + half],
});

const inside = ([x, z]: FloorPoint, rect: Rect, margin: number) =>
  x > rect.x[0] - margin &&
  x < rect.x[1] + margin &&
  z > rect.z[0] - margin &&
  z < rect.z[1] + margin;

/** The pieces standing on the floor, which an egg must not be inside. */
const onTheFloor = (pieces: readonly Piece[]): Rect[] =>
  pieces
    .filter(
      (piece) =>
        piece.position[1] - piece.size[1] / 2 < 0.2 &&
        piece.position[1] + piece.size[1] / 2 > 0.02,
    )
    .map((piece) => footprint(piece));

/**
 * Spots for Easter eggs over a room: a jittered grid, at a fixed seed so
 * they stay put, keeping off everything on the floor, clear of `clear`,
 * and not too many.
 */
function eggSpotsIn(
  bounds: Rect,
  taken: readonly Rect[],
  clear: (point: FloorPoint) => boolean,
  seed: string,
): FloorPoint[] {
  const random = seededRandom(seed);
  const step = 0.75;
  const spots: FloorPoint[] = [];
  for (let x = bounds.x[0] + 0.3; x < bounds.x[1] - 0.2; x += step) {
    for (let z = bounds.z[0] + 0.3; z < bounds.z[1] - 0.2; z += step) {
      const point: FloorPoint = [
        x + (random() - 0.5) * step * 0.6,
        z + (random() - 0.5) * step * 0.6,
      ];
      if (
        point[0] > bounds.x[0] + 0.15 &&
        point[0] < bounds.x[1] - 0.15 &&
        point[1] > bounds.z[0] + 0.15 &&
        point[1] < bounds.z[1] - 0.15 &&
        !taken.some((rect) => inside(point, rect, 0.1)) &&
        clear(point)
      ) {
        spots.push(point);
      }
    }
  }
  // An even spread of them, if there are too many.
  const every = Math.max(1, spots.length / eggsPerRoom);
  return Array.from(
    { length: Math.min(spots.length, eggsPerRoom) },
    (_, index) => spots[Math.floor(index * every)],
  ).filter((spot) => spot !== undefined);
}

/** Where a Floor's Easter eggs lie: off its furniture, clear of every path and the lift. */
export function floorEggSpots(
  layout: Pick<FloorLayout, "bounds" | "pieces" | "waypoints">,
): FloorPoint[] {
  const byId = new Map(
    layout.waypoints.waypoints.map(({ id, position }) => [id, position]),
  );
  const paths = layout.waypoints.edges.flatMap(([a, b]) => {
    const from = byId.get(a);
    const to = byId.get(b);
    return from === undefined || to === undefined ? [] : [[from, to] as const];
  });
  const doorway: FloorPoint = [
    liftDoorway.position[0],
    liftDoorway.position[2],
  ];
  return eggSpotsIn(
    layout.bounds,
    [
      ...onTheFloor(layout.pieces),
      around(floorTreeSpot, 0.6),
      ...floorSpots.map((spot) => around(spot, 0.3)),
    ],
    (point) =>
      distance(point, doorway) > 1.2 &&
      paths.every(([from, to]) => fromSegment(point, from, to) > eggClearance),
    "floor easter eggs",
  );
}

/** Where the lobby's Easter eggs lie: off its furniture and its walkways. */
export const lobbyEggSpots: readonly FloorPoint[] = eggSpotsIn(
  {
    x: [-lobbySize.width / 2, lobbySize.width / 2],
    z: [-lobbySize.depth / 2, lobbySize.depth / 2],
  },
  [
    ...onTheFloor(lobbyPieces),
    ...lobbyWalkways.map((walkway): Rect => ({
      x: [walkway.x[0] - 0.2, walkway.x[1] + 0.2],
      z: [walkway.z[0] - 0.2, walkway.z[1] + 0.2],
    })),
    around(lobbyTreeSpot, lobbyTreeRadius + 0.2),
    ...lobbySpots.map((spot) => around(spot, 0.3)),
  ],
  () => true,
  "lobby easter eggs",
);

const eggColours = [
  "#f4a6b7",
  "#9fd3ff",
  "#ffe066",
  "#81b29a",
  "#c9b6e4",
  "#ffb37a",
  "#e05a6d",
  "#5fb3e0",
];

/** Easter eggs lying at `spots`, each its own colour, some with a band round them. */
export function easterEggs(spots: readonly FloorPoint[]): Decor {
  return {
    shapes: spots.flatMap(([x, z], index) => {
      const colour = eggColours[index % eggColours.length] ?? "#ffe066";
      const band = eggColours[(index * 3 + 2) % eggColours.length] ?? "#fff";
      // A banded egg stands up; the rest lie tilted every which way.
      const banded = index % 3 === 0;
      const tilt = banded ? 0 : 0.4 + ((index * 37) % 10) / 10;
      const egg = shape({
        name: "easter egg",
        kind: "ellipsoid",
        tint: swatch(colour),
        detail: "tiny",
        at: [x, banded ? 0.08 : 0.06, z],
        rotation: [0, index * 0.9, tilt],
        radii: [0.06, 0.08, 0.06],
      });
      return banded
        ? [
            egg,
            shape({
              name: "easter egg band",
              kind: "torus",
              tint: swatch(band),
              detail: "tiny",
              at: [x, 0.08, z],
              rotation: [Math.PI / 2, 0, 0],
              radius: 0.06,
              tube: 0.008,
            }),
          ]
        : [egg];
    }),
    lights: [],
  };
}

/** Halloween in a room: its pumpkins and its decorations, each if chosen. */
function halloween(
  choices: DecorChoices,
  pumpkins: Decor,
  decorations: Decor,
): Decor {
  return merge([
    choices.pumpkins ? pumpkins : none,
    choices.halloweenDecorations ? decorations : none,
  ]);
}

const merge = (parts: readonly Decor[]): Decor => {
  const overhead = parts.flatMap(({ overhead = [] }) => overhead);
  return {
    shapes: parts.flatMap(({ shapes }) => shapes),
    lights: parts.flatMap(({ lights }) => lights),
    ...(overhead.length === 0 ? {} : { overhead }),
  };
};

/** Where things hang from a ceiling: a grid over the room, above heads. */
const overhead = (
  x: readonly [number, number],
  z: readonly [number, number],
  y: number,
): Vec3[] => {
  const points: Vec3[] = [];
  for (let px = x[0] + 1; px < x[1]; px += 2.6) {
    for (let pz = z[0] + 1; pz < z[1]; pz += 2.6) {
      points.push([px, y, pz]);
    }
  }
  return points;
};

/** Christmas in a room: its tree, its lights and its decorations, each if chosen. */
function christmas(
  choices: DecorChoices,
  tree: Decor,
  lights: Decor["lights"],
  decorations: () => Decor,
): Decor {
  return merge([
    choices.trees
      ? { shapes: tree.shapes, lights: choices.lights ? tree.lights : [] }
      : none,
    choices.lights ? { shapes: [], lights } : none,
    choices.christmasDecorations ? decorations() : none,
  ]);
}

/** The lobby's decorations for the events on. */
export function lobbyDecor(
  events: readonly SeasonalEventId[],
  choices: DecorChoices = allDecorations,
): Decor {
  const halfWidth = lobbySize.width / 2;
  const halfDepth = lobbySize.depth / 2;
  const y = lobbySize.ceiling - 0.25;
  const liftLeft = liftDoorway.position[0] - liftWall.width / 2 - 0.1;
  const liftRight = liftDoorway.position[0] + liftWall.width / 2 + 0.1;
  const inset = 0.04;
  const walls = (tokens: readonly PaletteToken[]) => [
    ...lightString(
      [-halfWidth + 0.2, y, -halfDepth + inset],
      [liftLeft, y, -halfDepth + inset],
      tokens,
    ),
    ...lightString(
      [liftRight, y, -halfDepth + inset],
      [halfWidth - 0.2, y, -halfDepth + inset],
      tokens,
    ),
    ...lightString(
      [halfWidth - inset, y, -halfDepth + 0.2],
      [halfWidth - inset, y, halfDepth - 0.2],
      tokens,
    ),
    ...lightString(
      [-halfWidth + 0.2, y, halfDepth - inset],
      [halfWidth - 0.2, y, halfDepth - inset],
      tokens,
    ),
    ...lightString(
      [-halfWidth + inset, y, -halfDepth + 0.2],
      [-halfWidth + inset, y, halfDepth - 0.2],
      tokens,
    ),
  ];
  const hanging = overhead(
    [-halfWidth, halfWidth],
    [-halfDepth, halfDepth],
    y - 0.1,
  );
  return merge(
    events.map((event): Decor => {
      const lights = walls(lightTokens[event]);
      switch (event) {
        case "christmas":
          return christmas(
            choices,
            christmasTree(lobbyTreeSpot, 2.75, lobbyTreeRadius),
            lights,
            () =>
              christmasDecorations(
                [-halfWidth, halfWidth],
                [-halfDepth, halfDepth],
                lobbySize.ceiling,
                [[liftLeft, liftRight]],
              ),
          );
        case "halloween":
          return halloween(
            choices,
            merge(
              lobbySpots
                .slice(0, 5)
                .map((spot, index) => pumpkin(spot, 0.3 + (index % 2) * 0.12)),
            ),
            merge([
              ...lobbySpots.slice(5).map((spot) => gravestone(spot)),
              {
                shapes: hanging.flatMap((at, index) => bat(at, index)),
                lights,
              },
            ]),
          );
        case "easter":
          return merge([
            {
              shapes: lobbySpots.flatMap((spot) => eggBasket(spot).shapes),
              lights,
            },
            choices.eggs ? easterEggs(lobbyEggSpots) : none,
          ]);
        case "new-year":
          if (!choices.newYearDecorations) {
            return none;
          }
          return {
            shapes: [
              ...lobbySpots.flatMap(
                (spot, index) => balloons(spot, index).shapes,
              ),
              ...hanging.map((at, index) =>
                streamer(
                  at,
                  ["#d98e04", "#b9bec4", "#d64f8f"][index % 3] ?? "#d98e04",
                ),
              ),
            ],
            lights,
          };
      }
    }),
  );
}

/** A Floor's decorations for the events on, `bounds` its walls. */
export function floorDecor(
  events: readonly SeasonalEventId[],
  bounds: {
    readonly x: readonly [number, number];
    readonly z: readonly [number, number];
  },
  options: {
    readonly nibbles?: boolean;
    readonly partyFood?: boolean;
    readonly halloweenFood?: boolean;
    readonly choices?: DecorChoices;
    /** Where its Easter eggs lie (`floorEggSpots`); none without. */
    readonly eggSpots?: readonly FloorPoint[];
  } = {},
): Decor {
  const choices = options.choices ?? allDecorations;
  const y = 2.75;
  const inset = 0.04;
  const liftLeft = liftDoorway.position[0] - liftWall.width / 2 - 0.1;
  const liftRight = liftDoorway.position[0] + liftWall.width / 2 + 0.1;
  const [left, right] = bounds.x;
  const [back, front] = bounds.z;
  const walls = (tokens: readonly PaletteToken[]) => [
    ...lightString(
      [left + 0.2, y, back + inset],
      [liftLeft, y, back + inset],
      tokens,
    ),
    ...lightString(
      [liftRight, y, back + inset],
      [right - 0.2, y, back + inset],
      tokens,
    ),
    ...lightString(
      [left + inset, y, back + 0.2],
      [left + inset, y, front - 0.2],
      tokens,
    ),
    ...lightString(
      [right - inset, y, back + 0.2],
      [right - inset, y, front - 0.2],
      tokens,
    ),
  ];
  const hanging = overhead(bounds.x, bounds.z, y - 0.1);
  return merge([
    ...events.map((event): Decor => {
      const lights = walls(lightTokens[event]);
      switch (event) {
        case "christmas":
          return christmas(
            choices,
            christmasTree(floorTreeSpot, 1.9, 0.5),
            lights,
            () =>
              christmasDecorations(
                bounds.x,
                bounds.z,
                floorCeiling,
                [[liftLeft, liftRight]],
                false,
              ),
          );
        case "halloween":
          return halloween(
            choices,
            merge(
              floorSpots.flatMap((spot, index) =>
                index % 3 === 2
                  ? []
                  : [pumpkin(spot, 0.28 + (index % 2) * 0.1)],
              ),
            ),
            merge([
              ...floorSpots.flatMap((spot, index) =>
                index % 3 === 2 ? [gravestone(spot)] : [],
              ),
              {
                shapes: hanging
                  .filter((_, index) => index % 2 === 0)
                  .flatMap((at, index) => bat(at, index)),
                lights,
              },
            ]),
          );
        case "easter":
          return merge([
            {
              shapes: floorSpots.flatMap((spot) => eggBasket(spot).shapes),
              lights,
            },
            choices.eggs && options.eggSpots !== undefined
              ? easterEggs(options.eggSpots)
              : none,
          ]);
        case "new-year":
          if (!choices.newYearDecorations) {
            return none;
          }
          return {
            shapes: [
              ...floorSpots.flatMap(
                (spot, index) => balloons(spot, index).shapes,
              ),
              ...hanging
                .filter((_, index) => index % 2 === 0)
                .map((at, index) =>
                  streamer(
                    at,
                    ["#d98e04", "#b9bec4", "#d64f8f"][index % 3] ?? "#d98e04",
                  ),
                ),
            ],
            lights,
          };
      }
    }),
    // Christmas's party food takes the table on the day both are on;
    // Halloween's food is never on with either, as the events' days go,
    // but would come before nibbles.
    ...(options.partyFood === true
      ? [partyFood()]
      : options.halloweenFood === true
        ? [halloweenFood()]
        : options.nibbles === true
          ? [nibbles()]
          : []),
  ]);
}

/** The table's top, where the nibbles go. */
const tableTop = 0.74;

/** New Year's nibbles along the meeting room table. */
export function nibbles(): Decor {
  const [cx, cz] = meetingTable.centre;
  const shapes: UnboundShape[] = [];
  const plate = (x: number, z: number, name: string) => {
    shapes.push(
      shape({
        name: `${name} plate`,
        kind: "frustum",
        tint: "ceramic",
        from: [x, tableTop, z],
        to: [x, tableTop + 0.015, z],
        radii: [0.09, 0.13],
      }),
    );
    return tableTop + 0.015;
  };
  // Along the middle of the table, clear of its ends.
  const xs = [-1.2, -0.6, 0, 0.6, 1.2].map((dx) => cx + dx);
  xs.forEach((x, index) => {
    const z = cz + (index % 2 === 0 ? -0.15 : 0.15);
    switch (index) {
      case 0: {
        // Crisps in a bowl.
        shapes.push(
          shape({
            name: "crisp bowl",
            kind: "frustum",
            tint: "stage-work",
            from: [x, tableTop, z],
            to: [x, tableTop + 0.07, z],
            radii: [0.07, 0.12],
          }),
          ...[0, 1, 2, 3, 4].map((crisp) =>
            shape({
              name: `crisp ${String(crisp + 1)}`,
              kind: "ellipsoid",
              tint: swatch("#e6be8a"),
              detail: "tiny",
              at: [
                x + Math.cos(crisp * 1.3) * 0.05,
                tableTop + 0.075,
                z + Math.sin(crisp * 1.3) * 0.05,
              ],
              rotation: [crisp * 0.4, crisp, 0],
              radii: [0.03, 0.006, 0.025],
            }),
          ),
        );
        break;
      }
      case 1: {
        // Cupcakes.
        const top = plate(x, z, "cupcake");
        shapes.push(
          ...[-1, 0, 1].flatMap((n) => [
            shape({
              name: `cupcake ${String(n + 2)}`,
              kind: "frustum",
              tint: "stage-docs",
              detail: "tiny",
              from: [x + n * 0.06, top, z],
              to: [x + n * 0.06, top + 0.04, z],
              radii: [0.022, 0.028],
            }),
            shape({
              name: `cupcake icing ${String(n + 2)}`,
              kind: "dome",
              tint: "paper",
              detail: "tiny",
              at: [x + n * 0.06, top + 0.04, z],
              radii: [0.03, 0.025, 0.03],
              cut: 0.5,
            }),
          ]),
        );
        break;
      }
      case 2: {
        // A bottle and glasses.
        shapes.push(
          shape({
            name: "bottle",
            kind: "capsule",
            tint: "plant",
            finish: "metal",
            from: [x, tableTop + 0.04, z],
            to: [x, tableTop + 0.22, z],
            radii: [0.04, 0.035],
          }),
          shape({
            name: "bottle neck",
            kind: "frustum",
            tint: "state-warning",
            finish: "metal",
            from: [x, tableTop + 0.25, z],
            to: [x, tableTop + 0.32, z],
            radii: [0.03, 0.015],
          }),
          ...[-1, 1].flatMap((side) => [
            shape({
              name: `glass stem ${String(side)}`,
              kind: "capsule",
              tint: "glass",
              detail: "tiny",
              from: [x + side * 0.12, tableTop + 0.005, z + 0.05],
              to: [x + side * 0.12, tableTop + 0.1, z + 0.05],
              radii: [0.005, 0.005],
            }),
            shape({
              name: `glass ${String(side)}`,
              kind: "frustum",
              tint: "glass",
              detail: "tiny",
              from: [x + side * 0.12, tableTop + 0.1, z + 0.05],
              to: [x + side * 0.12, tableTop + 0.18, z + 0.05],
              radii: [0.012, 0.03],
            }),
          ]),
        );
        break;
      }
      case 3: {
        // Sausage rolls.
        const top = plate(x, z, "sausage roll");
        shapes.push(
          ...[-1, 0, 1].map((n) =>
            shape({
              name: `sausage roll ${String(n + 2)}`,
              kind: "capsule",
              tint: swatch("#d9a45b"),
              detail: "tiny",
              from: [x - 0.04, top + 0.018, z + n * 0.04],
              to: [x + 0.04, top + 0.018, z + n * 0.04],
              radii: [0.018, 0.018],
            }),
          ),
        );
        break;
      }
      default: {
        // Sandwiches and grapes.
        const top = plate(x, z, "sandwich");
        shapes.push(
          ...[-1, 1].map((n) =>
            shape({
              name: `sandwich ${String(n)}`,
              kind: "box",
              tint: swatch("#f2dcb3"),
              detail: "tiny",
              at: [x + n * 0.045, top + 0.02, z],
              rotation: [0, 0.3 * n, 0],
              size: [0.07, 0.035, 0.07],
            }),
          ),
          ...[0, 1, 2, 3, 4, 5].map((grape) =>
            shape({
              name: `grape ${String(grape + 1)}`,
              kind: "ellipsoid",
              tint: "stage-review",
              detail: "tiny",
              at: [
                x + (grape % 3) * 0.018 - 0.018,
                top + 0.05 + Math.floor(grape / 3) * 0.015,
                z + 0.07,
              ],
              radii: [0.011, 0.011, 0.011],
            }),
          ),
        );
      }
    }
  });
  return { shapes, lights: [] };
}

/** Christmas's party food along the meeting room table. */
export function partyFood(): Decor {
  const [cx, cz] = meetingTable.centre;
  const shapes: UnboundShape[] = [];
  const plate = (x: number, z: number, name: string, radius = 0.13) => {
    shapes.push(
      shape({
        name: `${name} plate`,
        kind: "frustum",
        tint: "ceramic",
        from: [x, tableTop, z],
        to: [x, tableTop + 0.015, z],
        radii: [radius * 0.7, radius],
      }),
    );
    return tableTop + 0.015;
  };
  const xs = [-1.2, -0.6, 0, 0.6, 1.2].map((dx) => cx + dx);
  xs.forEach((x, index) => {
    const z = cz + (index % 2 === 0 ? -0.15 : 0.15);
    switch (index) {
      case 0: {
        // Mince pies, dusted with sugar.
        const top = plate(x, z, "mince pie");
        shapes.push(
          ...[0, 1, 2, 3].flatMap((pie) => {
            const at: Vec3 = [
              x + (pie % 2) * 0.07 - 0.035,
              top,
              z + Math.floor(pie / 2) * 0.07 - 0.035,
            ];
            return [
              shape({
                name: `mince pie ${String(pie + 1)}`,
                kind: "frustum",
                tint: swatch("#c98a4b"),
                detail: "tiny",
                from: at,
                to: add(at, [0, 0.025, 0]),
                radii: [0.025, 0.032],
              }),
              shape({
                name: `mince pie ${String(pie + 1)} sugar`,
                kind: "dome",
                tint: "paper",
                detail: "tiny",
                at: add(at, [0, 0.025, 0]),
                radii: [0.03, 0.008, 0.03],
                cut: 0.5,
              }),
            ];
          }),
        );
        break;
      }
      case 1: {
        // A Christmas pudding with brandy butter and holly.
        const top = plate(x, z, "pudding");
        shapes.push(
          shape({
            name: "christmas pudding",
            kind: "dome",
            tint: swatch("#4a2c1a"),
            at: [x, top, z],
            radii: [0.08, 0.08, 0.08],
            cut: 0.5,
          }),
          shape({
            name: "brandy butter",
            kind: "dome",
            tint: swatch("#f7f0d8"),
            detail: "tiny",
            at: [x, top + 0.06, z],
            radii: [0.06, 0.03, 0.06],
            cut: 0.5,
          }),
          ...[-1, 1].map((side) =>
            shape({
              name: `holly leaf ${String(side)}`,
              kind: "ellipsoid",
              tint: "plant",
              detail: "tiny",
              at: [x + side * 0.02, top + 0.09, z],
              rotation: [0, side * 0.5, side * 0.4],
              radii: [0.025, 0.004, 0.012],
            }),
          ),
          shape({
            name: "holly berries",
            kind: "ellipsoid",
            tint: "state-critical",
            detail: "tiny",
            at: [x, top + 0.095, z],
            radii: [0.01, 0.01, 0.01],
          }),
        );
        break;
      }
      case 2: {
        // The turkey on its platter.
        const top = plate(x, z, "turkey", 0.2);
        shapes.push(
          shape({
            name: "turkey",
            kind: "ellipsoid",
            tint: swatch("#b9752f"),
            at: [x, top + 0.08, z],
            radii: [0.13, 0.08, 0.1],
          }),
          ...[-1, 1].flatMap((side) => [
            shape({
              name: `turkey leg ${String(side)}`,
              kind: "capsule",
              tint: swatch("#a8642a"),
              detail: "tiny",
              from: [x + 0.06, top + 0.07, z + side * 0.06],
              to: [x + 0.15, top + 0.1, z + side * 0.05],
              radii: [0.03, 0.018],
            }),
            shape({
              name: `turkey leg ${String(side)} frill`,
              kind: "ellipsoid",
              tint: "paper",
              detail: "tiny",
              at: [x + 0.17, top + 0.105, z + side * 0.05],
              radii: [0.012, 0.012, 0.012],
            }),
          ]),
          ...[0, 1, 2, 3, 4, 5].map((sprout) =>
            shape({
              name: `sprout ${String(sprout + 1)}`,
              kind: "ellipsoid",
              tint: swatch("#5a8a3c"),
              detail: "tiny",
              at: [
                x + Math.cos(sprout + 2) * 0.16,
                top + 0.012,
                z + Math.sin(sprout + 2) * 0.13,
              ],
              radii: [0.014, 0.014, 0.014],
            }),
          ),
        );
        break;
      }
      case 3: {
        // A chocolate Yule log.
        const top = plate(x, z, "yule log", 0.15);
        shapes.push(
          shape({
            name: "yule log",
            kind: "capsule",
            tint: swatch("#4a2c1a"),
            from: [x - 0.09, top + 0.035, z],
            to: [x + 0.09, top + 0.035, z],
            radii: [0.035, 0.035],
          }),
          shape({
            name: "yule log snow",
            kind: "box",
            tint: "paper",
            detail: "tiny",
            at: [x, top + 0.07, z],
            size: [0.12, 0.005, 0.03],
          }),
        );
        break;
      }
      default: {
        // Crackers, a bottle and glasses.
        shapes.push(
          ...[-1, 0, 1].flatMap((n) => {
            const at: Vec3 = [x - 0.12, tableTop + 0.02, z + n * 0.06];
            const colour =
              ["#c0392b", "#2e8b57", "#d4af37"][n + 1] ?? "#c0392b";
            return [
              shape({
                name: `cracker ${String(n + 2)}`,
                kind: "capsule",
                tint: swatch(colour),
                finish: "metal",
                detail: "tiny",
                from: add(at, [-0.06, 0, 0]),
                to: add(at, [0.06, 0, 0]),
                radii: [0.018, 0.018],
              }),
              shape({
                name: `cracker ${String(n + 2)} band`,
                kind: "capsule",
                tint: swatch("#d4af37"),
                finish: "metal",
                detail: "tiny",
                from: add(at, [-0.012, 0, 0]),
                to: add(at, [0.012, 0, 0]),
                radii: [0.02, 0.02],
              }),
            ];
          }),
          shape({
            name: "bottle",
            kind: "capsule",
            tint: "plant",
            finish: "metal",
            from: [x + 0.08, tableTop + 0.04, z],
            to: [x + 0.08, tableTop + 0.22, z],
            radii: [0.04, 0.035],
          }),
          shape({
            name: "bottle neck",
            kind: "frustum",
            tint: "state-critical",
            finish: "metal",
            from: [x + 0.08, tableTop + 0.25, z],
            to: [x + 0.08, tableTop + 0.32, z],
            radii: [0.03, 0.015],
          }),
          shape({
            name: "glass",
            kind: "frustum",
            tint: "glass",
            detail: "tiny",
            from: [x + 0.18, tableTop, z + 0.05],
            to: [x + 0.18, tableTop + 0.1, z + 0.05],
            radii: [0.025, 0.03],
          }),
        );
      }
    }
  });
  return { shapes, lights: [] };
}

/**
 * Halloween's food along the meeting room table: a cauldron of bubbling
 * green punch, a pumpkin pie, eyeball cupcakes, a bowl of sweets and
 * meringue ghosts.
 */
export function halloweenFood(): Decor {
  const [cx, cz] = meetingTable.centre;
  const shapes: UnboundShape[] = [];
  const lights: Decor["lights"][number][] = [];
  const plate = (x: number, z: number, name: string, radius = 0.13) => {
    shapes.push(
      shape({
        name: `${name} plate`,
        kind: "frustum",
        tint: swatch("#1c1c1c"),
        from: [x, tableTop, z],
        to: [x, tableTop + 0.015, z],
        radii: [radius * 0.7, radius],
      }),
    );
    return tableTop + 0.015;
  };
  const green = swatch("#7bd34f");
  const orange = swatch("#e67e22");
  const xs = [-1.2, -0.6, 0, 0.6, 1.2].map((dx) => cx + dx);
  xs.forEach((x, index) => {
    const z = cz + (index % 2 === 0 ? -0.15 : 0.15);
    switch (index) {
      case 0: {
        // A cauldron of punch, bubbling and glowing green.
        shapes.push(
          shape({
            name: "cauldron",
            kind: "frustum",
            tint: swatch("#262626"),
            finish: "metal",
            from: [x, tableTop, z],
            to: [x, tableTop + 0.16, z],
            radii: [0.08, 0.12],
          }),
          shape({
            name: "cauldron rim",
            kind: "torus",
            tint: swatch("#262626"),
            finish: "metal",
            at: [x, tableTop + 0.16, z],
            rotation: [Math.PI / 2, 0, 0],
            radius: 0.12,
            tube: 0.012,
          }),
          shape({
            name: "punch",
            kind: "frustum",
            tint: green,
            from: [x, tableTop + 0.14, z],
            to: [x, tableTop + 0.15, z],
            radii: [0.11, 0.11],
          }),
          ...[0, 1, 2, 3].map((bubble) =>
            shape({
              name: `punch bubble ${String(bubble + 1)}`,
              kind: "ellipsoid",
              tint: green,
              detail: "tiny",
              at: [
                x + Math.cos(bubble * 1.7) * 0.06,
                tableTop + 0.155,
                z + Math.sin(bubble * 1.7) * 0.06,
              ],
              radii: [0.015, 0.012, 0.015],
            }),
          ),
          shape({
            name: "ladle",
            kind: "capsule",
            tint: "metal-dark",
            finish: "metal",
            detail: "tiny",
            from: [x + 0.03, tableTop + 0.13, z],
            to: [x + 0.13, tableTop + 0.26, z],
            radii: [0.008, 0.008],
          }),
        );
        lights.push({ token: "state-ok", at: [x, tableTop + 0.17, z] });
        break;
      }
      case 1: {
        // A pumpkin pie, a slice cut out.
        const top = plate(x, z, "pumpkin pie", 0.15);
        shapes.push(
          shape({
            name: "pumpkin pie",
            kind: "frustum",
            tint: orange,
            from: [x, top, z],
            to: [x, top + 0.035, z],
            radii: [0.11, 0.12],
          }),
          shape({
            name: "pumpkin pie crust",
            kind: "torus",
            tint: swatch("#c98a4b"),
            at: [x, top + 0.035, z],
            rotation: [Math.PI / 2, 0, 0],
            radius: 0.12,
            tube: 0.012,
          }),
        );
        break;
      }
      case 2: {
        // Eyeball cupcakes.
        const top = plate(x, z, "cupcake", 0.15);
        shapes.push(
          ...[0, 1, 2, 3].flatMap((cake) => {
            const at: Vec3 = [
              x + (cake % 2) * 0.1 - 0.05,
              top,
              z + Math.floor(cake / 2) * 0.1 - 0.05,
            ];
            return [
              shape({
                name: `cupcake ${String(cake + 1)}`,
                kind: "frustum",
                tint: orange,
                detail: "tiny",
                from: at,
                to: add(at, [0, 0.04, 0]),
                radii: [0.025, 0.033],
              }),
              shape({
                name: `cupcake ${String(cake + 1)} icing`,
                kind: "dome",
                tint: "paper",
                detail: "tiny",
                at: add(at, [0, 0.04, 0]),
                radii: [0.034, 0.025, 0.034],
                cut: 0.5,
              }),
              shape({
                name: `cupcake ${String(cake + 1)} eye`,
                kind: "ellipsoid",
                tint: swatch(cake % 2 === 0 ? "#2e6fd8" : "#2e8b57"),
                detail: "tiny",
                at: add(at, [0, 0.064, 0]),
                radii: [0.014, 0.005, 0.014],
              }),
              shape({
                name: `cupcake ${String(cake + 1)} pupil`,
                kind: "ellipsoid",
                tint: "ink",
                detail: "tiny",
                at: add(at, [0, 0.068, 0]),
                radii: [0.006, 0.003, 0.006],
              }),
            ];
          }),
        );
        break;
      }
      case 3: {
        // A bowl of sweets.
        shapes.push(
          shape({
            name: "sweet bowl",
            kind: "frustum",
            tint: swatch("#6c3483"),
            from: [x, tableTop, z],
            to: [x, tableTop + 0.07, z],
            radii: [0.06, 0.11],
          }),
          ...Array.from({ length: 9 }, (_, sweet) => {
            const angle = (sweet / 9) * Math.PI * 2;
            const out = sweet % 3 === 0 ? 0.02 : 0.065;
            return shape({
              name: `sweet ${String(sweet + 1)}`,
              kind: "ellipsoid",
              tint: swatch(
                ["#e67e22", "#ffe066", "#d64f8f", "#81b29a"][sweet % 4] ??
                  "#e67e22",
              ),
              detail: "tiny",
              at: [
                x + Math.cos(angle) * out,
                tableTop + 0.075,
                z + Math.sin(angle) * out,
              ],
              rotation: [0, angle, 0],
              radii: [0.025, 0.012, 0.015],
            });
          }),
        );
        break;
      }
      default: {
        // Meringue ghosts.
        const top = plate(x, z, "ghost");
        shapes.push(
          ...[-1, 0, 1].flatMap((ghost) => {
            const at: Vec3 = [x + ghost * 0.07, top, z + (ghost % 2) * 0.04];
            return [
              shape({
                name: `meringue ghost ${String(ghost + 2)}`,
                kind: "dome",
                tint: "paper",
                detail: "tiny",
                at,
                radii: [0.03, 0.07, 0.03],
                cut: 0.5,
              }),
              ...[-1, 1].map((side) =>
                shape({
                  name: `meringue ghost ${String(ghost + 2)} eye`,
                  kind: "ellipsoid",
                  tint: "ink",
                  detail: "tiny",
                  at: add(at, [side * 0.009, 0.05, 0.022]),
                  radii: [0.005, 0.007, 0.004],
                }),
              ),
            ];
          }),
        );
      }
    }
  });
  return { shapes, lights };
}
