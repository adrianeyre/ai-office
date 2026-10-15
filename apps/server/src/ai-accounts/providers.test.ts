import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createAiAccounts, memoryAiAccountStore } from "@ai-office/gateway";
import {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "@ai-office/gateway/testing";
import {
  allowInternalHosts,
  allowedInternalHosts,
  aiAccountListSchema,
  aiAccountSchema,
  createRedactor,
  oauthLoginSchema,
} from "@ai-office/shared";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, testEncryptor } from "../test-support.ts";

// Grok, Gemini, ChatGPT, OpenRouter, DeepSeek, Z.ai, Minimax, Kimi, Qwen
// and Ollama AI Accounts, and compatible endpoints, through the API (PRD
// FR-35, FR-36): an xAI API key, xAI's device sign-in against a fake OAuth
// server shaped like xAI's, importing a Grok CLI login, a Gemini API key,
// a ChatGPT subscription's sign-in against one shaped like OpenAI's, the
// other AI Providers' API keys, Qwen's sign-in against one shaped like
// Qwen's, the Owner's own Ollama and Ollama Cloud, and Anthropic- and
// OpenAI-compatible endpoints. No answer or log line carries a key or a
// token.

const xaiKey =
  "xai-routesTestKey0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";

let oauth: FakeOAuthServer | undefined;

afterEach(async () => {
  await oauth?.close();
  oauth = undefined;
});

