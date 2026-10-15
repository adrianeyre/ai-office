import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createRedactor, endGrillingText } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createManagerChat, type ManagerChatUpdate } from "../manager/chat.ts";
import { floorChatSkills } from "../manager/chat-skills.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { createFloorSkills } from "../skills/floor.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";

// A Grilling Session, end to end (PRD §5 scenario 8, FR-77, FR-78, FR-82):
// the Owner runs `/grilling` in the Manager chat, and the Manager's Model,
// which the test scripts, asks rounds of numbered questions with
// recommended answers. The Owner answers one, pauses the session, resumes
// it, accepts the rest with "recommended to all", gets a second round
// (holding a question that waited on the first's answers), accepts that
// too, and confirms once no open questions remain. Each case runs in
// memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const anthropicKey = "sk-ant-api03-saidinagrilling-Qw3Er4Ty5Ui6Op7As8Df9";

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
    turn(value: unknown): void {
      this.says(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
    },
  };
}

async function setUp(stores: OfficeStores) {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const events = createEventBus({ store: memoryEventStore() });
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const model = scriptedModel();
  let tick = 0;
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model.client,
    grilling: stores.grilling,
    redactor: createRedactor(),
    now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++)),
    skills: floorChatSkills(
      createFloorSkills({
        floors: stores.floors,
        library: stores.skills,
        toggles: stores.floorSkills,
        reviews: stores.repositorySkillReviews,
        events,
        github,
      }),
    ),
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
  return { chat, model, say, updates };
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

const firstRound = {
  message: "Let's settle what the export is for.",
  questions: [
    {
      text: "Which records does the export hold?",
      recommended: "Orders only.",
    },
    {
      text: "Who may run an export?",
      recommended: `Only the Owner. Never paste ${anthropicKey}.`,
    },
    {
      text: "Which columns come first?",
      recommended: "Order number, then date.",
      dependsOn: [1],
    },
  ],
};

const secondRound = {
  message: "",
  decisions: [
    {
      text: "The export holds orders and refunds, one row each.",
      questions: [1],
    },
  ],
  terms: [
    {
      term: "Export",
      definition: "A CSV file of a Floor's orders and refunds.",
      avoid: ["dump", "report"],
    },
  ],
  questions: [
    {
      text: "How often is it sent?",
      recommended: "Weekly, on Mondays.",
    },
  ],
};

const lastTurn = {
  message: "That settles it.",
  decisions: [
    { text: "The columns start with order number, then date.", questions: [3] },
    { text: "Exports are sent weekly, on Mondays.", questions: [4] },
  ],
  questions: [],
};

type Case = [name: string, run: (stores: OfficeStores) => Promise<void>];

