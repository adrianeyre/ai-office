import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createRedactor,
  noticeErrorCodes,
  type NewNotice,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createNotices,
  NoticeError,
  NoticeOutdatedError,
  type Notices,
} from "./notices.ts";
import {
  databaseNoticeStore,
  memoryNoticeStore,
  type NoticeRecord,
  type NoticeStore,
} from "./store.ts";

// Notices (PRD FR-48): raise, list, dismiss and act, each an event. Every
// case runs twice: with the Notices in memory, and in Postgres 18.

interface Setup {
  readonly notices: Notices;
  /** Actions taken by the test's `approve_and_merge` handler. */
  readonly merged: string[];
  /** Every event published so far. */
  readonly events: () => Promise<OfficeEvent[]>;
}

const start = new Date("2026-10-08T12:00:00.000Z");

const prAwaiting = {
  kind: "action",
  title: "PR #14 awaiting your approval",
  floorId: "web-shop",
  agentId: "ada",
  issue: { number: 4, url: "https://github.com/adrianeyre/web-shop/issues/4" },
  pullRequest: {
    number: 14,
    url: "https://github.com/adrianeyre/web-shop/pull/14",
  },
  ciRunUrl: "https://github.com/adrianeyre/web-shop/actions/runs/99",
  links: [
    {
      label: "Round 1",
      url: "https://github.com/adrianeyre/web-shop/pull/14#pullrequestreview-7",
    },
  ],
  actions: [{ id: "approve_and_merge", label: "Approve and merge" }],
} satisfies NewNotice;

const prMerged = {
  kind: "info",
  title: "PR #12 merged by the App",
  floorId: "web-shop",
  pullRequest: {
    number: 12,
    url: "https://github.com/adrianeyre/web-shop/pull/12",
  },
} satisfies NewNotice;

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  // Notices belong to a Floor that exists.
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const floors = createFloors({ store: stores.floors, github, events: bus });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");
  const seen = (await bus.eventsAfter(0)).length;

  let tick = 0;
  let id = 0;
  const notices = createNotices({
    store: stores.notices,
    events: bus,
    redactor: createRedactor({ secrets: ["hunter2-secret"] }),
    // Each a second after the one before.
    now: () => new Date(start.getTime() + 1000 * tick++),
    newId: () => `notice-${String(++id)}`,
  });
  const merged: string[] = [];
  notices.registerAction("approve_and_merge", (notice) => {
    if (notice.pullRequest?.number === 13) {
      return Promise.reject(new Error("GitHub refused: CI is red."));
    }
    merged.push(notice.id);
    return Promise.resolve();
  });
  return {
    notices,
    merged,
    events: async () =>
      (await bus.eventsAfter(0)).slice(seen).map(({ event }) => event),
  };
}

