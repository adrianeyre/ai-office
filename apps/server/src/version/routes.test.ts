import {
  apiErrorSchema,
  latestPackageUrl,
  latestVersionSchema,
  versionErrorCodes,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";
import type { VersionCheckOptions } from "./routes.ts";

// The version check (`GET /api/version/latest`): the latest version, from
// the root package.json on GitHub, asked by the server with a fake fetch
// here, kept for a while, and a 502 when GitHub cannot say.

async function setUp(versionCheck: VersionCheckOptions): Promise<{
  server: FastifyInstance;
  cookie: string;
}> {
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    versionCheck,
  });
  const { cookie } = await signIn(server);
  return { server, cookie };
}

/** A fake `fetch` that answers with each of `answers` in turn. */
function fakeFetch(...answers: (() => Promise<Response>)[]) {
  const asked: string[] = [];
  const fetchLatest = ((url: string) => {
    asked.push(url);
    const answer = answers[Math.min(asked.length, answers.length) - 1];
    return answer === undefined
      ? Promise.reject(new Error("not answered"))
      : answer();
  }) as typeof fetch;
  return { fetchLatest, asked };
}

const packageJson = (version: unknown) => () =>
  Promise.resolve(Response.json({ name: "ai-office", version }));

describe("GET /api/version/latest", () => {
  it("answers the version in the root package.json on GitHub", async () => {
    const { fetchLatest, asked } = fakeFetch(packageJson("1.4.0"));
    const { server, cookie } = await setUp({ fetch: fetchLatest });
    const response = await server.inject({
      method: "GET",
      url: "/api/version/latest",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(latestVersionSchema.parse(response.json())).toEqual({
      version: "1.4.0",
    });
    expect(asked).toEqual([latestPackageUrl]);
  });

  it("needs a session", async () => {
    const { fetchLatest, asked } = fakeFetch(packageJson("1.4.0"));
    const { server } = await setUp({ fetch: fetchLatest });
    const response = await server.inject({
      method: "GET",
      url: "/api/version/latest",
    });
    expect(response.statusCode).toBe(401);
    expect(asked).toEqual([]);
  });

  it("keeps an answer for a while, then asks again", async () => {
    let time = 0;
    const { fetchLatest, asked } = fakeFetch(
      packageJson("1.4.0"),
      packageJson("1.5.0"),
    );
    const { server, cookie } = await setUp({
      fetch: fetchLatest,
      cacheMs: 1000,
      now: () => time,
    });
    const ask = async () =>
      latestVersionSchema.parse(
        (
          await server.inject({
            method: "GET",
            url: "/api/version/latest",
            headers: { cookie },
          })
        ).json(),
      ).version;

    expect(await ask()).toBe("1.4.0");
    time = 999;
    expect(await ask()).toBe("1.4.0");
    expect(asked).toHaveLength(1);
    time = 1000;
    expect(await ask()).toBe("1.5.0");
    expect(asked).toHaveLength(2);
  });

  it.each([
    [
      "GitHub answers 404",
      () => Promise.resolve(new Response("Not Found", { status: 404 })),
      "GitHub answered 404.",
    ],
    [
      "its package.json has no version",
      packageJson(undefined),
      "Its package.json has no version.",
    ],
    [
      "its package.json's version is not a version number",
      packageJson("latest"),
      "Its package.json's version is not a version number.",
    ],
    [
      "GitHub cannot be reached",
      () => Promise.reject(new TypeError("fetch failed")),
      "GitHub could not be reached.",
    ],
    [
      "GitHub takes too long",
      () =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
      "GitHub took too long to answer.",
    ],
  ])("answers 502 when %s", async (_, answer, message) => {
    const { fetchLatest } = fakeFetch(answer);
    const { server, cookie } = await setUp({ fetch: fetchLatest });
    const response = await server.inject({
      method: "GET",
      url: "/api/version/latest",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(502);
    expect(apiErrorSchema.parse(response.json())).toEqual({
      error: versionErrorCodes.versionCheckFailed,
      message,
    });
  });

  it("asks again soon after a failure", async () => {
    let time = 0;
    const { fetchLatest, asked } = fakeFetch(
      () => Promise.reject(new TypeError("fetch failed")),
      packageJson("1.4.0"),
    );
    const { server, cookie } = await setUp({
      fetch: fetchLatest,
      failureCacheMs: 100,
      now: () => time,
    });
    const ask = () =>
      server.inject({
        method: "GET",
        url: "/api/version/latest",
        headers: { cookie },
      });
    expect((await ask()).statusCode).toBe(502);
    time = 50;
    expect((await ask()).statusCode).toBe(502);
    expect(asked).toHaveLength(1);
    time = 100;
    expect((await ask()).statusCode).toBe(200);
  });
});
