import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  memoryEventStore,
  type EventOfType,
  type StoredEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createRedactor } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createManagerChat, type ManagerChatUpdate } from "../manager/chat.ts";
import type { ModelClient, ModelReply } from "../models/client.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { publishingGrillingStore, sessionChange } from "./session-events.ts";
import type { GrillingSessionRecord } from "./session.ts";
import { memoryGrillingStore } from "./store.ts";

// A Grilling Session's course on the event bus (PRD FR-83): the Manager
// chat runs a session through `/grilling`, an answer, a pause, a resume,
// "recommended to all" twice and "confirm", and each change the Office
// shows is published once, as `grilling.session_changed`, with counts
// only. The Office's meeting room is a projection of these.

const repository = "adrianeyre/web-shop";

const at = new Date(Date.UTC(2026, 9, 10, 12));

const question = (
  number: number,
  round: number | null,
  status: "open" | "answered" | "withdrawn" = "open",
) => ({
  number,
  round,
  text: `Question ${String(number)}?`,
  recommended: "Yes.",
  dependsOn: [],
  status,
  answer: status === "answered" ? "Yes." : null,
  acceptedRecommended: status === "answered",
  answeredAt: status === "answered" ? at.toISOString() : null,
});

const session = (
  change: Partial<GrillingSessionRecord> = {},
): GrillingSessionRecord => ({
  id: 1,
  floorId: "web-shop",
  topic: "exports",
  skill: "grilling",
  status: "active",
  round: 1,
  awaitingConfirmation: false,
  questions: [question(1, 1), question(2, 1)],
  decisions: [],
  terms: [],
  facts: [],
  outline: [],
  adrs: [],
  processes: [],
  documents: null,
  issues: null,
  sources: [],
  startedAt: at,
  updatedAt: at,
  pausedAt: null,
  endedAt: null,
  ...change,
});

/** A new session, as the chat gives it to the store to keep. */
const fresh = (): Omit<GrillingSessionRecord, "id"> => {
  const { id, ...rest } = session({ round: 0, questions: [] });
  expect(id).toBe(1);
  return rest;
};

describe("sessionChange", () => {
  it("names what the Office shows of a session's change", () => {
    const running = session();
    expect(sessionChange(undefined, session({ round: 0 }))).toBe("started");
    expect(sessionChange(running, session({ status: "paused" }))).toBe(
      "paused",
    );
    expect(sessionChange(session({ status: "paused" }), running)).toBe(
      "resumed",
    );
    expect(sessionChange(running, session({ status: "ended" }))).toBe("ended");
    expect(
      sessionChange(
        running,
        session({ round: 2, questions: [question(1, 1, "answered")] }),
      ),
    ).toBe("round");
    expect(
      sessionChange(
        running,
        session({ questions: [question(1, 1, "answered"), question(2, 1)] }),
      ),
    ).toBe("settled");
    expect(
      sessionChange(
        running,
        session({ questions: [question(1, 1, "withdrawn"), question(2, 1)] }),
      ),
    ).toBe("settled");
    expect(
      sessionChange(
        running,
        session({
          decisions: [
            {
              number: 1,
              text: "Orders only.",
              questions: [1],
              round: 1,
              settledAt: at.toISOString(),
            },
          ],
        }),
      ),
    ).toBe("settled");
  });

  it("names nothing when only what has events of its own changed", () => {
    const running = session();
    expect(
      sessionChange(
        running,
        session({
          facts: [
            {
              number: 1,
              question: "Which database?",
              answer: "Postgres 18.",
              status: "found",
              agentId: "mo",
              round: 1,
              foundAt: at.toISOString(),
            },
          ],
          outline: [{ heading: "Summary", text: "Exports." }],
          updatedAt: new Date(at.getTime() + 1000),
        }),
      ),
    ).toBeUndefined();
  });
});

