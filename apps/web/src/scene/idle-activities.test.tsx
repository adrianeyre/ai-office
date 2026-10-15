import type { Role } from "@ai-office/shared";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { screen } from "@testing-library/react";
import { Vector3, type Object3D } from "three";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { agentLook, type AgentLook } from "./agent-state.ts";
import { rally } from "./avatar-animations.ts";
import { Floor } from "./floor.tsx";
import { floorLayout, gamesHall, type FloorAgent } from "./floor-layout.ts";
import {
  bubbleHeight,
  IdleActivities,
  tableTennisBall,
} from "./idle-activities.tsx";
import {
  createIdleBehaviours,
  idleActivities,
  idleTrip,
  longIdleSeconds,
  restSeconds,
  type IdlePlanner,
} from "./idle-behaviours.ts";
import { liftStops } from "./lift-stops.ts";
import { meetingPlanner, type MeetingSignal } from "./meeting-walks.ts";
import { resetDeskReturn, useDeskReturnStore } from "./desk-return.ts";
import { provideModels, type LoadedModels } from "./models.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// Idle behaviours on a Floor (PRD FR-61), rendered without WebGL by React
// Three Fiber's test renderer: an Agent with nothing to do gets up for an
// activity after a rest, a new task has it back at its desk at once, a
// doze shows "zzz" in HTML, and with reduced motion no one leaves its
// chair.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const roles: Role[] = ["manager", "coder", "reviewer"];
const team: FloorAgent[] = roles.map((role) => ({ id: role, role }));
const layout = floorLayout(team);
const stops = liftStops([], []);

const look = (working: boolean): AgentLook =>
  agentLook({
    working,
    enabled: true,
    capped: false,
    awaitingReview: 0,
    queued: 0,
  });

/** Every Agent busy at work, but the coder, which has nothing to do. */
const coderIdle = (coderWorking = false): ReadonlyMap<string, AgentLook> =>
  new Map(
    team.map(({ id }) => [id, look(id === "coder" ? coderWorking : true)]),
  );

let renderer: Renderer | undefined;
let models: LoadedModels;

const floor = (looks: ReadonlyMap<string, AgentLook>) => (
  <Floor floorId="web-shop" team={team} looks={looks} stops={stops} />
);

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

const placeOf = (scene: Renderer, agentId: string): FloorPoint => {
  const agent = object(scene, `agent-${agentId}`);
  return [agent.position.x, agent.position.z];
};

const seatOf = (agentId: string): FloorPoint => {
  const desk = layout.desks.find((each) => each.agentId === agentId);
  return [desk?.seat[0] ?? NaN, desk?.seat[2] ?? NaN];
};

beforeAll(async () => {
  models = await loadModelsFromDisk();
});

beforeEach(() => {
  resetSceneSettings();
  resetDeskReturn();
  provideModels(models);
  // Every rest the shortest, and the first activity on offer: a coffee.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(async () => {
  await act(async () => {
    await renderer?.unmount();
  });
  renderer = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("idle behaviours on a Floor", () => {
  it("get an Agent with nothing to do up for an activity after a rest, and leave working Agents at their desks", async () => {
    renderer = await ReactThreeTestRenderer.create(floor(coderIdle()));
    await play(renderer, restSeconds.min - 1);
    expect(distance(placeOf(renderer, "coder"), seatOf("coder"))).toBeLessThan(
      1e-6,
    );
    await play(renderer, 6);
    expect(
      distance(placeOf(renderer, "coder"), seatOf("coder")),
    ).toBeGreaterThan(0.5);
    for (const busy of ["manager", "reviewer"]) {
      expect(distance(placeOf(renderer, busy), seatOf(busy))).toBeLessThan(
        1e-6,
      );
    }
  });

  it("bring the Agent back to its desk on the very next frame once it has a new task, with no walk back", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(coderIdle()));
    renderer = scene;
    await play(scene, restSeconds.min + 8);
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeGreaterThan(
      0.5,
    );
    await act(async () => {
      await scene.update(floor(coderIdle(true)));
    });
    // However short the frame, it is back: no time is spent walking back.
    await act(async () => {
      await scene.advanceFrames(1, 1e-6);
    });
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeLessThan(
      1e-6,
    );
    await play(scene, 60);
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeLessThan(
      1e-6,
    );
  });

  it("leave everyone in their chairs with reduced motion", async () => {
    useSceneSettings.getState().setReducedMotion(true);
    renderer = await ReactThreeTestRenderer.create(floor(coderIdle()));
    await play(renderer, restSeconds.max + 10);
    expect(distance(placeOf(renderer, "coder"), seatOf("coder"))).toBeLessThan(
      1e-6,
    );
  });
});

