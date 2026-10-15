import { Writable } from "node:stream";

import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayAccount } from "./gateway.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  accountKey,
  gatewayKey,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = undefined;
  upstream = undefined;
});

const message = JSON.stringify({
  type: "message",
  usage: { input_tokens: 3, output_tokens: 4 },
});

const request = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": gatewayKey,
    ...headers,
  },
  body: JSON.stringify(body),
});

const records = (running: RunningGateway | undefined) =>
  running === undefined
    ? []
    : (running.requestLog as ReturnType<typeof memoryRequestLog>).records;

const decoder = new TextDecoder();

describe("forwarding", () => {
  it("sends the AI Account's key in place of the caller's Gateway Key and credentials", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    gateway = await startGateway({ upstream });

    await fetch(
      `${gateway.url}/v1/messages`,
      request(
        { model: "claude-haiku-5-5" },
        {
          authorization: "Bearer the-callers-token",
          cookie: "session=abc",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
          "x-stainless-lang": "js",
        },
      ),
    );

    const headers = upstream.received[0]?.headers;
    expect(headers?.["x-api-key"]).toBe(accountKey);
    expect(headers?.authorization).toBeUndefined();
    expect(headers?.cookie).toBeUndefined();
    expect(headers?.["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
    expect(headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(headers?.["x-stainless-lang"]).toBe("js");
    expect(headers?.["accept-encoding"]).toBe("identity");
  });

  it("keeps the query string and any path prefix of the account's URL", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 9 }));
    });
    gateway = await startGateway({
      account: {
        id: null,
        name: "prefixed",
        apiKey: accountKey,
        baseUrl: `${upstream.url}/anthropic/`,
      },
    });

    const response = await fetch(
      `${gateway.url}/v1/messages/count_tokens?beta=true`,
      request({ model: "claude-haiku-5-5", messages: [] }),
    );
    expect(await response.json()).toEqual({ input_tokens: 9 });
    expect(upstream.received[0]?.url).toBe(
      "/anthropic/v1/messages/count_tokens?beta=true",
    );
  });

  it("forwards a body that is not JSON unchanged and records no model", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "bad JSON" },
        }),
      );
    });
    gateway = await startGateway({ upstream });

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-api-key": gatewayKey },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(upstream.received[0]?.body).toBe("{not json");
    await vi.waitFor(() => {
      expect(records(gateway)).toHaveLength(1);
    });
    expect(records(gateway)[0]).toMatchObject({ model: null, status: 400 });
  });
});

describe("streaming", () => {
  it("passes each event on as it arrives, without waiting for the end", async () => {
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    upstream = await startFakeUpstream(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: message_start\ndata: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      );
      await finished;
      response.end(
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
      );
    });
    gateway = await startGateway({ upstream });

    const response = await fetch(
      `${gateway.url}/v1/messages`,
      request({ model: "claude-haiku-5-5", stream: true }),
    );
    if (response.body === null) {
      throw new Error("expected a streamed body");
    }
    const reader = response.body.getReader();
    const first = await reader.read();
    // The first event is here while the AI Provider is still holding the rest.
    expect(decoder.decode(first.value as Uint8Array)).toContain(
      "message_start",
    );
    expect(records(gateway)).toHaveLength(0);

    finish();
    let rest = "";
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      rest += decoder.decode(chunk.value as Uint8Array);
    }
    expect(rest).toContain("message_delta");
    await vi.waitFor(() => {
      expect(records(gateway)).toHaveLength(1);
    });
    expect(records(gateway)[0]).toMatchObject({
      streamed: true,
      status: 200,
      inputTokens: 5,
      outputTokens: 9,
    });
  });

  it("stops the AI Provider's stream and records a 499 when the caller goes away", async () => {
    let upstreamClosed = false;
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: message_start\ndata: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":7,"output_tokens":1}}}\n\n',
      );
      response.on("close", () => {
        upstreamClosed = true;
      });
      // Never ends on its own.
    });
    gateway = await startGateway({ upstream });

    const abort = new AbortController();
    const response = await fetch(`${gateway.url}/v1/messages`, {
      ...request({ model: "claude-haiku-5-5", stream: true }),
      signal: abort.signal,
    });
    await response.body?.getReader().read();
    abort.abort();

    await vi.waitFor(() => {
      expect(upstreamClosed).toBe(true);
      expect(records(gateway)).toHaveLength(1);
    });
    expect(records(gateway)[0]).toMatchObject({
      status: 499,
      streamed: true,
      inputTokens: 7,
      outputTokens: 1,
    });
  });
});

