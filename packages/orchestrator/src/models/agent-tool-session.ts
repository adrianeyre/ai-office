import {
  effortsOf,
  maxChatToolUses,
  type ManagerChatToolUse,
} from "@ai-office/shared";

import { codexRepositoryConfig } from "../sandbox/agent-tools.ts";
import {
  codexNoShellConfig,
  codexProviderConfig,
  type CallingTool,
} from "./agent-tool-client.ts";
import { ModelCallError, type ModelReply } from "./client.ts";

// The Manager chat's agent session (PRD FR-24, ADR 0004), as its agent
// tool runs it: Claude Code for Claude, Codex for ChatGPT (FR-16), in its
// sandbox image, on a read-only clone of the Floor's repository, with only
// read-only tools: reading, searching and listing files, `git log`, `git
// show` and `git diff`, web search and web fetch. A conversation is one
// session, started on its first turn and resumed on each turn after it by
// the tool's own session id. This file builds each tool's command and
// reads what it writes; `manager/chat-sessions.ts` runs them.
//
// The session has no shell (P2-1, P2-2): an allow-rule such as
// `Bash(git diff:*)` bounds a command's prefix, not what it does, and
// `git diff --no-index` read any file in the container (the Gateway Key at
// `/proc/self/environ`) while `git log --output` wrote one. The history,
// and for Codex the files too, are read through AI Office's own repository
// tools (`manager/repository-tools.ts`), an MCP server mounted read-only
// beside the clone, which runs Git without a shell on the clone's objects
// alone. Claude Code's own file tools read only the clone and the turn's
// images.

/** Where the clone is mounted, read-only, and the tool works. */
export const sessionWorkspace = "/home/agent/workspace";

/** Where the images the Owner attached to a turn are mounted, read-only. */
export const sessionAttachments = "/home/agent/attachments";

/**
 * Where a turn's `index`th image is, in the container: its name made safe
 * for a path, after its place.
 */
export function sessionImagePath(index: number, name: string): string {
  const safe = name
    .replaceAll(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(-100);
  return `${sessionAttachments}/${String(index + 1)}-${safe === "" ? "image" : safe}`;
}

/** Where each tool keeps its own state, and so its sessions. */
export const sessionToolHomes: Readonly<Record<CallingTool, string>> = {
  "Claude Code": "/home/agent/.claude",
  Codex: "/home/agent/.codex",
};

/** Where AI Office's repository tools are mounted, read-only. */
export const sessionRepositoryTools = "/home/agent/ai-office";

/** The repository tools' MCP server, as the session's agent tool names it. */
export const repositoryToolsServer = "repository";

/** How the agent tool starts the repository tools' MCP server. */
export const repositoryToolsCommand = {
  command: "node",
  args: [`${sessionRepositoryTools}/repository-tools.ts`, sessionWorkspace],
} as const;

/** The only tools Claude Code is given: no shell (P2-1, P2-2). */
export const claudeSessionTools = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
] as const;

/**
 * What Claude Code may use without asking: everything else is denied
 * (`dontAsk`). Its file tools read the clone, its working directory, and
 * the turn's images; anywhere else is asked about, so denied. The history
 * is read through the repository tools.
 */
export const claudeAllowedTools = [
  `Read(/${sessionWorkspace}/**)`,
  `Read(/${sessionAttachments}/**)`,
  "WebSearch",
  "WebFetch",
  `mcp__${repositoryToolsServer}__git_log`,
  `mcp__${repositoryToolsServer}__git_show`,
  `mcp__${repositoryToolsServer}__git_diff`,
] as const;

/**
 * What Claude Code refuses even if offered: its tools that write, and
 * writing any path at all (P2-2: an `Edit` rule covers every tool that
 * writes a file, and a redirect's target), a shell, and reading the
 * process's environment (where the Gateway Key is), the kernel's files
 * and its own state.
 */
export const claudeDisallowedTools = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Edit(//**)",
  "Bash",
  "Read(//proc/**)",
  "Read(//sys/**)",
  `Read(/${sessionToolHomes["Claude Code"]}/**)`,
] as const;

/** The repository tools, as Claude Code's `--mcp-config` takes them. */
export const claudeMcpConfig = JSON.stringify({
  mcpServers: {
    [repositoryToolsServer]: { type: "stdio", ...repositoryToolsCommand },
  },
});

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;

