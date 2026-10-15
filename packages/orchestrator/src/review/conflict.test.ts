import type { ComparedFile } from "@ai-office/github";
import type { QaResult } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  conflictPositions,
  describeConflict,
  qaConflictOf,
  reviewConflictOf,
} from "./conflict.ts";
import type { QaReportRecord, VerdictRecord } from "./store.ts";

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
    summary: `${agentId} approves round ${String(round)}.`,
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
  ...paths: string[]
): VerdictRecord => ({
  ...approval(round, agentId),
  verdict: {
    verdict: "changes_requested",
    summary: "Keep both skus.",
    comments: paths.map((path) => ({
      severity: "blocking",
      path,
      line: 3,
      body: `Undo the change to ${path}.`,
    })),
  },
});

const qa = (
  round: number,
  result: QaResult,
  summary = "Adding the same sku twice fails.",
  steps = "1. add('a')\n2. add('a')\n3. The basket has two",
): QaReportRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round,
  agentId: "evelyn",
  headSha: "b".repeat(40),
  result,
  summary,
  steps: result === "pass" ? "" : steps,
  commentUrl: `${pull}#issuecomment-${String(round)}`,
  createdAt: new Date("2026-10-09T12:00:00Z"),
});

const file = (path: string): ComparedFile => ({
  path,
  status: "modified",
  additions: 4,
  deletions: 1,
  patch: null,
});

const names: Record<string, string> = { grace: "Grace", quinta: "Quinta" };
const nameOf = (agentId: string) => names[agentId] ?? agentId;

describe("qaConflictOf", () => {
  it("finds QA failing, as before, what every reviewer approved twice in a row", () => {
    expect(
      qaConflictOf({
        verdicts: [
          approval(1, "grace"),
          approval(1, "quinta"),
          approval(2, "grace"),
          approval(2, "quinta"),
        ],
        reports: [
          qa(1, "fail"),
          // The same failure, in other words.
          qa(2, "fail", "Adding the same sku twice still fails!"),
        ],
      }),
    ).toEqual({
      kind: "qa_against_reviewers",
      reviewRounds: [1, 2],
      qaRounds: [1, 2],
    });
  });

  it("finds none in QA's first round, or when QA passed the round before", () => {
    const verdicts = [approval(1, "grace"), approval(2, "grace")];
    expect(
      qaConflictOf({
        verdicts: verdicts.slice(0, 1),
        reports: [qa(1, "fail")],
      }),
    ).toBeUndefined();
    expect(
      qaConflictOf({ verdicts, reports: [qa(1, "pass"), qa(2, "fail")] }),
    ).toBeUndefined();
  });

  it("finds none when a reviewer asked for changes in either of the last two rounds", () => {
    const reports = [qa(1, "fail"), qa(2, "fail")];
    expect(
      qaConflictOf({
        verdicts: [
          approval(1, "grace"),
          rejection(2, "quinta", "src/basket.ts"),
          approval(2, "grace"),
          approval(3, "grace"),
          approval(3, "quinta"),
        ],
        reports,
      }),
    ).toBeUndefined();
  });

  it("finds none when QA found something new: that is the coder's to fix", () => {
    expect(
      qaConflictOf({
        verdicts: [approval(1, "grace"), approval(2, "grace")],
        reports: [
          qa(1, "fail"),
          qa(
            2,
            "fail",
            "Removing a sku that is not there throws.",
            "1. remove('z')",
          ),
        ],
      }),
    ).toBeUndefined();
  });
});

