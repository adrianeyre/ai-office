import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventStore,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import type { ModelClient } from "../models/client.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { createManagerChat } from "./chat.ts";
import { createStatusUpdates } from "./status-update.ts";

// A Floor's Status update (PRD FR-23a), in plain code from the event log
// and the work queue: what each Agent did on the last working day, and
// what it plans today, kept in the Manager chat, told to the Office, and
// given by itself once a day; and, hourly, what each did in the last hour.
// The Owner is in London; Monday 12 October 2026 follows a weekend with no
// work. Each case runs in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const friday = new Date("2026-10-09T14:00:00Z");
const monday = new Date("2026-10-12T08:30:00Z");

const noModels: ModelClient = {
  complete: () => Promise.reject(new Error("No model is asked.")),
  stream: () => Promise.reject(new Error("No model is asked.")),
};

async function setUp(
  stores: OfficeStores,
  work: WorkQueueStore,
  eventStore: EventStore,
) {
  let clock = friday;
  const now = () => clock;
  const events = createEventBus({ store: eventStore, now });
  const github = createFakeGitHub();
  github.installRepository(repository);
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const team = await stores.agents.list("web-shop");
  const byRole = (role: string) => {
    const agent = team.find((each) => each.role === role);
    if (agent === undefined) {
      throw new Error(`A new Floor has a ${role}.`);
    }
    return agent;
  };
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: noModels,
    now,
  });
  const updates = createStatusUpdates({
    floors: stores.floors,
    agents: stores.agents,
    work,
    batches: stores.batches,
    events,
    store: stores.statusUpdates,
    chat,
    timeZone: () => Promise.resolve("Europe/London"),
    now,
  });
  const publish = (event: OfficeEvent) => events.publish(event);
  return {
    stores,
    work,
    events,
    updates,
    manager: byRole("manager"),
    coder: byRole("coder"),
    reviewer: byRole("reviewer"),
    publish,
    at(at: Date) {
      clock = at;
    },
  };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** Friday's work: the coder opens a pull request, the reviewer approves it. */
async function fridaysWork(s: Setup): Promise<void> {
  const subject = { version: 1, floorId: "web-shop", issue: 12 } as const;
  await s.publish({
    ...subject,
    type: "issue.triaged",
    agentId: s.manager.id,
    outcome: "clear",
    priority: "normal",
    judgedBy: "rules",
  });
  await s.publish({
    ...subject,
    type: "sandbox.started",
    agentId: s.coder.id,
    sandboxId: "sandbox-1",
    branch: "ai-office/12",
  });
  await s.publish({
    ...subject,
    type: "branch.pushed",
    agentId: s.coder.id,
    branch: "ai-office/12",
    sha: "a".repeat(40),
    commits: 3,
  });
  await s.publish({
    ...subject,
    type: "pull_request.opened",
    agentId: s.coder.id,
    pullRequest: 14,
    url: "https://github.com/adrianeyre/web-shop/pull/14",
    branch: "ai-office/12",
  });
  await s.publish({
    ...subject,
    type: "review.posted",
    agentId: s.reviewer.id,
    pullRequest: 14,
    round: 1,
    verdict: "approve",
    blocking: 0,
    nits: 1,
    url: "https://github.com/adrianeyre/web-shop/pull/14#review",
  });
  // A sandbox's chatter is no work on its own.
  await s.publish({
    ...subject,
    type: "sandbox.text",
    agentId: s.coder.id,
    sandboxId: "sandbox-1",
    text: "Reading the basket.",
  });
}

