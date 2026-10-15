import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createFloors, memoryStores } from "@ai-office/orchestrator";
import { describe, expect, it } from "vitest";

import { batchReportOf, completedIssueOf, issueTitleOf } from "./publishing.ts";

// What the Communications Agent publishes from (PRD FR-92): a finished
// Batch's Wrap-up joined with its Plan and its coders' names, an issue's
// title from the event log, and a completed issue's work log row.

const at = new Date("2026-10-10T10:00:00.000Z");

describe("a finished Batch's report data", () => {
  it("joins the Wrap-up with the Plan it finished on and the coders' names; none for a Batch not finished, or not the Floor's", async () => {
    const stores = memoryStores();
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    const events = createEventBus({ store: memoryEventStore() });
    await createFloors({ store: stores.floors, github, events }).add(
      "adrianeyre/web-shop",
    );
    const coder = (await stores.agents.list("web-shop")).find(
      ({ role }) => role === "coder",
    );
    const item = (issue: number, dependsOn: number[]) => ({
      issue,
      title: `Issue ${String(issue)}`,
      dependsOn,
      files: [],
      agentId: coder?.id ?? null,
      note: "",
    });
    const { batch } = await stores.batches.create(
      {
        floorId: "web-shop",
        issues: [1, 2],
        status: "in_progress",
        agentId: "grace",
        createdAt: at,
      },
      {
        draftedBy: "rules",
        summary: "v1",
        items: [item(1, []), item(2, [])],
        overlaps: [],
        parallel: [[1, 2]],
        leftOut: [],
      },
    );
    await stores.batches.addPlan(
      batch.id,
      {
        draftedBy: "rules",
        summary: "v2",
        items: [item(1, []), item(2, [1])],
        overlaps: [],
        parallel: [[1], [2]],
        leftOut: [{ issue: 5, reason: "you skipped it" }],
      },
      "grace",
      at,
    );
    expect(await batchReportOf(stores, "web-shop", batch.id)).toBeUndefined();

    const wrapUp = {
      planVersion: 2,
      issues: [1, 2].map((issue) => ({
        issue,
        title: `Issue ${String(issue)}`,
        outcome: issue === 1 ? ("merged" as const) : ("blocked" as const),
        pullRequest: null,
        agentId: coder?.id ?? null,
        rounds: { review: issue, qa: 0 },
        tokens: issue * 1000,
        estimatedCostUsd: issue / 10,
      })),
      leftOut: [{ issue: 5, reason: "you skipped it" }],
      totals: {
        merged: 1,
        closed: 0,
        blocked: 1,
        notStarted: 0,
        tokens: 3000,
        estimatedCostUsd: 0.3,
      },
    };
    const finishedAt = new Date(at.getTime() + 3_600_000);
    await stores.batches.markFinished(batch.id, finishedAt, wrapUp);

    expect(await batchReportOf(stores, "web-shop", batch.id)).toEqual({
      batchId: batch.id,
      floor: {
        id: "web-shop",
        name: "web-shop",
        repository: "adrianeyre/web-shop",
      },
      startedAt: at,
      finishedAt,
      planVersion: 2,
      issues: [
        {
          issue: 1,
          title: "Issue 1",
          agent: coder?.name,
          dependsOn: [],
          outcome: "merged",
          pullRequest: null,
          rounds: { review: 1, qa: 0 },
          tokens: 1000,
          estimatedCostUsd: 0.1,
        },
        {
          issue: 2,
          title: "Issue 2",
          agent: coder?.name,
          dependsOn: [1],
          outcome: "blocked",
          pullRequest: null,
          rounds: { review: 2, qa: 0 },
          tokens: 2000,
          estimatedCostUsd: 0.2,
        },
      ],
      parallel: [[1], [2]],
      leftOut: [{ issue: 5, reason: "you skipped it" }],
      totals: wrapUp.totals,
    });
    expect(await batchReportOf(stores, "blog", batch.id)).toBeUndefined();
    expect(
      await batchReportOf(stores, "web-shop", batch.id + 1),
    ).toBeUndefined();
  });
});

