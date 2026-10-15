// Contract tests for Anthropic-compatible endpoints (PRD FR-35): its
// fixtures, in `fixtures/anthropic-compatible/`, replayed through a real
// Gateway serving from a real endpoint whose URL the Owner gave with its
// own path (`…/anthropic`, as ANTHROPIC_BASE_URL is given), its answer in
// 7-byte chunks:
// - Claude Code's Messages pass through unchanged to `…/anthropic/v1/…`,
//   with the key both as `x-api-key` and as a bearer token (endpoints read
//   one or the other), never the Gateway Key; the caller gets the answer
//   byte for byte; the record has the status and tokens; recorder mode
//   saves the path as sent;
// - opencode's Chat Completions are translated to Messages;
// - it is sent any Model, and those no AI Provider claims before any other
//   account; it counts no tokens;
// - a 429 and a 529 fall back to a second endpoint, holding the first back;
// - its key is never listed and is known to be a credential, and an
//   endpoint added without one is sent no credential at all.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import type { AiAccountLimitReason } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { readFixture, type Fixture } from "../fixtures.ts";
import { memoryRequestLog, type GatewayRequestRecord } from "../request-log.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "../test-support.ts";

const folder = fileURLToPath(
  new URL("../../fixtures/anthropic-compatible/", import.meta.url),
);
const fixture = (name: string) => readFixture(`${folder}${name}`);
const encryptor = encryptorFromKey(Buffer.alloc(32, 46));
const key = "sk-litellm-0123456789abcdef0123456789abcdef";
const otherKey = "sk-litellm-fedcba9876543210fedcba9876543210";
const claudeKey = "sk-ant-api03-anthropicCompatibleClaude0123456789";
/** The path of the endpoint's URL, as the Owner gives it. */
const endpointPath = "/anthropic";

type Expected = Pick<
  GatewayRequestRecord,
  | "streamed"
  | "status"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadInputTokens"
  | "cacheCreationInputTokens"
>;

const unanswered = {
  streamed: false,
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
} as const;

// What each fixture is recorded as. A new fixture needs an entry here.
const expectations: Record<string, Expected> = {
  "messages.json": {
    streamed: false,
    status: 200,
    inputTokens: 512,
    outputTokens: 40,
    cacheReadInputTokens: 1536,
    cacheCreationInputTokens: 128,
  },
  "messages-streaming.json": {
    streamed: true,
    status: 200,
    inputTokens: 18,
    outputTokens: 4,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  "messages-rate-limited.json": { ...unanswered, status: 429 },
  "messages-overloaded.json": { ...unanswered, status: 529 },
};

// Each failure, and how it holds the endpoint back.
const failures: readonly {
  fixture: string;
  reason: AiAccountLimitReason;
  seconds: number;
}[] = [
  // For its retry-after.
  {
    fixture: "messages-rate-limited.json",
    reason: "rate_limited",
    seconds: 15,
  },
  // For the default half-minute.
  { fixture: "messages-overloaded.json", reason: "overloaded", seconds: 30 },
];

const modelOf = (recorded: Fixture): string =>
  (JSON.parse(recorded.request.body) as { model: string }).model;

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
    kind: "endpoint" | "claude";
    answer: Fixture;
    credential: string | null;
  }[],
  options: { saved?: Fixture[] } = {},
) {
  const requestLog = memoryRequestLog();
  const told: string[] = [];
  const aiAccounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    onCredential: (credential) => told.push(credential),
  });
  const upstreamOf: Record<string, FakeUpstream> = {};
  for (const [index, account] of accounts.entries()) {
    const upstream = await startFakeUpstream(replay(account.answer, 7));
    upstreams.push(upstream);
    upstreamOf[account.name] = upstream;
    await aiAccounts.add(
      account.kind === "endpoint"
        ? {
            name: account.name,
            aiProvider: "Anthropic-compatible",
            accountType: "endpoint",
            endpointUrl: `${upstream.url}${endpointPath}`,
            credential: account.credential,
            priority: index + 1,
          }
        : {
            name: account.name,
            aiProvider: "Claude",
            accountType: "api_key",
            endpointUrl: upstream.url,
            credential: account.credential ?? "",
            priority: index + 1,
          },
    );
  }
  const { saved } = options;
  gateway = await startGateway({
    accounts: aiAccounts,
    requestLog,
    sleep: () => Promise.resolve(),
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
  return { aiAccounts, requestLog, upstreamOf, told, url: gateway.url };
}

const alone = (
  answer: Fixture,
  options: { saved?: Fixture[]; credential?: string | null } = {},
) =>
  office(
    [
      {
        name: "Endpoint",
        kind: "endpoint",
        answer,
        credential: options.credential === undefined ? key : options.credential,
      },
    ],
    options,
  );

/** Sends a fixture's request to the Gateway, as Claude Code does. */
const send = (url: string, recorded: Fixture) =>
  fetch(
    `${url}/v1${recorded.request.path.slice(`${endpointPath}/v1`.length)}`,
    {
      method: "POST",
      headers: { ...recorded.request.headers, "x-api-key": gatewayKey },
      body: recorded.request.body,
    },
  );

/** Claude's own answer, for a Claude account. */
const claudeAnswer = (recorded: Fixture): Fixture => ({
  ...recorded,
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"Claude here."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":3}}',
  },
});

