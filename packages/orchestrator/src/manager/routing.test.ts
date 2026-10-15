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
  builtInRole,
  defaultIntakeSettings,
  routingActions,
  type RoleDefinition,
} from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createAgents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import { createIntake, type Intake } from "../intake/intake.ts";
import { ModelCallError } from "../models/client.ts";
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
import type { FloorRecord } from "../floors/store.ts";
import { createTriage, type Triage } from "./triage.ts";

// Routing between work Roles (PRD FR-23, ADR 0003) as scenarios, with a
// fake model standing in for the Manager's Model behind the AI Gateway, the
// fake GitHub, and intake and the work queue wired as the server wires
// them. On a store's Floor with a merchandiser and a copywriter, the
// Manager's triage gives a product-data issue to the merchandiser and a
// copy issue to the copywriter; a `role:copywriter` label overrides it;
// an issue it cannot place raises one Notice, and the Owner's choice there
// dispatches it. A Floor with one work Role never asks. Each case runs in
// memory and in Postgres 18.

const shop = "adrianeyre/shop-theme";
const floorId = "shop-theme";

const role = (id: string, description: string): RoleDefinition => ({
  id,
  name: id,
  stage: "work",
  description,
  instructions: "- Commit your change.",
  skills: [],
  deskDressing: "books",
  aiProvider: "Claude",
  model: null,
});

const merchandiser = role(
  "merchandiser",
  "Changes product data: prices, variants, stock and collections.",
);
const copywriter = role(
  "copywriter",
  "Writes the words: product descriptions, page copy and emails.",
);

const productIssue = {
  title: "Add the autumn range",
  body: [
    "Add the six autumn coats to the catalogue, with their prices and sizes.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Six products in the Autumn collection, each with a price and S, M and L",
  ].join("\n"),
  labels: ["ai-office"],
};

const copyIssue = {
  title: "Rewrite the About page",
  body: [
    "The About page reads like a legal notice. Make it warm and short.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] The About page is under 200 words, in the brand's voice",
  ].join("\n"),
  labels: ["ai-office"],
};

const launchIssue = {
  title: "Get the winter sale ready",
  body: [
    "Everything for the winter sale on the home page.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] The winter sale is ready to launch",
  ].join("\n"),
  labels: ["ai-office"],
};

const answer = (fields: { roles?: string[]; roleReason?: string }): string =>
  JSON.stringify({
    clear: true,
    priority: "normal",
    reason: "It has acceptance criteria and one change.",
    questions: [],
    ...fields,
  });

interface Setup {
  readonly github: FakeGitHub;
  readonly bus: EventBus;
  readonly model: FakeModel;
  readonly notices: Notices;
  readonly intake: Intake;
  readonly triage: Triage;
  readonly manager: AgentRecord;
  /** The Floor's Agents, by name. */
  readonly agent: (role: string) => AgentRecord;
  labels(issue: number): Promise<readonly string[]>;
  comments(issue: number): Promise<string[]>;
  /** Each piece of queued work: its issue and the Role of its Agent. */
  queued(): Promise<{ issue: number; role: string | undefined }[]>;
  routed(): Promise<OfficeEvent[]>;
  floor(): Promise<FloorRecord>;
}

/**
 * A Floor at `shop`, with a Manager and an Agent for each entry of `team`
 * (a Role twice is two Agents): its Development team's coder is swapped
 * for them unless `team` keeps it.
 */
