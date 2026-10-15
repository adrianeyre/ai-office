import type { Role } from "@ai-office/shared";
import { palette } from "@ai-office/shared/palette";
import { useThree } from "@react-three/fiber";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { useLayoutEffect } from "react";
import {
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Object3D,
} from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { agentLook, type AgentLook, type AgentState } from "./agent-state.ts";
import { desk, ticketPile } from "./desk-set.ts";
import { Floor } from "./floor.tsx";
import {
  floorCeiling,
  floorLayout,
  managersLight,
  managersOffice,
  type FloorAgent,
} from "./floor-layout.ts";
import { liftStops } from "./lift-stops.ts";
import { emissiveIntensity } from "./materials.ts";
import { provideModels, type LoadedModels } from "./models.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import {
  lightIntensity,
  lightPulse,
  markerHeight,
  markerSize,
  ticketSize,
} from "./state-visuals.tsx";
import { loadModelsFromDisk } from "./test-models.ts";

// What each Agent's state looks like on a Floor (PRD FR-62), rendered
// without WebGL by React Three Fiber's test renderer: the waiting pose,
// the piles of tickets, the markers over paused and capped Agents, and the
// red light at the Manager's office.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const roles: Role[] = ["manager", "coder", "reviewer", "qa", "docs"];
const team: FloorAgent[] = roles.map((role, index) => ({
  id: `agent-${String(index + 1)}`,
  role,
}));
const stops = liftStops([], []);
const idle: AgentState = {
  working: false,
  enabled: true,
  capped: false,
  awaitingReview: 0,
  queued: 0,
};
const looksOf = (states: Record<string, Partial<AgentState>>) =>
  new Map(
    team.map(({ id }) => [id, agentLook({ ...idle, ...states[id] })] as const),
  );

/** Puts the camera at the default view, looking at the Floor. */
function DefaultView() {
  const camera = useThree((state) => state.camera);
  useLayoutEffect(() => {
    camera.position.set(14, 16, 18);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }, [camera]);
  return null;
}

let renderer: Renderer | undefined;
let models: LoadedModels;

async function renderFloor(
  looks: ReadonlyMap<string, AgentLook>,
  needsOwner = false,
): Promise<Renderer> {
  renderer = await ReactThreeTestRenderer.create(
    <>
      <DefaultView />
      <Floor
        floorId="web-shop"
        team={team}
        looks={looks}
        needsOwner={needsOwner}
        stops={stops}
      />
    </>,
  );
  return renderer;
}

const rerender = async (
  scene: Renderer,
  looks: ReadonlyMap<string, AgentLook>,
  needsOwner = false,
) => {
  await act(async () => {
    await scene.update(
      <>
        <DefaultView />
        <Floor
          floorId="web-shop"
          team={team}
          looks={looks}
          needsOwner={needsOwner}
          stops={stops}
        />
      </>,
    );
  });
};

function object(scene: Renderer, name: string): Object3D {
  const found = scene.scene.instance.getObjectByName(name);
  if (found === undefined) {
    throw new Error(`The scene has nothing named "${name}".`);
  }
  return found;
}

/** An instanced mesh's instances, in world space: where each is, turned and sized. */
function instances(mesh: InstancedMesh) {
  mesh.updateWorldMatrix(true, false);
  const matrix = new Matrix4();
  return Array.from({ length: mesh.count }, (_, index) => {
    mesh.getMatrixAt(index, matrix);
    const world = mesh.matrixWorld.clone().multiply(matrix);
    const at = new Vector3();
    const turn = new Quaternion();
    const size = new Vector3();
    world.decompose(at, turn, size);
    return { at, turn, size };
  });
}

beforeAll(async () => {
  models = await loadModelsFromDisk();
});

beforeEach(() => {
  resetSceneSettings();
  provideModels(models);
});

afterEach(async () => {
  await act(async () => {
    await renderer?.unmount();
  });
  renderer = undefined;
});

