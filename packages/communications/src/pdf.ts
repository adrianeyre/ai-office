import { parseMarkdown, type Block, type Inline } from "./markdown.ts";

// A Wrap-up report as a PDF (PRD FR-92: Google Drive keeps each report as
// a Markdown and a PDF file). It is written from the report's Markdown,
// redacted and at its Connection's detail level already, read as
// `parseMarkdown` reads it: headings, paragraphs, lists and tables, with
// bold and links, laid out on A4 pages in Helvetica, each link a link
// annotation. Nothing else is read: escaped text stays text. The file is
// ASCII throughout (every other character an octal escape in a string),
// and its streams are not compressed.

/** A4, in points. */
const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 56;
const contentWidth = pageWidth - 2 * margin;

const linkColour = "0.10 0.33 0.70";

// Helvetica's and Helvetica-Bold's widths (thousandths of the font size)
// for the printable ASCII characters, from their AFM files; anything else
// is taken as 556.
const regularWidths = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const boldWidths = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

/** WinAnsiEncoding's characters outside Latin-1, by their byte. */
export const winAnsiExtras: Readonly<Record<string, number>> = {
  "€": 0x80,
  "‚": 0x82,
  ƒ: 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  ˆ: 0x88,
  "‰": 0x89,
  Š: 0x8a,
  "‹": 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  š: 0x9a,
  "›": 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** A character's byte in WinAnsiEncoding; `?` for one it does not have. */
const winAnsiByte = (character: string): number => {
  const code = character.codePointAt(0) ?? 63;
  if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
    return code;
  }
  return winAnsiExtras[character] ?? 63;
};

const charWidth = (character: string, bold: boolean): number => {
  const code = winAnsiByte(character);
  const widths = bold ? boldWidths : regularWidths;
  return code >= 32 && code <= 126 ? (widths[code - 32] ?? 556) : 556;
};

/** How wide `text` is at `size` points. */
export const textWidth = (text: string, size: number, bold: boolean): number =>
  (Array.from(text).reduce(
    (sum, character) => sum + charWidth(character, bold),
    0,
  ) *
    size) /
  1000;

/** `text` as a PDF string: WinAnsi bytes, escaped, in parentheses. */
export const pdfString = (text: string): string =>
  `(${Array.from(text)
    .map((character) => {
      const byte = winAnsiByte(character);
      if (character === "\\" || character === "(" || character === ")") {
        return `\\${character}`;
      }
      return byte >= 32 && byte <= 126
        ? String.fromCharCode(byte)
        : `\\${byte.toString(8).padStart(3, "0")}`;
    })
    .join("")})`;

/** A run of text on a line, where it starts and how wide it is. */
interface Segment {
  readonly text: string;
  readonly bold: boolean;
  readonly link: string | undefined;
  readonly x: number;
  readonly width: number;
}

type Line = Segment[];

/**
 * `runs` broken into lines of at most `width` points at `size`, at spaces;
 * a word wider than a line is broken where it must be.
 */
