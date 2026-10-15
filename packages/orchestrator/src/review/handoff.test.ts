import { describe, expect, it } from "vitest";

import {
  approvalHandoff,
  coderHandoff,
  maxHandoffPart,
  parseHandoff,
  reviewersHandoff,
} from "./handoff.ts";
import type { VerdictRecord } from "./store.ts";

// Handoff summaries (PRD FR-26): what changed, what to check and known
// risks; the coder's in its own words where it gave them, the reviewers'
// from their verdicts.

const verdict = (
  agentId: string,
  kind: "approve" | "changes_requested",
  comments: VerdictRecord["verdict"]["comments"],
): VerdictRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round: 1,
  agentId,
  headSha: "a".repeat(40),
  verdict: { verdict: kind, summary: "Summary.", comments },
  reviewUrl:
    "https://github.com/adrianeyre/web-shop/pull/2#pullrequestreview-1",
  createdAt: new Date("2026-10-09T09:00:00.000Z"),
});

const names: Record<string, string> = { grace: "Grace", quinta: "Quinta" };
const nameOf = (id: string) => names[id] ?? id;

const graceApproves = verdict("grace", "approve", [
  { severity: "nit", path: "a.ts", line: 2, body: "Rename it." },
]);

const roundOne = [
  graceApproves,
  verdict("quinta", "changes_requested", [
    { severity: "blocking", path: "a.ts", line: 1, body: "Handle null." },
    { severity: "blocking", path: "b.ts", line: 9, body: "Add a test." },
  ]),
];

describe("parseHandoff", () => {
  it("reads the last <handoff> block's parts, across lines", () => {
    expect(
      parseHandoff(
        [
          "<handoff>Changed: an old one</handoff>",
          "All done.",
          "<HANDOFF>",
          "- Changed: Added add().",
          "  It pushes to the basket.",
          "* check: basket.ts",
          "Risks:   none",
          "</handoff>",
        ].join("\n"),
      ),
    ).toEqual({
      changed: "Added add().\n  It pushes to the basket.",
      check: "basket.ts",
      risks: "none",
    });
  });

  it("finds nothing without a block, and leaves out empty parts", () => {
    expect(parseHandoff(null)).toEqual({});
    expect(parseHandoff("Changed: not in a block")).toEqual({});
    expect(parseHandoff("<handoff>\nChanged:\nRisks: x\n</handoff>")).toEqual({
      risks: "x",
    });
  });

  it("cuts a long part", () => {
    const { changed } = parseHandoff(
      `<handoff>\nChanged: ${"x".repeat(maxHandoffPart * 2)}\n</handoff>`,
    );
    expect(changed).toHaveLength(maxHandoffPart);
    expect(changed?.endsWith("…")).toBe(true);
  });
});

describe("coderHandoff", () => {
  const issue = { number: 1, title: "Add a basket" };

  it("takes the coder's own words", () => {
    expect(
      coderHandoff({
        text: "<handoff>\nChanged: A.\nCheck: B.\nRisks: C.\n</handoff>",
        subjects: ["feat: x"],
        issue,
        fixing: [],
      }),
    ).toEqual({ changed: "A.", check: "B.", risks: "C." });
  });

  it("fills in what it left out from its commits, the issue or the comments it fixed", () => {
    expect(
      coderHandoff({
        text: "Done.",
        subjects: ["feat: a", "fix: b"],
        issue,
        fixing: [],
      }),
    ).toEqual({
      changed: "2 new commits: feat: a; fix: b.",
      check: "That it does what #1 asks: Add a basket",
      risks: "None reported.",
    });
    expect(
      coderHandoff({
        text: null,
        subjects: ["fix: c"],
        issue,
        fixing: [
          { reviewer: "Quinta", path: "a.ts", line: 1, body: "Handle null." },
        ],
      }),
    ).toMatchObject({
      changed: "1 new commit: fix: c.",
      check:
        "That these blocking comments are fixed: a.ts line 1 (Quinta): Handle null.",
    });
    expect(
      coderHandoff({
        text: null,
        subjects: ["fix: d"],
        issue,
        fixing: [],
        fixingQa: "Adding a sku twice fails.",
      }).check,
    ).toBe("That what QA found failing is fixed: Adding a sku twice fails.");
  });

  it("warns the reviewers when the branch could not be rebased onto the default branch", () => {
    const base = "fedcba9876543210fedcba9876543210fedcba98";
    expect(
      coderHandoff({
        text: "<handoff>\nChanged: A.\nRisks: No tests.\n</handoff>",
        subjects: [],
        issue,
        fixing: [],
        rebase: {
          outcome: "conflict",
          onto: "main",
          base,
          files: ["src/basket.ts"],
        },
      }).risks,
    ).toBe(
      "It could not be rebased onto main, which has changed since the work began: src/basket.ts conflict. It is reviewed as it is, and needs main merged in before it can merge. No tests.",
    );
    expect(
      coderHandoff({
        text: "<handoff>\nRisks: No tests.\n</handoff>",
        subjects: [],
        issue,
        fixing: [],
        rebase: { outcome: "rebased", onto: "main", base },
      }).risks,
    ).toBe("No tests.");
  });
});

describe("reviewersHandoff", () => {
  it("says who asked for what, the blocking comments only, and the rounds left", () => {
    expect(
      reviewersHandoff({ round: 1, roundCap: 3, verdicts: roundOne, nameOf }),
    ).toEqual({
      changed: "Round 1 of 3: Quinta requested changes; Grace approved.",
      check:
        "Fix these 2 blocking comments, and only them: a.ts line 1 (Quinta): Handle null.; b.ts line 9 (Quinta): Add a test.",
      risks:
        "1 nit was left aside. 2 rounds are left before the pull request goes to the Owner.",
    });
    expect(
      reviewersHandoff({ round: 2, roundCap: 3, verdicts: roundOne, nameOf })
        .risks,
    ).toContain("One round is left");
  });
});

describe("approvalHandoff", () => {
  it("carries the coder's Handoff on, with the nits left aside", () => {
    expect(
      approvalHandoff({
        round: 2,
        verdicts: [graceApproves, verdict("quinta", "approve", [])],
        nameOf,
        coder: { changed: "Added add().", check: "add()", risks: "No tests." },
      }),
    ).toEqual({
      changed:
        "Approved by Grace and Quinta in round 2 of the Review Loop. Added add().",
      check: "add()",
      risks: "No tests. Nits left aside: a.ts line 2 (Grace): Rename it.",
    });
  });
});
