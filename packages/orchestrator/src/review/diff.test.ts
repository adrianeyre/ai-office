import { describe, expect, it } from "vitest";

import { commentableLines, unifiedDiff } from "./diff.ts";

// Which lines of a pull request's diff a review may comment on, as GitHub
// allows (the new version's context and added lines), and the diff a
// reviewer reads.

describe("commentableLines", () => {
  it("takes the added and context lines of each hunk, not removed ones", () => {
    const patch = [
      "@@ -1,4 +1,5 @@",
      " import { a } from './a';",
      "-const b = 1;",
      "+const b = 2;",
      "+const c = 3;",
      " ",
      " export { a };",
      "@@ -20,2 +21,3 @@ function tail() {",
      " return a;",
      "+// done",
      " }",
      "\\ No newline at end of file",
    ].join("\n");
    expect([...commentableLines(patch)].sort((x, y) => x - y)).toEqual([
      1, 2, 3, 4, 5, 21, 22, 23,
    ]);
  });

  it("takes a hunk of one line, and nothing from a removed file or no patch", () => {
    expect([...commentableLines("@@ -0,0 +1 @@\n+only")]).toEqual([1]);
    expect([...commentableLines("@@ -1,2 +0,0 @@\n-a\n-b")]).toEqual([]);
    expect([...commentableLines(null)]).toEqual([]);
  });
});

describe("unifiedDiff", () => {
  it("puts Git's file headers on each patch", () => {
    expect(
      unifiedDiff([
        { path: "new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+a" },
        { path: "gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-b" },
        {
          path: "b.ts",
          previousPath: "a.ts",
          status: "renamed",
          patch: null,
        },
      ]),
    ).toBe(
      [
        "diff --git a/new.ts b/new.ts",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "+a",
        "diff --git a/gone.ts b/gone.ts",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-b",
        "diff --git a/a.ts b/b.ts",
        "--- a/a.ts",
        "+++ b/b.ts",
        "(No diff shown: a binary file, or too large.)",
      ].join("\n"),
    );
  });
});