const refusal = async (promise: Promise<unknown>): Promise<NoticeError> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(NoticeError);
  return error as NoticeError;
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "raises an action Notice with its links and actions, as an event",
    async ({ notices, events }) => {
      const notice = await notices.raise(prAwaiting);
      expect(notice).toEqual({
        id: "notice-1",
        kind: "action",
        title: "PR #14 awaiting your approval",
        floorId: "web-shop",
        agentId: "ada",
        issue: prAwaiting.issue,
        pullRequest: prAwaiting.pullRequest,
        ciRunUrl: prAwaiting.ciRunUrl,
        links: prAwaiting.links,
        positions: [],
        actions: [{ id: "approve_and_merge", label: "Approve and merge" }],
        createdAt: start,
        dismissedAt: null,
        actedAt: null,
        actedOn: null,
      });
      expect(await notices.get("notice-1")).toEqual(notice);
      expect(await events()).toEqual([
        {
          type: "notice.raised",
          version: 1,
          noticeId: "notice-1",
          kind: "action",
          title: "PR #14 awaiting your approval",
          floorId: "web-shop",
          agentId: "ada",
          issue: 4,
        },
      ]);
    },
  ],
  [
    "lists the open Notices newest first, every Floor's or one Floor's",
    async ({ notices }) => {
      await notices.raise(prAwaiting);
      await notices.raise(prMerged);
      await notices.raise({
        kind: "action",
        title: "An AI Account needs signing in again",
      });
      await notices.raise({
        kind: "info",
        title: "Batch finished",
        floorId: "blog",
      });
      expect((await notices.open()).map(({ id }) => id)).toEqual([
        "notice-4",
        "notice-3",
        "notice-2",
        "notice-1",
      ]);
      expect(
        (await notices.open({ floorId: "web-shop" })).map(({ id }) => id),
      ).toEqual(["notice-2", "notice-1"]);
      expect(await notices.open({ floorId: "nowhere" })).toEqual([]);
    },
  ],
  [
    "keeps a conflict's two positions, in order",
    async ({ notices }) => {
      const positions = [
        {
          label: "Reviewers: approved in rounds 1 and 2",
          text: "Grace: It does what the issue asks.",
          url: "https://github.com/adrianeyre/web-shop/pull/14#pullrequestreview-2",
        },
        {
          label: "QA: failed in QA rounds 1 and 2",
          text: "Adding the same sku twice fails.\n\nSteps to reproduce:\n1. add('a')",
        },
      ];
      const notice = await notices.raise({
        kind: "action",
        title: "Review Loop conflict between Roles",
        floorId: "web-shop",
        positions,
      });
      expect(notice.positions).toEqual(positions);
      expect((await notices.get(notice.id)).positions).toEqual(positions);
    },
  ],
  [
    "dismisses a Notice: it leaves the board, is kept, and cannot be acted on",
    async ({ notices, events, merged }) => {
      await notices.raise(prAwaiting);
      const dismissed = await notices.dismiss("notice-1");
      expect(dismissed.dismissedAt).toEqual(new Date(start.getTime() + 1000));
      expect(dismissed.actedAt).toBeNull();
      expect(await notices.open()).toEqual([]);
      expect(await notices.get("notice-1")).toEqual(dismissed);
      expect((await events()).at(-1)).toEqual({
        type: "notice.dismissed",
        version: 1,
        noticeId: "notice-1",
        floorId: "web-shop",
      });

      for (const attempt of [
        () => notices.dismiss("notice-1"),
        () => notices.act("notice-1", "approve_and_merge"),
      ]) {
        const error = await refusal(attempt());
        expect(error.code).toBe(noticeErrorCodes.noticeClosed);
        expect(error.message).toBe("That Notice was already dismissed.");
      }
      expect(merged).toEqual([]);
    },
  ],
  [
    "acts on a Notice through its registered handler, which closes it",
    async ({ notices, events, merged }) => {
      await notices.raise(prAwaiting);
      const acted = await notices.act("notice-1", "approve_and_merge");
      expect(merged).toEqual(["notice-1"]);
      expect(acted.actedAt).toEqual(new Date(start.getTime() + 1000));
      expect(acted.actedOn).toBe("approve_and_merge");
      expect(acted.dismissedAt).toBeNull();
      expect(await notices.open()).toEqual([]);
      expect((await events()).at(-1)).toEqual({
        type: "notice.acted_on",
        version: 1,
        noticeId: "notice-1",
        floorId: "web-shop",
        action: "approve_and_merge",
      });

      const again = await refusal(notices.act("notice-1", "approve_and_merge"));
      expect(again.code).toBe(noticeErrorCodes.noticeClosed);
      expect(again.message).toBe("That Notice was already acted on.");
      expect(merged).toEqual(["notice-1"]);
    },
  ],
  [
    "keeps an action Notice on the board when its action fails",
    async ({ notices, events }) => {
      await notices.raise({
        ...prAwaiting,
        title: "PR #13 awaiting your approval",
        pullRequest: {
          number: 13,
          url: "https://github.com/adrianeyre/web-shop/pull/13",
        },
      });
      const error = await refusal(notices.act("notice-1", "approve_and_merge"));
      expect(error.code).toBe(noticeErrorCodes.actionFailed);
      expect(error.message).toBe(
        "The action failed, so the Notice stays: GitHub refused: CI is red.",
      );
      expect((await notices.open()).map(({ id }) => id)).toEqual(["notice-1"]);
      expect((await events()).map(({ type }) => type)).toEqual([
        "notice.raised",
      ]);
    },
  ],
  [
    "refuses an action the Notice does not offer, or a Notice that is not there",
    async ({ notices }) => {
      await notices.raise(prMerged);
      const notOffered = await refusal(
        notices.act("notice-1", "approve_and_merge"),
      );
      expect(notOffered.code).toBe(noticeErrorCodes.actionNotOffered);
      for (const attempt of [
        () => notices.get("notice-9"),
        () => notices.dismiss("notice-9"),
        () => notices.act("notice-9", "approve_and_merge"),
      ]) {
        expect((await refusal(attempt())).code).toBe(
          noticeErrorCodes.noticeNotFound,
        );
      }
    },
  ],
  [
    "refuses to raise a Notice offering an action with no handler",
    async ({ notices, events }) => {
      const error = await refusal(
        notices.raise({
          kind: "action",
          title: "Token Cap reached",
          actions: [{ id: "raise_cap", label: "Raise cap" }],
        }),
      );
      expect(error.code).toBe(noticeErrorCodes.actionNotRegistered);
      expect(await notices.open()).toEqual([]);
      expect(await events()).toEqual([]);
    },
  ],
  [
    "never stores or publishes a credential in a title, link or position",
    async ({ notices, events }) => {
      const notice = await notices.raise({
        kind: "info",
        title: "Deploy key hunter2-secret was rotated",
        floorId: "web-shop",
        issue: {
          number: 4,
          url: "https://github.com/adrianeyre/web-shop/issues/4?token=hunter2-secret",
        },
        links: [
          {
            label: "Round hunter2-secret",
            url: "https://github.com/adrianeyre/web-shop/pull/5?token=hunter2-secret",
          },
        ],
        positions: [
          {
            label: "QA: failed hunter2-secret",
            text: "It printed hunter2-secret.",
            url: "https://github.com/adrianeyre/web-shop/pull/5?token=hunter2-secret",
          },
        ],
      });
      expect(notice.title).toBe("Deploy key [REDACTED] was rotated");
      expect(notice.issue?.url).not.toContain("hunter2-secret");
      expect(JSON.stringify(notice.links)).not.toContain("hunter2-secret");
      expect(notice.positions[0]?.text).toBe("It printed [REDACTED].");
      expect(JSON.stringify(notice.positions)).not.toContain("hunter2-secret");
      expect(JSON.stringify(await notices.get(notice.id))).not.toContain(
        "hunter2-secret",
      );
      expect(JSON.stringify(await events())).not.toContain("hunter2-secret");
    },
  ],
];

