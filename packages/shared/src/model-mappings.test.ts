import { describe, expect, it } from "vitest";

import { aiAccountUpdateSchema, offersExtraUsage } from "./ai-accounts.ts";
import {
  aliasedModel,
  mappedModel,
  modelMappingRequestSchema,
  modelSentTo,
  type ModelMappingRule,
} from "./model-mappings.ts";

// Model mappings, aliases and forced Models (PRD FR-41): which Model an AI
// Account is sent, and in what order of precedence.

const alias = (from: string, to: string): ModelMappingRule => ({
  from,
  to,
  aiProvider: null,
  accountType: null,
});
const forKind = (
  aiProvider: string,
  accountType: string,
  from: string,
  to: string,
): ModelMappingRule => ({ from, to, aiProvider, accountType });

const claudeKey = { aiProvider: "Claude", accountType: "api_key" };
const claudeSubscription = { aiProvider: "Claude", accountType: "oauth" };

describe("the Model an AI Account is sent", () => {
  const mappings: ModelMappingRule[] = [
    alias("opus", "claude-opus-5-5"),
    alias("fast", "claude-haiku-5-5"),
    forKind("Claude", "api_key", "claude-opus-5-5", "claude-sonnet-5-5"),
    forKind("Claude", "api_key", "opus", "claude-opus-4-5"),
    forKind("Claude", "oauth", "claude-haiku-5-5", "claude-sonnet-5-5"),
  ];

  it("is the Model asked for, when nothing maps or forces it", () => {
    expect(
      modelSentTo(
        { requested: "claude-sonnet-5-5" },
        { ...claudeKey, forcedModel: null },
        mappings,
      ),
    ).toBe("claude-sonnet-5-5");
    expect(
      modelSentTo(
        { requested: "claude-opus-5-5" },
        { ...claudeKey, forcedModel: null },
        [],
      ),
    ).toBe("claude-opus-5-5");
  });

  it("is an alias's Model, for every kind of AI Account", () => {
    expect(aliasedModel("fast", mappings)).toBe("claude-haiku-5-5");
    expect(mappedModel("fast", claudeKey, mappings)).toBe("claude-haiku-5-5");
    expect(
      mappedModel("fast", { aiProvider: "Grok", accountType: "api_key" }, [
        alias("fast", "grok-code-fast-1"),
      ]),
    ).toBe("grok-code-fast-1");
  });

  it("is the account's kind's mapping before the alias, for the name as asked", () => {
    // `opus` is an alias for every kind, but Claude API keys map it
    // themselves.
    expect(mappedModel("opus", claudeKey, mappings)).toBe("claude-opus-4-5");
    // A subscription has no mapping of its own for `opus`: the alias.
    expect(mappedModel("opus", claudeSubscription, mappings)).toBe(
      "claude-opus-5-5",
    );
  });

  it("then the kind's mapping of the alias's Model", () => {
    // `fast` is Haiku, which subscriptions map to Sonnet.
    expect(mappedModel("fast", claudeSubscription, mappings)).toBe(
      "claude-sonnet-5-5",
    );
    // `opus` asked for a subscription with only the alias: the alias's.
    expect(
      mappedModel("opus", claudeKey, [
        alias("opus", "claude-opus-5-5"),
        forKind("Claude", "api_key", "claude-opus-5-5", "claude-sonnet-5-5"),
      ]),
    ).toBe("claude-sonnet-5-5");
  });

  it("applies a kind's mapping only to accounts of that kind", () => {
    expect(mappedModel("claude-opus-5-5", claudeKey, mappings)).toBe(
      "claude-sonnet-5-5",
    );
    expect(mappedModel("claude-opus-5-5", claudeSubscription, mappings)).toBe(
      "claude-opus-5-5",
    );
  });

  it("follows one alias and one kind's mapping, never a chain", () => {
    const chained = [
      alias("a", "b"),
      alias("b", "c"),
      forKind("Claude", "api_key", "b", "d"),
      forKind("Claude", "api_key", "d", "e"),
    ];
    expect(aliasedModel("a", chained)).toBe("b");
    expect(mappedModel("a", claudeKey, chained)).toBe("d");
  });

  it("is a Combo slot's Model before any mapping", () => {
    expect(
      modelSentTo(
        { requested: "opus", comboModel: "claude-haiku-5-5" },
        { ...claudeKey, forcedModel: null },
        mappings,
      ),
    ).toBe("claude-haiku-5-5");
  });

  it("is the account's forced Model before everything else", () => {
    const forced = { ...claudeKey, forcedModel: "claude-haiku-4-5" };
    expect(modelSentTo({ requested: "opus" }, forced, mappings)).toBe(
      "claude-haiku-4-5",
    );
    expect(
      modelSentTo(
        { requested: "opus", comboModel: "claude-sonnet-5-5" },
        forced,
        mappings,
      ),
    ).toBe("claude-haiku-4-5");
    // Even when the request names no Model.
    expect(modelSentTo({ requested: null }, forced, mappings)).toBe(
      "claude-haiku-4-5",
    );
    expect(
      modelSentTo(
        { requested: null },
        { ...claudeKey, forcedModel: null },
        mappings,
      ),
    ).toBeUndefined();
  });
});

