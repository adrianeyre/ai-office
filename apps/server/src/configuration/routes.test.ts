import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createGatewayKeys,
  memoryGatewayKeyStore,
  type GatewayKeys,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  configurationPreviewSchema,
  configurationSchema,
  createRedactor,
  type Configuration,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  testPassword,
  type SignedIn,
} from "../test-support.ts";

// Configuration export and import through the API (PRD FR-65): the
// export is a JSON download without a credential, even with AI Accounts
// and Gateway Keys in use; an import is previewed, then applied, and
// refused whole when it has problems. The importing Office runs in memory
// and in Postgres 18.

const aiAccountKey = "sk-ant-api03-configuration-routes-0123456789abcdef";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly keys: GatewayKeys;
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const redactor = createRedactor();
  const keys = createGatewayKeys({
    store: memoryGatewayKeyStore(),
    encryptor: testEncryptor,
    events: bus,
    onKey: (key) => {
      redactor.register(key);
    },
  });
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    gatewayKeys: keys,
    redactor,
  });
  await server.ready();
  return { server, owner: await signIn(server), keys };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "PUT" | "POST",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

/** An Office configured through the API, with credentials in use. */
async function configured(): Promise<{
  setup: Setup;
  credentials: string[];
}> {
  const setup = await setUp(
    memoryStores(),
    createEventBus({ store: memoryEventStore() }),
  );
  const ok = async (method: "PUT" | "POST", url: string, payload: object) => {
    const response = await request(setup, method, url, payload);
    expect(response.statusCode).toBeLessThan(300);
    return response.json<Record<string, unknown>>();
  };
  await ok("POST", "/api/floors", { repository: "adrianeyre/web-shop" });
  await ok("POST", "/api/floors", { repository: "adrianeyre/blog" });
  await ok("PUT", "/api/office/sandboxes", { concurrencyLimit: 4 });
  await ok("PUT", "/api/office/prompt-cache", { ttl: "5m" });
  await ok("PUT", "/api/office/retention", {
    requestBodiesDays: 2,
    requestMetadataDays: 40,
    activityDays: 365,
    connectionDeliveriesDays: 30,
  });
  await ok("PUT", "/api/gateway/prices/claude-opus-5-5", {
    input: 4,
    output: 20,
    cacheWrite: 5,
    cacheRead: 0.4,
  });
  await ok("PUT", "/api/memory/office", { content: "Use pnpm." });
  // Credentials: an AI Account's key, an Owner tool's Gateway Key, and
  // each Agent's own Gateway Key.
  await ok("POST", "/api/ai-accounts", {
    name: "Work",
    aiProvider: "Claude",
    accountType: "api_key",
    credential: aiAccountKey,
  });
  const ownerTool = await ok("POST", "/api/gateway-keys", {
    name: "laptop",
  });
  const agentKeys: string[] = [];
  for (const floorId of ["web-shop", "blog"]) {
    const agents = (
      await request(setup, "GET", `/api/floors/${floorId}/agents`)
    ).json<{ agents: { id: string }[] }>().agents;
    for (const { id } of agents) {
      const key = await setup.keys.agentKey(id);
      if (key === undefined) {
        throw new Error(`The Agent ${id} has no Gateway Key.`);
      }
      agentKeys.push(key);
    }
  }
  expect(agentKeys).toHaveLength(8);
  return {
    setup,
    credentials: [
      aiAccountKey,
      String(ownerTool["key"]),
      ...agentKeys,
      testPassword,
      testEncryptor.encrypt("x", "context").slice(0, 8),
    ],
  };
}