async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
  team: readonly RoleDefinition[],
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(shop);
  await createFloors({
    store: stores.floors,
    github,
    events: bus,
    roles: stores.roles,
  }).add(shop);
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    roles: stores.roles,
  });
  const at = new Date("2026-10-10T09:00:00.000Z");
  for (const [index, workRole] of team.entries()) {
    if ((await stores.roles.get(workRole.id)) === undefined) {
      await stores.roles.create(workRole, at);
    }
    const wanted = team
      .slice(0, index + 1)
      .filter(({ id }) => id === workRole.id).length;
    const have = (await stores.agents.list(floorId)).filter(
      ({ role: id }) => id === workRole.id,
    ).length;
    if (have < wanted) {
      await agents.addToTeam(floorId, workRole.id);
    }
  }
  if (!team.some(({ id }) => id === "coder")) {
    const coder = (await stores.agents.list(floorId)).find(
      ({ role: id }) => id === "coder",
    );
    if (coder !== undefined) {
      await agents.remove(floorId, coder.id);
    }
  }
  const everyone = await stores.agents.list(floorId);
  const agent = (id: string): AgentRecord => {
    const found = everyone.find(({ role: of }) => of === id);
    if (found === undefined) {
      throw new Error(`The Floor has no ${id}.`);
    }
    return found;
  };
  const model = createFakeModel();
  const notices = createNotices({ store: stores.notices, events: bus });
  const triage = createTriage({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    notices,
    events: bus,
    store: stores.triage,
    roles: stores.roles,
  });
  // No `execute`: work is queued for its Agent, and nothing starts.
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    issuePriority: (floor, issue) => triage.priority(floor, issue),
    issueRole: (floor, issue) => triage.role(floor, issue),
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
  const repository = github.repository(shop);
  return {
    github,
    bus,
    model,
    notices,
    intake,
    triage,
    manager: agent("manager"),
    agent,
    labels: async (issue) => (await repository.getIssue(issue)).labels,
    comments: async (issue) =>
      (await repository.listComments(issue)).map(({ body }) => body),
    queued: async () =>
      (await workStore.active()).map(({ issue, agentId }) => ({
        issue,
        role: everyone.find(({ id }) => id === agentId)?.role,
      })),
    routed: async () =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(({ type }) => type === "issue.routed"),
    floor: async () => {
      const floor = await stores.floors.get(floorId);
      if (floor === undefined) {
        throw new Error("The Floor is there.");
      }
      return floor;
    },
  };
}

type Case = [
  name: string,
  team: readonly RoleDefinition[],
  run: (setup: Setup) => Promise<void>,
];

const coder = builtInRole("coder");
if (coder === undefined) {
  throw new Error("The coder is a built-in Role.");
}

