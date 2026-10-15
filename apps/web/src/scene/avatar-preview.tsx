import type { Avatar } from "@ai-office/shared/avatar";
import { palette } from "@ai-office/shared/palette";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, type ReactNode } from "react";
import { CylinderGeometry } from "three";

import type { Vec3 } from "./camera-rig.ts";
import { avatarFigure } from "./avatar-figure.ts";
import { avatarMaterial, mascotGeometry } from "./avatar-geometry.ts";
import { desk } from "./desk-set.ts";
import {
  ambientLight,
  fillLight,
  keyLight,
  lightPositions,
  shadowBias,
} from "./lighting.ts";
import { material } from "./materials.ts";
import { useSceneSettings } from "./scene-settings.ts";

// The Avatar Editor's live preview (PRD FR-13): one Avatar on a turntable,
// at the highest LOD, lit as the Office is, standing idle beside its desk
// mascot. Dragging turns the camera round it (and up, a little); the
// editor's own buttons turn the Avatar, for the keyboard. It is drawn from
// the draft, so every change shows at once, before it is saved. With
// reduced motion the Avatar holds its pose. It loads three.js, so the
// editor loads it only when it is shown.

/** Where the camera looks: about the Avatar's middle, a little above. */
export const previewTarget: Vec3 = [0, 0.85, 0];

/** Where the camera starts: in front, a little above, the whole Avatar in view. */
export const previewCamera: Vec3 = [0.9, 1.25, 4.3];

/**
 * The mascot stands on a plinth at a desk's height beside the Avatar, at
 * twice its size: at its own (under 13 cm) it would be a speck here.
 */
export const mascotStand = { at: [0.55, 0, 0.15] as Vec3, scale: 2 };

const lights = lightPositions({
  position: previewCamera,
  target: previewTarget,
});

const turntable = new CylinderGeometry(0.6, 0.6, 0.04, 48);
const plinth = new CylinderGeometry(0.1, 0.12, desk.top, 24);

/**
 * The Avatar and its mascot, turned by `turn` (radians, about the
 * vertical), on its turntable. Every new Avatar is a new figure.
 */
export function AvatarPreviewStage({
  avatar,
  turn,
}: {
  avatar: Avatar;
  turn: number;
}) {
  // Rebuilt only when what it looks like changes.
  const look = JSON.stringify(avatar);
  const figure = useMemo(
    () => avatarFigure(JSON.parse(look) as Avatar, 0),
    [look],
  );
  const mascot = useMemo(
    () => mascotGeometry(JSON.parse(look) as Avatar),
    [look],
  );
  useEffect(
    () => () => {
      figure.dispose();
    },
    [figure],
  );
  useEffect(
    () => () => {
      mascot.dispose();
    },
    [mascot],
  );
  useEffect(() => {
    figure.play("idle", true);
  }, [figure]);
  useFrame((_state, delta) => {
    if (!useSceneSettings.getState().reducedMotion) {
      figure.mixer.update(delta);
    }
  });
  const [x, , z] = mascotStand.at;
  return (
    <group name="avatar-preview" rotation={[0, turn, 0]}>
      <mesh
        name="turntable"
        geometry={turntable}
        material={material("floor-carpet", "fabric")}
        position={[0, -0.02, 0]}
        receiveShadow
      />
      <primitive object={figure.mesh} />
      <mesh
        name="plinth"
        geometry={plinth}
        material={material("desk-top", "wood")}
        position={[x, desk.top / 2, z]}
        castShadow
        receiveShadow
      />
      <mesh
        name="desk-mascot"
        geometry={mascot}
        material={avatarMaterial()}
        position={[x, desk.top, z]}
        scale={mascotStand.scale}
        castShadow
      />
    </group>
  );
}

/** The preview's canvas: the stage, its lights, and the camera's drag. */
export function AvatarPreview({
  avatar,
  turn,
}: {
  avatar: Avatar;
  turn: number;
}) {
  return (
    <PreviewCanvas>
      <AvatarPreviewStage avatar={avatar} turn={turn} />
    </PreviewCanvas>
  );
}

/** A turntable's lights: the Office's key, fill and sky, on the preview's background. */
export function PreviewLights() {
  return (
    <>
      <color attach="background" args={[palette["light-sky"]]} />
      <directionalLight
        color={palette["light-key"]}
        intensity={keyLight.intensity}
        position={lights.key}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={shadowBias.bias}
        shadow-normalBias={shadowBias.normalBias}
        shadow-camera-left={-1.5}
        shadow-camera-right={1.5}
        shadow-camera-top={2.5}
        shadow-camera-bottom={-0.5}
      />
      <directionalLight
        color={palette["light-fill"]}
        intensity={fillLight.intensity}
        position={lights.fill}
      />
      <hemisphereLight
        args={[
          palette["light-sky"],
          palette["light-ground"],
          ambientLight.intensity,
        ]}
      />
    </>
  );
}

/**
 * The drag that turns a turntable's camera round what stands on it (and
 * up, a little), on `domElement` when given, else the canvas.
 */
export function PreviewControls({
  domElement,
}: {
  domElement?: HTMLElement | undefined;
}) {
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  return (
    <OrbitControls
      target={previewTarget}
      enablePan={false}
      minDistance={1.6}
      maxDistance={6}
      minPolarAngle={Math.PI / 6}
      maxPolarAngle={Math.PI / 2}
      enableDamping={!reducedMotion}
      {...(domElement === undefined ? {} : { domElement })}
    />
  );
}

/** A turntable canvas's settings, the Avatar Editor's and the actors' shared one alike. */
export const previewCanvasProps = {
  dpr: [1, 2],
  shadows: "percentage",
  gl: { antialias: true, stencil: false },
} as const;

/** Where a turntable's camera starts, and how it sees. */
export const previewCameraProps = {
  fov: 30,
  near: 0.1,
  far: 50,
  position: previewCamera,
} as const;

/**
 * A turntable's canvas, lit as the Office is, whose camera the pointer
 * drags round what stands on it: the Avatar Editor's.
 */
export function PreviewCanvas({ children }: { children: ReactNode }) {
  return (
    <Canvas
      aria-hidden
      className="absolute inset-0"
      {...previewCanvasProps}
      dpr={[...previewCanvasProps.dpr]}
      camera={{ ...previewCameraProps, position: [...previewCamera] }}
    >
      <PreviewLights />
      {children}
      <PreviewControls />
    </Canvas>
  );
}
