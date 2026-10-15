import {
  createdGatewayKeySchema,
  totpSetupResponseSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import {
  codeAt,
  cookieFrom,
  enableTotp,
  probedApp,
} from "../pen-test-support.ts";
import { signIn, testPassword } from "../test-support.ts";
import { sessionCookie } from "./sessions.ts";
import { signInChallengeCookie } from "./sign-in-challenges.ts";

// A1 probe (pen-testing, "Sign-in and sessions"): the TOTP second factor
// (FR-3, H5): enrolment, recovery codes, replaying a code, and API-key
// sessions, which never ask for one. Positions 1 (the password guessed or
// known) and 4 (a stolen session or UI-capable API key).

/** The password step; returns the challenge cookie. */
async function challenge(
  server: FastifyInstance,
  remoteAddress = "203.0.113.80",
): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: testPassword },
    remoteAddress,
  });
  expect(response.json()).toEqual({ secondFactor: "totp" });
  return (
    cookieFrom(response.headers["set-cookie"], signInChallengeCookie) ?? ""
  );
}

const codeStep = (
  server: FastifyInstance,
  cookie: string,
  code: string,
  remoteAddress = "203.0.113.80",
) =>
  server.inject({
    method: "POST",
    url: "/api/login/totp",
    payload: { code },
    remoteAddress,
    headers: { cookie },
  });

describe("TOTP enrolment", () => {
  it("shows the secret once, uncached, and keeps it sealed until a code confirms it", async () => {
    const { server, store } = await probedApp();
    const owner = await signIn(server);
    const setup = await server.inject({
      method: "POST",
      url: "/api/totp/setup",
      headers: owner.headers,
      // Turning TOTP on needs the current password (A1-3).
      payload: { currentPassword: testPassword },
    });
    expect(setup.headers["cache-control"]).toBe("no-store");
    const { secret } = totpSetupResponseSchema.parse(setup.json());
    const { pendingSecret, secret: active } = store.state.totp;
    expect(active).toBeNull();
    expect(pendingSecret).toMatch(/^aio1:/);
    expect(pendingSecret).not.toContain(secret);
    // Not on until confirmed: the password alone still signs in.
    await signIn(server);
  });

  it("refuses a wrong confirming code, and a second enrolment while on", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    await probed.server.inject({
      method: "POST",
      url: "/api/totp/setup",
      headers: owner.headers,
      payload: { currentPassword: testPassword },
    });
    const wrong = await probed.server.inject({
      method: "POST",
      url: "/api/totp/enable",
      headers: owner.headers,
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(422);
    await enableTotp(probed, owner);
    const again = await probed.server.inject({
      method: "POST",
      url: "/api/totp/setup",
      headers: owner.headers,
      payload: { currentPassword: testPassword },
    });
    expect(again.statusCode).toBe(409);
  });

  it("the sign-in challenge is an HttpOnly, SameSite=Strict cookie scoped to /api/login for five minutes", async () => {
    const probed = await probedApp();
    await enableTotp(probed, await signIn(probed.server));
    const response = await probed.server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
    });
    const attributes = String(response.headers["set-cookie"])
      .split(";")
      .slice(1)
      .map((attribute) => attribute.trim());
    expect(attributes).toEqual([
      "Path=/api/login",
      "Max-Age=300",
      "HttpOnly",
      "SameSite=Strict",
    ]);
    // A right password with TOTP on starts no session.
    expect(
      cookieFrom(response.headers["set-cookie"], sessionCookie),
    ).toBeUndefined();
  });
});

