import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { agentScorecardOf, scorecardOf } from "./aggregate.ts";
import {
  createScorecardRecorder,
  type IssueUsage,
  type ScorecardRecorder,
} from "./recorder.ts";
import type { ScorecardEntry } from "./store.ts";

// Recording how each piece of work turned out, for the Scorecard
// (Scorecards PRD, FR-126, FR-127): as it ends, with the Agents that
// worked it, the Model that served each, its course through the Review
// Loop and QA, and what its Gateway requests used.

const repository = "adrianeyre/web-shop";
const url = `https://github.com/${repository}/pull/12`;
const sha = "0123456789abcdef0123456789abcdef01234567";

interface Setup {
  readonly fake: FakeGitHub;
  readonly bus: EventBus;
  readonly stores: OfficeStores;
  readonly recorder: ScorecardRecorder;
  readonly coder: AgentRecord;
  readonly reviewer: AgentRecord;
  /** What the request history holds of each issue's Gateway requests. */
  readonly usage: Map<number, IssueUsage[]>;
  /** The clock, which the test moves on. */
  readonly clock: { now: Date };
  publish(event: OfficeEvent): Promise<void>;
  /** Every record, once recording has caught up. */
  recorded(): Promise<ScorecardEntry[]>;
}

let current: Setup | undefined;

afterEach(async () => {
  await current?.recorder.stop();
  current = undefined;
});

/** Every record kept, oldest first. */
const allRecords = (stores: OfficeStores) =>
  stores.scorecards.list(new Date(0), new Date("2100-01-01T00:00:00Z"));

async function setUp(
  stores: OfficeStores = memoryStores(),
  bus: EventBus = createEventBus({ store: memoryEventStore() }),
): Promise<Setup> {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  await createFloors({ store: stores.floors, github: fake, events: bus }).add(
    repository,
  );
  const team = await stores.agents.list("web-shop");
  const coder = team.find(({ role }) => role === "coder");
  const reviewer = team.find(({ role }) => role === "reviewer");
  if (coder === undefined || reviewer === undefined) {
    throw new Error("A new Floor has a coder and a reviewer.");
  }
  const usage = new Map<number, IssueUsage[]>();
  const clock = { now: new Date("2026-11-20T10:00:00.000Z") };
  const recorder = createScorecardRecorder({
    store: stores.scorecards,
    floors: stores.floors,
    agents: stores.agents,
    roles: stores.roles,
    events: bus,
    reviews: stores.reviews,
    usage: (_floorId, issue) => Promise.resolve(usage.get(issue) ?? []),
    sizeOf: async (floorId, issue) =>
      (await stores.triage.get(floorId, issue))?.size ?? null,
    github: fake,
    now: () => clock.now,
  });
  recorder.start();
  return {
    fake,
    bus,
    stores,
    recorder,
    coder,
    reviewer,
    usage,
    clock,
    publish: async (event) => {
      await bus.publish(event);
    },
    async recorded() {
      // Recording runs after the event, in order: stopping waits for it.
      await recorder.stop();
      recorder.start();
      return allRecords(stores);
    },
  };
}

/** The events of an issue worked by the coder and reviewed. */
const worked = (setup: Setup, issue: number): OfficeEvent[] => [
  {
    type: "sandbox.started",
    version: 1,
    floorId: "web-shop",
    agentId: setup.coder.id,
    issue,
    sandboxId: "sandbox-1",
    branch: `ai-office/${String(issue)}-add-a-basket`,
  },
  {
    type: "review.posted",
    version: 1,
    floorId: "web-shop",
    agentId: setup.reviewer.id,
    issue,
    pullRequest: 12,
    round: 1,
    verdict: "changes_requested",
    blocking: 2,
    nits: 0,
    url,
  },
];

const merged = (issue: number): OfficeEvent => ({
  type: "pull_request.merged",
  version: 1,
  floorId: "web-shop",
  issue,
  pullRequest: 12,
  url,
  sha,
  by: "app",
});

