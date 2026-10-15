import { createEventBus, memoryEventStore } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { mergeActions, type MergePolicy } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { issueBranch } from "../sandbox/branch.ts";
import { memoryStores } from "../stores.ts";
import type { WorkItem } from "../work/store.ts";
import { createMergeFlow, type MergeFlow } from "./merge.ts";

// Probe W1 (docs/pen-testing/assessments/W1.md), "The App's write path:
// can anything an Agent controls choose the branch, repository or ref the
// App pushes or merges?" On a "send to me" Floor (FR-29, the default) the
// Merge Policy raises "PR #N awaiting your approval", and the Owner's
// "Approve and merge" has the App merge it. The real flow and Notices run
// against the fake GitHub, which, like GitHub, refuses a merge whose
// expected head is not the pull request's head.
//
// - Holds: auto-merge passes GitHub the head CI passed on, so a later
//   push is refused rather than merged.
// - W1-6 (new), fixed: "Approve and merge" named no head. The App merged
//   whatever the branch held when the Owner clicked, which was not what
//   the Notice was raised for, nor what the Owner read, if anything was
//   pushed to the branch since: such as an Agent's later work, pushed by
//   the App. Now the Notice names its head and only that head is merged:
//   a newer one is asked about in a new Notice.

const repository = "adrianeyre/web-shop";
const title = "Add a basket";
const branch = issueBranch(1, title);

interface Setup {
  readonly fake: FakeGitHub;
  readonly stores: ReturnType<typeof memoryStores>;
  readonly notices: Notices;
  readonly flow: MergeFlow;
  /** The head the Notice was raised for. */
  readonly shown: string;
  /** What `basket.ts` says on main. */
  basketOnMain(): Promise<string | undefined>;
}

let current: Setup | undefined;

afterEach(() => {
  current?.flow.stop();
  current = undefined;
});

/**
 * Issue #1 at ready-to-merge, its Merge Policy run: on a send-to-me Floor
 * its Notice is raised. With `pushBeforeMerge`, work lands on the branch
 * just as the App merges.
 */
