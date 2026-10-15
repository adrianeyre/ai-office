import type { Role } from "@ai-office/shared";
import { palette } from "@ai-office/shared/palette";
import ReactThreeTestRenderer from "@react-three/test-renderer";
import { screen } from "@testing-library/react";
import { Color, type InstancedMesh, type Object3D } from "three";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AgentLook } from "./agent-state.ts";
import { Floor, type FloorGrilling } from "./floor.tsx";
import { floorLayout, meetingRoom, type FloorAgent } from "./floor-layout.ts";
import { InSessionSign } from "./grilling-room.tsx";
import {
  grillingPlace,
  grillingPlanner,
  standBack,
  visitSeconds,
  type FactFindingVisit,
} from "./grilling-walks.ts";
import { walkSpeed } from "./handoff-walks.ts";
import { idleActivities } from "./idle-behaviours.ts";
import { liftStops } from "./lift-stops.ts";
import {
  resetMeetingRoomCall,
  useMeetingRoomCall,
} from "./meeting-room-call.ts";
import {
  arrival,
  homeward,
  meetingPlanner,
  type MeetingSignal,
} from "./meeting-walks.ts";
import { provideModels, type LoadedModels } from "./models.ts";
import { resetSceneSettings, useSceneSettings } from "./scene-settings.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

// A Grilling Session on a Floor (PRD FR-83), rendered without WebGL by
// React Three Fiber's test renderer: the Manager and every Agent walk to
// the meeting room's table when a session starts, sit there while it
// runs, and walk back to their desks when it is paused or ends; the sign
// over the door is lit while it runs; the whiteboard shows the round's
// questions and the decisions; an Agent sent to find facts stands up at
// the table for a moment; a Kickoff waits for them to be back; with
// reduced motion everyone is simply at the table.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = ReactThreeTestRenderer;

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const roles: Role[] = ["manager", "coder", "reviewer", "qa"];
const team: FloorAgent[] = roles.map((role) => ({ id: role, role }));
const layout = floorLayout(team);
const plan = grillingPlanner(layout);
const stops = liftStops([], []);

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

const running: FloorGrilling = {
  sessionId: 1,
  board: { round: 2, questions: ["answered", "open"], decisions: 3 },
};
const visit = (id: number, agentId: string): FactFindingVisit => ({
  id,
  floorId: "web-shop",
  sessionId: 1,
  agentId,
});

const allActivitiesOff = idleActivities.map(({ name }) => name);

let renderer: Renderer | undefined;
let models: LoadedModels;

const floor = (
  grilling: FloorGrilling | undefined,
  factFinding: readonly FactFindingVisit[] = [],
  meetings: readonly MeetingSignal[] = [],
  grillingKnown = true,
) => (
  <Floor
    floorId="web-shop"
    team={team}
    grilling={grilling}
    grillingKnown={grillingKnown}
    factFinding={factFinding}
    meetings={meetings}
    stops={stops}
    // No idle activities: an idle Agent would otherwise wander off at
    // random during the long sessions these tests play.
    disabledActivities={allActivitiesOff}
  />
);

