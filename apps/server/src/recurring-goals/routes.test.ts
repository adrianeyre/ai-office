import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  floorErrorCodes,
  recurringGoalErrorCodes,
  recurringGoalListSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// A Floor's Recurring Goals in its admin (Scorecards PRD, FR-136, FR-141;
// ADR 0018): the Owner lists, adds, changes, turns off, deletes and runs
// them now, each change an event, each with its last and next run; nobody
// else can. The orchestrator's scenarios run them; here the API is
// checked, in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const floorId = "web-shop";
const goalsUrl = `/api/floors/${floorId}/recurring-goals`;

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly stores: OfficeStores;
  readonly published: OfficeEvent[];
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
  });
  const owner = await signIn(server);
  const added = await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository },
  });
  expect(added.statusCode).toBe(201);
  const published: OfficeEvent[] = [];
  bus.subscribe(({ event }) => {
    published.push(event);
  });
  return { server, owner, stores, published };
}

const send = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const weeklyGaps = {
  name: "Weekly test gaps",
  words: "Find modules without tests and file an issue for each.",
  schedule: { frequency: "weekly", days: [1], time: "09:00" },
  tokenCap: 200_000,
};

const errorOf = (body: string) => apiErrorSchema.parse(JSON.parse(body));

async function run(setup: Setup): Promise<void> {
  // None at first, and the Office's time zone they come round in.
  const empty = recurringGoalListSchema.parse(
    (await send(setup, "GET", goalsUrl)).json(),
  );
  expect(empty).toEqual({ recurringGoals: [], timeZone: "Europe/London" });

  // Added: on, coming round next Monday at 09:00, with no run yet.
  const added = await send(setup, "POST", goalsUrl, weeklyGaps);
  expect(added.statusCode).toBe(201);
  const [goal] = recurringGoalListSchema.parse(added.json()).recurringGoals;
  expect(goal).toMatchObject({
    ...weeklyGaps,
    enabled: true,
    failures: 0,
    lastRun: null,
  });
  const next = Date.parse(goal?.nextRunAt ?? "");
  expect(new Date(next).getUTCDay()).toBe(1);
  expect(next).toBeGreaterThan(Date.now());
  const goalUrl = `${goalsUrl}/${String(goal?.id)}`;

  // Changed: daily at 07:30; then turned off, with no next run.
  const daily = await send(setup, "PATCH", goalUrl, {
    schedule: { frequency: "daily", time: "07:30" },
  });
  expect(daily.statusCode).toBe(200);
  expect(
    recurringGoalListSchema.parse(daily.json()).recurringGoals[0]?.schedule,
  ).toEqual({ frequency: "daily", days: [], time: "07:30" });
  const off = await send(setup, "PATCH", goalUrl, { enabled: false });
  expect(
    recurringGoalListSchema.parse(off.json()).recurringGoals[0],
  ).toMatchObject({ enabled: false, nextRunAt: null });

  // Run now: it starts at once, off or not, and its run is listed.
  const ran = await send(setup, "POST", `${goalUrl}/run`);
  expect(ran.statusCode).toBe(202);
  await vi.waitFor(async () => {
    const listed = recurringGoalListSchema.parse(
      (await send(setup, "GET", goalsUrl)).json(),
    ).recurringGoals[0];
    expect(listed?.lastRun?.finishedAt).not.toBeNull();
  });

  // Deleted.
  const deleted = await send(setup, "DELETE", goalUrl);
  expect(recurringGoalListSchema.parse(deleted.json()).recurringGoals).toEqual(
    [],
  );

  // Each change, and the run, is an Activity Feed event.
  expect(
    setup.published
      .filter(({ type }) => type.startsWith("recurring_goal."))
      .map((event) =>
        event.type === "recurring_goal.changed"
          ? [event.type, event.fields, event.enabled]
          : [event.type],
      ),
  ).toEqual([
    ["recurring_goal.added"],
    ["recurring_goal.changed", ["schedule"], true],
    ["recurring_goal.changed", ["enabled"], false],
    ["recurring_goal.run_started"],
    expect.arrayContaining([expect.stringMatching(/^recurring_goal\.run_/)]),
    ["recurring_goal.removed"],
  ]);
}

async function refusals(setup: Setup): Promise<void> {
  // What is not a Recurring Goal.
  for (const payload of [
    { ...weeklyGaps, name: " " },
    { ...weeklyGaps, schedule: { frequency: "weekly", time: "09:00" } },
    { ...weeklyGaps, schedule: { frequency: "hourly", time: "09:00" } },
    { ...weeklyGaps, schedule: { frequency: "daily", time: "9am" } },
    { ...weeklyGaps, tokenCap: 0 },
    { ...weeklyGaps, cron: "0 9 * * 1" },
  ]) {
    const response = await send(setup, "POST", goalsUrl, payload);
    expect({ payload, status: response.statusCode }).toEqual({
      payload,
      status: 400,
    });
  }
  // A name taken, whatever its case.
  expect((await send(setup, "POST", goalsUrl, weeklyGaps)).statusCode).toBe(
    201,
  );
  const taken = await send(setup, "POST", goalsUrl, {
    ...weeklyGaps,
    name: "WEEKLY TEST GAPS",
  });
  expect(taken.statusCode).toBe(409);
  expect(errorOf(taken.body).error).toBe(recurringGoalErrorCodes.nameTaken);
  // What the Floor does not have.
  const missing = await send(setup, "PATCH", `${goalsUrl}/999`, {
    enabled: false,
  });
  expect(missing.statusCode).toBe(404);
  expect(errorOf(missing.body).error).toBe(recurringGoalErrorCodes.notFound);
  const noFloor = await send(
    setup,
    "GET",
    "/api/floors/nowhere/recurring-goals",
  );
  expect(noFloor.statusCode).toBe(404);
  expect(errorOf(noFloor.body).error).toBe(floorErrorCodes.floorNotFound);
  // Only the Owner: without a session, nothing.
  for (const [method, url] of [
    ["GET", goalsUrl],
    ["POST", goalsUrl],
    ["PATCH", `${goalsUrl}/1`],
    ["DELETE", `${goalsUrl}/1`],
    ["POST", `${goalsUrl}/1/run`],
  ] as const) {
    const response = await setup.server.inject({
      method,
      url,
      payload: weeklyGaps,
    });
    expect(response.statusCode).toBe(401);
  }
  expect(await setup.stores.recurringGoals.list(floorId)).toHaveLength(1);
  // An archived Floor's Recurring Goals do not change.
  await setup.stores.floors.archive(floorId, new Date());
  const archived = await send(setup, "POST", goalsUrl, {
    ...weeklyGaps,
    name: "Another",
  });
  expect(archived.statusCode).toBe(409);
  expect(errorOf(archived.body).error).toBe(floorErrorCodes.floorArchived);
}

describe("the Recurring Goals API, in memory", () => {
  const fresh = () =>
    setUp(memoryStores(), createEventBus({ store: memoryEventStore() }));

  it("adds, changes, turns off, runs now and deletes a Recurring Goal, each an event", async () => {
    await run(await fresh());
  });

  it("refuses what is not a Recurring Goal, what the Floor does not have, a name taken, and anyone but the Owner", async () => {
    await refusals(await fresh());
  });
});

describe("the Recurring Goals API, in Postgres 18", () => {
  postgresTest(
    "adds, changes, turns off, runs now and deletes a Recurring Goal, each an event",
    async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    },
  );

  postgresTest(
    "refuses what is not a Recurring Goal, what the Floor does not have, a name taken, and anyone but the Owner",
    async ({ database }) => {
      await refusals(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    },
  );
});
