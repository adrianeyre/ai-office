import { describe, expect, it } from "vitest";

import { chatRequestSchema, maxRequestIssues } from "./chat-requests.ts";
import {
  goalCommand,
  managerCommandExamples,
  readGoalCommand,
} from "./manager-chat.ts";

// A chat request's decision (PRD FR-24, ADR 0004, ADR 0012): a Batch may
// work the Floor's existing issues as well as file new ones, saying how it
// read the Owner's descriptions; and `/goal` asks for one in the Owner's
// own words.

const newIssue = {
  title: "A page",
  body: "Build it.",
  acceptanceCriteria: ["It shows."],
  dependsOn: [],
  files: [],
  role: "coder",
};

const batch = (more: Record<string, unknown>) => ({
  decision: "batch",
  message: "The login issues.",
  roles: [],
  issues: [],
  ...more,
});

describe("a Batch decision", () => {
  it("names existing issues, how a description was read, and one pull request", () => {
    const value = batch({
      existingIssues: [12, 15],
      readings: [{ words: "the login issues", issues: [12, 15] }],
      onePullRequest: true,
    });
    expect(chatRequestSchema.parse(value)).toEqual(value);
  });

  it("still reads one that only files new issues, as before", () => {
    const value = batch({ issues: [newIssue] });
    expect(chatRequestSchema.parse(value)).toEqual(value);
  });

  it("keeps to its limits", () => {
    const fails = (value: unknown) =>
      !chatRequestSchema.safeParse(value).success;
    expect(fails(batch({ existingIssues: [0] }))).toBe(true);
    expect(fails(batch({ existingIssues: [1.5] }))).toBe(true);
    // Room for more existing issues than a request may work, so plain code
    // can refuse such a request in the Owner's words.
    expect(
      fails(
        batch({
          existingIssues: Array.from({ length: 50 }, (_, at) => at + 1),
        }),
      ),
    ).toBe(false);
    expect(
      fails(
        batch({
          existingIssues: Array.from({ length: 51 }, (_, at) => at + 1),
        }),
      ),
    ).toBe(true);
    expect(
      fails(
        batch({
          issues: Array.from({ length: maxRequestIssues + 1 }, () => newIssue),
        }),
      ),
    ).toBe(true);
    expect(fails(batch({ readings: [{ words: "", issues: [1] }] }))).toBe(true);
    expect(fails(batch({ onePullRequest: "yes" }))).toBe(true);
    expect(fails(batch({ extra: true }))).toBe(true);
  });
});

describe("/goal", () => {
  it("reads what the Owner wants after it", () => {
    expect(readGoalCommand("/goal get issues 1 to 5 done in one PR")).toEqual({
      words: "get issues 1 to 5 done in one PR",
    });
    expect(readGoalCommand("  /GOAL  fix the login\npage  ")).toEqual({
      words: "fix the login\npage",
    });
    expect(readGoalCommand(goalCommand)).toEqual({ words: "" });
  });

  it("leaves any other message alone", () => {
    for (const text of [
      "/goals",
      "/goalkeeper do it",
      "goal: fix the login",
      "/grilling the login",
      "",
    ]) {
      expect(readGoalCommand(text), text).toBeUndefined();
    }
  });

  it("is shown among the commands beside the chat", () => {
    expect(managerCommandExamples).toContain(
      "/goal get issues 1 to 5 done in one PR",
    );
    expect(managerCommandExamples).toContain("stop");
  });
});
