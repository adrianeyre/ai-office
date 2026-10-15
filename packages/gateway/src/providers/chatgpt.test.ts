// Contract tests for ChatGPT subscription AI Accounts (PRD FR-35): the
// recorded answers in `fixtures/chatgpt/` are replayed through a real
// Gateway serving from a real ChatGPT subscription, signed in through a
// fake OAuth server shaped like OpenAI's. Codex's Responses requests pass
// through unchanged to ChatGPT's Codex backend (`/backend-api/codex`),
// with the access token as a bearer token and the ChatGPT account it is
// for; nothing else reaches it (FR-35); and its usage limit holds it back
// until the plan's window resets, the request falling back to the next.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import {
  fakeChatgptAccountId,
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "../accounts/fake-oauth.ts";
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
  new URL("../../fixtures/chatgpt/", import.meta.url),
);
const fixture = (name: string) => readFixture(`${folder}${name}`);

const encryptor = encryptorFromKey(Buffer.alloc(32, 48));

/** Where callers send a fixture's request: the Gateway's own path. */
const callerPath = (path: string) =>
  path.replace(/^\/backend-api\/codex/, "/v1");

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
  "responses-streaming.json": {
    endpoint: "responses",
    streamed: true,
    status: 200,
    inputTokens: 390,
    outputTokens: 64,
    cacheReadInputTokens: 1920,
  },
  "responses-tool-call-streaming.json": {
    endpoint: "responses",
    streamed: true,
    status: 200,
    inputTokens: 1840,
    outputTokens: 22,
    cacheReadInputTokens: 0,
  },
  "responses-compact.json": {
    endpoint: "responses_compact",
    streamed: false,
    status: 200,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
  },
  "responses-usage-limit.json": {
    endpoint: "responses",
    streamed: false,
    status: 429,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
  },
};

const names = (await readdir(folder))
  .filter((name) => name.endsWith(".json"))
  .sort();

let gateway: RunningGateway | undefined;
let oauth: FakeOAuthServer | undefined;
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await oauth?.close();
  oauth = undefined;
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
});

/**
 * ChatGPT subscriptions, each signed in through the fake OAuth server and
 * answering with its fixture, in priority order; their access tokens by
 * name.
 */
