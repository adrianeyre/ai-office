import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGit } from "./command.ts";

// Probe S1 (H1): host-side git in an Agent-written worktree.
//
// Every host-side git call AI Office makes goes through `runGit`
// (`command.ts`). Its `environment()` neutralises *system* and *global*
// config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`) but says
// nothing about the repository's own `.git/config` or `.git/hooks`. On a
// Fresh Start `saveUncommitted` (`../sandbox/runner.ts`) runs, in a
// worktree an Agent has written, exactly:
//
//   git status --porcelain
//   git add --all
//   git commit --quiet --no-verify -m <message>
//
// and the fact-finding flow (`../grilling/fact-finding.ts`) runs
// `git status --porcelain` in the Agent's clone. This container is the app
// container, which holds the Docker socket (`docker-compose.yml`), so any
// program git runs here runs with the app's authority — ADR 0002's GitHub
// App key, every AI Account and, through the socket, root on the host.
//
// These tests drive the *real* `runGit` with the *real* argument vectors
// those call sites use, against a real repository in a temp dir whose
// config and hooks stand in for what an Agent (position 3) would have
// planted. A marker file written by the planted code is the proof that the
// app process ran it.
//
// Pinned at commit: see docs/pen-testing/assessments/S1.md. Finding S1-1
// is fixed: `runGit` now sets every such setting again on Git's command
// line, so each `it.fails` became an `it` and each test that pinned the
// old behaviour is a regression test that it is gone.

let root: string;
let repo: string;
let marker: string;

/** The author/committer identity `saveUncommitted` passes through the env. */
const identityEnv = {
  GIT_AUTHOR_NAME: "owner",
  GIT_AUTHOR_EMAIL: "owner@example.com",
  GIT_COMMITTER_NAME: "owner",
  GIT_COMMITTER_EMAIL: "owner@example.com",
};

/** Seeds a real repository with one commit, as a clone would have. */
const seedRepo = async (dir: string): Promise<void> => {
  await runGit("init", ["init", "--quiet", "-b", "main", dir]);
  await runGit("name", ["config", "user.name", "seed"], { cwd: dir });
  await runGit("email", ["config", "user.email", "seed@example.com"], {
    cwd: dir,
  });
  await writeFile(join(dir, "README.md"), "hello\n");
  await runGit("add", ["add", "README.md"], { cwd: dir });
  await runGit("commit", ["commit", "--quiet", "-m", "init"], { cwd: dir });
};

/** A shell script at `path` that writes `token` into the marker file. */
const plantScript = async (path: string, token: string): Promise<void> => {
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s' '${token}' > '${marker}'\n# fsmonitor must answer; empty is fine\nexit 0\n`,
  );
  await chmod(path, 0o755);
};

