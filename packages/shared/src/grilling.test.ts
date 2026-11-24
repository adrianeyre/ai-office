import { describe, expect, it } from "vitest";

import {
  instructionSkillNames,
  isMattPocockSkill,
  mattPocockSkillNames,
  startsGrillingSession,
} from "./built-in-skills.ts";
import {
  composeGrillingAnswers,
  draftGrillingIssuesText,
  fileGrillingIssuesText,
  grillingDraftsIssues,
  grillingSkillNames,
  grillingSourcePaths,
  grillingTurnSchema,
  grillingWritesDocuments,
  grillingWritesGuidelines,
  grillingWritesSpec,
  guidelinesSkillName,
  confirmSpecPhaseText,
  reopenSpecPhaseText,
  skipSpecDesignText,
  specSkillName,
  isGrillingSkillName,
  toTicketsSkillName,
  pauseGrillingText,
  readGrillingAnswers,
  endGrillingText,
  readGrillingControl,
  resumeGrillingText,
} from "./grilling.ts";

describe("readGrillingAnswers", () => {
  it("reads one answer per line, in the forms the Owner writes them", () => {
    expect(
      readGrillingAnswers(
        "1: Postgres\n2. recommended\nQ3) Only the Owner\n#4 - CSV and JSON\n5 recommended",
      ),
    ).toEqual({
      answers: [
        { number: 1, answer: "Postgres" },
        { number: 2, answer: null },
        { number: 3, answer: "Only the Owner" },
        { number: 4, answer: "CSV and JSON" },
        { number: 5, answer: null },
      ],
      restRecommended: false,
      bare: false,
    });
  });

  it("reads 'recommended to all', alone or after answers", () => {
    for (const text of [
      "recommended to all",
      "Recommended to all.",
      "accept the recommended answers for the rest",
      "All recommended!",
    ]) {
      expect(readGrillingAnswers(text)).toEqual({
        answers: [],
        restRecommended: true,
        bare: false,
      });
    }
    expect(readGrillingAnswers("2: No\nrecommended to all")).toEqual({
      answers: [{ number: 2, answer: "No" }],
      restRecommended: true,
      bare: false,
    });
  });

  it("reads a bare 'recommended' as such", () => {
    expect(readGrillingAnswers("Recommended.")).toEqual({
      answers: [],
      restRecommended: true,
      bare: true,
    });
  });

  it("continues an answer on the lines that follow it, and keeps the last of a number", () => {
    expect(
      readGrillingAnswers(
        "1: Postgres,\nwith one database per Floor\n1: SQLite",
      ),
    ).toMatchObject({ answers: [{ number: 1, answer: "SQLite" }] });
    expect(
      readGrillingAnswers("2: Two parts:\n- the server\n- the web app"),
    ).toMatchObject({
      answers: [
        { number: 2, answer: "Two parts:\n- the server\n- the web app" },
      ],
    });
  });

  it("answers nothing for a message without a numbered answer", () => {
    expect(
      readGrillingAnswers("Why do you recommend Postgres?"),
    ).toBeUndefined();
    expect(readGrillingAnswers("In 2026 we moved.")).toBeUndefined();
    expect(readGrillingAnswers("0: nothing")).toBeUndefined();
  });

  it("reads back what the cards compose", () => {
    const text = composeGrillingAnswers(
      [
        { number: 4, answer: "  Weekly  " },
        { number: 6, answer: null },
      ],
      true,
    );
    expect(text).toBe("4: Weekly\n6: recommended\nrecommended to all");
    expect(readGrillingAnswers(text)).toEqual({
      answers: [
        { number: 4, answer: "Weekly" },
        { number: 6, answer: null },
      ],
      restRecommended: true,
      bare: false,
    });
  });
});

