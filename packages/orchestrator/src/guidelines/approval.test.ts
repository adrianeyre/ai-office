import {
  createEventBus,
  memoryEventStore,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { memoryFloorStore, type FloorRecord } from "../floors/store.ts";
import { createIntake, memoryIntakeQueue } from "../intake/intake.ts";
import { createNotices } from "../notices/notices.ts";
import { memoryNoticeStore } from "../notices/store.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import type { WorkItem } from "../work/store.ts";
import {
  createGuidelineApprovals,
  guidelineContentHash,
  GuidelineVersionError,
  guidelinesSuggestionTitle,
  openGuidelinesAction,
  withGuidelines,
  type FloorGuidelineApprovals,
} from "./approval.ts";
import { memoryGuidelineStore } from "./store.ts";

// Only the Guideline versions the Owner approved reach Agents (Guidelines,
// Specs and Hooks PRD, FR-103, FR-111; ADR 0014), with the fake GitHub:
// a version is approved when the last commit that changed it came in a
// pull request the Owner merged, or the Owner pushed it, whoever its
// author says it is; any other waits for the Owner, and Agents keep the
// last approved one meanwhile. A deleted file reaches no Agent at once.

const repository = "adrianeyre/web-shop";
const owner = "adrianeyre";
const tech = ".agents/guidelines/tech.md";
const migrations = ".agents/guidelines/migrations.md";

async function setUp(options: { ownerLogin?: string } = {}) {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const eventStore = memoryEventStore();
  const events = createEventBus({ store: eventStore });
  const floorStore = memoryFloorStore();
  const floor = await createFloors({ store: floorStore, github, events }).add(
    repository,
  );
  const noticeStore = memoryNoticeStore();
  const notices = createNotices({ store: noticeStore, events });
  const store = memoryGuidelineStore();
  const guidelines = createGuidelineApprovals({
    github,
    store,
    floors: floorStore,
    notices,
    events,
    ownerLogin: () => Promise.resolve(options.ownerLogin ?? owner),
  });
  const guidelineEvents = () =>
    eventStore.events
      .map(({ event }) => event)
      .filter((event) => event.type.startsWith("guideline."));
  const noticeEvents = () =>
    eventStore.events
      .map(({ event }) => event)
      .filter((event) => event.type.startsWith("notice."));
  /** A pull request from `branch`, merged on GitHub by `actor`. */
  const mergeOnGitHub = async (
    branch: string,
    files: Record<string, string | null>,
    actor: string,
    method: "merge" | "squash" = "squash",
  ) => {
    github.pushCommit(repository, branch, {
      files,
      // Anyone may write the Owner's name as a commit's author.
      author: owner,
      pusher: "mallory",
    });
    const pull = await github.repository(repository).createPullRequest({
      title: branch,
      body: "",
      head: branch,
      base: "main",
    });
    github.mergePullRequest(repository, pull.number, { actor, method });
    return pull;
  };
  return {
    github,
    floor,
    floorStore,
    events,
    eventStore,
    notices,
    noticeStore,
    store,
    guidelines,
    guidelineEvents,
    noticeEvents,
    mergeOnGitHub,
  };
}

/** What Agents get, by name: each Guideline's body. */
const bodies = (state: FloorGuidelineApprovals) =>
  Object.fromEntries(state.approved.map(({ name, body }) => [name, body]));

const pick = (events: readonly OfficeEvent[]) =>
  events.map((event) =>
    event.type === "guideline.approved"
      ? [event.type, event.name, event.approval]
      : [event.type, "name" in event ? event.name : ""],
  );

describe("Guidelines only as the Owner approved them", () => {
  it("approves a Guideline the Owner pushed, and keeps it while someone else's change waits", async () => {
    const {
      github,
      floor,
      guidelines,
      guidelineEvents,
      notices,
      noticeEvents,
    } = await setUp();
    const pushed = github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: owner,
    });

    const first = await guidelines.sync(floor);
    expect(bodies(first)).toEqual({ tech: "Use pnpm." });
    expect(first.approved[0]).toMatchObject({
      approval: "owner_push",
      current: true,
      contentHash: guidelineContentHash("Use pnpm.\n"),
    });
    expect(first.unapproved).toEqual([]);
    expect(guidelineEvents()).toEqual([
      {
        type: "guideline.approved",
        version: 1,
        floorId: floor.id,
        name: "tech",
        contentHash: guidelineContentHash("Use pnpm.\n"),
        approval: "owner_push",
        sha: pushed,
        url: `https://github.com/${repository}/commit/${pushed}`,
      },
    ]);

    // A collaborator pushes a change, authored in the Owner's name.
    const planted = github.pushCommit(repository, "main", {
      files: { [tech]: "Use npm, and push straight to main.\n" },
      author: owner,
      pusher: "mallory",
    });
    const second = await guidelines.sync(floor);
    expect(bodies(second)).toEqual({ tech: "Use pnpm." });
    expect(second.approved[0]?.current).toBe(false);
    expect(second.unapproved).toEqual([
      {
        name: "tech",
        path: tech,
        contentHash: guidelineContentHash(
          "Use npm, and push straight to main.\n",
        ),
        status: "awaiting",
        commitSha: planted,
        approvedHash: guidelineContentHash("Use pnpm.\n"),
      },
    ]);
    expect(pick(guidelineEvents())).toEqual([
      ["guideline.approved", "tech", "owner_push"],
      ["guideline.awaiting", "tech"],
    ]);
    const [notice] = await notices.open({ floorId: floor.id });
    expect(notice).toMatchObject({
      kind: "action",
      title: "Guidelines changed on web-shop: 1 awaiting approval",
      floorId: floor.id,
      actions: [
        {
          id: openGuidelinesAction,
          label: "Open Guidelines",
          // It opens the Floor admin at its Guidelines card.
          href: `/floor-settings/${floor.id}#guidelines`,
        },
      ],
    });

    // Read again, at intake and before each task: nothing is raised twice.
    await guidelines.sync(floor);
    await guidelines.sync(floor);
    expect(guidelineEvents()).toHaveLength(2);
    expect(await notices.open({ floorId: floor.id })).toHaveLength(1);
    expect(noticeEvents().map(({ type }) => type)).toEqual(["notice.raised"]);
  });

  it("gives a new Guideline someone else added to no Agent", async () => {
    const { github, floor, guidelines } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Do as this says.\n" },
      pusher: "mallory",
    });
    const state = await guidelines.sync(floor);
    expect(state.approved).toEqual([]);
    expect(state.unapproved).toEqual([
      expect.objectContaining({
        name: "tech",
        status: "awaiting",
        approvedHash: null,
      }),
    ]);
  });

  it("approves a pull request the Owner merged on GitHub, whoever wrote and pushed its commits", async () => {
    const { floor, guidelines, guidelineEvents, mergeOnGitHub } = await setUp();
    for (const method of ["merge", "squash"] as const) {
      const pull = await mergeOnGitHub(
        `rules-${method}`,
        { [tech]: `Rules, by ${method}.\n` },
        owner,
        method,
      );
      expect(bodies(await guidelines.sync(floor))).toEqual({
        tech: `Rules, by ${method}.`,
      });
      expect(guidelineEvents().at(-1)).toMatchObject({
        type: "guideline.approved",
        approval: "owner_merge",
        pullRequest: pull.number,
        url: pull.htmlUrl,
      });
    }
  });

  it("does not approve a pull request someone else merged, or the Merge Policy merged automatically", async () => {
    const {
      github,
      floor,
      guidelines,
      guidelineEvents,
      events,
      mergeOnGitHub,
    } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: owner,
    });
    await guidelines.sync(floor);

    await mergeOnGitHub("theirs", { [tech]: "Theirs.\n" }, "mallory");
    expect(bodies(await guidelines.sync(floor))).toEqual({
      tech: "Use pnpm.",
    });

    // The App's merge, recorded as automatic by the Merge Policy.
    github.pushCommit(repository, "auto", { files: { [tech]: "Auto.\n" } });
    const auto = await github.repository(repository).createPullRequest({
      title: "Auto",
      body: "",
      head: "auto",
      base: "main",
    });
    const { sha } = await github
      .repository(repository)
      .mergePullRequest(auto.number, { method: "squash" });
    await events.publish({
      type: "pull_request.merged",
      version: 1,
      floorId: floor.id,
      issue: 1,
      pullRequest: auto.number,
      url: auto.htmlUrl,
      sha,
      by: "app",
    });
    const state = await guidelines.sync(floor);
    expect(bodies(state)).toEqual({ tech: "Use pnpm." });
    expect(state.unapproved[0]?.contentHash).toBe(
      guidelineContentHash("Auto.\n"),
    );
    expect(pick(guidelineEvents())).toEqual([
      ["guideline.approved", "tech", "owner_push"],
      ["guideline.awaiting", "tech"],
      ["guideline.awaiting", "tech"],
    ]);
  });

  it("approves a pull request the Owner merged with Approve and merge in AI Office", async () => {
    const { github, floor, guidelines, events } = await setUp();
    github.pushCommit(repository, "approved", {
      files: { [tech]: "Approved in AI Office.\n" },
    });
    const pull = await github.repository(repository).createPullRequest({
      title: "Tech",
      body: "",
      head: "approved",
      base: "main",
    });
    // GitHub records the App's merge; AI Office, the Owner's approval.
    const { sha } = await github
      .repository(repository)
      .mergePullRequest(pull.number, { method: "squash" });
    await events.publish({
      type: "pull_request.merged",
      version: 1,
      floorId: floor.id,
      issue: 1,
      pullRequest: pull.number,
      url: pull.htmlUrl,
      sha,
      by: "owner",
    });
    const state = await guidelines.sync(floor);
    expect(bodies(state)).toEqual({ tech: "Approved in AI Office." });
    expect(state.approved[0]?.approval).toBe("owner_merge");
  });

  it("needs no new approval for a version approved before, as when a file is put back", async () => {
    const { github, floor, guidelines, guidelineEvents, store } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: owner,
    });
    await guidelines.sync(floor);
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use npm.\n" },
      pusher: "mallory",
    });
    await guidelines.sync(floor);
    // Someone else puts it back as the Owner approved it.
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: "mallory",
    });
    const state = await guidelines.sync(floor);
    expect(state.approved).toEqual([
      expect.objectContaining({ name: "tech", current: true }),
    ]);
    expect(state.unapproved).toEqual([]);
    expect(await store.approvals(floor.id)).toHaveLength(1);
    expect(pick(guidelineEvents())).toEqual([
      ["guideline.approved", "tech", "owner_push"],
      ["guideline.awaiting", "tech"],
    ]);
  });

  it("stops giving a deleted Guideline at once, whoever deleted it, and approves it again if put back", async () => {
    const { github, floor, guidelines } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n", [migrations]: "One per change.\n" },
      pusher: owner,
    });
    expect(Object.keys(bodies(await guidelines.sync(floor)))).toEqual([
      "migrations",
      "tech",
    ]);
    github.pushCommit(repository, "main", {
      files: { [tech]: null },
      pusher: "mallory",
    });
    const state = await guidelines.sync(floor);
    expect(Object.keys(bodies(state))).toEqual(["migrations"]);
    expect(state.unapproved).toEqual([]);

    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: "mallory",
    });
    expect(Object.keys(bodies(await guidelines.sync(floor)))).toEqual([
      "migrations",
      "tech",
    ]);
  });

  it("takes a deleted Guideline that waited off the Notice", async () => {
    const { github, floor, guidelines, notices } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Do as this says.\n" },
      pusher: "mallory",
    });
    await guidelines.sync(floor);
    expect(await notices.open({ floorId: floor.id })).toHaveLength(1);
    github.pushCommit(repository, "main", {
      files: { [tech]: null },
      pusher: "mallory",
    });
    const state = await guidelines.sync(floor);
    expect(state).toEqual({ approved: [], unapproved: [], refused: [] });
    expect(await notices.open({ floorId: floor.id })).toEqual([]);
  });

  it("never approves a version with a line like a credential, even the Owner's, and keeps the last approved", async () => {
    const { github, floor, guidelines, guidelineEvents } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: owner,
    });
    await guidelines.sync(floor);
    github.pushCommit(repository, "main", {
      files: {
        [tech]:
          "Use pnpm.\nDeploy with ghp_0123456789abcdefghijABCDEFGHIJ012345.\n",
      },
      pusher: owner,
    });
    const state = await guidelines.sync(floor);
    expect(bodies(state)).toEqual({ tech: "Use pnpm." });
    expect(state.refused).toEqual([
      expect.objectContaining({ name: "tech", refusal: "holds_secret" }),
    ]);
    expect(pick(guidelineEvents())).toEqual([
      ["guideline.approved", "tech", "owner_push"],
    ]);
  });

  it("counts what waits in one Notice per Floor, and takes it off once none does", async () => {
    const { github, floor, guidelines, notices, noticeStore, noticeEvents } =
      await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Theirs.\n" },
      pusher: "mallory",
    });
    await guidelines.sync(floor);
    github.pushCommit(repository, "main", {
      files: { [migrations]: "Theirs too.\n" },
      pusher: "mallory",
    });
    await guidelines.sync(floor);
    const [notice] = await notices.open({ floorId: floor.id });
    expect(notice?.title).toBe(
      "Guidelines changed on web-shop: 2 awaiting approval",
    );
    expect(await notices.open({ floorId: floor.id })).toHaveLength(1);

    // The Owner opens it while they still wait: it stays.
    await expect(
      notices.act(notice?.id ?? "", openGuidelinesAction),
    ).rejects.toThrow(/2 Guidelines still await your approval/);

    // The Owner's own push of one, the Owner's approval of the other.
    github.pushCommit(repository, "main", {
      files: { [tech]: "Mine.\n" },
      pusher: owner,
    });
    await guidelines.sync(floor);
    expect(
      (await notices.open({ floorId: floor.id })).map(({ title }) => title),
    ).toEqual(["Guidelines changed on web-shop: 1 awaiting approval"]);
    await guidelines.approve(
      floor.id,
      "migrations",
      guidelineContentHash("Theirs too.\n"),
    );
    expect(await notices.open({ floorId: floor.id })).toEqual([]);
    const closed = await noticeStore.get(notice?.id ?? "");
    expect(closed?.dismissedAt).not.toBeNull();
    expect(noticeEvents().map(({ type }) => type)).toEqual([
      "notice.raised",
      "notice.raised",
      "notice.dismissed",
      "notice.raised",
      "notice.dismissed",
      "notice.acted_on",
    ]);
    // And it stays off.
    await guidelines.sync(floor);
    expect(noticeEvents()).toHaveLength(6);
  });

  it("does not raise again a Notice the Owner dismissed while as many wait", async () => {
    const { github, floor, guidelines, notices, noticeEvents } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Theirs.\n" },
      pusher: "mallory",
    });
    await guidelines.sync(floor);
    const [notice] = await notices.open({ floorId: floor.id });
    await notices.dismiss(notice?.id ?? "");
    await guidelines.sync(floor);
    expect(await notices.open({ floorId: floor.id })).toEqual([]);
    expect(noticeEvents().map(({ type }) => type)).toEqual([
      "notice.raised",
      "notice.dismissed",
    ]);
  });

  it("lets the Owner approve exactly the version that waits, in the Floor admin", async () => {
    const { github, floor, guidelines, guidelineEvents } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Theirs.\n" },
      pusher: "mallory",
    });
    await guidelines.sync(floor);
    github.pushCommit(repository, "main", {
      files: { [tech]: "Theirs, changed.\n" },
      pusher: "mallory",
    });
    // A version that changed meanwhile is not approved.
    const stale = await guidelines
      .approve(floor.id, "tech", guidelineContentHash("Theirs.\n"))
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(GuidelineVersionError);
    expect(stale).toMatchObject({ code: "changed" });
    await expect(
      guidelines.approve(floor.id, "none", guidelineContentHash("x")),
    ).rejects.toMatchObject({ code: "not_found" });

    const state = await guidelines.approve(
      floor.id,
      "tech",
      guidelineContentHash("Theirs, changed.\n"),
    );
    expect(bodies(state)).toEqual({ tech: "Theirs, changed." });
    expect(state.approved[0]?.approval).toBe("owner_admin");
    expect(guidelineEvents().at(-1)).toEqual({
      type: "guideline.approved",
      version: 1,
      floorId: floor.id,
      name: "tech",
      contentHash: guidelineContentHash("Theirs, changed.\n"),
      approval: "owner_admin",
    });
    // Approved already.
    await expect(
      guidelines.approve(
        floor.id,
        "tech",
        guidelineContentHash("Theirs, changed.\n"),
      ),
    ).rejects.toMatchObject({ code: "changed" });
  });

  it("lets the Owner dismiss a version: Agents keep the last approved, and it waits no more", async () => {
    const { github, floor, guidelines, guidelineEvents, notices } =
      await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: owner,
    });
    await guidelines.sync(floor);
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use npm.\n" },
      pusher: "mallory",
    });
    await guidelines.sync(floor);
    const hash = guidelineContentHash("Use npm.\n");
    const state = await guidelines.dismiss(floor.id, "tech", hash);
    expect(bodies(state)).toEqual({ tech: "Use pnpm." });
    expect(state.unapproved).toEqual([
      expect.objectContaining({ name: "tech", status: "dismissed" }),
    ]);
    expect(await notices.open({ floorId: floor.id })).toEqual([]);
    expect(guidelineEvents().at(-1)).toEqual({
      type: "guideline.dismissed",
      version: 1,
      floorId: floor.id,
      name: "tech",
      contentHash: hash,
    });
    await expect(
      guidelines.dismiss(floor.id, "tech", hash),
    ).rejects.toMatchObject({ code: "changed" });

    // Someone else makes it so again: still dismissed, nothing raised.
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\nUse npm.\n" },
      pusher: "mallory",
    });
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use npm.\n" },
      pusher: "mallory",
    });
    const after = await guidelines.sync(floor);
    expect(bodies(after)).toEqual({ tech: "Use pnpm." });
    expect(after.unapproved).toEqual([
      expect.objectContaining({ contentHash: hash, status: "dismissed" }),
    ]);
    expect(await notices.open({ floorId: floor.id })).toEqual([]);
    expect(
      guidelineEvents().filter(({ type }) => type === "guideline.awaiting"),
    ).toHaveLength(1);
  });

  it("approves nothing by merge or push without the Owner's login", async () => {
    const { github, floor, guidelines } = await setUp({ ownerLogin: "" });
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: "",
    });
    expect((await guidelines.sync(floor)).approved).toEqual([]);
  });

  it("gives each task what the Floor's latest read settled, reading it only when it has not been read", async () => {
    const { github, floor, guidelines } = await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm.\n" },
      pusher: owner,
    });
    // Not read since AI Office started: read now.
    expect((await guidelines.approved(floor)).map(({ body }) => body)).toEqual([
      "Use pnpm.",
    ]);
    // A change on the default branch reaches tasks at the next read, at
    // intake or before a task, not before.
    github.pushCommit(repository, "main", {
      files: { [tech]: "Use pnpm 12.\n" },
      pusher: owner,
    });
    expect((await guidelines.approved(floor)).map(({ body }) => body)).toEqual([
      "Use pnpm.",
    ]);
    await guidelines.sync(floor);
    expect((await guidelines.approved(floor)).map(({ body }) => body)).toEqual([
      "Use pnpm 12.",
    ]);
  });

  it("changes nothing for a Floor without Guidelines but suggest /guidelines", async () => {
    const { floor, guidelines, guidelineEvents, noticeEvents } = await setUp();
    expect(await guidelines.sync(floor)).toEqual({
      approved: [],
      unapproved: [],
      refused: [],
    });
    expect(guidelineEvents()).toEqual([]);
    expect(noticeEvents()).toEqual([
      expect.objectContaining({
        type: "notice.raised",
        kind: "info",
        title: guidelinesSuggestionTitle("web-shop"),
      }),
    ]);
  });
});

