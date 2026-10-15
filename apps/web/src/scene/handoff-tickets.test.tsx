import type { Role } from "@ai-office/shared";
import { palette } from "@ai-office/shared/palette";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { screen } from "@testing-library/react";
import {
  Color,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedMesh,
  type Object3D,
} from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deskFacing } from "./desk-set.ts";
import { Floor } from "./floor.tsx";
import { floorLayout, type FloorAgent } from "./floor-layout.ts";
import {
  HandoffWalks,
  ticketLabel,
  ticketLabelAt,
} from "./handoff-tickets.tsx";
import {
  catchUpPace,
  createHandoffWalker,
  handoffRoute,
  handoffWalk,
  monitorLight,
  type HandoffTicket,
} from "./handoff-walks.ts";
import { liftStops } from "./lift-stops.ts";
import type { MonitorScreen } from "./monitor-preview.ts";
import { screenGlow } from "./monitor-screens.tsx";
import { provideModels, type LoadedModels } from "./models.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// Handoff walks on a Floor (PRD FR-59), rendered without WebGL by React
// Three Fiber's test renderer: the Agent gets up, carries its ticket to
// the next Agent's desk, hands it over (the receiving monitor lights up),
// walks back and sits down; the pipeline's state shows at once, whatever
// the walk; walks that fall behind are skipped; and the ticket's label is
// the issue's number, in HTML.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const roles: Role[] = ["manager", "coder", "reviewer", "qa", "docs"];
const team: FloorAgent[] = roles.map((role) => ({ id: role, role }));
const layout = floorLayout(team);
const stops = liftStops([], []);

let nextId = 1;
const ticket = (
  fromAgentId: string,
  toAgentId: string,
  more: Partial<HandoffTicket> = {},
): HandoffTicket => ({
  id: nextId++,
  floorId: "web-shop",
  issue: 42,
  stage: "needs-review",
  fromAgentId,
  toAgentId,
  ...more,
});

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

const working = (agentId: string): MonitorScreen => ({
  agentId,
  working: true,
  lines: [],
  activity: 0,
});

let renderer: Renderer | undefined;
let models: LoadedModels;

const floor = (
  handoffs: readonly HandoffTicket[],
  monitors: ReadonlyMap<string, MonitorScreen> = new Map(),
) => (
  <Floor
    floorId="web-shop"
    team={team}
    monitors={monitors}
    handoffs={handoffs}
    stops={stops}
  />
);

async function renderFloor(
  handoffs: readonly HandoffTicket[] = [],
): Promise<Renderer> {
  renderer = await ReactThreeTestRenderer.create(floor(handoffs));
  return renderer;
}

const rerender = async (
  scene: Renderer,
  handoffs: readonly HandoffTicket[],
  monitors?: ReadonlyMap<string, MonitorScreen>,
) => {
  await act(async () => {
    await scene.update(floor(handoffs, monitors));
  });
};

/** Moves the scene on by `seconds`, a tenth of a second a frame. */
const play = async (scene: Renderer, seconds: number) => {
  await act(async () => {
    await scene.advanceFrames(Math.round(seconds / 0.1), 0.1);
  });
};

function object(scene: Renderer, name: string): Object3D {
  const found = scene.scene.instance.getObjectByName(name);
  if (found === undefined) {
    throw new Error(`The scene has nothing named "${name}".`);
  }
  return found;
}

/** Where an Agent stands on the floor, and which way it faces. */
function placeOf(scene: Renderer, agentId: string) {
  const agent = object(scene, `agent-${agentId}`);
  return {
    at: [agent.position.x, agent.position.z] as FloorPoint,
    heading: agent.rotation.y,
    carrying: agent.getObjectByName("ticket")?.visible === true,
  };
}

const seatOf = (agentId: string): FloorPoint => {
  const desk = layout.desks.find((each) => each.agentId === agentId);
  return [desk?.seat[0] ?? NaN, desk?.seat[2] ?? NaN];
};

/** The glowing monitors' displays: whose desk each is at, and how bright. */
function litMonitors(scene: Renderer) {
  const mesh = object(scene, "monitor-displays") as InstancedMesh;
  mesh.updateWorldMatrix(true, false);
  const matrix = new Matrix4();
  const colour = new Color();
  const glow = new Color(palette["screen-glow"]);
  return Array.from({ length: mesh.count }, (_, index) => {
    mesh.getMatrixAt(index, matrix);
    mesh.getColorAt(index, colour);
    const at = new Vector3();
    mesh.matrixWorld
      .clone()
      .multiply(matrix)
      .decompose(at, new Quaternion(), new Vector3());
    const desk = layout.desks.reduce((best, each) =>
      distance([each.seat[0], each.seat[2]], [at.x, at.z]) <
      distance([best.seat[0], best.seat[2]], [at.x, at.z])
        ? each
        : best,
    );
    return { agentId: desk.agentId, brightness: colour.r / glow.r };
  });
}

