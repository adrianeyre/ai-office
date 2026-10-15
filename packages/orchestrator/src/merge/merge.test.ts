import {
  createEventBus,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import type { CheckRunConclusion } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { mergeActions, type MergePolicy } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";
import type { VerdictRecord } from "../review/store.ts";
import { issueBranch } from "../sandbox/branch.ts";
import { memoryStores } from "../stores.ts";
import type { WorkItem } from "../work/store.ts";
import { chatIssueReason, createMergeFlow, type MergeFlow } from "./merge.ts";

// The Merge Policy at ready-to-merge (PRD FR-29, FR-49; ADR 0002), the flow
// on its own against the fake GitHub: each condition of the auto-merge
// gate holds a pull request back for the Owner; the labels override the
// Floor's policy; and the Notice's "Approve and merge" has the App merge.

const repository = "adrianeyre/web-shop";
const title = "Add a basket!";
const branch = issueBranch(1, title);

interface Setup {
  readonly fake: FakeGitHub;
  readonly bus: EventBus;
  readonly stores: ReturnType<typeof memoryStores>;
  readonly notices: Notices;
  readonly flow: MergeFlow;
  readonly reviewers: readonly AgentRecord[];
  readonly coder: AgentRecord;
  /** Runs the work at ready-to-merge for issue #1. */
  run(): Promise<string>;
  /** Every reviewer approves round `round`. */
  approved(round: number): Promise<void>;
  openNotices(): Promise<NoticeRecord[]>;
  /** How long the flow waited for CI, in all. */
  waited(): number;
}

let current: Setup | undefined;

afterEach(() => {
  current?.flow.stop();
  current = undefined;
});

const setUp = async (
  options: {
    readonly policy?: MergePolicy;
    readonly labels?: readonly { name: string; actor?: string }[];
    /** Checks that finish on the head the first time the flow waits. */
    readonly ciLater?: readonly {
      name: string;
      conclusion: CheckRunConclusion;
    }[];
    /** Waits in place of the stand-in that finishes `ciLater` at once. */
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    /**
     * The Batch issue #1 is in: one a chat request started (P2-3), or one
     * handed over by "complete issues".
     */
    readonly batch?: "chat" | "command";
  } = {},
): Promise<Setup> => {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github: fake, events: bus }).add(
    repository,
  );
  const team = await stores.agents.list("web-shop");
  const grace = team.find(({ role }) => role === "reviewer");
  const coder = team.find(({ role }) => role === "coder");
  if (grace === undefined || coder === undefined) {
    throw new Error("A new Floor has a coder and a reviewer.");
  }
  const quinta: AgentRecord = { ...grace, id: "quinta", name: "Quinta" };
  stores.agents.agents.set(quinta.id, quinta);
  await stores.floors.update("web-shop", {
    requiredReviewerAgentIds: [grace.id, quinta.id],
    mergePolicy: options.policy ?? "send_to_me",
  });

  // Issue #1 at ready-to-merge, with its pull request (#2) from its branch.
  fake.createIssue(repository, {
    title,
    body: "Shoppers need a basket.",
    labels: ["ai-office", "ready-to-merge"],
  });
  for (const { name, actor } of options.labels ?? []) {
    fake.setLabel(repository, 1, name, actor === undefined ? {} : { actor });
  }
  const head = fake.pushCommit(repository, branch, {
    files: { "src/basket.ts": "export const basket: string[] = [];\n" },
  });
  await fake.repository(repository).createPullRequest({
    title,
    body: "Closes #1",
    head: branch,
    base: "main",
  });

  if (options.batch !== undefined) {
    const manager = team.find(({ role }) => role === "manager");
    if (manager === undefined) {
      throw new Error("A new Floor has a Manager.");
    }
    const at = new Date("2026-10-09T11:00:00Z");
    const asked =
      options.batch === "chat"
        ? await stores.managerChat.append({
            floorId: "web-shop",
            kind: "owner",
            text: "Add a basket",
            command: null,
            replyTo: null,
            agentId: null,
            model: null,
            createdAt: at,
          })
        : undefined;
    await stores.batches.create(
      {
        floorId: "web-shop",
        issues: [1],
        status: "in_progress",
        agentId: manager.id,
        createdAt: at,
        chatMessageId: asked?.id ?? null,
      },
      {
        draftedBy: "model",
        summary: "A basket.",
        items: [],
        overlaps: [],
        parallel: [],
        leftOut: [],
      },
    );
  }

  const notices = createNotices({ store: stores.notices, events: bus });
  let clock = Date.parse("2026-10-09T12:00:00Z");
  let waited = 0;
  let waits = 0;
  const flow = createMergeFlow({
    floors: stores.floors,
    agents: stores.agents,
    github: fake,
    notices,
    events: bus,
    reviews: stores.reviews,
    batches: stores.batches,
    ownerLogin: () => Promise.resolve("adrianeyre"),
    now: () => new Date(clock),
    sleep: (ms, signal) => {
      if (options.sleep !== undefined) {
        return options.sleep(ms, signal);
      }
      clock += ms;
      waited += ms;
      waits += 1;
      if (waits === 1) {
        for (const { name, conclusion } of options.ciLater ?? []) {
          fake.finishCI(repository, branch, { name, conclusion });
        }
      }
      return Promise.resolve();
    },
  });
  const work: WorkItem = {
    id: 1,
    floorId: "web-shop",
    issue: 1,
    stage: "ready-to-merge",
    agentId: null,
    status: "running",
    priority: "normal",
    createdAt: new Date(clock),
    startedAt: new Date(clock),
    finishedAt: null,
  };
  const verdict = (agentId: string, round: number): VerdictRecord => ({
    floorId: "web-shop",
    issue: 1,
    pullRequest: 2,
    round,
    agentId,
    headSha: head,
    verdict: {
      verdict: "approve",
      summary: "It does what the issue asks.",
      comments: [],
    },
    reviewUrl: `https://github.com/${repository}/pull/2#review-${agentId}-${String(round)}`,
    createdAt: new Date(clock + round),
  });
  return {
    fake,
    bus,
    stores,
    notices,
    flow,
    reviewers: [grace, quinta],
    coder,
    run: () => flow.execute(work, new AbortController().signal),
    async approved(round) {
      for (const reviewer of [grace, quinta]) {
        await stores.reviews.recordVerdict(verdict(reviewer.id, round));
      }
    },
    openNotices: () => notices.open(),
    waited: () => waited,
  };
};

