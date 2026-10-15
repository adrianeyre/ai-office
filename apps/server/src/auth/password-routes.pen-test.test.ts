import {
  createdGatewayKeySchema,
  ownerPasswordInfoSchema,
  signedOutEverywhereSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import {
  codeAt,
  cookieFrom,
  enableTotp,
  probedApp,
  type ProbedApp,
} from "../pen-test-support.ts";
import { signIn, testPassword, type SignedIn } from "../test-support.ts";
import { sessionCookie } from "./sessions.ts";
import { signInChallengeCookie } from "./sign-in-challenges.ts";

// A1 probe (pen-testing, "Sign-in and sessions"): what a session may do to
// the Owner's credentials (H5). Position 4: a stolen session cookie, or a
// session begun with a UI-capable API key, which never asks for TOTP.

const attackerPassword = "Pen-Test-Persist-Pass-77";

/** A fresh proof of the Owner (A1-3): what a stolen session lacks. */
interface Proof {
  readonly currentPassword?: string;
  readonly code?: string;
}

/** The Owner's own proof, for steps the Owner takes. */
const ownerProof: Proof = { currentPassword: testPassword };

const addPassword = (
  server: FastifyInstance,
  session: SignedIn,
  password: string,
  name = "Pen test",
  proof: Proof = {},
) =>
  server.inject({
    method: "POST",
    url: "/api/owner-passwords",
    headers: session.headers,
    payload: {
      name,
      nickname: "",
      timeZone: "Europe/London",
      password,
      ...proof,
    },
  });

const signOutEverywhere = (server: FastifyInstance, session: SignedIn) =>
  server.inject({
    method: "POST",
    url: "/api/logout/everywhere",
    headers: session.headers,
  });

/** Signs in with an API key; the session's headers, like `signIn`'s. */
async function signInWithKey(
  server: FastifyInstance,
  key: string,
): Promise<SignedIn> {
  const response = await server.inject({
    method: "POST",
    url: "/api/login/api-key",
    payload: { key },
  });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers["set-cookie"]).split(";", 1)[0] ?? "";
  const { csrfToken, expiresAt } = response.json<{
    csrfToken: string;
    expiresAt: string;
  }>();
  return {
    cookie,
    csrfToken,
    expiresAt,
    headers: { cookie, "x-csrf-token": csrfToken },
  };
}

/** Makes an Owner tool's key with `access`, as a session may. */
const makeKey = (
  server: FastifyInstance,
  session: SignedIn,
  access: "proxy" | "proxy_and_ui",
  name = "Pen test tool",
  proof: Proof = {},
) =>
  server.inject({
    method: "POST",
    url: "/api/gateway-keys",
    headers: session.headers,
    payload: { name, access, ...proof },
  });

/**
 * The Owner with TOTP on, and an attacker holding a session the Owner's
 * own sign-in made (password and code): the stolen cookie.
 */
async function ownerWithTotp(): Promise<
  ProbedApp & {
    readonly stolen: SignedIn;
    readonly secret: string;
    /** Signs the Owner in again, with the password and a fresh code. */
    signInWithCode(): Promise<SignedIn>;
  }
> {
  const probed = await probedApp();
  const { secret } = await enableTotp(probed, await signIn(probed.server));
  const signInWithCode = async (): Promise<SignedIn> => {
    probed.wait(30_000);
    const password = await probed.server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
    });
    const challenge =
      cookieFrom(password.headers["set-cookie"], signInChallengeCookie) ?? "";
    const code = await probed.server.inject({
      method: "POST",
      url: "/api/login/totp",
      payload: { code: await codeAt(secret, probed.clock.now) },
      headers: { cookie: challenge },
    });
    expect(code.statusCode).toBe(200);
    const cookie = cookieFrom(code.headers["set-cookie"], sessionCookie) ?? "";
    const { csrfToken, expiresAt } = code.json<{
      csrfToken: string;
      expiresAt: string;
    }>();
    return {
      cookie,
      csrfToken,
      expiresAt,
      headers: { cookie, "x-csrf-token": csrfToken },
    };
  };
  return {
    ...probed,
    secret,
    stolen: await signInWithCode(),
    signInWithCode,
  };
}