describe("reviewConflictOf", () => {
  const previous = [approval(1, "grace"), approval(1, "quinta")];

  it("finds the reviewers rejecting the coder's fix for what QA required", () => {
    expect(
      reviewConflictOf({
        current: [
          rejection(2, "grace", "src/basket.ts", "src/basket.ts", "README.md"),
          approval(2, "quinta"),
        ],
        previous,
        qa: qa(1, "fail"),
        fixed: [file("src/basket.ts"), file("test/basket.test.ts")],
      }),
    ).toEqual({
      kind: "reviewers_against_qa",
      round: 2,
      qaRound: 1,
      rejected: 2,
      of: 3,
    });
  });

  it("finds none when the blocking comments are mostly elsewhere: half is not most", () => {
    expect(
      reviewConflictOf({
        current: [rejection(2, "grace", "src/basket.ts", "README.md")],
        previous,
        qa: qa(1, "fail"),
        fixed: [file("src/basket.ts")],
      }),
    ).toBeUndefined();
  });

  it("finds none unless the previous round approved and QA then failed it", () => {
    const current = [rejection(2, "grace", "src/basket.ts")];
    const fixed = [file("src/basket.ts")];
    // The previous round asked for changes: this is the Review Loop's own.
    expect(
      reviewConflictOf({
        current,
        previous: [rejection(1, "grace", "src/basket.ts")],
        qa: qa(1, "fail"),
        fixed,
      }),
    ).toBeUndefined();
    // QA has not failed it, or not checked it at all.
    expect(
      reviewConflictOf({ current, previous, qa: qa(1, "pass"), fixed }),
    ).toBeUndefined();
    expect(
      reviewConflictOf({ current, previous, qa: undefined, fixed }),
    ).toBeUndefined();
    // Nothing blocking: no conflict.
    expect(
      reviewConflictOf({
        current: [approval(2, "grace")],
        previous,
        qa: qa(1, "fail"),
        fixed,
      }),
    ).toBeUndefined();
  });
});

describe("describeConflict", () => {
  it("says who disagrees, about what, for the Notice's title", () => {
    expect(
      describeConflict(
        {
          kind: "qa_against_reviewers",
          reviewRounds: [1, 2],
          qaRounds: [1, 2],
        },
        "PR #2 (#1)",
      ),
    ).toBe(
      "Review Loop conflict between Roles: QA failed PR #2 (#1) in QA round 2 as in round 1, though every reviewer approved it twice in a row.",
    );
    expect(
      describeConflict(
        {
          kind: "reviewers_against_qa",
          round: 2,
          qaRound: 1,
          rejected: 1,
          of: 1,
        },
        "PR #2 (#1)",
      ),
    ).toBe(
      "Review Loop conflict between Roles: in round 2, the reviewers rejected the fix QA required of PR #2 (#1) in QA round 1.",
    );
  });
});

describe("conflictPositions", () => {
  it("puts the reviewers' approval first, then QA's failure with its steps", () => {
    expect(
      conflictPositions({
        conflict: {
          kind: "qa_against_reviewers",
          reviewRounds: [1, 2],
          qaRounds: [1, 2],
        },
        verdicts: [
          approval(1, "grace"),
          approval(2, "grace"),
          approval(2, "quinta"),
        ],
        reports: [qa(1, "fail"), qa(2, "fail", "Still fails.")],
        nameOf,
      }),
    ).toEqual([
      {
        label: "Reviewers: approved in rounds 1 and 2",
        text: "Grace: grace approves round 2.\nQuinta: quinta approves round 2.",
        url: `${pull}#review-grace-2`,
      },
      {
        label: "QA: failed in QA rounds 1 and 2",
        text: "Still fails.\n\nSteps to reproduce:\n1. add('a')\n2. add('a')\n3. The basket has two",
        url: `${pull}#issuecomment-2`,
      },
    ]);
  });

  it("puts QA's failure first, then the reviewers' blocking comments on the fix", () => {
    expect(
      conflictPositions({
        conflict: {
          kind: "reviewers_against_qa",
          round: 2,
          qaRound: 1,
          rejected: 1,
          of: 1,
        },
        verdicts: [
          approval(1, "grace"),
          approval(2, "grace"),
          rejection(2, "quinta", "src/basket.ts"),
        ],
        reports: [qa(1, "fail")],
        nameOf,
      }),
    ).toEqual([
      {
        label: "QA: failed in QA round 1",
        text: "Adding the same sku twice fails.\n\nSteps to reproduce:\n1. add('a')\n2. add('a')\n3. The basket has two",
        url: `${pull}#issuecomment-1`,
      },
      {
        label: "Reviewers: changes requested in round 2",
        text: "Quinta: Keep both skus.\n\n- src/basket.ts line 3 (Quinta): Undo the change to src/basket.ts.",
        url: `${pull}#review-quinta-2`,
      },
    ]);
  });

  it("cuts what a side said to what a Notice holds", () => {
    const [, failed] = conflictPositions({
      conflict: {
        kind: "qa_against_reviewers",
        reviewRounds: [1, 2],
        qaRounds: [1, 2],
      },
      verdicts: [approval(1, "grace"), approval(2, "grace")],
      reports: [qa(1, "fail"), qa(2, "fail", "x".repeat(4000))],
      nameOf,
    });
    expect(failed?.text).toHaveLength(1500);
    expect(failed?.text.endsWith("…")).toBe(true);
  });
});
