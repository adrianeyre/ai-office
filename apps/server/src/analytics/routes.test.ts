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
  databaseAiAccountStore,
  databaseRequestHistoryStore,
  memoryAiAccountStore,
  memoryRequestHistoryStore,
  type AiAccountChanges,
  type AiAccountStore,
  type GatewayRequestRecord,
  type RequestHistory,
  type RequestHistoryStore,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  analyticsBreakdownSchema,
  analyticsInsightsSchema,
  analyticsSeriesSchema,
  analyticsUsageWindowsSchema,
  type Agent,
  type AnalyticsDimension,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Gateway's analytics through the API (PRD FR-43): the series over
// time, each breakdown, the insights and the usage-window history, each
// checked against the request records and account readings it comes from.
// Each case runs in memory and in Postgres 18.

const now = new Date("2026-10-09T15:00:00.000Z");
const encryptor = encryptorFromKey(Buffer.alloc(32, 9));
const range = {
  from: "2026-10-08T00:00:00.000Z",
  to: "2026-10-10T00:00:00.000Z",
};

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly history: RequestHistory;
  readonly store: RequestHistoryStore;
  readonly accountStore: AiAccountStore;
  readonly ada: Agent;
  readonly linus: Agent;
}

const record = (
  fields: Partial<GatewayRequestRecord>,
): GatewayRequestRecord => ({
  startedAt: new Date("2026-10-09T10:00:00.000Z"),
  account: "Work",
  accountId: null,
  endpoint: "messages",
  model: "claude-opus-5-5",
  streamed: false,
  status: 200,
  latencyMs: 100,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  upstreamRequestId: null,
  gatewayKeyId: null,
  agentId: null,
  floorId: null,
  ownerTool: null,
  issue: null,
  pullRequest: null,
  estimatedCostUsd: null,
  timeToFirstByteMs: 50,
  requestHeaders: null,
  responseHeaders: null,
  ...fields,
});

async function setUp(
  stores: OfficeStores,
  bus: EventBus,
  store: RequestHistoryStore,
  accountStore: AiAccountStore,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const history = createRequestHistory({ store, encryptor });
  const auth = await testAuth({ now: () => now });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth,
    events: bus,
    stores,
    github,
    requestHistory: history,
    aiAccounts: createAiAccounts({
      store: accountStore,
      encryptor: auth.encryptor,
      events: bus,
      now: () => now,
    }),
  });
  const owner = await signIn(server);
  await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  const team = agentListSchema.parse(
    (
      await server.inject({
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
      })
    ).json(),
  ).agents;
  const [ada, linus] = team.filter(({ role }) => role !== "manager");
  if (ada === undefined || linus === undefined) {
    throw new Error("web-shop has no team.");
  }

  // The requests: two Agents, an Owner tool, two Models, two accounts.
  const work = (agent: Agent, issue: number | null) => ({
    agentId: agent.id,
    floorId: "web-shop",
    issue,
  });
  for (const fields of [
    // The 8th: Ada on #4, Claude, served by Work.
    {
      ...work(ada, 4),
      startedAt: new Date("2026-10-08T09:00:00.000Z"),
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 50,
      estimatedCostUsd: 0.5,
      latencyMs: 1_000,
    },
    // The 9th: Ada on #4 again, failing; Linus on #7 with GPT.
    {
      ...work(ada, 4),
      status: 529,
      latencyMs: 200,
    },
    {
      ...work(linus, 7),
      account: "Codex plan",
      model: "gpt-5.5-codex",
      inputTokens: 400,
      outputTokens: 100,
      estimatedCostUsd: 0.25,
      latencyMs: 600,
    },
    // An Owner tool, on no issue; and one refused before any account.
    {
      ownerTool: "laptop",
      model: "grok-5",
      account: "xAI",
      inputTokens: 50,
      outputTokens: 50,
      latencyMs: 100,
    },
    { ...work(linus, 7), account: null, status: 403, latencyMs: 2 },
    // Outside the range.
    {
      ...work(ada, 4),
      startedAt: new Date("2026-10-10T00:00:00.000Z"),
      inputTokens: 99_999,
    },
  ]) {
    await history.record(record(fields));
  }
  return { server, owner, history, store, accountStore, ada, linus };
}

