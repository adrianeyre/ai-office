// Contract tests for xAI (Grok) AI Accounts (PRD FR-35): the recorded
// answers in `fixtures/xai/` are replayed through a real Gateway serving
// from a real xAI API-key account. Requests in OpenAI's formats pass
// through unchanged to `api.x.ai/v1`, with the account's key as a bearer
// token; Claude Code's Messages are translated to Chat Completions; a
// Grok Model goes only to Grok accounts; and a rate-limited xAI account
// falls back to the next.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { readFixture, type Fixture } from "../fixtures.ts";
import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "../test-support.ts";

const folder = fileURLToPath(new URL("../../fixtures/xai/", import.meta.url));
const fixture = (name: string) => readFixture(`${folder}${name}`);

const encryptor = encryptorFromKey(Buffer.alloc(32, 43));
const xaiKey =
  "xai-contractTestKey0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
const otherXaiKey =
  "xai-contractTestKeyOther0123456789abcdefghijklmnopqrstuvwxyzABC";

// What each fixture is recorded as. A new fixture needs an entry here.
const expectations: Record<
  string,
  {
    endpoint: string;
    streamed: boolean;
    status: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadInputTokens: number | null;
  }
> = {
  "chat-completions.json": {
    endpoint: "chat_completions",
    streamed: false,
    status: 200,
    inputTokens: 32,
    outputTokens: 12,
    cacheReadInputTokens: 6,
  },
  "chat-completions-streaming.json": {
    endpoint: "chat_completions",
    streamed: true,
    status: 200,
    inputTokens: 14,
    outputTokens: 4,
    cacheReadInputTokens: 0,
  },
  "chat-completions-rate-limited.json": {
    endpoint: "chat_completions",
    streamed: false,
    status: 429,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
  },
  "responses.json": {
    endpoint: "responses",
    streamed: false,
    status: 200,
    inputTokens: 21,
    outputTokens: 7,
    cacheReadInputTokens: 0,
  },
};

const names = (await readdir(folder))
  .filter((name) => name.endsWith(".json"))
  .sort();

let gateway: RunningGateway | undefined;
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
});

/** AI Accounts, each answering with its fixture, in priority order. */
async function office(
  accounts: readonly {
    name: string;
    aiProvider: "Claude" | "Grok";
    answer: Fixture;
    credential: string;
  }[],
) {
  const requestLog = memoryRequestLog();
  const aiAccounts: AiAccounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
  });
  const upstreamOf: Record<string, FakeUpstream> = {};
  for (const [index, account] of accounts.entries()) {
    const upstream = await startFakeUpstream(replay(account.answer, 7));
    upstreams.push(upstream);
    upstreamOf[account.name] = upstream;
    await aiAccounts.add({
      name: account.name,
      aiProvider: account.aiProvider,
      accountType: "api_key",
      credential: account.credential,
      endpointUrl: upstream.url,
      priority: index + 1,
    });
  }
  gateway = await startGateway({ accounts: aiAccounts, requestLog });
  return { aiAccounts, requestLog, upstreamOf, url: gateway.url };
}

describe("the xAI fixtures", () => {
  it("each have an expectation, and each expectation a fixture", () => {
    expect(names).toEqual(Object.keys(expectations).sort());
  });

  it.each(names)(
    "%s passes through an xAI API key unchanged, with its usage recorded",
    async (name) => {
      const recorded = await fixture(name);
      const { requestLog, upstreamOf, url } = await office([
        {
          name: "xAI",
          aiProvider: "Grok",
          answer: recorded,
          credential: xaiKey,
        },
      ]);
      // One attempt: a 429 from the only account is sent on as it is.
      const response = await fetch(`${url}${recorded.request.path}`, {
        method: "POST",
        headers: {
          ...recorded.request.headers,
          authorization: `Bearer ${gatewayKey}`,
        },
        body: recorded.request.body,
      });
      expect(response.status).toBe(recorded.response.status);
      expect(await response.text()).toBe(recorded.response.body);

      const upstream = upstreamOf["xAI"];
      expect(upstream?.received).toHaveLength(1);
      const [received] = upstream?.received ?? [];
      // xAI's own API: the path under /v1, the very body, the key as a
      // bearer token and never the Gateway Key.
      expect(received?.url).toBe(recorded.request.path);
      expect(received?.body).toBe(recorded.request.body);
      expect(received?.headers.authorization).toBe(`Bearer ${xaiKey}`);
      expect(received?.headers["x-api-key"]).toBeUndefined();
      expect(JSON.stringify(received?.headers)).not.toContain(gatewayKey);

      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(1);
      });
      expect(requestLog.records[0]).toMatchObject({
        ...expectations[name],
        account: "xAI",
        model: "grok-4",
      });
    },
  );
});

