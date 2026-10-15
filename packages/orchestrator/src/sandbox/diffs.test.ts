import { describe, expect, it } from "vitest";

import { fileDiffs } from "./diffs.ts";
import { bash, editFile, say } from "./fake-sandbox.ts";

// The file diffs read from Claude Code's stream (PRD FR-58).

const line = (object: object) => JSON.stringify(object);

describe("fileDiffs", () => {
  it("reads an Edit as its removed and added lines", () => {
    expect(
      fileDiffs(
        line(
          editFile("Edit", {
            file_path: "/work/src/basket.ts",
            old_string: "export const total = 0;\n",
            new_string: "export const total = sum(items);\nexport const n = 1;",
          }),
        ),
      ),
    ).toEqual([
      {
        path: "/work/src/basket.ts",
        diff: "-export const total = 0;\n+export const total = sum(items);\n+export const n = 1;",
        added: 2,
        removed: 1,
      },
    ]);
  });

  it("reads a Write as every line added", () => {
    expect(
      fileDiffs(
        line(editFile("Write", { file_path: "a.txt", content: "one\ntwo\n" })),
      ),
    ).toEqual([{ path: "a.txt", diff: "+one\n+two", added: 2, removed: 0 }]);
  });

  it("reads a MultiEdit as its changes, apart", () => {
    expect(
      fileDiffs(
        line(
          editFile("MultiEdit", {
            file_path: "b.ts",
            edits: [
              { old_string: "a", new_string: "b" },
              { old_string: "c", new_string: "" },
            ],
          }),
        ),
      ),
    ).toEqual([{ path: "b.ts", diff: "-a\n+b\n@@\n-c", added: 1, removed: 2 }]);
  });

  it("ignores everything else", () => {
    for (const text of [
      line(say("Editing the basket.")),
      line(bash("pnpm test")),
      line(editFile("Edit", { file_path: "c.ts" })),
      line({ type: "result", usage: {} }),
      "not json",
      "{broken",
    ]) {
      expect(fileDiffs(text)).toEqual([]);
    }
  });
});
