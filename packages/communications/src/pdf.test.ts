import { describe, expect, it } from "vitest";

import { escapeMarkdown } from "./markdown.ts";
import { pdfString, reportPdf, textWidth } from "./pdf.ts";
import { readPdf } from "./pdf-text.ts";

// A Wrap-up report as a PDF (PRD FR-92, Google Drive): a well-formed file
// whose pages say what the report's Markdown says, its links annotations,
// and whatever the report quotes only ever text.

const report = [
  "# AI Office: Batch 3 Wrap\\-up (Web shop)",
  "",
  "Finished 10 Oct 2026, 10:50 UTC: 1 of 2 issues merged.",
  "",
  "## Summary",
  "",
  escapeMarkdown(
    "One merged; one waits for the Owner [click](https://evil.example) **now**.",
  ),
  "",
  "## The Plan",
  "",
  "1. [#1](https://github.com/o/r/issues/1) Add a basket: Ada",
  "2. [#2](https://github.com/o/r/issues/2) Show the total, after #1",
  "",
  "## Results",
  "",
  "| Issue | Outcome | Pull request | Tokens |",
  "| --- | --- | --- | --- |",
  "| [#1](https://github.com/o/r/issues/1) Add a basket | Merged | [PR #11](https://github.com/o/r/pull/11) | 150,000 |",
  "| **Total** | 1 of 2 issues merged |  | 150,000 |",
  "",
  "- [#6](https://github.com/o/r/issues/6): it is closed",
  "",
  "[Open the Wrap-up in AI Office](https://office.example.com/floors/web-shop/whiteboard?batch=3)",
  "",
].join("\n");

describe("a report's PDF", () => {
  it("is a well-formed PDF whose page says what the report says, in order, with its headings bold", () => {
    const pdf = readPdf(reportPdf(report));
    expect(pdf.title).toBe("AI Office: Batch 3 Wrap-up (Web shop)");
    expect(pdf.pages).toHaveLength(1);
    const [page] = pdf.pages;
    expect(page?.lines).toEqual([
      "AI Office: Batch 3 Wrap-up (Web shop)",
      "Finished 10 Oct 2026, 10:50 UTC: 1 of 2 issues merged.",
      "Summary",
      "One merged; one waits for the Owner [click](https://evil.example) **now**.",
      "The Plan",
      "1. | #1 Add a basket: Ada",
      "2. | #2 Show the total, after #1",
      "Results",
      "Issue | Outcome | Pull request | Tokens",
      "#1 Add a basket | Merged | PR #11 | 150,000",
      "Total | 1 of 2 issues merged | 150,000",
      "• | #6: it is closed",
      "Open the Wrap-up in AI Office",
    ]);
    expect(page?.bold).toEqual(
      expect.arrayContaining([
        "AI Office: Batch 3 Wrap-up (Web shop)",
        "Summary",
        "Issue",
        "Total",
      ]),
    );
  });

  it("makes each link an annotation over its text; escaped Markdown is never a link", () => {
    const [page] = readPdf(reportPdf(report)).pages;
    expect(page?.links.map(({ url }) => url)).toEqual([
      "https://github.com/o/r/issues/1",
      "https://github.com/o/r/issues/2",
      "https://github.com/o/r/issues/1",
      "https://github.com/o/r/pull/11",
      "https://github.com/o/r/issues/6",
      "https://office.example.com/floors/web-shop/whiteboard?batch=3",
    ]);
    for (const { rect } of page?.links ?? []) {
      const [left = 0, bottom = 0, right = 0, top = 0] = rect;
      expect(right).toBeGreaterThan(left);
      expect(top).toBeGreaterThan(bottom);
    }
  });

  it("wraps long paragraphs within the margins, and runs over as many pages as it needs", () => {
    const long = Array.from(
      { length: 120 },
      (_, index) =>
        `Paragraph ${String(index + 1)}: ${"a fairly long sentence about the Batch ".repeat(4)}`,
    ).join("\n\n");
    const pdf = readPdf(reportPdf(`# Long\n\n${long}\n`));
    expect(pdf.pages.length).toBeGreaterThan(3);
    const lines = pdf.pages.flatMap((page) => page.lines);
    expect(lines.filter((line) => line.startsWith("Paragraph "))).toHaveLength(
      120,
    );
    expect(lines.at(-1)).toMatch(/the Batch$/);
    for (const line of lines) {
      expect(textWidth(line, 10.5, false)).toBeLessThanOrEqual(595.28 - 112);
    }
  });

  it("writes every character as ASCII: Latin-1 and WinAnsi's own escaped, anything else a question mark", () => {
    expect(pdfString("a (b) \\ c")).toBe(String.raw`(a \(b\) \\ c)`);
    expect(pdfString("Café – “ok” …")).toBe(
      String.raw`(Caf\351 \226 \223ok\224 \205)`,
    );
    const pdf = readPdf(reportPdf("# Café – 日本 “ok”\n\nPrix: £5 · 10 €\n"));
    expect(pdf.title).toBe("Café – ?? “ok”");
    expect(pdf.pages[0]?.lines).toEqual(["Café – ?? “ok”", "Prix: £5 · 10 €"]);
  });
});
