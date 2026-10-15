// One entry point (Q32): the app's own port serves the AI Gateway's `/v1`
// paths exactly as the Gateway's own port does, while `/api`, `/health`
// and the web app are the app's as before.
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  buildGateway,
  createAgentWork,
  memoryRequestLog,
  staticAccounts,
  staticKeys,
  type GatewayCaller,
} from "@ai-office/gateway";
import { aiOfficeHeaders } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.ts";
import { isGatewayPath } from "./gateway-entry.ts";
import { createLogger } from "./logger.ts";
import { signIn, testAuth, webBuild, type SignedIn } from "./test-support.ts";

const ownerToolKey = "aio_gk_entrypointtestownertoolkey00000000000000";
const agentKey = "aio_gk_entrypointtestagentkey0000000000000000000";
const ownerTool: GatewayCaller = {
  kind: "owner_tool",
  keyId: "owner-tool-key",
  name: "claude-code-here",
};
const agent: GatewayCaller = {
  kind: "agent",
  keyId: "agent-key",
  agentId: "agent-1",
  floorId: "floor-1",
  name: "Ada",
};

const message = {
  id: "msg_entry_point",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Hello from upstream." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 5 },
};

const sseEvents = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from upstream." } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
];

/** The Anthropic API, as the one AI Account's upstream. */
interface Upstream {
  readonly url: string;
  /** Each request body it was sent, as bytes. */
  readonly bodies: Buffer[];
  /** Each request's headers, as the Gateway sent them. */
  readonly headers: IncomingHttpHeaders[];
  /** Holds the rest of the next stream back until called. */
  holdStream(): () => void;
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const bodies: Buffer[] = [];
  const headers: IncomingHttpHeaders[] = [];
  let hold: Promise<void> | undefined;
  const respond = async (body: Buffer, response: ServerResponse) => {
    const parsed = JSON.parse(body.toString("utf8")) as { stream?: boolean };
    if (parsed.stream === true) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": "req_upstream",
      });
      const [first, ...rest] = sseEvents;
      response.write(first);
      await hold;
      for (const event of rest) {
        response.write(event);
      }
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "request-id": "req_upstream",
    });
    response.end(JSON.stringify(message));
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      bodies.push(body);
      headers.push(request.headers);
      void respond(body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    bodies,
    headers,
    holdStream() {
      let release: () => void = () => undefined;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        hold = undefined;
      };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("the AI Gateway on the app's own port", () => {
  let upstream: Upstream;
  let gateway: FastifyInstance;
  let app: FastifyInstance;
  let web: Awaited<ReturnType<typeof webBuild>>;
  let owner: SignedIn;
  /** The Gateway's own port (the sandboxes' 3047) and the app's (3045). */
  let ports: { readonly gateway: string; readonly app: string };
  const requestLog = memoryRequestLog();
  const capped = new Set<string>();
  // The Agent's sandbox works #42 (pen-testing G1-1).
  const work = createAgentWork();
  work.hold("agent-1", { issue: 42 });

  beforeAll(async () => {
    upstream = await startUpstream();
    web = await webBuild();
    gateway = await buildGateway({
      logger: pino({ level: "silent" }),
      accounts: staticAccounts({
        id: null,
        name: "entry-point-account",
        apiKey: "sk-ant-api03-entrypointtestaccountkey-000000000",
        baseUrl: upstream.url,
        apiFormat: "anthropic",
      }),
      keys: staticKeys({ [ownerToolKey]: ownerTool, [agentKey]: agent }),
      requestLog,
      work,
      capCheck: ({ agentId }) =>
        Promise.resolve(
          capped.has(agentId)
            ? { message: "Ada reached her daily Token Cap." }
            : undefined,
        ),
    });
    app = await buildApp({
      logger: createLogger({ level: "silent", secrets: [] }),
      checkDatabase: () => Promise.resolve(true),
      webDistDir: web.dir,
      auth: await testAuth(),
      gateway,
    });
    ports = {
      gateway: await gateway.listen({ port: 0, host: "127.0.0.1" }),
      app: await app.listen({ port: 0, host: "127.0.0.1" }),
    };
    owner = await signIn(app);
  });

  afterAll(async () => {
    await app.close();
    await gateway.close();
    await upstream.close();
    await web.remove();
  });

  beforeEach(() => {
    requestLog.records.length = 0;
    capped.clear();
  });

  const post = (
    base: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = { "x-api-key": ownerToolKey },
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const messagesRequest = {
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "Hello?" }],
  };

  it.each(["gateway", "app"] as const)(
    "answers /v1/messages on the %s's port, attributed to the key's owner",
    async (port) => {
      const response = await post(ports[port], "/v1/messages", messagesRequest);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(message);
      await expect.poll(() => requestLog.records.length).toBe(1);
      expect(requestLog.records[0]).toMatchObject({
        endpoint: "messages",
        status: 200,
        streamed: false,
        gatewayKeyId: "owner-tool-key",
        ownerTool: "claude-code-here",
        agentId: null,
        inputTokens: 12,
        outputTokens: 5,
      });
    },
  );

  it.each(["gateway", "app"] as const)(
    "streams /v1/messages on the %s's port as it arrives",
    async (port) => {
      const release = upstream.holdStream();
      const response = await post(ports[port], "/v1/messages", {
        ...messagesRequest,
        stream: true,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(
        /^text\/event-stream/,
      );
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      // The first event arrives while upstream still holds the rest back.
      let received = "";
      while (!received.includes("\n\n")) {
        const { value, done } = await reader.read();
        expect(done).toBe(false);
        received += decoder.decode(value, { stream: true });
      }
      expect(received).toContain("event: message_start");
      expect(received).not.toContain("message_stop");
      release();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        received += decoder.decode(value, { stream: true });
      }
      expect(received).toBe(sseEvents.join(""));
      await expect.poll(() => requestLog.records.length).toBe(1);
      expect(requestLog.records[0]).toMatchObject({
        streamed: true,
        status: 200,
        ownerTool: "claude-code-here",
        outputTokens: 5,
      });
    },
  );

  it("passes a large body through unchanged", async () => {
    const big = JSON.stringify({
      ...messagesRequest,
      messages: [{ role: "user", content: "x".repeat(8 * 1024 * 1024) }],
    });
    upstream.bodies.length = 0;
    const response = await post(ports.app, "/v1/messages", big);
    expect(response.status).toBe(200);
    expect(upstream.bodies).toHaveLength(1);
    expect(upstream.bodies[0]?.toString("utf8")).toBe(big);
  });

  it("answers /v1/chat/completions on the app's port as on the Gateway's", async () => {
    const request = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hello?" }],
    };
    const [direct, entry] = await Promise.all(
      [ports.gateway, ports.app].map(async (base) => {
        const response = await post(base, "/v1/chat/completions", request, {
          authorization: `Bearer ${ownerToolKey}`,
        });
        return {
          status: response.status,
          body: (await response.json()) as {
            object: string;
            choices: { message: { content: string } }[];
          },
        };
      }),
    );
    expect(entry?.status).toBe(200);
    expect(entry?.status).toBe(direct?.status);
    expect(entry?.body.object).toBe("chat.completion");
    expect(entry?.body.choices[0]?.message.content).toBe(
      "Hello from upstream.",
    );
    expect(entry?.body.choices).toEqual(direct?.body.choices);
  });

  it("answers /v1/models, which the Gateway does not serve, with the Gateway's 404 rather than the web app", async () => {
    const answers = await Promise.all(
      [ports.gateway, ports.app].map(async (base) => {
        const response = await fetch(`${base}/v1/models`, {
          headers: { "x-api-key": ownerToolKey, cookie: owner.cookie },
        });
        return {
          status: response.status,
          type: response.headers.get("content-type"),
          body: await response.text(),
        };
      }),
    );
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[1]?.status).toBe(404);
    expect(answers[1]?.body).toContain("not_found_error");
    expect(answers[1]?.body).not.toContain("AI Office</");
  });

  it.each(["gateway", "app"] as const)(
    "refuses a call without a Gateway Key on the %s's port, and a UI session alone is not one",
    async (port) => {
      const without = await post(
        ports[port],
        "/v1/messages",
        messagesRequest,
        {},
      );
      expect(without.status).toBe(401);
      expect(await without.json()).toMatchObject({
        type: "error",
        error: { type: "authentication_error" },
      });
      const sessionOnly = await post(
        ports[port],
        "/v1/messages",
        messagesRequest,
        owner.headers,
      );
      expect(sessionOnly.status).toBe(401);
      const wrongKey = await post(
        ports[port],
        "/v1/chat/completions",
        messagesRequest,
        { ...owner.headers, authorization: "Bearer aio_gk_notakey" },
      );
      expect(wrongKey.status).toBe(401);
      expect(requestLog.records).toEqual([]);
    },
  );

  it.each(["gateway", "app"] as const)(
    "refuses an Agent at its Token Cap on the %s's port, and attributes its calls otherwise",
    async (port) => {
      const headers = { "x-api-key": agentKey, [aiOfficeHeaders.issue]: "42" };
      const served = await post(
        ports[port],
        "/v1/messages",
        messagesRequest,
        headers,
      );
      expect(served.status).toBe(200);
      await expect.poll(() => requestLog.records.length).toBe(1);
      expect(requestLog.records[0]).toMatchObject({
        agentId: "agent-1",
        floorId: "floor-1",
        issue: 42,
        ownerTool: null,
      });
      capped.add("agent-1");
      const refused = await post(
        ports[port],
        "/v1/messages",
        messagesRequest,
        headers,
      );
      expect(refused.status).toBe(403);
      expect(refused.headers.get("x-ai-office-refusal")).toBe("token_cap");
    },
  );

  it("keeps /health, /api and the web app the app's", async () => {
    const health = await fetch(`${ports.app}/health`);
    expect(await health.json()).toEqual({ status: "ok", database: "up" });
    // The Gateway's own /health is not the app's.
    const session = await fetch(`${ports.app}/api/session`, {
      headers: { cookie: owner.cookie },
    });
    expect(session.status).toBe(200);
    const anonymous = await fetch(`${ports.app}/api/session`);
    expect(anonymous.status).toBe(401);
    const page = await fetch(`${ports.app}/`, {
      headers: { cookie: owner.cookie },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("AI Office");
    // A page whose name only starts with v1 is still the web app's.
    const v1ish = await fetch(`${ports.app}/v1things`, {
      headers: { cookie: owner.cookie },
    });
    expect(await v1ish.text()).toContain("AI Office");
    // The Gateway's own port serves no web app and no API.
    const notTheApp = await fetch(`${ports.gateway}/api/session`, {
      headers: { cookie: owner.cookie },
    });
    expect(notTheApp.status).toBe(404);
  });
});

// What the pen-testing fixes give every answer of the app, a `/v1` request
// gets too, though it goes to the Gateway before any of the app's hooks:
// the proof Caddy sends (PROXY_SECRET) is taken off, and X-Forwarded-*
// with it unless the proof is right (A1-1), so the secret reaches neither
// the Gateway's request history nor an AI Provider; and the answer carries
// the security headers (A1-6), HSTS only over https.
describe("the AI Gateway on the app's port, behind Caddy (A1-1, A1-6)", () => {
  const proxySecret = "entry-point-test-proxy-secret-00000000000000";
  let upstream: Upstream;
  let gateway: FastifyInstance;
  let app: FastifyInstance;
  let web: Awaited<ReturnType<typeof webBuild>>;
  let base: string;
  const requestLog = memoryRequestLog();

  /** The app as `startOffice` builds it behind Caddy, with `gateway`. */
  const appBehindCaddy = async (publicUrl?: string) =>
    buildApp({
      logger: createLogger({ level: "silent", secrets: [proxySecret] }),
      checkDatabase: () => Promise.resolve(true),
      webDistDir: web.dir,
      auth: await testAuth(),
      trustProxy: 1,
      proxySecret,
      ...(publicUrl === undefined ? {} : { publicUrl }),
      gateway,
    });

  beforeAll(async () => {
    upstream = await startUpstream();
    web = await webBuild();
    gateway = await buildGateway({
      logger: pino({ level: "silent" }),
      accounts: staticAccounts({
        id: null,
        name: "entry-point-account",
        apiKey: "sk-ant-api03-entrypointtestaccountkey-000000000",
        baseUrl: upstream.url,
        apiFormat: "anthropic",
      }),
      keys: staticKeys({ [ownerToolKey]: ownerTool }),
      requestLog,
    });
    app = await appBehindCaddy();
    base = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    await gateway.close();
    await upstream.close();
    await web.remove();
  });

  beforeEach(() => {
    requestLog.records.length = 0;
    upstream.headers.length = 0;
  });

  const call = (
    headers: Record<string, string>,
    path = "/v1/messages",
    at = base,
  ) =>
    fetch(`${at}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ownerToolKey,
        ...headers,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello?" }],
      }),
    });

  /** The one request the Gateway recorded and the one it sent upstream. */
  const whatTheGatewaySaw = async () => {
    await expect.poll(() => requestLog.records.length).toBe(1);
    expect(upstream.headers).toHaveLength(1);
    return {
      history: requestLog.records[0]?.requestHeaders ?? {},
      provider: upstream.headers[0] ?? {},
    };
  };

  it("takes PROXY_SECRET off a /v1 request Caddy sends, so neither the Gateway's request history nor the AI Provider gets it", async () => {
    const response = await call({
      "x-ai-office-proxy": proxySecret,
      "x-forwarded-for": "192.0.2.7",
    });
    expect(response.status).toBe(200);
    const { history, provider } = await whatTheGatewaySaw();
    expect(history).not.toHaveProperty("x-ai-office-proxy");
    expect(provider).not.toHaveProperty("x-ai-office-proxy");
    expect(JSON.stringify(requestLog.records)).not.toContain(proxySecret);
    expect(JSON.stringify(upstream.headers)).not.toContain(proxySecret);
    // The proof was right, so the client address Caddy gave is kept.
    expect(history["x-forwarded-for"]).toBe("192.0.2.7");
  });

  it.each([
    ["no proof", undefined],
    ["a wrong one", `${proxySecret}-guess`],
  ])(
    "keeps no X-Forwarded-* from a /v1 caller that sends %s, as for the app's own routes",
    async (_, proof) => {
      const response = await call({
        ...(proof === undefined ? {} : { "x-ai-office-proxy": proof }),
        "x-forwarded-for": "198.51.100.9",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      });
      expect(response.status).toBe(200);
      const { history, provider } = await whatTheGatewaySaw();
      for (const name of [
        "x-ai-office-proxy",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
      ]) {
        expect(history, name).not.toHaveProperty(name);
        expect(provider, name).not.toHaveProperty(name);
      }
      // Not over https by the caller's word: no HSTS.
      expect(response.headers.get("strict-transport-security")).toBeNull();
    },
  );

  it.each([
    ["a served call", {}, "/v1/messages", 200],
    [
      "a refusal without a Gateway Key",
      { "x-api-key": "" },
      "/v1/messages",
      401,
    ],
    ["a path the Gateway does not serve", {}, "/v1/nothing-here", 404],
  ])(
    "%s on /v1 carries the security headers the app's own answers do",
    async (_, headers, path, status) => {
      const response = await call(headers, path);
      expect(response.status).toBe(status);
      const apps = await fetch(`${base}/api/session`);
      expect(apps.status).toBe(401);
      for (const name of [
        "content-security-policy",
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
      ]) {
        expect(response.headers.get(name), name).toBe(apps.headers.get(name));
      }
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
    },
  );

  it("sends HSTS on /v1 only over https: from the proxy that proves itself, or from an https PUBLIC_URL", async () => {
    const hsts = async (headers: Record<string, string>, at = base) =>
      (await call(headers, "/v1/messages", at)).headers.get(
        "strict-transport-security",
      );
    expect(
      await hsts({
        "x-ai-office-proxy": proxySecret,
        "x-forwarded-proto": "https",
      }),
    ).toBe("max-age=31536000");
    expect(
      await hsts({
        "x-ai-office-proxy": proxySecret,
        "x-forwarded-proto": "http",
      }),
    ).toBeNull();
    expect(await hsts({ "x-forwarded-proto": "https" })).toBeNull();
    expect(await hsts({})).toBeNull();
    const served = await appBehindCaddy("https://ai-office.example.com");
    try {
      const at = await served.listen({ port: 0, host: "127.0.0.1" });
      expect(await hsts({}, at)).toBe("max-age=31536000");
    } finally {
      await served.close();
    }
  });

  // Pen-testing I2-3: by the client the app believes, as for sign-ins.
  it("limits Gateway Keys not in use per client Caddy names: that client's right key waits too, another's does not, and a direct caller's own X-Forwarded-For buys no bucket of its own", async () => {
    const limited = await appBehindCaddy();
    try {
      const at = await limited.listen({ port: 0, host: "127.0.0.1" });
      const notInUse = `aio_gk_${"0".repeat(43)}`;
      const from = async (client: string, key: string) =>
        (
          await call(
            {
              "x-ai-office-proxy": proxySecret,
              "x-forwarded-for": client,
              "x-api-key": key,
            },
            "/v1/messages",
            at,
          )
        ).status;
      const guesses: number[] = [];
      for (let guess = 0; guess < 6; guess += 1) {
        guesses.push(await from("192.0.2.10", notInUse));
      }
      expect(guesses).toEqual([401, 401, 401, 401, 401, 429]);
      expect(await from("192.0.2.10", ownerToolKey)).toBe(429);
      expect(await from("192.0.2.11", ownerToolKey)).toBe(200);
      const direct: number[] = [];
      for (let guess = 0; guess < 6; guess += 1) {
        const response = await call(
          {
            "x-forwarded-for": `198.51.100.${String(guess)}`,
            "x-api-key": notInUse,
          },
          "/v1/messages",
          at,
        );
        direct.push(response.status);
      }
      expect(direct).toEqual([401, 401, 401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe("isGatewayPath", () => {
  it.each([
    ["/v1", true],
    ["/v1/messages", true],
    ["/v1/messages/count_tokens", true],
    ["/v1/chat/completions?x=1", true],
    ["/v1?x=1", true],
    ["/v1things", false],
    ["/api/v1/messages", false],
    ["/", false],
    ["/health", false],
    ["/V1/messages", false],
  ])("%s → %s", (url, expected) => {
    expect(isGatewayPath(url)).toBe(expected);
  });
});