/** The reviewer's verdicts on issue 4: changes in round 1, then approval. */
const reviewTwice = async (setup: Setup): Promise<void> => {
  const verdict = (
    round: number,
    approve: boolean,
  ): Parameters<typeof setup.stores.reviews.recordVerdict>[0] => ({
    floorId: "web-shop",
    issue: 4,
    pullRequest: 12,
    round,
    agentId: setup.reviewer.id,
    headSha: sha,
    verdict: approve
      ? { verdict: "approve", summary: "Good.", comments: [] }
      : {
          verdict: "changes_requested",
          summary: "Two problems.",
          comments: [
            {
              severity: "blocking",
              path: "src/basket.ts",
              line: 1,
              body: "Total is wrong.",
            },
            {
              severity: "blocking",
              path: "src/basket.ts",
              line: 2,
              body: "No test.",
            },
            {
              severity: "nit",
              path: "src/basket.ts",
              line: 3,
              body: "Name it total.",
            },
          ],
        },
    reviewUrl: `${url}#review-${String(round)}`,
    createdAt: new Date(`2026-11-20T0${String(round)}:00:00.000Z`),
  });
  await setup.stores.reviews.recordVerdict(verdict(1, false));
  await setup.stores.reviews.recordVerdict(verdict(2, true));
};

type Case = [
  name: string,
  run: (stores: OfficeStores, bus: EventBus) => Promise<void>,
];

