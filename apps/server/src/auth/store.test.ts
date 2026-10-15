import { owner, recoveryCodes, sessions, signInEvents } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from "@ai-office/shared";
import { generate } from "otplib";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testEncryptor, testSessionSecret } from "../test-support.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { databaseAuthStore, memoryAuthStore, type AuthStore } from "./store.ts";
import { hashRecoveryCode, sealTotpSecret } from "./totp.ts";

const password = "Tr0ub4dor&3x-postgres";

describe("databaseAuthStore against Postgres 18", () => {
  postgresTest("has no password until one is created", async ({ database }) => {
    const store = databaseAuthStore(database.db);
    expect(await store.passwordHash()).toBeUndefined();

    const passwordHash = await hashPassword(password);
    expect(await store.createPasswordHash(passwordHash)).toBe(true);
    expect(await store.passwordHash()).toBe(passwordHash);
  });

  postgresTest("creates the password only once", async ({ database }) => {
    const store = databaseAuthStore(database.db);
    const first = await hashPassword(password);
    const [created, again] = await Promise.all([
      store.createPasswordHash(first),
      store.createPasswordHash(await hashPassword("An0ther-passw0rd")),
    ]);
    expect([created, again].filter(Boolean)).toHaveLength(1);
    expect(await database.db.select().from(owner)).toHaveLength(1);
  });

  postgresTest(
    "refuses to store anything but an Argon2id hash",
    async ({ database }) => {
      await expect(
        database.db.insert(owner).values({ passwordHash: password }),
      ).rejects.toThrow();
      await expect(
        database.db
          .insert(owner)
          .values({ id: 2, passwordHash: "$argon2id$x" }),
      ).rejects.toThrow();
    },
  );

  postgresTest(
    "stores the setup screen's password as an Argon2id hash",
    async ({ database }) => {
      const app = await buildApp({
        logger: createLogger({ level: "silent", secrets: [] }),
        checkDatabase: () => Promise.resolve(true),
        webDistDir: "/nonexistent",
        auth: {
          store: databaseAuthStore(database.db),
          secret: testSessionSecret,
          secureCookie: false,
          encryptor: testEncryptor,
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { password },
      });
      expect(response.statusCode).toBe(204);

      const rows = await database.db.select().from(owner);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row?.passwordHash).not.toContain(password);
      expect(await verifyPassword(row?.passwordHash ?? "", password)).toBe(
        true,
      );

      const again = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { password },
      });
      expect(again.statusCode).toBe(404);
      await app.close();
    },
  );

  postgresTest(
    "keeps the Owner's further passwords, and ends a removed one's sessions",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      const createdAt = new Date("2026-10-08T12:00:00.000Z");
      await store.addOwnerPassword({
        id: "sam",
        name: "Sam",
        nickname: "",
        timeZone: "Europe/London",
        passwordHash: await hashPassword(password),
        createdAt,
        lastUsedAt: null,
      });
      expect((await store.ownerPasswords()).map(({ id }) => id)).toEqual([
        "sam",
      ]);
      expect(
        await store.updateOwnerPassword("sam", {
          name: "Samantha",
          nickname: "Sam",
          timeZone: "Asia/Tokyo",
        }),
      ).toMatchObject({ name: "Samantha", nickname: "Sam" });
      await store.touchOwnerPassword("sam", createdAt);
      expect((await store.ownerPasswords())[0]?.lastUsedAt).toEqual(createdAt);
      await store.createSession({
        id: "s",
        createdAt,
        expiresAt: new Date("2026-10-15T12:00:00.000Z"),
        passwordId: "sam",
      });
      expect(await store.findSession("s")).toMatchObject({ passwordId: "sam" });
      expect(await store.deleteOwnerPassword("sam")).toBe(true);
      expect(await store.findSession("s")).toBeUndefined();
      expect(await store.deleteOwnerPassword("sam")).toBe(false);
    },
  );

  postgresTest(
    "replaces an Owner password, and ends only the sessions it began (A1-9)",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      const createdAt = new Date("2026-10-08T12:00:00.000Z");
      const expiresAt = new Date("2026-10-15T12:00:00.000Z");
      await store.createPasswordHash(await hashPassword(password));
      await store.addOwnerPassword({
        id: "sam",
        name: "Sam",
        nickname: "",
        timeZone: "Europe/London",
        passwordHash: await hashPassword(password),
        createdAt,
        lastUsedAt: null,
      });
      await store.createSession({ id: "first", createdAt, expiresAt });
      await store.createSession({
        id: "sam",
        createdAt,
        expiresAt,
        passwordId: "sam",
      });
      const replacement = await hashPassword("Replacement-Passw0rd");
      expect(await store.replaceOwnerPassword(null, replacement)).toBe(true);
      expect(await store.passwordHash()).toBe(replacement);
      expect(await store.findSession("first")).toBeUndefined();
      expect(await store.findSession("sam")).toBeDefined();
      expect(await store.replaceOwnerPassword("sam", replacement)).toBe(true);
      expect((await store.ownerPasswords())[0]?.passwordHash).toBe(replacement);
      expect(await store.findSession("sam")).toBeUndefined();
      expect(await store.replaceOwnerPassword("nobody", replacement)).toBe(
        false,
      );
    },
  );

  postgresTest(
    "notes when a session was last used (A1-8)",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      const createdAt = new Date("2026-10-08T12:00:00.000Z");
      await store.createSession({
        id: "s",
        createdAt,
        expiresAt: new Date("2026-10-15T12:00:00.000Z"),
      });
      expect((await store.findSession("s"))?.lastSeenAt ?? null).toBeNull();
      const seen = new Date("2026-10-09T08:00:00.000Z");
      await store.touchSession("s", seen);
      expect((await store.findSession("s"))?.lastSeenAt).toEqual(seen);
    },
  );

  postgresTest("keeps, finds and ends sessions", async ({ database }) => {
    const store = databaseAuthStore(database.db);
    const createdAt = new Date("2026-10-08T12:00:00.000Z");
    const session = (id: string, expiresAt: string) => ({
      id,
      createdAt,
      expiresAt: new Date(expiresAt),
    });
    await store.createSession(session("a", "2026-10-15T12:00:00.000Z"));
    await store.createSession(session("b", "2026-10-09T12:00:00.000Z"));
    await store.createSession(session("c", "2026-10-15T12:00:00.000Z"));

    expect(await store.findSession("a")).toEqual({
      ...session("a", "2026-10-15T12:00:00.000Z"),
      gatewayKeyId: null,
      passwordId: null,
      // Not used since it began: the idle timeout counts from createdAt (A1-8).
      lastSeenAt: null,
    });
    expect(await store.findSession("missing")).toBeUndefined();

    await store.deleteExpiredSessions(new Date("2026-10-09T12:00:00.000Z"));
    expect(await store.findSession("b")).toBeUndefined();

    await store.deleteSession("a");
    expect(await store.findSession("a")).toBeUndefined();
    expect(await store.findSession("c")).toBeDefined();

    expect(await store.deleteAllSessions()).toBe(1);
    expect(await database.db.select().from(sessions)).toEqual([]);
  });

  postgresTest(
    "signs in, out and out everywhere through the app",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      await store.createPasswordHash(await hashPassword(password));
      const app = await buildApp({
        logger: createLogger({ level: "silent", secrets: [] }),
        checkDatabase: () => Promise.resolve(true),
        webDistDir: "/nonexistent",
        auth: {
          store,
          secret: testSessionSecret,
          secureCookie: false,
          encryptor: testEncryptor,
        },
      });
      const first = await signIn(app, password);
      const second = await signIn(app, password);
      const rows = await database.db.select().from(sessions);
      expect(rows).toHaveLength(2);
      // Only the token's hash is stored, never the cookie's value.
      for (const row of rows) {
        expect(row.id).toMatch(/^[0-9a-f]{64}$/);
        expect(first.cookie).not.toContain(row.id);
      }

      const session = (cookie: string) =>
        app.inject({ url: "/api/session", headers: { cookie } });
      expect((await session(first.cookie)).statusCode).toBe(200);
      await app.inject({
        method: "POST",
        url: "/api/logout/everywhere",
        headers: second.headers,
      });
      expect((await session(first.cookie)).statusCode).toBe(401);
      expect((await session(second.cookie)).statusCode).toBe(401);
      expect(await database.db.select().from(sessions)).toEqual([]);
      await app.close();
    },
  );

  postgresTest("records sign-in events", async ({ database }) => {
    const store = databaseAuthStore(database.db);
    const occurredAt = new Date("2026-10-08T12:00:00.000Z");
    await store.recordSignInEvent({
      occurredAt,
      outcome: "failed",
      ip: "203.0.113.7",
      userAgent: "curl/8.17.0",
    });
    await store.recordSignInEvent({
      occurredAt,
      outcome: "succeeded",
      ip: "2001:db8::1",
      userAgent: null,
    });
    expect(await database.db.select().from(signInEvents)).toEqual([
      {
        id: 1,
        occurredAt,
        outcome: "failed",
        ip: "203.0.113.7",
        userAgent: "curl/8.17.0",
        secondFactor: null,
      },
      {
        id: 2,
        occurredAt,
        outcome: "succeeded",
        ip: "2001:db8::1",
        userAgent: null,
        secondFactor: null,
      },
    ]);
    await expect(
      database.db
        .insert(signInEvents)
        .values({ occurredAt, outcome: "locked", ip: "203.0.113.7" }),
    ).rejects.toThrow();
  });

  postgresTest(
    "records sign-ins through the app, and refuses the sixth failure",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      await store.createPasswordHash(await hashPassword(password));
      const app = await buildApp({
        logger: createLogger({ level: "silent", secrets: [] }),
        checkDatabase: () => Promise.resolve(true),
        webDistDir: "/nonexistent",
        auth: {
          store,
          secret: testSessionSecret,
          secureCookie: false,
          encryptor: testEncryptor,
        },
      });
      const attempt = (value: string) =>
        app.inject({
          method: "POST",
          url: "/api/login",
          payload: { password: value },
          remoteAddress: "203.0.113.7",
        });
      expect((await attempt(password)).statusCode).toBe(200);
      for (let count = 1; count <= 5; count += 1) {
        expect((await attempt("wrong")).statusCode).toBe(401);
      }
      const sixth = await attempt("wrong");
      expect(sixth.statusCode).toBe(429);
      expect(sixth.headers["retry-after"]).toBe("60");

      const rows = await database.db
        .select()
        .from(signInEvents)
        .orderBy(signInEvents.id);
      expect(rows.map(({ outcome }) => outcome)).toEqual([
        "succeeded",
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
      ]);
      expect(rows.every(({ ip }) => ip === "203.0.113.7")).toBe(true);
      expect(rows[0]?.userAgent).toBe("lightMyRequest");
      await app.close();
    },
  );

  postgresTest(
    "keeps the TOTP secret sealed and each code single-use",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      await store.createPasswordHash(await hashPassword(password));
      const at = new Date("2026-10-08T12:00:00.000Z");
      expect(await store.totp()).toEqual({
        secret: null,
        pendingSecret: null,
        lastTimeStep: null,
        recoveryCodesLeft: 0,
      });

      const sealed = sealTotpSecret(testEncryptor, "JBSWY3DPEHPK3PXPJBSWY3DP");
      await store.setPendingTotpSecret(sealed);
      const hashes = ["a", "b", "c"].map(hashRecoveryCode);
      // Only the pending secret it was shown can be turned on.
      expect(
        await store.enableTotp({
          pendingSecret: sealTotpSecret(testEncryptor, "OTHER"),
          timeStep: 1,
          recoveryCodeHashes: hashes,
          at,
        }),
      ).toBe(false);
      expect(
        await store.enableTotp({
          pendingSecret: sealed,
          timeStep: 100,
          recoveryCodeHashes: hashes,
          at,
        }),
      ).toBe(true);
      expect(await store.totp()).toEqual({
        secret: sealed,
        pendingSecret: null,
        lastTimeStep: 100,
        recoveryCodesLeft: 3,
      });
      const [row] = await database.db.select().from(owner);
      expect(row?.totpEnabledAt).toEqual(at);

      // A time step is used once, and never an earlier one.
      expect(await store.useTotpTimeStep(100)).toBe(false);
      expect(await store.useTotpTimeStep(99)).toBe(false);
      const steps = await Promise.all([
        store.useTotpTimeStep(101),
        store.useTotpTimeStep(101),
      ]);
      expect(steps.filter(Boolean)).toHaveLength(1);

      // A recovery code works once, even when two requests race.
      const uses = await Promise.all([
        store.useRecoveryCode(hashRecoveryCode("a"), at),
        store.useRecoveryCode(hashRecoveryCode("a"), at),
      ]);
      expect(uses.filter(Boolean)).toHaveLength(1);
      expect(await store.useRecoveryCode(hashRecoveryCode("z"), at)).toBe(
        false,
      );
      expect((await store.totp()).recoveryCodesLeft).toBe(2);

      await store.disableTotp();
      expect(await store.totp()).toEqual({
        secret: null,
        pendingSecret: null,
        lastTimeStep: null,
        recoveryCodesLeft: 0,
      });
      expect(await database.db.select().from(recoveryCodes)).toEqual([]);
    },
  );

  postgresTest(
    "refuses a TOTP secret that is not sealed",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      await store.createPasswordHash(await hashPassword(password));
      await expect(
        database.db
          .update(owner)
          .set({ totpSecret: "JBSWY3DPEHPK3PXP", totpEnabledAt: new Date() }),
      ).rejects.toThrow();
      await expect(
        database.db
          .update(owner)
          .set({ totpPendingSecret: "JBSWY3DPEHPK3PXP" }),
      ).rejects.toThrow();
      // On means a secret and when it was turned on, together.
      await expect(
        database.db.update(owner).set({ totpEnabledAt: new Date() }),
      ).rejects.toThrow();
      await expect(
        database.db.insert(signInEvents).values({
          occurredAt: new Date(),
          outcome: "failed",
          ip: "203.0.113.7",
          secondFactor: "sms",
        }),
      ).rejects.toThrow();
    },
  );

  postgresTest(
    "turns TOTP on, signs in with a code and a recovery code, and turns it off through the app",
    async ({ database }) => {
      const store = databaseAuthStore(database.db);
      await store.createPasswordHash(await hashPassword(password));
      await checkTotpThroughTheApp(store, async (secret, codes) => {
        const [row] = await database.db.select().from(owner);
        expect(row?.totpSecret).toMatch(/^aio1:1:/);
        expect(row?.totpSecret).not.toContain(secret);
        const stored = await database.db.select().from(recoveryCodes);
        expect(stored.map(({ codeHash }) => codeHash).sort()).toEqual(
          codes.map(hashRecoveryCode).sort(),
        );
      });
    },
  );
});

