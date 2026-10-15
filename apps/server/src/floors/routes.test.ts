import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { GitHubError, type GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  floorListSchema,
  floorSchema,
  floorStopSchema,
  installedRepositoryListSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Floor API against the fake GitHub (PRD FR-6, FR-7, FR-9): add a
// Floor, refuse a duplicate repository, edit settings, archive. Each case
// runs with the Floors in memory, and in Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly fake: FakeGitHub;
  readonly bus: EventBus;
}

async function setUp(
  stores: OfficeStores,
  bus: EventBus,
  github?: GitHubApp | null,
): Promise<Setup> {
  const fake = createFakeGitHub();
  fake.installRepository("adrianeyre/web-shop");
  fake.installRepository("adrianeyre/blog");
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    ...(github === null ? {} : { github: github ?? fake }),
  });
  return { server, owner: await signIn(server), fake, bus };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const addWebShop = (setup: Setup) =>
  request(setup, "POST", "/api/floors", {
    repository: "adrianeyre/web-shop",
  });

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "lists the repositories the App is installed on",
    async (setup) => {
      const response = await request(setup, "GET", "/api/github/repositories");
      expect(response.statusCode).toBe(200);
      expect(
        installedRepositoryListSchema.parse(response.json()).repositories,
      ).toEqual([
        {
          fullName: "adrianeyre/blog",
          defaultBranch: "main",
          private: true,
          htmlUrl: "https://github.com/adrianeyre/blog",
          floorId: null,
        },
        {
          fullName: "adrianeyre/web-shop",
          defaultBranch: "main",
          private: true,
          htmlUrl: "https://github.com/adrianeyre/web-shop",
          floorId: null,
        },
      ]);
    },
  ],
  [
    "adds a Floor with the default settings",
    async (setup) => {
      const response = await addWebShop(setup);
      expect(response.statusCode).toBe(201);
      const floor = floorSchema.parse(response.json());
      expect(floor).toMatchObject({
        id: "web-shop",
        repository: "adrianeyre/web-shop",
        name: "web-shop",
        defaultBranch: "main",
        setupCommand: "",
        testCommand: "",
        mergePolicy: "send_to_me",
        roundCap: 3,
        tokenCaps: { daily: null, monthly: null },
        concurrencyLimit: null,
        planApproval: true,
        hourlyStatusUpdates: true,
        archivedAt: null,
      });

      const list = await request(setup, "GET", "/api/floors");
      expect(floorListSchema.parse(list.json()).floors).toEqual([floor]);
      const one = await request(setup, "GET", "/api/floors/web-shop");
      expect(one.json()).toEqual(floor);
      const repositories = await request(
        setup,
        "GET",
        "/api/github/repositories",
      );
      expect(
        installedRepositoryListSchema
          .parse(repositories.json())
          .repositories.map(({ fullName, floorId }) => [fullName, floorId]),
      ).toEqual([
        ["adrianeyre/blog", null],
        ["adrianeyre/web-shop", "web-shop"],
      ]);
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event.type),
      ).toContain("floor.created");
    },
  ],
  [
    "refuses a repository that is already a Floor",
    async (setup) => {
      await addWebShop(setup);
      const again = await addWebShop(setup);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({
        error: "floor_exists",
        message: 'adrianeyre/web-shop is already a Floor ("web-shop").',
      });
      const list = await request(setup, "GET", "/api/floors");
      expect(floorListSchema.parse(list.json()).floors).toHaveLength(1);
    },
  ],
  [
    "refuses a repository the App is not installed on, or no repository",
    async (setup) => {
      const notInstalled = await request(setup, "POST", "/api/floors", {
        repository: "adrianeyre/secret",
      });
      expect(notInstalled.statusCode).toBe(422);
      expect(notInstalled.json()).toMatchObject({
        error: "repository_not_installed",
      });
      for (const payload of [{}, { repository: "web-shop" }]) {
        const malformed = await request(setup, "POST", "/api/floors", payload);
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json()).toMatchObject({ error: "invalid_request" });
      }
    },
  ],
  [
    "renames a Floor, trimmed, 1 to 60 characters and unique whatever its case, for the Owner only",
    async (setup) => {
      await addWebShop(setup);
      await request(setup, "POST", "/api/floors", {
        repository: "adrianeyre/blog",
      });
      const renamed = await request(setup, "PATCH", "/api/floors/web-shop", {
        name: "  Storefront  ",
      });
      expect(renamed.statusCode).toBe(200);
      expect(floorSchema.parse(renamed.json())).toMatchObject({
        id: "web-shop",
        repository: "adrianeyre/web-shop",
        name: "Storefront",
      });
      // The address keeps the id; the list shows the name.
      expect(
        floorListSchema
          .parse((await request(setup, "GET", "/api/floors")).json())
          .floors.map(({ id, name }) => [id, name]),
      ).toEqual([
        ["web-shop", "Storefront"],
        ["blog", "blog"],
      ]);
      const events = (await setup.bus.eventsAfter(0)).map(({ event }) => event);
      expect(events).toContainEqual({
        type: "floor.renamed",
        version: 1,
        floorId: "web-shop",
        name: "Storefront",
        previousName: "web-shop",
      });
      expect(events).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId: "web-shop",
        keys: ["name"],
      });

      const clash = await request(setup, "PATCH", "/api/floors/blog", {
        name: "storefront",
      });
      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toEqual({
        error: "floor_name_taken",
        message: 'Another Floor is called "Storefront". Choose another name.',
      });
      for (const name of ["", "   ", "x".repeat(61)]) {
        const refused = await request(setup, "PATCH", "/api/floors/blog", {
          name,
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: "invalid_request" });
      }
      const longest = await request(setup, "PATCH", "/api/floors/blog", {
        name: "x".repeat(60),
      });
      expect(longest.statusCode).toBe(200);

      // Only the Owner, signed in, may rename one.
      const signedOut = await setup.server.inject({
        method: "PATCH",
        url: "/api/floors/blog",
        payload: { name: "Journal" },
      });
      expect(signedOut.statusCode).toBe(401);
      const withoutCsrf = await setup.server.inject({
        method: "PATCH",
        url: "/api/floors/blog",
        headers: { cookie: setup.owner.cookie },
        payload: { name: "Journal" },
      });
      expect(withoutCsrf.statusCode).toBe(403);
      expect(
        floorSchema.parse(
          (await request(setup, "GET", "/api/floors/blog")).json(),
        ).name,
      ).toBe("x".repeat(60));
    },
  ],
  [
    "edits a Floor's settings",
    async (setup) => {
      await addWebShop(setup);
      setup.fake.pushCommit("adrianeyre/web-shop", "develop");
      const response = await request(setup, "PATCH", "/api/floors/web-shop", {
        name: "Web shop",
        defaultBranch: "develop",
        setupCommand: "pnpm install --frozen-lockfile",
        testCommand: "pnpm test",
        mergePolicy: "auto_merge",
        roundCap: 4,
        tokenCaps: { daily: 1_500_000, monthly: 30_000_000 },
        concurrencyLimit: 1,
        priority: 7,
        planApproval: false,
        hourlyStatusUpdates: false,
      });
      expect(response.statusCode).toBe(200);
      const expected = {
        name: "Web shop",
        defaultBranch: "develop",
        setupCommand: "pnpm install --frozen-lockfile",
        testCommand: "pnpm test",
        mergePolicy: "auto_merge",
        roundCap: 4,
        tokenCaps: { daily: 1_500_000, monthly: 30_000_000 },
        concurrencyLimit: 1,
        priority: 7,
        planApproval: false,
        hourlyStatusUpdates: false,
      };
      expect(response.json()).toMatchObject(expected);
      expect(
        (await request(setup, "GET", "/api/floors/web-shop")).json(),
      ).toMatchObject(expected);

      // Back to no overrides.
      const cleared = await request(setup, "PATCH", "/api/floors/web-shop", {
        tokenCaps: { daily: null, monthly: null },
        concurrencyLimit: null,
      });
      expect(cleared.json()).toMatchObject({
        tokenCaps: { daily: null, monthly: null },
        concurrencyLimit: null,
      });
      const changes = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter((event) => event.type === "config.changed");
      expect(changes).toEqual([
        expect.objectContaining({
          scope: "floor",
          floorId: "web-shop",
          keys: [
            "name",
            "defaultBranch",
            "setupCommand",
            "testCommand",
            "mergePolicy",
            "roundCap",
            "tokenCaps",
            "concurrencyLimit",
            "priority",
            "planApproval",
            "hourlyStatusUpdates",
          ],
        }),
        expect.objectContaining({ keys: ["tokenCaps", "concurrencyLimit"] }),
      ]);
    },
  ],
  [
    "refuses settings out of bounds, unknown ones and missing branches",
    async (setup) => {
      await addWebShop(setup);
      for (const payload of [
        {},
        { roundCap: 0 },
        { roundCap: 2.5 },
        { mergePolicy: "yolo" },
        { name: "  " },
        { tokenCaps: { daily: -1, monthly: null } },
        { concurrencyLimit: 0 },
        { priority: -1 },
        { priority: 11 },
        { defaultBranch: "has space" },
        { colour: "red" },
        // At least one required reviewer, as a list (FR-27).
        { requiredReviewerAgentIds: [] },
        { requiredReviewerAgentIds: "grace" },
      ]) {
        const response = await request(
          setup,
          "PATCH",
          "/api/floors/web-shop",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
      const missing = await request(setup, "PATCH", "/api/floors/web-shop", {
        defaultBranch: "develop",
      });
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toEqual({
        error: "branch_not_found",
        message: 'adrianeyre/web-shop has no branch "develop".',
      });
      expect(
        (await request(setup, "GET", "/api/floors/web-shop")).json(),
      ).toMatchObject({ roundCap: 3, defaultBranch: "main" });
    },
  ],
  [
    "archives a Floor, hiding it and keeping its record",
    async (setup) => {
      await addWebShop(setup);
      const archived = await request(
        setup,
        "POST",
        "/api/floors/web-shop/archive",
      );
      expect(archived.statusCode).toBe(200);
      expect(floorSchema.parse(archived.json()).archivedAt).not.toBeNull();

      const list = await request(setup, "GET", "/api/floors");
      expect(floorListSchema.parse(list.json()).floors).toEqual([]);
      const one = await request(setup, "GET", "/api/floors/web-shop");
      expect(one.json()).toEqual(archived.json());

      for (const response of [
        await request(setup, "PATCH", "/api/floors/web-shop", { roundCap: 5 }),
        await request(setup, "POST", "/api/floors/web-shop/archive"),
      ]) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: "floor_archived" });
      }
      // It is still that repository's Floor.
      expect((await addWebShop(setup)).statusCode).toBe(409);
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event.type)
          .filter((type) => type.startsWith("floor.")),
      ).toEqual(["floor.created", "floor.archived"]);
    },
  ],
  [
    "stops everything on a Floor from the Meeting Room, until it carries on, and says so",
    async (setup) => {
      await addWebShop(setup);
      const state = async () =>
        floorStopSchema.parse(
          (await request(setup, "GET", "/api/floors/web-shop/stop")).json(),
        ).stoppedAt;
      expect(await state()).toBeNull();

      const stopped = await request(setup, "POST", "/api/floors/web-shop/stop");
      expect(stopped.statusCode).toBe(200);
      const stoppedAt = floorStopSchema.parse(stopped.json()).stoppedAt;
      expect(stoppedAt).not.toBeNull();
      expect(await state()).toBe(stoppedAt);
      // Stopping it again changes nothing.
      await request(setup, "POST", "/api/floors/web-shop/stop");
      expect(await state()).toBe(stoppedAt);

      const carried = await request(
        setup,
        "POST",
        "/api/floors/web-shop/continue",
      );
      expect(carried.statusCode).toBe(200);
      expect(floorStopSchema.parse(carried.json()).stoppedAt).toBeNull();
      expect(await state()).toBeNull();
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event.type)
          .filter((type) => type.startsWith("floor.")),
      ).toEqual(["floor.created", "floor.stopped", "floor.continued"]);
    },
  ],
  [
    "answers 404 for a Floor that does not exist",
    async (setup) => {
      for (const [method, url] of [
        ["GET", "/api/floors/nowhere"],
        ["PATCH", "/api/floors/nowhere"],
        ["POST", "/api/floors/nowhere/archive"],
        ["GET", "/api/floors/nowhere/stop"],
        ["POST", "/api/floors/nowhere/stop"],
        ["POST", "/api/floors/nowhere/continue"],
      ] as const) {
        const response = await request(
          setup,
          method,
          url,
          method === "PATCH" ? { roundCap: 4 } : undefined,
        );
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: "floor_not_found" });
      }
    },
  ],
];