describe("publishingGrillingStore", () => {
  it("never fails a save when its event cannot be published", async () => {
    const store = memoryGrillingStore();
    const errors: unknown[] = [];
    const publishing = publishingGrillingStore(store, {
      events: { publish: () => Promise.reject(new Error("bus down")) },
      agents: {
        list: () =>
          Promise.resolve([{ id: "mo", role: "manager" }] as Awaited<
            ReturnType<OfficeStores["agents"]["list"]>
          >),
      },
      onError: (error) => errors.push(error),
    });
    const created = await publishing.create(fresh());
    const paused = await publishing.save({ ...created, status: "paused" });
    expect(paused.status).toBe("paused");
    expect(store.sessions[0]?.status).toBe("paused");
    expect(errors).toEqual([new Error("bus down"), new Error("bus down")]);
  });

  it("publishes nothing for a Floor without a Manager", async () => {
    const published: unknown[] = [];
    const publishing = publishingGrillingStore(memoryGrillingStore(), {
      events: {
        publish: (event) => {
          published.push(event);
          return Promise.reject(new Error("unreachable"));
        },
      },
      agents: { list: () => Promise.resolve([]) },
    });
    await publishing.create(fresh());
    expect(published).toEqual([]);
  });
});

/** A model whose JSON turns the test writes. */
function scriptedModel() {
  const answers: string[] = [];
  const client: ModelClient = {
    complete: () => Promise.reject(new Error("The chat streams its calls.")),
    stream(_request, { onText }) {
      const text = answers.shift();
      if (text === undefined) {
        return Promise.reject(new Error("No answer was scripted."));
      }
      onText(text);
      return Promise.resolve<ModelReply>({ text, stopReason: "end_turn" });
    },
  };
  return {
    client,
    turn(value: unknown): void {
      answers.push(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
    },
  };
}

async function setUp(stores: OfficeStores) {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const events = createEventBus({ store: memoryEventStore() });
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const changes: StoredEvent[] = [];
  events.subscribe(
    (stored) => {
      changes.push(stored);
    },
    {
      types: ["grilling.session_changed"],
    },
  );
  const model = scriptedModel();
  let tick = 0;
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model.client,
    grilling: publishingGrillingStore(stores.grilling, {
      events,
      agents: stores.agents,
    }),
    redactor: createRedactor(),
    now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++)),
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));
  const say = async (text: string) => {
    const sent = await chat.send("web-shop", text);
    if (sent.reply === undefined) {
      await vi.waitFor(() => {
        expect(
          updates.some(
            (update) =>
              update.type === "message" &&
              update.message.replyTo === sent.message.id,
          ),
        ).toBe(true);
      });
    }
  };
  const manager = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "manager",
  );
  return { model, say, changes, managerId: manager?.id ?? "" };
}

type Case = [name: string, run: (stores: OfficeStores) => Promise<void>];

const cases: Case[] = [
  [
    "a session's course in the Manager chat is published once per change, with counts only",
    async (stores) => {
      const s = await setUp(stores);
      s.model.turn({
        message: "",
        questions: [
          { text: "Which records?", recommended: "Orders only." },
          { text: "Who may run it?", recommended: "Only the Owner." },
        ],
      });
      await s.say("/grilling CSV export for orders");
      await s.say("1: Orders and refunds");
      await s.say("pause the session");
      await s.say("resume the session");
      s.model.turn({
        message: "",
        decisions: [
          { text: "Orders and refunds, a row each.", questions: [1] },
        ],
        questions: [{ text: "How often?", recommended: "Weekly." }],
      });
      await s.say("recommended to all");
      s.model.turn({
        message: "",
        decisions: [{ text: "Sent weekly.", questions: [3] }],
        questions: [],
      });
      await s.say("recommended to all");
      await s.say("confirm");

      const of = (
        change: string,
        status: string,
        round: number,
        openQuestions: number,
        decisions: number,
      ): EventOfType<"grilling.session_changed"> =>
        ({
          type: "grilling.session_changed",
          version: 1,
          floorId: "web-shop",
          agentId: s.managerId,
          sessionId: 1,
          change,
          status,
          round,
          openQuestions,
          decisions,
        }) as EventOfType<"grilling.session_changed">;
      expect(s.changes.map(({ event }) => event)).toEqual([
        of("started", "active", 0, 0, 0),
        of("round", "active", 1, 2, 0),
        of("settled", "active", 1, 1, 0),
        of("paused", "paused", 1, 1, 0),
        of("resumed", "active", 1, 1, 0),
        // "recommended to all" settles question 2, then round 2 is asked.
        of("settled", "active", 1, 0, 0),
        of("round", "active", 2, 1, 2),
        of("settled", "active", 2, 0, 2),
        of("settled", "active", 2, 0, 3),
        of("ended", "ended", 2, 0, 3),
      ]);
      expect(s.managerId).not.toBe("");
    },
  ],
];

describe("a Grilling Session's events, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => run(memoryStores()));
  }
});

describe("a Grilling Session's events, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) => run(databaseStores(database.db)));
  }
});
