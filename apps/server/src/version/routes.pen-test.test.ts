import {
  apiErrorSchema,
  latestPackageUrl,
  latestVersionSchema,
  releasePageOf,
  releasesUrl,
  versionErrorCodes,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// I1 probe (pen-testing, "Infrastructure and delivery"): the version check
// (apps/server/src/version/routes.ts). The server asks GitHub for the root
// package.json on `main` and shows its `version`. The URL is fixed and the
// browser loads nothing itself, so there is no SSRF here; what is probed is
// what a spoofed or hostile answer can do (an on-path attacker between the
// server and raw.githubusercontent.com — outside positions 1–5, as G1-7).
// See docs/pen-testing/assessments/I1.md.
//
// Fixed (I1-11): the answer is taken only as a version number
// (`latestVersionSchema`, `isVersion`) before it is kept, shown or linked
// to; anything else is a failure, kept as one, and `releasePageOf` links
// only a version number's tag.

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setUp(
  fetchLatest: typeof fetch,
  now: () => number = () => 0,
): Promise<{ cookie: string; server: FastifyInstance }> {
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    versionCheck: { fetch: fetchLatest, now },
  });
  servers.push(server);
  const { cookie } = await signIn(server);
  return { cookie, server };
}

/** A fetch that answers the version check with one body. */
const answering = (body: unknown): typeof fetch =>
  ((url: string) => {
    expect(url).toBe(latestPackageUrl);
    return Promise.resolve(Response.json(body));
  }) as typeof fetch;

const ask = (server: FastifyInstance, cookie: string) =>
  server.inject({
    method: "GET",
    url: "/api/version/latest",
    headers: { cookie },
  });

/** The 502 the route answers when the latest version is not known. */
const couldNotFindOut = {
  error: versionErrorCodes.versionCheckFailed,
  message: "Its package.json's version is not a version number.",
};

describe("I1-11: a hostile version answer is accepted and shown unchecked", () => {
  it("regression (I1-11): a string that is not a version number is no longer accepted as the latest version, returned to the web app or linked to", async () => {
    const hostile =
      "9999.0.0 — update now at http://evil.example (attacker text)";
    const { server, cookie } = await setUp(answering({ version: hostile }));

    const response = await ask(server, cookie);
    // The schema takes a version number only, so the attacker's string is
    // "could not find out", and none of it reaches the web app.
    expect(response.statusCode).toBe(502);
    expect(apiErrorSchema.parse(response.json())).toEqual(couldNotFindOut);
    expect(response.body).not.toContain("evil.example");
    expect(latestVersionSchema.safeParse({ version: hostile }).success).toBe(
      false,
    );
    // The web app's link to a release is the releases page, not a tag
    // named by the attacker.
    expect(releasePageOf(hostile)).toBe(releasesUrl);
    expect(releasePageOf(hostile)).not.toMatch(/\/tag\//);
  });

  it("regression (I1-11): a huge version string is no longer accepted whole", async () => {
    const huge = `1.0.0-${"A".repeat(5000)}`;
    const { server, cookie } = await setUp(answering({ version: huge }));

    const response = await ask(server, cookie);
    expect(response.statusCode).toBe(502);
    expect(apiErrorSchema.parse(response.json())).toEqual(couldNotFindOut);
    expect(response.body).not.toContain("AAAA");
    expect(latestVersionSchema.safeParse({ version: huge }).success).toBe(
      false,
    );
  });

  it("the latest version is validated as a version number before it is shown", async () => {
    const hostile = "not a version <script>";
    const { server, cookie } = await setUp(answering({ version: hostile }));

    const response = await ask(server, cookie);
    // The property: an answer that is not a dotted version is refused, so
    // no attacker-controlled text reaches the web app.
    expect(response.statusCode).toBe(502);
  });
});

describe("I1-11 siblings: what is kept, and every shape a hostile answer can take", () => {
  it("a refused answer is kept as a failure, never as the latest version, and a version number is taken once GitHub gives one", async () => {
    let time = 0;
    const asked: string[] = [];
    const answers = ["9999.0.0 <b>update now</b>", "1.4.0"];
    const { server, cookie } = await setUp(
      ((url: string) => {
        asked.push(url);
        return Promise.resolve(
          Response.json({ version: answers[asked.length - 1] }),
        );
      }) as typeof fetch,
      () => time,
    );

    expect((await ask(server, cookie)).statusCode).toBe(502);
    // Kept as a failure for its minute: asked again, nothing new is fetched
    // and nothing of the refused answer comes back.
    time = 59_999;
    const again = await ask(server, cookie);
    expect(again.statusCode).toBe(502);
    expect(again.body).not.toContain("update now");
    expect(asked).toHaveLength(1);
    time = 60_000;
    const later = await ask(server, cookie);
    expect(later.statusCode).toBe(200);
    expect(latestVersionSchema.parse(later.json())).toEqual({
      version: "1.4.0",
    });
  });

  it.each([
    ["a version with a scheme", "1.2.3/../../javascript:alert(1)"],
    ["markup", "<img src=x onerror=alert(1)>"],
    ["a version with a space and text after it", "1.2.3 update now"],
    ["a version with a newline", "1.2.3\nupdate now"],
    ["a leading v", "v1.2.3"],
    ["two numbers", "1.2"],
    ["a leading zero", "01.2.3"],
    ["a version too long to be one", `1.2.3-${"a".repeat(64)}`],
  ])("refuses %s", async (_, version) => {
    const { server, cookie } = await setUp(answering({ version }));
    const response = await ask(server, cookie);
    expect(response.statusCode).toBe(502);
    expect(apiErrorSchema.parse(response.json())).toEqual(couldNotFindOut);
  });

  it.each([
    ["a number", 1],
    ["an empty string", ""],
    ["an object", { toString: "1.2.3" }],
  ])("says there is no version for %s", async (_, version) => {
    const { server, cookie } = await setUp(answering({ version }));
    const response = await ask(server, cookie);
    expect(response.statusCode).toBe(502);
    expect(apiErrorSchema.parse(response.json()).message).toBe(
      "Its package.json has no version.",
    );
  });

  it.each(["1.2.3", "10.20.30", "1.2.3-rc.1", "1.0.0-alpha.beta+build.5"])(
    "still takes %s",
    async (version) => {
      const { server, cookie } = await setUp(answering({ version }));
      const response = await ask(server, cookie);
      expect(response.statusCode).toBe(200);
      expect(latestVersionSchema.parse(response.json())).toEqual({ version });
    },
  );
});

describe("the version check where it holds", () => {
  it("asks GitHub itself over the one fixed URL, so the browser loads nothing from other sites", async () => {
    let asked = "";
    const { server, cookie } = await setUp(((url: string) => {
      asked = url;
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }) as typeof fetch);

    await ask(server, cookie);
    expect(asked).toBe(latestPackageUrl);
    expect(asked).toBe(
      "https://raw.githubusercontent.com/adrianeyre/ai-office/main/package.json",
    );
  });

  it("needs a signed-in session: the route is owner-access", async () => {
    const { server } = await setUp(answering({ version: "1.0.0" }));
    const response = await server.inject({
      method: "GET",
      url: "/api/version/latest",
    });
    expect(response.statusCode).toBe(401);
  });
});
