import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createAiAccounts,
  createModelMappings,
  databaseAiAccountStore,
  databaseModelMappingStore,
  memoryAiAccountStore,
  memoryModelMappingStore,
  type AiAccounts,
  type AiAccountStore,
  type ModelMappingStore,
} from "@ai-office/gateway";
import {
  aiAccountListSchema,
  aiAccountSchema,
  apiErrorSchema,
  modelMappingListSchema,
  modelMappingSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The model mappings API, and an AI Account's forced Model and extra
// usage (PRD FR-41): the Owner's aliases and mappings are listed, added,
// changed and deleted, and apply to the AI Accounts at once. Each case
// runs in memory and in Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  readonly aiAccounts: AiAccounts;
  readonly claude: string;
}

async function setUp(
  accountStore: AiAccountStore,
  store: ModelMappingStore,
  bus: EventBus,
): Promise<Setup> {
  const auth = await testAuth();
  let time = Date.parse("2026-10-10T12:00:00.000Z");
  const now = () => new Date((time += 1000));
  const modelMappings = createModelMappings({ store, events: bus, now });
  const aiAccounts = createAiAccounts({
    store: accountStore,
    encryptor: auth.encryptor,
    events: bus,
    now,
    modelMappings,
  });
  const claude = await aiAccounts.add({
    name: "Claude key",
    aiProvider: "Claude",
    accountType: "api_key",
    credential: "sk-ant-api03-mapping-routes-0123456789",
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth,
    events: bus,
    aiAccounts,
    modelMappings,
  });
  return {
    server,
    owner: await signIn(server),
    bus,
    aiAccounts,
    claude: claude.id,
  };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const list = async (setup: Setup) =>
  modelMappingListSchema.parse(
    (await request(setup, "GET", "/api/gateway/model-mappings")).json(),
  ).mappings;

/** The Model a request for `model` is sent. */
const sentFor = async (setup: Setup, model: string) => {
  const chosen = await setup.aiAccounts.select({ agentTool: null, model });
  return chosen?.model ?? model;
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds a mapping, changes it and deletes it, each applying at once",
    async (setup) => {
      expect(await list(setup)).toEqual([]);
      const added = await request(
        setup,
        "POST",
        "/api/gateway/model-mappings",
        {
          from: "opus",
          to: "claude-opus-5-5",
          aiProvider: null,
          accountType: null,
        },
      );
      expect(added.statusCode).toBe(201);
      const alias = modelMappingSchema.parse(added.json());
      expect(alias).toMatchObject({
        from: "opus",
        to: "claude-opus-5-5",
        aiProvider: null,
        accountType: null,
      });
      expect(await list(setup)).toEqual([alias]);
      expect(await sentFor(setup, "opus")).toBe("claude-opus-5-5");

      // Claude API keys map the alias's Model to Sonnet.
      const forKeys = await request(
        setup,
        "POST",
        "/api/gateway/model-mappings",
        {
          from: "claude-opus-5-5",
          to: "claude-sonnet-5-5",
          aiProvider: "Claude",
          accountType: "api_key",
        },
      );
      expect(forKeys.statusCode).toBe(201);
      const mapping = modelMappingSchema.parse(forKeys.json());
      expect(await sentFor(setup, "opus")).toBe("claude-sonnet-5-5");

      const changed = await request(
        setup,
        "PUT",
        `/api/gateway/model-mappings/${mapping.id}`,
        {
          from: "claude-opus-5-5",
          to: "claude-haiku-5-5",
          aiProvider: "Claude",
          accountType: "api_key",
        },
      );
      expect(changed.statusCode).toBe(200);
      expect(modelMappingSchema.parse(changed.json())).toMatchObject({
        id: mapping.id,
        to: "claude-haiku-5-5",
      });
      expect(await sentFor(setup, "opus")).toBe("claude-haiku-5-5");

      // The Claude account's own forced Model comes first.
      const forced = await request(
        setup,
        "PATCH",
        `/api/ai-accounts/${setup.claude}`,
        { forcedModel: "claude-sonnet-4-5" },
      );
      expect(forced.statusCode).toBe(200);
      expect(aiAccountSchema.parse(forced.json())).toMatchObject({
        forcedModel: "claude-sonnet-4-5",
        // An API key offers no extra usage.
        extraUsage: null,
      });
      expect(await sentFor(setup, "opus")).toBe("claude-sonnet-4-5");
      await request(setup, "PATCH", `/api/ai-accounts/${setup.claude}`, {
        forcedModel: null,
      });

      const deleted = await request(
        setup,
        "DELETE",
        `/api/gateway/model-mappings/${mapping.id}`,
      );
      expect(deleted.statusCode).toBe(204);
      expect(await list(setup)).toEqual([alias]);
      expect(await sentFor(setup, "opus")).toBe("claude-opus-5-5");
      const gone = await request(
        setup,
        "DELETE",
        `/api/gateway/model-mappings/${mapping.id}`,
      );
      expect(gone.statusCode).toBe(404);
      expect(apiErrorSchema.parse(gone.json()).error).toBe(
        "model_mapping_not_found",
      );

      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .flatMap((event) =>
            event.type === "config.changed" ? [event.keys] : [],
          ),
      ).toEqual(
        expect.arrayContaining([
          ["modelMappings.added"],
          ["modelMappings.changed"],
          ["modelMappings.deleted"],
          ["aiAccounts.forcedModel"],
        ]),
      );
    },
  ],
  [
    "refuses a mapping that does not make sense, saying why",
    async (setup) => {
      const refused = async (
        method: "POST" | "PUT",
        url: string,
        payload: object,
      ) => {
        const response = await request(setup, method, url, payload);
        return {
          status: response.statusCode,
          ...apiErrorSchema.parse(response.json()),
        };
      };
      const url = "/api/gateway/model-mappings";
      expect(
        await refused("POST", url, {
          from: "opus",
          to: "gpt-5-codex",
          aiProvider: "Claude",
          accountType: "oauth",
        }),
      ).toMatchObject({ status: 400, error: "invalid_request" });
      expect(
        await refused("POST", url, {
          from: "opus",
          to: "claude-opus-5-5",
          aiProvider: "Claude",
        }),
      ).toMatchObject({ status: 400, error: "invalid_request" });
      expect(
        await refused("POST", url, {
          from: "opus",
          to: "opus",
          aiProvider: null,
          accountType: null,
        }),
      ).toMatchObject({ status: 400, error: "invalid_request" });

      const alias = {
        from: "opus",
        to: "claude-opus-5-5",
        aiProvider: null,
        accountType: null,
      };
      expect((await request(setup, "POST", url, alias)).statusCode).toBe(201);
      expect(await refused("POST", url, alias)).toEqual({
        status: 409,
        error: "model_mapping_taken",
        message: "opus is already mapped as an alias.",
      });
      expect(await refused("PUT", `${url}/nonexistent`, alias)).toMatchObject({
        status: 404,
        error: "model_mapping_not_found",
      });
      expect(await list(setup)).toHaveLength(1);
    },
  ],
  [
    "refuses a forced Model of another AI Provider, and extra usage where none is offered",
    async (setup) => {
      const patch = async (payload: object) => {
        const response = await request(
          setup,
          "PATCH",
          `/api/ai-accounts/${setup.claude}`,
          payload,
        );
        return {
          status: response.statusCode,
          ...apiErrorSchema.parse(response.json()),
        };
      };
      expect(await patch({ forcedModel: "grok-4" })).toEqual({
        status: 400,
        error: "forced_model_mismatch",
        message: "grok-4 is Grok's, but Claude key is a Claude account.",
      });
      expect(await patch({ extraUsage: true })).toEqual({
        status: 400,
        error: "extra_usage_not_offered",
        message: "Claude offers no extra usage for this kind of AI Account.",
      });
      expect(await patch({ forcedModel: "has a space" })).toMatchObject({
        status: 400,
        error: "invalid_request",
      });
      const [account] = aiAccountListSchema.parse(
        (await request(setup, "GET", "/api/ai-accounts")).json(),
      ).accounts;
      expect(account).toMatchObject({ forcedModel: null, extraUsage: null });
    },
  ],
];

describe("the model mappings API, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryAiAccountStore(),
          memoryModelMappingStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the model mappings API, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseAiAccountStore(database.db),
          databaseModelMappingStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});
