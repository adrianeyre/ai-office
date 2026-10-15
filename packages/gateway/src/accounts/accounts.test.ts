import { aiAccounts, gatewayRequests } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  aiAccountErrorCodes,
  type AddAiAccountRequest,
} from "@ai-office/shared";
import {
  DecryptionError,
  encryptorFromKey,
  type Encryptor,
} from "@ai-office/shared/crypto";
import { describe, expect, it, vi } from "vitest";

import { databaseRequestLog, memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
} from "../test-support.ts";
import {
  AiAccountError,
  createAiAccounts,
  credentialContext,
  type AiAccounts,
} from "./accounts.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountStore,
} from "./store.ts";

// The Owner's key-based AI Accounts (PRD FR-35, FR-36): adding, renaming,
// reprioritising, pausing, resuming and deleting them, their credentials
// sealed at rest, and the account the Gateway chooses. Every case runs in
// memory and in Postgres 18.

const encryptor: Encryptor = encryptorFromKey(Buffer.alloc(32, 9));

/** A request from no agent tool in particular. */
const anyCaller = { agentTool: null };

const firstKey = "sk-ant-api03-firstaccountsecret-AbCdEf0123456789";
const secondKey = "sk-ant-api03-secondaccountsecret-ZyXwVu9876543210";
const thirdKey = "sk-ant-api03-thirdaccountsecret-QrStUv5555555555";

const apiKeyAccount = (
  credential: string,
  name: string,
): AddAiAccountRequest => ({
  name,
  aiProvider: "Claude",
  accountType: "api_key",
  credential,
});

interface Setup {
  readonly accounts: AiAccounts;
  readonly store: AiAccountStore;
  readonly bus: EventBus;
  /** Every credential `onCredential` was told, in order. */
  readonly told: string[];
}

function setUp(store: AiAccountStore, bus: EventBus): Setup {
  const told: string[] = [];
  let tick = 0;
  let id = 0;
  return {
    accounts: createAiAccounts({
      store,
      encryptor,
      events: bus,
      onCredential: (credential) => told.push(credential),
      now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    }),
    store,
    bus,
    told,
  };
}

const configChanges = async (bus: EventBus) =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type === "config.changed");

