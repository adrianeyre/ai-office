import { describe, expect, it } from "vitest";

import {
  describeCommand,
  editDistance,
  issueList,
  readManagerCommand,
} from "./commands.ts";

// The Manager chat's commands (PRD FR-24), read in plain code: ranges and
// lists of issues, what was understood, typos and unreadable lists refused
// with a hint, and everything else left for the Manager's Model.

const command = (text: string) => {
  const reading = readManagerCommand(text);
  if (reading.kind !== "command") {
    throw new Error(`"${text}" was read as ${JSON.stringify(reading)}`);
  }
  return reading.command;
};

const hint = (text: string): string => {
  const reading = readManagerCommand(text);
  if (reading.kind !== "refused") {
    throw new Error(`"${text}" was read as ${JSON.stringify(reading)}`);
  }
  return reading.hint;
};

describe("ranges", () => {
  it.each([
    "complete issues 1 to 5",
    "complete issues 1-5",
    "complete issues 1 - 5",
    "complete issues 1–5",
    "complete issues 1 through 5",
    "complete issues 1 thru 5",
    "complete issues #1 to #5",
    "complete 1 to 5",
    "Complete Issues 1 To 5",
    "  complete issues 1 to 5.  ",
    "please complete issues 1 to 5",
    "complete issues 1 to 5, please",
  ])("reads %j as issues 1 to 5", (text) => {
    expect(command(text)).toEqual({
      kind: "complete",
      issues: [1, 2, 3, 4, 5],
    });
  });

  it("reads a range of one", () => {
    expect(command("complete issues 4 to 4")).toEqual({
      kind: "complete",
      issues: [4],
    });
  });

  it("joins ranges and single issues, each issue once", () => {
    expect(command("complete issues 1 to 3, 7 and 9-10")).toEqual({
      kind: "complete",
      issues: [1, 2, 3, 7, 9, 10],
    });
    expect(command("complete issues 1 to 3 and 2 to 4")).toEqual({
      kind: "complete",
      issues: [1, 2, 3, 4],
    });
  });

  it("refuses a range that runs backwards, saying which way it goes", () => {
    expect(hint("complete issues 5 to 1")).toBe(
      'A range goes from the lower number to the higher, such as "complete issues 1 to 5".',
    );
  });

  it("refuses more than 50 issues in one command", () => {
    expect(command("complete issues 1 to 50")).toMatchObject({
      kind: "complete",
    });
    expect(hint("complete issues 1 to 51")).toBe(
      "One command can name at most 50 issues; 1 to 51 is 51.",
    );
    expect(hint("complete issues 1 to 40, 100 to 120")).toBe(
      "One command can name at most 50 issues.",
    );
  });

  it("refuses an unfinished range or list", () => {
    for (const text of [
      "complete issues 1 to",
      "complete issues 1 -",
      "complete issues 1 and",
      "complete issues 1,",
      "complete issues to 5",
      "complete issues",
      "complete",
    ]) {
      expect(hint(text), text).toBe(
        'Say which issues, such as "complete issues 1 to 5" or "complete issues 1, 3 and 4"; end it "in one PR" to have them all in one pull request.',
      );
    }
  });

  it("refuses issue 0 and numbers no issue has", () => {
    expect(hint("complete issues 0 to 3")).toBe("Issue numbers start at 1.");
    expect(hint("skip 0")).toBe("Issue numbers start at 1.");
    expect(hint("skip 99999999999")).toBe(
      "99999999999 is not an issue number.",
    );
    expect(hint("move #3000000000 up")).toBe(
      "#3000000000 is not an issue number.",
    );
  });
});

