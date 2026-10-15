import { sessionLifetimeMs } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probedApp } from "../pen-test-support.ts";
import { signIn, webBuild } from "../test-support.ts";

// A1 probe (pen-testing, "Sign-in and sessions"): proving the negative
// (FR-2). Every route, live stream and WebSocket of the app, as the real
// app registers them: those that answer without a session are exactly the
// ones meant to, each for a stated reason, and every other one refuses a
// caller with no session or an expired one. Position 1.

let web: Awaited<ReturnType<typeof webBuild>>;
beforeAll(async () => {
  web = await webBuild();
});
afterAll(async () => {
  await web.remove();
});

/**
 * Everything that answers without a session, and why. FR-2 names three:
 * the login page, the setup screen (until a password exists) and a health
 * endpoint. The rest are beyond FR-2's words but public by intent; FR-2's
 * list is out of date (H17, the I series).
 */
const openByIntent: Readonly<Record<string, string>> = {
  // FR-2: the setup screen, until a password exists (then a 404).
  "POST /api/setup": "setup",
  // FR-2: the login page's API, and its two other ways in.
  "POST /api/login": "sign-in",
  "POST /api/login/totp": "sign-in",
  "POST /api/login/api-key": "sign-in",
  // FR-2 and FR-47: compose's health check.
  "GET /health": "public",
  "HEAD /health": "public",
  // Beyond FR-2: GitHub's deliveries, believed only when HMAC-signed (W).
  "POST /api/github/webhooks": "public",
  // Beyond FR-2: for crawlers; they name only /login.
  "GET /robots.txt": "public",
  "HEAD /robots.txt": "public",
  "GET /sitemap.xml": "public",
  "HEAD /sitemap.xml": "public",
};

async function routes(): Promise<{
  server: FastifyInstance;
  open: Record<string, string>;
  guarded: { method: string; url: string }[];
}> {
  const probed = await probedApp({ webDistDir: web.dir });
  await probed.server.ready();
  const all = probed.server.routeAccess();
  const isWebFile = (method: string, url: string) =>
    (method === "GET" || method === "HEAD") && web.files.includes(url);
  return {
    server: probed.server,
    open: Object.fromEntries(
      all
        .filter(({ access }) => access !== undefined && access !== "owner")
        .filter(({ method, url }) => !isWebFile(method, url))
        .map(({ method, url, access }) => [`${method} ${url}`, access ?? ""]),
    ),
    guarded: all.filter(({ access }) => (access ?? "owner") === "owner"),
  };
}

const asPath = (url: string) => url.replaceAll(/:\w+/g, "1");

describe("routes open without a session", () => {
  it("are exactly those open by intent, besides the built web app's files", async () => {
    const { open } = await routes();
    expect(open).toEqual(openByIntent);
  });

  it("the built web app's files are public, and are only the files", async () => {
    const probed = await probedApp({ webDistDir: web.dir });
    await probed.server.ready();
    const files = probed.server
      .routeAccess()
      .filter(({ url }) => web.files.includes(url));
    expect(files.every(({ access }) => access === "public")).toBe(true);
    // No directory listing, and nothing outside the build.
    for (const url of [
      "/assets/",
      "/../package.json",
      "/%2e%2e/package.json",
    ]) {
      const response = await probed.server.inject({ url });
      expect({ url, status: response.statusCode }).not.toEqual({
        url,
        status: 200,
      });
    }
  });

  it("hold no data: health says up or down, the crawler files name /login only", async () => {
    const { server } = await probedApp({ webDistDir: web.dir });
    expect((await server.inject({ url: "/health" })).json()).toEqual({
      status: "ok",
      database: "up",
    });
    const sitemap = (await server.inject({ url: "/sitemap.xml" })).body;
    expect(sitemap.match(/<loc>[^<]+<\/loc>/g)).toEqual([
      "<loc>http://localhost/login</loc>",
    ]);
    // A decision to record: robots.txt invites crawling of the login page.
    expect((await server.inject({ url: "/robots.txt" })).body).toContain(
      "Allow: /\nDisallow: /api/",
    );
  });

  it("of the pages, only /login (and /setup before setup) are served without a session", async () => {
    const { server } = await probedApp({ webDistDir: web.dir });
    for (const path of ["/", "/admin", "/floors/1", "/terminal", "/setup"]) {
      const response = await server.inject({ url: path });
      expect({ path, status: response.statusCode }).toEqual({
        path,
        status: path === "/setup" ? 404 : 302,
      });
    }
    expect((await server.inject({ url: "/login" })).statusCode).toBe(200);
  });
});

