import {
  createRedactor,
  guidelineNamePattern,
  guidelinesFolder,
  maxGuidelineLength,
  parseGuideline,
  secretLikeLines,
  type Guideline,
  type Redactor,
} from "@ai-office/shared";

// How an Agent proposes a Guideline (Guidelines, Specs and Hooks PRD,
// FR-110): the coder (every work Role), the docs Agent and QA may end their
// Handoff, or QA's `<qa-report>`, with one `<guideline name="…">` block
// holding the whole file of a new or changed Guideline, front matter and
// all. This reads it: plain code, never a model. A block with no name, a
// name that is not a Guideline's, an empty file, one that breaks FR-102's
// rules, or one with a line that looks like a credential is dropped; a
// name the Floor has no Guideline of proposes a new one. More than one
// block: only the last counts. The block is no part of the Handoff or
// report itself (`withoutGuidelineProposals`), so what an Agent proposes
// never reaches the next Agent: only the Owner's merge of it does
// (ADR 0014).

/** The tags whose last block may end with a proposed Guideline. */
export type ProposalTag = "handoff" | "qa-report";

/**
 * Why a `<guideline>` block was dropped:
 * - `no_name`: it has no `name="…"`;
 * - `invalid_name`: its name is not lowercase letters, digits and dashes;
 * - `empty`: it holds nothing;
 * - `holds_secret`: a line looks like it holds a credential;
 * - `invalid`: the file breaks another of a Guideline's rules.
 */
export const droppedProposalReasons = [
  "no_name",
  "invalid_name",
  "empty",
  "holds_secret",
  "invalid",
] as const;
export type DroppedProposalReason = (typeof droppedProposalReasons)[number];

/** What an Agent's text proposed, if anything. */
export type ProposedGuideline =
  | { readonly kind: "none" }
  | { readonly kind: "dropped"; readonly reason: DroppedProposalReason }
  | {
      readonly kind: "proposed";
      /** The Guideline it adds or changes. */
      readonly name: string;
      /** The whole file, as it would be committed. */
      readonly content: string;
      /** The file, read as a Guideline. */
      readonly guideline: Guideline;
    };

/** A `<guideline …>` block, closed or running to the end of the text. */
const blockPattern = /<guideline\b([^>]*)>([\s\S]*?)(?:<\/guideline\s*>|$)/gi;

/** The block's `name="…"` (or `'…'`), as written; undefined without one. */
const nameIn = (attributes: string): string | undefined => {
  const found = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  return found === null ? undefined : (found[1] ?? found[2] ?? "");
};

/**
 * The block's text as a file: its common indentation and the blank lines
 * around it taken away, each line's trailing spaces too, ending in one
 * newline. Empty when it holds nothing.
 */
const fileOf = (text: string): string => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return "";
  }
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim() !== "")
      .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0),
  );
  return `${lines.map((line) => line.slice(indent).trimEnd()).join("\n")}\n`;
};

/**
 * The Guideline proposed in the last `<tag>` block of an Agent's text: its
 * last `<guideline name="…">` block, read and checked. `none` when there
 * is no such block.
 */
export function proposedGuideline(
  text: string | null,
  tag: ProposalTag,
  options: { readonly redactor?: Redactor } = {},
): ProposedGuideline {
  const blocks = [
    ...(text ?? "").matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi")),
  ];
  const last = [...(blocks.at(-1)?.[1] ?? "").matchAll(blockPattern)].at(-1);
  if (last === undefined) {
    return { kind: "none" };
  }
  const written = nameIn(last[1] ?? "")?.trim();
  if (written === undefined || written === "") {
    return { kind: "dropped", reason: "no_name" };
  }
  // The name, with or without its file's `.md`.
  const name = written.replace(/\.md$/i, "");
  if (!guidelineNamePattern.test(name) || name.length > 255) {
    return { kind: "dropped", reason: "invalid_name" };
  }
  const content = fileOf(last[2] ?? "");
  if (content === "") {
    return { kind: "dropped", reason: "empty" };
  }
  const redactor = options.redactor ?? createRedactor();
  // Never a credential: such a proposal is dropped whole, never kept
  // redacted, so nothing of it is kept, shown or committed.
  if (
    secretLikeLines(content, redactor).length > 0 ||
    redactor.redactText(content) !== content
  ) {
    return { kind: "dropped", reason: "holds_secret" };
  }
  const parsed = parseGuideline(`${name}.md`, content, { redactor });
  if (!parsed.ok) {
    return {
      kind: "dropped",
      reason:
        parsed.refused.refusal === "holds_secret" ? "holds_secret" : "invalid",
    };
  }
  return { kind: "proposed", name, content, guideline: parsed.guideline };
}

/** `text` without its `<guideline …>` blocks. */
export const withoutGuidelineProposals = (text: string): string =>
  text.replaceAll(blockPattern, "");

/**
 * How an Agent proposes a Guideline, inside the Handoff (or report) it
 * ends with. Callers put a blank line before it.
 */
export const proposingGuidelines = (where: "Handoff" | "report"): string[] => [
  `If this task showed you that one of the Owner's Guidelines is missing or wrong, you may propose one new or changed Guideline inside your ${where}, just before its closing marker, as the whole file under \`${guidelinesFolder}/\`, front matter and all, at most ${maxGuidelineLength.toLocaleString("en-GB")} characters, named by its file name without \`.md\`:`,
  "",
  '    <guideline name="migrations">',
  "    ---",
  "    inclusion: fileMatch",
  '    fileMatchPattern: "packages/db/**"',
  "    description: How migrations are written.",
  "    ---",
  "",
  "    The rules, in Markdown.",
  "    </guideline>",
  "",
  "Leave it out when nothing is missing or wrong, never put a credential, a token or a secret in it, and never change the Guidelines yourself. Only the Owner decides: no Agent follows what you propose unless the Owner merges it.",
];
