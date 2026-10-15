import { afterEach, describe, expect, it } from "vitest";

import { createGitHubApp } from "./app.ts";
import { GitHubError } from "./errors.ts";
import { createFakeGitHub, type FakeGitHub } from "./fake.ts";
import { appJwt } from "./jwt.ts";
import {
  createAppKeys,
  serveFakeGitHub,
  type FakeGitHubServer,
} from "./fake-server.ts";
import { appPermissions, readOnlyPermissions } from "./types.ts";

// The App client against the fake GitHub over HTTP: how it authenticates
// and when it mints installation tokens.

const keys = createAppKeys();
const minute = 60 * 1000;
const servers: FakeGitHubServer[] = [];

/** What `promise` failed with, which must be a `GitHubError`. */
const failureOf = async (promise: Promise<unknown>): Promise<GitHubError> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(GitHubError);
  return error as GitHubError;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A fake GitHub with two owners' repositories, and the App, on one clock. */
async function setUp(options: { privateKey?: string } = {}) {
  const clock = { now: new Date("2026-10-08T12:00:00.000Z") };
  const now = () => clock.now;
  const fake: FakeGitHub = createFakeGitHub({ now });
  fake.installRepository("adrianeyre/web-shop");
  fake.installRepository("adrianeyre/blog", { defaultBranch: "trunk" });
  fake.installRepository("acme/tools");
  const server = await serveFakeGitHub(fake, {
    appId: "4242",
    publicKey: keys.publicKey,
    now,
  });
  servers.push(server);
  const app = createGitHubApp({
    appId: "4242",
    privateKey: options.privateKey ?? keys.privateKey,
    baseUrl: server.url,
    now,
  });
  const advance = (ms: number): void => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { fake, server, app, advance };
}

