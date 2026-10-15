import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createAiAccounts,
  createRequestHistory,
  credentialContext,
  databaseAiAccountStore,
  memoryAiAccountStore,
  memoryRequestHistoryStore,
  type AiAccounts,
  type AiAccountStore,
} from "@ai-office/gateway";
import {
  aiAccountListSchema,
  aiAccountSchema,
  apiErrorSchema,
  usageHistorySchema,
  createRedactor,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  type SignedIn,
} from "../test-support.ts";

// The AI Accounts API (PRD FR-35, FR-36): adding a key-based account,
// renaming, reprioritising, pausing, resuming and deleting it. Its
// credential is stored sealed, and no answer, event or log line ever
// carries it. Each case runs in memory and in Postgres 18.

// Not shaped like an Anthropic key, so only its registration can redact it
// from logs, and a test that finds it anywhere means it really leaked.
const credential = "console-account-key-7d1e4b9a3c5f0e2d8b6a";
const otherCredential = "console-account-key-0a9b8c7d6e5f4a3b2c1d";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly accounts: AiAccounts;
  readonly store: AiAccountStore;
  readonly bus: EventBus;
  /** Every log line the server wrote. */
  readonly logs: string[];
}

async function setUp(store: AiAccountStore, bus: EventBus): Promise<Setup> {
  const logs: string[] = [];
  const redactor = createRedactor();
  let tick = 0;
  const accounts = createAiAccounts({
    store,
    encryptor: testEncryptor,
    events: bus,
    onCredential: (value) => {
      redactor.register(value);
    },
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
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
  return { server, owner: await signIn(server), accounts, store, bus, logs };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const work = {
  name: "Work",
  aiProvider: "Claude",
  accountType: "api_key",
  credential,
};

/** Adds `body` through the API, and answers with what the API sent back. */
const add = async (setup: Setup, body: object = work) => {
  const response = await request(setup, "POST", "/api/ai-accounts", body);
  expect(response.statusCode).toBe(201);
  await expectNoCredential(setup, [response.body]);
  return aiAccountSchema.parse(response.json());
};

const list = async (setup: Setup) => {
  const response = await request(setup, "GET", "/api/ai-accounts");
  expect(response.statusCode).toBe(200);
  return aiAccountListSchema.parse(response.json()).accounts;
};

/** Nothing the server sent, published or logged holds a credential. */
const expectNoCredential = async (setup: Setup, bodies: string[]) => {
  const everything = [
    ...bodies,
    JSON.stringify(await setup.bus.eventsAfter(0)),
    ...setup.logs,
  ].join("\n");
  expect(everything).not.toContain(credential);
  expect(everything).not.toContain(otherCredential);
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds an account, stores its credential sealed, and never returns it",
    async (setup) => {
      const response = await request(setup, "POST", "/api/ai-accounts", {
        ...work,
        endpointUrl: "https://llm-proxy.example/anthropic",
      });
      expect(response.statusCode).toBe(201);
      const added = aiAccountSchema.parse(response.json());
      // Exactly these fields: nothing of the credential, not even a hint.
      expect(response.json()).toEqual({
        id: added.id,
        name: "Work",
        aiProvider: "Claude",
        accountType: "api_key",
        endpointUrl: "https://llm-proxy.example/anthropic",
        region: null,
        projectId: null,
        priority: 1,
        paused: false,
        tokenHealth: null,
        tokenExpiresAt: null,
        reauthenticationNeeded: false,
        limitReason: null,
        limitedUntil: null,
        usage: { fiveHour: null, weekly: null },
        fiveHourPauseThreshold: null,
        weeklyPauseThreshold: null,
        // No forced Model; an API key offers no extra usage (FR-41).
        forcedModel: null,
        extraUsage: null,
        rateLimits: null,
        balance: null,
        createdAt: "2026-10-09T12:00:00.000Z",
        updatedAt: "2026-10-09T12:00:00.000Z",
      });

      const stored = await setup.store.get(added.id);
      expect(stored?.credential).toMatch(/^aio1:/);
      expect(stored?.credential).not.toContain(credential);
      expect(
        testEncryptor.decrypt(
          stored?.credential ?? "",
          credentialContext(added.id),
        ),
      ).toBe(credential);

      const listed = await request(setup, "GET", "/api/ai-accounts");
      // Listed with its share of the Gateway's tokens today: none yet.
      expect(listed.json()).toEqual({
        accounts: [
          {
            ...response.json<object>(),
            tokensToday: { tokens: 0, gatewayTokens: 0 },
          },
        ],
      });

      // The Gateway opens it to forward a request; still nothing leaks.
      expect((await setup.accounts.select({ agentTool: null }))?.apiKey).toBe(
        credential,
      );
      await expectNoCredential(setup, [response.body, listed.body]);
    },
  ],
  [
    "renames, reprioritises, pauses, resumes and deletes an account",
    async (setup) => {
      const first = await add(setup);
      const second = await add(setup, {
        ...work,
        name: "Personal",
        credential: otherCredential,
      });
      expect(second.priority).toBe(2);
      const bodies: string[] = [];
      const patch = async (id: string, body: object) => {
        const response = await request(
          setup,
          "PATCH",
          `/api/ai-accounts/${id}`,
          body,
        );
        bodies.push(response.body);
        expect(response.statusCode).toBe(200);
        return aiAccountSchema.parse(response.json());
      };

      expect(
        await patch(first.id, { name: "Work (team)", priority: 3 }),
      ).toMatchObject({ name: "Work (team)", priority: 3 });
      expect((await list(setup)).map(({ name }) => name)).toEqual([
        "Personal",
        "Work (team)",
      ]);
      expect(await patch(second.id, { paused: true })).toMatchObject({
        paused: true,
      });
      expect((await setup.accounts.select({ agentTool: null }))?.name).toBe(
        "Work (team)",
      );
      expect(await patch(second.id, { paused: false })).toMatchObject({
        paused: false,
      });
      expect((await setup.accounts.select({ agentTool: null }))?.name).toBe(
        "Personal",
      );

      const deleted = await request(
        setup,
        "DELETE",
        `/api/ai-accounts/${second.id}`,
      );
      expect(deleted.statusCode).toBe(204);
      expect((await list(setup)).map(({ id }) => id)).toEqual([first.id]);
      expect(await setup.store.get(second.id)).toBeUndefined();

      const changes = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter((event) => event.type === "config.changed");
      expect(changes.map((event) => [event.scope, event.keys])).toEqual([
        ["gateway", ["aiAccounts.added"]],
        ["gateway", ["aiAccounts.added"]],
        ["gateway", ["aiAccounts.name", "aiAccounts.priority"]],
        ["gateway", ["aiAccounts.paused"]],
        ["gateway", ["aiAccounts.paused"]],
        ["gateway", ["aiAccounts.deleted"]],
      ]);
      await expectNoCredential(setup, bodies);
    },
  ],
  [
    "shows why the AI Gateway holds an account back, until its limit runs out",
    async (setup) => {
      const added = await add(setup);
      const listed = async () =>
        aiAccountListSchema.parse(
          (await request(setup, "GET", "/api/ai-accounts")).json(),
        ).accounts[0];
      const until = new Date(Date.now() + 60 * 60 * 1000);
      await setup.store.update(added.id, {
        limitReason: "rate_limited",
        limitedUntil: until,
        updatedAt: new Date(),
      });
      expect(await listed()).toMatchObject({
        limitReason: "rate_limited",
        limitedUntil: until.toISOString(),
      });
      // Once its time has passed it is not held back, even before the
      // minute's check lifts it.
      await setup.store.update(added.id, {
        limitReason: "circuit_open",
        limitedUntil: new Date(Date.now() - 1000),
        updatedAt: new Date(),
      });
      expect(await listed()).toMatchObject({
        limitReason: null,
        limitedUntil: null,
      });
    },
  ],
  [
    "sets usage pause thresholds, shows usage and its history, and force-resets",
    async (setup) => {
      const added = await add(setup);
      const url = `/api/ai-accounts/${added.id}`;
      const set = await request(setup, "PATCH", url, {
        fiveHourPauseThreshold: 80,
        weeklyPauseThreshold: 95,
      });
      expect(set.statusCode).toBe(200);
      expect(aiAccountSchema.parse(set.json())).toMatchObject({
        fiveHourPauseThreshold: 80,
        weeklyPauseThreshold: 95,
        usage: { fiveHour: null, weekly: null },
      });
      for (const payload of [
        { fiveHourPauseThreshold: 0 },
        { weeklyPauseThreshold: 101 },
        { fiveHourPauseThreshold: 50.5 },
      ]) {
        expect(
          (await request(setup, "PATCH", url, payload)).statusCode,
          JSON.stringify(payload),
        ).toBe(400);
      }

      // The Gateway hears the account's windows in an answer.
      const resetsAt = new Date(Date.now() + 60 * 60 * 1000);
      const account = await setup.accounts.select({
        agentTool: null,
        forcedAccount: added.id,
      });
      if (account === undefined) {
        throw new Error("The account cannot be selected.");
      }
      await setup.accounts.report(
        account,
        { kind: "served" },
        { five_hour: { utilization: 85, resetsAt } },
      );
      expect((await list(setup))[0]).toMatchObject({
        usage: {
          fiveHour: { utilization: 85, resetsAt: resetsAt.toISOString() },
          weekly: null,
        },
        limitReason: "usage_threshold",
        limitedUntil: resetsAt.toISOString(),
      });
      const history = await request(setup, "GET", `${url}/usage`);
      expect(history.statusCode).toBe(200);
      expect(usageHistorySchema.parse(history.json()).usage).toEqual([
        {
          window: "five_hour",
          utilization: 85,
          resetsAt: resetsAt.toISOString(),
          observedAt: expect.any(String) as unknown,
        },
      ]);

      const reset = await request(setup, "POST", `${url}/reset-limits`);
      expect(reset.statusCode).toBe(200);
      expect(aiAccountSchema.parse(reset.json())).toMatchObject({
        usage: { fiveHour: null, weekly: null },
        limitReason: null,
        fiveHourPauseThreshold: 80,
      });

      const missing = "/api/ai-accounts/00000000-0000-4000-8000-000000000000";
      for (const response of [
        await request(setup, "POST", `${missing}/reset-limits`),
        await request(setup, "GET", `${missing}/usage`),
      ]) {
        expect(response.statusCode).toBe(404);
      }
    },
  ],
  [
    "refuses a malformed account without echoing what was sent",
    async (setup) => {
      const refused = async (body: object) => {
        const response = await request(setup, "POST", "/api/ai-accounts", body);
        expect(response.statusCode).toBe(400);
        return apiErrorSchema.parse(response.json());
      };
      const withSpace = `${credential} ${otherCredential}`;
      expect(await refused({ ...work, credential: withSpace })).toEqual({
        error: "invalid_request",
        problems: ["An API key has no spaces in it."],
      });
      expect((await refused({ ...work, credential: "" })).problems).toEqual([
        "Enter the API key.",
      ]);
      expect(
        (
          await refused({
            ...work,
            endpointUrl: `https://me:${otherCredential}@llm-proxy.example`,
          })
        ).problems,
      ).toEqual([
        "Leave credentials out of the endpoint URL; the key goes in its own field.",
      ]);
      expect(
        (await refused({ ...work, aiProvider: "ChatGPT" })).problems,
      ).toEqual([
        "Only Claude, Grok, Gemini, OpenRouter, DeepSeek, Z.ai, Minimax, Kimi and Ollama API keys can be added so far.",
      ]);
      expect(
        (await refused({ ...work, accountType: "oauth" })).problems,
      ).toEqual([
        "Add an API key, an endpoint, an AWS Bedrock or a Google Vertex AI account here; a subscription signs in instead.",
      ]);
      expect((await refused({ ...work, priority: 0 })).problems).toEqual([
        "The priority is at least 1.",
      ]);
      expect(await list(setup)).toEqual([]);
      await expectNoCredential(setup, []);
    },
  ],
  [
    "refuses a second account of one name, and an unknown account",
    async (setup) => {
      const first = await add(setup);
      const second = await request(setup, "POST", "/api/ai-accounts", {
        ...work,
        credential: otherCredential,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: "ai_account_name_taken" });

      const missing = "00000000-0000-4000-8000-000000000000";
      for (const response of [
        await request(setup, "PATCH", `/api/ai-accounts/${missing}`, {
          paused: true,
        }),
        await request(setup, "DELETE", `/api/ai-accounts/${missing}`),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({
          error: "ai_account_not_found",
        });
      }
      const empty = await request(
        setup,
        "PATCH",
        `/api/ai-accounts/${first.id}`,
        {},
      );
      expect(empty.statusCode).toBe(400);
      expect((await list(setup)).map(({ id }) => id)).toEqual([first.id]);
      await expectNoCredential(setup, [second.body]);
    },
  ],
];

describe("the AI Accounts API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryAiAccountStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the AI Accounts API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseAiAccountStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});

describe("the AI Accounts API's access", () => {
  it("needs a session, and the CSRF token to change anything", async () => {
    const setup = await setUp(
      memoryAiAccountStore(),
      createEventBus({ store: memoryEventStore() }),
    );
    const signedOut = await setup.server.inject({
      method: "GET",
      url: "/api/ai-accounts",
    });
    expect(signedOut.statusCode).toBe(401);
    const withoutCsrf = await setup.server.inject({
      method: "POST",
      url: "/api/ai-accounts",
      headers: { cookie: setup.owner.cookie },
      payload: work,
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(await list(setup)).toEqual([]);
  });
});

describe("each AI Account's usage beyond its usage windows", () => {
  it("lists its rate limits (full again once reset), its credit, and its share of the Gateway's tokens today", async () => {
    const store = memoryAiAccountStore();
    const accounts = createAiAccounts({
      store,
      encryptor: testEncryptor,
      events: createEventBus({ store: memoryEventStore() }),
    });
    const history = createRequestHistory({
      store: memoryRequestHistoryStore(),
      encryptor: testEncryptor,
    });
    const now = new Date();
    const server = await buildApp({
      logger: createLogger({ level: "silent", secrets: [] }),
      checkDatabase: () => Promise.resolve(true),
      webDistDir: "/nonexistent",
      auth: await testAuth(),
      aiAccounts: accounts,
      requestHistory: history,
    });
    const owner = await signIn(server);
    const work = await accounts.add({
      name: "Work",
      aiProvider: "Claude",
      accountType: "api_key",
      credential,
    });
    const local = await accounts.add({
      name: "Ollama",
      aiProvider: "Ollama",
      accountType: "endpoint",
      endpointUrl: "http://localhost:11434",
    });
    const later = new Date(now.getTime() + 30_000).toISOString();
    const earlier = new Date(now.getTime() - 30_000).toISOString();
    await store.update(work.id, {
      rateLimits: {
        requests: { limit: 50, remaining: 12, resetsAt: later },
        tokens: null,
        inputTokens: { limit: 30_000, remaining: 0, resetsAt: earlier },
        outputTokens: null,
        observedAt: earlier,
      },
      balance: {
        currency: "USD",
        remaining: 5.5,
        used: 4.5,
        limit: 10,
        observedAt: earlier,
      },
      updatedAt: now,
    });
    const served = (accountId: string, tokens: number, startedAt: Date) =>
      history.record({
        startedAt,
        account: null,
        accountId,
        endpoint: "messages",
        model: "m",
        streamed: false,
        status: 200,
        latencyMs: 1,
        upstreamRequestId: null,
        gatewayKeyId: null,
        agentId: null,
        floorId: null,
        ownerTool: "Terminal",
        issue: null,
        pullRequest: null,
        estimatedCostUsd: null,
        timeToFirstByteMs: null,
        requestHeaders: null,
        responseHeaders: null,
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    await served(work.id, 3000, now);
    await served(local.id, 1000, now);
    // Yesterday's is not today's.
    await served(local.id, 9000, new Date(midnight.getTime() - 60_000));

    const listed = aiAccountListSchema.parse(
      (
        await server.inject({ url: "/api/ai-accounts", headers: owner.headers })
      ).json(),
    ).accounts;
    expect(listed.map(({ name, tokensToday }) => [name, tokensToday])).toEqual([
      ["Work", { tokens: 3000, gatewayTokens: 4000 }],
      ["Ollama", { tokens: 1000, gatewayTokens: 4000 }],
    ]);
    expect(listed[0]?.rateLimits).toEqual({
      requests: { limit: 50, remaining: 12, resetsAt: later },
      tokens: null,
      inputTokens: { limit: 30_000, remaining: 30_000, resetsAt: null },
      outputTokens: null,
      observedAt: earlier,
    });
    expect(listed[0]?.balance).toMatchObject({ remaining: 5.5, limit: 10 });
    expect(listed[1]).toMatchObject({ rateLimits: null, balance: null });
    await server.close();
  });
});
