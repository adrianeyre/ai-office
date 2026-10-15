import { palette, type PaletteToken } from "@ai-office/shared/palette";

import type { PosterArt } from "./posters.ts";

// The classic arcade game posters on a Floor's left wall (FR-61), between
// the dartboard and the basketball hoop: affectionate parodies of eight
// coin-op classics, as the adventure posters (posters.ts) are of point-
// and-click adventures. Each evokes its game's screen (pixel sprites
// drawn as blocks, neon on black) under a cabinet's lit marquee, with its
// title altered by a joke: "Space Intruders", "Donkey Kongo". Nothing is
// the games' own art, sprite or logo: every sprite is drawn here, block by
// block, from the Office's own designs. posters.ts letters the titles and
// draws the marquee behind them; this module draws the pictures beneath,
// in the posters' units (100 wide, 140 high).

/** The arcade posters' own inks, beyond the palette and the adventure posters'. */
export const arcadeInks = {
  "arcade-black": "#05050c",
  "arcade-navy": "#0b1240",
  "arcade-marquee": "#1a0a2e",
  "arcade-green": "#39ff6a",
  "arcade-magenta": "#ff3ad2",
  "arcade-cyan": "#2ef2ff",
  "arcade-yellow": "#ffe62e",
  "arcade-red": "#ff3b3b",
  "arcade-orange": "#ff9a2e",
  "arcade-blue": "#2e5bff",
  "arcade-pink": "#ffa3d8",
  "arcade-purple": "#9b4dff",
  "arcade-white": "#f4f4ff",
  "arcade-peach": "#ffcfa8",
  "arcade-girder": "#d8344a",
  "arcade-ape": "#8a4a1e",
  "arcade-ape-face": "#e8b07a",
  "arcade-barrel": "#b0662a",
  "arcade-road": "#22222c",
  "arcade-river": "#16349a",
  "arcade-log": "#7a4a22",
  "arcade-grass": "#2f8a3a",
  "arcade-verge": "#5a2a8a",
} as const satisfies Record<string, `#${string}`>;

export type ArcadeInk = keyof typeof arcadeInks;

/** An arcade poster's colour: one of the palette's tokens, or an arcade ink. */
type ArcadeColour = PaletteToken | ArcadeInk;

/** Which picture an arcade poster shows, beneath its marquee. */
export type ArcadeMotif =
  | "intruders"
  | "chomping mum"
  | "girders and bongos"
  | "galaxy swarm"
  | "vector rocks"
  | "crowned frog"
  | "mushroom field"
  | "falling blocks";

/**
 * The eight arcade posters, in the order they hang (floor-layout.ts): the
 * top row from the dartboard's end, then the bottom row.
 */
