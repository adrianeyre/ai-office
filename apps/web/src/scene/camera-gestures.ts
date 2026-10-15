import type { CameraPose, Vec3 } from "./camera-rig.ts";

// Touch gestures on the camera (PRD §7: tablets are fully usable), as pure
// functions of a pose, so they are tested without a browser: one finger
// drags the camera around the point it looks at, two fingers pinch it
// closer or further and drag it across the Floor. `touch-camera.ts` feeds
// them the fingers' moves.

/** A finger on the screen, in CSS pixels. */
export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/** What a gesture needs of the screen: its height, and the camera's field of view. */
export interface GestureScreen {
  /** The canvas's height, in CSS pixels. */
  readonly height: number;
  /** The camera's vertical field of view, in degrees. */
  readonly fov: number;
}

/**
 * How far the camera may turn and move by hand: from straight down to
 * 80° from it (so it never looks up from under the Floor), from 1 m to
 * 60 m from what it looks at, and that point at most 30 m from the
 * Office's centre.
 */
export const gestureLimits = {
  minPolar: 0.01,
  maxPolar: (80 * Math.PI) / 180,
  minDistance: 1,
  maxDistance: 60,
  maxPan: 30,
} as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface Spherical {
  readonly radius: number;
  /** Around the vertical, from +z towards +x. */
  readonly azimuth: number;
  /** Down from straight overhead. */
  readonly polar: number;
}

function sphericalOf(offset: Vec3): Spherical {
  const radius = Math.hypot(...offset);
  return {
    radius,
    azimuth: Math.atan2(offset[0], offset[2]),
    polar: radius === 0 ? 0 : Math.acos(clamp(offset[1] / radius, -1, 1)),
  };
}

function offsetOf({ radius, azimuth, polar }: Spherical): Vec3 {
  return [
    radius * Math.sin(polar) * Math.sin(azimuth),
    radius * Math.cos(polar),
    radius * Math.sin(polar) * Math.cos(azimuth),
  ];
}

const offsetFrom = ({ position, target }: CameraPose): Vec3 => [
  position[0] - target[0],
  position[1] - target[1],
  position[2] - target[2],
];

const at = (target: Vec3, offset: Vec3): CameraPose => ({
  position: [
    target[0] + offset[0],
    target[1] + offset[1],
    target[2] + offset[2],
  ],
  target,
});

/**
 * One finger dragging: the camera turns around what it looks at, with the
 * scene following the finger. Dragging the screen's height turns it half
 * a turn.
 */
export function orbit(
  pose: CameraPose,
  dx: number,
  dy: number,
  { height }: Pick<GestureScreen, "height">,
): CameraPose {
  const { radius, azimuth, polar } = sphericalOf(offsetFrom(pose));
  const perPixel = Math.PI / Math.max(1, height);
  return at(
    pose.target,
    offsetOf({
      radius,
      azimuth: azimuth - dx * perPixel,
      polar: clamp(
        polar - dy * perPixel,
        gestureLimits.minPolar,
        gestureLimits.maxPolar,
      ),
    }),
  );
}

/**
 * A pinch: fingers spreading by `factor` (2 for twice as far apart) bring
 * the camera that many times closer to what it looks at.
 */
export function dolly(pose: CameraPose, factor: number): CameraPose {
  const offset = offsetFrom(pose);
  const spherical = sphericalOf(offset);
  if (spherical.radius === 0 || !(factor > 0)) {
    return pose;
  }
  const radius = clamp(
    spherical.radius / factor,
    gestureLimits.minDistance,
    gestureLimits.maxDistance,
  );
  const scale = radius / spherical.radius;
  return at(pose.target, [
    offset[0] * scale,
    offset[1] * scale,
    offset[2] * scale,
  ]);
}

/**
 * Two fingers dragging: the camera slides across the Floor, keeping its
 * height and angle, so the scene under the fingers follows them, at the
 * distance of what it looks at.
 */
export function pan(
  pose: CameraPose,
  dx: number,
  dy: number,
  { height, fov }: GestureScreen,
): CameraPose {
  const offset = offsetFrom(pose);
  const radius = Math.hypot(...offset);
  const perPixel =
    (2 * radius * Math.tan((fov * Math.PI) / 360)) / Math.max(1, height);
  // Along the ground, away from the camera, and to its right.
  const ground = Math.hypot(offset[0], offset[2]);
  const [forwardX, forwardZ] =
    ground < 1e-9 ? [0, -1] : [-offset[0] / ground, -offset[2] / ground];
  const [rightX, rightZ] = [-forwardZ, forwardX];
  const limit = gestureLimits.maxPan;
  const target: Vec3 = [
    clamp(
      pose.target[0] + (forwardX * dy - rightX * dx) * perPixel,
      -limit,
      limit,
    ),
    pose.target[1],
    clamp(
      pose.target[2] + (forwardZ * dy - rightZ * dx) * perPixel,
      -limit,
      limit,
    ),
  ];
  return at(target, offset);
}

const midpoint = (a: TouchPoint, b: TouchPoint): TouchPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const spread = (a: TouchPoint, b: TouchPoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The pose after the fingers move from `before` to `after` (the same
 * fingers, in the same order): one finger orbits; two pinch and pan, by
 * the first two. Anything else leaves the camera where it is.
 */
export function gesturePose(
  pose: CameraPose,
  before: readonly TouchPoint[],
  after: readonly TouchPoint[],
  screen: GestureScreen,
): CameraPose {
  const [first, second] = before;
  const [firstNow, secondNow] = after;
  if (first === undefined || firstNow === undefined) {
    return pose;
  }
  if (second === undefined || secondNow === undefined) {
    return orbit(pose, firstNow.x - first.x, firstNow.y - first.y, screen);
  }
  const from = spread(first, second);
  const to = spread(firstNow, secondNow);
  const pinched = from > 0 && to > 0 ? dolly(pose, to / from) : pose;
  const middle = midpoint(first, second);
  const middleNow = midpoint(firstNow, secondNow);
  return pan(pinched, middleNow.x - middle.x, middleNow.y - middle.y, screen);
}
