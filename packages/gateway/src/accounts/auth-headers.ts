import type { GatewayAccount } from "../gateway.ts";

/**
 * The headers that present an account's credential, as its API takes it:
 * Anthropic's `x-api-key` for an API key, a bearer token for a
 * subscription's token and for OpenAI's formats, both for an
 * Anthropic-compatible endpoint; none for an endpoint that asks for no key
 * (the Owner's own Ollama, or a compatible endpoint given none).
 */
export function authHeaders(
  account: Pick<GatewayAccount, "apiKey" | "apiFormat" | "authorization">,
): Record<string, string> {
  if (account.apiKey === "") {
    return {};
  }
  if ((account.apiFormat ?? "anthropic") !== "anthropic") {
    return { authorization: `Bearer ${account.apiKey}` };
  }
  switch (account.authorization ?? "x-api-key") {
    case "x-api-key":
      return { "x-api-key": account.apiKey };
    case "bearer":
      return { authorization: `Bearer ${account.apiKey}` };
    case "both":
      return {
        "x-api-key": account.apiKey,
        authorization: `Bearer ${account.apiKey}`,
      };
  }
}
