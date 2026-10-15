import {
  createRequestHistory,
  memoryRequestHistoryStore,
  type GatewayRequestRecord,
} from "@ai-office/gateway";
import type { DirectChatMessageRecord } from "@ai-office/orchestrator";
import { describe, expect, it } from "vitest";

import { testEncryptor } from "../test-support.ts";
import { directChatUsageOf } from "./usage.ts";

// A direct chat's Context Usage and serving AI Account, from the AI
// Gateway's request history: its latest answered call in the chat's own
// session, by the Agent or the Terminal's Owner tool.

const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 9, 0, second));

const record = (
  overrides: Partial<GatewayRequestRecord>,
): GatewayRequestRecord => ({
  startedAt: at(0),
  account: "Claude (work)",
  accountId: "acc-work",
  endpoint: "messages",
  model: "claude-opus-5-5",
  streamed: true,
  status: 200,
  latencyMs: 900,
  upstreamRequestId: null,
  gatewayKeyId: null,
  agentId: "bo",
  floorId: "web-shop",
  ownerTool: null,
  issue: null,
  pullRequest: null,
  session: "direct-chat",
  estimatedCostUsd: null,
  timeToFirstByteMs: null,
  requestHeaders: null,
  responseHeaders: null,
  inputTokens: 1_000,
  outputTokens: 300,
  cacheReadInputTokens: 19_000,
  cacheCreationInputTokens: 0,
  ...overrides,
});

const message = (
  id: number,
  kind: DirectChatMessageRecord["kind"],
  second: number,
): DirectChatMessageRecord => ({
  id,
  chat: "agent:bo",
  floorId: "web-shop",
  agentId: "bo",
  kind,
  text: "",
  replyTo: null,
  model: null,
  createdAt: at(second),
});

function setUp() {
  const history = createRequestHistory({
    store: memoryRequestHistoryStore(),
    encryptor: testEncryptor,
  });
  const windows: Record<string, number> = {
    "claude-opus-5-5": 200_000,
    "gpt-5.5": 400_000,
  };
  const asked: [string, string][] = [];
  const usageOf = directChatUsageOf({
    history,
    contextWindow: (aiProvider, model) => {
      asked.push([aiProvider, model]);
      return Promise.resolve(windows[model] ?? null);
    },
  });
  return { history, usageOf, asked };
}

const agent = { kind: "agent", floorId: "web-shop", agentId: "bo" } as const;
const claudeChat = { aiProvider: "Claude", models: [], messages: [] };

describe("directChatUsageOf", () => {
  it("is the chat's latest answered call: its whole prompt over its Model's window, and the account that served it", async () => {
    const { history, usageOf } = setUp();
    expect(await usageOf(agent, claudeChat)).toBeNull();

    await history.record(
      record({ startedAt: at(1), cacheReadInputTokens: 9_000 }),
    );
    await history.record(record({ startedAt: at(2), accountId: "acc-home" }));
    // Not the chat's: the Agent's sandbox, another Agent, a failed call
    // and a keep-alive.
    await history.record(
      record({ startedAt: at(3), session: "sbx-1", inputTokens: 150_000 }),
    );
    await history.record(record({ startedAt: at(4), agentId: "cy" }));
    await history.record(
      record({ startedAt: at(5), status: 529, inputTokens: null }),
    );
    await history.record(record({ startedAt: at(6), keepAlive: true }));

    expect(await usageOf(agent, claudeChat)).toEqual({
      model: "claude-opus-5-5",
      inputTokens: 20_000,
      contextWindow: 200_000,
      contextUsage: 0.1,
      aiAccountId: "acc-home",
      updatedAt: at(2).toISOString(),
    });
  });

  it("finds the Terminal's calls by its Owner tool, and the AI Provider of the Model it asked", async () => {
    const { history, usageOf, asked } = setUp();
    await history.record(
      record({
        agentId: null,
        floorId: null,
        ownerTool: "Terminal",
        model: "gpt-5.5",
        accountId: "acc-chatgpt",
        inputTokens: 100_000,
        cacheReadInputTokens: 0,
      }),
    );
    expect(
      await usageOf(
        { kind: "terminal" },
        {
          aiProvider: "Claude",
          models: [
            { aiProvider: "ChatGPT", model: "gpt-5.5" },
            { aiProvider: "Claude", model: "claude-opus-5-5" },
          ],
          messages: [],
        },
      ),
    ).toMatchObject({ contextUsage: 0.25, aiAccountId: "acc-chatgpt" });
    expect(asked).toEqual([["ChatGPT", "gpt-5.5"]]);
  });

  it("has none since a /clear, and an unknown share for a Model without a window", async () => {
    const { history, usageOf } = setUp();
    await history.record(record({ startedAt: at(1), model: "claude-haiku-9" }));
    expect(await usageOf(agent, claudeChat)).toMatchObject({
      model: "claude-haiku-9",
      contextWindow: null,
      contextUsage: null,
    });
    expect(
      await usageOf(agent, {
        ...claudeChat,
        messages: [message(1, "owner", 0), message(2, "clear", 2)],
      }),
    ).toBeNull();
  });
});
