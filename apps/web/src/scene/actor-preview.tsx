import { seasonalActors, type SeasonalActorId } from "@ai-office/shared";
import { PerspectiveCamera, View } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CylinderGeometry } from "three";

import type { AnimationName } from "./avatar-animations.ts";
import { avatarFigure } from "./avatar-figure.ts";
import {
  previewCamera,
  previewCameraProps,
  previewCanvasProps,
  PreviewControls,
  PreviewLights,
} from "./avatar-preview.tsx";
import { material } from "./materials.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { actorLooks } from "./seasonal-dress.ts";

// The seasonal actors on their turntables in General Settings, as the
// Avatar Editor shows an Avatar: dragging turns the camera round each.
// Christmas's and Easter's actors stand at ease; Halloween's frights
// loom; the ghost floats; New Year's drunks sway. There are more actors
// than a browser keeps WebGL canvases (it drops the oldest past about
// sixteen, so the first few went blank a moment after they showed), so
// they share one canvas over the page: each turntable is a view drawn
// into its own tile's place on it. It loads three.js, so the settings
// card loads it only when it is shown.

const turntable = new CylinderGeometry(0.6, 0.6, 0.04, 48);

/** What an actor does on its turntable, by how it goes round. */
const posing: Record<
  (typeof seasonalActors)[SeasonalActorId]["gait"],
  AnimationName
> = {
  walk: "idle",
  hop: "idle",
  run: "scare",
  stagger: "sway",
  float: "float",
};

/** One actor on its turntable. */
export function ActorPreviewStage({ actor }: { actor: SeasonalActorId }) {
  const figure = useMemo(() => {
    const { avatar, dress } = actorLooks[actor];
    return avatarFigure(avatar, 0, undefined, dress);
  }, [actor]);
  useEffect(
    () => () => {
      figure.dispose();
    },
    [figure],
  );
  useEffect(() => {
    figure.play(posing[seasonalActors[actor].gait], true);
  }, [figure, actor]);
  useFrame((_state, delta) => {
    if (!useSceneSettings.getState().reducedMotion) {
      figure.mixer.update(delta);
    }
  });
  return (
    <group name={`actor-preview ${actor}`}>
      <mesh
        name="turntable"
        geometry={turntable}
        material={material("floor-carpet", "fabric")}
        position={[0, -0.02, 0]}
        receiveShadow
      />
      <primitive object={figure.mesh} />
    </group>
  );
}

/**
 * Clears the shared canvas to see-through each frame, before the views
 * draw into it: a view that has scrolled on leaves nothing behind, and the
 * page shows round them.
 */
function ClearEachFrame() {
  useFrame(({ gl }) => {
    gl.setScissorTest(false);
    gl.setClearColor(0x000000, 0);
    gl.clear();
  }, 0);
  return null;
}

/**
 * The one canvas every actor's turntable is drawn on: fixed over the
 * page, under its sticky header and footer, letting the pointer through
 * to the tiles beneath.
 */
export function ActorPreviewCanvas() {
  return createPortal(
    <Canvas
      aria-hidden
      {...previewCanvasProps}
      dpr={[...previewCanvasProps.dpr]}
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <ClearEachFrame />
      <View.Port />
    </Canvas>,
    document.body,
  );
}

/** An actor's turntable, drawn on the shared canvas where this tile is. */
export function ActorPreview({ actor }: { actor: SeasonalActorId }) {
  // The tile's own element, which its drag turns the camera from.
  const [tile, setTile] = useState<HTMLElement | null>(null);
  const tracked = useCallback((element: HTMLElement | object | null) => {
    setTile(element instanceof HTMLElement ? element : null);
  }, []);
  return (
    <View ref={tracked} className="absolute inset-0 touch-none select-none">
      <PerspectiveCamera
        makeDefault
        {...previewCameraProps}
        position={[...previewCamera]}
      />
      <PreviewLights />
      <ActorPreviewStage actor={actor} />
      {tile !== null && <PreviewControls domElement={tile} />}
    </View>
  );
}