const rerender = async (scene: Renderer, ...args: Parameters<typeof floor>) => {
  await act(async () => {
    await scene.update(floor(...args));
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
  const agent = defined(find(scene, `agent-${agentId}`));
  return [agent.position.x, agent.position.z];
};

const deskOf = (agentId: string): FloorPoint => {
  const desk = defined(layout.desks.find((each) => each.agentId === agentId));
  return [desk.seat[0], desk.seat[2]];
};

const seat = defined(grillingPlace(layout)).at;
const toSeat = defined(plan.seat("manager"));
const others = ["coder", "reviewer", "qa"] as const;
const gathered = plan.gather({
  sessionId: 1,
  managerId: "manager",
  agentIds: others,
});
const placeAt = (agentId: string) => defined(gathered.get(agentId)).place.at;
const longest = Math.max(...[...gathered.values()].map(arrival));
const longestHome = Math.max(...[...gathered.values()].map(homeward));

beforeAll(async () => {
  models = await loadModelsFromDisk();
});

beforeEach(() => {
  resetSceneSettings();
  resetMeetingRoomCall();
  provideModels(models);
});

afterEach(async () => {
  await act(async () => {
    await renderer?.unmount();
  });
  renderer = undefined;
  document.body.innerHTML = "";
});

describe("a Grilling Session on a Floor", () => {
  it("everyone walks to the table as it starts and sits there while it runs, with the door's sign lit and the whiteboard filled in; they walk back when the session pauses", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(undefined));
    renderer = scene;
    await play(scene, 0.5);
    expect(find(scene, "in-session-sign")).toBeUndefined();
    expect(find(scene, "grilling-whiteboard")).toBeUndefined();

    await rerender(scene, running);
    expect(find(scene, "in-session-sign")).toBeDefined();
    const marks = defined(
      find(scene, "grilling-whiteboard-marks"),
    ) as InstancedMesh;
    // Two notes (answered, open), three ticks, with their writing and headings.
    const colours = Array.from({ length: marks.count }, (_, index) => {
      const colour = new Color();
      marks.getColorAt(index, colour);
      return `#${colour.getHexString()}`;
    });
    expect(
      colours.filter((each) => each === palette["state-warning"]),
    ).toHaveLength(1);
    expect(colours.filter((each) => each === palette["state-ok"])).toHaveLength(
      1 + 3,
    );

    await play(scene, 3);
    for (const agentId of ["manager", ...others]) {
      expect(
        distance(placeOf(scene, agentId), deskOf(agentId)),
        agentId,
      ).toBeGreaterThan(0.3);
    }
    await play(scene, longest);
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    // However long the session runs, they stay, each in a seat of its own
    // at the table.
    await play(scene, 60);
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    for (const agentId of others) {
      expect(
        distance(placeOf(scene, agentId), placeAt(agentId)),
        agentId,
      ).toBeLessThan(1e-6);
      expect(defined(gathered.get(agentId)).place.sits).toBe(true);
      const [x, z] = placeOf(scene, agentId);
      expect(
        x > meetingRoom.x[0] && x < meetingRoom.x[1] && z < meetingRoom.z[1],
        agentId,
      ).toBe(true);
    }
    expect(new Set(others.map((each) => placeAt(each).join())).size).toBe(3);

    // Paused: back to their desks, and the sign goes out.
    await rerender(scene, undefined);
    expect(find(scene, "in-session-sign")).toBeUndefined();
    await play(scene, 3);
    expect(distance(placeOf(scene, "manager"), seat)).toBeGreaterThan(0.3);
    await play(scene, longestHome);
    for (const agentId of ["manager", ...others]) {
      expect(
        distance(placeOf(scene, agentId), deskOf(agentId)),
        agentId,
      ).toBeLessThan(1e-6);
    }
  });

  it("an Agent at its desk at work comes too: its work goes on in its sandbox", async () => {
    const looks = new Map<string, AgentLook>(
      team.map(({ id }) => [
        id,
        {
          animation: id === "coder" ? "type" : "sit",
          marker: undefined,
          tickets: 0,
        },
      ]),
    );
    const scene = await ReactThreeTestRenderer.create(
      <Floor
        floorId="web-shop"
        team={team}
        looks={looks}
        grilling={undefined}
        stops={stops}
        disabledActivities={allActivitiesOff}
      />,
    );
    renderer = scene;
    await play(scene, 0.5);
    await act(async () => {
      await scene.update(
        <Floor
          floorId="web-shop"
          team={team}
          looks={looks}
          grilling={running}
          stops={stops}
          disabledActivities={allActivitiesOff}
        />,
      );
    });
    await play(scene, longest + 1);
    expect(distance(placeOf(scene, "coder"), placeAt("coder"))).toBeLessThan(
      1e-6,
    );
  });

  it("a session running when the Floor is shown has everyone at the table already", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(running));
    renderer = scene;
    await play(scene, 0.2);
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    for (const agentId of others) {
      expect(
        distance(placeOf(scene, agentId), placeAt(agentId)),
        agentId,
      ).toBeLessThan(1e-6);
    }
  });

  it("a running session found once the Floor's sessions load has everyone seated at the table, with no walk", async () => {
    const scene = await ReactThreeTestRenderer.create(
      floor(undefined, [], [], false),
    );
    renderer = scene;
    await play(scene, 0.2);
    await rerender(scene, running, [], [], true);
    await play(scene, 0.2);
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    for (const agentId of others) {
      expect(
        distance(placeOf(scene, agentId), placeAt(agentId)),
        agentId,
      ).toBeLessThan(1e-6);
    }
  });

  it("the Owner's Meeting Room call walks the whole Floor to the table, and ending it walks them back", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(undefined));
    renderer = scene;
    await play(scene, 0.2);
    await act(async () => {
      useMeetingRoomCall.getState().call("web-shop");
      await Promise.resolve();
    });
    await play(scene, 0.5);
    // On the way, not there yet.
    expect(distance(placeOf(scene, "coder"), placeAt("coder"))).toBeGreaterThan(
      1e-3,
    );
    await play(scene, longest + 1);
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    for (const agentId of others) {
      expect(
        distance(placeOf(scene, agentId), placeAt(agentId)),
        agentId,
      ).toBeLessThan(1e-6);
    }
    await act(async () => {
      useMeetingRoomCall.getState().end();
      await Promise.resolve();
    });
    await play(scene, longest + 1);
    expect(distance(placeOf(scene, "coder"), deskOf("coder"))).toBeLessThan(
      1e-6,
    );
  });

  it("an Agent sent to find facts stands up behind its chair at the table for a moment, then sits again; the Manager finding facts itself stays put", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(running));
    renderer = scene;
    await play(scene, 0.2);
    await rerender(scene, running, [visit(4, "coder"), visit(5, "manager")]);
    await play(scene, visitSeconds / 2);
    const standing = distance(placeOf(scene, "coder"), placeAt("coder"));
    expect(standing).toBeCloseTo(standBack, 6);
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    await play(scene, visitSeconds / 2 + 0.5);
    expect(distance(placeOf(scene, "coder"), placeAt("coder"))).toBeLessThan(
      1e-6,
    );
  });

  it("never stands up for fact-finding that came before the Floor was shown", async () => {
    const scene = await ReactThreeTestRenderer.create(
      floor(running, [visit(4, "coder")]),
    );
    renderer = scene;
    await play(scene, 1);
    expect(distance(placeOf(scene, "coder"), placeAt("coder"))).toBe(0);
  });

  it("a Kickoff during the session waits for the Manager to be back from the table", async () => {
    const scene = await ReactThreeTestRenderer.create(floor(running));
    renderer = scene;
    await play(scene, 0.2);
    const kickoff: MeetingSignal = {
      type: "gather",
      id: 7,
      floorId: "web-shop",
      batchId: 3,
      kind: "kickoff",
      managerId: "manager",
      agentIds: ["coder"],
    };
    await rerender(scene, running, [], [kickoff]);
    await play(scene, 30);
    // Still at the session's table, not the whiteboard.
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    const meetings = meetingPlanner(layout);
    const board = defined(meetings.places("manager", ["coder"]).get("manager"));
    await rerender(scene, undefined, [], [kickoff]);
    // A second at a time: the test renderer plays each frame subscriber's
    // frames before the next's, and the Kickoff waits on the session's walk.
    const seconds =
      // Home, it sits down before it gets up again for the Kickoff.
      homeward(toSeat) + arrival(defined(meetings.route("manager", board))) + 3;
    let longestStep = 0;
    let last = placeOf(scene, "manager");
    for (let second = 0; second < seconds; second += 1) {
      await play(scene, 1);
      const now = placeOf(scene, "manager");
      longestStep = Math.max(longestStep, distance(last, now));
      last = now;
    }
    // Home, then to the whiteboard, walking all the way: never a jump.
    expect(longestStep).toBeLessThanOrEqual(walkSpeed + 1e-6);
    expect(distance(placeOf(scene, "manager"), board.at)).toBeLessThan(1e-6);
  });

  it("with reduced motion everyone is at the table while the session runs, and at their desks once it ends, never walking", async () => {
    useSceneSettings.setState({ reducedMotion: true });
    const scene = await ReactThreeTestRenderer.create(floor(undefined));
    renderer = scene;
    await rerender(scene, running, [visit(4, "coder")]);
    await play(scene, 0.2);
    expect(distance(placeOf(scene, "manager"), seat)).toBeLessThan(1e-6);
    for (const agentId of others) {
      // Seated at once, and never standing up for fact-finding.
      expect(
        distance(placeOf(scene, agentId), placeAt(agentId)),
        agentId,
      ).toBeLessThan(1e-6);
    }
    await rerender(scene, undefined, [visit(4, "coder")]);
    await play(scene, 0.2);
    for (const agentId of ["manager", ...others]) {
      expect(
        distance(placeOf(scene, agentId), deskOf(agentId)),
        agentId,
      ).toBeLessThan(1e-6);
    }
  });
});

describe("the sign over the meeting room's door", () => {
  it("says the room is in session, in HTML over the canvas", async () => {
    const labelsIn = { current: document.body };
    const scene = await ReactThreeTestRenderer.create(
      <InSessionSign labelsIn={labelsIn} />,
    );
    renderer = scene;
    await play(scene, 0.1);
    const label = screen.getByText("In session");
    expect(label.getAttribute("aria-hidden")).toBe("true");
    expect(find(scene, "in-session-sign/lamp")).toBeDefined();
  });
});