describe("the GitHub App client", () => {
  it("lists every installation's repositories", async () => {
    const { app } = await setUp();
    expect(
      (await app.installations()).map(({ account }) => account).sort(),
    ).toEqual(["acme", "adrianeyre"]);
    expect(
      (await app.repositories())
        .map(({ fullName, defaultBranch }) => `${fullName}@${defaultBranch}`)
        .sort(),
    ).toEqual([
      "acme/tools@main",
      "adrianeyre/blog@trunk",
      "adrianeyre/web-shop@main",
    ]);
  });

  it("mints one token per repository, scoped to it, and reuses it", async () => {
    const { app, server } = await setUp();
    const webShop = app.repository("adrianeyre/web-shop");
    await webShop.createIssue({ title: "Add a basket" });
    await webShop.listIssues();
    await webShop.getBranch("main");
    const blog = app.repository("adrianeyre/blog");
    await blog.get();
    await blog.listIssues();
    // A second client for the same repository shares the token.
    await app.repository("ADRIANEYRE/web-shop").get();

    expect(server.mintedTokens).toEqual([
      {
        installationId: expect.any(Number) as unknown,
        repositories: ["web-shop"],
        permissions: appPermissions,
      },
      {
        installationId: expect.any(Number) as unknown,
        repositories: ["blog"],
        permissions: appPermissions,
      },
    ]);
  });

  it("mints a fresh token once the old one is within five minutes of expiry", async () => {
    const { app, server, advance } = await setUp();
    const webShop = app.repository("adrianeyre/web-shop");
    const first = await webShop.installationToken();
    await webShop.get();
    advance(54 * minute);
    await webShop.get();
    expect(server.mintedTokens).toHaveLength(1);

    advance(2 * minute);
    await webShop.get();
    expect(server.mintedTokens).toHaveLength(2);
    const second = await webShop.installationToken();
    expect(second.token).not.toBe(first.token);
    expect(second.expiresAt.getTime()).toBeGreaterThan(
      first.expiresAt.getTime(),
    );
  });

  it("cannot reach another repository with a repository's token", async () => {
    const { app, server } = await setUp();
    const { token } = await app
      .repository("adrianeyre/web-shop")
      .installationToken();
    const headers = { authorization: `token ${token}` };
    expect(
      (await fetch(`${server.url}/repos/adrianeyre/web-shop`, { headers }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${server.url}/repos/adrianeyre/blog`, { headers })).status,
    ).toBe(404);
  });

  it("cannot make a call its token's permissions do not cover", async () => {
    const { fake, server } = await setUp();
    const { token } = fake.mintToken(
      fake.installationOf("adrianeyre/web-shop") ?? 0,
      ["web-shop"],
      { issues: "write" },
    );
    const call = async (method: string, path: string): Promise<number> =>
      (
        await fetch(`${server.url}/repos/adrianeyre/web-shop${path}`, {
          method,
          headers: { authorization: `token ${token}` },
          ...(method === "GET" ? {} : { body: "{}" }),
        })
      ).status;
    // Every token reads metadata; issues it may write, so read too.
    expect(await call("GET", "")).toBe(200);
    expect(await call("GET", "/issues")).toBe(200);
    // Pull requests, contents and checks it was not given.
    expect(await call("GET", "/pulls")).toBe(403);
    expect(await call("GET", "/contents/README.md")).toBe(403);
    expect(await call("GET", "/commits/main/check-runs")).toBe(403);
    expect(await call("PUT", "/pulls/1/merge")).toBe(403);
  });

  it("cannot mint a token with more than the App was granted", async () => {
    const { fake, server, app } = await setUp();
    const installation = fake.installationOf("adrianeyre/web-shop") ?? 0;
    expect(() =>
      fake.mintToken(installation, ["web-shop"], { administration: "write" }),
    ).toThrow(/not granted/);
    expect(() =>
      fake.mintToken(installation, ["web-shop"], { checks: "write" }),
    ).toThrow(/not granted/);
    // Asked for over HTTP, as the App asks, GitHub answers 422.
    const mint = (permissions: Record<string, string>) =>
      fetch(
        `${server.url}/app/installations/${String(installation)}/access_tokens`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${appJwt({
              appId: "4242",
              privateKey: keys.privateKey,
              now: new Date("2026-10-08T12:00:00.000Z"),
            })}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ repositories: ["web-shop"], permissions }),
        },
      );
    expect((await mint({ workflows: "write" })).status).toBe(422);
    expect((await mint({ contents: "read" })).status).toBe(201);
    // The sandbox's read-only token is within what the App was granted.
    await app.repository("adrianeyre/web-shop").readOnlyToken();
    expect(server.mintedTokens.at(-1)?.permissions).toEqual(
      readOnlyPermissions,
    );
  });

  it("is refused when its key is not the App's", async () => {
    const { app } = await setUp({ privateKey: createAppKeys().privateKey });
    expect((await failureOf(app.installations())).status).toBe(401);
    await expect(app.repository("adrianeyre/web-shop").get()).rejects.toThrow(
      GitHubError,
    );
  });

  it("fails with a 404 for a repository it is not installed on", async () => {
    const { app } = await setUp();
    await expect(app.repository("adrianeyre/secret").get()).rejects.toThrow(
      expect.objectContaining({ status: 404 }) as Error,
    );
  });

  it("never puts a credential in an error", async () => {
    const { app } = await setUp();
    const repo = app.repository("adrianeyre/web-shop");
    const { token } = await repo.installationToken();
    const error = await failureOf(repo.getIssue(41));
    expect(error.message).toMatch(/^GitHub answered 404: /);
    for (const text of [error.message, error.stack ?? ""]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain("PRIVATE KEY");
    }
  });

  it("reports an unreachable GitHub with status 0", async () => {
    const app = createGitHubApp({
      appId: "4242",
      privateKey: keys.privateKey,
      // Nothing listens on port 9 (discard) here.
      baseUrl: "http://127.0.0.1:9",
    });
    const error = await failureOf(app.installations());
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/^GitHub could not be reached/);
  });
});
