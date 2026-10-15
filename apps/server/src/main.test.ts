import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  aiAccounts,
  events,
  gatewayKeys,
  gatewayRequests,
  officeSettings,
} from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import { startFakeProxy } from "@ai-office/gateway/testing";
import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config.ts";
import { startServer } from "./server.ts";

const main = fileURLToPath(new URL("main.ts", import.meta.url));

const env = {
  DATABASE_URL: "postgres://ai_office:db-pass-0f3a9c@127.0.0.1:1/ai_office",
  SESSION_SECRET: "session-secret-6b1d0e9f4c2a8b7e5d3f1a0c9e8b7d6a",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  LOG_LEVEL: "silent",
};

/** Runs `node src/main.ts` with only `extraEnv` (and PATH) set. */
async function runMain(
  extraEnv: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [main],
      {
        env: { PATH: process.env["PATH"] ?? "", ...extraEnv },
        timeout: 20_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return failure;
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  });

describe("starting the server", () => {
  it("stops start-up with a message naming ENCRYPTION_KEY when it is missing", async () => {
    const withoutKey: Record<string, string> = { ...env };
    delete withoutKey["ENCRYPTION_KEY"];
    const result = await runMain(withoutKey);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("AI Office cannot start");
    expect(result.stderr).toContain("ENCRYPTION_KEY is required");
    expect(result.stdout).toBe("");
    // The values that were given are not echoed back.
    expect(result.stderr).not.toContain(env.SESSION_SECRET);
    expect(result.stderr).not.toContain("db-pass-0f3a9c");
  });

  it("refuses before listening or connecting", async () => {
    await expect(startServer({})).rejects.toThrow(ConfigError);
  });

  it("listens and reports the database on /health", async () => {
    const port = await freePort();
    const app = await startServer({
      ...env,
      HOST: "127.0.0.1",
      PORT: String(port),
      GATEWAY_PORT: String(await freePort()),
      WEB_DIST_DIR: "/nonexistent",
    });
    try {
      // Nothing listens on 127.0.0.1:1, so the database is down.
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: "unavailable",
        database: "down",
      });
    } finally {
      await app.close();
    }
  });

  it("starts the AI Gateway on GATEWAY_PORT and closes it with the app", async () => {
    const gatewayPort = await freePort();
    const app = await startServer({
      ...env,
      HOST: "127.0.0.1",
      PORT: String(await freePort()),
      GATEWAY_PORT: String(gatewayPort),
      WEB_DIST_DIR: "/nonexistent",
    });
    const gateway = `http://127.0.0.1:${String(gatewayPort)}`;
    try {
      const send = (headers: Record<string, string>) =>
        fetch(`${gateway}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
        });
      // Without a Gateway Key, it is refused before anything is read.
      const unauthorized = await send({});
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toMatchObject({
        error: { type: "authentication_error" },
      });
      // Nothing listens on 127.0.0.1:1, so its Gateway Keys cannot be read.
      const response = await send({
        "x-api-key": "aio_gk_mainteststandinkey0000000000000000000000",
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { message: "The AI Gateway could not check its Gateway Keys." },
      });
    } finally {
      await app.close();
    }
    await expect(fetch(`${gateway}/health`)).rejects.toThrow();
  });
});

describe("the AI Gateway and the AI Accounts added in Admin", () => {
  postgresTest(
    "serves from an account added through the API, with its key sealed in the database",
    async ({ database }) => {
      const apiKey = "sk-ant-api03-servertestkey-0000000000000000";
      const received: { url: string; key: string | undefined }[] = [];
      const upstream = createHttpServer((request, response) => {
        received.push({
          url: request.url ?? "",
          key: request.headers["x-api-key"] as string | undefined,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 3 }));
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const upstreamPort = (upstream.address() as AddressInfo).port;
      const port = await freePort();
      const gatewayPort = await freePort();
      const app = await startServer({
        ...env,
        DATABASE_URL: database.url,
        HOST: "127.0.0.1",
        PORT: String(port),
        GATEWAY_PORT: String(gatewayPort),
        WEB_DIST_DIR: "/nonexistent",
        // The AI Provider here is on loopback (ADR 0007).
        ALLOWED_INTERNAL_HOSTS: "127.0.0.1",
      });
      const base = `http://127.0.0.1:${String(port)}`;
      const gateway = `http://127.0.0.1:${String(gatewayPort)}`;
      let gatewayKey = "";
      const countTokens = () =>
        fetch(`${gateway}/v1/messages/count_tokens`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${gatewayKey}`,
          },
          body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
        });
      try {
        const password = "Tr0ub4dor&3x-main-test";
        const json = { "content-type": "application/json" };
        await fetch(`${base}/api/setup`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ password }),
        });
        const login = await fetch(`${base}/api/login`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ password }),
        });
        const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
        const { csrfToken } = (await (
          await fetch(`${base}/api/session`, {
            headers: { cookie: cookie ?? "" },
          })
        ).json()) as { csrfToken: string };
        // A Gateway Key for an Owner tool, to call the Gateway with.
        const made = await fetch(`${base}/api/gateway-keys`, {
          method: "POST",
          headers: { ...json, cookie: cookie ?? "", "x-csrf-token": csrfToken },
          body: JSON.stringify({ name: "Test tool" }),
        });
        expect(made.status).toBe(201);
        gatewayKey = ((await made.json()) as { key: string }).key;
        const [keyRow] = await database.db.select().from(gatewayKeys);
        expect(JSON.stringify(keyRow)).not.toContain(gatewayKey);

        // No AI Account yet.
        expect((await countTokens()).status).toBe(503);

        const added = await fetch(`${base}/api/ai-accounts`, {
          method: "POST",
          headers: { ...json, cookie: cookie ?? "", "x-csrf-token": csrfToken },
          body: JSON.stringify({
            name: "Work",
            aiProvider: "Claude",
            accountType: "api_key",
            credential: apiKey,
            endpointUrl: `http://127.0.0.1:${String(upstreamPort)}`,
          }),
        });
        expect(added.status).toBe(201);
        expect(await added.text()).not.toContain(apiKey);

        // Served at once, without a restart.
        expect(await (await countTokens()).json()).toEqual({ input_tokens: 3 });
        // Adding it also reads its Models into the catalogue, at once.
        expect(
          received.filter(({ url }) => !url.startsWith("/v1/models")),
        ).toEqual([{ url: "/v1/messages/count_tokens", key: apiKey }]);

        const [row] = await database.db.select().from(aiAccounts);
        expect(row?.credential).toMatch(/^aio1:/);
        expect(JSON.stringify(row)).not.toContain(apiKey);
        await vi.waitFor(async () => {
          expect(
            await database.db
              .select({
                account: gatewayRequests.account,
                ownerTool: gatewayRequests.ownerTool,
              })
              .from(gatewayRequests),
          ).toEqual([
            { account: null, ownerTool: "Test tool" },
            { account: "Work", ownerTool: "Test tool" },
          ]);
        });
        const stored = await database.db.select().from(events);
        expect(JSON.stringify(stored)).not.toContain(apiKey);
        expect(JSON.stringify(stored)).not.toContain(gatewayKey);
      } finally {
        await app.close();
        upstream.close();
      }
    },
  );
});