describe("the Floor API, with Floors in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryStores(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the Floor API, with Floors in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});

describe("the Floor API without a working GitHub", () => {
  const bus = () => createEventBus({ store: memoryEventStore() });

  it("says the GitHub App is not configured", async () => {
    const setup = await setUp(memoryStores(), bus(), null);
    for (const response of [
      await request(setup, "GET", "/api/github/repositories"),
      await addWebShop(setup),
    ]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "github_not_configured",
        message:
          "GitHub is not set up: add a GitHub App or an access token in Floor Settings.",
      });
    }
    // The Floors themselves are still there to read.
    expect((await request(setup, "GET", "/api/floors")).json()).toEqual({
      floors: [],
    });
  });

  it("says when GitHub cannot be reached", async () => {
    const down = new GitHubError(0, "GitHub could not be reached");
    const unreachable: GitHubApp = {
      installations: () => Promise.reject(down),
      repositories: () => Promise.reject(down),
      repository: (fullName) => ({
        ...createFakeGitHub().repository(fullName),
        get: () => Promise.reject(down),
      }),
    };
    const setup = await setUp(memoryStores(), bus(), unreachable);
    for (const response of [
      await request(setup, "GET", "/api/github/repositories"),
      await addWebShop(setup),
    ]) {
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: "github_unavailable" });
    }
  });
});

describe("the Floor API's access", () => {
  it("needs the session's CSRF token to change anything", async () => {
    const setup = await setUp(
      memoryStores(),
      createEventBus({ store: memoryEventStore() }),
    );
    const response = await setup.server.inject({
      method: "POST",
      url: "/api/floors",
      headers: { cookie: setup.owner.cookie },
      payload: { repository: "adrianeyre/web-shop" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "csrf_refused" });
  });
});
