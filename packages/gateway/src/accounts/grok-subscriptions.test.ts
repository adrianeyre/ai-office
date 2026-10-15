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
  type RunningGateway,
} from "../test-support.ts";
import {
  createAiAccounts,
  credentialContext,
  refreshTokenContext,
  type AiAccounts,
} from "./accounts.ts";
import { startFakeOAuthServer, type FakeOAuthServer } from "./fake-oauth.ts";
import { tokensInLoginFile } from "./oauth.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountStore,
} from "./store.ts";

// Grok subscriptions (PRD FR-35, FR-36, §11): added through xAI's device
// login (the Owner approves a code on xAI's page) against a fake OAuth
// server shaped like xAI's, or imported from an existing Grok CLI login;
// their tokens sealed and refreshed; serving only opencode, untranslated,
// as a bearer token to xAI's API. Every case runs in memory and in
// Postgres 18.

const encryptor: Encryptor = encryptorFromKey(Buffer.alloc(32, 47));
const hour = 60 * 60 * 1000;
const minute = 60 * 1000;
const start = Date.UTC(2026, 9, 9, 12, 0, 0);

interface Setup {
  readonly accounts: AiAccounts;
  readonly store: AiAccountStore;
  readonly oauth: FakeOAuthServer;
  readonly at: (ms: number) => void;
  events(): Promise<OfficeEvent[]>;
}

let oauth: FakeOAuthServer | undefined;

afterEach(async () => {
  await oauth?.close();
  oauth = undefined;
});