export const arcadePosterArt: readonly PosterArt[] = [
  {
    title: "Space Intruders",
    parodies: "Space Invaders",
    motif: "intruders",
    sky: [
      [0, "arcade-black"],
      [1, "arcade-navy"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "arcade-white"],
        [1, "arcade-green"],
      ],
      outline: "arcade-black",
      glow: "arcade-green",
      stretch: 0.9,
      marquee: "arcade-marquee",
    },
  },
  {
    title: "Pac-Mum",
    parodies: "Pac-Man",
    motif: "chomping mum",
    sky: [
      [0, "arcade-black"],
      [1, "arcade-black"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "arcade-yellow"],
        [1, "arcade-orange"],
      ],
      outline: "arcade-blue",
      extrude: { colour: "arcade-blue", by: 1.4 },
      marquee: "arcade-marquee",
    },
  },
  {
    title: "Donkey Kongo",
    parodies: "Donkey Kong",
    motif: "girders and bongos",
    sky: [
      [0, "arcade-black"],
      [1, "arcade-black"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "arcade-orange"],
        [1, "arcade-girder"],
      ],
      outline: "arcade-black",
      extrude: { colour: "arcade-ape", by: 1.6 },
      tilt: [-0.04, 0.03],
      marquee: "arcade-marquee",
    },
  },
  {
    title: "Galaxia",
    parodies: "Galaxian",
    motif: "galaxy swarm",
    sky: [
      [0, "arcade-black"],
      [0.7, "arcade-navy"],
      [1, "arcade-black"],
    ],
    lettering: {
      typeface: "sans",
      italic: true,
      fill: [
        [0, "arcade-yellow"],
        [1, "arcade-red"],
      ],
      outline: "arcade-black",
      glow: "arcade-red",
      marquee: "arcade-marquee",
    },
  },
  {
    title: "Asteroidz",
    parodies: "Asteroids",
    motif: "vector rocks",
    sky: [
      [0, "arcade-black"],
      [1, "arcade-black"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "arcade-white"],
        [1, "arcade-white"],
      ],
      outline: "arcade-black",
      glow: "arcade-cyan",
      stretch: 0.9,
      marquee: "arcade-black",
    },
  },
  {
    title: "Frogga",
    parodies: "Frogger",
    motif: "crowned frog",
    sky: [
      [0, "arcade-black"],
      [1, "arcade-black"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "arcade-green"],
        [1, "arcade-grass"],
      ],
      outline: "arcade-black",
      extrude: { colour: "arcade-verge", by: 1.4 },
      tilt: [0.04],
      marquee: "arcade-marquee",
    },
  },
  {
    title: "Centipeed",
    parodies: "Centipede",
    motif: "mushroom field",
    sky: [
      [0, "arcade-black"],
      [1, "arcade-black"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "arcade-pink"],
        [1, "arcade-magenta"],
      ],
      outline: "arcade-black",
      glow: "arcade-magenta",
      stretch: 0.9,
      marquee: "arcade-marquee",
    },
  },
  {
    title: "Tetrus",
    parodies: "Tetris",
    motif: "falling blocks",
    sky: [
      [0, "arcade-navy"],
      [1, "arcade-black"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "arcade-cyan"],
        [1, "arcade-blue"],
      ],
      outline: "arcade-black",
      extrude: { colour: "arcade-red", by: 1.4 },
      marquee: "arcade-marquee",
    },
  },
];

/** A 2D canvas context, on screen or off it. */
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

type Point = readonly [number, number];

/** An arcade colour's sRGB hex, with an alpha appended when it has one. */
function hex(name: ArcadeColour, alpha = 1): string {
  const value =
    name in palette
      ? palette[name as PaletteToken]
      : arcadeInks[name as ArcadeInk];
  if (alpha >= 1) {
    return value;
  }
  const byte = Math.round(Math.max(0, alpha) * 255);
  return `${value}${byte.toString(16).padStart(2, "0")}`;
}

/** A filled block. */
function block(
  context: Context,
  colour: ArcadeColour,
  [x, y]: Point,
  [width, height]: Point,
  alpha = 1,
): void {
  context.fillStyle = hex(colour, alpha);
  context.fillRect(x, y, width, height);
}

/**
 * A pixel sprite: each row a string, each character a pixel of the colour
 * `inks` gives it (a space or "." is see-through), each pixel `cell` units
 * square, from `[x, y]` at its top left. `flip` mirrors it left to right.
 */
function sprite(
  context: Context,
  rows: readonly string[],
  inks: Readonly<Record<string, ArcadeColour>>,
  [x, y]: Point,
  cell: number,
  flip = false,
): void {
  rows.forEach((row, line) => {
    for (let column = 0; column < row.length; column += 1) {
      const ink = inks[row.charAt(column)];
      if (ink !== undefined) {
        const across = flip ? row.length - 1 - column : column;
        block(context, ink, [x + across * cell, y + line * cell], [cell, cell]);
      }
    }
  });
}

/** A filled disc. */
function disc(
  context: Context,
  colour: ArcadeColour,
  [x, y]: Point,
  radius: number,
): void {
  context.beginPath();
  context.arc(x, y, radius, 0, 2 * Math.PI);
  context.fillStyle = hex(colour);
  context.fill();
}

/** A closed outline through `points`, stroked in neon, vector-screen style. */
function outline(
  context: Context,
  colour: ArcadeColour,
  points: readonly Point[],
  width = 0.7,
): void {
  context.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.closePath();
  context.lineJoin = "round";
  context.lineWidth = width;
  context.strokeStyle = hex(colour);
  context.stroke();
}

