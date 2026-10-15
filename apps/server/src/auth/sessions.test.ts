import { createHash } from "node:crypto";

import { sessionIdleMs, sessionLifetimeMs } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, testPassword, webBuild } from "../test-support.ts";
import type { SessionOptions } from "./sessions.ts";

const start = new Date("2026-10-08T12:00:00.000Z");

/** A set-up app on a clock the test moves, logging into `lines`. */
async function app(
  options: { secureCookie?: boolean; setUp?: boolean } = {},
): Promise<{
  server: FastifyInstance;
  auth: Awaited<ReturnType<typeof testAuth>>;
  clock: { now: Date };
  lines: string[];
}> {
  const clock = { now: start };
  const lines: string[] = [];
  const auth = await testAuth({ ...options, now: () => clock.now });
  const server = await buildApp({
    logger: createLogger({
      level: "debug",
      secrets: [],
      destination: { write: (line) => lines.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: auth satisfies SessionOptions,
  });
  return { server, auth, clock, lines };
}

const login = (server: FastifyInstance, password: string, headers = {}) =>
  server.inject({
    method: "POST",
    url: "/api/login",
    payload: { password },
    headers,
  });

describe("POST /api/login", () => {
  it("refuses a wrong password, and starts no session", async () => {
    const { server, auth } = await app();
    const response = await login(server, `${testPassword}x`);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "wrong_password",
      message: "That password is not right.",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(auth.store.state.sessions.size).toBe(0);
  });

  it("refuses a malformed body", async () => {
    const { server } = await app();
    const response = await server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answers setup_required before setup", async () => {
    const { server } = await app({ setUp: false });
    const response = await login(server, testPassword);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "setup_required" });
  });

  it("starts a 7-day session in an HttpOnly, SameSite=Strict cookie", async () => {
    const { server, auth } = await app();
    const response = await login(server, testPassword);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      csrfToken: expect.stringMatching(/^[\w-]{43}$/) as unknown,
      expiresAt: "2026-10-15T12:00:00.000Z",
      gatewayKeyId: null,
      passwordId: null,
      // As the tests allow them (ADR 0007).
      allowedInternalHosts: ["127.0.0.1", "localhost"],
    });

    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toMatch(
      /^ai_office_session=[\w-]{43}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Strict$/,
    );
    // Only the token's SHA-256 is stored.
    const token = (setCookie.split(";", 1)[0] ?? "").split("=")[1] ?? "";
    expect([...auth.store.state.sessions.keys()]).toEqual([
      createHash("sha256").update(token).digest("hex"),
    ]);
  });

  it("marks the cookie Secure when PUBLIC_URL is https", async () => {
    const { server } = await app({ secureCookie: true });
    const response = await login(server, testPassword);
    expect(String(response.headers["set-cookie"])).toMatch(
      /; HttpOnly; SameSite=Strict; Secure$/,
    );
  });

  it("refuses a sign-in from another site", async () => {
    const { server } = await app();
    for (const headers of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
    ]) {
      const response = await login(server, testPassword, headers);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "csrf_refused" });
    }
    // The browser's own same-origin request is fine.
    const sameOrigin = await login(server, testPassword, {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "sec-fetch-site": "same-origin",
    });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it("never logs the password or the session token", async () => {
    const { server, lines } = await app();
    await login(server, `${testPassword}x`);
    const response = await login(server, testPassword);
    const token = String(response.headers["set-cookie"])
      .split(";", 1)[0]
      ?.split("=")[1];
    const log = lines.join("");
    expect(log).toContain("A sign-in failed: wrong password.");
    expect(log).toContain("The Owner signed in.");
    expect(log).not.toContain(testPassword);
    expect(log).not.toContain(token);
  });
});

