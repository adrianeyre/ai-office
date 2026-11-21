import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allowedHeadersOf } from "./browser-access.ts";
import { buildGateway, refusalHeader, staticAccounts } from "./gateway.ts";
import { limitKeyCheck } from "./key-checks.ts";
import {
  createGatewayKeys,
  staticKeys,
  type GatewayCaller,
  type GatewayKeyAuthenticator,
} from "./keys/keys.ts";
import { memoryGatewayKeyStore } from "./keys/store.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  testCaller,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";

// Browser access (ADR 0013): an Owner tool's Gateway Key may be used from
// a web page in a browser, on the origins it lists or on any. These drive
// the real Gateway, listening on loopback, as a browser calls it: a
// preflight first (with no key), then the request, with `Origin` on both.

const cvChecker = "http://localhost:4870";
const pagesSite = "https://cv.example.github.io";

/** An Owner tool's key that any page may use. */
const anyKey = "aio_gk_browseranyoriginfakekey00000000000000";
/** An Owner tool's key that only the CV checker may use. */
const cvKey = "aio_gk_browsercvcheckerfakekey0000000000000";
/** An Agent's key: never a browser's. */
const agentKey = "aio_gk_browseragentsownfakekey000000000000";

const anyCaller: GatewayCaller = {
  kind: "owner_tool",
  keyId: "any-key",
  name: "Any page",
  browserAccess: { mode: "any" },
};
const cvCaller: GatewayCaller = {
  kind: "owner_tool",
  keyId: "cv-key",
  name: "CV checker",
  browserAccess: { mode: "origins", origins: [cvChecker] },
};
const agentCaller: GatewayCaller = {
  kind: "agent",
  keyId: "agent-key",
  agentId: "ada",
  floorId: "web-shop",
  name: "Ada",
};

/** `gatewayKey` (off), the CV checker's, any page's and an Agent's. */
const browserKeys = staticKeys({
  [gatewayKey]: testCaller,
  [anyKey]: anyCaller,
  [cvKey]: cvCaller,
  [agentKey]: agentCaller,
});

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  gateway = undefined;
  upstream = undefined;
});

const message = JSON.stringify({
  type: "message",
  usage: { input_tokens: 3, output_tokens: 4 },
});

const answering = () =>
  startFakeUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(message);
  });

const preflight = (
  origin: string | undefined,
  options: { method?: string; headers?: string; path?: string } = {},
) =>
  fetch(`${gateway?.url ?? ""}${options.path ?? "/v1/messages"}`, {
    method: "OPTIONS",
    headers: {
      ...(origin === undefined ? {} : { origin }),
      "access-control-request-method": options.method ?? "POST",
      "access-control-request-headers":
        options.headers ?? "x-api-key,content-type,anthropic-version",
    },
  });

