// The Markdown of a Wrap-up report (PRD FR-92), and its translations for
// the publishing destinations: Confluence's storage format (XHTML),
// Notion's blocks, and the HTML of a Google Calendar event's description. Only the subset the report is written in is read:
// headings (`#` to `###`), paragraphs, bulleted and numbered lists, tables
// (a header row, then `| --- |`, then rows), and within them bold
// (`**…**`), links (`[text](https://…)`) and backslash escapes. Text from
// elsewhere (issue titles, a Model's summary) is escaped before it is
// written in (`escapeMarkdown`), so it is only ever text: it cannot add a
// link, a heading or a row.

/** A run of text: bold or not, and a link or not. */
export interface Inline {
  readonly text: string;
  readonly bold?: boolean;
  /** An http or https address. */
  readonly link?: string;
}

export type Block =
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3;
      readonly content: Inline[];
    }
  | { readonly type: "paragraph"; readonly content: Inline[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: Inline[][];
    }
  | {
      readonly type: "table";
      readonly header: Inline[][];
      readonly rows: Inline[][][];
    };

/** `text` with every character Markdown would read escaped: only ever text. */
export const escapeMarkdown = (text: string): string =>
  text.replaceAll(/[\\`*_[\]()#|<>!~.+-]/g, (character) => `\\${character}`);

/** One line's inline Markdown, as runs of text. */
export function parseInline(source: string): Inline[] {
  const runs: Inline[] = [];
  let text = "";
  let bold = false;
  const flush = () => {
    if (text !== "") {
      runs.push(bold ? { text, bold } : { text });
      text = "";
    }
  };
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at] ?? "";
    if (character === "\\" && at + 1 < source.length) {
      text += source[at + 1] ?? "";
      at += 1;
      continue;
    }
    if (character === "*" && source[at + 1] === "*") {
      flush();
      bold = !bold;
      at += 1;
      continue;
    }
    if (character === "[") {
      const link = /^\[((?:\\.|[^\\\]])*)\]\((https?:\/\/[^\s)]+)\)/.exec(
        source.slice(at),
      );
      if (link !== null) {
        flush();
        const label = (link[1] ?? "").replaceAll(/\\(.)/g, "$1");
        runs.push({
          text: label,
          link: link[2] ?? "",
          ...(bold ? { bold } : {}),
        });
        at += link[0].length - 1;
        continue;
      }
    }
    text += character;
  }
  flush();
  return runs;
}

/** A table row's cells, split on the pipes that are not escaped. */
const cellsOf = (line: string): string[] => {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < inner.length; at += 1) {
    const character = inner[at] ?? "";
    if (character === "\\" && at + 1 < inner.length) {
      cell += character + (inner[at + 1] ?? "");
      at += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
};

const isRule = (line: string) =>
  /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());

/** The report's Markdown, as blocks. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({
        type: "heading",
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3,
        content: parseInline(heading[2] ?? ""),
      });
      at += 1;
      continue;
    }
    if (line.trim().startsWith("|") && isRule(lines[at + 1] ?? "")) {
      const header = cellsOf(line).map(parseInline);
      const rows: Inline[][][] = [];
      at += 2;
      while (at < lines.length && (lines[at] ?? "").trim().startsWith("|")) {
        rows.push(cellsOf(lines[at] ?? "").map(parseInline));
        at += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = /^[-*]\s+/;
    const numbered = /^\d+\.\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: Inline[][] = [];
      while (at < lines.length && pattern.test(lines[at] ?? "")) {
        items.push(parseInline((lines[at] ?? "").replace(pattern, "")));
        at += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    // A paragraph runs to a blank line or the next block's start.
    const paragraph: string[] = [line.trim()];
    at += 1;
    while (
      at < lines.length &&
      (lines[at] ?? "").trim() !== "" &&
      !/^(#{1,3}\s|[-*]\s|\d+\.\s|\|)/.test(lines[at] ?? "")
    ) {
      paragraph.push((lines[at] ?? "").trim());
      at += 1;
    }
    blocks.push({
      type: "paragraph",
      content: parseInline(paragraph.join(" ")),
    });
  }
  return blocks;
}

/** `text` safe in XHTML, as text or in an attribute. */
export const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const inlineXml = (runs: readonly Inline[], boldTag = "strong"): string =>
  runs
    .map((run) => {
      const text = escapeXml(run.text);
      const linked =
        run.link === undefined
          ? text
          : `<a href="${escapeXml(run.link)}">${text}</a>`;
      return run.bold === true ? `<${boldTag}>${linked}</${boldTag}>` : linked;
    })
    .join("");

/** Blocks in Confluence's storage format (XHTML). */
export function confluenceStorage(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
          return `<h${String(block.level)}>${inlineXml(block.content)}</h${String(block.level)}>`;
        case "paragraph":
          return `<p>${inlineXml(block.content)}</p>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          return `<${tag}>${block.items.map((item) => `<li>${inlineXml(item)}</li>`).join("")}</${tag}>`;
        }
        case "table":
          return `<table><tbody><tr>${block.header
            .map((cell) => `<th>${inlineXml(cell)}</th>`)
            .join("")}</tr>${block.rows
            .map(
              (row) =>
                `<tr>${row.map((cell) => `<td>${inlineXml(cell)}</td>`).join("")}</tr>`,
            )
            .join("")}</tbody></table>`;
      }
    })
    .join("");
}

