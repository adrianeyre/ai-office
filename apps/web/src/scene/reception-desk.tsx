import { palette } from "@ai-office/shared/palette";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
  type Mesh,
} from "three";

import { outTray, receptionMarker } from "./lobby-layout.ts";
import { emissiveIntensity, material } from "./materials.ts";
import {
  createOutTray,
  envelopeSize,
  maxPile,
  type OutTray,
} from "./reception-desk.ts";
import { useSceneSettings } from "./scene-settings.ts";
import { lightIntensity } from "./state-visuals.tsx";

// The Communications Agent's reception desk in the scene (PRD FR-96): an
// envelope drops from its hands into the out-tray for each message it
// sends, onto a pile there, and a failing Connection shows a red marker,
// pulsing gently, on the counter's ledge. Delivery never waits for it:
// the scene only counts what was sent (reception-desk.ts), and envelopes
// far behind land at once. With reduced motion they land at once, and the
// marker holds still.

/** What the reception desk shows: the messages sent, and the failing Connections. */
export interface Reception {
  /**
   * How many messages the Communications Agent has sent since the Office
   * opened: an envelope each into the out-tray.
   */
  readonly sent: number;
  /** The names of the failing Connections: any shows the red marker. */
  readonly failing: readonly string[];
}

const unitBox = new BoxGeometry(1, 1, 1);

/** Each envelope in the pile, a little askew, the same each time. */
function pileMatrix(index: number): Matrix4 {
  const turn = (((index * 7919) % 13) - 6) * 0.012;
  const shift = (((index * 104729) % 7) - 3) * 0.004;
  return new Matrix4().compose(
    new Vector3(
      outTray.centre[0] + shift,
      outTray.top + (index + 0.5) * envelopeSize[1],
      outTray.centre[2] - shift / 2,
    ),
    new Quaternion().setFromEuler(new Euler(0, turn, 0)),
    new Vector3(...envelopeSize),
  );
}

const pileMatrices = Array.from({ length: maxPile }, (_, index) =>
  pileMatrix(index),
);

/** The out-tray's envelopes: the pile, and the one dropping into it. */
function OutTrayEnvelopes({ sent }: { sent: number }) {
  // What was sent before the desk was drawn is in the tray already.
  const tray = useRef<OutTray>(null);
  const counted = useRef<number>(null);
  const pile = useRef<InstancedMesh>(null);
  const dropping = useRef<Mesh>(null);
  const shown = useRef(-1);

  useLayoutEffect(() => {
    if (tray.current === null || counted.current === null) {
      tray.current = createOutTray(sent);
      counted.current = sent;
      return;
    }
    tray.current.send(
      sent - counted.current,
      useSceneSettings.getState().reducedMotion,
    );
    counted.current = sent;
  }, [sent]);

  useFrame((_state, delta) => {
    const current = tray.current;
    if (current === null) {
      return;
    }
    current.advance(delta);
    const count = current.pile();
    const mesh = pile.current;
    if (mesh !== null && count !== shown.current) {
      shown.current = count;
      pileMatrices.forEach((matrix, index) => {
        mesh.setMatrixAt(index, matrix);
      });
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    const envelope = current.envelope();
    const flying = dropping.current;
    if (flying !== null) {
      flying.visible = envelope !== undefined;
      if (envelope !== undefined) {
        flying.position.set(...envelope.position);
        flying.rotation.set(envelope.tilt, 0, 0);
      }
    }
  });

  return (
    <>
      <instancedMesh
        ref={pile}
        name="out-tray-envelopes"
        args={[unitBox, material("paper", "paint"), maxPile]}
        count={0}
        receiveShadow
      />
      <mesh
        ref={dropping}
        name="dropping-envelope"
        geometry={unitBox}
        material={material("paper", "paint")}
        scale={[...envelopeSize]}
        visible={false}
        castShadow
      />
    </>
  );
}

/** The marker's sign, facing +z: a disc, as a lamp's lens. */
const signGeometry = new CylinderGeometry(
  receptionMarker.radius,
  receptionMarker.radius,
  receptionMarker.thickness,
  24,
).rotateX(Math.PI / 2);

/** An exclamation mark in paper on the sign: its bar, then its dot. */
export const markerSymbol: readonly { at: Vector3; size: Vector3 }[] = [
  { at: new Vector3(0, 0.022, 0), size: new Vector3(0.026, 0.085, 0.004) },
  { at: new Vector3(0, -0.05, 0), size: new Vector3(0.026, 0.026, 0.004) },
].map(({ at, size }) => ({
  at: at.setZ(receptionMarker.thickness / 2 + 0.002),
  size,
}));

/** The sign glows in `state-critical`, so it blooms; its brightness pulses. */
const criticalColour = new Color(palette["state-critical"]);
const critical = new MeshBasicMaterial({
  name: "reception-marker/critical",
  color: criticalColour.clone().multiplyScalar(emissiveIntensity.lamp),
});
const symbolMaterial = new MeshBasicMaterial({
  name: "reception-marker/paper",
  color: palette.paper,
});

/**
 * The red marker on the reception desk while a Connection is failing: a
 * sign on a post, glowing `state-critical` and pulsing as the Manager's
 * red light does, turned towards the camera so it reads from any view.
 */
function FailingMarker() {
  const sign = useRef<Group>(null);
  const elapsed = useRef(0);
  const [x, y, z] = receptionMarker.centre;
  const [, postHeight] = receptionMarker.post;
  useFrame(({ camera }, delta) => {
    elapsed.current += delta;
    critical.color
      .copy(criticalColour)
      .multiplyScalar(
        lightIntensity(
          elapsed.current,
          useSceneSettings.getState().reducedMotion,
        ),
      );
    // Turned about the upright only, so it stands on its post.
    sign.current?.rotation.set(
      0,
      Math.atan2(camera.position.x - x, camera.position.z - z),
      0,
    );
  });
  return (
    <group name="reception-marker">
      <mesh
        name="reception-marker-post"
        position={[x, y - receptionMarker.radius - postHeight / 2, z]}
        geometry={unitBox}
        material={material("metal-dark", "metal")}
        scale={[...receptionMarker.post]}
      />
      <group ref={sign} position={[x, y, z]}>
        <mesh
          name="reception-marker-sign"
          geometry={signGeometry}
          material={critical}
        />
        {markerSymbol.map(({ at, size }, index) => (
          <mesh
            key={index}
            name={`reception-marker-symbol-${String(index + 1)}`}
            geometry={unitBox}
            material={symbolMaterial}
            position={at}
            scale={size}
          />
        ))}
      </group>
    </group>
  );
}

/** The reception desk's moving parts: the out-tray's envelopes, and the red marker. */
export function ReceptionDesk({ sent, failing }: Reception) {
  return (
    <group name="reception-desk">
      <OutTrayEnvelopes sent={sent} />
      {failing.length > 0 && <FailingMarker />}
    </group>
  );
}
