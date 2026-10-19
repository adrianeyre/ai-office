import { aiAccounts } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { aiAccountErrorCodes } from "@ai-office/shared";
import { encryptorFromKey, type Encryptor } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
} from "../test-support.ts";
import {
  createAiAccounts,
  credentialContext,
  refreshTokenContext,
  type AiAccounts,
} from "./accounts.ts";
import { startFakeOAuthServer, type FakeOAuthServer } from "./fake-oauth.ts";
import { exchangeCode, OAuthError, pastedCode } from "./oauth.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountStore,
} from "./store.ts";

// Claude subscriptions (PRD FR-35, FR-36, §11): added through the OAuth
// login with PKCE against a fake OAuth server, their tokens sealed,
// refreshed ahead of expiry, their health told as it changes, a refused
// refresh asking the Owner to sign in again, and serving only Claude Code.
// Every case runs in memory and in Postgres 18.

const encryptor: Encryptor = encryptorFromKey(Buffer.alloc(32, 11));
const hour = 60 * 60 * 1000;
const minute = 60 * 1000;
const start = Date.UTC(2026, 9, 9, 12, 0, 0);

interface Setup {
  readonly accounts: AiAccounts;
  readonly store: AiAccountStore;
  readonly oauth: FakeOAuthServer;
  /** Sets the clock this far after the start. */
  readonly at: (ms: number) => void;
  readonly told: string[];
  events(): Promise<OfficeEvent[]>;
}

let oauth: FakeOAuthServer | undefined;

afterEach(async () => {
  await oauth?.close();
  oauth = undefined;
});