describe("the Anthropic-compatible fixtures", () => {
  it("each have an expectation, and each expectation a fixture", async () => {
    const names = (await readdir(folder))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(names).toEqual(Object.keys(expectations).sort());
  });

  it.each(Object.keys(expectations).sort())(
    "%s passes through unchanged to the endpoint's own path, with its usage recorded",
    async (name) => {
      const recorded = await fixture(name);
      const saved: Fixture[] = [];
      const { requestLog, upstreamOf, url } = await alone(recorded, { saved });
      const response = await send(url, recorded);
      expect(response.status).toBe(recorded.response.status);
      expect(await response.text()).toBe(recorded.response.body);

      const received = upstreamOf["Endpoint"]?.received ?? [];
      // A failure is tried as often as the Gateway tries; it holds the
      // endpoint back after the first.
      expect(received.length).toBeGreaterThanOrEqual(1);
      for (const request of received) {
        expect(request.url).toBe(recorded.request.path);
        expect(request.body).toBe(recorded.request.body);
        expect(request.headers["x-api-key"]).toBe(key);
        expect(request.headers.authorization).toBe(`Bearer ${key}`);
        expect(JSON.stringify(request.headers)).not.toContain(gatewayKey);
      }

      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(1);
        expect(saved).toHaveLength(1);
      });
      expect(requestLog.records[0]).toMatchObject({
        ...expectations[name],
        endpoint: "messages",
        account: "Endpoint",
        model: modelOf(recorded),
      });
      // Recorder mode saves the path as sent, and never the key.
      expect(saved[0]?.request.path).toBe(recorded.request.path);
      expect(JSON.stringify(saved[0])).not.toContain(key);
    },
  );
});