const refusal = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AiAccountError);
  return (error as AiAccountError).code;
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds AWS Bedrock and Vertex AI accounts: their region and project kept, their credentials sealed",
    async ({ accounts, store, told }) => {
      const secretAccessKey = "bedrockStoreTestSecret/0123456789abcdefgh";
      const privateKey =
        "-----BEGIN PRIVATE KEY-----\nstoreTestPrivateKeyMaterial0123456789\n-----END PRIVATE KEY-----\n";
      const bedrock = await accounts.add({
        name: "Bedrock",
        aiProvider: "Claude",
        accountType: "bedrock",
        region: "eu-central-1",
        awsCredentials: {
          accessKeyId: "AKIASTORETEST0000001",
          secretAccessKey,
        },
      });
      const vertex = await accounts.add({
        name: "Vertex",
        aiProvider: "Claude",
        accountType: "vertex",
        region: "us-east5",
        serviceAccount: {
          type: "service_account",
          client_email: "ai-office@store-test.iam.gserviceaccount.com",
          private_key: privateKey,
          project_id: "store-test",
        },
      });
      expect(bedrock).toMatchObject({
        accountType: "bedrock",
        region: "eu-central-1",
        projectId: null,
      });
      expect(vertex).toMatchObject({
        accountType: "vertex",
        region: "us-east5",
        projectId: "store-test",
      });
      const listed = JSON.stringify(await accounts.list());
      expect(listed).not.toContain(secretAccessKey);
      expect(listed).not.toContain("storeTestPrivateKeyMaterial");
      // Sealed for their own rows, as JSON.
      for (const added of [bedrock, vertex]) {
        const row = await store.get(added.id);
        expect(row?.credential).toMatch(/^aio1:/);
        expect(
          JSON.parse(
            encryptor.decrypt(
              row?.credential ?? "",
              credentialContext(added.id),
            ),
          ),
        ).toBeTypeOf("object");
      }
      expect(told).toEqual(
        expect.arrayContaining([secretAccessKey, privateKey]),
      );
      // Each serves Claude Models only, sent as its platform names them.
      const chosen = await accounts.select({
        ...anyCaller,
        model: "claude-opus-5-5",
      });
      expect(chosen).toMatchObject({
        name: "Bedrock",
        apiKey: "",
        baseUrl: "https://bedrock-mantle.eu-central-1.api.aws",
        model: "anthropic.claude-opus-5-5",
      });
      expect(
        await accounts.select({ ...anyCaller, model: "gemini-2.5-pro" }),
      ).toBeUndefined();
    },
  ],
  [
    "stores the credential sealed for its own row, and never hands it back",
    async ({ accounts, store, bus }) => {
      const added = await accounts.add(apiKeyAccount(firstKey, "Work"));
      expect(added).toEqual({
        id: "00000000-0000-4000-8000-000000000001",
        name: "Work",
        accountType: "api_key",
        aiProvider: "Claude",
        endpointUrl: null,
        // Not a cloud platform's.
        region: null,
        projectId: null,
        priority: 1,
        paused: false,
        // A key has no token to refresh.
        tokenExpiresAt: null,
        reauthenticationNeeded: false,
        // Not held back, and no usage windows reported yet.
        limitReason: null,
        limitedUntil: null,
        fiveHourUtilization: null,
        fiveHourResetsAt: null,
        weeklyUtilization: null,
        weeklyResetsAt: null,
        fiveHourPauseThreshold: null,
        weeklyPauseThreshold: null,
        // No forced Model, and extra usage off (FR-41).
        forcedModel: null,
        extraUsage: false,
        // No rate limits reported yet, and no credit read.
        rateLimits: null,
        balance: null,
        createdAt: new Date("2026-10-09T12:00:00.000Z"),
        updatedAt: new Date("2026-10-09T12:00:00.000Z"),
      });
      expect(JSON.stringify(added)).not.toContain(firstKey);
      expect(JSON.stringify(await accounts.list())).not.toContain(firstKey);

      const stored = await store.get(added.id);
      expect(stored?.credential).toMatch(/^aio1:1:/);
      expect(stored?.credential).not.toContain(firstKey);
      expect(
        encryptor.decrypt(
          stored?.credential ?? "",
          credentialContext(added.id),
        ),
      ).toBe(firstKey);
      // Copied into another row, it does not open.
      expect(() =>
        encryptor.decrypt(
          stored?.credential ?? "",
          credentialContext("00000000-0000-4000-8000-000000000002"),
        ),
      ).toThrow(DecryptionError);

      // The Activity Feed says what changed, never the credential.
      expect(await configChanges(bus)).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["aiAccounts.added"],
        },
      ]);
      expect(JSON.stringify(await bus.eventsAfter(0))).not.toContain(firstKey);
    },
  ],
  [
    "lists accounts by priority, new ones after the rest unless given one",
    async ({ accounts }) => {
      await accounts.add(apiKeyAccount(firstKey, "Work"));
      await accounts.add(apiKeyAccount(secondKey, "Personal"));
      await accounts.add({ ...apiKeyAccount(thirdKey, "Spare"), priority: 1 });
      expect(
        (await accounts.list()).map(({ name, priority }) => [name, priority]),
      ).toEqual([
        // A tie goes to the oldest.
        ["Work", 1],
        ["Spare", 1],
        ["Personal", 2],
      ]);
    },
  ],
  [
    "serves from the first unpaused account, with its key in clear",
    async ({ accounts }) => {
      expect(await accounts.select(anyCaller)).toBeUndefined();
      const work = await accounts.add(apiKeyAccount(firstKey, "Work"));
      const personal = await accounts.add({
        ...apiKeyAccount(secondKey, "Personal"),
        endpointUrl: "https://llm-proxy.example/anthropic",
      });
      expect(await accounts.select(anyCaller)).toEqual({
        id: work.id,
        name: "Work",
        apiKey: firstKey,
        baseUrl: "https://api.anthropic.com",
        apiFormat: "anthropic",
        apiPath: "/v1",
      });

      await accounts.update(work.id, { paused: true });
      expect(await accounts.select(anyCaller)).toEqual({
        id: personal.id,
        name: "Personal",
        apiKey: secondKey,
        baseUrl: "https://llm-proxy.example/anthropic",
        apiFormat: "anthropic",
        apiPath: "/v1",
      });

      await accounts.update(personal.id, { paused: true });
      expect(await accounts.select(anyCaller)).toBeUndefined();

      await accounts.update(work.id, { paused: false });
      expect((await accounts.select(anyCaller))?.name).toBe("Work");

      await accounts.update(personal.id, { paused: false, priority: 1 });
      await accounts.update(work.id, { priority: 2 });
      expect((await accounts.select(anyCaller))?.name).toBe("Personal");
    },
  ],
  [
    "renames, reprioritises, pauses and resumes, recording only what changed",
    async ({ accounts, bus }) => {
      const work = await accounts.add(apiKeyAccount(firstKey, "Work"));
      const renamed = await accounts.update(work.id, {
        name: "Work (team)",
        priority: 5,
      });
      expect(renamed).toMatchObject({
        name: "Work (team)",
        priority: 5,
        paused: false,
        updatedAt: new Date("2026-10-09T12:00:01.000Z"),
      });
      expect(await accounts.update(work.id, { paused: true })).toMatchObject({
        paused: true,
      });
      expect(await accounts.update(work.id, { paused: false })).toMatchObject({
        paused: false,
      });
      // Nothing changes, so nothing is recorded.
      expect(
        await accounts.update(work.id, { name: "Work (team)", priority: 5 }),
      ).toMatchObject({ updatedAt: new Date("2026-10-09T12:00:03.000Z") });

      expect((await configChanges(bus)).map(({ keys }) => keys)).toEqual([
        ["aiAccounts.added"],
        ["aiAccounts.name", "aiAccounts.priority"],
        ["aiAccounts.paused"],
        ["aiAccounts.paused"],
      ]);
      expect(await accounts.list()).toEqual([
        expect.objectContaining({ name: "Work (team)", priority: 5 }),
      ]);
    },
  ],
  [
    "refuses a second account of one name",
    async ({ accounts }) => {
      const work = await accounts.add(apiKeyAccount(firstKey, "Work"));
      const personal = await accounts.add(apiKeyAccount(secondKey, "Personal"));
      expect(await refusal(accounts.add(apiKeyAccount(thirdKey, "Work")))).toBe(
        aiAccountErrorCodes.aiAccountNameTaken,
      );
      expect(
        await refusal(accounts.update(personal.id, { name: "Work" })),
      ).toBe(aiAccountErrorCodes.aiAccountNameTaken);
      expect((await accounts.list()).map(({ id }) => id)).toEqual([
        work.id,
        personal.id,
      ]);
    },
  ],
  [
    "deletes an account, and the next one serves",
    async ({ accounts, store, bus }) => {
      const work = await accounts.add(apiKeyAccount(firstKey, "Work"));
      await accounts.add(apiKeyAccount(secondKey, "Personal"));
      await accounts.remove(work.id);
      expect(await store.get(work.id)).toBeUndefined();
      expect((await accounts.list()).map(({ name }) => name)).toEqual([
        "Personal",
      ]);
      expect((await accounts.select(anyCaller))?.name).toBe("Personal");
      expect((await configChanges(bus)).at(-1)?.keys).toEqual([
        "aiAccounts.deleted",
      ]);
    },
  ],
  [
    "refuses to change or delete an account that does not exist",
    async ({ accounts }) => {
      expect(await refusal(accounts.update("missing", { paused: true }))).toBe(
        aiAccountErrorCodes.aiAccountNotFound,
      );
      expect(await refusal(accounts.remove("missing"))).toBe(
        aiAccountErrorCodes.aiAccountNotFound,
      );
    },
  ],
  [
    "tells each credential once, so it can be redacted",
    async ({ accounts, told }) => {
      await accounts.add(apiKeyAccount(firstKey, "Work"));
      await accounts.select(anyCaller);
      await accounts.select(anyCaller);
      expect(told).toEqual([firstKey]);
    },
  ],
  [
    "is what the Gateway forwards with, and records",
    async ({ accounts }) => {
      const upstream = await startFakeUpstream((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 3 }));
      });
      const requestLog = memoryRequestLog();
      await accounts.add({
        ...apiKeyAccount(firstKey, "Work"),
        endpointUrl: upstream.url,
      });
      const gateway = await startGateway({ accounts, requestLog });
      try {
        await fetch(`${gateway.url}/v1/messages/count_tokens`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": gatewayKey,
          },
          body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
        });
        expect(upstream.received[0]?.headers["x-api-key"]).toBe(firstKey);
        await vi.waitFor(() => {
          expect(requestLog.records).toHaveLength(1);
        });
        expect(requestLog.records[0]).toMatchObject({
          account: "Work",
          accountId: "00000000-0000-4000-8000-000000000001",
          status: 200,
        });
      } finally {
        await gateway.close();
        await upstream.close();
      }
    },
  ],
  [
    "tells whether a value holds any account's credential, paused or not, so none reaches a sandbox",
    async ({ accounts }) => {
      const custom = "opaque-custom-endpoint-secret-0001";
      await accounts.add(apiKeyAccount(firstKey, "Work"));
      const second = await accounts.add({
        ...apiKeyAccount(custom, "Custom"),
        endpointUrl: "https://llm.example.com",
      });
      await accounts.update(second.id, { paused: true });

      expect(await accounts.holdsCredential(firstKey)).toBe(true);
      expect(await accounts.holdsCredential(`x-api-key: ${custom}`)).toBe(true);
      expect(
        await accounts.holdsCredential(
          "aio_gk_adasownkeyforhersandboxes000000000000000",
        ),
      ).toBe(false);
      expect(await accounts.holdsCredential(secondKey)).toBe(false);
    },
  ],
];