const cases: Case[] = [
  [
    "records a merged issue worked by two Agents for both, each with the Model that served it, and its course",
    async (stores, bus) => {
      current = await setUp(stores, bus);
      const { coder, reviewer } = current;
      for (const event of worked(current, 4)) {
        await current.publish(event);
      }
      await reviewTwice(current);
      await current.stores.reviews.recordQaReport({
        floorId: "web-shop",
        issue: 4,
        pullRequest: 12,
        round: 1,
        agentId: coder.id,
        headSha: sha,
        result: "fail",
        summary: "The total is off by one.",
        steps: "Add two items.",
        commentUrl: `${url}#qa-1`,
        createdAt: new Date("2026-11-20T05:00:00.000Z"),
      });
      // The coder's requests were served by two Models (a Combo, say): each
      // is its own row, the coder's own counts on the one that served most.
      current.usage.set(4, [
        {
          agentId: coder.id,
          model: "claude-opus-5-5",
          inputTokens: 90_000,
          outputTokens: 10_000,
          estimatedCostUsd: 0.9,
        },
        {
          agentId: coder.id,
          model: "claude-sonnet-5-5",
          inputTokens: 20_000,
          outputTokens: 1_000,
          estimatedCostUsd: 0.07,
        },
        {
          agentId: reviewer.id,
          model: "gpt-5.5",
          inputTokens: 30_000,
          outputTokens: 2_000,
          estimatedCostUsd: 0.12,
        },
      ]);
      await current.publish(merged(4));

      const recorded = await current.recorded();
      const common = {
        floorId: "web-shop",
        issue: 4,
        outcome: "merged",
        size: null,
        roundsToApproval: 2,
        qaRoundsFailed: 1,
        contractor: false,
        endedAt: current.clock.now,
      };
      expect(recorded).toEqual([
        {
          ...common,
          agentId: coder.id,
          agentName: coder.name,
          role: "coder",
          stage: "work",
          model: "claude-opus-5-5",
          stalls: 0,
          failures: 0,
          roundsReviewed: 0,
          blockingComments: 0,
          inputTokens: 90_000,
          outputTokens: 10_000,
          estimatedCostUsd: 0.9,
        },
        {
          ...common,
          agentId: coder.id,
          agentName: coder.name,
          role: "coder",
          stage: "work",
          model: "claude-sonnet-5-5",
          stalls: 0,
          failures: 0,
          roundsReviewed: 0,
          blockingComments: 0,
          inputTokens: 20_000,
          outputTokens: 1_000,
          estimatedCostUsd: 0.07,
        },
        {
          ...common,
          agentId: reviewer.id,
          agentName: reviewer.name,
          role: "reviewer",
          stage: "review",
          model: "gpt-5.5",
          stalls: 0,
          failures: 0,
          roundsReviewed: 2,
          blockingComments: 2,
          inputTokens: 30_000,
          outputTokens: 2_000,
          estimatedCostUsd: 0.12,
        },
      ]);
    },
  ],

  [
    "charges a stall and a failure to the Agent holding the work then",
    async (stores, bus) => {
      current = await setUp(stores, bus);
      const { coder } = current;
      const other: AgentRecord = {
        ...coder,
        id: "web-shop-coder-2",
        name: "Linus",
        createdAt: new Date("2026-11-20T00:00:00.000Z"),
      };
      expect(await stores.agents.create(other)).toBe("created");
      const manager = (await stores.agents.list("web-shop")).find(
        ({ role }) => role === "manager",
      );
      for (const event of worked(current, 4)) {
        await current.publish(event);
      }
      // The coder's work stalled, so the watchdog gave it to Linus, whose
      // work then failed once.
      await current.publish({
        type: "manager.decision",
        version: 1,
        floorId: "web-shop",
        issue: 4,
        agentId: manager?.id ?? "",
        action: "reassign",
        trigger: "stalled",
        stage: "needs-work",
        fromAgentId: coder.id,
        toAgentId: other.id,
      });
      await current.publish({
        type: "sandbox.started",
        version: 1,
        floorId: "web-shop",
        agentId: other.id,
        issue: 4,
        sandboxId: "sandbox-2",
        branch: "ai-office/4-add-a-basket",
      });
      await current.publish({
        type: "manager.decision",
        version: 1,
        floorId: "web-shop",
        issue: 4,
        agentId: manager?.id ?? "",
        action: "retry",
        trigger: "failing",
        stage: "needs-work",
        fromAgentId: other.id,
      });
      await current.publish(merged(4));

      const recorded = await current.recorded();
      const of = (agentId: string) =>
        recorded.find((entry) => entry.agentId === agentId);
      expect(of(coder.id)).toMatchObject({ stalls: 1, failures: 0 });
      expect(of(other.id)).toMatchObject({ stalls: 0, failures: 1 });
      expect(of(current.reviewer.id)).toMatchObject({ stalls: 0, failures: 0 });
      // The Manager, which decided, worked no Stage.
      expect(recorded.map(({ agentId }) => agentId)).not.toContain(manager?.id);
    },
  ],

  [
    "records an issue handed to the Owner as such, and the same issue merged later in its place",
    async (stores, bus) => {
      current = await setUp(stores, bus);
      for (const event of worked(current, 4)) {
        await current.publish(event);
      }
      await current.publish({
        type: "issue.label_changed",
        version: 1,
        floorId: "web-shop",
        issue: 4,
        from: "needs-review",
        to: "needs-human",
      });
      expect(
        (await current.recorded()).map(({ agentId, outcome }) => [
          agentId,
          outcome,
        ]),
      ).toEqual([
        [current.coder.id, "handed_to_owner"],
        [current.reviewer.id, "handed_to_owner"],
      ]);
      expect(await current.stores.scorecards.outcomeOf("web-shop", 4)).toBe(
        "handed_to_owner",
      );

      // The Owner approves and merges it: recorded again, as merged.
      current.clock.now = new Date("2026-11-21T10:00:00.000Z");
      await current.publish(merged(4));
      const again = await current.recorded();
      expect(again.map(({ outcome }) => outcome)).toEqual(["merged", "merged"]);
      expect(again.map(({ endedAt }) => endedAt.toISOString())).toEqual([
        "2026-11-21T10:00:00.000Z",
        "2026-11-21T10:00:00.000Z",
      ]);
    },
  ],

  [
    "records a Contractor as one, with its Role, though it has left the Floor since",
    async (stores, bus) => {
      current = await setUp(stores, bus);
      const { coder } = current;
      const contractor: AgentRecord = {
        ...coder,
        id: "web-shop-contractor-1",
        name: "Hopper",
        modelOverride: "claude-haiku-5-5",
        contractor: { kind: "research", batchId: null, oneOffRole: false },
        createdAt: new Date("2026-11-20T00:00:00.000Z"),
      };
      expect(await stores.agents.create(contractor)).toBe("created");
      await current.publish({
        type: "agent.created",
        version: 1,
        floorId: "web-shop",
        agentId: contractor.id,
        name: contractor.name,
        role: "coder",
        aiProvider: contractor.aiProvider,
        model: "claude-haiku-5-5",
      });
      await current.publish({
        type: "contractor.added",
        version: 1,
        floorId: "web-shop",
        agentId: contractor.id,
        name: contractor.name,
        role: "coder",
        roleName: "Coder",
        oneOff: false,
        kind: "research",
        managerId: "web-shop-manager",
      });
      await current.publish({
        type: "sandbox.started",
        version: 1,
        floorId: "web-shop",
        agentId: contractor.id,
        issue: 7,
        sandboxId: "sandbox-7",
        branch: "ai-office/7-fix-a-typo",
      });
      expect(
        await stores.agents.remove("web-shop", contractor.id, new Date()),
      ).toBe(true);
      await current.publish(merged(7));

      expect(await current.recorded()).toEqual([
        expect.objectContaining({
          agentId: contractor.id,
          agentName: "Hopper",
          role: "coder",
          stage: "work",
          contractor: true,
          // It made no request: its own Model stands for it.
          model: "claude-haiku-5-5",
          outcome: "merged",
        }),
      ]);
    },
  ],

  [
    "keeps the issue's Size from its triage",
    async (stores, bus) => {
      current = await setUp(stores, bus);
      await current.stores.triage.put({
        floorId: "web-shop",
        issue: 4,
        status: "clear",
        priority: "normal",
        size: "small",
        judgedBy: "model",
        agentId: null,
        fingerprint: "f".repeat(64),
        noticeId: null,
        role: "coder",
        candidates: [],
        triagedAt: new Date("2026-11-20T00:00:00.000Z"),
      });
      for (const event of worked(current, 4)) {
        await current.publish(event);
      }
      await current.publish(merged(4));
      expect((await current.recorded()).map(({ size }) => size)).toEqual([
        "small",
        "small",
      ]);
    },
  ],

  [
    "finds an issue closed without being merged, once an hour",
    async (stores, bus) => {
      current = await setUp(stores, bus);
      const { fake } = current;
      const issue = fake.createIssue(repository, {
        title: "Add a basket",
        body: "Shoppers need a basket.",
        labels: ["ai-office", "needs-work"],
      });
      await current.publish({
        type: "issue.picked_up",
        version: 1,
        floorId: "web-shop",
        issue: issue.number,
        title: issue.title,
        url: issue.htmlUrl,
      });
      for (const event of worked(current, issue.number)) {
        await current.publish(event);
      }
      // Still open: nothing to record.
      expect(await current.recorder.sweep()).toBe(0);
      await fake.repository(repository).closeIssue(issue.number);
      expect(await current.recorder.sweep()).toBe(1);
      expect(
        (await allRecords(current.stores)).map(({ outcome }) => outcome),
      ).toEqual(["closed", "closed"]);
      // Recorded once: the next sweep leaves it alone.
      expect(await current.recorder.sweep()).toBe(0);
    },
  ],
];

