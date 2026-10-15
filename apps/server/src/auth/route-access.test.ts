import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { testAuth, webBuild } from "../test-support.ts";
import type { RouteAccess } from "./access.ts";

// The route-registration test (PRD FR-2): every route must require a
// session, unless it is on this list. Adding a route that declares no
// access, or that exempts itself without being listed here, fails it.
const exemptions: Readonly<Record<string, RouteAccess>> = {
  // Compose health checks call it, before setup and without a session.
  "GET /health": "public",
  "HEAD /health": "public",
  // Crawlers read them without a session; they hold no data.
  "GET /robots.txt": "public",
  "HEAD /robots.txt": "public",
  "GET /sitemap.xml": "public",
  "HEAD /sitemap.xml": "public",
  // The first-run setup screen; a 404 once the password exists.
  "POST /api/setup": "setup",
  "POST /api/login": "sign-in",
  // The second step of a sign-in with TOTP on; it needs the challenge
  // cookie that a right password starts.
  "POST /api/login/totp": "sign-in",
  "POST /api/login/api-key": "sign-in",
  // GitHub's webhook deliveries (FR-8): GitHub has no session, so each is
  // believed only when signed with the webhook secret, and the path is a
  // 404 while webhooks are off.
  "POST /api/github/webhooks": "public",
};

/**
 * What is wrong with the app's routes: one line per route that declares no
 * access, or that is exempt from needing a session without being listed.
 * The built web app's files (`webFiles`) are public by design: the login
 * page needs them, and they hold no data.
 */
function routeAccessProblems(
  server: FastifyInstance,
  webFiles: readonly string[],
): string[] {
  return server.routeAccess().flatMap(({ method, url, access }) => {
    const route = `${method} ${url}`;
    if (access === undefined) {
      return [`${route} declares no access`];
    }
    if (access === "owner") {
      return [];
    }
    const isWebFile =
      access === "public" &&
      (method === "GET" || method === "HEAD") &&
      webFiles.includes(url);
    if (isWebFile || exemptions[route] === access) {
      return [];
    }
    return [`${route} is exempt from sign-in (${access}) but not listed`];
  });
}

let web: Awaited<ReturnType<typeof webBuild>>;

beforeAll(async () => {
  web = await webBuild();
});

afterAll(async () => {
  await web.remove();
});

/** The whole app, with a web build, as the server builds it. */
const app = async (): Promise<FastifyInstance> =>
  buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: web.dir,
    auth: await testAuth(),
  });

describe("every route", () => {
  it("requires a session or is an explicit exemption", async () => {
    const server = await app();
    await server.ready();
    expect(routeAccessProblems(server, web.files)).toEqual([]);
    // The list holds no stale entries.
    const routes = server
      .routeAccess()
      .map(({ method, url, access }) => [`${method} ${url}`, access]);
    for (const exemption of Object.entries(exemptions)) {
      expect(routes).toContainEqual(exemption);
    }
  });

  it("that requires a session answers 401 without one", async () => {
    const server = await app();
    await server.ready();
    const guarded = server
      .routeAccess()
      .filter(({ access }) => access === "owner");
    expect(guarded.length).toBeGreaterThan(0);
    for (const { method, url } of guarded) {
      const response = await server.inject({
        method: method as "GET",
        // Any path parameter will do.
        url: url.replaceAll(/:\w+/g, "1"),
      });
      expect({
        route: `${method} ${url}`,
        status: response.statusCode,
      }).toEqual({ route: `${method} ${url}`, status: 401 });
    }
  });
});

describe("the route-registration check", () => {
  it("fails for a new route that declares no access", async () => {
    const server = await app();
    server.get("/api/streams/activity", () => "");
    expect(routeAccessProblems(server, web.files)).toEqual([
      "GET /api/streams/activity declares no access",
      "HEAD /api/streams/activity declares no access",
    ]);
    // Undeclared still means signed in only.
    expect(
      (await server.inject({ url: "/api/streams/activity" })).statusCode,
    ).toBe(401);
  });

  it("fails for a new exemption that is not listed", async () => {
    const server = await app();
    server.post(
      "/api/webhooks/github",
      { config: { access: "public" } },
      () => "",
    );
    server.get(
      "/api/password-hint",
      { config: { access: "sign-in" } },
      () => "",
    );
    expect(routeAccessProblems(server, web.files)).toEqual([
      "POST /api/webhooks/github is exempt from sign-in (public) but not listed",
      "GET /api/password-hint is exempt from sign-in (sign-in) but not listed",
      "HEAD /api/password-hint is exempt from sign-in (sign-in) but not listed",
    ]);
  });

  it("passes a new route that requires a session", async () => {
    const server = await app();
    server.get("/api/plans", { config: { access: "owner" } }, () => []);
    expect(routeAccessProblems(server, web.files)).toEqual([]);
  });
});
