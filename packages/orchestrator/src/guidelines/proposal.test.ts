import { describe, expect, it } from "vitest";

import { parseQaReport } from "../qa/report.ts";
import { coderHandoff, parseHandoff } from "../review/handoff.ts";
import { withGuidelineProposals } from "./prompt.ts";
import {
  proposedGuideline,
  withoutGuidelineProposals,
  type ProposedGuideline,
} from "./proposal.ts";
import { techGuideline } from "./testing.ts";

// Reading the Guideline an Agent proposes (Guidelines, Specs and Hooks
// PRD, FR-110): one `<guideline name="…">` block at the end of a Handoff
// or QA report, read by plain code. One without a name, with a name that
// is not a Guideline's, empty, breaking a Guideline's rules or holding a
// credential is dropped; a name the Floor has no Guideline of proposes a
// new one. The block is never part of the Handoff or report itself.

const anthropicKey = "sk-ant-api03-pastedintoguideline-Qw3Er4Ty5Ui6Op7As8Df9";
const githubToken = "ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";

const handoff = (...inside: string[]): string =>
  [
    "I added the migration.",
    "",
    "<handoff>",
    "Changed: Added the orders table and its migration.",
    "Check: That the migration runs on an empty database.",
    "Risks: None.",
    ...inside,
    "</handoff>",
  ].join("\n");

const migrations = [
  '<guideline name="migrations">',
  "---",
  "inclusion: fileMatch",
  'fileMatchPattern: "packages/db/**"',
  "description: How migrations are written.",
  "---",
  "",
  "Write each migration as plain SQL, never edited once merged.",
  "</guideline>",
];

const migrationsFile = [
  "---",
  "inclusion: fileMatch",
  'fileMatchPattern: "packages/db/**"',
  "description: How migrations are written.",
  "---",
  "",
  "Write each migration as plain SQL, never edited once merged.",
  "",
].join("\n");

const kept = (proposed: ProposedGuideline) =>
  proposed.kind === "proposed"
    ? { name: proposed.name, content: proposed.content }
    : proposed;

describe("a proposed Guideline", () => {
  it("is the whole file in the Handoff's guideline block, front matter and all, for a Guideline the Floor has", () => {
    const proposed = proposedGuideline(handoff(...migrations), "handoff");
    expect(kept(proposed)).toEqual({
      name: "migrations",
      content: migrationsFile,
    });
    expect(proposed).toMatchObject({
      guideline: {
        inclusion: "fileMatch",
        fileMatchPatterns: ["packages/db/**"],
        description: "How migrations are written.",
        body: "Write each migration as plain SQL, never edited once merged.",
      },
    });
  });

  it("with an unknown name proposes a new Guideline, as `always` without front matter", () => {
    const proposed = proposedGuideline(
      handoff(
        "<guideline name='accessibility'>",
        "Every image has alt text.",
        "</guideline>",
      ),
      "handoff",
    );
    expect(kept(proposed)).toEqual({
      name: "accessibility",
      content: "Every image has alt text.\n",
    });
    expect(proposed).toMatchObject({ guideline: { inclusion: "always" } });
  });

  it("takes away the block's common indentation, and a name's .md", () => {
    expect(
      kept(
        proposedGuideline(
          handoff(
            '    <guideline name="migrations.md">',
            ...migrations.slice(1, -1).map((line) => `    ${line}`),
            "    </guideline>",
          ),
          "handoff",
        ),
      ),
    ).toEqual({ name: "migrations", content: migrationsFile });
  });

  it("is dropped without a name, or with a name that is not a Guideline's", () => {
    for (const open of [
      "<guideline>",
      '<guideline name="">',
      '<guideline title="migrations">',
    ]) {
      expect(
        proposedGuideline(
          handoff(open, "Use pnpm.", "</guideline>"),
          "handoff",
        ),
      ).toEqual({ kind: "dropped", reason: "no_name" });
    }
    for (const name of ["Tech", "db/migrations", "../tech", "tech guide"]) {
      expect(
        proposedGuideline(
          handoff(`<guideline name="${name}">`, "Use pnpm.", "</guideline>"),
          "handoff",
        ),
      ).toEqual({ kind: "dropped", reason: "invalid_name" });
    }
  });

  it("is dropped whole when a line looks like a credential, never kept redacted", () => {
    for (const secret of [
      `Call the API with ${anthropicKey}.`,
      `export GH_TOKEN=${githubToken}`,
    ]) {
      expect(
        proposedGuideline(
          handoff(
            '<guideline name="tech">',
            "Use pnpm.",
            secret,
            "</guideline>",
          ),
          "handoff",
        ),
      ).toEqual({ kind: "dropped", reason: "holds_secret" });
    }
  });

  it("is dropped when it is empty, or breaks a Guideline's rules", () => {
    expect(
      proposedGuideline(
        handoff('<guideline name="tech">', "  ", "</guideline>"),
        "handoff",
      ),
    ).toEqual({ kind: "dropped", reason: "empty" });
    expect(
      proposedGuideline(
        handoff(
          '<guideline name="migrations">',
          "---",
          "inclusion: fileMatch",
          "---",
          "Plain SQL.",
          "</guideline>",
        ),
        "handoff",
      ),
    ).toEqual({ kind: "dropped", reason: "invalid" });
    expect(
      proposedGuideline(
        handoff('<guideline name="tech">', "x".repeat(12_001), "</guideline>"),
        "handoff",
      ),
    ).toEqual({ kind: "dropped", reason: "invalid" });
  });

  it("is none without a block, or with one outside the Handoff", () => {
    expect(proposedGuideline(handoff(), "handoff")).toEqual({ kind: "none" });
    expect(proposedGuideline(null, "handoff")).toEqual({ kind: "none" });
    expect(
      proposedGuideline(`${handoff()}\n\n${migrations.join("\n")}`, "handoff"),
    ).toEqual({ kind: "none" });
    // The Guidelines quoted to a reviewer are no proposal.
    expect(
      proposedGuideline(
        handoff("<guidelines>", "Use pnpm.", "</guidelines>"),
        "handoff",
      ),
    ).toEqual({ kind: "none" });
  });

  it("is the last block of the last Handoff: one per Handoff", () => {
    const text = [
      handoff('<guideline name="tech">', "Use npm.", "</guideline>"),
      handoff(
        '<guideline name="tech">',
        "Use yarn.",
        "</guideline>",
        '<guideline name="tech">',
        "Use pnpm.",
        "</guideline>",
      ),
    ].join("\n\n");
    expect(kept(proposedGuideline(text, "handoff"))).toEqual({
      name: "tech",
      content: "Use pnpm.\n",
    });
  });

  it("is read from QA's report too", () => {
    const report = [
      "<qa-report>",
      "Result: pass",
      "Summary: The basket works.",
      "Steps: None.",
      '<guideline name="testing">',
      "Every bug fix comes with a test that failed before it.",
      "</guideline>",
      "</qa-report>",
    ].join("\n");
    expect(kept(proposedGuideline(report, "qa-report"))).toEqual({
      name: "testing",
      content: "Every bug fix comes with a test that failed before it.\n",
    });
    expect(proposedGuideline(report, "handoff")).toEqual({ kind: "none" });
  });
});