async function setUp(options: { openai?: boolean; qwen?: boolean } = {}) {
  oauth = await startFakeOAuthServer(
    options.openai === true
      ? { openai: true }
      : options.qwen === true
        ? { qwen: true }
        : { device: true },
  );
  const logs: string[] = [];
  const redactor = createRedactor();
  const bus = createEventBus({ store: memoryEventStore() });
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor: testEncryptor,
    events: bus,
    oauthProviders: {
      Grok: oauth.provider,
      ChatGPT: oauth.provider,
      Qwen: oauth.provider,
    },
    onCredential: (value) => {
      redactor.register(value);
    },
  });
  const server = await buildApp({
    logger: createLogger({
      level: "trace",
      secrets: [],
      redactor,
      destination: { write: (line: string) => logs.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    aiAccounts: accounts,
  });
  const owner = await signIn(server);
  const post = (url: string, payload: object = {}) =>
    server.inject({ method: "POST", url, headers: owner.headers, payload });
  const list = async () =>
    aiAccountListSchema.parse(
      (
        await server.inject({
          method: "GET",
          url: "/api/ai-accounts",
          headers: owner.headers,
        })
      ).json(),
    ).accounts;
  return { oauth, logs, post, list };
}

describe("Grok AI Accounts through the API", () => {
  it("adds an xAI API key, which serves as a Grok account", async () => {
    const setup = await setUp();
    const added = await setup.post("/api/ai-accounts", {
      name: "xAI",
      aiProvider: "Grok",
      accountType: "api_key",
      credential: xaiKey,
    });
    expect(added.statusCode).toBe(201);
    expect(aiAccountSchema.parse(added.json())).toMatchObject({
      name: "xAI",
      aiProvider: "Grok",
      accountType: "api_key",
      endpointUrl: null,
    });
    expect(added.body).not.toContain(xaiKey);
    expect(setup.logs.join("\n")).not.toContain(xaiKey);
  });

  it("adds a Gemini API key, for Google's OpenAI-compatible API", async () => {
    const setup = await setUp();
    const geminiKey = "AIzaSyRoutesTestKey0123456789abcdefghijk";
    const added = await setup.post("/api/ai-accounts", {
      name: "Gemini",
      aiProvider: "Gemini",
      accountType: "api_key",
      credential: geminiKey,
    });
    expect(added.statusCode).toBe(201);
    expect(aiAccountSchema.parse(added.json())).toMatchObject({
      name: "Gemini",
      aiProvider: "Gemini",
      accountType: "api_key",
    });
    // A Gemini subscription cannot be added: there is none to sign in to.
    const subscription = await setup.post("/api/ai-accounts/oauth", {
      name: "Gemini sub",
      aiProvider: "Gemini",
      acceptedTerms: true,
    });
    expect(subscription.statusCode).toBe(400);
    for (const text of [added.body, setup.logs.join("\n")]) {
      expect(text).not.toContain(geminiKey);
    }
  });

  it("adds a Grok subscription through xAI's device sign-in", async () => {
    const setup = await setUp();
    const started = await setup.post("/api/ai-accounts/oauth", {
      name: "SuperGrok",
      aiProvider: "Grok",
      acceptedTerms: true,
    });
    expect(started.statusCode).toBe(201);
    const login = oauthLoginSchema.parse(started.json());
    expect(login.userCode).toBe("ABCD-0001");

    // Finished before it is approved: 409, and it can be tried again.
    const early = await setup.post(`/api/ai-accounts/oauth/${login.loginId}`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: "oauth_login_pending" });

    setup.oauth.approve(login.userCode ?? "");
    const done = await setup.post(`/api/ai-accounts/oauth/${login.loginId}`);
    expect(done.statusCode).toBe(201);
    expect(aiAccountSchema.parse(done.json())).toMatchObject({
      name: "SuperGrok",
      aiProvider: "Grok",
      accountType: "oauth",
      tokenHealth: "valid",
    });
    const [accessToken] = setup.oauth.accessTokens;
    for (const text of [done.body, setup.logs.join("\n")]) {
      expect(text).not.toContain(accessToken);
    }
  });

  it("imports a Grok CLI login, and refuses one without tokens", async () => {
    const setup = await setUp();
    const issued = setup.oauth.issue();
    const imported = await setup.post("/api/ai-accounts/import", {
      name: "Grok CLI",
      aiProvider: "Grok",
      acceptedTerms: true,
      login: JSON.stringify({
        ...issued,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });
    expect(imported.statusCode).toBe(201);
    expect(aiAccountSchema.parse(imported.json())).toMatchObject({
      name: "Grok CLI",
      aiProvider: "Grok",
      accountType: "oauth",
      tokenHealth: "valid",
    });
    for (const text of [imported.body, setup.logs.join("\n")]) {
      expect(text).not.toContain(issued.access_token);
      expect(text).not.toContain(issued.refresh_token);
    }

    const empty = await setup.post("/api/ai-accounts/import", {
      name: "Empty",
      aiProvider: "Grok",
      acceptedTerms: true,
      login: '{"api_key":"nothing-to-import"}',
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: "login_not_importable" });
    expect(empty.body).not.toContain("nothing-to-import");

    for (const payload of [
      { name: "No terms", aiProvider: "Grok", login: "{}" },
      {
        name: "Claude",
        aiProvider: "Claude",
        acceptedTerms: true,
        login: "{}",
      },
    ]) {
      expect(
        (await setup.post("/api/ai-accounts/import", payload)).statusCode,
      ).toBe(400);
    }
    expect((await setup.list()).map(({ name }) => name)).toEqual(["Grok CLI"]);
  });
});

describe("ChatGPT subscriptions through the API", () => {
  it("signs in as Codex does, with the address the sign-in ended on pasted back", async () => {
    const setup = await setUp({ openai: true });
    // Without the terms accepted, no sign-in starts.
    expect(
      (
        await setup.post("/api/ai-accounts/oauth", {
          name: "ChatGPT Plus",
          aiProvider: "ChatGPT",
        })
      ).statusCode,
    ).toBe(400);
    const started = await setup.post("/api/ai-accounts/oauth", {
      name: "ChatGPT Plus",
      aiProvider: "ChatGPT",
      acceptedTerms: true,
    });
    expect(started.statusCode).toBe(201);
    expect(started.headers["cache-control"]).toBe("no-store");
    const login = oauthLoginSchema.parse(started.json());
    expect(login.userCode).toBeUndefined();

    const address = await setup.oauth.signIn(login.authorizeUrl);
    const done = await setup.post(`/api/ai-accounts/oauth/${login.loginId}`, {
      code: address,
    });
    expect(done.statusCode).toBe(201);
    expect(aiAccountSchema.parse(done.json())).toMatchObject({
      name: "ChatGPT Plus",
      aiProvider: "ChatGPT",
      accountType: "oauth",
      tokenHealth: "valid",
      reauthenticationNeeded: false,
    });
    const code = new URL(address).searchParams.get("code") ?? "";
    const [accessToken = ""] = setup.oauth.accessTokens;
    for (const text of [done.body, setup.logs.join("\n")]) {
      expect(text).not.toContain(accessToken);
      expect(text).not.toContain(code);
    }

    // Signing in again goes through the same login.
    const again = await setup.post(
      `/api/ai-accounts/${aiAccountSchema.parse(done.json()).id}/reauthenticate`,
    );
    expect(again.statusCode).toBe(201);
    const relogin = oauthLoginSchema.parse(again.json());
    const signedIn = await setup.post(
      `/api/ai-accounts/oauth/${relogin.loginId}`,
      { code: await setup.oauth.signIn(relogin.authorizeUrl) },
    );
    expect(signedIn.statusCode).toBe(200);
    expect((await setup.list()).map(({ name }) => name)).toEqual([
      "ChatGPT Plus",
    ]);
  });
});

describe("OpenRouter, DeepSeek, Z.ai, Minimax and Kimi AI Accounts through the API", () => {
  it.each([
    ["OpenRouter", "sk-or-v1-routesTestKey0123456789abcdef0123456789"],
    ["DeepSeek", "sk-routesTestDeepSeek0123456789abcdef"],
    ["Z.ai", "routesTestZai0123456789abcdef01.AbCdEfGhIjKl"],
    ["Minimax", "eyJhbGciOiJSUzI1NiJ9.routesTestMinimax.c2lnbmF0dXJl"],
    ["Kimi", "sk-routesTestKimi0123456789abcdef0123"],
  ])(
    "adds %s's API key, which is never sent back or logged",
    async (aiProvider, key) => {
      const setup = await setUp();
      const added = await setup.post("/api/ai-accounts", {
        name: aiProvider,
        aiProvider,
        accountType: "api_key",
        credential: key,
      });
      expect(added.statusCode).toBe(201);
      expect(aiAccountSchema.parse(added.json())).toMatchObject({
        name: aiProvider,
        aiProvider,
        accountType: "api_key",
        endpointUrl: null,
        tokenHealth: null,
        extraUsage: null,
      });
      expect(added.body).not.toContain(key);
      const custom = await setup.post("/api/ai-accounts", {
        name: `${aiProvider} via a proxy`,
        aiProvider,
        accountType: "api_key",
        credential: `${key}-2`,
        endpointUrl: "https://llm-proxy.example",
      });
      expect(custom.statusCode).toBe(201);
      expect(custom.json()).toMatchObject({
        endpointUrl: "https://llm-proxy.example",
      });
      expect(JSON.stringify(await setup.list())).not.toContain(key);
      expect(setup.logs.join("\n")).not.toContain(key);
      // There is no subscription to sign in to.
      const subscription = await setup.post("/api/ai-accounts/oauth", {
        name: `${aiProvider} sub`,
        aiProvider,
        acceptedTerms: true,
      });
      expect(subscription.statusCode).toBe(400);
    },
  );
});

describe("Qwen, Ollama and compatible endpoints through the API", () => {
  it("adds a Qwen sign-in through Qwen Code's device login, reached where it says", async () => {
    const setup = await setUp({ qwen: true });
    setup.oauth.resourceUrl = "portal.qwen.ai";
    const started = await setup.post("/api/ai-accounts/oauth", {
      name: "Qwen",
      aiProvider: "Qwen",
      acceptedTerms: true,
    });
    expect(started.statusCode).toBe(201);
    const login = oauthLoginSchema.parse(started.json());
    expect(login.userCode).toBe("ABCD-0001");
    setup.oauth.approve(login.userCode ?? "");
    const done = await setup.post(`/api/ai-accounts/oauth/${login.loginId}`);
    expect(done.statusCode).toBe(201);
    expect(aiAccountSchema.parse(done.json())).toMatchObject({
      name: "Qwen",
      aiProvider: "Qwen",
      accountType: "oauth",
      endpointUrl: "https://portal.qwen.ai",
      tokenHealth: "valid",
    });
    const [accessToken] = setup.oauth.accessTokens;
    for (const text of [done.body, setup.logs.join("\n")]) {
      expect(text).not.toContain(accessToken);
    }
    // There is no Qwen API key to add.
    const key = await setup.post("/api/ai-accounts", {
      name: "Qwen key",
      aiProvider: "Qwen",
      accountType: "api_key",
      credential: "sk-routesTestQwen0123456789",
    });
    expect(key.statusCode).toBe(400);
  });

  it("adds an Ollama Cloud API key, which is never sent back or logged", async () => {
    const setup = await setUp();
    const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0.routesTestOllamaCloud";
    const added = await setup.post("/api/ai-accounts", {
      name: "Ollama Cloud",
      aiProvider: "Ollama",
      accountType: "api_key",
      credential: key,
    });
    expect(added.statusCode).toBe(201);
    expect(aiAccountSchema.parse(added.json())).toMatchObject({
      aiProvider: "Ollama",
      accountType: "api_key",
      endpointUrl: null,
    });
    expect(added.body).not.toContain(key);
    expect(JSON.stringify(await setup.list())).not.toContain(key);
    expect(setup.logs.join("\n")).not.toContain(key);
  });

  it("adds the Owner's own Ollama with no key, at its own address or another", async () => {
    // On the AI Office host and the Owner's network, which they allow
    // (ADR 0007).
    const allowed = allowedInternalHosts();
    allowInternalHosts([...allowed, ".lan"]);
    onTestFinished(() => {
      allowInternalHosts(allowed);
    });
    const setup = await setUp();
    const local = await setup.post("/api/ai-accounts", {
      name: "Ollama",
      aiProvider: "Ollama",
      accountType: "endpoint",
    });
    expect(local.statusCode).toBe(201);
    expect(aiAccountSchema.parse(local.json())).toMatchObject({
      aiProvider: "Ollama",
      accountType: "endpoint",
      // Its own address, http://localhost:11434, unless given another.
      endpointUrl: null,
    });
    const lan = await setup.post("/api/ai-accounts", {
      name: "Ollama on the GPU box",
      aiProvider: "Ollama",
      accountType: "endpoint",
      endpointUrl: "http://gpu-box.lan:11434",
    });
    expect(lan.statusCode).toBe(201);
    expect(lan.json()).toMatchObject({
      endpointUrl: "http://gpu-box.lan:11434",
    });
  });

  it.each([
    ["Anthropic-compatible", "https://llm.example.com/anthropic"],
    ["OpenAI-compatible", "https://llm.example.com/openai/v1"],
  ])(
    "adds an %s endpoint at its URL, with a key that is never sent back or logged, or none",
    async (aiProvider, endpointUrl) => {
      const setup = await setUp();
      const key = "sk-routesTestEndpoint0123456789abcdef";
      const added = await setup.post("/api/ai-accounts", {
        name: aiProvider,
        aiProvider,
        accountType: "endpoint",
        endpointUrl,
        credential: key,
      });
      expect(added.statusCode).toBe(201);
      expect(aiAccountSchema.parse(added.json())).toMatchObject({
        aiProvider,
        accountType: "endpoint",
        endpointUrl,
        tokenHealth: null,
      });
      expect(added.body).not.toContain(key);
      const keyless = await setup.post("/api/ai-accounts", {
        name: `${aiProvider} without a key`,
        aiProvider,
        accountType: "endpoint",
        endpointUrl,
      });
      expect(keyless.statusCode).toBe(201);
      // It has no address of its own.
      const nowhere = await setup.post("/api/ai-accounts", {
        name: `${aiProvider} nowhere`,
        aiProvider,
        accountType: "endpoint",
        credential: key,
      });
      expect(nowhere.statusCode).toBe(400);
      expect(nowhere.json()).toMatchObject({
        problems: ["Enter the endpoint's URL."],
      });
      expect(nowhere.body).not.toContain(key);
      expect(JSON.stringify(await setup.list())).not.toContain(key);
      expect(setup.logs.join("\n")).not.toContain(key);
    },
  );
});
