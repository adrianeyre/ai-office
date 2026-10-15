import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createRedactor } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { directoryFixtureRecorder, readFixture } from "../fixtures.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type ReceivedRequest,
  type RunningGateway,
} from "../test-support.ts";
import { parseTarget, recordingOf } from "./record.ts";

// `pnpm --filter @ai-office/gateway record` (#45), run as the Owner runs
// it, against a real Gateway in recorder mode serving from real AI
// Accounts, each at a fake AI Provider.

const main = fileURLToPath(new URL("main.ts", import.meta.url));
const claudeKey = "sk-ant-api03-recordScriptClaudeKey0123456789abcdef";
const grokKey = "xai-recordScriptGrokKey0123456789abcdefghijklmnopqrstuvwxyzAB";

/** The credential an AI Provider was sent. */
const keyOf = (request: ReceivedRequest): string =>
  String(
    request.headers["x-api-key"] ??
      request.headers.authorization?.replace(/^Bearer /, ""),
  );

/**
 * An AI Provider careless enough to say back the key it was sent, in a
 * header and in its answer, so the recorder has something to redact.
 */
function answer(format: "messages" | "chat_completions") {
  return (
    request: ReceivedRequest,
    response: import("node:http").ServerResponse,
  ) => {
    const body = JSON.parse(request.body) as {
      stream?: boolean;
      tools?: unknown;
    };
    const key = keyOf(request);
    const headers = { "x-echoed-key": key };
    if (body.stream === true) {
      response.writeHead(200, {
        ...headers,
        "content-type": "text/event-stream",
      });
      response.end(
        format === "messages"
          ? 'event: message_start\ndata: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":12,"output_tokens":1}}}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          : 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"recorded"}}]}\n\n' +
              'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}\n\n' +
              "data: [DONE]\n\n",
      );
      return;
    }
    const tool = body.tools !== undefined;
    response.writeHead(200, { ...headers, "content-type": "application/json" });
    response.end(
      JSON.stringify(
        format === "messages"
          ? {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-haiku-5-5",
              content: tool
                ? [
                    {
                      type: "tool_use",
                      id: "toolu_1",
                      name: "get_weather",
                      input: { city: "Paris" },
                    },
                  ]
                : [{ type: "text", text: `recorded with ${key}` }],
              stop_reason: tool ? "tool_use" : "end_turn",
              usage: { input_tokens: 12, output_tokens: 2 },
            }
          : {
              id: "c1",
              object: "chat.completion",
              model: "grok-4",
              choices: [
                {
                  index: 0,
                  message: tool
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call_1",
                            type: "function",
                            function: {
                              name: "get_weather",
                              arguments: '{"city":"Paris"}',
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: `recorded with ${key}` },
                  finish_reason: tool ? "tool_calls" : "stop",
                },
              ],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 2,
                total_tokens: 14,
              },
            },
      ),
    );
  };
}

let directory: string;
let gateway: RunningGateway | undefined;
const upstreams: FakeUpstream[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gateway-record-"));
});

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
  await rm(directory, { recursive: true, force: true });
});

/**
 * A Gateway as the server starts it with `GATEWAY_FIXTURES_DIR`: its
 * recorder redacts with the redactor every AI Account's credential is
 * registered with as it is opened. It serves from a Claude API key and a
 * Grok API key.
 */
async function office() {
  const redactor = createRedactor({ secrets: [gatewayKey] });
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor: encryptorFromKey(Buffer.alloc(32, 45)),
    events: createEventBus({ store: memoryEventStore() }),
    onCredential: (credential) => {
      redactor.register(credential);
    },
  });
  const claude = await startFakeUpstream(answer("messages"));
  const grok = await startFakeUpstream(answer("chat_completions"));
  upstreams.push(claude, grok);
  await accounts.add({
    name: "Claude API key",
    aiProvider: "Claude",
    accountType: "api_key",
    credential: claudeKey,
    endpointUrl: claude.url,
    priority: 1,
  });
  await accounts.add({
    name: "Grok API key",
    aiProvider: "Grok",
    accountType: "api_key",
    credential: grokKey,
    endpointUrl: grok.url,
    priority: 2,
  });
  gateway = await startGateway({
    accounts,
    fixtureRecorder: directoryFixtureRecorder(directory, { redactor }),
  });
  return { url: gateway.url, claude, grok };
}

