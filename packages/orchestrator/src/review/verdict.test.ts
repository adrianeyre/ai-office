import { describe, expect, it } from "vitest";

import { parseVerdict } from "./verdict.ts";

// A reviewer's answer read as a verdict (PRD FR-20): the schema, and the
// problems a reviewer is told of when its answer is not one.

const valid = {
  verdict: "changes_requested",
  summary: "No way to add an item.",
  comments: [
    { severity: "blocking", path: "src/basket.ts", line: 3, body: "Add one." },
    { severity: "nit", path: "README.md", line: 1, body: "Mention it." },
  ],
};

describe("parseVerdict", () => {
  it("reads a verdict alone, in a code fence, or among other words", () => {
    for (const text of [
      JSON.stringify(valid),
      `\`\`\`json\n${JSON.stringify(valid, null, 2)}\n\`\`\``,
      `My verdict follows.\n${JSON.stringify(valid)}\nThanks.`,
    ]) {
      expect(parseVerdict(text)).toEqual({ ok: true, verdict: valid });
    }
  });

  it("approves with nits alone, or with nothing to say", () => {
    for (const comments of [[], [valid.comments[1]]]) {
      expect(
        parseVerdict(
          JSON.stringify({ verdict: "approve", summary: "Fine.", comments }),
        ).ok,
      ).toBe(true);
    }
  });

  it.each([
    ["no JSON at all", "Looks good to me!", "It has no JSON object."],
    ["broken JSON", '{"verdict": "approve",', "It has no JSON object."],
    [
      "JSON that does not parse",
      '{"verdict": approve}',
      "It is not valid JSON",
    ],
    [
      "an unknown verdict",
      JSON.stringify({ ...valid, verdict: "maybe" }),
      'verdict: The verdict is "approve" or "changes_requested".',
    ],
    [
      "an approval with a blocking comment",
      JSON.stringify({ ...valid, verdict: "approve" }),
      "verdict: An approval has no blocking comments",
    ],
    [
      "changes requested with only nits",
      JSON.stringify({ ...valid, comments: [valid.comments[1]] }),
      "verdict: Changes requested needs at least one blocking comment",
    ],
    [
      "a comment without a line",
      JSON.stringify({
        ...valid,
        comments: [{ severity: "blocking", path: "a.ts", body: "No." }],
      }),
      "comments.0.line: A comment's line is a whole number from 1.",
    ],
    [
      "a severity that is neither",
      JSON.stringify({
        ...valid,
        comments: [{ severity: "major", path: "a.ts", line: 1, body: "No." }],
      }),
      'comments.0.severity: A comment\'s severity is "blocking" or "nit".',
    ],
    [
      "a field the schema does not have",
      JSON.stringify({ ...valid, score: 7 }),
      "score",
    ],
    [
      "no summary",
      JSON.stringify({ ...valid, summary: " " }),
      "summary: Give a summary of the review.",
    ],
  ])("refuses %s, saying why", (_name, text, problem) => {
    const parsed = parseVerdict(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.problem).toContain(problem);
  });

  it("names at most five problems", () => {
    const parsed = parseVerdict(
      JSON.stringify({
        verdict: "approve",
        summary: "Fine.",
        comments: Array.from({ length: 8 }, () => ({ severity: "nit" })),
      }),
    );
    expect(parsed.ok ? "" : parsed.problem).toMatch(/\(and \d+ more\)$/);
  });
});
