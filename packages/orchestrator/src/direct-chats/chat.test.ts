import { describe, expect, it } from "vitest";

import { memoryStores } from "../stores.ts";
import type { ModelClient, ModelRequest } from "../models/client.ts";
import {
  agentChatSystemPrompt,
  createDirectChats,
  directConversation,
  terminalAgentId,
} from "./chat.ts";
import type { DirectChatMessageRecord } from "./store.ts";

// Direct chats in plain code: the conversation the Model is given, an
// Agent that cannot answer, and the Terminal's Models.

const record = (
  id: number,
  kind: DirectChatMessageRecord["kind"],
  text: string,
): DirectChatMessageRecord => ({
  id,
  chat: "terminal",
  floorId: null,
  agentId: null,
  kind,
  text,
  replyTo: kind === "owner" || kind === "clear" ? null : id - 1,
  model: null,
  createdAt: new Date(0),
});

/** A model that answers "Done." and keeps each request. */
function answering() {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    complete: () => Promise.reject(new Error("Chats stream.")),
    stream(request, { onText }) {
      requests.push(request);
      onText("Done.");
      return Promise.resolve({ text: "Done.", stopReason: "end_turn" });
    },
  };
  return { client, requests };
}

describe("directConversation", () => {
  it("alternates, starting with the Owner, and leaves errors out", () => {
    expect(
      directConversation([
        record(1, "reply", "A reply from before"),
        record(2, "owner", "First"),
        record(3, "error", "Could not answer"),
        record(4, "owner", "Again"),
        record(5, "reply", "Here."),
        record(6, "owner", "Thanks"),
      ]),
    ).toEqual([
      { role: "user", content: "First\n\nAgain" },
      { role: "assistant", content: "Here." },
      { role: "user", content: "Thanks" },
    ]);
  });
});

describe("agentChatSystemPrompt", () => {
  it("says who the Agent is, how its Role works and the Owner's instructions", () => {
    const prompt = agentChatSystemPrompt({
      floor: { name: "Web shop", repository: "adrianeyre/web-shop" },
      agent: {
        name: "Bo",
        role: "coder",
        extraInstructions: "Use British English.",
      },
      role: {
        name: "coder",
        description: "Changes the code.",
        instructions: "- Commit.",
      },
    });
    expect(prompt).toContain(
      "You are Bo, the coder on the Web shop Floor of AI Office, which works on the GitHub repository adrianeyre/web-shop.",
    );
    expect(prompt).toContain("Your Role: Changes the code.");
    expect(prompt).toContain("How you work:\n- Commit.");
    expect(prompt).toContain(
      "The Owner's instructions for you:\nUse British English.",
    );
  });
});

describe("createDirectChats", () => {
  const floor = {
    id: "web-shop",
    githubRepositoryId: 1,
    repository: "adrianeyre/web-shop",
    name: "Web shop",
  };

  it("answers with why when the Agent is paused, asking no model", async () => {
    const stores = memoryStores();
    const models = answering();
    const chats = createDirectChats({
      store: stores.directChats,
      floors: {
        ...stores.floors,
        get: (id: string) =>
          Promise.resolve(id === floor.id ? (floor as never) : undefined),
      },
      agents: {
        ...stores.agents,
        list: () =>
          Promise.resolve([
            {
              id: "bo",
              floorId: "web-shop",
              name: "Bo",
              role: "coder",
              aiProvider: "Claude",
              modelOverride: null,
              enabled: false,
              extraInstructions: "",
            } as never,
          ]),
      },
      models: models.client,
      terminalModels: answering().client,
    });
    const ref = { kind: "agent", floorId: "web-shop", agentId: "bo" } as const;
    await chats.send(ref, "Hi");
    await chats.stop();
    const { messages } = await chats.history(ref);
    expect(messages.map(({ kind, text }) => [kind, text])).toEqual([
      ["owner", "Hi"],
      [
        "error",
        "Bo is paused, so does not answer. Turn Bo back on in Agent Settings.",
      ],
    ]);
    expect(models.requests).toEqual([]);
  });

  it("offers the Terminal each AI Provider's default Model, Claude's first", async () => {
    const stores = memoryStores();
    const terminal = answering();
    const chats = createDirectChats({
      store: stores.directChats,
      floors: stores.floors,
      agents: stores.agents,
      models: answering().client,
      terminalModels: terminal.client,
      defaultModels: () =>
        Promise.resolve({ ChatGPT: "gpt-5.5", Claude: "claude-opus-5-5" }),
    });
    const history = await chats.history({ kind: "terminal" });
    expect(history.model).toBe("claude-opus-5-5");
    expect(history.models).toEqual([
      { aiProvider: "ChatGPT", model: "gpt-5.5" },
      { aiProvider: "Claude", model: "claude-opus-5-5" },
    ]);
    await chats.send({ kind: "terminal" }, "Hi", "gpt-5.5");
    await chats.stop();
    // In the chat's own session, as every direct chat's calls are.
    expect(terminal.requests).toMatchObject([
      { agentId: terminalAgentId, model: "gpt-5.5", session: "direct-chat" },
    ]);
    await expect(
      chats.send({ kind: "terminal" }, "Hi", "nope"),
    ).rejects.toMatchObject({ code: "model_not_offered" });
  });

  it("says the Terminal has no Model before any AI Provider has a default", async () => {
    const stores = memoryStores();
    const chats = createDirectChats({
      store: stores.directChats,
      floors: stores.floors,
      agents: stores.agents,
      models: answering().client,
      terminalModels: answering().client,
      defaultModels: () => Promise.resolve({}),
    });
    await chats.send({ kind: "terminal" }, "Hi");
    await chats.stop();
    expect(
      (await chats.history({ kind: "terminal" })).messages.at(-1)?.text,
    ).toBe(
      "No AI Provider has a default Model yet: choose one in AI Settings.",
    );
  });
});