const pullRequest = async (setup: Setup) =>
  setup.fake.repository(repository).getPullRequest(2);

const merges = async (setup: Setup) =>
  (await setup.bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type === "pull_request.merged");

/** Expects the pull request held back for the Owner, saying why. */
const heldBackFor = async (setup: Setup, reasons: string): Promise<void> => {
  expect(await setup.run()).toBe("finished");
  expect((await pullRequest(setup)).merged).toBe(false);
  expect(await merges(setup)).toEqual([]);
  const [notice, ...others] = await setup.openNotices();
  expect(others).toEqual([]);
  expect(notice).toMatchObject({
    kind: "action",
    title: `PR #2 awaiting your approval: not merged automatically, as ${reasons}.`,
    floorId: "web-shop",
    pullRequest: { number: 2 },
    issue: { number: 1 },
    actions: [{ id: mergeActions.approveAndMerge, label: "Approve and merge" }],
  });
};

describe("auto-merge", () => {
  it("merges once every required reviewer approved and CI passed, recording it in an info Notice", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    current.fake.finishCI(repository, branch, { name: "test" });

    expect(await current.run()).toBe("finished");
    const merged = await pullRequest(current);
    expect(merged).toMatchObject({ merged: true, state: "closed" });
    // With a merge commit: the Agents' commits stay the Owner's.
    expect(await merges(current)).toEqual([
      expect.objectContaining({
        floorId: "web-shop",
        issue: 1,
        pullRequest: 2,
        url: merged.htmlUrl,
        by: "app",
      }),
    ]);
    expect(await current.openNotices()).toEqual([
      expect.objectContaining({
        kind: "info",
        title:
          "PR #2 merged automatically: every required reviewer approved and CI passed.",
        actions: [],
        pullRequest: { number: 2, url: merged.htmlUrl },
      }),
    ]);
    expect(current.waited()).toBe(0);
  });

  it("waits for CI to finish on the head, then merges", async () => {
    current = await setUp({
      policy: "auto_merge",
      ciLater: [{ name: "test", conclusion: "success" }],
    });
    await current.approved(1);
    // Lint has passed; the tests are still running.
    current.fake.finishCI(repository, branch, { name: "lint" });
    current.fake.startCI(repository, branch, { name: "test" });

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(true);
    expect(current.waited()).toBe(30_000);
  });

  it("looks at CI again at once when a webhook says it changed (FR-8)", async () => {
    const napping: AbortSignal[] = [];
    current = await setUp({
      policy: "auto_merge",
      // Waits for as long as it is let: a poll that never comes.
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          napping.push(signal);
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
    });
    const setup = current;
    await setup.approved(1);
    setup.fake.startCI(repository, branch, { name: "test" });

    const outcome = setup.run();
    await expect.poll(() => napping.length).toBe(1);
    // CI on another Floor's repository wakes nothing here.
    setup.flow.ciChanged("blog");
    expect(napping[0]?.aborted).toBe(false);

    setup.fake.finishCI(repository, branch, { name: "test" });
    setup.flow.ciChanged("web-shop");
    expect(await outcome).toBe("finished");
    expect((await pullRequest(setup)).merged).toBe(true);
    expect(napping).toHaveLength(1);
  });

  it("holds back a pull request a required reviewer has not approved", async () => {
    current = await setUp({ policy: "auto_merge" });
    // Quinta became a required reviewer after Grace's approval.
    await current.stores.reviews.recordVerdict({
      floorId: "web-shop",
      issue: 1,
      pullRequest: 2,
      round: 1,
      agentId: current.reviewers[0]?.id ?? "",
      headSha: (await pullRequest(current)).head.sha,
      verdict: { verdict: "approve", summary: "Fine.", comments: [] },
      reviewUrl: `https://github.com/${repository}/pull/2#review`,
      createdAt: new Date(),
    });
    current.fake.finishCI(repository, branch);
    await heldBackFor(current, "Quinta has not approved it");
  });

  it("holds back a pull request with blocking comments left", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    await current.stores.reviews.recordVerdict({
      floorId: "web-shop",
      issue: 1,
      pullRequest: 2,
      round: 1,
      agentId: "quinta",
      headSha: (await pullRequest(current)).head.sha,
      verdict: {
        verdict: "changes_requested",
        summary: "Not yet.",
        comments: [
          {
            severity: "blocking",
            path: "src/basket.ts",
            line: 1,
            body: "Keep both skus.",
          },
        ],
      },
      reviewUrl: `https://github.com/${repository}/pull/2#review-quinta`,
      createdAt: new Date(),
    });
    current.fake.finishCI(repository, branch);
    await heldBackFor(
      current,
      "Quinta has not approved it; and 1 blocking comment from round 1 remains",
    );
  });

  it("holds back a pull request whose CI failed, linking the failed run", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    current.fake.finishCI(repository, branch, { name: "lint" });
    const failed = current.fake.finishCI(repository, branch, {
      name: "test",
      conclusion: "failure",
    });
    await heldBackFor(current, 'CI check "test" failed');
    expect((await current.openNotices())[0]?.ciRunUrl).toBe(failed.htmlUrl);
    // It did not wait: a failure is final.
    expect(current.waited()).toBe(0);
  });

  it("holds back a pull request whose CI never finishes, after half an hour", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    current.fake.startCI(repository, branch, { name: "test" });
    await heldBackFor(current, 'CI had not finished after 30 minutes ("test")');
    expect(current.waited()).toBe(30 * 60_000);
  });

  it("holds back a pull request a required check never ran on", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    current.fake.requireChecks(repository, "main", ["test", "e2e"]);
    current.fake.finishCI(repository, branch, { name: "test" });
    await heldBackFor(current, 'the required check "e2e" never ran');
  });

  it("holds back a pull request no CI ran on, after waiting for one to start", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    await heldBackFor(current, "no CI check ran on it");
    expect(current.waited()).toBe(5 * 60_000);
  });

  it("holds back a pull request past the Round Cap", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    await current.approved(2);
    // The Owner lowered the Round Cap since.
    await current.stores.floors.update("web-shop", { roundCap: 1 });
    current.fake.finishCI(repository, branch);
    await heldBackFor(
      current,
      "its Review Loop ran 2 rounds, past the Round Cap of 1",
    );
  });

  it("holds back a pull request whose work reached a Token Cap", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    await current.bus.publish({
      type: "cap.reached",
      version: 1,
      level: "agent",
      period: "daily",
      floorId: "web-shop",
      agentId: current.coder.id,
      issue: 1,
      used: 1_000,
      cap: 1_000,
    });
    // Another issue's cap is not this one's.
    await current.bus.publish({
      type: "cap.reached",
      version: 1,
      level: "agent",
      period: "monthly",
      floorId: "web-shop",
      agentId: current.coder.id,
      issue: 9,
      used: 1_000,
      cap: 1_000,
    });
    current.fake.finishCI(repository, branch);
    await heldBackFor(
      current,
      `${current.coder.name} reached a daily Token Cap working on it`,
    );
  });

  it("names every condition that failed, and does not wait for CI when another did", async () => {
    current = await setUp({ policy: "auto_merge" });
    current.fake.startCI(repository, branch, { name: "test" });
    current.fake.finishCI(repository, branch, {
      name: "lint",
      conclusion: "failure",
    });
    await heldBackFor(
      current,
      `${current.reviewers[0]?.name ?? ""} and Quinta have not approved it; and CI check "lint" failed`,
    );
    expect(current.waited()).toBe(0);
  });

  it("sends the pull request to the Owner when GitHub refuses the merge", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    current.fake.finishCI(repository, branch);
    // Someone pushes as CI is looked at: the merge is of the head checked.
    const client = current.fake.repository(repository);
    const merge = client.mergePullRequest.bind(client);
    client.mergePullRequest = async (number, options) => {
      current?.fake.pushCommit(repository, branch, {
        files: { "src/basket.ts": "// changed\n" },
      });
      return merge(number, options);
    };
    const repositoryOf = current.fake.repository.bind(current.fake);
    current.fake.repository = (name) =>
      name === repository ? client : repositoryOf(name);
    await heldBackFor(
      current,
      "its head commit changed as it was being merged",
    );
  });
});

