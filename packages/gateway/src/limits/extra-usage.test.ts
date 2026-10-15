// Extra usage (PRD FR-41): a Claude subscription can go on past its plan's
// limits, billed as extra usage, where the Owner has turned that on at
// Anthropic. Each such account has a toggle in AI Office, off by default:
// while it is off, an account whose window is full, or that an answer says
// was served on extra usage, is held back until its plan's limit resets,
// and the next request goes to another account. Turned on, it goes on
// serving. Through a real Gateway in memory, and the store in Postgres 18.
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

import {
  AiAccountError,
  createAiAccounts,
  credentialContext,
  refreshTokenContext,
  type AiAccounts,
} from "../accounts/accounts.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountRecord,
  type AiAccountStore,
} from "../accounts/store.ts";
import { AccountsUnavailableError } from "../balancing/balancing.ts";
import { readFixture } from "../fixtures.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "../test-support.ts";
import { extraUsageUntil, outcomeOf } from "./detect.ts";
import { usageWindowsOf } from "./usage-windows.ts";

const fixture = (name: string) =>
  readFixture(
    fileURLToPath(new URL(`../../fixtures/limits/${name}`, import.meta.url)),
  );
// Served past the five-hour limit, which resets at 14:00, on extra usage.
const onExtraUsage = await fixture("anthropic-extra-usage.json");
// Five-hour window 82% used, resetting at 14:00; weekly 36.4%.
const withUsage = await fixture("anthropic-subscription-usage.json");

const encryptor = encryptorFromKey(Buffer.alloc(32, 43));
const start = Date.parse("2026-10-09T12:00:00.000Z");
const fiveHourReset = new Date("2026-10-09T14:00:00.000Z");

describe("an answer served on extra usage", () => {
  it("says so, until its plan's limit resets", () => {
    const at = new Date(start);
    const headers = new Headers(onExtraUsage.response.headers);
    expect(extraUsageUntil(headers, at)).toEqual(fiveHourReset);
    expect(
      outcomeOf({ status: 200, headers, body: onExtraUsage.response.body }, at),
    ).toEqual({ kind: "served", extraUsageUntil: fiveHourReset });
    // Within its plan's limits, or past them with extra usage refused (a
    // 429 then), it does not.
    expect(
      outcomeOf(
        {
          status: 200,
          headers: new Headers(withUsage.response.headers),
          body: "",
        },
        at,
      ),
    ).toEqual({ kind: "served" });
    const refused = new Headers(onExtraUsage.response.headers);
    refused.set("anthropic-ratelimit-unified-overage-status", "rejected");
    expect(extraUsageUntil(refused, at)).toBeUndefined();
    // Without a reset it is believed to last an hour.
    const noReset = new Headers(onExtraUsage.response.headers);
    noReset.delete("anthropic-ratelimit-unified-reset");
    expect(extraUsageUntil(noReset, at)).toEqual(
      new Date(start + 60 * 60 * 1000),
    );
  });
});

interface Office {
  readonly accounts: AiAccounts;
  readonly bus: EventBus;
  readonly ids: Record<string, string>;
  limitEvents(): Promise<EventOfType<"ai_account.limit_changed">[]>;
  at(ms: number): void;
}

