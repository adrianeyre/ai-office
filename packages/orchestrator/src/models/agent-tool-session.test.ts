import { maxChatToolUses } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  claudeSessionArgs,
  claudeSessionEvent,
  codexSessionArgs,
  codexSessionEvent,
  readSessionTurn,
  type SessionCommand,
} from "./agent-tool-session.ts";
import { ModelCallError } from "./client.ts";

// The Manager chat's read-only agent session (PRD FR-24, ADR 0004), as
// Claude Code and Codex run it: the arguments of each turn, started or
// resumed, with only read-only tools, and what each tool writes, read into
// the answer's text, the tools it used and its session's id.

const claude: SessionCommand = {
  model: "claude-opus-5-5",
  aiProvider: "Claude",
  effort: "high",
  system: "You are Joan, the Floor's Manager.",
  session: { resume: false, id: "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e" },
};

const codex: SessionCommand = {
  model: "gpt-5.5",
  aiProvider: "ChatGPT",
  effort: "minimal",
  system: "You are Joan, the Floor's Manager.",
  session: { resume: false, id: null },
};

/** The values given after `flag`, up to the next flag. */
const after = (args: readonly string[], flag: string): string[] => {
  const start = args.indexOf(flag) + 1;
  const end = args.findIndex(
    (arg, index) => index >= start && arg.startsWith("-"),
  );
  return args.slice(start, end === -1 ? undefined : end);
};

const lines = async function* (...values: unknown[]) {
  await Promise.resolve();
  for (const value of values) {
    yield typeof value === "string" ? value : JSON.stringify(value);
  }
};

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "t", name, input }] },
});

