// The live model catalogue (PRD FR-41): each kind of AI Account's Models,
// fetched from its AI Provider's models endpoint with an account of that
// kind. The recorded lists in `fixtures/models/` are served by fake AI
// Providers, each in its own shape, to real AI Accounts (API keys, and
// subscriptions signed in through fake OAuth servers).
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import {
  fakeChatgptAccountId,
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "../accounts/fake-oauth.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { readFixture, type Fixture } from "../fixtures.ts";
import {
  startFakeUpstream,
  type FakeUpstream,
  type ReceivedRequest,
} from "../test-support.ts";
import { createModelCatalogue, modelsInList } from "./catalogue.ts";
import {
  databaseModelCatalogueStore,
  memoryModelCatalogueStore,
  type CatalogueEntry,
} from "./store.ts";

const folder = fileURLToPath(
  new URL("../../fixtures/models/", import.meta.url),
);
const fixtures = Object.fromEntries(
  await Promise.all(
    (await readdir(folder))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => [name, await readFixture(`${folder}${name}`)]),
  ),
) as Record<string, Fixture>;

const encryptor = encryptorFromKey(Buffer.alloc(32, 61));
const anthropicKey = "sk-ant-api03-catalogueTestKey0123456789abcdefghij";
const xaiKey = "xai-catalogueTestKey0123456789abcdefghijklmnopqrstuvwxyzAB";
const geminiKey = "AIzaSyCatalogueTestKey0123456789abcdefgh";
const fetchedAt = new Date("2026-10-09T12:00:00.000Z");

const upstreams: FakeUpstream[] = [];
const oauthServers: FakeOAuthServer[] = [];

afterEach(async () => {
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
  for (const server of oauthServers.splice(0)) {
    await server.close();
  }
});

/**
 * A fake AI Provider answering each fixture's request (by its path and
 * query), and 404 for anything else; or `status` for everything, while
 * set.
 */
async function provider(names: readonly string[]) {
  const answers = names.map((name) => {
    const fixture = fixtures[name];
    if (fixture === undefined) {
      throw new Error(`There is no fixture ${name}.`);
    }
    return fixture;
  });
  const state: { status: number | undefined } = { status: undefined };
  const upstream = await startFakeUpstream(
    (request: ReceivedRequest, response) => {
      const answer = answers.find(
        ({ request: recorded }) =>
          recorded.method === request.method && recorded.path === request.url,
      );
      if (state.status !== undefined || answer === undefined) {
        response.writeHead(state.status ?? 404, {
          "content-type": "application/json",
        });
        response.end(`{"error":{"message":"no such list, ${anthropicKey}"}}`);
        return;
      }
      response.writeHead(answer.response.status, answer.response.headers);
      response.end(answer.response.body);
    },
  );
  upstreams.push(upstream);
  return { upstream, state };
}

/** Points a stored account at a fake, as a custom endpoint would. */
function pointAt(
  store: ReturnType<typeof memoryAiAccountStore>,
  id: string,
  url: string,
) {
  const row = store.accounts.get(id);
  if (row === undefined) {
    throw new Error("The account is not stored.");
  }
  store.accounts.set(id, { ...row, endpointUrl: url });
}