describe("the AI Gateway and the outbound proxy set in Admin", () => {
  postgresTest(
    "sends the Gateway's requests through the proxy the Owner sets, at once, its password sealed",
    async ({ database }) => {
      const apiKey = "sk-ant-api03-proxytestkey-00000000000000000";
      const upstream = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 3 }));
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
      const authorization = `Basic ${Buffer.from("office:pr0xy-pa55").toString("base64")}`;
      // The AI Provider's name resolves nowhere but through the proxy.
      const proxy = await startFakeProxy({
        hosts: { "api.anthropic.test": upstreamUrl },
        proxyAuthorization: authorization,
      });
      const port = await freePort();
      const gatewayPort = await freePort();
      const app = await startServer({
        ...env,
        DATABASE_URL: database.url,
        HOST: "127.0.0.1",
        PORT: String(port),
        GATEWAY_PORT: String(gatewayPort),
        WEB_DIST_DIR: "/nonexistent",
        // The proxy is on loopback, and the AI Provider is plain http://
        // (ADR 0007).
        ALLOWED_INTERNAL_HOSTS: "127.0.0.1,api.anthropic.test",
      });
      const base = `http://127.0.0.1:${String(port)}`;
      const gateway = `http://127.0.0.1:${String(gatewayPort)}`;
      try {
        const password = "Tr0ub4dor&3x-proxy-test";
        const json = { "content-type": "application/json" };
        await fetch(`${base}/api/setup`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ password }),
        });
        const login = await fetch(`${base}/api/login`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ password }),
        });
        const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
        const { csrfToken } = (await (
          await fetch(`${base}/api/session`, {
            headers: { cookie: cookie ?? "" },
          })
        ).json()) as { csrfToken: string };
        const owner = {
          ...json,
          cookie: cookie ?? "",
          "x-csrf-token": csrfToken,
        };
        const made = await fetch(`${base}/api/gateway-keys`, {
          method: "POST",
          headers: owner,
          body: JSON.stringify({ name: "Test tool" }),
        });
        const { key: gatewayKey } = (await made.json()) as { key: string };
        await fetch(`${base}/api/ai-accounts`, {
          method: "POST",
          headers: owner,
          body: JSON.stringify({
            name: "Work",
            aiProvider: "Claude",
            accountType: "api_key",
            credential: apiKey,
            endpointUrl: "http://api.anthropic.test",
          }),
        });
        const countTokens = () =>
          fetch(`${gateway}/v1/messages/count_tokens`, {
            method: "POST",
            headers: { ...json, authorization: `Bearer ${gatewayKey}` },
            body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
          }).then(async (response) => {
            await response.body?.cancel();
            return response.status;
          });
        const setProxy = (body: object) =>
          fetch(`${base}/api/office/outbound-proxy`, {
            method: "PUT",
            headers: owner,
            body: JSON.stringify(body),
          });

        // No proxy: the AI Provider cannot be reached.
        expect(await countTokens()).toBe(502);
        const set = await setProxy({
          url: proxy.url,
          username: "office",
          password: "pr0xy-pa55",
        });
        expect(set.status).toBe(200);
        expect(await set.text()).not.toContain("pr0xy-pa55");
        // Through the proxy, without a restart.
        await vi.waitFor(async () => {
          expect(await countTokens()).toBe(200);
        });
        expect(proxy.proxied.at(-1)).toEqual({
          method: "POST",
          target: "http://api.anthropic.test/v1/messages/count_tokens",
          proxyAuthorization: authorization,
        });
        const [row] = await database.db.select().from(officeSettings);
        expect(row?.gatewayOutboundProxyPassword).toMatch(/^aio1:/);
        expect(JSON.stringify(row)).not.toContain("pr0xy-pa55");
        const stored = await database.db.select().from(events);
        expect(JSON.stringify(stored)).not.toContain("pr0xy-pa55");

        // Turned off, again at once: unreachable (502, or 503 once the
        // account's circuit has opened), and the proxy sees no more.
        expect((await setProxy({ url: null })).status).toBe(200);
        const seen = proxy.proxied.length;
        await vi.waitFor(
          async () => {
            expect([502, 503]).toContain(await countTokens());
          },
          { timeout: 10_000 },
        );
        expect(proxy.proxied).toHaveLength(seen);
      } finally {
        await app.close();
        await proxy.close();
        upstream.close();
      }
    },
  );
});