/** A random number from 0 to 1, the same sequence every time from `seed`. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

/** Square pixel stars between `top` and `bottom`, in `colours` in turn. */
function pixelStars(
  context: Context,
  colours: readonly ArcadeColour[],
  count: number,
  [top, bottom]: Point,
  seed: number,
): void {
  const next = seeded(seed);
  for (let index = 0; index < count; index += 1) {
    const colour = colours[index % colours.length] ?? "arcade-white";
    block(
      context,
      colour,
      [4 + next() * 92, top + next() * (bottom - top)],
      [0.7, 0.7],
      0.5 + next() * 0.5,
    );
  }
}

/** A cathode-ray tube's scanlines and a soft dark vignette, over everything below the marquee. */
function screenGlass(context: Context, top: number): void {
  for (let y = top; y < 138; y += 2) {
    block(context, "arcade-black", [3, y], [94, 0.5], 0.22);
  }
  const vignette = context.createRadialGradient(50, 92, 20, 50, 92, 70);
  vignette.addColorStop(0, hex("arcade-black", 0));
  vignette.addColorStop(1, hex("arcade-black", 0.55));
  context.fillStyle = vignette;
  context.fillRect(3, top, 94, 138 - top);
}

/** Where every picture's screen begins: beneath the tallest marquee. */
const screenTop = 46;

// The Office's own sprites, drawn for these posters.

const intruderSquid = [
  "....XXX....",
  "..XXXXXXX..",
  ".XX.XXX.XX.",
  ".XXXXXXXXX.",
  "...X.X.X...",
  "..X.X.X.X..",
];
const intruderBug = [
  "..X.....X..",
  "...XXXXX...",
  "..XX.X.XX..",
  ".XXXXXXXXX.",
  ".X.XXXXX.X.",
  "...X...X...",
];
const intruderBlob = [
  "...XXXXX...",
  ".XXXXXXXXX.",
  "XXX.XXX.XXX",
  "XXXXXXXXXXX",
  ".XX.....XX.",
  "XX.......XX",
];
const cannon = [
  ".....X.....",
  "....XXX....",
  ".XXXXXXXXX.",
  "XXXXXXXXXXX",
  "XXXXXXXXXXX",
];
const saucer = [
  "....XXXXXX....",
  "..XXXXXXXXXX..",
  ".XX.XX.XX.XX..",
  "XXXXXXXXXXXXXX",
  "..XXX....XXX..",
];
const shield = [
  "...XXXXXX...",
  "..XXXXXXXX..",
  ".XXXXXXXXXX.",
  "XXXXXXXXXXXX",
  "XXXX....XXXX",
  "XXX......XXX",
];

const ghost = [
  "...XXXX...",
  ".XXXXXXXX.",
  "XXWWXXWWXX",
  "XXWPXXWPXX",
  "XXXXXXXXXX",
  "XXXXXXXXXX",
  "XXXXXXXXXX",
  "XX.XXX.XXX",
  "X...X...XX",
];

const ape = [
  "....BBBBBB....",
  "...BBBBBBBB...",
  "..BBFFFFFFBB..",
  "..BFWKFFWKFB..",
  "..BFFFFFFFFB..",
  "...FFNNNNFF...",
  "BB..FFFFFF..BB",
  "BBBBBBBBBBBBBB",
  "BBBBBBFFBBBBBB",
  ".BBBBFFFFBBBB.",
  "..BBBBFFBBBB..",
  "..BBBBBBBBBB..",
  "..BBB....BBB..",
  ".BBBB....BBBB.",
];
const bongo = ["WWWW", "OOOO", "OBBO", ".OO.", ".OO."];
const jumper = [
  "..RRR..",
  ".RRRRR.",
  ".FFKF..",
  "..FFF..",
  ".RBBR..",
  "RRBBBRR",
  "..BBB..",
  ".BB.BB.",
  "OO...OO",
];

