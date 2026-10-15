import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { cookieFrom, enableTotp, probedApp } from "../pen-test-support.ts";
import { signIn, testPassword } from "../test-support.ts";
import { proxyHeader } from "./proxy.ts";
import { signInChallengeCookie } from "./sign-in-challenges.ts";

// A1 probe (pen-testing, "Sign-in and sessions"): the login limiter and the
// client address it is keyed on (H3, H7), and repeated failures in the
// Activity Feed (FR-4). Driven through the real app with `inject`, whose
// `remoteAddress` stands for the TCP peer the app sees.
//
// Positions: 3 (a sandbox on `ai-office-sandboxes`, reaching app:3045
// directly; whether it can is #193) and 1 (any caller that reaches the
// app's own port rather than Caddy).

const wrong = `${testPassword}-wrong`;
const userAgent = "pen-test/1.0";

/** A sandbox's address on the compose `sandboxes` network (172.16.0.0/12). */
const sandbox = "172.18.0.5";

/** PROXY_SECRET, as the proxy in front of AI Office sends it (A1-1). */
const proxySecret = "pen-test-proxy-secret-000000000000000";

const login = (
  server: FastifyInstance,
  password: string,
  from: { remoteAddress: string; forwardedFor?: string; proof?: string },
) =>
  server.inject({
    method: "POST",
    url: "/api/login",
    payload: { password },
    remoteAddress: from.remoteAddress,
    headers: {
      "user-agent": userAgent,
      ...(from.forwardedFor === undefined
        ? {}
        : { "x-forwarded-for": from.forwardedFor }),
      ...(from.proof === undefined ? {} : { [proxyHeader]: from.proof }),
    },
  });

/** `count` wrong guesses from `remoteAddress`, each claiming a new address. */
async function rotatingGuesses(
  server: FastifyInstance,
  remoteAddress: string,
  count: number,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let guess = 1; guess <= count; guess += 1) {
    const response = await login(server, wrong, {
      remoteAddress,
      forwardedFor: `198.51.100.${String(guess)}`,
    });
    statuses.push(response.statusCode);
  }
  return statuses;
}

// TRUST_PROXY as the deployment docs prescribe it (`1`, EC2 guide §6) and
// as `.env.example` suggests it (the compose network's 172.16.0.0/12).
const trustSettings = [
  ["TRUST_PROXY=1", 1],
  ["TRUST_PROXY=172.16.0.0/12", ["172.16.0.0/12"]],
] as const;

describe("A1-1: the limiter's client address, from a caller that is not Caddy", () => {
  describe.each(trustSettings)("with %s", (_, trustProxy) => {
    it("a caller that is not the trusted proxy cannot choose the address it is limited by", async () => {
      const { server } = await probedApp({ trustProxy });
      const statuses = await rotatingGuesses(server, sandbox, 20);
      // Five free failures, then the limiter must refuse.
      expect(statuses.slice(5)).not.toContain(401);
      expect(statuses.slice(5).every((status) => status === 429)).toBe(true);
    });

    it("regression (A1-1): rotating X-Forwarded-For no longer gives every guess a fresh bucket", async () => {
      // As the documents configure it, PROXY_SECRET and all: the sandbox
      // does not hold the secret, so its X-Forwarded-For is not believed.
      const { server, store } = await probedApp({ trustProxy, proxySecret });
      const statuses = await rotatingGuesses(server, sandbox, 20);
      expect(statuses).toEqual([
        ...Array<number>(5).fill(401),
        ...Array<number>(15).fill(429),
      ]);
      // Locked out: not even the right password signs in now.
      const right = await login(server, testPassword, {
        remoteAddress: sandbox,
        forwardedFor: "198.51.100.250",
      });
      expect(right.statusCode).toBe(429);
      // And the record of who tried is the sandbox's own address.
      expect(new Set(store.state.signInEvents.map(({ ip }) => ip))).toEqual(
        new Set([sandbox]),
      );
    });
  });

  it("regression (A1-1): the same rotation no longer guesses TOTP codes and API keys without limit", async () => {
    const probed = await probedApp({ trustProxy: 1, proxySecret });
    const { server, store } = probed;
    // TOTP on, so the password starts a challenge.
    await enableTotp(probed, await signIn(server));
    expect((await store.totp()).secret).not.toBeNull();
    const password = await login(server, testPassword, {
      remoteAddress: sandbox,
      forwardedFor: "198.51.100.1",
    });
    const challenge = cookieFrom(
      password.headers["set-cookie"],
      signInChallengeCookie,
    );
    expect(challenge).toBeDefined();
    const codeStatuses: number[] = [];
    const keyStatuses: number[] = [];
    for (let guess = 1; guess <= 12; guess += 1) {
      const code = await server.inject({
        method: "POST",
        url: "/api/login/totp",
        payload: { code: String(100_000 + guess) },
        remoteAddress: sandbox,
        headers: {
          cookie: challenge ?? "",
          "x-forwarded-for": `198.51.100.${String(guess)}`,
        },
      });
      codeStatuses.push(code.statusCode);
      const key = await server.inject({
        method: "POST",
        url: "/api/login/api-key",
        payload: { key: `aio_gk_${"x".repeat(40)}${String(guess)}` },
        remoteAddress: sandbox,
        headers: { "x-forwarded-for": `203.0.113.${String(guess)}` },
      });
      keyStatuses.push(key.statusCode);
    }
    // Codes and keys take turns against one limit, the sandbox's: five
    // free failures between them (three codes, two keys), then 429s.
    expect(codeStatuses).toEqual([
      ...Array<number>(3).fill(401),
      ...Array<number>(9).fill(429),
    ]);
    expect(keyStatuses).toEqual([
      ...Array<number>(2).fill(401),
      ...Array<number>(10).fill(429),
    ]);
  });
});

