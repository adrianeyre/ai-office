import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
} from "@ai-office/events";
import type { LoadBalancingSettings } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountStore,
} from "../accounts/store.ts";
import type { GatewayCaller } from "../keys/keys.ts";
import { staticKeys } from "../keys/keys.ts";
import { memoryRequestLog } from "../request-log.ts";
import {
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
} from "../test-support.ts";
import {
  createLoadBalancer,
  createUsageTracker,
  ForcedAccountError,
} from "./balancing.ts";

// Routing a request to an AI Account (PRD FR-37, FR-38): first the account
// a request forces, then the strategy, among the unpaused accounts that
// can serve it, in the Owner's priority order. Selection runs in memory
// and in Postgres 18; the headers run through a real Gateway.

const encryptor = encryptorFromKey(Buffer.alloc(32, 13));
const minute = 60 * 1000;
const start = Date.UTC(2026, 9, 9, 12, 0, 0);

interface Setup {
  readonly accounts: AiAccounts;
  readonly ids: { work: string; team: string; spare: string };
  readonly usage: ReturnType<typeof createUsageTracker>;
  settings: LoadBalancingSettings;
  /** Sets the clock this far after the start. */
  readonly at: (ms: number) => void;
}

/**
 * Three key-based accounts: Work and Team at priority 1 (Work older), and
 * Spare at priority 2, each at `endpointUrl`.
 */
