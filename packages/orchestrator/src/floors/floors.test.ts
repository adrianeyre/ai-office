import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import {
  createLiveGitHub,
  GitHubError,
  type GitHubApp,
} from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { floorErrorCodes } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { FloorError } from "./errors.ts";
import { createFloors, floorSlug, type Floors } from "./floors.ts";
import {
  databaseFloorStore,
  memoryFloorStore,
  type FloorStore,
} from "./store.ts";

// Floors against the fake GitHub (PRD FR-6, FR-7, FR-9). Every case runs
// twice: with the Floors in memory, and in Postgres 18.

interface Setup {
  readonly floors: Floors;
  readonly fake: FakeGitHub;
  readonly store: FloorStore;
  readonly bus: EventBus;
  /** Every event published so far. */
  readonly events: () => Promise<OfficeEvent[]>;
}

const start = new Date("2026-10-08T12:00:00.000Z");

function setUp(store: FloorStore, bus: EventBus, github?: GitHubApp): Setup {
  const fake = createFakeGitHub();
  fake.installRepository("adrianeyre/web-shop");
  fake.installRepository("adrianeyre/Blog_2026", { defaultBranch: "trunk" });
  fake.installRepository("acme/web-shop");
  let tick = 0;
  return {
    floors: createFloors({
      store,
      github: github ?? fake,
      events: bus,
      // Each Floor a second after the one before.
      now: () => new Date(start.getTime() + 1000 * tick++),
    }),
    fake,
    store,
    bus,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const refusal = async (promise: Promise<unknown>): Promise<FloorError> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(FloorError);
  return error as FloorError;
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds a Floor from an installed repository, with the default settings",
    async ({ floors, events }) => {
      const floor = await floors.add("adrianeyre/web-shop");
      expect(floor).toEqual({
        id: "web-shop",
        githubRepositoryId: expect.any(Number) as unknown,
        repository: "adrianeyre/web-shop",
        name: "web-shop",
        defaultBranch: "main",
        setupCommand: "",
        testCommand: "",
        mergePolicy: "send_to_me",
        roundCap: 3,
        tokenCaps: { daily: null, monthly: null },
        concurrencyLimit: null,
        // Queued work starts in age order with other Floors' (#25).
        priority: 0,
        // Its reviewer Agent (#21).
        requiredReviewerAgentIds: [expect.any(String)],
        planApproval: true,
        mostAgents: 8,
        spinOffFromChat: true,
        hourlyStatusUpdates: true,
        freshStartThreshold: 85,
        // The office's Git identity (#23).
        gitIdentity: null,
        // Added without a choice, it counts as Development (#147).
        template: { id: "development", name: "Development" },
        // Development's office, the 3D theme every Floor had before themes (#153).
        theme: "office",
        createdAt: start,
        archivedAt: null,
      });
      expect(await floors.get("web-shop")).toEqual(floor);
      expect(await floors.list()).toEqual([floor]);
      const [created, ...team] = await events();
      expect(created).toEqual({
        type: "floor.created",
        version: 1,
        floorId: "web-shop",
        name: "web-shop",
        repository: "adrianeyre/web-shop",
        template: { id: "development", name: "Development" },
      });
      // Then its four Agents (#21).
      expect(team.map(({ type }) => type)).toEqual(
        Array(4).fill("agent.created"),
      );
    },
  ],
  [
    "lists the installed repositories, with the Floor each one has",
    async ({ floors }) => {
      await floors.add("adrianeyre/Blog_2026");
      expect(await floors.installedRepositories()).toEqual([
        {
          fullName: "acme/web-shop",
          defaultBranch: "main",
          private: true,
          htmlUrl: "https://github.com/acme/web-shop",
          floorId: null,
        },
        {
          fullName: "adrianeyre/Blog_2026",
          defaultBranch: "trunk",
          private: true,
          htmlUrl: "https://github.com/adrianeyre/Blog_2026",
          floorId: "blog-2026",
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
    "refuses a repository that is already a Floor",
    async ({ floors, events }) => {
      await floors.add("adrianeyre/web-shop");
      for (const name of ["adrianeyre/web-shop", "AdrianEyre/Web-Shop"]) {
        const error = await refusal(floors.add(name));
        expect(error.code).toBe(floorErrorCodes.floorExists);
        expect(error.message).toBe(
          'adrianeyre/web-shop is already a Floor ("web-shop").',
        );
      }
      expect(await floors.list()).toHaveLength(1);
      // floor.created and its four agent.created, once.
      expect(await events()).toHaveLength(5);
    },
  ],
  [
    "refuses the same repository added twice at once",
    async ({ floors, store }) => {
      const results = await Promise.allSettled([
        floors.add("adrianeyre/web-shop"),
        floors.add("adrianeyre/web-shop"),
      ]);
      expect(results.map(({ status }) => status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(await store.list({ includeArchived: true })).toHaveLength(1);
    },
  ],
  [
    "refuses an archived Floor's repository: it is still that Floor",
    async ({ floors }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.archive("web-shop");
      const error = await refusal(floors.add("adrianeyre/web-shop"));
      expect(error.code).toBe(floorErrorCodes.floorExists);
    },
  ],
  [
    "refuses a repository the App is not installed on",
    async ({ floors }) => {
      const error = await refusal(floors.add("adrianeyre/secret"));
      expect(error.code).toBe(floorErrorCodes.notInstalled);
      expect(error.message).toBe(
        "The GitHub App is not installed on adrianeyre/secret. Install it there first.",
      );
      expect(await floors.list()).toEqual([]);
    },
  ],
  [
    "gives Floors of repositories with the same name different ids",
    async ({ floors }) => {
      await floors.add("adrianeyre/web-shop");
      const second = await floors.add("acme/web-shop");
      expect(second.id).toBe("web-shop-2");
      expect((await floors.list()).map(({ id }) => id)).toEqual([
        "web-shop",
        "web-shop-2",
      ]);
    },
  ],
  [
    "changes settings, recording which ones changed",
    async ({ floors, events }) => {
      await floors.add("adrianeyre/web-shop");
      const updated = await floors.updateSettings("web-shop", {
        name: "Web shop",
        mergePolicy: "auto_merge",
        roundCap: 5,
        setupCommand: "pnpm install",
        testCommand: "pnpm test",
        tokenCaps: { daily: 2_000_000, monthly: null },
        concurrencyLimit: 2,
        planApproval: false,
        freshStartThreshold: 70,
        // Unchanged, so not recorded as a change.
        defaultBranch: "main",
      });
      expect(updated).toMatchObject({
        name: "Web shop",
        mergePolicy: "auto_merge",
        roundCap: 5,
        setupCommand: "pnpm install",
        testCommand: "pnpm test",
        tokenCaps: { daily: 2_000_000, monthly: null },
        concurrencyLimit: 2,
        planApproval: false,
        freshStartThreshold: 70,
        defaultBranch: "main",
      });
      expect(await floors.get("web-shop")).toEqual(updated);

      // Changing nothing records nothing.
      await floors.updateSettings("web-shop", { roundCap: 5 });
      expect(
        (await events()).filter(({ type }) => type === "config.changed"),
      ).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "floor",
          floorId: "web-shop",
          keys: [
            "name",
            "mergePolicy",
            "roundCap",
            "setupCommand",
            "testCommand",
            "tokenCaps",
            "concurrencyLimit",
            "planApproval",
            "freshStartThreshold",
          ],
        },
      ]);
    },
  ],
  [
    "renames a Floor to a name unique among the Floors in use, whatever its case, keeping its id",
    async ({ floors, events }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/Blog_2026");
      await floors.add("acme/web-shop");
      await floors.archive("web-shop-2");
      const renamed = await floors.updateSettings("web-shop", {
        name: "Storefront",
      });
      expect(renamed).toMatchObject({
        id: "web-shop",
        repository: "adrianeyre/web-shop",
        name: "Storefront",
      });
      expect((await floors.get("web-shop")).name).toBe("Storefront");
      expect((await floors.list()).map(({ name }) => name)).toEqual([
        "Storefront",
        "Blog_2026",
      ]);

      // Another Floor in use has it, whatever its case.
      const clash = await refusal(
        floors.updateSettings("blog-2026", { name: "STOREFRONT" }),
      );
      expect(clash.code).toBe(floorErrorCodes.floorNameTaken);
      expect(clash.message).toBe(
        'Another Floor is called "Storefront". Choose another name.',
      );
      expect((await floors.get("blog-2026")).name).toBe("Blog_2026");
      // An archived Floor's name is free; a Floor may change its own case.
      await floors.updateSettings("blog-2026", { name: "Web-Shop" });
      await floors.updateSettings("web-shop", { name: "storefront" });

      const renames = (await events()).filter(
        ({ type }) => type === "floor.renamed",
      );
      expect(renames).toEqual([
        {
          type: "floor.renamed",
          version: 1,
          floorId: "web-shop",
          name: "Storefront",
          previousName: "web-shop",
        },
        {
          type: "floor.renamed",
          version: 1,
          floorId: "blog-2026",
          name: "Web-Shop",
          previousName: "Blog_2026",
        },
        {
          type: "floor.renamed",
          version: 1,
          floorId: "web-shop",
          name: "storefront",
          previousName: "Storefront",
        },
      ]);
      // Each rename is a settings change too, which open pages read again on.
      expect(
        (await events())
          .filter(
            (event) =>
              event.type === "config.changed" && event.floorId === "web-shop",
          )
          .map((event) => event.type === "config.changed" && event.keys),
      ).toEqual([["name"], ["name"]]);
    },
  ],
  [
    "changes the default branch only to a branch the repository has",
    async ({ floors, fake }) => {
      await floors.add("adrianeyre/web-shop");
      const error = await refusal(
        floors.updateSettings("web-shop", { defaultBranch: "develop" }),
      );
      expect(error.code).toBe(floorErrorCodes.branchNotFound);
      expect((await floors.get("web-shop")).defaultBranch).toBe("main");

      fake.pushCommit("adrianeyre/web-shop", "develop");
      expect(
        (await floors.updateSettings("web-shop", { defaultBranch: "develop" }))
          .defaultBranch,
      ).toBe("develop");
    },
  ],
  [
    "archives a Floor: hidden, its intake stopped, its record kept",
    async ({ floors, events }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/Blog_2026");
      const archived = await floors.archive("web-shop");
      expect(archived.archivedAt).toBeInstanceOf(Date);
      expect((await floors.list()).map(({ id }) => id)).toEqual(["blog-2026"]);
      expect((await floors.active()).map(({ id }) => id)).toEqual([
        "blog-2026",
      ]);
      expect(await floors.get("web-shop")).toEqual(archived);
      expect((await events()).at(-1)).toEqual({
        type: "floor.archived",
        version: 1,
        floorId: "web-shop",
      });
      // Its row is still marked as a Floor in the repository list.
      expect(
        (await floors.installedRepositories()).find(
          ({ fullName }) => fullName === "adrianeyre/web-shop",
        )?.floorId,
      ).toBe("web-shop");
    },
  ],
  [
    "refuses to change or archive an archived Floor",
    async ({ floors, events }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.archive("web-shop");
      const before = (await events()).length;
      for (const attempt of [
        () => floors.updateSettings("web-shop", { roundCap: 4 }),
        () => floors.archive("web-shop"),
      ]) {
        expect((await refusal(attempt())).code).toBe(
          floorErrorCodes.floorArchived,
        );
      }
      expect((await floors.get("web-shop")).roundCap).toBe(3);
      expect(await events()).toHaveLength(before);
    },
  ],
  [
    "answers floor_not_found for a Floor that does not exist",
    async ({ floors }) => {
      for (const attempt of [
        () => floors.get("nowhere"),
        () => floors.updateSettings("nowhere", { roundCap: 4 }),
        () => floors.archive("nowhere"),
      ]) {
        expect((await refusal(attempt())).code).toBe(
          floorErrorCodes.floorNotFound,
        );
      }
    },
  ],
];

describe("Floors, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(
        setUp(
          memoryFloorStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      ),
    );
  }
});

