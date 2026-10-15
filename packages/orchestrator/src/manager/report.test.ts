import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  createRedactor,
  noTokens,
  type Redactor,
  type TokenUsageRow,
} from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createAgents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import type { ModelClient } from "../models/client.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createWorkQueue, type WorkQueue } from "../work/queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { createManagerChat, type ManagerChat } from "./chat.ts";
import { createStatusReports, type StatusReports } from "./report.ts";

// The Manager's status reports (PRD FR-23, "Reporting") as scenarios: a
// Floor is seeded with work in flight (running, and queued), work that is
// blocked (failed, and waiting for a reviewer paused at its Token Cap),
// and issues that need the Owner. Asked "status" in the Manager chat, or
// at its daily hour, the Manager writes a report listing them, with the
// Floor's tokens, in the chat and as an info Notice. Each case runs in
// memory and in Postgres 18.

const webShop = "adrianeyre/web-shop";
const blog = "adrianeyre/blog";
/** Half past eight in the morning, UTC: before the daily report. */
const start = new Date("2026-10-09T08:30:00.000Z");
const minutes = (count: number) => count * 60_000;
const anthropicKey = "sk-ant-api03-pastedintoatitle-Qw3Er4Ty5Ui6Op7As8Df9";

/** No model may be asked for a report. */
const noModel: ModelClient = {
  complete: () => Promise.reject(new Error("A report asks no model.")),
  stream: () => Promise.reject(new Error("A report asks no model.")),
};

interface Setup {
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly workStore: WorkQueueStore;
  readonly bus: EventBus;
  readonly notices: Notices;
  readonly queue: WorkQueue;
  readonly chat: ManagerChat;
  readonly reports: StatusReports;
  readonly manager: AgentRecord;
  readonly ada: AgentRecord;
  readonly alan: AgentRecord;
  readonly reviewer: AgentRecord;
  /** Each start of work: its issue and Agent, in order. */
  readonly ran: { issue: number; agentId: string | null }[];
  /** The Agents paused at a Token Cap. */
  readonly capPaused: string[];
  /** Removes credentials, as the server's does, with those registered. */
  readonly redactor: Redactor;
  /** What the Gateway's request history holds. */
  readonly usage: (TokenUsageRow & { readonly at: Date })[];
  /** How many sandboxes may run at once. */
  limit: number;
  advance(ms: number): void;
  now(): Date;
  finish(issue: number, outcome?: "finished" | "failed"): void;
  openIssue(title: string, labels: readonly string[]): number;
  /** A new instance, as after a restart, on the same stores. */
  restart(): StatusReports;
}

