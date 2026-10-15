import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { healthResponseSchema } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AppOptions } from "./app.ts";
import { createLogger } from "./logger.ts";
import { signIn, testAuth, type SignedIn } from "./test-support.ts";

const silent = createLogger({ level: "silent", secrets: [] });

// Set up already: setup and sign-in have their own tests.
const app = async (
  options: Partial<AppOptions> = {},
): Promise<FastifyInstance> =>
  buildApp({
    logger: silent,
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    ...options,
  });

describe("GET /health", () => {
  it("is 200 with the database up", async () => {
    const server = await app();
    const response = await server.inject({ url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      database: "up",
    });
  });

  it.each([
    ["answers no", () => Promise.resolve(false)],
    ["throws", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["hangs", () => new Promise<boolean>(() => undefined)],
  ])("is 503 when the database check %s", async (_, checkDatabase) => {
    const server = await app({ checkDatabase, healthTimeoutMs: 50 });
    const response = await server.inject({ url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json())).toEqual({
      status: "unavailable",
      database: "down",
    });
  });
});

describe("the web app, signed in", () => {
  let webDistDir: string;
  let server: FastifyInstance;
  let owner: SignedIn;

  beforeAll(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "ai-office-web-"));
    await mkdir(join(webDistDir, "assets"));
    await writeFile(
      join(webDistDir, "index.html"),
      "<!doctype html><p>AI Office",
    );
    await writeFile(join(webDistDir, "assets", "app.js"), "console.log(1);");
    server = await app({ webDistDir });
    owner = await signIn(server);
  });

  afterAll(async () => {
    await server.close();
    await rm(webDistDir, { recursive: true });
  });

  it("serves index.html at /", async () => {
    const response = await server.inject({
      url: "/",
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.body).toContain("AI Office");
  });

  it("serves built files", async () => {
    const response = await server.inject({ url: "/assets/app.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/javascript/);
    expect(response.body).toBe("console.log(1);");
  });

  it.each(["/floors/web-shop", "/admin?tab=gateway"])(
    "falls back to index.html for the page %s",
    async (url) => {
      const response = await server.inject({
        url,
        headers: { cookie: owner.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^text\/html/);
      expect(response.body).toContain("AI Office");
    },
  );

  it.each([
    ["GET", "/api/nothing"],
    ["GET", "/assets/missing.js"],
    ["POST", "/floors/web-shop"],
  ] as const)("is 404 for %s %s", async (method, url) => {
    const response = await server.inject({
      method,
      url,
      headers: owner.headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found" });
  });
});

describe("what crawlers and link previews read", () => {
  let webDistDir: string;
  let server: FastifyInstance;

  beforeAll(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "ai-office-web-"));
    await writeFile(
      join(webDistDir, "index.html"),
      '<meta property="og:image" content="__AI_OFFICE_ORIGIN__/og-image.png" /><link rel="canonical" href="__AI_OFFICE_PAGE_URL__" />',
    );
    server = await app({ webDistDir, publicUrl: "https://office.example/" });
  });

  afterAll(async () => {
    await server.close();
    await rm(webDistDir, { recursive: true });
  });

  it("serves the sign-in page with absolute URLs, signed out", async () => {
    const response = await server.inject({ url: "/login?next=%2F" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      '<meta property="og:image" content="https://office.example/og-image.png" /><link rel="canonical" href="https://office.example/login" />',
    );
  });

  it("serves robots.txt and the sitemap, signed out", async () => {
    const robots = await server.inject({ url: "/robots.txt" });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers["content-type"]).toMatch(/^text\/plain/);
    expect(robots.body).toContain(
      "Sitemap: https://office.example/sitemap.xml",
    );
    const sitemap = await server.inject({ url: "/sitemap.xml" });
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.headers["content-type"]).toMatch(/^application\/xml/);
    expect(sitemap.body).toContain("<loc>https://office.example/login</loc>");
  });

  it("uses the request's own address without a PUBLIC_URL", async () => {
    const local = await app({ webDistDir });
    const response = await local.inject({
      url: "/robots.txt",
      headers: { host: "office.internal:3046" },
    });
    expect(response.body).toContain(
      "Sitemap: http://office.internal:3046/sitemap.xml",
    );
    await local.close();
  });
});

describe("without a web build", () => {
  it("serves the API and is 404 for pages", async () => {
    const lines: string[] = [];
    const server = await app({
      logger: createLogger({
        level: "warn",
        secrets: [],
        destination: { write: (line) => lines.push(line) },
      }),
    });
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
    const { cookie } = await signIn(server);
    expect(
      (await server.inject({ url: "/", headers: { cookie } })).statusCode,
    ).toBe(404);
    expect(lines.join("")).toContain("The web app is not built");
  });
});
