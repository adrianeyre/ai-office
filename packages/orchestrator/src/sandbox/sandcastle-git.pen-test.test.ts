import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { claudeCode, run as sandcastleRun } from "@ai-hero/sandcastle";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { allowListed } from "./environment.ts";
import { createFakeSandbox, result, say } from "./fake-sandbox.ts";
import { guardSandcastleGit } from "./sandcastle-git.ts";

// Probe S1 (H1): Sandcastle's own host-side git, which AI Office drives
// through `runSandcastle` (`runner.ts`, `grilling/fact-finding.ts`).
//
// AI Office runs Agents with Sandcastle's `branch` strategy, which keeps
// the worktree under `.sandcastle/worktrees/<branch>` in the host clone and
// reuses it across sessions. Sandcastle manages those worktrees with its
// own git calls. Its runner (read from the installed package,
// `@ai-hero/sandcastle/dist/chunk-VOG34SRF.js`) runs git through:
//
//   var execGit = (args, cwd) => Effect.async((resume) => {
//     execFile("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } }, ...)
//   });
//
// and calls, among others, `git worktree add <path> <branch>` to make or
// reuse a worktree and `git merge ...` to fast-forward a reused worktree to
// origin. Unlike AI Office's own `runGit`, `execGit` passes the full
// process environment unchanged: it does not even set `GIT_CONFIG_NOSYSTEM`
// or `GIT_CONFIG_GLOBAL`, and it sets no `core.hooksPath`. So it runs the
// repository's hooks, and `git worktree add` runs `post-checkout` while
// `git merge` runs `post-merge`/`post-commit`.
//
// This test drives git with `execGit`'s exact environment and the exact
// subcommands Sandcastle issues, so it pins Sandcastle's exposure at the
// git version in the sandbox. It cannot drive Sandcastle's full worktree
// manager here (that needs the Effect runtime and a configured sandbox
// run); on the live stack, triggering a second session on an issue whose
// worktree a prior session wrote exercises the reuse/merge path directly.
// See docs/pen-testing/assessments/S1.md.
//
// Finding S1-2 is fixed. `execGit` still runs `git` from the PATH with the
// process's environment, so before AI Office runs Sandcastle it puts its
// own `git` first on the app's PATH (`guardSandcastleGit`, from
// `createSandboxRunner` and `createSandboxFactFinder`), which runs each
// command as AI Office runs its own (`runGit`, S1-1). These tests install
// it as AI Office does, then drive git exactly as `execGit` does: each
// `it.fails` became an `it`, and each test that pinned the old behaviour
// is a regression test that it is gone. The last describe drives real
// Sandcastle, twice on one clone, as a Fresh Start does.

const execFileAsync = promisify(execFile);

/** Exactly how Sandcastle's `execGit` spawns git: full env, LC_ALL=C, no neutralisation. */
const execGit = (args: readonly string[], cwd: string) =>
  execFileAsync("git", [...args], {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
  });

/** AI Office's own `runGit` neutralises system/global config; the helper mirrors that for setup. */
const seedGit = (args: readonly string[], cwd: string) =>
  execFileAsync("git", [...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "seed",
      GIT_AUTHOR_EMAIL: "seed@example.com",
      GIT_COMMITTER_NAME: "seed",
      GIT_COMMITTER_EMAIL: "seed@example.com",
    },
  });

let root: string;
let clone: string;
let marker: string;

// As `createSandboxRunner` and `createSandboxFactFinder` do.
beforeAll(() => {
  guardSandcastleGit();
});

const plantHook = async (path: string, token: string): Promise<void> => {
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s' '${token}' > '${marker}'\nexit 0\n`,
  );
  await chmod(path, 0o755);
};

const markerExists = (): boolean => existsSync(marker);

const markerValue = async (): Promise<string | null> =>
  existsSync(marker) ? (await readFile(marker, "utf8")).trim() : null;

