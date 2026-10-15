import { postgresTest } from "@ai-office/db/testing";
import { createLiveGitHub, GitHubNotConfiguredError } from "@ai-office/github";
import { githubConnectionSecretContext } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import { databaseStores, memoryStores } from "../stores.ts";
import {
  createGitHubConnections,
  GitHubConnectionError,
} from "./connections.ts";
import type { GitHubConnectionStore } from "./store.ts";

// The GitHub Apps and access tokens the Owner adds in Floor Settings (ADR
// 0011): kept sealed, never given back, tried Apps first, and taken up by
// the live GitHub as soon as they change.

const encryptor = encryptorFromKey(Buffer.alloc(32, 9));
const pem =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAwxyz\n-----END RSA PRIVATE KEY-----";
const writer = "github_pat_11AAAAAAA0writer9f3c";
const reader = "github_pat_11AAAAAAA0reader7b2e";

type Case = readonly [string, (store: GitHubConnectionStore) => Promise<void>];

function setUp(store: GitHubConnectionStore) {
  const live = createLiveGitHub();
  const secrets: string[] = [];
  let tick = 0;
  let ids = 0;
  const connections = createGitHubConnections({
    store,
    encryptor,
    live,
    onSecret: (secret) => secrets.push(secret),
    // A second apart, so the oldest is first.
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++)),
    newId: () => `connection-${String(++ids)}`,
  });
  return { connections, live, secrets };
}

const cases: readonly Case[] = [
  [
    "adds Apps and access tokens, kept sealed, listed Apps first without their secrets",
    async (store) => {
      const { connections, live, secrets } = setUp(store);
      const token = await connections.addAccessToken({
        token: writer,
        readOnlyToken: reader,
      });
      const app = await connections.addApp({
        name: "Acme's App",
        appId: "123456",
        privateKey: pem,
      });
      expect(token).toMatchObject({
        kind: "access-token",
        name: "Access token …9f3c",
        appId: null,
        hint: "9f3c",
        enabled: true,
      });
      expect(app).toMatchObject({
        kind: "app",
        name: "Acme's App",
        appId: "123456",
        hint: "wxyz",
      });
      const listed = await connections.list();
      expect(listed.map(({ id }) => id)).toEqual([app.id, token.id]);
      expect(JSON.stringify(listed)).not.toContain("MIIE");
      expect(JSON.stringify(listed)).not.toContain(writer);

      const [keptApp, keptToken] = [
        ...(await store.list()).filter(({ kind }) => kind === "app"),
        ...(await store.list()).filter(({ kind }) => kind !== "app"),
      ];
      expect(keptApp?.privateKey).toMatch(/^aio1:/);
      expect(
        encryptor.decrypt(
          keptApp?.privateKey ?? "",
          githubConnectionSecretContext(app.id, "private_key"),
        ),
      ).toBe(pem);
      expect(keptToken?.token).toMatch(/^aio1:/);
      expect(keptToken?.readOnlyToken).toMatch(/^aio1:/);

      expect(await connections.configs()).toEqual([
        { kind: "app", appId: "123456", privateKey: pem },
        { kind: "access-token", token: writer, readOnlyToken: reader },
      ]);
      expect(secrets).toEqual(expect.arrayContaining([pem, writer, reader]));
      expect(live.size).toBe(2);
    },
  ],
  [
    "refuses an App added twice",
    async (store) => {
      const { connections } = setUp(store);
      await connections.addApp({ appId: "1", privateKey: pem });
      const refused = await connections
        .addApp({ appId: "1", privateKey: pem })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(GitHubConnectionError);
      expect((refused as GitHubConnectionError).code).toBe("github_app_taken");
      expect(await connections.list()).toHaveLength(1);
    },
  ],
  [
    "renames, disables and removes, the live GitHub keeping up without a restart",
    async (store) => {
      const { connections, live } = setUp(store);
      const app = await connections.addApp({ appId: "1", privateKey: pem });
      expect(app.name).toBe("GitHub App 1");
      expect(live.size).toBe(1);

      expect(
        await connections.update(app.id, { name: "Work", enabled: false }),
      ).toMatchObject({ name: "Work", enabled: false });
      expect(live.size).toBe(0);
      expect(await connections.configs()).toEqual([]);
      await expect(live.repositories()).rejects.toBeInstanceOf(
        GitHubNotConfiguredError,
      );

      await connections.update(app.id, { enabled: true });
      expect(live.size).toBe(1);
      await connections.remove(app.id);
      expect(live.size).toBe(0);
      expect(await connections.list()).toEqual([]);
      await expect(connections.remove(app.id)).rejects.toThrow(
        "There is no such GitHub connection.",
      );
      await expect(
        connections.update(app.id, { enabled: true }),
      ).rejects.toBeInstanceOf(GitHubConnectionError);
    },
  ],
  [
    "takes up a connection added elsewhere on refresh, and leaves out one no key opens",
    async (store) => {
      const { connections, live } = setUp(store);
      const elsewhere = createGitHubConnections({
        store,
        encryptor,
        newId: () => "from-a-seed",
      });
      await elsewhere.addApp({ appId: "7", privateKey: pem });
      expect(live.size).toBe(0);
      await connections.refresh();
      expect(live.size).toBe(1);

      const unreadable: string[] = [];
      const otherKey = createGitHubConnections({
        store,
        encryptor: encryptorFromKey(Buffer.alloc(32, 1)),
        onUnreadable: (id) => unreadable.push(id),
      });
      expect(await otherKey.configs()).toEqual([]);
      expect(unreadable).toEqual(["from-a-seed"]);
    },
  ],
];

describe("GitHub connections, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => run(memoryStores().githubConnections));
  }
});

describe("GitHub connections, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(databaseStores(database.db).githubConnections),
    );
  }
});
