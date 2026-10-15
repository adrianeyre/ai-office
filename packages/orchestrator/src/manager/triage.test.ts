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
  defaultDecisionModelSettings,
  defaultIntakeSettings,
  triageActions,
  type DecisionModelSettings,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createDecisionModel } from "../decision-model/decision-model.ts";
import {
  choice,
  createFakeDecisionModel,
  noul,
  type FakeDecisionModel,
} from "../decision-model/fake-decision-model.ts";
import { createFloors } from "../floors/floors.ts";
import { createIntake, type Intake } from "../intake/intake.ts";
import { ModelCallError } from "../models/client.ts";
import { createFakeModel, type FakeModel } from "../models/fake-model.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createWorkQueue, type WorkQueue } from "../work/queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { createTriage, triageCommentMarker, type Triage } from "./triage.ts";

// The Manager's triage (PRD FR-23, FR-49) as scenarios, with a fake model
// standing in for the Manager's Model behind the AI Gateway, the fake
// GitHub, and intake and the work queue as the server runs them: a clear
// issue goes into the pipeline at the priority the Manager set; a vague one
// raises an action Notice, is commented on, and waits until the Owner
// edits it or has it worked as it is. With the Decision Model on (FR-17),
// a fake Jev triages in the Manager's Model's place; off, as it is until
// the Owner turns it on, Jev is never asked. Each case runs in memory and
// in Postgres 18.

const webShop = "adrianeyre/web-shop";
const anthropicKey = "sk-ant-api03-pastedintoanissue-Qw3Er4Ty5Ui6Op7As8Df9";

const clearIssue = {
  title: "Add a basket",
  body: [
    "Shoppers can put products in a basket and see its total.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] An Add to basket button on each product page",
    "- [ ] The basket page lists the products and their total",
  ].join("\n"),
  labels: ["ai-office"],
};

const vagueIssue = {
  title: "Make the shop better",
  body: "It feels slow and dated. Improve it.",
  labels: ["ai-office"],
};

const triageAnswer = (answer: {
  clear: boolean;
  priority: "high" | "normal" | "low";
  reason: string;
  questions?: string[];
}): string => JSON.stringify({ questions: [], ...answer });

interface Setup {
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly bus: EventBus;
  readonly model: FakeModel;
  /** Jev, asked only while the Decision Model is on. */
  readonly jev: FakeDecisionModel;
  /** Turns the Decision Model on (off by default). */
  setDecisionModel(settings: DecisionModelSettings): void;
  readonly notices: Notices;
  readonly triage: Triage;
  readonly intake: Intake;
  readonly queue: WorkQueue;
  readonly workStore: WorkQueueStore;
  readonly manager: AgentRecord;
  /** The issue's labels on GitHub. */
  labels(issue: number): Promise<readonly string[]>;
  /** The issue's comments' bodies, oldest first. */
  comments(issue: number): Promise<string[]>;
  /** The queued work: each issue's stage and priority. */
  queued(): Promise<{ issue: number; stage: string; priority: string }[]>;
  /** The `issue.triaged` events, oldest first. */
  triaged(): Promise<OfficeEvent[]>;
}

async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  await createFloors({ store: stores.floors, github, events: bus }).add(
    webShop,
  );
  const manager = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "manager",
  );
  if (manager === undefined) {
    throw new Error("The Floor has no Manager.");
  }
  const model = createFakeModel();
  const jev = createFakeDecisionModel();
  let decisionSettings = defaultDecisionModelSettings;
  const notices = createNotices({ store: stores.notices, events: bus });
  const triage = createTriage({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    decisionModel: createDecisionModel({
      settings: () => Promise.resolve(decisionSettings),
      client: jev,
      agents: stores.agents,
    }),
    notices,
    events: bus,
    store: stores.triage,
  });
  // No `execute`: work is queued, and nothing starts.
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    issuePriority: (floorId, issue) => triage.priority(floorId, issue),
  });
  const intake = createIntake({
    floors: stores.floors,
    github,
    pipeline: createPipeline({ github, events: bus }),
    queue,
    events: bus,
    settings: () => Promise.resolve(defaultIntakeSettings),
    triage,
  });
  const repository = github.repository(webShop);
  return {
    github,
    stores,
    bus,
    model,
    jev,
    setDecisionModel: (settings) => {
      decisionSettings = settings;
    },
    notices,
    triage,
    intake,
    queue,
    workStore,
    manager,
    labels: async (issue) => (await repository.getIssue(issue)).labels,
    comments: async (issue) =>
      (await repository.listComments(issue)).map(({ body }) => body),
    queued: async () =>
      (await workStore.active()).map(({ issue, stage, priority }) => ({
        issue,
        stage,
        priority,
      })),
    triaged: async () =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(({ type }) => type === "issue.triaged"),
  };
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const decisionModelOn: DecisionModelSettings = {
  enabled: true,
  model: "typesafe/jev-1.13",
  summaries: false,
};

