import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apiErrorSchema } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testEncryptor, testSessionSecret } from "../test-support.ts";
import { verifyPassword } from "./password.ts";
import { memoryAuthStore } from "./store.ts";

const password = "Tr0ub4dor&3x-setup";
let webDistDir: string;

beforeAll(async () => {
  webDistDir = await mkdtemp(join(tmpdir(), "ai-office-web-"));
  await mkdir(join(webDistDir, "assets"));
  await writeFile(
    join(webDistDir, "index.html"),
    "<!doctype html><p>AI Office",
  );
  await writeFile(join(webDistDir, "assets", "app.js"), "console.log(1);");
});

afterAll(async () => {
  await rm(webDistDir, { recursive: true });
});

/** An app whose routes include one an issue might add later, undeclared. */
async function app(
  store = memoryAuthStore(),
  lines: string[] = [],
): Promise<FastifyInstance> {
  const server = await buildApp({
    logger: createLogger({
      level: "debug",
      secrets: [],
      destination: { write: (line) => lines.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir,
    auth: {
      store,
      secret: testSessionSecret,
      secureCookie: false,
      encryptor: testEncryptor,
    },
  });
  server.get("/api/example", () => ({ ok: true }));
  server.post("/api/example", () => ({ ok: true }));
  return server;
}

const setup = (server: FastifyInstance, body: unknown) =>
  server.inject({ method: "POST", url: "/api/setup", payload: body as object });

/** Every API route the app has, except the ones that need no setup. */
const guardedApiRoutes = (server: FastifyInstance) =>
  server
    .routeAccess()
    .filter(
      ({ url, access, method }) =>
        url.startsWith("/api/") &&
        access !== "public" &&
        access !== "setup" &&
        method !== "HEAD",
    );

describe("before setup", () => {
  it("answers every API route with setup_required", async () => {
    const server = await app();
    const routes = guardedApiRoutes(server);
    expect(routes.map(({ method, url }) => `${method} ${url}`)).toEqual(
      expect.arrayContaining(["GET /api/example", "POST /api/example"]),
    );
    for (const { method, url } of [
      ...routes,
      // Paths with no route say no more than paths with one.
      { method: "GET", url: "/api/nothing" },
      { method: "DELETE", url: "/api/floors/1" },
    ]) {
      const response = await server.inject({
        method: method as "GET",
        url,
      });
      expect({
        route: `${method} ${url}`,
        status: response.statusCode,
      }).toEqual({ route: `${method} ${url}`, status: 403 });
      expect(apiErrorSchema.parse(response.json())).toEqual({
        error: "setup_required",
        message: "AI Office has no password yet; set one at /setup.",
      });
    }
  });

  it.each(["/", "/notices", "/admin?tab=gateway", "/login"])(
    "redirects the page %s to /setup",
    async (url) => {
      const response = await (await app()).inject({ url });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/setup");
    },
  );

  it("serves the setup page, the built files and /health", async () => {
    const server = await app();
    const page = await server.inject({ url: "/setup" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("AI Office");
    expect((await server.inject({ url: "/assets/app.js" })).statusCode).toBe(
      200,
    );
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("has no default password: the store starts empty", async () => {
    const store = memoryAuthStore();
    await app(store);
    expect(await store.passwordHash()).toBeUndefined();
  });
});

describe("POST /api/setup", () => {
  it.each([
    [{ password: "short" }, ["Use at least 12 characters."]],
    [
      { password: "onlylowercase" },
      [
        "Mix at least three of lower case, upper case, digits and symbols, or use 20 or more characters.",
      ],
    ],
    [{}, ["Invalid input: expected string, received undefined"]],
  ])("refuses %j and stores nothing", async (body, problems) => {
    const store = memoryAuthStore();
    const response = await setup(await app(store), body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request", problems });
    expect(store.state.passwordHash).toBeUndefined();
  });

  it("accepts only JSON, so a cross-site form cannot set the password", async () => {
    const store = memoryAuthStore();
    const response = await (
      await app(store)
    ).inject({
      method: "POST",
      url: "/api/setup",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(password)}`,
    });
    expect(response.statusCode).toBe(415);
    expect(store.state.passwordHash).toBeUndefined();
  });

  it("stores an Argon2id hash of the password, never the password", async () => {
    const store = memoryAuthStore();
    const lines: string[] = [];
    const response = await setup(await app(store, lines), { password });
    expect(response.statusCode).toBe(204);

    const stored = store.state.passwordHash ?? "";
    expect(stored).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(stored).not.toContain(password);
    expect(await verifyPassword(stored, password)).toBe(true);
    expect(await verifyPassword(stored, `${password}x`)).toBe(false);
    // The request was logged, but not the password.
    expect(lines.join("")).toContain("The Owner's password was set.");
    expect(lines.join("")).not.toContain(password);
  });

  it("salts each hash", async () => {
    const first = memoryAuthStore();
    const second = memoryAuthStore();
    await setup(await app(first), { password });
    await setup(await app(second), { password });
    expect(first.state.passwordHash).not.toBe(second.state.passwordHash);
  });

  it("lets only one of two concurrent setups set the password", async () => {
    const store = memoryAuthStore();
    const server = await app(store);
    const responses = await Promise.all([
      setup(server, { password }),
      setup(server, { password: "An0ther-passw0rd" }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      204, 404,
    ]);
    const stored = store.state.passwordHash ?? "";
    expect(
      (await verifyPassword(stored, password)) !==
        (await verifyPassword(stored, "An0ther-passw0rd")),
    ).toBe(true);
  });
});

describe("after setup", () => {
  it("makes /setup a 404, as a page and as an API route", async () => {
    const store = memoryAuthStore();
    const server = await app(store);
    expect((await setup(server, { password })).statusCode).toBe(204);
    const stored = store.state.passwordHash;

    const page = await server.inject({ url: "/setup" });
    expect(page.statusCode).toBe(404);
    const again = await setup(server, { password: "An0ther-passw0rd" });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "Not Found" });
    expect(store.state.passwordHash).toBe(stored);
  });

  it("keeps /setup gone after a restart", async () => {
    const store = memoryAuthStore();
    await setup(await app(store), { password });
    const restarted = await app(store);
    expect((await restarted.inject({ url: "/setup" })).statusCode).toBe(404);
    expect((await setup(restarted, { password })).statusCode).toBe(404);
  });

  it("stops answering setup_required, and asks for a sign-in instead", async () => {
    const store = memoryAuthStore();
    const server = await app(store);
    await setup(server, { password });
    for (const url of ["/api/example", "/api/nothing"]) {
      const response = await server.inject({ url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "unauthorized" });
    }
    const login = await server.inject({ url: "/login" });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain("AI Office");
    const page = await server.inject({ url: "/notices" });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/login");

    const { cookie } = await signIn(server, password);
    expect(
      (await server.inject({ url: "/api/example", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ url: "/notices", headers: { cookie } })).body,
    ).toContain("AI Office");
  });
});