/** An office with one AI Account of every kind, each at its own fake. */
async function office() {
  const anthropicOAuth = await startFakeOAuthServer();
  const openaiOAuth = await startFakeOAuthServer({ openai: true });
  oauthServers.push(anthropicOAuth, openaiOAuth);
  const store = memoryAiAccountStore();
  const accounts: AiAccounts = createAiAccounts({
    store,
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    oauth: anthropicOAuth.provider,
    oauthProviders: { ChatGPT: openaiOAuth.provider },
  });
  const anthropic = await provider(["anthropic.json", "anthropic-page-2.json"]);
  const claudeMax = await provider(["anthropic.json", "anthropic-page-2.json"]);
  const xai = await provider(["xai.json"]);
  const gemini = await provider(["gemini.json"]);
  const chatgpt = await provider(["chatgpt.json"]);
  for (const [name, aiProvider, credential, url] of [
    ["Anthropic", "Claude", anthropicKey, anthropic.upstream.url],
    ["xAI", "Grok", xaiKey, xai.upstream.url],
    ["Gemini", "Gemini", geminiKey, gemini.upstream.url],
  ] as const) {
    await accounts.add({
      name,
      aiProvider,
      accountType: "api_key",
      credential,
      endpointUrl: url,
    });
  }
  const subscriptions = {} as Record<"Claude" | "ChatGPT", string>;
  for (const [name, aiProvider, oauth, url] of [
    ["Claude Max", "Claude", anthropicOAuth, claudeMax.upstream.url],
    ["ChatGPT Plus", "ChatGPT", openaiOAuth, chatgpt.upstream.url],
  ] as const) {
    const login = await accounts.startLogin({
      name,
      aiProvider,
      acceptedTerms: true,
    });
    const { account } = await accounts.completeLogin(
      login.loginId,
      await oauth.signIn(login.authorizeUrl),
    );
    pointAt(store, account.id, url);
    subscriptions[aiProvider] = oauth.accessTokens.at(-1) ?? "";
  }
  return {
    accounts,
    store,
    subscriptions,
    fakes: { anthropic, claudeMax, xai, gemini, chatgpt },
  };
}

const modelsOf = (entries: readonly CatalogueEntry[], kind: string) =>
  entries
    .filter(
      ({ aiProvider, accountType }) => `${aiProvider}:${accountType}` === kind,
    )
    .map(({ model }) => model);

describe("the model catalogue", () => {
  it("refreshes every kind of AI Account's Models from its AI Provider's list", async () => {
    const { accounts, subscriptions, fakes } = await office();
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
      now: () => fetchedAt,
    });
    expect(await catalogue.list()).toEqual([]);

    const report = await catalogue.refresh();
    expect(report.failed).toEqual([]);
    expect(
      Object.fromEntries(
        report.refreshed.map(({ aiProvider, accountType, models }) => [
          `${aiProvider}:${accountType}`,
          models,
        ]),
      ),
    ).toEqual({
      "Claude:api_key": 4,
      "Claude:oauth": 4,
      "Grok:api_key": 3,
      "Gemini:api_key": 3,
      "ChatGPT:oauth": 2,
    });

    const entries = await catalogue.list();
    // Anthropic's two pages, in the order listed.
    expect(modelsOf(entries, "Claude:api_key")).toEqual([
      "claude-fable-5-1",
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(modelsOf(entries, "Grok:api_key")).toEqual([
      "grok-4",
      "grok-4-fast-reasoning",
      "grok-code-fast-1",
    ]);
    // Google's ids without `models/`.
    expect(modelsOf(entries, "Gemini:api_key")).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "text-embedding-004",
    ]);
    expect(entries).toContainEqual({
      aiProvider: "Claude",
      accountType: "api_key",
      model: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      contextWindow: null,
      fetchedAt,
    });
    // ChatGPT's Codex backend says each Model's context window.
    expect(entries).toContainEqual({
      aiProvider: "ChatGPT",
      accountType: "oauth",
      model: "gpt-5-codex",
      displayName: "gpt-5-codex",
      contextWindow: 272_000,
      fetchedAt,
    });

    // Each list was asked for as its AI Provider wants, with the
    // account's own credential.
    const [first, second] = fakes.anthropic.upstream.received;
    expect([first?.url, second?.url]).toEqual([
      fixtures["anthropic.json"]?.request.path,
      fixtures["anthropic-page-2.json"]?.request.path,
    ]);
    expect(first?.method).toBe("GET");
    expect(first?.headers["x-api-key"]).toBe(anthropicKey);
    expect(first?.headers["anthropic-version"]).toBe("2023-06-01");
    const [subscription] = fakes.claudeMax.upstream.received;
    expect(subscription?.headers.authorization).toBe(
      `Bearer ${subscriptions.Claude}`,
    );
    expect(subscription?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(subscription?.headers["x-api-key"]).toBeUndefined();
    for (const [fake, name, key] of [
      [fakes.xai, "xai.json", xaiKey],
      [fakes.gemini, "gemini.json", geminiKey],
      [fakes.chatgpt, "chatgpt.json", subscriptions.ChatGPT],
    ] as const) {
      const [received] = fake.upstream.received;
      expect(received?.url).toBe(fixtures[name]?.request.path);
      expect(received?.headers.authorization).toBe(`Bearer ${key}`);
    }
    expect(
      fakes.chatgpt.upstream.received[0]?.headers["chatgpt-account-id"],
    ).toBe(fakeChatgptAccountId);
  });

  it("keeps a kind's last list when it cannot be fetched, saying why without the answer", async () => {
    const { accounts, fakes } = await office();
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
      now: () => fetchedAt,
    });
    await catalogue.refresh();
    const before = await catalogue.list();

    fakes.xai.state.status = 503;
    fakes.gemini.state.status = 401;
    const report = await catalogue.refresh();
    expect(report.failed).toEqual([
      {
        aiProvider: "Grok",
        accountType: "api_key",
        message: "The AI Provider's model list answered 503.",
      },
      {
        aiProvider: "Gemini",
        accountType: "api_key",
        message: "The AI Provider's model list answered 401.",
      },
    ]);
    expect(report.refreshed.map(({ aiProvider }) => aiProvider)).toEqual([
      "Claude",
      "Claude",
      "ChatGPT",
    ]);
    expect(await catalogue.list()).toEqual(before);
    expect(JSON.stringify(report)).not.toContain(anthropicKey);
  });

  it("asks no paused account, nor a subscription whose token has expired", async () => {
    const { accounts, store, fakes } = await office();
    for (const account of await accounts.list()) {
      if (account.name === "xAI") {
        await accounts.update(account.id, { paused: true });
      }
      if (account.name === "ChatGPT Plus") {
        const row = store.accounts.get(account.id);
        if (row !== undefined) {
          store.accounts.set(account.id, {
            ...row,
            tokenExpiresAt: new Date(Date.now() - 1000),
          });
        }
      }
    }
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
    });
    const report = await catalogue.refresh();
    expect(
      report.refreshed.map(
        ({ aiProvider, accountType }) => `${aiProvider}:${accountType}`,
      ),
    ).toEqual(["Claude:api_key", "Gemini:api_key", "Claude:oauth"]);
    expect(fakes.xai.upstream.received).toEqual([]);
    expect(fakes.chatgpt.upstream.received).toEqual([]);
  });

  it("runs one refresh at a time", async () => {
    const { accounts, fakes } = await office();
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
    });
    const [one, two] = await Promise.all([
      catalogue.refresh(),
      catalogue.refresh(),
    ]);
    expect(two).toBe(one);
    expect(fakes.xai.upstream.received).toHaveLength(1);
    await catalogue.refresh();
    expect(fakes.xai.upstream.received).toHaveLength(2);
  });
});