const call = (
  origin: string | undefined,
  key: string | null,
  body: unknown = { model: "claude-haiku-5-5", max_tokens: 16, messages: [] },
) =>
  fetch(`${gateway?.url ?? ""}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(origin === undefined ? {} : { origin }),
      ...(key === null ? {} : { "x-api-key": key }),
    },
    body: JSON.stringify(body),
  });

const records = () =>
  (gateway?.requestLog as ReturnType<typeof memoryRequestLog> | undefined)
    ?.records ?? [];

/** Whether an answer grants `origin`, and never with credentials. */
function expectGranted(response: Response, origin: string) {
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("vary")).toMatch(/(^|, )Origin(,|$)/);
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
}

/** Whether an answer carries no CORS header at all. */
function expectNoCors(response: Response) {
  for (const name of response.headers.keys()) {
    expect(name).not.toMatch(/^access-control-/);
  }
}

describe("a browser's preflight", () => {
  it("is answered with a 204 granting its origin, GET and POST, the headers it may send, for 10 minutes, when a key allows it", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys: browserKeys });
    const response = await preflight(cvChecker, {
      headers:
        "Authorization, x-api-key, content-type, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
    });
    expect(response.status).toBe(204);
    expectGranted(response, cvChecker);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, x-api-key, content-type, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(await response.text()).toBe("");
    // For any /v1 route, the Models list's GET too, and any origin, which
    // one key allows.
    const models = await preflight(pagesSite, {
      method: "GET",
      path: "/v1/models",
      headers: "authorization",
    });
    expect(models.status).toBe(204);
    expectGranted(models, pagesSite);
  });

  it("needs no Gateway Key, is not recorded and reaches no AI Account", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys: browserKeys });
    for (const path of [
      "/v1/messages",
      "/v1/chat/completions",
      "/v1/responses",
    ]) {
      expect((await preflight(cvChecker, { path })).status, path).toBe(204);
    }
    // Give a recording the chance to happen, were there one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(records()).toEqual([]);
    expect(upstream.received).toEqual([]);
  });

  it("allows only the request headers listed, and the SDKs' x-stainless ones, never user-agent or a cookie", async () => {
    gateway = await startGateway({ keys: browserKeys });
    const response = await preflight(cvChecker, {
      headers:
        "x-api-key, user-agent, cookie, x-stainless-os, x-stainless-retry-count, x-ai-office-issue, openai-organization, openai-project, x-forwarded-for",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "x-api-key, x-stainless-os, x-stainless-retry-count, openai-organization, openai-project",
    );
    // Asking for none it may send: no header list at all.
    const none = await preflight(cvChecker, { headers: "user-agent" });
    expect(none.status).toBe(204);
    expect(none.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("is refused as today for another method", async () => {
    gateway = await startGateway({ keys: browserKeys });
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const response = await preflight(cvChecker, { method });
      expect(response.status, method).toBe(404);
      expectNoCors(response);
    }
  });

  it("is refused as today for an origin no key allows, without an origin, and while no key allows any", async () => {
    gateway = await startGateway({
      keys: staticKeys({ [gatewayKey]: testCaller, [cvKey]: cvCaller }),
    });
    for (const origin of [
      "https://attacker.example",
      "http://localhost:4871",
      "https://localhost:4870",
      "null",
      `${cvChecker}/`,
      undefined,
    ]) {
      const response = await preflight(origin);
      expect(response.status, String(origin)).toBe(404);
      expectNoCors(response);
    }
    await gateway.close();
    // Only keys that are off, an Agent's among them.
    gateway = await startGateway({
      keys: staticKeys({ [gatewayKey]: testCaller, [agentKey]: agentCaller }),
    });
    const off = await preflight(cvChecker);
    expect(off.status).toBe(404);
    expectNoCors(off);
    await gateway.close();
    // Keys that cannot tell at all.
    gateway = await startGateway({
      keys: { authenticate: () => Promise.resolve(testCaller) },
    });
    const unknown = await preflight(cvChecker);
    expect(unknown.status).toBe(404);
    expectNoCors(unknown);
  });

  it("is refused as today when the keys' browser access cannot be read", async () => {
    const failing: GatewayKeyAuthenticator = {
      authenticate: () => Promise.resolve(undefined),
      allowsBrowserOrigin: () =>
        Promise.reject(new Error("The database is down.")),
    };
    gateway = await startGateway({ keys: failing });
    const response = await preflight(cvChecker);
    expect(response.status).toBe(404);
    expectNoCors(response);
  });

  it("is not answered on a path outside /v1", async () => {
    gateway = await startGateway({ keys: browserKeys });
    for (const path of ["/health", "/api/session", "/v1x", "/"]) {
      const response = await preflight(cvChecker, { path });
      expect(response.status, path).toBe(404);
      expectNoCors(response);
    }
  });

  it("follows the keys in use: a key turned on, off or revoked counts from the next preflight", async () => {
    const store = memoryGatewayKeyStore();
    const keys = createGatewayKeys({
      store,
      encryptor: encryptorFromKey(Buffer.alloc(32, 7)),
      events: createEventBus({ store: memoryEventStore() }),
    });
    gateway = await startGateway({ keys });
    const { gatewayKey: made, key } =
      await keys.createOwnerToolKey("CV checker");
    expect((await preflight(cvChecker)).status).toBe(404);
    await keys.update(made.id, {
      browserAccess: { mode: "origins", origins: [cvChecker] },
    });
    expect((await preflight(cvChecker)).status).toBe(204);
    expect((await preflight(pagesSite)).status).toBe(404);
    // And the key itself serves the page.
    expect((await call(cvChecker, key)).status).not.toBe(403);
    await keys.update(made.id, { browserAccess: { mode: "any" } });
    expect((await preflight(pagesSite)).status).toBe(204);
    await keys.revoke(made.id);
    expect((await preflight(cvChecker)).status).toBe(404);
    expect((await preflight(pagesSite)).status).toBe(404);
  });
});

describe("a page's request, with a key that allows its origin", () => {
  it("is served, granting its origin, and letting its page read the useful headers", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "request-id": "req_browser",
        // An AI Provider's own CORS answer is not passed on.
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        vary: "Accept-Encoding",
      });
      response.end(message);
    });
    gateway = await startGateway({ upstream, keys: browserKeys });
    for (const [origin, key] of [
      [cvChecker, cvKey],
      [pagesSite, anyKey],
      [cvChecker, anyKey],
    ] as const) {
      const response = await call(origin, key);
      expect(response.status).toBe(200);
      expectGranted(response, origin);
      expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
      expect(response.headers.get("access-control-expose-headers")).toBe(
        `retry-after, request-id, x-request-id, ${refusalHeader}`,
      );
      expect(response.headers.get("request-id")).toBe("req_browser");
    }
    await vi.waitFor(() => {
      expect(records()).toHaveLength(3);
    });
  });

  it("grants its origin on a 503 when no AI Account can serve it", async () => {
    gateway = await startGateway({ account: undefined, keys: browserKeys });
    const response = await call(cvChecker, cvKey);
    expect(response.status).toBe(503);
    expectGranted(response, cvChecker);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "No AI Account is available." },
    });
  });

  it("grants its origin on a Token Cap refusal, and lets its page read the refusal header", async () => {
    upstream = await answering();
    gateway = await startGateway({
      upstream,
      keys: browserKeys,
      ownerToolCapCheck: () =>
        Promise.resolve({ message: "CV checker reached its daily Token Cap." }),
    });
    const response = await call(cvChecker, cvKey);
    expect(response.status).toBe(403);
    expectGranted(response, cvChecker);
    expect(response.headers.get(refusalHeader)).toBe("token_cap");
    expect(response.headers.get("access-control-expose-headers")).toContain(
      refusalHeader,
    );
    expect(upstream.received).toEqual([]);
  });

  it("grants its origin on a streamed answer, before its first event", async () => {
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
    gateway = await startGateway({ upstream, keys: browserKeys });
    const response = await call(cvChecker, cvKey, {
      model: "claude-haiku-5-5",
      stream: true,
    });
    // The headers are here while the AI Provider is still streaming.
    expect(response.status).toBe(200);
    expectGranted(response, cvChecker);
    finish();
    expect(await response.text()).toContain("message_delta");
  });

  it("grants its origin on a translated streamed answer too", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'event: message_start\ndata: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":5,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      );
    });
    gateway = await startGateway({ upstream, keys: browserKeys });
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        origin: pagesSite,
        authorization: `Bearer ${anyKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expectGranted(response, pagesSite);
    await response.text();
  });

  it("grants its origin on a 404 for a /v1 route there is not", async () => {
    gateway = await startGateway({ keys: browserKeys });
    const response = await fetch(`${gateway.url}/v1/nowhere`, {
      method: "POST",
      headers: { origin: cvChecker, "x-api-key": cvKey },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expectGranted(response, cvChecker);
  });
});

