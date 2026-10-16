import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import type { IssuePriority } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createAgents } from "../agents/agents.ts";
import { createFloors, type Floors } from "../floors/floors.ts";
import { createFloorStops, memoryFloorStopStore } from "../floors/stops.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createWorkQueue,
  type WorkQueue,
  type WorkQueueOptions,
} from "./queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkItem,
  type WorkQueueStore,
} from "./store.ts";

// The office-wide and per-Floor sandbox limits and the work queue (PRD
// FR-22), with the Manager's dispatch (FR-23), as scenarios: work waits
// while the limits' worth of sandboxes run, then starts by Floor priority,
// issue priority (the Manager's triage) and age, shared across the Agents
// of a Role. Every case runs with the queue in memory and in Postgres 18.

interface Setup {
  readonly floors: Floors;
  readonly stores: OfficeStores;
  readonly store: WorkQueueStore;
  readonly bus: EventBus;
  /** The office-wide limit the queue reads. */
  readonly limit: { current: number };
  /** Issues whose work has started, in the order it started. */
  readonly started: number[];
  /** Each start: its issue and the Agent that does it, in order. */
  readonly ran: { issue: number; agentId: string | null }[];
  /** The most sandbox work seen running at once on each Floor. */
  readonly peak: Map<string, number>;
  /** Agents paused at a Token Cap, as the queue reads them. */
  readonly paused: string[];
  /** Issues' priorities from triage, by issue; normal when absent. */
  readonly priorities: Map<number, IssuePriority>;
  /** Ends the running work for an issue. */
  finish(issue: number, outcome?: "finished" | "failed" | "requeued"): void;
  /** A queue on these stores; `start()` it to start work. */
  queue(
    options?: Pick<WorkQueueOptions, "onEnded" | "stoppedFloors">,
  ): WorkQueue;
  /** Each issue's work's status, by issue. */
  statuses(): Promise<Record<number, string>>;
  /** The coders on a Floor, oldest first. */
  coders(floorId: string): Promise<string[]>;
}

const start = new Date("2026-10-09T09:00:00.000Z");

async function setUp(
  stores: OfficeStores,
  store: WorkQueueStore,
  bus: EventBus,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  // Each step a second after the one before, so ages are distinct.
  let tick = 0;
  const now = () => new Date(start.getTime() + 1000 * tick++);
  const floors = createFloors({
    store: stores.floors,
    github,
    events: bus,
    now,
  });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");
  // web-shop has two coders, the blog one.
  await createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    now,
  }).add("web-shop", { role: "coder" });

  const limit = { current: 1 };
  const started: number[] = [];
  const paused: string[] = [];
  const priorities = new Map<number, IssuePriority>();
  const running = new Map<
    number,
    (outcome: "finished" | "failed" | "requeued") => void
  >();
  const all: WorkItem[] = [];
  const ran: { issue: number; agentId: string | null }[] = [];
  const peak = new Map<string, number>();
  const onFloor = new Map<string, number>();
  const count = (floorId: string, by: number) => {
    const now = (onFloor.get(floorId) ?? 0) + by;
    onFloor.set(floorId, now);
    peak.set(floorId, Math.max(peak.get(floorId) ?? 0, now));
  };
  const queue = (
    options: Pick<WorkQueueOptions, "onEnded" | "stoppedFloors"> = {},
  ) =>
    createWorkQueue({
      ...options,
      store,
      agents: stores.agents,
      events: bus,
      limit: () => Promise.resolve(limit.current),
      execute: (work, signal) =>
        new Promise((resolve) => {
          started.push(work.issue);
          all.push(work);
          ran.push({ issue: work.issue, agentId: work.agentId });
          if (work.stage !== "needs-review") {
            count(work.floorId, 1);
          }
          let ended = false;
          const end = (outcome: "finished" | "failed" | "requeued") => {
            if (!ended && work.stage !== "needs-review") {
              count(work.floorId, -1);
            }
            ended = true;
            resolve(outcome);
          };
          running.set(work.issue, end);
          signal.addEventListener("abort", () => {
            end("failed");
          });
        }),
      pausedAgents: () => paused,
      issuePriority: (_floorId, issue) =>
        Promise.resolve(priorities.get(issue) ?? "normal"),
      now,
    });
  return {
    floors,
    stores,
    store,
    bus,
    limit,
    started,
    ran,
    peak,
    paused,
    priorities,
    finish(issue, outcome = "finished") {
      running.get(issue)?.(outcome);
      running.delete(issue);
    },
    queue,
    async statuses() {
      const active = await store.active();
      return Object.fromEntries(
        [...all, ...active].map(({ issue, id }) => [
          issue,
          active.find((item) => item.id === id)?.status ?? "ended",
        ]),
      );
    },
    coders: async (floorId) =>
      (await stores.agents.list(floorId))
        .filter(({ role }) => role === "coder")
        .map(({ id }) => id),
  };
}

