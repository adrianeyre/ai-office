import { palette, type PaletteToken } from "@ai-office/shared/palette";

import {
  arcadeInks,
  arcadeScenes,
  type ArcadeMotif,
} from "./arcade-posters.ts";

// The adventure game posters on a Floor's walls (FR-61): affectionate
// parodies of nine classic point-and-click adventures. Each one evokes its
// game's poster or box art (its composition, its palette, the style of its
// lettering and its key subject) under an altered title: "Night of the
// Tentacle", "The Secret of Donkey Island". Nothing is the games' own art
// or logo, traced or copied: every picture is drawn here, procedurally,
// from simple shapes, so each is the Office's own. A title is the one
// place the scene carries words (docs/reference/art-direction.md): the
// posters are decoration, never information the Office needs read.
//
// The posters take the palette's colours where they can, and a few inks of
// their own besides (`posterInks`): a sunset, a smoggy sky and a ghost's
// glow need colours the Office has no other use for.
//
// This module only draws, onto any 2D canvas context; floor-layout.ts
// hangs the posters and wall-posters.tsx turns them into a texture. Each
// is drawn in its own units, 100 wide and 140 high (a B-series poster's
// proportions), and scaled to the canvas.

/** A poster's width and height, in its drawing units: 1 : 1.4. */
export const posterUnits = [100, 140] as const;

/**
 * The posters' own inks, beyond the palette: only the posters use them
 * (docs/reference/art-direction.md, "No text in the scene").
 */
export const posterInks = {
  // Night of the Tentacle
  "night-purple": "#2a1240",
  "dusk-magenta": "#8a3a7c",
  "tentacle-light": "#a983ea",
  "tentacle-shade": "#4c2790",
  "tentacle-green": "#5cc65a",
  "tentacle-green-shade": "#23794a",
  "mouth-dark": "#3a0d2a",
  "title-yellow": "#ffd93a",
  "title-orange": "#f27a1a",
  // Sam & Bob Hit the Road
  "sunset-purple": "#5a2a5e",
  "sunset-red": "#e0542e",
  "sunset-gold": "#ffb347",
  mesa: "#7e3b4f",
  "desert-sand": "#e0a05a",
  "desert-shade": "#b8733c",
  "car-black": "#24242c",
  "dog-tan": "#b9895a",
  "suit-blue": "#5f7896",
  "hat-grey": "#6e7177",
  // Montana Jones and the Fate of Atlantis
  "sepia-dark": "#2e1a0e",
  sepia: "#6e4020",
  orichalcum: "#ff8a1e",
  "orichalcum-glow": "#ffe08a",
  // Space Quack III
  "space-black": "#0b0e22",
  "space-blue": "#1c2a62",
  "chrome-horizon": "#23366e",
  "chrome-pink": "#ef8fc0",
  "bill-orange": "#ff9a1f",
  rust: "#a3532c",
  // Simone the Sorcerer
  "forest-dark": "#0f2a1a",
  forest: "#2b5a30",
  bark: "#4a3020",
  "cape-red": "#c4262f",
  "hat-purple": "#5d2aa0",
  gold: "#e9b52c",
  skin: "#f2c9a0",
  "hair-copper": "#c45a26",
  // Beneath a Tin Sky
  "smog-yellow": "#dcd67a",
  "smog-green": "#8d9e52",
  "smog-dark": "#55633a",
  "tower-far": "#8a9478",
  "tower-mid": "#5b6266",
  "beacon-red": "#ff4a3a",
  // Queen's Quest VII
  "royal-purple": "#36195e",
  orchid: "#9a6ccc",
  "gown-rose": "#e47fab",
  "troll-green": "#86a83e",
  "troll-shade": "#5a7a26",
  // The Secret of Donkey Island
  "deep-blue": "#0a1a44",
  "night-blue": "#17407e",
  teal: "#1e8c8c",
  "sea-teal": "#0f4f5a",
  moon: "#f6f0d0",
  "beach-moon": "#a8b8a8",
  silhouette: "#08202a",
  "hair-blond": "#ecc458",
  "title-red": "#a8281a",
  "donkey-grey": "#7b8790",
  // Donkey Island 2: LeDuck's Revenge
  "storm-black": "#081210",
  "storm-green": "#1c3a2c",
  "ghost-green": "#4cf28c",
  "ghost-glow": "#c6ffd8",
  "ghost-skin": "#7cb894",
  "sea-dark": "#0e2a26",
  // The arcade posters (arcade-posters.ts)
  ...arcadeInks,
} as const satisfies Record<string, `#${string}`>;

export type PosterInk = keyof typeof posterInks;

/** A poster colour: one of the palette's tokens, or a poster ink. */
export type PosterColour = PaletteToken | PosterInk;

/** A gradient's stops: an offset, a colour and, if not opaque, an alpha. */
export type Stops = readonly (
  readonly [number, PosterColour] | readonly [number, PosterColour, number]
)[];

/** Which picture a poster shows, beneath its title. */
export type PosterMotif =
  | "tentacles"
  | "road trip"
  | "atlantis"
  | "space janitor"
  | "young sorceress"
  | "tin city"
  | "storybook castle"
  | "moonlit beach"
  | "ghost captain";

/** How a poster's title is lettered. */
export interface Lettering {
  readonly typeface: "serif" | "sans";
  readonly italic?: boolean;
  /** Each line's fill, from its top to its bottom. */
  readonly fill: Stops;
  /** Its outline, round each letter. */
  readonly outline: PosterColour;
  /** A solid shadow beneath it, offset down and to the right, in units. */
  readonly extrude?: { readonly colour: PosterColour; readonly by: number };
  /** A soft glow round it. */
  readonly glow?: PosterColour;
  /** Each line's tilt, in radians, repeating: a jaunty or warped title. */
  readonly tilt?: readonly number[];
  /** How wide the letters are drawn, as a share of their own width. */
  readonly stretch?: number;
  /** A riveted plate behind the title, its letters stencilled through. */
  readonly plate?: PosterColour;
  /**
   * An arcade cabinet's marquee behind the title: a lit panel of this
   * colour, edged with bulbs in the glow's (or the outline's) colour.
   */
  readonly marquee?: PosterColour;
}

/** A poster: its title, the game it parodies, its picture and its lettering. */
export interface PosterArt {
  readonly title: string;
  /** The game it is a parody of, which it never names. */
  readonly parodies: string;
  readonly motif: PosterMotif | ArcadeMotif;
  /** Its background, from the top to the bottom. */
  readonly sky: Stops;
  readonly lettering: Lettering;
}

/**
 * The nine posters, in the order they hang (floor-layout.ts): four in the
 * meeting room, three on the left wall and two over the canteen's counter.
 */
