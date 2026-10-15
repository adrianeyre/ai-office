import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentToolModelClient,
  callingToolOf,
  conversationPrompt,
  dockerToolRunner,
  toolFailure,
  withAgentToolFallback,
  type ToolRun,
} from "./agent-tool-client.ts";
import { ModelCallError, type ModelClient } from "./client.ts";

const gatewayKey = "aio_gk_0123456789abcdefghij";

/** A runner that records each run and answers with `lines`. */
function fakeRunner(lines: readonly string[]) {
  const runs: ToolRun[] = [];
  return {
    runs,
    async *run(run: ToolRun) {
      runs.push(run);
      await Promise.resolve();
      yield* lines;
    },
  };
}

const request = (model: string) => ({
  agentId: "joan",
  model,
  system: "You are Joan, the Floor's Manager.",
  messages: [
    { role: "user" as const, content: "What is in progress?" },
    { role: "assistant" as const, content: "Issue #3." },
    { role: "user" as const, content: "And next?" },
  ],
  maxTokens: 1024,
  issue: 3,
});

describe("calls made through an agent tool", () => {
  it("names the tool for each AI Provider's Models, Claude Code and Codex only", () => {
    expect(callingToolOf("claude-opus-5-5")).toBe("Claude Code");
    expect(callingToolOf("gpt-5.5")).toBe("Codex");
    expect(callingToolOf("grok-4")).toBeUndefined();
  });

  it("puts the earlier turns before the one to answer", () => {
    expect(conversationPrompt([{ role: "user", content: "Hi" }])).toBe("Hi");
    expect(conversationPrompt(request("x").messages)).toBe(
      "The conversation so far:\n<user>\nWhat is in progress?\n</user>\n<you>\nIssue #3.\n</you>\n\nAnswer this, the latest message:\nAnd next?",
    );
  });

  it("runs Claude Code once, through the Gateway with the Agent's key, streaming its text", async () => {
    const runner = fakeRunner([
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Issue " },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "#4." },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Issue #4.",
      }),
    ]);
    const client = agentToolModelClient({
      gateway: (agentId) =>
        Promise.resolve(
          agentId === "joan"
            ? { url: "http://app:3047", key: gatewayKey }
            : undefined,
        ),
      run: (run) => runner.run(run),
    });
    const pieces: string[] = [];
    const reply = await client.stream(request("claude-opus-5-5"), {
      onText: (text) => pieces.push(text),
    });
    expect(reply).toEqual({ text: "Issue #4.", stopReason: "end_turn" });
    expect(pieces).toEqual(["Issue ", "#4."]);
    const [run] = runner.runs;
    expect(run?.tool).toBe("Claude Code");
    expect(run?.image).toMatch(/^ai-office\/sandbox-claude:/);
    expect(run?.args).toEqual(
      expect.arrayContaining([
        "--print",
        "--model",
        "claude-opus-5-5",
        "--system-prompt",
        "You are Joan, the Floor's Manager.",
      ]),
    );
    expect(run?.environment).toMatchObject({
      ANTHROPIC_BASE_URL: "http://app:3047",
      ANTHROPIC_AUTH_TOKEN: gatewayKey,
    });
    expect(run?.environment["ANTHROPIC_CUSTOM_HEADERS"]).toContain("3");
    // The key goes in the environment, never on the command line.
    expect(run?.args.join(" ")).not.toContain(gatewayKey);
  });

  it("runs Codex once, with the Gateway as its model provider", async () => {
    const runner = fakeRunner([
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Issue #4." },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ]);
    const client = agentToolModelClient({
      gateway: () =>
        Promise.resolve({ url: "http://app:3047", key: gatewayKey }),
      run: (run) => runner.run(run),
    });
    expect(await client.complete(request("gpt-5.5"))).toEqual({
      text: "Issue #4.",
      stopReason: "end_turn",
    });
    const [run] = runner.runs;
    expect(run?.tool).toBe("Codex");
    expect(run?.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(run?.args).toContain(
      'model_providers.ai_office.base_url="http://app:3047/v1"',
    );
    // With no shell (P2-1): a command could read the Gateway Key in its
    // environment.
    const config = run?.args.filter((_, index) => run.args[index - 1] === "-c");
    expect(config).toEqual(
      expect.arrayContaining([
        "features.shell_tool=false",
        "features.unified_exec=false",
      ]),
    );
    expect(run?.environment).toMatchObject({
      AI_OFFICE_GATEWAY_KEY: gatewayKey,
      AI_OFFICE_ISSUE: "3",
    });
    expect(run?.input.startsWith("You are Joan")).toBe(true);
  });

  it("G1-1: gives the tool the token of the work it opened for the call, in Claude Code's and Codex's headers, and closes it once the tool has run", async () => {
    const opened: { agentId: string; work: unknown; closed: boolean }[] = [];
    const runs: ToolRun[] = [];
    const client = agentToolModelClient({
      gateway: () =>
        Promise.resolve({ url: "http://app:3047", key: gatewayKey }),
      run: async function* (run) {
        runs.push(run);
        // Still open while the tool runs.
        expect(opened.at(-1)?.closed).toBe(false);
        await Promise.resolve();
        yield run.tool === "Claude Code"
          ? JSON.stringify({
              type: "result",
              subtype: "success",
              result: "Done.",
            })
          : JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "Done." },
            });
      },
      work: (agentId, work) => {
        const entry = { agentId, work, closed: false };
        opened.push(entry);
        return {
          token: `work-${String(opened.length)}`,
          close: () => {
            entry.closed = true;
          },
        };
      },
    });
    await client.complete(request("claude-opus-5-5"));
    await client.complete(request("gpt-5.5"));
    expect(opened).toEqual([
      { agentId: "joan", work: { issue: 3 }, closed: true },
      { agentId: "joan", work: { issue: 3 }, closed: true },
    ]);
    expect(runs[0]?.environment["ANTHROPIC_CUSTOM_HEADERS"]).toContain(
      "x-ai-office-work: work-1",
    );
    expect(runs[1]?.environment).toMatchObject({ AI_OFFICE_WORK: "work-2" });
    expect(runs[1]?.args).toContain(
      'model_providers.ai_office.env_http_headers={ "x-ai-office-issue" = "AI_OFFICE_ISSUE", "x-ai-office-pull-request" = "AI_OFFICE_PULL_REQUEST", "x-ai-office-session" = "AI_OFFICE_SESSION", "x-ai-office-work" = "AI_OFFICE_WORK" }',
    );
  });

  it("G1-1: closes the work it opened when the tool fails", async () => {
    let closed = false;
    const client = agentToolModelClient({
      gateway: () =>
        Promise.resolve({ url: "http://app:3047", key: gatewayKey }),
      // eslint-disable-next-line require-yield
      run: async function* () {
        await Promise.resolve();
        throw new Error("docker run failed");
      },
      work: () => ({
        token: "work-1",
        close: () => {
          closed = true;
        },
      }),
    });
    await expect(client.complete(request("claude-opus-5-5"))).rejects.toThrow(
      "docker run failed",
    );
    expect(closed).toBe(true);
  });

  it("says why when the tool cannot answer", async () => {
    const client = agentToolModelClient({
      gateway: () =>
        Promise.resolve({ url: "http://app:3047", key: gatewayKey }),
      run: (run) =>
        fakeRunner([
          JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "Invalid API key",
          }),
        ]).run(run),
    });
    await expect(client.complete(request("claude-opus-5-5"))).rejects.toThrow(
      "Claude Code could not answer: Invalid API key",
    );
  });
});

