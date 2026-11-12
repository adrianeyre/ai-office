import { describe, expect, it } from "vitest";

import { subscriptionsOnly } from "./accounts.ts";

// Why no AI Account served a request when the only ones that could are
// subscriptions for another agent tool (FR-35).

const claude = { aiProvider: "Claude", accountType: "oauth" } as const;
const chatGpt = { aiProvider: "ChatGPT", accountType: "oauth" } as const;
const apiKey = { aiProvider: "Claude", accountType: "api_key" } as const;

describe("subscriptionsOnly", () => {
  it("says a subscription serves only its own agent tool, and what would serve", () => {
    expect(subscriptionsOnly([claude, chatGpt], null)).toBe(
      "No AI Account can serve this request: the only ones that could are subscriptions, and a subscription serves only its own agent tool (Claude Code or Codex), as its AI Provider's terms require. This request is not from one. Send it from Claude Code or Codex (Claude Code's ANTHROPIC_BASE_URL is AI Office's address, without /v1), or add an API key AI Account to serve other tools.",
    );
  });

  it("names the tool a request came from", () => {
    expect(subscriptionsOnly([claude], "opencode")).toContain(
      "This request is from opencode.",
    );
  });

  it("says nothing when an account is not a subscription, or there are none", () => {
    expect(subscriptionsOnly([claude, apiKey], null)).toBeUndefined();
    expect(subscriptionsOnly([], null)).toBeUndefined();
  });

  it("says nothing when a subscription is the request's own tool's", () => {
    // Its token has expired, say: not a matter of the wrong tool.
    expect(subscriptionsOnly([claude], "Claude Code")).toBeUndefined();
  });
});
