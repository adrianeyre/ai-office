import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  palette,
  paletteForegrounds,
  paletteTokens,
  type PaletteToken,
} from "./index.ts";

// WCAG 2.2's relative luminance and contrast ratio, for sRGB hex colours.
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

describe("palette", () => {
  it("names each token in kebab case, with a six-digit sRGB hex value", () => {
    expect(paletteTokens.length).toBeGreaterThan(0);
    for (const token of paletteTokens) {
      expect(token).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(palette[token]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("has no pure black or white: ink and paper are the extremes", () => {
    const values: string[] = Object.values(palette);
    expect(values).not.toContain("#000000");
    expect(values).not.toContain("#ffffff");
    for (const token of paletteTokens) {
      const value = luminance(palette[token]);
      expect(value).toBeGreaterThanOrEqual(luminance(palette.ink));
      expect(value).toBeLessThanOrEqual(luminance(palette.paper));
    }
  });

  it("gives every Stage and every state a foreground", () => {
    const labelled = paletteTokens.filter((token) =>
      /^(stage|state)-/.test(token),
    );
    expect(labelled).toHaveLength(9);
    for (const token of labelled) {
      expect(paletteForegrounds).toHaveProperty(token);
    }
  });

  it("has each foreground at 4.5:1 or more on its colour", () => {
    for (const [token, foreground] of Object.entries(paletteForegrounds)) {
      const ratio = contrast(
        palette[token as PaletteToken],
        palette[foreground],
      );
      expect(ratio, `${foreground} on ${token}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("matches the palette tables of docs/reference/art-direction.md", async () => {
    const spec = await readFile(
      new URL("../../../docs/reference/art-direction.md", import.meta.url),
      "utf8",
    );
    // | `token` | `#value` | `foreground` or — | Used for |
    const rows = [
      ...spec.matchAll(
        /^\| `([a-z-]+)` \| `(#[0-9a-f]{6})` \| (?:`([a-z-]+)`|—) \|/gm,
      ),
    ].map(([, token, value, foreground]) => ({ token, value, foreground }));

    expect(rows).toEqual(
      paletteTokens.map((token) => ({
        token,
        value: palette[token],
        foreground: (paletteForegrounds as Partial<Record<string, string>>)[
          token
        ],
      })),
    );
  });
});