describe("a session", () => {
  it("is required: unauthenticated API calls get 401", async () => {
    const { server } = await app();
    for (const [method, url] of [
      ["GET", "/api/session"],
      ["POST", "/api/logout"],
      ["POST", "/api/logout/everywhere"],
      ["GET", "/api/no-such-route"],
    ] as const) {
      const response = await server.inject({ method, url });
      expect({
        route: `${method} ${url}`,
        status: response.statusCode,
      }).toEqual({ route: `${method} ${url}`, status: 401 });
      expect(response.json()).toEqual({
        error: "unauthorized",
        message: "Sign in at /login.",
      });
    }
  });

  it("is rejected when its cookie names no session, and the cookie cleared", async () => {
    const { server } = await app();
    const response = await server.inject({
      url: "/api/session",
      headers: { cookie: "ai_office_session=forged-token-value" },
    });
    expect(response.statusCode).toBe(401);
    expect(String(response.headers["set-cookie"])).toMatch(
      /^ai_office_session=; Path=\/; Max-Age=0;/,
    );
  });

  it("describes itself at GET /api/session", async () => {
    const { server } = await app();
    const owner = await signIn(server);
    const response = await server.inject({
      url: "/api/session",
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      csrfToken: owner.csrfToken,
      expiresAt: owner.expiresAt,
      gatewayKeyId: null,
      passwordId: null,
      allowedInternalHosts: ["127.0.0.1", "localhost"],
    });
  });

  it("expires 7 days after sign-in, and is then rejected", async () => {
    const { server, auth, clock } = await app();
    const { cookie } = await signIn(server);
    const session = () =>
      server.inject({ url: "/api/session", headers: { cookie } });

    // Used every day, so it never goes a day unused (A1-8)...
    for (let day = 1; day <= 6; day += 1) {
      clock.now = new Date(start.getTime() + day * sessionIdleMs);
      expect((await session()).statusCode).toBe(200);
    }
    // ...it lasts until the 7 days are up.
    clock.now = new Date(start.getTime() + sessionLifetimeMs - 1);
    expect((await session()).statusCode).toBe(200);

    clock.now = new Date(start.getTime() + sessionLifetimeMs);
    const expired = await session();
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: "unauthorized" });
    expect(auth.store.state.sessions.size).toBe(0);
    // Signing in again starts a new 7 days.
    const again = await signIn(server);
    expect(again.expiresAt).toBe("2026-10-22T12:00:00.000Z");
  });

  it("is not extended by use", async () => {
    const { server, clock } = await app();
    const { cookie } = await signIn(server);
    // Used twice a day, so it never goes a day unused (A1-8).
    for (let half = 1; half < 7; half += 1) {
      clock.now = new Date(start.getTime() + (half * sessionIdleMs) / 2);
      await server.inject({ url: "/api/session", headers: { cookie } });
    }
    clock.now = new Date(start.getTime() + sessionLifetimeMs / 2);
    const halfway = await server.inject({
      url: "/api/session",
      headers: { cookie },
    });
    expect(halfway.json()).toMatchObject({
      expiresAt: "2026-10-15T12:00:00.000Z",
    });
  });

  it("removes expired sessions when a new one starts", async () => {
    const { server, auth, clock } = await app();
    await signIn(server);
    await signIn(server);
    clock.now = new Date(start.getTime() + sessionLifetimeMs + 1);
    await signIn(server);
    expect(auth.store.state.sessions.size).toBe(1);
  });
});

