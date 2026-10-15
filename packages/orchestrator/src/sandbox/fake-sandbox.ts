import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type ExecResult,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import { aiOfficeHeaders, toolCallScreenPath } from "@ai-office/shared";

import { withoutGitGuard } from "../git/command.ts";
import type { ToolCallScreens } from "./tool-call-screens.ts";

// A fake Sandcastle sandbox provider, for tests without Docker. It is a
// bind-mount provider whose "container" is the host: commands run with
// `sh` in the worktree, with only the environment the sandbox was given
// (plus PATH, without the app's guarded `git` as a container has its own
// Git, and a throwaway HOME of its own, so Sandcastle's `git config
// --global` stays out of the real one, and sandboxes running at once do
// not share one, as no two containers would). The agent tool (`claude …`, `codex …` or
// `opencode …`) is not run: a script stands in for it, printing the tool's
// stream (Claude Code's, unless it prints another's) and committing. As
// Claude Code does, the stand-in runs the `PreToolUse` hooks of the
// settings its command line gives (`--settings`) before each tool call it
// makes, its shell commands included, and makes no call a hook blocks.

/** What a fake agent can do inside the fake sandbox. */
export interface FakeAgentContext {
  /** The prompt the agent tool was given on its standard input. */
  readonly prompt: string;
  /** The agent tool's command line, as Sandcastle built it. */
  readonly command: string;
  /** Prints one line of the agent's stream (a Claude Code stream-json object). */
  readonly print: (line: object) => void;
  /**
   * Runs a shell command in the worktree, as the agent's Bash tool would:
   * after the `PreToolUse` hooks, and not at all when one blocks it.
   */
  readonly sh: (command: string) => Promise<ExecResult>;
  /**
   * Runs the `PreToolUse` hooks for a call of `tool` with `input`, as
   * Claude Code does before it runs it: why one blocks it, or undefined.
   */
  readonly preToolUse: (
    tool: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<string | undefined>;
  /** Resolves when the sandbox is torn down (killing the agent). */
  readonly killed: Promise<void>;
}

export type FakeAgent = (context: FakeAgentContext) => Promise<void>;

/** One sandbox the fake started. */
export interface FakeSandboxRecord {
  /** Exactly the environment the sandbox was started with. */
  readonly env: Readonly<Record<string, string>>;
  /** Every command run in it, in order. */
  readonly commands: string[];
  closed: boolean;
}

/** Claude Code's stream for a turn of text. */
export const say = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

/** Claude Code's stream for a Bash tool call. */
export const bash = (command: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }],
  },
});

/** Claude Code's stream for a tool call that changes a file. */
export const editFile = (
  name: "Edit" | "MultiEdit" | "Write",
  input: Readonly<Record<string, unknown>>,
) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id: "t2", name, input }],
  },
});

/** Claude Code's last line, with the session's usage. */
export const result = (usage: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}) => ({
  type: "result",
  subtype: "success",
  result: "Done.",
  usage: {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead ?? 0,
    cache_creation_input_tokens: usage.cacheWrite ?? 0,
  },
});

/** The agent tools' commands, which the fake agent stands in for. */
const agentToolCommands = ["claude ", "codex ", "opencode "];

/** The words of a command line, as `sh` splits them (quotes, not `$`). */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let at = 0; at < command.length; at += 1) {
    const char = command.charAt(at);
    if (char === "'") {
      const end = command.indexOf("'", at + 1);
      word = `${word ?? ""}${command.slice(at + 1, end === -1 ? undefined : end)}`;
      at = end === -1 ? command.length : end;
    } else if (char === '"') {
      let text = "";
      for (
        at += 1;
        at < command.length && command.charAt(at) !== '"';
        at += 1
      ) {
        if (command.charAt(at) === "\\") {
          at += 1;
        }
        text += command.charAt(at);
      }
      word = `${word ?? ""}${text}`;
    } else if (/\s/.test(char)) {
      if (word !== undefined) {
        words.push(word);
      }
      word = undefined;
    } else {
      word = `${word ?? ""}${char === "\\" ? command.charAt((at += 1)) : char}`;
    }
  }
  return word === undefined ? words : [...words, word];
}

/** The `PreToolUse` hooks' commands for `tool` in Claude Code's settings. */
function preToolUseHooks(settings: string | undefined, tool: string): string[] {
  if (settings === undefined) {
    return [];
  }
  const parsed = JSON.parse(settings) as {
    hooks?: {
      PreToolUse?: {
        matcher?: string;
        hooks?: { type?: string; command?: string }[];
      }[];
    };
  };
  return (parsed.hooks?.PreToolUse ?? [])
    .filter(
      ({ matcher }) =>
        matcher === undefined ||
        matcher === "" ||
        matcher === "*" ||
        new RegExp(`^(?:${matcher})$`).test(tool),
    )
    .flatMap(({ hooks }) => hooks ?? [])
    .flatMap(({ type, command }) =>
      type === "command" && command !== undefined ? [command] : [],
    );
}

/**
 * A stand-in for the AI Gateway's screen route (`toolCallScreenPath`), on
 * a port of its own: every request is the Agent `agentId`'s, as its key
 * would say on the Gateway. Its URL is the Gateway's for the sandbox.
 */
