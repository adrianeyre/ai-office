import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  buildGateway,
  memoryRequestLog,
  staticAccounts,
  staticKeys,
  type GatewayCaller,
} from "@ai-office/gateway";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.ts";
import { probedApp, type ProbedApp } from "./pen-test-support.ts";
import { signIn, type SignedIn } from "./test-support.ts";

// I2 probe (pen-testing, "Infrastructure and delivery"), H21: the AI
// Gateway on the app's own port. `gateway-entry.ts` hands every request
// whose raw URL `isGatewayPath` matches to the Gateway's Fastify instance,
// before any of the app's hooks, and everything else to the app. This
// drives the real app (`buildApp`, as `startServer` builds it, with the
// real Gateway from `buildGateway`) over a real listening socket: `inject`
// would skip the server factory, which is where the split happens. Raw
// paths are sent with `node:http`, which sends them as written.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/I2.md.

const ownerToolKey = "aio_gk_i2probefakeownertoolkey000000000000000000";
const ownerTool: GatewayCaller = {
  kind: "owner_tool",
  keyId: "i2-owner-tool",
  name: "i2-probe-tool",
};

/** A fake AI Provider: answers every call, and keeps what it was sent. */
interface Upstream {
  readonly url: string;
  readonly received: { url: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const received: Upstream["received"] = [];
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      received.push({ url: request.url ?? "", headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg_i2",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Hello." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** One request with its path exactly as written. */
const send = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string | number> = {},
  body?: Buffer | string,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });

const messagesRequest = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 16,
  messages: [{ role: "user", content: "Hello?" }],
});

const json = { "content-type": "application/json" };

/**
 * The Gateway on a port of its own, as on GATEWAY_PORT (the sandboxes',
 * through the sandbox relay): nothing of the app before it. Runs `use`
 * with the port.
 */
async function onItsOwnPort(
  gateway: FastifyInstance,
  use: (port: number) => Promise<void>,
): Promise<void> {
  const own = createServer((request, response) => {
    gateway.routing(request, response);
  });
  await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
  try {
    await use((own.address() as AddressInfo).port);
  } finally {
    own.closeAllConnections();
    own.close();
  }
}

