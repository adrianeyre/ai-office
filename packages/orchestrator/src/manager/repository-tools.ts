import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The Manager chat's session reads its Floor's repository through these
// tools, and nothing else (PRD FR-24, ADR 0004; P2-1, P2-2). A shell's
// allow-rules bound a command's prefix, not what the command then does:
// `git diff --no-index` read any file in the container, the Manager's
// Gateway Key included, and `git log --output` wrote one. So the session
// has no shell. AI Office mounts this file read-only into the session's
// container, and its agent tool runs it as an MCP server over standard
// input and output (`node repository-tools.ts <clone>`), which Claude Code and
// Codex both take: one JSON-RPC message per line.
//
// Each tool runs `git` without a shell, in the read-only clone, with
// arguments of AI Office's choosing: a revision or a path is checked
// before it is passed, and given only where Git takes one, after `--` for
// a path. Everything is read from the clone's objects at its default
// branch, never from its files, so a symlink in the repository is read as
// the link it is, and no path leaves the repository. Nothing is written:
// these Git commands write nothing, with no option that could. Git runs
// with an environment of its own, with nothing of the tool's (no Gateway
// Key), no configuration but the clone's own, which is AI Office's, and
// no program it could name.
//
// This file imports nothing but Node's own modules: in the container it is
// all there is.

/** Where the read-only clone is, in the session's container. */
export const repositoryDirectory = "/home/agent/workspace";

/** The most a tool answers, in characters: the rest is cut. */
export const maxToolOutput = 100_000;

/** The most commits `git_log` lists. */
const maxCommits = 100;

/** The most lines `search` answers. */
const maxMatches = 500;

/** A tool, as an MCP client is told of it. */
interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
  };
}

const pathProperty = {
  type: "string",
  description:
    "A path in the repository, relative to its root, such as src/checkout/total.ts.",
};

const revisionProperty = (description: string) => ({
  type: "string",
  description: `${description} A commit, branch or tag, such as HEAD~3, main or a commit hash.`,
});

/** The tools, in the order they are listed. */
export const repositoryToolDefinitions: readonly ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Reads one of the repository's files at its default branch (or at a revision).",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        revision: revisionProperty("Where to read it; HEAD if absent."),
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    description:
      "Lists the repository's files at its default branch, under a directory if given.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty },
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Searches the repository's files at its default branch for a regular expression (POSIX extended), under a path if given. Answers file:line:text.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "What to search for." },
        path: pathProperty,
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "git_log",
    description:
      "The history (git log): commits, newest first, with the files each changed; for a path, only the commits that changed it.",
    inputSchema: {
      type: "object",
      properties: {
        revision: revisionProperty(
          "Where to start; HEAD if absent. A range such as v1.2..HEAD is allowed.",
        ),
        path: pathProperty,
        max_count: {
          type: "integer",
          minimum: 1,
          maximum: maxCommits,
          description: `How many commits, at most ${String(maxCommits)}; 20 if absent.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_show",
    description:
      "One commit (git show): its message and its changes, only a path's if given.",
    inputSchema: {
      type: "object",
      properties: {
        revision: revisionProperty("The commit."),
        path: pathProperty,
      },
      required: ["revision"],
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description:
      "The changes between two revisions (git diff from to), only a path's if given.",
    inputSchema: {
      type: "object",
      properties: {
        from: revisionProperty("The older side."),
        to: revisionProperty("The newer side; HEAD if absent."),
        path: pathProperty,
      },
      required: ["from"],
      additionalProperties: false,
    },
  },
];

/** A tool's answer could not be given: said to the Model as the tool's error. */
export class RepositoryToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryToolError";
  }
}

/**
 * A revision as Git is given it: a name, a hash, `~`, `^`, `@{…}` and a
 * range, never an option (a leading `-`), a path (`:`) or anything a shell
 * or Git would read as more.
 */
const revisionShape =
  /^(?!-)(?!.*\.\.\.\.)[A-Za-z0-9][A-Za-z0-9._/@{}^~-]{0,199}$/;

function revisionOf(value: unknown, what: string, range = false): string {
  if (typeof value !== "string" || !revisionShape.test(value)) {
    throw new RepositoryToolError(
      `${what} is a commit, branch or tag, such as HEAD~3, main or a commit hash.`,
    );
  }
  if (!range && value.includes("..")) {
    throw new RepositoryToolError(`${what} is one revision, not a range.`);
  }
  return value;
}

/**
 * A path in the repository, from its root: never absolute, never with a
 * `.` or `..` segment, never empty, never starting with `-`. Git is given
 * it literally (`--literal-pathspecs`), after `--`.
 */
function pathOf(value: unknown): string {
  if (typeof value !== "string") {
    throw new RepositoryToolError("A path is text, such as src/index.ts.");
  }
  const path = value.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.startsWith("-") ||
    path.includes("\0") ||
    path.length > 1000 ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new RepositoryToolError(
      `"${value.slice(0, 200)}" is not a path in the repository: give it from the repository's root, without "..".`,
    );
  }
  return path;
}