describe("Claude Code's session arguments", () => {
  it("gives only read-only tools, denying everything not allowed", () => {
    const args = claudeSessionArgs(claude);
    expect(after(args, "--tools")).toEqual([
      "Read,Grep,Glob,WebSearch,WebFetch",
    ]);
    expect(after(args, "--allowedTools")).toEqual([
      "Read(//home/agent/workspace/**)",
      "Read(//home/agent/attachments/**)",
      "WebSearch",
      "WebFetch",
      "mcp__repository__git_log",
      "mcp__repository__git_show",
      "mcp__repository__git_diff",
    ]);
    expect(after(args, "--disallowedTools")).toEqual([
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "Edit(//**)",
      "Bash",
      "Read(//proc/**)",
      "Read(//sys/**)",
      "Read(//home/agent/.claude/**)",
    ]);
    expect(after(args, "--permission-mode")).toEqual(["dontAsk"]);
    // The repository's own settings and MCP servers are not read: its only
    // MCP server is AI Office's repository tools.
    expect(after(args, "--setting-sources")).toEqual(["user"]);
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(after(args, "--mcp-config")[0] ?? "")).toEqual({
      mcpServers: {
        repository: {
          type: "stdio",
          command: "node",
          args: [
            "/home/agent/ai-office/repository-tools.ts",
            "/home/agent/workspace",
          ],
        },
      },
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("uses the Manager's own Model and effort, and its instructions", () => {
    const args = claudeSessionArgs(claude);
    expect(after(args, "--model")).toEqual(["claude-opus-5-5"]);
    expect(after(args, "--effort")).toEqual(["high"]);
    expect(after(args, "--system-prompt")).toEqual([claude.system]);
    expect(claudeSessionArgs({ ...claude, effort: null })).not.toContain(
      "--effort",
    );
  });

  it("starts a session with its id on the first turn, and resumes it after", () => {
    const id = "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e";
    const first = claudeSessionArgs(claude);
    expect(after(first, "--session-id")).toEqual([id]);
    expect(first).not.toContain("--resume");
    const later = claudeSessionArgs({
      ...claude,
      session: { resume: true, id },
    });
    expect(after(later, "--resume")).toEqual([id]);
    expect(later).not.toContain("--session-id");
  });
});

describe("Codex's session arguments", () => {
  const baseUrl = "http://app:3047/v1";

  it("runs read-only, with live web search, through the Gateway", () => {
    const args = codexSessionArgs(codex, baseUrl);
    expect(args.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(args.at(-1)).toBe("-");
    const config = args.filter((_, index) => args[index - 1] === "-c");
    expect(config).toEqual(
      expect.arrayContaining([
        'sandbox_mode="read-only"',
        'approval_policy="never"',
        'web_search="live"',
        // No shell: the repository tools read the clone instead.
        "features.shell_tool=false",
        "features.unified_exec=false",
        'mcp_servers.repository.command="node"',
        'mcp_servers.repository.args=["/home/agent/ai-office/repository-tools.ts","/home/agent/workspace"]',
        'model_provider="ai_office"',
        `model_providers.ai_office.base_url="${baseUrl}"`,
        'model_reasoning_effort="minimal"',
      ]),
    );
    expect(after(args, "--model")).toEqual(["gpt-5.5"]);
    // Its instructions go with the first turn, on its standard input.
    expect(args.join(" ")).not.toContain(codex.system);
  });

  it("resumes the session by the id it named, still read-only", () => {
    const args = codexSessionArgs(
      { ...codex, session: { resume: true, id: "0199-thread" } },
      baseUrl,
    );
    expect(args.slice(0, 4)).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "resume",
    ]);
    expect(args.slice(-2)).toEqual(["0199-thread", "-"]);
    expect(args).toContain('sandbox_mode="read-only"');
  });

  it("reads no AGENTS.md from the clone as its instructions, started or resumed (P1-9)", () => {
    for (const args of [
      codexSessionArgs(codex, baseUrl),
      codexSessionArgs(
        { ...codex, session: { resume: true, id: "0199-thread" } },
        baseUrl,
      ),
    ]) {
      const config = args.filter((_, index) => args[index - 1] === "-c");
      expect(config).toContain("project_doc_max_bytes=0");
    }
  });
});

describe("reading a session's turn", () => {
  it("tells Claude Code's text as it is written, each tool it used, and its session", async () => {
    const pieces: string[] = [];
    const tools: unknown[] = [];
    const sessions: string[] = [];
    const reply = await readSessionTurn(
      "Claude Code",
      lines(
        { type: "system", subtype: "init", session_id: "s-1" },
        { type: "stream_event", event: { type: "message_start" } },
        delta("Let me look."),
        toolUse("Read", { file_path: "/home/agent/workspace/src/total.ts" }),
        toolUse("Grep", {
          pattern: "total",
          path: "/home/agent/workspace/src",
        }),
        toolUse("Glob", { pattern: "**/*.test.ts" }),
        toolUse("Bash", { command: "git log -5" }),
        toolUse("WebFetch", { url: "https://example.com/vat", prompt: "x" }),
        toolUse("WebSearch", { query: "UK VAT rate" }),
        { type: "stream_event", event: { type: "message_start" } },
        delta("Totals are "),
        delta("in src/total.ts."),
        {
          type: "result",
          subtype: "success",
          result: "Totals are in src/total.ts.",
          stop_reason: "end_turn",
        },
      ),
      {
        onText: (text) => pieces.push(text),
        onTool: (tool) => tools.push(tool),
        onSession: (id) => sessions.push(id),
      },
    );
    // The answer is the last message; the narration before is set apart.
    expect(reply).toEqual({
      text: "Totals are in src/total.ts.",
      stopReason: "end_turn",
    });
    expect(pieces.join("")).toBe("Let me look.\n\nTotals are in src/total.ts.");
    expect(tools).toEqual([
      { name: "Read", summary: "src/total.ts" },
      { name: "Grep", summary: '"total" in src' },
      { name: "Glob", summary: "**/*.test.ts" },
      { name: "Bash", summary: "git log -5" },
      { name: "WebFetch", summary: "https://example.com/vat" },
      { name: "WebSearch", summary: "UK VAT rate" },
    ]);
    expect(sessions).toEqual(["s-1"]);
  });

  it("lists at most the most tools one reply may", async () => {
    let told = 0;
    await readSessionTurn(
      "Claude Code",
      lines(
        ...Array.from({ length: maxChatToolUses + 5 }, () =>
          toolUse("Read", { file_path: "a.ts" }),
        ),
        { type: "result", subtype: "success", result: "Done." },
      ),
      {
        onText: () => undefined,
        onTool: () => (told += 1),
        onSession: () => undefined,
      },
    );
    expect(told).toBe(maxChatToolUses);
  });

  it("throws Claude Code's error, and a turn that ends without an answer", async () => {
    expect(() =>
      claudeSessionEvent(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "No conversation found",
        }),
      ),
    ).toThrow(
      new ModelCallError(
        502,
        "Claude Code could not answer: No conversation found",
      ),
    );
    await expect(
      readSessionTurn("Claude Code", lines(delta("Half")), {
        onText: () => undefined,
        onTool: () => undefined,
        onSession: () => undefined,
      }),
    ).rejects.toThrow("Claude Code ended without an answer.");
  });

  it("reads Codex's thread, its commands and searches, and its last message", async () => {
    const pieces: string[] = [];
    const tools: unknown[] = [];
    const sessions: string[] = [];
    const reply = await readSessionTurn(
      "Codex",
      lines(
        { type: "thread.started", thread_id: "0199-thread" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "i0", type: "agent_message", text: "Looking." },
        },
        {
          type: "item.completed",
          item: {
            id: "i1",
            type: "command_execution",
            command: "bash -lc 'rg -n total src'",
            exit_code: 0,
          },
        },
        {
          type: "item.completed",
          item: { id: "i2", type: "web_search", query: "UK VAT rate" },
        },
        {
          type: "item.completed",
          item: { id: "i3", type: "agent_message", text: "In src/total.ts." },
        },
        { type: "turn.completed", usage: {} },
      ),
      {
        onText: (text) => pieces.push(text),
        onTool: (tool) => tools.push(tool),
        onSession: (id) => sessions.push(id),
      },
    );
    expect(reply).toEqual({ text: "In src/total.ts.", stopReason: "end_turn" });
    expect(pieces.join("")).toBe("Looking.\n\nIn src/total.ts.");
    expect(tools).toEqual([
      { name: "Bash", summary: "rg -n total src" },
      { name: "WebSearch", summary: "UK VAT rate" },
    ]);
    expect(sessions).toEqual(["0199-thread"]);
  });

  it("throws Codex's failure", () => {
    expect(() =>
      codexSessionEvent(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "stream disconnected" },
        }),
      ),
    ).toThrow("Codex could not answer: stream disconnected");
  });
});