describe("Return to desks", () => {
  const kickoff: MeetingSignal = {
    type: "gather",
    id: 7,
    floorId: "web-shop",
    batchId: 3,
    kind: "kickoff",
    managerId: "manager",
    agentIds: ["reviewer"],
  };
  const withKickoff = (
    looks: ReadonlyMap<string, AgentLook>,
    meetings: readonly MeetingSignal[],
  ) => (
    <Floor
      floorId="web-shop"
      team={team}
      looks={looks}
      stops={stops}
      meetings={meetings}
    />
  );
  const returnToDesks = async () => {
    await act(async () => {
      useDeskReturnStore.getState().returnToDesks();
      await Promise.resolve();
    });
  };

  it("walks an Agent on an idle activity back to its desk, and it rests before it idles again; a Kickoff's Agents carry on", async () => {
    const scene = await ReactThreeTestRenderer.create(
      withKickoff(coderIdle(), []),
    );
    renderer = scene;
    await play(scene, 0.2);
    expect(useDeskReturnStore.getState().wandering).toBe(false);
    // The reviewer gathered for a Kickoff, the coder off for a coffee.
    await act(async () => {
      await scene.update(withKickoff(coderIdle(), [kickoff]));
    });
    await play(scene, restSeconds.min + 8);
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeGreaterThan(
      0.5,
    );
    expect(useDeskReturnStore.getState().wandering).toBe(true);

    await returnToDesks();
    await play(scene, 0.2);
    expect(useDeskReturnStore.getState().wandering).toBe(false);
    await play(scene, 40);
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeLessThan(
      1e-6,
    );
    // Work is never called off: the reviewer is still at the Kickoff.
    const place = meetingPlanner(layout)
      .places("manager", ["reviewer"])
      .get("reviewer");
    expect(place).toBeDefined();
    expect(
      distance(placeOf(scene, "reviewer"), place?.at ?? [NaN, NaN]),
    ).toBeLessThan(1e-6);
    // A full rest before the coder wanders off again.
    await play(scene, restSeconds.max - 45);
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeLessThan(
      1e-6,
    );
  });

  it("with reduced motion, has everyone in their chairs at once", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(coderIdle()));
    renderer = scene;
    await play(scene, restSeconds.min + 8);
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeGreaterThan(
      0.5,
    );
    useSceneSettings.getState().setReducedMotion(true);
    await returnToDesks();
    await act(async () => {
      await scene.advanceFrames(1, 1e-6);
    });
    expect(distance(placeOf(scene, "coder"), seatOf("coder"))).toBeLessThan(
      1e-6,
    );
    expect(useDeskReturnStore.getState().wandering).toBe(false);
  });
});

describe("a dozing Agent's bubble", () => {
  it('is "zzz" in HTML over its head, hidden from assistive technology, and goes when it wakes', async () => {
    // Always the last of the PRD's five on offer: the doze, once it may be chosen.
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const idle = createIdleBehaviours(Math.random, idleActivities.slice(0, 5));
    const plan: IdlePlanner = (agentId, activity, place) =>
      idleTrip(layout, agentId, activity, place);
    const labelsIn = { current: document.body };
    const bubbles = (looks: ReadonlyMap<string, AgentLook>) => (
      <IdleActivities
        idle={idle}
        layout={layout}
        looks={looks}
        labelsIn={labelsIn}
      />
    );
    const scene = await ReactThreeTestRenderer.create(bubbles(coderIdle()));
    renderer = scene;
    // Let the idling run on, without drawing a frame for each second of it.
    const states = new Map([
      ["manager", "working" as const],
      ["coder", "idle" as const],
      ["reviewer", "working" as const],
    ]);
    for (let second = 0; second < longIdleSeconds + 120; second += 0.5) {
      idle.advance(0.5, states, plan);
      if (idle.bubbles().size > 0) {
        break;
      }
    }
    await play(scene, 0.1);
    const bubble = screen.getByText("zzz");
    expect(bubble.getAttribute("aria-hidden")).toBe("true");
    const group = object(scene, "idle-bubble-coder");
    expect(group.position.y).toBe(bubbleHeight);
    expect(
      distance([group.position.x, group.position.z], seatOf("coder")),
    ).toBeLessThan(1e-6);

    await act(async () => {
      await scene.update(bubbles(coderIdle(true)));
    });
    await play(scene, 0.1);
    expect(screen.queryByText("zzz")).toBeNull();
  });
});