/** One turn of a session, as a tool's command needs it. */
export interface SessionCommand {
  readonly model: string;
  /** The Manager's AI Provider, whose efforts the tool may take. */
  readonly aiProvider: string;
  /** The Manager's effort; null (or one its tool takes not) for the default. */
  readonly effort: string | null;
  readonly system: string;
  /**
   * The session: started with `id` (Claude Code names its own), or by the
   * tool (Codex, `id` null); or resumed by `id`.
   */
  readonly session:
    | { readonly resume: false; readonly id: string | null }
    | { readonly resume: true; readonly id: string };
}

/** The effort, if the Manager's AI Provider takes it. */
const effortOf = (command: SessionCommand): string | undefined =>
  effortsOf(command.aiProvider).find((level) => level === command.effort);

/**
 * Claude Code's arguments for a turn, after `claude`. The prompt goes on
 * its standard input. Project and local settings are not read, so the
 * repository cannot widen what the session may do, and no MCP server is.
 */
export function claudeSessionArgs(command: SessionCommand): string[] {
  const effort = claudeEfforts.find((level) => level === effortOf(command));
  const { session } = command;
  return [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--model",
    command.model,
    ...(effort === undefined ? [] : ["--effort", effort]),
    "--system-prompt",
    command.system,
    "--tools",
    claudeSessionTools.join(","),
    "--allowedTools",
    ...claudeAllowedTools,
    "--disallowedTools",
    ...claudeDisallowedTools,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "user",
    "--mcp-config",
    claudeMcpConfig,
    "--strict-mcp-config",
    ...(session.resume
      ? ["--resume", session.id]
      : session.id === null
        ? []
        : ["--session-id", session.id]),
  ];
}

/**
 * Codex's arguments for a turn, after `codex`: read-only in its own
 * sandbox (said twice, as the option and as configuration, since `exec
 * resume` takes no `--sandbox`), with no shell and the repository tools in
 * its place, live web search, the Gateway at `baseUrl` as its model
 * provider, and the effort. The prompt goes on its standard input.
 */
export function codexSessionArgs(
  command: SessionCommand,
  baseUrl: string,
  /** The turn's images, in the container, shown with it. */
  images: readonly string[] = [],
): string[] {
  const effort = effortOf(command);
  const options = [
    ...images.flatMap((path) => ["--image", path]),
    "--json",
    "--skip-git-repo-check",
    "--model",
    command.model,
    ...[
      'sandbox_mode="read-only"',
      'approval_policy="never"',
      'web_search="live"',
      ...codexNoShellConfig,
      // The clone's AGENTS.md is not its instructions (P1-9).
      ...codexRepositoryConfig,
      `mcp_servers.${repositoryToolsServer}.command="${repositoryToolsCommand.command}"`,
      `mcp_servers.${repositoryToolsServer}.args=${JSON.stringify(repositoryToolsCommand.args)}`,
      ...codexProviderConfig(baseUrl),
      ...(effort === undefined ? [] : [`model_reasoning_effort="${effort}"`]),
    ].flatMap((value) => ["-c", value]),
  ];
  const { session } = command;
  return session.resume
    ? ["exec", "--sandbox", "read-only", "resume", ...options, session.id, "-"]
    : ["exec", "--sandbox", "read-only", ...options, "-"];
}

/** What one line a tool wrote holds. */
export interface SessionEvent {
  /** More of the answer's text. */
  readonly text?: string;
  /** A new message of the Manager's started: its text is set apart. */
  readonly messageStarted?: boolean;
  /** A whole message of the Manager's (Codex writes no pieces). */
  readonly message?: string;
  readonly tools?: readonly ManagerChatToolUse[];
  /** The tool's own id for the session. */
  readonly sessionId?: string;
  /** The turn ended: its answer, the last message. */
  readonly result?: ModelReply;
}

const parse = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** A path as the Owner knows it: within the repository, if it is. */
const repositoryPath = (path: string): string =>
  path === sessionWorkspace
    ? "."
    : path.startsWith(`${sessionWorkspace}/`)
      ? path.slice(sessionWorkspace.length + 1)
      : path;