describe("A1-3: a session adds credentials that outlive it, with no fresh proof of the Owner", () => {
  it("adding an Owner password needs the current password, not just a session", async () => {
    const { server } = await probedApp();
    const stolen = await signIn(server);
    const response = await addPassword(server, stolen, attackerPassword);
    expect(response.statusCode).not.toBe(201);
  });

  it("regression (A1-3): a stolen session no longer adds a password that signs in again after sign-out-everywhere", async () => {
    const { server, store } = await probedApp();
    const stolen = await signIn(server);
    const added = await addPassword(server, stolen, attackerPassword);
    expect(added.statusCode).toBe(403);
    expect(added.json()).toMatchObject({ error: "proof_required" });
    // A guess at the password is no proof either.
    const guessed = await addPassword(
      server,
      stolen,
      attackerPassword,
      "Pen test",
      { currentPassword: attackerPassword },
    );
    expect(guessed.statusCode).toBe(422);
    expect(guessed.json()).toMatchObject({ error: "wrong_password" });
    expect(store.state.ownerPasswords.size).toBe(0);
    // The Owner signs out everywhere, and is told what still signs in:
    // only the first password.
    const owner = await signIn(server);
    const out = await signOutEverywhere(server, owner);
    expect(out.statusCode).toBe(200);
    expect(signedOutEverywhereSchema.parse(out.json()).stillSignIn).toEqual({
      passwords: [{ id: "first", name: "The first password, set at setup" }],
      apiKeys: [],
    });
    expect(store.state.sessions.size).toBe(0);
    // ...and the attacker is not back in.
    await expect(signIn(server, attackerPassword)).rejects.toThrow();
  });

  it("making an API key that can sign in needs a fresh proof of the Owner, and the TOTP code when on", async () => {
    const { server, stolen } = await ownerWithTotp();
    const response = await makeKey(server, stolen, "proxy_and_ui");
    expect(response.statusCode).not.toBe(201);
  });

  it("regression (A1-3): with TOTP on, a stolen session no longer mints a UI key that signs in again with no code, after sign-out-everywhere", async () => {
    const probed = await ownerWithTotp();
    const { server, stolen, store, secret } = probed;
    for (const proof of [
      {},
      // The password alone is not enough with TOTP on...
      { currentPassword: testPassword },
      // ...nor with a wrong code.
      { currentPassword: testPassword, code: "000000" },
    ]) {
      const made = await makeKey(
        server,
        stolen,
        "proxy_and_ui",
        "Pen test tool",
        proof,
      );
      expect(made.statusCode).toBeGreaterThanOrEqual(400);
    }
    // No key was made; a proxy-only one, which cannot sign in, still can be.
    expect((await makeKey(server, stolen, "proxy")).statusCode).toBe(201);
    const out = await signOutEverywhere(server, stolen);
    expect(out.statusCode).toBe(200);
    expect(
      signedOutEverywhereSchema.parse(out.json()).stillSignIn.apiKeys,
    ).toEqual([]);
    expect(store.state.sessions.size).toBe(0);
    // The Owner, with password and code, still can: and the answer to
    // sign-out-everywhere names the key that still signs in.
    const owner = await probed.signInWithCode();
    probed.wait(30_000);
    const made = await makeKey(server, owner, "proxy_and_ui", "My laptop", {
      currentPassword: testPassword,
      code: await codeAt(secret, probed.clock.now),
    });
    expect(made.statusCode).toBe(201);
    const { key, gatewayKey } = createdGatewayKeySchema.parse(made.json());
    const outAgain = await signOutEverywhere(server, owner);
    expect(
      signedOutEverywhereSchema.parse(outAgain.json()).stillSignIn.apiKeys,
    ).toEqual([{ id: gatewayKey.id, name: "My laptop" }]);
    // A session begun with that key cannot give a proof, even with the
    // right password: it cannot add a password, nor another UI key.
    const viaKey = await signInWithKey(server, key);
    const fromKey = await addPassword(
      server,
      viaKey,
      attackerPassword,
      "Pen test",
      { currentPassword: testPassword },
    );
    expect(fromKey.statusCode).toBe(403);
    expect(fromKey.json()).toMatchObject({ error: "proof_required" });
    expect(
      (
        await makeKey(server, viaKey, "proxy_and_ui", "Another", {
          currentPassword: testPassword,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("turning TOTP on needs the current password, so a stolen session cannot lock the Owner out with its own secret", async () => {
    const { server } = await probedApp();
    const stolen = await signIn(server);
    const response = await server.inject({
      method: "POST",
      url: "/api/totp/setup",
      headers: stolen.headers,
    });
    expect(response.statusCode).not.toBe(200);
  });

  it("regression (A1-3): a stolen session no longer turns TOTP on with the attacker's secret, and the Owner's password alone still signs in", async () => {
    const probed = await probedApp();
    const stolen = await signIn(probed.server);
    for (const payload of [undefined, { currentPassword: attackerPassword }]) {
      const setup = await probed.server.inject({
        method: "POST",
        url: "/api/totp/setup",
        headers: stolen.headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(setup.statusCode).toBeGreaterThanOrEqual(400);
      expect(setup.json()).not.toHaveProperty("secret");
    }
    expect((await probed.store.totp()).pendingSecret).toBeNull();
    const owner = await probed.server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).not.toEqual({ secondFactor: "totp" });
  });
});

describe("A1-3 · the sibling paths: widening a key, and the Owner's own steps", () => {
  /** Changes an Owner tool's key, as API Key Management does. */
  const changeKey = (
    server: FastifyInstance,
    session: SignedIn,
    keyId: string,
    changes: object,
  ) =>
    server.inject({
      method: "PATCH",
      url: `/api/gateway-keys/${keyId}`,
      headers: session.headers,
      payload: changes,
    });

  it("giving a proxy-only key UI access needs the proof", async () => {
    const { server } = await probedApp();
    const stolen = await signIn(server);
    const { gatewayKey } = createdGatewayKeySchema.parse(
      (await makeKey(server, stolen, "proxy")).json(),
    );
    const widened = await changeKey(server, stolen, gatewayKey.id, {
      access: "proxy_and_ui",
    });
    expect(widened.statusCode).toBe(403);
    expect(widened.json()).toMatchObject({ error: "proof_required" });
    const proven = await changeKey(server, stolen, gatewayKey.id, {
      access: "proxy_and_ui",
      ...ownerProof,
    });
    expect(proven.statusCode).toBe(200);
    expect(proven.json()).toMatchObject({ access: "proxy_and_ui" });
  });

  it("enabling a disabled UI key again needs the proof; disabling it, or narrowing it, does not", async () => {
    const { server } = await probedApp();
    const owner = await signIn(server);
    const { gatewayKey } = createdGatewayKeySchema.parse(
      (
        await makeKey(server, owner, "proxy_and_ui", "Laptop", ownerProof)
      ).json(),
    );
    expect(
      (await changeKey(server, owner, gatewayKey.id, { enabled: false }))
        .statusCode,
    ).toBe(200);
    const again = await changeKey(server, owner, gatewayKey.id, {
      enabled: true,
    });
    expect(again.statusCode).toBe(403);
    expect(
      (
        await changeKey(server, owner, gatewayKey.id, {
          enabled: true,
          ...ownerProof,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await changeKey(server, owner, gatewayKey.id, { access: "proxy" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await changeKey(server, owner, gatewayKey.id, { name: "Old laptop" }))
        .statusCode,
    ).toBe(200);
  });

  it("the proof never reaches the key it guards, a log line or the Activity Feed", async () => {
    const { server, lines, feed } = await probedApp();
    const owner = await signIn(server);
    const made = await makeKey(
      server,
      owner,
      "proxy_and_ui",
      "Laptop",
      ownerProof,
    );
    expect(made.statusCode).toBe(201);
    expect(made.json()).not.toHaveProperty("gatewayKey.currentPassword");
    expect(lines.join("\n")).not.toContain(testPassword);
    expect(JSON.stringify(feed)).not.toContain(testPassword);
  });

  it("the Owner adds a password with the current one, and with the code when TOTP is on", async () => {
    const probed = await ownerWithTotp();
    const { server, secret } = probed;
    const owner = await probed.signInWithCode();
    expect(
      (await addPassword(server, owner, attackerPassword, "Sam", ownerProof))
        .statusCode,
    ).toBe(403);
    probed.wait(30_000);
    const added = await addPassword(server, owner, attackerPassword, "Sam", {
      ...ownerProof,
      code: await codeAt(secret, probed.clock.now),
    });
    expect(added.statusCode).toBe(201);
  });
});

describe("A1-3 where it holds", () => {
  it("turning TOTP off needs a current code, so a stolen session cannot", async () => {
    const { server, stolen, store } = await ownerWithTotp();
    const response = await server.inject({
      method: "POST",
      url: "/api/totp/disable",
      headers: stolen.headers,
      payload: { code: "000000" },
    });
    expect(response.statusCode).toBe(422);
    expect((await store.totp()).secret).not.toBeNull();
  });

  it("a proxy-only Gateway Key, as every Agent's (what a sandbox holds) is, cannot sign in", async () => {
    const { server } = await probedApp();
    const owner = await signIn(server);
    const proxy = await makeKey(server, owner, "proxy", "Proxy only");
    const { key } = createdGatewayKeySchema.parse(proxy.json());
    const response = await server.inject({
      method: "POST",
      url: "/api/login/api-key",
      payload: { key },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "wrong_api_key" });
  });

  it("revoking a UI key ends the sessions it began, at once", async () => {
    const { server } = await probedApp();
    const owner = await signIn(server);
    const made = await makeKey(
      server,
      owner,
      "proxy_and_ui",
      "Pen test tool",
      ownerProof,
    );
    const { key, gatewayKey } = createdGatewayKeySchema.parse(made.json());
    const viaKey = await signInWithKey(server, key);
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/api/gateway-keys/${gatewayKey.id}`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await server.inject({
          url: "/api/session",
          headers: { cookie: viaKey.cookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("removing an Owner password ends the sessions it began", async () => {
    const { server } = await probedApp();
    const owner = await signIn(server);
    const added = ownerPasswordInfoSchema.parse(
      (
        await addPassword(
          server,
          owner,
          attackerPassword,
          "Pen test",
          ownerProof,
        )
      ).json(),
    );
    const viaAdded = await signIn(server, attackerPassword);
    await server.inject({
      method: "DELETE",
      url: `/api/owner-passwords/${added.id}`,
      headers: owner.headers,
    });
    expect(
      (
        await server.inject({
          url: "/api/session",
          headers: { cookie: viaAdded.cookie },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("A1-4: 409 password_in_use as an oracle", () => {
  /**
   * Guesses as an attacker would. Since A1-3 the route checks a fresh
   * proof before it compares the new password, so a session without the
   * Owner's password guesses through `currentPassword`: a miss is answered
   * 422, and a hit confirmed by the password being added (201), which the
   * attacker takes away again.
   */
  async function guess(
    server: FastifyInstance,
    session: SignedIn,
    candidate: string,
  ): Promise<number> {
    const response = await addPassword(
      server,
      session,
      attackerPassword,
      "Pen test",
      { currentPassword: candidate },
    );
    if (response.statusCode === 201) {
      const { id } = ownerPasswordInfoSchema.parse(response.json());
      await server.inject({
        method: "DELETE",
        url: `/api/owner-passwords/${id}`,
        headers: session.headers,
      });
    }
    return response.statusCode;
  }

  const misses = Array.from(
    { length: 10 },
    (_, index) => `Dictionary-Guess-${String(index).padStart(3, "0")}x`,
  );

  it("a session cannot test guesses at the Owner's password without limit", async () => {
    const { server } = await probedApp();
    const stolen = await signIn(server);
    for (const candidate of misses) {
      await guess(server, stolen, candidate);
    }
    // After ten misses the route must refuse, not confirm the password
    // (201 since A1-3; 409 before it).
    expect(await guess(server, stolen, testPassword)).not.toBe(201);
  });

  it("regression (A1-4): misses are no longer answered without limit, nor the Owner's own confirmed, and every guess is on record", async () => {
    const { server, feed, store } = await probedApp();
    const stolen = await signIn(server);
    const before = feed.length;
    const statuses: number[] = [];
    for (const candidate of misses) {
      statuses.push(await guess(server, stolen, candidate));
    }
    // Five free misses, as at sign-in, then the limiter refuses.
    expect(statuses).toEqual([
      ...Array<number>(5).fill(422),
      ...Array<number>(5).fill(429),
    ]);
    expect(await guess(server, stolen, testPassword)).toBe(429);
    expect(store.state.ownerPasswords.size).toBe(0);
    // Each checked guess is a failed sign-in attempt, and the lockout is
    // in the Activity Feed, never the guess itself.
    const events = feed.slice(before).map(({ event }) => event.type);
    expect(events).toEqual([
      ...Array<string>(5).fill("sign_in.failed"),
      "sign_in.locked_out",
    ]);
    expect(
      store.state.signInEvents.filter(({ outcome }) => outcome === "failed"),
    ).toHaveLength(5);
    expect(JSON.stringify(feed)).not.toContain("Dictionary-Guess");
  });
});

describe("A1-4 · every route that checks a fresh proof is limited and recorded", () => {
  const guessesThrough: readonly (readonly [
    string,
    (
      server: FastifyInstance,
      session: SignedIn,
      guess: string,
    ) => Promise<number>,
  ])[] = [
    [
      "making an API key with UI access",
      async (server, session, candidate) =>
        (
          await makeKey(server, session, "proxy_and_ui", "Pen test", {
            currentPassword: candidate,
          })
        ).statusCode,
    ],
    [
      "giving a key UI access",
      async (server, session, candidate) => {
        // A proxy-only key needs no proof to make.
        const made = await makeKey(
          server,
          session,
          "proxy",
          `Tool ${candidate}`,
        );
        const { id } = createdGatewayKeySchema.parse(made.json()).gatewayKey;
        return (
          await server.inject({
            method: "PATCH",
            url: `/api/gateway-keys/${id}`,
            headers: session.headers,
            payload: { access: "proxy_and_ui", currentPassword: candidate },
          })
        ).statusCode;
      },
    ],
    [
      "turning TOTP on",
      async (server, session, candidate) =>
        (
          await server.inject({
            method: "POST",
            url: "/api/totp/setup",
            headers: session.headers,
            payload: { currentPassword: candidate },
          })
        ).statusCode,
    ],
  ];

  it.each(guessesThrough)(
    "%s: five wrong passwords, then 429, each a failed sign-in attempt",
    async (_, through) => {
      const { server, feed, store } = await probedApp();
      const stolen = await signIn(server);
      const statuses: number[] = [];
      for (let guess = 1; guess <= 6; guess += 1) {
        statuses.push(
          await through(server, stolen, `Wrong-Guess-${String(guess)}x`),
        );
      }
      expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
      // Locked out, even the right password is refused for now.
      expect(await through(server, stolen, testPassword)).toBe(429);
      expect(
        feed.filter(({ event }) => event.type === "sign_in.failed"),
      ).toHaveLength(5);
      expect(
        store.state.signInEvents.filter(({ outcome }) => outcome === "failed"),
      ).toHaveLength(5);
    },
  );

  it("shares one limit with sign-ins: guesses here lock out sign-in from the same client", async () => {
    const { server } = await probedApp();
    const stolen = await signIn(server);
    for (let guess = 1; guess <= 5; guess += 1) {
      await addPassword(server, stolen, attackerPassword, "Pen test", {
        currentPassword: `Wrong-Guess-${String(guess)}x`,
      });
    }
    const login = await server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
    });
    expect(login.statusCode).toBe(429);
  });

  it("with TOTP on, guesses at the code are limited and recorded too", async () => {
    const probed = await ownerWithTotp();
    const { server, stolen, store } = probed;
    const before = store.state.signInEvents.length;
    const statuses: number[] = [];
    for (let guess = 1; guess <= 6; guess += 1) {
      const response = await addPassword(
        server,
        stolen,
        attackerPassword,
        "Pen test",
        { currentPassword: testPassword, code: String(100_000 + guess) },
      );
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
    expect(
      store.state.signInEvents
        .slice(before)
        .map(({ outcome, secondFactor }) => ({ outcome, secondFactor })),
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        outcome: "failed",
        secondFactor: "totp",
      })),
    );
  });

  it("a right proof is recorded in sign_in_events, but is no sign-in for the Activity Feed", async () => {
    const { server, feed, store } = await probedApp();
    const owner = await signIn(server);
    const before = {
      feed: feed.length,
      events: store.state.signInEvents.length,
    };
    expect(
      (await addPassword(server, owner, attackerPassword, "Sam", ownerProof))
        .statusCode,
    ).toBe(201);
    expect(
      store.state.signInEvents
        .slice(before.events)
        .map(({ outcome }) => outcome),
    ).toEqual(["succeeded"]);
    expect(
      feed
        .slice(before.feed)
        .filter(({ event }) => event.type.startsWith("sign_in")),
    ).toEqual([]);
  });
});

describe("A1-5: changes to the Owner's credentials in the Activity Feed (FR-52)", () => {
  type Step = (probed: ProbedApp, owner: SignedIn) => Promise<unknown>;
  const nothing: Step = () => Promise.resolve();
  /** The secret the Owner scanned, kept by the step that turned TOTP on. */
  let scanned = "";

  /** Each change, how to prepare and make it, and the key it is named by. */
  const changes: readonly (readonly [string, Step, Step, string])[] = [
    [
      "adding an Owner password",
      nothing,
      async ({ server }, owner) => {
        expect(
          (
            await addPassword(
              server,
              owner,
              attackerPassword,
              "Pen test",
              ownerProof,
            )
          ).statusCode,
        ).toBe(201);
      },
      "ownerPasswords.added",
    ],
    [
      "removing an Owner password",
      ({ server }, owner) =>
        addPassword(
          server,
          owner,
          `${attackerPassword}-old`,
          "Old",
          ownerProof,
        ),
      async ({ server }, owner) => {
        const [added] = (
          await server.inject({
            url: "/api/owner-passwords",
            headers: owner.headers,
          })
        )
          .json<{ passwords: { id: string; first: boolean }[] }>()
          .passwords.filter(({ first }) => !first);
        expect(
          (
            await server.inject({
              method: "DELETE",
              url: `/api/owner-passwords/${added?.id ?? ""}`,
              headers: owner.headers,
            })
          ).statusCode,
        ).toBe(204);
      },
      "ownerPasswords.removed",
    ],
    [
      "turning TOTP on",
      nothing,
      async (probed, owner) => {
        await enableTotp(probed, owner);
      },
      "totp.enabled",
    ],
    [
      "turning TOTP off",
      async (probed, owner) => {
        ({ secret: scanned } = await enableTotp(probed, owner));
      },
      async (probed, owner) => {
        probed.wait(30_000);
        const response = await probed.server.inject({
          method: "POST",
          url: "/api/totp/disable",
          headers: owner.headers,
          payload: { code: await codeAt(scanned, probed.clock.now) },
        });
        expect(response.statusCode).toBe(204);
      },
      "totp.disabled",
    ],
  ];

  /** The app, signed in, and the feed's events after `change`. */
  async function feedAfter(prepare: Step, change: Step) {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    await prepare(probed, owner);
    const before = probed.feed.length;
    await change(probed, owner);
    return probed.feed.slice(before).map(({ event }) => event);
  }

  describe.each(changes)("%s", (_, prepare, change, key) => {
    it("is recorded in the Activity Feed", async () => {
      expect(await feedAfter(prepare, change)).toContainEqual(
        expect.objectContaining({ type: "config.changed" }),
      );
    });

    it("regression (A1-5): no longer leaves nothing in the Activity Feed, and names the change, never the secret", async () => {
      const events = await feedAfter(prepare, change);
      expect(events).not.toEqual([]);
      // Exactly this, so no password, secret or code: and the proof or
      // code the change took is no sign-in.
      expect(events).toEqual([
        { type: "config.changed", version: 1, scope: "security", keys: [key] },
      ]);
    });
  });

  it("A1-5 sibling: setting the first password at setup is recorded, without it", async () => {
    const { server, feed } = await probedApp({ setUp: false });
    const setup = await server.inject({
      method: "POST",
      url: "/api/setup",
      payload: { password: testPassword },
    });
    expect(setup.statusCode).toBe(204);
    expect(feed.map(({ event }) => event)).toEqual([
      {
        type: "config.changed",
        version: 1,
        scope: "security",
        keys: ["ownerPasswords.firstSet"],
      },
    ]);
  });

  it("holds for Gateway Keys: making one is recorded, without the key", async () => {
    const { server, feed } = await probedApp();
    const owner = await signIn(server);
    const before = feed.length;
    const made = await makeKey(
      server,
      owner,
      "proxy_and_ui",
      "Pen test tool",
      ownerProof,
    );
    const { key } = createdGatewayKeySchema.parse(made.json());
    expect(feed.slice(before).map(({ event }) => event)).toEqual([
      {
        type: "config.changed",
        version: 1,
        scope: "gateway",
        keys: ["gatewayKeys.created"],
      },
    ]);
    expect(JSON.stringify(feed)).not.toContain(key);
  });
});

describe("A1-9: retiring the first Owner password", () => {
  const replacement = "Pen-Test-Replacement-Pass-13";

  /**
   * Asks to replace the first password, the only way the API offers: its
   * settings and the new password, and since the fix the proof of it.
   */
  const replaceFirst = (
    server: FastifyInstance,
    owner: SignedIn,
    proof: Proof = {},
  ) =>
    server.inject({
      method: "PUT",
      url: "/api/owner-passwords/first",
      headers: owner.headers,
      payload: {
        name: "Owner",
        nickname: "",
        timeZone: "Europe/London",
        password: replacement,
        ...proof,
      },
    });

  it("the Owner can replace the first password, so a leaked one stops signing in", async () => {
    const { server } = await probedApp();
    const owner = await signIn(server);
    await replaceFirst(server, owner, ownerProof);
    const old = await server.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: testPassword },
    });
    expect(old.statusCode).toBe(401);
  });

  it("regression (A1-9): the first password is no longer one that can be neither changed nor removed and keeps signing in", async () => {
    const { server, store, feed } = await probedApp();
    const owner = await signIn(server);
    const other = await signIn(server);
    const before = store.state.passwordHash;
    // The password in the body is no longer ignored: without the proof of
    // the first password it is refused, and nothing changes.
    const unproven = await replaceFirst(server, owner);
    expect(unproven.statusCode).toBe(403);
    expect(unproven.json()).toMatchObject({ error: "proof_required" });
    expect(store.state.passwordHash).toBe(before);
    // With it, the first password is replaced...
    const replaced = await replaceFirst(server, owner, ownerProof);
    expect(replaced.statusCode).toBe(200);
    expect(store.state.passwordHash).not.toBe(before);
    // ...the sessions it began end, this one and every other...
    for (const cookie of [owner.cookie, other.cookie]) {
      expect(
        (await server.inject({ url: "/api/session", headers: { cookie } }))
          .statusCode,
      ).toBe(401);
    }
    expect(String(replaced.headers["set-cookie"])).toMatch(/Max-Age=0/);
    // ...the old one no longer signs in, and the new one does.
    await expect(signIn(server)).rejects.toThrow();
    await signIn(server, replacement);
    // It still cannot be removed: it is replaced instead.
    const removed = await server.inject({
      method: "DELETE",
      url: "/api/owner-passwords/first",
      headers: (await signIn(server, replacement)).headers,
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toMatchObject({
      error: "first_password_not_removable",
    });
    // The change is in the Activity Feed (A1-5), never the password.
    expect(
      feed
        .map(({ event }) => event)
        .filter(
          (event) =>
            event.type === "config.changed" && event.scope === "security",
        ),
    ).toEqual([
      {
        type: "config.changed",
        version: 1,
        scope: "security",
        keys: ["ownerPasswords.replaced"],
      },
    ]);
    expect(JSON.stringify(feed)).not.toContain(replacement);
  });
});

describe("A1-9 · the sibling paths: replacing any Owner password", () => {
  const replacement = "Pen-Test-Replacement-Pass-14";
  const samsPassword = "Pen-Test-Sams-Password-15";

  const replace = (
    server: FastifyInstance,
    session: SignedIn,
    id: string,
    proof: Proof,
    password = replacement,
  ) =>
    server.inject({
      method: "PUT",
      url: `/api/owner-passwords/${id}`,
      headers: session.headers,
      payload: {
        name: "Sam",
        nickname: "",
        timeZone: "Europe/London",
        password,
        ...proof,
      },
    });

  /** The Owner, and Sam with a further password and a session begun with it. */
  async function withSam() {
    const probed = await probedApp();
    const owner = await signIn(probed.server);
    const sam = ownerPasswordInfoSchema.parse(
      (
        await addPassword(probed.server, owner, samsPassword, "Sam", ownerProof)
      ).json(),
    );
    return {
      ...probed,
      owner,
      sam,
      samsSession: await signIn(probed.server, samsPassword),
    };
  }

  it("a further password is replaced with proof of itself, ending only its own sessions", async () => {
    const { server, owner, sam, samsSession } = await withSam();
    const replaced = await replace(server, samsSession, sam.id, {
      currentPassword: samsPassword,
    });
    expect(replaced.statusCode).toBe(200);
    const live = async (cookie: string) =>
      (await server.inject({ url: "/api/session", headers: { cookie } }))
        .statusCode;
    expect(await live(samsSession.cookie)).toBe(401);
    expect(await live(owner.cookie)).toBe(200);
    await expect(signIn(server, samsPassword)).rejects.toThrow();
    await signIn(server, replacement);
  });

  it("the proof must be the password being replaced, not another Owner password", async () => {
    const { server, store, owner, sam, samsSession } = await withSam();
    const first = store.state.passwordHash;
    // Sam cannot replace the first with Sam's own password...
    const bySam = await replace(server, samsSession, "first", {
      currentPassword: samsPassword,
    });
    expect(bySam.statusCode).toBe(422);
    expect(bySam.json()).toMatchObject({ error: "wrong_password" });
    expect(store.state.passwordHash).toBe(first);
    // ...nor the first holder Sam's with the first.
    const byOwner = await replace(server, owner, sam.id, ownerProof);
    expect(byOwner.statusCode).toBe(422);
    // Each is a failed attempt, limited and recorded as sign-ins are.
    expect(
      store.state.signInEvents.filter(({ outcome }) => outcome === "failed"),
    ).toHaveLength(2);
  });

  it("with TOTP on, it needs the code too; a session begun with an API key cannot", async () => {
    const probed = await ownerWithTotp();
    const { server, stolen, secret } = probed;
    expect(
      (await replace(server, stolen, "first", ownerProof)).statusCode,
    ).toBe(403);
    probed.wait(30_000);
    const made = await makeKey(server, stolen, "proxy_and_ui", "Laptop", {
      ...ownerProof,
      code: await codeAt(secret, probed.clock.now),
    });
    const viaKey = await signInWithKey(
      server,
      createdGatewayKeySchema.parse(made.json()).key,
    );
    probed.wait(30_000);
    const fromKey = await replace(server, viaKey, "first", {
      ...ownerProof,
      code: await codeAt(secret, probed.clock.now),
    });
    expect(fromKey.statusCode).toBe(403);
    expect(fromKey.json()).toMatchObject({ error: "proof_required" });
    probed.wait(30_000);
    expect(
      (
        await replace(server, stolen, "first", {
          ...ownerProof,
          code: await codeAt(secret, probed.clock.now),
        })
      ).statusCode,
    ).toBe(200);
  });

  it("the new password must be unlike every Owner password, the one it replaces included", async () => {
    const { server, store, sam, samsSession } = await withSam();
    for (const password of [samsPassword, testPassword]) {
      const response = await replace(
        server,
        samsSession,
        sam.id,
        { currentPassword: samsPassword },
        password,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "password_in_use" });
    }
    // A weak one is refused before any proof is checked.
    expect(
      (
        await replace(
          server,
          samsSession,
          sam.id,
          { currentPassword: samsPassword },
          "short",
        )
      ).statusCode,
    ).toBe(400);
    expect(store.state.sessions.size).toBe(2);
  });

  it("a password that is not there is a 404, with no proof checked", async () => {
    const { server, owner, store } = await withSam();
    const attempts = store.state.signInEvents.length;
    const response = await replace(server, owner, "nobody", ownerProof);
    expect(response.statusCode).toBe(404);
    expect(store.state.signInEvents).toHaveLength(attempts);
  });

  it("renaming a password still needs no proof", async () => {
    const { server, owner } = await withSam();
    const renamed = await server.inject({
      method: "PUT",
      url: "/api/owner-passwords/first",
      headers: owner.headers,
      payload: { name: "Ada", nickname: "", timeZone: "Europe/London" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Ada" });
  });
});
