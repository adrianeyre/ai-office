import { anyAiProvider } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  resolveAiProvider,
  workingAgent,
  type AvailableAiAccount,
} from "./any-ai-provider.ts";
import type { AgentRecord } from "./store.ts";

// Any AI Provider (FR-11): the AI Provider an Agent on any is given when a
// task starts.

const now = new Date("2026-10-14T12:00:00.000Z");

const account = (
  aiProvider: string,
  more: Partial<AvailableAiAccount> = {},
): AvailableAiAccount => ({
  aiProvider,
  priority: 50,
  paused: false,
  limitedUntil: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  ...more,
});

const defaults = { Claude: "claude-opus-5-5", ChatGPT: "gpt-5-codex" };

describe("resolveAiProvider", () => {
  it("leaves an Agent's own AI Provider as it is", () => {
    expect(resolveAiProvider("Grok", { defaults: {}, accounts: [] }, now)).toBe(
      "Grok",
    );
  });

  it("gives any AI Provider the first AI Account's, in priority order", () => {
    expect(
      resolveAiProvider(
        anyAiProvider,
        {
          defaults,
          accounts: [
            account("Claude", { priority: 2 }),
            account("ChatGPT", { priority: 1 }),
          ],
        },
        now,
      ),
    ).toBe("ChatGPT");
  });

  it("gives ties to the oldest AI Account", () => {
    expect(
      resolveAiProvider(
        anyAiProvider,
        {
          defaults,
          accounts: [
            account("Claude", { createdAt: new Date("2026-10-02") }),
            account("ChatGPT", { createdAt: new Date("2026-10-01") }),
          ],
        },
        now,
      ),
    ).toBe("ChatGPT");
  });

  it("passes over paused and held-back AI Accounts, and AI Providers with no default Model", () => {
    expect(
      resolveAiProvider(
        anyAiProvider,
        {
          defaults,
          accounts: [
            account("Grok", { priority: 1 }),
            account("ChatGPT", { priority: 2, paused: true }),
            account("ChatGPT", {
              priority: 3,
              limitedUntil: new Date("2026-10-14T13:00:00.000Z"),
            }),
            account("Claude", { priority: 4 }),
          ],
        },
        now,
      ),
    ).toBe("Claude");
    // A hold that has ended holds nothing back.
    expect(
      resolveAiProvider(
        anyAiProvider,
        {
          defaults,
          accounts: [
            account("ChatGPT", {
              priority: 1,
              limitedUntil: new Date("2026-10-14T11:00:00.000Z"),
            }),
            account("Claude", { priority: 2 }),
          ],
        },
        now,
      ),
    ).toBe("ChatGPT");
  });

  it("takes a held-back AI Account's when every one is held back", () => {
    expect(
      resolveAiProvider(
        anyAiProvider,
        {
          defaults,
          accounts: [
            account("ChatGPT", {
              limitedUntil: new Date("2026-10-14T13:00:00.000Z"),
            }),
          ],
        },
        now,
      ),
    ).toBe("ChatGPT");
  });

  it("without an AI Account, takes the first AI Provider with a default Model", () => {
    expect(
      resolveAiProvider(
        anyAiProvider,
        { defaults: { ChatGPT: "gpt-5-codex" }, accounts: [] },
        now,
      ),
    ).toBe("ChatGPT");
    expect(
      resolveAiProvider(anyAiProvider, { defaults: {}, accounts: [] }, now),
    ).toBeUndefined();
  });
});

describe("workingAgent", () => {
  const agent = {
    id: "a1",
    aiProvider: anyAiProvider,
    modelOverride: null,
    effort: null,
  } as unknown as AgentRecord;

  it("puts an Agent on any AI Provider on the one available", () => {
    expect(
      workingAgent(agent, { defaults, accounts: [account("ChatGPT")] }, now),
    ).toMatchObject({
      aiProvider: "ChatGPT",
      modelOverride: "gpt-5-codex",
      effort: null,
    });
  });

  it("leaves it as it is when none can be chosen", () => {
    expect(workingAgent(agent, { defaults: {}, accounts: [] }, now)).toBe(
      agent,
    );
  });
});
