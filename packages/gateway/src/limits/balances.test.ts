import { describe, expect, it } from "vitest";

import { balanceSourceOf, readBalance } from "./balances.ts";

// Prepaid credit from the AI Providers whose documented API gives an API
// key its own balance, with a fake fetch answering as each documents.

/** A fetch that answers `body` (or `status`), keeping what it was asked. */
function fakeFetch(body: unknown, status = 200) {
  const asked: { url: string; authorization: string | null }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    asked.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(Response.json(body, { status }));
  }) as typeof fetch;
  return { fetchFn, asked };
}

const sourceOf = (aiProvider: string) => {
  const source = balanceSourceOf({ aiProvider, accountType: "api_key" });
  if (source === undefined) {
    throw new Error(`${aiProvider} has a balance.`);
  }
  return source;
};

describe("balanceSourceOf", () => {
  it("reads OpenRouter's, DeepSeek's and Kimi's API keys only", () => {
    expect(
      [
        "OpenRouter",
        "DeepSeek",
        "Kimi",
        "Grok",
        "Z.ai",
        "Minimax",
        "Claude",
      ].map(
        (aiProvider) =>
          balanceSourceOf({ aiProvider, accountType: "api_key" }) !== undefined,
      ),
    ).toEqual([true, true, true, false, false, false, false]);
    expect(
      balanceSourceOf({ aiProvider: "Ollama", accountType: "endpoint" }),
    ).toBeUndefined();
  });
});

describe("readBalance", () => {
  it("reads an OpenRouter key's credit used against its limit, with the key itself", async () => {
    const { fetchFn, asked } = fakeFetch({
      data: {
        label: "sk-or-v1-0e6...",
        limit: 20,
        limit_remaining: 7.5,
        usage: 12.5,
        usage_daily: 1.25,
        is_free_tier: false,
      },
    });
    expect(
      await readBalance(
        sourceOf("OpenRouter"),
        "https://openrouter.ai",
        "sk-or-key",
        fetchFn,
      ),
    ).toEqual({ currency: "USD", used: 12.5, limit: 20, remaining: 7.5 });
    expect(asked).toEqual([
      {
        url: "https://openrouter.ai/api/v1/key",
        authorization: "Bearer sk-or-key",
      },
    ]);
  });

  it("reads an OpenRouter key without a limit as credit used only", async () => {
    const { fetchFn } = fakeFetch({
      data: { limit: null, limit_remaining: null, usage: 3.2 },
    });
    expect(
      await readBalance(
        sourceOf("OpenRouter"),
        "https://openrouter.ai/",
        "k",
        fetchFn,
      ),
    ).toEqual({ currency: "USD", used: 3.2, limit: null, remaining: null });
  });

  it("reads DeepSeek's balance, in US dollars where it has them", async () => {
    const { fetchFn, asked } = fakeFetch({
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "110.00",
          granted_balance: "10.00",
          topped_up_balance: "100.00",
        },
        {
          currency: "USD",
          total_balance: "15.40",
          granted_balance: "0.00",
          topped_up_balance: "15.40",
        },
      ],
    });
    expect(
      await readBalance(
        sourceOf("DeepSeek"),
        "https://api.deepseek.com",
        "sk-ds",
        fetchFn,
      ),
    ).toEqual({ currency: "USD", remaining: 15.4, used: null, limit: null });
    expect(asked[0]?.url).toBe("https://api.deepseek.com/user/balance");
  });

  it("reads Kimi's available balance, in yuan on Moonshot's Chinese platform", async () => {
    const body = {
      code: 0,
      data: {
        available_balance: 49.58,
        voucher_balance: 46.58,
        cash_balance: 3,
      },
      scode: "0x0",
      status: true,
    };
    const international = fakeFetch(body);
    expect(
      await readBalance(
        sourceOf("Kimi"),
        "https://api.moonshot.ai",
        "sk-kimi",
        international.fetchFn,
      ),
    ).toEqual({ currency: "USD", remaining: 49.58, used: null, limit: null });
    expect(international.asked[0]?.url).toBe(
      "https://api.moonshot.ai/v1/users/me/balance",
    );
    expect(
      (
        await readBalance(
          sourceOf("Kimi"),
          "https://api.moonshot.cn",
          "sk-kimi",
          fakeFetch(body).fetchFn,
        )
      ).currency,
    ).toBe("CNY");
  });

  it("fails on a refusal, or an answer not as documented, without the body", async () => {
    await expect(
      readBalance(
        sourceOf("DeepSeek"),
        "https://api.deepseek.com",
        "sk-ds",
        fakeFetch({ error: "invalid key sk-ds" }, 401).fetchFn,
      ),
    ).rejects.toThrow("The balance endpoint answered 401.");
    await expect(
      readBalance(
        sourceOf("Kimi"),
        "https://api.moonshot.ai",
        "sk-kimi",
        fakeFetch({ data: {} }).fetchFn,
      ),
    ).rejects.toThrow("Kimi's balance answer was not as documented.");
  });
});
