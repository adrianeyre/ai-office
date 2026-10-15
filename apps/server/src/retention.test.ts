import {
  databaseCommunicationsStore,
  memoryCommunicationsStore,
  type CommunicationsStore,
  type DeliveryRecord,
} from "@ai-office/communications";
import { signInEvents } from "@ai-office/db";
import { defaultConnectionRules } from "@ai-office/shared";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type EventStore,
} from "@ai-office/events";
import {
  createAiAccounts,
  createRequestHistory,
  databaseAiAccountStore,
  databaseRequestHistoryStore,
  memoryAiAccountStore,
  memoryRequestHistoryStore,
  type AiAccountStore,
  type GatewayRequestRecord,
  type RequestHistory,
  type RequestHistoryStore,
} from "@ai-office/gateway";
import {
  createNotices,
  createOfficeSettings,
  createRetention,
  createUsageTally,
  databaseStores,
  memoryStores,
  type Notices,
  type OfficeSettings,
  type OfficeStores,
  type Retention,
} from "@ai-office/orchestrator";
import { describe, expect, it } from "vitest";

import {
  databaseAuthStore,
  memoryAuthStore,
  type AuthStore,
} from "./auth/store.ts";
import { retentionTargets } from "./retention.ts";
import { testEncryptor } from "./test-support.ts";

// Retention (PRD §7), end to end with a fake clock: each rule deletes what
// is past its period, and only that, from where AI Office really keeps it;
// the periods the Owner sets apply; what Token Caps count survives the
// records; and Connections' outbound queue survives their delivery logs.
// Every case runs in memory and in Postgres 18.

const day = 24 * 60 * 60 * 1000;
const start = Date.parse("2025-10-01T12:00:00.000Z");

interface Office {
  readonly clock: { at(ms: number): void; now(): Date };
  readonly bus: EventBus;
  readonly requests: RequestHistory;
  readonly aiAccounts: AiAccountStore;
  readonly accountId: string;
  readonly notices: Notices;
  readonly auth: AuthStore;
  readonly communications: CommunicationsStore;
  readonly settings: OfficeSettings;
  readonly retention: Retention;
  /** Events, Notices and sign-ins still kept. */
  readonly kept: () => Promise<{
    events: string[];
    notices: string[];
    signIns: Date[];
  }>;
}

interface Stores {
  readonly office: OfficeStores;
  readonly events: EventStore;
  readonly requests: RequestHistoryStore;
  readonly aiAccounts: AiAccountStore;
  readonly auth: AuthStore;
  readonly communications: CommunicationsStore;
  /** Every sign-in still kept. */
  readonly signIns: () => Promise<Date[]>;
}

async function office(stores: Stores): Promise<Office> {
  let time = start;
  const clock = {
    at(ms: number) {
      time = start + ms;
    },
    now: () => new Date(time),
  };
  const bus = createEventBus({ store: stores.events, now: clock.now });
  const requests = createRequestHistory({
    store: stores.requests,
    encryptor: testEncryptor,
  });
  const accounts = createAiAccounts({
    store: stores.aiAccounts,
    encryptor: testEncryptor,
    events: bus,
    now: clock.now,
  });
  const { id: accountId } = await accounts.add({
    name: "Work",
    aiProvider: "Claude",
    accountType: "api_key",
    credential: "sk-ant-api03-retention-test-0123456789",
    endpointUrl: null,
  });
  const notices = createNotices({
    store: stores.office.notices,
    events: bus,
    now: clock.now,
  });
  const settings = createOfficeSettings({
    store: stores.office.office,
    floors: stores.office.floors,
    events: bus,
    now: clock.now,
  });
  const retention = createRetention({
    settings: () => settings.retentionSettings(),
    targets: retentionTargets({
      requests: stores.requests,
      aiAccounts: stores.aiAccounts,
      events: stores.events,
      notices: stores.office.notices,
      auth: stores.auth,
      communications: stores.communications,
    }),
    now: clock.now,
  });
  return {
    clock,
    bus,
    requests,
    aiAccounts: stores.aiAccounts,
    accountId,
    notices,
    auth: stores.auth,
    communications: stores.communications,
    settings,
    retention,
    kept: async () => ({
      events: (await bus.eventsAfter(0)).map(({ event }) => event.type),
      notices: (
        await Promise.all(
          noticeIds.map(
            async (id) => [id, await stores.office.notices.get(id)] as const,
          ),
        )
      ).flatMap(([id, notice]) => (notice === undefined ? [] : [id])),
      signIns: await stores.signIns(),
    }),
  };
}

/** The Notices each case raises, by id, so it can look for them later. */
const noticeIds: string[] = [];

const record = (
  fields: Partial<GatewayRequestRecord> = {},
): GatewayRequestRecord => ({
  startedAt: new Date(start),
  account: "Work",
  accountId: null,
  endpoint: "messages",
  model: "claude-opus-5-5",
  streamed: false,
  status: 200,
  latencyMs: 100,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  upstreamRequestId: null,
  gatewayKeyId: null,
  agentId: "ada",
  floorId: "web-shop",
  ownerTool: null,
  issue: 4,
  pullRequest: null,
  estimatedCostUsd: 0.03,
  timeToFirstByteMs: 50,
  requestHeaders: null,
  responseHeaders: null,
  ...fields,
});

