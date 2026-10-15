import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { destination, isMoving, type CameraPose } from "./camera-rig.ts";
import {
  defaultView,
  handView,
  officeViews,
  resetCamera,
  useCameraStore,
} from "./camera-store.ts";
import {
  prefersReducedMotion,
  resetSceneSettings,
  useSceneSettings,
} from "./scene-settings.ts";
import { floorInspectables, inspectableViewName } from "./inspectable.ts";
import { closeInspectable, inspected, openInspectable } from "./inspection.ts";
import { resetSelection, useSelectionStore } from "./selection-store.ts";

describe("the camera store", () => {
  beforeEach(() => {
    resetCamera();
  });

  it("starts at rest at the overview", () => {
    const { rig } = useCameraStore.getState();
    expect(defaultView).toBe("overview");
    expect(rig.view).toBe("overview");
    expect(rig.pose).toEqual(officeViews.overview);
    expect(isMoving(rig)).toBe(false);
  });

  it("flies to a named view over frames, and to one registered later", () => {
    const camera = useCameraStore.getState();
    camera.flyTo("plan");
    expect(destination(useCameraStore.getState().rig)).toBe("plan");
    for (let frame = 0; frame < 300; frame += 1) {
      camera.advance(1 / 60, false);
    }
    expect(useCameraStore.getState().rig.view).toBe("plan");
    expect(useCameraStore.getState().rig.pose).toEqual(officeViews.plan);

    const desk = { position: [3, 2, 3], target: [3, 0.8, 0] } as const;
    camera.registerView("desk:ada", desk);
    camera.queueView("overview");
    camera.queueView("desk:ada");
    camera.advance(60, false);
    expect(useCameraStore.getState().rig.pose).toEqual(desk);
  });

  it("cuts to the view with reduced motion", () => {
    const camera = useCameraStore.getState();
    camera.flyTo("close");
    camera.advance(1 / 60, true);
    expect(useCameraStore.getState().rig.view).toBe("close");
    expect(isMoving(useCameraStore.getState().rig)).toBe(false);
  });

  it("refuses a view it does not know", () => {
    expect(() => {
      useCameraStore.getState().flyTo("nowhere");
    }).toThrow('There is no camera view named "nowhere".');
  });

  it("notifies no one while the camera is at rest", () => {
    let notified = 0;
    const unsubscribe = useCameraStore.subscribe(() => {
      notified += 1;
    });
    useCameraStore.getState().advance(1 / 60, false);
    useCameraStore.getState().flyTo("overview");
    unsubscribe();
    expect(notified).toBe(0);
  });
});

describe("the selection store", () => {
  beforeEach(() => {
    resetSelection();
  });

  it("selects, hovers and clears, and changes nothing for the same selection", () => {
    const store = useSelectionStore;
    const ada = { kind: "agent", id: "ada" } as const;
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    store.getState().select(ada);
    store.getState().select({ kind: "agent", id: "ada" });
    expect(store.getState().selected).toBe(ada);
    expect(notified).toBe(1);

    store.getState().hover({ kind: "monitor", id: "ada" });
    store.getState().hover({ kind: "monitor", id: "ada" });
    expect(store.getState().hovered).toEqual({ kind: "monitor", id: "ada" });
    expect(notified).toBe(2);

    store.getState().select({ kind: "monitor", id: "ada" });
    expect(store.getState().selected).toEqual({ kind: "monitor", id: "ada" });

    store.getState().clearSelection();
    store.getState().clearSelection();
    store.getState().hover(undefined);
    expect(store.getState().selected).toBeUndefined();
    expect(store.getState().hovered).toBeUndefined();
    expect(notified).toBe(5);
    unsubscribe();
  });
});