describe("AI Accounts, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(
        setUp(
          memoryAiAccountStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      ),
    );
  }
});

describe("AI Accounts, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(
        setUp(
          databaseAiAccountStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      ),
    );
  }

  postgresTest(
    "refuses a credential that is not sealed",
    async ({ database }) => {
      const at = new Date();
      await expect(
        database.db.insert(aiAccounts).values({
          id: "unsealed",
          name: "Unsealed",
          accountType: "api_key",
          aiProvider: "Claude",
          credential: firstKey,
          priority: 1,
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toMatchObject({
        cause: { constraint: "ai_accounts_credential_sealed" },
      });
    },
  );

  postgresTest(
    "refuses a cloud platform's account without its region, or a project on another",
    async ({ database }) => {
      const at = new Date();
      const row = {
        name: "Cloud",
        aiProvider: "Claude",
        credential: "aio1:sealed",
        priority: 1,
        createdAt: at,
        updatedAt: at,
      };
      await expect(
        database.db
          .insert(aiAccounts)
          .values({ ...row, id: "bedrock", accountType: "bedrock" }),
      ).rejects.toMatchObject({ cause: { constraint: "ai_accounts_cloud" } });
      await expect(
        database.db.insert(aiAccounts).values({
          ...row,
          id: "vertex",
          accountType: "vertex",
          region: "global",
        }),
      ).rejects.toMatchObject({ cause: { constraint: "ai_accounts_cloud" } });
      await expect(
        database.db.insert(aiAccounts).values({
          ...row,
          id: "key",
          accountType: "api_key",
          region: "us-east-1",
        }),
      ).rejects.toMatchObject({ cause: { constraint: "ai_accounts_cloud" } });
    },
  );

  postgresTest(
    "keeps a deleted account's requests, by name",
    async ({ database }) => {
      const { accounts } = setUp(
        databaseAiAccountStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      const work = await accounts.add(apiKeyAccount(firstKey, "Work"));
      await databaseRequestLog(database.db).record({
        startedAt: new Date(),
        account: work.name,
        accountId: work.id,
        endpoint: "messages",
        model: "claude-haiku-5-5",
        streamed: false,
        status: 200,
        latencyMs: 20,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        upstreamRequestId: null,
        gatewayKeyId: null,
        agentId: null,
        floorId: null,
        ownerTool: "test-tool",
        issue: null,
        pullRequest: null,
        estimatedCostUsd: 0.000006,
        timeToFirstByteMs: 15,
        requestHeaders: null,
        responseHeaders: null,
      });
      await accounts.remove(work.id);
      expect(
        await database.db
          .select({
            account: gatewayRequests.account,
            aiAccountId: gatewayRequests.aiAccountId,
          })
          .from(gatewayRequests),
      ).toEqual([{ account: "Work", aiAccountId: null }]);
    },
  );
});
