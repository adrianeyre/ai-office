import { maxMemoryEntries, maxMemoryEntryLength } from "@ai-office/shared";

// The memory file, `.agents/MEMORY.md` (PRD FR-53): a heading, a line
// saying what it is, then one entry per line as a Markdown list. AI Office
// writes it in this form; a file the Owner wrote by hand is read line by
// line, every line that is not a heading (or AI Office's own preamble)
// being an entry. AI Office's own curation rules, for when the Manager's
// Model cannot curate, live here too.

export const memoryHeading = "# Repository memory";

export const memoryPreamble =
  "What AI Office's Agents have learned about this repository, one entry per line. Every Agent reads it at the start of a task. The Floor's Manager curates it through pull requests, merging duplicates and dropping stale entries: change it the same way.";

/** An entry, as compared: case, spacing, list markers and an end stop aside. */
const normalised = (entry: string): string =>
  entry
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .toLowerCase()
    .replaceAll(/[`*_]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/[.!;:,]+$/, "");

/** Whether two entries say the same thing in the same words. */
export const sameEntry = (a: string, b: string): boolean =>
  normalised(a) === normalised(b);

const oneEntry = (line: string): string => {
  const entry = line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return entry.length <= maxMemoryEntryLength
    ? entry
    : `${entry.slice(0, maxMemoryEntryLength - 1)}…`;
};

/** The entries of a memory file, in order, the same entry once. */
export function memoryEntries(text: string | undefined): string[] {
  const entries: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("#") ||
      trimmed === memoryPreamble
    ) {
      continue;
    }
    const entry = oneEntry(trimmed);
    if (entry !== "" && !entries.some((known) => sameEntry(known, entry))) {
      entries.push(entry);
    }
  }
  return entries;
}

/** The memory file holding `entries`. */
export const memoryFile = (entries: readonly string[]): string =>
  [
    memoryHeading,
    "",
    memoryPreamble,
    "",
    ...entries.map((entry) => `- ${entry}`),
    "",
  ].join("\n");

/**
 * AI Office's own curation (PRD FR-17): the memory's entries, then each
 * proposal not already there, oldest first; duplicates merged, and the
 * oldest entries dropped beyond `maxMemoryEntries`.
 */
export function curateByRules(
  current: readonly string[],
  proposals: readonly string[],
): string[] {
  const entries: string[] = [];
  for (const entry of [...current, ...proposals].map(oneEntry)) {
    if (entry !== "" && !entries.some((known) => sameEntry(known, entry))) {
      entries.push(entry);
    }
  }
  return entries.slice(Math.max(0, entries.length - maxMemoryEntries));
}
