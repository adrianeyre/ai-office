import { afterEach, describe, expect, it } from "vitest";

import { createGitHubApp, createGitHubTokenConnection } from "./app.ts";
import {
  appsFirst,
  combineGitHubConnections,
  createLiveGitHub,
  GitHubNotConfiguredError,
} from "./connections.ts";
import { GitHubError } from "./errors.ts";
import { createFakeGitHub } from "./fake.ts";
import {
  createAppKeys,
  serveFakeGitHub,
  type FakeGitHubServer,
} from "./fake-server.ts";

// More than one GitHub App, and access tokens, against fake GitHubs over
// HTTP: each repository is acted on through the connection that reaches
// it, and an access token is used as it is, never revoked.

const keys = createAppKeys();
const servers: FakeGitHubServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A fake GitHub with `repositories`, its App and an access token reaching `byToken`. */
async function gitHub(
  appId: string,
  repositories: readonly string[],
  byToken: readonly string[] = [],
) {
  const fake = createFakeGitHub();
  for (const fullName of repositories) {
    fake.installRepository(fullName);
  }
  const server = await serveFakeGitHub(fake, {
    appId,
    publicKey: keys.publicKey,
    accessTokens: {
      [`write-${appId}`]: { login: "adrianeyre", repositories: byToken },
      [`read-${appId}`]: {
        login: "adrianeyre",
        repositories: byToken,
        permissions: {
          metadata: "read",
          contents: "read",
          issues: "read",
          pull_requests: "read",
        },
      },
    },
  });
  servers.push(server);
  const app = createGitHubApp({
    appId,
    privateKey: keys.privateKey,
    baseUrl: server.url,
  });
  const token = createGitHubTokenConnection({
    token: `write-${appId}`,
    readOnlyToken: `read-${appId}`,
    baseUrl: server.url,
  });
  return { fake, server, app, token };
}