/**
 * Turns TOTP on through the app, with the fresh proof A1-3 asks for, signs
 * in with a code and a recovery code, and turns it off. `checkStored` looks
 * at how the store keeps the secret and codes once TOTP is on.
 */
async function checkTotpThroughTheApp(
  store: AuthStore,
  checkStored?: (secret: string, codes: string[]) => Promise<void>,
) {
  const clock = { now: new Date("2026-10-08T12:00:00.000Z") };
  const app = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: {
      store,
      secret: testSessionSecret,
      secureCookie: false,
      encryptor: testEncryptor,
      now: () => clock.now,
    },
  });
  const codeNow = (secret: string) =>
    generate({ secret, epoch: Math.floor(clock.now.getTime() / 1000) });
  const nextStep = () => {
    clock.now = new Date(clock.now.getTime() + 30_000);
  };
  const signedIn = await signIn(app, password);
  const post = (
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ) => app.inject({ method: "POST", url, payload, headers });

  // Turning TOTP on needs a fresh proof of the Owner (A1-3): a session
  // alone sets up nothing.
  const unproven = await post("/api/totp/setup", {}, signedIn.headers);
  expect(unproven.statusCode).toBe(403);
  expect(unproven.json()).toMatchObject({ error: "proof_required" });
  expect((await store.totp()).pendingSecret).toBeNull();
  const setup = await post(
    "/api/totp/setup",
    { currentPassword: password },
    signedIn.headers,
  );
  expect(setup.statusCode).toBe(200);
  const { secret } = totpSetupResponseSchema.parse(setup.json());
  const enable = await post(
    "/api/totp/enable",
    { code: await codeNow(secret) },
    signedIn.headers,
  );
  const { recoveryCodes: codes } = totpEnableResponseSchema.parse(
    enable.json(),
  );
  await checkStored?.(secret, codes);

  /** Signs in with the password and `code`; returns the status. */
  const signInWith = async (code: string) => {
    const first = await post("/api/login", { password }, {});
    expect(first.json()).toEqual({ secondFactor: "totp" });
    const challenge = String(first.headers["set-cookie"]).split(";", 1)[0];
    const second = await post(
      "/api/login/totp",
      { code },
      { cookie: challenge ?? "" },
    );
    return second.statusCode;
  };
  nextStep();
  expect(await signInWith(await codeNow(secret))).toBe(200);
  expect(await signInWith(codes[0] ?? "")).toBe(200);
  expect(await signInWith(codes[0] ?? "")).toBe(401);

  const events = await store.signInEventsSince(new Date(0));
  expect(
    events.map(({ outcome, secondFactor }) => [outcome, secondFactor ?? null]),
  ).toEqual([
    ["succeeded", null],
    // The proof is recorded as a sign-in attempt is (A1-4).
    ["succeeded", null],
    ["succeeded", "totp"],
    ["succeeded", "recovery_code"],
    ["failed", "recovery_code"],
  ]);

  nextStep();
  const disable = await post(
    "/api/totp/disable",
    { code: await codeNow(secret) },
    signedIn.headers,
  );
  expect(disable.statusCode).toBe(204);
  expect((await post("/api/login", { password }, {})).json()).toHaveProperty(
    "csrfToken",
  );
  await app.close();
}

