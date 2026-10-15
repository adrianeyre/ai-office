// Contract tests for Qwen AI Accounts (PRD FR-35, FR-36, §11): Qwen Code's
// free sign-in, through a device login proved with PKCE against a fake
// OAuth server shaped like Qwen's (chat.qwen.ai), at the API host each
// answer names (`resource_url`). Its fixtures, in `fixtures/qwen/`, are
// replayed through a real Gateway serving from a real Qwen account, its
// answer in 7-byte chunks:
// - the device login asks with a PKCE challenge and finishes with its
//   verifier; the account is reached where the login says, and moves when
//   a refresh says it has;
// - opencode's Chat Completions pass through unchanged to `/v1/…` there,
//   with the access token as a bearer token, never the Gateway Key; the
//   caller gets the answer byte for byte; the record has the status and
//   tokens (and no cost: the sign-in is free);
// - it serves opencode only: Claude Code's Messages, and any other tool's
//   requests, go elsewhere or nowhere;
// - its free quota running out holds it back, and a second account serves;
// - its tokens are sealed, never listed, and kept out of sandboxes.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { aiAccountErrorCodes } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "../accounts/fake-oauth.ts";
import { apiUrlOf, qwenOAuth } from "../accounts/oauth.ts";
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

const folder = fileURLToPath(new URL("../../fixtures/qwen/", import.meta.url));
const fixture = (name: string) => readFixture(`${folder}${name}`);
const encryptor = encryptorFromKey(Buffer.alloc(32, 48));
const opencode = "opencode/1.2.0";

type Expected = Pick<
  GatewayRequestRecord,
  | "streamed"
  | "status"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadInputTokens"
  | "estimatedCostUsd"
>;

// What each fixture is recorded as. A new fixture needs an entry here.
const expectations: Record<string, Expected> = {
  "chat-completions.json": {
    streamed: false,
    status: 200,
    // 1200 prompt tokens, 1024 read from the cache.
    inputTokens: 176,
    outputTokens: 48,
    cacheReadInputTokens: 1024,
    estimatedCostUsd: null,
  },
  "chat-completions-streaming.json": {
    streamed: true,
    status: 200,
    inputTokens: 18,
    outputTokens: 4,
    cacheReadInputTokens: 0,
    estimatedCostUsd: null,
  },
  "chat-completions-quota-exceeded.json": {
    streamed: false,
    status: 429,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    estimatedCostUsd: null,
  },
};

let oauth: FakeOAuthServer | undefined;
let gateway: RunningGateway | undefined;
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

/** Qwen's sign-in, its fake, and AI Accounts that sign in through it. */
async function office(options: { now?: () => Date } = {}) {
  oauth = await startFakeOAuthServer({ qwen: true });
  const told: string[] = [];
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    oauthProviders: { Qwen: oauth.provider },
    onCredential: (credential) => told.push(credential),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { accounts, oauth, told };
}

/** Signs a Qwen account in, at the API `answer` stands in for. */
async function signIn(
  accounts: AiAccounts,
  fake: FakeOAuthServer,
  answer: Fixture,
  name = "Qwen",
) {
  const upstream = await startFakeUpstream(replay(answer, 7));
  upstreams.push(upstream);
  fake.resourceUrl = upstream.url;
  const login = await accounts.startLogin({
    name,
    aiProvider: "Qwen",
    acceptedTerms: true,
  });
  fake.approve(login.userCode ?? "");
  const { account } = await accounts.completeLogin(login.loginId, undefined);
  return { account, upstream };
}

/** A fixture's request, sent to the Gateway as opencode sends it. */
const send = (url: string, recorded: Fixture, userAgent = opencode) =>
  fetch(`${url}${recorded.request.path}`, {
    method: "POST",
    headers: {
      ...recorded.request.headers,
      "user-agent": userAgent,
      authorization: `Bearer ${gatewayKey}`,
    },
    body: recorded.request.body,
  });

