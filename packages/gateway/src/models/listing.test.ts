import { describe, expect, it } from "vitest";

import { gatewayModels } from "./listing.ts";
import type { CatalogueEntry } from "./store.ts";

const entry = (
  aiProvider: string,
  accountType: CatalogueEntry["accountType"],
  model: string,
  displayName: string | null = null,
): CatalogueEntry => ({
  aiProvider,
  accountType,
  model,
  displayName,
  contextWindow: null,
  fetchedAt: new Date(0),
});

describe("gatewayModels", () => {
  it("lists the Models of the kinds of AI Account the Owner has unpaused, each once, by name", () => {
    const catalogue = [
      entry("Claude", "oauth", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
      entry("Claude", "oauth", "claude-haiku-5-5", "Claude Haiku 5.5"),
      entry("Claude", "api_key", "claude-haiku-5-5", "Claude Haiku 5.5"),
      entry("ChatGPT", "oauth", "gpt-5"),
      entry("Gemini", "api_key", "gemini-3-pro"),
    ];
    const accounts = [
      { aiProvider: "Claude", accountType: "oauth", paused: false },
      { aiProvider: "Claude", accountType: "api_key", paused: false },
      { aiProvider: "ChatGPT", accountType: "oauth", paused: false },
      { aiProvider: "Gemini", accountType: "api_key", paused: true },
    ] as const;

    expect(gatewayModels(catalogue, accounts)).toEqual([
      {
        id: "claude-haiku-5-5",
        displayName: "Claude Haiku 5.5",
        aiProvider: "Claude",
      },
      {
        id: "claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        aiProvider: "Claude",
      },
      { id: "gpt-5", displayName: null, aiProvider: "ChatGPT" },
    ]);
  });

  it("lists nothing without an AI Account", () => {
    expect(gatewayModels([entry("Claude", "oauth", "x")], [])).toEqual([]);
  });
});
