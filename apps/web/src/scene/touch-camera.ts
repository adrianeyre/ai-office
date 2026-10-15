import { gesturePose, type TouchPoint } from "./camera-gestures.ts";
import { useCameraStore } from "./camera-store.ts";

// The camera by touch, on a tablet (PRD §7): one finger turns it around
// what it looks at, two pinch it closer or further and slide it across the
// Floor (camera-gestures.ts). Only fingers count, so a mouse and a pen
// work as before. A touch that moves less than `tapSlop` is a tap, which
// picks what is under it as a click does; once it moves further it is a
// gesture, and lifting it is not a tap.

/** How far, in CSS pixels, a finger may move and still tap. */
export const tapSlop = 8;

export interface TouchCameraOptions {
  /** The camera's vertical field of view, in degrees. */
  readonly fov: number;
  /** Whether gestures move the camera now: not while the lift has it. */
  readonly enabled: () => boolean;
}

/**
 * Moves the camera as fingers drag, pinch and slide on `element` (the
 * Office's canvas). Returns what stops it.
 */
export function attachTouchCamera(
  element: HTMLElement,
  { fov, enabled }: TouchCameraOptions,
): () => void {
  /** Each finger down, where it was last. */
  const fingers = new Map<number, TouchPoint>();
  /** How far the fingers have moved since the first went down. */
  let travelled = 0;

  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    if (fingers.size === 0) {
      travelled = 0;
    }
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  const onMove = (event: PointerEvent) => {
    const last = fingers.get(event.pointerId);
    if (last === undefined) {
      return;
    }
    const ids = [...fingers.keys()];
    const before = ids.flatMap((id) => fingers.get(id) ?? []);
    const now = { x: event.clientX, y: event.clientY };
    fingers.set(event.pointerId, now);
    travelled += Math.hypot(now.x - last.x, now.y - last.y);
    if (travelled < tapSlop || !enabled()) {
      return;
    }
    const after = ids.flatMap((id) => fingers.get(id) ?? []);
    const camera = useCameraStore.getState();
    camera.placeByHand(
      gesturePose(camera.rig.pose, before, after, {
        height: element.clientHeight,
        fov,
      }),
    );
  };

  const onUp = (event: PointerEvent) => {
    fingers.delete(event.pointerId);
  };

  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointercancel", onUp);
  return () => {
    element.removeEventListener("pointerdown", onDown);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", onUp);
    element.removeEventListener("pointercancel", onUp);
  };
}