describe("readGrillingControl", () => {
  it("reads pausing, resuming and confirming", () => {
    expect(readGrillingControl("Pause the session.")).toEqual({
      kind: "pause",
    });
    expect(readGrillingControl("pause grilling session")).toEqual({
      kind: "pause",
    });
    expect(readGrillingControl("please resume the session")).toEqual({
      kind: "resume",
      session: null,
    });
    expect(readGrillingControl(resumeGrillingText(3))).toEqual({
      kind: "resume",
      session: 3,
    });
    expect(readGrillingControl(pauseGrillingText)).toEqual({ kind: "pause" });
    expect(readGrillingControl("Confirm")).toEqual({ kind: "confirm" });
    expect(readGrillingControl("yes, confirm and end the session")).toEqual({
      kind: "confirm",
    });
  });

  it("reads ending the session now (FR-83a)", () => {
    expect(readGrillingControl(endGrillingText)).toEqual({ kind: "end" });
    expect(readGrillingControl("End the grilling session now.")).toEqual({
      kind: "end",
    });
    expect(readGrillingControl("please finish the session")).toEqual({
      kind: "end",
    });
    expect(readGrillingControl("stop session")).toEqual({ kind: "end" });
    // Confirming still confirms, and anything longer is a message.
    expect(readGrillingControl("confirm and end the session")).toEqual({
      kind: "confirm",
    });
    expect(
      readGrillingControl("end the session once the API is settled"),
    ).toBeUndefined();
  });

  it("reads drafting and filing an ended session's issues", () => {
    expect(readGrillingControl(draftGrillingIssuesText(3))).toEqual({
      kind: "draft-issues",
      session: 3,
    });
    expect(readGrillingControl("Draft the issues again, please.")).toEqual({
      kind: "draft-issues",
      session: null,
    });
    expect(readGrillingControl("redraft issues for session #2")).toEqual({
      kind: "draft-issues",
      session: 2,
    });
    expect(readGrillingControl(fileGrillingIssuesText(3))).toEqual({
      kind: "file-issues",
      session: 3,
    });
    expect(readGrillingControl("Approve the issues")).toEqual({
      kind: "file-issues",
      session: null,
    });
    expect(
      readGrillingControl("approve and file the issues of grilling session 4"),
    ).toEqual({ kind: "file-issues", session: 4 });
  });

  it("reads \"… in one PR\" after filing a session's issues, for a Spec's Batch (FR-115)", () => {
    expect(readGrillingControl(fileGrillingIssuesText(7, true))).toEqual({
      kind: "file-issues",
      session: 7,
      onePullRequest: true,
    });
    expect(
      readGrillingControl(
        "Please file the issues of session 7 as a single pull request.",
      ),
    ).toEqual({ kind: "file-issues", session: 7, onePullRequest: true });
    expect(readGrillingControl("file the issues in one PR, please")).toEqual({
      kind: "file-issues",
      session: null,
      onePullRequest: true,
    });
    expect(
      readGrillingControl("file the issues of session 7 in two PRs"),
    ).toBeUndefined();
  });

  it("reads a /spec session's phases: confirm, skip design and reopen (FR-113)", () => {
    expect(readGrillingControl("confirm requirements")).toEqual({
      kind: "confirm-phase",
      phase: "requirements",
    });
    expect(readGrillingControl("Yes, confirm the design.")).toEqual({
      kind: "confirm-phase",
      phase: "design",
    });
    expect(readGrillingControl(confirmSpecPhaseText("tasks"))).toEqual({
      kind: "confirm-phase",
      phase: "tasks",
    });
    expect(readGrillingControl(skipSpecDesignText)).toEqual({
      kind: "skip-design",
    });
    expect(readGrillingControl("Please skip the design")).toEqual({
      kind: "skip-design",
    });
    expect(readGrillingControl(reopenSpecPhaseText("requirements"))).toEqual({
      kind: "reopen",
      phase: "requirements",
    });
    expect(readGrillingControl("go back to the design")).toEqual({
      kind: "reopen",
      phase: "design",
    });
    expect(readGrillingControl("re-open the tasks please")).toEqual({
      kind: "reopen",
      phase: "tasks",
    });
    expect(readGrillingControl("confirm the plan")).toBeUndefined();
    expect(
      readGrillingControl("skip design for the admin pages"),
    ).toBeUndefined();
    expect(readGrillingControl("reopen issue 4")).toBeUndefined();
  });

  it("leaves everything else, the Floor's own pause included", () => {
    expect(
      readGrillingControl("file the issues about the basket"),
    ).toBeUndefined();
    expect(readGrillingControl("pause")).toBeUndefined();
    expect(readGrillingControl("resume")).toBeUndefined();
    expect(readGrillingControl("confirm the plan for #4")).toBeUndefined();
  });
});