const bodies = {
  request: '{"messages":["Refactor the basket"]}',
  response: '{"content":"Done."}',
  truncated: false,
};

/** A delivery to the Slack Connection of `eventId`, queued at `createdAt`. */
const delivery = (
  eventId: number,
  status: DeliveryRecord["status"],
  createdAt: Date,
): DeliveryRecord => ({
  id: `delivery-${String(eventId)}`,
  connectionId: "slack",
  eventId,
  test: false,
  message: {
    kind: "work_complete",
    title: "Pull request merged",
    floor: null,
    aiOfficeUrl: "http://localhost:3046/activity",
    githubUrl: null,
    occurredAt: createdAt.toISOString(),
  },
  status,
  attempts: status === "pending" ? 0 : 1,
  createdAt,
  // Pending: held for the end of quiet hours, long after it was queued.
  nextAttemptAt:
    status === "pending" ? new Date(createdAt.getTime() + 400 * day) : null,
  firstAttemptAt: status === "pending" ? null : createdAt,
  lastAttemptAt: status === "pending" ? null : createdAt,
  deliveredAt: status === "delivered" ? createdAt : null,
  error: status === "failed" ? "Slack answered 404." : null,
});

const requestIds = async (office: Office) =>
  (await office.requests.list({ limit: 50 })).requests
    .map(({ id }) => id)
    .sort((a, b) => a - b);

type Case = [name: string, run: (office: Office) => Promise<void>];

