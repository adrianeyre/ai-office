import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import type { VerdictRecord } from "./store.ts";

// Where the Review Loop keeps verdicts by round, QA's results and Handoffs
// (PRD FR-26 to FR-28): in memory and in Postgres 18, alike.

const at = (minute: number) =>
  new Date(`2026-10-09T09:${String(minute).padStart(2, "0")}:00.000Z`);

const record = (
  round: number,
  agentId: string,
  kind: "approve" | "changes_requested",
  minute: number,
): VerdictRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round,
  agentId,
  headSha: String(round).repeat(40),
  verdict: {
    verdict: kind,
    summary: `Round ${String(round)}.`,
    comments:
      kind === "approve"
        ? []
        : [{ severity: "blocking", path: "a.ts", line: 1, body: "Fix it." }],
  },
  reviewUrl: `https://github.com/adrianeyre/web-shop/pull/2#pullrequestreview-${String(minute)}`,
  createdAt: at(minute),
});

async function run(stores: OfficeStores): Promise<void> {
  await createFloors({
    store: stores.floors,
    github: (() => {
      const fake = createFakeGitHub();
      fake.installRepository("adrianeyre/web-shop");
      return fake;
    })(),
    events: createEventBus({ store: memoryEventStore() }),
  }).add("adrianeyre/web-shop");
  const { reviews } = stores;

  await reviews.recordVerdict(record(2, "grace", "approve", 5));
  await reviews.recordVerdict(record(1, "quinta", "changes_requested", 2));
  await reviews.recordVerdict(record(1, "grace", "changes_requested", 1));
  // A reviewer's verdict again in the same round replaces its earlier one.
  await reviews.recordVerdict(record(1, "grace", "approve", 3));
  expect(
    (await reviews.verdicts("web-shop", 1)).map(
      ({ round, agentId, verdict }) => [round, agentId, verdict.verdict],
    ),
  ).toEqual([
    [1, "quinta", "changes_requested"],
    [1, "grace", "approve"],
    [2, "grace", "approve"],
  ]);
  const [first] = await reviews.verdicts("web-shop", 1);
  expect(first).toEqual(record(1, "quinta", "changes_requested", 2));
  expect(await reviews.verdicts("web-shop", 9)).toEqual([]);

  expect(
    await reviews.latestHandoff("web-shop", 1, "needs-review"),
  ).toBeUndefined();
  const handoff = (minute: number, changed: string) => ({
    floorId: "web-shop",
    issue: 1,
    stage: "needs-review" as const,
    fromAgentId: "ada",
    summary: { changed, check: "a.ts", risks: "None." },
    createdAt: at(minute),
  });
  await reviews.recordHandoff(handoff(1, "Take 1."));
  await reviews.recordHandoff(handoff(4, "Take 2."));
  await reviews.recordHandoff({
    ...handoff(6, "Back to the coder."),
    stage: "needs-work",
  });
  expect(await reviews.latestHandoff("web-shop", 1, "needs-review")).toEqual(
    handoff(4, "Take 2."),
  );
  expect(
    (await reviews.latestHandoff("web-shop", 1, "needs-work"))?.summary.changed,
  ).toBe("Back to the coder.");

  // QA's results, one per round.
  const report = (round: number, result: "pass" | "fail", minute: number) => ({
    floorId: "web-shop",
    issue: 1,
    pullRequest: 2,
    round,
    agentId: "quill",
    headSha: String(round + 4).repeat(40),
    result,
    summary: `QA round ${String(round)}.`,
    steps: result === "fail" ? "1. Run pnpm test." : "",
    commentUrl: `https://github.com/adrianeyre/web-shop/pull/2#issuecomment-${String(minute)}`,
    createdAt: at(minute),
  });
  expect(await reviews.qaReports("web-shop", 1)).toEqual([]);
  await reviews.recordQaReport(report(2, "pass", 9));
  await reviews.recordQaReport(report(1, "pass", 7));
  // Again in the same round: it replaces the earlier one.
  await reviews.recordQaReport(report(1, "fail", 8));
  expect(await reviews.qaReports("web-shop", 1)).toEqual([
    report(1, "fail", 8),
    report(2, "pass", 9),
  ]);
  expect(await reviews.qaReports("web-shop", 9)).toEqual([]);

  // A designer's result in each round of design review: one per round.
  const design = (
    round: number,
    result: "pass" | "changes",
    minute: number,
  ) => ({
    floorId: "web-shop",
    issue: 1,
    pullRequest: 2,
    round,
    agentId: "dee",
    headSha: String(round + 6).repeat(40),
    result,
    summary: `Design round ${String(round)}.`,
    findings: result === "changes" ? "1. The button is off the palette." : "",
    commentUrl: `https://github.com/adrianeyre/web-shop/pull/2#issuecomment-${String(minute + 20)}`,
    createdAt: at(minute),
  });
  expect(await reviews.designReviews("web-shop", 1)).toEqual([]);
  await reviews.recordDesignReview(design(2, "pass", 12));
  await reviews.recordDesignReview(design(1, "pass", 10));
  // Again in the same round: it replaces the earlier one.
  await reviews.recordDesignReview(design(1, "changes", 11));
  expect(await reviews.designReviews("web-shop", 1)).toEqual([
    design(1, "changes", 11),
    design(2, "pass", 12),
  ]);
  expect(await reviews.designReviews("web-shop", 9)).toEqual([]);
}

describe("the Review Loop's store", () => {
  it("in memory keeps verdicts by round, one per reviewer, QA's and designers' results, and the latest Handoff to each stage", async () => {
    await run(memoryStores());
  });

  postgresTest(
    "in Postgres 18 keeps verdicts by round, one per reviewer, QA's and designers' results, and the latest Handoff to each stage",
    async ({ database }) => {
      await run(databaseStores(database.db));
    },
  );
});