describe("A1-1 · the proxy proves itself with PROXY_SECRET", () => {
  /** Caddy's address on the compose `default` network. */
  const caddy = "172.19.0.3";

  it("believes X-Forwarded-For from the proxy that sends PROXY_SECRET", async () => {
    const { server, store } = await probedApp({ trustProxy: 1, proxySecret });
    for (let guess = 1; guess <= 5; guess += 1) {
      await login(server, wrong, {
        remoteAddress: caddy,
        forwardedFor: "192.0.2.1",
        proof: proxySecret,
      });
    }
    // The client behind the proxy is locked out; another one is not.
    expect(
      (
        await login(server, wrong, {
          remoteAddress: caddy,
          forwardedFor: "192.0.2.1",
          proof: proxySecret,
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await login(server, testPassword, {
          remoteAddress: caddy,
          forwardedFor: "192.0.2.2",
          proof: proxySecret,
        })
      ).statusCode,
    ).toBe(200);
    expect(store.state.signInEvents.at(-1)?.ip).toBe("192.0.2.2");
  });

  it.each([
    ["no proof", undefined],
    ["a wrong secret", `${proxySecret}-guess`],
    ["an empty one", ""],
  ])(
    "does not believe a caller that sends %s, from inside the trusted range",
    async (_, proof) => {
      const { server, store } = await probedApp({
        trustProxy: ["172.16.0.0/12"],
        proxySecret,
      });
      const statuses: number[] = [];
      for (let guess = 1; guess <= 7; guess += 1) {
        const response = await login(server, wrong, {
          remoteAddress: sandbox,
          forwardedFor: `198.51.100.${String(guess)}`,
          ...(proof === undefined ? {} : { proof }),
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
      expect(store.state.signInEvents.every(({ ip }) => ip === sandbox)).toBe(
        true,
      );
    },
  );

  it("believes nobody with no PROXY_SECRET, even a caller that sends one", async () => {
    const { server } = await probedApp({ trustProxy: 1 });
    const statuses: number[] = [];
    for (let guess = 1; guess <= 6; guess += 1) {
      const response = await login(server, wrong, {
        remoteAddress: caddy,
        forwardedFor: `198.51.100.${String(guess)}`,
        proof: proxySecret,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("keeps the proof itself from every log line and route", async () => {
    const { server, lines } = await probedApp({ trustProxy: 1, proxySecret });
    await login(server, wrong, {
      remoteAddress: caddy,
      forwardedFor: "192.0.2.9",
      proof: proxySecret,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(proxySecret);
  });

  it("does not believe X-Forwarded-Host or -Proto from a caller that is not the proxy either", async () => {
    // With PUBLIC_URL unset, robots.txt names the request's own origin.
    const { server } = await probedApp({ trustProxy: 1, proxySecret });
    const forged = await server.inject({
      url: "/robots.txt",
      remoteAddress: sandbox,
      headers: {
        host: "app:3045",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(forged.body).toContain("http://app:3045/");
    expect(forged.body).not.toContain("attacker.example");
    const proxied = await server.inject({
      url: "/robots.txt",
      remoteAddress: caddy,
      headers: {
        host: "app:3045",
        "x-forwarded-host": "ai-office.example.com",
        "x-forwarded-proto": "https",
        [proxyHeader]: proxySecret,
      },
    });
    expect(proxied.body).toContain("https://ai-office.example.com/");
  });
});

describe("the limiter where it holds", () => {
  it("ignores X-Forwarded-For with TRUST_PROXY unset, even from a sandbox's address", async () => {
    const { server } = await probedApp();
    const statuses = await rotatingGuesses(server, sandbox, 8);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
  });

  it("with TRUST_PROXY=1, believes only the hop nearest the app", async () => {
    // Caddy appends the real peer; a forged entry before it is not used.
    const { server } = await probedApp({ trustProxy: 1, proxySecret });
    const statuses: number[] = [];
    for (let guess = 1; guess <= 7; guess += 1) {
      const response = await login(server, wrong, {
        remoteAddress: "172.18.0.2",
        forwardedFor: `198.51.100.${String(guess)}, 203.0.113.9`,
        proof: proxySecret,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it("keys an IPv6 client by its /64, so rotating within it does not help", async () => {
    const { server } = await probedApp();
    const statuses: number[] = [];
    for (let guess = 1; guess <= 7; guess += 1) {
      const response = await login(server, wrong, {
        remoteAddress: `2001:db8:1:2::${guess.toString(16)}`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it("counts a right password that awaits its TOTP code as no success", async () => {
    // Otherwise the right password would wipe the failures before it.
    const probed = await probedApp();
    const { server } = probed;
    await enableTotp(probed, await signIn(server));
    const from = { remoteAddress: "203.0.113.50" };
    for (let guess = 1; guess <= 4; guess += 1) {
      expect((await login(server, wrong, from)).statusCode).toBe(401);
    }
    expect((await login(server, testPassword, from)).statusCode).toBe(200);
    expect((await login(server, wrong, from)).statusCode).toBe(401);
    expect((await login(server, wrong, from)).statusCode).toBe(429);
  });
});

describe("A1-7: the limiter across a restart", () => {
  /** Locks `client` out, then restarts on the same database. */
  async function lockOutThenRestart(client: string) {
    const first = await probedApp();
    for (let guess = 1; guess <= 5; guess += 1) {
      await login(first.server, wrong, { remoteAddress: client });
    }
    expect(
      (await login(first.server, wrong, { remoteAddress: client })).statusCode,
    ).toBe(429);
    await first.server.close();
    // The same auth store stands for the same Postgres after a restart.
    return probedApp({ store: first.store, clock: first.clock });
  }

  it("a client locked out stays locked out after a restart", async () => {
    const { server } = await lockOutThenRestart("203.0.113.60");
    const response = await login(server, wrong, {
      remoteAddress: "203.0.113.60",
    });
    expect(response.statusCode).toBe(429);
  });

  it("regression (A1-7): a restart no longer forgets every lockout that sign_in_events kept", async () => {
    const restarted = await lockOutThenRestart("203.0.113.61");
    const { server, store } = restarted;
    // The failures are on record in the database...
    expect(
      store.state.signInEvents.filter(
        ({ ip, outcome }) => ip === "203.0.113.61" && outcome === "failed",
      ),
    ).toHaveLength(5);
    // ...and the new process no longer gives five more free guesses: the
    // lockout runs on, even the right password is refused...
    const statuses: number[] = [];
    for (let guess = 1; guess <= 6; guess += 1) {
      statuses.push(
        (await login(server, wrong, { remoteAddress: "203.0.113.61" }))
          .statusCode,
      );
    }
    expect(statuses).not.toEqual([401, 401, 401, 401, 401, 429]);
    expect(statuses).toEqual(Array<number>(6).fill(429));
    expect(
      (await login(server, testPassword, { remoteAddress: "203.0.113.61" }))
        .statusCode,
    ).toBe(429);
    // ...until it ends, after which the next failure doubles it, as before
    // the restart.
    restarted.wait(60_000);
    expect(
      (await login(server, wrong, { remoteAddress: "203.0.113.61" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await login(server, testPassword, { remoteAddress: "203.0.113.61" }))
        .statusCode,
    ).toBe(429);
  });

  it("A1-7 sibling: failures short of a lockout still count after a restart", async () => {
    const first = await probedApp();
    for (let guess = 1; guess <= 4; guess += 1) {
      await login(first.server, wrong, { remoteAddress: "203.0.113.63" });
    }
    await first.server.close();
    const { server } = await probedApp({
      store: first.store,
      clock: first.clock,
    });
    const statuses: number[] = [];
    for (let guess = 1; guess <= 2; guess += 1) {
      statuses.push(
        (await login(server, wrong, { remoteAddress: "203.0.113.63" }))
          .statusCode,
      );
    }
    expect(statuses).toEqual([401, 429]);
  });

  it("A1-7 sibling: a success before the restart still forgets the client's failures", async () => {
    const first = await probedApp();
    for (let guess = 1; guess <= 4; guess += 1) {
      await login(first.server, wrong, { remoteAddress: "203.0.113.64" });
    }
    await login(first.server, testPassword, { remoteAddress: "203.0.113.64" });
    await first.server.close();
    const { server } = await probedApp({
      store: first.store,
      clock: first.clock,
    });
    const statuses: number[] = [];
    for (let guess = 1; guess <= 5; guess += 1) {
      statuses.push(
        (await login(server, wrong, { remoteAddress: "203.0.113.64" }))
          .statusCode,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
  });

  it("A1-7 sibling: a lockout from guessing through a fresh proof, or at turning TOTP off, outlives a restart too", async () => {
    const first = await probedApp();
    const owner = await signIn(first.server);
    await enableTotp(first, owner);
    // Three wrong proofs (A1-4) and two wrong codes to turn TOTP off
    // (A1-5) from one client: five failures, a lockout.
    for (let guess = 1; guess <= 3; guess += 1) {
      await first.server.inject({
        method: "POST",
        url: "/api/owner-passwords",
        headers: owner.headers,
        remoteAddress: "203.0.113.65",
        payload: {
          name: "Pen test",
          password: "Pen-Test-Persist-Pass-77",
          currentPassword: `${wrong}-${String(guess)}`,
          code: "000000",
        },
      });
    }
    for (let guess = 1; guess <= 2; guess += 1) {
      await first.server.inject({
        method: "POST",
        url: "/api/totp/disable",
        headers: owner.headers,
        remoteAddress: "203.0.113.65",
        payload: { code: String(400_000 + guess) },
      });
    }
    await first.server.close();
    const { server } = await probedApp({
      store: first.store,
      clock: first.clock,
    });
    expect(
      (await login(server, testPassword, { remoteAddress: "203.0.113.65" }))
        .statusCode,
    ).toBe(429);
  });

  it("A1-7 sibling: what the limiter would have forgotten, a day without attempts, is not restored", async () => {
    const first = await probedApp();
    for (let guess = 1; guess <= 5; guess += 1) {
      await login(first.server, wrong, { remoteAddress: "203.0.113.66" });
    }
    await first.server.close();
    first.wait(24 * 60 * 60_000);
    const { server } = await probedApp({
      store: first.store,
      clock: first.clock,
    });
    expect(
      (await login(server, testPassword, { remoteAddress: "203.0.113.66" }))
        .statusCode,
    ).toBe(200);
  });

  it("A1-7: a start without the database still starts, saying lockouts were not restored", async () => {
    const first = await probedApp();
    const store = {
      ...first.store,
      signInEventsSince: () =>
        Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
    };
    const { server, lines } = await probedApp({ store, clock: first.clock });
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
    expect(lines.join("\n")).toContain(
      "The sign-in limiter could not read sign_in_events",
    );
  });

  it("a sign-in challenge does not survive a restart: it fails closed", async () => {
    const first = await probedApp();
    await enableTotp(first, await signIn(first.server));
    const password = await login(first.server, testPassword, {
      remoteAddress: "203.0.113.62",
    });
    const challenge = cookieFrom(
      password.headers["set-cookie"],
      signInChallengeCookie,
    );
    await first.server.close();
    const { server } = await probedApp({
      store: first.store,
      clock: first.clock,
    });
    const code = await server.inject({
      method: "POST",
      url: "/api/login/totp",
      payload: { code: "123456" },
      remoteAddress: "203.0.113.62",
      headers: { cookie: challenge ?? "" },
    });
    expect(code.statusCode).toBe(401);
    expect(code.json()).toMatchObject({ error: "sign_in_expired" });
  });
});

describe("repeated failures in the Activity Feed (FR-4)", () => {
  it("records each failed sign-in and the lockout it starts, never the password", async () => {
    const { server, feed } = await probedApp();
    for (let guess = 1; guess <= 5; guess += 1) {
      await login(server, wrong, { remoteAddress: "203.0.113.70" });
    }
    const signIns = feed.map(({ event }) => event);
    expect(signIns.filter(({ type }) => type === "sign_in.failed")).toEqual(
      Array.from({ length: 5 }, () => ({
        type: "sign_in.failed",
        version: 1,
        ip: "203.0.113.70",
        userAgent,
      })),
    );
    expect(signIns.filter(({ type }) => type === "sign_in.locked_out")).toEqual(
      [
        {
          type: "sign_in.locked_out",
          version: 1,
          ip: "203.0.113.70",
          lockoutSeconds: 60,
        },
      ],
    );
    expect(JSON.stringify(feed)).not.toContain(wrong);
  });

  it("records a failed API-key sign-in without the key", async () => {
    const { server, feed, lines } = await probedApp();
    const key = `aio_gk_${"k".repeat(43)}`;
    const response = await server.inject({
      method: "POST",
      url: "/api/login/api-key",
      payload: { key },
      remoteAddress: "203.0.113.71",
    });
    expect(response.statusCode).toBe(401);
    expect(feed.map(({ event }) => event.type)).toEqual(["sign_in.failed"]);
    expect(JSON.stringify(feed)).not.toContain(key);
    expect(lines.join("\n")).not.toContain(key);
  });
});
