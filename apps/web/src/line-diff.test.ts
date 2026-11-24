import { describe, expect, it } from "vitest";

import { lineDiff } from "./line-diff.ts";

// The Guidelines card's difference between a version awaiting approval
// and the one approved, line by line.

describe("a line-by-line difference", () => {
  it("keeps the lines both share, and marks those taken out and put in", () => {
    expect(
      lineDiff(
        "Use pnpm.\nWrite tests.\nNo any.\n",
        "Use pnpm.\nNo any.\nShip.\n",
      ),
    ).toEqual([
      { kind: "same", text: "Use pnpm." },
      { kind: "removed", text: "Write tests." },
      { kind: "same", text: "No any." },
      { kind: "added", text: "Ship." },
    ]);
  });

  it("shows a changed line as taken out, then put in", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("puts in every line of a new file, and nothing of an empty one", () => {
    expect(lineDiff("", "One.\nTwo.\n")).toEqual([
      { kind: "added", text: "One." },
      { kind: "added", text: "Two." },
    ]);
    expect(lineDiff("", "")).toEqual([]);
    expect(lineDiff("Same.\r\n", "Same.\n")).toEqual([
      { kind: "same", text: "Same." },
    ]);
  });
});
