import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { GitHubError, type GitHubApp } from "@ai-office/github";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createBranches,
  databaseStores,
  databaseWorkQueueStore,
  memoryStores,
  memoryWorkQueueStore,
  type OfficeStores,
  type WorkQueueStore,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  floorBranchesSchema,
  floorErrorCodes,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { buildApp, type AppOptions } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// A Floor's AI Office branches through the API (the Branches page): each
// branch AI Office made, as a lane off the default branch, read from the
// GitHub App and the work queue the server keeps. Read-only, behind the
// Owner's sign-in like every Floor route. Each case runs in memory and in
// Postgres 18.

const repository = "adrianeyre/web-shop";
const at = new Date("2026-10-12T09:00:00.000Z");

async function serve(
  stores: OfficeStores,
  work: WorkQueueStore,
  bus: EventBus,
  options: Partial<AppOptions> = {},
) {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  fake.installRepository("adrianeyre/blog");
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github: fake,
    workQueue: work,
    ...options,
  });
  const owner = await signIn(server);
  for (const name of [repository, "adrianeyre/blog"]) {
    const added = await server.inject({
      method: "POST",
      url: "/api/floors",
      headers: owner.headers,
      payload: { repository: name },
    });
    expect(added.statusCode).toBe(201);
  }
  return { server, owner, fake };
}

async function answers(
  stores: OfficeStores,
  work: WorkQueueStore,
  bus: EventBus,
): Promise<void> {
  const { server, owner, fake } = await serve(stores, work, bus);
  const issue = fake.createIssue(repository, {
    title: "Add a basket",
    labels: ["ai-office"],
  });
  const branch = "ai-office/1-add-a-basket";
  fake.pushCommit(repository, branch, {
    message: "Add a basket\n\nAgent: Ada (coder, Claude claude-opus-5-5)",
  });
  const head = fake.pushCommit(repository, branch, { message: "Total it" });
  fake.pushCommit(repository, "main", { message: "Meanwhile on main" });
  fake.pushCommit(repository, "feature/by-hand");
  const coder =
    agentListSchema
      .parse(
        (
          await server.inject({
            url: "/api/floors/web-shop/agents",
            headers: owner.headers,
          })
        ).json(),
      )
      .agents.find(({ role }) => role === "coder")?.id ?? "";
  await work.add(
    {
      floorId: "web-shop",
      issue: issue.number,
      stage: "needs-work",
      agentId: coder,
      priority: "normal",
    },
    at,
  );
  await work.claimNext(3, at);

  const response = await server.inject({
    url: "/api/floors/web-shop/branches",
    headers: owner.headers,
  });
  expect(response.statusCode).toBe(200);
  const body = floorBranchesSchema.parse(response.json());
  expect(body).toMatchObject({
    floorId: "web-shop",
    repository,
    defaultBranch: { name: "main" },
  });
  expect(body.lanes).toHaveLength(1);
  expect(body.lanes[0]).toMatchObject({
    name: branch,
    headSha: head,
    aheadBy: 2,
    behindBy: 1,
    likelyToConflict: false,
    issue: { number: issue.number, title: "Add a basket" },
    pullRequest: null,
    ci: "none",
    work: { kind: "agent", agentId: coder, role: "coder" },
  });
  expect(
    body.lanes[0]?.commits.map(({ message, agent }) => [message, agent]),
  ).toEqual([
    ["Add a basket", "Ada (coder, Claude claude-opus-5-5)"],
    ["Total it", null],
  ]);
  // Nothing of the App's credentials reaches the browser.
  expect(response.body).not.toMatch(/ghs_|token/i);

  // A Floor with no AI Office branches has no lanes.
  const blog = await server.inject({
    url: "/api/floors/blog/branches",
    headers: owner.headers,
  });
  expect(floorBranchesSchema.parse(blog.json()).lanes).toEqual([]);
  await server.close();
}