type Case = [name: string, run: (s: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "on a Monday after a quiet weekend, each Agent tells Friday's work and today's plan, in the chat and to the Office",
    async (s) => {
      await fridaysWork(s);
      s.at(monday);
      // Today's work: the coder carries on with #13, then #15.
      await s.work.add(
        {
          floorId: "web-shop",
          issue: 13,
          stage: "needs-work",
          agentId: s.coder.id,
          priority: "normal",
        },
        monday,
      );
      await s.work.claimNext(5, monday);
      await s.work.add(
        {
          floorId: "web-shop",
          issue: 15,
          stage: "needs-work",
          agentId: s.coder.id,
          priority: "normal",
        },
        monday,
      );

      const given = await s.updates.give("web-shop", "owner");
      expect(given).toMatchObject({
        floorId: "web-shop",
        trigger: "owner",
        day: "2026-10-12",
        reportedDay: "2026-10-09",
        givenAt: monday.toISOString(),
      });
      const entry = (agentId: string) =>
        given?.entries.find((each) => each.agentId === agentId);
      expect(given?.entries[0]?.agentId).toBe(s.manager.id);
      expect(entry(s.manager.id)).toMatchObject({
        role: "manager",
        did: ["Triaged 1 issue."],
        today: ["Triage whatever comes in, and tell you what needs you."],
      });
      expect(entry(s.coder.id)).toMatchObject({
        did: ["Opened pull request #14 for #12.", "Pushed 3 commits to #12."],
        today: [
          "Carry on with #13, at needs-work.",
          "Then #15, at needs-work.",
        ],
      });
      expect(entry(s.reviewer.id)?.did).toEqual([
        "Reviewed pull request #14 for #12: approved it.",
      ]);

      // Kept in the Manager chat, as a report of the Manager's own…
      const [message] = await s.stores.managerChat.latest("web-shop", 1);
      expect(message).toMatchObject({
        kind: "report",
        replyTo: null,
        agentId: s.manager.id,
      });
      expect(message?.text).toMatch(
        /^Status update on web-shop, Monday 12 October: what each of us did on Friday 9 October, and what we plan today\.\n/,
      );
      expect(message?.text).toContain(
        "On Friday 9 October:\n- Opened pull request #14 for #12.\n- Pushed 3 commits to #12.\nToday:\n- Carry on with #13, at needs-work.",
      );
      // …which is not the daily status report.
      expect(
        await s.stores.managerChat.latestDailyReport("web-shop"),
      ).toBeUndefined();

      // Told to the Office, which walks everyone to the meeting room.
      const [told] = await s.events.history({
        filter: { floorId: "web-shop", types: ["status_update.given"] },
      });
      expect(told?.id).toBe(given?.eventId);
      expect(told?.event).toEqual({
        type: "status_update.given",
        version: 1,
        floorId: "web-shop",
        agentId: s.manager.id,
        agentIds: given?.entries.slice(1).map(({ agentId }) => agentId),
        day: "2026-10-12",
        reportedDay: "2026-10-09",
        trigger: "owner",
        messageId: message?.id,
      });
    },
  ],
  [
    "the day's own is given once a day, however often the Floor is opened; the Owner's whenever they ask",
    async (s) => {
      await fridaysWork(s);
      s.at(monday);
      // Opened twice at once, as from two browsers: one Status update.
      const [first, second] = await Promise.all([
        s.updates.give("web-shop", "daily"),
        s.updates.give("web-shop", "daily"),
      ]);
      expect(
        [first, second].filter((given) => given !== undefined),
      ).toHaveLength(1);
      expect(await s.updates.give("web-shop", "daily")).toBeUndefined();
      const kept = await s.stores.statusUpdates.get("web-shop", "2026-10-12");
      expect(kept).toMatchObject({ trigger: "daily", day: "2026-10-12" });
      expect(kept?.messageId).toEqual(expect.any(Number));

      // The Owner asks again: given, and the day's stays as it was.
      expect((await s.updates.give("web-shop", "owner"))?.trigger).toBe(
        "owner",
      );
      expect(
        (await s.stores.statusUpdates.get("web-shop", "2026-10-12"))?.trigger,
      ).toBe("daily");

      // The next day, opened in the Owner's morning (still Monday in UTC,
      // just after midnight in London), it is given again.
      s.at(new Date("2026-10-12T23:30:00Z"));
      expect((await s.updates.give("web-shop", "daily"))?.day).toBe(
        "2026-10-13",
      );
    },
  ],
  [
    "a day with no work reports on the last weekday, and an archived Floor gives none",
    async (s) => {
      s.at(monday);
      const given = await s.updates.give("web-shop", "daily");
      expect(given?.reportedDay).toBe("2026-10-09");
      expect(
        given?.entries.find(({ agentId }) => agentId === s.coder.id),
      ).toMatchObject({
        did: [],
        today: ["Nothing queued: ready for the next issue."],
      });
      const [message] = await s.stores.managerChat.latest("web-shop", 1);
      expect(message?.text).toContain(
        "On Friday 9 October:\n- Nothing to report.",
      );

      await s.stores.floors.archive("web-shop", monday);
      s.at(new Date("2026-10-13T08:00:00Z"));
      expect(await s.updates.give("web-shop", "daily")).toBeUndefined();
    },
  ],
  [
    "an hourly one tells the last hour's work, and is not the day's",
    async (s) => {
      const subject = { version: 1, floorId: "web-shop", issue: 13 } as const;
      // Pushed at 8:30, more than an hour before…
      s.at(monday);
      await s.publish({
        ...subject,
        type: "branch.pushed",
        agentId: s.coder.id,
        branch: "ai-office/13",
        sha: "a".repeat(40),
        commits: 2,
      });
      // …and at 9:10, within it.
      s.at(new Date("2026-10-12T09:10:00Z"));
      await s.publish({
        ...subject,
        type: "branch.pushed",
        agentId: s.coder.id,
        branch: "ai-office/13",
        sha: "b".repeat(40),
        commits: 1,
      });
      await s.work.add(
        {
          floorId: "web-shop",
          issue: 13,
          stage: "needs-work",
          agentId: s.coder.id,
          priority: "normal",
        },
        monday,
      );
      await s.work.claimNext(5, monday);

      const at = new Date("2026-10-12T09:45:00Z");
      s.at(at);
      const given = await s.updates.give("web-shop", "hourly");
      expect(given).toMatchObject({
        trigger: "hourly",
        day: "2026-10-12",
        reportedDay: "2026-10-12",
        givenAt: at.toISOString(),
      });
      expect(
        given?.entries.find(({ agentId }) => agentId === s.coder.id),
      ).toMatchObject({
        did: ["Pushed 1 commit to #13."],
        today: ["Carry on with #13, at needs-work."],
      });
      const [message] = await s.stores.managerChat.latest("web-shop", 1);
      expect(message?.text).toMatch(
        /^Status update on web-shop, Monday 12 October: what each of us did in the last hour, and what we plan today\.\n/,
      );
      expect(message?.text).toContain(
        "In the last hour:\n- Pushed 1 commit to #13.\nToday:",
      );
      const [told] = await s.events.history({
        filter: { floorId: "web-shop", types: ["status_update.given"] },
      });
      expect(told?.event).toMatchObject({
        type: "status_update.given",
        trigger: "hourly",
        reportedDay: "2026-10-12",
        messageId: message?.id,
      });
      expect(s.updates.latest("web-shop")).toEqual(given);

      // The day's own still comes, and is the latest then.
      expect(
        await s.stores.statusUpdates.get("web-shop", "2026-10-12"),
      ).toBeUndefined();
      const daily = await s.updates.give("web-shop", "daily");
      expect(daily?.trigger).toBe("daily");
      expect(s.updates.latest("web-shop")).toEqual(daily);
      expect(s.updates.latest("another-floor")).toBeUndefined();
    },
  ],
];

describe("Status updates, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      await run(
        await setUp(
          stores,
          memoryWorkQueueStore(stores.floors),
          memoryEventStore(),
        ),
      );
    });
  }
});

describe("Status updates, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          databaseWorkQueueStore(database.db),
          databaseEventStore(database.db),
        ),
      );
    });
  }
});