const cases: Case[] = [
  [
    "two rounds, a pause and a resume, recommended to all, and the session ends on confirmation",
    async (stores) => {
      const s = await setUp(stores);

      // `/grilling` starts a session, and the Model asks round 1.
      s.model.turn(firstRound);
      const started = await s.say("/grilling CSV export for orders");
      expect(started.message).toMatchObject({
        kind: "owner",
        skill: {
          name: "grilling",
          source: "built-in",
          arguments: "CSV export for orders",
          chosenBy: "owner",
        },
        grilling: { sessionId: 1, round: null },
      });
      expect(started.reply).toMatchObject({
        kind: "reply",
        grilling: { sessionId: 1, round: 1 },
      });
      expect(started.reply.text).toBe(
        [
          "Let's settle what the export is for.",
          "",
          "Round 1: 2 questions.",
          "",
          "1. Which records does the export hold?",
          "   Recommended: Orders only.",
          "",
          "2. Who may run an export?",
          "   Recommended: Only the Owner. Never paste [REDACTED].",
          "",
          'Answer each by its number ("1: …"), reply "1: recommended" to accept one, or "recommended to all".',
        ].join("\n"),
      );
      // Its JSON was never told to listeners as it was written.
      expect(
        s.updates.some(
          (update) =>
            update.type === "delta" && update.replyTo === started.message.id,
        ),
      ).toBe(false);
      const first = s.model.requests[0]?.system ?? "";
      expect(first).toContain("### /grilling (built into AI Office)");
      expect(section(first, "## The Grilling Session")).toContain(
        "on: CSV export for orders",
      );
      expect(section(first, "## Your turn")).toContain(
        "Start the session: ask the first round of questions.",
      );
      expect(first).not.toContain(anthropicKey);
      // Question 3 waits for question 1's answer.
      let session = (await s.chat.grillingSession("web-shop", 1)).session;
      expect(
        session.questions.map(({ number, round, status }) => ({
          number,
          round,
          status,
        })),
      ).toEqual([
        { number: 1, round: 1, status: "open" },
        { number: 2, round: 1, status: "open" },
        { number: 3, round: null, status: "open" },
      ]);

      // An answer to one question is noted; no model is asked.
      const one = await s.say("1: Orders and refunds, one row each");
      expect(one.reply).toMatchObject({
        kind: "grilling",
        text: "Noted your answer to 1. Still open in round 1: 2.",
        grilling: { sessionId: 1, round: null },
      });
      expect(s.model.requests).toHaveLength(1);

      // Paused: kept, and the chat is the Manager's own again.
      const paused = await s.say("pause the session");
      expect(paused.reply).toMatchObject({
        kind: "grilling",
        text: 'Paused the Grilling Session 1 on CSV export for orders. Round 1 has question 2 open, and 0 decisions settled. It is kept with its full history: say "resume session 1" to carry on.',
      });
      expect((await s.chat.grillingSessions("web-shop"))[0]).toMatchObject({
        status: "paused",
      });
      s.model.says("Sunny, by the look of it.");
      const aside = await s.say("Is it sunny?");
      expect(aside.message.grilling).toBeNull();
      expect(aside.reply).toMatchObject({
        kind: "reply",
        text: "Sunny, by the look of it.",
        grilling: null,
      });
      expect(s.model.requests[1]?.system).not.toContain(
        "## The Grilling Session",
      );

      // Resumed, with round 1's open question shown again.
      const resumed = await s.say("resume the session");
      expect(resumed.reply).toMatchObject({
        kind: "grilling",
        text: "Resumed the Grilling Session 1 on CSV export for orders. Round 1 has question 2 open, and 0 decisions settled.",
        grilling: { sessionId: 1, round: 1 },
      });

      // "recommended to all" accepts the rest; the Model asks round 2.
      s.model.turn(secondRound);
      const all = await s.say("recommended to all");
      expect(all.reply).toMatchObject({
        kind: "reply",
        grilling: { sessionId: 1, round: 2 },
      });
      expect(all.reply.text).toContain("Round 2: 2 questions.");
      expect(all.reply.text).toContain(
        "3. Which columns come first?\n   Recommended: Order number, then date.",
      );
      expect(all.reply.text).toContain(
        "4. How often is it sent?\n   Recommended: Weekly, on Mondays.",
      );
      const second = s.model.requests[2]?.system ?? "";
      expect(section(second, "## Your turn")).toContain(
        "The Owner has answered every question of round 1:\n- Q1: Which records does the export hold?\n  Answer: Orders and refunds, one row each\n- Q2: Who may run an export?\n  Answer (the recommended one): Only the Owner. Never paste [REDACTED].",
      );
      session = (await s.chat.grillingSession("web-shop", 1)).session;
      expect(session).toMatchObject({
        status: "active",
        round: 2,
        terms: [
          {
            term: "Export",
            definition: "A CSV file of a Floor's orders and refunds.",
            avoid: ["dump", "report"],
          },
        ],
      });
      // The Model settled question 1; AI Office settled question 2 from its answer.
      expect(
        session.decisions.map(({ text, questions }) => [text, questions]),
      ).toEqual([
        ["The export holds orders and refunds, one row each.", [1]],
        ["Who may run an export? Only the Owner. Never paste [REDACTED].", [2]],
      ]);
      expect(session.questions[1]).toMatchObject({
        status: "answered",
        acceptedRecommended: true,
      });

      // Round 2 accepted too; no open questions remain, and the Owner confirms.
      s.model.turn(lastTurn);
      const done = await s.say("Recommended to all.");
      expect(done.reply).toMatchObject({
        kind: "reply",
        text: 'That settles it.\n\nNo open questions remain: 4 decisions are settled. Reply "confirm" to end the Grilling Session, or say what is still unsettled.',
        grilling: { sessionId: 1, round: null },
      });
      const third = s.model.requests[3]?.system ?? "";
      // Every settled decision is in the prompt word for word.
      expect(section(third, "### Settled decisions")).toBe(
        [
          "### Settled decisions",
          "",
          "1. The export holds orders and refunds, one row each.",
          "2. Who may run an export? Only the Owner. Never paste [REDACTED].",
          "",
        ].join("\n"),
      );
      const ended = await s.say("Confirm");
      expect(ended.reply).toMatchObject({
        kind: "grilling",
        text: "Ended the Grilling Session 1 on CSV export for orders: 4 decisions settled and 1 glossary term. It is kept with its full history in the Grilling Sessions list.",
      });
      expect(s.model.requests).toHaveLength(4);

      // Kept with its full history.
      const kept = await s.chat.grillingSession("web-shop", 1);
      expect(kept.session).toMatchObject({
        status: "ended",
        awaitingConfirmation: false,
      });
      expect(kept.session.endedAt).not.toBeNull();
      expect(kept.session.decisions.map(({ text }) => text)).toEqual([
        "The export holds orders and refunds, one row each.",
        "Who may run an export? Only the Owner. Never paste [REDACTED].",
        "The columns start with order number, then date.",
        "Exports are sent weekly, on Mondays.",
      ]);
      expect(
        kept.messages.map(({ kind, text }) => [kind, text.split("\n")[0]]),
      ).toEqual([
        ["owner", "/grilling CSV export for orders"],
        ["reply", "Let's settle what the export is for."],
        ["owner", "1: Orders and refunds, one row each"],
        ["grilling", "Noted your answer to 1. Still open in round 1: 2."],
        ["owner", "pause the session"],
        ["grilling", expect.stringMatching(/^Paused/)],
        ["owner", "resume the session"],
        ["grilling", expect.stringMatching(/^Resumed/)],
        ["owner", "recommended to all"],
        ["reply", "Round 2: 2 questions."],
        ["owner", "Recommended to all."],
        ["reply", "That settles it."],
        ["owner", "Confirm"],
        ["grilling", expect.stringMatching(/^Ended/)],
      ]);

      // After it ends, messages are the Manager's own again.
      s.model.says("Glad to help.");
      const after = await s.say("Thanks!");
      expect(after.reply.grilling).toBeNull();
    },
  ],
  [
    "a session's questions are answered in plain code, and what cannot be read is refused with a hint",
    async (stores) => {
      const s = await setUp(stores);
      s.model.turn(firstRound);
      await s.say("/grilling");

      // A second session cannot start while one runs.
      const again = await s.say("/grilling something else");
      expect(again.reply).toMatchObject({
        kind: "hint",
        text: 'The Grilling Session 1 is running: Round 1 has questions 1 and 2 open, and 0 decisions settled. Say "pause the session" before starting another.',
      });
      // A bare "recommended" with two questions open.
      expect((await s.say("recommended")).reply).toMatchObject({
        kind: "hint",
        text: 'Questions 1 and 2 are open in round 1: say which you accept, as "1: recommended", or reply "recommended to all".',
      });
      // A question not in the round.
      expect((await s.say("3: Order number first")).reply).toMatchObject({
        kind: "hint",
        text: "Question 3 is not in round 1, so was left. Its open questions are 1 and 2.",
      });
      // Confirming with questions open.
      expect((await s.say("confirm")).reply).toMatchObject({
        kind: "hint",
        text: "The Grilling Session 1 has questions still to settle. Round 1 has questions 1 and 2 open, and 0 decisions settled.",
      });
      // A question about the round goes to the Model, with the session in its prompt.
      s.model.says("Refunds are rows of their own.");
      const asked = await s.say("Would refunds be in it?");
      expect(asked.reply).toMatchObject({
        kind: "reply",
        text: "Refunds are rows of their own.",
        grilling: { sessionId: 1, round: null },
      });
      const prompt = s.model.requests[1]?.system ?? "";
      expect(section(prompt, "### Open questions")).toContain(
        "- Q1, asked in round 1: Which records does the export hold?\n  Recommended: Orders only.",
      );
      expect(section(prompt, "### Open questions")).toContain(
        "- Q3, not yet asked (asked once Q1 is settled): Which columns come first?",
      );
      expect(prompt).not.toContain("## Your turn");
      // Commands still work in a session.
      expect((await s.say("status")).reply.kind).toBe("command");

      // An answer that cannot be kept is asked for once more.
      s.model.says("Here you go: no JSON.");
      s.model.turn({ questions: [], decisions: [] });
      const settled = await s.say("1: recommended\n2: Anyone on the team");
      // Question 3 waited on 1, now settled, so the next round asks it.
      expect(settled.reply.text).toContain(
        "Round 2: 1 question.\n\n3. Which columns come first?",
      );
      expect(s.model.requests[3]?.messages.at(-1)).toEqual({
        role: "user",
        content:
          "That answer is not one AI Office can keep: It has no JSON object. Answer again with only the JSON object, in the form asked for.",
      });
      const session = (await s.chat.grillingSession("web-shop", 1)).session;
      expect(session.awaitingConfirmation).toBe(false);
      expect(session.round).toBe(2);
      expect(settled.reply.grilling).toEqual({ sessionId: 1, round: 2 });

      // Pausing, then resuming a session that does not exist, or by number.
      await s.say("pause the session");
      expect((await s.say("resume session 9")).reply.text).toBe(
        "There is no Grilling Session 9 on this Floor.",
      );
      expect((await s.say("resume session 1")).reply.kind).toBe("grilling");
    },
  ],
  [
    "End session ends a running or a paused session now, with its questions still open (FR-83a)",
    async (stores) => {
      const s = await setUp(stores);
      // Nothing to end yet: an ordinary message, with no session.
      expect((await s.say(endGrillingText)).reply).toMatchObject({
        kind: "hint",
        text: "No Grilling Session is running or paused, so none was ended.",
      });

      s.model.turn(firstRound);
      await s.say("/grilling");
      const ended = await s.say(endGrillingText);
      expect(ended.reply).toMatchObject({
        kind: "grilling",
        text: "Ended the Grilling Session 1: 0 decisions settled. Questions 1 and 2 of round 1 were left open. It is kept with its full history in the Grilling Sessions list.",
        grilling: { sessionId: 1, round: null },
      });
      const first = (await s.chat.grillingSession("web-shop", 1)).session;
      expect(first.status).toBe("ended");
      expect(first.endedAt).not.toBeNull();
      // No model was asked to end it.
      expect(s.model.requests).toHaveLength(1);

      // A paused session is ended too, with none running.
      s.model.turn(firstRound);
      await s.say("/grilling the import");
      await s.say("pause the session");
      expect((await s.say("End the grilling session now.")).reply.text).toMatch(
        /^Ended the Grilling Session 2 on the import: 0 decisions settled\./,
      );
      expect((await s.chat.grillingSession("web-shop", 2)).session.status).toBe(
        "ended",
      );
      // And once ended, there is none left to end.
      expect((await s.say(endGrillingText)).reply.kind).toBe("hint");
    },
  ],
];

describe("Grilling Sessions in the Manager chat, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => run(memoryStores()));
  }
});

describe("Grilling Sessions in the Manager chat, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) => run(databaseStores(database.db)));
  }
});