describe("Grok AI Accounts", () => {
  it("serve Claude Code too, translated from Messages to Chat Completions", async () => {
    const recorded = await fixture("chat-completions.json");
    const { upstreamOf, url } = await office([
      { name: "xAI", aiProvider: "Grok", answer: recorded, credential: xaiKey },
    ]);
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.1.0 (external, cli)",
        "x-api-key": gatewayKey,
      },
      body: JSON.stringify({
        model: "grok-4",
        max_tokens: 256,
        messages: [{ role: "user", content: "Is this diff safe to merge?" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Yes: the change is covered by the new test." },
      ],
      usage: { input_tokens: 32, output_tokens: 12 },
    });
    expect(upstreamOf["xAI"]?.received[0]?.url).toBe("/v1/chat/completions");
  });

  it("serve only Grok Models, and Claude accounts only Claude Models", async () => {
    const chat = await fixture("chat-completions.json");
    const claudeAnswer: Fixture = {
      ...chat,
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"Claude here."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":3}}',
      },
    };
    // Claude first, so it would be chosen if the Model did not decide.
    const { upstreamOf, url } = await office([
      {
        name: "Claude",
        aiProvider: "Claude",
        answer: claudeAnswer,
        credential: "sk-ant-api03-claude-provider-routing-0123456789",
      },
      { name: "xAI", aiProvider: "Grok", answer: chat, credential: xaiKey },
    ]);
    const ask = (model: string) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${gatewayKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Hi" }],
        }),
      }).then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }));
    expect((await ask("grok-4")).status).toBe(200);
    expect(upstreamOf["xAI"]?.received).toHaveLength(1);
    expect(upstreamOf["Claude"]?.received).toHaveLength(0);
    expect((await ask("claude-sonnet-5-5")).status).toBe(200);
    expect(upstreamOf["Claude"]?.received).toHaveLength(1);
    expect(upstreamOf["xAI"]?.received).toHaveLength(1);
    // A Gemini Model has no account here.
    const gemini = await ask("gemini-2.5-pro");
    expect(gemini.status).toBe(503);
  });

  it("fall back from a rate-limited xAI account to the next, held back until the reset", async () => {
    const limited = await fixture("chat-completions-rate-limited.json");
    const chat = await fixture("chat-completions.json");
    const { aiAccounts, upstreamOf, url } = await office([
      { name: "xAI", aiProvider: "Grok", answer: limited, credential: xaiKey },
      {
        name: "xAI spare",
        aiProvider: "Grok",
        answer: chat,
        credential: otherXaiKey,
      },
    ]);
    const before = Date.now();
    const response = await fetch(`${url}${chat.request.path}`, {
      method: "POST",
      headers: {
        ...chat.request.headers,
        authorization: `Bearer ${gatewayKey}`,
      },
      body: chat.request.body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(chat.response.body);
    expect(upstreamOf["xAI"]?.received).toHaveLength(1);
    expect(upstreamOf["xAI spare"]?.received).toHaveLength(1);
    const [first] = await aiAccounts.list();
    expect(first?.limitReason).toBe("rate_limited");
    // The requests limit, the one with nothing left, resets in 45 s.
    const until = first?.limitedUntil?.getTime() ?? 0;
    expect(until - before).toBeGreaterThanOrEqual(44_000);
    expect(until - Date.now()).toBeLessThanOrEqual(45_000);
  });
});
