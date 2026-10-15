import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { eventHistoryResponseSchema } from "@ai-office/events/stream";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testPassword,
  type SignedIn,
} from "../test-support.ts";

// The event history behind the Activity Feed (PRD FR-52): pages of stored
// events, newest first, filtered by Floor, Agent, issue, type and time;
// and the sign-ins and sign-outs it records (FR-4).

interface Setup {
  readonly server: FastifyInstance;
  readonly bus: EventBus;
  readonly owner: SignedIn;
}

const start = new Date("2026-10-08T12:00:00.000Z");

async function setUp(bus: EventBus): Promise<Setup> {
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: { ...(await testAuth()), loginLimits: { freeFailures: 2 } },
    events: bus,
  });
  return { server, bus, owner: await signIn(server) };
}

/** A bus whose events are each a second after the one before. */
const clock = () => {
  let tick = 0;
  return () => new Date(start.getTime() + 1000 * tick++);
};

const status = (
  agentId: string,
  issue: number,
  floorId = "web-shop",
): OfficeEvent => ({
  type: "agent.status_changed",
  version: 1,
  floorId,
  agentId,
  status: "working",
  issue,
});

const page = async ({ server, owner }: Setup, query = "") => {
  const response = await server.inject({
    method: "GET",
    url: `/api/events${query}`,
    headers: { cookie: owner.cookie },
  });
  expect(response.statusCode).toBe(200);
  return eventHistoryResponseSchema.parse(response.json());
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "pages through the events newest first",
    async (setup) => {
      // Event 1 is the test's own sign-in.
      for (const issue of [1, 2, 3, 4, 5]) {
        await setup.bus.publish(status("ada", issue));
      }
      const first = await page(setup, "?limit=4");
      expect(first.events.map(({ id }) => id)).toEqual([6, 5, 4, 3]);
      expect(first.nextBefore).toBe(3);
      expect(first.events[0]).toEqual({
        id: 6,
        occurredAt: "2026-10-08T12:00:05.000Z",
        event: status("ada", 5),
      });
      const second = await page(setup, "?limit=4&before=3");
      expect(second.events.map(({ id }) => id)).toEqual([2, 1]);
      expect(second.nextBefore).toBeNull();
      expect(second.events.at(-1)?.event.type).toBe("sign_in.succeeded");
    },
  ],
  [
    "filters by Floor, Agent, issue, type and time",
    async (setup) => {
      await setup.bus.publish(status("ada", 7, "blog")); // 2
      await setup.bus.publish(status("grace", 7)); // 3
      await setup.bus.publish(status("ada", 8)); // 4
      await setup.bus.publish(status("ada", 7)); // 5
      const ids = async (query: string) =>
        (await page(setup, query)).events.map(({ id }) => id);
      expect(await ids("?floorId=web-shop")).toEqual([5, 4, 3]);
      expect(await ids("?agentId=ada")).toEqual([5, 4, 2]);
      expect(await ids("?floorId=web-shop&agentId=ada&issue=7")).toEqual([5]);
      expect(await ids("?type=sign_in.succeeded,sign_in.failed")).toEqual([1]);
      expect(
        await ids("?from=2026-10-08T12:00:02.000Z&to=2026-10-08T12:00:04.000Z"),
      ).toEqual([4, 3]);
    },
  ],
];

describe("GET /api/events, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          createEventBus({ store: memoryEventStore(), now: clock() }),
        ),
      );
    });
  }
});

describe("GET /api/events, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          createEventBus({
            store: databaseEventStore(database.db),
            now: clock(),
          }),
        ),
      );
    });
  }
});

describe("GET /api/events", () => {
  it("needs a session, and refuses a malformed query", async () => {
    const setup = await setUp(createEventBus({ store: memoryEventStore() }));
    const signedOut = await setup.server.inject({ url: "/api/events" });
    expect(signedOut.statusCode).toBe(401);
    for (const query of [
      "?type=floor.flooded",
      "?from=yesterday",
      "?limit=500",
      "?before=0",
    ]) {
      const response = await setup.server.inject({
        url: `/api/events${query}`,
        headers: { cookie: setup.owner.cookie },
      });
      expect(response.statusCode, query).toBe(400);
    }
  });
});

describe("sign-ins in the Activity Feed", () => {
  it("records each sign-in attempt, the lockout, and signing out", async () => {
    const bus = createEventBus({ store: memoryEventStore() });
    const setup = await setUp(bus);
    const attempt = (password: string) =>
      setup.server.inject({
        method: "POST",
        url: "/api/login",
        headers: { "user-agent": "Firefox/140.0" },
        payload: { password },
      });
    expect((await attempt("wrong-password-1")).statusCode).toBe(401);
    expect((await attempt("wrong-password-2")).statusCode).toBe(401);
    // Locked out: refused unchecked, so not recorded again.
    expect((await attempt(testPassword)).statusCode).toBe(429);
    await setup.server.inject({
      method: "POST",
      url: "/api/logout",
      headers: setup.owner.headers,
    });

    const events = (await bus.eventsAfter(0)).map(({ event }) => event);
    expect(events).toEqual([
      {
        type: "sign_in.succeeded",
        version: 1,
        ip: "127.0.0.1",
        userAgent: "lightMyRequest",
      },
      {
        type: "sign_in.failed",
        version: 1,
        ip: "127.0.0.1",
        userAgent: "Firefox/140.0",
      },
      {
        type: "sign_in.failed",
        version: 1,
        ip: "127.0.0.1",
        userAgent: "Firefox/140.0",
      },
      {
        type: "sign_in.locked_out",
        version: 1,
        ip: "127.0.0.1",
        lockoutSeconds: 60,
      },
      { type: "signed_out", version: 1, everywhere: false },
    ]);
    // Never the password.
    expect(JSON.stringify(events)).not.toContain("wrong-password");
  });

  it("records signing out everywhere", async () => {
    const bus = createEventBus({ store: memoryEventStore() });
    const setup = await setUp(bus);
    await setup.server.inject({
      method: "POST",
      url: "/api/logout/everywhere",
      headers: setup.owner.headers,
    });
    expect((await bus.eventsAfter(0)).at(-1)?.event).toEqual({
      type: "signed_out",
      version: 1,
      everywhere: true,
    });
  });
});
