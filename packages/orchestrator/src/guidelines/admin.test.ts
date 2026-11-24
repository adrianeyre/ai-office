import { createEventBus, memoryEventStore } from "@ai-office/events";
import { GitHubError, GitHubNotConfiguredError } from "@ai-office/github";
import { createFakeGitHub } from "@ai-office/github/testing";
import { floorErrorCodes } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { FloorError } from "../floors/errors.ts";
import { createFloors } from "../floors/floors.ts";
import { memoryFloorStore } from "../floors/store.ts";
import { createNotices } from "../notices/notices.ts";
import { memoryNoticeStore } from "../notices/store.ts";
import { createGuidelinesAdmin } from "./admin.ts";
import {
  createGuidelineApprovals,
  guidelineContentHash,
  GuidelineVersionError,
} from "./approval.ts";
import { memoryGuidelineStore } from "./store.ts";

// The Floor admin's Guidelines card (FR-103, FR-111): one row per
// Guideline, with the version Agents get, any awaiting approval in full
// beside it, and why a file reaches no Agent, never what a line holds.

const repository = "adrianeyre/web-shop";
const owner = "adrianeyre";
const folder = ".agents/guidelines";

const migrationsV1 =
  '---\ninclusion: fileMatch\nfileMatchPattern: "packages/db/**"\ndescription: How migrations are written\n---\n\nOne migration per change.\n';
const migrationsV2 =
  '---\ninclusion: fileMatch\nfileMatchPattern: ["packages/db/**", "migrations/**"]\ndescription: How migrations are written\n---\n\nOne migration per change, never edited once merged.\n';
const copy = "---\ninclusion: manual\n---\n\nBritish English.\n";
const secret = "Deploy with ghp_0123456789abcdefghijABCDEFGHIJ012345.\n";

async function setUp() {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const events = createEventBus({ store: memoryEventStore() });
  const floors = memoryFloorStore();
  const floor = await createFloors({ store: floors, github, events }).add(
    repository,
  );
  const store = memoryGuidelineStore();
  const approvals = createGuidelineApprovals({
    github,
    store,
    floors,
    notices: createNotices({ store: memoryNoticeStore(), events }),
    events,
    ownerLogin: () => Promise.resolve(owner),
  });
  const admin = createGuidelinesAdmin({ floors, approvals, store });
  return { github, floor, admin };
}

describe("the Floor admin's Guidelines", () => {
  it("lists none for a Floor without Guidelines", async () => {
    const { floor, admin } = await setUp();
    expect(await admin.list(floor.id)).toEqual({
      guidelines: [],
      awaitingCount: 0,
    });
  });

  it("lists each Guideline with its inclusion, patterns, approved and awaiting versions, and errors", async () => {
    const { github, floor, admin } = await setUp();
    github.pushCommit(repository, "main", {
      files: {
        [`${folder}/migrations.md`]: migrationsV1,
        [`${folder}/tech.md`]: "Use pnpm.\n",
      },
      pusher: owner,
    });
    await admin.list(floor.id);
    // Someone else changes one, adds one, and breaks another.
    const changed = github.pushCommit(repository, "main", {
      files: {
        [`${folder}/migrations.md`]: migrationsV2,
        [`${folder}/copy.md`]: copy,
        [`${folder}/tech.md`]: `Use pnpm.\n${secret}`,
      },
      pusher: "mallory",
    });

    const list = await admin.list(floor.id);
    expect(list.awaitingCount).toBe(2);
    expect(list.guidelines.map(({ name }) => name)).toEqual([
      "copy",
      "migrations",
      "tech",
    ]);
    const [newOne, migrations, tech] = list.guidelines;
    // New: nothing approved, described as the version awaiting says.
    expect(newOne).toEqual({
      name: "copy",
      path: `${folder}/copy.md`,
      inclusion: "manual",
      fileMatchPatterns: [],
      description: null,
      approved: null,
      awaiting: {
        contentHash: guidelineContentHash(copy),
        status: "awaiting",
        content: copy,
        commitSha: changed,
      },
      error: null,
    });
    // Changed: as Agents get it, with the version awaiting beside it.
    expect(migrations).toEqual({
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
    });
    // Broken: the line named, never what it holds; Agents keep the last.
    expect(tech).toMatchObject({
      name: "tech",
      inclusion: "always",
      approved: { content: "Use pnpm.\n", current: false },
      awaiting: null,
      error: { refusal: "holds_secret", secretLines: [2] },
    });
    expect(JSON.stringify(list)).not.toContain("ghp_");
  });

  it("approves and dismisses the version seen, and refuses one that changed meanwhile", async () => {
    const { github, floor, admin } = await setUp();
    github.pushCommit(repository, "main", {
      files: {
        [`${folder}/migrations.md`]: migrationsV1,
        [`${folder}/copy.md`]: copy,
      },
      pusher: "mallory",
    });
    const seen = await admin.list(floor.id);
    expect(seen.awaitingCount).toBe(2);

    const approved = await admin.approve(
      floor.id,
      "migrations",
      guidelineContentHash(migrationsV1),
    );
    expect(approved.awaitingCount).toBe(1);
    expect(
      approved.guidelines.find(({ name }) => name === "migrations"),
    ).toMatchObject({
      approved: { approval: "owner_admin", current: true },
      awaiting: null,
    });

    const dismissed = await admin.dismiss(
      floor.id,
      "copy",
      guidelineContentHash(copy),
    );
    expect(dismissed.awaitingCount).toBe(0);
    expect(
      dismissed.guidelines.find(({ name }) => name === "copy"),
    ).toMatchObject({ approved: null, awaiting: { status: "dismissed" } });

    // Changed on the default branch after the Owner looked.
    github.pushCommit(repository, "main", {
      files: { [`${folder}/migrations.md`]: migrationsV2 },
      pusher: "mallory",
    });
    await expect(
      admin.approve(floor.id, "migrations", guidelineContentHash(migrationsV1)),
    ).rejects.toMatchObject({ code: "changed" });
    await expect(
      admin.approve(floor.id, "nowhere", guidelineContentHash(copy)),
    ).rejects.toBeInstanceOf(GuidelineVersionError);
  });

  it("says when there is no such Floor, or GitHub cannot be asked", async () => {
    const { floor, admin } = await setUp();
    await expect(admin.list("nowhere")).rejects.toMatchObject({
      code: floorErrorCodes.floorNotFound,
    });

    const failing = (error: Error) =>
      createGuidelinesAdmin({
        floors: { get: () => Promise.resolve(floor) },
        approvals: {
          sync: () => Promise.reject(error),
          approve: () => Promise.reject(error),
          dismiss: () => Promise.reject(error),
        },
        store: { changeContent: () => Promise.resolve(undefined) },
      });
    const down = failing(new GitHubError(0, "GitHub could not be reached."));
    await expect(down.list(floor.id)).rejects.toBeInstanceOf(FloorError);
    await expect(down.list(floor.id)).rejects.toMatchObject({
      code: floorErrorCodes.githubUnavailable,
    });
    await expect(
      failing(new GitHubNotConfiguredError()).approve(floor.id, "tech", "0"),
    ).rejects.toMatchObject({ code: floorErrorCodes.githubNotConfigured });
  });
});
