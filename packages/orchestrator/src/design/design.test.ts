import { describe, expect, it } from "vitest";

import { designCommentOf } from "./design.ts";
import { designChangesHandoff, designPassedHandoff } from "./handoff.ts";

const dee = {
  name: "Dee",
  role: "designer",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
} as const;

describe("the designer's comment", () => {
  it("says what it found, the fixes it made and the changes for the coder", () => {
    expect(
      designCommentOf(
        dee,
        { number: 3, cap: 3 },
        { result: "changes", summary: "Off the palette.", findings: "" },
        2,
      ),
    ).toBe(
      [
        "**Design changes requested** by Dee (designer, Claude claude-opus-5-5) in AI Office, design round 3 of 3.",
        "",
        "Off the palette.",
        "",
        "Design fixes made: 2 commits on this branch.",
        "",
        "### Changes for the coder",
        "",
        "None given.",
      ].join("\n"),
    );
  });
});

describe("the designer's Handoffs", () => {
  const report = {
    result: "changes",
    summary: "Off the palette.",
    findings: "1. Use the primary Button.",
  } as const;

  it("asks the coder for the changes, and says the rounds left", () => {
    expect(
      designChangesHandoff({
        round: 2,
        roundCap: 3,
        designer: "Dee",
        report,
        committed: 1,
      }),
    ).toEqual({
      changed:
        "Design round 2 of 3: Dee reviewed the UI against the style guide. Off the palette.",
      check:
        "Make the design changes asked for, and only those: 1. Use the primary Button.",
      risks:
        "One round of design review is left: if it still asks for changes, the pull request goes to the Owner. The designer committed 1 change of its own on the branch. Keep them.",
    });
  });

  it("passes on what QA handed it, or says what to check without", () => {
    const passed = {
      result: "pass",
      summary: "On the guide.",
      findings: "",
    } as const;
    expect(
      designPassedHandoff({
        round: 1,
        designer: "Dee",
        report: passed,
        committed: 0,
        qa: { changed: "QA passed.", check: "add()", risks: "Flaky CSS." },
      }),
    ).toEqual({
      changed:
        "Dee passed the design review in round 1: On the guide. QA passed.",
      check: "add()",
      risks: "Flaky CSS.",
    });
    expect(
      designPassedHandoff({
        round: 1,
        designer: "Dee",
        report: passed,
        committed: 0,
        qa: undefined,
      }),
    ).toEqual({
      changed: "Dee passed the design review in round 1: On the guide.",
      check: "That the change does what its issue asks.",
      risks: "None reported.",
    });
  });
});
