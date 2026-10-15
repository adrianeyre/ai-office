import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { gatewayModelClient, ModelCallError } from "./client.ts";

// An Agent's model call outside a sandbox (PRD FR-20, FR-42; ADR 0001): a
// Messages request to the AI Gateway with the Agent's own Gateway Key,
// attributed to its issue and pull request, against a stand-in Gateway.

const key = "aio_gk_reviewerskeyforthegateway000000000000";

interface Received {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function gateway(
  status: number,
  answer: unknown,
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(answer));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  close = () =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/`, received };
}

const request = {
  agentId: "grace",
  model: "gpt-5.5",
  system: "You are a reviewer.",
  messages: [{ role: "user", content: "Review this." }] as const,
  maxTokens: 1024,
  issue: 4,
  pullRequest: 14,
};

describe("gatewayModelClient", () => {
  it("calls the Gateway's Messages API with the Agent's Gateway Key, attributed to its issue and pull request", async () => {
    const stand = await gateway(200, {
      type: "message",
      content: [
        { type: "thinking", thinking: "Hmm." },
        { type: "text", text: '{"verdict":' },
        { type: "text", text: '"approve"}' },
      ],
      stop_reason: "end_turn",
    });
    const asked: string[] = [];
    const client = gatewayModelClient({
      url: stand.url,
      key: (agentId) => {
        asked.push(agentId);
        return Promise.resolve(key);
      },
    });
    expect(await client.complete(request)).toEqual({
      text: '{"verdict":"approve"}',
      stopReason: "end_turn",
    });
    expect(asked).toEqual(["grace"]);
    const [received] = stand.received;
    expect(received?.url).toBe("/v1/messages");
    expect(received?.headers).toMatchObject({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "x-ai-office-issue": "4",
      "x-ai-office-pull-request": "14",
    });
    expect(received?.body).toEqual({
      model: "gpt-5.5",
      max_tokens: 1024,
      system: "You are a reviewer.",
      messages: [{ role: "user", content: "Review this." }],
    });
  });

  it("names the session a call belongs to, when it has one (a Fresh Start's summary)", async () => {
    const stand = await gateway(200, {
      type: "message",
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
    });
    const client = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
    });
    await client.complete(request);
    await client.complete({ ...request, session: "sbx-1" });
    const [without, withSession] = stand.received;
    expect(without?.headers["x-ai-office-session"]).toBeUndefined();
    expect(withSession?.headers["x-ai-office-session"]).toBe("sbx-1");
  });

  it("G1-1: sends the token of the work it opened for the call, which the Gateway counts it against, and closes it once the Gateway answers", async () => {
    const stand = await gateway(200, {
      type: "message",
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
    });
    const opened: { agentId: string; work: unknown; closed: boolean }[] = [];
    const client = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
      work: (agentId, work) => {
        const entry = { agentId, work, closed: false };
        opened.push(entry);
        return {
          token: `work-${String(opened.length)}`,
          close: () => {
            entry.closed = true;
          },
        };
      },
    });
    await client.complete(request);
    // A call for no issue, such as the Manager chat's.
    await client.complete({
      agentId: request.agentId,
      model: request.model,
      system: request.system,
      messages: request.messages,
      maxTokens: request.maxTokens,
    });
    expect(opened).toEqual([
      {
        agentId: "grace",
        work: { issue: 4, pullRequest: 14 },
        closed: true,
      },
      { agentId: "grace", work: {}, closed: true },
    ]);
    expect(
      stand.received.map(({ headers }) => headers["x-ai-office-work"]),
    ).toEqual(["work-1", "work-2"]);
  });

  it("G1-1: closes the work it opened when the Gateway cannot be reached", async () => {
    let closed = false;
    const client = gatewayModelClient({
      url: "http://127.0.0.1:9/",
      key: () => Promise.resolve(key),
      work: () => ({
        token: "work-1",
        close: () => {
          closed = true;
        },
      }),
      fetch: () => Promise.reject(new Error("connection refused")),
    });
    await expect(client.complete(request)).rejects.toBeInstanceOf(
      ModelCallError,
    );
    expect(closed).toBe(true);
  });

  it("fails with the Gateway's status and message, such as a Token Cap's refusal", async () => {
    const stand = await gateway(403, {
      type: "error",
      error: {
        type: "permission_error",
        message: "grace has reached its daily Token Cap.",
      },
    });
    const client = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
    });
    const error = await client
      .complete(request)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      status: 403,
      message:
        "The AI Gateway answered 403: grace has reached its daily Token Cap.",
    });
    expect((error as Error).message).not.toContain(key);
  });

  it("fails without calling when the Agent has no Gateway Key, or the Gateway cannot be reached", async () => {
    const stand = await gateway(200, {});
    const keyless = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(undefined),
    });
    await expect(keyless.complete(request)).rejects.toThrow(
      "The Agent grace has no Gateway Key.",
    );
    expect(stand.received).toEqual([]);
    const unreachable = gatewayModelClient({
      url: "http://127.0.0.1:1",
      key: () => Promise.resolve(key),
    });
    const failure = await unreachable
      .complete(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelCallError);
    expect((failure as ModelCallError).status).toBe(0);
    expect((failure as ModelCallError).message).toMatch(
      /^The AI Gateway could not be reached/,
    );
  });
});

/** A Messages stream's events, as the Gateway passes them on. */
const sse = (type: string, data: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const textDelta = (text: string): string =>
  sse("content_block_delta", {
    index: 0,
    delta: { type: "text_delta", text },
  });

const opening = [
  sse("message_start", {
    message: { type: "message", usage: { input_tokens: 9, output_tokens: 1 } },
  }),
  sse("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  }),
];

const closing = [
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", {
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 6 },
  }),
  sse("message_stop", {}),
];

/**
 * A stand-in Gateway that streams `first`, then waits for `release` before
 * streaming `rest`.
 */
async function streamingGateway(
  first: readonly string[],
  rest: readonly string[],
  release: Promise<void> = Promise.resolve(),
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Split mid-frame, as a network may.
      const whole = first.join("");
      response.write(whole.slice(0, 40));
      response.write(whole.slice(40));
      void release.then(() => {
        response.end(rest.join(""));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, received };
}

describe("gatewayModelClient, streamed", () => {
  it("gives each piece of text as the Gateway passes it on, then the whole reply", async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stand = await streamingGateway(
      [...opening, textDelta("Hello")],
      [textDelta(" from"), textDelta(" the Manager."), ...closing],
      released,
    );
    const client = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
    });
    const pieces: string[] = [];
    let first: () => void = () => undefined;
    const firstArrived = new Promise<void>((resolve) => {
      first = resolve;
    });
    const unattributed = {
      agentId: request.agentId,
      model: request.model,
      system: request.system,
      messages: request.messages,
      maxTokens: request.maxTokens,
    };
    const reply = client.stream(unattributed, {
      onText: (text) => {
        pieces.push(text);
        first();
      },
    });
    // The first piece is here while the Gateway still holds the rest.
    await firstArrived;
    expect(pieces).toEqual(["Hello"]);
    release();
    expect(await reply).toEqual({
      text: "Hello from the Manager.",
      stopReason: "end_turn",
    });
    expect(pieces).toEqual(["Hello", " from", " the Manager."]);
    const [received] = stand.received;
    expect(received?.headers).toMatchObject({
      "x-api-key": key,
      accept: "text/event-stream",
    });
    expect(received?.headers).not.toHaveProperty("x-ai-office-issue");
    expect(received?.body).toEqual({
      model: "gpt-5.5",
      max_tokens: 1024,
      system: "You are a reviewer.",
      messages: [{ role: "user", content: "Review this." }],
      stream: true,
    });
  });

  it("reads frames with Windows line endings", async () => {
    const stand = await streamingGateway(
      [...opening, textDelta("Hi")].map((frame) =>
        frame.replaceAll("\n", "\r\n"),
      ),
      closing,
    );
    const client = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
    });
    const pieces: string[] = [];
    expect(
      await client.stream(request, { onText: (text) => pieces.push(text) }),
    ).toEqual({ text: "Hi", stopReason: "end_turn" });
    expect(pieces).toEqual(["Hi"]);
  });

  it("fails with the Gateway's status and message before anything streams", async () => {
    const stand = await gateway(429, {
      type: "error",
      error: { type: "rate_limit_error", message: "Every AI Account is busy." },
    });
    const client = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
    });
    const pieces: string[] = [];
    const error = await client
      .stream(request, { onText: (text) => pieces.push(text) })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      status: 429,
      message: "The AI Gateway answered 429: Every AI Account is busy.",
    });
    expect(pieces).toEqual([]);
  });

  it("fails on an error event, or a stream that ends before the answer", async () => {
    const failing = await streamingGateway(
      [...opening, textDelta("Hel")],
      [
        sse("error", {
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
      ],
    );
    const client = gatewayModelClient({
      url: failing.url,
      key: () => Promise.resolve(key),
    });
    await expect(
      client.stream(request, { onText: () => undefined }),
    ).rejects.toThrow("The AI Gateway's stream failed: Overloaded");
    await close?.();

    const cut = await streamingGateway([...opening, textDelta("Hel")], []);
    const cutClient = gatewayModelClient({
      url: cut.url,
      key: () => Promise.resolve(key),
    });
    await expect(
      cutClient.stream(request, { onText: () => undefined }),
    ).rejects.toThrow("The AI Gateway's stream ended before the answer did.");
  });

  it("takes an answer that came whole, all at once", async () => {
    const stand = await gateway(200, {
      type: "message",
      content: [{ type: "text", text: "All of it." }],
      stop_reason: "end_turn",
    });
    const client = gatewayModelClient({
      url: stand.url,
      key: () => Promise.resolve(key),
    });
    const pieces: string[] = [];
    expect(
      await client.stream(request, { onText: (text) => pieces.push(text) }),
    ).toEqual({ text: "All of it.", stopReason: "end_turn" });
    expect(pieces).toEqual(["All of it."]);
  });
});
