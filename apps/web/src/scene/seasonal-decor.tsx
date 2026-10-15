import type { PaletteToken } from "@ai-office/shared/palette";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Matrix4, SphereGeometry, type InstancedMesh } from "three";

import {
  avatarLods,
  avatarMaterial,
  shapesGeometry,
} from "./avatar-geometry.ts";
import { material } from "./materials.ts";
import { useSceneSettings } from "./scene-settings.ts";
import type { Decor } from "./seasonal-decor.ts";

// The seasonal decorations in the scene: their shapes as one mesh in the
// Avatars' material (those up by the ceiling as another, casting no
// shadows), and their fairy lights as glowing bulbs, one
// instanced mesh per colour, half of each colour dimming in turn so the
// strings twinkle (still, with reduced motion).

const bulb = new SphereGeometry(0.025, 8, 6);

/** How long each half of the lights stays bright, in seconds. */
export const twinkleSeconds = 0.8;

function Bulbs({
  token,
  at,
}: {
  token: PaletteToken;
  at: readonly (readonly [number, number, number])[];
}) {
  const mesh = useRef<InstancedMesh>(null);
  const phase = useRef(0);
  const shown = useRef<number>(-1);
  const place = (bright: number) => {
    const instances = mesh.current;
    if (instances === null) {
      return;
    }
    const matrix = new Matrix4();
    at.forEach(([x, y, z], index) => {
      const scale = index % 2 === bright ? 1 : 0.55;
      instances.setMatrixAt(
        index,
        matrix.makeScale(scale, scale, scale).setPosition(x, y, z),
      );
    });
    instances.instanceMatrix.needsUpdate = true;
  };
  useLayoutEffect(() => {
    shown.current = 0;
    place(0);
  });
  useFrame((_state, delta) => {
    if (useSceneSettings.getState().reducedMotion) {
      return;
    }
    phase.current = (phase.current + delta) % (twinkleSeconds * 2);
    const bright = phase.current < twinkleSeconds ? 0 : 1;
    if (bright !== shown.current) {
      shown.current = bright;
      place(bright);
    }
  });
  return (
    <instancedMesh
      key={at.length}
      ref={mesh}
      name={`seasonal-lights ${token}`}
      args={[bulb, material(token, "lamp"), at.length]}
    />
  );
}

/** A Decor: its shapes and its fairy lights. */
export function SeasonalDecor({ decor }: { decor: Decor }) {
  const quality = useSceneSettings((settings) => settings.quality);
  const geometry = useMemo(
    () =>
      decor.shapes.length === 0
        ? undefined
        : shapesGeometry(decor.shapes, avatarLods[quality]),
    [decor, quality],
  );
  useEffect(() => () => geometry?.dispose(), [geometry]);
  const overhead = useMemo(
    () =>
      decor.overhead === undefined || decor.overhead.length === 0
        ? undefined
        : shapesGeometry(decor.overhead, avatarLods[quality]),
    [decor, quality],
  );
  useEffect(() => () => overhead?.dispose(), [overhead]);
  const byToken = useMemo(() => {
    const lights = new Map<PaletteToken, [number, number, number][]>();
    for (const { token, at } of decor.lights) {
      lights.set(token, [...(lights.get(token) ?? []), [...at]]);
    }
    return [...lights];
  }, [decor]);
  return (
    <group name="seasonal-decor">
      {geometry !== undefined && (
        <mesh
          name="seasonal-decorations"
          geometry={geometry}
          material={avatarMaterial()}
          castShadow
          receiveShadow
        />
      )}
      {overhead !== undefined && (
        <mesh
          name="seasonal-overhead"
          geometry={overhead}
          material={avatarMaterial()}
        />
      )}
      {byToken.map(([token, at]) => (
        <Bulbs key={token} token={token} at={at} />
      ))}
    </group>
  );
}
