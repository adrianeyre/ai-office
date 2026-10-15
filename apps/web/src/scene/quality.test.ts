import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canvasDpr,
  defaultQuality,
  isQualityLevel,
  qualityLevels,
  qualityPresets,
} from "./quality.ts";

// jsdom gives import.meta.url an http: address, so the path comes from dirname.
const spec = readFileSync(
  join(import.meta.dirname, "../../../../docs/reference/art-direction.md"),
  "utf8",
);

/** The cells after the first of the spec's table row that starts with `label`. */
function row(label: string): string[] {
  const line = spec
    .split("\n")
    .find((candidate) => candidate.startsWith(`| ${label} |`));
  if (line === undefined) {
    throw new Error(`The art direction spec has no "${label}" row.`);
  }
  return line
    .split("|")
    .slice(2, -1)
    .map((cell) => cell.trim());
}

/** A post-processing row's Low, Medium and High cells. */
const effectRow = (effect: string) => row(effect).slice(1);

const levelLabels = { low: "Low", medium: "Medium", high: "High" } as const;

describe("the quality presets", () => {
  it("are Low, Medium and High, starting on Medium", () => {
    expect(qualityLevels).toEqual(["low", "medium", "high"]);
    expect(qualityLevels.map((level) => qualityPresets[level].label)).toEqual([
      "Low",
      "Medium",
      "High",
    ]);
    expect(defaultQuality).toBe("medium");
    expect(isQualityLevel("high")).toBe(true);
    expect(isQualityLevel("ultra")).toBe(false);
    expect(isQualityLevel(undefined)).toBe(false);
  });

  it("cost more at each step up", () => {
    const [low, medium, high] = qualityLevels.map(
      (level) => qualityPresets[level],
    );
    expect(low?.shadows).toBeUndefined();
    expect(medium?.shadows?.mapSize).toBeLessThan(high?.shadows?.mapSize ?? 0);
    expect(low?.maxPixelRatio).toBeLessThan(medium?.maxPixelRatio ?? 0);
    expect(medium?.maxPixelRatio).toBeLessThan(high?.maxPixelRatio ?? 0);
    expect(low?.postProcessing.multisampling).toBe(0);
    expect(high?.postProcessing.multisampling).toBeGreaterThan(0);
  });

  it("give the canvas a pixel ratio from 1 to the preset's most", () => {
    expect(canvasDpr(qualityPresets.low)).toEqual([1, 1]);
    expect(canvasDpr(qualityPresets.medium)).toEqual([1, 1.5]);
    expect(canvasDpr(qualityPresets.high)).toEqual([1, 2]);
  });
});

describe("the quality presets match docs/reference/art-direction.md", () => {
  it.each(qualityLevels)("%s: shadows and contact shadows", (level) => {
    const preset = qualityPresets[level];
    const [shadows = "", softness = ""] = row(levelLabels[level]);
    const mapSize = /(\d+) × \1/.exec(shadows)?.[1];
    if (mapSize === undefined) {
      expect(shadows).toMatch(/^No real-time shadows/);
      expect(preset.shadows).toBeUndefined();
    } else {
      expect(preset.shadows).toEqual({
        mapSize: Number(mapSize),
        radius: Number(/`radius` (\d+)/.exec(softness)?.[1]),
      });
    }
    const contact = shadows.includes("contact shadows");
    expect(preset.contactShadows).toEqual({
      props: contact && shadows.includes("desk, chair"),
      agents: contact && shadows.includes("Agent"),
    });
  });

  it("post-processing: ambient occlusion, bloom, vignette and anti-aliasing", () => {
    const occlusion = effectRow("Ambient occlusion");
    const bloom = effectRow("Bloom");
    const vignette = effectRow("Vignette");
    const antiAliasing = effectRow("Anti-aliasing");
    qualityLevels.forEach((level, index) => {
      const effects = qualityPresets[level].postProcessing;
      const ao = occlusion[index] ?? "";
      expect(effects.ambientOcclusion).toBe(
        ao.startsWith("Off") ? "off" : ao.startsWith("Half") ? "half" : "full",
      );
      expect(effects.bloom).toBe(bloom[index] === "On");
      expect(effects.vignette).toBe(vignette[index] === "On");
      const aa = antiAliasing[index] ?? "";
      expect(effects.smaa).toBe(aa.startsWith("SMAA"));
      expect(effects.multisampling).toBe(
        Number(/`multisampling` (\d+)/.exec(aa)?.[1] ?? 0),
      );
    });
  });

  it("post-processing: tone mapping and colour grading at every setting", () => {
    // The presets have no switch for these: the scene always runs them.
    expect(effectRow("Tone mapping")).toEqual(["On", "On", "On"]);
    expect(effectRow("Colour grading")).toEqual(["On", "On", "On"]);
  });

  it("pixel ratio", () => {
    const ratios = row("Pixel ratio").map((cell) =>
      Number(/([\d.]+)$/.exec(cell)?.[1]),
    );
    expect(
      qualityLevels.map((level) => qualityPresets[level].maxPixelRatio),
    ).toEqual(ratios);
  });

  it("largest texture", () => {
    const sides = row("Largest texture").map((cell) =>
      Number(/^(\d+) × \1$/.exec(cell)?.[1]),
    );
    expect(
      qualityLevels.map((level) => qualityPresets[level].largestTexture),
    ).toEqual(sides);
  });
});