/** Runs the script as `pnpm … record` does, with only these variables. */
async function runRecord(url: string, args: readonly string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [main, ...args],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          AI_OFFICE_GATEWAY_URL: url,
          AI_OFFICE_GATEWAY_KEY: gatewayKey,
          GATEWAY_FIXTURES_DIR: directory,
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("pnpm --filter @ai-office/gateway record", () => {
  it("writes one fixture per scenario for each AI Provider, with credentials redacted", async () => {
    const { url, claude, grok } = await office();

    const run = await runRecord(url, [
      "--target",
      "Claude:claude-haiku-5-5",
      "--target",
      "Grok:grok-4",
      "--target",
      "ChatGPT:gpt-5.5",
      "--account",
      "Claude:Claude API key",
    ]);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // Four scenarios sent to each AI Provider with an API key, through its
    // own API: none to ChatGPT, whose subscriptions serve only Codex.
    expect(claude.received.map(({ url }) => url)).toEqual(
      Array(4).fill("/v1/messages"),
    );
    expect(grok.received.map(({ url }) => url)).toEqual(
      Array(4).fill("/v1/chat/completions"),
    );

    const files = (await readdir(directory)).sort();
    expect(files).toHaveLength(8);
    for (const name of files) {
      // Each file is named once in the summary, beside its scenario.
      expect(run.stdout.split(name)).toHaveLength(2);
      const text = await readFile(join(directory, name), "utf8");
      expect(text).not.toContain(claudeKey);
      expect(text).not.toContain(grokKey);
      expect(text).not.toContain(gatewayKey);
      const fixture = await readFixture(join(directory, name));
      expect(fixture.response.headers["x-echoed-key"]).toBe("[REDACTED]");
      expect(fixture.request.headers).not.toHaveProperty("authorization");
      expect(fixture.request.headers).not.toHaveProperty("x-api-key");
    }

    const lines = run.stdout.split("\n");
    const row = (target: string, scenario: string) => {
      const start = lines.indexOf(target);
      expect(start, target).toBeGreaterThan(-1);
      return (
        lines.slice(start).find((line) => line.startsWith(`  ${scenario} `)) ??
        ""
      );
    };
    const claudeTarget =
      "Claude · claude-haiku-5-5 (AI Account: Claude API key)";
    const fixtureOf = (target: string, scenario: string) =>
      /\S+\.json/.exec(row(target, scenario))?.[0] ?? "";
    for (const [target, endpoint, path] of [
      [claudeTarget, "messages", "/v1/messages"],
      ["Grok · grok-4", "chat-completions", "/v1/chat/completions"],
    ] as const) {
      for (const scenario of [
        "plain message",
        "streaming",
        "tool call",
        "image",
      ]) {
        expect(row(target, scenario)).toMatch(
          new RegExp(`recorded {2}200 {2}\\S+-${endpoint}-200\\.json$`),
        );
      }
      const body = async (scenario: string) =>
        JSON.parse(
          (await readFixture(join(directory, fixtureOf(target, scenario))))
            .request.body,
        ) as Record<string, unknown>;
      expect(
        (await readFixture(join(directory, fixtureOf(target, "plain message"))))
          .request.path,
      ).toBe(path);
      expect(await body("plain message")).not.toHaveProperty("stream");
      expect(await body("streaming")).toHaveProperty("stream", true);
      expect(await body("tool call")).toHaveProperty("tools");
      expect(JSON.stringify(await body("image"))).toContain("iVBORw0KGgo");
      // Why each is skipped is said once, below every target.
      expect(row(target, "rate limit")).toMatch(/skipped {2}\[1\]$/);
      expect(row(target, "token refresh")).toMatch(/skipped {2}\[2\]$/);
    }
    for (const scenario of [
      "plain message",
      "streaming",
      "tool call",
      "image",
    ]) {
      expect(row("ChatGPT · gpt-5.5", scenario)).toMatch(/skipped {2}\[3\]$/);
    }
    expect(lines).toContainEqual(
      expect.stringMatching(/^\[1\] no AI Provider gives a 429 on request/),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^\[2\] the AI Gateway refreshes a subscription's OAuth token itself/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^\[3\] a ChatGPT subscription serves only Codex's own requests/,
      ),
    );
    expect(run.stdout).toContain(
      "Claude's requests above went to its AI Accounts other than subscriptions, which serve only Claude Code.",
    );
    expect(run.stdout).toContain("8 fixtures written");
    expect(run.stdout).toContain("check by eye");
    expect(run.stdout).not.toContain(gatewayKey);
  });

  it("says why nothing was recorded when the Gateway answers itself", async () => {
    const { url, claude } = await office();

    const run = await runRecord(url, [
      "--target",
      "Claude:claude-haiku-5-5",
      "--account",
      "Claude:No such account",
      "--scenario",
      "plain",
    ]);

    expect(run.code).toBe(1);
    expect(claude.received).toHaveLength(0);
    expect(await readdir(directory)).toEqual([]);
    expect(run.stdout).toMatch(/plain message +failed {2}503\n/);
    expect(run.stdout).toContain(
      'no fixture was written; the answer said: The forced AI Account "No such account" does not exist. (what the AI Gateway refuses itself is never recorded)',
    );
    expect(run.stdout).not.toContain(gatewayKey);
  });

  it("refuses what it cannot record, without a request", async () => {
    const run = await runRecord("http://127.0.0.1:9", [
      "--target",
      "Grok:claude-haiku-5-5",
    ]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "The AI Gateway sends claude-haiku-5-5 to another AI Provider's accounts, not Grok's.",
    );
    expect(run.stderr).not.toContain(gatewayKey);
  });
});

describe("recordingOf", () => {
  it("speaks each AI Provider's own API, and none for a subscription alone", () => {
    expect(recordingOf("Claude")).toEqual({
      format: "messages",
      subscriptionTool: "Claude Code",
    });
    expect(recordingOf("Gemini")).toEqual({
      format: "chat_completions",
      subscriptionTool: null,
    });
    expect(recordingOf("ChatGPT")).toEqual({
      format: null,
      subscriptionTool: "Codex",
    });
    expect(parseTarget("ollama:llama3.2:3b")).toEqual({
      aiProvider: "Ollama",
      model: "llama3.2:3b",
    });
  });
});
