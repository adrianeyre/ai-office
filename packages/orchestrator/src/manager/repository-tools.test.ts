import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  gitArguments,
  gitToolEnvironment,
  repositoryToolDefinitions,
  RepositoryToolError,
  runRepositoryTool,
} from "./repository-tools.ts";

// The Manager chat session's repository tools (P2-1, P2-2): an MCP server
// AI Office mounts into the session's container in place of a shell. Each
// tool runs Git without a shell on the read-only clone's objects, with a
// revision or a path checked before it is passed. These run the real tools
// on a real repository, and the real server over its standard input and
// output, as Claude Code and Codex run it.

const exec = promisify(execFile);

let root: string;
let repo: string;
let first: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "repository-tools-"));
  repo = join(root, "repo");
  await writeFile(join(root, "outside.secret"), "OUTSIDE-SECRET\n");
  const git = (...args: string[]) =>
    exec(
      "git",
      ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
      { cwd: repo },
    );
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "total.ts"), "export const vat = 0.2;\n");
  // A symlink the repository holds, pointing out of it.
  await symlink(join(root, "outside.secret"), join(repo, "leak"));
  await git("add", ".");
  await git("commit", "-qm", "feat: VAT");
  first = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(repo, "total.ts"), "export const vat = 0.25;\n");
  await git("commit", "-qam", "fix: VAT is 25%");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the repository tools read the repository", () => {
  it("lists its tools: the files and the history, nothing that writes", () => {
    expect(repositoryToolDefinitions.map(({ name }) => name)).toEqual([
      "read_file",
      "list_files",
      "search",
      "git_log",
      "git_show",
      "git_diff",
    ]);
  });

  it("reads a file, lists the files and searches them", async () => {
    expect(
      await runRepositoryTool("read_file", { path: "total.ts" }, repo),
    ).toBe("export const vat = 0.25;\n");
    expect(
      await runRepositoryTool(
        "read_file",
        { path: "total.ts", revision: first },
        repo,
      ),
    ).toContain("0.2;");
    expect(await runRepositoryTool("list_files", {}, repo)).toBe(
      "leak\ntotal.ts\n",
    );
    expect(await runRepositoryTool("search", { pattern: "vat =" }, repo)).toBe(
      "total.ts:1:export const vat = 0.25;",
    );
    expect(
      await runRepositoryTool("search", { pattern: "nowhere" }, repo),
    ).toBe("No matches.");
  });

  it("reads the history: git log, git show and git diff", async () => {
    const log = await runRepositoryTool("git_log", { max_count: 5 }, repo);
    expect(log).toContain("fix: VAT is 25%");
    expect(log).toContain("feat: VAT");
    expect(
      await runRepositoryTool("git_show", { revision: "HEAD" }, repo),
    ).toContain("+export const vat = 0.25;");
    expect(
      await runRepositoryTool(
        "git_diff",
        { from: "HEAD~1", path: "total.ts" },
        repo,
      ),
    ).toContain("-export const vat = 0.2;");
    expect(
      await runRepositoryTool("git_log", { revision: `${first}..HEAD` }, repo),
    ).not.toContain("feat: VAT");
  });
});

