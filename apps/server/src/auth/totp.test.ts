import {
  loginResponseSchema,
  normaliseCode,
  sessionResponseSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
  totpStatusSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { generate } from "otplib";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testPassword,
  type SignedIn,
} from "../test-support.ts";
import { signInChallengeCookie } from "./sign-in-challenges.ts";
import {
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  verifyTotpCode,
} from "./totp.ts";

const start = new Date("2026-10-08T12:00:00.000Z");
const userAgent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0";

/** The code an authenticator app shows for `secret` at `at`. */
const codeAt = (secret: string, at: Date): Promise<string> =>
  generate({ secret, epoch: Math.floor(at.getTime() / 1000) });

describe("TOTP codes", () => {
  it("accepts the current code and one step either side, but no further", async () => {
    const { secret } = await newTotpSecret();
    for (const [offsetSeconds, valid] of [
      [-60, false],
      [-30, true],
      [0, true],
      [30, true],
      [60, false],
    ] as const) {
      const code = await codeAt(
        secret,
        new Date(start.getTime() + offsetSeconds * 1000),
      );
      const step = await verifyTotpCode({ secret, code, now: start });
      expect({ offsetSeconds, valid: step !== undefined }).toEqual({
        offsetSeconds,
        valid,
      });
    }
  });

  it("refuses a code whose time step was already used", async () => {
    const { secret } = await newTotpSecret();
    const code = await codeAt(secret, start);
    const step = await verifyTotpCode({ secret, code, now: start });
    expect(step).toBe(Math.floor(start.getTime() / 30_000));
    expect(
      await verifyTotpCode({ secret, code, now: start, afterTimeStep: step }),
    ).toBeUndefined();
  });

  it("ignores spaces in a code, and refuses anything but six digits", async () => {
    const { secret } = await newTotpSecret();
    const code = await codeAt(secret, start);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(
      await verifyTotpCode({ secret, code: spaced, now: start }),
    ).toBeDefined();
    expect(
      await verifyTotpCode({ secret, code: "abcdef", now: start }),
    ).toBeUndefined();
  });

  it("are set up from a Base32 secret, an otpauth URI and a QR code", async () => {
    const { secret, otpauthUrl, qrCode } = await newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const url = new URL(otpauthUrl);
    expect(url.protocol).toBe("otpauth:");
    expect(url.searchParams.get("secret")).toBe(secret);
    expect(url.searchParams.get("issuer")).toBe("AI Office");
    expect(qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(
      Buffer.from(qrCode.split(",")[1] ?? "", "base64").toString(),
    ).toContain("<svg");
  });
});

describe("recovery codes", () => {
  it("are ten distinct 80-bit codes in groups of four", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(
        /^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/,
      );
    }
  });

  it("are hashed in their normal form, so case and dashes do not matter", () => {
    const [code = ""] = newRecoveryCodes();
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code.toUpperCase().replaceAll("-", " "))).toBe(
      hashRecoveryCode(code),
    );
    expect(hashRecoveryCode(code)).not.toContain(normaliseCode(code));
  });
});