const work = (floorId: string, issue: number) =>
  ({ floorId, issue, stage: "needs-work" }) as const;

type Case = [name: string, run: (setup: Setup) => Promise<void>];

/** Each `issue.assigned` event, as issue and Agent, in order. */
const assignments = async (bus: EventBus) =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type === "issue.assigned")
    .map(({ issue, agentId }) => [issue, agentId]);

const cases: Case[] = [
  [
    "two coders share four issues, the next going to whichever coder is free",
    async (setup) => {
      setup.limit.current = 3;
      const [ada, grace] = await setup.coders("web-shop");
      const queue = setup.queue();
      await queue.start();
      for (const issue of [1, 2, 3, 4]) {
        await queue.enqueue(work("web-shop", issue));
      }
      // Dispatched in turn, least work first: two each, one running each.
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      expect(await assignments(setup.bus)).toEqual([
        [1, ada],
        [2, grace],
        [3, ada],
        [4, grace],
      ]);
      expect(await setup.statuses()).toEqual({
        1: "running",
        2: "running",
        3: "queued",
        4: "queued",
      });

      // Ada finishes #1 and starts her #3.
      setup.finish(1);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 3]);
      });
      // Ada finishes #3 while Grace is still on #2: #4 waits for no one,
      // so the Manager moves it to Ada, who is free.
      setup.finish(3);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 3, 4]);
      });
      expect((await assignments(setup.bus)).at(-1)).toEqual([4, ada]);
      setup.finish(2);
      setup.finish(4);
      await queue.idle();

      expect(setup.ran).toEqual([
        { issue: 1, agentId: ada },
        { issue: 2, agentId: grace },
        { issue: 3, agentId: ada },
        { issue: 4, agentId: ada },
      ]);
      // Grace's pile went from one ticket to none when #4 moved.
      const graceQueue = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (event) =>
            event.type === "agent.queue_changed" && event.agentId === grace,
        )
        .map((event) =>
          event.type === "agent.queue_changed" ? event.queued : -1,
        );
      expect(graceQueue).toEqual([1, 0, 1, 0]);
      expect(await setup.store.active()).toEqual([]);
      await queue.stop();
    },
  ],
  [
    "the Floor limit holds: two coders share four issues one at a time while the office has room",
    async (setup) => {
      setup.limit.current = 3;
      await setup.floors.updateSettings("web-shop", { concurrencyLimit: 1 });
      const [ada, grace] = await setup.coders("web-shop");
      const [blogCoder] = await setup.coders("blog");
      const queue = setup.queue();
      await queue.start();
      for (const issue of [1, 2, 3, 4]) {
        await queue.enqueue(work("web-shop", issue));
      }
      await queue.enqueue(work("blog", 20));
      // web-shop runs one sandbox though Grace is free and the office has
      // room; the blog's work starts beside it.
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 20]);
      });
      queue.wake();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.started).toEqual([1, 20]);
      expect(await setup.statuses()).toMatchObject({
        1: "running",
        2: "queued",
        3: "queued",
        4: "queued",
        20: "running",
      });

      for (const [finished, next] of [
        [1, 2],
        [2, 3],
        [3, 4],
      ] as const) {
        setup.finish(finished);
        await vi.waitFor(() => {
          expect(setup.started.at(-1)).toBe(next);
        });
        expect(
          (await setup.store.active()).filter(
            ({ floorId, status }) =>
              floorId === "web-shop" && status === "running",
          ),
        ).toHaveLength(1);
      }
      setup.finish(4);
      setup.finish(20);
      await queue.idle();

      expect(setup.peak.get("web-shop")).toBe(1);
      // Shared two each, in the order they were dispatched.
      expect(setup.ran).toEqual([
        { issue: 1, agentId: ada },
        { issue: 20, agentId: blogCoder },
        { issue: 2, agentId: grace },
        { issue: 3, agentId: ada },
        { issue: 4, agentId: grace },
      ]);
      await queue.stop();
    },
  ],
  [
    "reads the Floor limit afresh, and the office limit holds over a higher Floor limit",
    async (setup) => {
      setup.limit.current = 3;
      await setup.floors.updateSettings("web-shop", { concurrencyLimit: 1 });
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await queue.enqueue(work("web-shop", 2));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      queue.wake();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.started).toEqual([1]);
      // Raised, the second coder starts at once.
      await setup.floors.updateSettings("web-shop", { concurrencyLimit: 2 });
      queue.wake();
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      setup.finish(1);
      setup.finish(2);
      await queue.idle();

      // A Floor limit above the office's does not lift the office's.
      setup.limit.current = 1;
      await setup.floors.updateSettings("web-shop", { concurrencyLimit: 5 });
      await queue.enqueue(work("web-shop", 3));
      await queue.enqueue(work("web-shop", 4));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 3]);
      });
      queue.wake();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.started).toEqual([1, 2, 3]);
      setup.finish(3);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 3, 4]);
      });
      expect(setup.peak.get("web-shop")).toBe(2);
      await queue.stop();
    },
  ],
  [
    "moves waiting work to a free Agent: one the Owner adds, or another when its own is paused in the Agent editor",
    async (setup) => {
      setup.limit.current = 3;
      const queue = setup.queue();
      await queue.start();
      // The blog's one coder has three issues: #1 runs, #2 and #3 wait.
      await queue.enqueue(work("blog", 1));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      await queue.enqueue(work("blog", 2));
      await queue.enqueue(work("blog", 3));
      const [first] = await setup.coders("blog");

      // A second coder joins the blog: the next waiting issue is moved to
      // it and starts.
      await createAgents({
        store: setup.stores.agents,
        floors: setup.stores.floors,
        events: setup.bus,
      }).add("blog", { role: "coder" });
      const [, second] = await setup.coders("blog");
      queue.wake();
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      expect(setup.ran.at(-1)).toEqual({ issue: 2, agentId: second });

      // The first coder is paused in the Agent editor while #3 waits for
      // it: when the second is free, #3 goes there instead.
      const agent = (await setup.stores.agents.list("blog")).find(
        ({ id }) => id === first,
      );
      if (agent === undefined) {
        throw new Error("No first coder.");
      }
      await setup.stores.agents.update({ ...agent, enabled: false });
      setup.finish(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.started).toEqual([1, 2]);
      setup.finish(2);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 3]);
      });
      expect(setup.ran.at(-1)).toEqual({ issue: 3, agentId: second });
      expect(await assignments(setup.bus)).toEqual([
        [1, first],
        [2, first],
        [3, first],
        [2, second],
        [3, second],
      ]);
      await queue.stop();
    },
  ],
  [
    "a coder removed mid-task finishes it, starts no more, and goes once it ends; its waiting work moves on (FR-10)",
    async (setup) => {
      setup.limit.current = 3;
      const [ada, grace] = await setup.coders("web-shop");
      const agents = createAgents({
        store: setup.stores.agents,
        floors: setup.stores.floors,
        events: setup.bus,
        work: setup.store,
      });
      const ended: number[] = [];
      const queue = setup.queue({
        onEnded: (item) => {
          ended.push(item.issue);
          void agents.settle(item.floorId);
        },
      });
      await queue.start();
      for (const issue of [1, 2, 3]) {
        await queue.enqueue(work("web-shop", issue));
      }
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      // #3 waits for Ada, who is working #1.
      expect((await assignments(setup.bus)).at(-1)).toEqual([3, ada]);

      const { removed } = await agents.remove("web-shop", ada ?? "");
      expect(removed).toBe(false);
      queue.wake();
      setup.finish(1);
      await vi.waitFor(async () => {
        expect(await setup.coders("web-shop")).toEqual([grace]);
      });
      expect(ended).toEqual([1]);
      // Ada took nothing more; #3 waits for Grace to be free.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.started).toEqual([1, 2]);
      setup.finish(2);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 3]);
      });
      expect(setup.ran.at(-1)).toEqual({ issue: 3, agentId: grace });
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter((event) => event.type === "agent.removed"),
      ).toEqual([
        {
          type: "agent.removed",
          version: 1,
          floorId: "web-shop",
          agentId: ada,
        },
      ]);
      await queue.stop();
    },
  ],
  [
    "holds back a paused Agent's work, gives new work to another, and starts requeued work once the Agent resumes",
    async (setup) => {
      setup.limit.current = 3;
      const [ada, grace] = await setup.coders("web-shop");
      const queue = setup.queue();
      await queue.start();
      // Ada is paused at a Token Cap: the work goes to Grace.
      setup.paused.push(ada ?? "");
      await queue.enqueue(work("web-shop", 1));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      expect((await setup.store.active())[0]?.agentId).toBe(grace);

      // Resumed, Ada takes the next; then she is paused while she works.
      setup.paused.splice(0);
      await queue.enqueue(work("web-shop", 2));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      setup.paused.push(ada ?? "");
      setup.finish(2, "requeued");
      await vi.waitFor(async () => {
        expect((await setup.statuses())[2]).toBe("queued");
      });
      queue.wake();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.started).toEqual([1, 2]);
      expect(
        (await setup.store.active()).find(({ issue }) => issue === 2),
      ).toMatchObject({ agentId: ada, status: "queued", startedAt: null });

      // Resumed: her work starts again.
      setup.paused.splice(0);
      queue.wake();
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 2]);
      });
      await queue.stop();
    },
  ],
  [
    "with a limit of 1, a second task waits and starts when the first finishes",
    async (setup) => {
      const queue = setup.queue();
      await queue.start();
      // For two different coders, so only the limit holds the second back.
      await queue.enqueue(work("web-shop", 1));
      await queue.enqueue(work("web-shop", 2));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      expect(await setup.statuses()).toEqual({ 1: "running", 2: "queued" });
      const [ada, grace] = await setup.coders("web-shop");
      expect(
        (await setup.store.active()).map(({ agentId }) => agentId),
      ).toEqual([ada, grace]);

      setup.finish(1);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      expect(await setup.statuses()).toEqual({ 1: "ended", 2: "running" });

      setup.finish(2);
      await queue.idle();
      expect(await setup.store.active()).toEqual([]);
      await queue.stop();
    },
  ],
  [
    "with a limit of 2, both start at once",
    async (setup) => {
      setup.limit.current = 2;
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await queue.enqueue(work("web-shop", 2));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      await queue.stop();
    },
  ],
  [
    "reads the limit afresh, starting waiting work when it is raised",
    async (setup) => {
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await queue.enqueue(work("web-shop", 2));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      setup.limit.current = 2;
      queue.wake();
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      await queue.stop();
    },
  ],
  [
    "starts waiting work by Floor priority, then oldest first",
    async (setup) => {
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      // Waiting: web-shop #2 (oldest), blog #20, web-shop #3.
      await queue.enqueue(work("web-shop", 2));
      await queue.enqueue(work("blog", 20));
      await queue.enqueue(work("web-shop", 3));
      await setup.floors.updateSettings("blog", { priority: 5 });

      setup.finish(1);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 20]);
      });
      setup.finish(20);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 20, 2]);
      });
      setup.finish(2);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 20, 2, 3]);
      });
      await queue.stop();
    },
  ],
  [
    "starts waiting work by Floor priority, then issue priority, then oldest first",
    async (setup) => {
      setup.priorities.set(3, "low");
      setup.priorities.set(4, "high");
      setup.priorities.set(20, "low");
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      // Waiting: web-shop #2 (normal, oldest), #3 (low), #4 (high), and
      // blog #20 (low, on the higher-priority Floor).
      await queue.enqueue(work("web-shop", 2));
      await queue.enqueue(work("web-shop", 3));
      await queue.enqueue(work("web-shop", 4));
      await queue.enqueue(work("blog", 20));
      await setup.floors.updateSettings("blog", { priority: 5 });
      expect(
        Object.fromEntries(
          (await setup.store.active()).map(({ issue, priority }) => [
            issue,
            priority,
          ]),
        ),
      ).toEqual({ 1: "normal", 2: "normal", 3: "low", 4: "high", 20: "low" });

      for (const [finished, next] of [
        [1, 20],
        [20, 4],
        [4, 2],
        [2, 3],
      ] as const) {
        setup.finish(finished);
        await vi.waitFor(() => {
          expect(setup.started.at(-1)).toBe(next);
        });
      }
      expect(setup.started).toEqual([1, 20, 4, 2, 3]);
      await queue.stop();
    },
  ],
  [
    "gives an Agent one task at a time, and emits how many wait for it",
    async (setup) => {
      setup.limit.current = 3;
      const queue = setup.queue();
      await queue.start();
      // The blog has one coder.
      await queue.enqueue(work("blog", 1));
      // #1 starts before the others arrive, so the emitted lengths do not
      // depend on how quickly the store claims it.
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      await queue.enqueue(work("blog", 2));
      await queue.enqueue(work("blog", 3));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      setup.finish(1);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2]);
      });
      setup.finish(2);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 3]);
      });
      await queue.stop();

      const [coder] = await setup.coders("blog");
      const lengths = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter((event) => event.type === "agent.queue_changed");
      expect(
        lengths.every(
          (event) => event.floorId === "blog" && event.agentId === coder,
        ),
      ).toBe(true);
      // 1 waits, it starts, then 1 and 2 more wait, and each starts in turn.
      expect(lengths.map(({ queued }) => queued)).toEqual([1, 0, 1, 2, 1, 0]);
    },
  ],
  [
    "queues an issue once per stage, and only stages with work to do",
    async (setup) => {
      const queue = setup.queue();
      await queue.enqueue(work("web-shop", 1));
      await queue.enqueue(work("web-shop", 1));
      expect(await setup.store.active()).toHaveLength(1);
      // The Merge Policy's work at ready-to-merge, for no one Agent.
      await queue.enqueue({
        floorId: "web-shop",
        issue: 1,
        stage: "ready-to-merge",
      });
      expect(
        (await setup.store.active()).map(({ stage, agentId }) => [
          stage,
          agentId,
        ]),
      ).toEqual([
        ["needs-work", expect.any(String)],
        ["ready-to-merge", null],
      ]);
      // Only the Owner moves an issue out of needs-human.
      await expect(
        queue.enqueue({ floorId: "web-shop", issue: 1, stage: "needs-human" }),
      ).rejects.toThrow("is no Agent's to do");
      // Without start(), nothing runs; the work waits, persisted.
      expect(setup.started).toEqual([]);
    },
  ],
  [
    "starts review rounds whatever the sandbox limit, for no one Agent, holding them while a required reviewer is paused",
    async (setup) => {
      const queue = setup.queue();
      await queue.start();
      // The one sandbox is in use, and another task waits for it.
      await queue.enqueue(work("web-shop", 1));
      await queue.enqueue(work("web-shop", 2));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      const review = (issue: number) =>
        ({ floorId: "web-shop", issue, stage: "needs-review" }) as const;
      await queue.enqueue(review(3));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 3]);
      });
      expect(
        (await setup.store.active()).find(({ issue }) => issue === 3),
      ).toMatchObject({ agentId: null, status: "running" });
      // A review round takes no sandbox: when the first task finishes,
      // the second starts though the review is still running.
      setup.finish(1);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 3, 2]);
      });
      setup.finish(3);
      setup.finish(2);

      // While one of the Floor's required reviewers is paused at a Token
      // Cap, its review rounds wait; the blog's do not.
      const [reviewer] = (await setup.stores.floors.get("web-shop"))
        ?.requiredReviewerAgentIds ?? [""];
      setup.paused.push(reviewer ?? "");
      await queue.enqueue(review(4));
      await queue.enqueue({ floorId: "blog", issue: 5, stage: "needs-review" });
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 3, 2, 5]);
      });
      queue.wake();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await setup.statuses())[4]).toBe("queued");
      setup.paused.splice(0);
      queue.wake();
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 3, 2, 5, 4]);
      });
      await queue.stop();
    },
  ],
  [
    "queues work for a stage whose work is still running once that work ends",
    async (setup) => {
      setup.limit.current = 3;
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      // A review round sends the issue back before the coder's work ends.
      await queue.enqueue(work("web-shop", 1));
      expect(await setup.store.active()).toHaveLength(1);
      setup.finish(1);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 1]);
      });
      // Work that is queued again runs again itself: nothing more is added.
      await queue.enqueue(work("web-shop", 1));
      setup.finish(1, "requeued");
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 1, 1]);
      });
      setup.finish(1);
      await queue.idle();
      expect(setup.started).toEqual([1, 1, 1]);
      await queue.stop();
    },
  ],
  [
    "the Manager can stop running work: queued again for another Agent, or cancelled",
    async (setup) => {
      setup.limit.current = 3;
      const [ada, grace] = await setup.coders("web-shop");
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await vi.waitFor(() => {
        expect(setup.ran).toEqual([{ issue: 1, agentId: ada }]);
      });
      const [first] = await setup.store.active();
      if (first === undefined) {
        throw new Error("Nothing is running.");
      }

      // Queued again for Grace: the same work, which starts for her.
      expect(
        await queue.interrupt(first.id, {
          requeue: true,
          ...(grace === undefined ? {} : { agentId: grace }),
        }),
      ).toBe(true);
      await vi.waitFor(() => {
        expect(setup.ran).toEqual([
          { issue: 1, agentId: ada },
          { issue: 1, agentId: grace },
        ]);
      });
      expect(await assignments(setup.bus)).toEqual([
        [1, ada],
        [1, grace],
      ]);
      expect(await setup.store.active()).toEqual([
        expect.objectContaining({ id: first.id, status: "running" }),
      ]);

      // Stopped for good: it ends as cancelled.
      expect(await queue.interrupt(first.id)).toBe(true);
      expect(await setup.store.active()).toEqual([]);
      expect(await setup.store.recent("web-shop", 10)).toEqual([
        expect.objectContaining({ id: first.id, status: "cancelled" }),
      ]);
      // Work not running here cannot be interrupted.
      expect(await queue.interrupt(first.id)).toBe(false);
      await queue.stop();
    },
  ],
  [
    "stops everything on a Floor, its work queued again until it carries on, and the other Floor works on",
    async (setup) => {
      setup.limit.current = 3;
      const [ada] = await setup.coders("web-shop");
      const queue = setup.queue({ stoppedFloors: () => stops.stopped() });
      const stops = createFloorStops({
        store: memoryFloorStopStore(),
        events: setup.bus,
        work: setup.store,
        queue: () => queue,
      });
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await vi.waitFor(() => {
        expect(setup.ran).toEqual([{ issue: 1, agentId: ada }]);
      });

      await stops.stop("web-shop");
      expect(stops.stopped()).toEqual(["web-shop"]);
      // Its work is back in the queue, for the same Agent, and new work waits.
      expect(await setup.store.active()).toEqual([
        expect.objectContaining({ issue: 1, status: "queued", agentId: ada }),
      ]);
      await queue.enqueue(work("web-shop", 2));
      await queue.enqueue(work("blog", 3));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 3]);
      });
      queue.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(setup.started).toEqual([1, 3]);
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(({ type }) => type === "floor.stopped"),
      ).toEqual([{ type: "floor.stopped", version: 1, floorId: "web-shop" }]);

      // Carrying on, the work starts again where it was, and the new work too.
      await stops.carryOn("web-shop");
      expect(stops.stopped()).toEqual([]);
      await vi.waitFor(() => {
        expect(setup.started.slice(2).sort()).toEqual([1, 2]);
      });
      expect(setup.ran.slice(2)).toContainEqual({ issue: 1, agentId: ada });
      await queue.stop();
    },
  ],
  [
    "ends all the work of a Floor removed, running and queued, for good, and the other Floor works on",
    async (setup) => {
      setup.limit.current = 3;
      await setup.coders("web-shop");
      const queue = setup.queue({ stoppedFloors: () => stops.stopped() });
      const stops = createFloorStops({
        store: memoryFloorStopStore(),
        events: setup.bus,
        work: setup.store,
        queue: () => queue,
      });
      await queue.start();
      // Two coders: #1 and #2 run, #3 waits for one of them.
      for (const issue of [1, 2, 3]) {
        await queue.enqueue(work("web-shop", issue));
      }
      await queue.enqueue(work("blog", 4));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 2, 4]);
      });

      await setup.stores.floors.archive("web-shop", start);
      await stops.end("web-shop");
      // The running work was interrupted, the queued work cancelled.
      expect(
        (await setup.store.recent("web-shop", 10))
          .map(({ issue, status }) => [issue, status])
          .sort(),
      ).toEqual([
        [1, "cancelled"],
        [2, "cancelled"],
        [3, "cancelled"],
      ]);
      expect(await setup.statuses()).toMatchObject({ 4: "running" });
      queue.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(setup.started).toEqual([1, 2, 4]);
      await queue.stop();
    },
  ],
  [
    "queues work for the Agent named, and reads a Floor's latest work newest first",
    async (setup) => {
      setup.limit.current = 3;
      const [ada, grace] = await setup.coders("web-shop");
      const queue = setup.queue();
      // Dispatch would give #1 to Ada, the oldest coder with no work.
      await queue.enqueue({
        ...work("web-shop", 1),
        ...(grace === undefined ? {} : { agentId: grace }),
      });
      await queue.enqueue(work("web-shop", 2));
      await queue.enqueue(work("blog", 3));
      expect(await assignments(setup.bus)).toEqual([
        [1, grace],
        [2, ada],
        [3, expect.any(String)],
      ]);
      expect(
        (await setup.store.recent("web-shop", 10)).map(({ issue }) => issue),
      ).toEqual([2, 1]);
      expect(
        (await setup.store.recent("web-shop", 1)).map(({ issue }) => issue),
      ).toEqual([2]);
    },
  ],
  [
    "starts work left running by a server that stopped",
    async (setup) => {
      const first = setup.queue();
      await first.enqueue(work("web-shop", 1));
      // A server claimed it, then went away without ending it.
      expect(await setup.store.claimNext(1, start)).toMatchObject({ issue: 1 });

      const second = setup.queue();
      await second.start();
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      await second.stop();
    },
  ],
  [
    "a designer's work at needs-qa waits for QA's to end, keeps its Role and goes to the designer",
    async (setup) => {
      setup.limit.current = 3;
      const designer = await createAgents({
        store: setup.stores.agents,
        floors: setup.stores.floors,
        events: setup.bus,
      }).add("web-shop", { role: "designer", name: "Dee" });
      const qa = (await setup.stores.agents.list("web-shop")).find(
        ({ role }) => role === "qa",
      );
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue({ floorId: "web-shop", issue: 1, stage: "needs-qa" });
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      // QA passes it on while its own work still runs: the designer's waits.
      await queue.enqueue({
        floorId: "web-shop",
        issue: 1,
        stage: "needs-qa",
        role: "designer",
      });
      expect(await setup.store.active()).toEqual([
        expect.objectContaining({ agentId: qa?.id, status: "running" }),
      ]);
      expect(
        (await setup.store.active()).map((item) => "role" in item),
      ).toEqual([false]);
      setup.finish(1);
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1, 1]);
      });
      expect(await setup.store.active()).toEqual([
        expect.objectContaining({
          stage: "needs-qa",
          role: "designer",
          agentId: designer.id,
          status: "running",
        }),
      ]);
      setup.finish(1);
      await queue.idle();
      expect(setup.ran).toEqual([
        { issue: 1, agentId: qa?.id },
        { issue: 1, agentId: designer.id },
      ]);
      await queue.stop();
    },
  ],
  [
    "cancels running work when it stops, and starts nothing on archived Floors",
    async (setup) => {
      const queue = setup.queue();
      await queue.start();
      await queue.enqueue(work("web-shop", 1));
      await queue.enqueue(work("blog", 2));
      await vi.waitFor(() => {
        expect(setup.started).toEqual([1]);
      });
      await setup.floors.archive("blog");
      await queue.stop();
      expect(await setup.store.active()).toEqual([
        expect.objectContaining({ issue: 2, status: "queued" }),
      ]);

      const again = setup.queue();
      await again.start();
      await again.idle();
      expect(setup.started).toEqual([1]);
      await again.stop();
    },
  ],
];

