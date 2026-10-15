import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { mergeActions, type MergePolicy } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { BatchBranch } from "../batches/one-pull-request.ts";
import { createFloors } from "../floors/floors.ts";
import { memoryIntakeQueue } from "../intake/intake.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import type { VerdictRecord } from "../review/store.ts";
import { memoryStores } from "../stores.ts";
import type { WorkItem } from "../work/store.ts";
import { createMergeFlow, type MergeFlow } from "./merge.ts";

// The Merge Policy for a Batch handed over "in one PR" (PRD FR-25a; ADR
// 0010), against the fake GitHub: its one pull request is considered only
// once every issue is ready to merge, an issue with the Owner holds the
// whole of it, the gate judges each issue's own work, and a merge records
// each issue's.

const repository = "adrianeyre/web-shop";
const branch = "ai-office/batch-7";

interface Setup {
  readonly fake: FakeGitHub;
  readonly notices: Notices;
  readonly flow: MergeFlow;
  readonly queued: ReturnType<typeof memoryIntakeQueue>["items"];
  /** The commits each issue's work ended at on the branch. */
  readonly first: string;
  readonly head: string;
  /** Runs the work at ready-to-merge for an issue. */
  run(issue: number): Promise<string>;
  /** Moves an issue to `stage`. */
  stage(issue: number, stage: string): void;
  /** Both reviewers approve the issue's round 1, at `sha`. */
  approved(issue: number, sha: string): Promise<void>;
  merged(): Promise<number[]>;
}

let current: Setup | undefined;

afterEach(() => {
  current?.flow.stop();
  current = undefined;
});

const setUp = async (policy: MergePolicy): Promise<Setup> => {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github: fake, events: bus }).add(
    repository,
  );
  const team = await stores.agents.list("web-shop");
  const grace = team.find(({ role }) => role === "reviewer");
  if (grace === undefined) {
    throw new Error("A new Floor has a reviewer.");
  }
  await stores.floors.update("web-shop", {
    requiredReviewerAgentIds: [grace.id],
    mergePolicy: policy,
  });
  // Issues #1 and #2, worked in turn on the Batch's branch: #1's work,
  // then #2's, in one pull request (#3).
  fake.createIssue(repository, {
    title: "Add a basket",
    body: "",
    labels: ["ai-office", "ready-to-merge"],
  });
  fake.createIssue(repository, {
    title: "Show the total",
    body: "",
    labels: ["ai-office", "needs-review"],
  });
  const first = fake.pushCommit(repository, branch, {
    files: { "src/basket.ts": "export const basket = [];\n" },
  });
  const head = fake.pushCommit(repository, branch, {
    files: { "src/total.ts": "export const total = 0;\n" },
  });
  await fake.repository(repository).createPullRequest({
    title: "Batch 7: #1 and #2",
    body: "Closes #1",
    head: branch,
    base: "main",
  });
  const batch: BatchBranch = {
    batchId: 7,
    branch,
    issues: [
      { issue: 1, title: "Add a basket", started: true, base: null },
      { issue: 2, title: "Show the total", started: true, base: first },
    ],
  };
  const notices = createNotices({ store: stores.notices, events: bus });
  const queue = memoryIntakeQueue();
  const flow = createMergeFlow({
    floors: stores.floors,
    agents: stores.agents,
    github: fake,
    notices,
    events: bus,
    reviews: stores.reviews,
    batches: stores.batches,
    batchBranches: {
      of: (_floorId, issue) => Promise.resolve(issue <= 2 ? batch : undefined),
    },
    queue,
    ownerLogin: () => Promise.resolve("adrianeyre"),
    sleep: () => Promise.resolve(),
  });
  const work = (issue: number): WorkItem => ({
    id: issue,
    floorId: "web-shop",
    issue,
    stage: "ready-to-merge",
    agentId: null,
    status: "running",
    priority: "normal",
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  });
  return {
    fake,
    notices,
    flow,
    queued: queue.items,
    first,
    head,
    run: (issue) => flow.execute(work(issue), new AbortController().signal),
    stage(issue, stage) {
      for (const label of ["needs-review", "ready-to-merge", "needs-human"]) {
        fake.removeLabel(repository, issue, label);
      }
      fake.setLabel(repository, issue, stage);
    },
    async approved(issue, sha) {
      const verdict: VerdictRecord = {
        floorId: "web-shop",
        issue,
        pullRequest: 3,
        round: 1,
        agentId: grace.id,
        headSha: sha,
        verdict: { verdict: "approve", summary: "Good.", comments: [] },
        reviewUrl: `https://github.com/${repository}/pull/3#review-${String(issue)}`,
        createdAt: new Date(),
      };
      await stores.reviews.recordVerdict(verdict);
    },
    merged: async () =>
      (await bus.eventsAfter(0)).flatMap(({ event }) =>
        event.type === "pull_request.merged" ? [event.issue] : [],
      ),
  };
};