/** A set-up app on a clock the test moves, logging into `lines`. */
async function app() {
  const clock = { now: start };
  const lines: string[] = [];
  const auth = await testAuth({ now: () => clock.now });
  const server = await buildApp({
    logger: createLogger({
      level: "debug",
      secrets: [],
      destination: { write: (line) => lines.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth,
  });
  /** Moves the clock `seconds` on. */
  const wait = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  return { server, store: auth.store, clock, wait, lines };
}

type App = Awaited<ReturnType<typeof app>>;

const post = (
  server: FastifyInstance,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
) =>
  server.inject({
    method: "POST",
    url,
    payload: payload as Record<string, unknown>,
    remoteAddress: "203.0.113.7",
    headers: { "user-agent": userAgent, ...headers },
  });

const cookieFrom = (setCookie: unknown, name: string): string | undefined =>
  [setCookie]
    .flat()
    .map((header) => String(header).split(";", 1)[0] ?? "")
    .find((pair) => pair.startsWith(`${name}=`) && pair !== `${name}=`);

/** Turns TOTP on through the API; returns the secret and recovery codes. */
async function enableTotp(
  { server, clock }: App,
  owner: SignedIn,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await post(
    server,
    "/api/totp/setup",
    { currentPassword: testPassword },
    owner.headers,
  );
  expect(setup.statusCode).toBe(200);
  const { secret } = totpSetupResponseSchema.parse(setup.json());
  const enable = await post(
    server,
    "/api/totp/enable",
    { code: await codeAt(secret, clock.now) },
    owner.headers,
  );
  expect(enable.statusCode).toBe(200);
  const { recoveryCodes } = totpEnableResponseSchema.parse(enable.json());
  return { secret, recoveryCodes };
}

/** The password step: returns the challenge cookie when TOTP is on. */
async function passwordStep(server: FastifyInstance): Promise<string> {
  const response = await post(server, "/api/login", { password: testPassword });
  expect(response.statusCode).toBe(200);
  expect(loginResponseSchema.parse(response.json())).toEqual({
    secondFactor: "totp",
  });
  const challenge = cookieFrom(
    response.headers["set-cookie"],
    signInChallengeCookie,
  );
  expect(challenge).toBeDefined();
  // No session yet.
  expect(
    cookieFrom(response.headers["set-cookie"], "ai_office_session"),
  ).toBeUndefined();
  return challenge ?? "";
}

const codeStep = (server: FastifyInstance, challenge: string, code: string) =>
  post(server, "/api/login/totp", { code }, { cookie: challenge });

const status = async (server: FastifyInstance, owner: SignedIn) =>
  totpStatusSchema.parse(
    (
      await server.inject({
        url: "/api/totp",
        headers: { cookie: owner.cookie },
      })
    ).json(),
  );

describe("turning TOTP on", () => {
  it("shows a QR code and secret, confirms a code, then shows ten recovery codes once", async () => {
    const context = await app();
    const { server, store, clock } = context;
    const owner = await signIn(server);
    expect(await status(server, owner)).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
    });

    const setup = await post(
      server,
      "/api/totp/setup",
      { currentPassword: testPassword },
      owner.headers,
    );
    expect(setup.statusCode).toBe(200);
    expect(setup.headers["cache-control"]).toBe("no-store");
    const { secret, otpauthUrl, qrCode } = totpSetupResponseSchema.parse(
      setup.json(),
    );
    expect(otpauthUrl).toContain(secret);
    expect(qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    // Set up is not on: signing in still needs only the password.
    expect(await status(server, owner)).toMatchObject({ enabled: false });

    const wrong = await post(
      server,
      "/api/totp/enable",
      { code: "000000" },
      owner.headers,
    );
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ error: "wrong_code" });

    const enable = await post(
      server,
      "/api/totp/enable",
      { code: await codeAt(secret, clock.now) },
      owner.headers,
    );
    expect(enable.statusCode).toBe(200);
    expect(enable.headers["cache-control"]).toBe("no-store");
    const { recoveryCodes } = totpEnableResponseSchema.parse(enable.json());
    expect(recoveryCodes).toHaveLength(10);
    expect(await status(server, owner)).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });

    // The secret is sealed at rest, and only the codes' hashes are kept.
    expect(store.state.totp.secret).toMatch(/^aio1:1:/);
    expect(store.state.totp.secret).not.toContain(secret);
    expect(store.state.totp.pendingSecret).toBeNull();
    expect([...store.state.recoveryCodes.keys()]).toEqual(
      recoveryCodes.map(hashRecoveryCode),
    );

    // Set up again only after turning it off; the codes are not shown again.
    const again = await post(
      server,
      "/api/totp/setup",
      { currentPassword: testPassword },
      owner.headers,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "totp_enabled" });
  });

  it("needs a secret set up first", async () => {
    const { server } = await app();
    const owner = await signIn(server);
    const response = await post(
      server,
      "/api/totp/enable",
      { code: "123456" },
      owner.headers,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "totp_not_set_up" });
  });

  it("confirms only the latest secret set up", async () => {
    const { server, clock } = await app();
    const owner = await signIn(server);
    const first = totpSetupResponseSchema.parse(
      (
        await post(
          server,
          "/api/totp/setup",
          { currentPassword: testPassword },
          owner.headers,
        )
      ).json(),
    );
    await post(
      server,
      "/api/totp/setup",
      { currentPassword: testPassword },
      owner.headers,
    );
    const response = await post(
      server,
      "/api/totp/enable",
      { code: await codeAt(first.secret, clock.now) },
      owner.headers,
    );
    expect(response.statusCode).toBe(422);
  });

  it("needs a session and the CSRF token", async () => {
    const { server } = await app();
    const owner = await signIn(server);
    expect((await post(server, "/api/totp/setup", {})).statusCode).toBe(401);
    expect(
      (await post(server, "/api/totp/setup", {}, { cookie: owner.cookie }))
        .statusCode,
    ).toBe(403);
  });
});