function wrap(
  runs: readonly Inline[],
  size: number,
  width: number,
  allBold = false,
): Line[] {
  interface Word {
    text: string;
    bold: boolean;
    link: string | undefined;
    space: boolean;
  }
  const words: Word[] = [];
  let space = false;
  for (const run of runs) {
    const bold = allBold || run.bold === true;
    for (const part of run.text.split(/(\s+)/)) {
      if (part === "") {
        continue;
      }
      if (/^\s+$/.test(part)) {
        space = words.length > 0;
        continue;
      }
      words.push({ text: part, bold, link: run.link, space });
      space = false;
    }
  }
  const lines: Line[] = [];
  let line: Line = [];
  let x = 0;
  const place = (word: Word, gap: boolean) => {
    const text = gap ? ` ${word.text}` : word.text;
    const wide = textWidth(text, size, word.bold);
    const last = line.at(-1);
    if (last?.bold === word.bold && last.link === word.link) {
      line[line.length - 1] = {
        ...last,
        text: last.text + text,
        width: last.width + wide,
      };
    } else {
      line.push({
        text,
        bold: word.bold,
        link: word.link,
        x,
        width: wide,
      });
    }
    x += wide;
  };
  const breakLine = () => {
    lines.push(line);
    line = [];
    x = 0;
  };
  for (const word of words) {
    const gap = word.space && line.length > 0;
    const wide = textWidth(gap ? ` ${word.text}` : word.text, size, word.bold);
    if (x + wide <= width) {
      place(word, gap);
      continue;
    }
    if (line.length > 0) {
      breakLine();
    }
    if (textWidth(word.text, size, word.bold) <= width) {
      place(word, false);
      continue;
    }
    // Wider than a line: as many characters as fit, line after line.
    let rest = word.text;
    while (rest !== "") {
      let fits = 1;
      while (
        fits < rest.length &&
        textWidth(rest.slice(0, fits + 1), size, word.bold) <= width
      ) {
        fits += 1;
      }
      place({ ...word, text: rest.slice(0, fits) }, false);
      rest = rest.slice(fits);
      if (rest !== "") {
        breakLine();
      }
    }
  }
  if (line.length > 0 || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}

interface Annotation {
  readonly rect: readonly [number, number, number, number];
  readonly url: string;
}

interface Page {
  content: string[];
  annotations: Annotation[];
}

/** Lays blocks out on pages, top to bottom. */
class Layout {
  readonly pages: Page[] = [];
  private y = 0;

  constructor() {
    this.newPage();
  }

  private get page(): Page {
    return this.pages.at(-1) ?? this.newPage();
  }

  newPage(): Page {
    const page: Page = { content: [], annotations: [] };
    this.pages.push(page);
    this.y = pageHeight - margin;
    return page;
  }

  /** Room for `height` more points, on a new page if this one is full. */
  room(height: number): void {
    if (this.y - height < margin && this.y < pageHeight - margin) {
      this.newPage();
    }
  }

  space(points: number): void {
    this.y -= points;
  }

  /** Writes `line` with its baseline `size` below the cursor, at `left`. */
  line(line: Line, size: number, left: number, leading: number): void {
    this.room(leading);
    const baseline = this.y - size;
    for (const segment of line) {
      if (segment.text === "") {
        continue;
      }
      const x = left + segment.x;
      const font = segment.bold ? "F2" : "F1";
      this.page.content.push(
        `BT ${segment.link === undefined ? "0 g" : `${linkColour} rg`} /${font} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${pdfString(segment.text)} Tj ET`,
      );
      if (segment.link !== undefined) {
        this.page.annotations.push({
          rect: [
            x,
            baseline - size * 0.25,
            x + segment.width,
            baseline + size * 0.85,
          ],
          url: segment.link,
        });
      }
    }
    this.y -= leading;
  }

  /** Lines of text, wrapped to `width` from `left`. */
  text(
    runs: readonly Inline[],
    options: {
      readonly size: number;
      readonly bold?: boolean;
      readonly left?: number;
      readonly width?: number;
    },
  ): void {
    const left = options.left ?? margin;
    const width = options.width ?? contentWidth - (left - margin);
    const leading = options.size * 1.35;
    for (const line of wrap(runs, options.size, width, options.bold)) {
      this.line(line, options.size, left, leading);
    }
  }

  /** A table: columns as wide as their text needs, sharing the page's width. */
  table(header: readonly Inline[][], rows: readonly Inline[][][]): void {
    const size = 8.5;
    const leading = size * 1.3;
    const pad = 4;
    const columns = Math.max(header.length, ...rows.map((row) => row.length));
    const natural = Array.from({ length: columns }, (_, column) =>
      Math.max(
        24,
        ...[header, ...rows].map(
          (row, index) =>
            (row[column] ?? []).reduce(
              (sum, run) =>
                sum +
                textWidth(run.text, size, index === 0 || run.bold === true),
              0,
            ) +
            2 * pad +
            1,
        ),
      ),
    );
    const total = natural.reduce((sum, width) => sum + width, 0);
    let widths = natural;
    if (total > contentWidth) {
      // Narrow columns keep their width; wide ones share what is left.
      const fair = contentWidth / columns;
      const kept = natural.reduce(
        (sum, width) => (width <= fair ? sum + width : sum),
        0,
      );
      const wide = natural.reduce(
        (sum, width) => (width > fair ? sum + width : sum),
        0,
      );
      widths = natural.map((width) =>
        width <= fair ? width : ((contentWidth - kept) * width) / wide,
      );
    }
    const drawRow = (cells: readonly Inline[][], bold: boolean) => {
      const wrapped = widths.map((width, column) =>
        wrap(cells[column] ?? [], size, width - 2 * pad, bold),
      );
      const height =
        Math.max(...wrapped.map((lines) => lines.length)) * leading + 2 * pad;
      this.room(height);
      const top = this.y;
      let left = margin;
      const content = this.page.content;
      if (bold) {
        content.push(
          `0.93 g ${num(margin)} ${num(top - height)} ${num(widths.reduce((a, b) => a + b, 0))} ${num(height)} re f`,
        );
      }
      wrapped.forEach((lines, column) => {
        const width = widths[column] ?? 0;
        content.push(
          `0.6 G 0.5 w ${num(left)} ${num(top - height)} ${num(width)} ${num(height)} re S`,
        );
        this.y = top - pad;
        for (const line of lines) {
          this.line(line, size, left + pad, leading);
        }
        left += width;
      });
      this.y = top - height;
    };
    drawRow(header, true);
    for (const row of rows) {
      drawRow(row, false);
    }
  }
}

/** A number as a PDF writes it: at most two decimals. */
const num = (value: number): string => String(Math.round(value * 100) / 100);

function layOut(blocks: readonly Block[]): Page[] {
  const layout = new Layout();
  blocks.forEach((block, index) => {
    switch (block.type) {
      case "heading": {
        const size = { 1: 18, 2: 14, 3: 12 }[block.level];
        if (index > 0) {
          layout.space(size * 0.6);
        }
        layout.room(size * 3);
        layout.text(block.content, { size, bold: true });
        layout.space(4);
        return;
      }
      case "paragraph":
        layout.text(block.content, { size: 10.5 });
        layout.space(6);
        return;
      case "list":
        block.items.forEach((item, at) => {
          const marker = block.ordered ? `${String(at + 1)}.` : "•";
          const indent = block.ordered ? 22 : 14;
          layout.room(10.5 * 1.35);
          // The marker on the item's first line, hanging to its left.
          layout.text([{ text: marker }], { size: 10.5, left: margin + 2 });
          layout.space(-10.5 * 1.35);
          layout.text(item, { size: 10.5, left: margin + indent });
        });
        layout.space(6);
        return;
      case "table":
        layout.table(block.header, block.rows);
        layout.space(10);
        return;
    }
  });
  return layout.pages;
}

/** The text of a heading, for the document's title. */
const plain = (runs: readonly Inline[]): string =>
  runs.map((run) => run.text).join("");

/**
 * `markdown` (a Wrap-up report) as a PDF: A4 pages, its first heading the
 * document's title.
 */
export function reportPdf(markdown: string): Uint8Array {
  const blocks = parseMarkdown(markdown);
  const pages = layOut(blocks);
  const first = blocks.find((block) => block.type === "heading");
  const title = first === undefined ? "Wrap-up report" : plain(first.content);

  // Objects 1 to 5 are fixed; then each page, its content and its links.
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // The page tree, once its pages are known.
  add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  add(`<< /Title ${pdfString(title)} /Producer (AI Office) >>`);
  const pageIds: number[] = [];
  for (const page of pages) {
    const stream = page.content.join("\n");
    const content = add(
      `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    );
    const annotations = page.annotations.map(({ rect, url }) =>
      add(
        `<< /Type /Annot /Subtype /Link /Rect [${rect.map(num).join(" ")}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(url)} >> >>`,
      ),
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${String(content)} 0 R${
          annotations.length === 0
            ? ""
            : ` /Annots [${annotations.map((id) => `${String(id)} 0 R`).join(" ")}]`
        } >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pageIds.length)} >>`;

  let file = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(file.length);
    file += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}`;
  file += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(file, "latin1");
}
