// Prepaid credit (PRD FR-36): the AI Providers whose documented API tells
// an API key's own balance, read with the account's own key on the same
// schedule as subscriptions' usage, for the AI Accounts card. Each reads
// one documented endpoint, and only the figures it needs:
// - OpenRouter: `GET /api/v1/key`, the key's `usage` (credits used, in
//   US dollars) against its `limit` and `limit_remaining`, both null for
//   a key without a limit (https://openrouter.ai/docs/api-reference/limits).
//   Its account-wide `/credits` needs a management key, so it is not read.
// - DeepSeek: `GET /user/balance`, each currency's `total_balance`, a
//   string such as "110.00"; US dollars first where there are both
//   (https://api-docs.deepseek.com/api/get-user-balance).
// - Kimi (Moonshot AI): `GET /v1/users/me/balance`, `data.
//   available_balance`, in US dollars on the international platform
//   (https://platform.kimi.ai/docs/api/balance); in yuan, presumably, on
//   `api.moonshot.cn`.
// Other AI Providers document no balance an inference key may read (xAI's
// needs a management key, OpenAI's an admin key), so none is read for them.

/** A balance as read: in `currency`, what is left and what was used of a limit. */
export interface BalanceReading {
  readonly currency: string;
  readonly remaining: number | null;
  readonly used: number | null;
  readonly limit: number | null;
}

/** Where an account's balance is read from, and how to read the answer. */
export interface BalanceSource {
  /** Appended to the account's API root (its endpoint URL). */
  readonly path: string;
  readonly read: (body: unknown, endpointUrl: string) => BalanceReading;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A number, or a numeric string; null for anything else. */
const amount = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return null;
};

const unreadable = (provider: string): Error =>
  new Error(`${provider}'s balance answer was not as documented.`);

const openRouter: BalanceSource = {
  path: "/api/v1/key",
  read(body) {
    const data = isObject(body) ? body["data"] : undefined;
    if (!isObject(data) || amount(data["usage"]) === null) {
      throw unreadable("OpenRouter");
    }
    return {
      currency: "USD",
      used: amount(data["usage"]),
      limit: amount(data["limit"]),
      remaining: amount(data["limit_remaining"]),
    };
  },
};

const deepSeek: BalanceSource = {
  path: "/user/balance",
  read(body) {
    const infos = isObject(body) ? body["balance_infos"] : undefined;
    if (!Array.isArray(infos)) {
      throw unreadable("DeepSeek");
    }
    const balances = infos.filter(isObject);
    const chosen =
      balances.find(({ currency }) => currency === "USD") ?? balances[0];
    if (chosen === undefined || typeof chosen["currency"] !== "string") {
      throw unreadable("DeepSeek");
    }
    return {
      currency: chosen["currency"],
      remaining: amount(chosen["total_balance"]),
      used: null,
      limit: null,
    };
  },
};

const kimi: BalanceSource = {
  path: "/v1/users/me/balance",
  read(body, endpointUrl) {
    const data = isObject(body) ? body["data"] : undefined;
    if (!isObject(data) || amount(data["available_balance"]) === null) {
      throw unreadable("Kimi");
    }
    return {
      currency: new URL(endpointUrl).hostname.endsWith(".cn") ? "CNY" : "USD",
      remaining: amount(data["available_balance"]),
      used: null,
      limit: null,
    };
  },
};

const sources: Readonly<Record<string, BalanceSource>> = {
  OpenRouter: openRouter,
  DeepSeek: deepSeek,
  Kimi: kimi,
};

/** Where an API key account's balance can be read; undefined for most. */
export const balanceSourceOf = (account: {
  readonly aiProvider: string;
  readonly accountType: string;
}): BalanceSource | undefined =>
  account.accountType === "api_key" ? sources[account.aiProvider] : undefined;

/** How long a balance endpoint is given to answer. */
const balanceTimeoutMs = 10 * 1000;

/**
 * Reads an account's balance from its AI Provider with its own key. Never
 * the answer's body in an error: it is the AI Provider's, and may echo the
 * key.
 */
export async function readBalance(
  source: BalanceSource,
  endpointUrl: string,
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<BalanceReading> {
  const response = await fetchFn(
    `${endpointUrl.replace(/\/+$/, "")}${source.path}`,
    {
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(balanceTimeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(
      `The balance endpoint answered ${String(response.status)}.`,
    );
  }
  return source.read(await response.json(), endpointUrl);
}