describe("I2 (H21): the AI Gateway on the app's own port", () => {
  let upstream: Upstream;
  let gateway: FastifyInstance;
  let probed: ProbedApp;
  let owner: SignedIn;
  let port: number;
  const requestLog = memoryRequestLog();
  /** The Gateway's log lines, as the server's redacting logger writes them. */
  const gatewayLines: string[] = [];
  /** Requests an app-wide `onRequest` hook saw, by URL. */
  const appHookSaw: string[] = [];

  beforeAll(async () => {
    upstream = await startUpstream();
    gateway = await buildGateway({
      // As `startServer` gives it: a child of the app's redacting logger.
      logger: createLogger({
        level: "debug",
        secrets: [],
        destination: { write: (line) => gatewayLines.push(line) },
      }).child({ component: "gateway" }),
      accounts: staticAccounts({
        id: null,
        name: "i2-account",
        apiKey: "sk-ant-api03-i2probefakeaccountkey-00000000000",
        baseUrl: upstream.url,
        apiFormat: "anthropic",
      }),
      keys: staticKeys({ [ownerToolKey]: ownerTool }),
      requestLog,
    });
    probed = await probedApp({ gateway });
    // Stands in for any app-wide control set as a hook: security headers
    // (#221 sets them so), a limiter, request logging.
    probed.server.addHook("onRequest", async (request, reply) => {
      appHookSaw.push(request.url);
      void reply.header("x-i2-app-hook", "ran");
    });
    await probed.server.listen({ port: 0, host: "127.0.0.1" });
    port = (probed.server.server.address() as AddressInfo).port;
    owner = await signIn(probed.server);
  });

  afterAll(async () => {
    await probed.server.close();
    await gateway.close();
    await upstream.close();
  });

  beforeEach(() => {
    requestLog.records.length = 0;
    upstream.received.length = 0;
    appHookSaw.length = 0;
    probed.lines.length = 0;
    gatewayLines.length = 0;
  });

  describe("the split: which side answers", () => {
    it("holds: /v1/messages with a Gateway Key is the Gateway's, and the app's hooks never see it", async () => {
      const answer = await send(
        port,
        "POST",
        "/v1/messages",
        { ...json, "x-api-key": ownerToolKey },
        messagesRequest,
      );
      expect(answer.status).toBe(200);
      expect(upstream.received).toHaveLength(1);
      await expect.poll(() => requestLog.records.length).toBe(1);
      expect(appHookSaw).toEqual([]);
    });

    it.each([
      "//v1/messages",
      "/V1/messages",
      "/%761/messages",
      "/v1%2Fmessages",
      "/./v1/messages",
      "/api/../v1/messages",
      "/x/../v1/messages",
      "http://127.0.0.1/v1/messages",
    ])(
      "holds: %s, with a valid Gateway Key, never reaches the Gateway or an AI Provider",
      async (path) => {
        const answer = await send(
          port,
          "POST",
          path,
          { ...json, "x-api-key": ownerToolKey, cookie: owner.cookie },
          messagesRequest,
        );
        expect(answer.status).not.toBe(200);
        expect(upstream.received).toEqual([]);
        expect(requestLog.records).toEqual([]);
        expect(answer.body).not.toContain("msg_i2");
      },
    );

    it.each([
      "/v1/../api/session",
      "/v1/%2e%2e/api/session",
      "/v1/..%2Fapi/session",
      "/v1/messages/../../api/session",
      "/v1?/../api/session",
    ])(
      "holds: %s, with the Owner's session, is the Gateway's 404 and never the app's session",
      async (path) => {
        const answer = await send(port, "GET", path, { cookie: owner.cookie });
        expect(answer.status).toBe(404);
        expect(answer.body).toContain("The AI Gateway has no such route.");
        expect(answer.body).not.toContain("csrfToken");
        expect(appHookSaw).toEqual([]);
      },
    );

    it("holds: a session cookie is not a Gateway credential, and is never forwarded to an AI Provider", async () => {
      const sessionOnly = await send(
        port,
        "POST",
        "/v1/messages",
        { ...json, ...owner.headers },
        messagesRequest,
      );
      expect(sessionOnly.status).toBe(401);
      expect(upstream.received).toEqual([]);
      const both = await send(
        port,
        "POST",
        "/v1/messages",
        { ...json, "x-api-key": ownerToolKey, cookie: owner.cookie },
        messagesRequest,
      );
      expect(both.status).toBe(200);
      expect(upstream.received).toHaveLength(1);
      expect(upstream.received[0]?.headers.cookie).toBeUndefined();
      expect(JSON.stringify(upstream.received[0]?.headers)).not.toContain(
        owner.cookie.split("=")[1] ?? "never",
      );
    });

    it("holds: another site's page cannot call /v1 from a browser: the preflight is refused and allows no origin", async () => {
      const preflight = await send(port, "OPTIONS", "/v1/messages", {
        origin: "https://elsewhere.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-api-key,content-type",
      });
      expect(preflight.status).toBe(404);
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
      expect(preflight.headers["access-control-allow-headers"]).toBeUndefined();
    });
  });

  describe("I2-1: app-wide security headers on /v1", () => {
    // Fixed by the merge of the pen-testing lanes: lane f's 175484e passes
    // the app's security headers to gatewayEntry, which sets them on every
    // /v1 answer. The app's own hooks still never run for /v1.
    it("regression (I2-1): an app-wide onRequest hook sets a header on the app's answers and still never runs for /v1, but /v1 answers now carry the security headers", async () => {
      const appAnswer = await send(port, "GET", "/api/session", {
        cookie: owner.cookie,
      });
      expect(appAnswer.headers["x-i2-app-hook"]).toBe("ran");
      for (const path of ["/v1/messages", "/v1/nowhere"]) {
        const answer = await send(
          port,
          "POST",
          path,
          { ...json, "x-api-key": ownerToolKey },
          messagesRequest,
        );
        expect(answer.headers["x-i2-app-hook"]).toBeUndefined();
        for (const name of [
          "x-content-type-options",
          "referrer-policy",
          "x-frame-options",
          "content-security-policy",
        ]) {
          expect(answer.headers[name], `${path}: ${name}`).toBeDefined();
        }
        // PUBLIC_URL is plain http here, so no HSTS, as on the app's side.
        expect(answer.headers["strict-transport-security"]).toBeUndefined();
      }
      expect(appHookSaw).toEqual(["/api/session"]);
    });

    it("I2-1: an answer on /v1 at the app's port carries the app-wide security headers (nosniff and Referrer-Policy at least)", async () => {
      const answer = await send(
        port,
        "POST",
        "/v1/messages",
        { ...json, "x-api-key": ownerToolKey },
        messagesRequest,
      );
      expect(answer.headers["x-content-type-options"]).toBe("nosniff");
      expect(answer.headers["referrer-policy"]).toBeDefined();
    });
  });

  describe("I2-2: the body limit on /v1", () => {
    const twoMiB = Buffer.alloc(2 * 1024 * 1024, "a");

    // Fixed: the Gateway checks the key in an onRequest hook, before the
    // body is read, so a keyless request is refused at once.
    it("regression (I2-2): the app refuses a 2 MiB body with 413, and /v1 refuses the same body without a Gateway Key, 401, without reading it first", async () => {
      const app = await send(
        port,
        "POST",
        "/api/login",
        { ...json, "content-length": twoMiB.length },
        twoMiB,
      );
      expect(app.status).toBe(413);
      const v1 = await send(
        port,
        "POST",
        "/v1/messages",
        { ...json, "content-length": twoMiB.length },
        twoMiB,
      );
      expect(v1.status).toBe(401);
      expect(upstream.received).toEqual([]);
      // Refused before the body: the refusal still carries the headers.
      expect(v1.headers["x-content-type-options"]).toBe("nosniff");
      expect(await answeredBeforeBody(port)).toBe(true);
    });

    it("regression (I2-2): /v1 no longer waits for the whole of an unauthenticated body: a key not in use is refused before it too", async () => {
      expect(
        await answeredBeforeBody(port, "/v1/messages", {
          "x-api-key": `aio_gk_${randomBytes(32).toString("base64url")}`,
        }),
      ).toBe(true);
    });

    it("I2-2: an unauthenticated /v1 request is refused before its body is read", async () => {
      expect(await answeredBeforeBody(port)).toBe(true);
    });

    // Siblings: every Gateway route that reads a body, and a path none
    // serves, on the app's port and on the Gateway's own (the sandboxes').
    it("holds since I2-2: each /v1 endpoint, and a /v1 path no route serves, answers an unauthenticated request before its body", async () => {
      for (const path of [
        "/v1/messages/count_tokens",
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/responses/compact",
        "/v1/systemone",
        "/v1/nowhere",
      ]) {
        expect(await answeredBeforeBody(port, path), path).toBe(true);
      }
    });

    it("holds since I2-2: on the Gateway's own port too, a keyless request is refused before its body", async () => {
      await onItsOwnPort(gateway, async (own) => {
        expect(await answeredBeforeBody(own)).toBe(true);
        expect(await answeredBeforeBody(own, "/v1/nowhere")).toBe(true);
      });
    });

    it("holds: with a Gateway Key in use, /v1 still reads the whole body and serves it", async () => {
      expect(
        await answeredBeforeBody(port, "/v1/messages", {
          "x-api-key": ownerToolKey,
        }),
      ).toBe(false);
    });
  });

  describe("I2-3: guessing a Gateway Key at /v1", () => {
    const guesses = Array.from(
      { length: 20 },
      () => `aio_gk_${randomBytes(32).toString("base64url")}`,
    );
    const guess = (key: string, path = "/v1/messages") =>
      send(port, "POST", path, { ...json, "x-api-key": key }, messagesRequest);
    const feedOf = (type: string) =>
      probed.feed.filter(({ event }) => event.type === type);

    // Each test starts this client afresh: a day on, its failures are
    // forgotten, as a sign-in's are.
    beforeEach(() => {
      probed.wait(25 * 60 * 60_000);
    });

    it("holds: a Gateway Key is the prefix and 32 random bytes, so guessing one is not feasible however many guesses are allowed", () => {
      expect(guesses[0]).toMatch(/^aio_gk_[A-Za-z0-9_-]{43}$/);
    });

    // Fixed: keys presented at /v1 on the app's port are limited per
    // client, as sign-ins are, and each key not in use, and the lockout
    // it starts, is in the Activity Feed.
    it("regression (I2-3): /api/login/api-key limits and records guesses at a UI-capable key, and /v1 now limits twenty guesses at a key and records them too, logging them still without the client's address", async () => {
      const signIns: number[] = [];
      for (const key of guesses) {
        const answer = await send(
          port,
          "POST",
          "/api/login/api-key",
          json,
          JSON.stringify({ key }),
        );
        signIns.push(answer.status);
      }
      expect(signIns).toContain(429);
      expect(feedOf("sign_in.failed").length).toBeGreaterThan(0);
      const signInsRecorded = feedOf("sign_in.failed").length;
      const failedBefore = feedOf("gateway_key.failed").length;
      const lockedOutBefore = feedOf("gateway_key.locked_out").length;

      const v1: number[] = [];
      for (const key of guesses) {
        v1.push((await guess(key)).status);
      }
      // Five keys not in use, then the client is locked out: as for
      // sign-ins, and apart from them.
      expect(v1).toEqual([
        ...guesses.slice(0, 5).map(() => 401),
        ...guesses.slice(5).map(() => 429),
      ]);
      await expect
        .poll(() => feedOf("gateway_key.failed").length)
        .toBe(failedBefore + 5);
      expect(
        feedOf("gateway_key.failed")
          .slice(failedBefore)
          .map(({ event }) => event),
      ).toContainEqual({
        type: "gateway_key.failed",
        version: 1,
        ip: "127.0.0.1",
        userAgent: null,
      });
      expect(
        feedOf("gateway_key.locked_out")
          .slice(lockedOutBefore)
          .map(({ event }) => event),
      ).toEqual([
        {
          type: "gateway_key.locked_out",
          version: 1,
          ip: "127.0.0.1",
          lockoutSeconds: 60,
        },
      ]);
      // Not sign-ins: those are recorded as they were.
      expect(feedOf("sign_in.failed").length).toBe(signInsRecorded);
      expect(requestLog.records).toEqual([]);
      const refusals = gatewayLines.filter((line) =>
        line.includes("A request without a Gateway Key in use was refused."),
      );
      expect(refusals).toHaveLength(5);
      for (const line of [...refusals, ...probed.lines, ...gatewayLines]) {
        for (const key of guesses) {
          expect(line).not.toContain(key);
        }
      }
      for (const line of refusals) {
        expect(line).not.toContain("127.0.0.1");
      }
    });

    it("I2-3: guesses at a Gateway Key on the app's port are limited, as /api/login/api-key's are", async () => {
      const statuses: number[] = [];
      for (const key of guesses) {
        const answer = await send(
          port,
          "POST",
          "/v1/messages",
          { ...json, "x-api-key": key },
          messagesRequest,
        );
        statuses.push(answer.status);
      }
      expect(statuses).toContain(429);
    });

    it("holds since I2-3: a locked-out client is refused unchecked, its right key too, with Retry-After, on every endpoint that takes a key, in its callers' format", async () => {
      for (const key of guesses.slice(0, 5)) {
        expect((await guess(key)).status).toBe(401);
      }
      const right = await guess(ownerToolKey);
      expect(right.status).toBe(429);
      expect(Number(right.headers["retry-after"])).toBe(60);
      expect(right.headers["x-content-type-options"]).toBe("nosniff");
      expect(JSON.parse(right.body)).toMatchObject({
        type: "error",
        error: { type: "rate_limit_error" },
      });
      const chat = await guess(ownerToolKey, "/v1/chat/completions");
      expect(chat.status).toBe(429);
      expect(JSON.parse(chat.body)).toMatchObject({
        error: { message: expect.stringContaining("Gateway Keys") as string },
      });
      for (const path of [
        "/v1/messages/count_tokens",
        "/v1/responses",
        "/v1/responses/compact",
        "/v1/systemone",
      ]) {
        expect((await guess(ownerToolKey, path)).status, path).toBe(429);
      }
      expect(upstream.received).toEqual([]);
      // Once the lockout has run out, the right key is served.
      probed.wait(61_000);
      expect((await guess(ownerToolKey)).status).toBe(200);
    });

    it("holds since I2-3: a key in use forgets the client's earlier keys not in use, and a request with no key counts none", async () => {
      for (const key of guesses.slice(0, 4)) {
        expect((await guess(key)).status).toBe(401);
      }
      expect((await guess(ownerToolKey)).status).toBe(200);
      for (let request = 0; request < 10; request += 1) {
        const keyless = await send(
          port,
          "POST",
          "/v1/messages",
          json,
          messagesRequest,
        );
        expect(keyless.status).toBe(401);
      }
      for (const key of guesses.slice(4, 8)) {
        expect((await guess(key)).status).toBe(401);
      }
      expect((await guess(ownerToolKey)).status).toBe(200);
    });

    // Decision (issue #327): the sandboxes reach the Gateway's own port
    // only through the sandbox relay, so all of them are one client there;
    // a limit would let one sandbox lock every Agent out of its models.
    it("holds since I2-3: the Gateway's own port, the sandboxes' through the sandbox relay, is not limited by client", async () => {
      const failedBefore = feedOf("gateway_key.failed").length;
      await onItsOwnPort(gateway, async (own) => {
        const statuses: number[] = [];
        for (const key of guesses) {
          const answer = await send(
            own,
            "POST",
            "/v1/messages",
            { ...json, "x-api-key": key },
            messagesRequest,
          );
          statuses.push(answer.status);
        }
        expect(statuses).toEqual(guesses.map(() => 401));
      });
      expect(feedOf("gateway_key.failed")).toHaveLength(failedBefore);
    });
  });

  describe("logging and redaction on /v1", () => {
    it("holds: a presented Gateway Key, right or wrong, appears in no log line, the app's or the Gateway's", async () => {
      const wrong = `aio_gk_${randomBytes(32).toString("base64url")}`;
      await send(
        port,
        "POST",
        "/v1/messages",
        { ...json, "x-api-key": wrong },
        messagesRequest,
      );
      await send(
        port,
        "POST",
        "/v1/messages",
        { ...json, authorization: `Bearer ${ownerToolKey}` },
        messagesRequest,
      );
      await expect.poll(() => requestLog.records.length).toBe(1);
      const lines = [...probed.lines, ...gatewayLines].join("\n");
      expect(gatewayLines.length).toBeGreaterThan(0);
      expect(lines).not.toContain(wrong);
      expect(lines).not.toContain(ownerToolKey);
    });
  });
});

/**
 * Sends the head of a 2 MiB request to `path` (`/v1/messages` by default),
 * with `headers` (none, so no Gateway Key, by default), and 1 KiB of its
 * body, then holds the rest back: whether an answer arrives within a
 * second.
 */
function answeredBeforeBody(
  port: number,
  path = "/v1/messages",
  headers: Record<string, string> = {},
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { ...json, ...headers, "content-length": 2 * 1024 * 1024 },
        agent: false,
      },
      (response) => {
        response.resume();
        clearTimeout(timer);
        outgoing.destroy();
        resolve(true);
      },
    );
    const timer = setTimeout(() => {
      outgoing.destroy();
      resolve(false);
    }, 1000);
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      // Destroyed here, once the answer is known.
      if (error.code !== "ECONNRESET") {
        reject(error);
      }
    });
    outgoing.write(Buffer.alloc(1024, "a"));
  });
}
