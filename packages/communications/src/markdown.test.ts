import { describe, expect, it } from "vitest";

import {
  confluenceStorage,
  escapeMarkdown,
  notionBlocks,
  notionRichText,
  parseInline,
  parseMarkdown,
} from "./markdown.ts";

// The Wrap-up report's Markdown subset (PRD FR-92), and its translations
// for Confluence (storage format) and Notion (blocks): escaped text stays
// text, whatever it says.

describe("the report's Markdown", () => {
  it("reads headings, paragraphs, lists and tables, with bold and links", () => {
    expect(
      parseMarkdown(
        [
          "# Batch 3",
          "",
          "Finished on",
          "Friday.",
          "",
          "1. [#1](https://github.com/a/b/issues/1) A **basket**",
          "2. Two",
          "",
          "- one",
          "- two",
          "",
          "| Issue | PR |",
          "| --- | --- |",
          "| #1 | [PR #9](https://github.com/a/b/pull/9) |",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "heading", level: 1, content: [{ text: "Batch 3" }] },
      { type: "paragraph", content: [{ text: "Finished on Friday." }] },
      {
        type: "list",
        ordered: true,
        items: [
          [
            { text: "#1", link: "https://github.com/a/b/issues/1" },
            { text: " A " },
            { text: "basket", bold: true },
          ],
          [{ text: "Two" }],
        ],
      },
      {
        type: "list",
        ordered: false,
        items: [[{ text: "one" }], [{ text: "two" }]],
      },
      {
        type: "table",
        header: [[{ text: "Issue" }], [{ text: "PR" }]],
        rows: [
          [
            [{ text: "#1" }],
            [{ text: "PR #9", link: "https://github.com/a/b/pull/9" }],
          ],
        ],
      },
    ]);
  });

  it("escaped text is only text: no link, no bold, no cell, no list, no heading", () => {
    const hostile = "# 1. **x** [y](https://evil.example) | z \\ - <b>";
    expect(parseInline(escapeMarkdown(hostile))).toEqual([{ text: hostile }]);
    const [block] = parseMarkdown(escapeMarkdown(hostile));
    expect(block).toEqual({ type: "paragraph", content: [{ text: hostile }] });
    expect(
      parseMarkdown(
        `| a | b |\n| --- | --- |\n| ${escapeMarkdown("x | y")} | z |`,
      ),
    ).toEqual([
      {
        type: "table",
        header: [[{ text: "a" }], [{ text: "b" }]],
        rows: [[[{ text: "x | y" }], [{ text: "z" }]]],
      },
    ]);
  });

  it("a link to anything but http or https is text", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { text: "[x](javascript:alert(1))" },
    ]);
  });

  it("a line starting with a pipe but no table is a paragraph", () => {
    expect(parseMarkdown("| not a table")).toEqual([
      { type: "paragraph", content: [{ text: "| not a table" }] },
    ]);
  });
});

describe("for Confluence", () => {
  it("is the storage format, with every text and address escaped", () => {
    expect(
      confluenceStorage(
        parseMarkdown(
          '## A & B\n\n[<x> "q"](https://e.example/?a=1&b=2)\n\n| H |\n| --- |\n| **c** |',
        ),
      ),
    ).toBe(
      '<h2>A &amp; B</h2><p><a href="https://e.example/?a=1&amp;b=2">&lt;x&gt; &quot;q&quot;</a></p><table><tbody><tr><th>H</th></tr><tr><td><strong>c</strong></td></tr></tbody></table>',
    );
  });
});

describe("for Notion", () => {
  it("is blocks: headings, paragraphs, list items and a table with a header row", () => {
    expect(
      notionBlocks(
        parseMarkdown(
          "### Hi\n\n- [a](https://a.example)\n\n| H | I |\n| --- | --- |\n| x |",
        ),
      ),
    ).toEqual([
      {
        object: "block",
        type: "heading_3",
        heading_3: {
          rich_text: [
            {
              type: "text",
              text: { content: "Hi", link: null },
              annotations: { bold: false },
            },
          ],
        },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [
            {
              type: "text",
              text: { content: "a", link: { url: "https://a.example" } },
              annotations: { bold: false },
            },
          ],
        },
      },
      {
        object: "block",
        type: "table",
        table: {
          table_width: 2,
          has_column_header: true,
          has_row_header: false,
          children: [
            {
              object: "block",
              type: "table_row",
              table_row: {
                cells: [
                  notionRichText([{ text: "H" }]),
                  notionRichText([{ text: "I" }]),
                ],
              },
            },
            {
              object: "block",
              type: "table_row",
              table_row: { cells: [notionRichText([{ text: "x" }]), []] },
            },
          ],
        },
      },
    ]);
  });

  it("splits text into items of at most 2000 characters", () => {
    const parts = notionRichText([{ text: "a".repeat(4500), bold: true }]);
    expect(
      parts.map((part) => (part["text"] as { content: string }).content.length),
    ).toEqual([2000, 2000, 500]);
    expect(
      parts.every((part) => (part["annotations"] as { bold: boolean }).bold),
    ).toBe(true);
  });
});