async function setUp(
  store: AiAccountStore,
  bus = createEventBus({ store: memoryEventStore() }),
  endpointUrl: string | null = null,
): Promise<Setup> {
  let time = start;
  let id = 0;
  const usage = createUsageTracker();
  const setup = {
    settings: { strategy: "session", sessionWindowMinutes: 300 },
  } as Setup;
  const accounts = createAiAccounts({
    store,
    encryptor,
    events: bus,
    balancer: createLoadBalancer({ settings: () => setup.settings, usage }),
    now: () => new Date(time),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  const add = async (name: string, priority: number) => {
    const account = await accounts.add({
      name,
      aiProvider: "Claude",
      accountType: "api_key",
      credential: `sk-ant-api03-${name.toLowerCase()}-key-0123456789`,
      endpointUrl,
      priority,
    });
    time += 1000;
    return account.id;
  };
  const ids = {
    work: await add("Work", 1),
    team: await add("Team", 1),
    spare: await add("Spare", 2),
  };
  return Object.assign(setup, {
    accounts,
    ids,
    usage,
    at: (ms: number) => {
      time = start + ms;
    },
  });
}

const chosen = async (
  accounts: AiAccounts,
  request: { sessionKey?: string | null; forcedAccount?: string | null } = {},
) => (await accounts.select({ agentTool: null, ...request }))?.name;

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "keeps sessions on their accounts, spread across the best priority, skipping paused accounts",
    async ({ accounts, ids, at }) => {
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Work");
      expect(await chosen(accounts, { sessionKey: "bea:sbx-2" })).toBe("Team");
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Work");

      // Paused, Work is skipped: its session moves to Team, not Spare.
      await accounts.update(ids.work, { paused: true });
      at(minute);
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Team");
      // With every priority-1 account paused, Spare serves.
      await accounts.update(ids.team, { paused: true });
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Spare");
      expect(await chosen(accounts, { sessionKey: "cy:sbx-3" })).toBe("Spare");
      await accounts.update(ids.spare, { paused: true });
      expect(
        await chosen(accounts, { sessionKey: "ada:sbx-1" }),
      ).toBeUndefined();
    },
  ],
  [
    "orders by priority as the Owner changes it",
    async ({ accounts, ids }) => {
      await accounts.update(ids.spare, { priority: 1 });
      await accounts.update(ids.work, { priority: 3 });
      await accounts.update(ids.team, { priority: 3 });
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Spare");
      expect(await chosen(accounts, { sessionKey: "bea:sbx-2" })).toBe("Spare");
    },
  ],
  [
    "sends each request to the least-used account of the best priority, once the Owner chooses it",
    async (setup) => {
      const { accounts, ids, usage, at } = setup;
      setup.settings = { strategy: "least_used", sessionWindowMinutes: 300 };
      usage.record(ids.work, 4_000, new Date(start));
      usage.record(ids.team, 1_000, new Date(start));
      at(minute);
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Team");
      usage.record(ids.team, 5_000, new Date(start + minute));
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Work");
      // Spare has used nothing, but its priority is worse.
      expect(await chosen(accounts)).toBe("Work");
      await accounts.update(ids.work, { paused: true });
      expect(await chosen(accounts)).toBe("Team");
    },
  ],
  [
    "drains the account whose usage window resets first, from the windows its AI Provider reports, once the Owner chooses it",
    async (setup) => {
      const { accounts, at } = setup;
      /** Work's or Team's answer reports its five-hour window. */
      const reports = async (name: string, resetsInMs: number) => {
        const account = await accounts.select({
          agentTool: null,
          forcedAccount: name,
        });
        if (account === undefined) {
          throw new Error(`No account ${name}.`);
        }
        await accounts.report(
          account,
          { kind: "served" },
          {
            five_hour: {
              utilization: 40,
              resetsAt: new Date(start + resetsInMs),
            },
          },
        );
      };
      await reports("Work", 4 * 60 * minute);
      await reports("Team", 60 * minute);
      setup.settings = {
        strategy: "drain_soonest",
        sessionWindowMinutes: 120,
      };
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Team");
      // Team's window resets; its next resets after Work's.
      at(61 * minute);
      await reports("Team", 6 * 60 * minute);
      // Ada's session is in use, so it stays; a new one drains Work.
      at(62 * minute);
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Team");
      expect(await chosen(accounts, { sessionKey: "bea:sbx-2" })).toBe("Work");
      // Strict, Ada's session moves to Work too.
      setup.settings = {
        strategy: "drain_soonest_strict",
        sessionWindowMinutes: 30,
      };
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Work");
    },
  ],
  [
    "keeps a session on its account while it is in use, once the Owner chooses session-affinity",
    async (setup) => {
      const { accounts, ids, usage, at } = setup;
      setup.settings = {
        strategy: "session_affinity",
        sessionWindowMinutes: 30,
      };
      usage.record(ids.work, 4_000, new Date(start));
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Team");
      usage.record(ids.team, 9_000, new Date(start));
      for (const minutes of [20, 40, 60, 80, 100]) {
        at(minutes * minute);
        expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe(
          "Team",
        );
      }
      expect(await chosen(accounts, { sessionKey: "bea:sbx-2" })).toBe("Work");
    },
  ],
  [
    "honours a forced account before any strategy, whatever its priority",
    async ({ accounts, ids }) => {
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Work");
      expect(
        await chosen(accounts, {
          sessionKey: "ada:sbx-1",
          forcedAccount: "Spare",
        }),
      ).toBe("Spare");
      expect(await chosen(accounts, { forcedAccount: ids.team })).toBe("Team");
      // The session itself stays where it was.
      expect(await chosen(accounts, { sessionKey: "ada:sbx-1" })).toBe("Work");
    },
  ],
  [
    "refuses a forced account that does not exist, is paused or cannot serve the request",
    async ({ accounts, ids }) => {
      await expect(
        accounts.select({ agentTool: null, forcedAccount: "Nobody" }),
      ).rejects.toThrow(
        new ForcedAccountError(
          'The forced AI Account "Nobody" does not exist.',
        ),
      );
      await accounts.update(ids.spare, { paused: true });
      await expect(
        accounts.select({ agentTool: null, forcedAccount: "Spare" }),
      ).rejects.toThrow(
        new ForcedAccountError('The forced AI Account "Spare" is paused.'),
      );
    },
  ],
];

describe("routing, with AI Accounts in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(await setUp(memoryAiAccountStore()));
    });
  }
});

