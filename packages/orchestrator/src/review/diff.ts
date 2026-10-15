import type { PullRequestFile } from "@ai-office/github";

// A pull request's diff, as a reviewer reads it and as GitHub takes review
// comments on it: only on lines the diff shows (context or added lines of
// the new version).

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** The lines of the new version a review may comment on, from a patch. */
export function commentableLines(patch: string | null): Set<number> {
  const lines = new Set<number>();
  if (patch === null) {
    return lines;
  }
  let next = 0;
  let left = 0;
  for (const line of patch.split("\n")) {
    const header = hunkHeader.exec(line);
    if (header !== null) {
      next = Number(header[1]);
      left = header[2] === undefined ? 1 : Number(header[2]);
      continue;
    }
    if (left <= 0 || line.startsWith("-") || line.startsWith("\\")) {
      continue;
    }
    // An added line, or context (a space, or nothing for an empty line).
    lines.add(next);
    next++;
    left--;
  }
  return lines;
}

/** The pull request's changes as one unified diff, file by file. */
export function unifiedDiff(files: readonly PullRequestFile[]): string {
  return files
    .map((file) => {
      const from =
        file.status === "added"
          ? "/dev/null"
          : `a/${file.previousPath ?? file.path}`;
      const to = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
      return [
        `diff --git a/${file.previousPath ?? file.path} b/${file.path}`,
        `--- ${from}`,
        `+++ ${to}`,
        file.patch ?? "(No diff shown: a binary file, or too large.)",
      ].join("\n");
    })
    .join("\n");
}
