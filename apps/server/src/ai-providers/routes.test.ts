import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createAiAccounts,
  createModelCatalogue,
  databaseModelCatalogueStore,
  memoryAiAccountStore,
  memoryModelCatalogueStore,
  type ModelCatalogueStore,
} from "@ai-office/gateway";
import { modelListFixture, type Fixture } from "@ai-office/gateway/testing";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  aiProviderListSchema,
  catalogueRefreshSchema,
  createRedactor,
} from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, testEncryptor } from "../test-support.ts";

// The AI Providers and the model catalogue through the API (PRD FR-15,
// FR-41): every AI Provider with its agent tool and default Model;
// the catalogue refreshed on demand from the AI Providers' recorded model
// lists; a default Model chosen only from it; and the Floor's Agents using
// it. Each case runs in memory and in Postgres 18.

const anthropicKey = "sk-ant-api03-providersRouteKey0123456789abcdefghij";
const xaiKey = "xai-providersRouteKey0123456789abcdefghijklmnopqrstuvwxyzAB";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A fake AI Provider answering its recorded model lists, by path. */
async function provider(names: readonly string[]): Promise<string> {
  const lists: Fixture[] = await Promise.all(names.map(modelListFixture));
  const server = createServer((request, response) => {
    const list = lists.find(({ request: { path } }) => path === request.url);
    response.writeHead(list?.response.status ?? 404, {
      "content-type": "application/json",
    });
    response.end(list?.response.body ?? "{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function setUp(
  stores: OfficeStores,
  catalogueStore: ModelCatalogueStore,
  bus: EventBus,
) {
  const logs: string[] = [];
  const redactor = createRedactor();
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const aiAccounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor: testEncryptor,
    events: bus,
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
    stores,
    github,
    aiAccounts,
    modelCatalogue: createModelCatalogue({
      store: catalogueStore,
      sources: () => aiAccounts.catalogueSources(),
    }),
  });
  const owner = await signIn(server);
  const send = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) =>
    server.inject({
      method,
      url,
      headers: owner.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  const providers = async () =>
    aiProviderListSchema.parse((await send("GET", "/api/ai-providers")).json())
      .aiProviders;
  return { aiAccounts, logs, send, providers };
}

type Setup = Awaited<ReturnType<typeof setUp>>;
type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "lists every AI Provider, with Claude's default Model and an empty catalogue",
    async ({ providers }) => {
      expect(await providers()).toEqual([
        {
          aiProvider: "Claude",
          agentTool: "Claude Code",
          defaultModel: "claude-opus-5-5",
          models: [],
          catalogueFetchedAt: null,
          hasAccount: false,
          catalogueError: null,
        },
        {
          aiProvider: "ChatGPT",
          agentTool: "Codex",
          defaultModel: null,
          models: [],
          catalogueFetchedAt: null,
          hasAccount: false,
          catalogueError: null,
        },
        {
          aiProvider: "Grok",
          agentTool: "opencode",
          defaultModel: null,
          models: [],
          catalogueFetchedAt: null,
          hasAccount: false,
          catalogueError: null,
        },
        ...[
          "Gemini",
          "OpenRouter",
          "DeepSeek",
          "Z.ai",
          "Minimax",
          "Kimi",
          "Qwen",
          "Ollama",
        ].map((aiProvider) => ({
          aiProvider,
          agentTool: "opencode",
          defaultModel: null,
          models: [],
          catalogueFetchedAt: null,
          hasAccount: false,
          catalogueError: null,
        })),
        {
          aiProvider: "Anthropic-compatible",
          agentTool: "Claude Code",
          defaultModel: null,
          models: [],
          catalogueFetchedAt: null,
          hasAccount: false,
          catalogueError: null,
        },
        {
          aiProvider: "OpenAI-compatible",
          agentTool: "opencode",
          defaultModel: null,
          models: [],
          catalogueFetchedAt: null,
          hasAccount: false,
          catalogueError: null,
        },
      ]);
    },
  ],
  [
    "says which AI Providers have an AI Account and why their Models could not be fetched, and gives one with Models its default",
    async ({ aiAccounts, send, providers }) => {
      await aiAccounts.add({
        name: "xAI",
        aiProvider: "Grok",
        accountType: "api_key",
        credential: xaiKey,
        endpointUrl: await provider(["xai.json"]),
      });
      await aiAccounts.add({
        name: "Anthropic",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: anthropicKey,
        // Lists nothing: every path answers 404.
        endpointUrl: await provider([]),
      });
      await send("POST", "/api/model-catalogue/refresh");
      const listed = Object.fromEntries(
        (await providers()).map((entry) => [entry.aiProvider, entry]),
      );
      expect(listed["Claude"]).toMatchObject({
        hasAccount: true,
        catalogueError: "The AI Provider's model list answered 404.",
      });
      // As the daily refresh does, the first Model it lists.
      expect(listed["Grok"]).toMatchObject({
        hasAccount: true,
        catalogueError: null,
        defaultModel: listed["Grok"]?.models[0]?.model,
      });
      expect(listed["Grok"]?.defaultModel).toEqual(expect.any(String));
      expect(listed["ChatGPT"]).toMatchObject({
        hasAccount: false,
        catalogueError: null,
        defaultModel: null,
      });
    },
  ],
  [
    "refreshes the catalogue on demand, then sets a default Model only from it",
    async ({ aiAccounts, send, providers, logs }) => {
      await aiAccounts.add({
        name: "Anthropic",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: anthropicKey,
        endpointUrl: await provider([
          "anthropic.json",
          "anthropic-page-2.json",
        ]),
      });
      await aiAccounts.add({
        name: "xAI",
        aiProvider: "Grok",
        accountType: "api_key",
        credential: xaiKey,
        endpointUrl: await provider(["xai.json"]),
      });
      // Nothing is in the catalogue yet: a default can still be typed in.
      const early = await send("PUT", "/api/ai-providers/Grok", {
        defaultModel: "grok-4",
      });
      expect(early.statusCode).toBe(204);

      const refreshed = await send("POST", "/api/model-catalogue/refresh");
      expect(refreshed.statusCode).toBe(200);
      expect(catalogueRefreshSchema.parse(refreshed.json())).toEqual({
        refreshed: [
          { aiProvider: "Claude", accountType: "api_key", models: 4 },
          { aiProvider: "Grok", accountType: "api_key", models: 3 },
        ],
        failed: [],
      });
      const [claude, chatgpt, grok] = await providers();
      expect(claude?.models.map(({ model }) => model)).toEqual([
        "claude-fable-5-1",
        "claude-haiku-5-5",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
      ]);
      expect(claude?.models[2]).toEqual({
        model: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        contextWindow: null,
        accountTypes: ["api_key"],
      });
      expect(claude?.catalogueFetchedAt).not.toBeNull();
      expect(grok?.models.map(({ model }) => model)).toEqual([
        "grok-4",
        "grok-4-fast-reasoning",
        "grok-code-fast-1",
      ]);
      expect(chatgpt?.models).toEqual([]);

      expect(
        (
          await send("PUT", "/api/ai-providers/Grok", {
            defaultModel: "grok-code-fast-1",
          })
        ).statusCode,
      ).toBe(204);
      expect((await providers())[2]?.defaultModel).toBe("grok-code-fast-1");

      // Another AI Provider's Model, an unknown AI Provider, a bad body.
      const other = await send("PUT", "/api/ai-providers/Grok", {
        defaultModel: "claude-opus-5-5",
      });
      expect(other.statusCode).toBe(400);
      expect(other.json()).toMatchObject({ error: "model_not_in_catalogue" });
      const unknown = await send("PUT", "/api/ai-providers/Jev", {
        defaultModel: "grok-4",
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: "ai_provider_not_found" });
      for (const payload of [
        {},
        { defaultModel: "" },
        { defaultModel: "grok-4", extra: 1 },
        // Jev is the Decision Model only, never an Agent's (FR-17).
        { defaultModel: "typesafe/jev-1.13" },
      ]) {
        expect(
          (await send("PUT", "/api/ai-providers/Grok", payload)).statusCode,
        ).toBe(400);
      }
      expect((await providers())[2]?.defaultModel).toBe("grok-code-fast-1");
      for (const key of [anthropicKey, xaiKey]) {
        expect(logs.join("\n")).not.toContain(key);
      }
    },
  ],
  [
    "lists OpenRouter's, DeepSeek's, Z.ai's, Minimax's and Kimi's Models, and sets each a default from them",
    async ({ aiAccounts, send, providers, logs }) => {
      const keys = {
        OpenRouter: "sk-or-v1-providersRouteKey0123456789abcdef",
        DeepSeek: "sk-providersRouteDeepSeek0123456789",
        "Z.ai": "providersRouteZai0123456789abcdef.AbCdEf0123",
        Minimax: "eyJhbGciOiJSUzI1NiJ9.providersRouteMinimax.c2ln",
        Kimi: "sk-providersRouteKimi0123456789abcdef",
      };
      const lists = {
        OpenRouter: ["openrouter.json"],
        DeepSeek: ["deepseek.json"],
        // Z.ai's API lists none: its documented Models are its catalogue.
        "Z.ai": [],
        Minimax: ["minimax.json"],
        Kimi: ["kimi.json"],
      };
      for (const aiProvider of Object.keys(keys) as (keyof typeof keys)[]) {
        await aiAccounts.add({
          name: aiProvider,
          aiProvider,
          accountType: "api_key",
          credential: keys[aiProvider],
          endpointUrl: await provider(lists[aiProvider]),
        });
      }
      const refreshed = await send("POST", "/api/model-catalogue/refresh");
      expect(catalogueRefreshSchema.parse(refreshed.json())).toEqual({
        refreshed: [
          { aiProvider: "OpenRouter", accountType: "api_key", models: 3 },
          { aiProvider: "DeepSeek", accountType: "api_key", models: 2 },
          { aiProvider: "Z.ai", accountType: "api_key", models: 8 },
          { aiProvider: "Minimax", accountType: "api_key", models: 3 },
          { aiProvider: "Kimi", accountType: "api_key", models: 2 },
        ],
        failed: [],
      });
      const listed = Object.fromEntries(
        (await providers()).map((entry) => [entry.aiProvider, entry]),
      );
      // OpenRouter's Claude is OpenRouter's, not Claude's.
      expect(listed["OpenRouter"]?.models.map(({ model }) => model)).toEqual([
        "anthropic/claude-sonnet-4.5",
        "deepseek/deepseek-v4-pro",
        "openrouter/auto",
      ]);
      expect(listed["Claude"]?.models).toEqual([]);
      expect(listed["OpenRouter"]?.models[0]).toEqual({
        model: "anthropic/claude-sonnet-4.5",
        displayName: "Anthropic: Claude Sonnet 4.5",
        contextWindow: 1_000_000,
        accountTypes: ["api_key"],
      });
      expect(listed["DeepSeek"]?.models.map(({ model }) => model)).toEqual([
        "deepseek-flash",
        "deepseek-v4-pro",
      ]);
      expect(listed["Z.ai"]?.models).toHaveLength(8);
      expect(listed["Minimax"]?.models).toHaveLength(3);
      expect(listed["Kimi"]?.models.map(({ model }) => model)).toEqual([
        "kimi-k2.7-code",
        "kimi-k3",
      ]);
      for (const entry of Object.values(listed)) {
        expect(entry.agentTool).toBe(
          entry.aiProvider === "Claude" ||
            entry.aiProvider === "Anthropic-compatible"
            ? "Claude Code"
            : entry.aiProvider === "ChatGPT"
              ? "Codex"
              : "opencode",
        );
      }

      const defaults = {
        OpenRouter: "anthropic/claude-sonnet-4.5",
        DeepSeek: "deepseek-v4-pro",
        "Z.ai": "glm-5.3",
        Minimax: "MiniMax-M3",
        Kimi: "kimi-k3",
      };
      for (const [aiProvider, defaultModel] of Object.entries(defaults)) {
        const set = await send(
          "PUT",
          `/api/ai-providers/${encodeURIComponent(aiProvider)}`,
          { defaultModel },
        );
        expect(set.statusCode, aiProvider).toBe(204);
      }
      expect(
        Object.fromEntries(
          (await providers())
            .filter(({ aiProvider }) => aiProvider in defaults)
            .map(({ aiProvider, defaultModel }) => [aiProvider, defaultModel]),
        ),
      ).toEqual(defaults);
      // Another AI Provider's Model is not in its catalogue.
      const other = await send("PUT", "/api/ai-providers/Kimi", {
        defaultModel: "glm-5.3",
      });
      expect(other.json()).toMatchObject({ error: "model_not_in_catalogue" });
      for (const key of Object.values(keys)) {
        expect(logs.join("\n")).not.toContain(key);
      }
    },
  ],
  [
    "lists Ollama's and compatible endpoints' Models, each as its own, and sets each a default from them",
    async ({ aiAccounts, send, providers }) => {
      await aiAccounts.add({
        name: "Ollama",
        aiProvider: "Ollama",
        accountType: "endpoint",
        endpointUrl: await provider(["ollama.json"]),
      });
      await aiAccounts.add({
        name: "Groq",
        aiProvider: "OpenAI-compatible",
        accountType: "endpoint",
        credential: "gsk_providersRouteEndpoint0123456789",
        endpointUrl: `${await provider(["openai-compatible.json"])}/openai/v1`,
      });
      await aiAccounts.add({
        name: "LiteLLM",
        aiProvider: "Anthropic-compatible",
        accountType: "endpoint",
        endpointUrl: `${await provider(["anthropic-compatible.json"])}/anthropic`,
      });
      const refreshed = await send("POST", "/api/model-catalogue/refresh");
      expect(catalogueRefreshSchema.parse(refreshed.json()).failed).toEqual([]);
      const listed = Object.fromEntries(
        (await providers()).map((entry) => [
          entry.aiProvider,
          entry.models.map(({ model }) => model),
        ]),
      );
      expect(listed["Ollama"]).toEqual([
        "gpt-oss:20b",
        "llama3.3:70b",
        "qwen3-coder:30b",
      ]);
      // A compatible endpoint's Models are its own, though one is named as
      // OpenRouter's and another as Z.ai's: it is sent them all.
      expect(listed["OpenAI-compatible"]).toEqual([
        "llama-3.3-70b-versatile",
        "openai/gpt-oss-120b",
      ]);
      expect(listed["Anthropic-compatible"]).toEqual([
        "glm-4.6",
        "my-coder-model",
      ]);
      expect(listed["OpenRouter"]).toEqual([]);
      expect(listed["Z.ai"]).toEqual([]);
      const defaults = {
        Ollama: "qwen3-coder:30b",
        "OpenAI-compatible": "openai/gpt-oss-120b",
        "Anthropic-compatible": "glm-4.6",
      };
      for (const [aiProvider, defaultModel] of Object.entries(defaults)) {
        const set = await send(
          "PUT",
          `/api/ai-providers/${encodeURIComponent(aiProvider)}`,
          { defaultModel },
        );
        expect(set.statusCode, aiProvider).toBe(204);
      }
      expect(
        Object.fromEntries(
          (await providers())
            .filter(({ aiProvider }) => aiProvider in defaults)
            .map(({ aiProvider, defaultModel }) => [aiProvider, defaultModel]),
        ),
      ).toEqual(defaults);
    },
  ],
  [
    "gives a Floor's Agents their AI Provider's default Model as the Owner chose it",
    async ({ aiAccounts, send }) => {
      await aiAccounts.add({
        name: "Anthropic",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: anthropicKey,
        endpointUrl: await provider([
          "anthropic.json",
          "anthropic-page-2.json",
        ]),
      });
      await send("POST", "/api/model-catalogue/refresh");
      expect(
        (
          await send("PUT", "/api/ai-providers/Claude", {
            defaultModel: "claude-sonnet-5-5",
          })
        ).statusCode,
      ).toBe(204);
      await send("POST", "/api/floors", { repository: "adrianeyre/web-shop" });
      const { agents } = agentListSchema.parse(
        (await send("GET", "/api/floors/web-shop/agents")).json(),
      );
      expect(agents.map(({ model }) => model)).toEqual(
        Array(4).fill("claude-sonnet-5-5"),
      );
    },
  ],
];

describe("AI Providers through the API, kept in memory", () => {
  it.each(cases)("%s", async (_name, run) => {
    await run(
      await setUp(
        memoryStores(),
        memoryModelCatalogueStore(),
        createEventBus({ store: memoryEventStore() }),
      ),
    );
  });
});

describe("AI Providers through the API, in Postgres 18", () => {
  postgresTest.for(cases)("%s", async ([, run], { database }) => {
    await run(
      await setUp(
        databaseStores(database.db),
        databaseModelCatalogueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      ),
    );
  });
});
