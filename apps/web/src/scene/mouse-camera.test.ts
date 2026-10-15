import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dolly, orbit, pan } from "./camera-gestures.ts";
import { destination } from "./camera-rig.ts";
import {
  handView,
  officeViews,
  resetCamera,
  useCameraStore,
} from "./camera-store.ts";
import { attachMouseCamera, wheelZoomPerPixel } from "./mouse-camera.ts";

const screen = { height: 600, fov: 35 };

/** A pointer event, as jsdom may lack PointerEvent. */
function pointer(
  type: string,
  {
    kind = "mouse",
    button = 0,
    shiftKey = false,
    x,
    y,
  }: {
    kind?: string;
    button?: number;
    shiftKey?: boolean;
    x: number;
    y: number;
  },
): Event {
  const event = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button,
    shiftKey,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: kind },
  });
  return event;
}

const wheel = (deltaY: number) =>
  new WheelEvent("wheel", { deltaY, cancelable: true });

let element: HTMLElement;
let enabled: boolean;
let detach: () => void;

beforeEach(() => {
  resetCamera();
  element = document.createElement("canvas");
  Object.defineProperty(element, "clientHeight", { value: screen.height });
  enabled = true;
  detach = attachMouseCamera(element, {
    fov: screen.fov,
    enabled: () => enabled,
  });
});

afterEach(() => {
  detach();
});

const pose = () => useCameraStore.getState().rig.pose;
const start = officeViews.overview;

/** A drag from (100, 100) by (dx, dy), past the click slop in one move. */
function drag(
  dx: number,
  dy: number,
  options: { button?: number; shiftKey?: boolean } = {},
) {
  element.dispatchEvent(pointer("pointerdown", { x: 100, y: 100, ...options }));
  element.dispatchEvent(pointer("pointermove", { x: 100 + dx, y: 100 + dy }));
  element.dispatchEvent(pointer("pointerup", { x: 100 + dx, y: 100 + dy }));
}

describe("the camera by mouse", () => {
  it("turns and tilts as the main button drags, and rests where it is left", () => {
    drag(40, 30);
    expect(pose()).toEqual(orbit(start, 40, 30, screen));
    expect(destination(useCameraStore.getState().rig)).toBe(handView);
  });

  it("pans as the right button, or Shift, drags", () => {
    drag(40, 30, { button: 2 });
    const once = pan(start, 40, 30, screen);
    expect(pose()).toEqual(once);
    drag(-20, 10, { shiftKey: true });
    expect(pose()).toEqual(pan(once, -20, 10, screen));
  });

  it("zooms in as the wheel scrolls up and out as it scrolls down, not scrolling the page", () => {
    const up = wheel(-100);
    element.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    const closer = dolly(start, Math.exp(100 * wheelZoomPerPixel));
    expect(pose()).toEqual(closer);
    element.dispatchEvent(wheel(100));
    expect(pose()).toEqual(dolly(closer, Math.exp(-100 * wheelZoomPerPixel)));
  });

  it("leaves a click a click, and ignores touch, and the lift's ride", () => {
    element.dispatchEvent(pointer("pointerdown", { x: 100, y: 100 }));
    element.dispatchEvent(pointer("pointermove", { x: 103, y: 102 }));
    element.dispatchEvent(pointer("pointerup", { x: 103, y: 102 }));
    expect(pose()).toEqual(start);

    element.dispatchEvent(
      pointer("pointerdown", { kind: "touch", x: 100, y: 100 }),
    );
    element.dispatchEvent(
      pointer("pointermove", { kind: "touch", x: 160, y: 100 }),
    );
    element.dispatchEvent(
      pointer("pointerup", { kind: "touch", x: 160, y: 100 }),
    );
    expect(pose()).toEqual(start);

    enabled = false;
    drag(40, 30);
    element.dispatchEvent(wheel(-100));
    expect(pose()).toEqual(start);
  });

  it("stops when detached", () => {
    detach();
    drag(40, 30);
    element.dispatchEvent(wheel(-100));
    expect(pose()).toEqual(start);
  });
});