const cases: Case[] = [
  [
    "a product-data issue goes to the merchandiser, and a copy issue to the copywriter",
    [merchandiser, copywriter],
    async (setup) => {
      const { github, model, manager, intake } = setup;
      // The copy first: by load alone, it would go to the merchandiser,
      // the Floor's oldest work Agent, and the product data to the other.
      const copy = github.createIssue(shop, copyIssue);
      const product = github.createIssue(shop, productIssue);
      model.answer(
        manager.id,
        answer({
          roles: ["copywriter"],
          roleReason: "It rewrites a page's words.",
        }),
        answer({
          roles: ["merchandiser"],
          roleReason: "It adds products, prices and sizes: catalogue data.",
        }),
      );

      expect((await intake.poll()).pickedUp).toEqual([
        { floorId, issue: copy.number },
        { floorId, issue: product.number },
      ]);
      expect(await setup.queued()).toEqual([
        { issue: copy.number, role: "copywriter" },
        { issue: product.number, role: "merchandiser" },
      ]);

      // The Manager chose from each Role's routing description, in the
      // one triage call per issue.
      expect(model.requests).toHaveLength(2);
      const [request] = model.requests;
      expect(request?.issue).toBe(copy.number);
      expect(request?.agentId).toBe(manager.id);
      expect(request?.system).toContain("## Which Role works it");
      expect(request?.system).toContain(
        "- `copywriter` (copywriter): Writes the words: product descriptions, page copy and emails.",
      );
      expect(request?.system).toContain(
        "- `merchandiser` (merchandiser): Changes product data: prices, variants, stock and collections.",
      );
      expect(request?.system).toContain('"roles":');

      // The choice and the reason are a comment on each issue, and events.
      const [productComment] = await setup.comments(product.number);
      expect(productComment).toContain("### Triage: clear to work");
      expect(productComment).toContain("### Role: merchandiser");
      expect(productComment).toContain(
        `${manager.name} (the Manager) gave this issue to the **merchandiser** Role.`,
      );
      expect(productComment).toContain(
        "> It adds products, prices and sizes: catalogue data.",
      );
      const [copyComment] = await setup.comments(copy.number);
      expect(copyComment).toContain("### Role: copywriter");
      expect(copyComment).toContain("> It rewrites a page's words.");
      expect(await setup.routed()).toEqual([
        {
          type: "issue.routed",
          version: 1,
          floorId,
          issue: copy.number,
          agentId: manager.id,
          role: "copywriter",
          roleName: "copywriter",
          routedBy: "model",
        },
        {
          type: "issue.routed",
          version: 1,
          floorId,
          issue: product.number,
          agentId: manager.id,
          role: "merchandiser",
          roleName: "merchandiser",
          routedBy: "model",
        },
      ]);
      expect(await setup.notices.open()).toEqual([]);

      // Each work Role has its label on the repository.
      expect(github.labels(shop)).toEqual(
        expect.arrayContaining([
          {
            name: "role:copywriter",
            color: "bfdadc",
            description: "AI Office: work this issue as the copywriter",
          },
          {
            name: "role:merchandiser",
            color: "bfdadc",
            description: "AI Office: work this issue as the merchandiser",
          },
        ]),
      );
    },
  ],
  [
    "a Batch's Plan gives an issue its work Roles: the Model is not asked to choose, a label gives way, and a waiting choice is settled",
    [merchandiser, copywriter],
    async (setup) => {
      const { github, model, manager, intake, triage } = setup;
      const floor = await setup.floor();
      // Labelled for the merchandiser, but the Plan gives it both, the
      // copywriter first.
      const labelled = github.createIssue(shop, {
        ...productIssue,
        labels: ["ai-office", "role:merchandiser"],
      });
      model.answer(manager.id, answer({}));
      expect(
        await triage.check(
          floor,
          await github.repository(shop).getIssue(labelled.number),
          { planned: ["copywriter", "merchandiser"] },
        ),
      ).toEqual({ proceed: true, priority: "normal" });
      expect(await triage.role(floorId, labelled.number)).toBe("copywriter");
      expect(model.requests[0]?.system).not.toContain("## Which Role works it");
      const [comment] = await setup.comments(labelled.number);
      expect(comment).toContain(
        [
          "### Role: copywriter, then merchandiser",
          "",
          "Its Batch's Plan gives this issue to the **copywriter**, then the **merchandiser**: they take turns on its one branch, and review starts after the last.",
        ].join("\n"),
      );
      expect(await setup.routed()).toMatchObject([
        { issue: labelled.number, role: "copywriter", routedBy: "plan" },
      ]);

      // An issue waiting for the Owner's choice of Role: the Plan settles
      // it, closing the Notice, with no second model call.
      const ambiguous = github.createIssue(shop, launchIssue);
      model.answer(
        manager.id,
        answer({ roles: ["merchandiser", "copywriter"] }),
      );
      expect((await intake.poll()).waiting).toEqual([
        { floorId, issue: ambiguous.number },
      ]);
      expect(await setup.notices.open({ floorId })).toHaveLength(1);
      expect(
        await triage.check(
          floor,
          await github.repository(shop).getIssue(ambiguous.number),
          { planned: ["merchandiser", "seo"] },
        ),
      ).toEqual({ proceed: true, priority: "normal" });
      expect(await setup.notices.open({ floorId })).toEqual([]);
      expect(await triage.role(floorId, ambiguous.number)).toBe("merchandiser");
      expect(model.requests).toHaveLength(2);
      expect((await setup.comments(ambiguous.number)).at(-1)).toContain(
        "Its Batch's Plan gives this issue to the **merchandiser** Role.",
      );
      // Asked again, unchanged: it stands.
      expect(
        await triage.check(
          floor,
          await github.repository(shop).getIssue(ambiguous.number),
          { planned: ["merchandiser"] },
        ),
      ).toEqual({ proceed: true, priority: "normal" });
      expect(await setup.comments(ambiguous.number)).toHaveLength(2);
    },
  ],
  [
    "a role:copywriter label overrides the Manager's triage",
    [merchandiser, copywriter],
    async (setup) => {
      const { github, model, manager, intake } = setup;
      // Product data, by its text; the Owner wants the copywriter on it.
      const issue = github.createIssue(shop, {
        ...productIssue,
        labels: ["ai-office", "role:copywriter"],
      });
      model.answer(
        manager.id,
        answer({ roles: ["merchandiser"], roleReason: "Catalogue data." }),
      );

      expect((await intake.poll()).pickedUp).toEqual([
        { floorId, issue: issue.number },
      ]);
      expect(await setup.queued()).toEqual([
        { issue: issue.number, role: "copywriter" },
      ]);
      // The Manager still triaged it, but was not asked to choose a Role.
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.system).not.toContain("## Which Role works it");
      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain("### Role: copywriter");
      expect(comment).toContain(
        "The `role:copywriter` label on this issue gives it to the **copywriter** Role.",
      );
      expect(comment).not.toContain("merchandiser");
      expect(await setup.routed()).toMatchObject([
        { role: "copywriter", routedBy: "label" },
      ]);
      expect(await setup.notices.open()).toEqual([]);
    },
  ],
  [
    "an ambiguous issue raises one Notice; choosing in it dispatches",
    [merchandiser, copywriter],
    async (setup) => {
      const { github, model, manager, intake, bus } = setup;
      const issue = github.createIssue(shop, launchIssue);
      model.answer(
        manager.id,
        answer({
          roles: ["merchandiser", "copywriter"],
          roleReason:
            "A sale needs both new prices and new copy, and it does not say which.",
        }),
      );

      expect(await intake.poll()).toMatchObject({
        pickedUp: [],
        waiting: [{ floorId, issue: issue.number }],
      });
      // It waits out of the pipeline, with nothing queued.
      expect(await setup.labels(issue.number)).toEqual(["ai-office"]);
      expect(await setup.queued()).toEqual([]);
      expect(await setup.routed()).toEqual([]);

      const [notice, ...others] = await setup.notices.open({ floorId });
      expect(others).toEqual([]);
      expect(notice).toMatchObject({
        kind: "action",
        title: `Choose the Role to work #${String(issue.number)} Get the winter sale ready`,
        floorId,
        agentId: manager.id,
        issue: { number: issue.number, url: issue.htmlUrl },
        actions: [
          { id: routingActions[0], label: "Give it to the merchandiser" },
          { id: routingActions[1], label: "Give it to the copywriter" },
        ],
      });
      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain("### Triage: clear to work");
      expect(comment).toContain("### Role: waiting for the Owner");
      expect(comment).toContain(
        "> A sale needs both new prices and new copy, and it does not say which.",
      );
      expect(comment).toContain(
        "- **merchandiser**: Changes product data: prices, variants, stock and collections.\n- **copywriter**: Writes the words: product descriptions, page copy and emails.",
      );
      expect(comment).toContain(
        "Choose one on its Notice in AI Office, or add a `role:<name>` label to the issue, such as `role:merchandiser`.",
      );

      // Later checks ask nothing more while it waits: one Notice, one
      // comment, one model call.
      expect((await intake.poll()).waiting).toEqual([
        { floorId, issue: issue.number },
      ]);
      expect(model.requests).toHaveLength(1);
      expect(await setup.notices.open()).toHaveLength(1);
      expect(await setup.comments(issue.number)).toHaveLength(1);

      // As the server does: the Owner's choice wakes intake, which picks
      // the issue up at once for the Role chosen.
      bus.subscribe(
        ({ event }) => {
          if (event.type === "issue.routed" && event.routedBy === "owner") {
            intake.wake();
          }
        },
        { types: ["issue.routed"] },
      );
      intake.start();
      try {
        if (notice === undefined) {
          throw new Error("No Notice was raised.");
        }
        await setup.notices.act(notice.id, routingActions[1]);
        await vi.waitFor(async () => {
          expect(await setup.queued()).toEqual([
            { issue: issue.number, role: "copywriter" },
          ]);
        });
      } finally {
        await intake.stop();
      }
      expect(await setup.labels(issue.number)).toEqual([
        "ai-office",
        "needs-work",
      ]);
      expect(await setup.notices.open()).toEqual([]);
      expect(await setup.routed()).toEqual([
        {
          type: "issue.routed",
          version: 1,
          floorId,
          issue: issue.number,
          agentId: manager.id,
          role: "copywriter",
          roleName: "copywriter",
          routedBy: "owner",
        },
      ]);
      expect((await setup.comments(issue.number)).at(-1)).toContain(
        "The Owner chose the **copywriter** Role for this issue, on its Notice in AI Office.",
      );
      expect(model.requests).toHaveLength(1);
    },
  ],
  [
    "a waiting issue labelled role:<name> goes on, and its Notice is closed",
    [merchandiser, copywriter],
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issue = github.createIssue(shop, launchIssue);
      model.answer(
        manager.id,
        answer({ roles: [], roleReason: "It could be either." }),
      );
      await intake.poll();
      // Roles named by no one: every work Role is a candidate.
      const [notice] = await setup.notices.open();
      expect(notice?.actions.map(({ label }) => label)).toEqual([
        "Give it to the copywriter",
        "Give it to the merchandiser",
      ]);

      await github
        .repository(shop)
        .addLabels(issue.number, ["role:merchandiser"]);
      expect((await intake.poll()).pickedUp).toEqual([
        { floorId, issue: issue.number },
      ]);
      expect(await setup.queued()).toEqual([
        { issue: issue.number, role: "merchandiser" },
      ]);
      expect(await setup.notices.open()).toEqual([]);
      expect(await setup.routed()).toMatchObject([
        { role: "merchandiser", routedBy: "label" },
      ]);
      expect((await setup.comments(issue.number)).at(-1)).toContain(
        "The `role:merchandiser` label on this issue gives it to the **merchandiser** Role.",
      );
      expect(model.requests).toHaveLength(1);
    },
  ],
  [
    "when no model judges, AI Office's rules ask the Owner which Role",
    [merchandiser, copywriter],
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issue = github.createIssue(shop, productIssue);
      model.answer(
        manager.id,
        new ModelCallError(503, "No AI Account can serve this request."),
      );
      expect((await intake.poll()).waiting).toEqual([
        { floorId, issue: issue.number },
      ]);
      expect(await setup.notices.open()).toHaveLength(1);
      const [comment] = await setup.comments(issue.number);
      expect(comment).toContain("### Role: waiting for the Owner");
      expect(comment).toContain(
        "> AI Office's rules triaged this issue, and they do not choose between work Roles.",
      );
      expect(await setup.queued()).toEqual([]);
    },
  ],
  [
    "a Floor with one work Role never asks",
    // Two coders: one work Role.
    [coder, coder],
    async (setup) => {
      const { github, model, manager, intake } = setup;
      const issues = [productIssue, copyIssue, launchIssue].map((issue) =>
        github.createIssue(shop, issue),
      );
      // Whatever the Model says of Roles, and when it cannot be asked.
      model.answer(
        manager.id,
        answer({}),
        answer({ roles: ["merchandiser", "copywriter"] }),
        new ModelCallError(503, "No AI Account can serve this request."),
      );

      expect((await intake.poll()).pickedUp).toEqual(
        issues.map(({ number }) => ({ floorId, issue: number })),
      );
      expect(await setup.queued()).toEqual(
        issues.map(({ number }) => ({ issue: number, role: "coder" })),
      );
      expect(await setup.notices.open()).toEqual([]);
      expect(await setup.routed()).toEqual([]);
      expect(model.requests[0]?.system).not.toContain("## Which Role works it");
      expect(model.requests[0]?.system).not.toContain('"roles":');
      for (const { number } of issues) {
        const comments = await setup.comments(number);
        expect(comments).toHaveLength(1);
        expect(comments[0]).not.toContain("### Role");
      }
      expect(github.labels(shop).map(({ name }) => name)).toContain(
        "role:coder",
      );
    },
  ],
];

describe("routing between work Roles, in memory", () => {
  for (const [name, team, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      await run(
        await setUp(
          stores,
          memoryWorkQueueStore(stores.floors),
          createEventBus({ store: memoryEventStore() }),
          team,
        ),
      );
    });
  }
});

describe("routing between work Roles, in Postgres 18", () => {
  for (const [name, team, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          databaseWorkQueueStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
          team,
        ),
      );
    });
  }
});
