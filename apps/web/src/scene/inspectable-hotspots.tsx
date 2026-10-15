import { palette } from "@ai-office/shared/palette";
import type { ThreeEvent } from "@react-three/fiber";
import { useEffect } from "react";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  MeshBasicMaterial,
} from "three";

import type { InspectableObject } from "./inspectable.ts";
import { openInspectable } from "./inspection.ts";
import { sameSelection, useSelectionStore } from "./selection-store.ts";
import { tapSlop } from "./touch-camera.ts";

// The inspectable objects in the scene (PRD FR-58): an unseen box over each
// one that the pointer picks it by. Hovering one highlights it (as does
// focusing it in the keyboard list), and clicking it opens its panel and
// flies the camera in (inspection.ts). The objects themselves are drawn
// with the rest of their room, merged by material; these boxes only pick
// and highlight. An object that opens another (the whiteboard and the
// Manager, during a Grilling Session) opens that one when clicked.

const unitBox = new BoxGeometry(1, 1, 1);
const unitEdges = new EdgesGeometry(unitBox);

/** Picked by the pointer, never drawn: three.js raycasts it all the same. */
const hitMaterial = new MeshBasicMaterial({
  name: "inspectable-hit-area",
  visible: false,
});

/** The highlight: a veil of `paper`, outlined in `ink` (the palette's outline colour). */
export const highlightMaterials = {
  veil: new MeshBasicMaterial({
    name: "inspectable-highlight",
    color: palette.paper,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
  }),
  outline: new LineBasicMaterial({
    name: "inspectable-outline",
    color: palette.ink,
  }),
};

function Hotspot({
  object,
  opens = object,
}: {
  object: InspectableObject;
  /** What clicking it opens: itself, unless it opens another. */
  opens?: InspectableObject;
}) {
  const { kind, id, box } = object;
  // Not while its panel is open: the camera is close in on it then.
  const highlighted = useSelectionStore(
    (state) =>
      sameSelection(state.hovered, object) &&
      !sameSelection(state.selected, object),
  );
  const pointAt = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    useSelectionStore.getState().hover({ kind, id });
    document.body.style.cursor = "pointer";
  };
  const stopPointing = () => {
    const { hovered, hover } = useSelectionStore.getState();
    if (sameSelection(hovered, object)) {
      hover(undefined);
    }
    document.body.style.cursor = "";
  };
  // Gone from the scene (the lift has left) with the pointer still on it:
  // it is no longer pointed at, so nothing is highlighted when it is back.
  useEffect(
    () => () => {
      const { hovered, hover } = useSelectionStore.getState();
      if (sameSelection(hovered, { kind, id })) {
        hover(undefined);
        document.body.style.cursor = "";
      }
    },
    [kind, id],
  );
  return (
    <group
      name={`inspectable:${kind}:${id}`}
      position={[...box.centre]}
      scale={[...box.size]}
    >
      <mesh
        name="hit-area"
        geometry={unitBox}
        material={hitMaterial}
        onClick={(event) => {
          event.stopPropagation();
          // A drag that moved the camera (by touch) is not a click.
          if (event.delta > tapSlop) {
            return;
          }
          openInspectable(opens);
        }}
        onPointerOver={pointAt}
        onPointerOut={stopPointing}
      />
      {highlighted && (
        <>
          <mesh
            name="highlight"
            geometry={unitBox}
            material={highlightMaterials.veil}
            renderOrder={2}
          />
          <lineSegments
            name="outline"
            geometry={unitEdges}
            material={highlightMaterials.outline}
          />
        </>
      )}
    </group>
  );
}

/** Every inspectable object where the lift is, ready to be picked. */
export function InspectableHotspots({
  objects,
}: {
  objects: readonly InspectableObject[];
}) {
  return (
    <group name="inspectables">
      {objects.map((object) => (
        <Hotspot
          key={`${object.kind}:${object.id}`}
          object={object}
          opens={
            object.opens === undefined
              ? object
              : (objects.find((each) => sameSelection(each, object.opens)) ??
                object)
          }
        />
      ))}
    </group>
  );
}