describe("falling back to the agent tool", () => {
  const answering = (text: string): ModelClient => ({
    complete: () => Promise.resolve({ text, stopReason: "end_turn" }),
    stream: (_request, options) => {
      options.onText(text);
      return Promise.resolve({ text, stopReason: "end_turn" });
    },
  });
  const failing = (status: number, afterText = false): ModelClient => ({
    complete: () => Promise.reject(new ModelCallError(status, "No.")),
    stream: (_request, options) => {
      if (afterText) {
        options.onText("Half");
      }
      return Promise.reject(new ModelCallError(status, "No."));
    },
  });

  it("goes through the tool when the Gateway has no account to serve the call", async () => {
    const client = withAgentToolFallback(failing(503), answering("By tool."));
    expect((await client.complete(request("claude-opus-5-5"))).text).toBe(
      "By tool.",
    );
    const pieces: string[] = [];
    await client.stream(request("gpt-5.5"), {
      onText: (text) => pieces.push(text),
    });
    expect(pieces).toEqual(["By tool."]);
  });

  it("keeps the Gateway's answer, and its other errors", async () => {
    expect(
      (
        await withAgentToolFallback(
          answering("Direct."),
          answering("By tool."),
        ).complete(request("claude-opus-5-5"))
      ).text,
    ).toBe("Direct.");
    await expect(
      withAgentToolFallback(failing(429), answering("By tool.")).complete(
        request("claude-opus-5-5"),
      ),
    ).rejects.toThrow("No.");
    // Nor for a Model no tool here calls, nor once the answer has begun.
    await expect(
      withAgentToolFallback(failing(503), answering("By tool.")).complete(
        request("grok-4"),
      ),
    ).rejects.toThrow("No.");
    await expect(
      withAgentToolFallback(failing(503, true), answering("By tool.")).stream(
        request("claude-opus-5-5"),
        { onText: () => undefined },
      ),
    ).rejects.toThrow("No.");
  });
});

