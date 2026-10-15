import type { Role } from "@ai-office/shared";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import type { Object3D } from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Floor } from "./floor.tsx";
import { floorLayout, type FloorAgent } from "./floor-layout.ts";
import type { HandoffTicket } from "./handoff-walks.ts";
import { idleActivities } from "./idle-behaviours.ts";
import { liftStops } from "./lift-stops.ts";
import {
  arrival,
  homeward,
  meetingPlanner,
  minimumStay,
  wrapUpSeconds,
  type MeetingSignal,
} from "./meeting-walks.ts";
import { provideModels, type LoadedModels } from "./models.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// The Kickoff and the Wrap-up on a Floor (PRD FR-60), rendered without
// WebGL by React Three Fiber's test renderer: the Agents a Plan assigns
// walk to the meeting room and sit at the table, the Manager standing at
// the whiteboard, until the Kickoff ends, then walk back to their desks;
// a Wrap-up gathers them again for a while; a Handoff from an Agent in
// the meeting room is handed over at once; with reduced motion no one
// walks.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const roles: Role[] = ["manager", "coder", "reviewer", "qa"];
const team: FloorAgent[] = roles.map((role) => ({ id: role, role }));
const layout = floorLayout(team);
const plan = meetingPlanner(layout);
const stops = liftStops([], []);

const kickoff = (id: number): MeetingSignal => ({
  type: "gather",
  id,
  floorId: "web-shop",
  batchId: 3,
  kind: "kickoff",
  managerId: "manager",
  agentIds: ["coder", "qa"],
});
const ended = (id: number): MeetingSignal => ({
  type: "end",
  id,
  floorId: "web-shop",
  batchId: 3,
  kind: "kickoff",
});

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

// No idle activities: an idle Agent would otherwise wander off at random
// during the meetings these tests play.
const allActivitiesOff = idleActivities.map(({ name }) => name);

let renderer: Renderer | undefined;
let models: LoadedModels;

const floor = (
  meetings: readonly MeetingSignal[],
  handoffs: readonly HandoffTicket[] = [],
) => (
  <Floor
    floorId="web-shop"
    team={team}
    meetings={meetings}
    handoffs={handoffs}
    stops={stops}
    disabledActivities={allActivitiesOff}
  />
);

const rerender = async (
  scene: Renderer,
  meetings: readonly MeetingSignal[],
  handoffs?: readonly HandoffTicket[],
) => {
  await act(async () => {
    await scene.update(floor(meetings, handoffs));
  });
};

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

const placeOf = (scene: Renderer, agentId: string): FloorPoint => {
  const agent = object(scene, `agent-${agentId}`);
  return [agent.position.x, agent.position.z];
};

const seatOf = (agentId: string): FloorPoint => {
  const desk = defined(layout.desks.find((each) => each.agentId === agentId));
  return [desk.seat[0], desk.seat[2]];
};

const places = plan.places("manager", ["coder", "qa"]);
const placeAt = (agentId: string): FloorPoint =>
  defined(places.get(agentId)).at;
const routeOf = (agentId: string) =>
  defined(plan.route(agentId, defined(places.get(agentId))));
/** Long enough for everyone to have reached their place. */
const gathered = Math.max(
  ...["manager", "coder", "qa"].map((agentId) => arrival(routeOf(agentId))),
);
const allHome = Math.max(
  ...["manager", "coder", "qa"].map((agentId) => homeward(routeOf(agentId))),
);

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

describe("meetings on a Floor", () => {
  it("a Kickoff: the assigned Agents walk to the table and sit, the Manager at the whiteboard, until it ends; then back to their desks", async () => {
    const scene = await ReactThreeTestRenderer.create(floor([]));
    renderer = scene;
    await play(scene, 0.5);
    await rerender(scene, [kickoff(1)]);

    await play(scene, 3);
    // On their way; the reviewer, not assigned, stays at its desk.
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeGreaterThan(
      0.3,
    );
    expect(distance(placeOf(scene, "reviewer"), seatOf("reviewer"))).toBe(0);

    await play(scene, gathered);
    for (const agentId of ["manager", "coder", "qa"]) {
      expect(distance(placeOf(scene, agentId), placeAt(agentId))).toBeLessThan(
        1e-6,
      );
    }
    // However long the Kickoff takes, they stay.
    await play(scene, 30);
    expect(distance(placeOf(scene, "coder"), placeAt("coder"))).toBeLessThan(
      1e-6,
    );

    await rerender(scene, [kickoff(1), ended(2)]);
    await play(scene, 3);
    expect(distance(placeOf(scene, "coder"), placeAt("coder"))).toBeGreaterThan(
      0.3,
    );
    await play(scene, allHome);
    for (const agentId of ["manager", "coder", "qa"]) {
      expect(distance(placeOf(scene, agentId), seatOf(agentId))).toBeLessThan(
        1e-6,
      );
    }
  });

  it("a Kickoff over at once still gathers them for a moment; a Wrap-up gathers them for a while by itself", async () => {
    const scene = await ReactThreeTestRenderer.create(floor([]));
    renderer = scene;
    await rerender(scene, [kickoff(1), ended(2)]);
    await play(scene, gathered + minimumStay / 2);
    expect(distance(placeOf(scene, "qa"), placeAt("qa"))).toBeLessThan(1e-6);
    await play(scene, minimumStay + allHome);
    expect(distance(placeOf(scene, "qa"), seatOf("qa"))).toBeLessThan(1e-6);

    await rerender(scene, [
      kickoff(1),
      ended(2),
      { ...kickoff(3), kind: "wrap-up" },
    ]);
    await play(scene, gathered + wrapUpSeconds - 1);
    expect(distance(placeOf(scene, "qa"), placeAt("qa"))).toBeLessThan(1e-6);
    await play(scene, 1.5 + allHome);
    expect(distance(placeOf(scene, "qa"), seatOf("qa"))).toBeLessThan(1e-6);
  });

  it("a Handoff from an Agent in the meeting room is handed over at once, not walked", async () => {
    const scene = await ReactThreeTestRenderer.create(floor([]));
    renderer = scene;
    await rerender(scene, [kickoff(1)]);
    await play(scene, gathered);
    await rerender(
      scene,
      [kickoff(1)],
      [
        {
          id: 10,
          floorId: "web-shop",
          issue: 4,
          stage: "needs-review",
          fromAgentId: "coder",
          toAgentId: "reviewer",
        },
      ],
    );
    await play(scene, 2);
    expect(distance(placeOf(scene, "coder"), placeAt("coder"))).toBeLessThan(
      1e-6,
    );
    expect(scene.scene.instance.getObjectByName("handoff-ticket-coder")).toBe(
      undefined,
    );
  });

  it("with reduced motion no one walks to a meeting", async () => {
    useSceneSettings.setState({ reducedMotion: true });
    const scene = await ReactThreeTestRenderer.create(floor([]));
    renderer = scene;
    await rerender(scene, [kickoff(1)]);
    await play(scene, gathered);
    for (const agentId of ["manager", "coder", "qa"]) {
      expect(distance(placeOf(scene, agentId), seatOf(agentId))).toBe(0);
    }
  });

  it("never gathers for the meetings that came before the Floor was shown", async () => {
    const scene = await ReactThreeTestRenderer.create(floor([kickoff(1)]));
    renderer = scene;
    await play(scene, gathered);
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBe(0);
  });
});
