import { agents, floors, gatewayKeys, gatewayRequests } from "@ai-office/db";
import type { Database } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  communicationsAgentId,
  terminalKeyName,
  gatewayKeyErrorCodes,
  gatewayKeyPrefix,
} from "@ai-office/shared";
import { encryptorFromKey, type Encryptor } from "@ai-office/shared/crypto";
import { describe, expect, it, vi } from "vitest";

import { databaseRequestLog, memoryRequestLog } from "../request-log.ts";
import type { RequestLog } from "../request-log.ts";
import {
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
} from "../test-support.ts";
import { createAgentWork, type AgentWork } from "../work.ts";
import {
  createGatewayKeys,
  GatewayKeyError,
  gatewayKeyContext,
  hashGatewayKey,
  type GatewayKeys,
} from "./keys.ts";
import {
  databaseGatewayKeyStore,
  memoryGatewayKeyStore,
  type GatewayKeyStore,
} from "./store.ts";

// Gateway Keys (PRD FR-42, FR-46; ADR 0001): Agents' keys, made with them
// and rotated; Owner tools' keys, shown once and revoked; and the Gateway
// refusing a request without a key in use, and attributing the rest. Every
// case runs in memory and in Postgres 18.

const encryptor: Encryptor = encryptorFromKey(Buffer.alloc(32, 5));

const ada = { id: "agent-ada", floorId: "web-shop", name: "Ada" };
const bea = { id: "agent-bea", floorId: "web-shop", name: "Bea" };

interface Setup {
  readonly keys: GatewayKeys;
  readonly store: GatewayKeyStore;
  readonly bus: EventBus;
  readonly requestLog: RequestLog & { records?: unknown[] };
  /** Every key `onKey` was told. */
  readonly told: string[];
  /** Moves the clock on. */
  readonly advance: (ms: number) => void;
  /** Every request record, oldest first. */
  records(): Promise<Record<string, unknown>[]>;
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

function setUp(
  store: GatewayKeyStore,
  bus: EventBus,
  requestLog: RequestLog,
  records: () => Promise<Record<string, unknown>[]>,
): Setup {
  const told: string[] = [];
  let time = Date.UTC(2026, 9, 9, 12, 0, 0);
  let id = 0;
  return {
    keys: createGatewayKeys({
      store,
      encryptor,
      events: bus,
      onKey: (key) => told.push(key),
      now: () => new Date(time),
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    }),
    store,
    bus,
    requestLog,
    told,
    advance: (ms) => {
      time += ms;
    },
    records,
  };
}

/** Sends a count_tokens request with `headers`; resolves with its status. */
const send = async (url: string, headers: Record<string, string> = {}) =>
  (
    await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
    })
  ).status;