const markerValue = async (): Promise<string | null> =>
  existsSync(marker) ? (await readFile(marker, "utf8")).trim() : null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s1-command-"));
  repo = join(root, "repo");
  marker = join(root, "marker");
  await seedRepo(repo);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("S1 · runGit runs no code the repository's own config/hooks define", () => {
  // --- core.fsmonitor, triggered by `git status` (saveUncommitted, fact-finding) ---

  it("regression (S1-1): `git status --porcelain` no longer runs the repo's core.fsmonitor program", async () => {
    await plantScript(join(root, "fsmon.sh"), "FSMONITOR_RAN");
    await runGit(
      "set fsmonitor",
      ["config", "core.fsmonitor", join(root, "fsmon.sh")],
      {
        cwd: repo,
      },
    );

    await runGit("read the worktree's changes", ["status", "--porcelain"], {
      cwd: repo,
    });

    expect(await markerValue()).toBeNull();
  });

  it("runGit must not run a program the repository's config names (core.fsmonitor)", async () => {
    await plantScript(join(root, "fsmon.sh"), "FSMONITOR_RAN");
    await runGit(
      "set fsmonitor",
      ["config", "core.fsmonitor", join(root, "fsmon.sh")],
      { cwd: repo },
    );

    await runGit("read the worktree's changes", ["status", "--porcelain"], {
      cwd: repo,
    });

    // The property that should hold: no repository-defined program ran.
    expect(await markerValue()).toBeNull();
  });

  // --- post-commit hook, run by `git commit --no-verify` (saveUncommitted) ---

  it("regression (S1-1): `git commit --no-verify` no longer runs the repo's post-commit hook", async () => {
    await plantScript(
      join(repo, ".git", "hooks", "post-commit"),
      "POST_COMMIT_RAN",
    );
    await writeFile(join(repo, "work.txt"), "in progress\n");

    await runGit("stage the work in progress", ["add", "--all"], { cwd: repo });
    await runGit(
      "commit the work in progress",
      [
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        "chore: save work in progress",
      ],
      { cwd: repo, env: identityEnv },
    );

    expect(await markerValue()).toBeNull();
  });

  it("--no-verify must stop any hook the repo plants (post-commit)", async () => {
    await plantScript(
      join(repo, ".git", "hooks", "post-commit"),
      "POST_COMMIT_RAN",
    );
    await writeFile(join(repo, "work.txt"), "in progress\n");

    await runGit("stage the work in progress", ["add", "--all"], {
      cwd: repo,
    });
    await runGit(
      "commit the work in progress",
      ["commit", "--quiet", "--no-verify", "-m", "chore"],
      { cwd: repo, env: identityEnv },
    );

    // --no-verify only skips pre-commit and commit-msg; the property that
    // should hold is that no Agent-planted hook runs at all.
    expect(await markerValue()).toBeNull();
  });

  it("regression (S1-1): `git commit --no-verify` no longer runs the reference-transaction hook", async () => {
    await plantScript(
      join(repo, ".git", "hooks", "reference-transaction"),
      "REFTX_RAN",
    );
    await writeFile(join(repo, "work.txt"), "in progress\n");

    await runGit("stage the work in progress", ["add", "--all"], { cwd: repo });
    await runGit(
      "commit the work in progress",
      ["commit", "--quiet", "--no-verify", "-m", "chore"],
      { cwd: repo, env: identityEnv },
    );

    expect(await markerValue()).toBeNull();
  });

  // --- filter.<x>.clean, run by `git add --all` via .gitattributes (saveUncommitted) ---

  it("regression (S1-1): `git add --all` no longer runs a clean filter the repo defines", async () => {
    await runGit(
      "set a clean filter",
      [
        "config",
        "filter.pwn.clean",
        `sh -c 'printf CLEAN_FILTER_RAN > ${JSON.stringify(marker)}; cat'`,
      ],
      { cwd: repo },
    );
    await writeFile(join(repo, ".gitattributes"), "*.secret filter=pwn\n");
    await writeFile(join(repo, "payload.secret"), "data\n");

    await runGit("stage the work in progress", ["add", "--all"], { cwd: repo });

    expect(await markerValue()).toBeNull();
  });

  it("runGit must not run a filter the repo's config + .gitattributes define (filter.*.clean)", async () => {
    await runGit(
      "set a clean filter",
      [
        "config",
        "filter.pwn.clean",
        `sh -c 'printf CLEAN_FILTER_RAN > ${JSON.stringify(marker)}; cat'`,
      ],
      { cwd: repo },
    );
    await writeFile(join(repo, ".gitattributes"), "*.secret filter=pwn\n");
    await writeFile(join(repo, "payload.secret"), "data\n");

    await runGit("stage the work in progress", ["add", "--all"], {
      cwd: repo,
    });

    expect(await markerValue()).toBeNull();
  });
});

