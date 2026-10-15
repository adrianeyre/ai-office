// The Office's colour palette (PRD §7, Visual bar): one set of named tokens
// that every 3D asset and the scene's lights take their colours from, and
// that the web app's Tailwind config turns into `office-*` colours, so a
// Stage or a warning looks the same in 2D as in 3D. The spec is
// docs/reference/art-direction.md, whose palette table must match this file
// (palette.test.ts checks it). Values are sRGB hex; three.js converts them
// to linear itself. It runs in the browser and in Tailwind's config loader,
// so it imports nothing.

export const palette = {
  // Architecture
  wall: "#efe8dc",
  "wall-feature": "#c9d8d0",
  ceiling: "#f6f2ea",
  "floor-wood": "#c89f74",
  "floor-carpet": "#66737d",
  glass: "#bcd7e3",
  "metal-dark": "#3a4047",
  "metal-light": "#b9bec4",

  // Furniture and props
  "desk-top": "#d9b991",
  chair: "#2f5d62",
  sofa: "#c8664a",
  ceramic: "#e6dccb",
  plant: "#5e8c4a",

  // Screens and light sources (emissive)
  "screen-off": "#2a3037",
  "screen-glow": "#9fd3ff",
  lamp: "#ffd9a0",

  // Paper and ink
  paper: "#fbf8f2",
  ink: "#23272c",

  // Stages: tickets, desk dressing and badges
  "stage-work": "#2f6fc4",
  "stage-review": "#7a4fc4",
  "stage-qa": "#137576",
  "stage-docs": "#b04a78",

  // States (FR-62): token labels, Context Usage, markers and lights
  "state-neutral": "#8b9096",
  "state-ok": "#3aa866",
  "state-warning": "#fab219",
  "state-critical": "#d03b3b",
  "state-info": "#2a6bc0",

  // Lighting
  "light-key": "#fff1dc",
  "light-fill": "#cfe0ff",
  "light-sky": "#e4ecf5",
  "light-ground": "#cdb89c",
  shadow: "#3a3550",
} as const satisfies Record<string, `#${string}`>;

export type PaletteToken = keyof typeof palette;

export const paletteTokens = Object.keys(palette) as readonly PaletteToken[];

/**
 * The text colour to put on each token that ever carries a label (a
 * ticket's issue number, a badge, a token label above an Agent). Each pair
 * is at least 4.5:1 (WCAG 2.2 AA for normal text).
 */
export const paletteForegrounds = {
  wall: "ink",
  paper: "ink",
  "screen-off": "paper",
  "screen-glow": "ink",
  "stage-work": "paper",
  "stage-review": "paper",
  "stage-qa": "paper",
  "stage-docs": "paper",
  "state-neutral": "ink",
  "state-ok": "ink",
  "state-warning": "ink",
  "state-critical": "paper",
  "state-info": "paper",
} as const satisfies Partial<Record<PaletteToken, "ink" | "paper">>;
