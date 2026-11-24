import { createEventBus, memoryEventStore } from "@ai-office/events";
import { defaultFloorSettings } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { memoryBatchStore } from "../batches/store.ts";
import type { FloorRecord } from "../floors/store.ts";
import { createNotices } from "../notices/notices.ts";
import { memoryNoticeStore } from "../notices/store.ts";
import type { ApprovedGuideline } from "./approval.ts";
import {
  createTaskGuidelines,
  guidelinesBudgetAction,
  plannedFiles,
} from "./tasks.ts";
import {
  approvedGuideline,
  floorGuidelines,
  migrationsGuideline,
  techGuideline,
} from "./testing.ts";

// Each task's Guidelines (FR-105, FR-108): the Floor's approved ones, as
// its latest read settled them, chosen by the task's Stage, its files and
// the issue's labels, within its budget; over it, an event each time and
// one action Notice per Floor until its Guidelines change.

const floor: FloorRecord = {
  ...defaultFloorSettings,
  template: { id: "development", name: "Development" },
  theme: "office",
  id: "web-shop",
  name: "web-shop",
  defaultBranch: "main",
  githubRepositoryId: 1,
  repository: "adrianeyre/web-shop",
  createdAt: new Date(Date.UTC(2026, 10, 1)),
  archivedAt: null,
};

function setUp(
  approved: readonly ApprovedGuideline[] = floorGuidelines,
  planFiles: Record<number, readonly string[]> = {},
) {
  const eventStore = memoryEventStore();
  const events = createEventBus({ store: eventStore });
  const notices = createNotices({ store: memoryNoticeStore(), events });
  const state = { approved, reads: 0, failing: false };
  const errors: unknown[] = [];
  const tasks = createTaskGuidelines({
    approvals: {
      approved: () => {
        state.reads += 1;
        return state.failing
          ? Promise.reject(new Error("GitHub is down."))
          : Promise.resolve(state.approved);
      },
    },
    notices,
    events,
    planFiles: (_floorId, issue) => Promise.resolve(planFiles[issue] ?? []),
    onError: (error) => errors.push(error),
  });
  const overBudget = () =>
    eventStore.events
      .map(({ event }) => event)
      .filter(({ type }) => type === "guideline.over_budget");
  const budgetNotices = async () =>
    (await notices.open({ floorId: floor.id })).filter((notice) =>
      notice.actions.some(({ id }) => id === guidelinesBudgetAction),
    );
  return { tasks, state, notices, errors, overBudget, budgetNotices };
}

const names = (guidelines: readonly { name: string }[] | undefined) =>
  guidelines?.map(({ name }) => name);

describe("each task's Guidelines", () => {
  it("chooses the work Stage's and the designer's by the files the Batch's Plan expects the issue to change", async () => {
    const { tasks } = setUp(floorGuidelines, {
      4: ["packages/db/schema.ts"],
    });
    for (const task of ["work", "design"] as const) {
      const given = await tasks.forTask({
        floor,
        task,
        agentId: "ada",
        issue: { number: 4, labels: ["ai-office", "needs-work"] },
        // Not the pull request's: the Plan's.
        files: ["apps/web/src/basket.tsx"],
      });
      expect(names(given?.followed), task).toEqual(["migrations", "tech"]);
      expect(names(given?.listed), task).toEqual(["web"]);
    }
  });

  it("chooses review's, QA's and docs' by the files the pull request changes", async () => {
    const { tasks } = setUp(floorGuidelines, {
      4: ["packages/db/schema.ts"],
    });
    for (const task of ["review", "qa", "docs"] as const) {
      const given = await tasks.forTask({
        floor,
        task,
        issue: { number: 4, labels: ["guideline:release"] },
        files: ["apps/web/src/basket.tsx"],
      });
      expect(names(given?.followed), task).toEqual(["release", "tech", "web"]);
      expect(given?.listed, task).toEqual([]);
    }
  });

  it("gives the Manager the always Guidelines and tells it of the rest", async () => {
    const { tasks } = setUp();
    const given = await tasks.forTask({ floor, task: "chat" });
    expect(names(given?.followed)).toEqual(["tech"]);
    expect(names(given?.listed)).toEqual(["migrations", "release", "web"]);
  });

  it("gives nothing on a Floor without Guidelines, or when they cannot be read", async () => {
    const { tasks, state, errors } = setUp([]);
    expect(
      await tasks.forTask({
        floor,
        task: "work",
        issue: { number: 4, labels: [] },
      }),
    ).toBeUndefined();
    state.failing = true;
    expect(await tasks.forTask({ floor, task: "triage" })).toBeUndefined();
    expect(errors).toEqual([new Error("GitHub is down.")]);
  });

  it("gives nothing when none of the Floor's Guidelines is for the task", async () => {
    const { tasks } = setUp([migrationsGuideline]);
    expect(
      await tasks.forTask({
        floor,
        task: "review",
        issue: { number: 4, labels: [] },
        files: ["README.md"],
      }),
    ).toBeUndefined();
  });

  it("finds the files the newest open Batch's latest Plan names for the issue", async () => {
    const store = memoryBatchStore();
    const item = (issue: number, files: string[]) => ({
      issue,
      title: `Issue ${String(issue)}`,
      dependsOn: [],
      files,
      agentId: null,
      note: "",
    });
    const { batch } = await store.create(
      {
        floorId: floor.id,
        issues: [4, 5],
        status: "in_progress",
        agentId: "manager",
        createdAt: new Date(Date.UTC(2026, 10, 1)),
      },
      {
        draftedBy: "model",
        summary: "Two issues.",
        items: [item(4, ["packages/db/schema.ts"]), item(5, [])],
        overlaps: [],
        parallel: [[4, 5]],
        leftOut: [],
      },
    );
    await store.addPlan(
      batch.id,
      {
        draftedBy: "model",
        summary: "Replanned.",
        items: [item(4, ["packages/db/0002.sql", "packages/db/schema.ts"])],
        overlaps: [],
        parallel: [[4]],
        leftOut: [],
      },
      "manager",
      new Date(Date.UTC(2026, 10, 2)),
    );
    const files = plannedFiles(store);
    expect(await files(floor.id, 4)).toEqual([
      "packages/db/0002.sql",
      "packages/db/schema.ts",
    ]);
    expect(await files(floor.id, 9)).toEqual([]);
    expect(await files("other", 4)).toEqual([]);
  });
});

