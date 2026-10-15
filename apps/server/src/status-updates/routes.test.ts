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
import { floorErrorCodes, statusUpdateAnswerSchema } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// A Floor's Status update through the API (PRD FR-23a): the button gives
// one whenever it is pressed; opening the Floor gives the day's once; and
// the latest given is there for a browser that only heard of it. Each
// needs a session, and a change its CSRF token. Each case runs in memory
// and in Postgres 18.

async function run(
  stores: OfficeStores,
  work: WorkQueueStore,
  bus: EventBus,
): Promise<void> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    workQueue: work,
  });
  const owner = await signIn(server);
  await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  const post = (url: string, headers: Record<string, string> = owner.headers) =>
    server.inject({ method: "POST", url, headers });
  const latest = (headers: Record<string, string> = owner.headers) =>
    server.inject({
      method: "GET",
      url: "/api/floors/web-shop/status-update/latest",
      headers,
    });

  // None given yet; and none to read signed out.
  expect((await latest()).json()).toEqual({ statusUpdate: null });
  expect((await latest({})).statusCode).toBe(401);

  // Signed out, or without the CSRF token: refused, and nothing given.
  expect(
    (await post("/api/floors/web-shop/status-update", {})).statusCode,
  ).toBe(401);
  expect(
    (
      await post("/api/floors/web-shop/status-update/daily", {
        cookie: owner.cookie,
      })
    ).statusCode,
  ).toBe(403);

  // The day's own: once.
  const daily = await post("/api/floors/web-shop/status-update/daily");
  expect(daily.statusCode).toBe(201);
  const given = statusUpdateAnswerSchema.parse(daily.json()).statusUpdate;
  expect(given).toMatchObject({ floorId: "web-shop", trigger: "daily" });
  expect(given?.entries[0]?.role).toBe("manager");
  const again = await post("/api/floors/web-shop/status-update/daily");
  expect(again.statusCode).toBe(200);
  expect(again.json()).toEqual({ statusUpdate: null });

  // The button's: whenever.
  const asked = await post("/api/floors/web-shop/status-update");
  expect(asked.statusCode).toBe(201);
  expect(
    statusUpdateAnswerSchema.parse(asked.json()).statusUpdate?.trigger,
  ).toBe("owner");
  expect(
    (
      await bus.history({
        filter: { floorId: "web-shop", types: ["status_update.given"] },
      })
    ).map(({ event }) => event.type === "status_update.given" && event.trigger),
  ).toEqual(["owner", "daily"]);

  // The latest given, as it was said.
  const read = await latest();
  expect(read.statusCode).toBe(200);
  expect(read.json()).toEqual(asked.json());

  // A Floor that is not there.
  const missing = await post("/api/floors/nowhere/status-update");
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({
    error: floorErrorCodes.floorNotFound,
  });
  await server.close();
}

describe("Status update routes, in memory", () => {
  it("gives the button's whenever, and the day's once, to a signed-in Owner", async () => {
    const stores = memoryStores();
    await run(
      stores,
      memoryWorkQueueStore(stores.floors),
      createEventBus({ store: memoryEventStore() }),
    );
  });
});

describe("Status update routes, in Postgres 18", () => {
  postgresTest(
    "gives the button's whenever, and the day's once, to a signed-in Owner",
    async ({ database }) => {
      await run(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
    },
  );
});