async function setUp(
  options: {
    readonly policy?: MergePolicy;
    readonly pushBeforeMerge?: boolean;
  } = {},
): Promise<Setup> {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github: fake, events: bus }).add(
    repository,
  );
  fake.createIssue(repository, {
    title,
    labels: ["ai-office", "ready-to-merge"],
  });
  const shown = fake.pushCommit(repository, branch, {
    files: { "basket.ts": "export const basket = [];\n" },
  });
  await fake.repository(repository).createPullRequest({
    title,
    body: "Closes #1",
    head: branch,
    base: "main",
  });
  fake.finishCI(repository, branch, { name: "CI" });
  if (options.policy === "auto_merge") {
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
    await stores.reviews.recordVerdict({
      floorId: "web-shop",
      issue: 1,
      pullRequest: 2,
      round: 1,
      agentId: reviewer.id,
      headSha: shown,
      verdict: { verdict: "approve", summary: "Looks right.", comments: [] },
      reviewUrl: `https://github.com/${repository}/pull/2#review-1`,
      createdAt: new Date(),
    });
  }
  const github: GitHubApp = {
    ...fake,
    repository(fullName) {
      const client = fake.repository(fullName);
      return {
        ...client,
        mergePullRequest: (number, merge) => {
          if (options.pushBeforeMerge === true) {
            pushLater(fake);
          }
          return client.mergePullRequest(number, merge);
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
    sleep: () => Promise.resolve(),
  });
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
  expect(await flow.execute(work, new AbortController().signal)).toBe(
    "finished",
  );
  current = {
    fake,
    stores,
    notices,
    flow,
    shown,
    basketOnMain: () =>
      fake.repository(repository).getFileContent("basket.ts", "main"),
  };
  return current;
}

/** The Owner clicks "Approve and merge" on the Floor's Notice. */
async function approveAndMerge(notices: Notices): Promise<void> {
  const [notice] = await notices.open({ floorId: "web-shop" });
  expect(notice?.title).toBe("PR #2 awaiting your approval");
  await notices.act(notice?.id ?? "", mergeActions.approveAndMerge);
}

/** The Floor's open Notices, oldest first. */
const openNotices = async (notices: Notices) =>
  (await notices.open({ floorId: "web-shop" })).reverse();

/** Work pushed to the branch after the Notice was raised. */
const pushLater = (fake: FakeGitHub): string =>
  fake.pushCommit(repository, branch, {
    files: {
      "basket.ts":
        "export const basket = [];\nfetch('https://evil.example');\n",
    },
  });

describe("what auto-merge merges", () => {
  it("holds: the App names the head CI passed on, so work pushed as it merges is refused, not merged, and goes to the Owner", async () => {
    const setup = await setUp({
      policy: "auto_merge",
      pushBeforeMerge: true,
    });
    expect(await setup.basketOnMain()).toBeUndefined();
    const [notice] = await setup.notices.open({ floorId: "web-shop" });
    expect(notice?.title).toContain("PR #2 awaiting your approval");
  });
});

describe("W1-6: what 'Approve and merge' merges", () => {
  it("merges the head the Notice was raised for, when nothing has moved", async () => {
    const setup = await setUp();
    await approveAndMerge(setup.notices);
    expect(await setup.basketOnMain()).toBe("export const basket = [];\n");
  });

  it("merges only the head the Notice was raised for: a head pushed since is not merged on that approval", async () => {
    const setup = await setUp();
    pushLater(setup.fake);
    await approveAndMerge(setup.notices).catch(() => undefined);
    // Nothing merged leaves no basket.ts on main at all.
    expect((await setup.basketOnMain()) ?? "").not.toContain("evil.example");
  });

  it("regression (W1-6): the App no longer merges whatever the branch holds when the Owner clicks: a head pushed after the Notice is not merged, and a new Notice asks about it", async () => {
    const setup = await setUp();
    const later = pushLater(setup.fake);
    expect(later).not.toBe(setup.shown);
    const [asked] = await openNotices(setup.notices);
    await expect(approveAndMerge(setup.notices)).rejects.toThrow(
      `The action was not taken, and the Notice is closed: Nothing was merged: PR #2's branch has moved on to ${later.slice(0, 7)} since you were asked about ${setup.shown.slice(0, 7)}. A new Notice asks you about its head.`,
    );
    expect(await setup.basketOnMain()).toBeUndefined();
    expect(
      (await setup.fake.repository(repository).getPullRequest(2)).merged,
    ).toBe(false);
    // The old Notice is closed, unmerged; the new one is for the new head.
    expect(await setup.notices.get(asked?.id ?? "")).toMatchObject({
      actedAt: null,
      dismissedAt: expect.any(Date) as Date,
    });
    const [again, ...others] = await openNotices(setup.notices);
    expect(others).toEqual([]);
    expect(again).toMatchObject({
      kind: "action",
      title: `PR #2 awaiting your approval: its branch moved on to ${later.slice(0, 7)} since you were last asked.`,
      pullRequest: { number: 2 },
      issue: { number: 1 },
      actions: [
        {
          id: mergeActions.approveAndMerge,
          label: "Approve and merge",
          sha: later,
        },
      ],
    });
    // Approving that one merges the head it names.
    await setup.notices.act(again?.id ?? "", mergeActions.approveAndMerge);
    expect(await setup.basketOnMain()).toContain("evil.example");
  });

  it("W1-6: a head pushed as the App merges is refused by GitHub, not merged, and asked about", async () => {
    const setup = await setUp({ pushBeforeMerge: true });
    await expect(approveAndMerge(setup.notices)).rejects.toThrow(
      "Nothing was merged",
    );
    expect(await setup.basketOnMain()).toBeUndefined();
    const [again, ...others] = await openNotices(setup.notices);
    expect(others).toEqual([]);
    expect(again?.title).toContain("its branch moved on to");
  });

  it("W1-6: a Notice whose issue has left ready-to-merge offers no merge, and is closed", async () => {
    const setup = await setUp();
    // The issue went round again, its Notice left open.
    setup.fake.removeLabel(repository, 1, "ready-to-merge");
    setup.fake.setLabel(repository, 1, "needs-review");
    const [asked] = await openNotices(setup.notices);
    await expect(approveAndMerge(setup.notices)).rejects.toThrow(
      "Nothing was merged: #1 has left ready-to-merge (it is at needs-review) since you were asked",
    );
    expect(await setup.basketOnMain()).toBeUndefined();
    expect(await setup.notices.get(asked?.id ?? "")).toMatchObject({
      dismissedAt: expect.any(Date) as Date,
    });
    expect(await openNotices(setup.notices)).toEqual([]);
  });

  it("W1-6: sent to the Owner again for a new head, the Notice for the old head is closed and one asks about the new head", async () => {
    const setup = await setUp();
    const [old] = await openNotices(setup.notices);
    const later = pushLater(setup.fake);
    setup.fake.finishCI(repository, branch, { name: "CI" });
    expect(
      await setup.flow.execute(
        {
          id: 2,
          floorId: "web-shop",
          issue: 1,
          stage: "ready-to-merge",
          agentId: null,
          status: "running",
          priority: "normal",
          createdAt: new Date(),
          startedAt: new Date(),
          finishedAt: null,
        },
        new AbortController().signal,
      ),
    ).toBe("finished");
    expect(await setup.notices.get(old?.id ?? "")).toMatchObject({
      dismissedAt: expect.any(Date) as Date,
    });
    const [now, ...others] = await openNotices(setup.notices);
    expect(others).toEqual([]);
    expect(now?.actions).toEqual([
      {
        id: mergeActions.approveAndMerge,
        label: "Approve and merge",
        sha: later,
      },
    ]);
  });

  it("W1-6: a Notice raised before it named its head merges nothing, and asks about the head there is", async () => {
    const setup = await setUp();
    const [raised] = await openNotices(setup.notices);
    await setup.notices.dismiss(raised?.id ?? "");
    await setup.notices.raise({
      kind: "action",
      title: "PR #2 awaiting your approval",
      floorId: "web-shop",
      issue: { number: 1, url: `https://github.com/${repository}/issues/1` },
      pullRequest: {
        number: 2,
        url: `https://github.com/${repository}/pull/2`,
      },
      actions: [
        { id: mergeActions.approveAndMerge, label: "Approve and merge" },
      ],
    });
    await expect(approveAndMerge(setup.notices)).rejects.toThrow(
      "since you were asked. A new Notice asks you about its head.",
    );
    expect(await setup.basketOnMain()).toBeUndefined();
    const [again] = await openNotices(setup.notices);
    expect(again?.actions[0]?.sha).toBe(setup.shown);
  });
});