describe("the Guidelines' budget, per Floor", () => {
  const large = (name: string, characters: number) =>
    approvedGuideline(
      name,
      ["inclusion: fileMatch", 'fileMatchPattern: "packages/**"'],
      "x".repeat(characters),
    );

  it("leaves the largest fileMatch Guidelines out, says so in an event each time, and raises one action Notice for the Floor", async () => {
    const guidelines = [techGuideline, large("db", 7000), large("api", 6000)];
    const { tasks, overBudget, budgetNotices } = setUp(guidelines);
    const ask = (number: number) =>
      tasks.forTask({
        floor,
        task: "review",
        agentId: "grace",
        issue: { number, labels: [] },
        files: ["packages/db/schema.ts"],
      });
    const given = await ask(4);
    expect(names(given?.followed)).toEqual(["api", "tech"]);
    expect(names(given?.leftOut)).toEqual(["db"]);
    expect(given?.budget).toBe(12_000);
    await ask(5);

    const characters = guidelines.reduce(
      (sum, { content }) => sum + content.length,
      0,
    );
    expect(overBudget()).toEqual([
      {
        type: "guideline.over_budget",
        version: 1,
        floorId: floor.id,
        task: "review",
        agentId: "grace",
        issue: 4,
        budget: 12_000,
        characters,
        leftOut: ["db"],
      },
      expect.objectContaining({ issue: 5 }),
    ]);
    const notices = await budgetNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "action",
      title: "Guidelines on web-shop exceed the 12,000-character budget",
      floorId: floor.id,
      actions: [
        {
          id: guidelinesBudgetAction,
          label: "Open Guidelines",
          href: `/floor-settings/${floor.id}#guidelines`,
        },
      ],
    });
  });

  it("goes by the task's own budget, its Model's", async () => {
    const { tasks, budgetNotices } = setUp([techGuideline, large("db", 3000)]);
    const given = await tasks.forTask({
      floor,
      task: "qa",
      issue: { number: 4, labels: [] },
      files: ["packages/db/schema.ts"],
      budget: 2000,
    });
    expect(names(given?.followed)).toEqual(["tech"]);
    expect((await budgetNotices())[0]?.title).toBe(
      "Guidelines on web-shop exceed the 2,000-character budget",
    );
  });

  it("keeps the Notice until the Floor's Guidelines change, and refuses the Owner's action meanwhile", async () => {
    const { tasks, state, notices, budgetNotices } = setUp([
      techGuideline,
      large("db", 5000),
    ]);
    const review = () =>
      tasks.forTask({
        floor,
        task: "review",
        issue: { number: 4, labels: [] },
        files: ["packages/db/schema.ts"],
        budget: 5000,
      });
    await review();
    const [notice] = await budgetNotices();
    // A task that fits does not take it off: another may not.
    await tasks.forTask({ floor, task: "chat" });
    expect(await budgetNotices()).toHaveLength(1);
    await expect(
      notices.act(notice?.id ?? "", guidelinesBudgetAction),
    ).rejects.toThrow(/goes once the Floor's Guidelines change/);

    // The Owner shortens it: the Notice goes.
    state.approved = [techGuideline, large("db", 2000)];
    expect(names((await review())?.leftOut)).toEqual([]);
    expect(await budgetNotices()).toEqual([]);
    expect(await notices.get(notice?.id ?? "")).toMatchObject({
      actedOn: guidelinesBudgetAction,
    });
  });

  it("does not raise again a Notice the Owner dismissed, until the Guidelines change", async () => {
    const { tasks, state, notices, budgetNotices } = setUp([
      techGuideline,
      large("db", 5000),
    ]);
    const review = () =>
      tasks.forTask({
        floor,
        task: "review",
        issue: { number: 4, labels: [] },
        files: ["packages/db/schema.ts"],
        budget: 5000,
      });
    await review();
    const [notice] = await budgetNotices();
    await notices.dismiss(notice?.id ?? "");
    await review();
    expect(await budgetNotices()).toEqual([]);

    // Changed, and still over: raised again.
    state.approved = [techGuideline, large("db", 5500)];
    await review();
    expect(await budgetNotices()).toHaveLength(1);
  });

  it("never holds the task up when the Notice cannot be kept", async () => {
    const { tasks, notices, errors } = setUp([
      techGuideline,
      large("db", 5000),
    ]);
    notices.raise = () => Promise.reject(new Error("The database is down."));
    const given = await tasks.forTask({
      floor,
      task: "review",
      issue: { number: 4, labels: [] },
      files: ["packages/db/schema.ts"],
      budget: 5000,
    });
    expect(names(given?.followed)).toEqual(["tech"]);
    expect(errors).toEqual([new Error("The database is down.")]);
  });
});
