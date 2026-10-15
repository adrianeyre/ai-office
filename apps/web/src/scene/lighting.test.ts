import { describe, expect, it } from "vitest";

import type { Vec3 } from "./camera-rig.ts";
import { officeViews } from "./camera-store.ts";
import { lightPositions, viewBearing } from "./lighting.ts";

const degrees = (radians: number) => (radians * 180) / Math.PI;

/** A light's elevation above the horizon, seen from the origin. */
const elevation = ([x, y, z]: Vec3) => degrees(Math.atan2(y, Math.hypot(x, z)));

describe("the lights' positions", () => {
  it("put the key light 50° up and 35° to the left of the default view, and the fill opposite it, 25° up", () => {
    const view = officeViews.overview;
    const { key, fill } = lightPositions(view);
    expect(elevation(key)).toBeCloseTo(50);
    expect(elevation(fill)).toBeCloseTo(25);

    const bearing = (position: Vec3) =>
      viewBearing({ position, target: [0, 0, 0] });
    expect(bearing(key)).toBeCloseTo(viewBearing(view) - 35);
    expect((bearing(fill) - bearing(key) + 360) % 360).toBeCloseTo(180);

    // Left as the camera sees it: the key light is on the camera's left.
    const forward = [-view.position[0], 0, -view.position[2]] as const;
    const right = [-forward[2], 0, forward[0]] as const;
    expect(key[0] * right[0] + key[2] * right[2]).toBeLessThan(0);
  });

  it("measure a view's bearing from +Z towards +X", () => {
    expect(viewBearing({ position: [0, 5, 10], target: [0, 0, 0] })).toBe(0);
    expect(viewBearing({ position: [10, 5, 0], target: [0, 0, 0] })).toBe(90);
    expect(viewBearing({ position: [12, 5, 3], target: [2, 0, 3] })).toBe(90);
  });
});
