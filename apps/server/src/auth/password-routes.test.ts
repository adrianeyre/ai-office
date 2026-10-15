import {
  ownerPasswordInfoSchema,
  ownerPasswordListSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testPassword,
  type SignedIn,
} from "../test-support.ts";

// The Owner's passwords (API Key Management): one per person who signs in.
// Each signs in, the session says which, and removing one signs it out.
// Adding one takes the current password (A1-3).

const second = "Correct-Horse-Battery-9";

async function setUp(): Promise<{
  server: FastifyInstance;
  owner: SignedIn;
}> {
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
  });
  return { server, owner: await signIn(server) };
}

const call = (
  { server, owner }: { server: FastifyInstance; owner: SignedIn },
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

describe("the Owner's passwords", () => {
  it("lists the first, adds another that signs in, and names who signed in", async () => {
    const setup = await setUp();
    const before = ownerPasswordListSchema.parse(
      (await call(setup, "GET", "/api/owner-passwords")).json(),
    );
    expect(before.passwords).toEqual([
      {
        id: "first",
        first: true,
        name: "Owner",
        nickname: "",
        timeZone: "Europe/London",
        createdAt: null,
        lastUsedAt: null,
      },
    ]);

    const added = await call(setup, "POST", "/api/owner-passwords", {
      currentPassword: testPassword,
      name: "Sam",
      password: second,
    });
    expect(added.statusCode).toBe(201);
    const sam = ownerPasswordInfoSchema.parse(added.json());
    expect(sam).toMatchObject({ name: "Sam", first: false, lastUsedAt: null });
    expect(JSON.stringify(added.json())).not.toContain(second);

    const samSignedIn = await signIn(setup.server, second);
    const session = await setup.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: samSignedIn.cookie },
    });
    expect(session.json()).toMatchObject({ passwordId: sam.id });
    const ownerSession = await setup.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: setup.owner.cookie },
    });
    expect(ownerSession.json()).toMatchObject({ passwordId: null });

    const listed = ownerPasswordListSchema.parse(
      (await call(setup, "GET", "/api/owner-passwords")).json(),
    ).passwords;
    expect(listed.find(({ id }) => id === sam.id)?.lastUsedAt).not.toBeNull();
  });

  it("refuses a weak password, or one another Owner password already is", async () => {
    const setup = await setUp();
    expect(
      (
        await call(setup, "POST", "/api/owner-passwords", {
          currentPassword: testPassword,
          name: "Weak",
          password: "short",
        })
      ).statusCode,
    ).toBe(400);
    const same = await call(setup, "POST", "/api/owner-passwords", {
      currentPassword: testPassword,
      name: "Copy",
      password: "Tr0ub4dor&3x-tests",
    });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ error: "password_in_use" });
  });

  it("names the first password through the Owner's profile, and renames another", async () => {
    const setup = await setUp();
    const first = await call(setup, "PUT", "/api/owner-passwords/first", {
      name: "Adrian",
      nickname: "Ade",
      timeZone: "Asia/Tokyo",
    });
    expect(first.statusCode).toBe(200);
    expect((await call(setup, "GET", "/api/office/profile")).json()).toEqual({
      forename: "Adrian",
      surname: "",
      nickname: "Ade",
      timeZone: "Asia/Tokyo",
    });
    const sam = ownerPasswordInfoSchema.parse(
      (
        await call(setup, "POST", "/api/owner-passwords", {
          currentPassword: testPassword,
          name: "Sam",
          password: second,
        })
      ).json(),
    );
    const renamed = await call(setup, "PUT", `/api/owner-passwords/${sam.id}`, {
      name: "Samantha",
      nickname: "Sam",
      timeZone: "America/New_York",
    });
    expect(renamed.json()).toMatchObject({
      name: "Samantha",
      nickname: "Sam",
      timeZone: "America/New_York",
    });
    expect(
      (
        await call(setup, "PUT", `/api/owner-passwords/${sam.id}`, {
          name: "Samantha",
          nickname: "",
          timeZone: "Mars/Olympus",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("removes another password, signing it out; never the first", async () => {
    const setup = await setUp();
    const sam = ownerPasswordInfoSchema.parse(
      (
        await call(setup, "POST", "/api/owner-passwords", {
          currentPassword: testPassword,
          name: "Sam",
          password: second,
        })
      ).json(),
    );
    const samSignedIn = await signIn(setup.server, second);
    expect(
      (await call(setup, "DELETE", `/api/owner-passwords/${sam.id}`))
        .statusCode,
    ).toBe(204);
    const session = await setup.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: samSignedIn.cookie },
    });
    expect(session.statusCode).toBe(401);
    expect(
      (
        await setup.server.inject({
          method: "POST",
          url: "/api/login",
          payload: { password: second },
        })
      ).statusCode,
    ).toBe(401);
    const first = await call(setup, "DELETE", "/api/owner-passwords/first");
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({
      error: "first_password_not_removable",
    });
  });
});
