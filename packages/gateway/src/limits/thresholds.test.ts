// Usage windows, pause thresholds and force-reset (PRD FR-36, FR-43): the
// windows an AI Provider reports are stored with their history; an account
// whose window reaches the Owner's pause threshold is held back until the
// window resets; and a force-reset clears a rate-limit state. Through a
// real Gateway in memory, and the store in Postgres 18.
import { fileURLToPath } from "node:url";

import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type EventOfType,
} from "@ai-office/events";
import { aiAccountErrorCodes } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountStore,
} from "../accounts/store.ts";
import { readFixture, type Fixture } from "../fixtures.ts";
import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "../test-support.ts";
import { usageWindowsOf } from "./usage-windows.ts";

const fixture = (name: string) =>
  readFixture(
    fileURLToPath(new URL(`../../fixtures/limits/${name}`, import.meta.url)),
  );
// Five-hour window 82% used, resetting at 14:00; weekly 36.4%, Monday 09:00.
const withUsage = await fixture("anthropic-subscription-usage.json");
const served = await fixture("anthropic-served.json");
const rateLimited = await fixture("anthropic-rate-limited.json");

/** `withUsage`, with its five-hour window at `fraction`. */
const usedAt = (fraction: string): Fixture => ({
  ...withUsage,
  response: {
    ...withUsage.response,
    headers: {
      ...withUsage.response.headers,
      "anthropic-ratelimit-unified-5h-utilization": fraction,
    },
  },
});

const encryptor = encryptorFromKey(Buffer.alloc(32, 34));
const start = Date.parse("2026-10-09T12:00:00.000Z");
const fiveHourReset = new Date("2026-10-09T14:00:00.000Z");
const weeklyReset = new Date("2026-10-12T09:00:00.000Z");

interface Office {
  readonly accounts: AiAccounts;
  readonly store: AiAccountStore;
  readonly bus: EventBus;
  readonly ids: Record<string, string>;
  readonly limitEvents: () => Promise<
    EventOfType<"ai_account.limit_changed">[]
  >;
  at(ms: number): void;
}