/** A filter driver in the repo's config, assigned to every file. */
const plantFilter = async (kind: "clean" | "smudge"): Promise<void> => {
  const script = join(root, `${kind}.sh`);
  await writeFile(
    script,
    `#!/bin/sh\nprintf '%s' '${kind.toUpperCase()}_RAN' > '${marker}'\ncat\n`,
  );
  await chmod(script, 0o755);
  await seedGit(["config", `filter.evil.${kind}`, script], clone);
  await writeFile(join(clone, ".git", "info", "attributes"), "* filter=evil\n");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s1-sandcastle-"));
  clone = join(root, "clone");
  marker = join(root, "marker");
  await seedGit(["init", "--quiet", "-b", "main", clone], root);
  await writeFile(join(clone, "README.md"), "hello\n");
  await seedGit(["add", "README.md"], clone);
  await seedGit(["commit", "--quiet", "-m", "init"], clone);
  // A feature branch, as an Agent's session would leave.
  await seedGit(["switch", "--quiet", "-c", "feature"], clone);
  await writeFile(join(clone, "work.txt"), "work\n");
  await seedGit(["add", "work.txt"], clone);
  await seedGit(["commit", "--quiet", "-m", "feat: work"], clone);
  await seedGit(["switch", "--quiet", "main"], clone);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("S1 · Sandcastle's host-side git runs the Agent-written repo's hooks", () => {
  it("regression (S1-2): Sandcastle's `git worktree add` no longer runs the repo's post-checkout hook", async () => {
    await plantHook(
      join(clone, ".git", "hooks", "post-checkout"),
      "POST_CHECKOUT_RAN",
    );

    const worktree = join(root, "wt");
    await execGit(["worktree", "add", "--quiet", worktree, "feature"], clone);

    expect(markerExists()).toBe(false);
    // The worktree was still made.
    expect(existsSync(join(worktree, "work.txt"))).toBe(true);
    await execGit(["worktree", "remove", "--force", worktree], clone).catch(
      () => undefined,
    );
  });

  it("Sandcastle's worktree management must not run a hook the Agent planted (post-checkout)", async () => {
    await plantHook(
      join(clone, ".git", "hooks", "post-checkout"),
      "POST_CHECKOUT_RAN",
    );

    const worktree = join(root, "wt");
    await execGit(["worktree", "add", "--quiet", worktree, "feature"], clone);

    expect(markerExists()).toBe(false);
    await execGit(["worktree", "remove", "--force", worktree], clone).catch(
      () => undefined,
    );
  });

  it("regression (S1-2): Sandcastle's `git merge` no longer runs the repo's post-merge hook", async () => {
    await plantHook(
      join(clone, ".git", "hooks", "post-merge"),
      "POST_MERGE_RAN",
    );

    await execGit(["merge", "--no-edit", "feature"], clone);

    expect(markerExists()).toBe(false);
    // The merge itself still happened.
    expect(existsSync(join(clone, "work.txt"))).toBe(true);
  });

  it("Sandcastle's merge-back must not run a hook the Agent planted (post-merge)", async () => {
    await plantHook(
      join(clone, ".git", "hooks", "post-merge"),
      "POST_MERGE_RAN",
    );

    await execGit(["merge", "--no-edit", "feature"], clone);

    expect(markerExists()).toBe(false);
  });
});

describe("S1-2 · Sandcastle's other host-side Git runs nothing the repository names", () => {
  it("does not run core.fsmonitor when it reads a worktree's status (reuse and clean-up)", async () => {
    const program = join(root, "fsmonitor.sh");
    await plantHook(program, "FSMONITOR_RAN");
    await seedGit(["config", "core.fsmonitor", program], clone);
    await writeFile(join(clone, "README.md"), "changed\n");

    const { stdout } = await execGit(["status", "--porcelain"], clone);

    expect(await markerValue()).toBeNull();
    // The status is still read: Sandcastle keeps a dirty worktree.
    expect(stdout).toContain("README.md");
  });

  it("does not run a smudge filter when `git worktree add` checks a branch out", async () => {
    await plantFilter("smudge");

    const worktree = join(root, "wt");
    await execGit(["worktree", "add", "--quiet", worktree, "feature"], clone);

    expect(await markerValue()).toBeNull();
    expect(existsSync(join(worktree, "work.txt"))).toBe(true);
  });

  it("does not run a clean filter when it reads a worktree's status", async () => {
    await plantFilter("clean");
    // As long as before, but newer: Git must read it through the filter.
    await writeFile(join(clone, "README.md"), "jello\n");
    await utimes(
      join(clone, "README.md"),
      new Date(),
      new Date(Date.now() + 5000),
    );

    await execGit(["status", "--porcelain"], clone);

    expect(await markerValue()).toBeNull();
  });

  it("runs no hook or filter when it fast-forwards a reused worktree from origin (fetch, then `merge --ff-only`)", async () => {
    // Sandcastle's `fastForwardFromOrigin`, in a worktree on `feature`.
    const origin = join(root, "origin.git");
    await seedGit(["clone", "--quiet", "--bare", clone, origin], root);
    await seedGit(["remote", "add", "origin", origin], clone);
    const ahead = join(root, "ahead");
    await seedGit(["clone", "--quiet", "-b", "feature", origin, ahead], root);
    await writeFile(join(ahead, "more.txt"), "more\n");
    await seedGit(["add", "more.txt"], ahead);
    await seedGit(["commit", "--quiet", "-m", "feat: more"], ahead);
    await seedGit(["push", "--quiet", "origin", "feature"], ahead);
    const worktree = join(root, "wt");
    await seedGit(["worktree", "add", "--quiet", worktree, "feature"], clone);
    for (const hook of [
      "post-merge",
      "post-checkout",
      "reference-transaction",
    ]) {
      await plantHook(join(clone, ".git", "hooks", hook), hook);
    }
    await plantFilter("smudge");

    const flags = ["-c", "branch.autoSetupMerge=false"];
    await execGit([...flags, "fetch", "origin", "feature"], worktree);
    await execGit([...flags, "merge", "--ff-only", "origin/feature"], worktree);

    expect(await markerValue()).toBeNull();
    expect(existsSync(join(worktree, "more.txt"))).toBe(true);
  });

  it("does not run core.alternateRefsCommand when it fetches into a repository with alternates", async () => {
    const origin = join(root, "origin.git");
    await seedGit(["clone", "--quiet", "--bare", clone, origin], root);
    await seedGit(["remote", "add", "origin", origin], clone);
    // Another repository's objects, borrowed, whose refs Git asks for.
    const borrowed = join(root, "borrowed.git");
    await seedGit(["clone", "--quiet", "--bare", clone, borrowed], root);
    await writeFile(
      join(clone, ".git", "objects", "info", "alternates"),
      `${join(borrowed, "objects")}\n`,
    );
    const program = join(root, "alternate-refs.sh");
    await plantHook(program, "ALTERNATE_REFS_RAN");
    await seedGit(["config", "core.alternateRefsCommand", program], clone);

    await execGit(["fetch", "origin", "feature"], clone);

    expect(await markerValue()).toBeNull();
  });

  it("refuses to fetch for a repository that names a remote's upload-pack program", async () => {
    const origin = join(root, "origin.git");
    await seedGit(["clone", "--quiet", "--bare", clone, origin], root);
    await seedGit(["remote", "add", "origin", origin], clone);
    const program = join(root, "upload-pack.sh");
    await plantHook(program, "UPLOADPACK_RAN");
    await seedGit(["config", "remote.origin.uploadpack", program], clone);

    await expect(
      execGit(["fetch", "origin", "feature"], clone),
    ).rejects.toThrow(/names a program for a remote/);

    expect(await markerValue()).toBeNull();
  });
});

describe("S1-2 · real Sandcastle, twice on one clone, as AI Office drives it", () => {
  it("runs none of the hooks or programs an Agent planted in its first session, in either session", async () => {
    const branch = "ai-office/7-add-a-basket";
    const program = join(root, "planted.sh");
    const sandbox = await createFakeSandbox(async ({ print, sh }) => {
      await sh(
        "echo basket > basket.txt && git add basket.txt && git -c user.name=x -c user.email=x@example.com commit --quiet -m 'feat: basket'",
      );
      // Work left uncommitted, so Sandcastle keeps the worktree to reuse.
      await sh("echo wip > wip.txt");
      // Then, after its own last Git command (the sandbox's Git would run
      // them too), it plants them in the clone's `.git`, mounted there.
      const common = (await sh("git rev-parse --git-common-dir")).stdout.trim();
      const hooks = join(
        common.startsWith("/") ? common : join(clone, common),
        "hooks",
      );
      for (const hook of [
        "post-checkout",
        "post-merge",
        "post-commit",
        "reference-transaction",
      ]) {
        await plantHook(join(hooks, hook), hook);
      }
      await plantHook(program, "FSMONITOR_RAN");
      await sh(`git config core.fsmonitor '${program}'`);
      print(say("Done."));
      print(result({ input: 1, output: 1 }));
    });
    const session = () =>
      sandcastleRun({
        agent: claudeCode("claude-opus-5-5"),
        sandbox: allowListed(sandbox.provider({})),
        cwd: clone,
        prompt: "Add a basket.",
        name: "S1-2",
        branchStrategy: { type: "branch", branch, baseBranch: "main" },
        logging: { type: "file", path: join(root, "sandcastle.log") },
      });

    // First session: its worktree is made, then read and kept.
    const first = await session();
    expect(first.commits).toHaveLength(1);
    expect(first.preservedWorktreePath).toBeDefined();
    // Second session: the Agent-written worktree is reused.
    sandbox.agent = ({ print }) => {
      print(say("Carrying on."));
      print(result({ input: 1, output: 1 }));
      return Promise.resolve();
    };
    await session();

    expect(await markerValue()).toBeNull();
    expect(sandbox.sandboxes).toHaveLength(2);
  });
});
