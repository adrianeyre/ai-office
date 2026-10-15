import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createFloors,
  createNotices,
  databaseStores,
  memoryStores,
  type Notices,
  type OfficeStores,
} from "@ai-office/orchestrator";
import { noticeListSchema, noticeSchema } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Notice Board's API (PRD FR-48, FR-50): the open Notices, all Floors'
// or one Floor's, then dismissing one and acting on one. Each case runs in
// memory and in Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly notices: Notices;
  readonly bus: EventBus;
  /** Pull requests the `approve_and_merge` handler merged. */
  readonly merged: number[];
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const floors = createFloors({ store: stores.floors, github, events: bus });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");

  let tick = 0;
  const notices = createNotices({
    store: stores.notices,
    events: bus,
    now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, tick++)),
  });
  const merged: number[] = [];
  notices.registerAction("approve_and_merge", ({ pullRequest }) => {
    if (pullRequest?.number === 13) {
      return Promise.reject(new Error("CI is red."));
    }
    merged.push(pullRequest?.number ?? 0);
    return Promise.resolve();
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    notices,
    github,
  });
  return { server, owner: await signIn(server), notices, bus, merged };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const awaitingApproval = (pullRequest: number, floorId = "web-shop") => ({
  kind: "action" as const,
  title: `PR #${String(pullRequest)} awaiting your approval`,
  floorId,
  pullRequest: {
    number: pullRequest,
    url: `https://github.com/adrianeyre/${floorId}/pull/${String(pullRequest)}`,
  },
  actions: [{ id: "approve_and_merge", label: "Approve and merge" }],
});

const titles = async (setup: Setup, url = "/api/notices") => {
  const response = await request(setup, "GET", url);
  expect(response.statusCode).toBe(200);
  return noticeListSchema.parse(response.json()).notices.map((n) => n.title);
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "lists the open Notices of every Floor, or of one",
    async (setup) => {
      const { notices } = setup;
      expect(await titles(setup)).toEqual([]);
      const raised = await notices.raise(awaitingApproval(14));
      await notices.raise({
        kind: "info",
        title: "PR #3 opened",
        floorId: "blog",
      });
      await notices.raise({ kind: "action", title: "AI Account rate-limited" });

      const response = await request(setup, "GET", "/api/notices");
      const [, , first] = noticeListSchema.parse(response.json()).notices;
      expect(first).toEqual({
        id: raised.id,
        kind: "action",
        title: "PR #14 awaiting your approval",
        floorId: "web-shop",
        agentId: null,
        issue: null,
        pullRequest: {
          number: 14,
          url: "https://github.com/adrianeyre/web-shop/pull/14",
        },
        ciRunUrl: null,
        links: [],
        positions: [],
        actions: [{ id: "approve_and_merge", label: "Approve and merge" }],
        createdAt: "2026-10-08T12:00:00.000Z",
        dismissedAt: null,
        actedAt: null,
        actedOn: null,
      });
      expect(await titles(setup)).toEqual([
        "AI Account rate-limited",
        "PR #3 opened",
        "PR #14 awaiting your approval",
      ]);
      expect(await titles(setup, "/api/notices?floorId=blog")).toEqual([
        "PR #3 opened",
      ]);
    },
  ],
  [
    "dismisses a Notice, which leaves the board",
    async (setup) => {
      const { notices, bus } = setup;
      const notice = await notices.raise(awaitingApproval(14));
      const response = await request(
        setup,
        "POST",
        `/api/notices/${notice.id}/dismiss`,
      );
      expect(response.statusCode).toBe(200);
      expect(noticeSchema.parse(response.json()).dismissedAt).toBe(
        "2026-10-08T12:00:01.000Z",
      );
      expect(await titles(setup)).toEqual([]);
      expect((await bus.eventsAfter(0)).at(-1)?.event.type).toBe(
        "notice.dismissed",
      );

      const again = await request(
        setup,
        "POST",
        `/api/notices/${notice.id}/dismiss`,
      );
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({
        error: "notice_closed",
        message: "That Notice was already dismissed.",
      });
    },
  ],
  [
    "acts on a Notice through its handler, which takes it off the board",
    async (setup) => {
      const { notices, bus, merged } = setup;
      const notice = await notices.raise(awaitingApproval(14));
      const response = await request(
        setup,
        "POST",
        `/api/notices/${notice.id}/act`,
        { action: "approve_and_merge" },
      );
      expect(response.statusCode).toBe(200);
      const acted = noticeSchema.parse(response.json());
      expect(acted.actedOn).toBe("approve_and_merge");
      expect(acted.actedAt).toBe("2026-10-08T12:00:01.000Z");
      expect(merged).toEqual([14]);
      expect(await titles(setup)).toEqual([]);
      expect((await bus.eventsAfter(0)).at(-1)?.event).toEqual({
        type: "notice.acted_on",
        version: 1,
        noticeId: notice.id,
        floorId: "web-shop",
        action: "approve_and_merge",
      });
    },
  ],
  [
    "keeps the Notice when its action fails, and says why",
    async (setup) => {
      const notice = await setup.notices.raise(awaitingApproval(13));
      const response = await request(
        setup,
        "POST",
        `/api/notices/${notice.id}/act`,
        { action: "approve_and_merge" },
      );
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: "action_failed",
        message: "The action failed, so the Notice stays: CI is red.",
      });
      expect(await titles(setup)).toEqual(["PR #13 awaiting your approval"]);
    },
  ],
  [
    "refuses actions a Notice does not offer, and Notices that are not there",
    async (setup) => {
      const notice = await setup.notices.raise({
        kind: "info",
        title: "PR #3 opened",
        floorId: "blog",
      });
      const notOffered = await request(
        setup,
        "POST",
        `/api/notices/${notice.id}/act`,
        { action: "approve_and_merge" },
      );
      expect(notOffered.statusCode).toBe(422);
      expect(notOffered.json()).toMatchObject({ error: "action_not_offered" });

      for (const url of [
        "/api/notices/notice-missing/dismiss",
        "/api/notices/notice-missing/act",
      ]) {
        const missing = await request(setup, "POST", url, {
          action: "approve_and_merge",
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: "notice_not_found" });
      }

      const malformed = await request(
        setup,
        "POST",
        `/api/notices/${notice.id}/act`,
        { action: "Approve & merge" },
      );
      expect(malformed.statusCode).toBe(400);
      expect(await titles(setup)).toEqual(["PR #3 opened"]);
    },
  ],
];

describe("the Notice API, in memory", () => {
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

describe("the Notice API, in Postgres 18", () => {
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

describe("the Notice API's access", () => {
  it("needs a session, and the CSRF token to change anything", async () => {
    const setup = await setUp(
      memoryStores(),
      createEventBus({ store: memoryEventStore() }),
    );
    const notice = await setup.notices.raise(awaitingApproval(14));
    const signedOut = await setup.server.inject({
      method: "GET",
      url: "/api/notices",
    });
    expect(signedOut.statusCode).toBe(401);
    const withoutCsrf = await setup.server.inject({
      method: "POST",
      url: `/api/notices/${notice.id}/dismiss`,
      headers: { cookie: setup.owner.cookie },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(await titles(setup)).toEqual(["PR #14 awaiting your approval"]);
  });
});
