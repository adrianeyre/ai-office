import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createRedactor } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import type { ModelClient, ModelRequest } from "../models/client.ts";
import { memoryStores } from "../stores.ts";
import { createManagerChat, type ManagerChatUpdate } from "./chat.ts";
import { createManagerChatSessions } from "./chat-sessions.ts";
import { createFakeSessionTool } from "./fake-chat-sessions.ts";

// The Manager chat as a continuing, read-only agent session (PRD FR-24,
// ADR 0004), with a fake agent tool: the Manager's plain replies are turns
// of its conversation's session, the tools it used are told as it uses
// them and kept on its reply, a second message resumes the same session
// with only the new turn, and "/clear" starts a new one. A Manager whose
// AI Provider has no agent tool still answers in one Gateway call.

const repository = "adrianeyre/web-shop";

async function setUp() {
  const stores = memoryStores();
  const github = createFakeGitHub();
  github.installRepository(repository);
  await createFloors({
    store: stores.floors,
    github,
    events: createEventBus({ store: memoryEventStore() }),
  }).add(repository);
  const tool = createFakeSessionTool();
  const requests: ModelRequest[] = [];
  const models: ModelClient = {
    complete: () => Promise.reject(new Error("The chat streams its calls.")),
    stream(request, { onText }) {
      requests.push(request);
      onText("One call.");
      return Promise.resolve({ text: "One call.", stopReason: "end_turn" });
    },
  };
  let tick = 0;
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models,
    attachments: stores.chatAttachments,
    sessions: createManagerChatSessions({
      store: stores.managerChatSessions,
      tool,
    }),
    redactor: createRedactor(),
    now: () => new Date(Date.UTC(2026, 9, 11, 12, 0, tick++)),
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));
  /** Uploads a screenshot, for a message to send. */
  const screenshot = async () =>
    (
      await stores.chatAttachments.add({
        floorId: "web-shop",
        name: "checkout error.png",
        mediaType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        createdAt: new Date(Date.UTC(2026, 9, 11, 11, 0, 0)),
      })
    ).id;
  /** Sends `text`, and resolves with the Manager's reply once it is kept. */
  const say = async (text: string, attachments: readonly string[] = []) => {
    const { message, reply } = await chat.send("web-shop", text, [
      ...attachments,
    ]);
    if (reply !== undefined) {
      return reply;
    }
    await vi.waitFor(() => {
      expect(
        updates.some(
          (update) =>
            update.type === "message" && update.message.replyTo === message.id,
        ),
      ).toBe(true);
    });
    const kept = updates.find(
      (update) =>
        update.type === "message" && update.message.replyTo === message.id,
    );
    if (kept?.type !== "message") {
      throw new Error("unreachable");
    }
    return kept.message;
  };
  return { stores, tool, requests, chat, updates, say, screenshot };
}

describe("the Manager chat's read-only agent session", () => {
  it("tells each tool the session used, and keeps them on the reply", async () => {
    const s = await setUp();
    s.tool.answer({
      text: "Totals are worked out in src/total.ts.",
      tools: [
        { name: "Grep", summary: '"total" in src' },
        { name: "Read", summary: "src/total.ts" },
      ],
    });
    const reply = await s.say("Where are totals worked out?");
    expect(reply).toMatchObject({
      kind: "reply",
      text: "Totals are worked out in src/total.ts.",
      tools: [
        { name: "Grep", summary: '"total" in src' },
        { name: "Read", summary: "src/total.ts" },
      ],
    });
    expect(s.updates.filter((update) => update.type === "tool")).toEqual([
      {
        type: "tool",
        replyTo: reply.replyTo,
        tool: { name: "Grep", summary: '"total" in src' },
      },
      {
        type: "tool",
        replyTo: reply.replyTo,
        tool: { name: "Read", summary: "src/total.ts" },
      },
    ]);
    // Kept as told, and read back.
    const [, kept] = await s.stores.managerChat.latest("web-shop", 2);
    expect(kept?.tools).toHaveLength(2);
    // The session uses the Manager's own Model, and no single call is made.
    expect(s.tool.runs[0]).toMatchObject({
      tool: "Claude Code",
      model: "claude-opus-5-5",
    });
    expect(s.tool.runs[0]?.system).toContain(
      "you can read and search a read-only clone of adrianeyre/web-shop",
    );
    expect(s.requests).toEqual([]);
  });

  it("resumes the conversation's session with only the new turn, and /clear starts a new one", async () => {
    const s = await setUp();
    s.tool.answer("In src/total.ts.", "It adds VAT last.", "Hello again.");
    await s.say("Where are totals worked out?");
    await s.say("And VAT?");
    const [first, second] = s.tool.runs;
    expect(first?.session.resume).toBe(false);
    expect(second?.session).toEqual({ resume: true, id: first?.session.id });
    expect(second?.input).toBe("And VAT?");
    expect(second?.conversation).toBe(first?.conversation);

    await s.say("/clear");
    await s.say("Hello?");
    const third = s.tool.runs[2];
    expect(third?.session.resume).toBe(false);
    expect(third?.session.id).not.toBe(first?.session.id);
    expect(third?.conversation).not.toBe(first?.conversation);
    expect(third?.input).toBe("Hello?");
  });

  it("gives the session the Owner's images, telling it where each is", async () => {
    const s = await setUp();
    s.tool.answer("Checkout answered 500.");
    await s.say("What is this error?", [await s.screenshot()]);
    const [run] = s.tool.runs;
    expect(run?.images).toMatchObject([
      {
        name: "checkout error.png",
        mediaType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ]);
    expect(run?.input).toContain(
      '(The Owner attached the image "checkout error.png": it is at /home/agent/attachments/1-checkout_error.png. Read it there to see it.)',
    );
    expect(run?.input).not.toContain("not visible");
  });

  it("answers in one Gateway call for a Manager whose AI Provider has no agent tool", async () => {
    const s = await setUp();
    const [manager] = (await s.stores.agents.list("web-shop")).filter(
      ({ role }) => role === "manager",
    );
    if (manager === undefined) {
      throw new Error("A new Floor has a Manager.");
    }
    await s.stores.agents.update({
      ...manager,
      aiProvider: "Grok",
      modelOverride: "grok-4",
    });
    const reply = await s.say("Where are totals worked out?", [
      await s.screenshot(),
    ]);
    expect(reply).toMatchObject({
      kind: "reply",
      text: "One call.",
      tools: [],
    });
    // Its call carries text only, so the image is said not to be seen.
    expect(s.requests[0]?.messages.at(-1)?.content).toContain(
      '(The Owner attached the image "checkout error.png": it is not visible to this Model.)',
    );
    expect(s.tool.runs).toEqual([]);
    expect(s.requests[0]?.system).toContain(
      "Here you cannot read the repository",
    );
  });
});
