import { dolly, orbit, pan } from "./camera-gestures.ts";
import { useCameraStore } from "./camera-store.ts";
import { tapSlop } from "./touch-camera.ts";

// The camera by mouse, on a desktop: dragging with the main button turns
// it around what it looks at (left and right) and tilts it (up and down);
// dragging with the right or middle button, or with Shift held, slides it
// across the Floor; the scroll wheel zooms it closer or further. The
// moves are touch's own (camera-gestures.ts). A press that moves less than
// `tapSlop` is still a click, so the Office's hotspots open as before.

/** How much one wheel pixel zooms: 100 px (a notch) is about 16%. */
export const wheelZoomPerPixel = 0.0015;

/** A wheel's lines and pages, in pixels, as browsers scroll them. */
const wheelPixels = (event: WheelEvent, height: number): number =>
  event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaY * 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * height
      : event.deltaY;

export interface MouseCameraOptions {
  /** The camera's vertical field of view, in degrees. */
  readonly fov: number;
  /** Whether the mouse moves the camera now: not while the lift has it. */
  readonly enabled: () => boolean;
}

/**
 * Moves the camera as the mouse drags and scrolls on `element` (the
 * Office's canvas). Returns what stops it.
 */
export function attachMouseCamera(
  element: HTMLElement,
  { fov, enabled }: MouseCameraOptions,
): () => void {
  /** The press under way: where it was last, and whether it pans. */
  let press:
    | { id: number; x: number; y: number; panning: boolean; travelled: number }
    | undefined;

  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || press !== undefined) {
      return;
    }
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panning: event.button !== 0 || event.shiftKey,
      travelled: 0,
    };
    // Keep the drag going past the canvas's edge, where capture is had.
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Without it, the drag stops at the edge.
    }
  };

  const onMove = (event: PointerEvent) => {
    if (press?.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    press.x = event.clientX;
    press.y = event.clientY;
    press.travelled += Math.hypot(dx, dy);
    if (press.travelled < tapSlop || !enabled()) {
      return;
    }
    const camera = useCameraStore.getState();
    const screen = { height: element.clientHeight, fov };
    camera.placeByHand(
      press.panning
        ? pan(camera.rig.pose, dx, dy, screen)
        : orbit(camera.rig.pose, dx, dy, screen),
    );
  };

  const onUp = (event: PointerEvent) => {
    if (press?.id === event.pointerId) {
      press = undefined;
      try {
        element.releasePointerCapture(event.pointerId);
      } catch {
        // It was never captured.
      }
    }
  };

  const onWheel = (event: WheelEvent) => {
    // The page does not scroll under the Office.
    event.preventDefault();
    if (!enabled()) {
      return;
    }
    const pixels = wheelPixels(event, element.clientHeight);
    if (pixels === 0) {
      return;
    }
    const camera = useCameraStore.getState();
    camera.placeByHand(
      dolly(camera.rig.pose, Math.exp(-pixels * wheelZoomPerPixel)),
    );
  };

  // A right-button drag pans, so it opens no menu.
  const onContextMenu = (event: Event) => {
    event.preventDefault();
  };

  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointercancel", onUp);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("contextmenu", onContextMenu);
  return () => {
    element.removeEventListener("pointerdown", onDown);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", onUp);
    element.removeEventListener("pointercancel", onUp);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("contextmenu", onContextMenu);
  };
}
