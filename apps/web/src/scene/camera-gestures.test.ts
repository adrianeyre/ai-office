import { describe, expect, it } from "vitest";

import {
  dolly,
  gestureLimits,
  gesturePose,
  orbit,
  pan,
  type GestureScreen,
} from "./camera-gestures.ts";
import type { CameraPose, Vec3 } from "./camera-rig.ts";
import { officeViews } from "./camera-store.ts";

const screen: GestureScreen = { height: 800, fov: 35 };

const distance = ({ position, target }: CameraPose) =>
  Math.hypot(
    position[0] - target[0],
    position[1] - target[1],
    position[2] - target[2],
  );

/** Degrees down from straight overhead. */
const polar = ({ position, target }: CameraPose) =>
  (Math.acos((position[1] - target[1]) / distance({ position, target })) *
    180) /
  Math.PI;

const expectClose = (actual: Vec3, expected: Vec3) => {
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 6);
  });
};

/** In front of the camera, along the ground: `z` falls as it goes. */
const front: CameraPose = { position: [0, 10, 10], target: [0, 0, 0] };

describe("one finger: orbit", () => {
  it("turns the camera around what it looks at, at the same distance", () => {
    const turned = orbit(officeViews.overview, 120, 40, screen);
    expect(turned.target).toEqual(officeViews.overview.target);
    expect(distance(turned)).toBeCloseTo(distance(officeViews.overview), 6);
    expect(turned.position).not.toEqual(officeViews.overview.position);
  });

  it("turns half a turn for a drag across the screen's height", () => {
    const turned = orbit(front, screen.height, 0, screen);
    expectClose(turned.position, [0, 10, -10]);
  });

  it("goes the other way for a drag the other way, and back again", () => {
    const there = orbit(front, 100, 30, screen);
    const back = orbit(there, -100, -30, screen);
    expectClose(back.position, front.position);
  });

  it("follows the finger: dragging right takes the camera left", () => {
    expect(orbit(front, 50, 0, screen).position[0]).toBeLessThan(0);
  });

  it("never goes past straight down, nor lower than 80° from it", () => {
    const top = orbit(front, 0, 10_000, screen);
    expect(polar(top)).toBeCloseTo((gestureLimits.minPolar * 180) / Math.PI, 6);
    const low = orbit(front, 0, -10_000, screen);
    expect(polar(low)).toBeCloseTo(80, 6);
    expect(low.position[1]).toBeGreaterThan(low.target[1]);
  });
});

describe("a pinch: dolly", () => {
  it("brings the camera closer as the fingers spread, along its line of sight", () => {
    const closer = dolly(front, 2);
    expect(distance(closer)).toBeCloseTo(distance(front) / 2, 6);
    expect(closer.target).toEqual(front.target);
    expectClose(closer.position, [0, 5, 5]);
  });

  it("takes it further as they close, within 1 m and 60 m", () => {
    expect(distance(dolly(front, 0.5))).toBeCloseTo(distance(front) * 2, 6);
    expect(distance(dolly(front, 1000))).toBeCloseTo(
      gestureLimits.minDistance,
      6,
    );
    expect(distance(dolly(front, 0.001))).toBeCloseTo(
      gestureLimits.maxDistance,
      6,
    );
  });

  it("leaves the camera where it is for no pinch at all", () => {
    expect(dolly(front, 0)).toBe(front);
  });
});

describe("two fingers dragging: pan", () => {
  it("slides the camera across the Floor, keeping its height and angle", () => {
    const slid = pan(front, 100, 0, screen);
    expect(slid.target[1]).toBe(front.target[1]);
    expect(slid.position[1]).toBe(front.position[1]);
    expect(slid.position[0] - slid.target[0]).toBeCloseTo(0, 6);
    expect(slid.position[2] - slid.target[2]).toBeCloseTo(10, 6);
  });

  it("follows the fingers: right takes the camera left, down takes it forwards", () => {
    expect(pan(front, 100, 0, screen).target[0]).toBeLessThan(0);
    expect(pan(front, 0, 100, screen).target[2]).toBeLessThan(0);
  });

  it("moves the scene under the fingers by as much as they move, at what it looks at", () => {
    // The screen's height spans 2·d·tan(fov/2) metres at distance d.
    const metres = 2 * distance(front) * Math.tan((35 * Math.PI) / 360);
    expect(pan(front, -screen.height, 0, screen).target[0]).toBeCloseTo(
      metres,
      6,
    );
  });

  it("works looking straight down, and stays within 30 m of the centre", () => {
    const plan = pan(officeViews.plan, 0, 100, screen);
    expect(plan.target[2]).toBeLessThan(0);
    const far = pan(front, -1e6, 1e6, screen);
    expect(far.target[0]).toBe(gestureLimits.maxPan);
    expect(far.target[2]).toBe(-gestureLimits.maxPan);
  });
});

describe("a gesture from fingers moving", () => {
  it("orbits for one finger", () => {
    expect(
      gesturePose(front, [{ x: 10, y: 10 }], [{ x: 60, y: 30 }], screen),
    ).toEqual(orbit(front, 50, 20, screen));
  });

  it("pinches and pans for two", () => {
    const moved = gesturePose(
      front,
      [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ],
      [
        { x: 80, y: 120 },
        { x: 280, y: 120 },
      ],
      screen,
    );
    expect(moved).toEqual(pan(dolly(front, 2), 30, 20, screen));
  });

  it("leaves the camera where it is with no finger", () => {
    expect(gesturePose(front, [], [], screen)).toBe(front);
  });
});