describe("routing, with AI Accounts in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseAiAccountStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});

describe("routing headers through the Gateway", () => {
  let upstream: FakeUpstream | undefined;

  afterEach(async () => {
    await upstream?.close();
  });

  const ownerKey = "aio_gk_routingtestownertoolkey0000000000000000";
  const agentKey = "aio_gk_routingtestagentadaskey0000000000000000";
  const callers: Record<string, GatewayCaller> = {
    [ownerKey]: { kind: "owner_tool", keyId: "key-owner", name: "Claude Code" },
    [agentKey]: {
      kind: "agent",
      keyId: "key-ada",
      agentId: "ada",
      floorId: "web-shop",
      name: "Ada",
    },
  };

  async function gatewaySetUp() {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 3 }));
    });
    const setup = await setUp(memoryAiAccountStore(), undefined, upstream.url);
    const requestLog = memoryRequestLog();
    const gateway = await startGateway({
      accounts: setup.accounts,
      keys: staticKeys(callers),
      requestLog,
    });
    const send = (key: string, headers: Record<string, string> = {}) =>
      fetch(`${gateway.url}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          ...headers,
        },
        body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
      });
    /** The account each recorded request was served from, in order. */
    const servedBy = async (count: number) => {
      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(count);
      });
      return requestLog.records.map(({ account }) => account);
    };
    return { setup, gateway, send, servedBy, upstream, requestLog };
  }

  it("serves an Owner tool from the account it forces, and never forwards the header", async () => {
    const { gateway, send, servedBy, upstream: fake } = await gatewaySetUp();
    try {
      expect(
        (await send(ownerKey, { "x-ai-office-account": "Spare" })).status,
      ).toBe(200);
      const refused = await send(ownerKey, {
        "x-ai-office-account": "Nobody",
      });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({
        error: {
          type: "api_error",
          message: 'The forced AI Account "Nobody" does not exist.',
        },
      });
      expect(await servedBy(2)).toEqual(["Spare", null]);
      expect(fake.received).toHaveLength(1);
      expect(Object.keys(fake.received[0]?.headers ?? {})).not.toContain(
        "x-ai-office-account",
      );
    } finally {
      await gateway.close();
    }
  });

  it("ignores a forced account from an Agent, whose sandbox is untrusted", async () => {
    const { gateway, send, servedBy } = await gatewaySetUp();
    try {
      expect(
        (await send(agentKey, { "x-ai-office-account": "Spare" })).status,
      ).toBe(200);
      expect(
        (await send(agentKey, { "x-ai-office-account": "Nobody" })).status,
      ).toBe(200);
      expect(await servedBy(2)).toEqual(["Work", "Work"]);
    } finally {
      await gateway.close();
    }
  });

  it("keeps each Agent session on one account, and spreads sessions across the best priority", async () => {
    const {
      gateway,
      send,
      servedBy,
      upstream: fake,
      requestLog,
    } = await gatewaySetUp();
    try {
      for (const session of ["sbx-1", "sbx-2", "sbx-1", "sbx-2", "sbx-1"]) {
        expect(
          (await send(agentKey, { "x-ai-office-session": session })).status,
        ).toBe(200);
      }
      // An Owner tool's requests are one session: its key's.
      await send(ownerKey);
      await send(ownerKey);
      expect(await servedBy(7)).toEqual([
        "Work",
        "Team",
        "Work",
        "Team",
        "Work",
        "Work",
        "Work",
      ]);
      // Each request records the session it named (FR-84), none for the tool.
      expect(requestLog.records.map(({ session }) => session)).toEqual([
        "sbx-1",
        "sbx-2",
        "sbx-1",
        "sbx-2",
        "sbx-1",
        null,
        null,
      ]);
      expect(
        fake.received.every(
          ({ headers }) => headers["x-ai-office-session"] === undefined,
        ),
      ).toBe(true);
    } finally {
      await gateway.close();
    }
  });
});
