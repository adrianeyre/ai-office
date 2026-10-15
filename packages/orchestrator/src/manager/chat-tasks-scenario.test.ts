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
} from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createAgents, type Agents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createBatches, type Batches } from "../batches/batches.ts";
import { createContractorDepartures } from "../contractors/departures.ts";
import { createFloors } from "../floors/floors.ts";
import type { FactFinder, FactRequest } from "../grilling/fact-finding.ts";
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
import { managerChatIssues } from "./authority.ts";
import { createManagerChat, type ManagerChat } from "./chat.ts";
import { createChatReports } from "./chat-reports.ts";
import { createChatTasks, issueState, type ChatTasks } from "./chat-tasks.ts";
import type { ChatMessageRecord } from "./store.ts";
import { createChatRequests, type ChatRequests } from "./requests.ts";
import { modelRequestBindingCheck } from "./request-binding.ts";
import { createTriage } from "./triage.ts";

// The Manager chat's live task list, end to end (PRD FR-24, ADR 0004): a
// Floor with a Manager, a coder, a reviewer and a QA Agent, on the fake
// GitHub, whose Manager's Model the test scripts. Each chat request's
// Batch shows one task per issue, as it goes from queued to running, in
// review, blocked and done; one per Contractor, running while it stays;
// and one per research run. Each change is told to the chat's clients, to
// fetch the list again. Each case runs in memory and in Postgres 18.

const webShop = "adrianeyre/web-shop";
const start = new Date("2026-10-11T10:00:00.000Z");

/** Waits for `check`, as long as a busy Postgres may need. */
const settled = <Value>(check: () => Value | Promise<Value>) =>
  vi.waitFor(check, { timeout: 15_000, interval: 20 });

/** A decision, as the Manager's Model writes it. */
const decision = (value: ChatRequest): string =>
  `${chatRequestFence}\n${JSON.stringify(value, null, 2)}\n\`\`\``;

const migrationWriter = {
  name: "Migration writer",
  description: "Writes the database migrations a change needs.",
  instructions:
    "Write the migration the issue asks for, with its down migration.",
};

const issue = (
  title: string,
  role: string,
  dependsOn: number[] = [],
): Extract<ChatRequest, { decision: "batch" }>["issues"][number] => ({
  title,
  body: `${title}, end to end.`,
  acceptanceCriteria: [`${title} works.`],
  dependsOn,
  files: [],
  role,
});

interface Setup {
  readonly bus: EventBus;
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly workStore: WorkQueueStore;
  readonly model: FakeModel;
  /**
   * The Manager's Model as the binding check calls it (P2-3): it vouches
   * for every Plan unless scripted otherwise.
   */
  readonly binder: FakeModel;
  readonly notices: Notices;
  readonly agents: Agents;
  readonly batches: Batches;
  readonly chat: ManagerChat;
  readonly manager: AgentRecord;
  readonly events: OfficeEvent[];
  readonly found: FactRequest[];
  readonly sandboxes: { limit: number };
  readonly tasks: ChatTasks;
  /** How many times the chat told its clients to fetch the list again. */
  tasksChanged(): number;
  /** What listeners were told of replies as they were written. */
  streamed(): string;
  /** Sends the Owner's message, and waits until the Manager has done with it. */
  ask(text: string): Promise<ChatMessageRecord[]>;
  /** The Manager's messages in answer to `id`, oldest first. */
  answersTo(id: number): Promise<ChatMessageRecord[]>;
  finish(issue: number): void;
  sweep(): Promise<string[]>;
}