async function setUp(store: AiAccountStore, bus: EventBus): Promise<Setup> {
  oauth = await startFakeOAuthServer();
  let time = start;
  let id = 0;
  const told: string[] = [];
  return {
    accounts: createAiAccounts({
      store,
      encryptor,
      events: bus,
      oauth: oauth.provider,
      onCredential: (credential) => told.push(credential),
      now: () => new Date(time),
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    }),
    store,
    oauth,
    at: (ms) => {
      time = start + ms;
    },
    told,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

/** Adds a subscription through the whole login, as the Owner would. */
async function addSubscription(setup: Setup, name = "Claude Max") {
  const login = await setup.accounts.startLogin({
    name,
    aiProvider: "Claude",
    acceptedTerms: true,
  });
  const pasted = await setup.oauth.signIn(login.authorizeUrl);
  return setup.accounts.completeLogin(login.loginId, pasted);
}

const healthEvents = (events: OfficeEvent[]) =>
  events.flatMap((event) =>
    event.type === "ai_account.token_health"
      ? [
          {
            health: event.health,
            expiresAt: event.expiresAt,
            reauthenticationNeeded: event.reauthenticationNeeded,
          },
        ]
      : [],
  );

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds a subscription through the OAuth login with PKCE, its tokens sealed",
    async (setup) => {
      const login = await setup.accounts.startLogin({
        name: "Claude Max",
        aiProvider: "Claude",
        acceptedTerms: true,
      });
      const url = new URL(login.authorizeUrl);
      expect(url.origin + url.pathname).toBe(setup.oauth.provider.authorizeUrl);
      expect(url.searchParams.get("client_id")).toBe(
        setup.oauth.provider.clientId,
      );
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(url.searchParams.get("redirect_uri")).toBe(
        setup.oauth.provider.redirectUri,
      );
      expect(login.expiresAt).toEqual(new Date(start + 15 * minute));

      // The Owner signs in and pastes back what the page shows.
      const pasted = await setup.oauth.signIn(login.authorizeUrl);
      const { account, added } = await setup.accounts.completeLogin(
        login.loginId,
        pasted,
      );

      expect(added).toBe(true);
      expect(account).toMatchObject({
        name: "Claude Max",
        aiProvider: "Claude",
        accountType: "oauth",
        endpointUrl: null,
        priority: 1,
        tokenExpiresAt: new Date(start + 8 * hour),
        reauthenticationNeeded: false,
      });
      // The token request proved the login with its verifier (the fake
      // checks it hashes to the challenge), and named the code's state.
      const [exchange] = setup.oauth.tokenRequests;
      expect(exchange).toMatchObject({
        grant_type: "authorization_code",
        code: pastedCode(pasted).code,
        state: url.searchParams.get("state"),
        redirect_uri: setup.oauth.provider.redirectUri,
      });
      expect(exchange?.["code_verifier"]).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const [accessToken] = setup.oauth.accessTokens;
      const stored = await setup.store.get(account.id);
      expect(stored?.credential).toMatch(/^aio1:1:/);
      expect(stored?.refreshToken).toMatch(/^aio1:1:/);
      expect(JSON.stringify(stored)).not.toContain("sk-ant-");
      expect(
        encryptor.decrypt(
          stored?.credential ?? "",
          credentialContext(account.id),
        ),
      ).toBe(accessToken);
      const refreshToken = encryptor.decrypt(
        stored?.refreshToken ?? "",
        refreshTokenContext(account.id),
      );
      expect(setup.oauth.refreshTokenValid(refreshToken)).toBe(true);
      expect(JSON.stringify(account)).not.toContain("sk-ant-");
      expect(JSON.stringify(await setup.accounts.list())).not.toContain(
        "sk-ant-",
      );
      // Both tokens are registered for redaction.
      expect(setup.told).toEqual(
        expect.arrayContaining([accessToken, refreshToken]),
      );

      const events = await setup.events();
      expect(events.filter(({ type }) => type === "config.changed")).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["aiAccounts.added"],
        },
      ]);
      expect(healthEvents(events)).toEqual([
        {
          health: "valid",
          expiresAt: new Date(start + 8 * hour).toISOString(),
          reauthenticationNeeded: false,
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("sk-ant-");

      // A login is finished once.
      await expect(
        setup.accounts.completeLogin(login.loginId, pasted),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthLoginNotFound });
    },
  ],
  [
    "refuses a code without the login's verifier, another login's code, and a login left too long",
    async (setup) => {
      // Without the verifier the code was issued for, there are no tokens.
      const first = await setup.accounts.startLogin({
        name: "First",
        aiProvider: "Claude",
        acceptedTerms: true,
      });
      const pasted = await setup.oauth.signIn(first.authorizeUrl);
      const { code, state = "" } = pastedCode(pasted);
      await expect(
        exchangeCode(
          setup.oauth.provider,
          { code, state, verifier: "a".repeat(43) },
          { fetch, now: new Date() },
        ),
      ).rejects.toMatchObject({ name: "OAuthError", reason: "refused" });

      // Another login's code is refused before it is sent anywhere.
      const second = await setup.accounts.startLogin({
        name: "Second",
        aiProvider: "Claude",
        acceptedTerms: true,
      });
      const secondPasted = await setup.oauth.signIn(second.authorizeUrl);
      const requests = setup.oauth.tokenRequests.length;
      await expect(
        setup.accounts.completeLogin(first.loginId, secondPasted),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthCodeRefused });
      expect(setup.oauth.tokenRequests).toHaveLength(requests);

      // A login left longer than 15 minutes is gone.
      setup.at(16 * minute);
      await expect(
        setup.accounts.completeLogin(second.loginId, secondPasted),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthLoginNotFound });
      expect(await setup.accounts.list()).toEqual([]);
    },
  ],
  [
    "refreshes tokens ahead of expiry, once at a time",
    async (setup) => {
      const { account } = await addSubscription(setup);
      const [firstAccess] = setup.oauth.accessTokens;

      // Seven and a half hours in, the token has half an hour left.
      setup.at(7.5 * hour);
      expect(await setup.accounts.refreshTokens()).toEqual({
        refreshed: [],
        refused: [],
        failed: [],
      });
      expect(setup.oauth.tokenRequests).toHaveLength(1);

      // Within 15 minutes of expiry it is refreshed, and only once however
      // many rounds overlap: a refresh token is used once.
      setup.at(7.8 * hour);
      const reports = await Promise.all([
        setup.accounts.refreshTokens(),
        setup.accounts.refreshTokens(),
      ]);
      // The round that came second either waited for the first one's
      // refresh or found the token no longer due: either way, nothing failed.
      expect(reports.flatMap(({ refreshed }) => refreshed)).toContain(
        account.id,
      );
      expect(reports.flatMap(({ refused }) => refused)).toEqual([]);
      expect(reports.flatMap(({ failed }) => failed)).toEqual([]);
      const refreshes = setup.oauth.tokenRequests.filter(
        (request) => request["grant_type"] === "refresh_token",
      );
      expect(refreshes).toHaveLength(1);

      const [, secondAccess] = setup.oauth.accessTokens;
      const stored = await setup.store.get(account.id);
      expect(
        encryptor.decrypt(
          stored?.credential ?? "",
          credentialContext(account.id),
        ),
      ).toBe(secondAccess);
      expect(secondAccess).not.toBe(firstAccess);
      // The old refresh token is used up; the new one is kept.
      expect(
        setup.oauth.refreshTokenValid(refreshes[0]?.["refresh_token"] ?? ""),
      ).toBe(false);
      expect(
        setup.oauth.refreshTokenValid(
          encryptor.decrypt(
            stored?.refreshToken ?? "",
            refreshTokenContext(account.id),
          ),
        ),
      ).toBe(true);
      expect(stored?.tokenExpiresAt).toEqual(new Date(start + 15.8 * hour));

      // The Gateway serves Claude Code with the new token.
      expect(
        (await setup.accounts.select({ agentTool: "Claude Code" }))?.apiKey,
      ).toBe(secondAccess);
      expect(healthEvents(await setup.events())).toEqual([
        {
          health: "valid",
          expiresAt: new Date(start + 8 * hour).toISOString(),
          reauthenticationNeeded: false,
        },
        {
          health: "valid",
          expiresAt: new Date(start + 15.8 * hour).toISOString(),
          reauthenticationNeeded: false,
        },
      ]);
    },
  ],
  [
    "never refreshes with a refresh token another round has already used",
    async (setup) => {
      const { account } = await addSubscription(setup);
      setup.at(7.9 * hour);
      // A slow round read the accounts before the next round refreshed.
      const stale = await setup.store.list();
      expect((await setup.accounts.refreshTokens()).refreshed).toEqual([
        account.id,
      ]);
      const slow = createAiAccounts({
        store: { ...setup.store, list: () => Promise.resolve(stale) },
        encryptor,
        events: { publish: () => Promise.reject(new Error("unused")) },
        oauth: setup.oauth.provider,
        now: () => new Date(start + 7.9 * hour),
      });

      expect(await slow.refreshTokens()).toEqual({
        refreshed: [],
        refused: [],
        failed: [],
      });
      expect(
        setup.oauth.tokenRequests.filter(
          (request) => request["grant_type"] === "refresh_token",
        ),
      ).toHaveLength(1);
      expect((await setup.store.get(account.id))?.reauthenticationNeeded).toBe(
        false,
      );
    },
  ],
  [
    "tells the token is expiring, then expired, while the AI Provider cannot be reached, and stops serving from it",
    async (setup) => {
      const { account } = await addSubscription(setup);
      setup.oauth.failWith = 503;

      setup.at(7.9 * hour);
      const report = await setup.accounts.refreshTokens();
      expect(report.refreshed).toEqual([]);
      expect(report.refused).toEqual([]);
      expect(report.failed.map(({ id }) => id)).toEqual([account.id]);
      expect(report.failed[0]?.error).toBeInstanceOf(OAuthError);
      // It still serves until it expires.
      expect(
        await setup.accounts.select({ agentTool: "Claude Code" }),
      ).toBeDefined();

      setup.at(8 * hour);
      await setup.accounts.refreshTokens();
      expect(
        await setup.accounts.select({ agentTool: "Claude Code" }),
      ).toBeUndefined();
      expect(
        healthEvents(await setup.events()).map(({ health }) => health),
      ).toEqual(["valid", "expiring", "expired"]);

      // Once it answers again, the token is refreshed.
      setup.oauth.failWith = undefined;
      expect((await setup.accounts.refreshTokens()).refreshed).toEqual([
        account.id,
      ]);
      expect(
        await setup.accounts.select({ agentTool: "Claude Code" }),
      ).toBeDefined();
    },
  ],
  [
    "asks the Owner to sign in again when a refresh is refused, and signs in again",
    async (setup) => {
      const { account } = await addSubscription(setup);
      setup.oauth.refuseRefreshes = true;

      setup.at(7.9 * hour);
      expect(await setup.accounts.refreshTokens()).toEqual({
        refreshed: [],
        refused: [account.id],
        failed: [],
      });
      expect((await setup.store.get(account.id))?.reauthenticationNeeded).toBe(
        true,
      );
      // Refused once is enough: it is not asked again every round.
      const asked = setup.oauth.tokenRequests.length;
      await setup.accounts.refreshTokens();
      expect(setup.oauth.tokenRequests).toHaveLength(asked);
      expect(healthEvents(await setup.events()).at(-1)).toEqual({
        health: "expiring",
        expiresAt: new Date(start + 8 * hour).toISOString(),
        reauthenticationNeeded: true,
      });

      // Signing in again gives it new tokens; its name, priority and
      // requests stay.
      setup.oauth.refuseRefreshes = false;
      const login = await setup.accounts.startLogin({ accountId: account.id });
      const result = await setup.accounts.completeLogin(
        login.loginId,
        await setup.oauth.signIn(login.authorizeUrl),
      );
      expect(result.added).toBe(false);
      expect(result.account).toMatchObject({
        id: account.id,
        name: "Claude Max",
        reauthenticationNeeded: false,
        tokenExpiresAt: new Date(start + 15.9 * hour),
      });
      expect(await setup.accounts.list()).toHaveLength(1);
      const events = await setup.events();
      expect(healthEvents(events).at(-1)).toEqual({
        health: "valid",
        expiresAt: new Date(start + 15.9 * hour).toISOString(),
        reauthenticationNeeded: false,
      });
      expect(
        events.some(
          (event) =>
            event.type === "config.changed" &&
            event.keys.includes("aiAccounts.reauthenticated"),
        ),
      ).toBe(true);
    },
  ],
  [
    "signs in again only an OAuth account, and adds none under a name in use",
    async (setup) => {
      const key = await setup.accounts.add({
        name: "Work",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: "sk-ant-api03-workkey-0123456789abcdef",
      });
      await expect(
        setup.accounts.startLogin({ accountId: key.id }),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.notOAuthAccount });
      await expect(
        setup.accounts.startLogin({ accountId: "nobody" }),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.aiAccountNotFound });
      await expect(
        setup.accounts.startLogin({
          name: "Work",
          aiProvider: "Claude",
          acceptedTerms: true,
        }),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.aiAccountNameTaken });
    },
  ],
  [
    "serves only Claude Code from a subscription, with its token as a bearer token",
    async (setup) => {
      await addSubscription(setup);
      const [accessToken] = setup.oauth.accessTokens;
      expect(await setup.accounts.select({ agentTool: "Claude Code" })).toEqual(
        {
          id: expect.any(String) as string,
          name: "Claude Max",
          apiKey: accessToken,
          baseUrl: "https://api.anthropic.com",
          apiFormat: "anthropic",
          apiPath: "/v1",
          authorization: "bearer",
          betas: ["oauth-2025-04-20"],
        },
      );
      for (const agentTool of [null, "Codex", "opencode"] as const) {
        expect(await setup.accounts.select({ agentTool })).toBeUndefined();
      }
      // An API key serves everyone; the subscription still only Claude Code.
      await setup.accounts.add({
        name: "Work",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: "sk-ant-api03-workkey-0123456789abcdef",
      });
      expect((await setup.accounts.select({ agentTool: null }))?.name).toBe(
        "Work",
      );
      expect(
        (await setup.accounts.select({ agentTool: "Claude Code" }))?.name,
      ).toBe("Claude Max");
    },
  ],
  [
    "reads a subscription's usage windows from its usage endpoint, before any request",
    async (setup) => {
      const { account } = await addSubscription(setup);
      const key = await setup.accounts.add({
        name: "Work",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: "sk-ant-api03-workkey-0123456789abcdef",
      });
      setup.oauth.usage = {
        five_hour: { utilization: 23.4, resets_at: "2026-10-09T15:00:00Z" },
        seven_day: { utilization: 61, resets_at: "2026-10-14T09:00:00Z" },
      };

      const report = await setup.accounts.refreshUsage();
      expect(report).toEqual({ refreshed: [account.id], failed: [] });
      // With the subscription's own token and beta flags; never the key's.
      expect(setup.oauth.usageRequests).toEqual([
        { token: setup.oauth.accessTokens[0], beta: "oauth-2025-04-20" },
      ]);
      const [listed] = (await setup.accounts.list()).filter(
        ({ id }) => id === account.id,
      );
      expect(listed).toMatchObject({
        fiveHourUtilization: 23.4,
        fiveHourResetsAt: new Date("2026-10-09T15:00:00Z"),
        weeklyUtilization: 61,
        weeklyResetsAt: new Date("2026-10-14T09:00:00Z"),
      });
      expect(
        await setup.accounts.usageHistory(account.id, {
          since: new Date(0),
          limit: 10,
        }),
      ).toHaveLength(2);

      // One account only, when asked; an API key has nothing to read.
      expect(await setup.accounts.refreshUsage(key.id)).toEqual({
        refreshed: [],
        failed: [],
      });
      await expect(setup.accounts.refreshUsage("nobody")).rejects.toMatchObject(
        { code: aiAccountErrorCodes.aiAccountNotFound },
      );

      // A failing endpoint is reported, and what was read is kept.
      setup.oauth.usageFailWith = 503;
      const failed = await setup.accounts.refreshUsage(account.id);
      expect(failed.refreshed).toEqual([]);
      expect(failed.failed.map(({ id }) => id)).toEqual([account.id]);
      expect(String(failed.failed[0]?.error)).toContain("503");
      expect(
        (await setup.accounts.list()).find(({ id }) => id === account.id)
          ?.fiveHourUtilization,
      ).toBe(23.4);
    },
  ],
  [
    "keeps a five-hour window no request has started as one that reset, once",
    async (setup) => {
      const { account } = await addSubscription(setup);
      const listed = async () =>
        (await setup.accounts.list()).find(({ id }) => id === account.id);
      const history = async () =>
        setup.accounts.usageHistory(account.id, {
          since: new Date(0),
          limit: 10,
        });
      // What Claude's usage endpoint answers while no window is running.
      setup.oauth.usage = {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 3, resets_at: "2026-10-14T09:00:00Z" },
      };

      setup.at(minute);
      await setup.accounts.refreshUsage();
      expect(await listed()).toMatchObject({
        fiveHourUtilization: 0,
        fiveHourResetsAt: new Date(start + minute),
        weeklyUtilization: 3,
      });
      expect(await history()).toHaveLength(2);

      // Read again, it has nothing new to keep.
      setup.at(6 * minute);
      await setup.accounts.refreshUsage();
      expect((await listed())?.fiveHourResetsAt).toEqual(
        new Date(start + minute),
      );
      expect(await history()).toHaveLength(2);

      // A running window that the endpoint says has ended is over now.
      setup.oauth.usage = {
        five_hour: { utilization: 40, resets_at: "2026-10-09T15:00:00Z" },
      };
      await setup.accounts.refreshUsage();
      setup.oauth.usage = { five_hour: { utilization: 0, resets_at: null } };
      setup.at(11 * minute);
      await setup.accounts.refreshUsage();
      expect(await listed()).toMatchObject({
        fiveHourUtilization: 0,
        fiveHourResetsAt: new Date(start + 11 * minute),
      });
    },
  ],
  [
    "refreshes an expiring token before reading usage, and skips one to sign in again",
    async (setup) => {
      const { account } = await addSubscription(setup);
      setup.oauth.usage = {
        five_hour: { utilization: 5, resets_at: "2026-10-09T15:00:00Z" },
      };
      // Close to expiry: refreshed first, and the new token used.
      setup.at(7.9 * hour);
      expect(await setup.accounts.refreshUsage()).toEqual({
        refreshed: [account.id],
        failed: [],
      });
      expect(setup.oauth.accessTokens).toHaveLength(2);
      expect(setup.oauth.usageRequests.map(({ token }) => token)).toEqual([
        setup.oauth.accessTokens[1],
      ]);

      // Refused a refresh: it must sign in again, so it is not read.
      setup.oauth.refuseRefreshes = true;
      setup.at(15.9 * hour);
      const report = await setup.accounts.refreshUsage();
      expect(report.refreshed).toEqual([]);
      expect(report.failed.map(({ id }) => id)).toEqual([account.id]);
      expect(await setup.accounts.refreshUsage()).toEqual({
        refreshed: [],
        failed: [],
      });
      expect(setup.oauth.usageRequests).toHaveLength(1);
    },
  ],
];