const litFor = (scene: Renderer) =>
  litMonitors(scene)
    .map(({ agentId }) => agentId)
    .sort();

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

describe("a Handoff walk on a Floor", () => {
  it("gets up, carries the ticket to the next desk, hands it over, walks back and sits down", async () => {
    const scene = await renderFloor();
    await play(scene, 0.5);
    const seat = seatOf("coder");
    expect(distance(placeOf(scene, "coder").at, seat)).toBeLessThan(1e-6);

    const handed = ticket("coder", "reviewer");
    await rerender(scene, [handed]);
    const route = handoffRoute(layout, "coder", "reviewer");
    if (route === undefined) {
      throw new Error("No way from the coder to the reviewer.");
    }
    const walk = handoffWalk(handed, route);
    const end = route.path.at(-1) ?? seat;

    // Standing up at its desk.
    await play(scene, 0.6);
    expect(distance(placeOf(scene, "coder").at, seat)).toBeLessThan(1e-6);
    expect(placeOf(scene, "coder").carrying).toBe(false);

    // On its way, the ticket in its hands; the reviewer's monitor still dark.
    await play(scene, 1.4);
    const going = placeOf(scene, "coder");
    expect(distance(going.at, seat)).toBeGreaterThan(0.3);
    expect(going.carrying).toBe(true);
    expect(litFor(scene)).toEqual([]);

    // Handing it over, beside the reviewer's chair, facing it.
    await play(scene, walk.handOverAt - 2.3);
    const handing = placeOf(scene, "coder");
    expect(distance(handing.at, end)).toBeLessThan(1e-6);
    expect(handing.heading).toBeCloseTo(route.handOverHeading, 6);
    expect(handing.carrying).toBe(true);
    expect(litFor(scene)).toEqual([]);

    // Handed over: the receiving monitor lights up, the hands are empty.
    await play(scene, 0.5);
    expect(litFor(scene)).toEqual(["reviewer"]);
    const [lit] = litMonitors(scene);
    expect(lit?.brightness).toBeCloseTo(screenGlow.base + screenGlow.pulse, 2);
    const leaving = placeOf(scene, "coder");
    expect(leaving.carrying).toBe(false);
    await play(scene, 1);
    expect(distance(placeOf(scene, "coder").at, end)).toBeGreaterThan(0.3);

    // The light fades and goes; the coder is back in its chair, facing its desk.
    await play(scene, monitorLight.seconds);
    expect(litFor(scene)).toEqual([]);
    await play(scene, walk.duration - walk.handOverAt - 4 + 0.3);
    const home = placeOf(scene, "coder");
    expect(distance(home.at, seat)).toBeLessThan(1e-6);
    expect(home.heading).toBeCloseTo(deskFacing(0), 6);
    expect(home.carrying).toBe(false);
  });

  it("never walks the Handoffs that came before the Floor was shown", async () => {
    const scene = await renderFloor([ticket("coder", "reviewer")]);
    await play(scene, 3);
    expect(distance(placeOf(scene, "coder").at, seatOf("coder"))).toBeLessThan(
      1e-6,
    );
    expect(litFor(scene)).toEqual([]);
  });

  it("never holds up the work: the monitors show it at once, while the walk plays on", async () => {
    const scene = await renderFloor();
    const handed = ticket("coder", "reviewer");
    await rerender(scene, [handed]);
    await play(scene, 2);
    expect(placeOf(scene, "coder").carrying).toBe(true);
    // The reviewer starts at once, and the coder has new work, while the
    // coder is still on its way.
    await rerender(
      scene,
      [handed],
      new Map([
        ["reviewer", working("reviewer")],
        ["coder", working("coder")],
      ]),
    );
    await play(scene, 0.1);
    expect(litFor(scene)).toEqual(["coder", "reviewer"]);
    expect(placeOf(scene, "coder").carrying).toBe(true);
  });

  it("skips forward when it falls behind: only the first and the newest are walked", async () => {
    const scene = await renderFloor();
    const tickets = [
      ticket("coder", "reviewer"),
      ticket("coder", "qa"),
      ticket("coder", "docs"),
      ticket("coder", "manager"),
    ];
    await rerender(scene, tickets);
    await play(scene, 0.1);
    // QA's and docs' tickets fell behind: handed over at once.
    expect(litFor(scene)).toEqual(["docs", "qa"]);
    // The walk under way hurries while the newest waits.
    const route = handoffRoute(layout, "coder", "reviewer");
    if (route === undefined) {
      throw new Error("No way from the coder to the reviewer.");
    }
    const first = handoffWalk(defined(tickets[0]), route);
    await play(scene, first.handOverAt / catchUpPace + 0.1);
    expect(litFor(scene)).toContain("reviewer");
    // Then the newest, to the Manager's office.
    await play(scene, (first.duration - first.handOverAt) / catchUpPace);
    await play(scene, 2);
    expect(placeOf(scene, "coder").carrying).toBe(true);
    const managerRoute = handoffRoute(layout, "coder", "manager");
    if (managerRoute === undefined) {
      throw new Error("No way from the coder to the Manager.");
    }
    const last = handoffWalk(defined(tickets[3]), managerRoute);
    await play(scene, last.handOverAt - 2 + 0.2);
    expect(litFor(scene)).toContain("manager");
  });

  it("walks no one with reduced motion: the ticket is handed over at once", async () => {
    useSceneSettings.getState().setReducedMotion(true);
    const scene = await renderFloor();
    await rerender(scene, [ticket("coder", "reviewer")]);
    await play(scene, 0.2);
    expect(distance(placeOf(scene, "coder").at, seatOf("coder"))).toBeLessThan(
      1e-6,
    );
    expect(litFor(scene)).toEqual(["reviewer"]);
    // Steady, then dark.
    const [lit] = litMonitors(scene);
    expect(lit?.brightness).toBeCloseTo(screenGlow.base + screenGlow.pulse, 2);
    await play(scene, monitorLight.seconds - monitorLight.fade / 2);
    expect(litMonitors(scene)[0]?.brightness).toBeCloseTo(
      screenGlow.base + screenGlow.pulse,
      2,
    );
    await play(scene, monitorLight.fade);
    expect(litFor(scene)).toEqual([]);
  });
});

