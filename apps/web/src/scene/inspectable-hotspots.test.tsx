import ReactThreeTestRenderer from "@react-three/test-renderer";
import { LineSegments, Mesh, Raycaster, Vector3, type Object3D } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { destination } from "./camera-rig.ts";
import { resetCamera, useCameraStore } from "./camera-store.ts";
import {
  floorInspectables,
  lobbyInspectables,
  type InspectableObject,
} from "./inspectable.ts";
import {
  highlightMaterials,
  InspectableHotspots,
} from "./inspectable-hotspots.tsx";
import { resetLift } from "./lift-store.ts";
import { liftStops } from "./lift-stops.ts";
import { boardPreview } from "./notice-board-preview.ts";
import { OfficeLocationScene } from "./office-location.tsx";
import { resetSelection, useSelectionStore } from "./selection-store.ts";
import { tapSlop } from "./touch-camera.ts";

// The inspectable objects in React Three Fiber, rendered without WebGL by
// its test renderer: a box over each that the pointer picks it by, the
// highlight while it is pointed at (or focused in the keyboard list), and
// a click that opens its panel and flies the camera in.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const objects = floorInspectables("web-shop", [
  { id: "ada", name: "Ada", role: "manager" },
  { id: "bo", name: "Bo", role: "designer" },
]);

let renderer: Renderer | undefined;

async function renderHotspots(
  shown: readonly InspectableObject[] = objects,
): Promise<Renderer> {
  renderer = await ReactThreeTestRenderer.create(
    <InspectableHotspots objects={shown} />,
  );
  return renderer;
}

/** The test instance of an object's hotspot, and its three.js group. */
function hotspot(scene: Renderer, kind: string, id: string) {
  const name = `inspectable:${kind}:${id}`;
  const group = scene.scene.findByProps({ name });
  const hitArea = group.children.find(
    (child) => child.props["name"] === "hit-area",
  );
  if (hitArea === undefined) {
    throw new Error(`${name} has no hit area.`);
  }
  return { group: group.instance, hitArea };
}

/** The highlight drawn over an object, if any. */
const highlightOf = (group: Object3D) => ({
  veil: group.getObjectByName("highlight"),
  outline: group.getObjectByName("outline"),
});

beforeEach(() => {
  resetCamera();
  resetLift();
  resetSelection();
  document.body.style.cursor = "";
});

afterEach(async () => {
  await renderer?.unmount();
  renderer = undefined;
});