/** A Gateway with these keys, in front of a fake AI Provider. */
async function withGateway(
  setup: Setup,
  run: (url: string, upstream: FakeUpstream) => Promise<void>,
  work?: AgentWork,
): Promise<void> {
  const upstream = await startFakeUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 3 }));
  });
  const gateway = await startGateway({
    upstream,
    keys: setup.keys,
    requestLog: setup.requestLog,
    ...(work === undefined ? {} : { work }),
  });
  try {
    await run(gateway.url, upstream);
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

const cases: Case[] = [
  [
    "makes an Owner tool's key, shown once and stored only as its hash",
    async ({ keys, store, told, bus }) => {
      const { gatewayKey, key } = await keys.createOwnerToolKey("Claude Code");
      expect(key).toMatch(/^aio_gk_[A-Za-z0-9_-]{43}$/);
      expect(gatewayKey).toEqual({
        id: "00000000-0000-4000-8000-000000000001",
        kind: "owner_tool",
        name: "Claude Code",
        agentId: null,
        floorId: null,
        hint: key.slice(0, gatewayKeyPrefix.length + 4),
        createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 0)),
        lastUsedAt: null,
        revokedAt: null,
        access: "proxy",
        enabled: true,
      });
      const stored = await store.get(gatewayKey.id);
      expect(stored?.keyHash).toBe(hashGatewayKey(key));
      expect(stored?.sealedKey).toBeNull();
      expect(JSON.stringify(stored)).not.toContain(key);
      expect(told).toEqual([key]);
      expect(await keys.list()).toEqual([gatewayKey]);
      const events = await bus.eventsAfter(0);
      expect(events.map(({ event }) => event)).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["gatewayKeys.created"],
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(key);
    },
  ],
  [
    "refuses a second Owner tool key in use with the same name",
    async ({ keys }) => {
      const first = await keys.createOwnerToolKey("Codex");
      await expect(keys.createOwnerToolKey("Codex")).rejects.toMatchObject({
        code: gatewayKeyErrorCodes.gatewayKeyNameTaken,
      });
      // Once it is revoked, the name is free again.
      await keys.revoke(first.gatewayKey.id);
      await expect(keys.createOwnerToolKey("Codex")).resolves.toBeDefined();
    },
  ],
  [
    "authenticates a key in use, and nothing else",
    async ({ keys }) => {
      const { gatewayKey, key } = await keys.createOwnerToolKey("Codex");
      expect(await keys.authenticate(key)).toEqual({
        kind: "owner_tool",
        keyId: gatewayKey.id,
        name: "Codex",
      });
      expect(await keys.authenticate(`${key}x`)).toBeUndefined();
      expect(await keys.authenticate("sk-ant-api03-not-a-gateway-key")).toBe(
        undefined,
      );
      await keys.revoke(gatewayKey.id);
      expect(await keys.authenticate(key)).toBeUndefined();
      expect(await keys.list()).toEqual([]);
      await expect(keys.revoke(gatewayKey.id)).rejects.toBeInstanceOf(
        GatewayKeyError,
      );
    },
  ],
  [
    "gives an Agent a key sealed for its sandboxes, and a new one on rotation",
    async ({ keys, store, told, bus }) => {
      await keys.ensureAgentKey(ada);
      const first = await keys.agentKey(ada.id);
      expect(first).toMatch(/^aio_gk_/);
      const stored = await store.forAgent(ada.id);
      expect(stored).toMatchObject({
        kind: "agent",
        name: "Ada",
        agentId: ada.id,
        floorId: ada.floorId,
        keyHash: hashGatewayKey(first ?? ""),
      });
      expect(stored?.sealedKey).toMatch(/^aio1:/);
      expect(
        encryptor.decrypt(
          stored?.sealedKey ?? "",
          gatewayKeyContext(stored?.id ?? ""),
        ),
      ).toBe(first);
      expect(await keys.authenticate(first ?? "")).toEqual({
        kind: "agent",
        keyId: stored?.id,
        agentId: ada.id,
        floorId: ada.floorId,
        name: "Ada",
      });

      // Ensuring again keeps it.
      await keys.ensureAgentKey(ada);
      expect(await keys.agentKey(ada.id)).toBe(first);

      // Rotating replaces it: the old key stops working at once.
      const rotated = await keys.issueAgentKey(ada);
      const second = await keys.agentKey(ada.id);
      expect(second).not.toBe(first);
      expect(rotated.id).not.toBe(stored?.id);
      expect(await keys.authenticate(first ?? "")).toBeUndefined();
      expect(await keys.authenticate(second ?? "")).toMatchObject({
        agentId: ada.id,
      });
      expect((await keys.list()).map(({ id }) => id)).toEqual([rotated.id]);
      expect(told).toEqual([first, second]);

      // Making it is part of making the Agent; rotating it is a change.
      const events = (await bus.eventsAfter(0)).map(({ event }) => event);
      expect(events).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          agentId: ada.id,
          floorId: ada.floorId,
          keys: ["gatewayKeys.rotated"],
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(first);
      expect(JSON.stringify(events)).not.toContain(second);
    },
  ],
  [
    "revokes an Agent's key with the Agent, never on its own",
    async ({ keys }) => {
      await keys.ensureAgentKey(ada);
      await keys.ensureAgentKey(bea);
      const key = (await keys.agentKey(ada.id)) ?? "";
      const info = await keys.agentKeyInfo(ada.id);
      await expect(keys.revoke(info?.id ?? "")).rejects.toMatchObject({
        code: gatewayKeyErrorCodes.agentKeyNotRevocable,
      });
      expect(await keys.authenticate(key)).toBeDefined();

      await keys.revokeAgentKey(ada.id);
      expect(await keys.authenticate(key)).toBeUndefined();
      expect(await keys.agentKey(ada.id)).toBeUndefined();
      expect(await keys.agentKeyInfo(ada.id)).toBeUndefined();
      // Bea's is untouched.
      expect(await keys.agentKey(bea.id)).toMatch(/^aio_gk_/);
      // Revoking again does nothing.
      await keys.revokeAgentKey(ada.id);
    },
  ],
  [
    "notes when a key was last used, at most once a minute",
    async ({ keys, store, advance }) => {
      const { gatewayKey, key } = await keys.createOwnerToolKey("Codex");
      await keys.authenticate(key);
      await vi.waitFor(async () => {
        expect((await store.get(gatewayKey.id))?.lastUsedAt).toEqual(
          new Date(Date.UTC(2026, 9, 9, 12, 0, 0)),
        );
      });
      advance(30_000);
      await keys.authenticate(key);
      advance(30_000);
      await keys.authenticate(key);
      await vi.waitFor(async () => {
        expect((await keys.list())[0]?.lastUsedAt).toEqual(
          new Date(Date.UTC(2026, 9, 9, 12, 1, 0)),
        );
      });
    },
  ],
  [
    "refuses a request through the Gateway with no key, an unknown one or a revoked one",
    async (setup) => {
      const { gatewayKey, key } =
        await setup.keys.createOwnerToolKey("Claude Code");
      await withGateway(setup, async (url, upstream) => {
        const unauthorized = {
          type: "error",
          error: { type: "authentication_error" },
        };
        const noKey = await fetch(`${url}/v1/messages`, { method: "POST" });
        expect(noKey.status).toBe(401);
        expect(await noKey.json()).toMatchObject(unauthorized);
        expect(await send(url, { "x-api-key": `${key}0` })).toBe(401);
        expect(await send(url, { authorization: "Bearer nonsense" })).toBe(401);

        // As x-api-key, or as a bearer token.
        expect(await send(url, { "x-api-key": key })).toBe(200);
        expect(await send(url, { authorization: `Bearer ${key}` })).toBe(200);

        await setup.keys.revoke(gatewayKey.id);
        const revoked = await fetch(`${url}/v1/messages/count_tokens`, {
          method: "POST",
          headers: { "x-api-key": key },
        });
        expect(revoked.status).toBe(401);
        expect(await revoked.json()).toMatchObject(unauthorized);

        // Only the two requests with the key in use reached the AI Provider,
        // and the Gateway Key was not forwarded with them.
        expect(upstream.received).toHaveLength(2);
        expect(JSON.stringify(upstream.received)).not.toContain(key);
        await vi.waitFor(async () => {
          expect(await setup.records()).toHaveLength(2);
        });
      });
    },
  ],
  [
    "attributes each request to its Agent and Floor and the work AI Office gave it, or to its Owner tool and the issue and pull request it names",
    async (setup) => {
      await setup.keys.ensureAgentKey(ada);
      const adaKey = (await setup.keys.agentKey(ada.id)) ?? "";
      const adaKeyId = (await setup.keys.agentKeyInfo(ada.id))?.id;
      const tool = await setup.keys.createOwnerToolKey("Codex");
      // Ada's sandbox works #4, whose pull request is #7 (pen-testing G1-1).
      const work = createAgentWork();
      work.hold(ada.id, { issue: 4, pullRequest: 7 });
      await withGateway(
        setup,
        async (url, upstream) => {
          // As Claude Code sends them from a sandbox (ANTHROPIC_CUSTOM_HEADERS).
          expect(
            await send(url, {
              authorization: `Bearer ${adaKey}`,
              "x-ai-office-issue": "4",
              "x-ai-office-pull-request": "7",
            }),
          ).toBe(200);
          expect(await send(url, { "x-api-key": tool.key })).toBe(200);
          // Numbers only: anything else names no issue.
          expect(
            await send(url, {
              "x-api-key": tool.key,
              "x-ai-office-issue": "4 OR 1=1",
              "x-ai-office-pull-request": "0",
            }),
          ).toBe(200);
          await vi.waitFor(async () => {
            expect(await setup.records()).toHaveLength(3);
          });
          // What a request is for is no AI Provider's business.
          for (const { headers } of upstream.received) {
            expect(Object.keys(headers)).not.toContain("x-ai-office-issue");
            expect(Object.keys(headers)).not.toContain(
              "x-ai-office-pull-request",
            );
          }
        },
        work,
      );
      const attributed = (await setup.records()).map(
        ({
          gatewayKeyId,
          agentId,
          floorId,
          ownerTool,
          issue,
          pullRequest,
        }) => ({
          gatewayKeyId,
          agentId,
          floorId,
          ownerTool,
          issue,
          pullRequest,
        }),
      );
      expect(attributed).toEqual(
        expect.arrayContaining([
          {
            gatewayKeyId: adaKeyId,
            agentId: ada.id,
            floorId: ada.floorId,
            ownerTool: null,
            issue: 4,
            pullRequest: 7,
          },
          {
            gatewayKeyId: tool.gatewayKey.id,
            agentId: null,
            floorId: null,
            ownerTool: "Codex",
            issue: null,
            pullRequest: null,
          },
        ]),
      );
      expect(
        attributed.filter(({ ownerTool }) => ownerTool === "Codex"),
      ).toEqual([
        expect.objectContaining({ issue: null, pullRequest: null }),
        expect.objectContaining({ issue: null, pullRequest: null }),
      ]);
    },
  ],
  [
    "gives the Communications Agent one key of its own, and attributes its requests to it, with no Floor",
    async (setup) => {
      const { keys } = setup;
      expect(await keys.communicationsKey()).toBeUndefined();
      await keys.ensureCommunicationsKey("Reception");
      const key = (await keys.communicationsKey()) ?? "";
      expect(key).toMatch(/^aio_gk_/);
      expect(setup.told).toContain(key);
      // Once only: a later start keeps it.
      await keys.ensureCommunicationsKey("Reception");
      expect(await keys.communicationsKey()).toBe(key);
      const [info] = (await keys.list()).filter(
        ({ kind }) => kind === "communications",
      );
      expect(info).toMatchObject({
        kind: "communications",
        name: "Reception",
        agentId: null,
        floorId: null,
      });
      expect(JSON.stringify(info)).not.toContain(key);
      expect(await keys.authenticate(key)).toEqual({
        kind: "communications",
        keyId: info?.id,
        name: "Reception",
      });
      await expect(keys.revoke(info?.id ?? "")).rejects.toMatchObject({
        code: gatewayKeyErrorCodes.agentKeyNotRevocable,
      });

      await withGateway(setup, async (url) => {
        expect(await send(url, { "x-api-key": key })).toBe(200);
        await vi.waitFor(async () => {
          expect(await setup.records()).toHaveLength(1);
        });
      });
      expect(await setup.records()).toEqual([
        expect.objectContaining({
          gatewayKeyId: info?.id,
          agentId: communicationsAgentId,
          floorId: null,
          ownerTool: null,
        }),
      ]);
    },
  ],
  [
    "gives the Terminal one key of its own, kept sealed, and attributes its requests to the Owner tool Terminal",
    async (setup) => {
      const { keys } = setup;
      const key = await keys.terminalKey();
      expect(key).toMatch(/^aio_gk_/);
      expect(setup.told).toContain(key);
      // Once only: it is kept.
      expect(await keys.terminalKey()).toBe(key);
      const [info] = (await keys.list()).filter(
        ({ kind }) => kind === "terminal",
      );
      expect(info).toMatchObject({
        kind: "terminal",
        name: terminalKeyName,
        agentId: null,
        floorId: null,
      });
      expect(JSON.stringify(info)).not.toContain(key);
      expect(await keys.authenticate(key)).toEqual({
        kind: "owner_tool",
        keyId: info?.id,
        name: terminalKeyName,
      });
      await expect(keys.revoke(info?.id ?? "")).rejects.toMatchObject({
        code: gatewayKeyErrorCodes.agentKeyNotRevocable,
      });
    },
  ],
];