const optional = <T>(
  value: unknown,
  read: (value: unknown) => T,
): T | undefined =>
  value === undefined || value === null ? undefined : read(value);

/**
 * Git's environment: nothing of the tool's, so no credential is in it; no
 * configuration but the repository's own; no pager, editor or prompt; and
 * no lock taken, so not even the index is written.
 */
export const gitToolEnvironment: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: ":",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ALLOW_PROTOCOL: "",
};

/** What Git is told before every command: nothing it reads may run a program. */
const gitOptions = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "log.showSignature=false",
];

/** What `git diff`, `show` and `log` are told: no external diff, no textconv, no colour. */
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color"];

/** The Git arguments of a tool's call, after `git`, checked; throws if they cannot be. */
export function gitArguments(
  name: string,
  input: Readonly<Record<string, unknown>>,
): string[] {
  const known = repositoryToolDefinitions.find((tool) => tool.name === name);
  if (known === undefined) {
    throw new RepositoryToolError(`There is no tool "${name}".`);
  }
  for (const key of Object.keys(input)) {
    if (!(key in known.inputSchema.properties)) {
      throw new RepositoryToolError(`${name} takes no "${key}".`);
    }
  }
  const path = optional(input["path"], pathOf);
  // Always `--`: what comes before it is a revision or nothing, so Git
  // never reads one as a file (`git diff a b` compares two files, even
  // outside the repository, when they are not revisions).
  const paths = path === undefined ? ["--"] : ["--", path];
  switch (name) {
    case "read_file": {
      const revision =
        optional(input["revision"], (value) => revisionOf(value, "revision")) ??
        "HEAD";
      if (path === undefined) {
        throw new RepositoryToolError("Give the file's path.");
      }
      return [...gitOptions, "show", "--no-textconv", `${revision}:${path}`];
    }
    case "list_files":
      return [
        ...gitOptions,
        "ls-tree",
        "-r",
        "--name-only",
        "--full-tree",
        "HEAD",
        ...paths,
      ];
    case "search": {
      const pattern = input["pattern"];
      if (
        typeof pattern !== "string" ||
        pattern === "" ||
        pattern.length > 1000 ||
        pattern.includes("\0")
      ) {
        throw new RepositoryToolError("Give a pattern to search for.");
      }
      return [
        ...gitOptions,
        "grep",
        "--no-color",
        "-n",
        "-I",
        "-E",
        "--full-name",
        ...(input["ignore_case"] === true ? ["-i"] : []),
        "-e",
        pattern,
        "HEAD",
        ...paths,
      ];
    }
    case "git_log": {
      const revision =
        optional(input["revision"], (value) =>
          revisionOf(value, "revision", true),
        ) ?? "HEAD";
      const count = input["max_count"] ?? 20;
      if (
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > maxCommits
      ) {
        throw new RepositoryToolError(
          `max_count is a whole number from 1 to ${String(maxCommits)}.`,
        );
      }
      return [
        ...gitOptions,
        "log",
        ...diffOptions,
        "--stat",
        "--format=commit %H%nAuthor: %an%nDate:   %aI%n%n%w(0,4,4)%B",
        `--max-count=${String(count)}`,
        revision,
        ...paths,
      ];
    }
    case "git_show":
      return [
        ...gitOptions,
        "show",
        ...diffOptions,
        "--format=fuller",
        revisionOf(input["revision"], "revision"),
        ...paths,
      ];
    case "git_diff":
      return [
        ...gitOptions,
        "diff",
        ...diffOptions,
        revisionOf(input["from"], "from"),
        optional(input["to"], (value) => revisionOf(value, "to")) ?? "HEAD",
        ...paths,
      ];
    default:
      throw new RepositoryToolError(`There is no tool "${name}".`);
  }
}

