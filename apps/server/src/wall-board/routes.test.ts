import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  databaseWorkQueueStore,
  memoryStores,
  memoryWorkQueueStore,
  type OfficeStores,
  type WorkQueueStore,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  floorErrorCodes,
  floorWallBoardSchema,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// A Floor's wall board through the API (PRD FR-50, FR-57): its issues in
// progress and its queues, read from the work queue the server keeps, and
// whether each Agent is paused at a Token Cap (FR-62). Each case runs in
// memory and in Postgres 18.

const at = new Date("2026-10-09T09:00:00.000Z");

async function run(
  stores: OfficeStores,
  work: WorkQueueStore,
  bus: EventBus,
): Promise<void> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const capped = new Set<string>();
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    workQueue: work,
    capPaused: (agentId) => capped.has(agentId),
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
  const coder = team.find(({ role }) => role === "coder")?.id ?? "";
  await work.add(
    {
      floorId: "web-shop",
      issue: 4,
      stage: "needs-work",
      agentId: coder,
      priority: "normal",
    },
    at,
  );
  await work.claimNext(3, at);

  const response = await server.inject({
    url: "/api/floors/web-shop/wall-board",
    headers: owner.headers,
  });
  expect(response.statusCode).toBe(200);
  const board = floorWallBoardSchema.parse(response.json());
  expect(board.issues).toEqual([
    {
      issue: 4,
      url: "https://github.com/adrianeyre/web-shop/issues/4",
      stage: "needs-work",
      status: "working",
      agentIds: [coder],
      pullRequest: null,
      reviewRounds: 0,
      qaRounds: 0,
    },
  ]);
  expect(board.queues[0]).toEqual({
    stage: "needs-work",
    waiting: 0,
    working: 1,
  });
  expect(board.agents.map(({ agentId }) => agentId)).toEqual(
    team.map(({ id }) => id),
  );
  expect(board.agents.some(({ capped: paused }) => paused)).toBe(false);

  // The coder reaches a Token Cap: the board says so.
  capped.add(coder);
  const after = floorWallBoardSchema.parse(
    (
      await server.inject({
        url: "/api/floors/web-shop/wall-board",
        headers: owner.headers,
      })
    ).json(),
  );
  expect(after.agents.find(({ agentId }) => agentId === coder)).toMatchObject({
    capped: true,
    awaitingReview: [],
  });

  const unknown = await server.inject({
    url: "/api/floors/nowhere/wall-board",
    headers: owner.headers,
  });
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toMatchObject({
    error: floorErrorCodes.floorNotFound,
  });

  // Signed out, it is refused.
  const signedOut = await server.inject({
    url: "/api/floors/web-shop/wall-board",
  });
  expect(signedOut.statusCode).toBe(401);
  await server.close();
}

describe("GET /api/floors/:floorId/wall-board", () => {
  it("answers a Floor's issues in progress and its queues, in memory", async () => {
    const stores = memoryStores();
    await run(
      stores,
      memoryWorkQueueStore(stores.floors),
      createEventBus({ store: memoryEventStore() }),
    );
  });

  postgresTest(
    "answers a Floor's issues in progress and its queues, in Postgres 18",
    async ({ database }) => {
      await run(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
    },
  );
});
