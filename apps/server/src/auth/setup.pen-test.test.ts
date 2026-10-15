import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.ts";
import { probedApp } from "../pen-test-support.ts";
import { signIn } from "../test-support.ts";
import { setupToken, writeSetupToken } from "./setup-token.ts";

// A1 probe (pen-testing, "Sign-in and sessions"): the first-run setup
// screen (H4, FR-1). Until a password exists, `POST /api/setup` makes
// whoever calls it the Owner. Position 1: a network caller that reaches
// the app before the Owner does, directly or through the Owner's browser.

const attackerPassword = "Pen-Test-Attacker-Pass-42";

const setup = (
  server: FastifyInstance,
  from: {
    remoteAddress?: string;
    headers?: Record<string, string>;
    token?: string;
  } = {},
) =>
  server.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      password: attackerPassword,
      ...(from.token === undefined ? {} : { token: from.token }),
    },
    remoteAddress: from.remoteAddress ?? "127.0.0.1",
    ...(from.headers === undefined ? {} : { headers: from.headers }),
  });

/** The one-time setup token, as the server writes it to a file (A1-2). */
const ownerToken = "pen-test-setup-token-0000000000000000";
const withToken = () => ({
  setupToken: setupToken(ownerToken, "/tmp/ai-office-setup-test/token"),
});

/** What a DNS-rebinding page sends: its own name, now resolving to the app. */
const rebinding = {
  host: "rebind.attacker.example:3045",
  origin: "http://rebind.attacker.example:3045",
  "sec-fetch-site": "same-origin",
};

describe("A1-2: who may set the first password", () => {
  it("setup is bound to this machine or to a one-time token, not open to any address", async () => {
    const { server } = await probedApp({ setUp: false });
    const response = await setup(server, { remoteAddress: "198.51.100.7" });
    expect(response.statusCode).not.toBe(204);
  });

  it("regression (A1-2): a caller from another address, with nothing but the password it chooses, no longer becomes the Owner", async () => {
    const { server, store } = await probedApp({
      setUp: false,
      ...withToken(),
    });
    const response = await setup(server, { remoteAddress: "198.51.100.7" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "setup_token_required" });
    expect(store.state.passwordHash).toBeUndefined();
    // ...and cannot sign in with it: there is still no password at all.
    await expect(signIn(server, attackerPassword)).rejects.toThrow();
  });

  it("a request for a name AI Office is not served at cannot set the password (DNS rebinding)", async () => {
    const { server } = await probedApp({
      setUp: false,
      publicUrl: "http://localhost:3045",
    });
    const response = await setup(server, { headers: rebinding });
    expect(response.statusCode).not.toBe(204);
  });

  it("regression (A1-2): Origin matching Host no longer lets a rebinding page set up, from loopback and with the token alike", async () => {
    const { server, store } = await probedApp({
      setUp: false,
      publicUrl: "http://localhost:3045",
      ...withToken(),
    });
    for (const token of [undefined, ownerToken]) {
      const response = await setup(server, {
        headers: rebinding,
        ...(token === undefined ? {} : { token }),
      });
      expect(response.statusCode).toBe(421);
      expect(response.json()).toMatchObject({ error: "wrong_host" });
    }
    expect(store.state.passwordHash).toBeUndefined();
  });
});

describe("A1-2: where setup is reachable before the Owner", () => {
  it("regression (A1-2): outside compose (pnpm dev, pnpm start) the server no longer listens on every interface unless HOST says so", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://ai_office:pen-test-db@localhost:3048/ai_office",
      SESSION_SECRET: "pen-test-session-secret-0000000000000000",
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    expect(config.host).toBe("127.0.0.1");
    // As the AI Gateway and the OAuth callback already default to loopback.
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.oauthCallbackHost).toBe("127.0.0.1");
  });
});