async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  let clock = start.getTime();
  const now = () => new Date((clock += 10));
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
  const running = new Map<number, (outcome: "finished") => void>();
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    execute: (work, signal) =>
      new Promise((resolve) => {
        running.set(work.issue, resolve);
        signal.addEventListener("abort", () => {
          resolve("failed");
        });
      }),
    issuePriority: (floorId, number) => triage.priority(floorId, number),
    issueRole: (floorId, number) => triage.role(floorId, number),
    // As the server wires it: a leaving Agent goes once its work ends.
    onEnded: (work) => {
      void agents.settle(work.floorId);
    },
    now,
  });
  await queue.start();
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    roles: stores.roles,
    work: workStore,
    now,
  });
  const pipeline = createPipeline({ github, events: bus });
  const batches = createBatches({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    store: stores.batches,
    work: workStore,
    pipeline,
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
        answer: "The order total is worked out in src/checkout/total.ts.",
      });
    },
  };
  const sandboxes = { limit: 3 };
  let tasksChanged = 0;
  const requests: ChatRequests = createChatRequests({
    agents,
    binding: modelRequestBindingCheck({ models: binder }),
    agentStore: stores.agents,
    roles: stores.roles,
    issues: managerChatIssues(github),
    batches,
    work: workStore,
    sandboxLimit: () => Promise.resolve(sandboxes.limit),
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
    onResearch: (floorId) => {
      chat.tasksChanged(floorId);
    },
    publicUrl: "https://office.example",
    now,
  });
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model,
    redactor,
    now,
    carryOut: (floorId, command) =>
      command.kind === "complete"
        ? batches.command(floorId, command.issues)
        : command.kind === "skip" || command.kind === "move"
          ? batches.changeCommand(floorId, command)
          : Promise.resolve(undefined),
    requests,
  });
  const deltas: string[] = [];
  chat.subscribe("web-shop", (update) => {
    if (update.type === "delta") {
      deltas.push(update.text);
    }
    if (update.type === "tasks") {
      tasksChanged += 1;
    }
  });
  const tasks = createChatTasks({
    floors: stores.floors,
    batches: stores.batches,
    agents: stores.agents,
    work: workStore,
    events: bus,
    research: requests,
    changed: (floorId) => {
      chat.tasksChanged(floorId);
    },
    now,
  });
  tasks.start();
  const reports = createChatReports({
    events: bus,
    batches: stores.batches,
    chat,
    publicUrl: "https://office.example",
  });
  reports.start();
  const departures = createContractorDepartures({
    agents,
    floors: stores.floors,
    batches: stores.batches,
    events: bus,
    now,
  });
  const answersTo = async (id: number) =>
    (await stores.managerChat.latest("web-shop", 200)).filter(
      ({ replyTo }) => replyTo === id,
    );
  return {
    bus,
    github,
    stores,
    workStore,
    model,
    binder,
    notices,
    agents,
    batches,
    chat,
    manager,
    events,
    found,
    sandboxes,
    tasks,
    tasksChanged: () => tasksChanged,
    streamed: () => deltas.join(""),
    async ask(text) {
      const sent = await chat.send("web-shop", text);
      await settled(async () => {
        expect((await chat.history("web-shop")).pending).toEqual([]);
        // Answered, and no longer held: another message would be taken.
        expect(await answersTo(sent.message.id)).not.toEqual([]);
      });
      // The Floor is free once the last answer is kept.
      await settled(async () => {
        const replies = await answersTo(sent.message.id);
        expect(
          replies.some(
            ({ kind, text: said }) =>
              kind === "reply" ||
              kind === "error" ||
              (kind === "progress" &&
                (said.startsWith("Batch ") || said.includes("could not"))),
          ),
        ).toBe(true);
      });
      return answersTo(sent.message.id);
    },
    answersTo,
    finish(number) {
      running.get(number)?.("finished");
      running.delete(number);
    },
    sweep: () => departures.sweep("web-shop"),
  };
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

/** Each task's id and state, newest request first. */
const states = async (s: Setup) =>
  (await s.tasks.list("web-shop")).map(({ id, state }) => [id, state]);

