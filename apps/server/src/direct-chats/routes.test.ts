import { postgresTest } from "@ai-office/db/testing";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  terminalAgentId,
  type ModelClient,
  type ModelRequest,
  type ModelStreamOptions,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  directChatFrameSchema,
  directChatSchema,
  directChatSendResponseSchema,
  type DirectChatFrame,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// Direct chats over the API: one with each of a Floor's Agents, and the
// Terminal. Messages are sent over REST and the Model's reply streams over
// server-sent events. The model clients stand in for the AI Gateway.

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A model that writes "Hello " at once, and "there." once released. */
function heldModel() {
  const requests: ModelRequest[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: ModelClient = {
    complete: () => Promise.reject(new Error("The chat streams its calls.")),
    async stream(request: ModelRequest, { onText }: ModelStreamOptions) {
      requests.push(request);
      onText("Hello ");
      await released;
      onText("there.");
      return { text: "Hello there.", stopReason: "end_turn" };
    },
  };
  return { client, requests, release };
}

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly baseUrl: string;
  readonly agents: ReturnType<typeof heldModel>;
  readonly terminal: ReturnType<typeof heldModel>;
  readonly logged: string[];
  readonly coder: { readonly id: string; readonly name: string };
}

async function setUp(stores: OfficeStores = memoryStores()): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const agents = heldModel();
  const terminal = heldModel();
  const logged: string[] = [];
  const server = await buildApp({
    logger: createLogger({
      level: "info",
      secrets: [],
      destination: {
        write(line: string) {
          logged.push(line);
        },
      },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    stores,
    github,
    models: agents.client,
    terminalModels: terminal.client,
  });
  servers.push(server);
  const owner = await signIn(server);
  const added = await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  if (added.statusCode !== 409) {
    expect(added.statusCode).toBe(201);
  }
  const coder = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "coder",
  );
  if (coder === undefined) {
    throw new Error("The Floor has no coder.");
  }
  const baseUrl = await server.listen({ port: 0, host: "127.0.0.1" });
  return { server, owner, baseUrl, agents, terminal, logged, coder };
}

const agentUrl = (setup: Setup, agentId = setup.coder.id) =>
  `/api/floors/web-shop/agents/${agentId}/chat`;

const send = (
  { server, owner }: Setup,
  url: string,
  payload: Record<string, unknown>,
) =>
  server.inject({
    method: "POST",
    url: `${url}/messages`,
    headers: owner.headers,
    payload,
  });

const history = async ({ server, owner }: Setup, url: string) =>
  directChatSchema.parse(
    (await server.inject({ url, headers: owner.headers })).json(),
  );

