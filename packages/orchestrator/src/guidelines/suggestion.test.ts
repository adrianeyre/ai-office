import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createNotices } from "../notices/notices.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createGuidelineApprovals,
  guidelinesSuggestionTitle,
} from "./approval.ts";

// A Floor that has never had Guidelines gets one info Notice suggesting
// `/guidelines` (Guidelines, Specs and Hooks PRD, FR-109), at most once
// per Floor: however often its Guidelines are read (at intake and before
// each task), after a restart, two reads at once, and once the Owner has
// dismissed it. A Floor with Guidelines, or one that had them, is not
// told to draft its first. Each case runs in memory and in Postgres 18.

const owner = "adrianeyre";
const tech = ".agents/guidelines/tech.md";

function setUp(stores: OfficeStores) {
  const github = createFakeGitHub();
  for (const name of ["web-shop", "blog"]) {
    github.installRepository(`${owner}/${name}`);
  }
  const events = createEventBus({ store: memoryEventStore() });
  const floors = createFloors({ store: stores.floors, github, events });
  const notices = createNotices({ store: stores.notices, events });
  /** AI Office's Guideline approvals, as one start of AI Office makes them. */
  const start = () =>
    createGuidelineApprovals({
      github,
      store: stores.guidelines,
      floors: stores.floors,
      notices,
      events,
      ownerLogin: () => Promise.resolve(owner),
    });
  /** Every suggestion raised on a Floor, open or not. */
  const suggestions = async (floorId: string) =>
    (
      await events.history({ filter: { floorId, types: ["notice.raised"] } })
    ).flatMap(({ event }) =>
      event.type === "notice.raised" && event.title.includes("/guidelines")
        ? [event]
        : [],
    );
  return { github, floors, notices, start, suggestions };
}

type Case = readonly [string, (stores: OfficeStores) => Promise<void>];

const cases: Case[] = [
  [
    "suggests /guidelines once to a Floor with none, however often they are read, after a restart and once dismissed",
    async (stores) => {
      const s = setUp(stores);
      const floor = await s.floors.add(`${owner}/web-shop`);
      const guidelines = s.start();

      await guidelines.sync(floor);
      const [notice, ...others] = await s.notices.open({ floorId: floor.id });
      expect(others).toEqual([]);
      expect(notice).toMatchObject({
        kind: "info",
        title: guidelinesSuggestionTitle("web-shop"),
        floorId: "web-shop",
        actions: [],
      });
      expect(notice?.title).toBe(
        "No Guidelines on web-shop yet: run /guidelines in the Manager chat to draft them from the repository",
      );

      // Read again at intake and before each task: no second one.
      await guidelines.sync(floor);
      await guidelines.sync(floor);
      expect(await s.suggestions(floor.id)).toHaveLength(1);

      // The Owner dismisses it; AI Office restarts and reads again, twice
      // at once.
      await s.notices.dismiss(notice?.id ?? "");
      guidelines.stop();
      const restarted = s.start();
      await Promise.all([restarted.sync(floor), restarted.sync(floor)]);
      expect(await s.notices.open({ floorId: floor.id })).toEqual([]);
      expect(await s.suggestions(floor.id)).toHaveLength(1);

      // Another Floor gets its own, once.
      const blog = await s.floors.add(`${owner}/blog`);
      await Promise.all([restarted.sync(blog), restarted.sync(blog)]);
      expect(await s.suggestions(blog.id)).toHaveLength(1);
      expect(await s.suggestions(floor.id)).toHaveLength(1);
    },
  ],
  [
    "never suggests /guidelines to a Floor with Guidelines, nor to one whose Guidelines were deleted",
    async (stores) => {
      const s = setUp(stores);
      const floor = await s.floors.add(`${owner}/web-shop`);
      const guidelines = s.start();
      s.github.pushCommit(`${owner}/web-shop`, "main", {
        files: { [tech]: "Use pnpm.\n" },
        pusher: owner,
      });
      await guidelines.sync(floor);
      expect(await s.suggestions(floor.id)).toEqual([]);

      // Deleted on the default branch: it had them, so it knows of them.
      s.github.pushCommit(`${owner}/web-shop`, "main", {
        files: { [tech]: null },
        pusher: owner,
      });
      expect((await guidelines.sync(floor)).approved).toEqual([]);
      guidelines.stop();
      const restarted = s.start();
      await restarted.sync(floor);
      expect(await s.suggestions(floor.id)).toEqual([]);

      // Nor to one whose only Guideline waits for the Owner.
      const blog = await s.floors.add(`${owner}/blog`);
      s.github.pushCommit(`${owner}/blog`, "main", {
        files: { [tech]: "Use npm.\n" },
        pusher: "mallory",
      });
      await restarted.sync(blog);
      expect(await s.suggestions(blog.id)).toEqual([]);
      expect(
        (await s.notices.open({ floorId: blog.id })).map(({ title }) => title),
      ).toEqual(["Guidelines changed on blog: 1 awaiting approval"]);
    },
  ],
];

describe("suggesting /guidelines, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(memoryStores());
    });
  }
});

describe("suggesting /guidelines, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(databaseStores(database.db));
    });
  }
});
