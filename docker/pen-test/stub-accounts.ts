// The pen-test stack's AI Accounts (docs/pen-testing/stack.md): one for
// each kind of upstream the Agents' tools reach through the AI Gateway,
// every one pointing at the stub upstream (`stub-upstream.ts`) and holding
// a canary in place of a credential. There are no real AI Account
// credentials anywhere in the stack.
//
// - Claude, a Console API key: Claude Code's Messages;
// - Grok and Gemini, API keys: opencode's Chat Completions;
// - an OpenAI-compatible endpoint, which is sent any Model: Codex's
//   Responses, and every Model no other AI Provider claims.
import type { AddAiAccountRequest } from "../../packages/shared/src/ai-accounts.ts";
import type { StubProvider } from "./stub-upstream.ts";

/** Every canary credential starts with this, so a leaked one is found. */
export const canaryPrefix = "pen-test-canary-";

/** The stub upstream, as the stack's app reaches it. */
export const stubUpstreamUrl = "http://stub-upstream:3050";

/** An AI Account of the stack: what is added, and its stub prefix. */
export interface StubAccount {
  readonly provider: StubProvider;
  readonly request: AddAiAccountRequest;
}

/**
 * The stack's AI Accounts for the stub upstream at `stubUrl`, each with
 * the canary credential `canary(provider)` gives it.
 */
export function stubAccounts(
  stubUrl: string,
  canary: (provider: StubProvider) => string,
): StubAccount[] {
  const at = (path: string) => `${stubUrl.replace(/\/+$/, "")}${path}`;
  return [
    {
      provider: "anthropic",
      request: {
        name: "Claude (pen-test stub)",
        aiProvider: "Claude",
        accountType: "api_key",
        credential: canary("anthropic"),
        endpointUrl: at("/anthropic"),
      },
    },
    {
      provider: "xai",
      request: {
        name: "Grok (pen-test stub)",
        aiProvider: "Grok",
        accountType: "api_key",
        credential: canary("xai"),
        endpointUrl: at("/xai"),
      },
    },
    {
      provider: "gemini",
      request: {
        name: "Gemini (pen-test stub)",
        aiProvider: "Gemini",
        accountType: "api_key",
        credential: canary("gemini"),
        endpointUrl: at("/gemini"),
      },
    },
    {
      provider: "openai",
      request: {
        name: "OpenAI-compatible (pen-test stub)",
        aiProvider: "OpenAI-compatible",
        accountType: "endpoint",
        credential: canary("openai"),
        // An OpenAI-compatible endpoint's URL is its API's root, `/v1`
        // included.
        endpointUrl: at("/openai/v1"),
      },
    },
  ];
}