/** One line, at most `length` characters. */
const line = (text: string, length: number): string => {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
};

/** A tool use, as the transcript shows it, collapsed. */
export function toolUse(name: string, summary: string): ManagerChatToolUse {
  return { name: line(name, 100) || "Tool", summary: line(summary, 500) };
}

/** What Claude Code used a tool on, in a line. */
export function claudeToolSummary(
  name: string,
  input: Readonly<Record<string, unknown>>,
): ManagerChatToolUse {
  const path = stringOf(input["path"]);
  const where = path === undefined ? "" : ` in ${repositoryPath(path)}`;
  switch (name) {
    case "Read":
      return toolUse(name, repositoryPath(stringOf(input["file_path"]) ?? ""));
    case "Grep":
      return toolUse(name, `"${stringOf(input["pattern"]) ?? ""}"${where}`);
    case "Glob":
      return toolUse(name, `${stringOf(input["pattern"]) ?? ""}${where}`);
    case "WebSearch":
      return toolUse(name, stringOf(input["query"]) ?? "");
    case "WebFetch":
      return toolUse(name, stringOf(input["url"]) ?? "");
    case "Bash":
      return toolUse(name, stringOf(input["command"]) ?? "");
    default:
      return name.startsWith(`mcp__${repositoryToolsServer}__`)
        ? repositoryToolSummary(
            name.slice(`mcp__${repositoryToolsServer}__`.length),
            input,
          )
        : toolUse(name, path === undefined ? "" : repositoryPath(path));
  }
}

/** What a repository tool was used on, in a line, such as "git log src/a.ts". */
export function repositoryToolSummary(
  tool: string,
  input: Readonly<Record<string, unknown>>,
): ManagerChatToolUse {
  const said = [
    stringOf(input["pattern"]) === undefined
      ? undefined
      : `"${stringOf(input["pattern"]) ?? ""}"`,
    stringOf(input["revision"]),
    stringOf(input["from"]),
    stringOf(input["to"]),
    stringOf(input["path"]),
  ].filter((part) => part !== undefined);
  return toolUse(tool.replace(/^git_/, "git "), said.join(" "));
}

/** Claude Code's `stream-json` line; a turn that failed is thrown. */
export function claudeSessionEvent(text: string): SessionEvent {
  const e = parse(text);
  if (e === undefined) {
    return {};
  }
  if (e["type"] === "system" && e["subtype"] === "init") {
    const id = stringOf(e["session_id"]);
    return id === undefined ? {} : { sessionId: id };
  }
  if (e["type"] === "stream_event") {
    const event = e["event"] as
      | { type?: unknown; delta?: { type?: unknown; text?: unknown } }
      | undefined;
    if (event?.type === "message_start") {
      return { messageStarted: true };
    }
    if (
      event?.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      typeof event.delta.text === "string"
    ) {
      return { text: event.delta.text };
    }
    return {};
  }
  if (e["type"] === "assistant") {
    const content = (e["message"] as { content?: unknown } | undefined)
      ?.content;
    const tools = (Array.isArray(content) ? content : [])
      .filter(
        (block): block is { type: "tool_use"; name: string; input?: unknown } =>
          (block as { type?: unknown }).type === "tool_use" &&
          typeof (block as { name?: unknown }).name === "string",
      )
      .map(({ name, input }) =>
        claudeToolSummary(
          name,
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : {},
        ),
      );
    return tools.length === 0 ? {} : { tools };
  }
  if (e["type"] === "result") {
    if (e["is_error"] === true || e["subtype"] !== "success") {
      const said = stringOf(e["result"]);
      throw new ModelCallError(
        502,
        `Claude Code could not answer${said === undefined ? "." : `: ${said}`}`,
      );
    }
    return {
      result: {
        text: typeof e["result"] === "string" ? e["result"] : "",
        stopReason: stringOf(e["stop_reason"]) ?? "end_turn",
      },
    };
  }
  return {};
}

/** A command as it was meant, without the shell Codex wraps it in. */
const unwrapped = (command: string): string =>
  /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(
    command.trim(),
  )?.[2] ?? command;