describe("S1 · vectors that do not fire through AI Office's current call sites", () => {
  // `--no-verify` DOES stop the two hooks it is defined to stop: this part
  // of the control holds, and the round confirms it still does.
  it("holds: `--no-verify` does skip the pre-commit hook", async () => {
    await plantScript(
      join(repo, ".git", "hooks", "pre-commit"),
      "PRE_COMMIT_RAN",
    );
    await writeFile(join(repo, "work.txt"), "in progress\n");

    await runGit("stage", ["add", "--all"], { cwd: repo });
    await runGit(
      "commit",
      ["commit", "--quiet", "--no-verify", "-m", "chore"],
      { cwd: repo, env: identityEnv },
    );

    expect(await markerValue()).toBeNull();
  });

  // No current host-side call generates a patch: `changedFiles`
  // (`../coder/coder.ts`) uses `git show --name-only --format=`, the Fresh
  // Start summary uses `git diff --name-only`. So diff.external, though
  // trusted from the repo config, is not reached today. This pins that —
  // and will break (telling a future author) if a call starts generating a
  // diff on an Agent-written repo without an override.
  it("holds today: `git show --name-only --format=` does not run diff.external", async () => {
    await plantScript(join(root, "ext.sh"), "DIFF_EXTERNAL_RAN");
    await runGit(
      "set diff.external",
      ["config", "diff.external", join(root, "ext.sh")],
      {
        cwd: repo,
      },
    );
    await writeFile(join(repo, "README.md"), "changed\n");
    await runGit("commit a change", ["commit", "-am", "change"], {
      cwd: repo,
      env: identityEnv,
    });
    const head = await runGit("head", ["rev-parse", "HEAD"], { cwd: repo });

    // The exact args `changedFiles` uses.
    await runGit(
      "list the files a commit changed",
      ["show", "--no-renames", "--name-only", "--format=", head],
      { cwd: repo },
    );

    expect(await markerValue()).toBeNull();
  });

  // core.sshCommand only runs on the ssh transport; AI Office clones,
  // fetches and pushes over https (`clone.ts`, `publish.ts`). No host-side
  // call uses ssh against an Agent-written repo, so this is not reached.
  it("holds today: no host-side call uses the ssh transport, so core.sshCommand is unreached", async () => {
    await plantScript(join(root, "ssh.sh"), "SSH_COMMAND_RAN");
    await runGit(
      "set sshCommand",
      ["config", "core.sshCommand", join(root, "ssh.sh")],
      {
        cwd: repo,
      },
    );

    // The one host-side op that touches the Agent's clone as a remote is
    // publish's `git fetch <path>` — a local path, never ssh.
    const other = join(root, "other");
    await runGit("init other", ["init", "--quiet", "--bare", other]);
    await runGit(
      "fetch from the agent clone",
      ["fetch", "--no-tags", repo, "+refs/heads/main:refs/heads/main"],
      { cwd: other },
    );

    expect(await markerValue()).toBeNull();
  });
});