describe("lists", () => {
  it.each([
    ["complete issues 1, 3 and 4", [1, 3, 4]],
    ["complete issues 1,3,4", [1, 3, 4]],
    ["complete issues 1 3 4", [1, 3, 4]],
    ["complete issues #1, #3, and #4", [1, 3, 4]],
    ["complete issues 1 & 3 & 4", [1, 3, 4]],
    ["complete issue 4", [4]],
    ["complete #4", [4]],
  ])("reads %j", (text, issues) => {
    expect(command(text)).toEqual({ kind: "complete", issues });
  });

  it("keeps the Owner's order, each issue once", () => {
    expect(command("complete issues 5, 1, 3, 5")).toEqual({
      kind: "complete",
      issues: [5, 1, 3],
    });
  });

  it("reads skip with one issue, a list or a range", () => {
    expect(command("skip 4")).toEqual({ kind: "skip", issues: [4] });
    expect(command("skip issue #4")).toEqual({ kind: "skip", issues: [4] });
    expect(command("Skip 4 and 6.")).toEqual({ kind: "skip", issues: [4, 6] });
    expect(command("skip issues 2-3")).toEqual({
      kind: "skip",
      issues: [2, 3],
    });
    expect(hint("skip")).toBe(
      'Say which issues to skip, such as "skip 4" or "skip 4 and 6".',
    );
  });

  it("reads move up and down", () => {
    expect(command("move 5 up")).toEqual({
      kind: "move",
      issue: 5,
      direction: "up",
    });
    expect(command("Move issue #5 down!")).toEqual({
      kind: "move",
      issue: 5,
      direction: "down",
    });
    for (const text of ["move 5", "move up", "move 5 6 up", "move 5 up 2"]) {
      expect(hint(text), text).toBe(
        'Say which issue and which way, such as "move 5 up" or "move 5 down".',
      );
    }
  });

  it("reads pause and resume on their own", () => {
    expect(command("pause")).toEqual({ kind: "pause" });
    expect(command("Pause.")).toEqual({ kind: "pause" });
    expect(command("RESUME")).toEqual({ kind: "resume" });
    expect(command("please resume")).toEqual({ kind: "resume" });
    expect(hint("pause 4")).toBe(
      '"pause" pauses the whole Floor, so it takes nothing after it: type "pause" on its own.',
    );
  });

  it("reads status, report and status report as the status report", () => {
    for (const text of [
      "status",
      "Status.",
      "please status",
      "report",
      "REPORT",
      "status report",
      "Status report, please",
    ]) {
      expect(command(text), text).toEqual({ kind: "report" });
    }
    expect(hint("status 4")).toBe(
      '"status" reports on the whole Floor, so it takes nothing after it: type "status" on its own.',
    );
    expect(hint("report status")).toBe(
      '"report" reports on the whole Floor, so it takes nothing after it: type "report" on its own.',
    );
  });
});

describe("one pull request", () => {
  it.each([
    "complete issues 1 to 5 in one PR",
    "complete issues 1 to 5 in one pull request",
    "complete issues 1 to 5 as one PR",
    "complete issues 1 to 5 in a single PR",
    "Complete Issues 1-5 In One PR.",
    "please complete issues 1 to 5 in one pr, please",
  ])("reads %j as issues 1 to 5 in one pull request", (text) => {
    expect(command(text)).toEqual({
      kind: "complete",
      issues: [1, 2, 3, 4, 5],
      onePullRequest: true,
    });
  });

  it("says so in what it understood", () => {
    expect(readManagerCommand("complete issues 1 to 3 in one PR")).toEqual({
      kind: "command",
      command: { kind: "complete", issues: [1, 2, 3], onePullRequest: true },
      understood:
        "Understood: complete 3 issues: #1, #2 and #3, in one pull request.",
    });
  });

  it("refuses it on any other command, saying where it goes", () => {
    for (const text of ["skip 4 in one PR", "pause in one PR"]) {
      expect(hint(text), text).toBe(
        '"in one PR" goes only with "complete", such as "complete issues 1 to 5 in one PR".',
      );
    }
  });

  it("refuses an unreadable list before it, with the usual hint", () => {
    expect(hint("complete issues 5 to 1 in one PR")).toBe(
      'A range goes from the lower number to the higher, such as "complete issues 1 to 5".',
    );
  });

  it("refuses a misspelt command before it with a hint", () => {
    expect(hint("compleet issues 1 to 5 in one PR")).toBe(
      'I did not understand that. Did you mean "complete issues 1 to 5 in one pr"?',
    );
  });

  it("leaves sentences that only mention a pull request alone", () => {
    for (const text of [
      "complete issues 1 to 5 in one PR?",
      "complete issues 1 to 5 in two PRs",
      "can you do issues 1 to 5 in one PR",
    ]) {
      expect(readManagerCommand(text), text).toEqual({ kind: "message" });
    }
  });
});

