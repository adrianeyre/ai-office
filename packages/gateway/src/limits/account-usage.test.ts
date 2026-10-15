import { createEventBus, memoryEventStore } from "@ai-office/events";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import { createAiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";

// What an AI Account shows of its usage beyond a subscription's windows
// (FR-36): an API key's per-minute rate limits, kept as its answers report
// them, and a prepaid account's credit, read with the usage refresh.

const encryptor = encryptorFromKey(Buffer.alloc(32, 5));

function setUp(fetchFn?: typeof fetch) {
  let tick = 0;
  let id = 0;
  const store = memoryAiAccountStore();
  const accounts = createAiAccounts({
    store,
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    now: () => new Date(Date.UTC(2026, 9, 11, 12, 0, tick++)),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
  });
  return { store, accounts };
}

describe("an API key's rate limits", () => {
  it("are kept as each answer reports them, and stored now and then", async () => {
    const { store, accounts } = setUp();
    const added = await accounts.add({
      name: "Work API",
      aiProvider: "Claude",
      accountType: "api_key",
      credential: "sk-ant-api03-ratelimitsecret-0123456789abcdef",
    });
    const chosen = await accounts.select({
      agentTool: null,
      forcedAccount: "Work API",
    });
    if (chosen === undefined) {
      throw new Error("The account serves.");
    }
    const answer = (remaining: number) =>
      accounts.report(
        chosen,
        { kind: "served" },
        {},
        {
          requests: {
            limit: 50,
            remaining,
            resetsAt: new Date("2026-10-11T12:01:00Z"),
          },
        },
      );
    await answer(49);
    await answer(48);
    const [listed] = await accounts.list();
    expect(listed?.rateLimits).toMatchObject({
      requests: {
        limit: 50,
        remaining: 48,
        resetsAt: "2026-10-11T12:01:00.000Z",
      },
      tokens: null,
      inputTokens: null,
      outputTokens: null,
    });
    // The first answer's are stored at once; the next only after a while.
    expect(store.accounts.get(added.id)?.rateLimits?.requests).toMatchObject({
      remaining: 49,
    });
  });
});

describe("a prepaid account's credit", () => {
  it("is read with the usage refresh, with the account's own key, for the AI Providers that give it", async () => {
    const asked: { url: string; authorization: string | null }[] = [];
    const { accounts } = setUp(((url: string, init?: RequestInit) => {
      asked.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(
        Response.json({
          data: { usage: 4.5, limit: 10, limit_remaining: 5.5 },
        }),
      );
    }) as typeof fetch);
    const openRouter = await accounts.add({
      name: "OpenRouter",
      aiProvider: "OpenRouter",
      accountType: "api_key",
      credential: "sk-or-v1-balancesecret0123456789abcdef",
    });
    await accounts.add({
      name: "Grok",
      aiProvider: "Grok",
      accountType: "api_key",
      credential: "xai-balancesecret0123456789abcdef",
    });

    expect(await accounts.refreshUsage()).toEqual({
      refreshed: [openRouter.id],
      failed: [],
    });
    expect(asked).toEqual([
      {
        url: "https://openrouter.ai/api/v1/key",
        authorization: "Bearer sk-or-v1-balancesecret0123456789abcdef",
      },
    ]);
    const listed = (await accounts.list()).map(({ name, balance }) => [
      name,
      balance,
    ]);
    expect(listed).toEqual([
      [
        "OpenRouter",
        {
          currency: "USD",
          used: 4.5,
          limit: 10,
          remaining: 5.5,
          observedAt: expect.any(String) as unknown,
        },
      ],
      ["Grok", null],
    ]);
  });
});