export async function serveToolCallScreens(
  screens: Pick<ToolCallScreens, "answer">,
  agentId: string,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== toolCallScreenPath) {
        response.writeHead(404).end();
        return;
      }
      const session = request.headers[aiOfficeHeaders.session];
      void screens
        .answer({
          agentId,
          session: typeof session === "string" ? session : null,
          body: JSON.parse(body) as unknown,
        })
        .then((answer) => {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(answer));
        });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface FakeSandbox {
  /** The provider to start sandboxes with `env` (as the runner asks). */
  provider(env: Readonly<Record<string, string>>): SandboxProvider;
  /** Every sandbox started, in order. */
  readonly sandboxes: FakeSandboxRecord[];
  /** What the agent does in the next sandboxes. */
  agent: FakeAgent;
  /** Environment the provider itself adds, as a real provider might. */
  providerEnv: Record<string, string>;
}

export function createFakeSandbox(
  agent: FakeAgent = () => Promise.resolve(),
): Promise<FakeSandbox> {
  const sandboxes: FakeSandboxRecord[] = [];
  const fake: FakeSandbox = {
    sandboxes,
    agent,
    providerEnv: {},
    provider: (env) =>
      createBindMountSandboxProvider({
        name: "fake",
        env: { ...env, ...fake.providerEnv },
        create: async (options) => {
          const home = await mkdtemp(join(tmpdir(), "ai-office-fake-home-"));
          const record: FakeSandboxRecord = {
            env: { ...options.env },
            commands: [],
            closed: false,
          };
          sandboxes.push(record);
          let kill = (): void => undefined;
          const killed = new Promise<void>((resolve) => {
            kill = resolve;
          });

          const sh = (
            command: string,
            cwd: string,
            onLine?: (line: string) => void,
            stdin?: string,
          ): Promise<ExecResult> =>
            new Promise((resolve) => {
              const child = spawn("sh", ["-c", command], {
                cwd,
                env: {
                  ...options.env,
                  PATH: withoutGitGuard(process.env["PATH"] ?? ""),
                  HOME: home,
                },
                stdio: [
                  stdin === undefined ? "ignore" : "pipe",
                  "pipe",
                  "pipe",
                ],
              });
              if (stdin !== undefined) {
                child.stdin?.end(stdin);
              }
              let stdout = "";
              let stderr = "";
              child.stdout?.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
              });
              child.stderr?.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
              });
              child.on("close", (code) => {
                for (const line of stdout.split("\n")) {
                  if (line !== "") {
                    onLine?.(line);
                  }
                }
                resolve({ stdout, stderr, exitCode: code ?? 1 });
              });
            });

          const handle: BindMountSandboxHandle = {
            worktreePath: options.worktreePath,
            async exec(command, execOptions) {
              record.commands.push(command);
              const cwd = execOptions?.cwd ?? options.worktreePath;
              if (!agentToolCommands.some((tool) => command.startsWith(tool))) {
                return sh(
                  command,
                  cwd,
                  execOptions?.onLine,
                  execOptions?.stdin,
                );
              }
              let stdout = "";
              const print = (line: object) => {
                const text = JSON.stringify(line);
                stdout += `${text}\n`;
                execOptions?.onLine?.(text);
              };
              const words = shellWords(command);
              const at = words.indexOf("--settings");
              const settings = at === -1 ? undefined : words[at + 1];
              const preToolUse = async (
                tool: string,
                input: Readonly<Record<string, unknown>>,
              ): Promise<string | undefined> => {
                for (const hook of preToolUseHooks(settings, tool)) {
                  const ran = await sh(
                    hook,
                    cwd,
                    undefined,
                    JSON.stringify({
                      hook_event_name: "PreToolUse",
                      tool_name: tool,
                      tool_input: input,
                    }),
                  );
                  if (ran.exitCode === 2) {
                    return ran.stderr.trim();
                  }
                  if (ran.exitCode === 0 && ran.stdout.trim().startsWith("{")) {
                    const answer = JSON.parse(ran.stdout) as {
                      hookSpecificOutput?: {
                        permissionDecision?: string;
                        permissionDecisionReason?: string;
                      };
                    };
                    const decided = answer.hookSpecificOutput;
                    if (decided?.permissionDecision === "deny") {
                      return decided.permissionDecisionReason ?? "denied";
                    }
                  }
                }
                return undefined;
              };
              await fake.agent({
                prompt: execOptions?.stdin ?? "",
                command,
                print,
                sh: async (shell) => {
                  const blocked = await preToolUse("Bash", { command: shell });
                  return blocked === undefined
                    ? sh(shell, cwd)
                    : { stdout: "", stderr: blocked, exitCode: 1 };
                },
                preToolUse,
                killed,
              });
              return { stdout, stderr: "", exitCode: record.closed ? 137 : 0 };
            },
            copyFileIn: () => Promise.resolve(),
            copyFileOut: () => Promise.resolve(),
            close: async () => {
              record.closed = true;
              kill();
              await rm(home, { recursive: true, force: true });
            },
          };
          return handle;
        },
      }),
  };
  return Promise.resolve(fake);
}
