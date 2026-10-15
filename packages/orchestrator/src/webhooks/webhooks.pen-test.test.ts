import { createEventBus, memoryEventStore } from "@ai-office/events";
import { signWebhook, type GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createMergeFlow } from "../merge/merge.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { issueBranch } from "../sandbox/branch.ts";
import { memoryStores } from "../stores.ts";
import type { WorkItem } from "../work/store.ts";
import {
  createGitHubWebhooks,
  webhookActions,
  type GitHubWebhooks,
} from "./webhooks.ts";

// Probe W1 (docs/pen-testing/assessments/W1.md), "Replay: find each state
// in which a replayed delivery is not a no-op (merge, intake, label,
// close)" and "Event types and actions handled; anything acted on without
// checking the installation and repository match a Floor" (H12). The real
// receiver is put in front of the real Merge Policy flow, waiting for CI
// on an auto-merge Floor whose required reviewer approved, against the
// fake GitHub. A spoofed GitHub (position 5) holding captured deliveries
// replays them in every state of that wait.
//
// What holds, and these tests keep holding: a delivery only says when to
// look. The gate reads CI from GitHub each time it is woken, so no replay,
// however its payload reads, merges a pull request GitHub's CI has not
// passed; and once merged, a replay merges nothing again. That a replay
// was acted on at all, and what each cost, was W1-1 (the route's probe,
// apps/server/src/webhooks/routes.pen-test.test.ts). Since its fix the
// same body is acted on once, so each wake here is a delivery of its own,
// as GitHub sends one per check run, and the replay of one starts nothing.

const repository = "adrianeyre/web-shop";
const title = "Add a basket";
const branch = issueBranch(1, title);
const secret = "fake-w1-webhook-secret-0123456789";
const encryptor = encryptorFromKey(Buffer.alloc(32, 7));

interface Setup {
  readonly fake: FakeGitHub;
  readonly webhooks: GitHubWebhooks;
  readonly notices: Notices;
  /** The Merge Policy's run at ready-to-merge, waiting for CI. */
  readonly running: Promise<string>;
  readonly stop: AbortController;
  /** How many times the gate has read CI on GitHub. */
  readonly looks: () => number;
  /** Batches' checks a delivery started. */
  readonly batchChecks: () => number;
  merged(): Promise<boolean>;
}

let current: Setup | undefined;

afterEach(async () => {
  current?.stop.abort();
  await current?.running.catch(() => undefined);
  current = undefined;
});

async function setUp(): Promise<Setup> {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github: fake, events: bus }).add(
    repository,
  );
  const reviewer = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "reviewer",
  );
  if (reviewer === undefined) {
    throw new Error("A new Floor has a reviewer.");
  }
  await stores.floors.update("web-shop", {
    requiredReviewerAgentIds: [reviewer.id],
    mergePolicy: "auto_merge",
  });
  fake.createIssue(repository, {
    title,
    labels: ["ai-office", "ready-to-merge"],
  });
  const head = fake.pushCommit(repository, branch, {
    files: { "basket.ts": "export const basket = [];\n" },
  });
  await fake.repository(repository).createPullRequest({
    title,
    body: "Closes #1",
    head: branch,
    base: "main",
  });
  await stores.reviews.recordVerdict({
    floorId: "web-shop",
    issue: 1,
    pullRequest: 2,
    round: 1,
    agentId: reviewer.id,
    headSha: head,
    verdict: { verdict: "approve", summary: "Looks right.", comments: [] },
    reviewUrl: `https://github.com/${repository}/pull/2#review-1`,
    createdAt: new Date(),
  });
  // CI has started on the head, and has not finished.
  fake.startCI(repository, branch, { name: "CI" });

  let looks = 0;
  const github: GitHubApp = {
    ...fake,
    repository(fullName) {
      const client = fake.repository(fullName);
      return {
        ...client,
        listCheckRuns: (ref) => {
          looks += 1;
          return client.listCheckRuns(ref);
        },
      };
    },
  };
  const notices = createNotices({ store: stores.notices, events: bus });
  const flow = createMergeFlow({
    floors: stores.floors,
    agents: stores.agents,
    github,
    notices,
    events: bus,
    reviews: stores.reviews,
    batches: stores.batches,
    ownerLogin: () => Promise.resolve("adrianeyre"),
    // Only a delivery wakes the gate within the test.
    ci: { pollMs: 3_600_000, timeoutMs: 7_200_000, startMs: 3_600_000 },
  });
  let batchChecks = 0;
  const webhooks = createGitHubWebhooks({
    store: stores.office,
    floors: stores.floors,
    encryptor,
    events: bus,
    targets: {
      merge: flow,
      batches: {
        trigger: () => {
          batchChecks += 1;
          return Promise.resolve();
        },
      },
    },
  });
  await webhooks.setSettings({ enabled: true, secret });
  const work: WorkItem = {
    id: 1,
    floorId: "web-shop",
    issue: 1,
    stage: "ready-to-merge",
    agentId: null,
    status: "running",
    priority: "normal",
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
  const stop = new AbortController();
  const running = flow.execute(work, stop.signal);
  current = {
    fake,
    webhooks,
    notices,
    running,
    stop,
    looks: () => looks,
    batchChecks: () => batchChecks,
    merged: async () =>
      (await fake.repository(repository).getPullRequest(2)).merged,
  };
  // The gate's first look, before any delivery.
  await expect.poll(() => looks).toBe(1);
  return current;
}