describe("the inspectable objects in the scene", () => {
  it("put a box over each object, picked by the pointer but never drawn", async () => {
    const scene = await renderHotspots();
    const groups = scene.scene.instance.getObjectByName("inspectables");
    expect(groups?.children.map(({ name }) => name)).toEqual([
      "inspectable:whiteboard:web-shop",
      "inspectable:wall-board:web-shop",
      "inspectable:bookshelf:web-shop",
      "inspectable:skills-bookshelf:web-shop",
      "inspectable:monitor:ada",
      "inspectable:monitor:bo",
      "inspectable:agent:ada",
      "inspectable:agent:bo",
    ]);
    for (const object of objects) {
      const { group, hitArea } = hotspot(scene, object.kind, object.id);
      expect(group.position.toArray()).toEqual([...object.box.centre]);
      expect(group.scale.toArray()).toEqual([...object.box.size]);
      const mesh = hitArea.instance as Mesh;
      // Not drawn, but three.js raycasts it all the same.
      expect(mesh.visible).toBe(true);
      expect(
        Array.isArray(mesh.material) ? undefined : mesh.material.visible,
      ).toBe(false);
      expect(highlightOf(group)).toEqual({
        veil: undefined,
        outline: undefined,
      });
    }
  });

  it("picks an object from a ray at its box", async () => {
    const scene = await renderHotspots();
    const { hitArea } = hotspot(scene, "monitor", "bo");
    const mesh = hitArea.instance as Mesh;
    mesh.updateWorldMatrix(true, false);
    const object = objects.find(({ id }) => id === "bo");
    if (object === undefined) {
      throw new Error("Bo has no monitor.");
    }
    const from = new Vector3(...object.view.position);
    const ray = new Raycaster(
      from,
      new Vector3(...object.box.centre).sub(from).normalize(),
    );
    expect(ray.intersectObject(mesh)).toHaveLength(1);
  });

  it("highlights an object while the pointer is over it, with a pointing cursor", async () => {
    const scene = await renderHotspots();
    const { group, hitArea } = hotspot(scene, "whiteboard", "web-shop");

    await scene.fireEvent(hitArea, "onPointerOver");
    expect(useSelectionStore.getState().hovered).toEqual({
      kind: "whiteboard",
      id: "web-shop",
    });
    expect(document.body.style.cursor).toBe("pointer");
    const { veil, outline } = highlightOf(group);
    expect(veil).toBeInstanceOf(Mesh);
    expect((veil as Mesh).material).toBe(highlightMaterials.veil);
    expect(outline).toBeInstanceOf(LineSegments);
    // Only this one.
    for (const other of objects.filter(({ kind }) => kind !== "whiteboard")) {
      expect(
        highlightOf(hotspot(scene, other.kind, other.id).group).veil,
      ).toBeUndefined();
    }

    await scene.fireEvent(hitArea, "onPointerOut");
    expect(useSelectionStore.getState().hovered).toBeUndefined();
    expect(document.body.style.cursor).toBe("");
    expect(highlightOf(group).veil).toBeUndefined();
  });

  it("is no longer highlighted once it leaves the scene with the pointer on it", async () => {
    const scene = await renderHotspots();
    await scene.fireEvent(
      hotspot(scene, "whiteboard", "web-shop").hitArea,
      "onPointerOver",
    );
    // The lift leaves for the lobby: the Floor's objects go.
    await scene.update(<InspectableHotspots objects={lobbyInspectables()} />);
    expect(useSelectionStore.getState().hovered).toBeUndefined();
    expect(document.body.style.cursor).toBe("");
  });

  it("highlights the object focused in the keyboard list", async () => {
    const scene = await renderHotspots();
    await act(async () => {
      useSelectionStore.getState().hover({ kind: "monitor", id: "ada" });
      await Promise.resolve();
    });
    expect(
      highlightOf(hotspot(scene, "monitor", "ada").group).outline,
    ).toBeDefined();
  });

  it("opens an object's panel and flies the camera in when it is clicked", async () => {
    const scene = await renderHotspots();
    const ada = hotspot(scene, "monitor", "ada");
    await scene.fireEvent(ada.hitArea, "onPointerOver");
    await scene.fireEvent(ada.hitArea, "onClick");
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "monitor",
      id: "ada",
    });
    // Close in on it, it is no longer veiled, though the pointer is on it.
    expect(highlightOf(ada.group)).toEqual({
      veil: undefined,
      outline: undefined,
    });
    expect(destination(useCameraStore.getState().rig)).toBe(
      "inspect:monitor:ada",
    );

    await scene.fireEvent(
      hotspot(scene, "bookshelf", "web-shop").hitArea,
      "onClick",
    );
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "bookshelf",
      id: "web-shop",
    });
    expect(destination(useCameraStore.getState().rig)).toBe(
      "inspect:bookshelf:web-shop",
    );
  });

  it("opens nothing when a finger drags over it to move the camera", async () => {
    const scene = await renderHotspots();
    const ada = hotspot(scene, "monitor", "ada");
    await scene.fireEvent(ada.hitArea, "onClick", { delta: tapSlop + 1 });
    expect(useSelectionStore.getState().selected).toBeUndefined();
    await scene.fireEvent(ada.hitArea, "onClick", { delta: tapSlop });
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "monitor",
      id: "ada",
    });
  });

  it("opens an Agent's card, flying to it, when the Agent is clicked (PRD FR-63)", async () => {
    const scene = await renderHotspots();
    const bo = hotspot(scene, "agent", "bo");
    await scene.fireEvent(bo.hitArea, "onPointerOver");
    expect(highlightOf(bo.group).veil).toBeDefined();
    expect(document.body.style.cursor).toBe("pointer");
    await scene.fireEvent(bo.hitArea, "onClick");
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "agent",
      id: "bo",
    });
    expect(destination(useCameraStore.getState().rig)).toBe("inspect:agent:bo");
  });

  it("while a Grilling Session runs, opens the session chat when the Manager, the table or the whiteboard is clicked (PRD FR-83), and the rest as ever", async () => {
    const inSession = floorInspectables(
      "web-shop",
      [
        { id: "ada", name: "Ada", role: "manager" },
        { id: "bo", name: "Bo", role: "designer" },
      ],
      { grilling: true },
    );
    const scene = await renderHotspots(inSession);
    for (const [kind, id] of [
      ["agent", "ada"],
      ["grilling-session", "web-shop"],
      ["whiteboard", "web-shop"],
    ] as const) {
      resetSelection();
      const clicked = hotspot(scene, kind, id);
      // The object pointed at is the one highlighted.
      await scene.fireEvent(clicked.hitArea, "onPointerOver");
      expect(highlightOf(clicked.group).veil, `${kind}:${id}`).toBeDefined();
      await scene.fireEvent(clicked.hitArea, "onClick");
      expect(useSelectionStore.getState().selected, `${kind}:${id}`).toEqual({
        kind: "grilling-session",
        id: "web-shop",
      });
      expect(destination(useCameraStore.getState().rig)).toBe(
        "inspect:grilling-session:web-shop",
      );
      await scene.fireEvent(clicked.hitArea, "onPointerOut");
    }
    resetSelection();
    await scene.fireEvent(hotspot(scene, "agent", "bo").hitArea, "onClick");
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "agent",
      id: "bo",
    });
  });

  it("are where the lift is: in the lobby, its Notice Board and the Communications Agent", async () => {
    renderer = await ReactThreeTestRenderer.create(
      <OfficeLocationScene
        board={boardPreview([])}
        stops={liftStops([], [])}
        inspectables={lobbyInspectables("Grace")}
      />,
    );
    const lobby = renderer.scene.instance.getObjectByName("lobby");
    expect(lobby).toBeDefined();
    expect(
      renderer.scene.instance
        .getObjectByName("inspectables")
        ?.children.map(({ name }) => name),
    ).toEqual([
      "inspectable:notice-board:office",
      "inspectable:agent:communications",
    ]);
    await renderer.fireEvent(
      hotspot(renderer, "notice-board", "office").hitArea,
      "onClick",
    );
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "notice-board",
      id: "office",
    });
    await renderer.fireEvent(
      hotspot(renderer, "agent", "communications").hitArea,
      "onClick",
    );
    expect(useSelectionStore.getState().selected).toEqual({
      kind: "agent",
      id: "communications",
    });
  });
});