describe("Floors, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(
        setUp(
          databaseFloorStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      ),
    );
  }

  postgresTest(
    "allows one Floor per repository, archived or not",
    async ({ database }) => {
      const store = databaseFloorStore(database.db);
      const floor = {
        id: "web-shop",
        githubRepositoryId: 101,
        repository: "adrianeyre/web-shop",
        name: "web-shop",
        defaultBranch: "main",
        setupCommand: "",
        testCommand: "",
        mergePolicy: "send_to_me" as const,
        roundCap: 3,
        tokenCaps: { daily: null, monthly: null },
        concurrencyLimit: null,
        priority: 0,
        requiredReviewerAgentIds: [],
        planApproval: true,
        mostAgents: 8,
        spinOffFromChat: true,
        hourlyStatusUpdates: true,
        freshStartThreshold: 85,
        gitIdentity: null,
        template: { id: "development", name: "Development" },
        theme: "office" as const,
        createdAt: start,
        archivedAt: null,
      };
      expect(await store.create(floor, [])).toBe("created");
      await store.archive("web-shop", start);
      expect(await store.create({ ...floor, id: "web-shop-2" }, [])).toBe(
        "repository_taken",
      );
      expect(
        await store.create({ ...floor, githubRepositoryId: 102 }, []),
      ).toBe("id_taken");
    },
  );
});