// Retention (PRD §7): sign-ins before a cutoff are deleted, and only those.
async function checkSignInRetention(store: AuthStore) {
  for (const occurredAt of [
    "2025-01-01T00:00:00.000Z",
    "2025-10-09T23:59:59.999Z",
    "2025-10-10T00:00:00.000Z",
  ]) {
    await store.recordSignInEvent({
      occurredAt: new Date(occurredAt),
      outcome: "failed",
      ip: "203.0.113.7",
      userAgent: null,
    });
  }
  expect(
    await store.deleteSignInEventsBefore(new Date("2025-10-10T00:00:00.000Z")),
  ).toBe(2);
  expect(
    await store.deleteSignInEventsBefore(new Date("2025-10-10T00:00:00.000Z")),
  ).toBe(0);
}

/** Records three attempts and reads those since the second (A1-7). */
async function checkSignInEventsSince(store: AuthStore) {
  for (const [occurredAt, outcome] of [
    ["2026-10-08T12:00:00.000Z", "failed"],
    ["2026-10-08T12:00:02.000Z", "succeeded"],
    ["2026-10-08T12:00:01.000Z", "failed"],
  ] as const) {
    await store.recordSignInEvent({
      occurredAt: new Date(occurredAt),
      outcome,
      ip: "203.0.113.7",
      userAgent: null,
      ...(outcome === "failed" ? { secondFactor: "totp" as const } : {}),
    });
  }
  expect(
    await store.signInEventsSince(new Date("2026-10-08T12:00:01.000Z")),
  ).toEqual([
    {
      occurredAt: new Date("2026-10-08T12:00:01.000Z"),
      outcome: "failed",
      ip: "203.0.113.7",
      userAgent: null,
      secondFactor: "totp",
    },
    {
      occurredAt: new Date("2026-10-08T12:00:02.000Z"),
      outcome: "succeeded",
      ip: "203.0.113.7",
      userAgent: null,
    },
  ]);
}