describe("typos", () => {
  it.each([
    ["compleet issues 1 to 5", "complete issues 1 to 5"],
    ["complte issues 1 to 5", "complete issues 1 to 5"],
    ["compelte 1-5", "complete 1-5"],
    ["complete isues 1 to 5", "complete issues 1 to 5"],
    ["complete issues 1 thorugh 5", "complete issues 1 through 5"],
    ["skp 4", "skip 4"],
    ["mvoe 5 up", "move 5 up"],
    ["move 5 dwon", "move 5 down"],
    ["puase", "pause"],
    ["resme", "resume"],
    ["Paused.", "pause"],
    ["stauts", "status"],
    ["reprot", "report"],
    ["status reprot", "status report"],
  ])("refuses %j with a hint", (typed, meant) => {
    expect(hint(typed)).toBe(
      `I did not understand that. Did you mean "${meant}"?`,
    );
  });

  it("says what is also wrong with a misspelt command", () => {
    expect(hint("skp")).toBe(
      'I did not understand that. Did you mean "skip"? Say which issues to skip, such as "skip 4" or "skip 4 and 6".',
    );
  });

  it("leaves sentences alone, even ones that start with a command's word", () => {
    for (const text of [
      "What should we work on first?",
      "complete issues 1 to 5?",
      "Complete the docs before the API, please",
      "skip the flaky test in issue 4",
      "Move fast and fix things",
      "Pause for a moment: why is #4 blocked?",
      "Some issues are stuck",
      "resume after lunch",
      "status of issue 4?",
      "Report the flaky test as a bug",
      "What is the status?",
      "complete issues one to five",
      "issues 1 to 5",
      "",
      "   ",
      "4",
    ]) {
      expect(readManagerCommand(text), text).toEqual({ kind: "message" });
    }
  });
});

describe("what it understood", () => {
  it("names every issue, with ranges expanded", () => {
    expect(readManagerCommand("complete issues 1 to 5")).toEqual({
      kind: "command",
      command: { kind: "complete", issues: [1, 2, 3, 4, 5] },
      understood: "Understood: complete 5 issues: #1, #2, #3, #4 and #5.",
    });
    expect(describeCommand({ kind: "complete", issues: [4] })).toBe(
      "Understood: complete issue #4.",
    );
    expect(describeCommand({ kind: "skip", issues: [4] })).toBe(
      "Understood: skip issue #4.",
    );
    expect(describeCommand({ kind: "skip", issues: [4, 6] })).toBe(
      "Understood: skip 2 issues: #4 and #6.",
    );
    expect(describeCommand({ kind: "move", issue: 5, direction: "up" })).toBe(
      "Understood: move issue #5 up one place.",
    );
    expect(describeCommand({ kind: "pause" })).toBe(
      "Understood: pause this Floor's work.",
    );
    expect(describeCommand({ kind: "resume" })).toBe(
      "Understood: resume this Floor's work.",
    );
    expect(describeCommand({ kind: "report" })).toBe(
      "Understood: a status report on this Floor.",
    );
  });

  it("lists issues as people write them", () => {
    expect(issueList([1])).toBe("#1");
    expect(issueList([1, 2])).toBe("#1 and #2");
    expect(issueList([1, 2, 3])).toBe("#1, #2 and #3");
  });
});

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions and swaps as one edit", () => {
    expect(editDistance("skip", "skip")).toBe(0);
    expect(editDistance("skp", "skip")).toBe(1);
    expect(editDistance("skiip", "skip")).toBe(1);
    expect(editDistance("skop", "skip")).toBe(1);
    expect(editDistance("mvoe", "move")).toBe(1);
    expect(editDistance("compleet", "complete")).toBe(1);
    expect(editDistance("cmplte", "complete")).toBe(2);
    expect(editDistance("", "pause")).toBe(5);
  });
});
