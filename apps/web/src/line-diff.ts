// A line-by-line difference between two texts, for the Guidelines card's
// view of a version awaiting approval against the one approved. Texts are
// short (a Guideline is at most 12,000 characters), so the longest common
// subsequence of their lines is found directly.

/** One line of a difference: kept, taken out or put in. */
export interface DiffLine {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
}

/** A text's lines, without the empty one after a final newline. */
const linesOf = (text: string): string[] => {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

/** The lines of `after` against those of `before`, in order. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  // common[i][j]: the longest common subsequence of a[i..] and b[j..].
  const common = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = common[i] ?? [];
    const next = common[i + 1] ?? [];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      diff.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((common[i + 1]?.[j] ?? 0) >= (common[i]?.[j + 1] ?? 0)) {
      diff.push({ kind: "removed", text: a[i] ?? "" });
      i += 1;
    } else {
      diff.push({ kind: "added", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    diff.push({ kind: "removed", text: a[i] ?? "" });
  }
  for (; j < b.length; j += 1) {
    diff.push({ kind: "added", text: b[j] ?? "" });
  }
  return diff;
}