describe("every other route", () => {
  it("refuses a caller with no session", async () => {
    const { server, guarded } = await routes();
    expect(guarded.length).toBeGreaterThan(150);
    const answered = await Promise.all(
      guarded.map(async ({ method, url }) => ({
        route: `${method} ${url}`,
        status: (
          await server.inject({ method: method as "GET", url: asPath(url) })
        ).statusCode,
      })),
    );
    expect(answered.filter(({ status }) => status !== 401)).toEqual([]);
  });

  it("refuses a session that has expired", async () => {
    const probed = await probedApp({ webDistDir: web.dir });
    await probed.server.ready();
    const owner = await signIn(probed.server);
    probed.wait(sessionLifetimeMs);
    const guarded = probed.server
      .routeAccess()
      .filter(({ access }) => (access ?? "owner") === "owner");
    const answered: { route: string; status: number }[] = [];
    for (const { method, url } of guarded) {
      const response = await probed.server.inject({
        method: method as "GET",
        url: asPath(url),
        headers: owner.headers,
      });
      answered.push({ route: `${method} ${url}`, status: response.statusCode });
    }
    expect(answered.filter(({ status }) => status !== 401)).toEqual([]);
  });

  it("an unknown API path answers as a guarded one, so paths cannot be enumerated", async () => {
    const { server } = await probedApp({ webDistDir: web.dir });
    expect(
      (await server.inject({ url: "/api/no-such-route" })).statusCode,
    ).toBe(401);
    const owner = await signIn(server);
    expect(
      (
        await server.inject({
          url: "/api/no-such-route",
          headers: { cookie: owner.cookie },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("live streams and WebSockets", () => {
  const streams = [
    "GET /api/events/stream",
    "GET /api/floors/:floorId/manager-chat/stream",
    "GET /api/floors/:floorId/agents/:agentId/chat/stream",
    "GET /api/terminal/stream",
    "GET /api/gateway/requests/stream",
    "GET /api/gateway/logs/stream",
  ];

  it("the streams are these six, and each is an owner route", async () => {
    const { guarded, open } = await routes();
    const named = guarded
      .filter(({ method, url }) => method === "GET" && url.endsWith("/stream"))
      .map(({ method, url }) => `${method} ${url}`);
    expect(named.sort()).toEqual([...streams].sort());
    expect(Object.keys(open).some((route) => route.includes("stream"))).toBe(
      false,
    );
  });

  it("there is no WebSocket: the HTTP server has no upgrade handler, and an upgrade is answered as plain HTTP", async () => {
    const { server } = await probedApp();
    await server.ready();
    expect(server.server.listenerCount("upgrade")).toBe(0);
    for (const route of streams) {
      const url = asPath(route.split(" ")[1] ?? "");
      const response = await server.inject({
        url,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      expect({ url, status: response.statusCode }).toEqual({
        url,
        status: 401,
      });
    }
  });
});

describe("routes added with #204", () => {
  it("the Manager chat's attachments, file mentions and tasks need a session", async () => {
    const { server } = await probedApp();
    for (const [method, url] of [
      ["POST", "/api/floors/1/manager-chat/attachments"],
      ["GET", "/api/floors/1/manager-chat/attachments/1"],
      ["GET", "/api/floors/1/manager-chat/files?query=src"],
      ["GET", "/api/floors/1/manager-chat/tasks"],
    ] as const) {
      const response = await server.inject({ method, url, payload: {} });
      expect({ url, status: response.statusCode }).toEqual({
        url,
        status: 401,
      });
    }
  });

  it("the version check needs a session, and GitHub is not asked for a caller without one", async () => {
    const asked: string[] = [];
    const { server } = await probedApp({
      versionCheck: {
        fetch: (input) => {
          asked.push(input instanceof Request ? input.url : input.toString());
          return Promise.resolve(Response.json({ version: "9.9.9" }));
        },
      },
    });
    const response = await server.inject({ url: "/api/version/latest" });
    expect(response.statusCode).toBe(401);
    expect(asked).toEqual([]);
    const owner = await signIn(server);
    const signedIn = await server.inject({
      url: "/api/version/latest",
      headers: { cookie: owner.cookie },
    });
    expect(signedIn.json()).toEqual({ version: "9.9.9" });
    expect(asked).toHaveLength(1);
  });
});
