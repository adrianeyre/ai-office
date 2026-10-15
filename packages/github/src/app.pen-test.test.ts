import { afterEach, describe, expect, it } from "vitest";

import { createGitHubApp } from "./app.ts";
import { createAppKeys, serveFakeGitHub } from "./fake-server.ts";
import { createFakeGitHub } from "./fake.ts";
import type { FakeGitHubServer } from "./fake-server.ts";
import { appPermissions, readOnlyPermissions } from "./types.ts";

// Probe W1 (docs/pen-testing/assessments/W1.md), "Installation tokens:
// permissions and repositories requested at mint time; lifetime; where
// they are held; the sandbox's read-only token really is read-only". The
// real GitHub App client mints its tokens from the fake GitHub served over
// HTTP, which records what each mint asked for, as GitHub's
// `POST /app/installations/{id}/access_tokens` takes it.
//
// - Holds: the sandbox's token is minted for the Floor's repository alone,
//   with read permissions only (S2 drives what it can then do); the token
//   that writes is minted for that one repository too, and the two are
//   never the same token.
// - W1-2, fixed: the App's own tokens asked for no permissions, so each
//   carried every permission the installation was granted, whatever AI
//   Office needs; and the one that lists repositories covered every
//   repository of the installation with all of them. Now the token that
//   writes asks for `appPermissions` (and Workflows only if granted), and
//   the listing token for metadata alone.
// - W1-3, fixed: one read-only token served every sandbox, Manager chat
//   session and fact-finding run of a Floor for 55 minutes, and none was
//   ever revoked, so a token a sandbox leaked outlived it by up to an
//   hour. Now each call mints its own, and the client revokes one.

const appId = "4242";
const webShop = "adrianeyre/web-shop";
const blog = "adrianeyre/blog";

const servers: FakeGitHubServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setUp(now: () => Date = () => new Date()) {
  const keys = createAppKeys();
  const fake = createFakeGitHub({ now });
  fake.installRepository(webShop);
  fake.installRepository(blog);
  const server = await serveFakeGitHub(fake, {
    appId,
    publicKey: keys.publicKey,
    now,
  });
  servers.push(server);
  const app = createGitHubApp({
    appId,
    privateKey: keys.privateKey,
    baseUrl: server.url,
    now,
  });
  return { fake, server, app };
}

describe("what each token is minted for", () => {
  it("the sandbox's token: the Floor's repository alone, contents, issues, pull requests and checks, each read", async () => {
    const { server, app } = await setUp();
    await app.repository(webShop).readOnlyToken();
    expect(server.mintedTokens).toEqual([
      {
        installationId: expect.any(Number) as number,
        repositories: ["web-shop"],
        permissions: readOnlyPermissions,
      },
    ]);
    expect(Object.values(readOnlyPermissions)).not.toContain("write");
  });

  it("the token that writes: the Floor's repository alone, and never the token a sandbox is given", async () => {
    const { server, app } = await setUp();
    const client = app.repository(webShop);
    const writable = await client.installationToken();
    const readOnly = await client.readOnlyToken();
    expect(writable.token).not.toBe(readOnly.token);
    expect(server.mintedTokens[0]?.repositories).toEqual(["web-shop"]);
  });

  it("W1-2: the token that writes asks for only the permissions AI Office needs (appPermissions), not all the installation has", async () => {
    const { server, app } = await setUp();
    await app.repository(webShop).installationToken();
    expect(server.mintedTokens[0]?.permissions).toEqual(appPermissions);
  });

  it("regression (W1-2): the token that writes no longer asks for no permissions, so it does not carry every one the installation was granted", async () => {
    const { fake, server, app } = await setUp();
    // More than the guide's table, granted by mistake.
    fake.grantPermissions(webShop, {
      administration: "read",
      secrets: "write",
    });
    const { token } = await app.repository(webShop).installationToken();
    expect(server.mintedTokens).toHaveLength(1);
    expect(server.mintedTokens[0]).toHaveProperty("permissions");
    expect(server.mintedTokens[0]?.permissions).toEqual(appPermissions);
    expect(fake.tokenScope(token)?.permissions).not.toHaveProperty(
      "administration",
    );
  });

  it("W1-2: the token that writes asks for Workflows too when, and only when, the Owner granted it, so Agents may change CI as the guide offers", async () => {
    let clock = new Date("2026-10-11T12:00:00Z");
    const { fake, server, app } = await setUp(() => clock);
    await app.repository(webShop).installationToken();
    fake.grantPermissions(webShop, { workflows: "write" });
    // Read again at the next mint, once the first token is near its end.
    clock = new Date(clock.getTime() + 56 * 60_000);
    await app.repository(webShop).installationToken();
    expect(server.mintedTokens.map(({ permissions }) => permissions)).toEqual([
      appPermissions,
      { ...appPermissions, workflows: "write" },
    ]);
  });

  it("W1-2: the token that lists the installation's repositories reads metadata only", async () => {
    const { server, app } = await setUp();
    await app.repositories();
    expect(server.mintedTokens[0]?.permissions).toEqual({
      metadata: "read",
    });
  });

  it("regression (W1-2): the token that lists repositories no longer asks for no permissions: it lists every repository of the installation, with metadata alone", async () => {
    const { server, app } = await setUp();
    const listed = await app.repositories();
    expect(listed.map(({ fullName }) => fullName).sort()).toEqual([
      blog,
      webShop,
    ]);
    expect(server.mintedTokens).toHaveLength(1);
    // Listing is its use, so it covers the installation's repositories.
    expect(server.mintedTokens[0]).not.toHaveProperty("repositories");
    expect(server.mintedTokens[0]).toHaveProperty("permissions", {
      metadata: "read",
    });
  });
});