describe("a page's request, with a key that does not allow its origin", () => {
  it("is refused with a 403 in the route's format, before anything is sent on, and granted nothing", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys: browserKeys });
    for (const [origin, key] of [
      [pagesSite, cvKey],
      [cvChecker, gatewayKey],
      ["https://attacker.example", gatewayKey],
      [cvChecker, agentKey],
    ] as const) {
      const response = await call(origin, key);
      expect(response.status, `${origin} ${key}`).toBe(403);
      expectNoCors(response);
      expect(await response.json()).toEqual({
        type: "error",
        error: {
          type: "permission_error",
          message: `This API key doesn't allow browser requests from ${origin}. Turn on Browser access for it in API Key Management.`,
        },
      });
    }
    // In OpenAI's format on its routes.
    const chat = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        origin: pagesSite,
        authorization: `Bearer ${gatewayKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
    });
    expect(chat.status).toBe(403);
    expect(
      ((await chat.json()) as { error: { message: string } }).error.message,
    ).toContain("doesn't allow browser requests");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstream.received).toEqual([]);
    expect(records()).toEqual([]);
  });

  it("is served as always when its Origin is the Gateway's own address", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys: browserKeys });
    const response = await call(gateway.url, gatewayKey);
    expect(response.status).toBe(200);
    expectNoCors(response);
  });
});

describe("a page's request refused before its key is checked", () => {
  it("grants its origin on a 401 when some key allows it, so its page can read why", async () => {
    gateway = await startGateway({ keys: browserKeys });
    for (const key of [null, "aio_gk_notakeyinuse0000000000000"]) {
      const response = await call(cvChecker, key);
      expect(response.status).toBe(401);
      expectGranted(response, cvChecker);
      expect(
        ((await response.json()) as { error: { message: string } }).error
          .message,
      ).toMatch(/Gateway Key/);
    }
  });

  it("grants nothing on a 401 when no key allows its origin", async () => {
    gateway = await startGateway({
      keys: staticKeys({ [gatewayKey]: testCaller, [cvKey]: cvCaller }),
    });
    const response = await call(pagesSite, null);
    expect(response.status).toBe(401);
    expectNoCors(response);
  });

  it("grants its origin on a 429 when its client has tried too many Gateway Keys", async () => {
    const app = await buildGateway({
      logger: pino({ level: "silent" }),
      accounts: staticAccounts(undefined),
      keys: browserKeys,
      requestLog: memoryRequestLog(),
    });
    await app.ready();
    // As the app's one entry point limits the key check, by client.
    const server = createServer((request, response) => {
      limitKeyCheck(request, () => ({ allowed: false, retryAfterSeconds: 7 }));
      app.routing(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/v1/messages`,
        {
          method: "POST",
          headers: {
            origin: cvChecker,
            "x-api-key": "aio_gk_notakeyinuse0000000000000",
          },
          body: "{}",
        },
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("7");
      expectGranted(response, cvChecker);
    } finally {
      await app.close();
    }
  });
});

describe("a request without Origin", () => {
  it("is answered as always, whatever keys allow browsers", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys: browserKeys });
    for (const key of [gatewayKey, cvKey, anyKey, agentKey]) {
      const served = await call(undefined, key);
      expect(served.status, key).toBe(200);
      expectNoCors(served);
      expect(served.headers.get("vary")).toBeNull();
    }
    const refused = await call(undefined, null);
    expect(refused.status).toBe(401);
    expectNoCors(refused);
    // Nor is the Gateway's own /health a page's, even with an Origin.
    const health = await fetch(`${gateway.url}/health`, {
      headers: { origin: cvChecker },
    });
    expect(health.status).toBe(200);
    expectNoCors(health);
  });
});

describe("the request headers a preflight allows", () => {
  it("are those listed, lowercased, each once", () => {
    expect(allowedHeadersOf(undefined)).toEqual([]);
    expect(allowedHeadersOf("")).toEqual([]);
    expect(
      allowedHeadersOf(
        "Content-Type,X-API-Key, x-api-key ,X-Stainless-Lang,Cookie,User-Agent,x-stainless-",
      ),
    ).toEqual(["content-type", "x-api-key", "x-stainless-lang"]);
  });
});