describe("reading Guidelines at intake and before each task", () => {
  it("reads each Floor's Guidelines every intake round", async () => {
    const { github, floorStore, events, guidelines, guidelineEvents } =
      await setUp();
    github.pushCommit(repository, "main", {
      files: { [tech]: "Theirs.\n" },
      pusher: "mallory",
    });
    const intake = createIntake({
      floors: floorStore,
      github,
      pipeline: createPipeline({ github, events }),
      queue: memoryIntakeQueue(),
      events,
      settings: () =>
        Promise.resolve({ ownerLogin: owner, intervalSeconds: 60 }),
      guidelines,
    });
    expect((await intake.poll()).failed).toEqual([]);
    expect(pick(guidelineEvents())).toEqual([["guideline.awaiting", "tech"]]);
  });

  it("makes a guideline:<name> label for each manual Guideline the Owner approved, once", async () => {
    const { github, floorStore, events, guidelines } = await setUp();
    github.pushCommit(repository, "main", {
      files: {
        ".agents/guidelines/release.md":
          "---\ninclusion: manual\n---\n\nBump the version.\n",
        [tech]: "Use pnpm.\n",
      },
      pusher: owner,
    });
    github.pushCommit(repository, "main", {
      files: {
        ".agents/guidelines/hotfix.md":
          "---\ninclusion: manual\n---\n\nTheirs.\n",
      },
      pusher: "mallory",
    });
    const intake = createIntake({
      floors: floorStore,
      github,
      pipeline: createPipeline({ github, events }),
      queue: memoryIntakeQueue(),
      events,
      settings: () =>
        Promise.resolve({ ownerLogin: owner, intervalSeconds: 60 }),
      guidelines,
    });
    expect((await intake.poll()).failed).toEqual([]);
    const guidelineLabels = () =>
      github
        .labels(repository)
        .filter(({ name }) => name.startsWith("guideline:"))
        .map(({ name, description }) => ({ name, description }));
    // Not the one awaiting approval, nor an always one.
    expect(guidelineLabels()).toEqual([
      {
        name: "guideline:release",
        description: "AI Office: follow the Owner's release Guideline",
      },
    ]);
    await intake.poll();
    expect(guidelineLabels()).toHaveLength(1);
  });

  it("still takes in a Floor's issues when its Guidelines cannot be read", async () => {
    const { github, floor, floorStore, events } = await setUp();
    const failure = new Error("GitHub is down.");
    github.createIssue(repository, {
      title: "Add a basket",
      labels: ["ai-office"],
    });
    const queue = memoryIntakeQueue();
    const report = await createIntake({
      floors: floorStore,
      github,
      pipeline: createPipeline({ github, events }),
      queue,
      events,
      settings: () =>
        Promise.resolve({ ownerLogin: owner, intervalSeconds: 60 }),
      guidelines: { sync: () => Promise.reject(failure) },
    }).poll();
    expect(report.failed).toEqual([{ floorId: floor.id, error: failure }]);
    expect(report.pickedUp).toEqual([{ floorId: floor.id, issue: 1 }]);
    expect(queue.items).toHaveLength(1);
  });

  it("settles a Floor's Guidelines before each task, and works on if they cannot be read", async () => {
    const { floor, floorStore } = await setUp();
    const order: string[] = [];
    const errors: unknown[] = [];
    const work = { floorId: floor.id } as WorkItem;
    const sync = (read: FloorRecord) => {
      order.push(`sync ${read.id}`);
      return Promise.resolve({ approved: [], unapproved: [], refused: [] });
    };
    const execute = withGuidelines(
      () => {
        order.push("work");
        return Promise.resolve("finished");
      },
      { floors: floorStore, guidelines: { sync } },
    );
    expect(await execute(work, new AbortController().signal)).toBe("finished");
    expect(order).toEqual([`sync ${floor.id}`, "work"]);

    const failing = withGuidelines(() => Promise.resolve("finished"), {
      floors: floorStore,
      guidelines: { sync: () => Promise.reject(new Error("GitHub is down.")) },
      onError: (error) => errors.push(error),
    });
    expect(await failing(work, new AbortController().signal)).toBe("finished");
    expect(errors).toHaveLength(1);
  });
});