const pullRequest = (setup: Setup) =>
  setup.fake.repository(repository).getPullRequest(3);

describe("a Batch's one pull request at the Merge Policy", () => {
  it("waits while any issue of the Batch is still on its way", async () => {
    current = await setUp("auto_merge");
    await current.approved(1, current.first);
    expect(await current.run(1)).toBe("finished");
    expect(await current.notices.open()).toEqual([]);
    expect(await pullRequest(current)).toMatchObject({
      state: "open",
      merged: false,
      body: "Closes #1",
    });
    expect(await current.merged()).toEqual([]);
  });

  it("holds the whole pull request while one issue is handed to the Owner, saying so once", async () => {
    current = await setUp("auto_merge");
    current.stage(2, "needs-human");
    expect(await current.run(1)).toBe("finished");
    expect(await current.run(1)).toBe("finished");
    expect(await current.notices.open()).toEqual([
      expect.objectContaining({
        kind: "action",
        title:
          "Batch 7's pull request is held: #2 is handed to you, and its issues merge together.",
        issue: {
          number: 2,
          url: "https://github.com/adrianeyre/web-shop/issues/2",
        },
      }),
    ]);
    expect((await pullRequest(current)).merged).toBe(false);
  });

  it("auto-merge: once every issue is ready, judges each issue's own work, merges once and records each issue's merge", async () => {
    current = await setUp("auto_merge");
    // #1's reviewer approved its work as it ended, before #2's began.
    await current.approved(1, current.first);
    await current.approved(2, current.head);
    current.stage(2, "ready-to-merge");
    current.fake.finishCI(repository, branch, { name: "test" });
    expect(await current.run(2)).toBe("finished");
    const merged = await pullRequest(current);
    expect(merged.merged).toBe(true);
    // Written again before the merge, closing both, in the `pr` shape.
    expect(merged.body).toContain("## Summary");
    expect(merged.body).toContain("Closes #1\nCloses #2");
    expect(merged.body).toContain("## Evidence");
    expect(merged.body).toContain("**Door:** two-way");
    expect(await current.merged()).toEqual([1, 2]);
    for (const issue of [1, 2]) {
      expect(
        (await current.fake.repository(repository).getIssue(issue)).state,
      ).toBe("closed");
    }
  });

  it("sends an issue back to its reviewers when commits were pushed on it after they approved", async () => {
    current = await setUp("auto_merge");
    // #1's reviewer approved an earlier commit than where its work ended.
    await current.approved(1, "f".repeat(40));
    await current.approved(2, current.head);
    current.stage(2, "ready-to-merge");
    current.fake.finishCI(repository, branch, { name: "test" });
    expect(await current.run(2)).toBe("finished");
    expect((await pullRequest(current)).merged).toBe(false);
    expect(
      (await current.fake.repository(repository).getIssue(1)).labels,
    ).toContain("needs-review");
    expect(current.queued).toEqual([
      { floorId: "web-shop", issue: 1, stage: "needs-review" },
    ]);
  });

  it("send to me: one Notice for the pull request, whose Approve and merge merges only while every issue is ready", async () => {
    current = await setUp("send_to_me");
    current.stage(2, "ready-to-merge");
    expect(await current.run(2)).toBe("finished");
    const [notice] = await current.notices.open();
    expect(notice).toMatchObject({
      kind: "action",
      title: "PR #3 awaiting your approval",
      pullRequest: { number: 3 },
    });
    // #1 goes back to review meanwhile: nothing is merged.
    current.stage(1, "needs-review");
    await expect(
      current.notices.act(notice?.id ?? "", mergeActions.approveAndMerge),
    ).rejects.toThrow("Nothing was merged: #1 has left ready-to-merge");
    expect((await pullRequest(current)).merged).toBe(false);

    current.stage(1, "ready-to-merge");
    expect(await current.run(1)).toBe("finished");
    const [again] = await current.notices.open();
    await current.notices.act(again?.id ?? "", mergeActions.approveAndMerge);
    expect((await pullRequest(current)).merged).toBe(true);
    expect(await current.merged()).toEqual([1, 2]);
  });
});
