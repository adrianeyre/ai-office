import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { gatewayRequests } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  buildGateway,
  createGatewayKeys,
  databaseGatewayKeyStore,
  databaseRequestLog,
  memoryGatewayKeyStore,
  memoryRequestLog,
  staticAccounts,
  type GatewayKeys,
  type GatewayKeyStore,
  type GatewayRequestRecord,
  type RequestLog,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  defaultTeam,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  apiErrorSchema,
  createdGatewayKeySchema,
  createRedactor,
  gatewayKeyListSchema,
  gatewayKeySchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  testPassword,
  type SignedIn,
} from "../test-support.ts";

// The Gateway Keys API (PRD FR-42, FR-46; ADR 0001): Owner tools' keys,
// made (shown once), listed and revoked; Agents' keys, made with each new
// Agent and rotated. A key never appears in a list, an event or a log
// line. Each case runs in memory and in Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly keys: GatewayKeys;
  readonly stores: OfficeStores;
  readonly bus: EventBus;
  readonly requestLog: RequestLog;
  /** Every request record, oldest first. */
  records(): Promise<Partial<Record<keyof GatewayRequestRecord, unknown>>[]>;
  /** Every log line the server wrote. */
  readonly logs: string[];
}

async function setUp(
  stores: OfficeStores,
  keyStore: GatewayKeyStore,
  bus: EventBus,
  requestLog: RequestLog,
  records: () => Promise<
    Partial<Record<keyof GatewayRequestRecord, unknown>>[]
  >,
): Promise<Setup> {
  const logs: string[] = [];
  const redactor = createRedactor();
  const keys = createGatewayKeys({
    store: keyStore,
    encryptor: testEncryptor,
    events: bus,
    onKey: (key) => {
      redactor.register(key);
    },
  });
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const server = await buildApp({
    logger: createLogger({
      level: "trace",
      secrets: [],
      redactor,
      destination: { write: (line: string) => logs.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    gatewayKeys: keys,
  });
  return {
    server,
    owner: await signIn(server),
    keys,
    stores,
    bus,
    requestLog,
    records,
    logs,
  };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const listKeys = async (setup: Setup) => {
  const response = await request(setup, "GET", "/api/gateway-keys");
  expect(response.statusCode).toBe(200);
  return gatewayKeyListSchema.parse(response.json()).keys;
};

/**
 * Sends a request through a Gateway that checks `setup.keys`, with `key`,
 * to a fake AI Provider; resolves with its status.
 */
async function callGateway(setup: Setup, key: string): Promise<number> {
  const provider = createServer((incoming, response) => {
    incoming.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 2 }));
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, "127.0.0.1", resolve);
  });
  const gateway = await buildGateway({
    logger: pino({ level: "silent" }),
    accounts: staticAccounts({
      id: null,
      name: "test-account",
      apiKey: "sk-ant-api03-routetestaccountkey-000000000000",
      baseUrl: `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`,
    }),
    keys: setup.keys,
    requestLog: setup.requestLog,
  });
  try {
    const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
    });
    await response.arrayBuffer();
    return response.status;
  } finally {
    await gateway.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
}

