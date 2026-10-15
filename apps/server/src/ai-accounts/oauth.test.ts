import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createAiAccounts,
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccounts,
  type AiAccountStore,
} from "@ai-office/gateway";
import {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "@ai-office/gateway/testing";
import {
  createNotices,
  createReauthenticationNotices,
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  aiAccountListSchema,
  aiAccountSchema,
  apiErrorSchema,
  createRedactor,
  noticeListSchema,
  oauthLoginSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  type SignedIn,
} from "../test-support.ts";

// Claude subscriptions through the API (PRD FR-35, FR-36, FR-49), against
// a fake OAuth server: the whole PKCE sign-in, the warning about the AI
// Provider's terms, a refused refresh raising the "re-authentication
// needed" Notice, and signing in again closing it. No answer, event or log
// line carries a token or the pasted code. Each case runs in memory and in
// Postgres 18.

const hour = 60 * 60 * 1000;
const start = Date.UTC(2026, 9, 9, 12, 0, 0);

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly accounts: AiAccounts;
  readonly oauth: FakeOAuthServer;
  readonly bus: EventBus;
  readonly logs: string[];
  /** Sets the clock this far after the start. */
  readonly at: (ms: number) => void;
}

let oauth: FakeOAuthServer | undefined;

afterEach(async () => {
  await oauth?.close();
  oauth = undefined;
});