describe("Floors without a working GitHub", () => {
  it("refuses to add a Floor while no GitHub App or access token is set up", async () => {
    // With no GitHub at all, and with the live GitHub of no connection.
    for (const github of [undefined, createLiveGitHub()]) {
      const floors = createFloors({
        store: memoryFloorStore(),
        github,
        events: createEventBus({ store: memoryEventStore() }),
      });
      for (const attempt of [
        () => floors.add("adrianeyre/web-shop"),
        () => floors.installedRepositories(),
      ]) {
        const error = await refusal(attempt());
        expect(error.code).toBe(floorErrorCodes.githubNotConfigured);
        expect(error.message).toBe(
          "GitHub is not set up: add a GitHub App or an access token in Floor Settings.",
        );
      }
    }
  });

  it("says when GitHub cannot be reached", async () => {
    const down = new GitHubError(
      0,
      "GitHub could not be reached: ECONNREFUSED",
    );
    const unreachable: GitHubApp = {
      installations: () => Promise.reject(down),
      repositories: () => Promise.reject(down),
      repository: (fullName) => ({
        ...createFakeGitHub().repository(fullName),
        get: () => Promise.reject(down),
      }),
    };
    const { floors } = setUp(
      memoryFloorStore(),
      createEventBus({ store: memoryEventStore() }),
      unreachable,
    );
    for (const attempt of [
      () => floors.add("adrianeyre/web-shop"),
      () => floors.installedRepositories(),
    ]) {
      expect((await refusal(attempt())).code).toBe(
        floorErrorCodes.githubUnavailable,
      );
    }
  });
});

describe("a Floor's id", () => {
  it("is tried a bounded number of times", async () => {
    const fake = createFakeGitHub();
    fake.installRepository("adrianeyre/web-shop");
    const store = memoryFloorStore();
    let attempts = 0;
    const floors = createFloors({
      store: {
        ...store,
        create: () => {
          attempts += 1;
          return Promise.resolve("id_taken");
        },
      },
      github: fake,
      events: createEventBus({ store: memoryEventStore() }),
    });
    await expect(floors.add("adrianeyre/web-shop")).rejects.toThrow(
      "No free Floor id for adrianeyre/web-shop after 100 tries.",
    );
    expect(attempts).toBe(100);
  });

  it("is a slug of the repository's name", () => {
    expect(floorSlug("web-shop")).toBe("web-shop");
    expect(floorSlug("Blog_2026")).toBe("blog-2026");
    expect(floorSlug("my.site.io")).toBe("my-site-io");
    expect(floorSlug("--Ünïcode--")).toBe("n-code");
    expect(floorSlug("___")).toBe("floor");
    expect(floorSlug("a".repeat(60))).toHaveLength(40);
  });
});
