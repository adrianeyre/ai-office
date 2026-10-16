import { managerChatMessages } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createRedactor,
  floorErrorCodes,
  type ManagerCommand,
} from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import {
  ModelCallError,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
  type ModelStreamOptions,
} from "../models/client.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createManagerChat,
  type ManagerChat,
  type ManagerChatUpdate,
} from "./chat.ts";

// The Manager chat (PRD FR-24): commands answered in plain code with what
// they were understood as, and refused with a hint when they cannot be
// read, neither reaching a model; anything else streamed from the
// Manager's Model through the AI Gateway (the model client here stands in
// for it) and kept per Floor. Each case runs in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const anthropicKey = "sk-ant-api03-ownerpastedthiskey-Qw3Er4Ty5Ui6Op7As8Df9";

type Answer = (
  request: ModelRequest,
  options: ModelStreamOptions,
) => Promise<ModelReply>;

/** A model whose next answers the test writes, recording each request. */
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
    /** Answers the next call with `text`, a word at a time. */
    says(text: string): void {
      answers.push((_request, { onText }) => {
        for (const word of text.match(/\S+\s*/g) ?? []) {
          onText(word);
        }
        return Promise.resolve({ text, stopReason: "end_turn" });
      });
    },
    /** Answers the next call as `answer` does. */
    next(answer: Answer): void {
      answers.push(answer);
    },
  };
}

interface Setup {
  readonly chat: ManagerChat;
  readonly stores: OfficeStores;
  readonly model: ReturnType<typeof scriptedModel>;
  readonly manager: AgentRecord;
  readonly updates: ManagerChatUpdate[];
  readonly carriedOut: ManagerCommand[];
}

async function setUp(
  stores: OfficeStores,
  options: {
    carryOut?:
      | boolean
      | ((
          floorId: string,
          command: ManagerCommand,
        ) => Promise<string | undefined>);
    report?: { fail: boolean };
  } = {},
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(repository);
  await createFloors({
    store: stores.floors,
    github,
    events: createEventBus({ store: memoryEventStore() }),
  }).add(repository);
  const manager = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "manager",
  );
  if (manager === undefined) {
    throw new Error("A new Floor has a Manager.");
  }
  const model = scriptedModel();
  const carriedOut: ManagerCommand[] = [];
  let tick = 0;
  // Status reports, as `createStatusReports` would write them.
  const report = options.report;
  const chat: ManagerChat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model.client,
    redactor: createRedactor(),
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
    ...(options.carryOut === true
      ? {
          carryOut: (_floorId: string, command: ManagerCommand) => {
            carriedOut.push(command);
            return Promise.resolve("The Batch has started.");
          },
        }
      : typeof options.carryOut === "function"
        ? { carryOut: options.carryOut }
        : {}),
    ...(report === undefined
      ? {}
      : {
          report: (floorId: string, replyTo: number) =>
            report.fail
              ? Promise.reject(new Error("GitHub is down"))
              : chat.postReport(
                  floorId,
                  `Status report on web-shop.\nIn flight: none. ${anthropicKey}`,
                  replyTo,
                ),
        }),
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));
  return { chat, stores, model, manager, updates, carriedOut };
}

/** Resolves once the Manager's answer to `replyTo` is kept. */
async function answerTo(setup: Setup, replyTo: number) {
  await vi.waitFor(() => {
    expect(
      setup.updates.some(
        (update) =>
          update.type === "message" && update.message.replyTo === replyTo,
      ),
    ).toBe(true);
  });
  const update = setup.updates.find(
    (candidate) =>
      candidate.type === "message" && candidate.message.replyTo === replyTo,
  );
  if (update?.type !== "message") {
    throw new Error("unreachable");
  }
  return update.message;
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error as { code?: string },
  );

type Case = [name: string, run: (stores: OfficeStores) => Promise<void>];

