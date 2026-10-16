import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  memoryStores,
  memoryWorkQueueStore,
  type ManagerChat,
  type ManagerWorking,
} from "@ai-office/orchestrator";
import { workingNowSchema } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// The Working now API: every Agent's work and Manager's answer on the
// Floors in use, and the Owner stopping any one of them.

async function setUp() {
  const fake = createFakeGitHub();
  fake.installRepository("adrianeyre/web-shop");
  const stores = memoryStores();
  const work = memoryWorkQueueStore(stores.floors);
  const answering: ManagerWorking[] = [];
  const managerChat = {
    working: () => [...answering],
    end: vi.fn((floorId: string) => {
      answering.splice(
        answering.findIndex((each) => each.floorId === floorId),
        1,
      );
      return Promise.resolve();
    }),
  };
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: createEventBus({ store: memoryEventStore() }),
    stores,
    github: fake,
    workQueue: work,
    // Only what this API asks of it.
    managerChat: managerChat as unknown as ManagerChat,
  });
  const owner = await signIn(server);
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    server.inject({
      method,
      url,
      headers: owner.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  expect(
    (await call("POST", "/api/floors", { repository: "adrianeyre/web-shop" }))
      .statusCode,
  ).toBe(201);
  return { server, stores, work, answering, managerChat, call };
}

describe("the Working now API", () => {
  it("lists the Agents' work and the Managers answering, and stops each", async () => {
    const setup = await setUp();
    const team = await setup.stores.agents.list("web-shop");
    const coder = team.find(({ role }) => role === "coder");
    const manager = team.find(({ role }) => role === "manager");
    const queued = await setup.work.add(
      {
        floorId: "web-shop",
        issue: 7,
        stage: "needs-work",
        agentId: coder?.id ?? null,
        priority: "normal",
      },
      new Date("2026-10-16T09:00:00.000Z"),
    );
    setup.answering.push({
      floorId: "web-shop",
      replyTo: 3,
      phase: "writing",
      since: new Date("2026-10-16T09:05:00.000Z"),
    });

    const listed = await setup.call("GET", "/api/working-now");
    expect(listed.statusCode).toBe(200);
    expect(workingNowSchema.parse(listed.json())).toEqual({
      work: [
        {
          id: queued?.id,
          floorId: "web-shop",
          floorName: "web-shop",
          repository: "adrianeyre/web-shop",
          issue: 7,
          stage: "needs-work",
          status: "queued",
          agentId: coder?.id,
          agentName: coder?.name,
          role: "coder",
          queuedAt: "2026-10-16T09:00:00.000Z",
          startedAt: null,
        },
      ],
      managers: [
        {
          floorId: "web-shop",
          floorName: "web-shop",
          agentId: manager?.id,
          agentName: manager?.name,
          phase: "writing",
          since: "2026-10-16T09:05:00.000Z",
        },
      ],
    });

    const stopped = await setup.call(
      "POST",
      `/api/working-now/work/${String(queued?.id)}/stop`,
    );
    expect(stopped.statusCode).toBe(200);
    expect(workingNowSchema.parse(stopped.json()).work).toEqual([]);
    expect(await setup.work.recent("web-shop", 5)).toMatchObject([
      { issue: 7, status: "cancelled" },
    ]);

    const ended = await setup.call(
      "POST",
      "/api/working-now/managers/web-shop/stop",
    );
    expect(ended.statusCode).toBe(200);
    expect(setup.managerChat.end).toHaveBeenCalledWith("web-shop");
    expect(workingNowSchema.parse(ended.json()).managers).toEqual([]);
  });

  it("answers 404 for work or a Manager no longer going on", async () => {
    const setup = await setUp();
    for (const url of [
      "/api/working-now/work/999/stop",
      "/api/working-now/work/nope/stop",
      "/api/working-now/managers/web-shop/stop",
    ]) {
      const response = await setup.call("POST", url);
      expect(response.statusCode).toBe(404);
    }
    expect(setup.managerChat.end).not.toHaveBeenCalled();
  });

  it("is the Owner's alone", async () => {
    const setup = await setUp();
    const response = await setup.server.inject({
      method: "GET",
      url: "/api/working-now",
    });
    expect(response.statusCode).toBe(401);
  });
});
