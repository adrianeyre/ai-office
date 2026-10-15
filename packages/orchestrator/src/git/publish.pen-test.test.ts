import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit } from "./command.ts";
import { publishBranch, type PublishOptions } from "./publish.ts";

// Probe S1 (H1): publish.ts fetches the Agent's branch into a *fresh* bare
// repository and turns hooks off there (`core.hooksPath=/dev/null`), so the
// Agent's own clone config and hooks do not run in the push repository.
//
// The one place the Agent's clone is still touched with its own config is
// `git fetch <workspace>`: the source side of a fetch. git's
// `uploadpack.packObjectsHook` runs a program when a repository is fetched
// *from* — the classic way to escape a hooks-off destination. This test
// drives the *real* `publishBranch` against an Agent clone that has planted
// both that hook and a post-commit hook, and checks neither runs.
//
// Verdict: holds today, but only because a fetch from a *local path* uses
// git's local transport and does not spawn `upload-pack`, so the hook is
// never consulted. It is not disabled; it is unreached. A future change to
// a `file://` URL or a real remote would reach it. See
// docs/pen-testing/assessments/S1.md.
//
// Since S1-1's fix that future is covered too: Git honours
// `uploadpack.packObjectsHook` only from system, global or command-line
// config, and `runGit` reads neither of the first two, so a fetch through
// `upload-pack` runs no hook the Agent's clone names either.

const git = promisify(execFile);
const identity = { name: "adrianeyre", email: "owner@example.com" };
const agent = {
  name: "Ada",
  role: "coder",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
} as const;
const branch = "ai-office/4-add-a-basket";

let root: string;
let remote: string;
let clone: string;
let marker: string;

const gitIn = async (cwd: string, ...args: string[]) =>
  (
    await git(
      "git",
      ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
      { cwd },
    )
  ).stdout.trim();

const plantHook = async (path: string, token: string): Promise<void> => {
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s' '${token}' > '${marker}'\nexit 0\n`,
  );
  await chmod(path, 0o755);
};

const markerExists = (): boolean => existsSync(marker);

const options = (upstream: string[]): PublishOptions => ({
  workspace: clone,
  branch,
  upstream,
  identity,
  agent,
  url: remote,
  token: "ghs_notused",
  scratchDir: root,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s1-publish-"));
  remote = join(root, "remote.git");
  clone = join(root, "clone");
  marker = join(root, "marker");
  await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await git("git", ["init", "--quiet", "-b", "main", clone]);
  await writeFile(join(clone, "README.md"), "chore: start\n");
  await gitIn(clone, "add", "README.md");
  await gitIn(clone, "commit", "--quiet", "-m", "chore: start");
  await gitIn(clone, "push", "--quiet", remote, "main");
  await gitIn(clone, "switch", "--quiet", "-c", branch);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("S1 · publish.ts does not run the Agent clone's hooks", () => {
  it("holds: publishBranch runs neither post-commit nor uploadpack.packObjectsHook from the Agent clone", async () => {
    const main = await gitIn(clone, "rev-parse", "main");
    // An Agent's new commit on the branch.
    await writeFile(join(clone, "basket.txt"), "a basket\n");
    await gitIn(clone, "add", "basket.txt");
    await gitIn(clone, "commit", "--quiet", "-m", "feat: a basket");

    // Hostile config/hooks an Agent (position 3) planted in its clone.
    await plantHook(
      join(clone, ".git", "hooks", "post-commit"),
      "POST_COMMIT_RAN",
    );
    await gitIn(
      clone,
      "config",
      "uploadpack.packObjectsHook",
      `sh -c 'printf PACKHOOK_RAN > ${JSON.stringify(marker)}; exec git pack-objects "$@"' --`,
    );
    await gitIn(clone, "config", "uploadpack.allowFilter", "true");

    const published = await publishBranch(options([main]));

    expect(published.commits).toHaveLength(1);
    expect(markerExists()).toBe(false);
  });

  it("holds (S1-1): a fetch from the Agent clone by `file://` URL runs no uploadpack.packObjectsHook it names", async () => {
    await writeFile(join(clone, "basket.txt"), "a basket\n");
    await gitIn(clone, "add", "basket.txt");
    await gitIn(clone, "commit", "--quiet", "-m", "feat: a basket");
    await gitIn(
      clone,
      "config",
      "uploadpack.packObjectsHook",
      `sh -c 'printf PACKHOOK_RAN > ${JSON.stringify(marker)}; exec git pack-objects "$@"' --`,
    );
    const other = join(root, "other.git");
    await runGit("make a repository", ["init", "--quiet", "--bare", other]);

    // Through `upload-pack`, unlike a fetch from a plain path.
    await runGit(
      "fetch from the Agent's clone",
      [
        "fetch",
        "--quiet",
        "--no-tags",
        `file://${clone}`,
        `+refs/heads/${branch}:refs/heads/${branch}`,
      ],
      { cwd: other },
    );

    expect(markerExists()).toBe(false);
  });
});
