import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { themes } from "./appearance.ts";

// Every theme, in both modes, against WCAG 2.2 AA: 4.5:1 for text (1.4.3),
// 3:1 for field borders, icons and the focus outline (1.4.11).

// jsdom gives import.meta.url an http: address, so the path comes from dirname.
const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

/** The colour tokens the block for `selector` in styles.css declares. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`No ${selector} block in styles.css`);
  }
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name ?? "",
      (value ?? "").trim(),
    ]),
  );
}

const linear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** A colour's linear-light sRGB channels, from hex or oklch(). */
function linearRgb(colour: string): [number, number, number] {
  if (colour.startsWith("#")) {
    const [r, g, b] = [1, 3, 5].map((at) =>
      linear(parseInt(colour.slice(at, at + 2), 16) / 255),
    );
    return [r ?? 0, g ?? 0, b ?? 0];
  }
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(colour);
  if (match === null) {
    throw new Error(`Cannot read the colour ${colour}`);
  }
  const [lightness, chroma, hue] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const luminance = (colour: string): number => {
  const [r, g, b] = linearRgb(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2.2's contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const surfaces = ["background", "card", "muted"];

/** [foreground, background, minimum]. */
const pairs: [string, string, number][] = [
  ...surfaces.map((surface): [string, string, number] => [
    "foreground",
    surface,
    4.5,
  ]),
  ...surfaces.map((surface): [string, string, number] => [
    "muted-foreground",
    surface,
    4.5,
  ]),
  ...surfaces.map((surface): [string, string, number] => ["input", surface, 3]),
  ...surfaces.map((surface): [string, string, number] => [
    "focus-ring",
    surface,
    3,
  ]),
  // Links in the policies' dialogs are in the focus colour.
  ["focus-ring", "card", 4.5],
  // Buttons.
  ["primary-foreground", "primary", 4.5],
  ["secondary-foreground", "secondary", 4.5],
  ["destructive-foreground", "destructive", 4.5],
  // The current page in the navigation, and ghost buttons on hover.
  ["foreground", "accent", 4.5],
  ["accent-foreground", "accent", 4.5],
  ["destructive", "background", 4.5],
  ["destructive", "card", 4.5],
  ["foreground", "success-soft", 4.5],
  // Menus and autocomplete lists.
  ["popover-foreground", "popover", 4.5],
  ["muted-foreground", "popover", 4.5],
  // Badges and callouts, each tone's ink on its fill.
  ...[
    "neutral",
    "info",
    "success",
    "warning",
    "danger",
    "violet",
    "indigo",
  ].map((tone): [string, string, number] => [
    `tone-${tone}-foreground`,
    `tone-${tone}`,
    4.5,
  ]),
  ["success", "success-soft", 3],
  // A Grilling Session's paper (grilling.tsx): the success tone, with muted
  // text and the page's own text on it too.
  ["muted-foreground", "tone-success", 4.5],
  ["foreground", "tone-success", 4.5],
];

const modes = [
  {
    mode: "light",
    base: [":root"],
    themed: (id: string) => `:root[data-theme="${id}"]`,
  },
  {
    mode: "dark",
    base: [":root", ".dark"],
    themed: (id: string) => `:root.dark[data-theme="${id}"]`,
  },
] as const;

const cases = themes.flatMap(({ id }) =>
  modes.map(({ mode, base, themed }) => ({
    name: `${id} ${mode}`,
    tokens: {
      ...Object.assign({}, ...base.map(tokens)),
      ...(id === "neutral" ? {} : tokens(themed(id))),
    } as Record<string, string>,
  })),
);

describe.each(cases)("the $name theme", ({ tokens: theme }) => {
  it.each(pairs)("%s on %s is at least %s:1", (foreground, background, min) => {
    const [fg, bg] = [theme[foreground], theme[background]];
    if (fg === undefined || bg === undefined) {
      throw new Error(`Missing --${foreground} or --${background}`);
    }
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

it("checks a known pair right", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
  expect(contrast("oklch(1 0 0)", "#ffffff")).toBeCloseTo(1);
});
