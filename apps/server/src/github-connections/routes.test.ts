import { createLiveGitHub } from "@ai-office/github";
import { createGitHubConnections, memoryStores } from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  githubConnectionListSchema,
  githubConnectionSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  type SignedIn,
} from "../test-support.ts";

// The GitHub connections through the API (ADR 0011): the Owner adds GitHub
// Apps and access tokens in Floor Settings, renames, disables and removes
// them; no answer ever carries a key or a token, and the live GitHub takes
// each change up at once.

const pem =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAwxyz\n-----END RSA PRIVATE KEY-----";
const writer = "github_pat_11AAAAAAA0writer9f3c";
const reader = "github_pat_11AAAAAAA0reader7b2e";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly live: ReturnType<typeof createLiveGitHub>;
  readonly stores: ReturnType<typeof memoryStores>;
}

let current: FastifyInstance | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setUp(): Promise<Setup> {
  const stores = memoryStores();
  const live = createLiveGitHub();
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    stores,
    github: live,
    githubConnections: createGitHubConnections({
      store: stores.githubConnections,
      encryptor: testEncryptor,
      live,
    }),
  });
  current = server;
  return { server, owner: await signIn(server), live, stores };
}

const call = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

describe("GitHub connections", () => {
  it("adds GitHub Apps and access tokens, lists them Apps first, and never gives a key or token back", async () => {
    const setup = await setUp();
    expect(
      githubConnectionListSchema.parse(
        (await call(setup, "GET", "/api/github/connections")).json(),
      ),
    ).toEqual({ connections: [] });

    const token = await call(
      setup,
      "POST",
      "/api/github/connections/access-tokens",
      { name: "My account", token: writer, readOnlyToken: reader },
    );
    expect(token.statusCode).toBe(201);
    expect(githubConnectionSchema.parse(token.json())).toMatchObject({
      kind: "access-token",
      name: "My account",
      hint: "9f3c",
      enabled: true,
    });
    const app = await call(setup, "POST", "/api/github/connections/apps", {
      appId: "123456",
      privateKey: pem,
    });
    expect(app.statusCode).toBe(201);
    expect(githubConnectionSchema.parse(app.json())).toMatchObject({
      kind: "app",
      name: "GitHub App 123456",
      appId: "123456",
    });
    expect(setup.live.size).toBe(2);

    const listed = await call(setup, "GET", "/api/github/connections");
    expect(
      githubConnectionListSchema
        .parse(listed.json())
        .connections.map(({ kind }) => kind),
    ).toEqual(["app", "access-token"]);
    for (const text of [token.body, app.body, listed.body]) {
      expect(text).not.toContain("MIIE");
      expect(text).not.toContain(writer);
      expect(text).not.toContain(reader);
    }
    // Kept sealed.
    const kept = [...setup.stores.githubConnections.connections.values()];
    expect(JSON.stringify(kept)).not.toContain(writer);

    const again = await call(setup, "POST", "/api/github/connections/apps", {
      appId: "123456",
      privateKey: pem,
    });
    expect(again.statusCode).toBe(409);
    expect(apiErrorSchema.parse(again.json()).error).toBe("github_app_taken");
  });

  it("refuses what is not an App or a token, without repeating it", async () => {
    const setup = await setUp();
    const refused = await call(
      setup,
      "POST",
      "/api/github/connections/access-tokens",
      { token: "github_pat_hunter2-but-it-is-fine", readOnlyToken: "hunter2" },
    );
    expect(refused.statusCode).toBe(400);
    expect(apiErrorSchema.parse(refused.json()).problems).toEqual([
      "The read-only access token is not a GitHub access token.",
    ]);
    expect(refused.body).not.toContain("hunter2");
    const app = await call(setup, "POST", "/api/github/connections/apps", {
      appId: "acme",
      privateKey: "secret-hunter2",
    });
    expect(app.statusCode).toBe(400);
    expect(app.body).not.toContain("hunter2");
    expect(setup.live.size).toBe(0);
  });

  it("renames, disables and removes one, the live GitHub keeping up", async () => {
    const setup = await setUp();
    const { id } = githubConnectionSchema.parse(
      (
        await call(setup, "POST", "/api/github/connections/apps", {
          appId: "1",
          privateKey: pem,
        })
      ).json(),
    );
    const path = `/api/github/connections/${id}`;
    const disabled = await call(setup, "PATCH", path, {
      name: "Acme",
      enabled: false,
    });
    expect(disabled.statusCode).toBe(200);
    expect(githubConnectionSchema.parse(disabled.json())).toMatchObject({
      name: "Acme",
      enabled: false,
    });
    expect(setup.live.size).toBe(0);
    expect((await call(setup, "PATCH", path, {})).statusCode).toBe(400);
    await call(setup, "PATCH", path, { enabled: true });
    expect(setup.live.size).toBe(1);

    expect((await call(setup, "DELETE", path)).statusCode).toBe(204);
    expect(setup.live.size).toBe(0);
    expect((await call(setup, "DELETE", path)).statusCode).toBe(404);
    expect(
      (await call(setup, "PATCH", path, { enabled: true })).statusCode,
    ).toBe(404);
  });

  it("is the signed-in Owner's alone, each change with the CSRF token", async () => {
    const setup = await setUp();
    expect(
      (
        await setup.server.inject({
          method: "GET",
          url: "/api/github/connections",
        })
      ).statusCode,
    ).toBe(401);
    const withoutCsrf = await setup.server.inject({
      method: "POST",
      url: "/api/github/connections/apps",
      headers: { cookie: setup.owner.cookie },
      payload: { appId: "1", privateKey: pem },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(setup.live.size).toBe(0);
  });
});
