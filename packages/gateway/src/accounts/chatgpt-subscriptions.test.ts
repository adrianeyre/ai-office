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

import {
  createAiAccounts,
  credentialContext,
  refreshTokenContext,
  type AiAccounts,
} from "./accounts.ts";
import {
  fakeChatgptAccountId,
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "./fake-oauth.ts";
import {
  authorizationUrl,
  chatgptAccountIdOf,
  openaiOAuth,
  pastedCode,
} from "./oauth.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountStore,
} from "./store.ts";

// ChatGPT subscriptions (PRD FR-35, FR-36, §11): added through OpenAI's
// OAuth login with PKCE, as Codex signs in, against a fake OAuth server
// shaped like OpenAI's (the sign-in ends on Codex's local callback, whose
// address the Owner pastes back); their tokens sealed, their expiry read
// from the access token, refreshed ahead of expiry, a refused refresh
// asking the Owner to sign in again; serving only Codex's Responses,
// natively, at ChatGPT's Codex backend. Every case runs in memory and in
// Postgres 18.

const encryptor: Encryptor = encryptorFromKey(Buffer.alloc(32, 53));
const hour = 60 * 60 * 1000;
const minute = 60 * 1000;
const start = Date.UTC(2026, 9, 9, 12, 0, 0);

interface Setup {
  readonly accounts: AiAccounts;
  readonly store: AiAccountStore;
  readonly oauth: FakeOAuthServer;
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
  oauth = await startFakeOAuthServer({ openai: true });
  let time = start;
  let id = 0;
  // The fake's tokens expire by the test's clock.
  oauth.now = () => new Date(time);
  const told: string[] = [];
  return {
    accounts: createAiAccounts({
      store,
      encryptor,
      events: bus,
      oauthProviders: { ChatGPT: oauth.provider },
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

const chatgpt = {
  name: "ChatGPT Plus",
  aiProvider: "ChatGPT",
  acceptedTerms: true,
} as const;

/** Adds a subscription through the whole login, as the Owner would. */
async function addSubscription(setup: Setup) {
  const login = await setup.accounts.startLogin(chatgpt);
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

/** Codex's Responses request, as the Gateway describes it to the accounts. */
const fromCodex = {
  agentTool: "Codex",
  model: "gpt-5-codex",
  endpoint: "responses",
} as const;

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "finishes a sign-in from its callback, by its state, and tells the page it is done",
    async (setup) => {
      const login = await setup.accounts.startLogin(chatgpt);
      expect(login.redirectUri).toBe("http://localhost:1455/auth/callback");
      expect(
        setup.accounts.awaitingCallback("http://localhost:1455/auth/callback"),
      ).toBe(true);
      expect(await setup.accounts.loginStatus(login.loginId)).toEqual({
        status: "pending",
      });
      const callback = await setup.oauth.signIn(login.authorizeUrl);
      const { account, added } =
        await setup.accounts.completeCallback(callback);
      expect(added).toBe(true);
      expect(account).toMatchObject({ name: "ChatGPT Plus" });
      expect(await setup.accounts.loginStatus(login.loginId)).toEqual({
        status: "done",
        account,
        added: true,
      });
      expect(
        setup.accounts.awaitingCallback("http://localhost:1455/auth/callback"),
      ).toBe(false);
      // A callback with no sign-in waiting for its state finishes nothing.
      await expect(
        setup.accounts.completeCallback(callback),
      ).rejects.toMatchObject({ code: "oauth_login_not_found" });
      await expect(
        setup.accounts.completeCallback(
          "http://localhost:1455/auth/callback?code=ac_1&state=someone-else",
        ),
      ).rejects.toMatchObject({ code: "oauth_login_not_found" });
    },
  ],
  [
    "adds a subscription through OpenAI's OAuth login, pasting back the address it ends on",
    async (setup) => {
      const login = await setup.accounts.startLogin(chatgpt);
      const url = new URL(login.authorizeUrl);
      expect(url.origin + url.pathname).toBe(setup.oauth.provider.authorizeUrl);
      expect(url.searchParams.get("client_id")).toBe(
        setup.oauth.provider.clientId,
      );
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://localhost:1455/auth/callback",
      );
      expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
      // Claude's "show the code" flag is Claude's alone.
      expect(url.searchParams.get("code")).toBeNull();
      expect(login.userCode).toBeUndefined();
      expect(login.expiresAt).toEqual(new Date(start + 15 * minute));

      // The browser lands on Codex's callback, which does not load: the
      // Owner pastes its address.
      const pasted = await setup.oauth.signIn(login.authorizeUrl);
      expect(pasted).toMatch(/^http:\/\/localhost:1455\/auth\/callback\?code=/);
      const { account, added } = await setup.accounts.completeLogin(
        login.loginId,
        pasted,
      );
      expect(added).toBe(true);
      expect(account).toMatchObject({
        name: "ChatGPT Plus",
        aiProvider: "ChatGPT",
        accountType: "oauth",
        endpointUrl: null,
        // OpenAI gives no `expires_in`: the access token's own `exp`.
        tokenExpiresAt: new Date(start + 8 * hour),
        reauthenticationNeeded: false,
      });
      // A form, proving the login with its verifier, without the state.
      const [exchange] = setup.oauth.tokenRequests;
      expect(exchange).toMatchObject({
        grant_type: "authorization_code",
        code: pastedCode(pasted).code,
        redirect_uri: "http://localhost:1455/auth/callback",
        client_id: setup.oauth.provider.clientId,
      });
      expect(exchange?.["state"]).toBeUndefined();
      expect(exchange?.["code_verifier"]).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Its tokens are sealed for its own row, told to the redactor, and
      // never handed back.
      const [accessToken = ""] = setup.oauth.accessTokens;
      const stored = await setup.store.get(account.id);
      expect(stored?.credential).toMatch(/^aio1:/);
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
      expect(setup.told).toEqual(
        expect.arrayContaining([accessToken, refreshToken]),
      );
      const events = await setup.events();
      for (const shown of [account, await setup.accounts.list(), events]) {
        expect(JSON.stringify(shown)).not.toContain(accessToken);
        expect(JSON.stringify(shown)).not.toContain(refreshToken);
      }
      expect(events.filter(({ type }) => type === "config.changed")).toEqual([
        expect.objectContaining({ keys: ["aiAccounts.added"] }),
      ]);
      expect(healthEvents(events)).toEqual([
        {
          health: "valid",
          expiresAt: new Date(start + 8 * hour).toISOString(),
          reauthenticationNeeded: false,
        },
      ]);

      // A login is finished once.
      await expect(
        setup.accounts.completeLogin(login.loginId, pasted),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthLoginNotFound });
    },
  ],
  [
    "refuses another login's address, and one that ended without a code",
    async (setup) => {
      const first = await setup.accounts.startLogin(chatgpt);
      const second = await setup.accounts.startLogin({
        ...chatgpt,
        name: "ChatGPT Pro",
      });
      const secondPasted = await setup.oauth.signIn(second.authorizeUrl);
      await expect(
        setup.accounts.completeLogin(first.loginId, secondPasted),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthCodeRefused });
      await expect(
        setup.accounts.completeLogin(
          first.loginId,
          "http://localhost:1455/auth/callback?error=access_denied&state=x",
        ),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthCodeRefused });
      // Neither reached OpenAI's token endpoint.
      expect(setup.oauth.tokenRequests).toEqual([]);
      expect(await setup.accounts.list()).toEqual([]);
    },
  ],
  [
    "serves only Codex's Responses, natively, at ChatGPT's Codex backend with its ChatGPT account",
    async (setup) => {
      await addSubscription(setup);
      const [accessToken] = setup.oauth.accessTokens;
      expect(await setup.accounts.select(fromCodex)).toEqual({
        id: expect.any(String) as string,
        name: "ChatGPT Plus",
        apiKey: accessToken,
        baseUrl: "https://chatgpt.com",
        apiFormat: "openai",
        apiPath: "/backend-api/codex",
        authorization: "bearer",
        betas: [],
        headers: { "chatgpt-account-id": fakeChatgptAccountId },
      });
      expect(
        await setup.accounts.select({
          ...fromCodex,
          endpoint: "responses_compact",
        }),
      ).toMatchObject({ name: "ChatGPT Plus" });
      // Not another tool's, nor no tool's.
      for (const agentTool of [null, "Claude Code", "opencode"] as const) {
        expect(
          await setup.accounts.select({ ...fromCodex, agentTool }),
        ).toBeUndefined();
      }
      // Not Chat Completions, nor a request translated from Messages.
      for (const endpoint of ["chat_completions", "messages"] as const) {
        expect(
          await setup.accounts.select({ ...fromCodex, endpoint }),
        ).toBeUndefined();
      }
      // Not another AI Provider's Model.
      expect(
        await setup.accounts.select({ ...fromCodex, model: "grok-4" }),
      ).toBeUndefined();
      // Once its token has expired, no one.
      setup.at(8 * hour);
      expect(await setup.accounts.select(fromCodex)).toBeUndefined();
    },
  ],
  [
    "refreshes its tokens ahead of expiry at OpenAI's token endpoint, the refresh token rotating",
    async (setup) => {
      const { account } = await addSubscription(setup);
      setup.at(8 * hour - 10 * minute);
      expect(await setup.accounts.refreshTokens()).toMatchObject({
        refreshed: [account.id],
      });
      const refresh = setup.oauth.tokenRequests.at(-1);
      expect(refresh).toMatchObject({
        grant_type: "refresh_token",
        client_id: setup.oauth.provider.clientId,
      });
      // Used up, and the new one kept.
      expect(
        setup.oauth.refreshTokenValid(refresh?.["refresh_token"] ?? ""),
      ).toBe(false);
      const stored = await setup.store.get(account.id);
      expect(
        setup.oauth.refreshTokenValid(
          encryptor.decrypt(
            stored?.refreshToken ?? "",
            refreshTokenContext(account.id),
          ),
        ),
      ).toBe(true);
      // The new token's own expiry, eight hours from the refresh.
      expect(stored?.tokenExpiresAt).toEqual(
        new Date(start + 16 * hour - 10 * minute),
      );
      expect((await setup.accounts.select(fromCodex))?.apiKey).toBe(
        setup.oauth.accessTokens.at(-1),
      );
      expect(
        healthEvents(await setup.events()).map(({ health }) => health),
      ).toEqual(["valid", "valid"]);
    },
  ],
  [
    "asks the Owner to sign in again when OpenAI refuses a refresh, and signing in again clears it",
    async (setup) => {
      const { account } = await addSubscription(setup);
      setup.oauth.refuseRefreshes = true;
      setup.at(8 * hour - 10 * minute);
      expect(await setup.accounts.refreshTokens()).toMatchObject({
        refused: [account.id],
      });
      expect((await setup.accounts.list())[0]?.reauthenticationNeeded).toBe(
        true,
      );
      // It serves until its token expires, and is not refreshed again.
      expect(await setup.accounts.select(fromCodex)).toBeDefined();
      const requests = setup.oauth.tokenRequests.length;
      await setup.accounts.refreshTokens();
      expect(setup.oauth.tokenRequests).toHaveLength(requests);

      setup.oauth.refuseRefreshes = false;
      const login = await setup.accounts.startLogin({ accountId: account.id });
      const { account: again, added } = await setup.accounts.completeLogin(
        login.loginId,
        await setup.oauth.signIn(login.authorizeUrl),
      );
      expect(added).toBe(false);
      expect(again).toMatchObject({
        id: account.id,
        reauthenticationNeeded: false,
        tokenExpiresAt: new Date(start + 16 * hour - 10 * minute),
      });
      const events = await setup.events();
      expect(healthEvents(events)).toEqual([
        expect.objectContaining({ reauthenticationNeeded: false }),
        expect.objectContaining({
          health: "expiring",
          reauthenticationNeeded: true,
        }),
        expect.objectContaining({
          health: "valid",
          reauthenticationNeeded: false,
        }),
      ]);
      expect(
        events.filter(({ type }) => type === "config.changed").at(-1),
      ).toMatchObject({ keys: ["aiAccounts.reauthenticated"] });
    },
  ],
];

