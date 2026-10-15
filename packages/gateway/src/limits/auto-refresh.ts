import { authHeaders } from "../accounts/auth-headers.ts";
import type { GatewayAccount } from "../gateway.ts";
import { outcomeOf, type AccountOutcome } from "./detect.ts";
import { usageWindowsOf, type UsageWindowReadings } from "./usage-windows.ts";

// Auto-refresh's request (PRD FR-39): the least a usage window can be
// started with. One Messages request for one output token to the cheapest
// Claude Model, presented as every request to the account is (its key, or
// its token and beta flags). Its answer is read like any other: whether it
// was served, held back or failed, and the usage windows it reports, so
// the new window is stored as it starts.

/** The Model auto-refresh asks: Claude's smallest. */
export const autoRefreshModel = "claude-haiku-5-5";

/** What auto-refresh's request said about the account that answered it. */
export interface RefreshAnswer {
  readonly status: number;
  readonly outcome: AccountOutcome;
  readonly usage: UsageWindowReadings;
}

/**
 * Sends `account` auto-refresh's minimal request; an error when its AI
 * Provider cannot be reached. Neither the credential nor the answer's
 * body is ever put in an error.
 */
export async function sendRefresh(
  account: GatewayAccount,
  options: { readonly fetch: typeof fetch; readonly now: Date },
): Promise<RefreshAnswer> {
  const url = `${account.baseUrl.replace(/\/+$/, "")}${(account.apiPath ?? "/v1").replace(/\/+$/, "")}/messages`;
  const response = await options.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...authHeaders({ ...account, apiFormat: "anthropic" }),
      ...(account.betas === undefined || account.betas.length === 0
        ? {}
        : { "anthropic-beta": account.betas.join(",") }),
      ...account.headers,
    },
    body: JSON.stringify({
      model: autoRefreshModel,
      max_tokens: 1,
      messages: [{ role: "user", content: "Hi" }],
    }),
    signal: AbortSignal.timeout(60_000),
    // Its credential goes to its own endpoint only (pen-testing G1-7).
    redirect: "manual",
  });
  const body = await response.text();
  return {
    status: response.status,
    outcome: outcomeOf(
      { status: response.status, headers: response.headers, body },
      options.now,
    ),
    usage: usageWindowsOf(response.headers, options.now),
  };
}
