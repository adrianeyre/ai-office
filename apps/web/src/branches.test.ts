import type { BranchCommit, BranchLane } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  aheadBehindBadge,
  aheadBehindText,
  commitText,
  laneGeometry,
  layoutLanes,
  timeAgo,
} from "./branches.ts";

// The Branches page's drawing and words, apart from React.

const commit = (sha: string, authoredAt: string): BranchCommit => ({
  sha: sha.repeat(40).slice(0, 40),
  message: `Commit ${sha}`,
  author: "Adrian Eyre",
  agent: null,
  authoredAt,
  url: `https://github.com/adrianeyre/web-shop/commit/${sha}`,
});

const lane = (
  name: string,
  mergeBase: BranchCommit,
  commits: BranchCommit[],
  aheadBy = commits.length,
): BranchLane => ({
  name,
  url: `https://github.com/adrianeyre/web-shop/tree/${name}`,
  headSha: commits.at(-1)?.sha ?? mergeBase.sha,
  aheadBy,
  behindBy: 0,
  mergeBase,
  commits,
  lastCommitAt: (commits.at(-1) ?? mergeBase).authoredAt,
  likelyToConflict: false,
  issue: null,
  batch: null,
  grillingSession: null,
  pullRequest: null,
  ci: "none",
  work: null,
});

const older = commit("a", "2026-10-01T09:00:00.000Z");
const newer = commit("b", "2026-10-05T09:00:00.000Z");
const { left, trunkY, row, base, commit: step, bend } = laneGeometry;

describe("layoutLanes", () => {
  it("draws the trunk alone for no lanes", () => {
    const layout = layoutLanes([]);
    expect(layout.lanes).toEqual([]);
    expect(layout.bases).toEqual([]);
    expect(layout.trunkY).toBe(trunkY);
    expect(layout.height).toBe(trunkY + laneGeometry.margin);
  });

  it("puts each merge base on the trunk once, oldest first, and each lane off it at its own", () => {
    const layout = layoutLanes([
      lane("ai-office/1-old", older, [commit("c", "2026-10-02T09:00:00.000Z")]),
      lane("ai-office/2-new", newer, [
        commit("d", "2026-10-06T09:00:00.000Z"),
        commit("e", "2026-10-07T09:00:00.000Z"),
      ]),
      lane("ai-office/3-also-old", older, []),
    ]);
    expect(layout.bases.map(({ x, commit: at }) => [x, at.sha[0]])).toEqual([
      [left, "a"],
      [left + base, "b"],
    ]);
    // The newest merge base on top, so no lane crosses another; by name
    // where they split off at the same commit.
    expect(
      layout.lanes.map(({ lane: drawn, y, splitX }) => [drawn.name, y, splitX]),
    ).toEqual([
      ["ai-office/2-new", trunkY + row, left + base],
      ["ai-office/1-old", trunkY + 2 * row, left],
      ["ai-office/3-also-old", trunkY + 3 * row, left],
    ]);
    expect(layout.height).toBe(trunkY + 3 * row + laneGeometry.margin);
  });

  it("puts a lane's commits along it, oldest first, a step apart, its name after them", () => {
    const [drawn] = layoutLanes([
      lane("ai-office/2-new", newer, [
        commit("d", "2026-10-06T09:00:00.000Z"),
        commit("e", "2026-10-07T09:00:00.000Z"),
      ]),
    ]).lanes;
    const first = left + bend + step / 2;
    expect(drawn?.commits.map(({ x, commit: at }) => [x, at.sha[0]])).toEqual([
      [first, "d"],
      [first + step, "e"],
    ]);
    expect(drawn?.hidden).toBe(0);
    expect(drawn?.labelX).toBe(first + step + step / 2);
    // Down from the trunk at its merge base, then along its row.
    expect(drawn?.path).toBe(
      `M ${String(left)} ${String(trunkY)} V ${String(trunkY + row - bend / 2)} Q ${String(left)} ${String(trunkY + row)} ${String(left + bend / 2)} ${String(trunkY + row)} H ${String(first + step)}`,
    );
  });

  it("marks the older commits of a long lane that are not drawn", () => {
    const [drawn] = layoutLanes([
      lane(
        "ai-office/9-long",
        older,
        [commit("f", "2026-10-02T09:00:00.000Z")],
        140,
      ),
    ]).lanes;
    expect(drawn?.hidden).toBe(139);
    expect(drawn?.commits[0]?.x).toBe((drawn?.hiddenX ?? 0) + step);
  });

  it("is wide enough for the longest lane's name", () => {
    const name = "ai-office/12-a-rather-long-title-for-an-issue-here";
    const layout = layoutLanes([lane(name, older, [])]);
    const [drawn] = layout.lanes;
    expect(layout.width).toBeGreaterThanOrEqual(
      (drawn?.labelX ?? 0) + name.length * laneGeometry.character,
    );
  });
});

describe("the ahead/behind badge", () => {
  it("shows how far ahead and behind, with arrows", () => {
    expect(aheadBehindBadge({ aheadBy: 3, behindBy: 12 })).toBe("↑3 ↓12");
    expect(aheadBehindBadge({ aheadBy: 0, behindBy: 0 })).toBe("↑0 ↓0");
  });

  it("says it in words against the default branch", () => {
    expect(aheadBehindText({ aheadBy: 3, behindBy: 12 }, "main")).toBe(
      "3 commits ahead of main, 12 behind",
    );
    expect(aheadBehindText({ aheadBy: 1, behindBy: 0 }, "trunk")).toBe(
      "1 commit ahead of trunk, 0 behind",
    );
  });
});

describe("a commit's words", () => {
  it("gives its short sha, message, author, Agent and time", () => {
    expect(
      commitText(commit("d", "2026-10-06T09:00:00.000Z"), "2 days ago"),
    ).toBe("ddddddd Commit d, by Adrian Eyre, 2 days ago");
    expect(
      commitText(
        { ...commit("d", "2026-10-06T09:00:00.000Z"), agent: "Ada (coder)" },
        "now",
      ),
    ).toBe("ddddddd Commit d, by Adrian Eyre (Agent: Ada (coder)), now");
  });

  it("says how long ago it was", () => {
    const now = new Date("2026-10-12T12:00:00.000Z");
    expect(timeAgo("2026-10-12T11:59:30.000Z", now)).toBe("just now");
    expect(timeAgo("2026-10-12T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(timeAgo("2026-10-12T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-10-11T12:00:00.000Z", now)).toBe("yesterday");
    expect(timeAgo("2026-09-28T12:00:00.000Z", now)).toBe("2 weeks ago");
  });
});