describe("recording a piece of work for the Scorecard, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(memoryStores(), createEventBus({ store: memoryEventStore() })),
    );
  }
});

describe("recording a piece of work for the Scorecard, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(
        databaseStores(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      ),
    );
  }
});

describe("the Scorecard's records", () => {
  it("are deleted by retention, by when their work ended", async () => {
    const stores = memoryStores();
    const entry = (issue: number, endedAt: string): ScorecardEntry => ({
      floorId: "web-shop",
      issue,
      agentId: "ada",
      agentName: "Ada",
      role: "coder",
      stage: "work",
      contractor: false,
      model: "claude-opus-5-5",
      size: null,
      outcome: "merged",
      roundsToApproval: 1,
      qaRoundsFailed: 0,
      stalls: 0,
      failures: 0,
      roundsReviewed: 0,
      blockingComments: 0,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      endedAt: new Date(endedAt),
    });
    await stores.scorecards.record("web-shop", 1, [
      entry(1, "2025-10-01T00:00:00.000Z"),
    ]);
    await stores.scorecards.record("web-shop", 2, [
      entry(2, "2026-11-01T00:00:00.000Z"),
    ]);
    expect(
      await stores.scorecards.deleteBefore(new Date("2026-01-01T00:00:00Z")),
    ).toBe(1);
    expect(stores.scorecards.entries.map(({ issue }) => issue)).toEqual([2]);
  });
});