async function office(
  accounts: readonly { name: string; answer: Fixture }[],
  options: { saved?: Fixture[] } = {},
) {
  oauth = await startFakeOAuthServer({ openai: true });
  const store = memoryAiAccountStore();
  const requestLog = memoryRequestLog();
  const aiAccounts: AiAccounts = createAiAccounts({
    store,
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    oauthProviders: { ChatGPT: oauth.provider },
  });
  const upstreamOf: Record<string, FakeUpstream> = {};
  const tokenOf: Record<string, string> = {};
  for (const account of accounts) {
    const login = await aiAccounts.startLogin({
      name: account.name,
      aiProvider: "ChatGPT",
      acceptedTerms: true,
    });
    const { account: added } = await aiAccounts.completeLogin(
      login.loginId,
      await oauth.signIn(login.authorizeUrl),
    );
    tokenOf[account.name] = oauth.accessTokens.at(-1) ?? "";
    const upstream = await startFakeUpstream(replay(account.answer, 7));
    upstreams.push(upstream);
    upstreamOf[account.name] = upstream;
    // Pointed at the fake ChatGPT, as a custom endpoint would be.
    const row = store.accounts.get(added.id);
    if (row === undefined) {
      throw new Error("The subscription is not stored.");
    }
    store.accounts.set(added.id, { ...row, endpointUrl: upstream.url });
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
  return { aiAccounts, requestLog, upstreamOf, tokenOf, url: gateway.url };
}

const send = (url: string, recorded: Fixture, path = recorded.request.path) =>
  fetch(`${url}${callerPath(path)}`, {
    method: "POST",
    headers: {
      ...recorded.request.headers,
      authorization: `Bearer ${gatewayKey}`,
    },
    body: recorded.request.body,
  });

describe("the ChatGPT fixtures", () => {
  it("each have an expectation, and each expectation a fixture", () => {
    expect(names).toEqual(Object.keys(expectations).sort());
  });

  it.each(names)(
    "%s passes through to ChatGPT's Codex backend unchanged, with its usage recorded",
    async (name) => {
      const recorded = await fixture(name);
      const saved: Fixture[] = [];
      const { requestLog, upstreamOf, tokenOf, url } = await office(
        [{ name: "ChatGPT Plus", answer: recorded }],
        { saved },
      );
      // One attempt: a 429 from the only account is sent on as it is.
      const response = await send(url, recorded);
      expect(response.status).toBe(recorded.response.status);
      expect(await response.text()).toBe(recorded.response.body);

      const upstream = upstreamOf["ChatGPT Plus"];
      expect(upstream?.received).toHaveLength(1);
      const [received] = upstream?.received ?? [];
      // The Codex backend's path, the very body, Codex's own headers, the
      // token as a bearer token with its ChatGPT account, and never the
      // Gateway Key.
      expect(received?.url).toBe(recorded.request.path);
      expect(received?.body).toBe(recorded.request.body);
      expect(received?.headers.authorization).toBe(
        `Bearer ${tokenOf["ChatGPT Plus"] ?? ""}`,
      );
      expect(received?.headers["chatgpt-account-id"]).toBe(
        fakeChatgptAccountId,
      );
      expect(received?.headers["originator"]).toBe("codex_exec");
      expect(received?.headers["user-agent"]).toBe(
        recorded.request.headers["user-agent"],
      );
      expect(received?.headers["x-api-key"]).toBeUndefined();
      expect(JSON.stringify(received?.headers)).not.toContain(gatewayKey);

      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(1);
        expect(saved).toHaveLength(1);
      });
      expect(requestLog.records[0]).toMatchObject({
        ...expectations[name],
        account: "ChatGPT Plus",
        model: "gpt-5-codex",
      });
      // Recorder mode saves the path as sent, and never the token.
      expect(saved[0]?.request.path).toBe(recorded.request.path);
      expect(JSON.stringify(saved[0])).not.toContain(
        tokenOf["ChatGPT Plus"] ?? "",
      );
    },
  );
});

