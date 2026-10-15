import {
  createEventBus,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { GitHubError, type CheckRun, type GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { floorErrorCodes, grillingBranch } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { BatchRecord } from "../batches/store.ts";
import { createFloors } from "../floors/floors.ts";
import type { GrillingSessionRecord } from "../grilling/session.ts";
import { batchBranch, issueBranch } from "../sandbox/branch.ts";
import { memoryStores, type OfficeStores } from "../stores.ts";
import { memoryWorkQueueStore, type WorkQueueStore } from "../work/store.ts";
import {
  branchCommitOf,
  ciStatusOf,
  createBranches,
  type Branches,
  type BranchesOptions,
  batchIssueStage,
} from "./branches.ts";

// A Floor's AI Office branches, for the Branches page: each a lane off the
// default branch, from the fake GitHub and the work queue.

const repository = "adrianeyre/web-shop";
const start = new Date("2026-10-12T09:00:00.000Z");
const daysBefore = (days: number) =>
  new Date(start.getTime() - days * 86_400_000);

interface Setup {
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly work: WorkQueueStore;
  readonly bus: EventBus;
  readonly clock: { now: Date };
  /** Every GitHub call the branches made, by method. */
  readonly calls: string[];
  /** Each wait asked for, in ms. */
  readonly waits: number[];
  readonly agentId: (role: string) => string;
  readonly branches: (options?: Partial<BranchesOptions>) => Branches;
}

/** Counts the calls made through `github`'s repository clients. */
function counted(github: GitHubApp, calls: string[]): GitHubApp {
  return {
    ...github,
    repository(fullName) {
      const client = github.repository(fullName);
      return new Proxy(client, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown;
          if (typeof value !== "function") {
            return value;
          }
          return (...args: unknown[]) => {
            calls.push(String(key));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
}

async function setUp(): Promise<Setup> {
  const clock = { now: start };
  const github = createFakeGitHub({ now: () => clock.now });
  github.installRepository(repository);
  const stores = memoryStores();
  const bus = createEventBus({ store: memoryEventStore() });
  await createFloors({
    store: stores.floors,
    github,
    events: bus,
    agents: stores.agents,
    now: () => clock.now,
  }).add(repository);
  const team = await stores.agents.list("web-shop");
  const work = memoryWorkQueueStore(stores.floors);
  const calls: string[] = [];
  const waits: number[] = [];
  const sessions: GrillingSessionRecord[] = [
    {
      id: 3,
      floorId: "web-shop",
      topic: "Gift cards",
      status: "active",
    } as GrillingSessionRecord,
  ];
  return {
    github,
    stores,
    work,
    bus,
    clock,
    calls,
    waits,
    agentId: (role) => team.find((agent) => agent.role === role)?.id ?? "",
    branches: (options = {}) =>
      createBranches({
        floors: stores.floors,
        agents: stores.agents,
        roles: stores.roles,
        work,
        grilling: {
          get: (floorId, id) =>
            Promise.resolve(
              sessions.find(
                (session) => session.floorId === floorId && session.id === id,
              ),
            ),
        },
        github: counted(github, calls),
        events: bus,
        now: () => clock.now,
        wait: (ms) => {
          waits.push(ms);
          clock.now = new Date(clock.now.getTime() + ms);
          return Promise.resolve();
        },
        ...options,
      }),
  };
}

const run = (overrides: Partial<CheckRun> = {}): CheckRun => ({
  id: 1,
  name: "CI",
  status: "completed",
  conclusion: "success",
  headSha: "0".repeat(40),
  htmlUrl: "https://github.com/adrianeyre/web-shop/runs/1",
  ...overrides,
});

describe("ciStatusOf", () => {
  it("is none with no check runs, pending while one runs, and success only when every one passes", () => {
    expect(ciStatusOf([])).toBe("none");
    expect(
      ciStatusOf([run(), run({ status: "in_progress", conclusion: null })]),
    ).toBe("pending");
    expect(
      ciStatusOf([
        run(),
        run({ conclusion: "neutral" }),
        run({ conclusion: "skipped" }),
      ]),
    ).toBe("success");
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
    ] as const) {
      expect(ciStatusOf([run(), run({ conclusion })])).toBe("failure");
    }
  });
});

describe("branchCommitOf", () => {
  it("keeps a commit's subject, and the Agent its trailer names", () => {
    expect(
      branchCommitOf({
        sha: "a".repeat(40),
        message:
          "Add a basket\n\nIt holds the items.\n\nAgent: Ada (coder, Claude claude-opus-5-5)\n",
        author: "Adrian Eyre",
        authoredAt: "2026-10-12T08:00:00Z",
        htmlUrl: `https://github.com/${repository}/commit/${"a".repeat(40)}`,
      }),
    ).toEqual({
      sha: "a".repeat(40),
      message: "Add a basket",
      author: "Adrian Eyre",
      agent: "Ada (coder, Claude claude-opus-5-5)",
      authoredAt: "2026-10-12T08:00:00.000Z",
      url: `https://github.com/${repository}/commit/${"a".repeat(40)}`,
    });
    expect(
      branchCommitOf({
        sha: "b".repeat(40),
        message: "Initial commit",
        author: "adrianeyre",
        authoredAt: "2026-10-12T08:00:00.000Z",
        htmlUrl: "https://github.com/x/y/commit/b",
      }).agent,
    ).toBeNull();
  });

  it("draws a commit GitHub gives no time for as the oldest, rather than failing", () => {
    expect(
      branchCommitOf({
        sha: "c".repeat(40),
        message: "Undated",
        author: "",
        authoredAt: "",
        htmlUrl: "https://github.com/x/y/commit/c",
      }).authoredAt,
    ).toBe(new Date(0).toISOString());
  });
});

describe("a Floor's branches", () => {
  it("draws each AI Office branch as a lane off the default branch, ahead and behind it, with its own commits, newest commit first", async () => {
    const { github, branches } = await setUp();
    const basket = github.createIssue(repository, {
      title: "Add a basket",
      labels: ["ai-office", "needs-work"],
    });
    const lane = issueBranch(basket.number, basket.title);
    const first = github.pushCommit(repository, lane, {
      message: "Add a basket\n\nAgent: Ada (coder, Claude claude-opus-5-5)",
      authoredAt: daysBefore(0.2),
    });
    const second = github.pushCommit(repository, lane, {
      message: "Total the basket",
      authoredAt: daysBefore(0.1),
    });
    github.pushCommit(repository, "main", { message: "Elsewhere" });
    // The Grilling Session's documents, and branches AI Office never made.
    github.pushCommit(repository, grillingBranch(3), {
      authoredAt: daysBefore(0.5),
    });
    github.pushCommit(repository, "feature/by-hand");
    github.pushCommit(repository, "ai-office/contract-lane");

    const floor = await branches().floorBranches("web-shop");
    expect(floor).toMatchObject({
      floorId: "web-shop",
      repository,
      defaultBranch: {
        name: "main",
        url: `https://github.com/${repository}/tree/main`,
      },
      fetchedAt: start.toISOString(),
    });
    expect(floor.lanes.map(({ name }) => name)).toEqual([
      lane,
      grillingBranch(3),
    ]);
    const [basketLane, grillingLane] = floor.lanes;
    expect(basketLane).toMatchObject({
      name: "ai-office/1-add-a-basket",
      url: `https://github.com/${repository}/tree/ai-office/1-add-a-basket`,
      headSha: second,
      aheadBy: 2,
      behindBy: 1,
      lastCommitAt: daysBefore(0.1).toISOString(),
      likelyToConflict: false,
      issue: {
        number: 1,
        title: "Add a basket",
        url: `https://github.com/${repository}/issues/1`,
      },
      grillingSession: null,
      pullRequest: null,
      ci: "none",
      work: { kind: "stage", stage: "needs-work" },
    });
    expect(basketLane?.mergeBase.message).toBe("Initial commit");
    expect(basketLane?.commits).toEqual([
      expect.objectContaining({
        sha: first,
        message: "Add a basket",
        author: "adrianeyre",
        agent: "Ada (coder, Claude claude-opus-5-5)",
      }),
      expect.objectContaining({ sha: second, message: "Total the basket" }),
    ]);
    // Made from the default branch after its new commit.
    expect(grillingLane).toMatchObject({
      aheadBy: 1,
      behindBy: 0,
      issue: null,
      grillingSession: { id: 3, topic: "Gift cards" },
      // The Manager writes its documents while the session runs.
      work: { kind: "agent", role: "manager", roleName: "Manager" },
    });
  });

  it("draws a one-pull-request Batch's shared branch as one lane: the issue at work now, then each of its issues with where it stands", async () => {
    const { github, work, branches, agentId, clock } = await setUp();
    for (const title of ["Basket", "Totals", "Receipts"]) {
      github.createIssue(repository, { title, labels: ["ai-office"] });
    }
    github.setLabel(repository, 1, "ready-to-merge");
    github.pushCommit(repository, batchBranch(7), { message: "Basket" });
    github.pushCommit(repository, batchBranch(7), { message: "Totals" });
    const coder = agentId("coder");
    await work.add(
      {
        floorId: "web-shop",
        issue: 2,
        stage: "needs-work",
        agentId: coder,
        priority: "normal",
      },
      clock.now,
    );
    await work.claimNext(3, clock.now);

    const floor = await branches({
      batches: {
        get: (id) =>
          Promise.resolve(
            id === 7
              ? ({
                  id: 7,
                  floorId: "web-shop",
                  issues: [1, 2, 3],
                } as Partial<BatchRecord> as BatchRecord)
              : undefined,
          ),
      },
    }).floorBranches("web-shop");
    expect(floor.lanes).toHaveLength(1);
    expect(floor.lanes[0]).toMatchObject({
      name: "ai-office/batch-7",
      aheadBy: 2,
      issue: { number: 2, title: "Totals" },
      batch: {
        id: 7,
        issues: [
          { number: 1, stage: "ready-to-merge" },
          { number: 2, stage: "needs-work" },
          { number: 3, stage: null },
        ],
      },
      grillingSession: null,
      work: { kind: "agent", agentId: coder },
    });
  });

  it("says where a Batch's issue stands: closed, its work's stage, its label, or not started", () => {
    expect(batchIssueStage(1, { state: "closed", labels: [] }, [])).toBe(
      "closed",
    );
    expect(
      batchIssueStage(1, { state: "open", labels: ["needs-qa"] }, [
        { issue: 1, stage: "needs-review", status: "queued" },
      ]),
    ).toBe("needs-review");
    expect(
      batchIssueStage(1, { state: "open", labels: ["Needs-QA"] }, []),
    ).toBe("needs-qa");
    expect(batchIssueStage(1, undefined, [])).toBeNull();
  });

  it("names the Agent working on a branch, or the stage it waits in", async () => {
    const { github, work, branches, agentId, clock } = await setUp();
    for (const title of ["Coded now", "Waiting for review", "Labelled"]) {
      github.createIssue(repository, { title, labels: ["ai-office"] });
    }
    github.setLabel(repository, 3, "needs-qa");
    for (const [issue, title] of [
      [1, "Coded now"],
      [2, "Waiting for review"],
      [3, "Labelled"],
      [4, "Lost"],
    ] as const) {
      github.pushCommit(repository, issueBranch(issue, title));
    }
    const coder = agentId("coder");
    await work.add(
      {
        floorId: "web-shop",
        issue: 1,
        stage: "needs-work",
        agentId: coder,
        priority: "normal",
      },
      clock.now,
    );
    await work.claimNext(3, clock.now);
    await work.add(
      {
        floorId: "web-shop",
        issue: 2,
        stage: "needs-review",
        agentId: agentId("reviewer"),
        priority: "normal",
      },
      clock.now,
    );

    const lanes = new Map(
      (await branches().floorBranches("web-shop")).lanes.map((lane) => [
        lane.issue?.number ?? lane.name,
        lane,
      ]),
    );
    expect(lanes.get(1)?.work).toMatchObject({
      kind: "agent",
      agentId: coder,
      role: "coder",
      roleName: "coder",
      avatar: expect.objectContaining({ version: 1 }) as unknown,
    });
    expect(lanes.get(2)?.work).toEqual({
      kind: "stage",
      stage: "needs-review",
    });
    expect(lanes.get(3)?.work).toEqual({ kind: "stage", stage: "needs-qa" });
    // An issue GitHub does not have: no issue, and nothing waits.
    expect(lanes.get("ai-office/4-lost")).toMatchObject({
      issue: null,
      work: null,
    });
  });

  it("gives a branch its open pull request and the CI on its head", async () => {
    const { github, branches } = await setUp();
    github.createIssue(repository, { title: "Add a basket" });
    const lane = issueBranch(1, "Add a basket");
    const head = github.pushCommit(repository, lane);
    const pull = await github.repository(repository).createPullRequest({
      title: "Add a basket",
      body: "Closes #1",
      head: lane,
      base: "main",
    });
    github.startCI(repository, head);

    const [opened] = (await branches().floorBranches("web-shop")).lanes;
    expect(opened).toMatchObject({
      pullRequest: {
        number: pull.number,
        title: "Add a basket",
        url: pull.htmlUrl,
        draft: false,
      },
      ci: "pending",
    });
  });

  it("marks a lane more than 20 commits behind, or split off more than 7 days ago, as likely to conflict", async () => {
    const { github, branches } = await setUp();
    const old = github.pushCommit(repository, "main", {
      authoredAt: daysBefore(8),
    });
    github.pushCommit(repository, issueBranch(1, "Split off long ago"));
    for (let commit = 0; commit < 20; commit += 1) {
      github.pushCommit(repository, "main");
    }
    github.pushCommit(repository, issueBranch(2, "Twenty behind"));
    // Now 20 and 21 behind; the first split off at `old`, 8 days ago.
    github.pushCommit(repository, "main");
    github.pushCommit(repository, issueBranch(3, "Fresh"));
    const lanes = (await branches().floorBranches("web-shop")).lanes;
    const byName = (name: string) => lanes.find((lane) => lane.name === name);
    expect(byName(issueBranch(1, "Split off long ago"))).toMatchObject({
      behindBy: 21,
      mergeBase: expect.objectContaining({ sha: old }) as unknown,
      likelyToConflict: true,
    });
    expect(byName(issueBranch(2, "Twenty behind"))).toMatchObject({
      behindBy: 1,
      likelyToConflict: false,
    });
    expect(byName(issueBranch(3, "Fresh"))).toMatchObject({
      behindBy: 0,
      likelyToConflict: false,
    });
  });

  it("is empty for a Floor with no AI Office branches", async () => {
    const { github, branches } = await setUp();
    github.pushCommit(repository, "feature/by-hand");
    expect((await branches().floorBranches("web-shop")).lanes).toEqual([]);
  });
});

describe("asking GitHub sparingly", () => {
  it("keeps what GitHub said for a minute, then asks again", async () => {
    const { github, branches, calls, clock } = await setUp();
    github.pushCommit(repository, issueBranch(1, "Add a basket"));
    const view = branches();
    await view.floorBranches("web-shop");
    const once = calls.length;
    expect(calls.filter((call) => call === "compareBranches")).toHaveLength(1);
    clock.now = new Date(start.getTime() + 59_000);
    await view.floorBranches("web-shop");
    expect(calls).toHaveLength(once);
    clock.now = new Date(start.getTime() + 60_000);
    await view.floorBranches("web-shop");
    // Asked again, but the same commits are not compared again, a finished
    // issue is kept, and the repository's address is known.
    expect(calls.slice(once).sort()).toEqual(
      ["getBranch", "listBranches", "listCheckRuns", "listPullRequests"].sort(),
    );
  });

  it("asks again once the repository changed, no sooner than 5 seconds after it last asked, and once for many callers", async () => {
    const { github, branches, bus, calls, clock, waits } = await setUp();
    const lane = issueBranch(1, "Add a basket");
    github.pushCommit(repository, lane);
    const view = branches();
    expect((await view.floorBranches("web-shop")).lanes[0]?.aheadBy).toBe(1);
    const once = calls.length;

    clock.now = new Date(start.getTime() + 2000);
    github.pushCommit(repository, lane);
    await bus.publish({
      type: "repository.changed",
      version: 1,
      floorId: "web-shop",
      change: "push",
    });
    const [first, second] = await Promise.all([
      view.floorBranches("web-shop"),
      view.floorBranches("web-shop"),
    ]);
    expect(waits).toEqual([3000]);
    expect(first.lanes[0]?.aheadBy).toBe(2);
    expect(second).toEqual(first);
    expect(calls.filter((call) => call === "listBranches")).toHaveLength(2);
    expect(calls.length).toBeGreaterThan(once);

    // A branch AI Office pushed itself does the same.
    github.pushCommit(repository, lane);
    await bus.publish({
      type: "branch.pushed",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      issue: 1,
      branch: lane,
      sha: (await github.repository(repository).getBranch(lane))?.sha ?? "",
      commits: 1,
    });
    expect((await view.floorBranches("web-shop")).lanes[0]?.aheadBy).toBe(3);
  });

  it("reads CI again after a check changes, and keeps finished CI otherwise", async () => {
    const { github, branches, bus, calls, clock } = await setUp();
    const head = github.pushCommit(repository, issueBranch(1, "Add a basket"));
    github.finishCI(repository, head);
    const view = branches();
    expect((await view.floorBranches("web-shop")).lanes[0]?.ci).toBe("success");
    clock.now = new Date(start.getTime() + 10_000);
    await bus.publish({
      type: "repository.changed",
      version: 1,
      floorId: "web-shop",
      change: "pull_request",
    });
    const before = calls.length;
    await view.floorBranches("web-shop");
    expect(calls.slice(before)).not.toContain("listCheckRuns");

    clock.now = new Date(start.getTime() + 20_000);
    github.finishCI(repository, head, { name: "lint", conclusion: "failure" });
    await bus.publish({
      type: "repository.changed",
      version: 1,
      floorId: "web-shop",
      change: "check_run",
    });
    expect((await view.floorBranches("web-shop")).lanes[0]?.ci).toBe("failure");
  });
});

describe("what the branches refuse", () => {
  it("refuses a Floor that does not exist, or is archived", async () => {
    const { branches, stores, bus, github, clock } = await setUp();
    await expect(branches().floorBranches("nowhere")).rejects.toMatchObject({
      code: floorErrorCodes.floorNotFound,
    });
    await createFloors({
      store: stores.floors,
      github,
      events: bus,
      now: () => clock.now,
    }).archive("web-shop");
    await expect(branches().floorBranches("web-shop")).rejects.toMatchObject({
      code: floorErrorCodes.floorArchived,
    });
  });

  it("says so when the GitHub App is not configured", async () => {
    const { branches } = await setUp();
    await expect(
      branches({ github: undefined }).floorBranches("web-shop"),
    ).rejects.toMatchObject({ code: floorErrorCodes.githubNotConfigured });
  });

  it("says GitHub could not be asked when it fails, and asks again next time", async () => {
    const { github, branches, clock } = await setUp();
    github.pushCommit(repository, issueBranch(1, "Add a basket"));
    let failing = true;
    const flaky: GitHubApp = {
      ...github,
      repository(fullName) {
        const client = github.repository(fullName);
        return {
          ...client,
          listBranches: (prefix) =>
            failing
              ? Promise.reject(
                  new GitHubError(403, "GitHub answered 403: API rate limit"),
                )
              : client.listBranches(prefix),
        };
      },
    };
    const view = branches({ github: flaky });
    await expect(view.floorBranches("web-shop")).rejects.toMatchObject({
      code: floorErrorCodes.githubUnavailable,
      message: expect.stringContaining("API rate limit") as unknown,
    });
    failing = false;
    clock.now = new Date(start.getTime() + 1000);
    expect((await view.floorBranches("web-shop")).lanes).toHaveLength(1);
  });

  it("refuses a default branch GitHub does not have", async () => {
    const { branches, stores } = await setUp();
    await stores.floors.update("web-shop", { defaultBranch: "trunk" });
    await expect(branches().floorBranches("web-shop")).rejects.toMatchObject({
      code: floorErrorCodes.branchNotFound,
    });
  });
});