describe("an Agent waiting on review", () => {
  it("leans back with its hands behind its head, unlike one with nothing queued", async () => {
    const [, coder, reviewer] = team;
    const scene = await renderFloor(
      looksOf({ [coder?.id ?? ""]: { awaitingReview: 1 } }),
    );
    await act(async () => {
      await scene.advanceFrames(30, 1 / 60);
    });
    const pose = (id: string) => {
      const seated = object(scene, `agent-${id}`);
      const local = (bone: string) =>
        seated.worldToLocal(
          seated.getObjectByName(bone)?.getWorldPosition(new Vector3()) ??
            new Vector3(),
        );
      return {
        hand: local("rightHand"),
        head: local("head"),
        elbow: local("rightForearm"),
        shoulder: local("rightUpperArm"),
      };
    };
    const waiting = pose(coder?.id ?? "");
    // The hand up by the head and behind it; the elbow out past the shoulder.
    expect(waiting.hand.y).toBeGreaterThan(waiting.head.y);
    expect(waiting.hand.z).toBeLessThan(waiting.head.z);
    expect(waiting.elbow.y).toBeGreaterThan(waiting.shoulder.y);
    expect(Math.abs(waiting.elbow.x)).toBeGreaterThan(
      Math.abs(waiting.shoulder.x) + 0.05,
    );
    // The reviewer, with nothing queued, sits with its hands in its lap.
    const sitting = pose(reviewer?.id ?? "");
    expect(sitting.hand.y).toBeLessThan(sitting.shoulder.y - 0.2);
  });
});

describe("the piles of tickets", () => {
  it("piles a ticket on each desk for each task that waits, up to ten, on the desk's left", async () => {
    const [, coder, reviewer, qa] = team;
    const scene = await renderFloor(
      looksOf({
        [coder?.id ?? ""]: { queued: 3 },
        [reviewer?.id ?? ""]: { queued: 1 },
        [qa?.id ?? ""]: { queued: 40 },
      }),
    );
    const piles = object(scene, "ticket-piles") as InstancedMesh;
    expect(piles.count).toBe(3 + 1 + 10);
    expect(piles.castShadow).toBe(false);
    const layout = floorLayout(team);
    const tickets = instances(piles);
    for (const each of layout.desks) {
      const own = tickets.filter(
        ({ at }) =>
          at.x > each.desk.x[0] &&
          at.x < each.desk.x[1] &&
          at.z > each.desk.z[0] &&
          at.z < each.desk.z[1],
      );
      const expected =
        each.agentId === coder?.id
          ? 3
          : each.agentId === reviewer?.id
            ? 1
            : each.agentId === qa?.id
              ? 10
              : 0;
      expect(own, each.agentId).toHaveLength(expected);
      // Stacked from the desk's top, 5 mm each, A4.
      own.forEach(({ at, size }, index) => {
        expect(at.y).toBeCloseTo(desk.top + ticketSize[1] * (index + 0.5), 6);
        expect(size.x).toBeCloseTo(ticketPile.size[0], 6);
        expect(size.y).toBeCloseTo(0.005, 6);
        expect(size.z).toBeCloseTo(ticketPile.size[1], 6);
      });
      // On the Agent's left: the desk faces the chair, so its left is the
      // seat's right turned by the desk.
      const left = new Vector3(-1, 0, 0).applyAxisAngle(
        new Vector3(0, 1, 0),
        (each.turns * Math.PI) / 2,
      );
      for (const { at } of own) {
        const fromSeat = new Vector3(
          at.x - each.seat[0],
          0,
          at.z - each.seat[2],
        );
        expect(fromSeat.dot(left)).toBeGreaterThan(0.3);
      }
    }
  });

  it("grows and shrinks as the queue does, and is gone when it is empty", async () => {
    const [, coder] = team;
    const scene = await renderFloor(
      looksOf({ [coder?.id ?? ""]: { queued: 2 } }),
    );
    const piles = () => object(scene, "ticket-piles") as InstancedMesh;
    expect(piles().count).toBe(2);
    await rerender(scene, looksOf({ [coder?.id ?? ""]: { queued: 7 } }));
    expect(piles().count).toBe(7);
    await rerender(scene, looksOf({}));
    expect(piles().count).toBe(0);
  });
});

