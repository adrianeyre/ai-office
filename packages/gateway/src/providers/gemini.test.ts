// Contract tests for Gemini AI Accounts (PRD FR-35): the recorded answers
// in `fixtures/gemini/` are replayed through a real Gateway serving from a
// real Gemini API-key account. Chat Completions pass through unchanged to
// Google's OpenAI-compatible API (`/v1beta/openai`), with the key as a
// bearer token; Claude Code's Messages are translated to Chat Completions;
// Responses, which that API lacks, go to no Gemini account; Google's 429
// and 503 hold the account back, and the request falls back.
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

const folder = fileURLToPath(
  new URL("../../fixtures/gemini/", import.meta.url),
);
const fixture = (name: string) => readFixture(`${folder}${name}`);

const encryptor = encryptorFromKey(Buffer.alloc(32, 44));
const geminiKey = "AIzaSyContractTestKey0123456789abcdefghi";
const otherGeminiKey = "AIzaSyContractTestKeyOther0123456789abcd";

/** Where callers send each fixture's request: the Gateway's own path. */
const callerPath = "/v1/chat/completions";

// What each fixture is recorded as. A new fixture needs an entry here.
const expectations: Record<
  string,
  {
    streamed: boolean;
    status: number;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }
> = {
  "chat-completions.json": {
    streamed: false,
    status: 200,
    model: "gemini-2.5-pro",
    inputTokens: 24,
    outputTokens: 11,
  },
  "chat-completions-streaming.json": {
    streamed: true,
    status: 200,
    model: "gemini-2.5-flash",
    inputTokens: 5,
    outputTokens: 3,
  },
  "chat-completions-rate-limited.json": {
    streamed: false,
    status: 429,
    model: "gemini-2.5-pro",
    inputTokens: null,
    outputTokens: null,
  },
  "chat-completions-overloaded.json": {
    streamed: false,
    status: 503,
    model: "gemini-2.5-pro",
    inputTokens: null,
    outputTokens: null,
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

/** Gemini accounts, each answering with its fixture, in priority order. */
async function office(
  accounts: readonly { name: string; answer: Fixture; credential: string }[],
  options: { saved?: Fixture[] } = {},
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
      aiProvider: "Gemini",
      accountType: "api_key",
      credential: account.credential,
      endpointUrl: upstream.url,
      priority: index + 1,
    });
  }
  const { saved } = options;
  gateway = await startGateway({
    accounts: aiAccounts,
    requestLog,
    ...(saved === undefined
      ? {}
      : {
          fixtureRecorder: {
            save: (recorded) => {
              saved.push(recorded);
              return Promise.resolve();
            },
          },
        }),
  });
  return { aiAccounts, requestLog, upstreamOf, url: gateway.url };
}

const post = (url: string, path: string, body: string) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewayKey}`,
    },
    body,
  }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  }));

describe("the Gemini fixtures", () => {
  it("each have an expectation, and each expectation a fixture", () => {
    expect(names).toEqual(Object.keys(expectations).sort());
  });

  it.each(names)(
    "%s passes through to Google's OpenAI-compatible API, with its usage recorded",
    async (name) => {
      const recorded = await fixture(name);
      const saved: Fixture[] = [];
      const { requestLog, upstreamOf, url } = await office(
        [{ name: "Gemini", answer: recorded, credential: geminiKey }],
        { saved },
      );
      const response = await fetch(`${url}${callerPath}`, {
        method: "POST",
        headers: {
          ...recorded.request.headers,
          authorization: `Bearer ${gatewayKey}`,
        },
        body: recorded.request.body,
      });
      expect(response.status).toBe(recorded.response.status);
      expect(await response.text()).toBe(recorded.response.body);

      const [received] = upstreamOf["Gemini"]?.received ?? [];
      expect(upstreamOf["Gemini"]?.received).toHaveLength(1);
      // Google's path, the very body, the key as a bearer token.
      expect(received?.url).toBe(recorded.request.path);
      expect(received?.body).toBe(recorded.request.body);
      expect(received?.headers.authorization).toBe(`Bearer ${geminiKey}`);
      expect(received?.headers["x-api-key"]).toBeUndefined();
      expect(JSON.stringify(received?.headers)).not.toContain(gatewayKey);

      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(1);
        expect(saved).toHaveLength(1);
      });
      expect(requestLog.records[0]).toMatchObject({
        ...expectations[name],
        endpoint: "chat_completions",
        account: "Gemini",
      });
      // Recorder mode saves the path as sent to Google.
      expect(saved[0]?.request.path).toBe(recorded.request.path);
    },
  );
});

describe("Gemini AI Accounts", () => {
  it("serve Claude Code too, translated from Messages to Chat Completions", async () => {
    const recorded = await fixture("chat-completions.json");
    const { upstreamOf, url } = await office([
      { name: "Gemini", answer: recorded, credential: geminiKey },
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
        model: "gemini-2.5-pro",
        max_tokens: 256,
        messages: [{ role: "user", content: "Summarise PR #14 in one line." }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      content: [
        {
          type: "text",
          text: "Adds retries and a circuit breaker to the AI Gateway.",
        },
      ],
      usage: { input_tokens: 24, output_tokens: 11 },
    });
    expect(upstreamOf["Gemini"]?.received[0]?.url).toBe(
      "/v1beta/openai/chat/completions",
    );
  });

  it("serve no Responses requests, which Google's API lacks", async () => {
    const recorded = await fixture("chat-completions.json");
    const { upstreamOf, url } = await office([
      { name: "Gemini", answer: recorded, credential: geminiKey },
    ]);
    const response = await post(
      url,
      "/v1/responses",
      JSON.stringify({ model: "gemini-2.5-pro", input: "Hi", store: false }),
    );
    expect(response.status).toBe(503);
    expect(upstreamOf["Gemini"]?.received).toHaveLength(0);
  });

  it.each([
    {
      name: "chat-completions-rate-limited.json",
      reason: "rate_limited",
      // RetryInfo's retryDelay.
      seconds: 23,
    },
    {
      name: "chat-completions-overloaded.json",
      reason: "overloaded",
      // Google gives no time: the default 30 seconds.
      seconds: 30,
    },
  ])(
    "fall back after Google's $reason answer, which holds the account back",
    async ({ name, reason, seconds }) => {
      const failure = await fixture(name);
      const served = await fixture("chat-completions.json");
      const { aiAccounts, upstreamOf, url } = await office([
        { name: "Gemini", answer: failure, credential: geminiKey },
        { name: "Gemini spare", answer: served, credential: otherGeminiKey },
      ]);
      const before = Date.now();
      const response = await post(url, callerPath, served.request.body);
      expect(response.status).toBe(200);
      expect(response.text).toBe(served.response.body);
      expect(upstreamOf["Gemini"]?.received).toHaveLength(1);
      expect(upstreamOf["Gemini spare"]?.received).toHaveLength(1);
      const [first] = await aiAccounts.list();
      expect(first?.limitReason).toBe(reason);
      const until = first?.limitedUntil?.getTime() ?? 0;
      expect(until - before).toBeGreaterThanOrEqual((seconds - 1) * 1000);
      expect(until - Date.now()).toBeLessThanOrEqual(seconds * 1000);
    },
  );
});