describe("an issue's title", () => {
  it("is the latest title intake read, on that Floor", async () => {
    const events = createEventBus({ store: memoryEventStore() });
    const picked = (floorId: string, title: string) =>
      events.publish({
        type: "issue.picked_up",
        version: 1,
        floorId,
        issue: 4,
        title,
        url: "https://github.com/adrianeyre/web-shop/issues/4",
      });
    expect(await issueTitleOf(events, "web-shop", 4)).toBeUndefined();
    await picked("web-shop", "Pay at checkout");
    await picked("blog", "Another Floor's #4");
    await picked("web-shop", "Pay at the checkout");
    expect(await issueTitleOf(events, "web-shop", 4)).toBe(
      "Pay at the checkout",
    );
  });
});

describe("a completed issue, for its work log row", () => {
  it("names the Agents that worked it in the order they began, with its Review Loop rounds and its model calls' tokens and cost", async () => {
    const stores = memoryStores();
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    const events = createEventBus({ store: memoryEventStore() });
    await createFloors({ store: stores.floors, github, events }).add(
      "adrianeyre/web-shop",
    );
    const team = await stores.agents.list("web-shop");
    const idOf = (role: string) =>
      team.find((agent) => agent.role === role)?.id ?? "";
    const nameOf = (role: string) =>
      team.find((agent) => agent.role === role)?.name ?? "";
    const [coder, reviewer, qa] = [idOf("coder"), idOf("reviewer"), idOf("qa")];
    const at4 = { floorId: "web-shop", issue: 4 } as const;
    await events.publish({
      type: "issue.picked_up",
      version: 1,
      ...at4,
      title: "Pay at checkout",
      url: "https://github.com/adrianeyre/web-shop/issues/4",
    });
    await events.publish({
      type: "issue.assigned",
      version: 1,
      ...at4,
      agentId: coder,
    });
    await events.publish({
      type: "sandbox.started",
      version: 1,
      ...at4,
      agentId: coder,
      sandboxId: "sbx-1",
      branch: "ai-office/4-pay-at-checkout",
    });
    for (const round of [1, 2]) {
      await events.publish({
        type: "review.posted",
        version: 1,
        ...at4,
        agentId: reviewer,
        pullRequest: 14,
        round,
        verdict: round === 1 ? "changes_requested" : "approve",
        blocking: round === 1 ? 1 : 0,
        nits: 0,
        url: "https://github.com/adrianeyre/web-shop/pull/14#pullrequestreview-7",
      });
    }
    await events.publish({
      type: "qa.reported",
      version: 1,
      ...at4,
      agentId: qa,
      pullRequest: 14,
      round: 1,
      result: "pass",
      url: "https://github.com/adrianeyre/web-shop/pull/14#issuecomment-9",
    });
    // Another issue's work, and an Agent no longer on the Floor, are not its.
    await events.publish({
      type: "issue.assigned",
      version: 1,
      floorId: "web-shop",
      issue: 5,
      agentId: reviewer,
    });
    await events.publish({
      type: "issue.assigned",
      version: 1,
      ...at4,
      agentId: "gone",
    });
    const totals = (tokens: number, estimatedCostUsd: number) => ({
      requests: 1,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokens,
      estimatedCostUsd,
    });
    const asked: [Date, Date][] = [];
    const now = new Date("2026-10-10T12:00:00.000Z");
    const record = await completedIssueOf(
      {
        events,
        agents: stores.agents,
        usage: (from, to) => {
          asked.push([from, to]);
          return Promise.resolve([
            {
              floorId: "web-shop",
              agentId: coder,
              issue: 4,
              ownerTool: null,
              totals: totals(100_000, 1.1),
            },
            {
              floorId: "web-shop",
              agentId: reviewer,
              issue: 4,
              ownerTool: null,
              totals: totals(20_000, 0.2),
            },
            {
              floorId: "web-shop",
              agentId: coder,
              issue: 5,
              ownerTool: null,
              totals: totals(9_000, 0.09),
            },
            {
              floorId: "blog",
              agentId: null,
              issue: 4,
              ownerTool: null,
              totals: totals(7_000, 0.07),
            },
          ]);
        },
        now: () => now,
      },
      "web-shop",
      4,
    );
    expect(record).toEqual({
      title: "Pay at checkout",
      agents: [nameOf("coder"), nameOf("reviewer"), nameOf("qa")],
      reviewRounds: 2,
      tokens: 120_000,
      estimatedCostUsd: 1.3,
    });
    // Every model call for it, however long ago.
    expect(asked).toEqual([[new Date(0), now]]);
  });
});