async function refuses(
  stores: OfficeStores,
  work: WorkQueueStore,
  bus: EventBus,
): Promise<void> {
  const { server, owner } = await serve(stores, work, bus);
  // Signed out, it is refused.
  const signedOut = await server.inject({
    url: "/api/floors/web-shop/branches",
  });
  expect(signedOut.statusCode).toBe(401);

  // A Floor that is not there, or no longer in use, cannot be seen.
  const unknown = await server.inject({
    url: "/api/floors/nowhere/branches",
    headers: owner.headers,
  });
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toMatchObject({
    error: floorErrorCodes.floorNotFound,
  });
  const archived = await server.inject({
    method: "POST",
    url: "/api/floors/blog/archive",
    headers: owner.headers,
  });
  expect(archived.statusCode).toBe(200);
  const hidden = await server.inject({
    url: "/api/floors/blog/branches",
    headers: owner.headers,
  });
  expect(hidden.statusCode).toBe(409);
  expect(hidden.json()).toMatchObject({
    error: floorErrorCodes.floorArchived,
  });

  // It only reads: there is no way to change a branch through it.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    const write = await server.inject({
      method,
      url: "/api/floors/web-shop/branches",
      headers: owner.headers,
    });
    expect(write.statusCode).toBe(404);
  }
  await server.close();
}

describe("GET /api/floors/:floorId/branches", () => {
  const inMemory = () => {
    const stores = memoryStores();
    return [
      stores,
      memoryWorkQueueStore(stores.floors),
      createEventBus({ store: memoryEventStore() }),
    ] as const;
  };

  it("answers a Floor's AI Office branches as lanes, in memory", async () => {
    await answers(...inMemory());
  });

  it("refuses a signed-out request and a Floor that cannot be seen, in memory", async () => {
    await refuses(...inMemory());
  });

  it("answers a GitHub failure with 502 and what GitHub said, and keeps serving", async () => {
    const stores = memoryStores();
    const fake = createFakeGitHub();
    fake.installRepository(repository);
    fake.installRepository("adrianeyre/blog");
    fake.pushCommit(repository, "ai-office/1-add-a-basket");
    let failing = true;
    const flaky: GitHubApp = {
      ...fake,
      repository(fullName) {
        const client = fake.repository(fullName);
        return {
          ...client,
          listBranches: (prefix) =>
            failing
              ? Promise.reject(
                  new GitHubError(
                    403,
                    "GitHub answered 403: API rate limit exceeded",
                  ),
                )
              : client.listBranches(prefix),
        };
      },
    };
    const work = memoryWorkQueueStore(stores.floors);
    const bus = createEventBus({ store: memoryEventStore() });
    const { server, owner } = await serve(stores, work, bus, {
      github: flaky,
      // Asked again at once, rather than five seconds after the failure.
      branches: createBranches({
        floors: stores.floors,
        agents: stores.agents,
        roles: stores.roles,
        work,
        grilling: stores.grilling,
        github: flaky,
        minIntervalMs: 0,
      }),
    });
    const failed = await server.inject({
      url: "/api/floors/web-shop/branches",
      headers: owner.headers,
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({
      error: floorErrorCodes.githubUnavailable,
      message:
        "GitHub could not be asked: GitHub answered 403: API rate limit exceeded",
    });
    // The rest of the server is unharmed.
    const floors = await server.inject({
      url: "/api/floors",
      headers: owner.headers,
    });
    expect(floors.statusCode).toBe(200);
    failing = false;
    const later = await server.inject({
      url: "/api/floors/web-shop/branches",
      headers: owner.headers,
    });
    expect(later.statusCode).toBe(200);
    expect(floorBranchesSchema.parse(later.json()).lanes).toHaveLength(1);
    await server.close();
  });

  postgresTest(
    "answers a Floor's AI Office branches as lanes, in Postgres 18",
    async ({ database }) => {
      await answers(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
    },
  );

  postgresTest(
    "refuses a signed-out request and a Floor that cannot be seen, in Postgres 18",
    async ({ database }) => {
      await refuses(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
    },
  );
});