async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  github.installRepository(blog);
  let clock = start.getTime();
  const now = () => new Date(clock);
  const floors = createFloors({
    store: stores.floors,
    github,
    events: bus,
    now,
  });
  await floors.add(webShop);
  await floors.add(blog);
  clock += 1000;
  await createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    now,
  }).add("web-shop", { role: "coder" });
  const team = await stores.agents.list("web-shop");
  const [manager] = team.filter(({ role }) => role === "manager");
  const [ada, alan] = team.filter(({ role }) => role === "coder");
  const [reviewer] = team.filter(({ role }) => role === "reviewer");
  if (
    manager === undefined ||
    ada === undefined ||
    alan === undefined ||
    reviewer === undefined
  ) {
    throw new Error("The Floor's team is not as expected.");
  }

  const ran: { issue: number; agentId: string | null }[] = [];
  const running = new Map<number, (outcome: "finished" | "failed") => void>();
  const capPaused: string[] = [];
  const usage: (TokenUsageRow & { readonly at: Date })[] = [];
  const redactor = createRedactor();
  const notices = createNotices({
    store: stores.notices,
    events: bus,
    redactor,
    now,
  });
  const setup = {
    limit: 3,
  } as Setup;
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(setup.limit),
    execute: (work, signal) =>
      new Promise((resolve) => {
        ran.push({ issue: work.issue, agentId: work.agentId });
        running.set(work.issue, resolve);
        signal.addEventListener("abort", () => {
          resolve("failed");
        });
      }),
    pausedAgents: () => capPaused,
    now,
  });
  // The chat answers "status" with a report, as the server wires them.
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: noModel,
    redactor,
    now,
    report: (floorId, replyTo) => reports.write(floorId, { replyTo }),
  });
  const make = () =>
    createStatusReports({
      floors: stores.floors,
      agents: stores.agents,
      work: workStore,
      github,
      notices,
      chat,
      chatStore: stores.managerChat,
      usage: (from, to) =>
        Promise.resolve(usage.filter(({ at }) => at >= from && at < to)),
      pausedAgents: () => capPaused,
      publicUrl: "https://office.example",
      redactor,
      now,
    });
  const reports = make();
  return Object.assign(setup, {
    redactor,
    github,
    stores,
    workStore,
    bus,
    notices,
    queue,
    chat,
    reports,
    manager,
    ada,
    alan,
    reviewer,
    ran,
    capPaused,
    usage,
    advance(ms: number) {
      clock += ms;
    },
    now,
    finish(issue: number, outcome: "finished" | "failed" = "finished") {
      running.get(issue)?.(outcome);
      running.delete(issue);
    },
    openIssue: (title: string, labels: readonly string[]) =>
      github.createIssue(webShop, {
        title,
        body: "- [ ] It works",
        labels: ["ai-office", ...labels],
      }).number,
    restart: make,
  });
}

const tokens = (count: number) => ({
  ...noTokens,
  requests: 1,
  inputTokens: count,
  tokens: count,
});

/** Waits for the queue to have started the given runs, in order. */
const ranAs = async (
  setup: Setup,
  runs: { issue: number; agentId: string | null }[],
) => {
  await vi.waitFor(() => {
    expect(setup.ran).toEqual(runs);
  });
};

/**
 * Seeds web-shop: #1 running for Ada and #2 for Alan, #4 queued for Ada
 * (the sandboxes are full), #5's review waiting for its reviewer, who is
 * paused at a Token Cap, #3's work failed, #6 handed to the Owner, #7
 * ready to merge, #8 closed after its work failed, and #9 not yet in the
 * pipeline. Its Agents used 1,500 tokens today and 2,000 earlier this
 * month (and 5,000 last month); the blog's Agents 999 earlier this month.
 */