type Case = [name: string, run: (target: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "exports without a credential, and imports the export into an empty Office",
    async (target) => {
      const { setup: source, credentials } = await configured();
      const response = await request(
        source,
        "GET",
        "/api/configuration/export",
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toMatch(
        /^attachment; filename="ai-office-configuration-\d{4}-\d{2}-\d{2}\.json"$/,
      );
      for (const credential of credentials.slice(0, -1)) {
        expect(response.body).not.toContain(credential);
      }
      // Nothing sealed with ENCRYPTION_KEY either.
      expect(response.body).not.toContain("aio1:");
      const exported = configurationSchema.parse(response.json());
      expect(exported.floors.map(({ id }) => id).sort()).toEqual([
        "blog",
        "web-shop",
      ]);
      // The office's settings, the prompt-cache TTL and retention among them.
      expect(exported.office.promptCache).toEqual({ ttl: "5m" });
      expect(exported.office.retention).toEqual({
        requestBodiesDays: 2,
        requestMetadataDays: 40,
        activityDays: 365,
        connectionDeliveriesDays: 30,
      });

      const preview = await request(
        target,
        "POST",
        "/api/configuration/import/preview",
        exported,
      );
      expect(preview.statusCode).toBe(200);
      const changes = configurationPreviewSchema.parse(preview.json());
      expect(changes.problems).toEqual([]);
      expect(
        changes.changes
          .filter(({ action }) => action === "add")
          .map(({ area }) => area),
      ).toEqual(expect.arrayContaining(["floor", "agent", "model_price"]));

      const applied = await request(
        target,
        "POST",
        "/api/configuration/import",
        exported,
      );
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toEqual(preview.json());
      const again = configurationSchema.parse(
        (await request(target, "GET", "/api/configuration/export")).json(),
      );
      const withoutTime = (configuration: Configuration) => ({
        ...configuration,
        exportedAt: "",
      });
      expect(withoutTime(again)).toEqual(withoutTime(exported));
      // The imported Agents have Gateway Keys of their own, not the source's.
      for (const floor of again.floors) {
        for (const agent of floor.agents) {
          const key = await target.keys.agentKey(agent.id);
          expect(key).toMatch(/^aio_gk_/);
          expect(credentials).not.toContain(key);
        }
      }
    },
  ],
  [
    "refuses an import with problems, and a file that is not an export",
    async (target) => {
      const { setup: source } = await configured();
      const exported = configurationSchema.parse(
        (await request(source, "GET", "/api/configuration/export")).json(),
      );
      await request(target, "POST", "/api/configuration/import", exported);
      const conflicting = {
        ...exported,
        // Each repository again, as another Floor.
        floors: exported.floors.map((floor) => ({
          ...floor,
          id: `${floor.id}-again`,
        })),
      };
      const previewed = await request(
        target,
        "POST",
        "/api/configuration/import/preview",
        conflicting,
      );
      expect(previewed.statusCode).toBe(200);
      const preview = configurationPreviewSchema.parse(previewed.json());
      expect([...preview.problems].sort()).toEqual([
        "adrianeyre/blog is the Floor blog here, not blog-again.",
        "adrianeyre/web-shop is the Floor web-shop here, not web-shop-again.",
      ]);
      const refused = await request(
        target,
        "POST",
        "/api/configuration/import",
        conflicting,
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({
        error: "configuration_conflicts",
        message: "The configuration was not imported: it has problems.",
        problems: preview.problems,
      });

      for (const payload of [
        {},
        { ...exported, format: "something-else" },
        { ...exported, version: 2 },
        { ...exported, credential: aiAccountKey },
      ]) {
        const response = await request(
          target,
          "POST",
          "/api/configuration/import/preview",
          payload,
        );
        expect({ status: response.statusCode }).toEqual({ status: 400 });
      }
    },
  ],
  [
    "needs a signed-in session",
    async (target) => {
      for (const [method, url] of [
        ["GET", "/api/configuration/export"],
        ["POST", "/api/configuration/import/preview"],
        ["POST", "/api/configuration/import"],
      ] as const) {
        const response = await target.server.inject({ method, url });
        expect(response.statusCode).toBe(401);
      }
    },
  ],
];

describe("configuration export and import, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryStores(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("configuration export and import, into Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});