describe("ChatGPT subscriptions through the Gateway", () => {
  it("serve nothing but Codex's Responses: not other tools, not translated requests", async () => {
    const recorded = await fixture("responses-streaming.json");
    const { upstreamOf, url } = await office([
      { name: "ChatGPT Plus", answer: recorded },
    ]);
    const post = (
      path: string,
      headers: Record<string, string>,
      body: unknown,
    ) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${gatewayKey}`,
          ...headers,
        },
        body: JSON.stringify(body),
      }).then(async (response) => {
        await response.text();
        return response.status;
      });
    const responses = JSON.parse(recorded.request.body) as unknown;

    // Responses from another tool, or from none.
    for (const userAgent of ["opencode/0.15.2", "curl/8.9.1", ""]) {
      expect(
        await post("/v1/responses", { "user-agent": userAgent }, responses),
      ).toBe(503);
    }
    // Codex's own Chat Completions, which the Codex backend does not speak.
    expect(
      await post(
        "/v1/chat/completions",
        { "user-agent": recorded.request.headers["user-agent"] ?? "" },
        {
          model: "gpt-5-codex",
          messages: [{ role: "user", content: "Hi" }],
        },
      ),
    ).toBe(503);
    // Claude Code asking for a ChatGPT Model: a translated request.
    expect(
      await post(
        "/v1/messages",
        {
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/2.1.0 (external, cli)",
        },
        {
          model: "gpt-5-codex",
          max_tokens: 16,
          messages: [{ role: "user", content: "Hi" }],
        },
      ),
    ).toBe(503);
    // Codex asking for a Claude Model.
    expect(
      await post(
        "/v1/responses",
        { "user-agent": recorded.request.headers["user-agent"] ?? "" },
        { ...(responses as object), model: "claude-sonnet-5-5" },
      ),
    ).toBe(503);
    expect(upstreamOf["ChatGPT Plus"]?.received).toHaveLength(0);

    // Codex itself is served.
    const served = await send(url, recorded);
    expect(served.status).toBe(200);
    await served.text();
    expect(upstreamOf["ChatGPT Plus"]?.received).toHaveLength(1);
  });

  it("fall back from a subscription at its usage limit, held back until the plan's window resets", async () => {
    const limited = await fixture("responses-usage-limit.json");
    const streamed = await fixture("responses-streaming.json");
    const { aiAccounts, upstreamOf, url } = await office([
      { name: "ChatGPT Plus", answer: limited },
      { name: "ChatGPT Pro", answer: streamed },
    ]);
    const before = Date.now();
    const response = await send(url, streamed);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(streamed.response.body);
    expect(upstreamOf["ChatGPT Plus"]?.received).toHaveLength(1);
    expect(upstreamOf["ChatGPT Pro"]?.received).toHaveLength(1);
    const [first] = await aiAccounts.list();
    expect(first?.name).toBe("ChatGPT Plus");
    expect(first?.limitReason).toBe("rate_limited");
    // `resets_in_seconds` (4800) is later than any header says.
    const until = first?.limitedUntil?.getTime() ?? 0;
    expect(until - before).toBeGreaterThanOrEqual(4_799_000);
    expect(until - Date.now()).toBeLessThanOrEqual(4_800_000);
  });

  it("keep the usage windows Codex's headers report, with their history (FR-36, FR-43)", async () => {
    const limited = await fixture("responses-usage-limit.json");
    const streamed = await fixture("responses-streaming.json");
    const { aiAccounts, url } = await office([
      { name: "ChatGPT Plus", answer: limited },
      { name: "ChatGPT Pro", answer: streamed },
    ]);
    const response = await send(url, streamed);
    await response.text();
    await vi.waitFor(async () => {
      expect(
        (await aiAccounts.list()).map(
          ({ name, fiveHourUtilization, weeklyUtilization }) => [
            name,
            fiveHourUtilization,
            weeklyUtilization,
          ],
        ),
      ).toEqual([
        // At its limit, with only its primary (five-hour) window said.
        ["ChatGPT Plus", 100, null],
        ["ChatGPT Pro", 23, 41],
      ]);
    });
    const [plus, pro] = await aiAccounts.list();
    const hour = 60 * 60 * 1000;
    // 4,800 and 12,400 seconds from the answer, to the minute.
    expect(
      Math.abs(
        (plus?.fiveHourResetsAt?.getTime() ?? 0) - Date.now() - 80 * 60_000,
      ),
    ).toBeLessThan(2 * 60_000);
    expect((pro?.weeklyResetsAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      83 * hour,
    );
    const history = await aiAccounts.usageHistory(pro?.id ?? "", {
      since: new Date(Date.now() - hour),
      limit: 10,
    });
    expect(
      history.map(({ window, utilization }) => [window, utilization]).sort(),
    ).toEqual([
      ["five_hour", 23],
      ["weekly", 41],
    ]);
  });
});

describe("ChatGPT subscriptions' usage endpoint", () => {
  it("is read for their usage windows without a request through them (FR-36)", async () => {
    const streamed = await fixture("responses-streaming.json");
    const { aiAccounts } = await office([
      { name: "ChatGPT Plus", answer: streamed },
    ]);
    if (oauth === undefined) {
      throw new Error("No fake OAuth server.");
    }
    oauth.usage = {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 17,
          limit_window_seconds: 18_000,
          reset_at: 1_791_550_800,
        },
        secondary_window: {
          used_percent: 62,
          limit_window_seconds: 604_800,
          reset_at: 1_791_900_000,
        },
      },
    };
    const [account] = await aiAccounts.list();
    expect(await aiAccounts.refreshUsage(account?.id)).toEqual({
      refreshed: [account?.id],
      failed: [],
    });
    // Its own token, naming its ChatGPT account, and no Anthropic flags.
    expect(oauth.usageRequests).toEqual([
      {
        token: oauth.accessTokens.at(-1),
        beta: undefined,
        account: fakeChatgptAccountId,
      },
    ]);
    const [read] = await aiAccounts.list();
    expect([
      read?.fiveHourUtilization,
      read?.fiveHourResetsAt,
      read?.weeklyUtilization,
      read?.weeklyResetsAt,
    ]).toEqual([
      17,
      new Date(1_791_550_800 * 1000),
      62,
      new Date(1_791_900_000 * 1000),
    ]);
  });
});
