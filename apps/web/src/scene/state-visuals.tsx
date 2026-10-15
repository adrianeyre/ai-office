import { palette } from "@ai-office/shared/palette";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";

import {
  maxTicketsShown,
  type AgentLook,
  type AgentMarker,
} from "./agent-state.ts";
import type { Vec3 } from "./camera-rig.ts";
import { chairOffset, desk, ticketPile } from "./desk-set.ts";
import { managersLight, type FloorDesk } from "./floor-layout.ts";
import { emissiveIntensity, material } from "./materials.ts";
import { turnPoint } from "./pieces.ts";
import { useSceneSettings } from "./scene-settings.ts";

// What each Agent's state looks like on a Floor (PRD FR-62), as
// agent-state.ts says: a pile of tickets on each desk, a marker over each
// paused or capped Agent's head, and the red light over the Manager's
// office door while the Floor has an action Notice. The piles are one
// instanced mesh, the markers two and their symbols one, so a Floor full
// of them costs four draw calls; the light is one more.

/** A ticket on a pile: A4, 5 mm thick (the art direction's). */
export const ticketSize: Vec3 = [ticketPile.size[0], 0.005, ticketPile.size[1]];

const yAxis = new Vector3(0, 1, 0);

/**
 * Where each of a desk's `count` tickets lies, bottom first: stacked on the
 * desk's left (the spot kept for them), each a little askew so the pile
 * reads as sheets, turned with the desk.
 */
export function ticketMatrices(
  { seat, turns }: Pick<FloorDesk, "seat" | "turns">,
  count: number,
): Matrix4[] {
  const [x, z] = ticketPile.centre;
  return Array.from({ length: count }, (_, index) => {
    const at = turnPoint(
      [
        x + 0.008 * Math.sin(index * 2.1),
        desk.top + ticketSize[1] * (index + 0.5),
        z + 0.008 * Math.cos(index * 1.7) - chairOffset,
      ],
      turns,
      [seat[0], seat[2]],
    );
    return new Matrix4().compose(
      new Vector3(...at),
      new Quaternion().setFromAxisAngle(
        yAxis,
        (turns * Math.PI) / 2 + 0.06 * Math.sin(index * 1.3 + 0.5),
      ),
      new Vector3(...ticketSize),
    );
  });
}

const unitBox = new BoxGeometry(1, 1, 1);