describe("the ticket's label", () => {
  it("is the issue's number, in the colour of the stage it goes to", () => {
    expect(ticketLabel({ issue: 42, stage: "needs-review" })).toEqual({
      text: "#42",
      className: "bg-office-stage-review text-office-paper",
    });
    expect(ticketLabel({ issue: 7, stage: "needs-qa" }).className).toBe(
      "bg-office-stage-qa text-office-paper",
    );
    expect(ticketLabel({ issue: 9, stage: "ready-to-merge" })).toEqual({
      text: "#9",
      className: "bg-office-paper text-office-ink",
    });
  });

  it("floats over the ticket as it is carried, in HTML, and goes once it is handed over", async () => {
    const walker = createHandoffWalker("web-shop");
    const labelsIn = { current: document.body };
    const walks = (handoffs: readonly HandoffTicket[]) => (
      <HandoffWalks
        walker={walker}
        layout={layout}
        handoffs={handoffs}
        labelsIn={labelsIn}
      />
    );
    renderer = await ReactThreeTestRenderer.create(walks([]));
    const handed = ticket("coder", "reviewer", { issue: 14 });
    await act(async () => {
      await renderer?.update(walks([handed]));
    });
    // Not while it stands up: the ticket is not in its hands yet.
    await play(renderer, 0.5);
    expect(screen.queryByText("#14")).toBeNull();
    await play(renderer, 1.5);
    const label = screen.getByText("#14");
    expect(label.className).toContain("bg-office-stage-review");
    expect(label.getAttribute("aria-hidden")).toBe("true");
    // Over the ticket, ahead of the Agent at the height it is held.
    const group = object(renderer, "handoff-ticket-coder");
    const pose = walker.poseOf("coder");
    expect(group.position.y).toBe(ticketLabelAt.height);
    expect(
      distance([group.position.x, group.position.z], pose?.position ?? [0, 0]),
    ).toBeCloseTo(ticketLabelAt.ahead, 6);
    // It goes with the Agent.
    const before = group.position.clone();
    await play(renderer, 1);
    expect(group.position.distanceTo(before)).toBeGreaterThan(0.5);

    const route = handoffRoute(layout, "coder", "reviewer");
    const walk = route === undefined ? undefined : handoffWalk(handed, route);
    await play(renderer, (walk?.handOverAt ?? 0) - 3 + 0.2);
    expect(screen.queryByText("#14")).toBeNull();
  });
});