describe("adding the records up", () => {
  const names = {
    floor: (id: string) => (id === "web-shop" ? "Web shop" : id),
    role: (id: string) => ({ coder: "Coder", reviewer: "Reviewer" })[id] ?? id,
  };
  const at = new Date("2026-11-20T00:00:00.000Z");
  const row = (
    fields: Partial<ScorecardEntry> &
      Pick<ScorecardEntry, "issue" | "agentId" | "model">,
  ): ScorecardEntry => ({
    floorId: "web-shop",
    agentName: fields.agentId === "ada" ? "Ada" : "Grace",
    role: "coder",
    stage: "work",
    contractor: false,
    size: "medium",
    outcome: "merged",
    roundsToApproval: 1,
    qaRoundsFailed: 0,
    stalls: 0,
    failures: 0,
    roundsReviewed: 0,
    blockingComments: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    endedAt: at,
    ...fields,
  });
  const rows = [
    // Ada merged #1 in 1 round and #2 in 2 (one QA failure, one stall),
    // and handed #3 to the Owner; #2's requests went to two Models.
    row({
      issue: 1,
      agentId: "ada",
      model: "opus",
      size: "small",
      inputTokens: 900,
      outputTokens: 100,
      estimatedCostUsd: 0.5,
    }),
    row({
      issue: 2,
      agentId: "ada",
      model: "opus",
      roundsToApproval: 2,
      qaRoundsFailed: 1,
      stalls: 1,
      inputTokens: 1800,
      outputTokens: 200,
      estimatedCostUsd: 1,
    }),
    row({
      issue: 2,
      agentId: "ada",
      model: "sonnet",
      roundsToApproval: 2,
      qaRoundsFailed: 1,
      inputTokens: 500,
      outputTokens: 0,
      estimatedCostUsd: 0.1,
    }),
    row({
      issue: 3,
      agentId: "ada",
      model: "opus",
      outcome: "handed_to_owner",
      roundsToApproval: null,
      size: "large",
      failures: 2,
      inputTokens: 400,
      outputTokens: 100,
      estimatedCostUsd: 0.2,
    }),
    // Grace reviewed #1 once and #2 twice, with three blocking comments.
    row({
      issue: 1,
      agentId: "grace",
      model: "gpt",
      role: "reviewer",
      stage: "review",
      roundsReviewed: 1,
      inputTokens: 100,
      estimatedCostUsd: 0.05,
    }),
    row({
      issue: 2,
      agentId: "grace",
      model: "gpt",
      role: "reviewer",
      stage: "review",
      roundsReviewed: 2,
      blockingComments: 3,
      inputTokens: 200,
      estimatedCostUsd: 0.1,
    }),
  ];

  it("gives work Agents their issues merged, rounds, QA failures, stalls, failures, hand-offs and cost per merged issue", () => {
    const { work, review } = scorecardOf(rows, "agent", names);
    expect(work).toEqual([
      {
        key: "ada",
        label: "Ada",
        floorId: "web-shop",
        issues: 3,
        issuesMerged: 2,
        meanRoundsToApproval: 1.5,
        // #2's failure counts once, though two rows hold it.
        qaRoundsFailed: 1,
        stalls: 1,
        failures: 2,
        handedToOwner: 1,
        tokens: 4000,
        estimatedCostUsd: 1.8,
        tokensPerMergedIssue: 2000,
        costPerMergedIssue: 0.9,
      },
    ]);
    expect(review).toEqual([
      {
        key: "grace",
        label: "Grace",
        floorId: "web-shop",
        issues: 2,
        roundsReviewed: 3,
        blockingComments: 3,
        blockingPerRound: 1,
        tokens: 300,
        estimatedCostUsd: 0.15,
      },
    ]);
  });

  it("counts work toward the Model that served it", () => {
    const { work } = scorecardOf(rows, "model", names);
    expect(
      work.map(({ key, issues, issuesMerged, tokens }) => [
        key,
        issues,
        issuesMerged,
        tokens,
      ]),
    ).toEqual([
      ["opus", 3, 2, 3500],
      ["sonnet", 1, 1, 500],
    ]);
  });

  it("breaks down by Role, by Floor and by Size, smallest first", () => {
    expect(
      scorecardOf(rows, "role", names).work.map(({ label }) => label),
    ).toEqual(["Coder"]);
    expect(
      scorecardOf(rows, "role", names).review.map(({ label }) => label),
    ).toEqual(["Reviewer"]);
    expect(
      scorecardOf(rows, "floor", names).work.map(({ label }) => label),
    ).toEqual(["Web shop"]);
    expect(
      scorecardOf(rows, "size", names).work.map(({ key, label, issues }) => [
        key,
        label,
        issues,
      ]),
    ).toEqual([
      ["small", "Small", 1],
      ["medium", "Medium", 1],
      ["large", "Large", 1],
    ]);
  });

  it("says nothing per merged issue when none merged, and nothing per round when none was reviewed", () => {
    const { work, review } = scorecardOf(
      [
        row({ issue: 9, agentId: "ada", model: "opus", outcome: "closed" }),
        row({
          issue: 9,
          agentId: "grace",
          model: "gpt",
          stage: "review",
          role: "reviewer",
        }),
      ],
      "agent",
      names,
    );
    expect(work[0]).toMatchObject({
      issuesMerged: 0,
      tokensPerMergedIssue: null,
      costPerMergedIssue: null,
    });
    expect(review[0]).toMatchObject({
      roundsReviewed: 0,
      blockingPerRound: null,
    });
  });

  it("gives an Agent's card its one line: merged, rounds and cost an issue", () => {
    expect(agentScorecardOf("ada", rows, 30)).toEqual({
      agentId: "ada",
      days: 30,
      stage: "work",
      issues: 3,
      issuesMerged: 2,
      meanRoundsToApproval: 1.5,
      costPerMergedIssue: 0.9,
      roundsReviewed: 0,
      blockingPerRound: null,
    });
    expect(agentScorecardOf("nobody", rows, 30)).toMatchObject({
      issues: 0,
      issuesMerged: 0,
      stage: null,
    });
  });
});