/**
 * Blocks as a Google Calendar event's description: the little HTML
 * Calendar keeps (`<b>`, `<a>`, `<br>`, `<ul>`, `<ol>`, `<li>`), every text
 * escaped. Paragraphs and headings are lines, a blank line between each;
 * a table's rows are lines of cells.
 */
export function calendarHtml(blocks: readonly Block[]): string {
  const line = (runs: readonly Inline[]) => inlineXml(runs, "b");
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
          return `<b>${line(block.content)}</b>`;
        case "paragraph":
          return line(block.content);
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          return `<${tag}>${block.items.map((item) => `<li>${line(item)}</li>`).join("")}</${tag}>`;
        }
        case "table":
          return [block.header, ...block.rows]
            .map((row) => row.map(line).join(" | "))
            .join("<br>");
      }
    })
    .join("<br><br>");
}

/** The most characters one of Notion's rich text items holds. */
export const notionTextLimit = 2000;

/** Runs of text as Notion's rich text, each at most 2000 characters. */
export function notionRichText(
  runs: readonly Inline[],
): Record<string, unknown>[] {
  return runs.flatMap((run) => {
    const parts: string[] = [];
    for (let at = 0; at < run.text.length; at += notionTextLimit) {
      parts.push(run.text.slice(at, at + notionTextLimit));
    }
    return parts.map((content) => ({
      type: "text",
      text: {
        content,
        link: run.link === undefined ? null : { url: run.link },
      },
      annotations: { bold: run.bold === true },
    }));
  });
}

/** Blocks as Notion's blocks, for a page's children. */
export function notionBlocks(
  blocks: readonly Block[],
): Record<string, unknown>[] {
  return blocks.flatMap((block): Record<string, unknown>[] => {
    switch (block.type) {
      case "heading": {
        const type = `heading_${String(block.level)}`;
        return [
          {
            object: "block",
            type,
            [type]: { rich_text: notionRichText(block.content) },
          },
        ];
      }
      case "paragraph":
        return [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: notionRichText(block.content) },
          },
        ];
      case "list": {
        const type = block.ordered
          ? "numbered_list_item"
          : "bulleted_list_item";
        return block.items.map((item) => ({
          object: "block",
          type,
          [type]: { rich_text: notionRichText(item) },
        }));
      }
      case "table": {
        const width = block.header.length;
        const row = (cells: readonly Inline[][]) => ({
          object: "block",
          type: "table_row",
          table_row: {
            cells: Array.from({ length: width }, (_, index) =>
              notionRichText(cells[index] ?? []),
            ),
          },
        });
        return [
          {
            object: "block",
            type: "table",
            table: {
              table_width: width,
              has_column_header: true,
              has_row_header: false,
              children: [row(block.header), ...block.rows.map(row)],
            },
          },
        ];
      }
    }
  });
}