/** Codex's `exec --json` line; a turn that failed is thrown. */
export function codexSessionEvent(text: string): SessionEvent {
  const e = parse(text);
  if (e === undefined) {
    return {};
  }
  if (e["type"] === "thread.started") {
    const id = stringOf(e["thread_id"]);
    return id === undefined ? {} : { sessionId: id };
  }
  if (e["type"] === "item.completed") {
    const item = (e["item"] ?? {}) as Record<string, unknown>;
    switch (item["type"]) {
      case "agent_message": {
        const said = stringOf(item["text"]);
        return said === undefined ? {} : { message: said };
      }
      case "command_execution":
        return {
          tools: [toolUse("Bash", unwrapped(stringOf(item["command"]) ?? ""))],
        };
      case "web_search":
        return {
          tools: [toolUse("WebSearch", stringOf(item["query"]) ?? "")],
        };
      case "mcp_tool_call":
        return {
          tools: [
            item["server"] === repositoryToolsServer
              ? repositoryToolSummary(
                  stringOf(item["tool"]) ?? "",
                  typeof item["arguments"] === "object" &&
                    item["arguments"] !== null
                    ? (item["arguments"] as Record<string, unknown>)
                    : {},
                )
              : toolUse(
                  stringOf(item["tool"]) ?? "Tool",
                  stringOf(item["server"]) ?? "",
                ),
          ],
        };
      case "file_change": {
        const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
        return {
          tools: [
            toolUse(
              "Edit",
              changes
                .map((change) =>
                  repositoryPath(
                    stringOf((change as { path?: unknown }).path) ?? "",
                  ),
                )
                .join(", "),
            ),
          ],
        };
      }
      default:
        return {};
    }
  }
  if (e["type"] === "turn.failed" || e["type"] === "error") {
    const error = e["error"] as { message?: unknown } | undefined;
    const said = stringOf(error?.message) ?? stringOf(e["message"]);
    throw new ModelCallError(
      502,
      `Codex could not answer${said === undefined ? "." : `: ${said}`}`,
    );
  }
  if (e["type"] === "turn.completed") {
    return { result: { text: "", stopReason: "end_turn" } };
  }
  return {};
}

/** What a turn's lines are told to, as they are read. */
export interface SessionListeners {
  readonly onText: (text: string) => void;
  readonly onTool: (tool: ManagerChatToolUse) => void;
  readonly onSession: (id: string) => void;
}

/**
 * Reads a turn's lines: its text a piece at a time (each message after
 * the first set apart by a blank line), each tool it used (`maxChatToolUses`
 * at most), and the session's id. Answers the turn's last message, which
 * is its answer; narration before a tool is only told as it is written.
 */
export async function readSessionTurn(
  tool: CallingTool,
  lines: AsyncIterable<string>,
  listeners: SessionListeners,
): Promise<ModelReply> {
  const read = tool === "Claude Code" ? claudeSessionEvent : codexSessionEvent;
  /** Whether any of the answer was told yet. */
  const said = { any: false };
  let apart = false;
  let tools = 0;
  let last = "";
  let current = "";
  const tell = (text: string) => {
    if (text === "") {
      return;
    }
    if (apart && said.any) {
      listeners.onText("\n\n");
    }
    apart = false;
    said.any = true;
    listeners.onText(text);
  };
  for await (const each of lines) {
    const event = read(each);
    if (event.sessionId !== undefined) {
      listeners.onSession(event.sessionId);
    }
    if (event.messageStarted === true) {
      apart = true;
      current = "";
    }
    if (event.text !== undefined) {
      current += event.text;
      tell(event.text);
    }
    if (event.message !== undefined) {
      apart = true;
      last = event.message;
      tell(event.message);
    }
    for (const used of event.tools ?? []) {
      if (tools < maxChatToolUses) {
        tools += 1;
        listeners.onTool(used);
      }
    }
    if (event.result !== undefined) {
      const text =
        event.result.text !== ""
          ? event.result.text
          : tool === "Claude Code"
            ? current
            : last;
      if (!said.any && text !== "") {
        listeners.onText(text);
      }
      if (text === "") {
        throw new ModelCallError(502, `${tool} ended without an answer.`);
      }
      return { text, stopReason: event.result.stopReason };
    }
  }
  throw new ModelCallError(502, `${tool} ended without an answer.`);
}