/** Every desk's pile of tickets, one per task waiting, as one instanced mesh. */
export function TicketPiles({
  desks,
  looks,
}: {
  desks: readonly FloorDesk[];
  looks: ReadonlyMap<string, AgentLook>;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const matrices = useMemo(
    () =>
      desks.flatMap((each) =>
        ticketMatrices(each, looks.get(each.agentId)?.tickets ?? 0),
      ),
    [desks, looks],
  );
  // Room for a full pile on every desk, so a growing queue never makes a new mesh.
  const capacity = Math.max(desks.length, 1) * maxTicketsShown;
  useLayoutEffect(() => {
    const current = mesh.current;
    if (current === null) {
      return;
    }
    matrices.forEach((matrix, index) => {
      current.setMatrixAt(index, matrix);
    });
    current.count = matrices.length;
    current.instanceMatrix.needsUpdate = true;
    current.computeBoundingSphere();
  }, [matrices]);
  return (
    <instancedMesh
      key={capacity}
      ref={mesh}
      name="ticket-piles"
      args={[unitBox, material("paper", "paint"), capacity]}
      receiveShadow
    />
  );
}

/** How high a marker's centre is over its Agent's seat: clear of the tallest head. */
export const markerHeight = 1.78;

/** A marker's sign: 32 cm across, 2 cm thick. */
export const markerSize = { radius: 0.16, thickness: 0.02 } as const;

/**
 * Each marker's symbol, in paper on its sign, in the sign's own space (its
 * face towards +z): a pause's two upright bars, and a cap's one bar across,
 * as on a no-entry sign.
 */
export const markerSymbols: Readonly<
  Record<AgentMarker, readonly { at: Vec3; size: Vec3 }[]>
> = {
  paused: [-1, 1].map((side) => ({
    at: [side * 0.045, 0, markerSize.thickness / 2 + 0.002] as Vec3,
    size: [0.045, 0.16, 0.004] as Vec3,
  })),
  capped: [
    {
      at: [0, 0, markerSize.thickness / 2 + 0.002],
      size: [0.2, 0.055, 0.004],
    },
  ],
};

/** A sign facing +z: a disc for a pause, an octagon (a stop sign's) for a cap. */
const signGeometry = (segments: number) =>
  new CylinderGeometry(
    markerSize.radius,
    markerSize.radius,
    markerSize.thickness,
    segments,
  )
    .rotateY(Math.PI / segments)
    .rotateX(Math.PI / 2);
const signs: Readonly<Record<AgentMarker, CylinderGeometry>> = {
  paused: signGeometry(32),
  capped: signGeometry(8),
};

/** The signs glow in `state-critical` (the art direction's), so they bloom. */
const signMaterial = new MeshBasicMaterial({
  name: "agent-markers/glow",
  color: new Color(palette["state-critical"]).multiplyScalar(
    emissiveIntensity.lamp,
  ),
});
const symbolMaterial = new MeshBasicMaterial({
  name: "agent-markers/paper",
  color: palette.paper,
});

/** Where an Agent's marker is: over its seat, clear of its head. */
export const markerAt = (seat: Vec3): Vec3 => [
  seat[0],
  seat[1] + markerHeight,
  seat[2],
];

/** One of a marker's kinds' signs, and its symbols. */
function MarkerKind({
  kind,
  places,
}: {
  kind: AgentMarker;
  places: readonly Vec3[];
}) {
  const sign = useRef<InstancedMesh>(null);
  const symbol = useRef<InstancedMesh>(null);
  const shapes = markerSymbols[kind];
  const capacity = Math.max(places.length, 1);
  // Every marker faces the camera, so it reads from any view.
  const face = (turn: Quaternion) => {
    const matrix = new Matrix4();
    const part = new Matrix4();
    places.forEach((at, index) => {
      matrix.compose(new Vector3(...at), turn, new Vector3(1, 1, 1));
      sign.current?.setMatrixAt(index, matrix);
      shapes.forEach(({ at: offset, size }, which) => {
        part.compose(
          new Vector3(...offset),
          new Quaternion(),
          new Vector3(...size),
        );
        symbol.current?.setMatrixAt(
          index * shapes.length + which,
          matrix.clone().multiply(part),
        );
      });
    });
    for (const mesh of [sign.current, symbol.current]) {
      if (mesh !== null) {
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  };
  useLayoutEffect(() => {
    if (sign.current !== null && symbol.current !== null) {
      sign.current.count = places.length;
      symbol.current.count = places.length * shapes.length;
    }
    face(new Quaternion());
    sign.current?.computeBoundingSphere();
    symbol.current?.computeBoundingSphere();
  });
  useFrame(({ camera }) => {
    face(camera.quaternion);
  });
  return (
    <>
      <instancedMesh
        key={`sign-${String(capacity)}`}
        ref={sign}
        name={`agent-markers-${kind}`}
        args={[signs[kind], signMaterial, capacity]}
      />
      <instancedMesh
        key={`symbol-${String(capacity)}`}
        ref={symbol}
        name={`agent-marker-symbols-${kind}`}
        args={[unitBox, symbolMaterial, capacity * shapes.length]}
      />
    </>
  );
}

/** A marker over each paused or capped Agent's head, each kind its own shape. */
export function AgentMarkers({
  desks,
  looks,
}: {
  desks: readonly FloorDesk[];
  looks: ReadonlyMap<string, AgentLook>;
}) {
  const places = useMemo(() => {
    const byKind: Record<AgentMarker, Vec3[]> = { paused: [], capped: [] };
    for (const { agentId, seat } of desks) {
      const marker = looks.get(agentId)?.marker;
      if (marker !== undefined) {
        byKind[marker].push(markerAt(seat));
      }
    }
    return byKind;
  }, [desks, looks]);
  return (
    <group name="agent-markers">
      {(["paused", "capped"] as const).map((kind) =>
        places[kind].length === 0 ? null : (
          <MarkerKind key={kind} kind={kind} places={places[kind]} />
        ),
      )}
    </group>
  );
}

/** How brightly the red light pulses: within the spec's 1.2 to 2.0. */
export const lightPulse = { low: 1.2, high: 2.0, seconds: 1.4 } as const;

const critical = new Color(palette["state-critical"]);
const lightOff = new Color(palette["screen-off"]);

/** The light's brightness `elapsed` seconds in: steady with reduced motion. */
export function lightIntensity(elapsed: number, reducedMotion: boolean) {
  if (reducedMotion) {
    return emissiveIntensity.lamp;
  }
  const wave = (1 - Math.cos((2 * Math.PI * elapsed) / lightPulse.seconds)) / 2;
  return lightPulse.low + (lightPulse.high - lightPulse.low) * wave;
}

/**
 * The red light over the Manager's office door: lit, and pulsing gently,
 * while the Floor has an action Notice; a dark lens otherwise.
 */
export function ManagersLight({ on }: { on: boolean }) {
  const lens = useMemo(
    () => new MeshBasicMaterial({ name: "managers-light/lens" }),
    [],
  );
  useEffect(
    () => () => {
      lens.dispose();
    },
    [lens],
  );
  useLayoutEffect(() => {
    lens.color.copy(
      on ? critical.clone().multiplyScalar(emissiveIntensity.lamp) : lightOff,
    );
  }, [lens, on]);
  const elapsed = useRef(0);
  useFrame((_state, delta) => {
    if (on) {
      elapsed.current += delta;
      lens.color
        .copy(critical)
        .multiplyScalar(
          lightIntensity(
            elapsed.current,
            useSceneSettings.getState().reducedMotion,
          ),
        );
    }
  });
  return (
    <mesh
      name="managers-light"
      position={[...managersLight.centre]}
      material={lens}
      userData={{ on }}
    >
      <boxGeometry args={[...managersLight.size]} />
    </mesh>
  );
}
