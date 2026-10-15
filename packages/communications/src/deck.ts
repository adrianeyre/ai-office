import { parseMarkdown, type Block, type Inline } from "./markdown.ts";
import { reportSections } from "./report.ts";

// A Wrap-up report as a short deck (PRD FR-92: Google Slides keeps a deck
// per Batch from the same Wrap-up report): a title slide (the report's
// title, when it finished with its counts, and a link to the Wrap-up in AI
// Office), its outcomes (the summary), its issues and pull requests (each
// issue's outcome and pull request), and its tokens and cost (the total,
// then each issue's). It is read from the report's Markdown, redacted and
// at its Connection's detail level already, so it says no more than the
// report does; what the report escaped stays text.

/** One paragraph of a slide's text: runs, bold or linked. */
export type SlideParagraph = readonly Inline[];

export interface Slide {
  readonly title: string;
  /** The title slide's subtitle, or a slide's body: a paragraph each. */
  readonly body: readonly SlideParagraph[];
}

export interface Deck {
  /** The title slide. */
  readonly cover: Slide;
  /** The slides after it, each a title and a body. */
  readonly slides: readonly Slide[];
}

/** How many lines of issues one slide holds before the next takes over. */
export const linesPerSlide = 8;

const plain = (runs: readonly Inline[]): string =>
  runs.map((run) => run.text).join("");

/** The blocks under the `##` heading named `name`, to the next heading. */
const section = (blocks: readonly Block[], name: string): Block[] => {
  const start = blocks.findIndex(
    (block) =>
      block.type === "heading" &&
      block.level === 2 &&
      plain(block.content) === name,
  );
  if (start === -1) {
    return [];
  }
  const rest = blocks.slice(start + 1);
  const end = rest.findIndex((block) => block.type === "heading");
  return end === -1 ? rest : rest.slice(0, end);
};

/** Runs joined with `between`, a run of its own. */
const joined = (
  parts: readonly (readonly Inline[])[],
  between: string,
): Inline[] =>
  parts
    .filter((part) => plain(part).trim() !== "")
    .flatMap((part, index) =>
      index === 0 ? [...part] : [{ text: between }, ...part],
    );

/** `lines` on as many slides titled `title` as they need. */
const paged = (title: string, lines: readonly SlideParagraph[]): Slide[] => {
  const count = Math.max(1, Math.ceil(lines.length / linesPerSlide));
  return Array.from({ length: count }, (_, index) => ({
    title:
      count === 1
        ? title
        : `${title} (${String(index + 1)} of ${String(count)})`,
    body: lines.slice(index * linesPerSlide, (index + 1) * linesPerSlide),
  }));
};

/** A Wrap-up report's Markdown as a deck. */
export function reportDeck(markdown: string): Deck {
  const blocks = parseMarkdown(markdown);
  const heading = blocks.find(
    (block) => block.type === "heading" && block.level === 1,
  );
  const title =
    heading?.type === "heading" ? plain(heading.content) : "Wrap-up report";
  const firstSection = blocks.findIndex(
    (block) => block.type === "heading" && block.level === 2,
  );
  // What the report says before its first section: when it finished, and
  // its counts, tokens and cost.
  const intro = blocks
    .slice(0, firstSection === -1 ? blocks.length : firstSection)
    .flatMap((block) => (block.type === "paragraph" ? [block.content] : []));
  // The report's last paragraph is its link to the Wrap-up in AI Office.
  const last = blocks.at(-1);
  const wrapUpLink =
    last?.type === "paragraph" && last.content.some((run) => run.link)
      ? [last.content]
      : [];

  const summary = section(blocks, reportSections.summary).flatMap((block) =>
    block.type === "paragraph" ? [block.content] : [],
  );
  const table = section(blocks, reportSections.results).find(
    (block) => block.type === "table",
  );
  const rows = table?.type === "table" ? table.rows : [];
  // Its last row is the Total.
  const issues = rows.filter((row) => plain(row[0] ?? []).trim() !== "Total");
  const total = rows.find((row) => plain(row[0] ?? []).trim() === "Total");

  return {
    cover: { title, body: [...intro, ...wrapUpLink] },
    slides: [
      { title: "Outcomes", body: summary },
      ...paged(
        "Issues and pull requests",
        issues.map((row) =>
          joined([row[0] ?? [], row[1] ?? [], row[2] ?? []], " · "),
        ),
      ),
      ...paged("Tokens and cost", [
        ...(total === undefined
          ? []
          : [
              [
                { text: "Total: ", bold: true },
                {
                  text: `${plain(total[4] ?? [])} tokens, about ${plain(total[5] ?? [])} (estimated)`,
                  bold: true,
                },
              ],
            ]),
        ...issues.map((row) =>
          joined(
            [
              row[0] ?? [],
              [
                {
                  text: `${plain(row[4] ?? [])} tokens, ${plain(row[5] ?? [])}; rounds (review, QA) ${plain(row[3] ?? [])}`,
                },
              ],
            ],
            ": ",
          ),
        ),
      ]),
    ],
  };
}
