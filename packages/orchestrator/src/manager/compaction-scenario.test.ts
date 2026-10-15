import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createRedactor } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import type {
  ContextUsage,
  ContextUsageListener,
  ContextUsageState,
} from "../context/usage.ts";
import { createFloors } from "../floors/floors.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createManagerChat, type ManagerChatUpdate } from "./chat.ts";

// Clearing and compacting the Manager chat, end to end (PRD FR-87, FR-88,
// FR-89), with a Manager whose Model the test scripts and a Context Usage
// the test reports:
// - `/clear` wipes the conversation the Model is given, keeping the
//   Floor's Batches and Plans and the Manager's decisions;
// - `/compact` has the Manager's Model summarise the conversation, and the
//   summary takes the place of the messages it replaced;
// - the chat compacts itself before a reply once the Manager's Context
//   Usage in the conversation reaches its threshold;
// - a compacted Grilling Session still has every settled decision, word
//   for word, in the Manager's prompt.
// Each case runs in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const anthropicKey = "sk-ant-api03-saidbeforecompacting-Qw3Er4Ty5Ui6Op7As8";

type Answer = (
  request: ModelRequest,
  options: ModelStreamOptions,
) => Promise<ModelReply>;

/** A model whose answers the test writes. */
function scriptedModel() {
  const requests: ModelRequest[] = [];
  const answers: Answer[] = [];
  const client: ModelClient = {
    complete: () => Promise.reject(new Error("The chat streams its calls.")),
    stream(request, options) {
      requests.push(request);
      const answer = answers.shift();
      return answer === undefined
        ? Promise.reject(new Error("No answer was scripted."))
        : answer(request, options);
    },
  };
  return {
    client,
    requests,
    says(text: string): void {
      answers.push((_request, { onText }) => {
        onText(text);
        return Promise.resolve({ text, stopReason: "end_turn" });
      });
    },
  };
}

/** Context Usage as the test reports it, and the sessions the chat ends. */
function reportedUsage() {
  const listeners = new Set<ContextUsageListener>();
  const ended: { agentId: string; session: string | null }[] = [];
  const usage: Pick<ContextUsage, "subscribe" | "endSession"> = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    endSession(agentId, session) {
      ended.push({ agentId, session });
      return Promise.resolve();
    },
  };
  return {
    usage,
    ended,
    /** The Gateway measured a call of the Manager's in `session`. */
    report(agentId: string, session: string | undefined, share: number) {
      const state: ContextUsageState = {
        agentId,
        floorId: "web-shop",
        session: session ?? null,
        issue: null,
        model: "claude-opus-5-5",
        inputTokens: Math.round(share * 200_000),
        contextWindow: 200_000,
        contextUsage: share,
        callStartedAt: new Date(Date.UTC(2026, 9, 10, 12)),
        updatedAt: new Date(Date.UTC(2026, 9, 10, 12)),
      };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

async function setUp(stores: OfficeStores) {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const events = createEventBus({ store: memoryEventStore() });
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const manager = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "manager",
  );
  if (manager === undefined) {
    throw new Error("The Floor has no Manager.");
  }
  const model = scriptedModel();
  const usage = reportedUsage();
  let tick = 0;
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model.client,
    grilling: stores.grilling,
    contextUsage: usage.usage,
    redactor: createRedactor(),
    now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++)),
    // "complete issues 1 to 2" keeps a Batch with its Plan.
    carryOut: async (floorId, command) => {
      if (command.kind !== "complete") {
        return undefined;
      }
      const { batch } = await stores.batches.create(
        {
          floorId,
          issues: command.issues,
          status: "awaiting_approval",
          agentId: manager.id,
          createdAt: new Date(Date.UTC(2026, 9, 10, 11)),
        },
        {
          draftedBy: "model",
          summary: "The basket, then its total.",
          items: command.issues.map((issue) => ({
            issue,
            title: `Issue ${String(issue)}`,
            dependsOn: [],
            files: [],
            agentId: null,
            note: "",
          })),
          overlaps: [],
          parallel: [command.issues],
          leftOut: [],
        },
      );
      return `Batch ${String(batch.id)} awaits your approval.`;
    },
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));

  /** The answer to `replyTo` that AI Office keeps, once it is kept. */
  const answerTo = async (replyTo: number) => {
    let found: ManagerChatUpdate | undefined;
    await vi.waitFor(() => {
      found = updates.find(
        (update) =>
          update.type === "message" && update.message.replyTo === replyTo,
      );
      expect(found).toBeDefined();
    });
    if (found?.type !== "message") {
      throw new Error("unreachable");
    }
    return found.message;
  };
  /** Sends `text`, and the answer kept: at once, or once the Model wrote it. */
  const say = async (text: string) => {
    const sent = await chat.send("web-shop", text);
    return {
      message: sent.message,
      reply: sent.reply ?? (await answerTo(sent.message.id)),
    };
  };
  return { chat, model, usage, say, updates, manager, stores };
}

