import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  chatRequestFence,
  createRedactor,
  defaultIntakeSettings,
  type ChatRequest,
  type RecurringGoalInput,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createAgents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createBatches, type Batches } from "../batches/batches.ts";
import { createFloors } from "../floors/floors.ts";
import type { FactFinder, FactRequest } from "../grilling/fact-finding.ts";
import { managerChatIssues, managerOpenIssues } from "../manager/authority.ts";
import { modelRequestBindingCheck } from "../manager/request-binding.ts";
import { createChatRequests } from "../manager/requests.ts";
import { createTriage } from "../manager/triage.ts";
import { createFakeModel, type FakeModel } from "../models/fake-model.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createWorkQueue } from "../work/queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import {
  createRecurringGoals,
  type RecurringGoals,
} from "./recurring-goals.ts";

// Recurring Goals, end to end (Scorecards PRD, FR-136 to FR-141; ADR
// 0018): a Floor on the fake GitHub, whose Manager's Model the test
// scripts. A run files issues by the chat request's path and proposes a
// Plan that waits for the Owner; a second run is skipped while it waits;
// an issue an earlier run filed is never filed again; three failures turn
// it off. A run may add one research Contractor, which it lets go once it
// has filed, but not a second; and it stops at its per-run Token Cap.
// Each case runs in memory and in Postgres 18.

const webShop = "adrianeyre/web-shop";
const start = new Date("2026-11-27T10:00:00.000Z");

/** A decision, as the Manager's Model writes it. */
const decision = (value: ChatRequest): string =>
  `${chatRequestFence}\n${JSON.stringify(value, null, 2)}\n\`\`\``;

const issue = (title: string) => ({
  title,
  body: `${title}, end to end.`,
  acceptanceCriteria: [`${title} has tests.`],
  dependsOn: [],
  files: [],
  role: "coder",
});

const filing = (...titles: string[]) =>
  decision({
    decision: "batch",
    message: "Modules without tests, one issue each.",
    roles: [],
    issues: titles.map(issue),
    onePullRequest: false,
  });

const research = decision({
  decision: "research",
  message: "I'll have the modules read first.",
  role: {
    name: "Test gap researcher",
    description: "Reads the repository for modules without tests.",
    instructions: "List each module with no test file beside it.",
  },
  questions: ["Which modules have no tests?"],
});

const weeklyGaps: RecurringGoalInput = {
  name: "Weekly test gaps",
  words: "Find modules without tests and file an issue for each.",
  schedule: { frequency: "weekly", days: [1], time: "09:00" },
  tokenCap: null,
  enabled: true,
};

interface Setup {
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly model: FakeModel;
  readonly notices: Notices;
  readonly batches: Batches;
  readonly goals: RecurringGoals;
  readonly manager: AgentRecord;
  readonly events: OfficeEvent[];
  readonly found: FactRequest[];
  /** The tokens the Gateway counts for the run's Agents. */
  readonly usage: { tokens: number };
  readonly clock: { at: number };
  /** Runs the Recurring Goal now, and waits for the run to end. */
  run(id: number): Promise<void>;
  /** The events of `type`, oldest first. */
  ofType<Type extends OfficeEvent["type"]>(
    type: Type,
  ): Extract<OfficeEvent, { type: Type }>[];
}