// S1-1's siblings: every other way the issue names for a repository to
// make Git run a program, through call sites AI Office could add later.
// Each must run nothing the repository names, whatever Git command it is.
describe("S1-1 · no other setting the repository can write runs a program", () => {
  /** A `sh -c` command line that writes `token` into the marker file. */
  const command = (token: string) =>
    `sh -c 'printf ${token} > ${JSON.stringify(marker)}; cat'`;

  it("does not run a smudge filter on checkout", async () => {
    await writeFile(join(repo, ".gitattributes"), "*.secret filter=pwn\n");
    await writeFile(join(repo, "payload.secret"), "data\n");
    await runGit("stage", ["add", "--all"], { cwd: repo });
    await runGit("commit", ["commit", "--quiet", "-m", "payload"], {
      cwd: repo,
      env: identityEnv,
    });
    await runGit(
      "set a smudge filter",
      ["config", "filter.pwn.smudge", command("SMUDGE_RAN")],
      { cwd: repo },
    );
    await rm(join(repo, "payload.secret"));

    await runGit("check the file out", ["checkout", "--", "payload.secret"], {
      cwd: repo,
    });

    expect(await markerValue()).toBeNull();
    expect(await readFile(join(repo, "payload.secret"), "utf8")).toBe("data\n");
  });

  it("does not run a long-running process filter", async () => {
    await runGit(
      "set a process filter",
      ["config", "filter.pwn.process", command("PROCESS_FILTER_RAN")],
      { cwd: repo },
    );
    await writeFile(join(repo, ".gitattributes"), "*.secret filter=pwn\n");
    await writeFile(join(repo, "payload.secret"), "data\n");

    await runGit("stage", ["add", "--all"], { cwd: repo });

    expect(await markerValue()).toBeNull();
  });

  it("does not run a filter that `include.path` pulls in", async () => {
    await writeFile(
      join(repo, "included.config"),
      `[filter "pwn"]\n\tclean = ${command("INCLUDED_FILTER_RAN")}\n\trequired = true\n`,
    );
    await runGit(
      "include more config",
      ["config", "include.path", join(repo, "included.config")],
      { cwd: repo },
    );
    await writeFile(join(repo, ".gitattributes"), "*.secret filter=pwn\n");
    await writeFile(join(repo, "payload.secret"), "data\n");

    await runGit("stage", ["add", "--all"], { cwd: repo });

    expect(await markerValue()).toBeNull();
  });

  it("does not run a filter that `includeIf` pulls in", async () => {
    await writeFile(
      join(root, "conditional.config"),
      `[filter "pwn"]\n\tclean = ${command("INCLUDE_IF_FILTER_RAN")}\n`,
    );
    await runGit(
      "include more config on a condition",
      [
        "config",
        `includeIf.gitdir:${repo}/.git.path`,
        join(root, "conditional.config"),
      ],
      { cwd: repo },
    );
    await writeFile(join(repo, ".gitattributes"), "*.secret filter=pwn\n");
    await writeFile(join(repo, "payload.secret"), "data\n");

    await runGit("read the worktree's changes", ["status", "--porcelain"], {
      cwd: repo,
    });
    await runGit("stage", ["add", "--all"], { cwd: repo });

    expect(await markerValue()).toBeNull();
  });

  it("does not run a filter that `.git/info/attributes` assigns", async () => {
    await runGit(
      "set a clean filter",
      ["config", "filter.pwn.clean", command("INFO_ATTRIBUTES_RAN")],
      { cwd: repo },
    );
    await writeFile(
      join(repo, ".git", "info", "attributes"),
      "*.txt filter=pwn\n",
    );
    await writeFile(join(repo, "work.txt"), "in progress\n");

    await runGit("stage", ["add", "--all"], { cwd: repo });

    expect(await markerValue()).toBeNull();
  });

  it("does not run diff.external when a command makes a patch", async () => {
    await plantScript(join(root, "ext.sh"), "DIFF_EXTERNAL_RAN");
    await runGit(
      "set diff.external",
      ["config", "diff.external", join(root, "ext.sh")],
      { cwd: repo },
    );
    await writeFile(join(repo, "README.md"), "changed\n");

    await runGit("show the change", ["diff"], { cwd: repo }).catch(
      () => undefined,
    );
    await runGit("commit", ["commit", "--quiet", "-am", "change"], {
      cwd: repo,
      env: identityEnv,
    });
    await runGit("show the commit", ["show", "HEAD"], { cwd: repo }).catch(
      () => undefined,
    );

    expect(await markerValue()).toBeNull();
  });

  it("does not run a diff driver's textconv or command", async () => {
    await runGit(
      "set a textconv",
      ["config", "diff.pwn.textconv", command("TEXTCONV_RAN")],
      { cwd: repo },
    );
    await runGit(
      "set a diff command",
      ["config", "diff.pwn.command", command("DIFF_COMMAND_RAN")],
      { cwd: repo },
    );
    await writeFile(join(repo, ".gitattributes"), "*.md diff=pwn\n");
    await writeFile(join(repo, "README.md"), "changed\n");
    await runGit("commit", ["commit", "--quiet", "-am", "change"], {
      cwd: repo,
      env: identityEnv,
    });

    await runGit("show the commit", ["show", "HEAD"], { cwd: repo }).catch(
      () => undefined,
    );
    await runGit("log the patches", ["log", "-p"], { cwd: repo }).catch(
      () => undefined,
    );

    expect(await markerValue()).toBeNull();
  });

  it("does not run core.sshCommand: no SSH transport is allowed", async () => {
    await plantScript(join(root, "ssh.sh"), "SSH_COMMAND_RAN");
    await runGit(
      "set sshCommand",
      ["config", "core.sshCommand", join(root, "ssh.sh")],
      { cwd: repo },
    );
    await runGit(
      "add an ssh remote",
      ["remote", "add", "elsewhere", "ssh://git@example.com/owner/repo.git"],
      { cwd: repo },
    );

    await expect(
      runGit("fetch over ssh", ["fetch", "elsewhere"], { cwd: repo }),
    ).rejects.toThrow();

    expect(await markerValue()).toBeNull();
  });

  it("does not run a signing program on commit", async () => {
    await plantScript(join(root, "gpg.sh"), "GPG_PROGRAM_RAN");
    await runGit("sign every commit", ["config", "commit.gpgSign", "true"], {
      cwd: repo,
    });
    await runGit(
      "set the signing program",
      ["config", "gpg.program", join(root, "gpg.sh")],
      { cwd: repo },
    );
    await writeFile(join(repo, "work.txt"), "in progress\n");

    await runGit("stage", ["add", "--all"], { cwd: repo });
    await runGit(
      "commit the work in progress",
      ["commit", "--quiet", "--no-verify", "-m", "chore"],
      { cwd: repo, env: identityEnv },
    );

    expect(await markerValue()).toBeNull();
  });

  it("does not run a merge driver", async () => {
    await runGit(
      "set a merge driver",
      ["config", "merge.pwn.driver", command("MERGE_DRIVER_RAN")],
      { cwd: repo },
    );
    await writeFile(join(repo, ".gitattributes"), "*.md merge=pwn\n");
    await runGit("stage", ["add", "--all"], { cwd: repo });
    await runGit("commit", ["commit", "--quiet", "-m", "attributes"], {
      cwd: repo,
      env: identityEnv,
    });
    await runGit("branch", ["switch", "--quiet", "-c", "side"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "side\n");
    await runGit("commit", ["commit", "--quiet", "-am", "side"], {
      cwd: repo,
      env: identityEnv,
    });
    await runGit("back", ["switch", "--quiet", "main"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "main\n");
    await runGit("commit", ["commit", "--quiet", "-am", "main"], {
      cwd: repo,
      env: identityEnv,
    });

    await runGit("merge", ["merge", "--no-edit", "side"], {
      cwd: repo,
      env: identityEnv,
    }).catch(() => undefined);

    expect(await markerValue()).toBeNull();
  });

  it("does not run a remote's upload-pack program on fetch", async () => {
    const other = join(root, "other");
    await runGit("clone", ["clone", "--quiet", repo, other]);
    await plantScript(join(root, "upload.sh"), "UPLOAD_PACK_RAN");
    await runGit(
      "set the remote's upload-pack",
      ["config", "remote.origin.uploadpack", join(root, "upload.sh")],
      { cwd: other },
    );

    // Git keeps the first upload-pack it reads, so it cannot be set
    // again: Git is not run at all in a repository that names one.
    await expect(
      runGit("fetch", ["fetch", "--quiet", "origin"], { cwd: other }),
    ).rejects.toThrow(
      "Git could not fetch: the repository names a program for a remote (remote.origin.uploadpack)",
    );

    expect(await markerValue()).toBeNull();
  });
});