describe("send to me", () => {
  it("raises an action Notice linking the pull request, its issue, its CI run and each round, once", async () => {
    current = await setUp();
    await current.approved(1);
    const run = current.fake.finishCI(repository, branch, { name: "test" });

    expect(await current.run()).toBe("finished");
    const merged = await pullRequest(current);
    expect(merged.merged).toBe(false);
    expect(await current.openNotices()).toEqual([
      expect.objectContaining({
        kind: "action",
        title: "PR #2 awaiting your approval",
        floorId: "web-shop",
        issue: { number: 1, url: `https://github.com/${repository}/issues/1` },
        pullRequest: { number: 2, url: merged.htmlUrl },
        ciRunUrl: run.htmlUrl,
        links: [
          {
            label: "Review round 1",
            url: `https://github.com/${repository}/pull/2#review-${current.reviewers[0]?.id ?? ""}-1`,
          },
        ],
        // For the head it was raised for, and no other (W1-6).
        actions: [
          {
            id: mergeActions.approveAndMerge,
            label: "Approve and merge",
            sha: merged.head.sha,
          },
        ],
      }),
    ]);
    // Run again (after a restart, say): no second Notice.
    expect(await current.run()).toBe("finished");
    expect(await current.openNotices()).toHaveLength(1);
    expect(current.waited()).toBe(0);
  });

  it("merges the pull request when the Owner approves it from the Notice", async () => {
    current = await setUp();
    await current.approved(1);
    await current.run();
    const [notice] = await current.openNotices();

    await current.notices.act(notice?.id ?? "", mergeActions.approveAndMerge);
    const merged = await pullRequest(current);
    expect(merged).toMatchObject({ merged: true, state: "closed" });
    // The issue it closes is closed by the merge.
    expect((await current.fake.repository(repository).getIssue(1)).state).toBe(
      "closed",
    );
    expect(await merges(current)).toEqual([
      expect.objectContaining({ pullRequest: 2, by: "owner" }),
    ]);
    expect(await current.notices.get(notice?.id ?? "")).toMatchObject({
      actedOn: mergeActions.approveAndMerge,
    });
    expect(await current.openNotices()).toEqual([
      expect.objectContaining({
        kind: "info",
        title: "PR #2 merged, as you approved it.",
      }),
    ]);
  });

  it("keeps the Notice, saying why, when the pull request cannot be merged", async () => {
    current = await setUp();
    await current.approved(1);
    await current.run();
    const [notice] = await current.openNotices();
    // Closed on GitHub without merging.
    const client = current.fake.repository(repository);
    const getPullRequest = client.getPullRequest.bind(client);
    client.getPullRequest = async (number) => ({
      ...(await getPullRequest(number)),
      state: "closed",
    });
    current.fake.repository = () => client;

    await expect(
      current.notices.act(notice?.id ?? "", mergeActions.approveAndMerge),
    ).rejects.toThrow("PR #2 was closed without being merged.");
    expect((await current.notices.get(notice?.id ?? "")).actedAt).toBeNull();
    expect(await merges(current)).toEqual([]);
  });

  it("closes the Notice without merging again when the Owner merged on GitHub", async () => {
    current = await setUp();
    await current.approved(1);
    await current.run();
    const [notice] = await current.openNotices();
    await current.fake
      .repository(repository)
      .mergePullRequest(2, { method: "merge" });

    await current.notices.act(notice?.id ?? "", mergeActions.approveAndMerge);
    expect(await merges(current)).toEqual([]);
    expect(await current.openNotices()).toEqual([]);
  });
});

