import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  gatewayModelEnvironment,
  codexModelEnvironment,
} from "../sandbox/environment.ts";
import {
  claudeAllowedTools,
  claudeDisallowedTools,
  claudeSessionArgs,
  claudeSessionTools,
  codexSessionArgs,
  type SessionCommand,
} from "./agent-tool-session.ts";
import {
  gitArguments,
  gitToolEnvironment,
  repositoryToolDefinitions,
  runRepositoryTool,
} from "../manager/repository-tools.ts";

// P2 (issue #205), H18. The Manager chat's agent session is meant to be
// read-only: it reads and searches a read-only clone, reads the history
// with `git log`, `git show` and `git diff`, and the web. "Read-only" is
// enforced by the tool flags (`agent-tool-session.ts`): Claude Code is
// allowed `Bash(git log:*)`, `Bash(git show:*)` and `Bash(git diff:*)`.
//
// These probes show the allow-rule bounds the command's *prefix*, not what
// git then does: a command that begins `git diff` passes the rule yet, with
// `--no-index`, reads any file in the container (the Manager's Gateway Key
// at `/proc/self/environ`, the whole read-only clone), and, with
// `--output`, writes any file the container's filesystem lets it. Beside
// each allowed tool is `WebFetch`, which sends anywhere. The read-only
// clone mount stops writes *to the clone*; it stops neither of these.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/P2.md.
//
// Fixed (P2-1, issue #239): the session has no shell. Claude Code is given
// no `Bash` and refuses it; its file tools read only the clone and the
// turn's images, never `/proc`; the history is read through AI Office's
// repository tools (`manager/repository-tools.ts`), which run Git without
// a shell on the clone's objects alone. Codex's shell is turned off, and
// it reads through the same tools. The pins below are now regression
// tests that the old behaviour is gone.
//
// Fixed (P2-2, issue #241): with no shell, nothing the session may use
// writes. Claude Code refuses every tool that writes and any write to any
// path (`Edit(//**)`, which covers a redirect's target too); the
// repository tools take no option, and their Git commands write nothing,
// not even a lock; Codex runs read-only with no shell.

const exec = promisify(execFile);

const claude: SessionCommand = {
  model: "claude-opus-5-5",
  aiProvider: "Claude",
  effort: "high",
  system: "You are Joan, the Floor's Manager.",
  session: { resume: false, id: "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e" },
};

/**
 * Whether Claude Code's allow-rules permit `command`, as Claude Code
 * matches them: a `Bash(<prefix>:*)` rule permits a command whose text
 * begins with `<prefix>` at a word boundary. Plain `Bash` is not in the
 * allow-list; only the three `git` prefixes and the read tools are.
 */
function allowsBash(command: string): boolean {
  const trimmed = command.trimStart();
  for (const rule of claudeAllowedTools) {
    const match = /^Bash\((.+):\*\)$/.exec(rule);
    if (match === null) {
      continue;
    }
    const prefix = match[1] ?? "";
    if (
      trimmed === prefix ||
      trimmed.startsWith(`${prefix} `) ||
      trimmed.startsWith(`${prefix}\t`)
    ) {
      return true;
    }
  }
  return false;
}

