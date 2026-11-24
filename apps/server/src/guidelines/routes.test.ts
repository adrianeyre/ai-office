import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  guidelineContentHash,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  floorErrorCodes,
  floorGuidelineListSchema,
  guidelineErrorCodes,
  noticeListSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// A Floor's Guidelines API (Guidelines, Specs and Hooks PRD, FR-103,
// FR-111; ADR 0014): each Guideline on the default branch with its
// inclusion, patterns, description, the version the Owner approved, any
// awaiting approval and any error; approving and dismissing exactly the
// version the Owner saw, and a 409 for one that changed meanwhile. Each
// case runs in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
/** General Settings' Intake card's Owner login, by default. */
const owner = "adrianeyre";
const folder = ".agents/guidelines";

const tech = "Use pnpm.\n";
const migrationsV1 =
  '---\ninclusion: fileMatch\nfileMatchPattern: "packages/db/**"\ndescription: How migrations are written\n---\n\nOne migration per change.\n';
const migrationsV2 =
  '---\ninclusion: fileMatch\nfileMatchPattern: ["packages/db/**", "migrations/**"]\ndescription: How migrations are written\n---\n\nOne migration per change, never edited once merged.\n';
const migrationsV3 =
  '---\ninclusion: fileMatch\nfileMatchPattern: "packages/db/**"\ndescription: How migrations are written\n---\n\nAsk first.\n';

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly fake: FakeGitHub;
  readonly bus: EventBus;
}

async function setUp(
  stores: OfficeStores,
  bus: EventBus,
  options: { readonly github?: boolean } = {},
): Promise<Setup> {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    ...(options.github === false ? {} : { github: fake }),
  });
  const signedIn = await signIn(server);
  if (options.github !== false) {
    const added = await server.inject({
      method: "POST",
      url: "/api/floors",
      headers: signedIn.headers,
      payload: { repository },
    });
    expect(added.statusCode).toBe(201);
  }
  return { server, owner: signedIn, fake, bus };
}

const request = (
  { server, owner: signedIn }: Setup,
  method: "GET" | "POST",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: signedIn.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const list = async (setup: Setup) => {
  const response = await request(
    setup,
    "GET",
    "/api/floors/web-shop/guidelines",
  );
  expect(response.statusCode).toBe(200);
  return floorGuidelineListSchema.parse(response.json());
};

const guidelineEvents = async ({ bus }: Setup) =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type.startsWith("guideline."))
    .map((event) => [event.type, "name" in event ? event.name : ""]);

const guidelineNotices = async (setup: Setup) =>
  noticeListSchema
    .parse((await request(setup, "GET", "/api/notices")).json())
    .notices.filter(({ title }) => title.startsWith("Guidelines changed"));

/**
 * The Owner's push of `tech` and `migrations`, read, then someone else's
 * change to `migrations`.
 */
