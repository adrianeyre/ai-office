import {
  createdGatewayKeySchema,
  sessionIdleMs,
  sessionLifetimeMs,
  sessionResponseSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { cookieFrom, probedApp, type ProbedApp } from "../pen-test-support.ts";
import { signIn, testPassword, type SignedIn } from "../test-support.ts";
import { sessionCookie } from "./sessions.ts";

// A1 probe (pen-testing, "Sign-in and sessions"): the session itself (H7,
// FR-2) and CSRF on every state-changing route. Position 4: a stolen
// session cookie or UI-capable API key; position 1 for fixation and CSRF
// (a page the Owner's browser visits).

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const session = (server: FastifyInstance, cookie: string) =>
  server.inject({ url: "/api/session", headers: { cookie } });

/** Signs in with a new UI-capable API key made by `owner`. */
async function keySession(
  server: FastifyInstance,
  owner: SignedIn,
): Promise<SignedIn> {
  const made = await server.inject({
    method: "POST",
    url: "/api/gateway-keys",
    headers: owner.headers,
    // A key that signs in needs the Owner's password to make (A1-3).
    payload: {
      name: "Pen test UI key",
      access: "proxy_and_ui",
      currentPassword: testPassword,
    },
  });
  const { key } = createdGatewayKeySchema.parse(made.json());
  const response = await server.inject({
    method: "POST",
    url: "/api/login/api-key",
    payload: { key },
  });
  expect(response.statusCode).toBe(200);
  const cookie = cookieFrom(response.headers["set-cookie"], sessionCookie);
  const { csrfToken, expiresAt } = sessionResponseSchema.parse(response.json());
  return {
    cookie: cookie ?? "",
    csrfToken,
    expiresAt,
    headers: { cookie: cookie ?? "", "x-csrf-token": csrfToken },
  };
}

describe("the session cookie", () => {
  it("is HttpOnly, SameSite=Strict, for the whole site, and lives 7 days", async () => {
    const { server } = await probedApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
    });
    const attributes = String(response.headers["set-cookie"])
      .split(";")
      .slice(1)
      .map((attribute) => attribute.trim());
    expect(attributes).toEqual([
      "Path=/",
      `Max-Age=${String(sessionLifetimeMs / 1000)}`,
      "HttpOnly",
      "SameSite=Strict",
    ]);
  });

  it("is Secure when PUBLIC_URL is https", async () => {
    const { server } = await probedApp({ secureCookie: true });
    const response = await server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
    });
    expect(String(response.headers["set-cookie"])).toMatch(/; Secure$/);
  });

  it("holds a fresh 256-bit token, and only its SHA-256 is stored", async () => {
    const { server, store } = await probedApp();
    const owner = await signIn(server);
    const token = owner.cookie.split("=")[1] ?? "";
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect([...store.state.sessions.keys()]).not.toContain(token);
    expect(JSON.stringify([...store.state.sessions.values()])).not.toContain(
      token,
    );
  });
});

describe("session lifetime", () => {
  it("ends 7 days after sign-in, however much it is used", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    for (let day = 1; day <= 6; day += 1) {
      probed.wait(24 * 60 * 60_000);
      expect((await session(probed.server, owner.cookie)).statusCode).toBe(200);
    }
    probed.wait(24 * 60 * 60_000);
    expect((await session(probed.server, owner.cookie)).statusCode).toBe(401);
  });

  it("A1-8: a session left unused for most of a week is refused (an idle timeout)", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    probed.wait(sessionLifetimeMs - 60 * 60_000);
    expect((await session(probed.server, owner.cookie)).statusCode).toBe(401);
  });

  it("A1-8 regression: a cookie unused for 6 days 23 hours no longer works, and the session is gone", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    probed.wait(sessionLifetimeMs - 60 * 60_000);
    const response = await session(probed.server, owner.cookie);
    expect(response.statusCode).not.toBe(200);
    expect(response.statusCode).toBe(401);
    expect(probed.store.state.sessions.size).toBe(0);
  });
});