/** The part of a prompt under `heading`, to the next heading of its level. */
const section = (system: string, heading: string): string | undefined => {
  const level = /^#+/.exec(heading)?.[0] ?? "##";
  const start = system.indexOf(`${heading}\n`);
  if (start === -1) {
    return undefined;
  }
  const end = system.indexOf(`\n${level} `, start + 1);
  return system.slice(start, end === -1 ? undefined : end);
};

type Case = [name: string, run: (stores: OfficeStores) => Promise<void>];

const cases: Case[] = [
  [
    "/clear wipes the conversation the Model is given, and keeps the Floor's Batches and Plans",
    async (stores) => {
      const s = await setUp(stores);
      const planned = await s.say("complete issues 1 to 2");
      expect(planned.reply.text).toContain("Batch 1 awaits your approval.");
      s.model.says("Start with the basket.");
      await s.say("What should go first?");
      const before = s.model.requests[0];
      expect(before?.session).toBe("manager-chat:web-shop:0");
      expect(before?.messages).toEqual([
        {
          role: "user",
          content: "complete issues 1 to 2",
        },
        {
          role: "assistant",
          content:
            "Understood: complete 2 issues: #1 and #2. Batch 1 awaits your approval.",
        },
        { role: "user", content: "What should go first?" },
      ]);

      const cleared = await s.say("/clear");
      expect(cleared.reply).toMatchObject({
        kind: "clear",
        text: `Cleared the conversation: ${s.manager.name} starts afresh from here. Decisions, Plans and Batches are kept.`,
        replyTo: cleared.message.id,
      });
      // No Skill of that name was looked for, and no model was called.
      expect(cleared.message.skill).toBeNull();
      expect(s.model.requests).toHaveLength(1);
      // The conversation's session ended, so its Context Usage empties.
      expect(s.usage.ended).toEqual([
        { agentId: s.manager.id, session: "manager-chat:web-shop:0" },
      ]);

      // The Batch and its Plan are kept.
      const [batch] = await s.stores.batches.list("web-shop", 10);
      expect(batch).toMatchObject({ id: 1, issues: [1, 2] });
      expect(await s.stores.batches.latestPlan(1)).toMatchObject({
        version: 1,
        summary: "The basket, then its total.",
      });

      // The Model is given only what came after.
      s.model.says("Hello again.");
      await s.say("Where were we?");
      const after = s.model.requests[1];
      expect(after?.messages).toEqual([
        { role: "user", content: "Where were we?" },
      ]);
      expect(after?.session).toBe(
        `manager-chat:web-shop:${String(cleared.reply.id)}`,
      );
      expect(after?.system).not.toContain("## Earlier in this conversation");
      // The page still has every message.
      expect((await s.chat.history("web-shop")).messages).toHaveLength(8);
    },
  ],
  [
    "/compact replaces the older history with the Manager's own summary",
    async (stores) => {
      const s = await setUp(stores);
      // Nothing yet to compact.
      expect((await s.say("/compact")).reply).toMatchObject({
        kind: "hint",
        text: "There is nothing to compact yet: nothing was said since the conversation was last cleared or compacted.",
      });
      expect(s.model.requests).toHaveLength(0);

      s.model.says("The basket first.");
      await s.say("What first? The key is " + anthropicKey);
      s.model.says("Then the total.");
      await s.say("And then?");
      s.usage.report(s.manager.id, s.model.requests[1]?.session, 0.41);

      s.model.says("The Owner wants the basket, then the total.");
      const compacted = await s.say("/compact keep the order of work");
      expect(compacted.reply).toMatchObject({
        kind: "summary",
        text: "The Owner wants the basket, then the total.",
        replyTo: compacted.message.id,
        compaction: {
          trigger: "owner",
          contextUsage: 0.41,
          upTo: compacted.message.id,
          // The first /compact and its hint, two exchanges, and this /compact.
          messages: 7,
        },
      });
      // The Manager's own Model summarised the conversation for itself.
      const summarising = s.model.requests[2];
      expect(summarising).toMatchObject({
        agentId: s.manager.id,
        model: "claude-opus-5-5",
        session: "manager-chat:web-shop:0",
      });
      expect(summarising?.system).toContain(
        "The Owner asked you to keep this in particular: keep the order of work",
      );
      expect(summarising?.messages).toHaveLength(1);
      const transcript = summarising?.messages[0]?.content ?? "";
      expect(transcript).toContain("Owner: What first? The key is [REDACTED]");
      expect(transcript).toContain(`${s.manager.name}: Then the total.`);
      expect(transcript).not.toContain("Owner: /compact");
      expect(s.usage.ended).toEqual([
        { agentId: s.manager.id, session: "manager-chat:web-shop:0" },
      ]);

      // The next reply is given the summary, not the history.
      s.model.says("Yes: the basket.");
      await s.say("Remind me what is first?");
      const next = s.model.requests[3];
      expect(next?.messages).toEqual([
        { role: "user", content: "Remind me what is first?" },
      ]);
      expect(section(next?.system ?? "", "## Earlier in this conversation"))
        .toBe(`## Earlier in this conversation

The conversation before the messages you are given was compacted into this summary, which you wrote:

The Owner wants the basket, then the total.
`);
      expect(next?.session).toBe(
        `manager-chat:web-shop:${String(compacted.reply.id)}`,
      );

      // Compacting again starts from the summary.
      s.model.says("Still the basket first.");
      await s.say("/compact");
      expect(s.model.requests[4]?.messages[0]?.content).toContain(
        "The conversation already started from this summary of what came before:\n\nThe Owner wants the basket, then the total.",
      );
    },
  ],
  [
    "the chat compacts itself once the Manager's Context Usage reaches its threshold",
    async (stores) => {
      const s = await setUp(stores);
      s.model.says("The basket first.");
      await s.say("What first?");
      // Below the threshold (85% by default): nothing happens.
      s.usage.report(s.manager.id, s.model.requests[0]?.session, 0.849);
      s.model.says("Then the total.");
      await s.say("And then?");
      expect(s.model.requests).toHaveLength(2);
      expect(s.model.requests[1]?.messages).toHaveLength(3);

      // Another conversation's call (a triage, say) does not count.
      s.usage.report(s.manager.id, undefined, 0.97);
      s.model.says("Then the footer.");
      await s.say("And after that?");
      expect(s.model.requests).toHaveLength(3);

      // At the threshold, the next message compacts first.
      s.usage.report(s.manager.id, s.model.requests[2]?.session, 0.85);
      s.model.says("Basket, total, footer: in that order.");
      s.model.says("Then we are done.");
      const asked = await s.say("Anything else?");
      expect(asked.reply).toMatchObject({
        kind: "reply",
        text: "Then we are done.",
      });
      const summary = s.updates.find(
        (update) =>
          update.type === "message" && update.message.kind === "summary",
      );
      expect(summary?.type === "message" && summary.message).toMatchObject({
        text: "Basket, total, footer: in that order.",
        replyTo: null,
        compaction: {
          trigger: "auto",
          contextUsage: 0.85,
          upTo: asked.message.id - 1,
          messages: 6,
        },
      });
      // The summary was written from the history, not the message to answer.
      expect(s.model.requests[3]?.messages[0]?.content).not.toContain(
        "Anything else?",
      );
      // The reply is given the summary and the message it answers.
      const reply = s.model.requests[4];
      expect(reply?.messages).toEqual([
        { role: "user", content: "Anything else?" },
      ]);
      expect(reply?.system).toContain("Basket, total, footer: in that order.");
      expect(s.usage.ended).toEqual([
        { agentId: s.manager.id, session: "manager-chat:web-shop:0" },
      ]);

      // A higher threshold of the Manager's own: 90% is not yet reached.
      await s.stores.agents.update({
        ...s.manager,
        freshStartThreshold: 90,
      });
      s.usage.report(s.manager.id, reply?.session, 0.89);
      s.model.says("Nothing else.");
      await s.say("Sure?");
      expect(s.model.requests).toHaveLength(6);
      expect(s.model.requests[5]?.messages).toHaveLength(3);
    },
  ],
  [
    "a compacted Grilling Session still has every settled decision, word for word",
    async (stores) => {
      const s = await setUp(stores);
      const turn = (value: unknown) => {
        s.model.says(JSON.stringify(value));
      };
      turn({
        questions: [
          { text: "Which records?", recommended: "Orders only." },
          { text: "Who may export?", recommended: "Only the Owner." },
        ],
      });
      await s.say("/grilling CSV export");
      const decisions = [
        "The export holds orders and refunds, one row each; nothing else.",
        "Only the Owner may run an export, from the Floor's admin.",
      ];
      turn({
        decisions: [
          { text: decisions[0], questions: [1] },
          { text: decisions[1], questions: [2] },
        ],
        terms: [{ term: "Export", definition: "A CSV file of orders." }],
        questions: [{ text: "How often?", recommended: "Weekly." }],
      });
      await s.say("1: Orders and refunds\n2: recommended");

      // Compacted: only the back-and-forth is summarised.
      s.model.says("The Owner is exporting for their accountant.");
      const compacted = await s.say("/compact");
      expect(compacted.message.grilling).toEqual({
        sessionId: 1,
        round: null,
      });
      expect(compacted.reply).toMatchObject({
        kind: "summary",
        grilling: { sessionId: 1, round: null },
      });
      expect(s.model.requests[2]?.system).toContain(
        "A Grilling Session is running. Its settled decisions, open questions and glossary terms are kept apart and given back to you word for word, so do not restate them: summarise only the back-and-forth",
      );

      // The next turn: the history is gone, but every decision, the open
      // question and the term are back, word for word.
      turn({ decisions: [], questions: [] });
      const done = await s.say("3: recommended");
      expect(done.reply.text).toContain("No open questions remain");
      const next = s.model.requests[3];
      expect(next?.messages).toEqual([
        { role: "user", content: "3: recommended" },
      ]);
      const system = next?.system ?? "";
      expect(section(system, "### Settled decisions")).toBe(
        `### Settled decisions\n\n1. ${decisions[0] ?? ""}\n2. ${decisions[1] ?? ""}\n`,
      );
      expect(section(system, "### Glossary terms")).toContain(
        "- **Export**: A CSV file of orders.",
      );
      expect(section(system, "## Your turn")).toContain(
        "- Q3: How often?\n  Answer (the recommended one): Weekly.",
      );
      expect(section(system, "## Earlier in this conversation")).toContain(
        "The Owner is exporting for their accountant.",
      );
      // The session's Skill stays loaded.
      expect(system).toContain("### /grilling (built into AI Office)");
      // The session itself is untouched by compacting it.
      const kept = (await s.chat.grillingSession("web-shop", 1)).session;
      expect(kept.decisions.map(({ text }) => text)).toEqual([
        ...decisions,
        "How often? Weekly.",
      ]);

      // /clear in a session: it goes on, with its data.
      const cleared = await s.say("/clear");
      expect(cleared.reply.text).toBe(
        `Cleared the conversation: ${s.manager.name} starts afresh from here. Decisions, Plans and Batches are kept. The Grilling Session 1 on CSV export goes on, with its decisions, glossary terms and open questions.`,
      );
      expect((await s.chat.grillingSession("web-shop", 1)).session.status).toBe(
        "active",
      );
    },
  ],
];

describe("clearing and compacting the Manager chat, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => run(memoryStores()));
  }
});

describe("clearing and compacting the Manager chat, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) => run(databaseStores(database.db)));
  }
});