describe("Anthropic-compatible endpoints", () => {
  it("serve opencode too, translated from Chat Completions to Messages", async () => {
    const recorded = await fixture("messages.json");
    const { upstreamOf, url } = await alone(recorded);
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "opencode/1.2.0",
        authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify({
        model: modelOf(recorded),
        messages: [{ role: "user", content: "Summarise PR #14 in one line." }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Adds retries and a circuit breaker to the AI Gateway.",
          },
        },
      ],
    });
    const [received] = upstreamOf["Endpoint"]?.received ?? [];
    expect(received?.url).toBe(`${endpointPath}/v1/messages`);
    expect(received?.headers["x-api-key"]).toBe(key);
    expect(JSON.parse(received?.body ?? "{}")).toMatchObject({
      model: modelOf(recorded),
      messages: [{ role: "user" }],
    });
  });

  it("are sent any Model, and those no AI Provider claims before any other account", async () => {
    const recorded = await fixture("messages.json");
    // Claude first, so it would be chosen if the Model did not decide.
    const { upstreamOf, url } = await office([
      {
        name: "Claude",
        kind: "claude",
        answer: claudeAnswer(recorded),
        credential: claudeKey,
      },
      { name: "Endpoint", kind: "endpoint", answer: recorded, credential: key },
    ]);
    const ask = (model: string) =>
      fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": gatewayKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Hi" }],
        }),
      }).then(async (response) => {
        await response.body?.cancel();
        return response.status;
      });
    // One no AI Provider claims: the endpoint, though Claude comes first.
    expect(await ask("my-coder-model")).toBe(200);
    expect(upstreamOf["Endpoint"]?.received).toHaveLength(1);
    expect(upstreamOf["Claude"]?.received).toHaveLength(0);
    // A Claude Model: Claude, by priority.
    expect(await ask("claude-sonnet-5-5")).toBe(200);
    expect(upstreamOf["Claude"]?.received).toHaveLength(1);
    // Z.ai's, which no Z.ai account here serves: the endpoint.
    expect(await ask("glm-4.6")).toBe(200);
    expect(upstreamOf["Endpoint"]?.received).toHaveLength(2);
    expect(upstreamOf["Claude"]?.received).toHaveLength(1);
  });

  it("count no tokens, which few such endpoints can", async () => {
    const recorded = await fixture("messages.json");
    const { upstreamOf, url } = await alone(recorded);
    const counted = await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": gatewayKey,
      },
      body: JSON.stringify({
        model: modelOf(recorded),
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(counted.status).toBe(503);
    await counted.body?.cancel();
    expect(upstreamOf["Endpoint"]?.received).toHaveLength(0);
  });

  it.each(failures)(
    "fall back after $fixture, which holds the endpoint back as $reason",
    async ({ fixture: name, reason, seconds }) => {
      const failure = await fixture(name);
      const served = await fixture("messages.json");
      const { aiAccounts, upstreamOf, url } = await office([
        {
          name: "Endpoint",
          kind: "endpoint",
          answer: failure,
          credential: key,
        },
        {
          name: "Endpoint spare",
          kind: "endpoint",
          answer: served,
          credential: otherKey,
        },
      ]);
      const before = Date.now();
      const response = await send(url, served);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(served.response.body);
      expect(upstreamOf["Endpoint"]?.received).toHaveLength(1);
      expect(upstreamOf["Endpoint spare"]?.received).toHaveLength(1);
      const [first] = await aiAccounts.list();
      expect(first?.limitReason).toBe(reason);
      const until = first?.limitedUntil?.getTime() ?? 0;
      expect(until - before).toBeGreaterThanOrEqual((seconds - 1) * 1000);
      expect(until - Date.now()).toBeLessThanOrEqual(seconds * 1000);
    },
  );

  it("hold the key as a secret: never listed, and kept out of sandboxes", async () => {
    const recorded = await fixture("messages.json");
    const { aiAccounts, told, url } = await alone(recorded);
    expect(JSON.stringify(await aiAccounts.list())).not.toContain(key);
    expect(await aiAccounts.list()).toMatchObject([
      {
        aiProvider: "Anthropic-compatible",
        accountType: "endpoint",
        endpointUrl: expect.stringMatching(/\/anthropic$/) as unknown,
      },
    ]);
    expect(await aiAccounts.holdsCredential(`export KEY=${key}`)).toBe(true);
    expect(await aiAccounts.holdsCredential("export KEY=nothing")).toBe(false);
    await (await send(url, recorded)).text();
    expect(told).toContain(key);
  });

  it("send an endpoint added without a key no credential at all", async () => {
    const recorded = await fixture("messages.json");
    const { aiAccounts, told, upstreamOf, url } = await alone(recorded, {
      credential: null,
    });
    const response = await send(url, recorded);
    expect(response.status).toBe(200);
    await response.text();
    const [received] = upstreamOf["Endpoint"]?.received ?? [];
    expect(received?.headers["x-api-key"]).toBeUndefined();
    expect(received?.headers.authorization).toBeUndefined();
    // No key is not an empty one, which every value would hold.
    expect(await aiAccounts.holdsCredential("export KEY=nothing")).toBe(false);
    expect(told).toEqual([]);
  });
});