/** An open chat stream, read one frame at a time. */
async function stream(setup: Setup, url: string) {
  const controller = new AbortController();
  const response = await fetch(`${setup.baseUrl}${url}/stream`, {
    headers: { cookie: setup.owner.cookie },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<DirectChatFrame> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const text = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = /^data: (.*)$/m.exec(text)?.[1];
          if (data !== undefined) {
            return directChatFrameSchema.parse(JSON.parse(data));
          }
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("The stream ended.");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close() {
      controller.abort();
    },
  };
}

describe("an Agent's chat", () => {
  it("asks the Agent's own Model as the Agent, streaming its reply", async () => {
    const setup = await setUp();
    const url = agentUrl(setup);
    const before = await history(setup, url);
    expect(before).toMatchObject({
      name: setup.coder.name,
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      messages: [],
      pending: [],
      models: [],
    });
    const live = await stream(setup, url);
    const response = await send(setup, url, { text: "What are you on?" });
    expect(response.statusCode).toBe(201);
    const sent = directChatSendResponseSchema.parse(response.json());
    expect(sent).toMatchObject({
      message: { kind: "owner", text: "What are you on?", replyTo: null },
      reply: null,
    });
    expect(await live.next()).toMatchObject({
      type: "message",
      message: { id: sent.message.id },
    });
    expect(await live.next()).toEqual({
      type: "delta",
      replyTo: sent.message.id,
      text: "Hello ",
    });
    const [request] = setup.agents.requests;
    expect(request).toMatchObject({
      agentId: setup.coder.id,
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "What are you on?" }],
    });
    expect(request?.system).toContain(
      `You are ${setup.coder.name}, the coder on the web-shop Floor`,
    );
    expect(request?.system).toContain("adrianeyre/web-shop");
    // One message at a time.
    expect((await send(setup, url, { text: "And?" })).statusCode).toBe(409);
    expect((await history(setup, url)).pending).toEqual([
      { replyTo: sent.message.id, text: "Hello " },
    ]);
    setup.agents.release();
    expect(await live.next()).toEqual({
      type: "delta",
      replyTo: sent.message.id,
      text: "there.",
    });
    expect(await live.next()).toMatchObject({
      type: "message",
      message: {
        kind: "reply",
        text: "Hello there.",
        replyTo: sent.message.id,
      },
    });
    live.close();
    expect(setup.terminal.requests).toEqual([]);
    // Which chat is logged, never the Owner's words.
    const log = setup.logged.join("");
    expect(log).toContain("The Owner wrote in a direct chat.");
    expect(log).not.toContain("What are you on?");
  });

  it("gives the Model the conversation since the latest /clear", async () => {
    const setup = await setUp();
    setup.agents.release();
    const url = agentUrl(setup);
    await send(setup, url, { text: "First" });
    await expect
      .poll(async () => (await history(setup, url)).messages.length)
      .toBe(2);
    await send(setup, url, { text: "Second" });
    await expect
      .poll(async () => (await history(setup, url)).messages.length)
      .toBe(4);
    expect(setup.agents.requests[1]?.messages).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Hello there." },
      { role: "user", content: "Second" },
    ]);
    const cleared = directChatSendResponseSchema.parse(
      (await send(setup, url, { text: "/clear" })).json(),
    );
    expect(cleared.message.kind).toBe("clear");
    await send(setup, url, { text: "Third" });
    await expect.poll(() => setup.agents.requests.length).toBe(3);
    expect(setup.agents.requests[2]?.messages).toEqual([
      { role: "user", content: "Third" },
    ]);
  });

  it("answers 404 for an Agent the Floor does not have", async () => {
    const setup = await setUp();
    const response = await setup.server.inject({
      url: agentUrl(setup, "nobody"),
      headers: setup.owner.headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "agent_not_found" });
    expect(
      (
        await setup.server.inject({
          url: "/api/floors/nowhere/agents/nobody/chat",
          headers: setup.owner.headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("needs a signed-in session", async () => {
    const setup = await setUp();
    const response = await setup.server.inject({ url: agentUrl(setup) });
    expect(response.statusCode).toBe(401);
  });
});

describe("the Terminal", () => {
  it("asks an AI Provider's default Model with its own key", async () => {
    const setup = await setUp();
    setup.terminal.release();
    const before = await history(setup, "/api/terminal");
    expect(before).toMatchObject({
      name: "the AI",
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      models: [{ aiProvider: "Claude", model: "claude-opus-5-5" }],
    });
    const response = await send(setup, "/api/terminal", {
      text: "Explain a monad",
      model: "claude-opus-5-5",
    });
    expect(response.statusCode).toBe(201);
    await expect
      .poll(async () => (await history(setup, "/api/terminal")).messages.length)
      .toBe(2);
    const [request] = setup.terminal.requests;
    expect(request).toMatchObject({
      agentId: terminalAgentId,
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "Explain a monad" }],
    });
    expect(request?.system).toContain("AI Office's Terminal");
    expect(setup.agents.requests).toEqual([]);
  });

  it("refuses a Model it does not offer", async () => {
    const setup = await setUp();
    const response = await send(setup, "/api/terminal", {
      text: "Hi",
      model: "gpt-unknown",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "model_not_offered" });
  });
});

describe("in Postgres", () => {
  postgresTest(
    "keeps each chat across a restart",
    async ({ database }) => {
      const first = await setUp(databaseStores(database.db));
      first.agents.release();
      first.terminal.release();
      await send(first, agentUrl(first), { text: "Hi" });
      await send(first, "/api/terminal", { text: "Hello" });
      await expect
        .poll(
          async () => (await history(first, "/api/terminal")).messages.length,
        )
        .toBe(2);
      await expect
        .poll(
          async () => (await history(first, agentUrl(first))).messages.length,
        )
        .toBe(2);
      await first.server.close();

      const second = await setUp(databaseStores(database.db));
      expect(
        (await history(second, agentUrl(second))).messages.map(
          ({ kind, text }) => [kind, text],
        ),
      ).toEqual([
        ["owner", "Hi"],
        ["reply", "Hello there."],
      ]);
      expect(
        (await history(second, "/api/terminal")).messages.map(
          ({ kind, text }) => [kind, text],
        ),
      ).toEqual([
        ["owner", "Hello"],
        ["reply", "Hello there."],
      ]);
    },
    60_000,
  );
});
