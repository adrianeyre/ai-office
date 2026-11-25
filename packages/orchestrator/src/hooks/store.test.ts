import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { keptHookRuns, type HookFields } from "./store.ts";

// Where each Floor's Hooks, their runs and the head their push Hooks last
// saw are kept (Guidelines, Specs and Hooks PRD, FR-118 to FR-121; ADR
// 0016): in memory and in Postgres 18, alike.

const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 24, 9, 0) + minute * 60_000);

const migrationCheck: HookFields = {
  name: "Migration check",
  trigger: "pull_request_opened",
  stage: null,
  labels: [],
  filePatterns: ["**/*.sql"],
  agentId: null,
  role: "reviewer",
  skillName: "migration-check",
  runsPerHour: 12,
  enabled: true,
};

async function run(stores: OfficeStores): Promise<void> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const floors = createFloors({
    store: stores.floors,
    github,
    events: createEventBus({ store: memoryEventStore() }),
  });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");
  const { hooks } = stores;

  const added = await hooks.create("web-shop", migrationCheck, at(1));
  if (added === "name_taken") {
    throw new Error("The first Hook's name is free.");
  }
  expect(added).toEqual({
    ...migrationCheck,
    id: added.id,
    floorId: "web-shop",
    failures: 0,
    createdAt: at(1),
    updatedAt: at(1),
  });
  // Its name is the Floor's, whatever its case; another Floor may use it.
  expect(
    await hooks.create(
      "web-shop",
      { ...migrationCheck, name: "MIGRATION CHECK" },
      at(2),
    ),
  ).toBe("name_taken");
  const blogs = await hooks.create("blog", migrationCheck, at(2));
  expect(blogs).not.toBe("name_taken");
  const push = await hooks.create(
    "web-shop",
    {
      ...migrationCheck,
      name: "Schema watch",
      trigger: "push",
      filePatterns: ["db/**"],
      role: null,
      agentId: "ada",
    },
    at(3),
  );
  if (push === "name_taken") {
    throw new Error("The second Hook's name is free.");
  }
  expect((await hooks.list("web-shop")).map(({ name }) => name)).toEqual([
    "Migration check",
    "Schema watch",
  ]);
  expect((await hooks.floorsWatchingPushes()).sort()).toEqual(["web-shop"]);

  // Three failures in a row turn it off; a change starts the count again.
  expect(await hooks.recordFailure("web-shop", added.id, 3, at(4))).toEqual(
    expect.objectContaining({ failures: 1, enabled: true, updatedAt: at(1) }),
  );
  await hooks.recordSuccess("web-shop", added.id);
  await hooks.recordFailure("web-shop", added.id, 3, at(5));
  await hooks.recordFailure("web-shop", added.id, 3, at(6));
  expect(await hooks.recordFailure("web-shop", added.id, 3, at(7))).toEqual(
    expect.objectContaining({ failures: 3, enabled: false, updatedAt: at(7) }),
  );
  expect(
    await hooks.update(
      "web-shop",
      added.id,
      { ...migrationCheck, enabled: true, runsPerHour: 4 },
      at(8),
    ),
  ).toEqual(
    expect.objectContaining({
      failures: 0,
      enabled: true,
      runsPerHour: 4,
      updatedAt: at(8),
    }),
  );
  expect(
    await hooks.update(
      "web-shop",
      added.id,
      { ...migrationCheck, name: "schema watch" },
      at(8),
    ),
  ).toBe("name_taken");
  expect(await hooks.update("blog", added.id, migrationCheck, at(8))).toBe(
    undefined,
  );

  // Runs: newest first, counted by the hour, one per pull request.
  const first = await hooks.startRun({
    hookId: added.id,
    floorId: "web-shop",
    agentId: "linus",
    trigger: "pull_request_opened",
    issue: 4,
    pullRequest: 14,
    startedAt: at(10),
  });
  expect(first).toMatchObject({ status: "running", finishedAt: null });
  expect(
    await hooks.finishRun(first.id, {
      status: "succeeded",
      finishedAt: at(11),
      error: null,
      result: "Fine.",
      commentUrl: "https://github.com/adrianeyre/web-shop/pull/14#c1",
    }),
  ).toMatchObject({ status: "succeeded", result: "Fine." });
  // Ended once.
  expect(
    await hooks.finishRun(first.id, {
      status: "failed",
      finishedAt: at(12),
      error: "Again",
      result: null,
      commentUrl: null,
    }),
  ).toBe(undefined);
  const second = await hooks.startRun({
    hookId: added.id,
    floorId: "web-shop",
    agentId: null,
    trigger: "pull_request_opened",
    issue: 5,
    pullRequest: 15,
    startedAt: at(20),
  });
  expect((await hooks.runs(added.id, 5)).map(({ id }) => id)).toEqual([
    second.id,
    first.id,
  ]);
  expect(await hooks.runsSince(added.id, at(10))).toBe(1);
  expect(await hooks.runsSince(added.id, at(9))).toBe(2);
  expect(await hooks.ranOnPullRequest(added.id, 14)).toBe(true);
  expect(await hooks.ranOnPullRequest(added.id, 16)).toBe(false);
  // What AI Office stopped in the middle of ends as failed.
  expect(await hooks.failRunning("Stopped.", at(21))).toBe(1);
  expect((await hooks.runs(added.id, 1))[0]).toMatchObject({
    status: "failed",
    error: "Stopped.",
    finishedAt: at(21),
  });

  // Only the newest runs are kept.
  for (let index = 0; index < keptHookRuns; index += 1) {
    const each = await hooks.startRun({
      hookId: added.id,
      floorId: "web-shop",
      agentId: "linus",
      trigger: "pull_request_opened",
      issue: null,
      pullRequest: null,
      startedAt: at(30 + index),
    });
    await hooks.finishRun(each.id, {
      status: "succeeded",
      finishedAt: at(30 + index),
      error: null,
      result: null,
      commentUrl: null,
    });
  }
  const kept = await hooks.runs(added.id, keptHookRuns + 10);
  expect(kept.length).toBeLessThanOrEqual(keptHookRuns + 1);
  expect(kept.map(({ id }) => id)).not.toContain(first.id);

  // The head push Hooks last saw.
  expect(await hooks.pushHead("web-shop")).toBe(undefined);
  await hooks.setPushHead("web-shop", "a".repeat(40), at(40));
  await hooks.setPushHead("web-shop", "b".repeat(40), at(41));
  expect(await hooks.pushHead("web-shop")).toBe("b".repeat(40));

  // Deleting a Hook deletes its runs.
  expect(await hooks.remove("web-shop", added.id)).toMatchObject({
    id: added.id,
  });
  expect(await hooks.remove("web-shop", added.id)).toBe(undefined);
  expect(await hooks.runs(added.id, 5)).toEqual([]);
  expect(await hooks.get("web-shop", added.id)).toBe(undefined);
  expect((await hooks.list("blog")).map(({ name }) => name)).toEqual([
    "Migration check",
  ]);
}

describe("the Hook store", () => {
  it("in memory keeps each Floor's Hooks, their runs and their push head", async () => {
    await run(memoryStores());
  });

  postgresTest(
    "in Postgres 18 keeps each Floor's Hooks, their runs and their push head",
    async ({ database }) => {
      await run(databaseStores(database.db));
    },
  );
});
