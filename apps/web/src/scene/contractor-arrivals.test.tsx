import ReactThreeTestRenderer from "@react-three/test-renderer";
import type { Mesh, Object3D } from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  insideLift,
  liftRoute,
  walkLength,
  type ContractorSignal,
} from "./contractor-walks.ts";
import { Floor } from "./floor.tsx";
import { floorLayout, type FloorAgent } from "./floor-layout.ts";
import { liftDoor, liftDoorway } from "./lift-layout.ts";
import { liftStops } from "./lift-stops.ts";
import { provideModels, type LoadedModels } from "./models.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// Contractors coming and going on a Floor (PRD FR-10, FR-57; ADR 0004),
// rendered without WebGL by React Three Fiber's test renderer: one the
// Manager adds steps out of the lift, the doors opening for it, and walks
// to its own desk; one that leaves walks back into the lift, its desk kept
// until then and removed after; with reduced motion no one walks.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const contractor: FloorAgent = {
  id: "migration-writer",
  role: "contractor-1a2b3c4d5e",
  contractor: { kind: "work", batchId: 3, oneOffRole: null },
};
const owners: FloorAgent[] = [
  { id: "manager", role: "manager" },
  { id: "coder", role: "coder" },
  { id: "reviewer", role: "reviewer" },
];
const withContractor = [...owners, contractor];
const layout = floorLayout(withContractor);
const stops = liftStops([], []);

const arrived = (id: number): ContractorSignal => ({
  type: "arrive",
  id,
  floorId: "web-shop",
  agentId: "migration-writer",
});
const left = (id: number): ContractorSignal => ({
  ...arrived(id),
  type: "leave",
});

const way = () => {
  const route = liftRoute(layout, "migration-writer");
  if (route === undefined) {
    throw new Error("No way to the lift.");
  }
  return route;
};

let renderer: Renderer | undefined;
let models: LoadedModels;

const floor = (
  team: readonly FloorAgent[],
  contractors: readonly ContractorSignal[],
) => (
  <Floor
    floorId="web-shop"
    team={team}
    contractors={contractors}
    stops={stops}
  />
);

const rerender = async (
  scene: Renderer,
  team: readonly FloorAgent[],
  contractors: readonly ContractorSignal[],
) => {
  await act(async () => {
    await scene.update(floor(team, contractors));
  });
};

const play = async (scene: Renderer, seconds: number) => {
  await act(async () => {
    await scene.advanceFrames(Math.round(seconds / 0.1), 0.1);
  });
};

const find = (scene: Renderer, name: string): Object3D | undefined =>
  scene.scene.instance.getObjectByName(name);

const placeOf = (scene: Renderer, agentId: string): FloorPoint => {
  const agent = find(scene, `agent-${agentId}`);
  if (agent === undefined) {
    throw new Error(`No ${agentId} in the scene.`);
  }
  return [agent.position.x, agent.position.z];
};

const seat = (): FloorPoint => {
  const desk = layout.desks.find(
    ({ agentId }) => agentId === "migration-writer",
  );
  if (desk === undefined) {
    throw new Error("No desk.");
  }
  return [desk.seat[0], desk.seat[2]];
};

/** How far the lift's left door has slid open. */
const doorsOpen = (scene: Renderer): number => {
  const door = find(scene, "lift-door-left");
  const closed = liftDoorway.position[0] - liftDoor.size[0] / 2;
  return door === undefined ? 0 : closed - door.position.x;
};

/** How much the Floor's fixed pieces hold, desks included: their vertices. */
const piecesSize = (scene: Renderer): number => {
  let vertices = 0;
  find(scene, "pieces")?.traverse((each) => {
    const position = (each as Partial<Mesh>).geometry?.getAttribute("position");
    vertices += position?.count ?? 0;
  });
  return vertices;
};

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
  document.body.innerHTML = "";
});

describe("Contractors coming and going on a Floor", () => {
  it("a new Contractor steps out of the lift, the doors open, and walks to its own desk", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(owners, []));
    renderer = scene;
    await play(scene, 0.2);
    await rerender(scene, withContractor, [arrived(1)]);
    await play(scene, 0.2);
    expect(
      distance(placeOf(scene, "migration-writer"), insideLift),
    ).toBeLessThan(0.5);
    expect(doorsOpen(scene)).toBeGreaterThan(0.3);
    await play(scene, walkLength({ type: "arrive", route: way() }) + 0.5);
    expect(distance(placeOf(scene, "migration-writer"), seat())).toBeLessThan(
      1e-6,
    );
    expect(doorsOpen(scene)).toBe(0);
  });

  it("a leaving Contractor walks back into the lift, keeping its desk until then; then its desk goes", async () => {
    const scene = await ReactThreeTestRenderer.create(
      floor(withContractor, []),
    );
    renderer = scene;
    await play(scene, 0.2);
    const withItsDesk = piecesSize(scene);
    // Its agent.removed comes first: the team drops it before its walk.
    await rerender(scene, owners, []);
    expect(find(scene, "agent-migration-writer")).toBeDefined();
    expect(piecesSize(scene)).toBe(withItsDesk);
    await rerender(scene, owners, [left(2)]);
    await play(scene, 3);
    expect(
      distance(placeOf(scene, "migration-writer"), seat()),
    ).toBeGreaterThan(0.3);
    await play(scene, walkLength({ type: "leave", route: way() }));
    expect(find(scene, "agent-migration-writer")).toBeUndefined();
    expect(piecesSize(scene)).toBeLessThan(withItsDesk);
  });

  it("an Agent the Owner removes goes at once, as before", async () => {
    const scene = await ReactThreeTestRenderer.create(
      floor(withContractor, []),
    );
    renderer = scene;
    await rerender(
      scene,
      withContractor.filter(({ id }) => id !== "coder"),
      [],
    );
    expect(find(scene, "agent-coder")).toBeUndefined();
  });

  it("with reduced motion a Contractor is at its desk at once, and gone at once", async () => {
    useSceneSettings.setState({ reducedMotion: true });
    const scene = await ReactThreeTestRenderer.create(floor(owners, []));
    renderer = scene;
    await rerender(scene, withContractor, [arrived(1)]);
    await play(scene, 1);
    expect(distance(placeOf(scene, "migration-writer"), seat())).toBe(0);
    await rerender(scene, owners, [arrived(1), left(2)]);
    expect(find(scene, "agent-migration-writer")).toBeUndefined();
  });

  it("never walks the Contractors that came before the Floor was shown", async () => {
    const scene = await ReactThreeTestRenderer.create(
      floor(withContractor, [arrived(1)]),
    );
    renderer = scene;
    await play(scene, 1);
    expect(distance(placeOf(scene, "migration-writer"), seat())).toBe(0);
  });
});
