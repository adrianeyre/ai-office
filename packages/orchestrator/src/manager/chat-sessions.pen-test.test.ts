import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, chmod, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createFakeGitHub } from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import type { ToolRun } from "../models/agent-tool-client.ts";
import { dockerSessionTool } from "./chat-sessions.ts";

// P2 (issue #205), H18. The Manager's chat session runs on a read-only
// clone, and AI Office refreshes that clone on the host before each turn
// (`refresh` in chat-sessions.ts: `git fetch` then `git reset --hard`).
// The S1 round (H1, #186/#201/#203) fixed host-side git running what an
// Agent's repository names. These probes confirm it holds for the Manager's
// clone:
//
// - The clone is mounted into the session read-only, so the session cannot
//   write its `.git` (config, hooks) to begin with.
// - Even with a hostile `core.fsmonitor`, `core.hooksPath` and a
//   `post-commit` hook planted in the clone, the host-side fetch and reset
//   that `refresh` runs execute none of them.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/P2.md.

const git = promisify(execFile);
const repository = "adrianeyre/web-shop";
const gatewayKey = "aio_gk_joansownkeyforhersession00000000000";
const conversation = "manager-chat:web-shop:0";

const answered = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
];

const runner = () => {
  const runs: ToolRun[] = [];
  return {
    runs,
    async *run(run: ToolRun) {
      runs.push(run);
      await Promise.resolve();
      yield* answered;
    },
  };
};

const turn = (workDir: string) =>
  ({
    tool: "Claude Code" as const,
    floor: { id: "web-shop", repository, defaultBranch: "main" },
    manager: { id: "joan", aiProvider: "Claude" },
    model: "claude-opus-5-5",
    effort: "high",
    system: "You are Joan.",
    conversation,
    session: {
      resume: false as const,
      id: "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e",
    },
    input: "Where is VAT?",
    images: [],
    signal: new AbortController().signal,
    onText: () => undefined,
    onTool: () => undefined,
    onSession: () => undefined,
    _workDir: workDir,
  }) as never;

describe("P2: host-side git on the Manager's read-only clone", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
    root = undefined;
  });

  const seeded = async () => {
    root = await mkdtemp(join(tmpdir(), "p2-manager-clone-"));
    const remote = join(root, "web-shop.git");
    const seed = join(root, "seed");
    const gitIn = (cwd: string, ...args: string[]) =>
      git(
        "git",
        ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
        { cwd },
      );
    await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
    await git("git", ["init", "--quiet", "-b", "main", seed]);
    await writeFile(join(seed, "total.ts"), "export const vat = 0.2;\n");
    await gitIn(seed, "add", "-A");
    await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
    await gitIn(seed, "push", "--quiet", remote, "main");
    return { remote, seed, gitIn };
  };

  it("mounts the clone read-only, so the session can never write its .git", async () => {
    const { remote } = await seeded();
    const github = createFakeGitHub();
    github.installRepository(repository);
    const fake = runner();
    const workDir = join(root ?? "", "work");
    const tool = dockerSessionTool({
      github,
      gateway: () =>
        Promise.resolve({ url: "http://app:3047", key: gatewayKey }),
      run: (run) => fake.run(run),
      workDir,
      cloneUrl: () => remote,
    });
    await tool.run(turn(workDir));
    const [made] = fake.runs;
    const clone = join(workDir, "web-shop", "repo");
    expect(made?.mounts?.[0]).toEqual({
      host: clone,
      container: "/home/agent/workspace",
      readOnly: true,
    });
  });

  it("runs the host-side refresh without executing a hostile fsmonitor, hooksPath or post-commit hook", async () => {
    const { remote, seed, gitIn } = await seeded();
    const github = createFakeGitHub();
    github.installRepository(repository);
    const fake = runner();
    const workDir = join(root ?? "", "work");
    const tool = dockerSessionTool({
      github,
      gateway: () =>
        Promise.resolve({ url: "http://app:3047", key: gatewayKey }),
      run: (run) => fake.run(run),
      workDir,
      cloneUrl: () => remote,
    });
    // First turn: makes the clone on the host.
    await tool.run(turn(workDir));
    const clone = join(workDir, "web-shop", "repo");

    // Plant what H1 would plant if the clone were writable from the session.
    const marker = join(root ?? "", "fsmonitor-ran");
    const hooks = join(root ?? "", "hooks");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(hooks, { recursive: true });
    const fsmonitor = join(root ?? "", "fsmonitor.sh");
    await writeFile(fsmonitor, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(fsmonitor, 0o755);
    const postCommit = join(hooks, "post-commit");
    await writeFile(postCommit, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(postCommit, 0o755);
    await appendFile(
      join(clone, ".git", "config"),
      `\n[core]\n\tfsmonitor = ${fsmonitor}\n\thooksPath = ${hooks}\n`,
    );

    // A new commit on the remote, so the second turn's fetch has work.
    await writeFile(join(seed, "total.ts"), "export const vat = 0.25;\n");
    await gitIn(seed, "commit", "--quiet", "-am", "chore: bump");
    await gitIn(seed, "push", "--quiet", remote, "main");

    // Second turn: refresh runs `git fetch` then `git reset --hard` on the
    // host, in the clone that now names those programs.
    await tool.run(turn(workDir));

    // None of the planted programs ran.
    expect(existsSync(marker)).toBe(false);
  });
});