describe("the work queue, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      await run(
        await setUp(
          stores,
          memoryWorkQueueStore(stores.floors),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the work queue, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          databaseWorkQueueStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});

describe("the work queue, as an Agent is paused during a search", () => {
  it("holds a review round queued after its Floor's required reviewer is paused, though the search began before", async () => {
    const stores = memoryStores();
    const inner = memoryWorkQueueStore(stores.floors);
    /** Runs once, as the next search is looking. */
    let during: (() => Promise<void>) | undefined;
    const store: WorkQueueStore = {
      ...inner,
      async claimNext(limit, at, paused) {
        const run = during;
        during = undefined;
        await run?.();
        return inner.claimNext(limit, at, paused);
      },
    };
    const setup = await setUp(
      stores,
      store,
      createEventBus({ store: memoryEventStore() }),
    );
    const queue = setup.queue();
    await queue.start();
    await queue.idle();
    const [reviewer = ""] =
      (await stores.floors.get("web-shop"))?.requiredReviewerAgentIds ?? [];
    expect(reviewer).not.toBe("");

    // The search has read who is paused; then the reviewer reaches a Token
    // Cap, and a review round is queued, before it reads the queue.
    during = async () => {
      setup.paused.push(reviewer);
      await inner.add(
        {
          floorId: "web-shop",
          issue: 4,
          stage: "needs-review",
          agentId: null,
          priority: "normal",
        },
        new Date(),
      );
    };
    queue.wake();
    await vi.waitFor(() => {
      expect(during).toBeUndefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setup.started).toEqual([]);
    expect((await setup.statuses())[4]).toBe("queued");

    setup.paused.splice(0);
    queue.wake();
    await vi.waitFor(() => {
      expect(setup.started).toEqual([4]);
    });
    await queue.stop();
  });
});