/** A delivery as GitHub would sign it: what a spoofed GitHub replays. */
const signed = (event: string, payload: unknown) => {
  const body = Buffer.from(JSON.stringify(payload));
  return { event, body, signature: signWebhook(secret, body) };
};

/**
 * A check run on the head that reads as passed, whatever GitHub says: the
 * `id`th, each a delivery of its own.
 */
const passed = (id: number) =>
  signed("check_run", {
    action: "completed",
    check_run: {
      id,
      name: "CI",
      status: "completed",
      conclusion: "success",
    },
    repository: { full_name: repository },
  });
const passedCheckRun = passed(1);

describe("replaying a CI delivery while the Merge Policy waits for CI", () => {
  it("wakes the gate to read GitHub again, and never merges while GitHub's CI is still running", async () => {
    const setup = await setUp();
    for (let replay = 1; replay <= 5; replay += 1) {
      expect(await setup.webhooks.receive(passed(replay))).toEqual({
        status: "accepted",
        floorId: "web-shop",
        started: ["ci"],
      });
      await expect.poll(() => setup.looks()).toBe(1 + replay);
      expect(await setup.merged()).toBe(false);
    }
    // W1-1: the same delivery again wakes nothing.
    expect(await setup.webhooks.receive(passedCheckRun)).toEqual({
      status: "repeated",
    });
    expect(setup.looks()).toBe(6);
  });

  it("a 'passed' delivery replayed after CI failed on GitHub sends the pull request to the Owner, unmerged", async () => {
    const setup = await setUp();
    setup.fake.finishCI(repository, branch, {
      name: "CI",
      conclusion: "failure",
    });
    await setup.webhooks.receive(passedCheckRun);
    expect(await setup.running).toBe("finished");
    expect(await setup.merged()).toBe(false);
    const open = await setup.notices.open({ floorId: "web-shop" });
    expect(open.map(({ title: text }) => text)).toEqual([
      expect.stringContaining("PR #2 awaiting your approval"),
    ]);
  });

  it("once CI passes on GitHub the App merges once, and a replay afterwards merges nothing again", async () => {
    const setup = await setUp();
    setup.fake.finishCI(repository, branch, { name: "CI" });
    await setup.webhooks.receive(passedCheckRun);
    expect(await setup.running).toBe("finished");
    expect(await setup.merged()).toBe(true);
    const main = (await setup.fake.repository(repository).getBranch("main"))
      ?.sha;
    const looked = setup.looks();
    // W1-1: the delivery that woke it, again, starts nothing.
    expect(await setup.webhooks.receive(passedCheckRun)).toEqual({
      status: "repeated",
    });
    for (const delivery of [
      passed(2),
      signed("pull_request", {
        action: "synchronize",
        repository: { full_name: repository },
      }),
    ]) {
      expect(await setup.webhooks.receive(delivery)).toMatchObject({
        started: ["ci"],
      });
    }
    // Nothing waits on CI now: the wake reaches nothing.
    expect(setup.looks()).toBe(looked);
    expect(
      (await setup.fake.repository(repository).getBranch("main"))?.sha,
    ).toBe(main);
  });

  it("a replayed 'closed' delivery only starts the Batches' check, which reads its Batches and GitHub", async () => {
    const setup = await setUp();
    const closed = [
      signed("issues", {
        action: "closed",
        issue: { number: 1 },
        repository: { full_name: repository },
      }),
      signed("pull_request", {
        action: "closed",
        pull_request: { number: 2 },
        repository: { full_name: repository },
      }),
    ];
    for (const delivery of closed) {
      await setup.webhooks.receive(delivery);
    }
    expect(setup.batchChecks()).toBe(2);
    // W1-1: each again starts nothing.
    for (const delivery of closed) {
      expect(await setup.webhooks.receive(delivery)).toEqual({
        status: "repeated",
      });
    }
    expect(setup.batchChecks()).toBe(2);
    expect(await setup.merged()).toBe(false);
  });
});