describe("the model catalogue of OpenRouter, DeepSeek, Z.ai, Minimax and Kimi", () => {
  /** One API-key account of each, each at its own fake. */
  async function newKinds() {
    const accounts: AiAccounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
    });
    const fakes = {
      OpenRouter: await provider(["openrouter.json"]),
      DeepSeek: await provider(["deepseek.json"]),
      // Z.ai's API lists no Models: nothing is asked of it.
      "Z.ai": await provider([]),
      Minimax: await provider(["minimax.json"]),
      Kimi: await provider(["kimi.json"]),
    };
    const keys = {
      OpenRouter: "sk-or-v1-catalogueTestKey0123456789abcdef",
      DeepSeek: "sk-catalogueTestDeepSeek0123456789",
      "Z.ai": "catalogueTestZai0123456789abcdef.AbCdEf0123",
      Minimax: "eyJhbGciOiJSUzI1NiJ9.catalogueTestMinimax.c2ln",
      Kimi: "sk-catalogueTestKimi0123456789abcdef",
    };
    for (const aiProvider of Object.keys(fakes) as (keyof typeof fakes)[]) {
      await accounts.add({
        name: aiProvider,
        aiProvider,
        accountType: "api_key",
        credential: keys[aiProvider],
        endpointUrl: fakes[aiProvider].upstream.url,
      });
    }
    return { accounts, fakes, keys };
  }

  it("refreshes each from its AI Provider's list, and Z.ai's from its documented Models", async () => {
    const { accounts, fakes, keys } = await newKinds();
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
      now: () => fetchedAt,
    });
    const report = await catalogue.refresh();
    expect(report.failed).toEqual([]);
    expect(
      Object.fromEntries(
        report.refreshed.map(({ aiProvider, models }) => [aiProvider, models]),
      ),
    ).toEqual({ OpenRouter: 3, DeepSeek: 2, "Z.ai": 8, Minimax: 3, Kimi: 2 });

    const entries = await catalogue.list();
    // OpenRouter names every vendor's Models its own way, with a name to
    // show and a context length.
    expect(modelsOf(entries, "OpenRouter:api_key")).toEqual([
      "anthropic/claude-sonnet-4.5",
      "deepseek/deepseek-v4-pro",
      "openrouter/auto",
    ]);
    expect(entries).toContainEqual({
      aiProvider: "OpenRouter",
      accountType: "api_key",
      model: "anthropic/claude-sonnet-4.5",
      displayName: "Anthropic: Claude Sonnet 4.5",
      contextWindow: 1_000_000,
      fetchedAt,
    });
    // DeepSeek's context_window, Kimi's context_length; Minimax says none.
    expect(entries).toContainEqual({
      aiProvider: "DeepSeek",
      accountType: "api_key",
      model: "deepseek-flash",
      displayName: "DeepSeek-V4.1-Flash",
      contextWindow: 1_048_576,
      fetchedAt,
    });
    expect(entries).toContainEqual({
      aiProvider: "Kimi",
      accountType: "api_key",
      model: "kimi-k3",
      displayName: null,
      contextWindow: 1_048_576,
      fetchedAt,
    });
    expect(modelsOf(entries, "Minimax:api_key")).toEqual([
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3",
    ]);
    expect(entries).toContainEqual({
      aiProvider: "Minimax",
      accountType: "api_key",
      model: "MiniMax-M3",
      displayName: null,
      contextWindow: null,
      fetchedAt,
    });
    // Z.ai's, as it documents them.
    expect(modelsOf(entries, "Z.ai:api_key")).toEqual([
      "glm-4.6",
      "glm-4.7",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-flashx",
    ]);
    expect(entries).toContainEqual({
      aiProvider: "Z.ai",
      accountType: "api_key",
      model: "glm-5.3",
      displayName: "GLM-5.3",
      contextWindow: 1_000_000,
      fetchedAt,
    });
    expect(fakes["Z.ai"].upstream.received).toEqual([]);

    // Each list was asked for at its own path, with the account's key.
    for (const [aiProvider, name] of [
      ["OpenRouter", "openrouter.json"],
      ["DeepSeek", "deepseek.json"],
      ["Minimax", "minimax.json"],
      ["Kimi", "kimi.json"],
    ] as const) {
      const [received] = fakes[aiProvider].upstream.received;
      expect(received?.url).toBe(fixtures[name]?.request.path);
      expect(received?.headers.authorization).toBe(
        `Bearer ${keys[aiProvider]}`,
      );
    }
  });

  it("lists Z.ai's documented Models only while it has an unpaused account", async () => {
    const { accounts } = await newKinds();
    for (const account of await accounts.list()) {
      if (account.aiProvider === "Z.ai") {
        await accounts.update(account.id, { paused: true });
      }
    }
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
    });
    const report = await catalogue.refresh();
    expect(report.refreshed.map(({ aiProvider }) => aiProvider)).toEqual([
      "OpenRouter",
      "DeepSeek",
      "Minimax",
      "Kimi",
    ]);
  });
});

