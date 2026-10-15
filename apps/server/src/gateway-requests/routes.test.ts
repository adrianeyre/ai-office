import {
  createRequestHistory,
  memoryRequestHistoryStore,
  type GatewayRequestRecord,
  type RequestHistory,
} from "@ai-office/gateway";
import {
  gatewayLogLineSchema,
  gatewayRequestDetailSchema,
  gatewayRequestListSchema,
  gatewayRequestSummarySchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  type SignedIn,
} from "../test-support.ts";
import { createLogHub, type LogHub } from "./log-hub.ts";

// Request history and the live request and log streams (PRD FR-44),
// through the real routes and auth.

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly history: RequestHistory;
  readonly logs: LogHub;
  readonly baseUrl: string;
}

async function setUp(options: { heartbeatMs?: number } = {}): Promise<Setup> {
  const history = createRequestHistory({
    store: memoryRequestHistoryStore(),
    encryptor: testEncryptor,
  });
  const logs = createLogHub();
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    requestHistory: history,
    gatewayLogs: logs,
    ...(options.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: options.heartbeatMs }),
  });
  servers.push(server);
  const owner = await signIn(server);
  const baseUrl = await server.listen({ port: 0, host: "127.0.0.1" });
  return { server, owner, history, logs, baseUrl };
}

const record = (
  fields: Partial<GatewayRequestRecord> = {},
): GatewayRequestRecord => ({
  startedAt: new Date("2026-10-09T12:00:00.000Z"),
  account: "Work",
  accountId: "account-1",
  endpoint: "messages",
  model: "claude-opus-5-5",
  streamed: true,
  status: 200,
  latencyMs: 820,
  inputTokens: 12,
  outputTokens: 40,
  cacheReadInputTokens: 2048,
  cacheCreationInputTokens: 0,
  upstreamRequestId: "req_1",
  gatewayKeyId: "key-ada",
  agentId: "ada",
  floorId: "web-shop",
  ownerTool: null,
  issue: 4,
  pullRequest: null,
  estimatedCostUsd: 0.0012,
  timeToFirstByteMs: 310,
  requestHeaders: {
    "x-api-key": "[REDACTED]",
    "anthropic-version": "2023-06-01",
  },
  responseHeaders: { "content-type": "text/event-stream" },
  ...fields,
});

const get = ({ server, owner }: Setup, url: string) =>
  server.inject({ method: "GET", url, headers: owner.headers });