describe("ChatGPT subscriptions, kept in memory", () => {
  it.each(cases)("%s", async (_name, run) => {
    await run(
      await setUp(
        memoryAiAccountStore(),
        createEventBus({ store: memoryEventStore() }),
      ),
    );
  });
});

describe("ChatGPT subscriptions, in Postgres 18", () => {
  postgresTest.for(cases)("%s", async ([, run], { database }) => {
    await run(
      await setUp(
        databaseAiAccountStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      ),
    );
  });
});

describe("OpenAI's sign-in, as Codex signs in", () => {
  it("asks for Codex's client, callback and scopes", () => {
    const url = new URL(
      authorizationUrl(openaiOAuth, { challenge: "c".repeat(43), state: "s" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://auth.openai.com/oauth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      response_type: "code",
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      state: "s",
    });
  });

  it("takes the code and state from a pasted address, or Claude's code#state", () => {
    expect(
      pastedCode(
        " http://localhost:1455/auth/callback?code=ac_123&scope=openid&state=abc ",
      ),
    ).toEqual({ code: "ac_123", state: "abc" });
    expect(
      pastedCode("http://localhost:1455/auth/callback?error=access_denied"),
    ).toEqual({ code: "" });
    expect(pastedCode("abc#def")).toEqual({ code: "abc", state: "def" });
    expect(pastedCode("abc")).toEqual({ code: "abc" });
  });

  it("reads the ChatGPT account from the access token, and nothing from another token", () => {
    const token = (claims: unknown) =>
      `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    expect(
      chatgptAccountIdOf(
        token({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-42" },
        }),
      ),
    ).toBe("acct-42");
    expect(chatgptAccountIdOf(token({ sub: "user" }))).toBeUndefined();
    expect(
      chatgptAccountIdOf(
        token({
          "https://api.openai.com/auth": { chatgpt_account_id: "a\r\nb" },
        }),
      ),
    ).toBeUndefined();
    expect(chatgptAccountIdOf("sk-not-a-jwt")).toBeUndefined();
  });
});