describe("Claude subscriptions, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryAiAccountStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("Claude subscriptions, kept in Postgres 18", () => {
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

  postgresTest(
    "refuses an OAuth account without its sealed refresh token and expiry",
    async ({ database }) => {
      const row = {
        name: "Claude Max",
        accountType: "oauth",
        aiProvider: "Claude",
        credential: "aio1:1:a:b:c",
        priority: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await expect(
        database.db.insert(aiAccounts).values({ ...row, id: "a" }),
      ).rejects.toMatchObject({
        cause: { constraint: "ai_accounts_oauth_login" },
      });
      await expect(
        database.db.insert(aiAccounts).values({
          ...row,
          id: "b",
          refreshToken: "sk-ant-ort01-in-clear",
          tokenExpiresAt: new Date(),
        }),
      ).rejects.toMatchObject({
        cause: { constraint: "ai_accounts_refresh_token_sealed" },
      });
    },
  );
});

describe("a subscription behind the Gateway", () => {
  let upstream: FakeUpstream | undefined;

  afterEach(async () => {
    await upstream?.close();
  });

  it("serves Claude Code's requests with the subscription's token, and no one else's", async () => {
    const setup = await setUp(
      memoryAiAccountStore(),
      createEventBus({ store: memoryEventStore() }),
    );
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 3 }));
    });
    const fakeUpstream = upstream;
    const { account } = await addSubscription(setup);
    // The fake AI Provider stands in for api.anthropic.com.
    const accounts: AiAccounts = {
      ...setup.accounts,
      select: async (request) => {
        const selected = await setup.accounts.select(request);
        return selected && { ...selected, baseUrl: fakeUpstream.url };
      },
    };
    const requestLog = memoryRequestLog();
    const gateway = await startGateway({ accounts, requestLog });
    const send = (userAgent: string, path = "/v1/messages/count_tokens") =>
      fetch(`${gateway.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "claude-code-20250219",
          "user-agent": userAgent,
          authorization: `Bearer ${gatewayKey}`,
        },
        body: JSON.stringify({
          model: "claude-haiku-5-5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
    try {
      expect((await send("claude-cli/2.1.3 (external, cli)")).status).toBe(200);
      const [received] = fakeUpstream.received;
      expect(received?.headers.authorization).toBe(
        `Bearer ${setup.oauth.accessTokens[0] ?? ""}`,
      );
      expect(received?.headers["x-api-key"]).toBeUndefined();
      expect(received?.headers["anthropic-beta"]).toBe(
        "claude-code-20250219,oauth-2025-04-20",
      );

      // Another tool, or one pretending in a translated request, gets
      // nothing from it.
      expect((await send("codex_cli_rs/0.50.0")).status).toBe(503);
      expect(
        (await send("claude-cli/2.1.3 (external, cli)", "/v1/chat/completions"))
          .status,
      ).toBe(503);
      expect(fakeUpstream.received).toHaveLength(1);
      expect(requestLog.records[0]?.accountId).toBe(account.id);
    } finally {
      await gateway.close();
    }
  });
});