describe("labels override the Floor's Merge Policy", () => {
  it("sends the pull request to the Owner with ai-office:manual on an auto-merge Floor", async () => {
    current = await setUp({
      policy: "auto_merge",
      labels: [{ name: "ai-office:manual", actor: "someone-else" }],
    });
    await current.approved(1);
    current.fake.finishCI(repository, branch);

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(false);
    expect((await current.openNotices()).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval (ai-office:manual)",
    ]);
  });

  it("merges automatically with the Owner's ai-office:auto-merge on a send-to-me Floor", async () => {
    current = await setUp({ labels: [{ name: "ai-office:auto-merge" }] });
    await current.approved(1);
    current.fake.finishCI(repository, branch);

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(true);
    expect(await merges(current)).toEqual([
      expect.objectContaining({ by: "app" }),
    ]);
  });

  it("still applies the gate to a pull request labelled ai-office:auto-merge", async () => {
    current = await setUp({ labels: [{ name: "ai-office:auto-merge" }] });
    await current.approved(1);
    current.fake.finishCI(repository, branch, { conclusion: "failure" });
    await heldBackFor(current, 'CI check "CI" failed');
  });

  it("follows ai-office:auto-merge only when the Owner added it", async () => {
    current = await setUp({
      labels: [{ name: "ai-office:auto-merge", actor: "someone-else" }],
    });
    await current.approved(1);
    current.fake.finishCI(repository, branch);
    await heldBackFor(
      current,
      "the ai-office:auto-merge label was not added by you",
    );
  });

  it("sends the pull request to the Owner when it has both labels", async () => {
    current = await setUp({
      labels: [{ name: "ai-office:auto-merge" }, { name: "ai-office:manual" }],
    });
    await current.approved(1);
    current.fake.finishCI(repository, branch);

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(false);
    expect((await current.openNotices()).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval (ai-office:manual)",
    ]);
  });
});

