import type { FloorWallBoard } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  agentLook,
  agentLooks,
  floorNeedsOwner,
  maxTicketsShown,
  type AgentState,
} from "./agent-state.ts";
import type { MonitorScreen } from "./monitor-preview.ts";

// What each Agent's state looks like in the Office (PRD FR-62): its pose,
// the marker over its head, and the pile of tickets on its desk; and the
// red light at the Manager's office.

/** An Agent with nothing to do, enabled. */
const idle: AgentState = {
  working: false,
  enabled: true,
  capped: false,
  awaitingReview: 0,
  queued: 0,
};

describe("how an Agent's state looks", () => {
  it("sits back with nothing to do, no marker and an empty desk", () => {
    expect(agentLook(idle)).toEqual({
      animation: "sit",
      marker: undefined,
      tickets: 0,
    });
  });

  it("types while it works", () => {
    expect(agentLook({ ...idle, working: true }).animation).toBe("type");
  });

  it("waits on review, looking unlike an Agent with nothing queued", () => {
    const waiting = agentLook({ ...idle, awaitingReview: 1 });
    expect(waiting.animation).toBe("wait");
    expect(waiting.animation).not.toBe(agentLook(idle).animation);
    // Working on something else while it waits, it types.
    expect(agentLook({ ...idle, awaitingReview: 2, working: true })).toEqual(
      expect.objectContaining({ animation: "type" }),
    );
  });

  it("shows a pause marker while paused, typing still if it is finishing its task", () => {
    expect(agentLook({ ...idle, enabled: false })).toEqual({
      animation: "sit",
      marker: "paused",
      tickets: 0,
    });
    expect(agentLook({ ...idle, enabled: false, working: true })).toEqual({
      animation: "type",
      marker: "paused",
      tickets: 0,
    });
  });

  it("shows a cap marker at a Token Cap, never typing, over a pause", () => {
    expect(agentLook({ ...idle, capped: true }).marker).toBe("capped");
    // Stopped at its next call, whatever its monitor last said.
    expect(agentLook({ ...idle, capped: true, working: true }).animation).toBe(
      "sit",
    );
    expect(agentLook({ ...idle, capped: true, enabled: false }).marker).toBe(
      "capped",
    );
    // Capped with its work at review, it still waits on it.
    expect(
      agentLook({ ...idle, capped: true, awaitingReview: 1 }).animation,
    ).toBe("wait");
  });

  it("piles a ticket on the desk for each task that waits, up to ten", () => {
    for (const [queued, tickets] of [
      [0, 0],
      [1, 1],
      [4, 4],
      [10, 10],
      [11, 10],
      [250, 10],
    ] as const) {
      expect(agentLook({ ...idle, queued }).tickets, String(queued)).toBe(
        tickets,
      );
    }
    expect(maxTicketsShown).toBe(10);
    // The pile is there whatever else it is doing.
    expect(
      agentLook({ ...idle, queued: 3, working: true, enabled: false }).tickets,
    ).toBe(3);
  });
});

describe("how a Floor's Agents look", () => {
  const screen = (agentId: string, working: boolean): MonitorScreen => ({
    agentId,
    working,
    lines: [],
    activity: 0,
  });
  const team = [
    { id: "mia", role: "manager" as const },
    { id: "ada", role: "coder" as const },
    { id: "bo", role: "reviewer" as const, enabled: false },
    { id: "cy", role: "qa" as const },
    { id: "di", role: "docs" as const },
  ];
  const board: FloorWallBoard = {
    floorId: "web-shop",
    roundCap: 3,
    qaRoundCap: 3,
    issues: [],
    queues: [],
    agents: [
      { agentId: "mia", waiting: 0, awaitingReview: [], capped: false },
      { agentId: "ada", waiting: 12, awaitingReview: [7, 9], capped: false },
      { agentId: "bo", waiting: 2, awaitingReview: [], capped: false },
      { agentId: "cy", waiting: 0, awaitingReview: [], capped: true },
      // An Agent no longer on the Floor is left out.
      { agentId: "gone", waiting: 3, awaitingReview: [], capped: true },
    ],
  };

  it("reads each Agent's work from its monitor, its pause from the team, and the rest from the wall board", () => {
    const looks = agentLooks({
      team,
      monitors: new Map([
        ["mia", screen("mia", true)],
        ["ada", screen("ada", false)],
        ["bo", screen("bo", true)],
      ]),
      board,
    });
    expect(Object.fromEntries(looks)).toEqual({
      mia: { animation: "type", marker: undefined, tickets: 0 },
      ada: { animation: "wait", marker: undefined, tickets: 10 },
      bo: { animation: "type", marker: "paused", tickets: 2 },
      cy: { animation: "sit", marker: "capped", tickets: 0 },
      // Not on the board yet: nothing queued, at review or capped.
      di: { animation: "sit", marker: undefined, tickets: 0 },
    });
  });

  it("before the wall board is read, shows only work and pauses", () => {
    const looks = agentLooks({
      team,
      monitors: new Map([["ada", screen("ada", true)]]),
      board: undefined,
    });
    expect(looks.get("ada")).toEqual({
      animation: "type",
      marker: undefined,
      tickets: 0,
    });
    expect(looks.get("bo")?.marker).toBe("paused");
    expect([...looks.keys()]).toEqual(team.map(({ id }) => id));
  });
});

describe("the red light at the Manager's office", () => {
  const notice = (kind: "action" | "info", floorId: string | null) => ({
    kind,
    floorId,
  });

  it("is on while the Floor has an action Notice open", () => {
    expect(floorNeedsOwner([notice("action", "web-shop")], "web-shop")).toBe(
      true,
    );
  });

  it("is off for info Notices, another Floor's, the whole Office's, or none", () => {
    expect(floorNeedsOwner([], "web-shop")).toBe(false);
    expect(
      floorNeedsOwner(
        [
          notice("info", "web-shop"),
          notice("action", "blog"),
          notice("action", null),
        ],
        "web-shop",
      ),
    ).toBe(false);
  });
});
