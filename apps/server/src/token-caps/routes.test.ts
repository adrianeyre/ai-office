import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createRequestHistory,
  databaseRequestHistoryStore,
  memoryRequestHistoryStore,
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
  defaultOfficeTokenCaps,
  floorTokenUsageSchema,
  officeTokenUsageSchema,
  type Agent,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// Token accounting and Token Caps through the API (PRD FR-31, FR-32): the
// office's caps and the Office's use, a Floor's Agents and issues against
// their caps, and issues' own caps. The totals are checked against the
// request records they come from. Each case runs in memory and in
// Postgres 18.

const now = new Date("2026-10-09T15:00:00.000Z");

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly history: RequestHistory;
  readonly bus: EventBus;
}

async function setUp(
  stores: OfficeStores,
  bus: EventBus,
  store: RequestHistoryStore,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const history = createRequestHistory({
    store,
    encryptor: encryptorFromKey(Buffer.alloc(32, 9)),
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth({ now: () => now }),
    events: bus,
    stores,
    github,
    requestHistory: history,
  });
  return { server, owner: await signIn(server), history, bus };
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

/** Adds web-shop and answers its team. */
async function webShop({ server, owner }: Setup): Promise<Agent[]> {
  await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  const response = await server.inject({
    url: "/api/floors/web-shop/agents",
    headers: owner.headers,
  });
  return agentListSchema.parse(response.json()).agents;
}

/** Input plus output, as Token Caps count them. */
const tokens = (records: readonly GatewayRequestRecord[]) =>
  records.reduce(
    (sum, entry) => sum + (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
    0,
  );

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "answers the office's caps and the Office's use, as the request records add up",
    async (setup) => {
      const { server, owner, history } = setup;
      const [manager, coder] = await webShop(setup);
      if (manager === undefined || coder === undefined) {
        throw new Error("The Floor has no team.");
      }
      const agent = (who: Agent, issue: number | null = null) => ({
        agentId: who.id,
        floorId: who.floorId,
        issue,
      });
      const records = [
        record({ ...agent(coder, 3), inputTokens: 1_200, outputTokens: 300 }),
        record({
          ...agent(coder, 3),
          inputTokens: 800,
          outputTokens: 200,
          cacheReadInputTokens: 9_000,
          estimatedCostUsd: 0.25,
        }),
        record({ ...agent(manager), inputTokens: 50, outputTokens: 25 }),
        record({ ownerTool: "laptop", inputTokens: 10, outputTokens: 5 }),
        // Earlier this month, and last month.
        record({
          ...agent(coder),
          startedAt: new Date("2026-10-01T00:00:00.000Z"),
          inputTokens: 4_000,
          outputTokens: 0,
        }),
        record({
          ...agent(coder, 3),
          startedAt: new Date("2026-09-30T23:59:59.999Z"),
          inputTokens: 99_999,
          outputTokens: 0,
        }),
      ];
      for (const entry of records) {
        await history.record(entry);
      }
      const day = records.slice(0, 4);
      const month = records.slice(0, 5);

      const response = await server.inject({
        url: "/api/office/token-caps",
        headers: owner.headers,
      });
      expect(response.statusCode).toBe(200);
      const usage = officeTokenUsageSchema.parse(response.json());
      expect(usage.caps).toEqual(defaultOfficeTokenCaps);
      expect(usage.usage.daily).toEqual({
        requests: 4,
        inputTokens: 2_060,
        outputTokens: 530,
        cacheReadTokens: 9_000,
        cacheWriteTokens: 0,
        tokens: tokens(day),
        estimatedCostUsd: 0.25,
      });
      expect(usage.usage.monthly.tokens).toBe(tokens(month));
      expect(usage.floors).toEqual([
        {
          floorId: "web-shop",
          usage: {
            daily: expect.objectContaining({
              tokens: tokens(day.slice(0, 3)),
            }) as unknown,
            monthly: expect.objectContaining({
              tokens: tokens(month.filter(({ floorId }) => floorId !== null)),
            }) as unknown,
          },
        },
      ]);
      expect(usage.ownerTools).toEqual([
        {
          ownerTool: "laptop",
          usage: {
            daily: expect.objectContaining({
              requests: 1,
              tokens: 15,
            }) as unknown,
            monthly: expect.objectContaining({
              requests: 1,
              tokens: 15,
            }) as unknown,
          },
        },
      ]);
      expect(usage.busiestAgents.daily).toEqual({
        floorId: "web-shop",
        agentId: coder.id,
        use: {
          level: "office",
          cap: defaultOfficeTokenCaps.daily,
          used: 2_500,
        },
      });

      // The Owner's own caps.
      const put = await server.inject({
        method: "PUT",
        url: "/api/office/token-caps",
        headers: owner.headers,
        payload: { daily: 1_000_000, monthly: 20_000_000 },
      });
      expect(put.statusCode).toBe(200);
      expect(officeTokenUsageSchema.parse(put.json()).caps).toEqual({
        daily: 1_000_000,
        monthly: 20_000_000,
      });
      for (const payload of [
        { daily: 0, monthly: 1 },
        { daily: null, monthly: 1 },
        { daily: 1.5, monthly: 1 },
        { daily: 1 },
        { daily: 1, monthly: 1, weekly: 1 },
      ]) {
        const refused = await server.inject({
          method: "PUT",
          url: "/api/office/token-caps",
          headers: owner.headers,
          payload,
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: "invalid_request" });
      }
    },
  ],
  [
    "answers a Floor's Agents and issues against their caps, as set at each level",
    async (setup) => {
      const { server, owner, history } = setup;
      const [, coder, reviewer] = await webShop(setup);
      if (coder === undefined || reviewer === undefined) {
        throw new Error("The Floor has no team.");
      }
      await history.record(
        record({
          agentId: coder.id,
          floorId: "web-shop",
          issue: 3,
          inputTokens: 700,
          outputTokens: 300,
        }),
      );
      await history.record(
        record({
          agentId: reviewer.id,
          floorId: "web-shop",
          issue: 3,
          inputTokens: 100,
          outputTokens: 100,
        }),
      );
      // The Floor's daily cap; the coder's own monthly one.
      const floor = await server.inject({
        method: "PATCH",
        url: "/api/floors/web-shop",
        headers: owner.headers,
        payload: { tokenCaps: { daily: 800_000, monthly: null } },
      });
      expect(floor.statusCode).toBe(200);
      const agent = await server.inject({
        method: "PATCH",
        url: `/api/floors/web-shop/agents/${coder.id}`,
        headers: owner.headers,
        payload: { tokenCaps: { daily: null, monthly: 9_000_000 } },
      });
      expect(agent.statusCode).toBe(200);
      expect(agent.json()).toMatchObject({
        tokenCaps: { daily: null, monthly: 9_000_000 },
      });
      // An issue's own daily cap.
      const issue = await server.inject({
        method: "PUT",
        url: "/api/floors/web-shop/issues/3/token-caps",
        headers: owner.headers,
        payload: { daily: 50_000, monthly: null },
      });
      expect(issue.statusCode).toBe(200);
      expect(issue.json()).toEqual({ daily: 50_000, monthly: null });

      const response = await server.inject({
        url: "/api/floors/web-shop/token-usage",
        headers: owner.headers,
      });
      expect(response.statusCode).toBe(200);
      const usage = floorTokenUsageSchema.parse(response.json());
      expect(usage.caps).toEqual({ daily: 800_000, monthly: null });
      expect(usage.agentDefaults).toEqual({
        daily: { level: "floor", cap: 800_000 },
        monthly: { level: "office", cap: defaultOfficeTokenCaps.monthly },
      });
      expect(usage.usage.daily.tokens).toBe(1_200);
      expect(
        usage.agents.find(({ agentId }) => agentId === coder.id)?.caps,
      ).toEqual({
        daily: { level: "floor", cap: 800_000, used: 1_000 },
        monthly: { level: "agent", cap: 9_000_000, used: 1_000 },
      });
      expect(usage.issues).toEqual([
        {
          issue: 3,
          caps: { daily: 50_000, monthly: null },
          usage: {
            daily: expect.objectContaining({ tokens: 1_200 }) as unknown,
            monthly: expect.objectContaining({ tokens: 1_200 }) as unknown,
          },
        },
      ]);
    },
  ],
  [
    "refuses an issue cap that is not one, and a Floor that does not exist",
    async (setup) => {
      const { server, owner } = setup;
      await webShop(setup);
      const put = (url: string, payload: unknown) =>
        server.inject({
          method: "PUT",
          url,
          headers: owner.headers,
          payload: payload as Record<string, unknown>,
        });
      for (const issue of ["0", "-1", "1.5", "abc", "99999999999"]) {
        const refused = await put(
          `/api/floors/web-shop/issues/${issue}/token-caps`,
          { daily: 1, monthly: null },
        );
        expect(refused.statusCode).toBe(400);
      }
      for (const payload of [{ daily: 0, monthly: null }, { daily: 1 }, {}]) {
        expect(
          (await put("/api/floors/web-shop/issues/3/token-caps", payload))
            .statusCode,
        ).toBe(400);
      }
      const missing = await put("/api/floors/nowhere/issues/3/token-caps", {
        daily: 1,
        monthly: null,
      });
      expect(missing.statusCode).toBe(404);
      const usage = await server.inject({
        url: "/api/floors/nowhere/token-usage",
        headers: owner.headers,
      });
      expect(usage.statusCode).toBe(404);
      expect(usage.json()).toMatchObject({ error: "floor_not_found" });
    },
  ],
];

describe("the Token Caps API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryStores(),
          createEventBus({ store: memoryEventStore() }),
          memoryRequestHistoryStore(),
        ),
      );
    });
  }
});

describe("the Token Caps API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
          databaseRequestHistoryStore(database.db),
        ),
      );
    });
  }
});
