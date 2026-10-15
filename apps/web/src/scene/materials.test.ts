import { readFileSync } from "node:fs";
import { join } from "node:path";

import { palette } from "@ai-office/shared/palette";
import { Color } from "three";
import { describe, expect, it } from "vitest";

import {
  emissiveIntensity,
  glassOpacity,
  material,
  surfaces,
  type Surface,
} from "./materials.ts";

// The shared materials against docs/reference/art-direction.md's Materials.

const spec = readFileSync(
  join(import.meta.dirname, "../../../../docs/reference/art-direction.md"),
  "utf8",
);

/** The Metalness and Roughness cells of the spec's row for `surface`. */
function finishRow(surface: string): [string, string] {
  const line = spec
    .split("\n")
    .find((candidate) => candidate.startsWith(`  | ${surface} |`));
  if (line === undefined) {
    throw new Error(`The art direction spec has no "${surface}" row.`);
  }
  const [metalness = "", roughness = ""] = line
    .split("|")
    .slice(2, -1)
    .map((cell) => cell.trim());
  return [metalness, roughness];
}

/** "0.85 to 0.95" or "0.2, with…" as the range it allows. */
function range(cell: string): [number, number] {
  const numbers = [...cell.matchAll(/\d+(?:\.\d+)?/g)].map(([n]) => Number(n));
  const [low = Number.NaN, high] = numbers;
  return cell.includes(" to ") && high !== undefined ? [low, high] : [low, low];
}

/** Each surface, and the row of the spec's table it follows. */
const rows: Record<Surface, string> = {
  paint: "Paint, plaster, ceilings",
  wood: "Wood",
  fabric: "Fabric, carpet",
  plastic: "Plastic, ceramic",
  metal: "Metal",
  screen: "Screens",
  lamp: "Plastic, ceramic",
  glass: "Glass",
};

describe("the shared materials", () => {
  it.each(Object.keys(rows) as Surface[])(
    "give %s the metalness and roughness of its row in the spec",
    (surface) => {
      const [metalness, roughness] = finishRow(rows[surface]);
      const [low, high] = range(roughness);
      expect(surfaces[surface].metalness).toBe(Number(metalness));
      expect(surfaces[surface].roughness).toBeGreaterThanOrEqual(low);
      expect(surfaces[surface].roughness).toBeLessThanOrEqual(high);
    },
  );

  it("are binary in metalness, and none shinier than 0.3 but glass and screens", () => {
    for (const [surface, { metalness, roughness }] of Object.entries(
      surfaces,
    )) {
      expect([0, 1]).toContain(metalness);
      if (surface !== "glass" && surface !== "screen") {
        expect(roughness).toBeGreaterThanOrEqual(0.3);
      }
    }
  });

  it("are made once for each token and surface, and named for them", () => {
    const desk = material("desk-top", "wood");
    expect(material("desk-top", "wood")).toBe(desk);
    expect(desk.name).toBe("desk-top/wood");
    expect(desk.color.equals(new Color(palette["desk-top"]))).toBe(true);
    expect(material("desk-top", "paint")).not.toBe(desk);
  });

  it("make only screens and lamps glow, in their own token", () => {
    expect(material("wall", "paint").emissive.getHex()).toBe(0);
    const lamp = material("lamp", "lamp");
    expect(lamp.emissive.equals(new Color(palette.lamp))).toBe(true);
    const screen = material("screen-glow", "screen");
    expect(screen.emissive.equals(new Color(palette["screen-glow"]))).toBe(
      true,
    );
    // The spec's 1.2 to 2.0.
    for (const intensity of Object.values(emissiveIntensity)) {
      expect(intensity).toBeGreaterThanOrEqual(1.2);
      expect(intensity).toBeLessThanOrEqual(2);
    }
  });

  it("make glass the only see-through one, at 25% opacity", () => {
    const glass = material("glass", "glass");
    expect(glass.transparent).toBe(true);
    expect(glass.opacity).toBe(glassOpacity);
    expect(finishRow("Glass")[1]).toContain("25% opacity");
    expect(glassOpacity).toBe(0.25);
    expect(material("wall", "paint").transparent).toBe(false);
  });
});