async function setUp(
  store: AiAccountStore,
  stores: OfficeStores,
  bus: EventBus,
): Promise<Setup> {
  oauth = await startFakeOAuthServer();
  const logs: string[] = [];
  const redactor = createRedactor();
  let time = start;
  const now = () => new Date(time);
  const accounts = createAiAccounts({
    store,
    encryptor: testEncryptor,
    events: bus,
    oauth: oauth.provider,
    onCredential: (value) => {
      redactor.register(value);
    },
    now,
  });
  const notices = createNotices({ store: stores.notices, events: bus, now });
  createReauthenticationNotices({
    notices,
    events: bus,
    needsReauthentication: async (id) =>
      (await accounts.list()).some(
        (account) => account.id === id && account.reauthenticationNeeded,
      ),
  });
  const server = await buildApp({
    logger: createLogger({
      level: "trace",
      secrets: [],
      redactor,
      destination: { write: (line: string) => logs.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth({ now }),
    events: bus,
    stores,
    notices,
    aiAccounts: accounts,
  });
  return {
    server,
    owner: await signIn(server),
    accounts,
    oauth,
    bus,
    logs,
    at: (ms) => {
      time = start + ms;
    },
  };
}

const post = ({ server, owner }: Setup, url: string, payload: object = {}) =>
  server.inject({ method: "POST", url, headers: owner.headers, payload });

const get = ({ server, owner }: Setup, url: string) =>
  server.inject({ method: "GET", url, headers: owner.headers });

/** Nothing sent, published or logged holds a token, or the pasted code. */
const expectNoSecrets = async (setup: Setup, extra: string[] = []) => {
  const everything = [
    ...extra,
    JSON.stringify(await setup.bus.eventsAfter(0)),
    ...setup.logs,
  ].join("\n");
  expect(everything).not.toMatch(/sk-ant-o[ar]t01-fake/);
};

/** Signs in through the API: start, the Owner's sign-in, the pasted code. */
async function signInThrough(setup: Setup, startUrl: string, body: object) {
  const started = await post(setup, startUrl, body);
  expect(started.statusCode).toBe(201);
  expect(started.headers["cache-control"]).toBe("no-store");
  const login = oauthLoginSchema.parse(started.json());
  const pasted = await setup.oauth.signIn(login.authorizeUrl);
  const finished = await post(
    setup,
    `/api/ai-accounts/oauth/${login.loginId}`,
    {
      code: pasted,
    },
  );
  await expectNoSecrets(setup, [finished.body]);
  expect(JSON.stringify(setup.logs)).not.toContain(pasted.split("#")[0]);
  return finished;
}

const subscription = {
  name: "Claude Max",
  aiProvider: "Claude",
  acceptedTerms: true,
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds a subscription through the whole PKCE sign-in, once its terms are accepted",
    async (setup) => {
      const refused = await post(setup, "/api/ai-accounts/oauth", {
        ...subscription,
        acceptedTerms: false,
      });
      expect(refused.statusCode).toBe(400);
      expect(apiErrorSchema.parse(refused.json()).problems).toEqual([
        "Confirm you have read the AI Provider's terms for subscriptions.",
      ]);

      const finished = await signInThrough(
        setup,
        "/api/ai-accounts/oauth",
        subscription,
      );
      expect(finished.statusCode).toBe(201);
      const account = aiAccountSchema.parse(finished.json());
      expect(finished.json()).toEqual({
        id: account.id,
        name: "Claude Max",
        aiProvider: "Claude",
        accountType: "oauth",
        endpointUrl: null,
        region: null,
        projectId: null,
        priority: 1,
        paused: false,
        tokenHealth: "valid",
        tokenExpiresAt: new Date(start + 8 * hour).toISOString(),
        reauthenticationNeeded: false,
        limitReason: null,
        limitedUntil: null,
        usage: { fiveHour: null, weekly: null },
        fiveHourPauseThreshold: null,
        weeklyPauseThreshold: null,
        // No forced Model; a subscription's extra usage is off (FR-41).
        forcedModel: null,
        extraUsage: false,
        rateLimits: null,
        balance: null,
        createdAt: new Date(start).toISOString(),
        updatedAt: new Date(start).toISOString(),
      });
      // The Owner sees its health go from valid to expiring as time passes.
      setup.at(7.9 * hour);
      const listed = aiAccountListSchema.parse(
        (await get(setup, "/api/ai-accounts")).json(),
      );
      expect(listed.accounts[0]?.tokenHealth).toBe("expiring");
    },
  ],
  [
    "tells the page whether a sign-in still waits",
    async (setup) => {
      const started = oauthLoginSchema.parse(
        (await post(setup, "/api/ai-accounts/oauth", subscription)).json(),
      );
      const waiting = await get(
        setup,
        `/api/ai-accounts/oauth/${started.loginId}`,
      );
      expect(waiting.statusCode).toBe(200);
      expect(waiting.headers["cache-control"]).toBe("no-store");
      expect(waiting.json()).toEqual({ status: "pending" });
      const unknown = await get(setup, "/api/ai-accounts/oauth/nope");
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: "oauth_login_not_found" });
    },
  ],
  [
    "refuses an unknown sign-in, and a code the AI Provider refuses",
    async (setup) => {
      const unknown = await post(setup, "/api/ai-accounts/oauth/nope", {
        code: "abc#def",
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: "oauth_login_not_found" });

      const started = oauthLoginSchema.parse(
        (await post(setup, "/api/ai-accounts/oauth", subscription)).json(),
      );
      const state = new URL(started.authorizeUrl).searchParams.get("state");
      const bad = await post(
        setup,
        `/api/ai-accounts/oauth/${started.loginId}`,
        { code: `not-a-code-it-issued#${state ?? ""}` },
      );
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: "oauth_code_refused" });
      expect(
        aiAccountListSchema.parse((await get(setup, "/api/ai-accounts")).json())
          .accounts,
      ).toEqual([]);
    },
  ],
  [
    "raises the re-authentication Notice when a refresh is refused, and closes it once signed in again",
    async (setup) => {
      const added = aiAccountSchema.parse(
        (
          await signInThrough(setup, "/api/ai-accounts/oauth", subscription)
        ).json(),
      );
      setup.oauth.refuseRefreshes = true;
      setup.at(7.9 * hour);
      expect((await setup.accounts.refreshTokens()).refused).toEqual([
        added.id,
      ]);

      const open = async () =>
        noticeListSchema.parse((await get(setup, "/api/notices")).json())
          .notices;
      await vi.waitFor(async () => {
        expect(await open()).toHaveLength(1);
      });
      const [notice] = await open();
      expect(notice).toMatchObject({
        kind: "action",
        title: "Re-authentication needed: Claude Max",
        actions: [
          {
            id: "reauthenticate_ai_account",
            label: "Re-authenticate",
            href: `/ai-settings?reauthenticate=${added.id}`,
          },
        ],
      });
      expect(
        aiAccountListSchema.parse((await get(setup, "/api/ai-accounts")).json())
          .accounts[0],
      ).toMatchObject({
        reauthenticationNeeded: true,
        tokenHealth: "expiring",
      });

      // The action is not done until the account has signed in again.
      const early = await post(setup, `/api/notices/${notice?.id ?? ""}/act`, {
        action: "reauthenticate_ai_account",
      });
      expect(early.statusCode).toBe(502);
      expect(await open()).toHaveLength(1);

      setup.oauth.refuseRefreshes = false;
      const again = await signInThrough(
        setup,
        `/api/ai-accounts/${added.id}/reauthenticate`,
        {},
      );
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({
        id: added.id,
        reauthenticationNeeded: false,
        tokenHealth: "valid",
      });
      await vi.waitFor(async () => {
        expect(await open()).toEqual([]);
      });
      // The Notice is closed before its event is published, so the empty
      // list can be seen first: wait for the event too.
      await vi.waitFor(async () => {
        expect(
          (await setup.bus.eventsAfter(0)).some(
            ({ event }) =>
              event.type === "notice.acted_on" &&
              event.action === "reauthenticate_ai_account",
          ),
        ).toBe(true);
      });
      await expectNoSecrets(setup);
    },
  ],
  [
    "signs in again only a subscription",
    async (setup) => {
      const key = await post(setup, "/api/ai-accounts", {
        name: "Work",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: "console-account-key-7d1e4b9a3c5f0e2d8b6a",
      });
      const { id } = aiAccountSchema.parse(key.json());
      const refused = await post(
        setup,
        `/api/ai-accounts/${id}/reauthenticate`,
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: "not_oauth_account" });
      expect(
        (await post(setup, "/api/ai-accounts/nobody/reauthenticate"))
          .statusCode,
      ).toBe(404);
    },
  ],
  [
    "shows a new subscription's five-hour and weekly usage at once, and reads it again on demand",
    async (setup) => {
      setup.oauth.usage = {
        five_hour: { utilization: 12, resets_at: "2026-10-09T15:00:00Z" },
        seven_day: { utilization: 48.5, resets_at: "2026-10-14T09:00:00Z" },
      };
      const finished = await signInThrough(setup, "/api/ai-accounts/oauth", {
        name: "Claude Max",
        aiProvider: "Claude",
        acceptedTerms: true,
      });
      expect(finished.statusCode).toBe(201);
      const added = aiAccountSchema.parse(finished.json());
      expect(added.usage).toEqual({
        fiveHour: { utilization: 12, resetsAt: "2026-10-09T15:00:00.000Z" },
        weekly: { utilization: 48.5, resetsAt: "2026-10-14T09:00:00.000Z" },
      });

      setup.oauth.usage = {
        five_hour: { utilization: 30, resets_at: "2026-10-09T15:00:00Z" },
        seven_day: { utilization: 50, resets_at: "2026-10-14T09:00:00Z" },
      };
      const refreshed = await post(
        setup,
        `/api/ai-accounts/${added.id}/refresh-usage`,
      );
      expect(refreshed.statusCode).toBe(200);
      expect(aiAccountSchema.parse(refreshed.json()).usage.fiveHour).toEqual({
        utilization: 30,
        resetsAt: "2026-10-09T15:00:00.000Z",
      });

      setup.oauth.usageFailWith = 500;
      const failed = await post(
        setup,
        `/api/ai-accounts/${added.id}/refresh-usage`,
      );
      expect(failed.statusCode).toBe(502);
      expect(apiErrorSchema.parse(failed.json()).message).toBe(
        "Its AI Provider did not say how much has been used.",
      );
      expect(
        (await post(setup, "/api/ai-accounts/nobody/refresh-usage")).statusCode,
      ).toBe(404);
      await expectNoSecrets(setup, [refreshed.body, failed.body]);
    },
  ],
];

describe("Claude subscriptions through the API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const bus = createEventBus({ store: memoryEventStore() });
      await run(await setUp(memoryAiAccountStore(), memoryStores(), bus));
    });
  }
});

describe("Claude subscriptions through the API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const bus = createEventBus({ store: databaseEventStore(database.db) });
      await run(
        await setUp(
          databaseAiAccountStore(database.db),
          databaseStores(database.db),
          bus,
        ),
      );
    });
  }
});
