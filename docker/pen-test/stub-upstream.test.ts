// The pen-test stack's stub upstream (docs/pen-testing/stack.md): it
// answers like each AI Provider the stack's AI Accounts are for, and logs
// every request it receives, headers and body included. Then the same,
// through the AI Gateway itself: the stack's AI Accounts, pointing at the
// stub, serve Claude Code's, Codex's and opencode's requests, and list
// their Models for the catalogue.
import type { AddressInfo } from "node:net";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createEventBus,
  memoryEventStore,
} from "../../packages/events/src/index.ts";
import {
  createAiAccounts,
  createModelCatalogue,
  memoryAiAccountStore,
  memoryModelCatalogueStore,
} from "../../packages/gateway/src/index.ts";
import {
  gatewayKey,
  startGateway,
  type RunningGateway,
} from "../../packages/gateway/src/test-support.ts";
import { addAiAccountRequestSchema } from "../../packages/shared/src/ai-accounts.ts";
import { encryptorFromKey } from "../../packages/shared/src/crypto.ts";
import { allowInternalHosts } from "../../packages/shared/src/internal-hosts.ts";
import {
  canaryPrefix,
  stubAccounts,
  stubUpstreamUrl,
} from "./stub-accounts.ts";
import {
  createStubUpstream,
  maxLoggedBody,
  stubModels,
  stubReply,
  type StubLogEntry,
  type StubProvider,
} from "./stub-upstream.ts";

const canary = (provider: StubProvider) =>
  `${canaryPrefix}${provider}-0123456789abcdef`;

// The stack allows the stub upstream, on its own network, as an Owner
// allows their own Ollama (compose.yml's ALLOWED_INTERNAL_HOSTS, ADR 0007);
// here the stub is on loopback.
beforeAll(() => {
  allowInternalHosts(["stub-upstream", "127.0.0.1"]);
});
afterAll(() => {
  allowInternalHosts([]);
});

let logged: StubLogEntry[];
let close: () => Promise<void>;
let stubUrl: string;

