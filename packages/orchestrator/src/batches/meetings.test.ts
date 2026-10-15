import type { StoredEvent } from "@ai-office/events";
import { describe, expect, it } from "vitest";

import { parseAcknowledgement } from "./kickoff.ts";
import {
  batchOutcomes,
  issueRecord,
  tokensInWords,
  type IssueNow,
} from "./wrap-up.ts";

// The Kickoff's acknowledgements and the Wrap-up's rule for when a Batch
// has finished (PRD FR-25.2, FR-25.6), as pure functions.

describe("an acknowledgement, from the Model's answer", () => {
  it.each(["OK", "ok", "Ok.", "  OK!  ", ""])("%j is OK", (answer) => {
    expect(parseAcknowledgement(answer)).toEqual({ response: "ok" });
  });

  it("a CONCERN: answer is that concern, without its label", () => {
    expect(parseAcknowledgement("CONCERN: #4 should wait for #2.")).toEqual({
      response: "concern",
      concern: "#4 should wait for #2.",
    });
    expect(parseAcknowledgement("**Concern**: run #3 first")).toEqual({
      response: "concern",
      concern: "run #3 first",
    });
  });

  it("anything else is one concern: its first line, on one line, cut to 300 characters", () => {
    const parsed = parseAcknowledgement(
      `\n  The basket   and the total\tclash. ${"x".repeat(400)}\nSecond line.`,
    );
    expect(parsed.response).toBe("concern");
    const concern = parsed.response === "concern" ? parsed.concern : "";
    expect(concern).toHaveLength(300);
    expect(concern.startsWith("The basket and the total clash. xxx")).toBe(
      true,
    );
    expect(concern.endsWith("…")).toBe(true);
    expect(concern).not.toContain("Second line");
  });

  it("a CONCERN: label with nothing after it is OK", () => {
    expect(parseAcknowledgement("CONCERN: OK")).toEqual({ response: "ok" });
  });
});

const open = (...labels: string[]): IssueNow => ({ state: "open", labels });
const closed: IssueNow = { state: "closed", labels: [] };

describe("whether a Batch has finished, and each issue's outcome", () => {
  const items = [
    { issue: 1, dependsOn: [] },
    { issue: 2, dependsOn: [1] },
    { issue: 3, dependsOn: [2] },
    { issue: 4, dependsOn: [] },
  ];

  it("finished once every issue is closed or blocked, or waits on one blocked", () => {
    expect(
      batchOutcomes(
        items,
        new Map([
          [1, closed],
          [2, open("ai-office", "needs-human")],
          [3, open("ai-office")],
          [4, closed],
        ]),
        (issue) => issue === 1,
      ),
    ).toEqual(
      new Map([
        [1, "merged"],
        [2, "blocked"],
        [3, "not_started"],
        [4, "closed"],
      ]),
    );
  });

  it("not finished while an issue is being worked, awaits the Owner at ready-to-merge, or could start", () => {
    const issues = (two: IssueNow) =>
      new Map([
        [1, closed],
        [2, two],
        [3, open()],
        [4, closed],
      ]);
    for (const two of [
      open("needs-review", "in-progress"),
      open("ready-to-merge"),
      open("ai-office"),
    ]) {
      expect(batchOutcomes(items, issues(two), () => true)).toBeUndefined();
    }
  });

  it("not finished with an issue it cannot read, or with conflicting stage labels", () => {
    expect(
      batchOutcomes(items, new Map([[1, closed]]), () => true),
    ).toBeUndefined();
    expect(
      batchOutcomes(
        [{ issue: 1, dependsOn: [] }],
        new Map([[1, open("needs-review", "needs-human")]]),
        () => true,
      ),
    ).toBeUndefined();
  });
});

describe("an issue's record, from its events", () => {
  const stored = (id: number, event: StoredEvent["event"]): StoredEvent => ({
    id,
    occurredAt: new Date(0),
    event,
  });
  const base = { version: 1, floorId: "web-shop", issue: 4 } as const;

  it("its latest pull request, whether AI Office merged it, and its most rounds", () => {
    expect(
      issueRecord([
        stored(9, {
          ...base,
          type: "qa.reported",
          agentId: "qa",
          pullRequest: 12,
          round: 2,
          result: "pass",
          url: "https://github.com/a/b/pull/12",
        }),
        stored(3, {
          ...base,
          type: "pull_request.opened",
          agentId: "ada",
          pullRequest: 11,
          url: "https://github.com/a/b/pull/11",
          branch: "ai-office/4-x",
        }),
        stored(5, {
          ...base,
          type: "pull_request.opened",
          agentId: "ada",
          pullRequest: 12,
          url: "https://github.com/a/b/pull/12",
          branch: "ai-office/4-y",
        }),
        stored(7, {
          ...base,
          type: "review.posted",
          agentId: "rex",
          pullRequest: 12,
          round: 3,
          verdict: "approve",
          blocking: 0,
          nits: 0,
          url: "https://github.com/a/b/pull/12#r",
        }),
        stored(6, {
          ...base,
          type: "review.posted",
          agentId: "rex",
          pullRequest: 12,
          round: 1,
          verdict: "changes_requested",
          blocking: 2,
          nits: 0,
          url: "https://github.com/a/b/pull/12#r1",
        }),
      ]),
    ).toEqual({
      pullRequest: { number: 12, url: "https://github.com/a/b/pull/12" },
      merged: false,
      rounds: { review: 3, qa: 2 },
    });
    expect(issueRecord([])).toEqual({
      pullRequest: null,
      merged: false,
      rounds: { review: 0, qa: 0 },
    });
  });
});

describe("tokens in words", () => {
  it.each([
    [0, "0 tokens"],
    [1, "1 token"],
    [999, "999 tokens"],
    [412_400, "412k tokens"],
    [1_000_000, "1M tokens"],
    [1_250_000, "1.3M tokens"],
  ])("%d is %s", (tokens, words) => {
    expect(tokensInWords(tokens)).toBe(words);
  });
});
