import type { CheckRun } from "@ai-office/github";
import { describe, expect, it } from "vitest";

import type { QaReportRecord, VerdictRecord } from "../review/store.ts";
import {
  approvedBefore,
  ciHeldBack,
  ciOf,
  ciRunOf,
  heldBack,
  roundLeft,
  type GateInput,
} from "./gate.ts";

// The Merge Policy's gate (PRD FR-29; ADR 0002): each of its conditions on
// its own, as plain rules.

const pull = "https://github.com/adrianeyre/web-shop/pull/2";

const approval = (round: number, agentId: string): VerdictRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round,
  agentId,
  headSha: "a".repeat(40),
  verdict: {
    verdict: "approve",
    summary: "It does what the issue asks.",
    comments: [
      { severity: "nit", path: "src/basket.ts", line: 1, body: "Name it." },
    ],
  },
  reviewUrl: `${pull}#review-${agentId}-${String(round)}`,
  createdAt: new Date("2026-10-09T12:00:00Z"),
});

const rejection = (
  round: number,
  agentId: string,
  blocking = 1,
): VerdictRecord => ({
  ...approval(round, agentId),
  verdict: {
    verdict: "changes_requested",
    summary: "Not yet.",
    comments: Array.from({ length: blocking }, (_, index) => ({
      severity: "blocking" as const,
      path: "src/basket.ts",
      line: index + 1,
      body: "Keep both skus.",
    })),
  },
});

const qa = (round: number): QaReportRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round,
  agentId: "quill",
  headSha: "b".repeat(40),
  result: round === 1 ? "fail" : "pass",
  summary: "Checked.",
  steps: "",
  commentUrl: `${pull}#qa-${String(round)}`,
  createdAt: new Date("2026-10-09T13:00:00Z"),
});

const reviewers = [
  { id: "grace", name: "Grace" },
  { id: "quinta", name: "Quinta" },
];

/** A pull request every condition lets through: approved in round 2. */
const passing: GateInput = {
  head: "a".repeat(40),
  reviewers,
  verdicts: [
    rejection(1, "grace"),
    approval(1, "quinta"),
    approval(2, "grace"),
    approval(2, "quinta"),
  ],
  reports: [qa(1), qa(2)],
  roundCap: 3,
  capsReached: [],
};

let ids = 0;
const check = (
  name: string,
  status: CheckRun["status"],
  conclusion: CheckRun["conclusion"] = null,
): CheckRun => {
  ids += 1;
  return {
    id: ids,
    name,
    status,
    conclusion,
    headSha: "c".repeat(40),
    htmlUrl: `https://github.com/adrianeyre/web-shop/runs/${String(ids)}`,
  };
};

describe("the Merge Policy's gate", () => {
  it("lets through a pull request every required reviewer approved, within every cap", () => {
    expect(heldBack(passing)).toEqual([]);
    // Approved at the Round Cap itself is within it.
    expect(heldBack({ ...passing, roundCap: 2 })).toEqual([]);
  });

  it("holds back a pull request a required reviewer has not approved in the latest round", () => {
    // Approved in round 1, but not in round 2.
    expect(
      heldBack({
        ...passing,
        verdicts: [approval(1, "grace"), approval(2, "quinta")],
      }),
    ).toEqual(["Grace has not approved it"]);
    // A required reviewer added since the round never reviewed it.
    expect(
      heldBack({
        ...passing,
        reviewers: [...reviewers, { id: "rex", name: "Rex" }],
      }),
    ).toEqual(["Rex has not approved it"]);
    expect(heldBack({ ...passing, verdicts: [] })).toEqual([
      "Grace and Quinta have not approved it",
    ]);
    expect(heldBack({ ...passing, reviewers: [] })).toEqual([
      "the Floor has no required reviewer to approve it",
    ]);
  });

  it("holds back a pull request with blocking comments in its latest round", () => {
    expect(
      heldBack({
        ...passing,
        verdicts: [approval(2, "grace"), rejection(2, "quinta", 2)],
      }),
    ).toEqual([
      "Quinta has not approved it",
      "2 blocking comments from round 2 remain",
    ]);
    // Earlier rounds' blocking comments were fixed.
    expect(heldBack(passing)).toEqual([]);
  });

  it("holds back a pull request whose head is not the one its reviewers approved (P1-1)", () => {
    // QA, the designer or the docs Agent pushed after the approvals.
    const later = { ...passing, head: "d".repeat(40) };
    expect(heldBack(later)).toEqual([
      "commits were pushed after Grace and Quinta approved it",
    ]);
    expect(approvedBefore(later)).toEqual(["Grace", "Quinta"]);
    // One approved the head; the other an earlier one.
    const one = {
      ...passing,
      verdicts: [
        approval(2, "grace"),
        { ...approval(2, "quinta"), headSha: "d".repeat(40) },
      ],
      head: "d".repeat(40),
    };
    expect(heldBack(one)).toEqual([
      "commits were pushed after Grace approved it",
    ]);
    // A reviewer who has not approved is not said to have approved before.
    expect(
      approvedBefore({
        ...later,
        verdicts: [approval(2, "grace"), rejection(2, "quinta")],
      }),
    ).toEqual(["Grace"]);
    expect(approvedBefore(passing)).toEqual([]);
  });

  it("knows whether the Review Loop has a round left", () => {
    // Two rounds of review and two of QA: a third round is within both caps.
    expect(roundLeft(passing)).toBe(true);
    expect(roundLeft({ ...passing, roundCap: 2 })).toBe(false);
    // Within the Round Cap, but at the overall cap (3 + 3 - 1 = 5).
    expect(roundLeft({ ...passing, reports: [qa(1), qa(2), qa(3)] })).toBe(
      false,
    );
  });

  it("holds back a pull request past any cap", () => {
    expect(heldBack({ ...passing, roundCap: 1 })).toEqual([
      "its Review Loop ran 2 rounds, past the Round Cap of 1",
      "it had 4 rounds of review and QA, past the overall cap of 3",
    ]);
    expect(
      heldBack({ ...passing, reports: [qa(1), qa(2), qa(3), qa(4)] }),
    ).toEqual([
      "QA ran 4 rounds, past QA's Round Cap of 3",
      "it had 6 rounds of review and QA, past the overall cap of 5",
    ]);
    expect(
      heldBack({ ...passing, reports: [qa(1), qa(2), qa(3)], roundCap: 2 }),
    ).toEqual(["it had 5 rounds of review and QA, past the overall cap of 4"]);
    expect(
      heldBack({
        ...passing,
        capsReached: [
          { agentName: "Ada", period: "daily" },
          { period: "monthly" },
        ],
      }),
    ).toEqual([
      "Ada reached a daily Token Cap working on it",
      "a monthly Token Cap was reached on its work",
    ]);
  });
});