/** Runs a tool's Git command in `cwd`, answering what it wrote, cut to length. */
export function runRepositoryTool(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string = repositoryDirectory,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = gitArguments(name, input);
    execFile(
      "git",
      args,
      {
        cwd,
        env: gitToolEnvironment,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // `git grep` finding nothing exits 1, and says nothing.
        if (error !== null && !(name === "search" && error.code === 1)) {
          const said = stderr.trim().split("\n").at(-1) ?? "";
          reject(
            new RepositoryToolError(
              said === "" ? `${name} failed.` : said.replace(/^fatal: /, ""),
            ),
          );
          return;
        }
        let text = stdout;
        if (name === "search") {
          const lines = text.split("\n").filter((line) => line !== "");
          text = lines
            .slice(0, maxMatches)
            .map((line) => line.replace(/^HEAD:/, ""))
            .join("\n");
          if (lines.length > maxMatches) {
            text += `\n(${String(lines.length - maxMatches)} more matches left out.)`;
          }
          if (lines.length === 0) {
            text = "No matches.";
          }
        }
        resolve(
          text.length > maxToolOutput
            ? `${text.slice(0, maxToolOutput)}\n(The rest was left out: ${String(text.length - maxToolOutput)} more characters.)`
            : text,
        );
      },
    );
  });
}

/** One JSON-RPC message, as read. */
interface Message {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const protocolVersion = "2025-06-18";

/**
 * Answers one JSON-RPC message: undefined for a notification, which has
 * no answer.
 */
export async function answerMessage(
  message: Message,
  cwd: string = repositoryDirectory,
): Promise<Record<string, unknown> | undefined> {
  const id = message.id;
  if (id === undefined || id === null) {
    return undefined;
  }
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  switch (message.method) {
    case "initialize": {
      const asked = (
        message.params as { protocolVersion?: unknown } | undefined
      )?.protocolVersion;
      return result({
        protocolVersion: typeof asked === "string" ? asked : protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "ai-office-repository", version: "1.0.0" },
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: repositoryToolDefinitions });
    case "tools/call": {
      const params = (message.params ?? {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      const input =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const text = await runRepositoryTool(
          typeof params.name === "string" ? params.name : "",
          input,
          cwd,
        );
        return result({ content: [{ type: "text", text }] });
      } catch (error) {
        return result({
          content: [
            {
              type: "text",
              text:
                error instanceof RepositoryToolError
                  ? error.message
                  : "The tool failed.",
            },
          ],
          isError: true,
        });
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      };
  }
}

/** Serves the tools over `input` and `output`, one message per line. */
export async function serveRepositoryTools(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  cwd: string = repositoryDirectory,
): Promise<void> {
  const pending: Promise<void>[] = [];
  for await (const line of createInterface({ input })) {
    if (line.trim() === "") {
      continue;
    }
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }
    pending.push(
      answerMessage(message, cwd).then((answer) => {
        if (answer !== undefined) {
          output.write(`${JSON.stringify(answer)}\n`);
        }
      }),
    );
  }
  await Promise.all(pending);
}

// Run as `node repository-tools.ts <clone>`: the clone to read.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await serveRepositoryTools(
    process.stdin,
    process.stdout,
    process.argv[2] ?? repositoryDirectory,
  );
}