describe("the model catalogue of Qwen, Ollama and compatible endpoints", () => {
  const cloudKey = "0f1e2d3c4b5a69788796a5b4c3d2e1f0.catalogueOllamaCloud";
  const groqKey = "gsk_catalogueTestEndpoint0123456789abcdef";
  const litellmKey = "sk-catalogueTestLiteLLM0123456789abcdef";

  /** One account of each, each at its own fake; Qwen signed in. */
  async function newKinds() {
    const qwenOAuth = await startFakeOAuthServer({ qwen: true });
    oauthServers.push(qwenOAuth);
    const store = memoryAiAccountStore();
    const accounts: AiAccounts = createAiAccounts({
      store,
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      oauthProviders: { Qwen: qwenOAuth.provider },
    });
    const fakes = {
      ollama: await provider(["ollama.json"]),
      ollamaCloud: await provider(["ollama-cloud.json"]),
      groq: await provider(["openai-compatible.json"]),
      vllm: await provider(["openai-compatible-vllm.json"]),
      litellm: await provider(["anthropic-compatible.json"]),
      // Qwen's sign-in lists no Models: nothing is asked of it.
      qwen: await provider([]),
    };
    await accounts.add({
      name: "Ollama",
      aiProvider: "Ollama",
      accountType: "endpoint",
      endpointUrl: fakes.ollama.upstream.url,
    });
    await accounts.add({
      name: "Ollama Cloud",
      aiProvider: "Ollama",
      accountType: "api_key",
      credential: cloudKey,
      endpointUrl: fakes.ollamaCloud.upstream.url,
    });
    await accounts.add({
      name: "Groq",
      aiProvider: "OpenAI-compatible",
      accountType: "endpoint",
      credential: groqKey,
      endpointUrl: `${fakes.groq.upstream.url}/openai/v1`,
    });
    await accounts.add({
      name: "vLLM",
      aiProvider: "OpenAI-compatible",
      accountType: "endpoint",
      endpointUrl: `${fakes.vllm.upstream.url}/v1`,
    });
    await accounts.add({
      name: "LiteLLM",
      aiProvider: "Anthropic-compatible",
      accountType: "endpoint",
      credential: litellmKey,
      endpointUrl: `${fakes.litellm.upstream.url}/anthropic`,
    });
    qwenOAuth.resourceUrl = fakes.qwen.upstream.url;
    const login = await accounts.startLogin({
      name: "Qwen",
      aiProvider: "Qwen",
      acceptedTerms: true,
    });
    qwenOAuth.approve(login.userCode ?? "");
    await accounts.completeLogin(login.loginId, undefined);
    return { accounts, fakes };
  }

  it("refreshes each from its own list, every compatible endpoint's into one, and Qwen's from its documented Models", async () => {
    const { accounts, fakes } = await newKinds();
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
      now: () => fetchedAt,
    });
    const report = await catalogue.refresh();
    expect(report.failed).toEqual([]);
    expect(
      report.refreshed.map(
        ({ aiProvider, accountType, models }) =>
          `${aiProvider}:${accountType} ${String(models)}`,
      ),
    ).toEqual([
      "Ollama:endpoint 3",
      "Ollama:api_key 3",
      "OpenAI-compatible:endpoint 3",
      "Anthropic-compatible:endpoint 2",
      "Qwen:oauth 4",
    ]);
    const entries = await catalogue.list();
    expect(modelsOf(entries, "Ollama:endpoint")).toEqual([
      "gpt-oss:20b",
      "llama3.3:70b",
      "qwen3-coder:30b",
    ]);
    expect(modelsOf(entries, "Ollama:api_key")).toEqual([
      "deepseek-v3.1:671b",
      "gpt-oss:120b",
      "qwen3-coder:480b",
    ]);
    // Both endpoints' Models, each once, in the Owner's order, with
    // vLLM's context window.
    expect(modelsOf(entries, "OpenAI-compatible:endpoint")).toEqual([
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-120b",
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    ]);
    expect(entries).toContainEqual({
      aiProvider: "OpenAI-compatible",
      accountType: "endpoint",
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      displayName: null,
      contextWindow: 262_144,
      fetchedAt,
    });
    expect(entries).toContainEqual({
      aiProvider: "Anthropic-compatible",
      accountType: "endpoint",
      model: "my-coder-model",
      displayName: "My coder",
      contextWindow: null,
      fetchedAt,
    });
    expect(modelsOf(entries, "Qwen:oauth")).toEqual([
      "coder-model",
      "qwen3-coder-flash",
      "qwen3-coder-plus",
      "vision-model",
    ]);
    expect(fakes.qwen.upstream.received).toEqual([]);

    // Each asked at its own path, with its key; the Owner's own Ollama
    // and an endpoint without a key with none.
    const [ollama] = fakes.ollama.upstream.received;
    expect(ollama?.url).toBe("/v1/models");
    expect(ollama?.headers.authorization).toBeUndefined();
    expect(fakes.ollamaCloud.upstream.received[0]?.headers.authorization).toBe(
      `Bearer ${cloudKey}`,
    );
    const [groq] = fakes.groq.upstream.received;
    expect(groq?.url).toBe("/openai/v1/models");
    expect(groq?.headers.authorization).toBe(`Bearer ${groqKey}`);
    const [vllm] = fakes.vllm.upstream.received;
    expect(vllm?.url).toBe("/v1/models");
    expect(vllm?.headers.authorization).toBeUndefined();
    const [litellm] = fakes.litellm.upstream.received;
    expect(litellm?.url).toBe("/anthropic/v1/models?limit=1000");
    expect(litellm?.headers["x-api-key"]).toBe(litellmKey);
    expect(litellm?.headers.authorization).toBe(`Bearer ${litellmKey}`);
  });

  it("keeps a compatible endpoint's Models when another cannot be reached", async () => {
    const { accounts, fakes } = await newKinds();
    fakes.vllm.state.status = 503;
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
    });
    const report = await catalogue.refresh();
    expect(report.failed).toEqual([
      {
        aiProvider: "OpenAI-compatible",
        accountType: "endpoint",
        message: "The AI Provider's model list answered 503.",
      },
    ]);
    expect(
      modelsOf(await catalogue.list(), "OpenAI-compatible:endpoint"),
    ).toEqual(["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]);
  });
});