describe("the built-in Skills that start a Grilling Session", () => {
  it("are /grilling, those adapted from Matt Pocock's, /guidelines and /spec, and only /to-tickets writes no documents", () => {
    expect(grillingSkillNames).toEqual([
      "grilling",
      "grill-with-docs",
      "wayfinder",
      "to-tickets",
      "to-spec",
      "guidelines",
      "spec",
    ]);
    expect(isGrillingSkillName("wayfinder")).toBe(true);
    expect(isGrillingSkillName("pr")).toBe(false);
    expect(
      grillingSkillNames.filter((name) => !grillingWritesDocuments(name)),
    ).toEqual([toTicketsSkillName]);
  });

  it("has only /guidelines write Guidelines, and draft no issues", () => {
    expect(isGrillingSkillName(guidelinesSkillName)).toBe(true);
    expect(grillingSkillNames.filter(grillingWritesGuidelines)).toEqual([
      guidelinesSkillName,
    ]);
    expect(
      grillingSkillNames.filter((name) => !grillingDraftsIssues(name)),
    ).toEqual([guidelinesSkillName]);
  });

  it("has only /spec write a Spec, which drafts issues from its tasks; /to-spec still writes a PRD", () => {
    expect(isGrillingSkillName(specSkillName)).toBe(true);
    expect(grillingSkillNames.filter(grillingWritesSpec)).toEqual([
      specSkillName,
    ]);
    expect(grillingDraftsIssues(specSkillName)).toBe(true);
    expect(grillingWritesDocuments(specSkillName)).toBe(true);
    expect(grillingWritesSpec("to-spec")).toBe(false);
    expect(grillingWritesGuidelines(specSkillName)).toBe(false);
  });

  it("reads the PRDs and ADRs /to-tickets names, once each, and nothing else", () => {
    expect(
      grillingSourcePaths(
        "@docs/product-requirements-document/gift-cards.md, `docs/architectural-decision-record/0003-cards.md` and docs/product-requirements-document/gift-cards.md; also README.md, docs/processes/x.md and docs/product-requirements-document/../../.env",
      ),
    ).toEqual([
      "docs/product-requirements-document/gift-cards.md",
      "docs/architectural-decision-record/0003-cards.md",
    ]);
    expect(
      grillingSourcePaths(
        Array.from(
          { length: 8 },
          (_, index) =>
            `docs/architectural-decision-record/000${String(index)}-a.md`,
        ).join(" "),
      ),
    ).toHaveLength(5);
    expect(grillingSourcePaths("break the gift cards PRD down")).toEqual([]);
  });
});

describe("the built-in Skills' names", () => {
  it("credit Matt Pocock for every built-in Skill but /grilling, and say which start a session", () => {
    expect(isMattPocockSkill("grilling")).toBe(false);
    expect(isMattPocockSkill("guidelines")).toBe(false);
    expect(startsGrillingSession("guidelines")).toBe(true);
    expect(isMattPocockSkill("spec")).toBe(false);
    expect(startsGrillingSession("spec")).toBe(true);
    for (const name of mattPocockSkillNames) {
      expect(isMattPocockSkill(name)).toBe(true);
    }
    expect(startsGrillingSession("to-tickets")).toBe(true);
    expect(startsGrillingSession("domain-modeling")).toBe(false);
    expect(instructionSkillNames).toContain("pr");
  });
});

describe("a /guidelines turn's Guidelines (FR-109)", () => {
  const turn = (guidelines: unknown[]) =>
    grillingTurnSchema.safeParse({ guidelines });
  const problems = (guidelines: unknown[]) => {
    const parsed = turn(guidelines);
    return parsed.success
      ? []
      : parsed.error.issues.map(({ message }) => message);
  };

  it("are always by default, with a name, a description and rules", () => {
    const parsed = grillingTurnSchema.parse({
      guidelines: [
        {
          name: " Tech ",
          description: "The stack and its tools.",
          text: "Use pnpm, never npm.",
        },
        {
          name: "migrations",
          inclusion: "fileMatch",
          fileMatchPatterns: ["packages/db/**"],
          description: "How migrations are written.",
          text: "Plain SQL.",
        },
      ],
    });
    expect(parsed.guidelines).toEqual([
      {
        name: "tech",
        inclusion: "always",
        fileMatchPatterns: [],
        description: "The stack and its tools.",
        text: "Use pnpm, never npm.",
      },
      {
        name: "migrations",
        inclusion: "fileMatch",
        fileMatchPatterns: ["packages/db/**"],
        description: "How migrations are written.",
        text: "Plain SQL.",
      },
    ]);
  });

  it("keep FR-102's rules: a fileMatch one needs patterns, an always one takes none, and names are lowercase letters, digits and dashes", () => {
    const base = { description: "A line.", text: "Rules." };
    expect(
      problems([{ ...base, name: "web", inclusion: "fileMatch" }]),
    ).toEqual([
      "The web Guideline is fileMatch, so it needs fileMatchPatterns: the globs of the files it applies to.",
    ]);
    expect(
      problems([{ ...base, name: "web", fileMatchPatterns: ["apps/**"] }]),
    ).toEqual([
      "The web Guideline is always, so it takes no fileMatchPatterns; make it fileMatch to apply it only to those files.",
    ]);
    expect(problems([{ ...base, name: "web_app" }])).toEqual([
      "A Guideline's name is lowercase letters, digits and dashes, such as migrations.",
    ]);
    expect(problems([{ ...base, name: "web", inclusion: "manual" }])).toEqual([
      "A Guideline's inclusion is always or fileMatch.",
    ]);
    expect(
      problems([{ ...base, name: "web", description: "Two\nlines." }]),
    ).toEqual(["A Guideline's description is one line."]);
  });

  it("keep product, tech and structure always", () => {
    for (const name of ["product", "tech", "structure"]) {
      expect(
        problems([
          {
            name,
            inclusion: "fileMatch",
            fileMatchPatterns: ["src/**"],
            description: "A line.",
            text: "Rules.",
          },
        ]),
      ).toEqual([
        `The ${name} Guideline is always: product, tech and structure apply to every task.`,
      ]);
    }
  });
});
