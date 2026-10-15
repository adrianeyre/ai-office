import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  createRequestHistory,
  memoryRequestHistoryStore,
  type CatalogueEntry,
  type GatewayRequestRecord,
  type ModelCatalogue,
  type RequestHistory,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import { memoryStores, type FreshStarts } from "@ai-office/orchestrator";
import {
  agentListSchema,
  apiErrorSchema,
  floorContextUsageSchema,
  freshStartResponseSchema,
  type Agent,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";
import { contextWindowOf } from "./routes.ts";

// Context Usage through the API (PRD FR-84, FR-85): each model call the
// AI Gateway records counts against its Agent's session, and the Floor's
// Agents with a session going are listed with their Context Usage.

const entry = (
  model: string,
  contextWindow: number | null,
  aiProvider = "Claude",
): CatalogueEntry => ({
  aiProvider,
  accountType: "api_key",
  model,
  displayName: null,
  contextWindow,
  fetchedAt: new Date("2026-10-09T08:00:00.000Z"),
});

/** The model catalogue: Opus with its window, Sonnet without one. */
const catalogue: ModelCatalogue = {
  list: () =>
    Promise.resolve([
      entry("claude-opus-5-5", 200_000),
      entry("claude-sonnet-5-5", null),
    ]),
  refresh: () => Promise.resolve({ refreshed: [], failed: [] }),
};

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly history: RequestHistory;
  readonly team: Agent[];
}

async function setUp(
  freshStarts?: Pick<FreshStarts, "request">,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const auth = await testAuth();
  const history = createRequestHistory({
    store: memoryRequestHistoryStore(),
    encryptor: auth.encryptor,
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth,
    events: createEventBus({ store: memoryEventStore() }),
    stores: memoryStores(),
    github,
    modelCatalogue: catalogue,
    requestHistory: history,
    ...(freshStarts === undefined ? {} : { freshStarts }),
  });
  const owner = await signIn(server);
  await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  const listed = await server.inject({
    url: "/api/floors/web-shop/agents",
    headers: owner.headers,
  });
  return {
    server,
    owner,
    history,
    team: agentListSchema.parse(listed.json()).agents,
  };
}

const member = (team: readonly Agent[], role: Agent["role"]): Agent => {
  const agent = team.find((candidate) => candidate.role === role);
  if (agent === undefined) {
    throw new Error(`A new Floor has a ${role}.`);
  }
  return agent;
};

/** A request the Gateway recorded for `agent`, with `tokens` of input. */
const request = (
  agent: Agent,
  tokens: number,
  overrides: Partial<GatewayRequestRecord> = {},
): GatewayRequestRecord => ({
  startedAt: new Date(),
  account: "Claude (work)",
  accountId: null,
  endpoint: "messages",
  model: "claude-opus-5-5",
  streamed: true,
  status: 200,
  latencyMs: 900,
  upstreamRequestId: null,
  gatewayKeyId: null,
  agentId: agent.id,
  floorId: agent.floorId,
  ownerTool: null,
  issue: 4,
  pullRequest: null,
  session: "sbx-1",
  estimatedCostUsd: null,
  timeToFirstByteMs: null,
  requestHeaders: null,
  responseHeaders: null,
  inputTokens: 4,
  outputTokens: 300,
  cacheReadInputTokens: tokens - 4,
  cacheCreationInputTokens: 0,
  ...overrides,
});

const contextUsage = async ({ server, owner }: Setup) => {
  const response = await server.inject({
    url: "/api/floors/web-shop/context-usage",
    headers: owner.headers,
  });
  expect(response.statusCode).toBe(200);
  return floorContextUsageSchema.parse(response.json()).agents;
};