/** Nothing the server sent, published or logged holds `key`. */
const expectNowhere = async (setup: Setup, key: string, bodies: string[]) => {
  const everything = [
    ...bodies,
    JSON.stringify(await setup.bus.eventsAfter(0)),
    ...setup.logs,
  ].join("\n");
  expect(everything).not.toContain(key);
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "makes an Owner tool's key, shown once, then lists it without the key",
    async (setup) => {
      const response = await request(setup, "POST", "/api/gateway-keys", {
        name: "Claude Code on my laptop",
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const { gatewayKey, key } = createdGatewayKeySchema.parse(
        response.json(),
      );
      expect(Object.keys(gatewayKey).sort()).toEqual(
        [
          "id",
          "kind",
          "name",
          "agentId",
          "floorId",
          "hint",
          "createdAt",
          "lastUsedAt",
          "revokedAt",
          "profile",
          "access",
          "enabled",
        ].sort(),
      );
      expect(gatewayKey).toMatchObject({
        kind: "owner_tool",
        name: "Claude Code on my laptop",
        hint: key.slice(0, 11),
        lastUsedAt: null,
      });
      const listed = await request(setup, "GET", "/api/gateway-keys");
      expect(gatewayKeyListSchema.parse(listed.json()).keys).toEqual([
        gatewayKey,
      ]);
      // Its first use shows in the list.
      expect(await callGateway(setup, key)).toBe(200);
      await vi.waitFor(async () => {
        expect((await listKeys(setup))[0]?.lastUsedAt).not.toBeNull();
      });
      await expectNowhere(setup, key, [listed.body]);
      expect(setup.logs.join("")).toContain(
        "A Gateway Key was made for an Owner tool.",
      );
    },
  ],
  [
    "refuses a nameless key, and a second one of a name in use",
    async (setup) => {
      const nameless = await request(setup, "POST", "/api/gateway-keys", {
        name: " ",
      });
      expect(nameless.statusCode).toBe(400);
      expect(
        (
          await request(setup, "POST", "/api/gateway-keys", {
            name: "Codex",
            key: "aio_gk_chosenbythecaller000000000000",
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await request(setup, "POST", "/api/gateway-keys", { name: "Codex" }))
          .statusCode,
      ).toBe(201);
      const again = await request(setup, "POST", "/api/gateway-keys", {
        name: "Codex",
      });
      expect(again.statusCode).toBe(409);
      expect(apiErrorSchema.parse(again.json()).error).toBe(
        "gateway_key_name_taken",
      );
    },
  ],
  [
    "revokes an Owner tool's key: the Gateway refuses it from then on",
    async (setup) => {
      const { gatewayKey, key } = createdGatewayKeySchema.parse(
        (
          await request(setup, "POST", "/api/gateway-keys", { name: "Codex" })
        ).json(),
      );
      expect(await callGateway(setup, key)).toBe(200);
      const revoked = await request(
        setup,
        "DELETE",
        `/api/gateway-keys/${gatewayKey.id}`,
      );
      expect(revoked.statusCode).toBe(204);
      expect(await callGateway(setup, key)).toBe(401);
      expect(await listKeys(setup)).toEqual([]);
      expect(
        (await request(setup, "DELETE", `/api/gateway-keys/${gatewayKey.id}`))
          .statusCode,
      ).toBe(404);
    },
  ],
  [
    "names who uses a key, in British time until set, and refuses an unknown time zone",
    async (setup) => {
      const { gatewayKey } = createdGatewayKeySchema.parse(
        (
          await request(setup, "POST", "/api/gateway-keys", { name: "Codex" })
        ).json(),
      );
      expect(gatewayKey.profile).toEqual({
        nickname: "",
        timeZone: "Europe/London",
      });
      const profile = { nickname: "Ade", timeZone: "Asia/Tokyo" };
      const set = await request(
        setup,
        "PUT",
        `/api/gateway-keys/${gatewayKey.id}/profile`,
        profile,
      );
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ id: gatewayKey.id, profile });
      expect(
        (await listKeys(setup)).find(({ id }) => id === gatewayKey.id)?.profile,
      ).toEqual(profile);
      expect(
        (
          await request(
            setup,
            "PUT",
            `/api/gateway-keys/${gatewayKey.id}/profile`,
            { ...profile, timeZone: "Mars/Olympus" },
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await request(
            setup,
            "PUT",
            "/api/gateway-keys/nowhere/profile",
            profile,
          )
        ).statusCode,
      ).toBe(404);
    },
  ],
  [
    "renames, disables and enables an Owner tool's key: a disabled key is refused",
    async (setup) => {
      const { gatewayKey, key } = createdGatewayKeySchema.parse(
        (
          await request(setup, "POST", "/api/gateway-keys", { name: "Codex" })
        ).json(),
      );
      expect(gatewayKey).toMatchObject({ access: "proxy", enabled: true });
      const url = `/api/gateway-keys/${gatewayKey.id}`;
      const renamed = await request(setup, "PATCH", url, { name: "Codex CLI" });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ name: "Codex CLI" });

      const disabled = await request(setup, "PATCH", url, { enabled: false });
      expect(disabled.json()).toMatchObject({ enabled: false });
      expect(await callGateway(setup, key)).toBe(401);
      await request(setup, "PATCH", url, { enabled: true });
      expect(await callGateway(setup, key)).toBe(200);

      expect((await request(setup, "PATCH", url, {})).statusCode).toBe(400);
      await request(setup, "POST", "/api/gateway-keys", { name: "Aider" });
      expect(
        (await request(setup, "PATCH", url, { name: "Aider" })).statusCode,
      ).toBe(409);
    },
  ],
  [
    "signs in to the web app with a key of AI proxy and UI access, until it is disabled",
    async (setup) => {
      // A key that signs in needs a fresh proof of the Owner (A1-3).
      const created = (access: string, name: string) =>
        request(setup, "POST", "/api/gateway-keys", {
          name,
          access,
          ...(access === "proxy_and_ui"
            ? { currentPassword: testPassword }
            : {}),
        }).then((response) => createdGatewayKeySchema.parse(response.json()));
      const ui = await created("proxy_and_ui", "My laptop");
      const proxy = await created("proxy", "A script");
      expect(ui.gatewayKey.access).toBe("proxy_and_ui");
      const signIn = (key: string) =>
        setup.server.inject({
          method: "POST",
          url: "/api/login/api-key",
          payload: { key },
        });

      // A key that only proxies cannot sign in, nor can an unknown one.
      for (const key of [proxy.key, "aio_gk_nothing"]) {
        const refused = await signIn(key);
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({ error: "wrong_api_key" });
      }

      const signedIn = await signIn(ui.key);
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json()).toMatchObject({
        gatewayKeyId: ui.gatewayKey.id,
      });
      const cookie = String(signedIn.headers["set-cookie"]).split(";")[0];
      const session = () =>
        setup.server.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie },
        });
      expect((await session()).statusCode).toBe(200);
      // Its key still works as an AI proxy too.
      expect(await callGateway(setup, ui.key)).toBe(200);

      // Disabled, its session ends, and it cannot sign in again.
      await request(setup, "PATCH", `/api/gateway-keys/${ui.gatewayKey.id}`, {
        enabled: false,
      });
      expect((await session()).statusCode).toBe(401);
      expect((await signIn(ui.key)).statusCode).toBe(401);
    },
  ],
  [
    "lists each key's usage",
    async (setup) => {
      const response = await request(setup, "GET", "/api/gateway-keys/usage");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ usage: [] });
    },
  ],
  [
    "gives each new Agent a working key, attributed to it and its Floor",
    async (setup) => {
      const added = await request(setup, "POST", "/api/floors", {
        repository: "adrianeyre/web-shop",
      });
      expect(added.statusCode).toBe(201);
      const agents = agentListSchema.parse(
        (await request(setup, "GET", "/api/floors/web-shop/agents")).json(),
      ).agents;
      expect(agents).toHaveLength(4);
      await vi.waitFor(async () => {
        expect(await listKeys(setup)).toHaveLength(4);
      });
      const listed = await listKeys(setup);
      expect(listed.map(({ agentId }) => agentId).sort()).toEqual(
        agents.map(({ id }) => id).sort(),
      );
      for (const key of listed) {
        expect(key).toMatchObject({ kind: "agent", floorId: "web-shop" });
        expect(key.name).toBe(
          agents.find(({ id }) => id === key.agentId)?.name,
        );
      }

      const [coder] = agents.filter(({ role }) => role === "coder");
      const coderKey = (await setup.keys.agentKey(coder?.id ?? "")) ?? "";
      expect(await callGateway(setup, coderKey)).toBe(200);
      await vi.waitFor(async () => {
        expect(await setup.records()).toHaveLength(1);
      });
      expect((await setup.records())[0]).toMatchObject({
        agentId: coder?.id,
        floorId: "web-shop",
        ownerTool: null,
        gatewayKeyId: listed.find(({ agentId }) => agentId === coder?.id)?.id,
      });
      await expectNowhere(setup, coderKey, [added.body]);
    },
  ],
  [
    "rotates an Agent's key, and will not revoke it on its own",
    async (setup) => {
      await request(setup, "POST", "/api/floors", {
        repository: "adrianeyre/web-shop",
      });
      const [agent] = agentListSchema.parse(
        (await request(setup, "GET", "/api/floors/web-shop/agents")).json(),
      ).agents;
      const agentId = agent?.id ?? "";
      await vi.waitFor(async () => {
        expect(await setup.keys.agentKey(agentId)).toBeDefined();
      });
      const before = (await setup.keys.agentKey(agentId)) ?? "";
      const old = await setup.keys.agentKeyInfo(agentId);

      const refused = await request(
        setup,
        "DELETE",
        `/api/gateway-keys/${old?.id ?? ""}`,
      );
      expect(refused.statusCode).toBe(409);

      const rotated = await request(
        setup,
        "POST",
        `/api/floors/web-shop/agents/${agentId}/gateway-key/rotate`,
      );
      expect(rotated.statusCode).toBe(200);
      const info = gatewayKeySchema.parse(rotated.json());
      expect(info).toMatchObject({ kind: "agent", agentId });
      expect(info.id).not.toBe(old?.id);
      const after = (await setup.keys.agentKey(agentId)) ?? "";
      expect(after).not.toBe(before);
      expect(await callGateway(setup, before)).toBe(401);
      expect(await callGateway(setup, after)).toBe(200);
      await expectNowhere(setup, after, [rotated.body]);

      expect(
        (
          await request(
            setup,
            "POST",
            "/api/floors/web-shop/agents/nobody/gateway-key/rotate",
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await request(
            setup,
            "POST",
            `/api/floors/no-such-floor/agents/${agentId}/gateway-key/rotate`,
          )
        ).statusCode,
      ).toBe(404);
    },
  ],
  [
    "revokes an Agent's key when the Agent is removed",
    async (setup) => {
      await request(setup, "POST", "/api/floors", {
        repository: "adrianeyre/web-shop",
      });
      const [agent] = agentListSchema.parse(
        (await request(setup, "GET", "/api/floors/web-shop/agents")).json(),
      ).agents;
      const agentId = agent?.id ?? "";
      await vi.waitFor(async () => {
        expect(await setup.keys.agentKey(agentId)).toBeDefined();
      });
      const key = (await setup.keys.agentKey(agentId)) ?? "";
      await setup.bus.publish({
        type: "agent.removed",
        version: 1,
        floorId: "web-shop",
        agentId,
      });
      await vi.waitFor(async () => {
        expect(await setup.keys.agentKey(agentId)).toBeUndefined();
      });
      expect(await callGateway(setup, key)).toBe(401);
    },
  ],
  [
    "gives Agents made before Gateway Keys theirs when the app is ready",
    async (setup) => {
      // A Floor and its team, straight into the stores, with no event.
      const createdAt = new Date();
      const result = await setup.stores.floors.create(
        {
          id: "blog",
          githubRepositoryId: 99,
          template: { id: "development", name: "Development" },
          theme: "office",
          repository: "adrianeyre/blog",
          name: "blog",
          defaultBranch: "main",
          setupCommand: "",
          testCommand: "",
          mergePolicy: "send_to_me",
          roundCap: 3,
          tokenCaps: { daily: null, monthly: null },
          concurrencyLimit: null,
          priority: 0,
          requiredReviewerAgentIds: [],
          planApproval: true,
          mostAgents: 8,
          spinOffFromChat: true,
          hourlyStatusUpdates: true,
          freshStartThreshold: 85,
          gitIdentity: null,
          createdAt,
          archivedAt: null,
        },
        defaultTeam({ floorId: "blog", random: Math.random, now: createdAt }),
      );
      expect(result).toBe("created");
      expect(await listKeys(setup)).toEqual([]);

      // As at the next start.
      const restarted = await buildApp({
        logger: createLogger({ level: "silent", secrets: [] }),
        checkDatabase: () => Promise.resolve(true),
        webDistDir: "/nonexistent",
        auth: await testAuth(),
        events: setup.bus,
        stores: setup.stores,
        gatewayKeys: setup.keys,
      });
      await restarted.ready();
      await restarted.close();
      const keys = await setup.keys.list();
      expect(keys).toHaveLength(4);
      for (const key of keys) {
        expect(await setup.keys.agentKey(key.agentId ?? "")).toMatch(
          /^aio_gk_/,
        );
      }
    },
  ],
];

describe("the Gateway Keys API, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const requestLog = memoryRequestLog();
      const setup = await setUp(
        memoryStores(),
        memoryGatewayKeyStore(),
        createEventBus({ store: memoryEventStore() }),
        requestLog,
        () => Promise.resolve([...requestLog.records]),
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});

describe("the Gateway Keys API, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        databaseGatewayKeyStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
        databaseRequestLog(database.db),
        async () =>
          await database.db
            .select()
            .from(gatewayRequests)
            .orderBy(gatewayRequests.id),
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});