// The Owner's decision on P2-3 (#199): a chat request still starts its
// Batch at once (ADR 0004), but what it builds is never merged by policy.
describe("a chat request's issues always go to the Owner (P2-3)", () => {
  it("are not merged automatically on an auto-merge Floor, the Notice saying why", async () => {
    current = await setUp({ policy: "auto_merge", batch: "chat" });
    await current.approved(1);
    current.fake.finishCI(repository, branch);
    await heldBackFor(current, chatIssueReason);
  });

  it("are sent to the Owner as any other on a send-to-me Floor", async () => {
    current = await setUp({ batch: "chat" });
    await current.approved(1);
    current.fake.finishCI(repository, branch);

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(false);
    expect((await current.openNotices()).map(({ title }) => title)).toEqual([
      "PR #2 awaiting your approval",
    ]);
  });

  it("are merged automatically once the Owner adds ai-office:auto-merge", async () => {
    current = await setUp({
      batch: "chat",
      labels: [{ name: "ai-office:auto-merge" }],
    });
    await current.approved(1);
    current.fake.finishCI(repository, branch);

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(true);
  });

  it("are not merged on an ai-office:auto-merge label someone else added", async () => {
    current = await setUp({
      policy: "auto_merge",
      batch: "chat",
      labels: [{ name: "ai-office:auto-merge", actor: "someone-else" }],
    });
    await current.approved(1);
    current.fake.finishCI(repository, branch);
    await heldBackFor(
      current,
      `the ai-office:auto-merge label was not added by you; and ${chatIssueReason}`,
    );
  });

  it("leaves a Batch handed over by command to the Floor's policy", async () => {
    current = await setUp({ policy: "auto_merge", batch: "command" });
    await current.approved(1);
    current.fake.finishCI(repository, branch);

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(true);
  });
});

describe("the work at ready-to-merge", () => {
  it("does nothing for an issue that is no longer ready to merge", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    current.fake.finishCI(repository, branch);
    current.fake.removeLabel(repository, 1, "ready-to-merge");
    current.fake.setLabel(repository, 1, "needs-human");

    expect(await current.run()).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(false);
    expect(await current.openNotices()).toEqual([]);
  });

  it("does nothing for a pull request merged already", async () => {
    current = await setUp({ policy: "auto_merge" });
    await current.approved(1);
    await current.fake
      .repository(repository)
      .mergePullRequest(2, { method: "merge" });

    expect(await current.run()).toBe("finished");
    expect(await current.openNotices()).toEqual([]);
  });
});
