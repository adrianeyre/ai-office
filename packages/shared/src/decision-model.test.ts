import { describe, expect, it } from "vitest";

import { aiProviders, updateAgentRequestSchema } from "./agents.ts";
import { aiAccountKinds, kindServes } from "./ai-accounts.ts";
import { setDefaultModelRequestSchema } from "./ai-providers.ts";
import {
  decisionModelSettingsSchema,
  defaultDecisionModelSettings,
  isDecisionModel,
  notAnAgentModel,
} from "./decision-model.ts";

// The Decision Model's settings (PRD FR-17, FR-89): Jev, off until the
// Owner turns it on, and never an Agent's AI Provider or Model.

const problems = (body: unknown) =>
  decisionModelSettingsSchema
    .safeParse(body)
    .error?.issues.map(({ message }) => message);

describe("the Decision Model's settings", () => {
  it("are off, Jev 1.13, and not writing summaries until the Owner chooses", () => {
    expect(defaultDecisionModelSettings).toEqual({
      enabled: false,
      model: "typesafe/jev-1.13",
      summaries: false,
    });
  });

  it("take Jev as OpenRouter names it: a release, or the newest", () => {
    for (const model of [
      "typesafe/jev-1.13",
      "~typesafe/jev-latest",
      " typesafe/jev-2.0 ",
    ]) {
      expect(isDecisionModel(model), model).toBe(true);
      expect(
        decisionModelSettingsSchema.parse({
          enabled: true,
          model,
          summaries: false,
        }).model,
      ).toBe(model.trim());
    }
  });

  it("refuse any other Model, and anything missing", () => {
    for (const model of [
      "claude-opus-5-5",
      "jev-1.13",
      "typesafe/jev-router",
      "anthropic/claude-sonnet-4.5",
      "",
    ]) {
      expect(isDecisionModel(model), model).toBe(false);
    }
    expect(
      problems({ enabled: true, model: "claude-opus-5-5", summaries: false }),
    ).toEqual([
      "The Decision Model is Jev: name it as OpenRouter does, such as typesafe/jev-1.13 or ~typesafe/jev-latest.",
    ]);
    expect(problems({ model: "typesafe/jev-1.13", summaries: false })).toEqual([
      "Say whether the Decision Model is on.",
    ]);
    expect(
      problems({
        enabled: false,
        model: "typesafe/jev-1.13",
        summaries: false,
        threshold: 0.5,
      }),
    ).toHaveLength(1);
  });
});

describe("Jev", () => {
  it("is no AI Provider an Agent can choose", () => {
    expect(aiProviders as readonly string[]).not.toContain("Jev");
    expect(
      updateAgentRequestSchema.safeParse({ aiProvider: "Jev" }).success,
    ).toBe(false);
  });

  it("is never an Agent's Model, nor an AI Provider's default", () => {
    for (const model of ["typesafe/jev-1.13", "~typesafe/jev-latest"]) {
      expect(
        updateAgentRequestSchema
          .safeParse({ modelOverride: model })
          .error?.issues.map(({ message }) => message),
      ).toEqual([notAnAgentModel]);
      expect(
        setDefaultModelRequestSchema
          .safeParse({ defaultModel: model })
          .error?.issues.map(({ message }) => message),
      ).toEqual([notAnAgentModel]);
    }
    expect(
      updateAgentRequestSchema.safeParse({
        modelOverride: "anthropic/claude-sonnet-4.5",
      }).success,
    ).toBe(true);
  });

  it("is answered only by AI Accounts that name its endpoint: OpenRouter's", () => {
    const answering = aiAccountKinds
      .filter((kind) => kindServes(kind, "systemone"))
      .map(({ aiProvider, accountType }) => `${aiProvider} ${accountType}`);
    expect(answering).toEqual(["OpenRouter api_key"]);
  });
});