describe("opening an inspectable object", () => {
  const [whiteboard, , bookshelf, , monitor, agent] = floorInspectables(
    "web-shop",
    [{ id: "ada", name: "Ada", role: "manager" }],
  );

  beforeEach(() => {
    resetCamera();
    resetSelection();
  });

  /** Where the camera will rest. */
  const headingTo = () => destination(useCameraStore.getState().rig);

  it("selects it, and flies the camera in to its own view", () => {
    const ada = monitor ?? fail();
    openInspectable(ada);
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "monitor",
      id: "ada",
    });
    expect(inspected()).toEqual({ kind: "monitor", id: "ada" });
    expect(headingTo()).toBe("inspect:monitor:ada");
    expect(useCameraStore.getState().views[inspectableViewName(ada)]).toBe(
      ada.view,
    );
    useCameraStore.getState().advance(60, false);
    expect(useCameraStore.getState().rig.pose).toEqual(ada.view);
  });

  it("flies back to where the camera was when it closes", () => {
    useCameraStore.getState().flyTo("plan");
    openInspectable(whiteboard ?? fail());
    closeInspectable();
    expect(useSelectionStore.getState().selected).toBeUndefined();
    expect(headingTo()).toBe("plan");
  });

  it("flies back to where fingers left the camera, once moved by touch", () => {
    const byHand = {
      position: [3, 9, 12],
      target: [2, 0, -1],
    } as const satisfies CameraPose;
    useCameraStore.getState().placeByHand(byHand);
    openInspectable(whiteboard ?? fail());
    useCameraStore.getState().advance(60, false);
    closeInspectable();
    expect(headingTo()).toBe(handView);
    useCameraStore.getState().advance(60, false);
    expect(useCameraStore.getState().rig.pose).toEqual(byHand);
  });

  it("goes back to where it was before the first, when one opens another", () => {
    useCameraStore.getState().flyTo("close");
    openInspectable(whiteboard ?? fail());
    useCameraStore.getState().advance(60, false);
    openInspectable(bookshelf ?? fail());
    expect(headingTo()).toBe("inspect:bookshelf:web-shop");
    expect(useSelectionStore.getState().returnView).toBe("close");
    closeInspectable();
    expect(headingTo()).toBe("close");
  });

  it("leaves the camera where it is when told not to fly back, and does nothing with nothing open", () => {
    openInspectable(whiteboard ?? fail());
    closeInspectable({ flyBack: false });
    expect(inspected()).toBeUndefined();
    expect(headingTo()).toBe("inspect:whiteboard:web-shop");

    // With nothing open, closing does nothing.
    closeInspectable();
    expect(useSelectionStore.getState().selected).toBeUndefined();
    expect(headingTo()).toBe("inspect:whiteboard:web-shop");
  });

  it("opens and closes an Agent as it does any object (its Avatar Editor)", () => {
    openInspectable(agent ?? fail());
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "agent",
      id: "ada",
    });
    expect(headingTo()).toBe("inspect:agent:ada");
    closeInspectable();
    expect(inspected()).toBeUndefined();
    expect(headingTo()).toBe(defaultView);
  });
});

function fail(): never {
  throw new Error("The Floor is missing an object.");
}

describe("the scene settings", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSceneSettings();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("start on Medium, with the FPS overlay off and the displays above the Agents' heads on", () => {
    const settings = useSceneSettings.getState();
    expect(settings.quality).toBe("medium");
    expect(settings.showFps).toBe(false);
    expect(settings.showAboveHead).toBe(true);
  });

  it("start with reduced motion as the browser asks for it", () => {
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(
      prefersReducedMotion((query) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
      })),
    ).toBe(true);
    expect(prefersReducedMotion(() => ({ matches: false }))).toBe(false);
  });

  it("are kept in this browser's local storage", () => {
    const settings = useSceneSettings.getState();
    settings.setQuality("high");
    settings.setReducedMotion(true);
    settings.setShowFps(true);
    settings.setShowAboveHead(false);
    expect(
      JSON.parse(localStorage.getItem("ai-office:scene-settings") ?? "{}"),
    ).toMatchObject({
      state: {
        quality: "high",
        reducedMotion: true,
        showFps: true,
        showAboveHead: false,
      },
    });
  });

  it("read back what was stored, and drop what this version does not know", async () => {
    localStorage.setItem(
      "ai-office:scene-settings",
      JSON.stringify({
        state: {
          quality: "ultra",
          reducedMotion: true,
          showFps: "yes",
          showAboveHead: "no",
        },
        version: 0,
      }),
    );
    await useSceneSettings.persist.rehydrate();
    const settings = useSceneSettings.getState();
    expect(settings.quality).toBe("medium");
    expect(settings.reducedMotion).toBe(true);
    expect(settings.showFps).toBe(false);
    expect(settings.showAboveHead).toBe(true);

    localStorage.setItem(
      "ai-office:scene-settings",
      JSON.stringify({ state: { quality: "low" }, version: 0 }),
    );
    await useSceneSettings.persist.rehydrate();
    expect(useSceneSettings.getState().quality).toBe("low");
  });
});