const cases: Case[] = [
  [
    "with the Decision Model off, Jev is never asked: the Manager's Model triages as it always has",
    async (setup) => {
      const { github, model, jev, manager, intake } = setup;
      const issue = github.createIssue(webShop, clearIssue);
      model.answer(
        manager.id,
        triageAnswer({ clear: true, priority: "low", reason: "Clear." }),
      );
      expect((await intake.poll()).pickedUp).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(jev.requests).toEqual([]);
      expect(model.requestsOf(manager.id)).toHaveLength(1);
      expect(await setup.triaged()).toMatchObject([
        { outcome: "clear", priority: "low", judgedBy: "model" },
      ]);
    },
  ],
  [
    "with the Decision Model on, Jev triages a clear issue in the Manager's Model's place, with the Manager's Gateway Key",
    async (setup) => {
      const { github, model, jev, manager, intake } = setup;
      setup.setDecisionModel(decisionModelOn);
      const issue = github.createIssue(webShop, clearIssue);
      jev.answer(manager.id, {
        clear: noul(0.93),
        priority: choice("high"),
        gap: choice("nothing"),
      });

      expect((await intake.poll()).pickedUp).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(await setup.queued()).toEqual([
        { issue: issue.number, stage: "needs-work", priority: "high" },
      ]);
      // Jev, not the Manager's own Model.
      expect(model.requests).toEqual([]);
      expect(jev.requests).toMatchObject([
        {
          agentId: manager.id,
          model: "typesafe/jev-1.13",
          issue: issue.number,
          state: { issue: `#${String(issue.number)} Add a basket` },
        },
      ]);

      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain("### Triage: clear to work");
      expect(comment).toContain(
        `${manager.name} (the Manager) triaged this issue with the Decision Model: it is clear enough to work, at **high** priority.`,
      );
      expect(comment).toContain(
        "> The Decision Model judged it clear enough to work (93% likely).",
      );
      expect(await setup.triaged()).toEqual([
        {
          type: "issue.triaged",
          version: 1,
          floorId: "web-shop",
          issue: issue.number,
          agentId: manager.id,
          outcome: "clear",
          priority: "high",
          judgedBy: "decision_model",
        },
      ]);
      expect(await setup.notices.open()).toEqual([]);
    },
  ],
  [
    "with the Decision Model on, an issue Jev judges unclear waits, asking the Owner for what it lacks",
    async (setup) => {
      const { github, model, jev, manager, intake } = setup;
      setup.setDecisionModel(decisionModelOn);
      const issue = github.createIssue(webShop, vagueIssue);
      jev.answer(manager.id, {
        clear: noul(0.08),
        priority: choice("normal"),
        gap: choice("done"),
      });

      expect((await intake.poll()).waiting).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(model.requests).toEqual([]);
      expect(await setup.labels(issue.number)).toEqual(["ai-office"]);
      expect(await setup.notices.open()).toMatchObject([
        {
          kind: "action",
          title: `Unclear issue needs your input: #${String(issue.number)} Make the shop better`,
          agentId: manager.id,
        },
      ]);
      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain("### Triage: waiting for the Owner");
      expect(comment).toContain(
        "> The Decision Model judged it not clear enough to work (8% likely to be clear).",
      );
      expect(comment).toContain(
        "1. What are its acceptance criteria: how will we tell that it is done?",
      );
      expect(await setup.triaged()).toMatchObject([
        { outcome: "unclear", judgedBy: "decision_model" },
      ]);
    },
  ],
  [
    "with the Decision Model on but unable to answer, the Manager's Model triages instead",
    async (setup) => {
      const { github, model, jev, manager, intake } = setup;
      setup.setDecisionModel(decisionModelOn);
      const issue = github.createIssue(webShop, clearIssue);
      jev.answer(
        manager.id,
        new ModelCallError(
          503,
          "The AI Gateway answered 503: No AI Account is available.",
        ),
      );
      model.answer(
        manager.id,
        triageAnswer({ clear: true, priority: "normal", reason: "Clear." }),
      );
      expect((await intake.poll()).pickedUp).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(jev.requests).toHaveLength(1);
      expect(model.requests).toHaveLength(1);
      expect(await setup.triaged()).toMatchObject([
        { outcome: "clear", judgedBy: "model" },
      ]);
    },
  ],
  [
    "a clear issue proceeds: into the pipeline, queued at the priority the Manager set, with its decision on the issue",
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issue = github.createIssue(webShop, clearIssue);
      model.answer(
        manager.id,
        triageAnswer({
          clear: true,
          priority: "high",
          reason: "It has acceptance criteria, and it is one page's work.",
        }),
      );

      expect(await intake.poll()).toEqual({
        pickedUp: [{ floorId: "web-shop", issue: issue.number }],
        ignored: [],
        waiting: [],
        failed: [],
      });
      expect(await setup.labels(issue.number)).toEqual([
        "ai-office",
        "needs-work",
      ]);
      expect(await setup.queued()).toEqual([
        { issue: issue.number, stage: "needs-work", priority: "high" },
      ]);

      // The Manager's own Model, through its Gateway Key, for this issue.
      const [request] = model.requestsOf(manager.id);
      expect(model.requests).toHaveLength(1);
      expect(request).toMatchObject({
        agentId: manager.id,
        model: "claude-opus-5-5",
        issue: issue.number,
      });
      expect(request?.system).toContain(
        `You are ${manager.name}, the Manager of the Floor "web-shop"`,
      );
      expect(request?.messages[0]?.content).toContain(
        "- [ ] An Add to basket button on each product page",
      );

      // Every Manager decision is a comment on the issue, and an event.
      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain(triageCommentMarker);
      expect(comment).toContain("### Triage: clear to work");
      expect(comment).toContain(
        `${manager.name} (the Manager) triaged this issue: it is clear enough to work, at **high** priority.`,
      );
      expect(comment).toContain(
        "> It has acceptance criteria, and it is one page's work.",
      );
      expect(await setup.triaged()).toEqual([
        {
          type: "issue.triaged",
          version: 1,
          floorId: "web-shop",
          issue: issue.number,
          agentId: manager.id,
          outcome: "clear",
          priority: "high",
          judgedBy: "model",
        },
      ]);
      // No Notice: nothing needs the Owner.
      expect(await setup.notices.open()).toEqual([]);

      // Once in the pipeline, it is not triaged again.
      expect((await intake.poll()).pickedUp).toEqual([]);
      expect(model.requests).toHaveLength(1);
    },
  ],
  [
    "a vague issue raises an action Notice, is commented on with the Manager's questions, and waits",
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issue = github.createIssue(webShop, vagueIssue);
      model.answer(
        manager.id,
        triageAnswer({
          clear: false,
          priority: "normal",
          reason: "It names no change to make and no way to tell it is done.",
          questions: [
            "Which pages feel slow, and how fast should they load?",
            "What should change about how the shop looks?",
          ],
        }),
      );

      expect(await intake.poll()).toEqual({
        pickedUp: [],
        ignored: [],
        waiting: [{ floorId: "web-shop", issue: issue.number }],
        failed: [],
      });
      // Out of the pipeline, and no work queued.
      expect(await setup.labels(issue.number)).toEqual(["ai-office"]);
      expect(await setup.queued()).toEqual([]);

      const [notice, ...others] = await setup.notices.open({
        floorId: "web-shop",
      });
      expect(others).toEqual([]);
      expect(notice).toMatchObject({
        kind: "action",
        title: `Unclear issue needs your input: #${String(issue.number)} Make the shop better`,
        floorId: "web-shop",
        agentId: manager.id,
        issue: { number: issue.number, url: issue.htmlUrl },
        actions: [{ id: triageActions.workAsItIs, label: "Work it as it is" }],
      });

      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain("### Triage: waiting for the Owner");
      expect(comment).toContain(
        `${manager.name} (the Manager) triaged this issue: it is not clear enough to work yet, so work on it waits.`,
      );
      expect(comment).toContain(
        "> It names no change to make and no way to tell it is done.",
      );
      expect(comment).toContain(
        "1. Which pages feel slow, and how fast should they load?\n2. What should change about how the shop looks?",
      );
      expect(comment).toContain("Edit the issue to answer them");
      expect(await setup.triaged()).toMatchObject([
        { outcome: "unclear", judgedBy: "model", agentId: manager.id },
      ]);

      // It waits: later checks ask no model, raise no Notice and write no
      // comment while the issue is unchanged.
      expect((await intake.poll()).waiting).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(model.requests).toHaveLength(1);
      expect(await setup.notices.open()).toHaveLength(1);
      expect(await setup.comments(issue.number)).toHaveLength(1);
      expect(await setup.labels(issue.number)).toEqual(["ai-office"]);
    },
  ],
  [
    "a waiting issue is triaged again once the Owner edits it, and its stale Notice is closed",
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issue = github.createIssue(webShop, vagueIssue);
      model.answer(
        manager.id,
        triageAnswer({
          clear: false,
          priority: "low",
          reason: "No acceptance criteria.",
          questions: ["What does done look like?"],
        }),
      );
      await intake.poll();
      const [asked] = await setup.notices.open();

      github.editIssue(webShop, issue.number, {
        body: `${vagueIssue.body}\n\n## Acceptance criteria\n\n- [ ] The home page loads in under a second`,
      });
      model.answer(
        manager.id,
        triageAnswer({
          clear: true,
          priority: "low",
          reason: "It now has one measurable criterion.",
        }),
      );
      expect((await intake.poll()).pickedUp).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.messages[0]?.content).toContain(
        "The home page loads in under a second",
      );
      expect(await setup.labels(issue.number)).toEqual([
        "ai-office",
        "needs-work",
      ]);
      expect(await setup.queued()).toEqual([
        { issue: issue.number, stage: "needs-work", priority: "low" },
      ]);
      expect(await setup.notices.open()).toEqual([]);
      expect(
        (await setup.notices.get(asked?.id ?? "")).dismissedAt,
      ).not.toBeNull();
      expect((await setup.comments(issue.number)).at(-1)).toContain(
        "### Triage: clear to work",
      );
    },
  ],
  [
    "the Owner can have a waiting issue worked as it is, from its Notice",
    async (setup) => {
      const { github, model, manager, intake, notices } = setup;
      const issue = github.createIssue(webShop, vagueIssue);
      model.answer(
        manager.id,
        triageAnswer({
          clear: false,
          priority: "high",
          reason: "Scope is open-ended.",
          questions: ["Which part first?"],
        }),
      );
      await intake.poll();
      const [notice] = await notices.open();

      await notices.act(notice?.id ?? "", triageActions.workAsItIs);
      expect(await notices.open()).toEqual([]);
      expect((await setup.comments(issue.number)).at(-1)).toContain(
        "The Owner chose to have this issue worked as it is, at **high** priority.",
      );
      expect((await setup.triaged()).at(-1)).toMatchObject({
        outcome: "clear",
        judgedBy: "owner",
        priority: "high",
      });

      // Picked up at the next check, without asking the model again.
      expect((await intake.poll()).pickedUp).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(model.requests).toHaveLength(1);
      expect(await setup.queued()).toEqual([
        { issue: issue.number, stage: "needs-work", priority: "high" },
      ]);
    },
  ],
  [
    "an issue with no description waits, by plain code, without a model call",
    async (setup) => {
      const { github, model, intake } = setup;
      const issue = github.createIssue(webShop, {
        title: "Basket",
        labels: ["ai-office"],
      });
      expect((await intake.poll()).waiting).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(model.requests).toEqual([]);
      expect(await setup.notices.open()).toHaveLength(1);
      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain(
        "AI Office's rules triaged this issue: it is not clear",
      );
      expect(comment).toContain("> The issue has no description.");
      expect(await setup.triaged()).toMatchObject([
        { outcome: "unclear", judgedBy: "rules", priority: "normal" },
      ]);
    },
  ],
  [
    "when the Manager's Model cannot be asked, AI Office's rules judge: clear only with acceptance criteria",
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const clear = github.createIssue(webShop, clearIssue);
      const vague = github.createIssue(webShop, vagueIssue);
      const refused = new ModelCallError(
        503,
        "The AI Gateway answered 503: There is no AI Account to serve this request.",
      );
      model.answer(manager.id, refused, refused);

      expect(await intake.poll()).toEqual({
        pickedUp: [{ floorId: "web-shop", issue: clear.number }],
        ignored: [],
        waiting: [{ floorId: "web-shop", issue: vague.number }],
        failed: [],
      });
      expect(await setup.queued()).toEqual([
        { issue: clear.number, stage: "needs-work", priority: "normal" },
      ]);
      expect((await setup.comments(clear.number))[0]).toContain(
        `AI Office's rules triaged this issue, as ${manager.name} could not be asked: The AI Gateway answered 503: There is no AI Account to serve this request.: it is clear enough to work, at **normal** priority.`,
      );
      expect((await setup.comments(vague.number))[0]).toContain(
        "> The issue lists no acceptance criteria.",
      );
      expect(await setup.triaged()).toMatchObject([
        { issue: clear.number, outcome: "clear", judgedBy: "rules" },
        { issue: vague.number, outcome: "unclear", judgedBy: "rules" },
      ]);
    },
  ],
  [
    "an answer that is not a triage is sent back once; a second one leaves it to the rules",
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const first = github.createIssue(webShop, vagueIssue);
      model.answer(
        manager.id,
        "Looks fine to me!",
        triageAnswer({
          clear: false,
          priority: "normal",
          reason: "Too broad.",
          questions: ["Which page?"],
        }),
      );
      await intake.poll();
      const [, retry] = model.requestsOf(manager.id);
      expect(retry?.messages.map(({ role }) => role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      expect(retry?.messages[2]?.content).toBe(
        "That answer is not a valid triage: It has no JSON object. Answer again with only the JSON object, in the form asked for.",
      );
      expect(await setup.triaged()).toMatchObject([
        { issue: first.number, outcome: "unclear", judgedBy: "model" },
      ]);

      // Unclear with no questions is no triage either.
      const second = github.createIssue(webShop, clearIssue);
      const noQuestions = triageAnswer({
        clear: false,
        priority: "normal",
        reason: "Hmm.",
      });
      model.answer(manager.id, noQuestions, noQuestions);
      expect((await intake.poll()).pickedUp).toEqual([
        { floorId: "web-shop", issue: second.number },
      ]);
      expect((await setup.comments(second.number))[0]).toContain(
        `as ${manager.name} gave no valid triage: questions: An issue that is not clear needs at least one question for the Owner.`,
      );
    },
  ],
  [
    "a paused Manager is asked nothing; the rules judge",
    async (setup) => {
      const { github, model, manager, intake, stores } = setup;
      await stores.agents.update({ ...manager, enabled: false });
      const issue = github.createIssue(webShop, clearIssue);
      expect((await intake.poll()).pickedUp).toEqual([
        { floorId: "web-shop", issue: issue.number },
      ]);
      expect(model.requests).toEqual([]);
      expect((await setup.comments(issue.number))[0]).toContain(
        `as ${manager.name} is paused`,
      );
    },
  ],
  [
    "credentials never reach the issue's comments",
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issue = github.createIssue(webShop, vagueIssue);
      model.answer(
        manager.id,
        triageAnswer({
          clear: false,
          priority: "normal",
          reason: `It quotes a key, ${anthropicKey}, and asks for nothing.`,
          questions: [`Should ${anthropicKey} be revoked first?`],
        }),
      );
      await intake.poll();
      const [comment] = await setup.comments(issue.number);
      expect(comment).not.toContain(anthropicKey);
      expect(comment).toContain("[REDACTED]");
    },
  ],
  [
    "credentials pasted into an issue never reach the Manager's Model",
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issue = github.createIssue(webShop, {
        title: `Rotate ${anthropicKey}`,
        body: `- [ ] The key ${anthropicKey} no longer works`,
        labels: ["ai-office"],
      });
      model.answer(
        manager.id,
        triageAnswer({ clear: true, priority: "high", reason: "Clear." }),
      );
      await intake.poll();
      const [request] = model.requests;
      expect(request?.messages[0]?.content).toContain(
        `<issue number="${String(issue.number)}">\nTitle: Rotate [REDACTED]\n\n- [ ] The key [REDACTED] no longer works`,
      );
      expect(JSON.stringify(model.requests)).not.toContain(anthropicKey);
    },
  ],
];

describe("the Manager's triage, in memory", () => {
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

describe("the Manager's triage, in Postgres 18", () => {
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