describe("signing in with TOTP on", () => {
  it("asks for a code after the password, then signs in with it", async () => {
    const context = await app();
    const { server, store, clock, wait } = context;
    const { secret } = await enableTotp(context, await signIn(server));
    wait(30);

    const challenge = await passwordStep(server);
    const response = await codeStep(
      server,
      challenge,
      await codeAt(secret, clock.now),
    );
    expect(response.statusCode).toBe(200);
    expect(sessionResponseSchema.parse(response.json())).toBeDefined();
    const session = cookieFrom(
      response.headers["set-cookie"],
      "ai_office_session",
    );
    expect(session).toBeDefined();
    // The challenge is over: its cookie is cleared.
    expect(String(response.headers["set-cookie"])).toContain(
      `${signInChallengeCookie}=; Path=/api/login; Max-Age=0`,
    );
    const me = await server.inject({
      url: "/api/session",
      headers: { cookie: session ?? "" },
    });
    expect(me.statusCode).toBe(200);

    expect(store.state.signInEvents.at(-1)).toEqual({
      occurredAt: clock.now,
      outcome: "succeeded",
      ip: "203.0.113.7",
      userAgent,
      secondFactor: "totp",
    });
  });

  it("refuses a wrong code, and a code that was already used", async () => {
    const context = await app();
    const { server, store, clock, wait } = context;
    const { secret } = await enableTotp(context, await signIn(server));
    wait(30);

    const challenge = await passwordStep(server);
    const wrong = await codeStep(server, challenge, "000000");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({
      error: "wrong_code",
      message: "That code is not right, or was already used.",
    });
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    expect(store.state.signInEvents.at(-1)).toMatchObject({
      outcome: "failed",
      secondFactor: "totp",
    });

    // The same challenge may try again.
    const code = await codeAt(secret, clock.now);
    expect((await codeStep(server, challenge, code)).statusCode).toBe(200);
    // A code works once, even with a new challenge.
    const replay = await codeStep(server, await passwordStep(server), code);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: "wrong_code" });
  });

  it("signs in with a recovery code, which then stops working", async () => {
    const context = await app();
    const { server, store } = context;
    const owner = await signIn(server);
    const { recoveryCodes } = await enableTotp(context, owner);
    const [code = ""] = recoveryCodes;

    const response = await codeStep(server, await passwordStep(server), code);
    expect(response.statusCode).toBe(200);
    expect(
      cookieFrom(response.headers["set-cookie"], "ai_office_session"),
    ).toBeDefined();
    expect(store.state.signInEvents.at(-1)).toMatchObject({
      outcome: "succeeded",
      secondFactor: "recovery_code",
    });
    expect(await status(server, owner)).toEqual({
      enabled: true,
      recoveryCodesLeft: 9,
    });

    const again = await codeStep(server, await passwordStep(server), code);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: "wrong_code" });
    expect(store.state.signInEvents.at(-1)).toMatchObject({
      outcome: "failed",
      secondFactor: "recovery_code",
    });

    // Typed in capitals without dashes, another code still works.
    const second = (recoveryCodes[1] ?? "").toUpperCase().replaceAll("-", "");
    expect(
      (await codeStep(server, await passwordStep(server), second)).statusCode,
    ).toBe(200);
  });

  it("needs the password first, and forgets it after five minutes", async () => {
    const context = await app();
    const { server, clock, wait } = context;
    const { secret } = await enableTotp(context, await signIn(server));

    const without = await post(server, "/api/login/totp", { code: "123456" });
    expect(without.statusCode).toBe(401);
    expect(without.json()).toEqual({
      error: "sign_in_expired",
      message: "Enter the password again.",
    });
    const forged = await codeStep(
      server,
      `${signInChallengeCookie}=forged`,
      "123456",
    );
    expect(forged.statusCode).toBe(401);

    const challenge = await passwordStep(server);
    wait(5 * 60);
    const late = await codeStep(
      server,
      challenge,
      await codeAt(secret, clock.now),
    );
    expect(late.statusCode).toBe(401);
    expect(late.json()).toMatchObject({ error: "sign_in_expired" });
  });

  it("rate-limits wrong codes like wrong passwords", async () => {
    const context = await app();
    const { server, clock, wait } = context;
    const { secret } = await enableTotp(context, await signIn(server));
    wait(30);

    const challenge = await passwordStep(server);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await codeStep(server, challenge, "000000")).statusCode).toBe(
        401,
      );
    }
    const sixth = await codeStep(
      server,
      challenge,
      await codeAt(secret, clock.now),
    );
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers["retry-after"]).toBe("60");
    // A new password step does not get round it.
    const password = await post(server, "/api/login", {
      password: testPassword,
    });
    expect(password.statusCode).toBe(429);
  });

  it("does not count a right password as a failure", async () => {
    const context = await app();
    const { server, clock, wait } = context;
    const { secret } = await enableTotp(context, await signIn(server));
    wait(30);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await post(server, "/api/login", { password: "not-the-password" });
    }
    // The fifth attempt is right, so it neither locks the client out nor
    // forgets the four failures before it.
    const challenge = await passwordStep(server);
    const response = await codeStep(
      server,
      challenge,
      await codeAt(secret, clock.now),
    );
    expect(response.statusCode).toBe(200);
  });

  it("never logs the secret or a code", async () => {
    const context = await app();
    const { server, clock, wait, lines } = context;
    const { secret, recoveryCodes } = await enableTotp(
      context,
      await signIn(server),
    );
    wait(30);
    const code = await codeAt(secret, clock.now);
    await codeStep(server, await passwordStep(server), code);
    await codeStep(server, await passwordStep(server), recoveryCodes[0] ?? "");
    const log = lines.join("");
    expect(log).toContain("The Owner signed in with TOTP.");
    expect(log).toContain("The Owner signed in with a recovery code.");
    expect(log).toContain('"recoveryCodesLeft":9');
    for (const value of [secret, code, ...recoveryCodes]) {
      expect(log).not.toContain(value);
    }
  });
});