export const posterArt: readonly PosterArt[] = [
  {
    title: "Night of the Tentacle",
    parodies: "Day of the Tentacle",
    motif: "tentacles",
    sky: [
      [0, "night-purple"],
      [0.6, "dusk-magenta"],
      [1, "night-purple"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "title-yellow"],
        [1, "title-orange"],
      ],
      outline: "ink",
      extrude: { colour: "tentacle-shade", by: 1.6 },
      tilt: [-0.07, 0.06, -0.04],
    },
  },
  {
    title: "Sam & Bob Hit the Road",
    parodies: "Sam & Max Hit the Road",
    motif: "road trip",
    sky: [
      [0, "sunset-purple"],
      [0.45, "sunset-red"],
      [0.66, "sunset-gold"],
      [1, "desert-shade"],
    ],
    lettering: {
      typeface: "sans",
      fill: [
        [0, "paper"],
        [1, "title-yellow"],
      ],
      outline: "ink",
      extrude: { colour: "ink", by: 2 },
      tilt: [-0.05],
      stretch: 0.94,
    },
  },
  {
    title: "Montana Jones and the Fate of Atlantis",
    parodies: "Indiana Jones and the Fate of Atlantis",
    motif: "atlantis",
    sky: [
      [0, "sepia-dark"],
      [0.5, "sepia"],
      [1, "sepia-dark"],
    ],
    lettering: {
      typeface: "serif",
      fill: [
        [0, "orichalcum-glow"],
        [1, "orichalcum"],
      ],
      outline: "sepia-dark",
      extrude: { colour: "ink", by: 1.2 },
    },
  },
  {
    title: "Space Quack III",
    parodies: "Space Quest III",
    motif: "space janitor",
    sky: [
      [0, "space-black"],
      [1, "space-blue"],
    ],
    lettering: {
      typeface: "sans",
      italic: true,
      fill: [
        [0, "paper"],
        [0.45, "screen-glow"],
        [0.5, "chrome-horizon"],
        [0.58, "stage-work"],
        [1, "chrome-pink"],
      ],
      outline: "paper",
      extrude: { colour: "stage-work", by: 1.4 },
    },
  },
  {
    title: "Simone the Sorcerer",
    parodies: "Simon the Sorcerer",
    motif: "young sorceress",
    sky: [
      [0, "forest"],
      [0.7, "plant"],
      [1, "forest"],
    ],
    lettering: {
      typeface: "serif",
      italic: true,
      fill: [
        [0, "lamp"],
        [1, "gold"],
      ],
      outline: "ink",
      extrude: { colour: "cape-red", by: 1.2 },
      tilt: [-0.05, 0.05],
    },
  },
  {
    title: "Beneath a Tin Sky",
    parodies: "Beneath a Steel Sky",
    motif: "tin city",
    sky: [
      [0, "smog-dark"],
      [0.35, "smog-green"],
      [0.7, "smog-yellow"],
      [1, "smog-green"],
    ],
    lettering: {
      typeface: "sans",
      fill: [[0, "title-yellow"]],
      outline: "metal-dark",
      plate: "metal-dark",
      stretch: 0.92,
    },
  },
  {
    title: "Queen's Quest VII: The Princeless Groom",
    parodies: "King's Quest VII: The Princeless Bride",
    motif: "storybook castle",
    sky: [
      [0, "royal-purple"],
      [0.75, "orchid"],
      [1, "gown-rose"],
    ],
    lettering: {
      typeface: "serif",
      italic: true,
      fill: [
        [0, "paper"],
        [0.5, "lamp"],
        [1, "gold"],
      ],
      outline: "ink",
      extrude: { colour: "royal-purple", by: 1.2 },
    },
  },
  {
    title: "The Secret of Donkey Island",
    parodies: "The Secret of Monkey Island",
    motif: "moonlit beach",
    sky: [
      [0, "deep-blue"],
      [0.55, "night-blue"],
      [0.8, "teal"],
      [1, "sea-teal"],
    ],
    lettering: {
      typeface: "serif",
      italic: true,
      fill: [
        [0, "title-yellow"],
        [1, "title-orange"],
      ],
      outline: "title-red",
      extrude: { colour: "ink", by: 1.4 },
      tilt: [-0.06, 0, 0.06],
    },
  },
  {
    title: "Donkey Island 2: LeDuck's Revenge",
    parodies: "Monkey Island 2: LeChuck's Revenge",
    motif: "ghost captain",
    sky: [
      [0, "storm-black"],
      [0.6, "storm-green"],
      [1, "storm-black"],
    ],
    lettering: {
      typeface: "serif",
      italic: true,
      fill: [
        [0, "ghost-glow"],
        [1, "ghost-green"],
      ],
      outline: "storm-black",
      glow: "ghost-green",
      tilt: [-0.04, 0.03, -0.02],
    },
  },
];

/** A 2D canvas context, on screen or off it. */
export type PosterContext =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A poster colour's sRGB hex, with an alpha appended when it has one. */
export function posterColour(name: PosterColour, alpha = 1): string {
  const hex =
    name in palette
      ? palette[name as PaletteToken]
      : posterInks[name as PosterInk];
  if (alpha >= 1) {
    return hex;
  }
  const byte = Math.round(Math.max(0, alpha) * 255);
  return `${hex}${byte.toString(16).padStart(2, "0")}`;
}

/** The fonts each typeface asks for: DejaVu first, as Linux has it. */
const fonts = {
  serif: '"DejaVu Serif", Georgia, "Times New Roman", serif',
  sans: '"DejaVu Sans", Verdana, Arial, sans-serif',
} as const;

/** How wide a title may run: the poster less its border and a margin. */
const titleWidth = 84;
/** The most lines a title takes, and its largest and smallest sizes. */
const titleLimits = { lines: 3, largest: 15, smallest: 7 } as const;
/** Where a title's first line starts, and how far apart its lines are. */
const titleTop = 8;
const lineSpacing = 1.12;

/** A title's font, at `size` drawing units. */
export function posterFont(lettering: Lettering, size: number): string {
  const style = lettering.italic === true ? "italic " : "";
  return `bold ${style}${String(size)}px ${fonts[lettering.typeface]}`;
}

/**
 * A title broken into lines, at the largest size (in drawing units) at
 * which it fits the poster's width in at most three lines.
 */
export function posterTitleLines(
  context: PosterContext,
  { title, lettering }: Pick<PosterArt, "title" | "lettering">,
): { size: number; lines: string[] } {
  const words = title.split(" ");
  const width = titleWidth / (lettering.stretch ?? 1);
  let size: number = titleLimits.largest;
  for (; size > titleLimits.smallest; size -= 0.5) {
    context.font = posterFont(lettering, size);
    const lines = wrap(context, words, width);
    if (
      lines.length <= titleLimits.lines &&
      lines.every((line) => context.measureText(line).width <= width)
    ) {
      return { size, lines };
    }
  }
  context.font = posterFont(lettering, size);
  return { size, lines: wrap(context, words, width) };
}