describe("sign-in events the limiter starts from (A1-7)", () => {
  it("reads those since a time, oldest first, in memory", async () => {
    await checkSignInEventsSince(memoryAuthStore());
  });

  postgresTest(
    "reads those since a time, oldest first, in Postgres 18",
    async ({ database }) => {
      await checkSignInEventsSince(databaseAuthStore(database.db));
    },
  );
});

describe("TOTP through the app", () => {
  it("turns on with a fresh proof, signs in with a code and a recovery code, and turns off, in memory", async () => {
    await checkTotpThroughTheApp(
      memoryAuthStore({ passwordHash: await hashPassword(password) }),
    );
  });
});

describe("retention of sign-in events", () => {
  it("deletes those before a cutoff, in memory", async () => {
    const store = memoryAuthStore();
    await checkSignInRetention(store);
    expect(
      store.state.signInEvents.map(({ occurredAt }) => occurredAt),
    ).toEqual([new Date("2025-10-10T00:00:00.000Z")]);
  });

  postgresTest(
    "deletes those before a cutoff, in Postgres 18",
    async ({ database }) => {
      await checkSignInRetention(databaseAuthStore(database.db));
      expect(
        (await database.db.select().from(signInEvents)).map(
          ({ occurredAt }) => occurredAt,
        ),
      ).toEqual([new Date("2025-10-10T00:00:00.000Z")]);
    },
  );
});