describe("the markers over paused and capped Agents", () => {
  it("puts a disc with a pause's two bars over a paused Agent, and an octagon with a bar across over a capped one", async () => {
    const [, coder, reviewer, qa] = team;
    const scene = await renderFloor(
      looksOf({
        [coder?.id ?? ""]: { enabled: false },
        [reviewer?.id ?? ""]: { capped: true },
        [qa?.id ?? ""]: { capped: true, enabled: false },
      }),
    );
    const paused = object(scene, "agent-markers-paused") as InstancedMesh;
    const capped = object(scene, "agent-markers-capped") as InstancedMesh;
    expect(paused.count).toBe(1);
    expect(capped.count).toBe(2);
    // Each its own shape: a round disc, and an eight-sided sign.
    const sides = (mesh: InstancedMesh) =>
      (mesh.geometry as CylinderGeometry).parameters.radialSegments;
    expect(sides(paused)).toBeGreaterThan(16);
    expect(sides(capped)).toBe(8);
    expect(
      (object(scene, "agent-marker-symbols-paused") as InstancedMesh).count,
    ).toBe(2);
    expect(
      (object(scene, "agent-marker-symbols-capped") as InstancedMesh).count,
    ).toBe(2);
    // In `state-critical`, glowing, with paper symbols.
    const glow = paused.material as MeshBasicMaterial;
    expect(glow).toBe(capped.material);
    expect(glow.color.getHex()).not.toBe(
      new Color(palette["state-critical"]).getHex(),
    );
    expect(
      glow.color
        .clone()
        .multiplyScalar(1 / emissiveIntensity.lamp)
        .getHexString(),
    ).toBe(new Color(palette["state-critical"]).getHexString());
    // Over its own Agent's seat, clear of its head.
    const layout = floorLayout(team);
    const seatOf = (id: string) =>
      layout.desks.find(({ agentId }) => agentId === id)?.seat ?? [0, 0, 0];
    const [marker] = instances(paused);
    const seat = seatOf(coder?.id ?? "");
    expect(marker?.at.x).toBeCloseTo(seat[0], 6);
    expect(marker?.at.z).toBeCloseTo(seat[2], 6);
    expect(marker?.at.y).toBeCloseTo(markerHeight, 6);
    await act(async () => {
      await scene.advanceFrames(1, 1 / 60);
    });
    const head = object(scene, `agent-${coder?.id ?? ""}`)
      .getObjectByName("head")
      ?.getWorldPosition(new Vector3());
    // The head bone is at the neck: its top is a head's height above it.
    expect((head?.y ?? 0) + 0.3).toBeLessThan(markerHeight - markerSize.radius);
    expect(markerHeight + markerSize.radius).toBeLessThan(floorCeiling);
    // No marker over an Agent that is neither.
    const markerPlaces = [...instances(paused), ...instances(capped)].map(
      ({ at }) => `${at.x.toFixed(3)},${at.z.toFixed(3)}`,
    );
    for (const id of [team[0]?.id ?? "", team[4]?.id ?? ""]) {
      const [x, , z] = seatOf(id);
      expect(markerPlaces).not.toContain(`${x.toFixed(3)},${z.toFixed(3)}`);
    }
  });

  it("faces the camera, so it reads from the default view", async () => {
    const [, coder] = team;
    const scene = await renderFloor(
      looksOf({ [coder?.id ?? ""]: { capped: true } }),
    );
    await act(async () => {
      await scene.advanceFrames(1, 1 / 60);
    });
    const toCamera = new Vector3(14, 16, 18).normalize();
    for (const name of [
      "agent-markers-capped",
      "agent-marker-symbols-capped",
    ]) {
      for (const { turn } of instances(object(scene, name) as InstancedMesh)) {
        const facing = new Vector3(0, 0, 1).applyQuaternion(turn);
        expect(facing.dot(toCamera)).toBeGreaterThan(0.98);
      }
    }
    // The symbol is on the sign's face towards the camera.
    const [sign] = instances(
      object(scene, "agent-markers-capped") as InstancedMesh,
    );
    const [bar] = instances(
      object(scene, "agent-marker-symbols-capped") as InstancedMesh,
    );
    expect(
      (bar?.at ?? new Vector3()).sub(sign?.at ?? new Vector3()).dot(toCamera),
    ).toBeGreaterThan(markerSize.thickness / 2 - 1e-6);
  });

  it("comes and goes with the pause", async () => {
    const [, coder] = team;
    const scene = await renderFloor(looksOf({}));
    expect(
      scene.scene.instance.getObjectByName("agent-markers-paused"),
    ).toBeUndefined();
    await rerender(scene, looksOf({ [coder?.id ?? ""]: { enabled: false } }));
    expect((object(scene, "agent-markers-paused") as InstancedMesh).count).toBe(
      1,
    );
    await rerender(scene, looksOf({}));
    expect(
      scene.scene.instance.getObjectByName("agent-markers-paused"),
    ).toBeUndefined();
  });
});