const flagship = [
  "...Y.Y...",
  "..YYYYY..",
  ".RYRYRYR.",
  "RRRRRRRRR",
  "R.R.R.R.R",
  "..R...R..",
];
const swarmer = [
  "X.......X",
  "XX..W..XX",
  ".XXWWWXX.",
  "..XXXXX..",
  ".X.X.X.X.",
  "X.......X",
];
const fighter = [
  "....W....",
  "....W....",
  "...WWW...",
  ".R.WRW.R.",
  ".RWWWWWR.",
  "RWWWWWWWR",
  "RR.W.W.RR",
];

const frog = [
  "..Y.Y.Y..",
  "..YYYYY..",
  "G..GGG..G",
  "GG.GGG.GG",
  ".GWGGGWG.",
  "..GGGGG..",
  ".GGGGGGG.",
  "GG.GGG.GG",
  "G.......G",
];
const car = ["..XXXX..", ".XWWWWX.", "XXXXXXXX", "XXXXXXXX", ".K....K."];

const mushroom = [".XXXX.", "XXXXXX", "XWXXWX", "..SS..", "..SS.."];
const spider = [
  "X.X...X.X",
  ".X.X.X.X.",
  "..XXXXX..",
  "XXXWXWXXX",
  "..XXXXX..",
  ".X.X.X.X.",
  "X.X...X.X",
];
const gnome = [".PPP.", "PPPPP", ".FFF.", "GGGGG", "G.G.G"];

/** A bevelled block, lit from the top left, `size` square. */
function bevelled(
  context: Context,
  colour: ArcadeColour,
  [x, y]: Point,
  size: number,
): void {
  block(context, colour, [x, y], [size, size]);
  block(context, "arcade-white", [x, y], [size, size * 0.18], 0.45);
  block(context, "arcade-white", [x, y], [size * 0.18, size], 0.35);
  block(
    context,
    "arcade-black",
    [x, y + size * 0.82],
    [size, size * 0.18],
    0.4,
  );
  block(
    context,
    "arcade-black",
    [x + size * 0.82, y],
    [size * 0.18, size],
    0.35,
  );
}

