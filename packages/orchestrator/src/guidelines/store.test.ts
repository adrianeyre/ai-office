import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { guidelineContentHash } from "./approval.ts";

// Where the Guideline versions the Owner approved, and those awaiting
// approval or dismissed, are kept (ADR 0014), and the Floors suggested
// `/guidelines` (FR-109): in memory and in Postgres 18, alike.

const at = (minute: number) =>
  new Date(`2026-11-24T09:${String(minute).padStart(2, "0")}:00.000Z`);

const version = (name: string, content: string) => ({
  name,
  contentHash: guidelineContentHash(content),
  content,
});

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
  const { guidelines } = stores;

  const pnpm = version("tech", "Use pnpm.\n");
  const npm = version("tech", "Use npm.\n");
  expect(
    await guidelines.approve(
      "web-shop",
      { ...pnpm, approval: "owner_push" },
      at(1),
    ),
  ).toBe(true);
  // Approved once: a later approval of the same version changes nothing.
  expect(
    await guidelines.approve(
      "web-shop",
      { ...pnpm, approval: "owner_admin" },
      at(2),
    ),
  ).toBe(false);
  expect(
    await guidelines.approve(
      "web-shop",
      {
        ...version("migrations", "One per change.\n"),
        approval: "owner_merge",
      },
      at(3),
    ),
  ).toBe(true);
  expect(await guidelines.approvals("web-shop")).toEqual([
    {
      name: "tech",
      contentHash: pnpm.contentHash,
      approval: "owner_push",
      approvedAt: at(1),
    },
    {
      name: "migrations",
      contentHash: version("migrations", "One per change.\n").contentHash,
      approval: "owner_merge",
      approvedAt: at(3),
    },
  ]);
  expect(await guidelines.approvals("blog")).toEqual([]);
  expect(
    await guidelines.approvedContent("web-shop", "tech", pnpm.contentHash),
  ).toBe("Use pnpm.\n");
  expect(
    await guidelines.approvedContent("web-shop", "tech", npm.contentHash),
  ).toBeUndefined();

  const sha = "a".repeat(40);
  expect(
    await guidelines.recordChange(
      "web-shop",
      { ...npm, commitSha: sha },
      at(4),
    ),
  ).toBe(true);
  // Seen again, by a later commit: only its commit changes.
  expect(
    await guidelines.recordChange(
      "web-shop",
      { ...npm, commitSha: "b".repeat(40) },
      at(5),
    ),
  ).toBe(false);
  expect(await guidelines.changes("web-shop")).toEqual([
    {
      name: "tech",
      contentHash: npm.contentHash,
      commitSha: "b".repeat(40),
      status: "awaiting",
      seenAt: at(4),
      dismissedAt: null,
    },
  ]);
  expect(
    await guidelines.changeContent("web-shop", "tech", npm.contentHash),
  ).toBe("Use npm.\n");

  expect(
    await guidelines.dismiss("web-shop", "tech", npm.contentHash, at(6)),
  ).toBe(true);
  expect(
    await guidelines.dismiss("web-shop", "tech", npm.contentHash, at(7)),
  ).toBe(false);
  expect(
    await guidelines.dismiss("web-shop", "tech", pnpm.contentHash, at(7)),
  ).toBe(false);
  await guidelines.recordChange("web-shop", { ...npm, commitSha: null }, at(8));
  expect(await guidelines.changes("web-shop")).toEqual([
    expect.objectContaining({
      status: "dismissed",
      commitSha: null,
      dismissedAt: at(6),
    }),
  ]);
  expect(await guidelines.changes("blog")).toEqual([]);

  // `/guidelines` is suggested to each Floor once, ever (FR-109).
  expect(await guidelines.suggest("web-shop", at(9))).toBe(true);
  expect(await guidelines.suggest("web-shop", at(10))).toBe(false);
  expect(await guidelines.suggest("blog", at(10))).toBe(true);
}

describe("the Guideline store", () => {
  it("in memory keeps approved versions once, and versions awaiting approval until dismissed", async () => {
    await run(memoryStores());
  });

  postgresTest(
    "in Postgres 18 keeps approved versions once, and versions awaiting approval until dismissed",
    async ({ database }) => {
      await run(databaseStores(database.db));
    },
  );
});