describe("CSRF protection", () => {
  it("refuses a state change without the session's CSRF token", async () => {
    const { server } = await app();
    const owner = await signIn(server);
    const other = await signIn(server);
    for (const headers of [
      { cookie: owner.cookie },
      { cookie: owner.cookie, "x-csrf-token": "not-the-token" },
      // Another session's token does not do.
      { cookie: owner.cookie, "x-csrf-token": other.csrfToken },
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/logout",
        headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "csrf_refused",
        message: "The x-csrf-token header is missing or does not match.",
      });
    }
    // Still signed in.
    expect(
      (
        await server.inject({
          url: "/api/session",
          headers: { cookie: owner.cookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("refuses a state change from another site, even with the token", async () => {
    const { server } = await app();
    const owner = await signIn(server);
    const response = await server.inject({
      method: "POST",
      url: "/api/logout",
      headers: { ...owner.headers, origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "csrf_refused" });
  });

  it("needs no token to read", async () => {
    const { server } = await app();
    const { cookie } = await signIn(server);
    expect(
      (await server.inject({ url: "/api/session", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
  });
});

describe("signing out", () => {
  it("ends this session only, and clears its cookie", async () => {
    const { server } = await app();
    const here = await signIn(server);
    const elsewhere = await signIn(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/logout",
      headers: here.headers,
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["set-cookie"])).toMatch(
      /^ai_office_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict$/,
    );
    const session = (cookie: string) =>
      server.inject({ url: "/api/session", headers: { cookie } });
    expect((await session(here.cookie)).statusCode).toBe(401);
    expect((await session(elsewhere.cookie)).statusCode).toBe(200);
  });

  it("everywhere invalidates every session", async () => {
    const { server, auth } = await app();
    const middle = await signIn(server);
    const sessions = [await signIn(server), middle, await signIn(server)];
    expect(auth.store.state.sessions.size).toBe(3);

    const response = await server.inject({
      method: "POST",
      url: "/api/logout/everywhere",
      headers: middle.headers,
    });
    // It says what still signs in (A1-3): ending sessions removes none.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionsEnded: 3,
      stillSignIn: {
        passwords: [{ id: "first", name: "The first password, set at setup" }],
        apiKeys: [],
      },
    });
    for (const { cookie } of sessions) {
      const after = await server.inject({
        url: "/api/session",
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);
    }
    expect(auth.store.state.sessions.size).toBe(0);
  });
});

describe("pages", () => {
  it("redirect to /login without a session, and /login to / with one", async () => {
    const web = await webBuild();
    try {
      const auth = await testAuth();
      const server = await buildApp({
        logger: createLogger({ level: "silent", secrets: [] }),
        checkDatabase: () => Promise.resolve(true),
        webDistDir: web.dir,
        auth,
      });
      for (const url of ["/", "/notices", "/admin?tab=gateway"]) {
        const response = await server.inject({ url });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe("/login");
      }
      const loginPage = await server.inject({ url: "/login" });
      expect(loginPage.statusCode).toBe(200);
      expect(loginPage.body).toContain("AI Office");
      // The login page needs the built files, so they stay public.
      expect((await server.inject({ url: "/assets/app.js" })).statusCode).toBe(
        200,
      );

      const { cookie } = await signIn(server);
      expect(
        (await server.inject({ url: "/", headers: { cookie } })).statusCode,
      ).toBe(200);
      const signedInLogin = await server.inject({
        url: "/login",
        headers: { cookie },
      });
      expect(signedInLogin.statusCode).toBe(302);
      expect(signedInLogin.headers.location).toBe("/");
    } finally {
      await web.remove();
    }
  });

  it("serve Google's redirect back without a session: its cross-site redirect carries no cookie, and the API it calls needs one", async () => {
    const web = await webBuild();
    try {
      const auth = await testAuth();
      const server = await buildApp({
        logger: createLogger({ level: "silent", secrets: [] }),
        checkDatabase: () => Promise.resolve(true),
        webDistDir: web.dir,
        auth,
      });
      await signIn(server);
      const page = await server.inject({
        url: "/admin/connections/google?state=s&code=4%2F0abc",
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("AI Office");
      // Only that page: the Connections page still needs a session, and
      // so does finishing the sign-in.
      const connections = await server.inject({ url: "/admin/connections" });
      expect(connections.statusCode).toBe(302);
      const complete = await server.inject({
        method: "POST",
        url: "/api/google/sign-in/complete",
        payload: { code: "4/0abc", state: "s" },
      });
      expect(complete.statusCode).toBe(401);
    } finally {
      await web.remove();
    }
  });
});
