import { textWidth, winAnsiExtras } from "./pdf.ts";

// What a PDF from `reportPdf` says, for tests: its title, each page's
// lines of text (top to bottom, each line's runs left to right, with ` | `
// where there is a gap between them, as between a table's cells) and its
// links. It checks the file's structure as it reads it: the header, the
// cross-reference table's offsets (each must be its object's), the page
// tree, and the end of the file. It reads only what `reportPdf` writes.

export interface PdfLink {
  readonly url: string;
  readonly rect: readonly number[];
}

export interface PdfPage {
  readonly lines: readonly string[];
  readonly links: readonly PdfLink[];
  /** Which fonts each line uses, by its text: `F1` regular, `F2` bold. */
  readonly bold: readonly string[];
}

export interface PdfDocument {
  readonly title: string;
  readonly pages: readonly PdfPage[];
}

const fromWinAnsi = new Map(
  Object.entries(winAnsiExtras).map(([character, byte]) => [byte, character]),
);

/** A PDF literal string's text: its escapes undone, WinAnsi decoded. */
const unescape = (literal: string): string =>
  literal
    .replaceAll(/\\([0-7]{3}|[\\()])/g, (_, escaped: string) =>
      /^[0-7]{3}$/.test(escaped)
        ? String.fromCharCode(Number.parseInt(escaped, 8))
        : escaped,
    )
    .replaceAll(
      /[\x80-\x9f]/g,
      (character) => fromWinAnsi.get(character.charCodeAt(0)) ?? character,
    );

const literal = String.raw`\(((?:\\[0-7]{3}|\\[\\()]|[^\\()])*)\)`;

export function readPdf(bytes: Uint8Array): PdfDocument {
  const file = Buffer.from(bytes).toString("latin1");
  if (!file.startsWith("%PDF-1.7\n") || !file.endsWith("%%EOF\n")) {
    throw new Error("Not a PDF: its header or its end is missing.");
  }
  if (/[^\t\n\r -~]/.test(file)) {
    throw new Error("The PDF is not ASCII.");
  }
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(file)?.[1]);
  if (file.slice(startxref, startxref + 5) !== "xref\n") {
    throw new Error("startxref does not point at the cross-reference table.");
  }
  const table = /^xref\n0 (\d+)\n0000000000 65535 f \n/.exec(
    file.slice(startxref),
  );
  const size = Number(table?.[1]);
  const entries = file
    .slice(startxref + (table?.[0].length ?? 0))
    .split("\n")
    .slice(0, size - 1);
  const objects = new Map<number, string>();
  entries.forEach((entry, index) => {
    const offset = Number(/^(\d{10}) 00000 n $/.exec(entry)?.[1]);
    const number = index + 1;
    const header = `${String(number)} 0 obj\n`;
    if (file.slice(offset, offset + header.length) !== header) {
      throw new Error(`Object ${String(number)} is not at its offset.`);
    }
    const end = file.indexOf("\nendobj\n", offset);
    objects.set(number, file.slice(offset + header.length, end));
  });
  const object = (number: number): string => {
    const found = objects.get(number);
    if (found === undefined) {
      throw new Error(`No object ${String(number)}.`);
    }
    return found;
  };
  const references = (text: string): number[] =>
    [...text.matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));

  const root = Number(/\/Root (\d+) 0 R/.exec(file.slice(startxref))?.[1]);
  const pagesId = Number(/\/Pages (\d+) 0 R/.exec(object(root))?.[1]);
  const tree = object(pagesId);
  const kids = references(/\/Kids \[([^\]]*)\]/.exec(tree)?.[1] ?? "");
  if (Number(/\/Count (\d+)/.exec(tree)?.[1]) !== kids.length) {
    throw new Error("The page tree's count is not its pages'.");
  }
  const info = Number(/\/Info (\d+) 0 R/.exec(file.slice(startxref))?.[1]);
  const title = unescape(
    new RegExp(`/Title ${literal}`).exec(object(info))?.[1] ?? "",
  );

  const pages = kids.map((kid): PdfPage => {
    const page = object(kid);
    const contents = Number(/\/Contents (\d+) 0 R/.exec(page)?.[1]);
    const stream = object(contents);
    const length = Number(/\/Length (\d+)/.exec(stream)?.[1]);
    const body = /stream\n([\s\S]*)\nendstream$/.exec(stream)?.[1] ?? "";
    if (body.length !== length) {
      throw new Error("A content stream's length is not its /Length.");
    }
    const runs = [
      ...body.matchAll(
        new RegExp(
          String.raw`/(F[12]) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td ${literal} Tj`,
          "g",
        ),
      ),
    ].map((match) => ({
      bold: match[1] === "F2",
      size: Number(match[2]),
      x: Number(match[3]),
      y: Number(match[4]),
      text: unescape(match[5] ?? ""),
    }));
    const ys = [...new Set(runs.map(({ y }) => y))].sort((a, b) => b - a);
    const lineAt = (y: number) => {
      let line = "";
      let end: number | undefined;
      for (const run of runs
        .filter((one) => one.y === y)
        .sort((a, b) => a.x - b.x)) {
        line +=
          end !== undefined && run.x - end > 1 ? ` | ${run.text}` : run.text;
        end = run.x + textWidth(run.text, run.size, run.bold);
      }
      return line;
    };
    const annotations = references(
      /\/Annots \[([^\]]*)\]/.exec(page)?.[1] ?? "",
    ).map(object);
    return {
      lines: ys.map(lineAt),
      bold: runs.filter((run) => run.bold).map((run) => run.text.trim()),
      links: annotations.map((annotation) => ({
        url: unescape(
          new RegExp(`/URI ${literal}`).exec(annotation)?.[1] ?? "",
        ),
        rect: (/\/Rect \[([^\]]*)\]/.exec(annotation)?.[1] ?? "")
          .split(" ")
          .map(Number),
      })),
    };
  });
  return { title, pages };
}