describe("turning TOTP off", () => {
  it("needs a current code, then signing in needs only the password", async () => {
    const context = await app();
    const { server, store, clock, wait } = context;
    const owner = await signIn(server);
    const { secret } = await enableTotp(context, owner);
    wait(30);

    const wrong = await post(
      server,
      "/api/totp/disable",
      { code: "000000" },
      owner.headers,
    );
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ error: "wrong_code" });
    expect(await status(server, owner)).toMatchObject({ enabled: true });

    const disable = await post(
      server,
      "/api/totp/disable",
      { code: await codeAt(secret, clock.now) },
      owner.headers,
    );
    expect(disable.statusCode).toBe(204);
    expect(await status(server, owner)).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
    });
    expect(store.state.totp).toEqual({
      secret: null,
      pendingSecret: null,
      lastTimeStep: null,
    });
    expect(store.state.recoveryCodes.size).toBe(0);

    const login = await post(server, "/api/login", { password: testPassword });
    expect(sessionResponseSchema.parse(login.json())).toBeDefined();

    const again = await post(
      server,
      "/api/totp/disable",
      { code: "123456" },
      owner.headers,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "totp_disabled" });
  });

  it("takes a recovery code instead", async () => {
    const context = await app();
    const { server } = context;
    const owner = await signIn(server);
    const { recoveryCodes } = await enableTotp(context, owner);
    const response = await post(
      server,
      "/api/totp/disable",
      { code: recoveryCodes[3] ?? "" },
      owner.headers,
    );
    expect(response.statusCode).toBe(204);
  });

  it("rate-limits wrong codes", async () => {
    const context = await app();
    const { server } = context;
    const owner = await signIn(server);
    await enableTotp(context, owner);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await post(
        server,
        "/api/totp/disable",
        { code: "000000" },
        owner.headers,
      );
    }
    const sixth = await post(
      server,
      "/api/totp/disable",
      { code: "000000" },
      owner.headers,
    );
    expect(sixth.statusCode).toBe(429);
  });

  it("ends a sign-in waiting for a code", async () => {
    const context = await app();
    const { server, clock, wait } = context;
    const owner = await signIn(server);
    const { secret } = await enableTotp(context, owner);
    const challenge = await passwordStep(server);
    wait(30);
    await post(
      server,
      "/api/totp/disable",
      { code: await codeAt(secret, clock.now) },
      owner.headers,
    );
    const response = await codeStep(server, challenge, "123456");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "sign_in_expired" });
  });
});