const pushOwnerThenSomeoneElse = async (setup: Setup) => {
  const { fake } = setup;
  fake.pushCommit(repository, "main", {
    files: {
      [`${folder}/tech.md`]: tech,
      [`${folder}/migrations.md`]: migrationsV1,
    },
    pusher: owner,
  });
  await list(setup);
  return fake.pushCommit(repository, "main", {
    files: { [`${folder}/migrations.md`]: migrationsV2 },
    // Whoever the commit says wrote it.
    author: owner,
    pusher: "mallory",
  });
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "lists none for a Floor without Guidelines",
    async (setup) => {
      expect(await list(setup)).toEqual({ guidelines: [], awaitingCount: 0 });
      expect(await guidelineNotices(setup)).toEqual([]);
    },
  ],
  [
    "lists each Guideline's inclusion, patterns, description, approved and awaiting versions and errors",
    async (setup) => {
      const changed = await pushOwnerThenSomeoneElse(setup);
      setup.fake.pushCommit(repository, "main", {
        files: {
          [`${folder}/Bad_Name.md`]: tech,
          [`${folder}/deploy.md`]:
            "Deploy with ghp_0123456789abcdefghijABCDEFGHIJ012345.\n",
        },
        pusher: owner,
      });

      const listed = await list(setup);
      expect(listed.awaitingCount).toBe(1);
      expect(listed.guidelines).toEqual([
        {
          name: "Bad_Name",
          path: `${folder}/Bad_Name.md`,
          inclusion: null,
          fileMatchPatterns: [],
          description: null,
          approved: null,
          awaiting: null,
          error: {
            refusal: "invalid",
            reason: expect.stringContaining("lowercase letters") as string,
            secretLines: [],
          },
        },
        {
          name: "deploy",
          path: `${folder}/deploy.md`,
          inclusion: null,
          fileMatchPatterns: [],
          description: null,
          approved: null,
          awaiting: null,
          error: {
            refusal: "holds_secret",
            reason:
              "Line 1 looks like it holds a credential, which a Guideline never does: take it out.",
            secretLines: [1],
          },
        },
        {
          name: "migrations",
          path: `${folder}/migrations.md`,
          inclusion: "fileMatch",
          fileMatchPatterns: ["packages/db/**"],
          description: "How migrations are written",
          approved: {
            contentHash: guidelineContentHash(migrationsV1),
            approval: "owner_push",
            content: migrationsV1,
            current: false,
          },
          awaiting: {
            contentHash: guidelineContentHash(migrationsV2),
            status: "awaiting",
            content: migrationsV2,
            commitSha: changed,
          },
          error: null,
        },
        {
          name: "tech",
          path: `${folder}/tech.md`,
          inclusion: "always",
          fileMatchPatterns: [],
          description: null,
          approved: {
            contentHash: guidelineContentHash(tech),
            approval: "owner_push",
            content: tech,
            current: true,
          },
          awaiting: null,
          error: null,
        },
      ]);
      // A line like a credential is named, never repeated.
      expect(JSON.stringify(listed)).not.toContain("ghp_");

      // One action Notice, whose action opens the Guidelines card.
      const [notice, ...others] = await guidelineNotices(setup);
      expect(others).toEqual([]);
      expect(notice).toMatchObject({
        kind: "action",
        title: "Guidelines changed on web-shop: 1 awaiting approval",
        actions: [
          {
            label: "Open Guidelines",
            href: "/floor-settings/web-shop#guidelines",
          },
        ],
      });
    },
  ],
  [
    "approves the version the Owner saw: Agents get it, and the Notice goes",
    async (setup) => {
      await pushOwnerThenSomeoneElse(setup);
      const seen = await list(setup);
      const awaiting = seen.guidelines.find(
        ({ name }) => name === "migrations",
      )?.awaiting;
      expect(awaiting?.status).toBe("awaiting");

      const approved = await request(
        setup,
        "POST",
        "/api/floors/web-shop/guidelines/migrations/approve",
        { contentHash: awaiting?.contentHash },
      );
      expect(approved.statusCode).toBe(200);
      const after = floorGuidelineListSchema.parse(approved.json());
      expect(after.awaitingCount).toBe(0);
      expect(
        after.guidelines.find(({ name }) => name === "migrations"),
      ).toMatchObject({
        fileMatchPatterns: ["packages/db/**", "migrations/**"],
        approved: {
          contentHash: guidelineContentHash(migrationsV2),
          approval: "owner_admin",
          content: migrationsV2,
          current: true,
        },
        awaiting: null,
      });
      expect(await list(setup)).toEqual(after);
      expect(await guidelineEvents(setup)).toEqual([
        ["guideline.approved", "migrations"],
        ["guideline.approved", "tech"],
        ["guideline.awaiting", "migrations"],
        ["guideline.approved", "migrations"],
      ]);
      expect(await guidelineNotices(setup)).toEqual([]);
    },
  ],
  [
    "dismisses the version awaiting approval: Agents keep the approved one",
    async (setup) => {
      await pushOwnerThenSomeoneElse(setup);
      await list(setup);
      const dismissed = await request(
        setup,
        "POST",
        "/api/floors/web-shop/guidelines/migrations/dismiss",
        { contentHash: guidelineContentHash(migrationsV2) },
      );
      expect(dismissed.statusCode).toBe(200);
      const after = floorGuidelineListSchema.parse(dismissed.json());
      expect(after.awaitingCount).toBe(0);
      expect(
        after.guidelines.find(({ name }) => name === "migrations"),
      ).toMatchObject({
        approved: {
          contentHash: guidelineContentHash(migrationsV1),
          current: false,
        },
        awaiting: {
          contentHash: guidelineContentHash(migrationsV2),
          status: "dismissed",
        },
      });
      expect((await guidelineEvents(setup)).at(-1)).toEqual([
        "guideline.dismissed",
        "migrations",
      ]);
      expect(await guidelineNotices(setup)).toEqual([]);

      // Dismissed already.
      const again = await request(
        setup,
        "POST",
        "/api/floors/web-shop/guidelines/migrations/dismiss",
        { contentHash: guidelineContentHash(migrationsV2) },
      );
      expect(again.statusCode).toBe(409);
      expect(apiErrorSchema.parse(again.json()).error).toBe(
        guidelineErrorCodes.guidelineChanged,
      );
    },
  ],
  [
    "refuses, with a 409, to approve or dismiss a version that changed meanwhile",
    async (setup) => {
      await pushOwnerThenSomeoneElse(setup);
      await list(setup);
      // Changed again after the Owner looked.
      setup.fake.pushCommit(repository, "main", {
        files: { [`${folder}/migrations.md`]: migrationsV3 },
        pusher: "mallory",
      });
      for (const action of ["approve", "dismiss"]) {
        const stale = await request(
          setup,
          "POST",
          `/api/floors/web-shop/guidelines/migrations/${action}`,
          { contentHash: guidelineContentHash(migrationsV2) },
        );
        expect({ action, status: stale.statusCode }).toEqual({
          action,
          status: 409,
        });
        expect(apiErrorSchema.parse(stale.json())).toEqual({
          error: guidelineErrorCodes.guidelineChanged,
          message:
            'Guideline "migrations" on web-shop has changed since: look at its version now.',
        });
      }
      // Agents still get the version approved before.
      const migrations = (await list(setup)).guidelines.find(
        ({ name }) => name === "migrations",
      );
      expect(migrations).toMatchObject({
        approved: { contentHash: guidelineContentHash(migrationsV1) },
        awaiting: { contentHash: guidelineContentHash(migrationsV3) },
      });

      // One approved already has nothing waiting.
      const approvedAlready = await request(
        setup,
        "POST",
        "/api/floors/web-shop/guidelines/tech/approve",
        { contentHash: guidelineContentHash(tech) },
      );
      expect(approvedAlready.statusCode).toBe(409);
      expect(apiErrorSchema.parse(approvedAlready.json()).error).toBe(
        guidelineErrorCodes.guidelineChanged,
      );
    },
  ],
  [
    "answers 404 for an unknown Guideline or Floor, and 400 for a body without a hash",
    async (setup) => {
      await pushOwnerThenSomeoneElse(setup);
      const unknown = await request(
        setup,
        "POST",
        "/api/floors/web-shop/guidelines/nowhere/approve",
        { contentHash: guidelineContentHash(tech) },
      );
      expect(unknown.statusCode).toBe(404);
      expect(apiErrorSchema.parse(unknown.json()).error).toBe(
        guidelineErrorCodes.guidelineNotFound,
      );
      for (const url of [
        "/api/floors/elsewhere/guidelines",
        "/api/floors/elsewhere/guidelines/tech/approve",
      ]) {
        const response = await request(
          setup,
          url.endsWith("approve") ? "POST" : "GET",
          url,
          { contentHash: guidelineContentHash(tech) },
        );
        expect({ url, status: response.statusCode }).toEqual({
          url,
          status: 404,
        });
        expect(apiErrorSchema.parse(response.json()).error).toBe(
          floorErrorCodes.floorNotFound,
        );
      }
      for (const payload of [{}, { contentHash: "abc" }, { hash: "x" }]) {
        const response = await request(
          setup,
          "POST",
          "/api/floors/web-shop/guidelines/migrations/approve",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
      const signedOut = await setup.server.inject({
        method: "GET",
        url: "/api/floors/web-shop/guidelines",
      });
      expect(signedOut.statusCode).toBe(401);
    },
  ],
];

describe("the Guidelines API, in memory", () => {
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

  it("answers 503 while GitHub is not set up", async () => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    // The Floor was added while GitHub was set up.
    await (await setUp(stores, bus)).server.close();
    const setup = await setUp(stores, bus, { github: false });
    const response = await request(
      setup,
      "GET",
      "/api/floors/web-shop/guidelines",
    );
    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json()).error).toBe(
      floorErrorCodes.githubNotConfigured,
    );
  });
});

describe("the Guidelines API, in Postgres", () => {
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