describe("CI on the head commit", () => {
  it("passes when every check that ran passed, and every required one ran", () => {
    const ci = ciOf(
      [
        check("test", "completed", "success"),
        check("lint", "completed", "neutral"),
        check("deploy preview", "completed", "skipped"),
      ],
      ["test", "lint"],
    );
    expect(ci.state).toBe("passed");
    expect(ciHeldBack(ci, 0)).toBeUndefined();
    expect(ciRunOf(ci)?.name).toBe("test");
  });

  it("fails on any check that did not pass, required or not", () => {
    for (const conclusion of [
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "stale",
    ] as const) {
      const failed = check("e2e", "completed", conclusion);
      const ci = ciOf(
        [
          check("test", "completed", "success"),
          failed,
          check("lint", "queued"),
        ],
        ["test"],
      );
      expect(ci).toEqual({ state: "failed", failed });
      expect(ciRunOf(ci)).toBe(failed);
    }
    expect(
      ciHeldBack(ciOf([check("e2e", "completed", "failure")], []), 0),
    ).toBe('CI check "e2e" failed');
    expect(
      ciHeldBack(ciOf([check("e2e", "completed", "timed_out")], []), 0),
    ).toBe('CI check "e2e" timed out');
  });

  it("counts a check run again by its latest run", () => {
    expect(
      ciOf(
        [
          check("test", "completed", "failure"),
          check("test", "completed", "success"),
        ],
        [],
      ).state,
    ).toBe("passed");
    expect(
      ciOf(
        [check("test", "completed", "success"), check("test", "in_progress")],
        [],
      ).state,
    ).toBe("pending");
  });

  it("waits for checks still running, and for required checks to start", () => {
    const running = ciOf(
      [check("test", "in_progress"), check("lint", "completed", "success")],
      [],
    );
    expect(running).toMatchObject({ state: "pending", missing: [] });
    expect(ciHeldBack(running, 30)).toBe(
      'CI had not finished after 30 minutes ("test")',
    );
    const missing = ciOf(
      [check("test", "completed", "success")],
      ["test", "lint", "e2e"],
    );
    expect(missing).toMatchObject({
      state: "pending",
      running: [],
      missing: ["lint", "e2e"],
    });
    expect(ciHeldBack(missing, 30)).toBe(
      'the required checks "lint" and "e2e" never ran',
    );
  });

  it("knows when no CI ran at all", () => {
    const none = ciOf([], []);
    expect(none).toEqual({ state: "none" });
    expect(ciHeldBack(none, 5)).toBe("no CI check ran on it");
    expect(ciRunOf(none)).toBeUndefined();
    // A required check that has not started is waited for.
    expect(ciOf([], ["test"]).state).toBe("pending");
  });
});