describe("Notices, kept in memory", () => {
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

describe("Notices, kept in Postgres 18", () => {
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

describe("raising a Notice", () => {
  const notices = () =>
    createNotices({
      store: memoryStores().notices,
      events: createEventBus({ store: memoryEventStore() }),
    });

  it("refuses an info Notice that offers actions", async () => {
    const office = notices();
    office.registerAction("resume", () => Promise.resolve());
    await expect(
      office.raise({
        kind: "info",
        title: "Agent recovered",
        actions: [{ id: "resume", label: "Resume" }],
      }),
    ).rejects.toThrow("An info Notice offers no actions.");
  });

  it("refuses links that are not web addresses", async () => {
    await expect(
      notices().raise({
        kind: "info",
        title: "PR opened",
        pullRequest: { number: 1, url: "javascript:alert(1)" },
      }),
    ).rejects.toThrow("A link is an http or https address.");
    await expect(
      notices().raise({
        kind: "action",
        title: "Round Cap reached",
        links: [{ label: "Round 1", url: "javascript:alert(1)" }],
      }),
    ).rejects.toThrow("A link is an http or https address.");
    await expect(
      notices().raise({
        kind: "action",
        title: "Review Loop conflict between Roles",
        positions: [
          { label: "QA: failed", text: "It fails.", url: "file:///etc" },
        ],
      }),
    ).rejects.toThrow("A link is an http or https address.");
  });

  it("shows at most two positions, the two sides of a conflict", async () => {
    const side = { label: "QA: failed", text: "It fails." };
    await expect(
      notices().raise({
        kind: "action",
        title: "Review Loop conflict between Roles",
        positions: [side, side, side],
      }),
    ).rejects.toThrow();
  });

  it("refuses a second handler for the same action", () => {
    const office = notices();
    const remove = office.registerAction("resume", () => Promise.resolve());
    expect(() =>
      office.registerAction("resume", () => Promise.resolve()),
    ).toThrow("A handler for resume is already registered.");
    remove();
    office.registerAction("resume", () => Promise.resolve());
  });

  it("refuses to act while the same Notice's action is being taken", async () => {
    const office = notices();
    let started: () => void = () => undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: () => void = () => undefined;
    office.registerAction(
      "resume",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const notice = await office.raise({
      kind: "action",
      title: "Ada paused at the Token Cap",
      actions: [{ id: "resume", label: "Resume" }],
    });
    const first = office.act(notice.id, "resume");
    await handlerStarted;
    for (const attempt of [
      () => office.act(notice.id, "resume"),
      () => office.dismiss(notice.id),
    ]) {
      expect((await refusal(attempt())).code).toBe(
        noticeErrorCodes.actionInProgress,
      );
    }
    finish();
    expect((await first).actedOn).toBe("resume");
  });

  it("closes a Notice whose handler finds it out of date, as dismissed and not acted on, saying why (W1-6)", async () => {
    const bus = createEventBus({ store: memoryEventStore() });
    const office = createNotices({ store: memoryNoticeStore(), events: bus });
    office.registerAction("approve_and_merge", () =>
      Promise.reject(
        new NoticeOutdatedError("Nothing was merged: its branch moved on."),
      ),
    );
    const notice = await office.raise({
      ...prAwaiting,
      actions: [
        {
          id: "approve_and_merge",
          label: "Approve and merge",
          sha: "1bcfb3912bcbf0a0e0c2a8cfc5f0f6b5d2b2e9a1",
        },
      ],
    });
    expect(notice.actions[0]?.sha).toBe(
      "1bcfb3912bcbf0a0e0c2a8cfc5f0f6b5d2b2e9a1",
    );
    const error = await refusal(office.act(notice.id, "approve_and_merge"));
    expect(error.code).toBe(noticeErrorCodes.actionFailed);
    expect(error.message).toBe(
      "The action was not taken, and the Notice is closed: Nothing was merged: its branch moved on.",
    );
    expect(await office.get(notice.id)).toMatchObject({
      actedAt: null,
      actedOn: null,
      dismissedAt: expect.any(Date) as Date,
    });
    expect((await bus.eventsAfter(0)).map(({ event }) => event.type)).toEqual([
      "notice.raised",
      "notice.dismissed",
    ]);
  });
});

// Retention (PRD §7): Notices closed before a cutoff are deleted; open
// ones stay, however old, until the Owner closes them (FR-48).
async function checkRetention(store: NoticeStore): Promise<void> {
  const notice = (id: string, closing: Partial<NoticeRecord> = {}) => ({
    id,
    kind: "info" as const,
    title: `Notice ${id}`,
    floorId: null,
    agentId: null,
    issue: null,
    pullRequest: null,
    ciRunUrl: null,
    links: [],
    positions: [],
    actions: [],
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    dismissedAt: null,
    actedAt: null,
    actedOn: null,
    ...closing,
  });
  const cutoff = new Date("2025-10-10T00:00:00.000Z");
  await store.add(notice("open"));
  await store.add(
    notice("dismissed-long-ago", {
      dismissedAt: new Date("2025-02-01T00:00:00.000Z"),
    }),
  );
  await store.add(
    notice("acted-long-ago", {
      actedAt: new Date("2025-10-09T23:59:59.999Z"),
      actedOn: "resume",
    }),
  );
  await store.add(notice("dismissed-lately", { dismissedAt: cutoff }));

  expect(await store.deleteClosedBefore(cutoff)).toBe(2);
  expect(await store.get("dismissed-long-ago")).toBeUndefined();
  expect(await store.get("acted-long-ago")).toBeUndefined();
  expect((await store.get("dismissed-lately"))?.dismissedAt).toEqual(cutoff);
  expect((await store.open()).map(({ id }) => id)).toEqual(["open"]);
  expect(await store.deleteClosedBefore(cutoff)).toBe(0);
}

describe("retention of Notices", () => {
  it("deletes those closed before a cutoff, in memory", () =>
    checkRetention(memoryNoticeStore()));

  postgresTest(
    "deletes those closed before a cutoff, in Postgres 18",
    async ({ database }) => {
      await checkRetention(databaseNoticeStore(database.db));
    },
  );
});