beforeEach(async () => {
  logged = [];
  const server = createStubUpstream({
    log: (entry) => logged.push(entry),
    now: () => new Date("2026-10-11T12:00:00.000Z"),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  stubUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
});

afterEach(async () => {
  await close();
});

const post = (path: string, body: unknown, headers = {}) =>
  fetch(`${stubUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** The `data:` payloads of a server-sent event stream, parsed. */
const events = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .map((data) => (data === "[DONE]" ? data : (JSON.parse(data) as unknown)));

describe("the stub upstream answers", () => {
  it("Anthropic Messages, whole, with the Model asked for and its usage", async () => {
    const response = await post("/anthropic/v1/messages", {
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: stubReply }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: expect.any(Number) as number,
        output_tokens: expect.any(Number) as number,
      },
    });
  });

  it("Anthropic Messages, streamed, from message_start to message_stop", async () => {
    const response = await post("/anthropic/v1/messages", {
      model: "claude-sonnet-5-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(
      events(text).map((event) => (event as { type: string }).type),
    ).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain("event: message_start\n");
    expect(text).toContain(JSON.stringify(stubReply));
  });

  it("Anthropic's token count", async () => {
    const response = await post("/anthropic/v1/messages/count_tokens", {
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(await response.json()).toEqual({
      input_tokens: expect.any(Number) as number,
    });
  });

  it("Chat Completions, whole and streamed, with usage when asked for", async () => {
    const whole = await post("/xai/v1/chat/completions", {
      model: "grok-stub",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(await whole.json()).toMatchObject({
      object: "chat.completion",
      model: "grok-stub",
      choices: [
        {
          message: { role: "assistant", content: stubReply },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: expect.any(Number) as number },
    });

    const streamed = await post("/gemini/v1beta/openai/chat/completions", {
      model: "gemini-stub",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Hello" }],
    });
    const chunks = events(await streamed.text());
    expect(chunks.at(-1)).toBe("[DONE]");
    expect(chunks[0]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: { content: stubReply } }],
    });
    expect(chunks.at(-2)).toMatchObject({
      choices: [],
      usage: { total_tokens: expect.any(Number) as number },
    });
  });

  it("Responses, whole and streamed, ending with response.completed", async () => {
    const whole = await post("/openai/v1/responses", {
      model: "gpt-stub",
      input: "Hello",
    });
    expect(await whole.json()).toMatchObject({
      object: "response",
      status: "completed",
      model: "gpt-stub",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: stubReply }],
        },
      ],
    });

    const streamed = await post("/openai/v1/responses", {
      model: "gpt-stub",
      input: "Hello",
      stream: true,
    });
    const types = events(await streamed.text()).map(
      (event) => (event as { type: string }).type,
    );
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types.at(-1)).toBe("response.completed");
  });

  it("each AI Provider's model list, in its own shape", async () => {
    const list = async (path: string) =>
      (await (await fetch(`${stubUrl}${path}`)).json()) as {
        data: { id: string }[];
      };
    const anthropic = await list("/anthropic/v1/models?limit=1000");
    expect(anthropic).toMatchObject({ has_more: false });
    expect(anthropic.data.map(({ id }) => id)).toEqual([
      ...stubModels.anthropic,
    ]);
    expect((await list("/xai/v1/models")).data.map(({ id }) => id)).toEqual([
      "grok-stub",
    ]);
    expect(
      (await list("/gemini/v1beta/openai/models")).data.map(({ id }) => id),
    ).toEqual(["models/gemini-stub"]);
    expect((await list("/openai/v1/models")).data.map(({ id }) => id)).toEqual([
      "gpt-stub",
    ]);
  });

  it("an error, in the AI Provider's shape, for what it does not serve", async () => {
    const notJson = await post("/anthropic/v1/messages", "{not json");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect((await post("/xai/v1/embeddings", { model: "x" })).status).toBe(404);
    expect((await post("/nowhere/v1/messages", {})).status).toBe(404);
  });
});

describe("the stub upstream logs", () => {
  it("every request: method, URL, every header (credentials included), body and status", async () => {
    const body = JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "Hello" }],
    });
    await post("/anthropic/v1/messages?beta=true", body, {
      "x-api-key": canary("anthropic"),
      "anthropic-version": "2023-06-01",
      "x-ai-office-issue": "7",
    });
    await fetch(`${stubUrl}/xai/v1/models`, {
      headers: { authorization: `Bearer ${canary("xai")}` },
    });
    await post("/nowhere", "{}");

    expect(logged).toEqual([
      {
        at: "2026-10-11T12:00:00.000Z",
        method: "POST",
        url: "/anthropic/v1/messages?beta=true",
        headers: expect.objectContaining({
          "x-api-key": canary("anthropic"),
          "anthropic-version": "2023-06-01",
          "x-ai-office-issue": "7",
          "content-type": "application/json",
        }) as unknown,
        body,
        bodyBytes: Buffer.byteLength(body),
        status: 200,
      },
      expect.objectContaining({
        method: "GET",
        url: "/xai/v1/models",
        headers: expect.objectContaining({
          authorization: `Bearer ${canary("xai")}`,
        }) as unknown,
        body: "",
        status: 200,
      }) as unknown,
      expect.objectContaining({ url: "/nowhere", status: 404 }) as unknown,
    ]);
  });

  it("a long body cut at the limit, with its whole length", async () => {
    const long = JSON.stringify({
      model: "gpt-stub",
      input: "x".repeat(maxLoggedBody),
    });
    await post("/openai/v1/responses", long);
    expect(logged[0]?.body).toHaveLength(maxLoggedBody);
    expect(logged[0]?.bodyBytes).toBe(Buffer.byteLength(long));
  });

  it("nothing for the health check, and answers it", async () => {
    const health = await fetch(`${stubUrl}/health`);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(logged).toEqual([]);
  });
});

describe("the stack's AI Accounts", () => {
  it("each point at the stub upstream, with a canary credential, and are valid to add", () => {
    const accounts = stubAccounts(stubUpstreamUrl, canary);
    expect(accounts.map(({ provider }) => provider).sort()).toEqual(
      Object.keys(stubModels).sort(),
    );
    for (const { provider, request } of accounts) {
      expect(addAiAccountRequestSchema.parse(request)).toEqual(request);
      expect(request.endpointUrl).toMatch(
        new RegExp(`^${stubUpstreamUrl}/${provider}(/|$)`),
      );
      const credential = "credential" in request ? request.credential : null;
      expect(credential).toBe(canary(provider));
      expect(credential?.startsWith(canaryPrefix)).toBe(true);
    }
  });
});

describe("through the AI Gateway", () => {
  let gateway: RunningGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  async function office() {
    const events = createEventBus({ store: memoryEventStore() });
    const accounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor: encryptorFromKey(Buffer.alloc(32, 7)),
      events,
    });
    for (const { request } of stubAccounts(stubUrl, canary)) {
      await accounts.add(request);
    }
    gateway = await startGateway({
      accounts,
      sleep: () => Promise.resolve(),
    });
    return { accounts, url: gateway.url };
  }

  const call = (url: string, path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify(body),
    });

  /** The credential the stub was sent with, for the request to `path`. */
  const sentWith = (path: string) => {
    const entry = logged.find(({ url }) => url.startsWith(path));
    return entry?.headers["x-api-key"] ?? entry?.headers.authorization;
  };

  it("serves Claude Code's Messages from the Claude account, streamed or not", async () => {
    const { url } = await office();
    for (const stream of [false, true]) {
      const response = await call(url, "/v1/messages", {
        model: "claude-opus-5-5",
        max_tokens: 100,
        stream,
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(stubReply);
    }
    expect(sentWith("/anthropic/v1/messages")).toContain(canary("anthropic"));
  });

  it("serves opencode's Chat Completions from the Grok and Gemini accounts", async () => {
    const { url } = await office();
    for (const model of ["grok-stub", "gemini-stub"]) {
      const response = await call(url, "/v1/chat/completions", {
        model,
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(stubReply);
    }
    expect(sentWith("/xai/v1/chat/completions")).toContain(canary("xai"));
    expect(sentWith("/gemini/v1beta/openai/chat/completions")).toContain(
      canary("gemini"),
    );
  });

  it("serves Codex's Responses from the OpenAI-compatible endpoint", async () => {
    const { url } = await office();
    for (const stream of [false, true]) {
      const response = await call(url, "/v1/responses", {
        model: "gpt-stub",
        input: "Hello",
        stream,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(stubReply);
    }
    expect(sentWith("/openai/v1/responses")).toContain(canary("openai"));
  });

  it("lists every account's Models in the catalogue", async () => {
    const { accounts } = await office();
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
    });
    const report = await catalogue.refresh();
    expect(report.failed).toEqual([]);
    expect(report.refreshed.map(({ aiProvider }) => aiProvider).sort()).toEqual(
      ["Claude", "Gemini", "Grok", "OpenAI-compatible"],
    );
    expect((await catalogue.list()).map(({ model }) => model).sort()).toEqual(
      [...Object.values(stubModels).flat()].sort(),
    );
  });
});