describe("a model list", () => {
  it("is read in each AI Provider's shape, skipping what is not a Model", () => {
    expect(
      modelsInList({
        data: [
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
          { id: "models/gemini-2.5-pro", input_token_limit: 1_048_576 },
          { id: "has a space" },
          { id: "" },
          { id: 42 },
          "not an object",
        ],
        has_more: true,
        last_id: "claude-opus-5-5",
      }),
    ).toEqual({
      models: [
        {
          model: "claude-opus-5-5",
          displayName: "Claude Opus 5.5",
          contextWindow: null,
        },
        {
          model: "gemini-2.5-pro",
          displayName: null,
          contextWindow: 1_048_576,
        },
      ],
      nextAfter: "claude-opus-5-5",
    });
    expect(
      modelsInList({ models: [{ slug: "gpt-5", context_window: 272_000 }] }),
    ).toEqual({
      models: [{ model: "gpt-5", displayName: null, contextWindow: 272_000 }],
      nextAfter: undefined,
    });
    for (const body of [undefined, [], { object: "list" }, "text"]) {
      expect(() => modelsInList(body)).toThrow(/model list/);
    }
  });
});

describe("the catalogue in Postgres 18", () => {
  postgresTest(
    "replaces one kind's Models, keeping the others",
    async ({ database }) => {
      const store = databaseModelCatalogueStore(database.db);
      const entry = (
        aiProvider: string,
        accountType: "api_key" | "oauth",
        model: string,
        contextWindow: number | null = null,
      ): CatalogueEntry => ({
        aiProvider,
        accountType,
        model,
        displayName: null,
        contextWindow,
        fetchedAt,
      });
      await store.replace("Claude", "api_key", [
        entry("Claude", "api_key", "claude-opus-5-5"),
        entry("Claude", "api_key", "claude-haiku-5-5"),
      ]);
      await store.replace("ChatGPT", "oauth", [
        entry("ChatGPT", "oauth", "gpt-5-codex", 272_000),
      ]);
      await store.replace("Claude", "api_key", [
        entry("Claude", "api_key", "claude-sonnet-5-5"),
      ]);
      expect(await store.list()).toEqual([
        entry("ChatGPT", "oauth", "gpt-5-codex", 272_000),
        entry("Claude", "api_key", "claude-sonnet-5-5"),
      ]);
      await store.replace("Claude", "api_key", []);
      expect((await store.list()).map(({ model }) => model)).toEqual([
        "gpt-5-codex",
      ]);
    },
  );
});