describe("A1-8 · the idle timeout on every path", () => {
  const hour = 60 * 60_000;

  it("is 24 hours: refused just after, kept just before", async () => {
    const probed = await probedApp();
    const kept = await signIn(probed.server);
    probed.wait(sessionIdleMs - 60_000);
    expect((await session(probed.server, kept.cookie)).statusCode).toBe(200);
    const idle = await signIn(probed.server);
    probed.wait(sessionIdleMs + 1);
    expect((await session(probed.server, idle.cookie)).statusCode).toBe(401);
  });

  it("use keeps it alive, noted at most once a minute, but never past 7 days", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    const id = [...probed.store.state.sessions.keys()][0] ?? "";
    // Seven uses 23 hours apart: 161 hours, each within a day of the last.
    for (let use = 1; use <= 7; use += 1) {
      probed.wait(23 * hour);
      expect((await session(probed.server, owner.cookie)).statusCode).toBe(200);
    }
    const seen = probed.store.state.sessions.get(id)?.lastSeenAt;
    expect(seen).toEqual(probed.clock.now);
    probed.wait(30_000);
    await session(probed.server, owner.cookie);
    expect(probed.store.state.sessions.get(id)?.lastSeenAt).toEqual(seen);
    // At 168 hours the 7 days are up, however recently it was used.
    probed.wait(7 * hour - 30_000);
    expect((await session(probed.server, owner.cookie)).statusCode).toBe(401);
  });

  it("a session begun with an API key idles out too", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    const viaKey = await keySession(probed.server, owner);
    probed.wait(sessionIdleMs + 1);
    expect((await session(probed.server, viaKey.cookie)).statusCode).toBe(401);
  });

  it("an idle session's pages send it to sign in, and its live streams are refused", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    probed.wait(sessionIdleMs + 1);
    const page = await probed.server.inject({
      url: "/",
      headers: { cookie: owner.cookie },
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/login");
    const stream = await probed.server.inject({
      url: "/api/events/stream",
      headers: { cookie: owner.cookie },
    });
    expect(stream.statusCode).toBe(401);
  });

  it("the time it was last used outlives a restart", async () => {
    const first = await probedApp();
    const owner = await signIn(first.server);
    await first.server.close();
    first.wait(sessionIdleMs + 1);
    const { server } = await probedApp({
      store: first.store,
      clock: first.clock,
    });
    expect((await session(server, owner.cookie)).statusCode).toBe(401);
  });
});

describe("session fixation", () => {
  it("a cookie the attacker chose before sign-in is never adopted", async () => {
    const { server } = await probedApp();
    const planted = `${sessionCookie}=${"A".repeat(43)}`;
    const response = await server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
      headers: { cookie: planted },
    });
    expect(response.statusCode).toBe(200);
    const issued = cookieFrom(response.headers["set-cookie"], sessionCookie);
    expect(issued).toBeDefined();
    expect(issued).not.toBe(planted);
    expect((await session(server, planted)).statusCode).toBe(401);
  });

  it("signing in again over a live session issues a new token", async () => {
    const { server } = await probedApp();
    const first = await signIn(server);
    const response = await server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
      headers: { cookie: first.cookie },
    });
    expect(cookieFrom(response.headers["set-cookie"], sessionCookie)).not.toBe(
      first.cookie,
    );
  });
});