describe("P2-1: no repository tool reads a file outside the repository", () => {
  it("reads a symlink as the link it is, never the file it points to", async () => {
    const read = await runRepositoryTool("read_file", { path: "leak" }, repo);
    expect(read).toBe(join(root, "outside.secret"));
    expect(read).not.toContain("OUTSIDE-SECRET");
    const searched = await runRepositoryTool(
      "search",
      { pattern: "OUTSIDE" },
      repo,
    );
    expect(searched).toBe("No matches.");
  });

  it.each([
    ["git_diff", { from: "/proc/self/environ" }],
    ["git_diff", { from: "--no-index" }],
    ["git_diff", { from: "HEAD", to: "../outside.secret" }],
    ["git_diff", { from: "HEAD", path: "/proc/self/environ" }],
    ["git_diff", { from: "HEAD", path: "../outside.secret" }],
    ["git_show", { revision: "HEAD:../outside.secret" }],
    ["git_show", { revision: "--output=/tmp/x" }],
    ["git_log", { revision: "--no-index" }],
    ["read_file", { path: "/proc/self/environ" }],
    ["read_file", { path: "../outside.secret" }],
    ["read_file", { path: "a/../../outside.secret" }],
    ["read_file", { path: "total.ts", revision: "-c" }],
    ["list_files", { path: "../" }],
    ["list_files", { path: "--output=x" }],
    ["search", { pattern: "x", path: "/etc" }],
  ])("refuses %s %j before Git runs", (name, input) => {
    expect(() => gitArguments(name, input)).toThrow(RepositoryToolError);
  });

  it("refuses what a tool does not take, and a tool there is not", () => {
    expect(() =>
      gitArguments("git_diff", { from: "HEAD", no_index: true }),
    ).toThrow('git_diff takes no "no_index"');
    expect(() => gitArguments("bash", { command: "cat /etc/passwd" })).toThrow(
      'There is no tool "bash"',
    );
  });

  it("always ends the revisions with `--`, so Git never compares two files", () => {
    // Without it, `git diff a b` compares two files, outside the
    // repository too, when they are not revisions.
    for (const [name, input] of [
      ["git_diff", { from: "HEAD~1" }],
      ["git_show", { revision: "HEAD" }],
      ["git_log", {}],
      ["list_files", {}],
      ["search", { pattern: "vat" }],
    ] as const) {
      expect(gitArguments(name, input)).toContain("--");
    }
    const diff = gitArguments("git_diff", { from: "HEAD~1", path: "total.ts" });
    expect(diff.slice(-3)).toEqual(["HEAD", "--", "total.ts"]);
    expect(diff).not.toContain("--no-index");
  });

  it("runs Git with an environment of its own: nothing of the tool's, no credential", () => {
    expect(Object.keys(gitToolEnvironment).sort()).toEqual([
      "GIT_ALLOW_PROTOCOL",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_EDITOR",
      "GIT_LITERAL_PATHSPECS",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
      "GIT_PAGER",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LC_ALL",
      "PAGER",
      "PATH",
    ]);
  });

  it("says why a revision is not one, as the tool's error", async () => {
    await expect(
      runRepositoryTool("git_show", { revision: "nowhere" }, repo),
    ).rejects.toThrow(RepositoryToolError);
  });
});

describe("the repository tools as an MCP server, over standard input and output", () => {
  /** Runs the server in the repository, sending `messages`, answering its lines. */
  const serve = (messages: readonly unknown[]): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      const server = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./repository-tools.ts", import.meta.url)),
          repo,
        ],
        {
          cwd: root,
          // As the agent tool starts it, with the Gateway Key in its
          // environment: none of it reaches Git.
          env: {
            PATH: process.env["PATH"] ?? "",
            ANTHROPIC_AUTH_TOKEN: "aio_gk_fakefakefakefakefake",
          },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      let out = "";
      server.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      server.on("error", reject);
      server.on("close", () => {
        resolve(
          out
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as unknown),
        );
      });
      server.stdin.end(
        messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
      );
    });

  it("answers initialize, lists its tools, and runs one in the clone it is given", async () => {
    const answers = await serve([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "git_log", arguments: { max_count: 1 } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "git_diff",
          arguments: { from: "--no-index", to: "/proc/self/environ" },
        },
      },
    ]);
    const byId = new Map(
      answers.map((answer) => [(answer as { id: number }).id, answer]),
    );
    expect(byId.get(1)).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-office-repository" },
      },
    });
    expect(
      (byId.get(2) as { result: { tools: { name: string }[] } }).result.tools,
    ).toHaveLength(6);
    expect(JSON.stringify(byId.get(3))).toContain("fix: VAT is 25%");
    expect(byId.get(4)).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(answers)).not.toContain("aio_gk_");
    // A notification has no answer.
    expect(answers).toHaveLength(4);
  });
});