describe("replaying a code", () => {
  it("the code that confirmed enrolment cannot then sign in", async () => {
    const probed = await probedApp();
    const { secret } = await enableTotp(probed, await signIn(probed.server));
    const cookie = await challenge(probed.server);
    const replay = await codeStep(
      probed.server,
      cookie,
      await codeAt(secret, probed.clock.now),
    );
    expect(replay.statusCode).toBe(401);
  });

  it("a code used to sign in cannot be used again, nor an older one", async () => {
    const probed = await probedApp();
    const { secret } = await enableTotp(probed, await signIn(probed.server));
    probed.wait(60_000);
    const code = await codeAt(secret, probed.clock.now);
    const first = await codeStep(
      probed.server,
      await challenge(probed.server),
      code,
    );
    expect(first.statusCode).toBe(200);
    const again = await codeStep(
      probed.server,
      await challenge(probed.server),
      code,
    );
    expect(again.statusCode).toBe(401);
    const older = await codeStep(
      probed.server,
      await challenge(probed.server),
      await codeAt(secret, new Date(probed.clock.now.getTime() - 30_000)),
    );
    expect(older.statusCode).toBe(401);
  });

  it("two sign-ins racing with one code: only one wins", async () => {
    const probed = await probedApp();
    const { secret } = await enableTotp(probed, await signIn(probed.server));
    probed.wait(60_000);
    const code = await codeAt(secret, probed.clock.now);
    const cookies = [
      await challenge(probed.server, "203.0.113.81"),
      await challenge(probed.server, "203.0.113.82"),
    ];
    const statuses = (
      await Promise.all(
        cookies.map((cookie, index) =>
          codeStep(
            probed.server,
            cookie,
            code,
            `203.0.113.8${String(index + 1)}`,
          ),
        ),
      )
    ).map((response) => response.statusCode);
    expect(statuses.sort()).toEqual([200, 401]);
  });

  it("wrong codes in one challenge are limited like wrong passwords", async () => {
    const probed = await probedApp();
    await enableTotp(probed, await signIn(probed.server));
    const cookie = await challenge(probed.server);
    const statuses: number[] = [];
    for (let guess = 1; guess <= 7; guess += 1) {
      statuses.push(
        (await codeStep(probed.server, cookie, String(100_000 + guess)))
          .statusCode,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });
});

describe("recovery codes", () => {
  it("are ten, each works once, and only their hashes are kept", async () => {
    const probed = await probedApp();
    const { recoveryCodes } = await enableTotp(
      probed,
      await signIn(probed.server),
    );
    expect(new Set(recoveryCodes).size).toBe(10);
    const [code = ""] = recoveryCodes;
    expect([...probed.store.state.recoveryCodes.keys()]).not.toContain(code);
    const first = await codeStep(
      probed.server,
      await challenge(probed.server),
      code.toUpperCase(),
    );
    expect(first.statusCode).toBe(200);
    const again = await codeStep(
      probed.server,
      await challenge(probed.server),
      code,
    );
    expect(again.statusCode).toBe(401);
    expect((await probed.store.totp()).recoveryCodesLeft).toBe(9);
  });

  it("a guessed recovery code counts against the limiter", async () => {
    const probed = await probedApp();
    await enableTotp(probed, await signIn(probed.server));
    const cookie = await challenge(probed.server);
    const statuses: number[] = [];
    for (let guess = 1; guess <= 6; guess += 1) {
      statuses.push(
        (
          await codeStep(
            probed.server,
            cookie,
            `abcd-efgh-jkmn-pq${String(guess)}0`,
          )
        ).statusCode,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe("API-key sessions and TOTP", () => {
  it("by design, a UI-capable API key signs in with no code even when TOTP is on (see A1-3)", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    const made = await probed.server.inject({
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
    await enableTotp(probed, owner);
    const response = await probed.server.inject({
      method: "POST",
      url: "/api/login/api-key",
      payload: { key },
    });
    expect(response.statusCode).toBe(200);
    expect(
      cookieFrom(response.headers["set-cookie"], sessionCookie),
    ).toBeDefined();
  });
});

describe("A1-5: refused attempts to turn TOTP off", () => {
  /** A stolen session guesses at turning TOTP off; the feed after it. */
  async function guessesToTurnOff() {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    await enableTotp(probed, owner);
    const before = probed.feed.length;
    const statuses: number[] = [];
    for (let guess = 1; guess <= 3; guess += 1) {
      statuses.push(
        (
          await probed.server.inject({
            method: "POST",
            url: "/api/totp/disable",
            headers: owner.headers,
            payload: { code: String(200_000 + guess) },
          })
        ).statusCode,
      );
    }
    expect(statuses).toEqual([422, 422, 422]);
    return probed.feed.slice(before).map(({ event }) => event);
  }

  it("are recorded in the Activity Feed", async () => {
    expect(await guessesToTurnOff()).not.toEqual([]);
  });

  it("regression (A1-5): no longer leave nothing in the Activity Feed: each is a failed sign-in at the second factor, never the code", async () => {
    const events = await guessesToTurnOff();
    expect(events).not.toEqual([]);
    expect(events).toEqual(
      Array.from({ length: 3 }, () => ({
        type: "sign_in.failed",
        version: 1,
        ip: "127.0.0.1",
        userAgent: "lightMyRequest",
        secondFactor: "totp",
      })),
    );
  });

  it("A1-5 sibling: each is a failed attempt in sign_in_events, the lockout they start is in the Activity Feed, and a right code is recorded too", async () => {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    const { secret } = await enableTotp(probed, owner);
    const before = {
      feed: probed.feed.length,
      attempts: probed.store.state.signInEvents.length,
    };
    const disable = async (code: string) =>
      (
        await probed.server.inject({
          method: "POST",
          url: "/api/totp/disable",
          headers: owner.headers,
          payload: { code },
        })
      ).statusCode;
    const statuses: number[] = [];
    for (let guess = 1; guess <= 5; guess += 1) {
      statuses.push(await disable(String(300_000 + guess)));
    }
    expect(statuses).toEqual([422, 422, 422, 422, 422]);
    expect(
      probed.feed.slice(before.feed).map(({ event }) => event.type),
    ).toEqual([
      ...Array<string>(5).fill("sign_in.failed"),
      "sign_in.locked_out",
    ]);
    expect(
      probed.store.state.signInEvents
        .slice(before.attempts)
        .map(({ outcome, secondFactor }) => ({ outcome, secondFactor })),
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        outcome: "failed",
        secondFactor: "totp",
      })),
    );
    expect(JSON.stringify(probed.feed)).not.toContain("300001");
    // After the lockout, the Owner's right code turns it off: a succeeded
    // attempt, and the change, but no sign-in.
    probed.wait(60 * 60_000);
    const attempts = probed.store.state.signInEvents.length;
    const feed = probed.feed.length;
    expect(await disable(await codeAt(secret, probed.clock.now))).toBe(204);
    expect(
      probed.store.state.signInEvents
        .slice(attempts)
        .map(({ outcome }) => outcome),
    ).toEqual(["succeeded"]);
    expect(probed.feed.slice(feed).map(({ event }) => event)).toEqual([
      {
        type: "config.changed",
        version: 1,
        scope: "security",
        keys: ["totp.disabled"],
      },
    ]);
  });
});