describe("an access token", () => {
  it("lists the repositories its user reaches, and acts on them with the token itself", async () => {
    const { fake, token } = await gitHub(
      "1",
      ["adrianeyre/web-shop", "adrianeyre/blog"],
      ["adrianeyre/web-shop"],
    );
    expect(
      (await token.repositories()).map(({ fullName }) => fullName),
    ).toEqual(["adrianeyre/web-shop"]);
    expect(await token.installations()).toEqual([
      expect.objectContaining({ account: "adrianeyre" }),
    ]);
    const shop = token.repository("adrianeyre/web-shop");
    const issue = await shop.createIssue({ title: "From a token" });
    expect(
      (await fake.repository("adrianeyre/web-shop").getIssue(issue.number))
        .title,
    ).toBe("From a token");
    expect((await shop.installationToken()).token).toBe("write-1");
    // A sandbox gets the read-only one, which can read and not write.
    const readOnly = await shop.readOnlyToken();
    expect(readOnly.token).toBe("read-1");
    const asSandbox = createGitHubTokenConnection({
      token: readOnly.token,
      readOnlyToken: readOnly.token,
      baseUrl: servers[0]?.url ?? "",
    }).repository("adrianeyre/web-shop");
    expect((await asSandbox.getIssue(issue.number)).title).toBe("From a token");
    const refused = await asSandbox
      .createIssue({ title: "Not allowed" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GitHubError);
    expect((refused as GitHubError).status).toBe(403);
    // Revoking is never done: the token is the Owner's.
    await shop.revokeToken(readOnly.token);
    expect((await asSandbox.get()).fullName).toBe("adrianeyre/web-shop");
    // A repository it does not reach is GitHub's 404.
    const hidden = await token
      .repository("adrianeyre/blog")
      .get()
      .catch((error: unknown) => error);
    expect((hidden as GitHubError).status).toBe(404);
  });
});

describe("several GitHub connections", () => {
  it("list every one's repositories once, and act on each through the one that reaches it", async () => {
    const first = await gitHub("1", ["adrianeyre/web-shop", "acme/tools"]);
    const second = await gitHub("2", ["globex/site"], ["globex/site"]);
    const third = await gitHub("3", ["initech/tps"], ["initech/tps"]);
    const github = combineGitHubConnections([
      first.app,
      second.app,
      third.token,
    ]);
    expect(
      (await github.repositories()).map(({ fullName }) => fullName).sort(),
    ).toEqual([
      "acme/tools",
      "adrianeyre/web-shop",
      "globex/site",
      "initech/tps",
    ]);
    expect(await github.installations()).toHaveLength(4);

    const site = github.repository("globex/site");
    const filed = await site.createIssue({ title: "Through the second App" });
    expect(
      (await second.fake.repository("globex/site").getIssue(filed.number))
        .author,
    ).toBe(second.fake.botLogin);
    const tps = github.repository("initech/tps");
    const byToken = await tps.createIssue({ title: "Through the token" });
    expect(
      (await third.fake.repository("initech/tps").getIssue(byToken.number))
        .title,
    ).toBe("Through the token");
    expect((await tps.installationToken()).token).toBe("write-3");
    // Its calls may be spread, as callers do.
    const spread = { ...github.repository("acme/tools") };
    expect((await spread.get()).fullName).toBe("acme/tools");

    const nowhere = await github
      .repository("nobody/nothing")
      .get()
      .catch((error: unknown) => error);
    expect(nowhere).toBeInstanceOf(GitHubError);
    expect((nowhere as GitHubError).status).toBe(404);
    expect((nowhere as GitHubError).message).toContain("No GitHub connection");
  });

  it("go on with the rest when one's credentials have gone bad", async () => {
    const good = await gitHub("1", ["adrianeyre/web-shop"]);
    const bad = createGitHubTokenConnection({
      token: "revoked",
      readOnlyToken: "revoked",
      baseUrl: good.server.url,
    });
    const github = combineGitHubConnections([bad, good.app]);
    expect(
      (await github.repositories()).map(({ fullName }) => fullName),
    ).toEqual(["adrianeyre/web-shop"]);
    expect(
      (await github.repository("adrianeyre/web-shop").get()).fullName,
    ).toBe("adrianeyre/web-shop");
  });

  it("is the one connection itself when there is one, and needs one", async () => {
    const { app } = await gitHub("1", ["adrianeyre/web-shop"]);
    expect(combineGitHubConnections([app])).toBe(app);
    expect(() => combineGitHubConnections([])).toThrow();
  });
});

describe("the live GitHub", () => {
  it("fails as not set up with no connection, then works through those it is given, without a new client", async () => {
    const first = await gitHub("1", ["adrianeyre/web-shop"]);
    const second = await gitHub("2", ["globex/site"], ["globex/site"]);
    const github = createLiveGitHub();
    expect(github.size).toBe(0);
    const shop = github.repository("adrianeyre/web-shop");
    await expect(github.repositories()).rejects.toBeInstanceOf(
      GitHubNotConfiguredError,
    );
    await expect(shop.get()).rejects.toThrow(/Floor Settings/);

    github.set([first.app]);
    expect((await shop.get()).fullName).toBe("adrianeyre/web-shop");
    github.set([first.app, second.token]);
    expect(github.size).toBe(2);
    expect(
      (await github.repositories()).map(({ fullName }) => fullName).sort(),
    ).toEqual(["adrianeyre/web-shop", "globex/site"]);
    const site = { ...github.repository("globex/site") };
    expect((await site.installationToken()).token).toBe("write-2");

    // A connection taken away is no longer used.
    github.set([second.token]);
    const gone = await shop.get().catch((error: unknown) => error);
    expect((gone as GitHubError).status).toBe(404);
  });

  it("tries Apps first, otherwise in the order given", () => {
    expect(
      appsFirst([
        { kind: "access-token", id: "a" },
        { kind: "app", id: "b" },
        { kind: "access-token", id: "c" },
        { kind: "app", id: "d" },
      ]).map(({ id }) => id),
    ).toEqual(["b", "d", "a", "c"]);
  });
});