const cases: Case[] = [
  [
    "deletes request and response bodies after 7 days, keeping the requests",
    async (office) => {
      await office.requests.record({ ...record(), bodies });
      office.clock.at(3 * day);
      await office.requests.record({
        ...record({ startedAt: office.clock.now() }),
        bodies,
      });
      const [older, newer] = await requestIds(office);

      office.clock.at(7 * day);
      await office.retention.run();
      expect((await office.requests.get(older ?? 0))?.bodies).not.toBeNull();

      office.clock.at(7 * day + 1);
      const report = await office.retention.run();
      expect(report.deleted[0]).toEqual({
        rule: "requestBodiesDays",
        before: new Date(start + 1),
        count: 1,
      });
      expect((await office.requests.get(older ?? 0))?.bodies).toBeNull();
      expect((await office.requests.get(newer ?? 0))?.bodies?.request).toBe(
        bodies.request,
      );
      expect(await requestIds(office)).toEqual([older, newer]);
    },
  ],
  [
    "deletes requests' records and usage readings after 90 days, and Token Caps still count them",
    async (office) => {
      await office.requests.record({ ...record(), bodies });
      await office.requests.record(
        record({ startedAt: new Date(start + 60 * 60 * 1000), issue: null }),
      );
      await office.aiAccounts.addUsage({
        aiAccountId: office.accountId,
        window: "weekly",
        utilization: 40,
        resetsAt: new Date(start + 7 * day),
        observedAt: new Date(start),
      });
      // What Token Caps count for that day and month (FR-31, FR-32).
      const dayOf = [
        new Date("2025-10-01T00:00:00.000Z"),
        new Date("2025-10-02T00:00:00.000Z"),
      ] as const;
      const monthOf = [
        new Date("2025-10-01T00:00:00.000Z"),
        new Date("2025-11-01T00:00:00.000Z"),
      ] as const;
      const counted = async (from: Date, to: Date) => {
        // A fresh tally, as the server reads after a restart.
        const tally = createUsageTally({
          load: (f, t) => office.requests.tokenUsage(f, t),
          now: () => office.clock.now(),
        });
        return (await tally.usage(from, to))
          .filter(({ agentId }) => agentId === "ada")
          .reduce((sum, { totals }) => sum + totals.tokens, 0);
      };
      expect(await counted(...dayOf)).toBe(2400);

      office.clock.at(90 * day);
      await office.retention.run();
      expect(await requestIds(office)).toHaveLength(2);

      office.clock.at(91 * day);
      const report = await office.retention.run();
      expect(
        report.deleted.find(({ rule }) => rule === "requestMetadataDays")
          ?.count,
      ).toBe(3);
      expect(await requestIds(office)).toEqual([]);
      expect(
        await office.aiAccounts.usageHistory(office.accountId, {
          since: new Date(0),
          limit: 10,
        }),
      ).toEqual([]);
      // The records are gone; what they used is not.
      expect(await counted(...dayOf)).toBe(2400);
      expect(await counted(...monthOf)).toBe(2400);
      const issueUsage = (await office.requests.tokenUsage(...monthOf)).find(
        ({ issue }) => issue === 4,
      );
      expect(issueUsage?.totals).toMatchObject({
        requests: 1,
        inputTokens: 1000,
        outputTokens: 200,
        tokens: 1200,
      });
    },
  ],
  [
    "deletes Activity Feed events, closed Notices and sign-ins after a year, keeping open Notices",
    async (office) => {
      const open = await office.notices.raise({
        kind: "action",
        title: "Plan awaiting approval",
      });
      const dismissed = await office.notices.raise({
        kind: "info",
        title: "Batch finished",
      });
      await office.notices.dismiss(dismissed.id);
      noticeIds.splice(0, noticeIds.length, open.id, dismissed.id);
      await office.auth.recordSignInEvent({
        occurredAt: office.clock.now(),
        outcome: "succeeded",
        ip: "203.0.113.7",
        userAgent: null,
      });
      office.clock.at(200 * day);
      await office.bus.publish({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["gitIdentity"],
      });
      const before = await office.kept();
      expect(before.notices).toEqual([open.id, dismissed.id]);
      expect(before.signIns).toHaveLength(1);

      office.clock.at(365 * day);
      await office.retention.run();
      expect(await office.kept()).toEqual(before);

      office.clock.at(365 * day + 1);
      const report = await office.retention.run();
      const kept = await office.kept();
      // Only the later event is left.
      expect(kept.events).toEqual(["config.changed"]);
      expect(kept.notices).toEqual([open.id]);
      expect(kept.signIns).toEqual([]);
      expect(
        report.deleted.find(({ rule }) => rule === "activityDays")?.count,
      ).toBe(before.events.length - 1 + 1 + 1);
      // The open Notice is still on the board, and the log carries on.
      expect((await office.notices.open()).map(({ id }) => id)).toEqual([
        open.id,
      ]);
      const next = await office.bus.publish({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["intake.intervalSeconds"],
      });
      expect(next.id).toBeGreaterThan(before.events.length);
    },
  ],
  [
    "deletes Connections' finished deliveries after 90 days, keeping those still waiting to go",
    async (office) => {
      await office.communications.addConnection({
        id: "slack",
        name: "Team Slack",
        type: "slack",
        rules: defaultConnectionRules,
        detailLevel: "titles_and_summaries",
        settings: {},
        credentials: "aio1:sealed",
        hint: "…/T0001",
        paused: false,
        status: "ok",
        consecutiveFailures: 0,
        digestCursor: 0,
        lastDigestAt: null,
        createdAt: office.clock.now(),
      });
      const queued = office.clock.now();
      await office.communications.enqueue(
        [
          delivery(1, "delivered", queued),
          delivery(2, "failed", queued),
          delivery(3, "summarised", queued),
          delivery(4, "pending", queued),
          delivery(5, "delivered", new Date(start + 30 * day)),
        ],
        5,
      );
      const kept = async () =>
        (await office.communications.deliveries("slack", 10))
          .map(({ eventId }) => eventId)
          .sort();

      office.clock.at(90 * day);
      await office.retention.run();
      expect(await kept()).toEqual([1, 2, 3, 4, 5]);

      office.clock.at(90 * day + 1);
      const report = await office.retention.run();
      expect(
        report.deleted.find(({ rule }) => rule === "connectionDeliveriesDays"),
      ).toEqual({
        rule: "connectionDeliveriesDays",
        before: new Date(start + 1),
        count: 3,
      });
      // The held delivery is the queue, not its log: it stays to be sent.
      expect(await kept()).toEqual([4, 5]);
      expect(
        await office.communications.due(new Date(start + 401 * day), 10),
      ).toHaveLength(1);
    },
  ],
  [
    "uses the periods the Owner sets in the office admin",
    async (office) => {
      await office.requests.record({ ...record(), bodies });
      office.clock.at(2 * day);
      await office.retention.run();
      const [id] = await requestIds(office);
      expect((await office.requests.get(id ?? 0))?.bodies).not.toBeNull();

      await office.settings.setRetentionSettings({
        requestBodiesDays: 1,
        requestMetadataDays: 90,
        activityDays: 365,
        connectionDeliveriesDays: 90,
      });
      await office.retention.run();
      expect((await office.requests.get(id ?? 0))?.bodies).toBeNull();
      expect(await requestIds(office)).toEqual([id]);
    },
  ],
];

describe("retention, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const auth = memoryAuthStore();
      await run(
        await office({
          office: memoryStores(),
          events: memoryEventStore(),
          requests: memoryRequestHistoryStore(),
          aiAccounts: memoryAiAccountStore(),
          auth,
          communications: memoryCommunicationsStore(),
          signIns: () =>
            Promise.resolve(
              auth.state.signInEvents.map(({ occurredAt }) => occurredAt),
            ),
        }),
      );
    });
  }
});

describe("retention, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await office({
          office: databaseStores(database.db),
          events: databaseEventStore(database.db),
          requests: databaseRequestHistoryStore(database.db),
          aiAccounts: databaseAiAccountStore(database.db),
          auth: databaseAuthStore(database.db),
          communications: databaseCommunicationsStore(database.db),
          signIns: async () =>
            (await database.db.select().from(signInEvents)).map(
              ({ occurredAt }) => occurredAt,
            ),
        }),
      );
    });
  }
});