/** Two Claude subscriptions, Max then Pro, and a Claude API key. */
async function office(
  store: AiAccountStore,
  bus: EventBus,
  endpoints: Record<"Max" | "Pro", string | null> = { Max: null, Pro: null },
): Promise<Office> {
  let time = start;
  let id = 0;
  const now = () => new Date(time);
  const newId = () =>
    `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const accounts = createAiAccounts({
    store,
    encryptor,
    events: bus,
    now,
    newId,
  });
  const ids: Record<string, string> = {};
  let priority = 0;
  for (const [name, endpointUrl] of Object.entries(endpoints)) {
    const accountId = newId();
    const record: AiAccountRecord = {
      id: accountId,
      name,
      accountType: "oauth",
      aiProvider: "Claude",
      credential: encryptor.encrypt(
        `sk-ant-oat01-${name.toLowerCase()}-extra-usage-0123456789`,
        credentialContext(accountId),
      ),
      endpointUrl,
      region: null,
      projectId: null,
      priority: (priority += 1),
      paused: false,
      refreshToken: encryptor.encrypt(
        `sk-ant-ort01-${name.toLowerCase()}-extra-usage-0123456789`,
        refreshTokenContext(accountId),
      ),
      tokenExpiresAt: new Date(start + 24 * 60 * 60 * 1000),
      reauthenticationNeeded: false,
      limitReason: null,
      limitedUntil: null,
      fiveHourUtilization: null,
      fiveHourResetsAt: null,
      weeklyUtilization: null,
      weeklyResetsAt: null,
      fiveHourPauseThreshold: null,
      weeklyPauseThreshold: null,
      forcedModel: null,
      extraUsage: false,
      createdAt: new Date(start),
      updatedAt: new Date(start),
    };
    await store.add(record);
    ids[name] = accountId;
  }
  ids["Key"] = (
    await accounts.add({
      name: "Key",
      aiProvider: "Claude",
      accountType: "api_key",
      credential: "sk-ant-api03-extra-usage-key-0123456789",
      priority: 3,
    })
  ).id;
  return {
    accounts,
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

/** Which account serves Claude Code's next request. */
const next = async (office: Office) =>
  (await office.accounts.select({ agentTool: "Claude Code" }))?.name;

/** What `name` was told by an answer, as the Gateway tells it. */
const answered = async (
  office: Office,
  name: string,
  answer = onExtraUsage,
) => {
  const account = await office.accounts.select({
    agentTool: "Claude Code",
    forcedAccount: name,
  });
  if (account === undefined) {
    throw new Error(`No account ${name}.`);
  }
  const headers = new Headers(answer.response.headers);
  await office.accounts.report(
    account,
    outcomeOf(
      { status: answer.response.status, headers, body: "" },
      new Date(start),
    ),
    usageWindowsOf(headers),
  );
};

const accountNamed = async (office: Office, name: string) =>
  (await office.accounts.list()).find((account) => account.name === name);

const cases: [string, (office: Office) => Promise<void>][] = [
  [
    "is off by default: served on extra usage, an account serves nothing more until its plan's limit resets",
    async (office) => {
      expect(await accountNamed(office, "Max")).toMatchObject({
        extraUsage: false,
      });
      await answered(office, "Max");
      expect(await accountNamed(office, "Max")).toMatchObject({
        limitReason: "extra_usage",
        limitedUntil: fiveHourReset,
      });
      expect(await office.limitEvents()).toEqual([
        expect.objectContaining({
          name: "Max",
          reason: "extra_usage",
          until: fiveHourReset.toISOString(),
          providerAvailable: true,
        }),
      ]);
      expect(await next(office)).toBe("Pro");
      // Once the limit resets, it serves again.
      office.at(fiveHourReset.getTime() - start);
      expect(await next(office)).toBe("Max");
    },
  ],
  [
    "holds back an account whose window is full before any extra usage is spent",
    async (office) => {
      // The answer reports the window full, but not that it was served on
      // extra usage: the next request would be.
      const full = {
        ...withUsage,
        response: {
          ...withUsage.response,
          headers: {
            ...withUsage.response.headers,
            "anthropic-ratelimit-unified-5h-utilization": "1.0",
          },
        },
      };
      await answered(office, "Max", full);
      expect(await next(office)).toBe("Pro");
      expect((await office.limitEvents()).at(-1)).toMatchObject({
        name: "Max",
        reason: "extra_usage",
        until: fiveHourReset.toISOString(),
      });
      // At 99% it is not full.
      await answered(office, "Pro", withUsage);
      expect(await next(office)).toBe("Pro");
    },
  ],
  [
    "turned on, lets an account go on serving past its plan's limits, at once",
    async (office) => {
      await answered(office, "Max");
      expect(await next(office)).toBe("Pro");

      const turnedOn = await office.accounts.update(office.ids["Max"] ?? "", {
        extraUsage: true,
      });
      expect(turnedOn).toMatchObject({
        extraUsage: true,
        limitReason: null,
        limitedUntil: null,
      });
      expect(await next(office)).toBe("Max");
      expect((await office.limitEvents()).at(-1)).toMatchObject({
        name: "Max",
        reason: null,
      });
      // Served on extra usage again, it is not held back.
      await answered(office, "Max");
      expect(await next(office)).toBe("Max");
      expect(
        (await office.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter((event) => event.type === "config.changed")
          .map((event) => event.keys),
      ).toContainEqual(["aiAccounts.extraUsage"]);

      // Turned off again, its full window holds it back at once.
      await office.accounts.update(office.ids["Max"] ?? "", {
        extraUsage: false,
      });
      expect(await next(office)).toBe("Pro");
    },
  ],
  [
    "is offered only where the AI Provider offers it",
    async (office) => {
      const refused = await office.accounts
        .update(office.ids["Key"] ?? "", { extraUsage: true })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AiAccountError);
      expect((refused as AiAccountError).code).toBe(
        aiAccountErrorCodes.extraUsageNotOffered,
      );
      // Off is no change.
      expect(
        await office.accounts.update(office.ids["Key"] ?? "", {
          extraUsage: false,
        }),
      ).toMatchObject({ extraUsage: false });
    },
  ],
  [
    "answers 429 once every account is at its plan's limit with extra usage off",
    async (office) => {
      // The API key too would serve Claude Code: it is out of the way.
      await office.accounts.update(office.ids["Key"] ?? "", { paused: true });
      await answered(office, "Max");
      await answered(office, "Pro");
      const refused = await office.accounts
        .select({ agentTool: "Claude Code" })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AccountsUnavailableError);
      expect(refused).toMatchObject({
        status: 429,
        message:
          "Every AI Account that can serve this request has reached its plan's limit, and extra usage is off.",
        retryAt: fiveHourReset,
      });
    },
  ],
];

describe("extra usage, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await office(
          memoryAiAccountStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("extra usage, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await office(
          databaseAiAccountStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});

describe("extra usage, through the Gateway", () => {
  const upstreams: FakeUpstream[] = [];
  let gateway: RunningGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    for (const upstream of upstreams.splice(0)) {
      await upstream.close();
    }
  });

  it("serves the request on extra usage, then sends the next to another subscription", async () => {
    const sent: string[] = [];
    const max = await startFakeUpstream((request, response) => {
      sent.push("Max");
      return replay(onExtraUsage)(request, response);
    });
    const pro = await startFakeUpstream((request, response) => {
      sent.push("Pro");
      return replay(withUsage)(request, response);
    });
    upstreams.push(max, pro);
    const subject = await office(
      memoryAiAccountStore(),
      createEventBus({ store: memoryEventStore() }),
      { Max: max.url, Pro: pro.url },
    );
    gateway = await startGateway({
      accounts: subject.accounts,
      now: () => new Date(start),
    });
    const send = () =>
      fetch(`${gateway?.url ?? ""}${onExtraUsage.request.path}`, {
        method: "POST",
        headers: { ...onExtraUsage.request.headers, "x-api-key": gatewayKey },
        body: onExtraUsage.request.body,
      });

    // What was asked is served: the extra usage is already spent.
    const first = await send();
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(onExtraUsage.response.body);
    const second = await send();
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(withUsage.response.body);
    expect(sent).toEqual(["Max", "Pro"]);
  });
});