const cases: Case[] = [
  [
    "a chat request's issues and Contractor are listed as its Batch goes on, each with its Agent",
    async (s) => {
      expect(await s.tasks.list("web-shop")).toEqual([]);
      s.model.answer(
        s.manager.id,
        decision({
          decision: "batch",
          message: "A status column first, then the page that shows it.",
          roles: [migrationWriter],
          issues: [
            issue("Add the status column", "Migration writer"),
            issue("Show each order's status", "coder", [1]),
          ],
        }),
      );
      const answers = await s.ask("Add an order status and show it.");
      const asked = answers[0]?.replyTo ?? 0;
      const contractor = (await s.stores.agents.list("web-shop")).find(
        ({ contractor: hired }) => hired !== null,
      );
      const coder = (await s.stores.agents.list("web-shop")).find(
        ({ role }) => role === "coder",
      );
      const [batch] = await s.stores.batches.list("web-shop", 10);

      // #1 runs with its Contractor; #2 waits for it.
      await settled(async () => {
        expect(await states(s)).toEqual([
          ["issue:1", "running"],
          ["issue:2", "queued"],
          [`contractor:${contractor?.id ?? ""}`, "running"],
        ]);
      });
      expect(await s.tasks.list("web-shop")).toEqual([
        {
          id: "issue:1",
          kind: "issue",
          title: "#1 Add the status column",
          state: "running",
          messageId: asked,
          batchId: batch?.id,
          issue: 1,
          url: "https://github.com/adrianeyre/web-shop/issues/1",
          agentId: contractor?.id,
          agentName: "Migration writer",
        },
        {
          id: "issue:2",
          kind: "issue",
          title: "#2 Show each order's status",
          state: "queued",
          messageId: asked,
          batchId: batch?.id,
          issue: 2,
          url: "https://github.com/adrianeyre/web-shop/issues/2",
          agentId: coder?.id,
          agentName: `${coder?.name ?? ""} (Coder)`,
        },
        {
          id: `contractor:${contractor?.id ?? ""}`,
          kind: "contractor",
          title: "Migration writer",
          state: "running",
          messageId: asked,
          batchId: batch?.id,
          issue: null,
          url: null,
          agentId: contractor?.id,
          agentName: "Migration writer",
        },
      ]);
      const told = s.tasksChanged();
      expect(told).toBeGreaterThan(0);

      // #1's work is done and it goes to review; #2 is handed to the Owner.
      s.finish(1);
      await s.bus.publish({
        type: "issue.label_changed",
        version: 1,
        floorId: "web-shop",
        issue: 1,
        from: "needs-work",
        to: "needs-review",
      });
      await s.bus.publish({
        type: "issue.label_changed",
        version: 1,
        floorId: "web-shop",
        issue: 2,
        from: null,
        to: "needs-human",
      });
      await settled(async () => {
        expect(await states(s)).toEqual([
          ["issue:1", "in_review"],
          ["issue:2", "blocked"],
          [`contractor:${contractor?.id ?? ""}`, "running"],
        ]);
      });
      // Each change was told to the chat's clients.
      expect(s.tasksChanged()).toBeGreaterThan(told);

      // #1 merges: done.
      await s.bus.publish({
        type: "pull_request.merged",
        version: 1,
        floorId: "web-shop",
        issue: 1,
        pullRequest: 7,
        url: "https://github.com/adrianeyre/web-shop/pull/7",
        sha: "a".repeat(40),
        by: "app",
      });
      await settled(async () => {
        expect((await states(s))[0]).toEqual(["issue:1", "done"]);
      });

      // The Batch wraps up, and its idle Contractor leaves: its Wrap-up
      // says where each issue ended; the Contractor is done.
      const repository = s.github.repository(webShop);
      await repository.closeIssue(1);
      s.github.setLabel(webShop, 2, "needs-human");
      expect(await s.batches.finish(batch?.id ?? 0)).toBeDefined();
      await s.sweep();
      await settled(async () => {
        expect(
          (await s.stores.agents.list("web-shop")).some(
            ({ id }) => id === contractor?.id,
          ),
        ).toBe(false);
      });
      expect(await s.tasks.list("web-shop")).toMatchObject([
        { id: "issue:1", state: "done" },
        { id: "issue:2", state: "blocked" },
        {
          id: `contractor:${contractor?.id ?? ""}`,
          state: "done",
          agentId: null,
          agentName: "Migration writer",
        },
      ]);
    },
  ],
  [
    "a research run is listed with its researcher, done once it reported back; newest request first",
    async (s) => {
      s.model.answer(
        s.manager.id,
        decision({
          decision: "research",
          message: "I'll have the checkout code read first.",
          role: {
            name: "Checkout researcher",
            description: "Reads the checkout code.",
            instructions: "Answer from the checkout code.",
          },
          questions: ["Where is the order total worked out?"],
        }),
        "It is worked out in src/checkout/total.ts.",
      );
      const answers = await s.ask("Where do we work out the order total?");
      const asked = answers[0]?.replyTo ?? 0;
      expect(await s.tasks.list("web-shop")).toEqual([
        {
          id: "research:1",
          kind: "research",
          title: "Checkout researcher",
          state: "done",
          messageId: asked,
          batchId: null,
          issue: null,
          url: null,
          // It left once it reported back.
          agentId: null,
          agentName: "Checkout researcher",
        },
      ]);
      expect(s.tasksChanged()).toBeGreaterThan(0);

      s.model.answer(
        s.manager.id,
        decision({
          decision: "batch",
          message: "The orders page.",
          roles: [],
          issues: [issue("The orders page", "coder")],
        }),
      );
      const later = await s.ask("Build the orders page.");
      expect(
        (await s.tasks.list("web-shop")).map(({ id, messageId }) => [
          id,
          messageId,
        ]),
      ).toEqual([
        ["issue:1", later[0]?.replyTo],
        ["research:1", asked],
      ]);
    },
  ],
];

describe("where a chat task stands", () => {
  it("is read in plain code from its label, its merge and its work", () => {
    const none = { merged: false, label: null, work: [] } as const;
    expect(issueState(none)).toBe("queued");
    expect(
      issueState({
        ...none,
        label: "needs-work",
        work: [{ stage: "needs-work", status: "queued" }],
      }),
    ).toBe("queued");
    expect(
      issueState({
        ...none,
        label: "needs-work",
        work: [{ stage: "needs-work", status: "running" }],
      }),
    ).toBe("running");
    for (const label of [
      "needs-review",
      "needs-qa",
      "needs-docs",
      "ready-to-merge",
    ]) {
      expect(issueState({ ...none, label })).toBe("in_review");
    }
    expect(issueState({ ...none, label: "needs-human" })).toBe("blocked");
    expect(issueState({ ...none, label: "blocked" })).toBe("blocked");
    expect(issueState({ ...none, merged: true, label: "needs-human" })).toBe(
      "done",
    );
  });
});

describe("the Manager chat's task list, in memory", () => {
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

describe("the Manager chat's task list, in Postgres 18", () => {
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
