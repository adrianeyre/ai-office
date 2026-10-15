import type { FloorWallBoard } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  capState,
  capStateTokens,
  currentIssueOf,
  healthTokens,
} from "./wall-board.ts";

// How a wall board colours a cap's use (PRD FR-62) and the Floor's health.

describe("a cap's state", () => {
  it("is neutral below 80% of the cap, a warning from 80%, and reached at 100%", () => {
    expect(capState({ cap: 1_000, used: 0 })).toBe("neutral");
    expect(capState({ cap: 1_000, used: 799 })).toBe("neutral");
    expect(capState({ cap: 1_000, used: 800 })).toBe("warning");
    expect(capState({ cap: 1_000, used: 999 })).toBe("warning");
    expect(capState({ cap: 1_000, used: 1_000 })).toBe("reached");
    expect(capState({ cap: 1_000, used: 1_500 })).toBe("reached");
  });

  it("is coloured from the palette's states", () => {
    expect(capStateTokens).toEqual({
      neutral: "state-neutral",
      warning: "state-warning",
      reached: "state-critical",
    });
    expect(healthTokens).toEqual({
      ok: "state-ok",
      warning: "state-warning",
      critical: "state-critical",
    });
  });
});

describe("an Agent's current issue", () => {
  const work = (
    issue: number,
    status: "working" | "waiting",
    agentIds: string[],
  ): FloorWallBoard["issues"][number] => ({
    issue,
    url: `https://github.com/adrianeyre/web-shop/issues/${String(issue)}`,
    stage: "needs-work",
    status,
    agentIds,
    pullRequest: null,
    reviewRounds: 0,
    qaRounds: 0,
  });
  // As the board lists them: being worked first, then waiting, oldest first.
  const board: FloorWallBoard = {
    floorId: "web-shop",
    roundCap: 3,
    qaRoundCap: 3,
    issues: [
      work(4, "working", ["bo"]),
      work(5, "working", ["cy", "di"]),
      work(2, "waiting", ["bo"]),
      work(3, "waiting", ["ada"]),
      work(6, "waiting", ["ada"]),
    ],
    queues: [],
    agents: [],
  };

  it("is the issue it works, or else the oldest waiting for it", () => {
    expect(currentIssueOf(board, "bo")?.issue).toBe(4);
    expect(currentIssueOf(board, "ada")?.issue).toBe(3);
  });

  it("is a review round's issue for each of its reviewers", () => {
    expect(currentIssueOf(board, "cy")?.issue).toBe(5);
    expect(currentIssueOf(board, "di")?.issue).toBe(5);
  });

  it("is none for an Agent with no work", () => {
    expect(currentIssueOf(board, "eve")).toBeUndefined();
  });
});