describe("Gateway Keys, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => {
      const requestLog = memoryRequestLog();
      return run(
        setUp(
          memoryGatewayKeyStore(),
          createEventBus({ store: memoryEventStore() }),
          requestLog,
          () =>
            Promise.resolve(
              requestLog.records.map((record) => ({ ...record })),
            ),
        ),
      );
    });
  }
});

/** The Floor and Agents the keys belong to, for the foreign keys. */
async function insertTeam(db: Database): Promise<void> {
  const createdAt = new Date();
  await db.insert(floors).values({
    id: "web-shop",
    githubRepositoryId: 1,
    repository: "adrianeyre/web-shop",
    name: "web-shop",
    defaultBranch: "main",
    createdAt,
  });
  await db.insert(agents).values(
    [ada, bea].map(({ id, name }) => ({
      id,
      floorId: "web-shop",
      name,
      role: "coder",
      aiProvider: "Claude",
      avatar: {},
      createdAt,
    })),
  );
}

describe("Gateway Keys, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await insertTeam(database.db);
      return run(
        setUp(
          databaseGatewayKeyStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
          databaseRequestLog(database.db),
          async () =>
            (
              await database.db
                .select()
                .from(gatewayRequests)
                .orderBy(gatewayRequests.id)
            ).map((row) => ({ ...row })),
        ),
      );
    });
  }

  postgresTest(
    "allows one key in use per Agent, and only hashes and sealed keys",
    async ({ database }) => {
      await insertTeam(database.db);
      const row = {
        kind: "agent",
        name: "Ada",
        agentId: ada.id,
        floorId: ada.floorId,
        hint: "aio_gk_AbCd",
        sealedKey: "aio1:1:a:b:c",
        createdAt: new Date(),
      };
      await database.db
        .insert(gatewayKeys)
        .values({ ...row, id: "k1", keyHash: "h1" });
      await expect(
        database.db
          .insert(gatewayKeys)
          .values({ ...row, id: "k2", keyHash: "h2" }),
      ).rejects.toThrow();
      // An Agent's key must be sealed.
      await expect(
        database.db.insert(gatewayKeys).values({
          ...row,
          id: "k3",
          keyHash: "h3",
          agentId: bea.id,
          sealedKey: "aio_gk_in-clear",
        }),
      ).rejects.toThrow();
      // An Owner tool's key is never kept, sealed or not.
      await expect(
        database.db.insert(gatewayKeys).values({
          ...row,
          id: "k4",
          keyHash: "h4",
          kind: "owner_tool",
          agentId: null,
          floorId: null,
        }),
      ).rejects.toThrow();
    },
  );
});