/** An open stream at `path`, read one `data` frame at a time. */
async function stream(
  setup: Setup,
  path: string,
  headers: Record<string, string> = {},
) {
  const controller = new AbortController();
  const response = await fetch(`${setup.baseUrl}${path}`, {
    headers: { cookie: setup.owner.cookie, ...headers },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "text/event-stream; charset=utf-8",
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    /** The next frame with data: its id and data. */
    async next(): Promise<{ id: number; data: unknown }> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (\d+)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (id !== undefined && data !== undefined) {
            return { id: Number(id), data: JSON.parse(data) as unknown };
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

describe("the request list", () => {
  it("lists requests newest first, filtered and a page at a time", async () => {
    const setup = await setUp();
    await setup.history.record(record());
    await setup.history.record(
      record({ status: 429, agentId: null, floorId: null, ownerTool: "Codex" }),
    );
    await setup.history.record(record({ endpoint: "responses", status: 200 }));

    const all = gatewayRequestListSchema.parse(
      (await get(setup, "/api/gateway/requests")).json(),
    );
    expect(all.requests.map(({ id }) => id)).toEqual([3, 2, 1]);
    expect(all.nextBefore).toBeNull();
    expect(all.requests[2]).toEqual({
      id: 1,
      startedAt: "2026-10-09T12:00:00.000Z",
      endpoint: "messages",
      model: "claude-opus-5-5",
      streamed: true,
      status: 200,
      latencyMs: 820,
      timeToFirstByteMs: 310,
      inputTokens: 12,
      outputTokens: 40,
      cacheReadInputTokens: 2048,
      cacheCreationInputTokens: 0,
      estimatedCostUsd: 0.0012,
      account: "Work",
      aiAccountId: "account-1",
      agentId: "ada",
      floorId: "web-shop",
      ownerTool: null,
      issue: 4,
      pullRequest: null,
      upstreamRequestId: "req_1",
      keepAlive: false,
    });

    const ids = async (query: string) =>
      gatewayRequestListSchema
        .parse((await get(setup, `/api/gateway/requests?${query}`)).json())
        .requests.map(({ id }) => id);
    expect(await ids("status=4xx")).toEqual([2]);
    expect(await ids("ownerTool=Codex")).toEqual([2]);
    expect(await ids("agentId=ada&endpoint=messages")).toEqual([1]);
    expect(await ids("q=codex")).toEqual([2]);
    const page = gatewayRequestListSchema.parse(
      (await get(setup, "/api/gateway/requests?limit=2")).json(),
    );
    expect(page.nextBefore).toBe(2);
    expect(await ids("limit=2&before=2")).toEqual([1]);

    for (const bad of ["status=6xx", "limit=500", "endpoint=nope", "from=x"]) {
      expect(
        (await get(setup, `/api/gateway/requests?${bad}`)).statusCode,
        bad,
      ).toBe(400);
    }
  });

  it("marks the prompt-cache keep-alives the Gateway sent for an Agent", async () => {
    const setup = await setUp();
    await setup.history.record(record());
    // Sent by the Gateway to keep Ada's prompt cache warm (FR-39).
    await setup.history.record(
      record({ streamed: false, outputTokens: 0, keepAlive: true }),
    );
    const { requests } = gatewayRequestListSchema.parse(
      (await get(setup, "/api/gateway/requests")).json(),
    );
    expect(
      requests.map(({ id, agentId, keepAlive }) => [id, agentId, keepAlive]),
    ).toEqual([
      [2, "ada", true],
      [1, "ada", false],
    ]);
    const detail = gatewayRequestDetailSchema.parse(
      (await get(setup, "/api/gateway/requests/2")).json(),
    );
    expect(detail.keepAlive).toBe(true);
  });

  it("needs a session", async () => {
    const setup = await setUp();
    for (const url of [
      "/api/gateway/requests",
      "/api/gateway/requests/1",
      "/api/gateway/requests/stream",
      "/api/gateway/logs/stream",
    ]) {
      expect(
        (await setup.server.inject({ method: "GET", url })).statusCode,
      ).toBe(401);
    }
  });
});

describe("one request", () => {
  it("shows its headers, timings, tokens, cost, account, Agent and bodies", async () => {
    const setup = await setUp();
    await setup.history.record({
      ...record(),
      bodies: {
        request: '{"model":"claude-opus-5-5"}',
        response: "event: message_stop\n\n",
        truncated: false,
      },
    });
    await setup.history.record(record());
    const detail = gatewayRequestDetailSchema.parse(
      (await get(setup, "/api/gateway/requests/1")).json(),
    );
    expect(detail).toMatchObject({
      id: 1,
      latencyMs: 820,
      timeToFirstByteMs: 310,
      inputTokens: 12,
      estimatedCostUsd: 0.0012,
      account: "Work",
      agentId: "ada",
      floorId: "web-shop",
      requestHeaders: {
        "x-api-key": "[REDACTED]",
        "anthropic-version": "2023-06-01",
      },
      responseHeaders: { "content-type": "text/event-stream" },
      bodies: {
        request: '{"model":"claude-opus-5-5"}',
        response: "event: message_stop\n\n",
        truncated: false,
      },
    });
    const without = gatewayRequestDetailSchema.parse(
      (await get(setup, "/api/gateway/requests/2")).json(),
    );
    expect(without.bodies).toBeNull();
    expect((await get(setup, "/api/gateway/requests/99")).statusCode).toBe(404);
    expect((await get(setup, "/api/gateway/requests/x")).statusCode).toBe(404);
  });
});

describe("the live request stream", () => {
  it("sends each new request as it is recorded, matching its filter", async () => {
    const setup = await setUp();
    const all = await stream(setup, "/api/gateway/requests/stream");
    const errors = await stream(
      setup,
      "/api/gateway/requests/stream?status=5xx",
    );
    await setup.history.record(record({ status: 200 }));
    await setup.history.record(record({ status: 502 }));

    const first = await all.next();
    expect(first.id).toBe(1);
    expect(gatewayRequestSummarySchema.parse(first.data)).toMatchObject({
      id: 1,
      status: 200,
      model: "claude-opus-5-5",
    });
    expect((await all.next()).id).toBe(2);
    expect(await errors.next()).toMatchObject({ id: 2, data: { status: 502 } });
    all.close();
    errors.close();
  });

  it("resumes after Last-Event-ID, missing and repeating nothing", async () => {
    const setup = await setUp();
    for (const status of [200, 201, 202]) {
      await setup.history.record(record({ status }));
    }
    const resumed = await stream(setup, "/api/gateway/requests/stream", {
      "last-event-id": "1",
    });
    expect((await resumed.next()).id).toBe(2);
    expect((await resumed.next()).id).toBe(3);
    await setup.history.record(record({ status: 203 }));
    expect((await resumed.next()).id).toBe(4);
    resumed.close();
  });
});

describe("the live log stream", () => {
  const line = (fields: object) =>
    `${JSON.stringify({ level: 30, time: Date.UTC(2026, 9, 9, 12), pid: 1, hostname: "h", ...fields })}\n`;

  it("sends the Gateway's recent lines, then each new one", async () => {
    const setup = await setUp();
    setup.logs.write(
      line({ component: "gateway", msg: "AI Office's Gateway started." }),
    );
    setup.logs.write(line({ msg: "Not the Gateway's." }));
    const logs = await stream(setup, "/api/gateway/logs/stream");
    const first = await logs.next();
    expect(gatewayLogLineSchema.parse(first.data)).toEqual({
      id: 1,
      time: "2026-10-09T12:00:00.000Z",
      level: "info",
      message: "AI Office's Gateway started.",
      fields: { component: "gateway" },
    });
    setup.logs.write(
      line({
        level: 40,
        component: "gateway",
        msg: "A request without a Gateway Key in use was refused.",
        endpoint: "messages",
      }),
    );
    const next = await logs.next();
    expect(next).toMatchObject({
      id: 2,
      data: {
        level: "warn",
        message: "A request without a Gateway Key in use was refused.",
        fields: { component: "gateway", endpoint: "messages" },
      },
    });
    logs.close();
  });

  it("keeps only the most recent lines", () => {
    const hub = createLogHub({ capacity: 2 });
    for (const msg of ["a", "b", "c"]) {
      hub.write(line({ component: "gateway", msg }));
    }
    hub.write("not json");
    expect(hub.recent().map(({ message }) => message)).toEqual(["b", "c"]);
    expect(hub.recent(2).map(({ message }) => message)).toEqual(["c"]);
  });
});

describe("the body storage setting", () => {
  it("is on until the Owner turns it off", async () => {
    const setup = await setUp();
    expect((await get(setup, "/api/office/request-bodies")).json()).toEqual({
      store: true,
    });
    const off = await setup.server.inject({
      method: "PUT",
      url: "/api/office/request-bodies",
      headers: setup.owner.headers,
      payload: { store: false },
    });
    expect(off.json()).toEqual({ store: false });
    expect((await get(setup, "/api/office/request-bodies")).json()).toEqual({
      store: false,
    });
    const bad = await setup.server.inject({
      method: "PUT",
      url: "/api/office/request-bodies",
      headers: setup.owner.headers,
      payload: { store: "no" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