async function office(
  store: AiAccountStore,
  bus: EventBus,
  endpoints: Record<string, string | null>,
): Promise<Office> {
  let time = start;
  let id = 0;
  const accounts = createAiAccounts({
    store,
    encryptor,
    events: bus,
    now: () => new Date(time),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
  const ids: Record<string, string> = {};
  let priority = 0;
  for (const [name, endpointUrl] of Object.entries(endpoints)) {
    ids[name] = (
      await accounts.add({
        name,
        aiProvider: "Claude",
        accountType: "api_key",
        credential: `sk-ant-api03-${name.toLowerCase()}-usage-0123456789`,
        endpointUrl,
        priority: (priority += 1),
      })
    ).id;
  }
  return {
    accounts,
    store,
    bus,
    ids,
    limitEvents: async () =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (event): event is EventOfType<"ai_account.limit_changed"> =>
            event.type === "ai_account.limit_changed",
        ),
    at(ms) {
      time = start + ms;
    },
  };
}

/** What `name` reports, as the Gateway tells it after an answer. */
const report = async (
  office: Office,
  name: string,
  answer: Fixture = withUsage,
) => {
  const account = await office.accounts.select({
    agentTool: null,
    forcedAccount: name,
  });
  if (account === undefined) {
    throw new Error(`No account ${name}.`);
  }
  await office.accounts.report(
    account,
    { kind: "served" },
    usageWindowsOf(new Headers(answer.response.headers)),
  );
};

const accountNamed = async (office: Office, name: string) =>
  (await office.accounts.list()).find((account) => account.name === name);

const cases: [string, (office: Office) => Promise<void>][] = [
  [
    "stores the windows an answer reports, and keeps each change in the history",
    async (office) => {
      await report(office, "First");
      expect(await accountNamed(office, "First")).toMatchObject({
        fiveHourUtilization: 82,
        fiveHourResetsAt: fiveHourReset,
        weeklyUtilization: 36.4,
        weeklyResetsAt: weeklyReset,
      });
      // The same again, or less than a whole percent more, is not kept.
      office.at(60_000);
      await report(office, "First");
      await report(office, "First", usedAt("0.825"));
      office.at(120_000);
      await report(office, "First", usedAt("0.83"));
      const history = await office.accounts.usageHistory(
        office.ids["First"] ?? "",
        {
          since: new Date(0),
          limit: 50,
        },
      );
      const readings = history.map(
        ({ window, utilization, resetsAt, observedAt }) => ({
          window,
          utilization,
          resetsAt,
          observedAt,
        }),
      );
      // Newest first: the 83%, then both readings of the first answer.
      expect(readings[0]).toEqual({
        window: "five_hour",
        utilization: 83,
        resetsAt: fiveHourReset,
        observedAt: new Date(start + 120_000),
      });
      expect(readings.slice(1)).toHaveLength(2);
      expect(readings.slice(1)).toEqual(
        expect.arrayContaining([
          {
            window: "five_hour",
            utilization: 82,
            resetsAt: fiveHourReset,
            observedAt: new Date(start),
          },
          {
            window: "weekly",
            utilization: 36.4,
            resetsAt: weeklyReset,
            observedAt: new Date(start),
          },
        ]),
      );
      expect(
        await office.accounts.usageHistory(office.ids["First"] ?? "", {
          since: new Date(start + 1),
          limit: 50,
        }),
      ).toHaveLength(1);
      // Holding nothing back: no threshold is set.
      expect(await office.limitEvents()).toEqual([]);
    },
  ],
  [
    "pauses an account at its threshold until the window resets",
    async (office) => {
      await office.accounts.update(office.ids["First"] ?? "", {
        fiveHourPauseThreshold: 80,
      });
      await report(office, "First");
      expect(await office.limitEvents()).toEqual([
        expect.objectContaining({
          name: "First",
          reason: "usage_threshold",
          until: fiveHourReset.toISOString(),
          providerAvailable: true,
        }),
      ]);
      // The next request goes to the second account.
      expect((await office.accounts.select({ agentTool: null }))?.name).toBe(
        "Second",
      );

      // Once the window resets, it serves again, and the minute's check
      // tells it.
      office.at(fiveHourReset.getTime() - start);
      expect((await office.accounts.select({ agentTool: null }))?.name).toBe(
        "First",
      );
      await office.accounts.checkLimits();
      expect((await office.limitEvents()).at(-1)).toMatchObject({
        name: "First",
        reason: null,
        providerAvailable: true,
      });
    },
  ],
  [
    "pauses at once when a threshold is set below what is used, and lets go when it is removed",
    async (office) => {
      await report(office, "First");
      await office.accounts.update(office.ids["First"] ?? "", {
        weeklyPauseThreshold: 30,
      });
      expect(await accountNamed(office, "First")).toMatchObject({
        weeklyPauseThreshold: 30,
      });
      expect((await office.limitEvents()).at(-1)).toMatchObject({
        reason: "usage_threshold",
        until: weeklyReset.toISOString(),
      });
      await office.accounts.update(office.ids["First"] ?? "", {
        weeklyPauseThreshold: null,
      });
      expect((await office.limitEvents()).at(-1)).toMatchObject({
        reason: null,
      });
      expect(
        (await office.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter((event) => event.type === "config.changed")
          .map((event) => event.keys),
      ).toContainEqual(["aiAccounts.weeklyPauseThreshold"]);
    },
  ],
  [
    "force-reset clears a rate-limit state, the circuit breaker and the windows",
    async (office) => {
      const first = await office.accounts.select({
        agentTool: null,
        forcedAccount: "First",
      });
      if (first === undefined) {
        throw new Error("No account First.");
      }
      await office.accounts.update(office.ids["First"] ?? "", {
        fiveHourPauseThreshold: 80,
      });
      await report(office, "First");
      await office.accounts.report(first, {
        kind: "rate_limited",
        until: new Date(start + 60 * 60 * 1000),
      });
      expect(await accountNamed(office, "First")).toMatchObject({
        limitReason: "rate_limited",
      });

      const reset = await office.accounts.resetLimits(
        office.ids["First"] ?? "",
      );
      expect(reset).toMatchObject({
        limitReason: null,
        limitedUntil: null,
        fiveHourUtilization: null,
        weeklyUtilization: null,
        // The Owner's thresholds stay.
        fiveHourPauseThreshold: 80,
      });
      expect((await office.accounts.select({ agentTool: null }))?.name).toBe(
        "First",
      );
      expect((await office.limitEvents()).at(-1)).toMatchObject({
        name: "First",
        reason: null,
        until: null,
        providerAvailable: true,
      });
      expect(
        (await office.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter((event) => event.type === "config.changed")
          .map((event) => event.keys),
      ).toContainEqual(["aiAccounts.limitsReset"]);
      // The history is kept.
      expect(
        await office.accounts.usageHistory(office.ids["First"] ?? "", {
          since: new Date(0),
          limit: 50,
        }),
      ).toHaveLength(2);
    },
  ],
  [
    "answers ai_account_not_found for an account that does not exist",
    async (office) => {
      for (const attempt of [
        () => office.accounts.resetLimits("nowhere"),
        () =>
          office.accounts.usageHistory("nowhere", {
            since: new Date(0),
            limit: 1,
          }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          code: aiAccountErrorCodes.aiAccountNotFound,
        });
      }
    },
  ],
  [
    "deletes every account's readings observed before a cutoff (retention)",
    async (office) => {
      const reading = (name: string, observedAt: string) => ({
        aiAccountId: office.ids[name] ?? "",
        window: "five_hour" as const,
        utilization: 12,
        resetsAt: fiveHourReset,
        observedAt: new Date(observedAt),
      });
      for (const [name, observedAt] of [
        ["First", "2026-07-01T00:00:00.000Z"],
        ["Second", "2026-07-10T23:59:59.999Z"],
        ["First", "2026-07-11T00:00:00.000Z"],
      ] as const) {
        await office.store.addUsage(reading(name, observedAt));
      }
      expect(
        await office.store.deleteUsageBefore(
          new Date("2026-07-11T00:00:00.000Z"),
        ),
      ).toBe(2);
      const history = async (name: string) =>
        (
          await office.store.usageHistory(office.ids[name] ?? "", {
            since: new Date(0),
            limit: 50,
          })
        ).map(({ observedAt }) => observedAt.toISOString());
      expect(await history("First")).toEqual(["2026-07-11T00:00:00.000Z"]);
      expect(await history("Second")).toEqual([]);
    },
  ],
  [
    "forgets an account's history when it is deleted",
    async (office) => {
      await report(office, "First");
      await office.accounts.remove(office.ids["First"] ?? "");
      await expect(
        office.store.usageHistory(office.ids["First"] ?? "", {
          since: new Date(0),
          limit: 50,
        }),
      ).resolves.toEqual([]);
    },
  ],
];

describe("usage windows and thresholds, in memory", () => {
  it.each(cases)("%s", async (_name, run) => {
    await run(
      await office(
        memoryAiAccountStore(),
        createEventBus({ store: memoryEventStore() }),
        { First: null, Second: null },
      ),
    );
  });
});

describe("usage windows and thresholds, in Postgres 18", () => {
  postgresTest.for(cases)("%s", async ([, run], { database }) => {
    await run(
      await office(
        databaseAiAccountStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
        { First: null, Second: null },
      ),
    );
  });
});

describe("through the Gateway", () => {
  let gateway: RunningGateway | undefined;
  const upstreams: FakeUpstream[] = [];

  afterEach(async () => {
    await gateway?.close();
    for (const upstream of upstreams.splice(0)) {
      await upstream.close();
    }
  });

  it("reads the windows from each answer, and answers 529 when every account is at its threshold", async () => {
    const answers = [withUsage, served];
    for (const answer of answers) {
      upstreams.push(await startFakeUpstream(replay(answer)));
    }
    let time = start;
    const bus = createEventBus({ store: memoryEventStore() });
    const accounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: bus,
      now: () => new Date(time),
    });
    const only = await accounts.add({
      name: "Max",
      aiProvider: "Claude",
      accountType: "api_key",
      credential: "sk-ant-api03-max-usage-0123456789",
      endpointUrl: upstreams[0]?.url ?? null,
    });
    await accounts.update(only.id, { fiveHourPauseThreshold: 80 });
    gateway = await startGateway({
      accounts,
      requestLog: memoryRequestLog(),
      now: () => new Date(time),
    });
    const send = async () => {
      const response = await fetch(`${gateway?.url ?? ""}/v1/messages`, {
        method: "POST",
        headers: { ...withUsage.request.headers, "x-api-key": gatewayKey },
        body: withUsage.request.body,
      });
      return {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      };
    };

    expect((await send()).status).toBe(200);
    expect((await accounts.list())[0]).toMatchObject({
      fiveHourUtilization: 82,
      fiveHourResetsAt: fiveHourReset,
    });

    // At its threshold: throttling, until the window resets.
    time = start + 30 * 60 * 1000;
    const refused = await send();
    expect(refused.status).toBe(529);
    expect(refused.headers.get("retry-after")).toBe(String(90 * 60));
    expect(JSON.parse(refused.body)).toMatchObject({
      error: {
        type: "overloaded_error",
        message:
          "Every AI Account that can serve this request has reached its usage pause threshold.",
      },
    });
    expect(upstreams[0]?.received).toHaveLength(1);

    // A force-reset lets it serve again at once.
    await accounts.resetLimits(only.id);
    expect((await send()).status).toBe(200);
    expect(upstreams[0]?.received).toHaveLength(2);
  });

  it("a rate limit's answer reports its windows too", async () => {
    upstreams.push(
      await startFakeUpstream(
        replay({
          ...rateLimited,
          response: {
            ...rateLimited.response,
            headers: {
              ...rateLimited.response.headers,
              "anthropic-ratelimit-unified-5h-utilization": "1",
              "anthropic-ratelimit-unified-5h-reset": "1791554400",
            },
          },
        }),
      ),
    );
    const accounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      now: () => new Date(start),
    });
    await accounts.add({
      name: "Max",
      aiProvider: "Claude",
      accountType: "api_key",
      credential: "sk-ant-api03-max-usage-0123456789",
      endpointUrl: upstreams[0]?.url ?? null,
    });
    gateway = await startGateway({
      accounts,
      requestLog: memoryRequestLog(),
      now: () => new Date(start),
    });
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { ...served.request.headers, "x-api-key": gatewayKey },
      body: served.request.body,
    });
    await response.text();
    expect(response.status).toBe(429);
    expect((await accounts.list())[0]).toMatchObject({
      limitReason: "rate_limited",
      fiveHourUtilization: 100,
    });
  });
});