describe("when the request cannot be served", () => {
  it("is a 503 in the Anthropic error format when there is no AI Account", async () => {
    gateway = await startGateway({ account: undefined });
    const response = await fetch(
      `${gateway.url}/v1/messages`,
      request({ model: "claude-haiku-5-5" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "No AI Account is available." },
    });
    await vi.waitFor(() => {
      expect(records(gateway)).toHaveLength(1);
    });
    expect(records(gateway)[0]).toMatchObject({
      account: null,
      endpoint: "messages",
      model: "claude-haiku-5-5",
      status: 503,
      inputTokens: null,
    });
  });

  it("is a 502 when the AI Provider cannot be reached, and never logs the key", async () => {
    // Started and stopped, so nothing listens on its port.
    const gone = await startFakeUpstream(() => undefined);
    await gone.close();
    const lines: string[] = [];
    const logger = pino(
      { level: "trace" },
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          lines.push(chunk.toString());
          callback();
        },
      }),
    );
    gateway = await startGateway({
      account: {
        id: null,
        name: "test-account",
        apiKey: accountKey,
        baseUrl: gone.url,
      },
      logger,
    });

    const response = await fetch(
      `${gateway.url}/v1/messages`,
      request({ model: "claude-haiku-5-5" }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    });
    await vi.waitFor(() => {
      expect(records(gateway)).toHaveLength(1);
    });
    expect(records(gateway)[0]).toMatchObject({
      account: "test-account",
      status: 502,
    });
    expect(lines.join("")).toContain("could not be reached");
    expect(lines.join("")).not.toContain(accountKey);
  });

  it("still answers when the request cannot be recorded", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    const lines: string[] = [];
    gateway = await startGateway({
      upstream,
      requestLog: { record: () => Promise.reject(new Error("database down")) },
      logger: pino(
        { level: "error" },
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
          },
        }),
      ),
    });
    const response = await fetch(
      `${gateway.url}/v1/messages`,
      request({ model: "claude-haiku-5-5" }),
    );
    expect(await response.text()).toBe(message);
    await vi.waitFor(() => {
      expect(lines.join("")).toContain("Could not record a Gateway request.");
    });
  });

  it("is a 404 in the Anthropic error format for other routes", async () => {
    gateway = await startGateway({ account: undefined });
    const response = await fetch(`${gateway.url}/v1/complete`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
  });
});

describe("choosing the AI Account", () => {
  it("asks for the account on every request, so a change applies at once", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    const url = upstream.url;
    let current: GatewayAccount | undefined = {
      id: "account-1",
      name: "first",
      apiKey: "sk-ant-api03-firstaccountkey-00000000000000",
      baseUrl: url,
    };
    gateway = await startGateway({
      accounts: { select: () => Promise.resolve(current) },
    });
    const send = () =>
      fetch(`${gateway?.url ?? ""}/v1/messages`, request({ model: "m" }));

    await send();
    current = {
      id: "account-2",
      name: "second",
      apiKey: "sk-ant-api03-secondaccountkey-0000000000000",
      baseUrl: url,
    };
    await send();
    current = undefined;
    expect((await send()).status).toBe(503);

    expect(
      upstream.received.map(({ headers }) => headers["x-api-key"]),
    ).toEqual([
      "sk-ant-api03-firstaccountkey-00000000000000",
      "sk-ant-api03-secondaccountkey-0000000000000",
    ]);
    await vi.waitFor(() => {
      expect(records(gateway)).toHaveLength(3);
    });
    expect(
      records(gateway).map(({ account, accountId, status }) => ({
        account,
        accountId,
        status,
      })),
    ).toEqual([
      { account: "first", accountId: "account-1", status: 200 },
      { account: "second", accountId: "account-2", status: 200 },
      { account: null, accountId: null, status: 503 },
    ]);
  });

  it("is a 503 when the AI Accounts cannot be read, and logs why", async () => {
    const lines: string[] = [];
    gateway = await startGateway({
      accounts: {
        select: () => Promise.reject(new Error("The database is down.")),
      },
      logger: pino(
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
          },
        }),
      ),
    });
    const response = await fetch(
      `${gateway.url}/v1/messages`,
      request({ model: "claude-haiku-5-5" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "The AI Gateway could not read its AI Accounts.",
      },
    });
    expect(lines.join("")).toContain("The database is down.");
    await vi.waitFor(() => {
      expect(records(gateway)).toHaveLength(1);
    });
    expect(records(gateway)[0]).toMatchObject({ account: null, status: 503 });
  });
});

describe("GET /health", () => {
  it("says whether an AI Account is available", async () => {
    gateway = await startGateway({ account: undefined });
    expect(await (await fetch(`${gateway.url}/health`)).json()).toEqual({
      status: "ok",
      account: "none",
    });
    await gateway.close();
    upstream = await startFakeUpstream(() => undefined);
    gateway = await startGateway({ upstream });
    expect(await (await fetch(`${gateway.url}/health`)).json()).toEqual({
      status: "ok",
      account: "available",
    });
  });
});