describe("a proposed Guideline reaches no Agent through the Handoff or report", () => {
  it("is left out of the Handoff the next Agent gets", () => {
    const text = handoff(...migrations);
    expect(parseHandoff(text)).toEqual({
      changed: "Added the orders table and its migration.",
      check: "That the migration runs on an empty database.",
      risks: "None.",
    });
    const summary = coderHandoff({
      text,
      subjects: [],
      issue: { number: 4, title: "Add orders" },
      fixing: [],
    });
    expect(JSON.stringify(summary)).not.toContain("plain SQL");
  });

  it("is left out of QA's report, which is posted on the pull request", () => {
    const report = parseQaReport(
      [
        "<qa-report>",
        "Result: fail",
        "Summary: The total is wrong.",
        "Steps: Add two of one item.",
        '<guideline name="testing">',
        "Every bug fix comes with a test.",
        "</guideline>",
        "</qa-report>",
      ].join("\n"),
    );
    expect(report).toEqual({
      result: "fail",
      summary: "The total is wrong.",
      steps: "Add two of one item.",
    });
  });

  it("is taken out of text, closed or not", () => {
    expect(
      withoutGuidelineProposals(
        'Risks: none.\n<guideline name="tech">\nUse pnpm.\n</guideline>\nDone.',
      ),
    ).toBe("Risks: none.\n\nDone.");
    expect(
      withoutGuidelineProposals('Risks: none.\n<guideline name="tech">\nUse'),
    ).toBe("Risks: none.\n");
  });
});

describe("how an Agent is told it may propose a Guideline", () => {
  it("only when its task is given Guidelines, so a prompt without them is as it was", () => {
    expect(withGuidelineProposals(undefined, "Handoff")).toEqual([]);
    expect(
      withGuidelineProposals(
        { task: "work", followed: [], listed: [], leftOut: [], budget: 12_000 },
        "Handoff",
      ),
    ).toEqual([]);
    const lines = withGuidelineProposals(
      {
        task: "qa",
        followed: [techGuideline],
        listed: [],
        leftOut: [],
        budget: 12_000,
      },
      "report",
    ).join("\n");
    expect(lines).toContain(
      "inside your report, just before its closing marker",
    );
    expect(lines).toContain('<guideline name="migrations">');
    expect(lines).toContain(
      "no Agent follows what you propose unless the Owner merges it",
    );
  });
});
