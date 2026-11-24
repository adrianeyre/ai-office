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
  guidelineContentHash,
  memoryStores,
  type GuidelineProposals,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  floorErrorCodes,
  guidelineErrorCodes,
  guidelineProposalListSchema,
  openedGuidelineProposalSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Guidelines Agents propose, in the Floor admin's Guidelines card
// (Guidelines, Specs and Hooks PRD, FR-110, FR-111): listed for the Owner,
// opened as a pull request or rejected. One that is gone is a 404; one
// settled already a 409. The orchestrator's scenarios open them against a
// real Git remote; here the API is checked, in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly stores: OfficeStores;
  readonly coder: string;
}

async function setUp(
  stores: OfficeStores,
  bus: EventBus,
  options: {
    readonly github?: boolean;
    readonly proposals?: GuidelineProposals;
  } = {},
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
    ...(options.proposals === undefined
      ? {}
      : { guidelineProposals: options.proposals }),
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
  const coder = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "coder",
  );
  return { server, owner: signedIn, stores, coder: coder?.id ?? "" };
}

const request = (
  { server, owner: signedIn }: Setup,
  method: "GET" | "POST",
  url: string,
) => server.inject({ method, url, headers: signedIn.headers });

/** A proposal the coder made on `issue`, kept as the flows keep it. */
const propose = async (setup: Setup, issue: number, content: string) => {
  const kept = await setup.stores.guidelineProposals.propose({
    floorId: "web-shop",
    name: "accessibility",
    contentHash: guidelineContentHash(content),
    content,
    agentId: setup.coder,
    issue,
    createdAt: new Date("2026-11-24T10:00:00.000Z"),
  });
  if (kept === undefined) {
    throw new Error("The proposal is kept.");
  }
  return kept.id;
};

type Case = [string, (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "lists the proposals waiting, rejects one once, and refuses one that is gone",
    async (setup) => {
      const first = await propose(setup, 4, "Every image has alt text.\n");
      await propose(setup, 5, "Every image has a caption.\n");
      const listed = await request(
        setup,
        "GET",
        "/api/floors/web-shop/guideline-proposals",
      );
      expect(listed.statusCode).toBe(200);
      const { proposals } = guidelineProposalListSchema.parse(listed.json());
      expect(
        proposals.map(({ issue, name, path }) => [issue, name, path]),
      ).toEqual([
        [4, "accessibility", ".agents/guidelines/accessibility.md"],
        [5, "accessibility", ".agents/guidelines/accessibility.md"],
      ]);
      expect(proposals[0]).toMatchObject({
        content: "Every image has alt text.\n",
        agentId: setup.coder,
        agentName: expect.any(String) as unknown,
        proposedAt: "2026-11-24T10:00:00.000Z",
      });

      const rejected = await request(
        setup,
        "POST",
        `/api/floors/web-shop/guideline-proposals/${String(first)}/reject`,
      );
      expect(rejected.statusCode).toBe(200);
      expect(
        guidelineProposalListSchema
          .parse(rejected.json())
          .proposals.map(({ issue }) => issue),
      ).toEqual([5]);

      for (const action of ["reject", "open"]) {
        const again = await request(
          setup,
          "POST",
          `/api/floors/web-shop/guideline-proposals/${String(first)}/${action}`,
        );
        expect(again.statusCode).toBe(409);
        expect(apiErrorSchema.parse(again.json()).error).toBe(
          guidelineErrorCodes.proposalSettled,
        );
      }
      for (const id of ["999", "abc", "0"]) {
        const gone = await request(
          setup,
          "POST",
          `/api/floors/web-shop/guideline-proposals/${id}/reject`,
        );
        expect(gone.statusCode).toBe(404);
        expect(apiErrorSchema.parse(gone.json()).error).toBe(
          guidelineErrorCodes.proposalNotFound,
        );
      }
      const noFloor = await request(
        setup,
        "GET",
        "/api/floors/blog/guideline-proposals",
      );
      expect(noFloor.statusCode).toBe(404);
      expect(apiErrorSchema.parse(noFloor.json()).error).toBe(
        floorErrorCodes.floorNotFound,
      );
    },
  ],
  [
    "needs a signed-in Owner",
    async (setup) => {
      for (const [method, url] of [
        ["GET", "/api/floors/web-shop/guideline-proposals"],
        ["POST", "/api/floors/web-shop/guideline-proposals/1/open"],
        ["POST", "/api/floors/web-shop/guideline-proposals/1/reject"],
      ] as const) {
        const signedOut = await setup.server.inject({ method, url });
        expect(signedOut.statusCode).toBe(401);
      }
    },
  ],
];

describe("the Guideline proposals API, in memory", () => {
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

  it("answers 503 when a proposal is opened while GitHub is not set up, and keeps it waiting", async () => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    // The Floor was added while GitHub was set up.
    const before = await setUp(stores, bus);
    const id = await propose(before, 4, "Every image has alt text.\n");
    await before.server.close();
    const setup = await setUp(stores, bus, { github: false });
    const response = await request(
      setup,
      "POST",
      `/api/floors/web-shop/guideline-proposals/${String(id)}/open`,
    );
    expect(response.statusCode).toBe(503);
    expect(apiErrorSchema.parse(response.json()).error).toBe(
      floorErrorCodes.githubNotConfigured,
    );
    expect(await stores.guidelineProposals.waiting("web-shop")).toHaveLength(1);
  });

  it("answers the pull request a proposal was opened as, and those still waiting", async () => {
    const opened: number[] = [];
    const proposals: GuidelineProposals = {
      propose: () => Promise.resolve(undefined),
      list: () => Promise.resolve({ proposals: [] }),
      reject: () => Promise.resolve({ proposals: [] }),
      open: (_floorId, id) => {
        opened.push(id);
        return Promise.resolve({
          pullRequest: {
            number: 12,
            url: `https://github.com/${repository}/pull/12`,
          },
          proposals: [],
        });
      },
    };
    const setup = await setUp(
      memoryStores(),
      createEventBus({ store: memoryEventStore() }),
      { proposals },
    );
    const response = await request(
      setup,
      "POST",
      "/api/floors/web-shop/guideline-proposals/7/open",
    );
    expect(response.statusCode).toBe(200);
    expect(openedGuidelineProposalSchema.parse(response.json())).toEqual({
      pullRequest: {
        number: 12,
        url: `https://github.com/${repository}/pull/12`,
      },
      proposals: [],
    });
    expect(opened).toEqual([7]);
  });
});

describe("the Guideline proposals API, in Postgres", () => {
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
