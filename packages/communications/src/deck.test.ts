import type { WrapUpOutcome } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { linesPerSlide, reportDeck, type Slide } from "./deck.ts";
import {
  reportMarkdown,
  type BatchReport,
  type ReportIssue,
} from "./report.ts";

// A Wrap-up report as a short deck (PRD FR-92, Google Slides): a title
// slide, its outcomes, its issues and pull requests, its tokens and cost,
// read from the report's own Markdown, so it says what the report says at
// its detail level, and what the report quotes stays text.

const issue = (number: number, outcome: WrapUpOutcome): ReportIssue => ({
  issue: number,
  title: `Issue ${String(number)} [x](https://evil.example)`,
  agent: "Ada",
  dependsOn: [],
  outcome,
  pullRequest:
    outcome === "not_started"
      ? null
      : {
          number: number + 10,
          url: `https://github.com/o/r/pull/${String(number + 10)}`,
        },
  rounds: { review: 1, qa: 1 },
  tokens: 1000 * number,
  estimatedCostUsd: number / 10,
});

const report = (issues: readonly ReportIssue[]): BatchReport => ({
  batchId: 7,
  floor: { id: "web-shop", name: "Web shop", repository: "o/r" },
  startedAt: null,
  finishedAt: new Date("2026-10-10T10:50:00.000Z"),
  planVersion: 1,
  issues,
  parallel: [],
  leftOut: [],
  totals: {
    merged: issues.filter(({ outcome }) => outcome === "merged").length,
    closed: 0,
    blocked: issues.filter(({ outcome }) => outcome === "blocked").length,
    notStarted: issues.filter(({ outcome }) => outcome === "not_started")
      .length,
    tokens: issues.reduce((sum, one) => sum + one.tokens, 0),
    estimatedCostUsd: issues.reduce(
      (sum, one) => sum + one.estimatedCostUsd,
      0,
    ),
  },
});

const wrapUp = "https://office.example.com/floors/web-shop/whiteboard?batch=7";

/** A slide's paragraphs as text. */
const text = (slide: Slide | undefined) =>
  (slide?.body ?? []).map((runs) => runs.map((run) => run.text).join(""));

describe("a report's deck", () => {
  it("is a title slide, then its outcomes, issues and pull requests, and tokens and cost", () => {
    const deck = reportDeck(
      reportMarkdown(
        report([
          issue(1, "merged"),
          issue(2, "blocked"),
          issue(3, "not_started"),
        ]),
        "titles_and_summaries",
        "Two of three moved. **Bold** [link](https://evil.example)",
        wrapUp,
      ),
    );
    expect(deck.cover.title).toBe("AI Office: Batch 7 Wrap-up (Web shop)");
    expect(text(deck.cover)).toEqual([
      "Finished 10 Oct 2026, 10:50 UTC, on version 1 of the Plan: 1 of 3 issues merged, 1 blocked, 1 not started. 6,000 tokens, about $0.60 (estimated).",
      "Open the Wrap-up in AI Office",
    ]);
    expect(deck.cover.body[1]).toEqual([
      { text: "Open the Wrap-up in AI Office", link: wrapUp },
    ]);
    expect(deck.slides.map(({ title }) => title)).toEqual([
      "Outcomes",
      "Issues and pull requests",
      "Tokens and cost",
    ]);
    const [outcomes, issues, cost] = deck.slides;
    // The summary is text: its Markdown is never bold or a link.
    expect(outcomes?.body).toEqual([
      [{ text: "Two of three moved. **Bold** [link](https://evil.example)" }],
    ]);
    expect(text(issues)).toEqual([
      "#1 Issue 1 [x](https://evil.example) · Merged · PR #11",
      "#2 Issue 2 [x](https://evil.example) · Blocked · PR #12",
      "#3 Issue 3 [x](https://evil.example) · Not started · None",
    ]);
    expect(
      issues?.body.flatMap((runs) => runs.flatMap((run) => run.link ?? [])),
    ).toEqual([
      "https://github.com/o/r/issues/1",
      "https://github.com/o/r/pull/11",
      "https://github.com/o/r/issues/2",
      "https://github.com/o/r/pull/12",
      "https://github.com/o/r/issues/3",
    ]);
    expect(text(cost)).toEqual([
      "Total: 6,000 tokens, about $0.60 (estimated)",
      "#1 Issue 1 [x](https://evil.example): 1,000 tokens, $0.10; rounds (review, QA) 1, 1",
      "#2 Issue 2 [x](https://evil.example): 2,000 tokens, $0.20; rounds (review, QA) 1, 1",
      "#3 Issue 3 [x](https://evil.example): 3,000 tokens, $0.30; rounds (review, QA) 1, 1",
    ]);
    expect(cost?.body[0]?.every((run) => run.bold === true)).toBe(true);
  });

  it(`puts at most ${String(linesPerSlide)} lines on a slide, continuing on the next`, () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      issue(index + 1, "merged"),
    );
    const deck = reportDeck(
      reportMarkdown(report(many), "links_only", "Twenty merged.", wrapUp),
    );
    expect(deck.cover.title).toBe("AI Office: Batch 7 Wrap-up");
    expect(deck.slides.map(({ title }) => title)).toEqual([
      "Outcomes",
      "Issues and pull requests (1 of 3)",
      "Issues and pull requests (2 of 3)",
      "Issues and pull requests (3 of 3)",
      "Tokens and cost (1 of 3)",
      "Tokens and cost (2 of 3)",
      "Tokens and cost (3 of 3)",
    ]);
    const issueLines = deck.slides
      .filter(({ title }) => title.startsWith("Issues"))
      .flatMap(text);
    expect(issueLines).toHaveLength(20);
    // At "links only" an issue is its link, never its title.
    expect(issueLines[0]).toBe("#1 · Merged · PR #11");
    for (const slide of deck.slides) {
      expect(slide.body.length).toBeLessThanOrEqual(linesPerSlide);
    }
  });
});