describe("Qwen's sign-in", () => {
  it("is Qwen Code's device login, proved with PKCE", () => {
    expect(qwenOAuth).toMatchObject({
      flow: "device",
      devicePkce: true,
      deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
      tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
      tokenFormat: "form",
      clientId: "f0304373b74a44d2b584a3fb70ca9e56",
      scopes: ["openid", "profile", "email", "model.completion"],
    });
  });

  it("adds an account once the Owner approves its code, reached where the login says", async () => {
    const { accounts, oauth: fake } = await office();
    fake.resourceUrl = "portal.qwen.ai";
    const login = await accounts.startLogin({
      name: "Qwen",
      aiProvider: "Qwen",
      acceptedTerms: true,
    });
    expect(login.userCode).toBe("ABCD-0001");
    // Not approved yet: it can be finished later.
    await expect(
      accounts.completeLogin(login.loginId, undefined),
    ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthLoginPending });
    fake.approve("ABCD-0001");
    const { account, added } = await accounts.completeLogin(
      login.loginId,
      undefined,
    );
    expect(added).toBe(true);
    expect(account).toMatchObject({
      aiProvider: "Qwen",
      accountType: "oauth",
      // A bare host is reached over HTTPS; `/v1` is the kind's.
      endpointUrl: "https://portal.qwen.ai",
      reauthenticationNeeded: false,
    });
    // The poll was proved with the verifier (the fake refuses any other).
    const polls = fake.tokenRequests.filter(
      (request) =>
        request["grant_type"] ===
        "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(polls).toHaveLength(2);
    for (const poll of polls) {
      expect(poll["code_verifier"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("reads where each answer says its API is", () => {
    expect(apiUrlOf("portal.qwen.ai")).toBe("https://portal.qwen.ai");
    expect(apiUrlOf("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode",
    );
    expect(apiUrlOf("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    for (const refused of [
      undefined,
      "",
      "ftp://portal.qwen.ai",
      "https://user:secret@portal.qwen.ai",
      "https://portal.qwen.ai/v1?x=1",
    ]) {
      expect(apiUrlOf(refused), String(refused)).toBeUndefined();
    }
  });

  it("refreshes its tokens ahead of expiry, following its API if it moves", async () => {
    let time = Date.now();
    const {
      accounts,
      oauth: fake,
      told,
    } = await office({
      now: () => new Date(time),
    });
    fake.expiresIn = 6 * 60 * 60;
    const { account } = await signIn(
      accounts,
      fake,
      await fixture("chat-completions.json"),
    );
    const [first] = fake.accessTokens;
    fake.resourceUrl = "https://portal-2.qwen.ai/v1";
    // Within 15 minutes of expiry, it is refreshed.
    time += 6 * 60 * 60 * 1000 - 10 * 60 * 1000;
    const report = await accounts.refreshTokens();
    expect(report.refreshed).toEqual([account.id]);
    const [refreshed] = await accounts.list();
    expect(refreshed?.endpointUrl).toBe("https://portal-2.qwen.ai");
    expect(fake.accessTokens).toHaveLength(2);
    expect(told).toContain(first);
    expect(told).toContain(fake.accessTokens[1]);
    expect(
      fake.tokenRequests.filter(
        (request) => request["grant_type"] === "refresh_token",
      ),
    ).toHaveLength(1);
  });
});

describe("the Qwen fixtures", () => {
  it("each have an expectation, and each expectation a fixture", async () => {
    const names = (await readdir(folder))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(names).toEqual(Object.keys(expectations).sort());
  });

  it.each(Object.keys(expectations).sort())(
    "%s passes through unchanged from opencode to Qwen's API, with its usage recorded",
    async (name) => {
      const recorded = await fixture(name);
      const { accounts, oauth: fake } = await office();
      const { upstream } = await signIn(accounts, fake, recorded);
      const requestLog = memoryRequestLog();
      gateway = await startGateway({
        accounts,
        requestLog,
        sleep: () => Promise.resolve(),
      });
      const response = await send(gateway.url, recorded);
      expect(response.status).toBe(recorded.response.status);
      expect(await response.text()).toBe(recorded.response.body);
      expect(upstream.received.length).toBeGreaterThanOrEqual(1);
      for (const request of upstream.received) {
        expect(request.url).toBe(recorded.request.path);
        expect(request.body).toBe(recorded.request.body);
        expect(request.headers.authorization).toBe(
          `Bearer ${fake.accessTokens[0] ?? ""}`,
        );
        expect(JSON.stringify(request.headers)).not.toContain(gatewayKey);
      }
      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(1);
      });
      expect(requestLog.records[0]).toMatchObject({
        ...expectations[name],
        endpoint: "chat_completions",
        account: "Qwen",
        model: (JSON.parse(recorded.request.body) as { model: string }).model,
      });
    },
  );
});

describe("Qwen AI Accounts", () => {
  it("serve opencode only: not Claude Code, nor any other tool", async () => {
    const recorded = await fixture("chat-completions.json");
    const { accounts, oauth: fake } = await office();
    const { upstream } = await signIn(accounts, fake, recorded);
    gateway = await startGateway({ accounts });
    const other = await send(gateway.url, recorded, "curl/8.9.0");
    expect(other.status).toBe(503);
    await other.text();
    const fromClaudeCode = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.0 (external, cli)",
        "x-api-key": gatewayKey,
      },
      body: JSON.stringify({
        model: "qwen3-coder-plus",
        max_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(fromClaudeCode.status).toBe(503);
    await fromClaudeCode.text();
    expect(upstream.received).toHaveLength(0);
    const fromOpencode = await send(gateway.url, recorded);
    expect(fromOpencode.status).toBe(200);
    await fromOpencode.text();
    expect(upstream.received).toHaveLength(1);
  });

  it("fall back when the free quota runs out, holding the account back", async () => {
    const { accounts, oauth: fake } = await office();
    const before = Date.now();
    await signIn(
      accounts,
      fake,
      await fixture("chat-completions-quota-exceeded.json"),
      "Qwen",
    );
    const served = await fixture("chat-completions.json");
    const { upstream: spare } = await signIn(
      accounts,
      fake,
      served,
      "Qwen spare",
    );
    gateway = await startGateway({ accounts, sleep: () => Promise.resolve() });
    const response = await send(gateway.url, served);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(served.response.body);
    expect(spare.received).toHaveLength(1);
    const [first] = await accounts.list();
    expect(first?.name).toBe("Qwen");
    expect(first?.limitReason).toBe("rate_limited");
    // For the default minute: Qwen says nothing of when it comes back.
    const until = first?.limitedUntil?.getTime() ?? 0;
    expect(until - before).toBeGreaterThanOrEqual(59 * 1000);
  });

  it("hold their tokens as secrets: never listed, and kept out of sandboxes", async () => {
    const { accounts, oauth: fake, told } = await office();
    await signIn(accounts, fake, await fixture("chat-completions.json"));
    const [access] = fake.accessTokens;
    if (access === undefined) {
      throw new Error("No access token was issued.");
    }
    expect(JSON.stringify(await accounts.list())).not.toContain(access);
    expect(await accounts.holdsCredential(`TOKEN=${access}`)).toBe(true);
    expect(await accounts.holdsCredential("TOKEN=nothing")).toBe(false);
    expect(told).toContain(access);
  });
});