async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  const clock = { at: start.getTime() };
  const now = () => new Date((clock.at += 10));
  await createFloors({ store: stores.floors, github, events: bus, now }).add(
    webShop,
  );
  const [manager] = (await stores.agents.list("web-shop")).filter(
    ({ role }) => role === "manager",
  );
  if (manager === undefined) {
    throw new Error("The Floor has no Manager.");
  }
  const events: OfficeEvent[] = [];
  bus.subscribe(({ event }) => {
    events.push(event);
  });
  const model = createFakeModel();
  const binder = createFakeModel({ otherwise: '{"bound": true}' });
  const redactor = createRedactor();
  const notices = createNotices({
    store: stores.notices,
    events: bus,
    redactor,
    now,
  });
  const triage = createTriage({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    notices,
    events: bus,
    store: stores.triage,
    roles: stores.roles,
    redactor,
    now,
  });
  // Work is queued; none of it starts in these tests.
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    now,
  });
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    roles: stores.roles,
    work: workStore,
    now,
  });
  const batches = createBatches({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    store: stores.batches,
    work: workStore,
    pipeline: createPipeline({ github, events: bus }),
    queue,
    events: bus,
    notices,
    triage,
    settings: () => Promise.resolve(defaultIntakeSettings),
    publicUrl: "https://office.example",
    redactor,
    now,
  });
  const found: FactRequest[] = [];
  const facts: FactFinder = {
    find(request) {
      found.push(request);
      return Promise.resolve({
        status: "found",
        answer: "src/basket.ts and src/prices.ts have no tests.",
      });
    },
  };
  const requests = createChatRequests({
    agents,
    binding: modelRequestBindingCheck({ models: binder }),
    agentStore: stores.agents,
    roles: stores.roles,
    issues: managerChatIssues(github),
    openIssues: managerOpenIssues(github),
    batches,
    work: workStore,
    sandboxLimit: () => Promise.resolve(3),
    facts,
    onFiled: async (filed) => {
      await bus.publish({
        type: "manager.issue_filed",
        version: 1,
        floorId: filed.floorId,
        issue: filed.issue,
        agentId: filed.managerId,
        title: filed.title,
        url: filed.url,
        messageId: filed.messageId,
      });
    },
    now,
  });
  const usage = { tokens: 0 };
  const goals = createRecurringGoals({
    store: stores.recurringGoals,
    floors: stores.floors,
    agents: stores.agents,
    batches: stores.batches,
    requests,
    release: (floorId, agentId) => agents.release(floorId, agentId),
    models: model,
    github,
    chat: {
      keep: (floorId, text) =>
        stores.managerChat.append({
          floorId,
          kind: "owner",
          text,
          command: null,
          replyTo: null,
          agentId: null,
          model: null,
          createdAt: now(),
        }),
      say: async (floorId, kind, text, replyTo) => {
        await stores.managerChat.append({
          floorId,
          kind,
          text,
          command: null,
          replyTo,
          agentId: manager.id,
          model: null,
          createdAt: now(),
        });
      },
    },
    notices,
    events: bus,
    timeZone: () => Promise.resolve("Europe/London"),
    officeTokenCap: () => Promise.resolve(5_000_000),
    tokensUsed: () => Promise.resolve(usage.tokens),
    capPollMs: 5,
    now,
  });
  return {
    github,
    stores,
    model,
    notices,
    batches,
    goals,
    manager,
    events,
    found,
    usage,
    clock,
    async run(id) {
      await goals.runNow("web-shop", id);
      await goals.idle();
    },
    ofType: <Type extends OfficeEvent["type"]>(type: Type) =>
      events.filter(
        (event): event is Extract<OfficeEvent, { type: Type }> =>
          event.type === type,
      ),
  };
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

/** The Recurring Goal made, by its id. */
const made = async (setup: Setup, input = weeklyGaps): Promise<number> =>
  (await setup.goals.create("web-shop", input)).id;