describe("the events and actions a delivery is acted on for", () => {
  it("is this table and nothing else; every other event, such as push, installation or member, starts nothing", () => {
    const table = Object.fromEntries(
      [
        ["issues", "opened"],
        ["issues", "reopened"],
        ["issues", "labeled"],
        ["issues", "edited"],
        ["issues", "transferred"],
        ["issues", "closed"],
        ["issues", "deleted"],
        ["issues", "assigned"],
        ["label", "deleted"],
        ["label", "created"],
        ["pull_request", "closed"],
        ["pull_request", "opened"],
        ["pull_request", "anything"],
        ["check_run", "completed"],
        ["check_suite", "completed"],
        ["push", undefined],
        ["installation", "created"],
        ["installation_repositories", "added"],
        ["member", "added"],
        ["repository", "renamed"],
        ["ping", undefined],
      ].map(([event = "", action]) => [
        `${event}.${action ?? "-"}`,
        webhookActions(event, {
          ...(action === undefined ? {} : { action }),
          label: "needs-work",
        }),
      ]),
    );
    expect(table).toEqual({
      "issues.opened": ["intake"],
      "issues.reopened": ["intake"],
      "issues.labeled": ["intake"],
      "issues.edited": ["intake"],
      "issues.transferred": ["intake"],
      "issues.closed": ["batches"],
      "issues.deleted": [],
      "issues.assigned": [],
      "label.deleted": ["labels", "intake"],
      "label.created": [],
      "pull_request.closed": ["batches"],
      "pull_request.opened": ["ci"],
      "pull_request.anything": ["ci"],
      "check_run.completed": ["ci"],
      "check_suite.completed": ["ci"],
      "push.-": [],
      "installation.created": [],
      "installation_repositories.added": [],
      "member.added": [],
      "repository.renamed": [],
      "ping.-": [],
    });
  });

  it("a signed delivery from another installation, about a repository named as a Floor's, starts that Floor's rounds: the installation is never read, only the name", async () => {
    const setup = await setUp();
    const outcome = await setup.webhooks.receive(
      signed("check_run", {
        action: "completed",
        repository: { full_name: repository.toUpperCase() },
        installation: { id: 987654 },
      }),
    );
    expect(outcome).toEqual({
      status: "accepted",
      floorId: "web-shop",
      started: ["ci"],
    });
    // Still only a look: GitHub, through the Floor's own installation,
    // says CI is running.
    await expect.poll(() => setup.looks()).toBe(2);
    expect(await setup.merged()).toBe(false);
  });
});