/** Waits for what the request history told to be counted. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("GET /api/floors/:floorId/context-usage", () => {
  it("lists each Agent with a session going and its Context Usage, from the requests the Gateway recorded", async () => {
    const setup = await setUp();
    const coder = member(setup.team, "coder");
    const reviewer = member(setup.team, "reviewer");
    expect(await contextUsage(setup)).toEqual([]);

    await setup.history.record(request(coder, 90_000));
    await setup.history.record(request(coder, 172_000));
    // Reviewer calls are stateless: they have no Context Usage.
    await setup.history.record(request(reviewer, 50_000, { session: null }));
    await settled();

    expect(await contextUsage(setup)).toEqual([
      {
        agentId: coder.id,
        floorId: "web-shop",
        issue: 4,
        model: "claude-opus-5-5",
        inputTokens: 172_000,
        contextWindow: 200_000,
        contextUsage: 0.86,
        updatedAt: expect.any(String) as string,
      },
    ]);
  });

  it("shows a Model with no context window in the catalogue as unknown, not 0%", async () => {
    const setup = await setUp();
    const coder = member(setup.team, "coder");
    await setup.server.inject({
      method: "PATCH",
      url: `/api/floors/web-shop/agents/${coder.id}`,
      headers: setup.owner.headers,
      payload: { modelOverride: "claude-sonnet-5-5" },
    });
    await setup.history.record(
      request(coder, 40_000, { model: "claude-sonnet-5-5" }),
    );
    await settled();

    expect(await contextUsage(setup)).toEqual([
      expect.objectContaining({
        agentId: coder.id,
        contextWindow: null,
        contextUsage: null,
      }),
    ]);
  });

  it("answers 404 for a Floor that does not exist, and 401 signed out", async () => {
    const setup = await setUp();
    const missing = await setup.server.inject({
      url: "/api/floors/nowhere/context-usage",
      headers: setup.owner.headers,
    });
    expect(missing.statusCode).toBe(404);
    const signedOut = await setup.server.inject({
      url: "/api/floors/web-shop/context-usage",
    });
    expect(signedOut.statusCode).toBe(401);
  });
});

describe("POST /api/floors/:floorId/agents/:agentId/fresh-start", () => {
  it("makes a Fresh Start of the Agent's session at once, answering with the session being ended", async () => {
    const asked: string[] = [];
    const setup = await setUp({
      request: (floorId, agentId) => {
        asked.push(`${floorId}/${agentId}`);
        return "sbx-1";
      },
    });
    const coder = member(setup.team, "coder");
    const response = await setup.server.inject({
      method: "POST",
      url: `/api/floors/web-shop/agents/${coder.id}/fresh-start`,
      headers: setup.owner.headers,
    });
    expect(response.statusCode).toBe(202);
    expect(freshStartResponseSchema.parse(response.json())).toEqual({
      session: "sbx-1",
    });
    expect(asked).toEqual([`web-shop/${coder.id}`]);
  });

  it("answers 409 when the Agent has no sandbox session going", async () => {
    const setup = await setUp({ request: () => undefined });
    const coder = member(setup.team, "coder");
    const response = await setup.server.inject({
      method: "POST",
      url: `/api/floors/web-shop/agents/${coder.id}/fresh-start`,
      headers: setup.owner.headers,
    });
    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json())).toEqual({
      error: "no_session",
      message: `${coder.name} has no sandbox session going, so there is nothing to start afresh.`,
    });
  });

  it("answers 409 without Fresh Starts, 404 for an Agent or Floor that does not exist, and 401 signed out", async () => {
    const setup = await setUp();
    const coder = member(setup.team, "coder");
    const post = (url: string, headers = setup.owner.headers) =>
      setup.server.inject({ method: "POST", url, headers });
    expect(
      (await post(`/api/floors/web-shop/agents/${coder.id}/fresh-start`))
        .statusCode,
    ).toBe(409);
    const missing = await post(
      "/api/floors/web-shop/agents/nobody/fresh-start",
    );
    expect(missing.statusCode).toBe(404);
    expect(apiErrorSchema.parse(missing.json()).error).toBe("agent_not_found");
    expect(
      (await post(`/api/floors/nowhere/agents/${coder.id}/fresh-start`))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await setup.server.inject({
          method: "POST",
          url: `/api/floors/web-shop/agents/${coder.id}/fresh-start`,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("contextWindowOf", () => {
  it("reads a Model's context window from its AI Provider's catalogue, at most once a minute", async () => {
    let reads = 0;
    let clock = 0;
    const windowOf = contextWindowOf(
      {
        list: () => {
          reads += 1;
          return Promise.resolve([
            entry("claude-opus-5-5", 200_000),
            entry("grok-4", 256_000, "Grok"),
          ]);
        },
      },
      () => clock,
    );
    expect(await windowOf("Claude", "claude-opus-5-5")).toBe(200_000);
    expect(await windowOf("Claude", "grok-4")).toBeNull();
    expect(await windowOf("Grok", "grok-4")).toBe(256_000);
    expect(await windowOf("Claude", "claude-unknown")).toBeNull();
    expect(reads).toBe(1);
    clock = 60_000;
    await windowOf("Claude", "claude-opus-5-5");
    expect(reads).toBe(2);
  });
});
