import { describe, expect, it } from "vitest";

import { awayOnWork, awayPose, type AwaySources } from "./away-pose.ts";
import { floorLayout, type FloorAgent } from "./floor-layout.ts";
import type { HandoffWalker } from "./handoff-walks.ts";
import {
  createIdleBehaviours,
  idleStateOf,
  idleTrip,
  type IdlePlanner,
  type IdleState,
} from "./idle-behaviours.ts";
import { createMeetingWalker, meetingPlanner } from "./meeting-walks.ts";

// What an Agent away from its chair is shown doing when more than one thing
// would take it there (PRD FR-59 to FR-61): a meeting wins over a Handoff
// walk, and both over an idle activity, which a meeting stops at once.

const team: FloorAgent[] = [
  { id: "manager", role: "manager" },
  { id: "ada", role: "coder" },
  { id: "rex", role: "reviewer" },
];
const layout = floorLayout(team);
const planIdle: IdlePlanner = (agentId, activity, place) =>
  idleTrip(layout, agentId, activity, place);

/** A Handoff walker with Ada on a walk, and no one else. */
const adaWalking: Pick<HandoffWalker, "poseOf"> = {
  poseOf: (agentId) =>
    agentId === "ada"
      ? {
          position: [1, 1],
          heading: 0,
          animation: "carry",
          carrying: true,
          pace: 2,
        }
      : undefined,
};

const kickoff = {
  type: "gather",
  id: 1,
  floorId: "web-shop",
  batchId: 7,
  kind: "kickoff",
  managerId: "manager",
  agentIds: ["manager", "ada"],
} as const;

/** Each Agent's idle state, as the Floor takes it: none of them has work. */
const statesOf = (sources: AwaySources): ReadonlyMap<string, IdleState> =>
  new Map(
    team.map(({ id }) => [id, idleStateOf(undefined, awayOnWork(id, sources))]),
  );

describe("an Agent away from its chair", () => {
  it("is in its chair when nothing takes it away", () => {
    expect(awayPose("ada", {})).toBeUndefined();
    expect(awayOnWork("ada", {})).toBe(false);
  });

  it("shows a Handoff walk over an idle activity, at the walk's pace", () => {
    const idle = createIdleBehaviours(() => 0);
    idle.advance(0, statesOf({}), planIdle);
    idle.advance(21, statesOf({}), planIdle);
    expect(idle.poseOf("ada")).toBeDefined();
    expect(awayPose("ada", { walker: adaWalking, idle })).toMatchObject({
      animation: "carry",
      pace: 2,
    });
    // Rex has no walk: his own activity shows.
    expect(awayPose("rex", { walker: adaWalking, idle })).toEqual(
      idle.poseOf("rex"),
    );
  });

  it("shows a meeting over a Handoff walk", () => {
    const meetings = createMeetingWalker("web-shop");
    meetings.receive(kickoff, meetingPlanner(layout));
    meetings.advance(1, () => false);
    expect(awayPose("ada", { meetings, walker: adaWalking })).toMatchObject({
      animation: "stand-up",
      pace: 1,
    });
  });

  it("stops its idle activity at once when a Kickoff gathers it, and walks to the meeting from its desk", () => {
    const idle = createIdleBehaviours(() => 0);
    const meetings = createMeetingWalker("web-shop");
    idle.advance(0, statesOf({ meetings }), planIdle);
    idle.advance(21, statesOf({ meetings }), planIdle);
    const fetching = awayPose("ada", { meetings, idle });
    expect(fetching).toEqual(idle.poseOf("ada"));

    meetings.receive(kickoff, meetingPlanner(layout));
    // Gathered but not yet set off: away on work, so no longer idle.
    expect(awayOnWork("ada", { meetings })).toBe(true);
    expect(statesOf({ meetings }).get("ada")).toBe("busy");
    idle.advance(0, statesOf({ meetings }), planIdle);
    expect(idle.poseOf("ada")).toBeUndefined();
    // Rex is not in the meeting: his activity carries on.
    expect(idle.poseOf("rex")).toBeDefined();

    meetings.advance(0.5, () => false);
    const desk = layout.desks.find(({ agentId }) => agentId === "ada");
    expect(awayPose("ada", { meetings, idle })).toMatchObject({
      animation: "stand-up",
      position: [desk?.seat[0], desk?.seat[2]],
    });
    // No idle activity starts while the meeting lasts.
    idle.advance(120, statesOf({ meetings }), planIdle);
    expect(idle.poseOf("ada")).toBeUndefined();
  });
});