/** Each arcade poster's picture, drawn beneath its marquee, in the poster's units. */
export const arcadeScenes: Record<ArcadeMotif, (context: Context) => void> = {
  // Rows of marching intruders over four shields and the player's cannon,
  // its shot rising, a saucer across the top.
  intruders: (context) => {
    pixelStars(context, ["arcade-white"], 30, [screenTop, 120], 3);
    sprite(context, saucer, { X: "arcade-red" }, [60, screenTop + 2], 1.1);
    const rows: [readonly string[], ArcadeColour][] = [
      [intruderSquid, "arcade-magenta"],
      [intruderBug, "arcade-cyan"],
      [intruderBug, "arcade-cyan"],
      [intruderBlob, "arcade-green"],
    ];
    rows.forEach(([shape, colour], row) => {
      for (let column = 0; column < 5; column += 1) {
        sprite(
          context,
          shape,
          { X: colour },
          [12 + column * 15.5 + (row % 2) * 2, screenTop + 11 + row * 9],
          1.1,
        );
      }
    });
    // A bomb falling, and the cannon's shot rising to meet it.
    block(context, "arcade-white", [53.5, 92], [0.8, 5]);
    block(context, "arcade-yellow", [36, 84], [0.8, 3]);
    block(context, "arcade-yellow", [36.8, 87], [0.8, 3]);
    for (const x of [10, 32, 54, 76]) {
      sprite(context, shield, { X: "arcade-green" }, [x, 106], 1.2);
    }
    sprite(context, cannon, { X: "arcade-green" }, [48, 122], 1);
    block(context, "arcade-green", [5, 129], [90, 0.8]);
    // The lives left, as cannons in the corner.
    for (const x of [8, 20]) {
      sprite(context, cannon, { X: "arcade-green" }, [x, 131], 0.8);
    }
    screenGlass(context, screenTop);
  },

  // A maze in blue neon, a trail of pellets, and Pac-Mum herself (a bow in
  // her hair and a string of pearls) chased by four ghosts.
  "chomping mum": (context) => {
    context.lineWidth = 1.4;
    context.strokeStyle = hex("arcade-blue");
    for (const [x, y, w, h] of [
      [5, screenTop, 90, 88],
      [14, 56, 22, 8],
      [64, 56, 22, 8],
      [14, 74, 10, 22],
      [76, 74, 10, 22],
      [34, 74, 32, 10],
      [14, 106, 30, 8],
      [56, 106, 30, 8],
      [44, 118, 12, 10],
    ] as const) {
      context.strokeRect(x, y, w, h);
    }
    // The pellets along the corridors.
    for (let x = 10; x <= 90; x += 4) {
      block(context, "arcade-peach", [x, 69], [1, 1]);
      block(context, "arcade-peach", [x, 101], [1, 1]);
    }
    for (let y = 52; y <= 128; y += 4) {
      block(context, "arcade-peach", [9.5, y], [1, 1]);
      block(context, "arcade-peach", [89.5, y], [1, 1]);
    }
    disc(context, "arcade-peach", [9.9, 52], 1.8);
    disc(context, "arcade-peach", [89.9, 128], 1.8);
    // Pac-Mum, mouth open to the right.
    const [cx, cy] = [36, 101] as const;
    context.beginPath();
    context.moveTo(cx, cy);
    context.arc(cx, cy, 9, 0.6, 2 * Math.PI - 0.6);
    context.closePath();
    context.fillStyle = hex("arcade-yellow");
    context.fill();
    disc(context, "arcade-black", [cx + 1, cy - 5], 1.1);
    // Her lipstick, her bow and her pearls.
    block(context, "arcade-red", [cx + 5.6, cy - 3.6], [1.6, 0.9]);
    sprite(
      context,
      ["X...X", "XX.XX", "XXXXX", "XX.XX", "X...X"],
      { X: "arcade-magenta" },
      [cx - 6, cy - 13],
      1,
    );
    for (let angle = 1.7; angle <= 2.9; angle += 0.3) {
      disc(
        context,
        "arcade-white",
        [cx + Math.cos(angle) * 6.5, cy + Math.sin(angle) * 6.5],
        0.7,
      );
    }
    const ghosts: [ArcadeColour, Point][] = [
      ["arcade-red", [56, 95]],
      ["arcade-pink", [68, 95]],
      ["arcade-cyan", [52, 62]],
      ["arcade-orange", [72, 116]],
    ];
    for (const [colour, at] of ghosts) {
      sprite(
        context,
        ghost,
        { X: colour, W: "arcade-white", P: "arcade-blue" },
        at,
        1,
      );
    }
    screenGlass(context, screenTop);
  },

  // Sloping red girders and cyan ladders, a barrel rolling down, the
  // little jumper at the bottom, and at the top a big ape playing bongos.
  "girders and bongos": (context) => {
    const girder = (y: number, slope: number) => {
      context.beginPath();
      context.moveTo(6, y);
      context.lineTo(94, y + slope);
      context.lineTo(94, y + slope + 3);
      context.lineTo(6, y + 3);
      context.closePath();
      context.fillStyle = hex("arcade-girder");
      context.fill();
      for (let x = 9; x < 94; x += 6) {
        block(
          context,
          "arcade-black",
          [x, y + 1 + ((x - 6) / 88) * slope],
          [1.4, 1],
        );
      }
    };
    const ladder = (x: number, top: number, bottom: number) => {
      block(context, "arcade-cyan", [x, top], [0.7, bottom - top]);
      block(context, "arcade-cyan", [x + 4, top], [0.7, bottom - top]);
      for (let y = top + 2; y < bottom; y += 3) {
        block(context, "arcade-cyan", [x, y], [4.7, 0.6]);
      }
    };
    ladder(78, 75, 92);
    ladder(18, 96, 112);
    ladder(64, 116, 130);
    girder(72, 3);
    girder(93, -3);
    girder(113, 3);
    block(context, "arcade-girder", [6, 132], [88, 3]);
    // The ape on the top girder, with its bongos.
    sprite(
      context,
      ape,
      {
        B: "arcade-ape",
        F: "arcade-ape-face",
        W: "arcade-white",
        K: "arcade-black",
        N: "arcade-red",
      },
      [10, 51],
      1.5,
    );
    for (const x of [33, 39]) {
      sprite(
        context,
        bongo,
        { W: "arcade-peach", O: "arcade-barrel", B: "arcade-ape" },
        [x, 63],
        1.2,
      );
    }
    // Barrels: one stacked by the ape, one rolling down.
    for (const [x, y] of [
      [50, 66],
      [56, 66],
      [70, 87],
      [40, 107],
    ] as const) {
      disc(context, "arcade-barrel", [x, y], 2.6);
      block(context, "arcade-ape", [x - 2.6, y - 0.4], [5.2, 0.8]);
    }
    sprite(
      context,
      jumper,
      {
        R: "arcade-red",
        F: "arcade-peach",
        K: "arcade-black",
        B: "arcade-blue",
        O: "arcade-ape",
      },
      [24, 122],
      1.1,
    );
    screenGlass(context, screenTop);
  },

  // A swarm in formation under a flagship, two of them peeling off to
  // dive on curving trails at the fighter below.
  "galaxy swarm": (context) => {
    pixelStars(
      context,
      ["arcade-white", "arcade-cyan", "arcade-yellow", "arcade-red"],
      70,
      [screenTop, 136],
      11,
    );
    const inks = (body: ArcadeColour) => ({
      X: body,
      W: "arcade-yellow" as const,
    });
    for (const x of [30, 58]) {
      sprite(
        context,
        flagship,
        { Y: "arcade-yellow", R: "arcade-red" },
        [x, screenTop + 4],
        1.3,
      );
    }
    const rows: ArcadeColour[] = [
      "arcade-red",
      "arcade-purple",
      "arcade-blue",
      "arcade-blue",
    ];
    rows.forEach((colour, row) => {
      const count = row === 0 ? 6 : 8;
      for (let column = 0; column < count; column += 1) {
        sprite(
          context,
          swarmer,
          inks(colour),
          [(row === 0 ? 20 : 8) + column * 10.5, screenTop + 14 + row * 8],
          1,
        );
      }
    });
    // Two diving, their trails curving down.
    context.setLineDash([1.2, 1.6]);
    context.lineWidth = 0.6;
    context.strokeStyle = hex("arcade-yellow", 0.8);
    context.beginPath();
    context.moveTo(25, 82);
    context.bezierCurveTo(5, 95, 40, 100, 30, 112);
    context.moveTo(75, 82);
    context.bezierCurveTo(95, 92, 58, 104, 66, 110);
    context.stroke();
    context.setLineDash([]);
    sprite(context, swarmer, inks("arcade-purple"), [25, 112], 1.2, true);
    sprite(context, swarmer, inks("arcade-red"), [62, 110], 1.2);
    block(context, "arcade-white", [49.4, 112], [0.7, 4]);
    sprite(
      context,
      fighter,
      { W: "arcade-white", R: "arcade-red" },
      [44, 122],
      1.3,
    );
    screenGlass(context, screenTop);
  },

  // A vector screen: jagged rocks in thin white outline, the triangle ship
  // in the middle with its thrust lit, its shots, and a saucer.
  "vector rocks": (context) => {
    const next = seeded(23);
    const rock = (cx: number, cy: number, radius: number) => {
      const points: Point[] = [];
      for (let corner = 0; corner < 10; corner += 1) {
        const angle = (corner / 10) * 2 * Math.PI;
        const reach = radius * (0.7 + next() * 0.35);
        points.push([
          cx + Math.cos(angle) * reach,
          cy + Math.sin(angle) * reach,
        ]);
      }
      outline(context, "arcade-white", points);
    };
    for (const [x, y, radius] of [
      [20, 60, 9],
      [78, 64, 11],
      [30, 112, 12],
      [76, 118, 7],
      [58, 52, 4],
      [12, 88, 4.5],
      [88, 96, 5],
      [52, 128, 3.5],
      [64, 84, 3],
    ] as const) {
      rock(x, y, radius);
    }
    // The ship, nose up and a little to the right, its flame behind.
    context.save();
    context.translate(50, 92);
    context.rotate(0.35);
    outline(context, "arcade-white", [
      [0, -7],
      [4.5, 5],
      [0, 3],
      [-4.5, 5],
    ]);
    outline(context, "arcade-orange", [
      [-2, 4.5],
      [0, 9],
      [2, 4.5],
    ]);
    context.restore();
    for (const [x, y] of [
      [53.5, 80],
      [56, 72],
      [58.5, 64],
    ] as const) {
      block(context, "arcade-white", [x, y], [0.9, 0.9]);
    }
    // A saucer, outlined, in the corner.
    outline(
      context,
      "arcade-cyan",
      [
        [10, 132],
        [14, 129],
        [22, 129],
        [26, 132],
        [22, 135],
        [14, 135],
      ],
      0.6,
    );
    outline(
      context,
      "arcade-cyan",
      [
        [15, 129],
        [16.5, 126.5],
        [19.5, 126.5],
        [21, 129],
      ],
      0.6,
    );
    // The ships left, small, under the marquee.
    for (const x of [80, 86, 92]) {
      outline(
        context,
        "arcade-white",
        [
          [x, screenTop + 1],
          [x + 2, screenTop + 6],
          [x - 2, screenTop + 6],
        ],
        0.5,
      );
    }
    screenGlass(context, screenTop);
  },

  // Home bays on the bank, a river of logs, a verge, a road of cars and
  // trucks, and the frog (crowned, as befits Frogga) half way across.
  "crowned frog": (context) => {
    block(context, "arcade-grass", [3, screenTop], [94, 10]);
    for (const x of [8, 28, 48, 68, 88]) {
      block(context, "arcade-black", [x - 4, screenTop + 3], [8, 7]);
    }
    block(context, "arcade-river", [3, screenTop + 10], [94, 34]);
    const logs: [number, number, number][] = [
      [6, 60, 28],
      [50, 60, 34],
      [20, 70, 22],
      [64, 70, 26],
      [10, 80, 30],
      [58, 80, 20],
    ];
    for (const [x, y, length] of logs) {
      block(context, "arcade-log", [x, y], [length, 6]);
      for (let ring = x + 3; ring < x + length - 2; ring += 6) {
        block(context, "arcade-barrel", [ring, y + 2.5], [2.5, 1]);
      }
    }
    for (const x of [40, 46]) {
      disc(context, "arcade-red", [x, 73], 2.4);
    }
    block(context, "arcade-verge", [3, 90], [94, 6]);
    block(context, "arcade-road", [3, 96], [94, 32]);
    for (let x = 6; x < 96; x += 10) {
      block(context, "arcade-yellow", [x, 111.5], [5, 0.6]);
    }
    const cars: [number, number, ArcadeColour][] = [
      [8, 99, "arcade-pink"],
      [44, 99, "arcade-yellow"],
      [76, 99, "arcade-cyan"],
      [26, 116, "arcade-white"],
      [70, 116, "arcade-magenta"],
    ];
    for (const [x, y, colour] of cars) {
      sprite(
        context,
        car,
        { X: colour, W: "arcade-blue", K: "arcade-black" },
        [x, y],
        1.2,
      );
    }
    // A long truck.
    block(context, "arcade-white", [46, 117], [18, 6]);
    block(context, "arcade-orange", [64, 118], [5, 5]);
    block(context, "arcade-verge", [3, 128], [94, 9]);
    sprite(
      context,
      frog,
      { G: "arcade-green", Y: "arcade-yellow", W: "arcade-white" },
      [45, 89],
      1.3,
    );
    screenGlass(context, screenTop);
  },

  // A field of mushrooms, a centipede winding down through it, a spider
  // bouncing along the bottom and the gnome's wand firing up.
  "mushroom field": (context) => {
    const next = seeded(5);
    for (let index = 0; index < 22; index += 1) {
      const colour: ArcadeColour =
        index % 3 === 0 ? "arcade-orange" : "arcade-magenta";
      sprite(
        context,
        mushroom,
        { X: colour, W: "arcade-peach", S: "arcade-cyan" },
        [5 + next() * 86, screenTop + 2 + next() * 70],
        1,
      );
    }
    // The centipede: a pink head, then green segments, curling back.
    const segments: Point[] = [];
    for (let index = 0; index < 13; index += 1) {
      const row = Math.floor(index / 7);
      const along = index % 7;
      segments.push([
        row === 0 ? 70 - along * 5 : 40 + along * 5,
        86 + row * 6,
      ]);
    }
    segments.reverse().forEach(([x, y], index, all) => {
      const head = index === all.length - 1;
      disc(context, head ? "arcade-pink" : "arcade-green", [x, y], 2.6);
      disc(context, head ? "arcade-magenta" : "arcade-grass", [x, y], 1.2);
      block(context, "arcade-yellow", [x - 2.6, y + 2], [0.8, 1.2]);
      block(context, "arcade-yellow", [x + 1.8, y + 2], [0.8, 1.2]);
    });
    sprite(
      context,
      spider,
      { X: "arcade-purple", W: "arcade-white" },
      [66, 114],
      1.3,
    );
    // The wand's shot, and the gnome at the bottom.
    block(context, "arcade-white", [47.6, 106], [0.8, 5]);
    sprite(
      context,
      gnome,
      { P: "arcade-pink", F: "arcade-peach", G: "arcade-green" },
      [45.5, 126],
      1.3,
    );
    block(context, "arcade-cyan", [3, 135], [94, 0.6]);
    screenGlass(context, screenTop);
  },

  // A well of bevelled blocks: a stack with a full row about to clear,
  // a T falling, and the next piece waiting in its box.
  "falling blocks": (context) => {
    const size = 5;
    const left = 20;
    const bottom = 134;
    // The well's walls.
    block(
      context,
      "metal-light",
      [left - 2, screenTop + 2],
      [2, bottom - screenTop - 2],
    );
    block(
      context,
      "metal-light",
      [left + 10 * size, screenTop + 2],
      [2, bottom - screenTop - 2],
    );
    block(context, "metal-light", [left - 2, bottom], [10 * size + 4, 2]);
    const at = (column: number, row: number): Point => [
      left + column * size,
      bottom - (row + 1) * size,
    ];
    const colours: Record<string, ArcadeColour> = {
      I: "arcade-cyan",
      O: "arcade-yellow",
      T: "arcade-purple",
      S: "arcade-green",
      Z: "arcade-red",
      J: "arcade-blue",
      L: "arcade-orange",
    };
    // The stack, bottom row first; its third row full, flashing white.
    const stack = [
      "IIIIJJLLOO",
      "ZZSSJTLLOO",
      "WWWWWWWWWW",
      "ZSS.TTTJJL",
      ".SSZZ.T.JL",
      "....Z....L",
    ];
    stack.forEach((row, line) => {
      for (let column = 0; column < row.length; column += 1) {
        const piece = row.charAt(column);
        const colour =
          piece === "W" ? ("arcade-white" as const) : colours[piece];
        if (colour !== undefined) {
          bevelled(context, colour, at(column, line), size);
        }
      }
    });
    // The T piece, falling.
    for (const [column, row] of [
      [3, 13],
      [4, 13],
      [5, 13],
      [4, 12],
    ] as const) {
      bevelled(context, "arcade-purple", at(column, row), size);
    }
    // The next piece, an L, in its box at the side.
    context.lineWidth = 0.6;
    context.strokeStyle = hex("metal-light");
    context.strokeRect(74, screenTop + 4, 20, 16);
    for (const [x, y] of [
      [78, screenTop + 8],
      [78, screenTop + 12],
      [82, screenTop + 12],
      [86, screenTop + 12],
    ] as const) {
      bevelled(context, "arcade-orange", [x, y], 4);
    }
    // The level, as pips down the side.
    for (let pip = 0; pip < 5; pip += 1) {
      block(context, "arcade-cyan", [6, 70 + pip * 6], [6, 3]);
    }
    screenGlass(context, screenTop);
  },
};