async function setUp(store: AiAccountStore, bus: EventBus): Promise<Setup> {
  oauth = await startFakeOAuthServer({ device: true });
  let time = start;
  let id = 0;
  return {
    accounts: createAiAccounts({
      store,
      encryptor,
      events: bus,
      oauthProviders: { Grok: oauth.provider },
      now: () => new Date(time),
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    }),
    store,
    oauth,
    at: (ms) => {
      time = start + ms;
    },
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const grok = {
  name: "SuperGrok",
  aiProvider: "Grok",
  acceptedTerms: true,
} as const;

/** A Grok CLI login file holding `tokens`, nested as a CLI might keep it. */
const loginFile = (
  tokens: { access_token: string; refresh_token: string },
  expiresAt: unknown,
) =>
  JSON.stringify({
    version: 1,
    auth: {
      provider: "xai",
      tokens: { ...tokens, expires_at: expiresAt, id_token: "not-kept" },
    },
  });

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds a subscription through xAI's device login, once the Owner approves its code",
    async (setup) => {
      const login = await setup.accounts.startLogin(grok);
      expect(login.userCode).toBe("ABCD-0001");
      expect(login.authorizeUrl).toMatch(/\/device\?user_code=ABCD-0001$/);
      // The device code lasts 10 minutes, less than a login's 15.
      expect(login.expiresAt).toEqual(new Date(start + 10 * minute));

      // Not approved yet: it can be finished later.
      await expect(
        setup.accounts.completeLogin(login.loginId, undefined),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthLoginPending });

      setup.oauth.approve("ABCD-0001");
      const { account, added } = await setup.accounts.completeLogin(
        login.loginId,
        undefined,
      );
      expect(added).toBe(true);
      expect(account).toMatchObject({
        name: "SuperGrok",
        aiProvider: "Grok",
        accountType: "oauth",
        tokenExpiresAt: new Date(start + 8 * hour),
      });
      // Its tokens are sealed for its own row, and never handed back.
      const [accessToken] = setup.oauth.accessTokens;
      const stored = await setup.store.get(account.id);
      expect(stored?.credential).toMatch(/^aio1:/);
      expect(
        encryptor.decrypt(
          stored?.credential ?? "",
          credentialContext(account.id),
        ),
      ).toBe(accessToken);
      expect(stored?.refreshToken).toMatch(/^aio1:/);
      expect(JSON.stringify(account)).not.toContain(accessToken);
      // xAI's token endpoint takes forms; the device grant, its client.
      expect(setup.oauth.tokenRequests.at(-1)).toMatchObject({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: setup.oauth.provider.clientId,
      });
      // A login is used once.
      await expect(
        setup.accounts.completeLogin(login.loginId, undefined),
      ).rejects.toMatchObject({
        code: aiAccountErrorCodes.oauthLoginNotFound,
      });
    },
  ],
  [
    "refuses a device login the Owner denied",
    async (setup) => {
      const login = await setup.accounts.startLogin(grok);
      setup.oauth.approve(login.userCode ?? "", false);
      await expect(
        setup.accounts.completeLogin(login.loginId, undefined),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.oauthCodeRefused });
      expect(await setup.accounts.list()).toEqual([]);
    },
  ],
  [
    "serves only opencode, untranslated, with its token as a bearer token to xAI's API",
    async (setup) => {
      const login = await setup.accounts.startLogin(grok);
      setup.oauth.approve(login.userCode ?? "");
      await setup.accounts.completeLogin(login.loginId, undefined);
      const [accessToken] = setup.oauth.accessTokens;
      expect(
        await setup.accounts.select({ agentTool: "opencode", model: "grok-4" }),
      ).toEqual({
        id: expect.any(String) as string,
        name: "SuperGrok",
        apiKey: accessToken,
        baseUrl: "https://api.x.ai",
        apiFormat: "openai",
        apiPath: "/v1",
        authorization: "bearer",
        betas: [],
      });
      for (const agentTool of [null, "Claude Code", "Codex"] as const) {
        expect(
          await setup.accounts.select({ agentTool, model: "grok-4" }),
        ).toBeUndefined();
      }
      // Nor a Claude Model, from opencode or anyone.
      expect(
        await setup.accounts.select({
          agentTool: "opencode",
          model: "claude-sonnet-5-5",
        }),
      ).toBeUndefined();
      // Once its token has expired, it serves no one.
      setup.at(8 * hour);
      expect(
        await setup.accounts.select({ agentTool: "opencode", model: "grok-4" }),
      ).toBeUndefined();
    },
  ],
  [
    "refreshes its tokens ahead of expiry at xAI's token endpoint",
    async (setup) => {
      setup.oauth.expiresIn = 6 * 60 * 60;
      const login = await setup.accounts.startLogin(grok);
      setup.oauth.approve(login.userCode ?? "");
      const { account } = await setup.accounts.completeLogin(
        login.loginId,
        undefined,
      );
      setup.at(6 * hour - 10 * minute);
      expect(await setup.accounts.refreshTokens()).toMatchObject({
        refreshed: [account.id],
      });
      expect(setup.oauth.tokenRequests.at(-1)).toMatchObject({
        grant_type: "refresh_token",
        client_id: setup.oauth.provider.clientId,
      });
      expect((await setup.accounts.list())[0]?.tokenExpiresAt).toEqual(
        new Date(start + 12 * hour - 10 * minute),
      );
    },
  ],
  [
    "imports an existing Grok CLI login, refreshed like any other",
    async (setup) => {
      const issued = setup.oauth.issue();
      const expiresAt = new Date(start + 5 * hour).toISOString();
      const account = await setup.accounts.importLogin({
        ...grok,
        name: "Grok CLI",
        login: loginFile(issued, expiresAt),
      });
      expect(account).toMatchObject({
        name: "Grok CLI",
        aiProvider: "Grok",
        accountType: "oauth",
        tokenExpiresAt: new Date(expiresAt),
      });
      const stored = await setup.store.get(account.id);
      expect(
        encryptor.decrypt(
          stored?.credential ?? "",
          credentialContext(account.id),
        ),
      ).toBe(issued.access_token);
      expect(
        encryptor.decrypt(
          stored?.refreshToken ?? "",
          refreshTokenContext(account.id),
        ),
      ).toBe(issued.refresh_token);
      expect(JSON.stringify(account)).not.toContain(issued.access_token);
      expect(
        (await setup.events()).filter(({ type }) => type === "config.changed"),
      ).toEqual([expect.objectContaining({ keys: ["aiAccounts.imported"] })]);

      // Its refresh token works, and is used up as the CLI's own was.
      setup.at(5 * hour - 5 * minute);
      expect(await setup.accounts.refreshTokens()).toMatchObject({
        refreshed: [account.id],
      });
      expect(setup.oauth.refreshTokenValid(issued.refresh_token)).toBe(false);
    },
  ],
  [
    "refuses a login file without tokens, and a name in use",
    async (setup) => {
      for (const login of [
        "not json",
        JSON.stringify({ access_token: "only-an-access-token" }),
        JSON.stringify({ api_key: "xai-something" }),
      ]) {
        await expect(
          setup.accounts.importLogin({ ...grok, login }),
        ).rejects.toMatchObject({
          code: aiAccountErrorCodes.loginNotImportable,
        });
      }
      const issued = setup.oauth.issue();
      await setup.accounts.importLogin({
        ...grok,
        login: loginFile(issued, null),
      });
      await expect(
        setup.accounts.importLogin({
          ...grok,
          login: loginFile(setup.oauth.issue(), null),
        }),
      ).rejects.toMatchObject({ code: aiAccountErrorCodes.aiAccountNameTaken });
    },
  ],
];

