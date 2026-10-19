// Coding plans (PRD FR-35): an AI Provider's subscription sold as a key,
// added as that AI Provider's API key at the plan's own API, which each
// request then goes to.
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { subscriptionPlanOf, subscriptionPlans } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import { createAiAccounts } from "./accounts.ts";
import { memoryAiAccountStore } from "./store.ts";

const accounts = () =>
  createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor: encryptorFromKey(Buffer.alloc(32, 48)),
    events: createEventBus({ store: memoryEventStore() }),
  });

describe("a coding plan's key", () => {
  it.each([
    ["Z.ai", "glm-5.3", "https://api.z.ai/api/coding/paas/v4/chat/completions"],
    [
      "Kimi",
      "kimi-for-coding",
      "https://api.kimi.ai/coding/v1/chat/completions",
    ],
    [
      "Qwen",
      "qwen3.7-plus",
      "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions",
    ],
  ] as const)(
    "of %s serves from the plan's own API",
    async (aiProvider, model, url) => {
      const plan = subscriptionPlans.find(
        (each) => each.aiProvider === aiProvider,
      );
      const office = accounts();
      const added = await office.add({
        name: plan?.label ?? aiProvider,
        aiProvider,
        accountType: "api_key",
        credential: "sk-plan-0123456789",
        endpointUrl: plan?.endpointUrl ?? null,
      });
      expect(subscriptionPlanOf(added)).toBe(plan);
      const chosen = await office.select({
        agentTool: "opencode",
        model,
        endpoint: "chat_completions",
      });
      const path = `${chosen?.apiPath ?? "/v1"}/chat/completions`;
      expect(`${chosen?.baseUrl ?? ""}${path}`).toBe(url);
    },
  );

  it("of MiniMax is MiniMax's usual API, and an account elsewhere is no plan's", () => {
    expect(
      subscriptionPlans.find((plan) => plan.aiProvider === "Minimax")
        ?.endpointUrl,
    ).toBeNull();
    expect(
      subscriptionPlanOf({
        aiProvider: "Z.ai",
        accountType: "api_key",
        endpointUrl: null,
      }),
    ).toBeUndefined();
    expect(
      subscriptionPlanOf({
        aiProvider: "Kimi",
        accountType: "api_key",
        endpointUrl: "https://api.kimi.ai/coding/",
      })?.label,
    ).toBe("Kimi for Coding key (Kimi Code membership)");
  });
});