describe("why a tool's run failed", () => {
  it("says how to build a sandbox image that is not there", () => {
    expect(
      toolFailure(
        "Claude Code",
        "ai-office/sandbox-claude:6",
        125,
        "Unable to find image 'ai-office/sandbox-claude:6' locally\ndocker: Error response from daemon: pull access denied for ai-office/sandbox-claude, repository does not exist or may require 'docker login'\n\nRun 'docker run --help' for more information\n",
      ),
    ).toBe(
      "Claude Code could not start: its sandbox image ai-office/sandbox-claude:6 is not built. Build it with `pnpm sandbox:build claude`.",
    );
  });

  it("gives Docker's own reason when docker run fails, not its help line", () => {
    expect(
      toolFailure(
        "Codex",
        "ai-office/sandbox-codex:6",
        125,
        "docker: invalid mount config for type \"bind\": bind source path does not exist: /tmp/x\n\nRun 'docker run --help' for more information\n",
      ),
    ).toBe(
      'Codex failed (exit 125): docker: invalid mount config for type "bind": bind source path does not exist: /tmp/x',
    );
  });

  it("gives the tool's last line when the tool itself fails", () => {
    expect(
      toolFailure("Claude Code", "img", 1, "warming up\nInvalid API key\n"),
    ).toBe("Claude Code failed (exit 1): Invalid API key");
    expect(toolFailure("Codex", "img", 2, "")).toBe("Codex failed (exit 2).");
  });
});

describe("a run that never answers", () => {
  it.skipIf(process.platform === "win32")(
    "is stopped at its time limit, as an error the chat shows",
    async () => {
      // A stand-in `docker` that starts and never answers.
      const bin = await mkdtemp(join(tmpdir(), "ai-office-docker-"));
      const path = process.env["PATH"];
      try {
        await writeFile(join(bin, "docker"), "#!/bin/sh\nexec sleep 30\n");
        await chmod(join(bin, "docker"), 0o755);
        process.env["PATH"] = `${bin}:${path ?? ""}`;
        const run = dockerToolRunner({ timeoutMs: 1000 })({
          tool: "Codex",
          image: "ai-office/sandbox-codex:6",
          args: [],
          environment: {},
          input: "Hello",
        });
        const lines: string[] = [];
        await expect(
          (async () => {
            for await (const line of run) {
              lines.push(line);
            }
          })(),
        ).rejects.toThrow(
          "Codex did not answer within 1 second, so it was stopped.",
        );
        expect(lines).toEqual([]);
      } finally {
        process.env["PATH"] = path;
        await rm(bin, { recursive: true, force: true });
      }
    },
  );
});
