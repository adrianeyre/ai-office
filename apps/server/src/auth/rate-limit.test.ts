import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp, type AppOptions } from "../app.ts";
import { createLogger } from "../logger.ts";
import { testAuth, testPassword } from "../test-support.ts";
import { proxyHeader } from "./proxy.ts";

const start = new Date("2026-10-08T12:00:00.000Z");
const userAgent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0";

async function app(options: Partial<AppOptions> = {}) {
  const clock = { now: start };
  const lines: string[] = [];
  const auth = await testAuth({ now: () => clock.now });
  const server = await buildApp({
    logger: createLogger({
      level: "info",
      secrets: [],
      destination: { write: (line) => lines.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth,
    ...options,
  });
  const at = (ms: number) => {
    clock.now = new Date(start.getTime() + ms);
  };
  return { server, store: auth.store, at, lines };
}

const login = (
  server: FastifyInstance,
  password: string,
  from: { remoteAddress?: string; headers?: Record<string, string> } = {},
) =>
  server.inject({
    method: "POST",
    url: "/api/login",
    payload: { password },
    remoteAddress: from.remoteAddress ?? "203.0.113.7",
    headers: { "user-agent": userAgent, ...from.headers },
  });

const wrong = `${testPassword}-wrong`;

describe("rate-limiting sign-ins", () => {
  it("refuses the sixth rapid failed attempt with 429 and a retry-after", async () => {
    const { server } = await app();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await login(server, wrong)).statusCode).toBe(401);
    }
    const sixth = await login(server, wrong);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers["retry-after"]).toBe("60");
    expect(sixth.json()).toEqual({
      error: "too_many_attempts",
      message: "Too many failed sign-ins. Try again in 60 seconds.",
    });
  });

  it("refuses even the right password while locked out", async () => {
    const { server } = await app();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await login(server, wrong);
    }
    const response = await login(server, testPassword);
    expect(response.statusCode).toBe(429);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("limits each client address on its own", async () => {
    const { server } = await app();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await login(server, wrong);
    }
    expect((await login(server, wrong)).statusCode).toBe(429);
    const elsewhere = await login(server, testPassword, {
      remoteAddress: "198.51.100.20",
    });
    expect(elsewhere.statusCode).toBe(200);
  });

  it("locks out for longer after each failure that follows a lockout", async () => {
    const { server, at } = await app();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await login(server, wrong);
    }
    at(59_000);
    expect((await login(server, wrong)).headers["retry-after"]).toBe("1");
    at(60_000);
    expect((await login(server, wrong)).statusCode).toBe(401);
    expect((await login(server, wrong)).headers["retry-after"]).toBe("120");
    at(180_000);
    expect((await login(server, wrong)).statusCode).toBe(401);
    expect((await login(server, wrong)).headers["retry-after"]).toBe("240");
  });

  it("starts afresh after a successful sign-in", async () => {
    const { server } = await app();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await login(server, wrong);
    }
    expect((await login(server, testPassword)).statusCode).toBe(200);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await login(server, wrong)).statusCode).toBe(401);
    }
    expect((await login(server, wrong)).statusCode).toBe(429);
  });

  it("lets no more than five guesses through when they arrive at once", async () => {
    const { server, store } = await app();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => login(server, wrong)),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
    expect(store.state.signInEvents).toHaveLength(5);
  });

  it("logs when a client is locked out", async () => {
    const { server, lines } = await app();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await login(server, wrong);
    }
    const lockouts = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ msg }) =>
        String(msg).startsWith("Sign-ins from this client are locked out"),
      );
    expect(lockouts).toEqual([
      expect.objectContaining({ client: "203.0.113.7", lockoutSeconds: 60 }),
    ]);
    expect(lines.join("")).not.toContain(wrong);
  });
});

describe("sign_in_events", () => {
  it("records each failed and successful sign-in with time, IP and user agent", async () => {
    const { server, store, at } = await app();
    await login(server, wrong);
    at(1_000);
    await login(server, testPassword, {
      remoteAddress: "198.51.100.20",
      headers: { "user-agent": "curl/8.17.0" },
    });
    expect(store.state.signInEvents).toEqual([
      {
        occurredAt: start,
        outcome: "failed",
        ip: "203.0.113.7",
        userAgent,
      },
      {
        occurredAt: new Date(start.getTime() + 1_000),
        outcome: "succeeded",
        ip: "198.51.100.20",
        userAgent: "curl/8.17.0",
      },
    ]);
  });

  it("does not record attempts the rate limit refused, nor malformed ones", async () => {
    const { server, store } = await app();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await login(server, wrong);
    }
    await server.inject({ method: "POST", url: "/api/login", payload: {} });
    expect(store.state.signInEvents).toHaveLength(5);
  });

  it("records no user agent for an empty one, and cuts a long one", async () => {
    const { server, store } = await app();
    await login(server, wrong, { headers: { "user-agent": "" } });
    await login(server, wrong, { headers: { "user-agent": "x".repeat(2000) } });
    expect(store.state.signInEvents.map((event) => event.userAgent)).toEqual([
      null,
      "x".repeat(512),
    ]);
  });
});

describe("the client's address behind a proxy", () => {
  const proxySecret = "test-proxy-secret-00000000000000000000";
  const viaProxy = (client: string) => ({
    remoteAddress: "10.0.0.2",
    headers: { "x-forwarded-for": client, [proxyHeader]: proxySecret },
  });

  it("is the proxy's address unless TRUST_PROXY is set, so it cannot be forged", async () => {
    const { server, store } = await app();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // Each guess claims a different address; none is believed.
      await login(server, wrong, viaProxy(`192.0.2.${String(attempt)}`));
    }
    expect(
      (await login(server, wrong, viaProxy("192.0.2.99"))).statusCode,
    ).toBe(429);
    expect(new Set(store.state.signInEvents.map(({ ip }) => ip))).toEqual(
      new Set(["10.0.0.2"]),
    );
  });

  it.each([
    ["the proxy's address", ["10.0.0.0/8"]],
    ["a hop count", 1],
  ] as const)(
    "comes from X-Forwarded-For when TRUST_PROXY names %s and the proxy sends PROXY_SECRET",
    async (_, trustProxy) => {
      const { server, store } = await app({ trustProxy, proxySecret });
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await login(server, wrong, viaProxy("192.0.2.1"));
      }
      expect(
        (await login(server, wrong, viaProxy("192.0.2.1"))).statusCode,
      ).toBe(429);
      expect(
        (await login(server, testPassword, viaProxy("192.0.2.2"))).statusCode,
      ).toBe(200);
      expect(store.state.signInEvents.at(-1)?.ip).toBe("192.0.2.2");
    },
  );
});