describe("how long a token lives, and who shares it", () => {
  it("a token is GitHub's hour, replaced five minutes before it ends", async () => {
    let clock = new Date("2026-10-11T12:00:00Z");
    const { server, app } = await setUp(() => clock);
    const client = app.repository(webShop);
    const first = await client.readOnlyToken();
    expect(first.expiresAt.getTime() - clock.getTime()).toBe(60 * 60_000);
    clock = new Date(clock.getTime() + 56 * 60_000);
    const second = await client.readOnlyToken();
    expect(second.token).not.toBe(first.token);
    expect(server.mintedTokens).toHaveLength(2);
  });

  it("W1-3: each sandbox's read-only token is its own, so one leaked names one sandbox and can be revoked with it", async () => {
    const { app } = await setUp();
    const client = app.repository(webShop);
    const ada = await client.readOnlyToken();
    const bea = await client.readOnlyToken();
    expect(bea.token).not.toBe(ada.token);
  });

  it("regression (W1-3): one read-only token is no longer handed to every caller for 55 minutes, and the client revokes one", async () => {
    let clock = new Date("2026-10-11T12:00:00Z");
    const { fake, server, app } = await setUp(() => clock);
    const client = app.repository(webShop);
    const ada = await client.readOnlyToken();
    clock = new Date(clock.getTime() + 54 * 60_000);
    const bea = await client.readOnlyToken();
    expect(bea.token).not.toBe(ada.token);
    expect(server.mintedTokens).toHaveLength(2);
    // GitHub's `DELETE /installation/token`, on the client.
    expect(
      Object.keys(client).filter((name) =>
        /revoke|forget|delete.*token/i.test(name),
      ),
    ).toEqual(["revokeToken"]);
    await client.revokeToken(ada.token);
    expect(fake.tokenScope(ada.token)).toBeUndefined();
    expect(fake.tokenScope(bea.token)).toBeDefined();
  });

  it("W1-3: a revoked token reads nothing more, while another sandbox's still reads; revoking it again is no error", async () => {
    const { server, app } = await setUp();
    const client = app.repository(webShop);
    const ada = await client.readOnlyToken();
    const bea = await client.readOnlyToken();
    const read = (token: string) =>
      fetch(`${server.url}/repos/${webShop}`, {
        headers: { authorization: `token ${token}` },
      });
    expect((await read(ada.token)).status).toBe(200);
    await client.revokeToken(ada.token);
    expect((await read(ada.token)).status).toBe(401);
    expect((await read(bea.token)).status).toBe(200);
    await expect(client.revokeToken(ada.token)).resolves.toBeUndefined();
  });
});