describe("Grok subscriptions, kept in memory", () => {
  it.each(cases)("%s", async (_name, run) => {
    await run(
      await setUp(
        memoryAiAccountStore(),
        createEventBus({ store: memoryEventStore() }),
      ),
    );
  });
});

describe("Grok subscriptions, in Postgres 18", () => {
  postgresTest.for(cases)("%s", async ([, run], { database }) => {
    await run(
      await setUp(
        databaseAiAccountStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      ),
    );
  });
});

describe("a Grok CLI login file", () => {
  const now = new Date(start);

  it("gives its tokens and expiry, at any depth and in either spelling", () => {
    expect(
      tokensInLoginFile(
        JSON.stringify({
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: 1_791_561_600_000,
        }),
        now,
      ),
    ).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(1_791_561_600_000),
    });
    expect(
      tokensInLoginFile(
        loginFile({ access_token: "a", refresh_token: "r" }, 1_791_561_600),
        now,
      )?.expiresAt,
    ).toEqual(new Date(1_791_561_600_000));
  });

  it("takes the access token's own expiry when the file has none", () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: 1_791_561_600 }),
    ).toString("base64url");
    expect(
      tokensInLoginFile(
        JSON.stringify({
          access_token: `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`,
          refresh_token: "refresh",
        }),
        now,
      )?.expiresAt,
    ).toEqual(new Date(1_791_561_600_000));
  });

  it("takes it as expiring now when nothing says, so it is refreshed at once", () => {
    expect(
      tokensInLoginFile(
        JSON.stringify({ access_token: "opaque", refresh_token: "refresh" }),
        now,
      )?.expiresAt,
    ).toEqual(now);
  });
});

describe("a Grok subscription through the Gateway", () => {
  let gateway: RunningGateway | undefined;
  let upstream: FakeUpstream | undefined;

  afterEach(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  it("serves opencode's Chat Completions as they are, and refuses Claude Code", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        '{"id":"c1","object":"chat.completion","created":1,"model":"grok-4","choices":[{"index":0,"message":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      );
    });
    const store = memoryAiAccountStore();
    const setup = await setUp(
      store,
      createEventBus({ store: memoryEventStore() }),
    );
    const issued = setup.oauth.issue();
    const account = await setup.accounts.importLogin({
      ...grok,
      login: loginFile(issued, new Date(Date.now() + hour).toISOString()),
    });
    // Pointed at the fake xAI, as a custom endpoint would be.
    const row = store.accounts.get(account.id);
    if (row === undefined) {
      throw new Error("The imported account is not stored.");
    }
    store.accounts.set(account.id, { ...row, endpointUrl: upstream.url });
    const accounts = createAiAccounts({
      store: setup.store,
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      oauthProviders: { Grok: setup.oauth.provider },
    });
    gateway = await startGateway({
      accounts,
      requestLog: memoryRequestLog(),
    });
    const body = JSON.stringify({
      model: "grok-4",
      messages: [{ role: "user", content: "Hi" }],
    });
    const fromOpencode = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "opencode/0.15.2 ai-sdk/provider-utils/3.0.0",
        authorization: `Bearer ${gatewayKey}`,
      },
      body,
    });
    expect(fromOpencode.status).toBe(200);
    await fromOpencode.text();
    expect(upstream.received[0]?.url).toBe("/v1/chat/completions");
    expect(upstream.received[0]?.body).toBe(body);
    expect(upstream.received[0]?.headers.authorization).toBe(
      `Bearer ${issued.access_token}`,
    );

    const fromClaudeCode = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.0 (external, cli)",
        "x-api-key": gatewayKey,
      },
      body: JSON.stringify({
        model: "grok-4",
        max_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(fromClaudeCode.status).toBe(503);
    await fromClaudeCode.text();
    expect(upstream.received).toHaveLength(1);
  });
});
