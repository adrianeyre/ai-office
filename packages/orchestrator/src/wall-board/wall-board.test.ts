import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { floorErrorCodes } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { FloorError } from "../floors/errors.ts";
import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { createWallBoard } from "./wall-board.ts";

// A Floor's wall board (PRD FR-50, FR-57): its issues in progress with the
// Agent working each, its stage, its links and the rounds it has used, and
// the Floor's queues by stage and by Agent. Every case runs with the stores
// in memory and in Postgres 18.

const at = (minute: number) =>
  new Date(`2026-10-09T09:${String(minute).padStart(2, "0")}:00.000Z`);

async function run(
  stores: OfficeStores,
  work: WorkQueueStore,
  bus: EventBus,
): Promise<void> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const floors = createFloors({ store: stores.floors, github, events: bus });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");
  const team = await stores.agents.list("web-shop");
  const idOf = (role: string) =>
    team.find((agent) => agent.role === role)?.id ?? "";
  const [coder, reviewer, qa] = [idOf("coder"), idOf("reviewer"), idOf("qa")];
  const [blogCoder] = (await stores.agents.list("blog"))
    .filter(({ role }) => role === "coder")
    .map(({ id }) => id);

  // Issue 3's work is done, and no longer in progress.
  await work.add(
    {
      floorId: "web-shop",
      issue: 3,
      stage: "needs-work",
      agentId: coder,
      priority: "normal",
    },
    at(1),
  );
  const done = await work.claimNext(3, at(2));
  await work.end(done?.id ?? 0, "finished", at(3));
  // Issue 2 waits for QA, which is paused, so it is older than the work
  // in progress and still listed after it.
  await work.add(
    {
      floorId: "web-shop",
      issue: 2,
      stage: "needs-qa",
      agentId: qa,
      priority: "normal",
    },
    at(3),
  );
  // The coder works issue 4.
  await work.add(
    {
      floorId: "web-shop",
      issue: 4,
      stage: "needs-work",
      agentId: coder,
      priority: "normal",
    },
    at(4),
  );
  expect((await work.claimNext(3, at(5), [qa]))?.issue).toBe(4);
  // Issue 7 waits for its third round of review, and issue 9 for the coder.
  await work.add(
    {
      floorId: "web-shop",
      issue: 7,
      stage: "needs-review",
      agentId: null,
      priority: "normal",
    },
    at(6),
  );
  await work.add(
    {
      floorId: "web-shop",
      issue: 9,
      stage: "needs-work",
      agentId: coder,
      priority: "high",
    },
    at(7),
  );
  // Another Floor's work is not on this board.
  await work.add(
    {
      floorId: "blog",
      issue: 2,
      stage: "needs-work",
      agentId: blogCoder ?? null,
      priority: "normal",
    },
    at(8),
  );

  for (const round of [1, 2]) {
    await stores.reviews.recordVerdict({
      floorId: "web-shop",
      issue: 7,
      pullRequest: 12,
      round,
      agentId: reviewer,
      headSha: String(round).repeat(40),
      verdict: {
        verdict: "changes_requested",
        summary: "Not yet.",
        comments: [
          { severity: "blocking", path: "a.ts", line: 1, body: "Fix it." },
        ],
      },
      reviewUrl: `https://github.com/adrianeyre/web-shop/pull/12#pullrequestreview-${String(round)}`,
      createdAt: at(10 + round),
    });
  }
  await stores.reviews.recordQaReport({
    floorId: "web-shop",
    issue: 7,
    pullRequest: 12,
    round: 1,
    agentId: qa,
    headSha: "3".repeat(40),
    result: "fail",
    summary: "A test fails.",
    steps: "Run it.",
    commentUrl: "https://github.com/adrianeyre/web-shop/pull/12#issuecomment-1",
    createdAt: at(15),
  });
  // The coder handed issue 7 to review, and waits on its verdicts; its
  // Handoff to review of issue 3, long done, is not waited on.
  for (const issue of [3, 7]) {
    await stores.reviews.recordHandoff({
      floorId: "web-shop",
      issue,
      stage: "needs-review",
      fromAgentId: coder,
      summary: { changed: "The basket.", check: "Totals.", risks: "None." },
      createdAt: at(16),
    });
  }
  await bus.publish({
    type: "issue.picked_up",
    version: 1,
    floorId: "web-shop",
    issue: 4,
    title: "Add a basket",
    url: "https://github.example/adrianeyre/web-shop/issues/4",
  });
  for (const pullRequest of [11, 12]) {
    await bus.publish({
      type: "pull_request.opened",
      version: 1,
      floorId: "web-shop",
      agentId: coder,
      issue: 7,
      pullRequest,
      url: `https://github.com/adrianeyre/web-shop/pull/${String(pullRequest)}`,
      branch: "ai-office/7-pay",
    });
  }

  const board = createWallBoard({
    floors: stores.floors,
    agents: stores.agents,
    work,
    reviews: stores.reviews,
    events: bus,
    // QA is paused at a Token Cap.
    capPaused: (agentId) => agentId === qa,
  });
  expect(await board.floorBoard("web-shop")).toEqual({
    floorId: "web-shop",
    roundCap: 3,
    qaRoundCap: 3,
    issues: [
      {
        issue: 4,
        // As intake saw it.
        url: "https://github.example/adrianeyre/web-shop/issues/4",
        stage: "needs-work",
        status: "working",
        agentIds: [coder],
        pullRequest: null,
        reviewRounds: 0,
        qaRounds: 0,
      },
      {
        issue: 2,
        url: "https://github.com/adrianeyre/web-shop/issues/2",
        stage: "needs-qa",
        status: "waiting",
        agentIds: [qa],
        pullRequest: null,
        reviewRounds: 0,
        qaRounds: 0,
      },
      {
        issue: 7,
        url: "https://github.com/adrianeyre/web-shop/issues/7",
        stage: "needs-review",
        status: "waiting",
        // A review round is the required reviewers' work.
        agentIds: [reviewer],
        // The latest it opened.
        pullRequest: {
          number: 12,
          url: "https://github.com/adrianeyre/web-shop/pull/12",
        },
        reviewRounds: 2,
        qaRounds: 1,
      },
      {
        issue: 9,
        url: "https://github.com/adrianeyre/web-shop/issues/9",
        stage: "needs-work",
        status: "waiting",
        agentIds: [coder],
        pullRequest: null,
        reviewRounds: 0,
        qaRounds: 0,
      },
    ],
    queues: [
      { stage: "needs-work", waiting: 1, working: 1 },
      { stage: "needs-review", waiting: 1, working: 0 },
      { stage: "needs-qa", waiting: 1, working: 0 },
      { stage: "needs-docs", waiting: 0, working: 0 },
      { stage: "ready-to-merge", waiting: 0, working: 0 },
    ],
    agents: team.map(({ id }) => ({
      agentId: id,
      waiting: id === coder || id === qa ? 1 : 0,
      awaitingReview: id === coder ? [7] : [],
      capped: id === qa,
    })),
  });

  // Issue 7 passes review, on to QA: the coder no longer waits on it.
  const reviewed = (await work.active()).find(
    (item) => item.floorId === "web-shop" && item.issue === 7,
  );
  await work.end(reviewed?.id ?? 0, "finished", at(17));
  await work.add(
    {
      floorId: "web-shop",
      issue: 7,
      stage: "needs-qa",
      agentId: qa,
      priority: "normal",
    },
    at(18),
  );
  const coderEntry = async (wallBoard: typeof board) =>
    (await wallBoard.floorBoard("web-shop")).agents.find(
      ({ agentId }) => agentId === coder,
    );
  expect((await coderEntry(board))?.awaitingReview).toEqual([]);
  // Without a word on Token Caps, no Agent is paused at one.
  const uncapped = createWallBoard({
    floors: stores.floors,
    agents: stores.agents,
    work,
    reviews: stores.reviews,
    events: bus,
  });
  expect(
    (await uncapped.floorBoard("web-shop")).agents.some(({ capped }) => capped),
  ).toBe(false);

  // A Floor with nothing in progress has an empty board.
  await work.end(
    (await work.active()).find(({ floorId }) => floorId === "blog")?.id ?? 0,
    "cancelled",
    at(20),
  );
  const blog = await board.floorBoard("blog");
  expect(blog.issues).toEqual([]);
  expect(
    blog.queues.every(({ waiting, working }) => waiting + working === 0),
  ).toBe(true);

  // An archived Floor's board can still be read; an unknown one cannot.
  await floors.archive("blog");
  expect((await board.floorBoard("blog")).floorId).toBe("blog");
  const missing = await board
    .floorBoard("nowhere")
    .catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(FloorError);
  expect((missing as FloorError).code).toBe(floorErrorCodes.floorNotFound);
}

describe("a Floor's wall board", () => {
  it("shows its issues in progress and its queues, in memory", async () => {
    const stores = memoryStores();
    await run(
      stores,
      memoryWorkQueueStore(stores.floors),
      createEventBus({ store: memoryEventStore() }),
    );
  });

  postgresTest(
    "shows its issues in progress and its queues, in Postgres 18",
    async ({ database }) => {
      await run(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
    },
  );
});
