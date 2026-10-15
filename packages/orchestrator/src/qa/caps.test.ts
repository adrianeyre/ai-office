import { describe, expect, it } from "vitest";

import type { QaReportRecord, VerdictRecord } from "../review/store.ts";
import {
  everyRoundLinks,
  overallRoundCap,
  qaRoundCap,
  roundsSoFar,
} from "./caps.ts";

const at = (minute: number) =>
  new Date(`2026-10-09T09:${String(minute).padStart(2, "0")}:00.000Z`);

const verdict = (
  round: number,
  agentId: string,
  kind: "approve" | "changes_requested",
  minute: number,
): VerdictRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round,
  agentId,
  headSha: "a".repeat(40),
  verdict: { verdict: kind, summary: "S.", comments: [] },
  reviewUrl: `https://github.com/r/pull/2#review-${agentId}-${String(round)}`,
  createdAt: at(minute),
});

const report = (round: number, minute: number): QaReportRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round,
  agentId: "evelyn",
  headSha: "b".repeat(40),
  result: "fail",
  summary: "Fails.",
  steps: "1. Run it.",
  commentUrl: `https://github.com/r/pull/2#qa-${String(round)}`,
  createdAt: at(minute),
});

describe("the caps beyond the Round Cap", () => {
  it("give QA a Round Cap of 3, and a pull request one fewer than both caps' rounds", () => {
    expect(qaRoundCap).toBe(3);
    expect(overallRoundCap(3)).toBe(5);
    expect(overallRoundCap(1)).toBe(3);
  });

  it("count each round of review once, and each round of QA", () => {
    expect(
      roundsSoFar(
        [
          verdict(1, "grace", "approve", 1),
          verdict(1, "quinta", "changes_requested", 2),
          verdict(2, "grace", "approve", 5),
        ],
        [report(1, 4)],
      ),
    ).toBe(3);
    expect(roundsSoFar([], [])).toBe(0);
  });

  it("link each round, oldest first, preferring a review that asked for changes", () => {
    expect(
      everyRoundLinks(
        [
          verdict(1, "grace", "approve", 1),
          verdict(1, "quinta", "changes_requested", 2),
          verdict(2, "grace", "approve", 5),
        ],
        [report(1, 3), report(2, 6)],
        "https://github.com/r/pull/2",
      ),
    ).toEqual([
      {
        label: "Review round 1",
        url: "https://github.com/r/pull/2#review-quinta-1",
      },
      { label: "QA round 1", url: "https://github.com/r/pull/2#qa-1" },
      {
        label: "Review round 2",
        url: "https://github.com/r/pull/2#review-grace-2",
      },
      { label: "QA round 2", url: "https://github.com/r/pull/2#qa-2" },
    ]);
  });

  it("link only the latest ten rounds", () => {
    const verdicts = Array.from({ length: 8 }, (_, index) =>
      verdict(index + 1, "grace", "approve", index * 2),
    );
    const reports = Array.from({ length: 4 }, (_, index) =>
      report(index + 1, index * 2 + 1),
    );
    const links = everyRoundLinks(verdicts, reports, "https://x");
    expect(links).toHaveLength(10);
    expect(links[0]?.label).toBe("Review round 2");
    expect(links.at(-1)?.label).toBe("Review round 8");
  });
});
