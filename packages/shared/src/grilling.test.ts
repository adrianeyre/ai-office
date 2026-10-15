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
  grillingSkillNames,
  grillingSourcePaths,
  grillingWritesDocuments,
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
  it("are /grilling and those adapted from Matt Pocock's, and only /to-tickets writes no documents", () => {
    expect(grillingSkillNames).toEqual([
      "grilling",
      "grill-with-docs",
      "wayfinder",
      "to-tickets",
      "to-spec",
    ]);
    expect(isGrillingSkillName("wayfinder")).toBe(true);
    expect(isGrillingSkillName("pr")).toBe(false);
    expect(
      grillingSkillNames.filter((name) => !grillingWritesDocuments(name)),
    ).toEqual([toTicketsSkillName]);
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
    for (const name of mattPocockSkillNames) {
      expect(isMattPocockSkill(name)).toBe(true);
    }
    expect(startsGrillingSession("to-tickets")).toBe(true);
    expect(startsGrillingSession("domain-modeling")).toBe(false);
    expect(instructionSkillNames).toContain("pr");
  });
});