const get = async (setup: Setup, url: string) =>
  setup.server.inject({ url, headers: setup.owner.headers });

const query = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "answers the totals, and each day's, over the range: requests, tokens by type, cost, latency and errors",
    async (setup) => {
      const response = await get(
        setup,
        `/api/analytics/series?${query({ ...range, bucket: "day" })}`,
      );
      expect(response.statusCode).toBe(200);
      const series = analyticsSeriesSchema.parse(response.json());
      expect(series.totals).toEqual({
        requests: 5,
        errors: 2,
        errorRate: 0.4,
        inputTokens: 1_450,
        outputTokens: 350,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
        tokens: 1_800,
        estimatedCostUsd: 0.75,
        averageLatencyMs: Math.round((1_000 + 200 + 600 + 100 + 2) / 5),
        averageTimeToFirstByteMs: 50,
        keepAliveRequests: 0,
        keepAliveCostUsd: 0,
      });
      expect(series.points.map(({ at }) => at)).toEqual([
        "2026-10-08T00:00:00.000Z",
        "2026-10-09T00:00:00.000Z",
      ]);
      expect(series.points[0]).toMatchObject({
        requests: 1,
        errors: 0,
        tokens: 1_200,
        cacheReadTokens: 300,
        averageLatencyMs: 1_000,
      });
      expect(series.points[1]).toMatchObject({
        requests: 4,
        errors: 2,
        errorRate: 0.5,
        tokens: 600,
        estimatedCostUsd: 0.25,
      });
    },
  ],
  [
    "counts prompt-cache keep-alives as requests, and apart, over time and by Agent",
    async (setup) => {
      const { ada } = setup;
      // Two of Ada's keep-alives on the 9th (FR-39): cache reads, no output.
      for (const at of [
        "2026-10-09T10:04:00.000Z",
        "2026-10-09T10:08:00.000Z",
      ]) {
        await setup.history.record(
          record({
            agentId: ada.id,
            floorId: "web-shop",
            issue: 4,
            startedAt: new Date(at),
            inputTokens: 3,
            outputTokens: 0,
            cacheReadInputTokens: 50_000,
            estimatedCostUsd: 0.01,
            latencyMs: 80,
            keepAlive: true,
          }),
        );
      }
      const series = analyticsSeriesSchema.parse(
        (
          await get(
            setup,
            `/api/analytics/series?${query({ ...range, bucket: "day" })}`,
          )
        ).json(),
      );
      expect(series.totals).toMatchObject({
        requests: 7,
        cacheReadTokens: 100_300,
        estimatedCostUsd: 0.77,
        keepAliveRequests: 2,
        keepAliveCostUsd: 0.02,
      });
      expect(
        series.points.map(({ keepAliveRequests }) => keepAliveRequests),
      ).toEqual([0, 2]);
      const byAgent = analyticsBreakdownSchema.parse(
        (
          await get(
            setup,
            `/api/analytics/breakdown?${query({ ...range, by: "agent" })}`,
          )
        ).json(),
      ).items;
      expect(
        byAgent.map(({ key, keepAliveRequests }) => [key, keepAliveRequests]),
      ).toEqual([
        [ada.id, 2],
        [setup.linus.id, 0],
      ]);
    },
  ],
  [
    "answers every hour of a range by the hour, empty ones too",
    async (setup) => {
      const response = await get(
        setup,
        `/api/analytics/series?${query({
          from: "2026-10-09T08:00:00.000Z",
          to: "2026-10-09T12:00:00.000Z",
          bucket: "hour",
        })}`,
      );
      const series = analyticsSeriesSchema.parse(response.json());
      expect(series.points.map(({ at, requests }) => [at, requests])).toEqual([
        ["2026-10-09T08:00:00.000Z", 0],
        ["2026-10-09T09:00:00.000Z", 0],
        ["2026-10-09T10:00:00.000Z", 4],
        ["2026-10-09T11:00:00.000Z", 0],
      ]);
      expect(series.points[0]?.averageLatencyMs).toBeNull();
    },
  ],
  [
    "answers one AI Account's series alone, by the hour or the day, retention's days by its name",
    async (setup) => {
      const added = await setup.server.inject({
        method: "POST",
        url: "/api/ai-accounts",
        headers: setup.owner.headers,
        payload: {
          name: "Work",
          aiProvider: "Claude",
          accountType: "api_key",
          credential: "sk-ant-api03-workplan-0123456789abcdefghij",
        },
      });
      const { id } = added.json<{ id: string }>();
      for (const [at, inputTokens] of [
        ["2026-10-08T05:00:00.000Z", 1_000],
        ["2026-10-09T10:30:00.000Z", 10],
        ["2026-10-09T11:30:00.000Z", 20],
      ] as const) {
        await setup.history.record(
          record({
            accountId: id,
            startedAt: new Date(at),
            inputTokens,
            outputTokens: 5,
            cacheReadInputTokens: 7,
          }),
        );
      }
      // Retention folds the 8th's early request into its day's totals,
      // which keep the account's name but not its id.
      await setup.store.deleteBefore(new Date("2026-10-08T06:00:00.000Z"));

      const hourly = analyticsSeriesSchema.parse(
        (
          await get(
            setup,
            `/api/analytics/series?${query({
              from: "2026-10-09T09:00:00.000Z",
              to: "2026-10-09T12:00:00.000Z",
              bucket: "hour",
              aiAccountId: id,
            })}`,
          )
        ).json(),
      );
      // Not the four other requests at 10:00, which no account served by id.
      expect(
        hourly.points.map(({ requests, tokens }) => [requests, tokens]),
      ).toEqual([
        [0, 0],
        [1, 15],
        [1, 25],
      ]);
      expect(hourly.totals.cacheReadTokens).toBe(14);

      const daily = analyticsSeriesSchema.parse(
        (
          await get(
            setup,
            `/api/analytics/series?${query({ ...range, bucket: "day", aiAccountId: id })}`,
          )
        ).json(),
      );
      expect(
        daily.points.map(({ requests, tokens }) => [requests, tokens]),
      ).toEqual([
        [1, 1_005],
        [2, 40],
      ]);

      const missing = await get(
        setup,
        `/api/analytics/series?${query({ ...range, aiAccountId: "nobody" })}`,
      );
      expect(missing.statusCode).toBe(404);
    },
  ],
  [
    "breaks the requests down by each dimension, most tokens first",
    async (setup) => {
      const { ada, linus } = setup;
      const breakdown = async (by: AnalyticsDimension) =>
        analyticsBreakdownSchema
          .parse(
            (
              await get(
                setup,
                `/api/analytics/breakdown?${query({ ...range, by })}`,
              )
            ).json(),
          )
          .items.map(({ key, label, floorId, requests, tokens, errors }) => ({
            key,
            label,
            floorId,
            requests,
            tokens,
            errors,
          }));
      expect(await breakdown("ai_account")).toEqual([
        {
          key: "Work",
          label: "Work",
          floorId: null,
          requests: 2,
          tokens: 1_200,
          errors: 1,
        },
        {
          key: "Codex plan",
          label: "Codex plan",
          floorId: null,
          requests: 1,
          tokens: 500,
          errors: 0,
        },
        {
          key: "xAI",
          label: "xAI",
          floorId: null,
          requests: 1,
          tokens: 100,
          errors: 0,
        },
        {
          key: null,
          label: "No AI Account",
          floorId: null,
          requests: 1,
          tokens: 0,
          errors: 1,
        },
      ]);
      expect(await breakdown("ai_provider")).toEqual([
        {
          key: "Claude",
          label: "Claude",
          floorId: null,
          requests: 3,
          tokens: 1_200,
          errors: 2,
        },
        {
          key: "ChatGPT",
          label: "ChatGPT",
          floorId: null,
          requests: 1,
          tokens: 500,
          errors: 0,
        },
        {
          key: "Grok",
          label: "Grok",
          floorId: null,
          requests: 1,
          tokens: 100,
          errors: 0,
        },
      ]);
      expect(await breakdown("model")).toEqual([
        {
          key: "claude-opus-5-5",
          label: "claude-opus-5-5",
          floorId: null,
          requests: 3,
          tokens: 1_200,
          errors: 2,
        },
        {
          key: "gpt-5.5-codex",
          label: "gpt-5.5-codex",
          floorId: null,
          requests: 1,
          tokens: 500,
          errors: 0,
        },
        {
          key: "grok-5",
          label: "grok-5",
          floorId: null,
          requests: 1,
          tokens: 100,
          errors: 0,
        },
      ]);
      expect(await breakdown("floor")).toEqual([
        {
          key: "web-shop",
          label: "web-shop",
          floorId: "web-shop",
          requests: 4,
          tokens: 1_700,
          errors: 2,
        },
        {
          key: null,
          label: "Owner tools",
          floorId: null,
          requests: 1,
          tokens: 100,
          errors: 0,
        },
      ]);
      expect(await breakdown("agent")).toEqual([
        {
          key: ada.id,
          label: ada.name,
          floorId: "web-shop",
          requests: 2,
          tokens: 1_200,
          errors: 1,
        },
        {
          key: linus.id,
          label: linus.name,
          floorId: "web-shop",
          requests: 2,
          tokens: 500,
          errors: 1,
        },
      ]);
      expect(await breakdown("issue")).toEqual([
        {
          key: "web-shop#4",
          label: "web-shop #4",
          floorId: "web-shop",
          requests: 2,
          tokens: 1_200,
          errors: 1,
        },
        {
          key: "web-shop#7",
          label: "web-shop #7",
          floorId: "web-shop",
          requests: 2,
          tokens: 500,
          errors: 1,
        },
      ]);
      expect(await breakdown("owner_tool")).toEqual([
        {
          key: "laptop",
          label: "laptop",
          floorId: null,
          requests: 1,
          tokens: 100,
          errors: 0,
        },
      ]);
      // Each item carries every total, as the series do.
      const [work] = analyticsBreakdownSchema.parse(
        (
          await get(
            setup,
            `/api/analytics/breakdown?${query({ ...range, by: "ai_account" })}`,
          )
        ).json(),
      ).items;
      expect(work).toMatchObject({
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
        estimatedCostUsd: 0.5,
        errorRate: 0.5,
        averageLatencyMs: 600,
      });
    },
  ],
  [
    "names the top consumers and the AI Accounts close to their limits",
    async (setup) => {
      const { ada, linus, accountStore } = setup;
      const added = async (
        name: string,
        fields: Omit<AiAccountChanges, "updatedAt">,
      ) => {
        await setup.server.inject({
          method: "POST",
          url: "/api/ai-accounts",
          headers: setup.owner.headers,
          payload: {
            name,
            aiProvider: "Claude",
            accountType: "api_key",
            credential: `sk-ant-api03-${name}-0123456789abcdefghij`,
          },
        });
        const account = (await accountStore.list()).find(
          (candidate) => candidate.name === name,
        );
        if (account === undefined) {
          throw new Error(`${name} was not added.`);
        }
        await accountStore.update(account.id, { ...fields, updatedAt: now });
        return account.id;
      };
      const busy = await added("Busy", {
        fiveHourUtilization: 92,
        fiveHourResetsAt: new Date("2026-10-09T17:00:00.000Z"),
        weeklyUtilization: 40,
        weeklyResetsAt: new Date("2026-10-12T00:00:00.000Z"),
      });
      const limited = await added("Limited", {
        limitReason: "rate_limited",
        limitedUntil: new Date("2026-10-09T15:30:00.000Z"),
      });
      // Near 100% once, but that window has reset.
      await added("Calm", {
        fiveHourUtilization: 95,
        fiveHourResetsAt: new Date("2026-10-09T14:00:00.000Z"),
      });

      const response = await get(
        setup,
        `/api/analytics/insights?${query(range)}`,
      );
      expect(response.statusCode).toBe(200);
      const insights = analyticsInsightsSchema.parse(response.json());
      expect(insights.topConsumers).toEqual([
        {
          kind: "agent",
          key: ada.id,
          label: ada.name,
          floorId: "web-shop",
          tokens: 1_200,
          requests: 2,
          estimatedCostUsd: 0.5,
          share: 1_200 / 1_800,
        },
        {
          kind: "agent",
          key: linus.id,
          label: linus.name,
          floorId: "web-shop",
          tokens: 500,
          requests: 2,
          estimatedCostUsd: 0.25,
          share: 500 / 1_800,
        },
        {
          kind: "owner_tool",
          key: "laptop",
          label: "laptop",
          floorId: null,
          tokens: 100,
          requests: 1,
          estimatedCostUsd: 0,
          share: 100 / 1_800,
        },
      ]);
      expect(insights.accountsNearLimits).toEqual([
        {
          accountId: busy,
          name: "Busy",
          aiProvider: "Claude",
          windows: [
            {
              window: "five_hour",
              utilization: 92,
              resetsAt: "2026-10-09T17:00:00.000Z",
            },
          ],
          limitReason: null,
          limitedUntil: null,
        },
        {
          accountId: limited,
          name: "Limited",
          aiProvider: "Claude",
          windows: [],
          limitReason: "rate_limited",
          limitedUntil: "2026-10-09T15:30:00.000Z",
        },
      ]);
    },
  ],
  [
    "answers each AI Account's usage-window readings in the range, oldest first",
    async (setup) => {
      await setup.server.inject({
        method: "POST",
        url: "/api/ai-accounts",
        headers: setup.owner.headers,
        payload: {
          name: "Max plan",
          aiProvider: "Claude",
          accountType: "api_key",
          credential: "sk-ant-api03-maxplan-0123456789abcdefghij",
        },
      });
      const [account] = await setup.accountStore.list();
      if (account === undefined) {
        throw new Error("The account was not added.");
      }
      for (const [window, utilization, observedAt] of [
        ["five_hour", 10, "2026-10-07T23:00:00.000Z"], // before the range
        ["five_hour", 20, "2026-10-08T10:00:00.000Z"],
        ["weekly", 5, "2026-10-08T10:00:00.000Z"],
        ["five_hour", 60, "2026-10-09T10:00:00.000Z"],
      ] as const) {
        await setup.accountStore.addUsage({
          aiAccountId: account.id,
          window,
          utilization,
          resetsAt: new Date("2026-10-09T12:00:00.000Z"),
          observedAt: new Date(observedAt),
        });
      }
      const response = await get(
        setup,
        `/api/analytics/usage-windows?${query(range)}`,
      );
      const body = analyticsUsageWindowsSchema.parse(response.json());
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0]).toMatchObject({
        accountId: account.id,
        name: "Max plan",
        aiProvider: "Claude",
      });
      expect(
        body.accounts[0]?.readings.map(({ window, utilization }) => [
          window,
          utilization,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["five_hour", 20],
          ["weekly", 5],
          ["five_hour", 60],
        ]),
      );
      expect(body.accounts[0]?.readings.at(-1)).toMatchObject({
        utilization: 60,
        observedAt: "2026-10-09T10:00:00.000Z",
      });
      expect(body.accounts[0]?.readings).toHaveLength(3);
    },
  ],
  [
    "refuses a range that ends before it starts, is too long, or is cut too finely",
    async (setup) => {
      for (const url of [
        `/api/analytics/series?${query({ from: range.to, to: range.from })}`,
        `/api/analytics/series?${query({ from: "2025-01-01T00:00:00.000Z", to: range.to })}`,
        `/api/analytics/series?${query({ from: "2026-08-01T00:00:00.000Z", to: range.to, bucket: "hour" })}`,
        `/api/analytics/breakdown?${query({ ...range, by: "colour" })}`,
        `/api/analytics/insights?${query({ from: "yesterday", to: range.to })}`,
        `/api/analytics/usage-windows`,
      ]) {
        expect((await get(setup, url)).statusCode, url).toBe(400);
      }
      // And all of it needs a session.
      const signedOut = await setup.server.inject({
        url: `/api/analytics/series?${query(range)}`,
      });
      expect(signedOut.statusCode).toBe(401);
    },
  ],
];

describe("the analytics API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () =>
      run(
        await setUp(
          memoryStores(),
          createEventBus({ store: memoryEventStore() }),
          memoryRequestHistoryStore(),
          memoryAiAccountStore(),
        ),
      ),
    );
  }
});

describe("the analytics API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) =>
      run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
          databaseRequestHistoryStore(database.db),
          databaseAiAccountStore(database.db),
        ),
      ),
    );
  }
});