const cases: Case[] = [
  [
    "answers a command in plain code with what it understood, and no model sees it",
    async (stores) => {
      const setup = await setUp(stores);
      const { message, reply } = await setup.chat.send(
        "web-shop",
        "  complete issues 1 to 3  ",
      );
      expect(message).toMatchObject({
        floorId: "web-shop",
        kind: "owner",
        text: "complete issues 1 to 3",
        command: null,
        replyTo: null,
        agentId: null,
      });
      expect(reply).toMatchObject({
        kind: "command",
        text: "Understood: complete 3 issues: #1, #2 and #3. Batches are not available here, so nothing was started.",
        command: { kind: "complete", issues: [1, 2, 3] },
        replyTo: message.id,
        agentId: setup.manager.id,
        model: null,
      });
      expect(setup.model.requests).toEqual([]);
      expect(setup.updates).toEqual([
        { type: "message", message },
        { type: "message", message: reply },
      ]);

      for (const [text, answer] of [
        [
          "skip 4",
          "Understood: skip issue #4. Batches are not available here, so nothing changed.",
        ],
        [
          "move 5 up",
          "Understood: move issue #5 up one place. Batches are not available here, so nothing changed.",
        ],
        [
          "pause",
          "Understood: pause this Floor's work. Pausing a Floor is not available yet, so nothing changed.",
        ],
        [
          "resume",
          "Understood: resume this Floor's work. Pausing a Floor is not available yet, so nothing changed.",
        ],
        [
          "status",
          "Understood: a status report on this Floor. Status reports are not available here, so none was written.",
        ],
      ] as const) {
        expect((await setup.chat.send("web-shop", text)).reply?.text).toBe(
          answer,
        );
      }
      expect(setup.model.requests).toEqual([]);
    },
  ],
  [
    "refuses a misspelt command with a hint, and no model sees it",
    async (stores) => {
      const setup = await setUp(stores);
      const { message, reply } = await setup.chat.send(
        "web-shop",
        "compleet issues 1 to 5",
      );
      expect(reply).toMatchObject({
        kind: "hint",
        text: 'I did not understand that. Did you mean "complete issues 1 to 5"?',
        command: null,
        replyTo: message.id,
      });
      const backwards = await setup.chat.send(
        "web-shop",
        "complete issues 5 to 1",
      );
      expect(backwards.reply).toMatchObject({
        kind: "hint",
        text: 'A range goes from the lower number to the higher, such as "complete issues 1 to 5".',
      });
      expect(setup.model.requests).toEqual([]);
    },
  ],
  [
    "carries a command out when it can, saying what it did",
    async (stores) => {
      const setup = await setUp(stores, { carryOut: true });
      const { reply } = await setup.chat.send("web-shop", "complete #4 and #6");
      expect(reply?.text).toBe(
        "Understood: complete 2 issues: #4 and #6. The Batch has started.",
      );
      expect(setup.carriedOut).toEqual([{ kind: "complete", issues: [4, 6] }]);
    },
  ],
  [
    "says nothing changed for a command it cannot carry out yet, and why one failed",
    async (stores) => {
      const setup = await setUp(stores, {
        carryOut: (_floorId, command) =>
          command.kind === "complete"
            ? Promise.reject(new Error("GitHub could not be reached."))
            : Promise.resolve(undefined),
      });
      const skipped = await setup.chat.send("web-shop", "skip 4");
      expect(skipped.reply).toMatchObject({
        kind: "command",
        text: "Understood: skip issue #4. Batches are not available here, so nothing changed.",
      });
      const { message, reply } = await setup.chat.send(
        "web-shop",
        "complete issues 1 to 3",
      );
      expect(reply).toMatchObject({
        kind: "error",
        command: null,
        replyTo: message.id,
        agentId: setup.manager.id,
        text: `Understood: complete 3 issues: #1, #2 and #3. ${setup.manager.name} could not carry it out: GitHub could not be reached.`,
      });
      // The chat takes the next message.
      const next = await setup.chat.send("web-shop", "pause");
      expect(next.reply?.kind).toBe("command");
      expect(setup.model.requests).toEqual([]);
    },
  ],
  [
    'answers "status" with the Manager\'s status report, or why it could not write one',
    async (stores) => {
      const report = { fail: false };
      const setup = await setUp(stores, { report });
      const { message, reply } = await setup.chat.send("web-shop", "status");
      expect(reply).toMatchObject({
        kind: "report",
        text: "Status report on web-shop.\nIn flight: none. [REDACTED]",
        command: null,
        replyTo: message.id,
        agentId: setup.manager.id,
        model: null,
      });
      expect(setup.updates).toEqual([
        { type: "message", message },
        { type: "message", message: reply },
      ]);
      expect(setup.model.requests).toEqual([]);

      // The daily report answers nothing.
      const daily = await setup.chat.postReport("web-shop", "Status report.");
      expect(daily).toMatchObject({
        kind: "report",
        replyTo: null,
        agentId: setup.manager.id,
      });
      expect(await stores.managerChat.latestDailyReport("web-shop")).toEqual(
        daily,
      );
      expect(
        await stores.managerChat.latestDailyReport("blog"),
      ).toBeUndefined();

      report.fail = true;
      const failed = await setup.chat.send("web-shop", "report");
      expect(failed.reply).toMatchObject({
        kind: "error",
        text: `${setup.manager.name} could not write a status report: GitHub is down`,
        replyTo: failed.message.id,
      });
      // The chat takes the next message.
      report.fail = false;
      expect((await setup.chat.send("web-shop", "status")).reply?.kind).toBe(
        "report",
      );
    },
  ],
  [
    "streams anything else from the Manager's Model, then keeps the reply",
    async (stores) => {
      const setup = await setUp(stores);
      let release: () => void = () => undefined;
      setup.model.next(async (_request, { onText }) => {
        onText("Start with ");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        onText("#4.");
        return { text: "Start with #4.", stopReason: "end_turn" };
      });
      const { message, reply } = await setup.chat.send(
        "web-shop",
        "What should we work on first?",
      );
      expect(reply).toBeUndefined();
      await vi.waitFor(() => {
        expect(setup.updates).toContainEqual({
          type: "delta",
          replyTo: message.id,
          text: "Start with ",
        });
      });

      // While it is written: a new listener and the history start from it.
      // (The Floor's next message would interrupt it: see
      // chat-attachments.test.ts.)
      const late: ManagerChatUpdate[] = [];
      const subscription = setup.chat.subscribe("web-shop", (update) =>
        late.push(update),
      );
      expect(subscription.pending).toEqual([
        { replyTo: message.id, text: "Start with " },
      ]);
      expect((await setup.chat.history("web-shop")).pending).toEqual([
        { replyTo: message.id, text: "Start with " },
      ]);
      release();
      const kept = await answerTo(setup, message.id);
      expect(kept).toMatchObject({
        kind: "reply",
        text: "Start with #4.",
        replyTo: message.id,
        agentId: setup.manager.id,
        model: "claude-opus-5-5",
      });
      expect(late).toEqual([
        { type: "delta", replyTo: message.id, text: "#4." },
        { type: "message", message: kept },
      ]);
      subscription.unsubscribe();
      const history = await setup.chat.history("web-shop");
      expect(history.pending).toEqual([]);
      expect(history.messages).toEqual([message, kept]);
      expect(history.manager.id).toBe(setup.manager.id);
      expect(history.model).toBe("claude-opus-5-5");

      // The call: the Manager's own, with its Model, prompt and the message.
      const [request] = setup.model.requests;
      expect(request).toMatchObject({
        agentId: setup.manager.id,
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "What should we work on first?" }],
        maxTokens: 4096,
      });
      expect(request?.issue).toBeUndefined();
      expect(request?.system).toContain(
        `You are ${setup.manager.name}, the Manager of the Floor "web-shop" in AI Office.`,
      );
      expect(request?.system).toContain(repository);
      expect(request?.system).toContain('"complete issues 1 to 5"');
    },
  ],
  [
    "gives the Model the conversation so far",
    async (stores) => {
      const setup = await setUp(stores);
      await setup.chat.send("web-shop", "skip 4");
      setup.model.says("Noted.");
      const first = await setup.chat.send("web-shop", "Why skip it?");
      await answerTo(setup, first.message.id);
      setup.model.says("Yes.");
      const second = await setup.chat.send("web-shop", "Fine?");
      await answerTo(setup, second.message.id);
      expect(setup.model.requests[1]?.messages).toEqual([
        { role: "user", content: "skip 4" },
        {
          role: "assistant",
          content:
            "Understood: skip issue #4. Batches are not available here, so nothing changed.",
        },
        { role: "user", content: "Why skip it?" },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "Fine?" },
      ]);
    },
  ],
  [
    "keeps why the Model did not answer, and takes the next message",
    async (stores) => {
      const setup = await setUp(stores);
      setup.model.next(() =>
        Promise.reject(
          new ModelCallError(
            403,
            `The AI Gateway answered 403: ${setup.manager.name} has reached its daily Token Cap.`,
          ),
        ),
      );
      const { message } = await setup.chat.send("web-shop", "Status?");
      expect(await answerTo(setup, message.id)).toMatchObject({
        kind: "error",
        text: `${setup.manager.name} could not answer: The AI Gateway answered 403: ${setup.manager.name} has reached its daily Token Cap.`,
        model: "claude-opus-5-5",
      });
      setup.model.says("");
      const empty = await setup.chat.send("web-shop", "Status?");
      expect((await answerTo(setup, empty.message.id)).text).toBe(
        `${setup.manager.name} gave no answer.`,
      );
      // Errors are not part of the conversation the Model is given.
      setup.model.says("All quiet.");
      const next = await setup.chat.send("web-shop", "And now?");
      expect((await answerTo(setup, next.message.id)).kind).toBe("reply");
      expect(setup.model.requests[2]?.messages).toEqual([
        { role: "user", content: "Status?\n\nStatus?\n\nAnd now?" },
      ]);
    },
  ],
  [
    "a paused Manager does not answer, but commands still are",
    async (stores) => {
      const setup = await setUp(stores);
      await stores.agents.update({ ...setup.manager, enabled: false });
      const { message } = await setup.chat.send("web-shop", "Hello?");
      expect(await answerTo(setup, message.id)).toMatchObject({
        kind: "error",
        text: `${setup.manager.name} is paused, so does not answer. Turn ${setup.manager.name} back on in Floor Settings.`,
      });
      expect((await setup.chat.send("web-shop", "skip 2")).reply?.kind).toBe(
        "command",
      );
      expect(setup.model.requests).toEqual([]);
    },
  ],
  [
    "keeps credentials out of what it keeps and sends",
    async (stores) => {
      const setup = await setUp(stores);
      setup.model.says(`Your key is ${anthropicKey}`);
      const { message } = await setup.chat.send(
        "web-shop",
        `My key is ${anthropicKey}, use it.`,
      );
      expect(message.text).toBe("My key is [REDACTED], use it.");
      const reply = await answerTo(setup, message.id);
      expect(reply.text).toBe("Your key is [REDACTED]");
      expect(JSON.stringify(setup.model.requests)).not.toContain(anthropicKey);
      expect(
        JSON.stringify(await setup.chat.history("web-shop")),
      ).not.toContain(anthropicKey);
    },
  ],
  [
    "refuses an unknown Floor, and messages to an archived one",
    async (stores) => {
      const setup = await setUp(stores);
      await setup.chat.send("web-shop", "pause");
      for (const attempt of [
        setup.chat.send("nowhere", "pause"),
        setup.chat.history("nowhere"),
      ]) {
        expect((await refusal(attempt)).code).toBe(
          floorErrorCodes.floorNotFound,
        );
      }
      await stores.floors.archive("web-shop", new Date());
      expect((await refusal(setup.chat.send("web-shop", "resume"))).code).toBe(
        floorErrorCodes.floorArchived,
      );
      // Its chat can still be read.
      expect((await setup.chat.history("web-shop")).messages).toHaveLength(2);
    },
  ],
  [
    "stopping keeps why a reply was left unfinished",
    async (stores) => {
      const setup = await setUp(stores);
      setup.model.next(
        (_request, { onText, signal }) =>
          new Promise((_resolve, reject) => {
            onText("Let me think");
            signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      );
      const { message } = await setup.chat.send("web-shop", "Plan it?");
      await vi.waitFor(() => {
        expect(setup.updates.some(({ type }) => type === "delta")).toBe(true);
      });
      await setup.chat.stop();
      expect(await answerTo(setup, message.id)).toMatchObject({
        kind: "error",
        text: `AI Office stopped before ${setup.manager.name} finished answering.`,
      });
    },
  ],
  [
    "ends what a removed Floor's Manager is doing, keeping why",
    async (stores) => {
      const setup = await setUp(stores);
      setup.model.next(
        (_request, { onText, signal }) =>
          new Promise((_resolve, reject) => {
            onText("Let me think");
            signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      );
      const { message } = await setup.chat.send("web-shop", "Plan it?");
      await vi.waitFor(() => {
        expect(setup.updates.some(({ type }) => type === "delta")).toBe(true);
      });
      await stores.floors.archive("web-shop", new Date());
      await setup.chat.end("web-shop");
      expect(await answerTo(setup, message.id)).toMatchObject({
        kind: "error",
        text: `AI Office stopped before ${setup.manager.name} finished answering.`,
      });
      // A Floor with nothing going on has nothing to end.
      await setup.chat.end("web-shop");
    },
  ],
  [
    "reads messages after one it was given, a Floor at a time",
    async (stores) => {
      const setup = await setUp(stores);
      const first = await setup.chat.send("web-shop", "pause");
      await setup.chat.send("web-shop", "resume");
      const after = await setup.chat.after("web-shop", first.reply?.id ?? 0);
      expect(after.map(({ text }) => text)).toEqual([
        "resume",
        "Understood: resume this Floor's work. Pausing a Floor is not available yet, so nothing changed.",
      ]);
      expect(await setup.chat.after("other", 0)).toEqual([]);
      expect(
        (await setup.chat.history("web-shop", 1)).messages.map(
          ({ kind }) => kind,
        ),
      ).toEqual(["command"]);
    },
  ],
];

describe("the Manager chat, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(memoryStores());
    });
  }
});

describe("the Manager chat, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(databaseStores(database.db));
    });
  }

  postgresTest(
    "the table refuses a message that answers nothing, or a command without one",
    async ({ database }) => {
      const stores = databaseStores(database.db);
      await setUp(stores);
      const row = {
        floorId: "web-shop",
        text: "x",
        createdAt: new Date(),
      };
      await expect(
        database.db
          .insert(managerChatMessages)
          .values({ ...row, kind: "reply", agentId: "a" }),
      ).rejects.toThrow();
      await expect(
        database.db.insert(managerChatMessages).values({
          ...row,
          kind: "owner",
          command: { kind: "pause" },
        }),
      ).rejects.toThrow();
      await expect(
        database.db
          .insert(managerChatMessages)
          .values({ ...row, kind: "shout" }),
      ).rejects.toThrow();
      // Only a status report may answer nothing: the daily one.
      await expect(
        database.db
          .insert(managerChatMessages)
          .values({ ...row, kind: "report", agentId: "a" }),
      ).resolves.toBeDefined();
      await expect(
        database.db
          .insert(managerChatMessages)
          .values({ ...row, kind: "report" }),
      ).rejects.toThrow();
    },
  );
});
