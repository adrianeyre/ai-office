import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gesturePose } from "./camera-gestures.ts";
import { destination } from "./camera-rig.ts";
import {
  handView,
  officeViews,
  resetCamera,
  useCameraStore,
} from "./camera-store.ts";
import { attachTouchCamera, tapSlop } from "./touch-camera.ts";

const screen = { height: 600, fov: 35 };

/** A pointer event, as jsdom may lack PointerEvent. */
function pointer(
  type: string,
  {
    id = 1,
    kind = "touch",
    x,
    y,
  }: { id?: number; kind?: string; x: number; y: number },
): Event {
  const event = new MouseEvent(type, { clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: kind },
  });
  return event;
}

let element: HTMLElement;
let enabled: boolean;
let detach: () => void;

beforeEach(() => {
  resetCamera();
  element = document.createElement("canvas");
  Object.defineProperty(element, "clientHeight", { value: screen.height });
  enabled = true;
  detach = attachTouchCamera(element, {
    fov: screen.fov,
    enabled: () => enabled,
  });
});

afterEach(() => {
  detach();
});

const pose = () => useCameraStore.getState().rig.pose;

describe("the camera by touch", () => {
  it("turns as one finger drags, and rests where it is left", () => {
    element.dispatchEvent(pointer("pointerdown", { x: 100, y: 100 }));
    element.dispatchEvent(pointer("pointermove", { x: 120, y: 100 }));
    element.dispatchEvent(pointer("pointermove", { x: 170, y: 130 }));
    element.dispatchEvent(pointer("pointerup", { x: 170, y: 130 }));

    const expected = gesturePose(
      gesturePose(
        officeViews.overview,
        [{ x: 100, y: 100 }],
        [{ x: 120, y: 100 }],
        screen,
      ),
      [{ x: 120, y: 100 }],
      [{ x: 170, y: 130 }],
      screen,
    );
    expect(pose()).toEqual(expected);
    const { rig, views } = useCameraStore.getState();
    expect(rig.view).toBe(handView);
    expect(views[handView]).toEqual(expected);
  });

  it("pinches and pans with two fingers", () => {
    element.dispatchEvent(pointer("pointerdown", { id: 1, x: 100, y: 300 }));
    element.dispatchEvent(pointer("pointerdown", { id: 2, x: 300, y: 300 }));
    element.dispatchEvent(pointer("pointermove", { id: 2, x: 500, y: 300 }));
    expect(pose()).toEqual(
      gesturePose(
        officeViews.overview,
        [
          { x: 100, y: 300 },
          { x: 300, y: 300 },
        ],
        [
          { x: 100, y: 300 },
          { x: 500, y: 300 },
        ],
        screen,
      ),
    );
  });

  it("leaves a tap to pick what is under it", () => {
    element.dispatchEvent(pointer("pointerdown", { x: 100, y: 100 }));
    element.dispatchEvent(
      pointer("pointermove", { x: 100 + tapSlop - 1, y: 100 }),
    );
    element.dispatchEvent(pointer("pointerup", { x: 100, y: 100 }));
    expect(pose()).toEqual(officeViews.overview);
    expect(useCameraStore.getState().rig.view).toBe("overview");
  });

  it("leaves the mouse and the pen alone", () => {
    for (const kind of ["mouse", "pen"]) {
      element.dispatchEvent(pointer("pointerdown", { kind, x: 0, y: 0 }));
      element.dispatchEvent(pointer("pointermove", { kind, x: 200, y: 90 }));
      element.dispatchEvent(pointer("pointerup", { kind, x: 200, y: 90 }));
    }
    expect(pose()).toEqual(officeViews.overview);
  });

  it("does nothing while it is not enabled (the lift has the camera)", () => {
    enabled = false;
    element.dispatchEvent(pointer("pointerdown", { x: 0, y: 0 }));
    element.dispatchEvent(pointer("pointermove", { x: 200, y: 90 }));
    expect(pose()).toEqual(officeViews.overview);
  });

  it("drops a flight under way, and flies on from where the fingers left it", () => {
    useCameraStore.getState().flyTo("plan");
    element.dispatchEvent(pointer("pointerdown", { x: 0, y: 0 }));
    element.dispatchEvent(pointer("pointermove", { x: 0, y: 50 }));
    element.dispatchEvent(pointer("pointerup", { x: 0, y: 50 }));
    expect(destination(useCameraStore.getState().rig)).toBe(handView);

    useCameraStore.getState().flyTo("plan");
    useCameraStore.getState().advance(10, false);
    expect(pose()).toEqual(officeViews.plan);
  });

  it("stops once detached", () => {
    detach();
    element.dispatchEvent(pointer("pointerdown", { x: 0, y: 0 }));
    element.dispatchEvent(pointer("pointermove", { x: 200, y: 90 }));
    expect(pose()).toEqual(officeViews.overview);
  });
});