describe("the red light at the Manager's office", () => {
  const lens = (scene: Renderer) =>
    (object(scene, "managers-light") as Mesh).material as MeshBasicMaterial;

  it("is over the office's door, above its frame, facing the open plan", async () => {
    const scene = await renderFloor(looksOf({}), true);
    const light = object(scene, "managers-light") as Mesh;
    const at = light.getWorldPosition(new Vector3());
    const [doorLeft, doorRight] = managersOffice.door;
    expect(at.x).toBeGreaterThan(doorLeft);
    expect(at.x).toBeLessThan(doorRight);
    const [, height, depth] = managersLight.size;
    expect(at.y - height / 2).toBeGreaterThan(2.1);
    expect(at.y + height / 2).toBeLessThan(floorCeiling);
    // In front of the office's glass, on the open plan's side.
    expect(at.z - depth / 2).toBeGreaterThan(managersOffice.z[1]);
  });

  it("is red and pulses while the Floor has an action Notice, and dark otherwise", async () => {
    const scene = await renderFloor(looksOf({}), false);
    expect(lens(scene).color.getHexString()).toBe(
      new Color(palette["screen-off"]).getHexString(),
    );
    await rerender(scene, looksOf({}), true);
    const red = new Color(palette["state-critical"]);
    const brightness = () => lens(scene).color.r / red.r;
    const readings: number[] = [];
    for (let frame = 0; frame < 6; frame += 1) {
      await act(async () => {
        await scene.advanceFrames(10, 1 / 30);
      });
      readings.push(brightness());
      // Red: each channel in state-critical's proportions.
      expect(lens(scene).color.g / lens(scene).color.r).toBeCloseTo(
        red.g / red.r,
        5,
      );
    }
    for (const each of readings) {
      expect(each).toBeGreaterThanOrEqual(lightPulse.low - 1e-6);
      expect(each).toBeLessThanOrEqual(lightPulse.high + 1e-6);
    }
    expect(Math.max(...readings) - Math.min(...readings)).toBeGreaterThan(0.1);
    // The action Notice dealt with, it goes dark again.
    await rerender(scene, looksOf({}), false);
    await act(async () => {
      await scene.advanceFrames(2, 1 / 30);
    });
    expect(lens(scene).color.getHexString()).toBe(
      new Color(palette["screen-off"]).getHexString(),
    );
  });

  it("holds steady with reduced motion", async () => {
    useSceneSettings.getState().setReducedMotion(true);
    const scene = await renderFloor(looksOf({}), true);
    const red = new Color(palette["state-critical"]);
    for (let frame = 0; frame < 4; frame += 1) {
      await act(async () => {
        await scene.advanceFrames(7, 1 / 30);
      });
      expect(lens(scene).color.r / red.r).toBeCloseTo(
        emissiveIntensity.lamp,
        5,
      );
    }
  });

  it("pulses within the spec's emissive range, once every 1.4 s", () => {
    const samples = Array.from({ length: 141 }, (_, index) =>
      lightIntensity(index / 100, false),
    );
    expect(Math.min(...samples)).toBeCloseTo(1.2, 5);
    expect(Math.max(...samples)).toBeCloseTo(2.0, 3);
    expect(lightIntensity(0, false)).toBeCloseTo(
      lightIntensity(lightPulse.seconds, false),
      6,
    );
    expect(lightIntensity(0.3, true)).toBe(emissiveIntensity.lamp);
  });
});