describe("a Floor's Agents as it loads", () => {
  it("are every one seated at its desk from the first frame, idle or not, and stay there through their first rest", async () => {
    const idle = new Map(team.map(({ id }) => [id, look(false)]));
    renderer = await ReactThreeTestRenderer.create(floor(idle));
    for (const { id } of team) {
      expect(distance(placeOf(renderer, id), seatOf(id))).toBeLessThan(1e-6);
      // Sat down: the hips well below a standing Avatar's.
      const hips = object(renderer, `agent-${id}`)
        .getObjectByName("hips")
        ?.getWorldPosition(new Vector3());
      expect(hips?.y, id).toBeLessThan(0.75);
    }
    await play(renderer, restSeconds.min - 1);
    for (const { id } of team) {
      expect(distance(placeOf(renderer, id), seatOf(id))).toBeLessThan(1e-6);
    }
  });
});

describe("the table tennis ball", () => {
  it("leaves the near bat as it swings, crosses the net, bounces on the far half and meets the far bat half a swing later", () => {
    const {
      at: [tableX, tableZ],
      size: [length, width],
    } = gamesHall.tableTennis;
    // The games hall's walkway's middle line, wherever the desks put it.
    const hallZ = 8.75;
    const hit = tableTennisBall(rally.batMeetsBall, hallZ);
    const returned = tableTennisBall(
      rally.batMeetsBall + rally.seconds / 2,
      hallZ,
    );
    expect(hit[0]).toBeLessThan(tableX - length / 2);
    expect(returned[0]).toBeGreaterThan(tableX + length / 2);
    // Over the net, clear of its top, and over the table in the hall.
    const steps = 200;
    let bounced = false;
    for (let step = 0; step <= steps; step += 1) {
      const [x, y, z] = tableTennisBall(
        rally.batMeetsBall + (step / steps) * (rally.seconds / 2),
        hallZ,
      );
      expect(Math.abs(z - (tableZ + hallZ))).toBeLessThan(width / 2);
      if (Math.abs(x - tableX) < 0.02) {
        expect(y).toBeGreaterThan(0.91);
      }
      if (y < 0.785) {
        bounced = true;
        expect(x).toBeGreaterThan(tableX);
      }
    }
    expect(bounced).toBe(true);
    // Back again, a whole swing later.
    const again = tableTennisBall(rally.batMeetsBall + rally.seconds, hallZ);
    hit.forEach((value, index) => {
      expect(again[index]).toBeCloseTo(value, 6);
    });
  });

  it("flies only while two Agents play each other", async () => {
    const looks = new Map(team.map(({ id }) => [id, look(id === "manager")]));
    const tennisOnly = idleActivities
      .filter(({ name }) => name !== "table tennis")
      .map(({ name }) => name);
    renderer = await ReactThreeTestRenderer.create(
      <Floor
        floorId="web-shop"
        team={team}
        looks={looks}
        stops={stops}
        disabledActivities={tennisOnly}
      />,
    );
    const ball = object(renderer, "table-tennis-ball");
    expect(ball.visible).toBe(false);
    let seconds = 0;
    while (!ball.visible && seconds < 90) {
      await play(renderer, 1);
      seconds += 1;
    }
    expect(ball.visible).toBe(true);
    expect(ball.position.y).toBeGreaterThan(0.76);
    // Over the games hall's table, wherever the hall is.
    const table = floorLayout(team).waypoints.waypoints.find(
      ({ id }) => id === "table-tennis",
    );
    expect(
      Math.abs(
        ball.position.z -
          (gamesHall.tableTennis.at[1] + (table?.position[1] ?? NaN)),
      ),
    ).toBeLessThan(gamesHall.tableTennis.size[1] / 2);
    // Both are at the table, swinging.
    for (const id of ["coder", "reviewer"]) {
      const [x] = placeOf(renderer, id);
      expect(Math.abs(x - gamesHall.tableTennis.at[0])).toBeGreaterThan(1.2);
    }
    // A new task for one calls the game off: the ball goes.
    await act(async () => {
      await renderer?.update(
        <Floor
          floorId="web-shop"
          team={team}
          looks={new Map(team.map(({ id }) => [id, look(id !== "reviewer")]))}
          stops={stops}
          disabledActivities={tennisOnly}
        />,
      );
    });
    await play(renderer, 0.2);
    expect(ball.visible).toBe(false);
  });
});
