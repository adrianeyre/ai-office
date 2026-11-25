import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit } from "./command.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-office-git-command-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runGit", () => {
  it("says what Git said when it fails, not only the command it ran", async () => {
    const missing = join(root, "missing");

    await expect(
      runGit("clone the repository", [
        "clone",
        "--quiet",
        `file://${missing}`,
        join(root, "clone"),
      ]),
    ).rejects.toThrow(
      /^Git could not clone the repository: fatal: .*does not appear to be a git repository/,
    );
  });

  it("does not repeat the command line in its message", async () => {
    const error = await runGit("read the log", ["log"], { cwd: root }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toMatch(/^Git could not read the log: fatal: /);
    expect(error?.message).not.toContain("Command failed");
  });
});