async function seed(setup: Setup) {
  const { ada, alan, reviewer } = setup;
  await setup.queue.start();
  const enqueue = (issue: number, stage: "needs-work" | "needs-review") =>
    setup.queue.enqueue({ floorId: "web-shop", issue, stage });

  // #3 and #8 fail.
  const failing = setup.openIssue("Fix the search", ["needs-work"]);
  const closing = setup.openIssue("An old idea", ["needs-work"]);
  await enqueue(failing, "needs-work");
  await enqueue(closing, "needs-work");
  await ranAs(setup, [
    { issue: failing, agentId: ada.id },
    { issue: closing, agentId: alan.id },
  ]);
  setup.advance(minutes(5));
  setup.finish(failing, "failed");
  setup.finish(closing, "failed");
  await vi.waitFor(async () => {
    expect(await setup.workStore.active()).toEqual([]);
  });
  await setup.github.repository(webShop).closeIssue(closing);
  await setup.notices.raise({
    kind: "action",
    title: `Agent blocked: ${ada.name} could not finish #${String(failing)}`,
    floorId: "web-shop",
    agentId: ada.id,
    issue: {
      number: failing,
      url: `https://github.com/${webShop}/issues/${String(failing)}`,
    },
  });

  // #1 and #2 run; #4 waits for a sandbox.
  setup.limit = 2;
  const basket = setup.openIssue("Add a basket", ["needs-work"]);
  const wishList = setup.openIssue("Add a wish list", ["needs-work"]);
  await enqueue(basket, "needs-work");
  await enqueue(wishList, "needs-work");
  await ranAs(setup, [
    { issue: failing, agentId: ada.id },
    { issue: closing, agentId: alan.id },
    { issue: basket, agentId: ada.id },
    { issue: wishList, agentId: alan.id },
  ]);
  setup.advance(minutes(10));
  const footer = setup.openIssue("Tidy the footer", ["needs-work"]);
  await enqueue(footer, "needs-work");

  // #5's review round waits for its reviewer, paused at a Token Cap.
  setup.capPaused.push(reviewer.id);
  const pricing = setup.openIssue("Show prices with tax", ["needs-review"]);
  await enqueue(pricing, "needs-review");

  // #6 waits for the Owner, #7 to be merged, #9 for triage.
  const human = setup.openIssue("Rework checkout", ["needs-human"]);
  const ready = setup.openIssue("Add a favicon", ["ready-to-merge"]);
  setup.openIssue("Something vague", []);

  const today = setup.now();
  setup.usage.push(
    {
      floorId: "web-shop",
      agentId: ada.id,
      issue: basket,
      ownerTool: null,
      totals: tokens(1200),
      at: today,
    },
    {
      floorId: "web-shop",
      agentId: setup.manager.id,
      issue: null,
      ownerTool: null,
      totals: tokens(300),
      at: today,
    },
    {
      floorId: "web-shop",
      agentId: ada.id,
      issue: failing,
      ownerTool: null,
      totals: tokens(2000),
      at: new Date("2026-10-02T12:00:00.000Z"),
    },
    {
      floorId: "web-shop",
      agentId: ada.id,
      issue: failing,
      ownerTool: null,
      totals: tokens(5000),
      at: new Date("2026-09-30T12:00:00.000Z"),
    },
    {
      floorId: "blog",
      agentId: "blog-coder",
      issue: 1,
      ownerTool: null,
      totals: tokens(999),
      at: new Date("2026-10-02T12:00:00.000Z"),
    },
    {
      floorId: null,
      agentId: null,
      issue: null,
      ownerTool: "laptop",
      totals: tokens(777),
      at: today,
    },
  );
  setup.advance(minutes(2));
  return { failing, closing, basket, wishList, footer, pricing, human, ready };
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    'asked "status" in the chat, the Manager lists the in-flight and blocked issues, what needs the Owner and the tokens used',
    async (setup) => {
      const { ada, alan, reviewer, manager } = setup;
      const issues = await seed(setup);

      const report = await setup.reports.compose("web-shop");
      expect(
        report.inFlight.map(({ issue, status, agentName }) => ({
          issue,
          status,
          agentName,
        })),
      ).toEqual([
        { issue: issues.basket, status: "running", agentName: ada.name },
        { issue: issues.wishList, status: "running", agentName: alan.name },
        { issue: issues.footer, status: "queued", agentName: ada.name },
      ]);
      expect(
        report.blocked.map(({ issue, stage }) => ({ issue, stage })),
      ).toEqual([
        { issue: issues.pricing, stage: "needs-review" },
        { issue: issues.failing, stage: "needs-work" },
      ]);
      expect(report.needsOwner.map(({ issue }) => issue)).toEqual([
        issues.failing,
        issues.human,
        issues.ready,
      ]);
      expect(report.tokens).toEqual({ today: 1500, month: 3500 });

      const sent = await setup.chat.send("web-shop", "status");
      expect(sent.reply).toMatchObject({
        kind: "report",
        replyTo: sent.message.id,
        agentId: manager.id,
        model: null,
        command: null,
      });
      expect(sent.reply?.text).toBe(
        [
          "Status report on web-shop, 2026-10-09 08:47 UTC.",
          "",
          "In flight (3):",
          `- #${String(issues.basket)} Add a basket: ${ada.name} is working on it at needs-work, for 12 minutes.`,
          `- #${String(issues.wishList)} Add a wish list: ${alan.name} is working on it at needs-work, for 12 minutes.`,
          `- #${String(issues.footer)} Tidy the footer: queued at needs-work for ${ada.name}, for 2 minutes.`,
          "Blocked (2):",
          `- #${String(issues.pricing)} Show prices with tax (needs-review): its review waits for its required reviewers, and ${reviewer.name} is paused at a Token Cap.`,
          `- #${String(issues.failing)} Fix the search (needs-work): its work at needs-work failed (${ada.name}), and nothing is queued again.`,
          "Needing you (3):",
          `- #${String(issues.failing)} Fix the search: Agent blocked: ${ada.name} could not finish #${String(issues.failing)}.`,
          `- #${String(issues.human)} Rework checkout: handed to you, at needs-human.`,
          `- #${String(issues.ready)} Add a favicon: ready to merge, for your approval.`,
          "Tokens used: 1,500 today, 3,500 this month (UTC).",
        ].join("\n"),
      );
      // The closed issue and the one not yet in the pipeline are left out.
      expect(sent.reply?.text).not.toContain("An old idea");
      expect(sent.reply?.text).not.toContain("Something vague");
      // In the chat, after the Owner's message.
      expect(
        (await setup.chat.history("web-shop")).messages.map(({ kind }) => kind),
      ).toEqual(["owner", "report"]);

      // And as an info Notice, linking the chat and each issue.
      const [notice] = (
        await setup.notices.open({ floorId: "web-shop" })
      ).filter(({ kind }) => kind === "info");
      const url = (issue: number) =>
        `https://github.com/${webShop}/issues/${String(issue)}`;
      expect(notice).toMatchObject({
        kind: "info",
        title:
          "Status report on web-shop: 3 in flight, 2 blocked, 3 needing you, 1,500 tokens today",
        floorId: "web-shop",
        agentId: manager.id,
        actions: [],
        links: [
          {
            label: "The report in the Manager chat",
            url: "https://office.example/floors/web-shop/manager",
          },
          {
            label: `#${String(issues.failing)} needs you`,
            url: url(issues.failing),
          },
          {
            label: `#${String(issues.human)} needs you`,
            url: url(issues.human),
          },
          {
            label: `#${String(issues.ready)} needs you`,
            url: url(issues.ready),
          },
          {
            label: `#${String(issues.pricing)} blocked at needs-review`,
            url: url(issues.pricing),
          },
          {
            label: `#${String(issues.basket)} in flight at needs-work`,
            url: url(issues.basket),
          },
          {
            label: `#${String(issues.wishList)} in flight at needs-work`,
            url: url(issues.wishList),
          },
          {
            label: `#${String(issues.footer)} in flight at needs-work`,
            url: url(issues.footer),
          },
        ],
      });
      const raised = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter((event) => event.type === "notice.raised");
      expect(raised.at(-1)).toMatchObject({
        kind: "info",
        floorId: "web-shop",
      });
    },
  ],
  [
    "the daily report is written at its hour, once a day, across restarts, and not for a quiet Floor",
    async (setup) => {
      const issues = await seed(setup);
      const daily = async () =>
        (await setup.stores.managerChat.latest("web-shop", 50)).filter(
          ({ kind, replyTo }) => kind === "report" && replyTo === null,
        );
      const infoNotices = async (floorId: string) =>
        (await setup.notices.open({ floorId })).filter(
          ({ kind }) => kind === "info",
        );

      // Before nine, and a report asked for, is no daily report.
      expect(await setup.reports.check()).toEqual([]);
      await setup.chat.send("web-shop", "status report");
      setup.advance(minutes(12));
      expect(await setup.reports.check()).toEqual([]);
      expect(await daily()).toEqual([]);

      // At nine: web-shop's, but not the blog's, which has nothing on.
      setup.advance(minutes(1));
      expect(setup.now().toISOString()).toBe("2026-10-09T09:00:01.000Z");
      expect(await setup.reports.check()).toEqual(["web-shop"]);
      const [first] = await daily();
      expect(first?.text).toContain(
        "Status report on web-shop, 2026-10-09 09:00 UTC.",
      );
      expect(first?.text).toContain(`#${String(issues.basket)} Add a basket: `);
      expect(first?.text).toContain(
        `#${String(issues.failing)} Fix the search (needs-work): its work at needs-work failed`,
      );
      expect(await infoNotices("web-shop")).toHaveLength(2);
      expect(await infoNotices("blog")).toEqual([]);

      // Once: not again this process, nor after a restart.
      setup.advance(minutes(30));
      expect(await setup.reports.check()).toEqual([]);
      expect(await setup.restart().check()).toEqual([]);
      expect(await daily()).toHaveLength(1);

      // The next day, again.
      setup.advance(minutes(24 * 60));
      expect(await setup.restart().check()).toEqual(["web-shop"]);
      expect(await daily()).toHaveLength(2);
      expect(await infoNotices("web-shop")).toHaveLength(3);
    },
  ],
  [
    "without GitHub, the report comes from AI Office's own records, and says so",
    async (setup) => {
      const issues = await seed(setup);
      const reports = createStatusReports({
        floors: setup.stores.floors,
        agents: setup.stores.agents,
        work: setup.workStore,
        notices: setup.notices,
        chat: setup.chat,
        chatStore: setup.stores.managerChat,
        usage: () => Promise.resolve([]),
        pausedAgents: () => setup.capPaused,
        now: () => setup.now(),
      });
      const message = await reports.write("web-shop");
      expect(message).toMatchObject({ kind: "report", replyTo: null });
      expect(message.text).toContain(
        `- #${String(issues.basket)}: ${setup.ada.name} is working on it at needs-work`,
      );
      expect(message.text).toContain(
        `- #${String(issues.failing)} (needs-work): its work at needs-work failed (${setup.ada.name})`,
      );
      // The closed issue cannot be told apart without GitHub.
      expect(message.text).toContain(
        `- #${String(issues.closing)} (needs-work)`,
      );
      expect(message.text).toContain(
        "GitHub could not be read (the GitHub App is not configured), so this comes from AI Office's own records alone.",
      );
    },
  ],
  [
    "never writes a credential into the chat or the Notice",
    async (setup) => {
      // Long enough to be shortened: the key is redacted before it is.
      const issue = setup.openIssue(
        `Rotate the key ${anthropicKey} that leaked into the logs`,
        ["needs-human"],
      );
      const message = await setup.reports.write("web-shop");
      expect(message.text).toContain(`#${String(issue)} Rotate`);
      expect(message.text).not.toContain(anthropicKey);
      expect(
        JSON.stringify(await setup.notices.open({ floorId: "web-shop" })),
      ).not.toContain(anthropicKey);
      expect(
        JSON.stringify(await setup.stores.managerChat.latest("web-shop", 10)),
      ).not.toContain(anthropicKey);

      // A credential of no known shape, such as an AI Account's, is
      // redacted as a whole, before the title is shortened: no part of it
      // is left that the redactor would no longer know.
      const secret = "officepassphrase-0f9e8d7c6b5a49382716-zyxwvu";
      setup.redactor.register(secret);
      const leaked = setup.openIssue(
        `Change the passphrase ${secret} found in a log`,
        ["needs-human"],
      );
      const again = await setup.reports.write("web-shop");
      expect(again.text).toContain(
        `#${String(leaked)} Change the passphrase [REDACTED] found in a log`,
      );
      const everything = JSON.stringify([
        await setup.stores.managerChat.latest("web-shop", 10),
        await setup.notices.open({ floorId: "web-shop" }),
      ]);
      expect(everything).not.toContain(secret.slice(0, 16));
    },
  ],
];

describe("the Manager's status reports, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      const setup = await setUp(
        stores,
        memoryWorkQueueStore(stores.floors),
        createEventBus({ store: memoryEventStore() }),
      );
      try {
        await run(setup);
      } finally {
        for (const { issue } of setup.ran) {
          setup.finish(issue);
        }
        await setup.queue.stop();
      }
    });
  }
});

describe("the Manager's status reports, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      try {
        await run(setup);
      } finally {
        for (const { issue } of setup.ran) {
          setup.finish(issue);
        }
        await setup.queue.stop();
      }
    });
  }
});