describe("A1-2 · what from the host lets a setup through", () => {
  it("the one-time setup token lets the Owner set up from another machine", async () => {
    const { server, store, lines } = await probedApp({
      setUp: false,
      ...withToken(),
    });
    const response = await setup(server, {
      remoteAddress: "198.51.100.7",
      token: ownerToken,
    });
    expect(response.statusCode).toBe(204);
    expect(store.state.passwordHash).toMatch(/^\$argon2id\$/);
    expect(lines.join("\n")).not.toContain(ownerToken);
  });

  it("refuses a wrong token, and says where the right one is, never what it is", async () => {
    const { server, store, lines } = await probedApp({
      setUp: false,
      ...withToken(),
    });
    const response = await setup(server, {
      remoteAddress: "198.51.100.7",
      token: `${ownerToken}-guess`,
    });
    expect(response.statusCode).toBe(403);
    const { message } = response.json<{ message: string }>();
    expect(message).toContain("/tmp/ai-office-setup-test/token");
    expect(message).not.toContain(ownerToken);
    expect(lines.join("\n")).not.toContain(ownerToken);
    expect(store.state.passwordHash).toBeUndefined();
  });

  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"])(
    "needs no token from this machine's loopback (%s)",
    async (remoteAddress) => {
      const { server } = await probedApp({ setUp: false, ...withToken() });
      expect((await setup(server, { remoteAddress })).statusCode).toBe(204);
    },
  );

  it.each(["10.0.0.1", "172.18.0.1", "192.168.1.20", "::ffff:10.0.0.1"])(
    "needs the token from anywhere else, a private network too (%s)",
    async (remoteAddress) => {
      const { server } = await probedApp({ setUp: false });
      expect((await setup(server, { remoteAddress })).statusCode).toBe(403);
    },
  );

  it("a caller cannot claim loopback with X-Forwarded-For (A1-1)", async () => {
    const { server } = await probedApp({ setUp: false, trustProxy: 1 });
    const response = await setup(server, {
      remoteAddress: "198.51.100.7",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(response.statusCode).toBe(403);
  });

  it.each([
    ["PUBLIC_URL's own name", "office.example.com", 204],
    ["localhost", "localhost:3045", 204],
    ["an address", "127.0.0.1:3045", 204],
    ["an IPv6 address", "[::1]:3045", 204],
    ["another name", "office.example.com.attacker.example", 421],
    ["a name that only ends like it", "evil-office.example.com", 421],
  ] as const)("serves setup for %s", async (_, host, status) => {
    const { server } = await probedApp({
      setUp: false,
      publicUrl: "https://office.example.com",
    });
    expect((await setup(server, { headers: { host } })).statusCode).toBe(
      status,
    );
  });

  it("writes the token to a file only this user can read, in a directory of its own, which goes once it is spent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "setup-token-test-"));
    try {
      const token = await writeSetupToken(parent);
      expect(dirname(token.where)).toMatch(/ai-office-setup-[^/]+$/);
      expect((await stat(token.where)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(token.where))).mode & 0o777).toBe(0o700);
      const written = (await readFile(token.where, "utf8")).trim();
      expect(written).toMatch(/^[\w-]{32}$/);
      expect(token.matches(written)).toBe(true);
      expect(token.matches(`${written}x`)).toBe(false);
      // A second start writes a different token, elsewhere.
      const again = await writeSetupToken(parent);
      expect(again.where).not.toBe(token.where);
      expect(again.matches(written)).toBe(false);
      await token.spend();
      await expect(stat(dirname(token.where))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("setup where it holds", () => {
  it("refuses a setup from another site (Origin or Sec-Fetch-Site)", async () => {
    for (const headers of [
      { origin: "https://attacker.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
    ]) {
      const { server, store } = await probedApp({ setUp: false });
      const response = await setup(server, {
        headers: { host: "localhost:3045", ...headers },
      });
      expect(response.statusCode).toBe(403);
      expect(store.state.passwordHash).toBeUndefined();
    }
  });

  it("takes no form or text body, so a cross-site form cannot post one", async () => {
    const { server, store } = await probedApp({ setUp: false });
    const form = await server.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(attackerPassword)}`,
    });
    expect(form.statusCode).toBe(415);
    const text = await server.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({ password: attackerPassword }),
    });
    expect(text.statusCode).toBe(400);
    expect(store.state.passwordHash).toBeUndefined();
  });

  it("is a 404 for good once a password exists, so the Owner cannot be replaced", async () => {
    const { server, store } = await probedApp();
    const before = store.state.passwordHash;
    expect((await setup(server)).statusCode).toBe(404);
    expect(store.state.passwordHash).toBe(before);
    // After a restart on the same database too.
    const restarted = await probedApp({ store });
    expect((await setup(restarted.server)).statusCode).toBe(404);
  });

  it("lets only one of many concurrent setups set the password", async () => {
    const { server } = await probedApp({ setUp: false, ...withToken() });
    const statuses = (
      await Promise.all(
        Array.from({ length: 6 }, () =>
          setup(server, { remoteAddress: "198.51.100.8", token: ownerToken }),
        ),
      )
    ).map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 204)).toHaveLength(1);
    expect(statuses.filter((status) => status === 404)).toHaveLength(5);
  });

  it("before setup, every other route but the public ones says setup_required", async () => {
    const { server } = await probedApp({ setUp: false });
    for (const [method, url] of [
      ["POST", "/api/login"],
      ["POST", "/api/login/api-key"],
      ["GET", "/api/session"],
      ["GET", "/api/events/stream"],
      ["POST", "/api/owner-passwords"],
    ] as const) {
      const response = await server.inject({ method, url, payload: {} });
      expect({ url, status: response.statusCode }).toEqual({
        url,
        status: 403,
      });
      expect(response.json()).toMatchObject({ error: "setup_required" });
    }
  });

  it("stores Argon2id with OWASP's parameters (19 MiB, 2 passes, 1 lane)", async () => {
    const { server, store } = await probedApp({ setUp: false });
    expect((await setup(server)).statusCode).toBe(204);
    expect(store.state.passwordHash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/,
    );
  });
});