describe("a model mapping", () => {
  it("is an alias with no kind of AI Account, or for one kind", () => {
    expect(
      modelMappingRequestSchema.parse({
        from: " opus ",
        to: "claude-opus-5-5",
        aiProvider: null,
        accountType: null,
      }),
    ).toEqual({
      from: "opus",
      to: "claude-opus-5-5",
      aiProvider: null,
      accountType: null,
    });
    expect(
      modelMappingRequestSchema.safeParse({
        from: "gpt-5",
        to: "claude-sonnet-5-5",
        aiProvider: "Claude",
        accountType: "api_key",
      }).success,
    ).toBe(true);
  });

  it("refuses half a kind, a kind that does not exist, and itself", () => {
    const problem = (mapping: object) =>
      modelMappingRequestSchema.safeParse(mapping).error?.issues[0]?.message;
    expect(
      problem({
        from: "opus",
        to: "claude-opus-5-5",
        aiProvider: "Claude",
        accountType: null,
      }),
    ).toMatch(/both an AI Provider and an account type/);
    expect(
      problem({
        from: "opus",
        to: "deepseek-v4-pro",
        aiProvider: "DeepSeek",
        accountType: "oauth",
      }),
    ).toBe("There is no DeepSeek account of that type.");
    expect(
      problem({
        from: "claude-opus-5-5",
        to: "claude-opus-5-5",
        aiProvider: null,
        accountType: null,
      }),
    ).toBe("Map the name to another Model.");
    expect(
      problem({
        from: "my model",
        to: "claude-opus-5-5",
        aiProvider: null,
        accountType: null,
      }),
    ).toBe("A Model's name has no spaces in it.");
  });

  it("maps a kind's requests only to its own AI Provider's Models", () => {
    expect(
      modelMappingRequestSchema.safeParse({
        from: "opus",
        to: "gpt-5-codex",
        aiProvider: "Claude",
        accountType: "oauth",
      }).error?.issues[0]?.message,
    ).toBe("gpt-5-codex is ChatGPT's, but the mapping is for Claude accounts.");
    // An alias may stand for any AI Provider's Model.
    expect(
      modelMappingRequestSchema.safeParse({
        from: "opus",
        to: "gpt-5-codex",
        aiProvider: null,
        accountType: null,
      }).success,
    ).toBe(true);
  });
});

describe("an AI Account's forced Model and extra usage", () => {
  it("are offered where the AI Provider offers extra usage: a Claude subscription", () => {
    expect(offersExtraUsage(claudeSubscription)).toBe(true);
    expect(offersExtraUsage(claudeKey)).toBe(false);
    expect(
      offersExtraUsage({ aiProvider: "ChatGPT", accountType: "oauth" }),
    ).toBe(false);
    expect(offersExtraUsage({ aiProvider: "Nope", accountType: "oauth" })).toBe(
      false,
    );
  });

  it("are changed like any other setting, and null forces nothing", () => {
    expect(
      aiAccountUpdateSchema.parse({
        forcedModel: " claude-sonnet-5-5 ",
        extraUsage: true,
      }),
    ).toEqual({ forcedModel: "claude-sonnet-5-5", extraUsage: true });
    expect(aiAccountUpdateSchema.parse({ forcedModel: null })).toEqual({
      forcedModel: null,
    });
    expect(aiAccountUpdateSchema.safeParse({ extraUsage: "yes" }).success).toBe(
      false,
    );
    expect(aiAccountUpdateSchema.safeParse({ forcedModel: "" }).success).toBe(
      false,
    );
  });
});
