import type { GitHubApp, RepositoryClient } from "@ai-office/github";
import { describe, expect, it } from "vitest";

import { createChatRepositoryFiles } from "./repository-files.ts";

// P2 (issue #205), H18. A Manager chat message that mentions `@path` gives
// the Manager that file's text at the Floor's default branch
// (`repository-files.ts`). These probes confirm the path checks hold: a
// traversal (`..`), an absolute path or a `.` segment reads nothing, and
// mentions read through the GitHub App against the Floor's own repository —
// not the local clone — so a symlink in the clone cannot redirect a read,
// and one Floor's mention cannot read another's.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/P2.md.

const floor = {
  id: "web-shop",
  repository: "adrianeyre/web-shop",
  defaultBranch: "main",
};

/** A GitHub App that records which repository and path each read asks for. */
function recordingGitHub(): {
  readonly github: Pick<GitHubApp, "repository">;
  readonly reads: { repository: string; path: string }[];
} {
  const reads: { repository: string; path: string }[] = [];
  const github = {
    repository: (fullName: string) =>
      ({
        getFileContent: (path: string) => {
          reads.push({ repository: fullName, path });
          return Promise.resolve(`contents of ${path}`);
        },
      }) as unknown as RepositoryClient,
  };
  return { github, reads };
}

describe("P2: `@` mention path checks hold", () => {
  it("reads nothing for a traversal, an absolute path or a `.` segment", async () => {
    const { github, reads } = recordingGitHub();
    const files = createChatRepositoryFiles({
      floors: { get: () => Promise.resolve(undefined) },
      github,
    });
    const paths = [
      "../../../etc/passwd",
      "/etc/passwd",
      "..",
      "src/../../../secret",
      "a/./b",
      "",
    ];
    const read = await files.read(floor, paths);
    expect(read.every((file) => file.content === undefined)).toBe(true);
    // None of them reached GitHub.
    expect(reads).toEqual([]);
  });

  it("reads an ordinary path, through the Floor's own repository", async () => {
    const { github, reads } = recordingGitHub();
    const files = createChatRepositoryFiles({
      floors: { get: () => Promise.resolve(undefined) },
      github,
    });
    const read = await files.read(floor, ["src/checkout/total.ts"]);
    expect(read[0]?.content).toBe("contents of src/checkout/total.ts");
    expect(reads).toEqual([
      { repository: "adrianeyre/web-shop", path: "src/checkout/total.ts" },
    ]);
  });
});
