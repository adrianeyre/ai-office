import type { Vec3 } from "./camera-rig.ts";

// Where the lights of docs/reference/art-direction.md ("Lighting") stand.
// The key light comes from 50° above the horizon, 35° to the left of the
// default view; the fill from opposite it, 25° above the horizon.

export const keyLight = { elevation: 50, leftOfView: 35, intensity: 2.4 };
export const fillLight = { elevation: 25, intensity: 0.6 };
export const ambientLight = { intensity: 0.8 };
export const environmentIntensity = 0.4;
export const shadowBias = { bias: -0.0005, normalBias: 0.02 };

/** How far from the target a directional light is placed; only its direction matters. */
const lightDistance = 30;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * The compass bearing (degrees, from +Z towards +X) at which a view sees
 * its target: the bearing from the target to the camera.
 */
export function viewBearing(view: { position: Vec3; target: Vec3 }): number {
  const x = view.position[0] - view.target[0];
  const z = view.position[2] - view.target[2];
  return (Math.atan2(x, z) * 180) / Math.PI;
}

/** A light's position at a bearing and elevation, `lightDistance` from `target`. */
export function lightPosition(
  target: Vec3,
  bearing: number,
  elevation: number,
): Vec3 {
  const horizontal = Math.cos(radians(elevation)) * lightDistance;
  return [
    target[0] + Math.sin(radians(bearing)) * horizontal,
    target[1] + Math.sin(radians(elevation)) * lightDistance,
    target[2] + Math.cos(radians(bearing)) * horizontal,
  ];
}

/**
 * The key and fill lights' positions for a default view. Seen from the
 * camera, a smaller bearing is to the left.
 */
export function lightPositions(view: { position: Vec3; target: Vec3 }): {
  key: Vec3;
  fill: Vec3;
} {
  const keyBearing = viewBearing(view) - keyLight.leftOfView;
  return {
    key: lightPosition(view.target, keyBearing, keyLight.elevation),
    fill: lightPosition(view.target, keyBearing + 180, fillLight.elevation),
  };
}