describe("P2: the Manager session's Bash allow-rules are a prefix, not read-only git", () => {
  it("regression (P2-1): no Bash rule is allowed and no shell is given; only WebFetch still sends", () => {
    // Was: `Bash(git log:*)`, `Bash(git show:*)` and `Bash(git diff:*)`,
    // with unscoped `Read`, `Grep` and `Glob`.
    expect(
      claudeAllowedTools.filter((rule) => rule.startsWith("Bash")),
    ).toEqual([]);
    // Not offered at all: offered, Claude Code runs its own read-only
    // commands (`cat`, `grep`, read-only `git`) without asking.
    expect([...claudeSessionTools]).not.toContain("Bash");
    expect([...claudeDisallowedTools]).toContain("Bash");
    // Its file tools may read the clone and the turn's images, nowhere else.
    expect(
      claudeAllowedTools.filter((rule) => /^(Read|Grep|Glob)\b/.test(rule)),
    ).toEqual([
      "Read(//home/agent/workspace/**)",
      "Read(//home/agent/attachments/**)",
    ]);
    // A tool that reaches any host is still in the session (S2-1 is egress).
    expect([...claudeSessionTools]).toContain("WebFetch");
    const args = claudeSessionArgs(claude);
    expect(args).not.toContain("Bash(git diff:*)");
    expect(args.join(" ")).not.toMatch(/Bash\(/);
    expect(args).toContain("WebFetch");
  });

  it("regression (P2-1, P2-2): commands that read outside the clone and write files no longer pass the allow-rules", () => {
    // Each began `git diff`/`git log`, so each was permitted.
    expect(allowsBash("git diff --no-index /proc/self/environ /dev/null")).toBe(
      false,
    );
    expect(allowsBash("git diff --no-index /etc/passwd /dev/null")).toBe(false);
    expect(allowsBash("git diff --output=/home/agent/.claude/x -- .")).toBe(
      false,
    );
    expect(allowsBash("git log --output=/home/agent/.claude/x -1")).toBe(false);
  });

  // P2-1: the property that should hold — a permitted Bash command cannot
  // read a file outside the read-only clone.
  it("P2-1: no Bash command the session may run can read a file outside the clone", () => {
    // `git diff --no-index <path> <path>` reads any path and prints it,
    // and it begins `git diff`, so the allow-rule permitted it.
    expect(allowsBash("git diff --no-index /proc/self/environ /dev/null")).toBe(
      false,
    );
  });

  it("P2-1: no file tool may read the process's environment, the kernel's files or the tool's own state", () => {
    expect([...claudeDisallowedTools]).toEqual(
      expect.arrayContaining([
        "Read(//proc/**)",
        "Read(//sys/**)",
        "Read(//home/agent/.claude/**)",
      ]),
    );
    // No allow-rule names a path outside the clone and the turn's images.
    for (const rule of claudeAllowedTools) {
      const path = /^\w+\((.*)\)$/.exec(rule)?.[1];
      if (path !== undefined) {
        expect(path).toMatch(
          /^\/\/home\/agent\/(workspace|attachments)\/\*\*$/,
        );
      }
    }
  });

  // P2-2: the property that should hold — a permitted Bash command cannot
  // write a file. The shell P2-1 took away was its only way to; see P2-2's
  // own tests below.
  it("P2-2: no Bash command the session may run can write a file", () => {
    // `git diff --output=FILE` and `git log --output=FILE` both write, and
    // both began an allowed prefix.
    expect(allowsBash("git diff --output=/home/agent/.claude/evil -- .")).toBe(
      false,
    );
    expect(allowsBash("git log --output=/home/agent/.claude/evil -1")).toBe(
      false,
    );
  });

  it("P2-2: no tool the session may use writes a file, anywhere, the tool home included", () => {
    // No tool that writes is offered or allowed.
    for (const writes of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect([...claudeSessionTools]).not.toContain(writes);
      expect(
        claudeAllowedTools.filter((rule) => rule.startsWith(writes)),
      ).toEqual([]);
    }
    // Writing any path is refused, by every tool that writes and as a
    // redirect's target (`> file` is checked against Edit rules).
    expect([...claudeDisallowedTools]).toEqual(
      expect.arrayContaining(["Edit", "Write", "Edit(//**)", "Bash"]),
    );
    // Codex: read-only, with no shell.
    const codexArgs = codexSessionArgs(claude, "http://app:3047/v1");
    expect(codexArgs.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(codexArgs).toContain("features.shell_tool=false");
  });

  it("P2-2: no repository tool can be given an option, and none of their Git commands is one that writes", () => {
    for (const { name } of repositoryToolDefinitions) {
      for (const key of ["revision", "from", "to", "path", "pattern"]) {
        for (const value of [
          "--output=/home/agent/.claude/evil",
          "-o/home/agent/.claude/evil",
          "--open-files-in-pager=sh",
        ]) {
          let args: string[] | undefined;
          try {
            args = gitArguments(name, {
              ...(name === "git_show" ? { revision: "HEAD" } : {}),
              ...(name === "git_diff" ? { from: "HEAD~1" } : {}),
              ...(name === "search" ? { pattern: "x" } : {}),
              ...(name === "read_file" ? { path: "a.ts" } : {}),
              [key]: value,
            });
          } catch {
            continue;
          }
          // Only a search pattern may begin with `-`: it is given after
          // `-e`, as the pattern.
          expect(key).toBe("pattern");
          expect(args[args.indexOf(value) - 1]).toBe("-e");
        }
      }
    }
  });
});

describe("P2-1/P2-2: real git honours those options (the effect is not theoretical)", () => {
  it("regression (P2-1): git diff --no-index still prints a file outside the repository, but the session's tools cannot ask for it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p2-noindex-"));
    try {
      const repo = join(dir, "repo");
      const outside = join(dir, "outside.secret");
      await exec("git", ["init", "-q", repo]);
      await writeFile(outside, "AI-OFFICE-SECRET-VALUE\n");
      // Run from inside the clone, as the session's Bash would have.
      const { stdout } = await exec(
        "git",
        ["diff", "--no-index", outside, "/dev/null"],
        { cwd: repo },
        // git diff exits 1 when the files differ.
      ).catch((error: unknown) => ({
        stdout: (error as { stdout?: string }).stdout ?? "",
      }));
      // Git itself is unchanged: the outside file's content is in the diff.
      expect(stdout).toContain("AI-OFFICE-SECRET-VALUE");
      // The session has no shell to run that; each way its repository
      // tools could be asked for the file is refused before Git runs.
      for (const [name, input] of [
        ["git_diff", { from: "--no-index", to: outside }],
        ["git_diff", { from: "HEAD", path: outside }],
        ["git_diff", { from: "HEAD", path: "../outside.secret" }],
        ["read_file", { path: outside }],
        ["read_file", { path: "../outside.secret" }],
      ] as const) {
        await expect(runRepositoryTool(name, input, repo)).rejects.toThrow();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("regression (P2-2): git diff --output still writes a file, but the session's tools cannot ask for it, and running them writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p2-output-"));
    try {
      const repo = join(dir, "repo");
      await exec("git", ["init", "-q", repo]);
      await exec("git", ["config", "user.email", "a@b.c"], { cwd: repo });
      await exec("git", ["config", "user.name", "t"], { cwd: repo });
      await writeFile(join(repo, "f.txt"), "one\n");
      await exec("git", ["add", "f.txt"], { cwd: repo });
      await exec("git", ["commit", "-qm", "init"], { cwd: repo });
      await writeFile(join(repo, "f.txt"), "one\ntwo\n");
      await exec("git", ["commit", "-qam", "two"], { cwd: repo });
      const written = join(dir, "written-by-session.txt");
      await exec("git", ["diff", `--output=${written}`, "HEAD~1", "--"], {
        cwd: repo,
      });
      const body = await readFile(written, "utf8");
      // Git itself is unchanged: `--output` writes the file.
      expect(body).toContain("+two");
      await rm(written);

      // The session's tools refuse it before Git runs.
      const evil = join(dir, "evil");
      for (const [name, input] of [
        ["git_diff", { from: `--output=${evil}` }],
        ["git_diff", { from: "HEAD~1", to: `--output=${evil}` }],
        ["git_log", { revision: `--output=${evil}` }],
        ["git_show", { revision: `--output=${evil}` }],
      ] as const) {
        await expect(runRepositoryTool(name, input, repo)).rejects.toThrow();
      }
      // And every tool, run, leaves every file as it was: nothing new,
      // nothing changed, not even the index.
      const snapshot = async () => {
        const files = await readdir(dir, { recursive: true });
        return Promise.all(
          files.sort().map(async (file) => {
            const { size, mtimeMs } = await stat(join(dir, file));
            return `${file} ${String(size)} ${String(mtimeMs)}`;
          }),
        );
      };
      const before = await snapshot();
      await runRepositoryTool("read_file", { path: "f.txt" }, repo);
      await runRepositoryTool("list_files", {}, repo);
      await runRepositoryTool("search", { pattern: "two" }, repo);
      await runRepositoryTool("git_log", {}, repo);
      await runRepositoryTool("git_show", { revision: "HEAD" }, repo);
      await runRepositoryTool("git_diff", { from: "HEAD~1" }, repo);
      expect(await snapshot()).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("P2-1: the Manager's Gateway Key is in the session container's environment", () => {
  const access = {
    url: "http://app:3047",
    key: "aio_gk_0123456789abcdefABCDEF",
  };

  it("regression (P2-1): Claude Code's env carries the Gateway Key, which it needs, but nothing the session runs can read /proc/self/environ", () => {
    const env = gatewayModelEnvironment(access, { session: "manager-chat:1" });
    // The tool reaches the Gateway with it, so it is still there.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(access.key);
    expect(env.ANTHROPIC_BASE_URL).toBe(access.url);
    // Was readable with `git diff --no-index /proc/self/environ /dev/null`:
    // no shell, the file tools refuse `/proc`, and the repository tools
    // run Git with none of the tool's environment.
    expect([...claudeSessionTools]).not.toContain("Bash");
    expect([...claudeDisallowedTools]).toContain("Read(//proc/**)");
    expect(Object.values(gitToolEnvironment)).not.toContain(access.key);
    expect(Object.keys(gitToolEnvironment)).not.toContain(
      "ANTHROPIC_AUTH_TOKEN",
    );
  });

  it("regression (P2-1): Codex's env carries the Gateway Key too, and Codex has no shell to read it with", () => {
    const env = codexModelEnvironment(access, { session: "manager-chat:1" });
    expect(env["AI_OFFICE_GATEWAY_KEY"]).toBe(access.key);
    const args = codexSessionArgs(claude, env["OPENAI_BASE_URL"] ?? "");
    // Read-only, as before; and now with no shell at all, which read-only
    // did not stop from reading (Codex's read-only sandbox reads anything).
    expect(args).toContain("read-only");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("features.unified_exec=false");
    expect(args).toContain('mcp_servers.repository.command="node"');
  });
});