const cases: Case[] = [
  [
    "a run files issues by the chat request's path and proposes a Plan that waits for the Owner, with an action Notice",
    async (setup) => {
      const { github, model, manager, stores, goals } = setup;
      const id = await made(setup);
      model.answer(manager.id, filing("Test the basket", "Test the prices"));
      await setup.run(id);

      // Two issues, filed as a chat request's are, labelled ai-office.
      const filed = (
        await github.repository(webShop).listIssues({ state: "all" })
      )
        .filter(({ title }) => title.startsWith("Test the"))
        .sort((a, b) => a.number - b.number);
      expect(filed.map(({ title }) => title)).toEqual([
        "Test the basket",
        "Test the prices",
      ]);
      expect(filed.every(({ labels }) => labels.includes("ai-office"))).toBe(
        true,
      );
      expect(
        (await github.repository(webShop).listComments(filed[0]?.number ?? 0))
          .map(({ body }) => body)
          .join("\n"),
      ).toContain(
        'filed this issue for the Owner\'s Recurring Goal "Weekly test gaps"',
      );

      // Its Plan waits for the Owner: never approved by the Goal.
      const [batch] = await stores.batches.open("web-shop");
      expect(batch?.status).toBe("awaiting_approval");
      expect(setup.ofType("batch.approved")).toEqual([]);
      expect(
        (await setup.notices.open()).map(({ kind, title }) => [kind, title]),
      ).toContainEqual([
        "action",
        `Plan awaiting approval on web-shop: Batch ${String(batch?.id)}, 2 issues`,
      ]);
      // Nothing started: no work is queued.
      expect(
        setup
          .ofType("issue.label_changed")
          .filter(({ to }) => to === "needs-work"),
      ).toEqual([]);

      const [listed] = await goals.list("web-shop");
      expect(listed?.lastRun).toMatchObject({
        outcome: "planned",
        batchId: batch?.id,
        issues: filed.map(({ number }) => number),
      });
      expect(
        setup.ofType("recurring_goal.run_started").map(({ by }) => by),
      ).toEqual(["owner"]);
      expect(setup.ofType("recurring_goal.run_finished")).toEqual([
        expect.objectContaining({
          name: "Weekly test gaps",
          batchId: batch?.id,
          issues: filed.map(({ number }) => number),
        }),
      ]);
      // The Goal's words are in the Manager chat, as the Owner's /goal,
      // and the Manager's Plan answers them.
      const chat = await stores.managerChat.latest("web-shop", 20);
      const asked = chat.find(({ kind }) => kind === "owner");
      expect(asked?.text).toBe(`/goal ${weeklyGaps.words}`);
      expect(
        chat.find(
          ({ replyTo, kind }) => replyTo === asked?.id && kind === "plan",
        )?.text,
      ).toContain("whose Plan waits for your approval on the whiteboard");

      // A second run is skipped while that Plan waits, asking no model.
      const asks = model.requestsOf(manager.id).length;
      await setup.run(id);
      expect(model.requestsOf(manager.id)).toHaveLength(asks);
      expect(setup.ofType("recurring_goal.run_skipped")).toEqual([
        expect.objectContaining({ reason: "plan_awaiting_approval" }),
      ]);
      expect((await goals.list("web-shop"))[0]?.lastRun).toMatchObject({
        outcome: "skipped",
        reason: "its last Plan still awaits your approval",
      });
      // Once the Owner approves it, it runs: skipped again while it runs.
      const approved = await setup.batches.approve(
        "web-shop",
        batch?.id ?? 0,
        1,
      );
      expect(approved.started.length).toBeGreaterThan(0);
      await setup.run(id);
      expect(
        setup.ofType("recurring_goal.run_skipped").map(({ reason }) => reason),
      ).toEqual(["plan_awaiting_approval", "batch_running"]);
    },
  ],
  [
    "an issue an earlier run filed, still open, is not filed again: the Manager is told of it, and plain code refuses it",
    async (setup) => {
      const { github, model, manager, stores } = setup;
      const id = await made(setup);
      // An earlier run filed "Test the basket", still open; its Batch is
      // long done.
      const earlier = github.createIssue(webShop, {
        title: "Test the basket",
        body: "Filed before.",
        labels: ["ai-office"],
      });
      const goal = await stores.recurringGoals.get("web-shop", id);
      if (goal === undefined) {
        throw new Error("No Recurring Goal.");
      }
      const run = await stores.recurringGoals.startRun(goal, start);
      await stores.recurringGoals.endRun(
        run.id,
        {
          outcome: "planned",
          reason: "",
          batchId: null,
          issues: [earlier.number],
          tokens: 0,
        },
        start,
      );
      model.answer(manager.id, filing("TEST THE BASKET", "Test the prices"));
      await setup.run(id);
      const [asked] = model.requestsOf(manager.id);
      expect(asked?.system).toContain(
        `- #${String(earlier.number)}: Test the basket`,
      );
      expect(asked?.system).toContain("Never file them again");
      // Only the new one is filed.
      expect(
        (await github.repository(webShop).listIssues({ state: "all" })).filter(
          ({ title }) => title.toLowerCase() === "test the basket",
        ),
      ).toHaveLength(1);
      const prices = (
        await github.repository(webShop).listIssues({ state: "all" })
      ).find(({ title }) => title === "Test the prices");
      expect((await setup.goals.list("web-shop"))[0]?.lastRun?.issues).toEqual([
        prices?.number,
      ]);
    },
  ],
  [
    "three failed runs in a row turn it off, each with an info Notice, the last with an action Notice",
    async (setup) => {
      const { model, manager } = setup;
      const id = await made(setup);
      const unclear = decision({
        decision: "clarify",
        question: "Which modules count?",
      });
      model.answer(manager.id, unclear, unclear, unclear);
      for (let run = 0; run < 3; run += 1) {
        await setup.run(id);
      }
      expect(
        setup
          .ofType("recurring_goal.run_failed")
          .map(({ failures, turnedOff }) => [failures, turnedOff]),
      ).toEqual([
        [1, false],
        [2, false],
        [3, true],
      ]);
      const notices = await setup.notices.open();
      // An info Notice says why (one, as the same Notice open is not
      // raised twice).
      expect(
        notices.some(
          ({ kind, title }) =>
            kind === "info" &&
            title.startsWith(
              'The Recurring Goal "Weekly test gaps" on web-shop failed',
            ),
        ),
      ).toBe(true);
      expect(notices).toContainEqual(
        expect.objectContaining({
          kind: "action",
          title:
            'The Recurring Goal "Weekly test gaps" on web-shop is off: its last 3 runs failed',
        }),
      );
      const [goal] = await setup.goals.list("web-shop");
      expect(goal).toMatchObject({
        enabled: false,
        failures: 3,
        nextRunAt: null,
      });
      expect(setup.ofType("recurring_goal.changed")).toEqual([
        expect.objectContaining({ by: "failures", enabled: false }),
      ]);
      // Turned on again by the Owner, its failures are forgotten.
      const on = await setup.goals.update("web-shop", id, { enabled: true });
      expect(on).toMatchObject({ enabled: true, failures: 0 });
      expect(on.nextRunAt).not.toBeNull();
    },
  ],
  [
    "a run is skipped while the Manager is paused",
    async (setup) => {
      const { stores, manager, model } = setup;
      const id = await made(setup);
      await stores.agents.update({ ...manager, enabled: false });
      await setup.run(id);
      expect(model.requests).toEqual([]);
      expect(setup.ofType("recurring_goal.run_skipped")).toEqual([
        expect.objectContaining({ reason: "manager_paused" }),
      ]);
    },
  ],
  [
    "a run adds one research Contractor, which changes nothing, and lets it go once it has filed its issues (FR-138)",
    async (setup) => {
      const { model, manager, found } = setup;
      const id = await made(setup);
      model.answer(manager.id, research, filing("Test the basket"));
      await setup.run(id);
      const added = setup.ofType("contractor.added");
      expect(added.map(({ kind }) => kind)).toEqual(["research"]);
      expect(found.map(({ question }) => question)).toEqual([
        "Which modules have no tests?",
      ]);
      // Asked again, knowing what it found.
      expect(model.requestsOf(manager.id)[1]?.system).toContain(
        "src/basket.ts and src/prices.ts have no tests.",
      );
      // It left after the issue was filed, not before.
      const order = setup.events.map((event) =>
        event.type === "manager.issue_filed" ||
        (event.type === "agent.removed" && event.agentId === added[0]?.agentId)
          ? event.type
          : undefined,
      );
      const filedAt = order.indexOf("manager.issue_filed");
      const leftAt = order.indexOf("agent.removed");
      expect(filedAt).toBeGreaterThanOrEqual(0);
      expect(leftAt).toBeGreaterThan(filedAt);
      expect((await setup.goals.list("web-shop"))[0]?.lastRun?.outcome).toBe(
        "planned",
      );
    },
  ],
  [
    "a second research Contractor is refused: the run fails, and the one it had leaves",
    async (setup) => {
      const { model, manager } = setup;
      const id = await made(setup);
      model.answer(manager.id, research, research);
      await setup.run(id);
      expect(setup.ofType("contractor.added")).toHaveLength(1);
      expect(setup.ofType("recurring_goal.run_failed")).toEqual([
        expect.objectContaining({
          reason: `${manager.name} asked for a second research Contractor, and a run may add only one`,
        }),
      ]);
      expect(
        setup.ofType("agent.removed").map(({ agentId }) => agentId),
      ).toContain(setup.ofType("contractor.added")[0]?.agentId);
    },
  ],
  [
    "a run that reaches its per-run Token Cap stops, and fails with a Notice",
    async (setup) => {
      const { model, manager, usage } = setup;
      const id = await made(setup, { ...weeklyGaps, tokenCap: 50_000 });
      // The research costs it more than its cap, while it runs.
      model.answer(manager.id, research, filing("Test the basket"));
      const watched = setup.found;
      const realFind = watched.push.bind(watched);
      watched.push = (...requests) => {
        usage.tokens = 60_000;
        return realFind(...requests);
      };
      await setup.run(id);
      expect(setup.ofType("recurring_goal.run_failed")).toEqual([
        expect.objectContaining({
          reason: "it reached its per-run Token Cap of 50,000 tokens",
          tokens: 60_000,
        }),
      ]);
      // Nothing was filed.
      expect(setup.ofType("manager.issue_filed")).toEqual([]);
      expect(await setup.notices.open()).toContainEqual(
        expect.objectContaining({
          kind: "info",
          title:
            'The Recurring Goal "Weekly test gaps" on web-shop failed: it reached its per-run Token Cap of 50,000 tokens',
        }),
      );
    },
  ],
  [
    "comes round on its schedule: due runs run, and the next is counted from then",
    async (setup) => {
      const { model, manager, stores, goals, clock } = setup;
      // Friday 27 November 2026; it comes round on Mondays at 09:00.
      const id = await made(setup);
      const goal = await stores.recurringGoals.get("web-shop", id);
      expect(goal?.nextRunAt?.toISOString()).toBe("2026-11-30T09:00:00.000Z");
      await goals.runDue();
      expect(setup.ofType("recurring_goal.run_started")).toEqual([]);
      clock.at = Date.parse("2026-11-30T09:00:00.000Z");
      model.answer(manager.id, filing("Test the basket"));
      await goals.runDue();
      await goals.idle();
      expect(
        setup.ofType("recurring_goal.run_started").map(({ by }) => by),
      ).toEqual(["schedule"]);
      expect(
        (
          await stores.recurringGoals.get("web-shop", id)
        )?.nextRunAt?.toISOString(),
      ).toBe("2026-12-07T09:00:00.000Z");
    },
  ],
];

describe("Recurring Goals, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      await run(
        await setUp(
          stores,
          memoryWorkQueueStore(stores.floors),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("Recurring Goals, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          databaseWorkQueueStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});