describe("sign out everywhere", () => {
  it("ends password and API-key sessions alike", async () => {
    const { server, store } = await probedApp();
    const owner = await signIn(server);
    const viaKey = await keySession(server, owner);
    const other = await signIn(server);
    expect(store.state.sessions.size).toBe(3);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/logout/everywhere",
          headers: viaKey.headers,
        })
      ).statusCode,
    ).toBe(200);
    for (const cookie of [owner.cookie, viaKey.cookie, other.cookie]) {
      expect((await session(server, cookie)).statusCode).toBe(401);
    }
    expect(store.state.sessions.size).toBe(0);
  });

  /** Reads `url` until the server ends it; false if it is still open. */
  async function endsWithin(
    baseUrl: string,
    url: string,
    cookie: string,
    then: () => Promise<unknown>,
  ): Promise<{ status: number; ended: boolean }> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}${url}`, {
      headers: { cookie },
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await then();
    const timeout = new Promise<"open">((resolve) =>
      setTimeout(resolve, 2000, "open"),
    );
    const read = async (): Promise<"ended"> => {
      for (;;) {
        if ((await reader.read()).done) {
          return "ended";
        }
      }
    };
    const outcome = await Promise.race([read(), timeout]);
    controller.abort();
    return { status: response.status, ended: outcome === "ended" };
  }

  it.each([
    "/api/events/stream",
    "/api/terminal/stream",
    "/api/gateway/requests/stream",
    "/api/gateway/logs/stream",
  ])(
    "closes %s held open by an API-key session at its next heartbeat",
    async (url) => {
      const probed: ProbedApp = await probedApp({ heartbeatMs: 20 });
      servers.push(probed.server);
      const owner = await signIn(probed.server);
      const viaKey = await keySession(probed.server, owner);
      const baseUrl = await probed.server.listen({
        port: 0,
        host: "127.0.0.1",
      });
      const result = await endsWithin(baseUrl, url, viaKey.cookie, () =>
        probed.server.inject({
          method: "POST",
          url: "/api/logout/everywhere",
          headers: owner.headers,
        }),
      );
      expect(result).toEqual({ status: 200, ended: true });
    },
  );
});

describe("CSRF on every state-changing route", () => {
  const unsafe = (server: FastifyInstance) =>
    server
      .routeAccess()
      .filter(
        ({ method, access }) =>
          !["GET", "HEAD", "OPTIONS"].includes(method) &&
          (access ?? "owner") === "owner",
      );

  it("every one refuses a signed-in request without the session's x-csrf-token", async () => {
    const { server } = await probedApp();
    await server.ready();
    const owner = await signIn(server);
    const routes = unsafe(server);
    expect(routes.length).toBeGreaterThan(100);
    const answered = await Promise.all(
      routes.map(async ({ method, url }) => {
        const response = await server.inject({
          method: method as "POST",
          url: url.replaceAll(/:\w+/g, "1"),
          headers: { cookie: owner.cookie },
          payload: {},
        });
        return { route: `${method} ${url}`, status: response.statusCode };
      }),
    );
    expect(answered.filter(({ status }) => status !== 403)).toEqual([]);
  });

  it("every one refuses a request from another site, even with the token", async () => {
    const { server } = await probedApp();
    await server.ready();
    const owner = await signIn(server);
    const answered = await Promise.all(
      unsafe(server).map(async ({ method, url }) => {
        const response = await server.inject({
          method: method as "POST",
          url: url.replaceAll(/:\w+/g, "1"),
          headers: {
            ...owner.headers,
            host: "localhost:3045",
            origin: "https://attacker.example",
          },
          payload: {},
        });
        return {
          route: `${method} ${url}`,
          status: response.statusCode,
          error: response.json<{ error?: string }>().error,
        };
      }),
    );
    expect(
      answered.filter(
        ({ status, error }) => status !== 403 || error !== "csrf_refused",
      ),
    ).toEqual([]);
  });

  it("a token from one session does not work for another", async () => {
    const { server } = await probedApp();
    const first = await signIn(server);
    const second = await signIn(server);
    const response = await server.inject({
      method: "POST",
      url: "/api/logout/everywhere",
      headers: { cookie: second.cookie, "x-csrf-token": first.csrfToken },
    });
    expect(response.statusCode).toBe(403);
  });

  it("the sign-in routes refuse another site too (login CSRF)", async () => {
    const { server } = await probedApp();
    for (const url of ["/api/login", "/api/login/api-key", "/api/login/totp"]) {
      const response = await server.inject({
        method: "POST",
        url,
        headers: { "sec-fetch-site": "cross-site" },
        payload: { password: testPassword, key: "aio_gk_x", code: "123456" },
      });
      expect({ url, status: response.statusCode }).toEqual({
        url,
        status: 403,
      });
    }
  });

  it("the Manager chat's attachment upload needs the token, and takes no form or text body", async () => {
    const { server } = await probedApp();
    const owner = await signIn(server);
    const url = "/api/floors/1/manager-chat/attachments";
    const upload = {
      name: "notes.txt",
      mediaType: "text/plain",
      data: Buffer.from("hello").toString("base64"),
    };
    const noToken = await server.inject({
      method: "POST",
      url,
      headers: { cookie: owner.cookie },
      payload: upload,
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json()).toMatchObject({ error: "csrf_refused" });
    // What a cross-site form could send, even if its cookie went with it.
    const form = await server.inject({
      method: "POST",
      url,
      headers: {
        ...owner.headers,
        "content-type": "multipart/form-data; boundary=x",
      },
      payload: "--x--",
    });
    expect(form.statusCode).toBe(415);
    const text = await server.inject({
      method: "POST",
      url,
      headers: { ...owner.headers, "content-type": "text/plain" },
      payload: JSON.stringify(upload),
    });
    expect(text.statusCode).toBe(400);
  });

  it("no route answers a CORS preflight or sends Access-Control-Allow-Origin", async () => {
    const { server } = await probedApp();
    const owner = await signIn(server);
    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/api/session",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const read = await server.inject({
      url: "/api/session",
      headers: { cookie: owner.cookie, origin: "https://attacker.example" },
    });
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