/** Words into lines no wider than `width`, a word never split. */
function wrap(
  context: PosterContext,
  words: readonly string[],
  width: number,
): string[] {
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    const joined = last === undefined ? word : `${last} ${word}`;
    if (last !== undefined && context.measureText(joined).width <= width) {
      lines[lines.length - 1] = joined;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

/**
 * Draws a poster on `context` in its own units (`posterUnits`), with the
 * context already scaled to them: its background, its picture, its title
 * at the top and an `ink` border round it all.
 */
export function drawPoster(context: PosterContext, art: PosterArt): void {
  const [width, height] = posterUnits;
  context.fillStyle = linear(context, [0, 0], [0, height], art.sky);
  context.fillRect(0, 0, width, height);

  context.save();
  const motif = art.motif;
  if (motif in scenes) {
    scenes[motif as PosterMotif](context);
  } else {
    arcadeScenes[motif as ArcadeMotif](context);
  }
  context.restore();

  context.save();
  drawTitle(context, art);
  context.restore();

  // The border, inside the poster's edge.
  context.lineWidth = 3;
  context.strokeStyle = posterColour("ink");
  context.strokeRect(1.5, 1.5, width - 3, height - 3);
}

/** A poster's title, lettered, across its top. */
function drawTitle(context: PosterContext, art: PosterArt): void {
  const { lettering } = art;
  const { size, lines } = posterTitleLines(context, art);
  const centre = posterUnits[0] / 2;
  const stretch = lettering.stretch ?? 1;
  const tilts = lettering.tilt ?? [0];
  const top = (index: number) => titleTop + index * size * lineSpacing;
  context.textAlign = "center";
  context.textBaseline = "top";
  context.lineJoin = "round";

  if (lettering.plate !== undefined) {
    plate(context, lettering.plate, [4, 4], [92, top(lines.length) + 1]);
  }
  if (lettering.marquee !== undefined) {
    marquee(context, lettering.marquee, lettering.glow ?? lettering.outline, [
      92,
      top(lines.length) + 1,
    ]);
  }

  lines.forEach((line, index) => {
    const y = top(index);
    context.save();
    // Tilt and stretch the line about its own middle.
    context.translate(centre, y + size / 2);
    context.rotate(tilts[index % tilts.length] ?? 0);
    context.scale(stretch, 1);
    context.translate(-centre, -(y + size / 2));

    if (lettering.glow !== undefined) {
      for (const [width, alpha] of [
        [size * 0.9, 0.12],
        [size * 0.6, 0.18],
        [size * 0.35, 0.3],
      ] as const) {
        context.lineWidth = width;
        context.strokeStyle = posterColour(lettering.glow, alpha);
        context.strokeText(line, centre, y);
      }
    }
    if (lettering.extrude !== undefined) {
      const { colour: shade, by } = lettering.extrude;
      context.lineWidth = size / 5;
      context.strokeStyle = posterColour(shade);
      for (let step = 0.25; step <= 1; step += 0.25) {
        context.save();
        context.translate(by * step * 0.6, by * step);
        context.strokeText(line, centre, y);
        context.restore();
      }
    }
    context.lineWidth = size / 5;
    context.strokeStyle = posterColour(lettering.outline);
    context.strokeText(line, centre, y);
    context.fillStyle = linear(context, [0, y], [0, y + size], lettering.fill);
    context.fillText(line, centre, y);

    if (lettering.plate !== undefined) {
      // A stencil's bridges: thin cuts through the letters, in the plate's
      // colour, across the middle of the line.
      context.fillStyle = posterColour(lettering.plate);
      const width = Math.min(context.measureText(line).width, 200);
      context.fillRect(centre - width / 2 - 1, y + size * 0.44, width + 2, 0.7);
    }
    context.restore();
  });
}

/**
 * An arcade cabinet's lit marquee across the poster's top, `[width,
 * height]` big from `[4, 4]`: a panel lit from behind, brightest in its
 * middle, in a dark frame, with a row of bulbs along its top and bottom.
 */
function marquee(
  context: PosterContext,
  fill: PosterColour,
  bulbs: PosterColour,
  [width, height]: readonly [number, number],
): void {
  const [x, y] = [4, 4];
  context.fillStyle = posterColour("ink");
  context.fillRect(x - 1, y - 1, width + 2, height + 2);
  context.fillStyle = linear(
    context,
    [0, y],
    [0, y + height],
    [
      [0, fill],
      [0.5, bulbs, 0.35],
      [1, fill],
    ],
  );
  context.fillRect(x, y, width, height);
  for (let across = x + 3; across < x + width - 1; across += 6) {
    disc(context, bulbs, [across, y + 1.4], 0.8);
    disc(context, bulbs, [across, y + height - 1.4], 0.8);
  }
}

/** A riveted metal plate, from `[x, y]`, `[width, height]` big. */
function plate(
  context: PosterContext,
  fill: PosterColour,
  [x, y]: readonly [number, number],
  [width, height]: readonly [number, number],
): void {
  context.fillStyle = posterColour(fill);
  context.fillRect(x, y, width, height);
  context.lineWidth = 0.6;
  context.strokeStyle = posterColour("ink");
  context.strokeRect(x, y, width, height);
  for (const [rx, ry] of [
    [x + 2.2, y + 2.2],
    [x + width - 2.2, y + 2.2],
    [x + 2.2, y + height - 2.2],
    [x + width - 2.2, y + height - 2.2],
  ] as const) {
    disc(context, "metal-light", [rx, ry], 0.9);
  }
}

// Drawing helpers, all in the poster's units.

type Point = readonly [number, number];

/** A linear gradient from `from` to `to` through `stops`. */
function linear(
  context: PosterContext,
  [x0, y0]: Point,
  [x1, y1]: Point,
  stops: Stops,
): CanvasGradient {
  const gradient = context.createLinearGradient(x0, y0, x1, y1);
  for (const [offset, name, alpha] of stops) {
    gradient.addColorStop(offset, posterColour(name, alpha));
  }
  return gradient;
}

/** A radial gradient out from `centre` to `radius` through `stops`. */
function radial(
  context: PosterContext,
  [x, y]: Point,
  radius: number,
  stops: Stops,
): CanvasGradient {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  for (const [offset, name, alpha] of stops) {
    gradient.addColorStop(offset, posterColour(name, alpha));
  }
  return gradient;
}

type Fill = PosterColour | CanvasGradient;

const style = (fill: Fill) =>
  typeof fill === "string" ? posterColour(fill) : fill;

/** A path built by `build`, filled. */
function shape(context: PosterContext, fill: Fill, build: () => void): void {
  context.beginPath();
  build();
  context.fillStyle = style(fill);
  context.fill();
}

/** A path built by `build`, stroked `width` wide with round ends. */
function stroke(
  context: PosterContext,
  colour: Fill,
  width: number,
  build: () => void,
): void {
  context.beginPath();
  build();
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = style(colour);
  context.stroke();
}

/** A closed shape through `points`, filled. */
function polygon(
  context: PosterContext,
  fill: Fill,
  points: readonly Point[],
): void {
  shape(context, fill, () => {
    points.forEach(([x, y], index) => {
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });
    context.closePath();
  });
}

/** A filled ellipse (a circle when `ry` is left out), turned by `turn`. */
function disc(
  context: PosterContext,
  fill: Fill,
  [x, y]: Point,
  rx: number,
  ry = rx,
  turn = 0,
): void {
  shape(context, fill, () => {
    context.ellipse(x, y, rx, ry, turn, 0, 2 * Math.PI);
  });
}

/** An ellipse's outline. */
function ring(
  context: PosterContext,
  colour: Fill,
  width: number,
  [x, y]: Point,
  rx: number,
  ry = rx,
  turn = 0,
): void {
  stroke(context, colour, width, () => {
    context.ellipse(x, y, rx, ry, turn, 0, 2 * Math.PI);
  });
}

/** A soft round glow, fading out from `colour` at its middle. */
function glow(
  context: PosterContext,
  colour: PosterColour,
  centre: Point,
  radius: number,
  strength = 0.6,
): void {
  disc(
    context,
    radial(context, centre, radius, [
      [0, colour, strength],
      [1, colour, 0],
    ]),
    centre,
    radius,
  );
}

/** A random number from 0 to 1, the same sequence every time from `seed`. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

/** Stars scattered between `top` and `bottom`, the same every time. */
function stars(
  context: PosterContext,
  colour: PosterColour,
  count: number,
  [top, bottom]: Point,
  seed = 7,
): void {
  const next = seeded(seed);
  for (let index = 0; index < count; index += 1) {
    disc(
      context,
      colour,
      [5 + next() * 90, top + next() * (bottom - top)],
      0.35 + next() * 0.6,
    );
  }
}

/** Rolling waves across the poster from `y` down. */
function sea(
  context: PosterContext,
  fill: Fill,
  y: number,
  swell = 3,
  length = 10,
): void {
  shape(context, fill, () => {
    context.moveTo(0, posterUnits[1]);
    context.lineTo(0, y);
    for (let x = 0; x < posterUnits[0]; x += length) {
      context.quadraticCurveTo(x + length / 2, y - swell, x + length, y);
    }
    context.lineTo(posterUnits[0], posterUnits[1]);
    context.closePath();
  });
}

/**
 * A cartoon eye: its white, a pupil looking `look` from its middle and,
 * if `lid` is given, a lid over its top in that colour, drooping by `droop`
 * (a sly, half-shut look).
 */
function eye(
  context: PosterContext,
  [x, y]: Point,
  [rx, ry]: Point,
  look: Point,
  lid?: { readonly colour: PosterColour; readonly droop: number },
): void {
  disc(context, "paper", [x, y], rx, ry);
  disc(context, "ink", [x + look[0], y + look[1]], rx * 0.42);
  disc(
    context,
    "paper",
    [x + look[0] - rx * 0.15, y + look[1] - ry * 0.15],
    rx * 0.12,
  );
  if (lid !== undefined) {
    context.save();
    context.beginPath();
    context.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI);
    context.clip();
    polygon(context, lid.colour, [
      [x - rx - 1, y - ry - 1],
      [x + rx + 1, y - ry - 1],
      [x + rx + 1, y - ry + lid.droop * 2 * ry],
      [x - rx - 1, y - ry + lid.droop * 2 * ry * 0.7],
    ]);
    context.restore();
    stroke(context, "ink", 0.7, () => {
      context.moveTo(x - rx, y - ry + lid.droop * 2 * ry * 0.7);
      context.lineTo(x + rx, y - ry + lid.droop * 2 * ry);
    });
  }
  ring(context, "ink", 0.6, [x, y], rx, ry);
}

/** A palm tree: a curving trunk from `foot` to `crown`, and its fronds. */
function palm(
  context: PosterContext,
  fill: PosterColour,
  [fx, fy]: Point,
  [cx, cy]: Point,
  reach: number,
): void {
  const bend = (fx + cx) / 2 + (fx < cx ? -6 : 6);
  stroke(context, fill, reach / 6, () => {
    context.moveTo(fx, fy);
    context.quadraticCurveTo(bend, (fy + cy) / 2, cx, cy);
  });
  for (const angle of [-2.8, -2.2, -1.5, -0.9, -0.3, 0.3, 3.4]) {
    const tip: Point = [
      cx + Math.cos(angle) * reach,
      cy + Math.sin(angle) * reach * 0.6 + reach * 0.35,
    ];
    const mid: Point = [
      cx + Math.cos(angle) * reach * 0.5,
      cy + Math.sin(angle) * reach * 0.6 - reach * 0.12,
    ];
    shape(context, fill, () => {
      context.moveTo(cx, cy - 0.8);
      context.quadraticCurveTo(mid[0], mid[1] - 2, tip[0], tip[1]);
      context.quadraticCurveTo(mid[0], mid[1] + 2, cx, cy + 0.8);
      context.closePath();
    });
  }
}

/** Each poster's picture, drawn beneath its title, in the poster's units. */
const scenes: Record<PosterMotif, (context: PosterContext) => void> = {
  // A grinning purple tentacle with a sly look, a worried green one behind
  // it, under a big orange moon.
  tentacles: (context) => {
    glow(context, "title-orange", [50, 86], 52, 0.55);
    disc(
      context,
      radial(context, [46, 80], 26, [
        [0, "title-yellow"],
        [1, "title-orange"],
      ]),
      [50, 84],
      25,
    );
    stars(context, "lamp", 18, [44, 120], 3);
    // The green tentacle, behind and to the left.
    const greenBody = () => {
      context.moveTo(6, 140);
      context.bezierCurveTo(8, 118, 10, 100, 14, 86);
      context.quadraticCurveTo(22, 66, 34, 84);
      context.bezierCurveTo(36, 102, 32, 120, 36, 140);
      context.closePath();
    };
    shape(
      context,
      linear(
        context,
        [8, 0],
        [36, 0],
        [
          [0, "tentacle-green"],
          [1, "tentacle-green-shade"],
        ],
      ),
      greenBody,
    );
    stroke(context, "ink", 1, greenBody);
    for (const y of [104, 114, 124, 134]) {
      disc(context, "tentacle-green-shade", [32, y], 1.8, 2.2);
    }
    eye(context, [19, 86], [3.2, 3.8], [1.3, -1]);
    eye(context, [27, 86], [3.2, 3.8], [1.3, -1]);
    stroke(context, "ink", 0.9, () => {
      context.moveTo(15.5, 80.5);
      context.lineTo(21, 79);
      context.moveTo(24.5, 79);
      context.lineTo(30, 80.5);
    });
    disc(context, "mouth-dark", [23, 96], 2.2, 1.8);

    // The purple tentacle, in front.
    context.save();
    context.translate(0, 5);
    const purpleBody = () => {
      context.moveTo(38, 140);
      context.bezierCurveTo(36, 118, 42, 98, 42, 70);
      context.quadraticCurveTo(44, 44, 60, 46);
      context.quadraticCurveTo(76, 48, 76, 68);
      context.bezierCurveTo(76, 96, 72, 118, 84, 140);
      context.closePath();
    };
    shape(
      context,
      linear(
        context,
        [40, 0],
        [80, 0],
        [
          [0, "tentacle-light"],
          [0.45, "stage-review"],
          [1, "tentacle-shade"],
        ],
      ),
      purpleBody,
    );
    stroke(context, "ink", 1.2, purpleBody);
    // Its suckers, down its right side.
    for (const [x, y, r] of [
      [72, 100, 2.4],
      [73, 110, 2.8],
      [75, 121, 3.2],
      [78, 132, 3.6],
    ] as const) {
      disc(context, "tentacle-light", [x, y], r, r * 0.8);
      disc(context, "tentacle-shade", [x, y], r * 0.5, r * 0.4);
      ring(context, "ink", 0.5, [x, y], r, r * 0.8);
    }
    // Sly eyes, looking aside under drooping lids, and a scheming brow.
    eye(context, [52, 64], [5.4, 6.4], [-2.4, 1.6], {
      colour: "stage-review",
      droop: 0.5,
    });
    eye(context, [66, 63], [5.4, 6.4], [-2.4, 1.6], {
      colour: "stage-review",
      droop: 0.55,
    });
    stroke(context, "ink", 1.6, () => {
      context.moveTo(45, 54);
      context.lineTo(57, 57.5);
      context.moveTo(61, 57);
      context.lineTo(73, 52);
    });
    // A big, toothy grin with fat lips.
    const grin = () => {
      context.moveTo(42, 76);
      context.quadraticCurveTo(58, 84, 76, 74);
      context.quadraticCurveTo(66, 100, 42, 76);
      context.closePath();
    };
    shape(context, "mouth-dark", grin);
    context.save();
    context.beginPath();
    grin();
    context.clip();
    shape(context, "paper", () => {
      context.moveTo(40, 74);
      context.quadraticCurveTo(58, 82, 78, 72);
      context.lineTo(78, 77);
      context.quadraticCurveTo(58, 87, 40, 79);
      context.closePath();
    });
    stroke(context, "ceramic", 0.5, () => {
      for (const x of [49, 55, 61, 67]) {
        context.moveTo(x, 77);
        context.lineTo(x, 84);
      }
    });
    disc(context, "state-critical", [60, 92], 7, 4);
    context.restore();
    stroke(context, "tentacle-shade", 2.6, grin);
    stroke(context, "ink", 0.6, grin);
    context.restore();
    // A dark hill hides where they rise from.
    disc(context, "night-purple", [50, 150], 70, 16);
  },

  // Two shady detectives, a dog in a suit and fedora and a white rabbity
  // critter, in a big old two-tone car on a desert road at sunset.
  "road trip": (context) => {
    const horizon = 92;
    // A banded sun going down behind the mesas.
    context.save();
    context.beginPath();
    context.rect(0, 0, 100, horizon);
    context.clip();
    glow(context, "sunset-gold", [50, horizon], 45, 0.7);
    disc(
      context,
      linear(
        context,
        [0, horizon - 26],
        [0, horizon],
        [
          [0, "title-yellow"],
          [1, "title-orange"],
        ],
      ),
      [50, horizon],
      26,
    );
    for (const [y, h] of [
      [horizon - 12, 1],
      [horizon - 7, 1.6],
      [horizon - 3, 2.2],
    ] as const) {
      context.fillStyle = posterColour("sunset-red");
      context.fillRect(20, y, 60, h);
    }
    context.restore();
    // Mesas on the horizon.
    polygon(context, "mesa", [
      [0, horizon],
      [0, 76],
      [6, 76],
      [8, 72],
      [22, 72],
      [25, 80],
      [30, 82],
      [32, horizon],
    ]);
    polygon(context, "mesa", [
      [66, horizon],
      [70, 82],
      [74, 78],
      [86, 78],
      [88, 70],
      [96, 70],
      [100, 74],
      [100, horizon],
    ]);
    // The desert and the road to the horizon.
    context.fillStyle = linear(
      context,
      [0, horizon],
      [0, 140],
      [
        [0, "desert-sand"],
        [1, "desert-shade"],
      ],
    );
    context.fillRect(0, horizon, 100, 48);
    polygon(context, "metal-dark", [
      [49, horizon],
      [51, horizon],
      [116, 140],
      [-16, 140],
    ]);
    for (const [y, length, half] of [
      [94, 2, 0.3],
      [99, 3, 0.5],
      [106, 5, 0.8],
    ] as const) {
      polygon(context, "state-warning", [
        [50 - half * 0.6, y],
        [50 + half * 0.6, y],
        [50 + half, y + length],
        [50 - half, y + length],
      ]);
    }
    // A saguaro.
    stroke(context, "plant", 3, () => {
      context.moveTo(12, 108);
      context.lineTo(12, 86);
      context.moveTo(12, 100);
      context.lineTo(7, 100);
      context.lineTo(7, 92);
      context.moveTo(12, 96);
      context.lineTo(17, 96);
      context.lineTo(17, 89);
    });

    // A cloud of dust behind the car.
    for (const [x, y, r] of [
      [6, 110, 5],
      [2, 104, 4],
      [12, 106, 3.5],
    ] as const) {
      disc(context, "light-ground", [x, y], r);
    }

    // The detectives, behind the car's side.
    // Sam, at the wheel: a dog's head under a fedora, in a blue suit.
    polygon(context, "suit-blue", [
      [54, 112],
      [56, 100],
      [66, 99],
      [69, 112],
    ]);
    polygon(context, "paper", [
      [60, 100],
      [63, 100],
      [61.5, 105],
    ]);
    stroke(context, "state-critical", 1, () => {
      context.moveTo(61.5, 101);
      context.lineTo(61.5, 106);
    });
    disc(context, "dog-tan", [61, 92], 5.6, 5.4);
    disc(context, "dog-tan", [67, 94.5], 4.4, 3);
    disc(context, "ink", [71, 93.5], 1.4, 1.1);
    disc(context, "desert-shade", [57.5, 94], 2.2, 4, 0.3);
    disc(context, "ink", [63.5, 90.5], 0.8);
    stroke(context, "ink", 0.6, () => {
      context.moveTo(65, 96.8);
      context.quadraticCurveTo(68, 97.6, 70.5, 96.4);
    });
    disc(context, "hat-grey", [61, 87.2], 8.4, 1.6);
    shape(context, "hat-grey", () => {
      context.moveTo(55.5, 87.5);
      context.lineTo(56.5, 81);
      context.quadraticCurveTo(61, 78.5, 65.5, 81);
      context.lineTo(66.5, 87.5);
      context.closePath();
    });
    context.fillStyle = posterColour("ink");
    context.fillRect(55.8, 84.8, 10.6, 1.5);
    // Bob, in the back: a white critter, ears flying, grinning wide, one
    // arm waving.
    stroke(context, "paper", 2.2, () => {
      context.moveTo(42, 104);
      context.quadraticCurveTo(44, 96, 47, 90);
    });
    disc(context, "paper", [47.5, 89], 1.8);
    disc(context, "paper", [38, 95], 5.6, 5.2);
    disc(context, "paper", [30, 86], 2, 6.5, -1.1);
    disc(context, "paper", [32, 82], 2, 6.5, -0.7);
    disc(context, "chrome-pink", [32, 82], 0.8, 4.5, -0.7);
    shape(context, "mouth-dark", () => {
      context.moveTo(35, 96.5);
      context.quadraticCurveTo(39, 97.5, 43.4, 95.5);
      context.quadraticCurveTo(41, 103, 35, 96.5);
      context.closePath();
    });
    context.fillStyle = posterColour("paper");
    context.fillRect(36.5, 96.4, 6, 1.3);
    disc(context, "ink", [38, 92], 0.9);
    disc(context, "ink", [42, 92], 0.9);

    // The car, side on: a long two-tone body with fins, chrome and
    // whitewall tyres.
    const roof = () => {
      context.moveTo(30, 104);
      context.quadraticCurveTo(34, 84, 50, 83);
      context.lineTo(56, 83);
    };
    stroke(context, "car-black", 2.2, roof);
    stroke(context, "car-black", 1.6, () => {
      context.moveTo(50, 83);
      context.lineTo(50, 104);
      context.moveTo(56, 83);
      context.lineTo(72, 103);
    });
    shape(context, "car-black", () => {
      context.moveTo(4, 120);
      context.lineTo(4, 108);
      context.lineTo(10, 101);
      context.lineTo(14, 104);
      context.lineTo(72, 103);
      context.quadraticCurveTo(84, 103, 92, 108);
      context.quadraticCurveTo(97, 112, 96, 120);
      context.closePath();
    });
    shape(context, "paper", () => {
      context.moveTo(8, 111);
      context.quadraticCurveTo(40, 106, 90, 109);
      context.lineTo(90, 112);
      context.quadraticCurveTo(40, 110, 8, 114);
      context.closePath();
    });
    context.fillStyle = posterColour("metal-light");
    context.fillRect(2, 118, 12, 3);
    context.fillRect(86, 118, 12, 3);
    disc(context, "lamp", [94, 111], 1.6, 2);
    disc(context, "state-critical", [5, 106], 1, 2);
    for (const x of [24, 78]) {
      disc(context, "ink", [x, 121], 7.2);
      disc(context, "paper", [x, 121], 4.6);
      disc(context, "metal-light", [x, 121], 2.8);
      disc(context, "ink", [x, 121], 0.8);
    }
  },

  // An adventurer's silhouette, fedora on and whip cracking, against a
  // lost city's temple glowing orichalcum orange.
  atlantis: (context) => {
    glow(context, "orichalcum", [60, 92], 56, 0.85);
    glow(context, "orichalcum-glow", [60, 92], 24, 0.9);
    // Atlantis's rings, behind the temple.
    for (const r of [34, 26, 18]) {
      ring(context, "orichalcum", 1.6, [60, 92], r, r * 0.92);
    }
    // The temple: a stepped base, columns and a pediment.
    for (const [y, half] of [
      [124, 40],
      [118, 34],
      [112, 28],
    ] as const) {
      context.fillStyle = posterColour("sepia");
      context.fillRect(60 - half, y, 2 * half, 6);
      context.fillStyle = posterColour("orichalcum");
      context.fillRect(60 - half, y, 2 * half, 0.8);
    }
    polygon(context, "sepia", [
      [34, 80],
      [60, 66],
      [86, 80],
    ]);
    stroke(context, "orichalcum", 0.8, () => {
      context.moveTo(34, 80);
      context.lineTo(60, 66);
      context.lineTo(86, 80);
    });
    context.fillStyle = posterColour("sepia");
    context.fillRect(34, 80, 52, 4);
    for (const x of [37, 46, 70, 79]) {
      context.fillStyle = posterColour("sepia");
      context.fillRect(x, 84, 4, 28);
      context.fillStyle = posterColour("orichalcum");
      context.fillRect(x + 3, 84, 1, 28);
    }
    // Its doorway, blazing.
    polygon(context, "orichalcum-glow", [
      [53, 112],
      [53, 92],
      [60, 86],
      [67, 92],
      [67, 112],
    ]);
    glow(context, "paper", [60, 100], 10, 0.7);
    // Rock in the foreground.
    polygon(context, "sepia-dark", [
      [0, 140],
      [0, 122],
      [14, 118],
      [36, 126],
      [58, 130],
      [80, 128],
      [100, 132],
      [100, 140],
    ]);

    // The adventurer, outlined in the glow.
    const figure = () => {
      // The fedora's brim and crown.
      context.ellipse(26, 66, 11, 2.4, -0.08, 0, 2 * Math.PI);
      context.moveTo(19, 66);
      context.lineTo(20.5, 57.5);
      context.quadraticCurveTo(26, 53, 31.5, 57.5);
      context.lineTo(33, 66);
      context.closePath();
      // The head, the jacket's shoulders and the legs.
      context.moveTo(30.5, 70);
      context.ellipse(26, 70.5, 4.6, 5.6, 0, 0, 2 * Math.PI);
      context.moveTo(22, 75);
      context.lineTo(30, 75);
      context.lineTo(38, 79);
      context.lineTo(40, 104);
      context.lineTo(36, 105);
      context.lineTo(35, 112);
      context.lineTo(37, 140);
      context.lineTo(28, 140);
      context.lineTo(26, 116);
      context.lineTo(24, 140);
      context.lineTo(14, 140);
      context.lineTo(16, 110);
      context.lineTo(12, 106);
      context.lineTo(13, 80);
      context.closePath();
    };
    context.save();
    context.translate(0.9, -0.3);
    shape(context, "orichalcum", figure);
    context.restore();
    shape(context, "ink", figure);
    // An arm raised, and the whip cracking out across the glow.
    stroke(context, "orichalcum", 5.2, () => {
      context.moveTo(36, 80);
      context.lineTo(44, 70);
      context.lineTo(47, 60);
    });
    stroke(context, "ink", 4.4, () => {
      context.moveTo(35.5, 80.5);
      context.lineTo(43.5, 70.5);
      context.lineTo(46.5, 60.5);
    });
    stroke(context, "ink", 1, () => {
      context.moveTo(47, 59);
      context.bezierCurveTo(56, 48, 78, 48, 86, 58);
      context.bezierCurveTo(92, 66, 80, 72, 74, 64);
      context.quadraticCurveTo(70, 58, 78, 56);
    });
  },

  // A lanky space janitor, mop in hand and a duck-billed visor on his
  // helmet, before a patched-up junk freighter and a ringed planet.
  "space janitor": (context) => {
    stars(context, "paper", 70, [4, 138], 11);
    // A ringed planet low on the right.
    disc(
      context,
      radial(context, [78, 112], 34, [
        [0, "chrome-pink"],
        [1, "stage-review"],
      ]),
      [88, 124],
      26,
    );
    ring(context, "lamp", 1.4, [88, 124], 40, 7, -0.3);
    // The junk freighter: a battered hull of patched plates, cargo
    // strapped on, its engines lit.
    context.save();
    context.translate(15, -6);
    polygon(context, "metal-light", [
      [34, 70],
      [46, 58],
      [84, 56],
      [96, 62],
      [96, 76],
      [82, 82],
      [46, 82],
      [34, 76],
    ]);
    polygon(context, "state-neutral", [
      [34, 76],
      [46, 82],
      [82, 82],
      [96, 76],
      [96, 72],
      [34, 72],
    ]);
    for (const [x, y, w, h, fill] of [
      [50, 60, 9, 6, "rust"],
      [66, 61, 12, 5, "metal-dark"],
      [60, 67, 8, 4, "rust"],
      [80, 64, 7, 6, "state-neutral"],
      [45, 66, 6, 5, "metal-dark"],
    ] as const) {
      context.fillStyle = posterColour(fill);
      context.fillRect(x, y, w, h);
    }
    // A bridge dome and its lit windows.
    disc(context, "metal-light", [88, 58], 6, 4);
    disc(context, "screen-glow", [90, 57], 3, 1.6);
    // Cargo pods, one hanging loose.
    for (const [x, y] of [
      [56, 84],
      [66, 84],
      [76, 86],
    ] as const) {
      context.fillStyle = posterColour("rust");
      context.fillRect(x, y, 7, 5);
      context.fillStyle = posterColour("metal-dark");
      context.fillRect(x, y + 2, 7, 0.8);
    }
    // The engines.
    for (const y of [64, 74]) {
      context.fillStyle = posterColour("metal-dark");
      context.fillRect(32, y - 3, 9, 6);
      glow(context, "screen-glow", [31, y], 9, 0.9);
      disc(context, "paper", [31.5, y], 1.8, 2.4);
    }
    context.restore();

    // The janitor, lanky, in grey overalls.
    stroke(context, "metal-light", 3.4, () => {
      context.moveTo(20, 140);
      context.lineTo(21, 112);
      context.moveTo(28, 140);
      context.lineTo(26, 112);
    });
    disc(context, "metal-dark", [18.5, 139], 3.6, 1.6);
    disc(context, "metal-dark", [29.5, 139], 3.6, 1.6);
    polygon(context, "metal-light", [
      [18, 114],
      [17, 88],
      [21, 84],
      [27, 84],
      [31, 88],
      [30, 114],
    ]);
    context.fillStyle = posterColour("stage-work");
    context.fillRect(17.5, 100, 12.5, 2);
    disc(context, "state-warning", [27, 92], 1.4);
    // His mop, held across him, its head on the floor.
    stroke(context, "desk-top", 1.4, () => {
      context.moveTo(40, 76);
      context.lineTo(8, 128);
    });
    for (let index = 0; index < 7; index += 1) {
      stroke(context, "ceramic", 1.2, () => {
        context.moveTo(9, 127);
        context.quadraticCurveTo(
          6 + index * 0.6,
          132,
          1 + index * 2.2,
          137 - (index % 2) * 1.5,
        );
      });
    }
    // His arms, reaching for the mop.
    stroke(context, "metal-light", 2.6, () => {
      context.moveTo(19, 89);
      context.lineTo(18, 102);
      context.lineTo(23, 108);
      context.moveTo(29, 89);
      context.lineTo(33, 96);
      context.lineTo(34, 86);
    });
    // His helmet: a glass bowl round his head, its visor a long duck's
    // bill sticking out in front.
    disc(context, "skin", [24, 77], 4.2, 4.6);
    disc(context, "hair-blond", [23, 73.5], 4, 1.8);
    disc(context, "ink", [26, 76.5], 0.6);
    disc(context, "screen-glow", [24, 77], 8, 8.5);
    disc(context, "paper", [20, 73], 2.2, 1.2, -0.6);
    const bill = () => {
      context.moveTo(28, 75);
      context.quadraticCurveTo(38, 70.5, 45, 75.5);
      context.quadraticCurveTo(46.5, 78, 44, 79);
      context.quadraticCurveTo(38, 84, 28, 82);
      context.closePath();
    };
    shape(context, "bill-orange", bill);
    stroke(context, "title-orange", 0.7, () => {
      context.moveTo(29, 79);
      context.quadraticCurveTo(37, 79.5, 45, 77.4);
    });
    disc(context, "title-orange", [36, 74.6], 0.8, 0.5);
    stroke(context, "ink", 0.5, bill);
    ring(context, "metal-dark", 0.8, [24, 77], 8, 8.5);
    context.fillStyle = posterColour("metal-dark");
    context.fillRect(19, 85, 10, 1.6);
  },

  // A young sorceress in a tall, crooked purple hat and a red cape, wand
  // raised, in a dark fairy-tale wood.
  "young sorceress": (context) => {
    // A shaft of light down the middle of the wood.
    polygon(
      context,
      linear(
        context,
        [0, 40],
        [0, 140],
        [
          [0, "lamp", 0.05],
          [1, "lamp", 0.35],
        ],
      ),
      [
        [38, 40],
        [62, 40],
        [80, 140],
        [20, 140],
      ],
    );
    // Twisted trees either side.
    for (const [x, flip] of [
      [8, 1],
      [92, -1],
    ] as const) {
      shape(context, "bark", () => {
        context.moveTo(x - 8 * flip, 140);
        context.bezierCurveTo(
          x + 2 * flip,
          110,
          x - 6 * flip,
          80,
          x + 4 * flip,
          40,
        );
        context.lineTo(x + 12 * flip, 40);
        context.bezierCurveTo(
          x + 4 * flip,
          80,
          x + 14 * flip,
          110,
          x + 8 * flip,
          140,
        );
        context.closePath();
      });
      stroke(context, "bark", 2, () => {
        context.moveTo(x + 5 * flip, 70);
        context.quadraticCurveTo(x + 14 * flip, 62, x + 22 * flip, 64);
        context.moveTo(x + 6 * flip, 92);
        context.quadraticCurveTo(x + 16 * flip, 88, x + 18 * flip, 80);
      });
    }
    // The canopy, and fireflies.
    for (const [x, y, r] of [
      [4, 44, 16],
      [20, 38, 14],
      [80, 38, 14],
      [96, 46, 16],
    ] as const) {
      disc(context, "forest-dark", [x, y], r, r * 0.8);
    }
    for (const [x, y] of [
      [20, 66],
      [80, 74],
      [28, 96],
      [74, 102],
      [86, 58],
      [14, 112],
    ] as const) {
      glow(context, "lamp", [x, y], 3.5, 0.8);
      disc(context, "lamp", [x, y], 0.6);
    }
    // The path and a toadstool.
    disc(context, "forest", [50, 140], 44, 10);
    stroke(context, "paper", 3, () => {
      context.moveTo(80, 132);
      context.lineTo(80, 126);
    });
    shape(context, "cape-red", () => {
      context.ellipse(80, 126, 6, 3.6, 0, Math.PI, 2 * Math.PI);
      context.closePath();
    });
    for (const [x, y] of [
      [78, 124],
      [82, 124.5],
      [80, 123],
    ] as const) {
      disc(context, "paper", [x, y], 0.7);
    }

    // The sorceress, a little smaller than life, so her hat clears the
    // title: her red cape, flaring behind her.
    context.save();
    context.translate(50, 136);
    context.scale(0.9, 0.9);
    context.translate(-50, -136);
    shape(context, "cape-red", () => {
      context.moveTo(44, 86);
      context.quadraticCurveTo(26, 110, 28, 136);
      context.lineTo(72, 136);
      context.quadraticCurveTo(72, 110, 56, 86);
      context.closePath();
    });
    shape(context, "title-red", () => {
      context.moveTo(44, 86);
      context.quadraticCurveTo(30, 112, 33, 136);
      context.lineTo(42, 136);
      context.quadraticCurveTo(40, 110, 46, 88);
      context.closePath();
    });
    // Her robe and boots.
    polygon(context, "stage-work", [
      [45, 86],
      [55, 86],
      [62, 132],
      [38, 132],
    ]);
    disc(context, "bark", [44, 133], 4, 2);
    disc(context, "bark", [56, 133], 4, 2);
    context.fillStyle = posterColour("gold");
    context.fillRect(42, 100, 16, 2);
    // Her arm up, and her wand sparkling.
    stroke(context, "stage-work", 3, () => {
      context.moveTo(54, 90);
      context.lineTo(62, 92);
      context.lineTo(66, 84);
    });
    stroke(context, "bark", 1, () => {
      context.moveTo(66, 85);
      context.lineTo(72, 72);
    });
    glow(context, "lamp", [72.5, 71], 8, 0.9);
    polygon(context, "lamp", [
      [72.5, 66],
      [73.6, 69.8],
      [77.5, 71],
      [73.6, 72.2],
      [72.5, 76],
      [71.4, 72.2],
      [67.5, 71],
      [71.4, 69.8],
    ]);
    // Her copper hair, long, and her face.
    shape(context, "hair-copper", () => {
      context.moveTo(43, 78);
      context.quadraticCurveTo(38, 92, 41, 100);
      context.lineTo(46, 96);
      context.lineTo(54, 96);
      context.lineTo(59, 100);
      context.quadraticCurveTo(62, 92, 57, 78);
      context.closePath();
    });
    disc(context, "skin", [50, 82], 6, 6.6);
    disc(context, "ink", [47.6, 82], 0.9, 1.1);
    disc(context, "ink", [52.4, 82], 0.9, 1.1);
    disc(context, "sofa", [46, 85], 1.2, 0.7);
    disc(context, "sofa", [54, 85], 1.2, 0.7);
    stroke(context, "ink", 0.6, () => {
      context.moveTo(48, 86);
      context.quadraticCurveTo(50, 87.6, 52, 86);
    });
    // Her hat: a broad brim and a tall, crooked point.
    disc(context, "hat-purple", [50, 76], 13, 2.8, -0.05);
    shape(context, "hat-purple", () => {
      context.moveTo(42, 76);
      context.quadraticCurveTo(46, 60, 50, 52);
      context.quadraticCurveTo(54, 44, 64, 42);
      context.quadraticCurveTo(56, 50, 56, 60);
      context.lineTo(58, 76);
      context.closePath();
    });
    shape(context, "gold", () => {
      context.moveTo(42.6, 72);
      context.lineTo(57.6, 72);
      context.lineTo(58, 75);
      context.lineTo(42.2, 75);
      context.closePath();
    });
    disc(context, "gold", [50, 64], 1.3);
    disc(context, "gold", [53.5, 56], 0.9);
    context.restore();
  },

  // A dystopian vertical city of grey towers in a yellow-green smog, a
  // lone figure and his small round robot on a walkway.
  "tin city": (context) => {
    glow(context, "paper", [64, 70], 30, 0.45);
    disc(context, "smog-yellow", [64, 70], 8);
    // Far towers, pale in the smog.
    for (const [x, top, width] of [
      [0, 66, 12],
      [14, 52, 9],
      [30, 60, 12],
      [56, 48, 8],
      [72, 58, 12],
      [88, 50, 12],
    ] as const) {
      context.fillStyle = posterColour("tower-far");
      context.fillRect(x, top, width, 140 - top);
    }
    // Nearer towers, dark, with rows of lit windows, pipes and masts.
    for (const [x, top, width] of [
      [2, 74, 16],
      [22, 44, 14],
      [64, 40, 12],
      [82, 70, 18],
    ] as const) {
      context.fillStyle = posterColour("tower-mid");
      context.fillRect(x, top, width, 140 - top);
      context.fillStyle = posterColour("metal-dark");
      context.fillRect(x + width - 3, top, 3, 140 - top);
      for (let y = top + 4; y < 136; y += 5) {
        for (let wx = x + 2; wx < x + width - 4; wx += 3) {
          if ((wx * 13 + y * 7) % 9 < 3) {
            context.fillStyle = posterColour("smog-yellow");
            context.fillRect(wx, y, 1.4, 1.8);
          }
        }
      }
    }
    for (const [x, top] of [
      [29, 44],
      [70, 40],
    ] as const) {
      context.fillStyle = posterColour("metal-dark");
      context.fillRect(x - 0.4, top - 12, 0.8, 12);
      glow(context, "beacon-red", [x, top - 12], 2.5, 0.9);
    }
    // Walkways between the towers.
    for (const [x0, x1, y] of [
      [36, 64, 96],
      [18, 22, 112],
      [76, 82, 88],
    ] as const) {
      context.fillStyle = posterColour("metal-dark");
      context.fillRect(x0, y, x1 - x0, 2.4);
      stroke(context, "metal-dark", 0.4, () => {
        context.moveTo(x0, y - 3);
        context.lineTo(x1, y - 3);
        for (let x = x0 + 2; x < x1; x += 4) {
          context.moveTo(x, y - 3);
          context.lineTo(x, y);
        }
      });
    }
    // A great pipe down the middle tower.
    stroke(context, "metal-dark", 2, () => {
      context.moveTo(39, 140);
      context.lineTo(39, 104);
      context.quadraticCurveTo(39, 100, 44, 100);
      context.lineTo(60, 100);
    });
    // The lone figure, in a long coat, and his robot.
    polygon(context, "ink", [
      [46, 96],
      [47, 88],
      [46.4, 84],
      [49.6, 84],
      [49, 88],
      [50, 96],
    ]);
    disc(context, "ink", [48, 82.4], 1.6, 1.9);
    disc(context, "metal-light", [55, 93.4], 2.4, 2.6);
    ring(context, "ink", 0.4, [55, 93.4], 2.4, 2.6);
    disc(context, "beacon-red", [56, 93], 0.7);
    stroke(context, "ink", 0.35, () => {
      context.moveTo(55, 90.8);
      context.lineTo(54.4, 88.6);
    });
    // Smog drifting low.
    context.fillStyle = linear(
      context,
      [0, 110],
      [0, 140],
      [
        [0, "smog-yellow", 0],
        [1, "smog-green", 0.75],
      ],
    );
    context.fillRect(0, 110, 100, 30);
  },

  // A storybook's page: a princess and her trollish groom before a purple
  // and gold castle, inside a gilded frame.
  "storybook castle": (context) => {
    stars(context, "lamp", 20, [40, 90], 5);
    disc(context, "lamp", [80, 54], 5);
    disc(context, "royal-purple", [82.4, 52.6], 4.4);
    // A green hill, and the castle on it.
    disc(context, "troll-shade", [70, 132], 60, 30);
    disc(context, "troll-green", [20, 142], 50, 26);
    context.fillStyle = posterColour("stage-review");
    context.fillRect(46, 74, 40, 36);
    for (const [x, top, width] of [
      [42, 62, 9],
      [80, 62, 9],
      [58, 52, 12],
    ] as const) {
      context.fillStyle = posterColour("orchid");
      context.fillRect(x, top, width, 110 - top);
      polygon(context, "gold", [
        [x - 1.5, top],
        [x + width + 1.5, top],
        [x + width / 2, top - 16],
      ]);
      polygon(context, "cape-red", [
        [x + width / 2, top - 16],
        [x + width / 2 + 5, top - 14.5],
        [x + width / 2, top - 13],
      ]);
      disc(context, "lamp", [x + width / 2, top + 7], 1.4, 2.2);
    }
    for (let x = 46; x < 86; x += 4) {
      context.fillStyle = posterColour("stage-review");
      context.fillRect(x, 71, 2.4, 3);
    }
    shape(context, "metal-dark", () => {
      context.moveTo(60, 110);
      context.lineTo(60, 99);
      context.quadraticCurveTo(64, 94, 68, 99);
      context.lineTo(68, 110);
      context.closePath();
    });

    // The princess: a bell of a rose gown, golden hair and a crown.
    shape(context, "gown-rose", () => {
      context.moveTo(26, 100);
      context.quadraticCurveTo(22, 120, 12, 134);
      context.lineTo(40, 134);
      context.quadraticCurveTo(30, 120, 30, 100);
      context.closePath();
    });
    polygon(context, "stage-docs", [
      [25, 98],
      [31, 98],
      [30.5, 106],
      [25.5, 106],
    ]);
    stroke(context, "gown-rose", 2, () => {
      context.moveTo(30, 100);
      context.quadraticCurveTo(36, 104, 40, 108);
    });
    shape(context, "gold", () => {
      context.moveTo(24, 92);
      context.quadraticCurveTo(22, 102, 23, 106);
      context.lineTo(33, 106);
      context.quadraticCurveTo(34, 100, 32, 92);
      context.closePath();
    });
    disc(context, "skin", [28, 93], 4, 4.4);
    disc(context, "ink", [29.6, 92.6], 0.6);
    disc(context, "sofa", [30.4, 95], 0.9, 0.5);
    disc(context, "gold", [27.6, 89.4], 4.4, 1.8);
    polygon(context, "gold", [
      [25, 88],
      [25.6, 84.6],
      [26.8, 86.6],
      [28, 84],
      [29.2, 86.6],
      [30.4, 84.6],
      [31, 88],
    ]);
    // The groom: squat and green, big-nosed, in a black coat and bow tie,
    // a bunch of flowers held out.
    shape(context, "ink", () => {
      context.moveTo(54, 134);
      context.lineTo(55, 112);
      context.quadraticCurveTo(64, 104, 73, 112);
      context.lineTo(74, 134);
      context.closePath();
    });
    polygon(context, "paper", [
      [61, 109],
      [67, 109],
      [65.5, 126],
      [62.5, 126],
    ]);
    polygon(context, "state-critical", [
      [60.6, 108.4],
      [64, 110],
      [67.4, 108.4],
      [67.4, 111.6],
      [64, 110],
      [60.6, 111.6],
    ]);
    stroke(context, "troll-green", 3, () => {
      context.moveTo(56, 114);
      context.lineTo(48, 112);
    });
    for (const [x, y, fill] of [
      [45, 110, "cape-red"],
      [44, 113, "lamp"],
      [46.4, 114, "gown-rose"],
    ] as const) {
      disc(context, fill, [x, y], 1.8);
    }
    disc(context, "troll-green", [64, 100], 9, 8);
    disc(context, "troll-green", [55, 96], 3, 1.6, -0.5);
    disc(context, "troll-green", [73, 96], 3, 1.6, 0.5);
    disc(context, "troll-shade", [61, 102], 4.6, 3.8);
    disc(context, "troll-green", [60, 101], 1.6, 1.2);
    stroke(context, "bark", 0.9, () => {
      context.moveTo(58, 92.4);
      context.lineTo(57, 89.6);
      context.moveTo(70, 92.4);
      context.lineTo(71.4, 89.8);
    });
    disc(context, "paper", [59, 96], 1.8);
    disc(context, "paper", [66, 96], 1.8);
    disc(context, "ink", [59.6, 96.4], 0.8);
    disc(context, "ink", [66.6, 96.4], 0.8);
    stroke(context, "ink", 0.7, () => {
      context.moveTo(60, 106);
      context.quadraticCurveTo(64, 108.4, 69, 105.4);
    });
    polygon(context, "paper", [
      [66, 106.4],
      [67.2, 106],
      [66.8, 108],
    ]);
    // A crown too small for him.
    polygon(context, "gold", [
      [61, 93],
      [61.4, 89],
      [62.6, 91],
      [64, 88.4],
      [65.4, 91],
      [66.6, 89],
      [67, 93],
    ]);

    // The gilded frame, its bottom corners curled.
    context.lineWidth = 1.2;
    context.strokeStyle = posterColour("gold");
    context.strokeRect(5, 5, 90, 130);
    context.lineWidth = 0.5;
    context.strokeRect(7, 7, 86, 126);
    for (const [x, y, sx, sy] of [
      [7, 133, 1, -1],
      [93, 133, -1, -1],
    ] as const) {
      stroke(context, "gold", 0.9, () => {
        context.moveTo(x, y + 10 * sy);
        context.quadraticCurveTo(x + 6 * sx, y + 6 * sy, x + 10 * sx, y);
        context.moveTo(x + 3 * sx, y + 3 * sy);
        context.arc(x + 5 * sx, y + 5 * sy, 2, 0, 2 * Math.PI);
      });
    }
  },

  // A would-be pirate on a moonlit beach, palms over him, a tall ship at
  // anchor and a donkey watching.
  "moonlit beach": (context) => {
    glow(context, "moon", [64, 72], 34, 0.5);
    disc(context, "moon", [64, 72], 17);
    disc(context, "beach-moon", [58, 68], 3, 2.4);
    disc(context, "beach-moon", [70, 78], 2.2);
    stars(context, "paper", 22, [40, 96], 9);
    // The sea, the moon's path on it, and the ship at anchor.
    sea(context, "sea-teal", 100, 1.4, 8);
    for (const [y, half] of [
      [103, 7],
      [107, 9],
      [111, 6],
      [115, 10],
    ] as const) {
      context.fillStyle = posterColour("moon", 0.7);
      context.fillRect(64 - half, y, 2 * half, 0.8);
    }
    polygon(context, "silhouette", [
      [74, 98],
      [96, 98],
      [93, 102],
      [77, 102],
    ]);
    for (const [x, top] of [
      [79, 76],
      [85, 72],
      [91, 80],
    ] as const) {
      context.fillStyle = posterColour("silhouette");
      context.fillRect(x - 0.3, top, 0.6, 98 - top);
      for (const [y, half] of [
        [top + 3, 3],
        [top + 10, 4],
      ] as const) {
        context.fillRect(x - half, y, 2 * half, 5);
      }
    }
    // The beach.
    shape(context, "beach-moon", () => {
      context.moveTo(0, 140);
      context.lineTo(0, 118);
      context.quadraticCurveTo(50, 112, 100, 124);
      context.lineTo(100, 140);
      context.closePath();
    });
    // Palms, dark against the sky.
    palm(context, "silhouette", [8, 140], [22, 58], 20);
    palm(context, "silhouette", [96, 140], [88, 100], 12);
    // A donkey on the beach, looking on.
    const donkey = "donkey-grey";
    context.fillStyle = posterColour(donkey);
    context.fillRect(72, 117, 12, 6);
    stroke(context, donkey, 1.4, () => {
      for (const x of [73, 75.5, 80.5, 83]) {
        context.moveTo(x, 122);
        context.lineTo(x, 127);
      }
      context.moveTo(84, 118);
      context.lineTo(87, 112);
    });
    disc(context, donkey, [88.6, 112], 2.8, 1.8, 0.4);
    disc(context, donkey, [86.4, 107.4], 0.8, 3, -0.2);
    disc(context, donkey, [88, 107.6], 0.8, 3, 0.2);
    disc(context, "ink", [88, 111], 0.4);

    // The pirate wannabe: a blond ponytail, a white shirt, dark breeches
    // and boots, and a sword held high.
    stroke(context, "silhouette", 2.6, () => {
      context.moveTo(42, 128);
      context.lineTo(43, 112);
      context.moveTo(50, 128);
      context.lineTo(48, 112);
    });
    disc(context, "ink", [41.4, 128.6], 2.4, 1.2);
    disc(context, "ink", [50.6, 128.6], 2.4, 1.2);
    polygon(context, "silhouette", [
      [41, 113],
      [42, 106],
      [49, 106],
      [50, 113],
    ]);
    shape(context, "paper", () => {
      context.moveTo(41, 107);
      context.quadraticCurveTo(39, 98, 42, 92);
      context.lineTo(49, 92);
      context.quadraticCurveTo(52, 98, 50, 107);
      context.closePath();
    });
    stroke(context, "paper", 2.4, () => {
      context.moveTo(48, 93);
      context.lineTo(54, 88);
      context.lineTo(57, 82);
      context.moveTo(42, 94);
      context.lineTo(38, 102);
    });
    stroke(context, "metal-light", 0.8, () => {
      context.moveTo(57, 82);
      context.lineTo(62, 66);
    });
    stroke(context, "gold", 1, () => {
      context.moveTo(55.6, 81.6);
      context.lineTo(58.6, 82.6);
    });
    disc(context, "skin", [45.5, 88], 3.2, 3.6);
    shape(context, "hair-blond", () => {
      context.moveTo(42.2, 87);
      context.quadraticCurveTo(43, 83, 46, 83.6);
      context.quadraticCurveTo(49, 84, 48.8, 86.4);
      context.quadraticCurveTo(46, 85.6, 44, 87.4);
      context.quadraticCurveTo(40, 92, 38, 94);
      context.quadraticCurveTo(39, 89, 42.2, 87);
      context.closePath();
    });
    disc(context, "ink", [47, 88], 0.45);
  },

  // A ghost-pirate captain looming over his black ship on a stormy sea:
  // a skull on his hat, glowing eyes, a duck's bill and a beard of green
  // ghost-fire.
  "ghost captain": (context) => {
    glow(context, "ghost-green", [50, 82], 48, 0.35);
    // Lightning.
    stroke(context, "ghost-glow", 0.9, () => {
      context.moveTo(88, 40);
      context.lineTo(82, 56);
      context.lineTo(87, 56);
      context.lineTo(80, 74);
      context.moveTo(12, 44);
      context.lineTo(16, 56);
      context.lineTo(11, 58);
      context.lineTo(15, 70);
    });
    // His coat's shoulders, broad and dark.
    shape(context, "storm-black", () => {
      context.moveTo(4, 128);
      context.quadraticCurveTo(10, 98, 34, 94);
      context.lineTo(66, 94);
      context.quadraticCurveTo(90, 98, 96, 128);
      context.closePath();
    });
    for (const y of [104, 112]) {
      disc(context, "gold", [26, y], 1.4);
      disc(context, "gold", [74, y], 1.4);
    }
    // His face, pale green.
    disc(context, "ghost-skin", [50, 74], 17, 18);
    // The beard: tongues of ghost-fire, glowing.
    glow(context, "ghost-green", [50, 98], 26, 0.7);
    for (let index = 0; index < 9; index += 1) {
      const x = 34 + index * 4;
      const length = 18 + ((index * 7) % 5) * 3 - Math.abs(index - 4) * 2;
      shape(context, index % 2 === 0 ? "ghost-green" : "ghost-glow", () => {
        context.moveTo(x - 3, 82);
        context.quadraticCurveTo(
          x - 4,
          82 + length * 0.6,
          x + (index % 3) - 1,
          82 + length,
        );
        context.quadraticCurveTo(x + 4, 82 + length * 0.5, x + 3, 82);
        context.closePath();
      });
    }
    // Glowing eyes under a furious brow.
    for (const x of [42, 58]) {
      glow(context, "ghost-glow", [x, 70], 6, 0.9);
      disc(context, "ghost-glow", [x, 70], 2.6, 2);
      disc(context, "paper", [x, 70], 1.2, 1);
    }
    stroke(context, "storm-black", 2, () => {
      context.moveTo(35, 62);
      context.lineTo(47, 66);
      context.moveTo(53, 66);
      context.lineTo(65, 62);
    });
    // The bill: a duck's, broad and flat, scowling.
    shape(context, "bill-orange", () => {
      context.moveTo(40, 78);
      context.quadraticCurveTo(50, 74, 60, 78);
      context.quadraticCurveTo(66, 82, 60, 86);
      context.quadraticCurveTo(50, 88, 40, 86);
      context.quadraticCurveTo(34, 82, 40, 78);
      context.closePath();
    });
    stroke(context, "title-orange", 0.8, () => {
      context.moveTo(38, 82.6);
      context.quadraticCurveTo(50, 80, 62, 82.6);
    });
    disc(context, "title-orange", [46, 78.4], 1, 0.6);
    disc(context, "title-orange", [54, 78.4], 1, 0.6);
    // His hat: a black tricorn with a skull and crossbones.
    shape(context, "storm-black", () => {
      context.moveTo(24, 60);
      context.quadraticCurveTo(30, 50, 36, 52);
      context.quadraticCurveTo(50, 38, 64, 52);
      context.quadraticCurveTo(70, 50, 76, 60);
      context.quadraticCurveTo(50, 54, 24, 60);
      context.closePath();
    });
    stroke(context, "gold", 0.8, () => {
      context.moveTo(25, 59.4);
      context.quadraticCurveTo(50, 53.4, 75, 59.4);
    });
    stroke(context, "paper", 0.9, () => {
      context.moveTo(46, 54);
      context.lineTo(54, 50);
      context.moveTo(46, 50);
      context.lineTo(54, 54);
    });
    disc(context, "paper", [50, 49.4], 2.2, 2);
    disc(context, "storm-black", [49.2, 49.2], 0.5);
    disc(context, "storm-black", [50.8, 49.2], 0.5);

    // The stormy sea, and his black ship riding it.
    sea(context, "sea-dark", 120, 4, 12);
    shape(context, "storm-black", () => {
      context.moveTo(24, 116);
      context.lineTo(76, 116);
      context.lineTo(70, 126);
      context.lineTo(30, 126);
      context.closePath();
    });
    for (const [x, top] of [
      [36, 96],
      [50, 92],
      [64, 98],
    ] as const) {
      context.fillStyle = posterColour("storm-black");
      context.fillRect(x - 0.4, top, 0.8, 116 - top);
      shape(context, "storm-black", () => {
        context.moveTo(x - 5, top + 3);
        context.quadraticCurveTo(x, top + 8, x - 5, top + 15);
        context.lineTo(x + 5, top + 15);
        context.quadraticCurveTo(x + 2, top + 8, x + 5, top + 3);
        context.closePath();
      });
    }
    for (const x of [34, 44, 54, 64]) {
      disc(context, "ghost-green", [x, 120], 0.9, 0.7);
    }
    sea(context, "storm-green", 128, 3, 9);
    for (const [x, y] of [
      [10, 127],
      [30, 129],
      [62, 128],
      [86, 127],
    ] as const) {
      stroke(context, "ghost-glow", 0.6, () => {
        context.moveTo(x, y);
        context.quadraticCurveTo(x + 3, y - 2, x + 6, y);
      });
    }
  },
};
