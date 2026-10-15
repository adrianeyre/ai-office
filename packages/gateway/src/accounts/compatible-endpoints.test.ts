import { createEventBus, memoryEventStore } from "@ai-office/events";
import { aiAccountErrorCodes, comboErrorCodes } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import { createCombos } from "../combos/combos.ts";
import { memoryComboStore } from "../combos/store.ts";
import { createAiAccounts } from "./accounts.ts";
import { memoryAiAccountStore } from "./store.ts";

// Routing with Ollama and compatible endpoints (PRD FR-35, FR-38, FR-40,
// FR-41): an Anthropic- or OpenAI-compatible endpoint serves whatever its
// owner put behind it, so it may be sent, forced or given in a Combo any
// Model; Ollama serves its own `model:tag` Models only. A Model no AI
// Provider claims by name goes to the compatible endpoints while one can
// serve it, and to any account when there is none.

const encryptor = encryptorFromKey(Buffer.alloc(32, 50));

async function office() {
  const store = memoryAiAccountStore();
  const events = createEventBus({ store: memoryEventStore() });
  const accounts = createAiAccounts({ store, encryptor, events });
  const claude = await accounts.add({
    name: "Claude",
    aiProvider: "Claude",
    accountType: "api_key",
    credential: "sk-ant-api03-compatibleEndpointsTest0123456789",
  });
  const ollama = await accounts.add({
    name: "Ollama",
    aiProvider: "Ollama",
    accountType: "endpoint",
  });
  const endpoint = await accounts.add({
    name: "vLLM",
    aiProvider: "OpenAI-compatible",
    accountType: "endpoint",
    endpointUrl: "http://gpu-box.lan:8000/v1",
  });
  const combos = createCombos({
    store: memoryComboStore(),
    accounts,
    events,
  });
  return { accounts, combos, claude, ollama, endpoint };
}

describe("Ollama and compatible endpoints, routed", () => {
  it("send a Model no AI Provider claims to a compatible endpoint, though Claude comes first", async () => {
    const { accounts } = await office();
    const chosen = (model: string) =>
      accounts
        .select({ agentTool: null, model, endpoint: "chat_completions" })
        .then((account) => account?.name);
    expect(await chosen("my-own-model")).toBe("vLLM");
    // Claude's go to Claude by priority, Ollama's to Ollama.
    expect(await chosen("claude-sonnet-5-5")).toBe("Claude");
    expect(await chosen("qwen3-coder:30b")).toBe("Ollama");
    // One no account here claims: the endpoint, which is sent any.
    expect(await chosen("grok-4")).toBe("vLLM");
  });

  it("send a Model no AI Provider claims to any account while no compatible endpoint can serve it", async () => {
    const { accounts, endpoint } = await office();
    await accounts.update(endpoint.id, { paused: true });
    const chosen = await accounts.select({
      agentTool: null,
      model: "my-own-model",
      endpoint: "chat_completions",
    });
    expect(chosen?.name).toBe("Claude");
  });

  it("force any Model on a compatible endpoint, and only Ollama's on Ollama", async () => {
    const { accounts, ollama, endpoint } = await office();
    expect(
      (await accounts.update(endpoint.id, { forcedModel: "claude-sonnet-5-5" }))
        .forcedModel,
    ).toBe("claude-sonnet-5-5");
    expect(
      (await accounts.update(ollama.id, { forcedModel: "gpt-oss:20b" }))
        .forcedModel,
    ).toBe("gpt-oss:20b");
    await expect(
      accounts.update(ollama.id, { forcedModel: "claude-sonnet-5-5" }),
    ).rejects.toMatchObject({
      code: aiAccountErrorCodes.forcedModelMismatch,
      message: "claude-sonnet-5-5 is Claude's, but Ollama is a Ollama account.",
    });
  });

  it("give a compatible endpoint any Model in a Combo's slot, and Ollama only its own", async () => {
    const { combos, ollama, endpoint } = await office();
    const combo = await combos.add({
      name: "Local first",
      modelFamilies: ["claude-sonnet"],
      slots: [
        { aiAccountId: ollama.id, model: "qwen3-coder:30b" },
        { aiAccountId: endpoint.id, model: "claude-sonnet-5-5" },
      ],
      enabled: true,
    });
    expect(combo.slots).toHaveLength(2);
    await expect(
      combos.add({
        name: "Wrong",
        modelFamilies: ["claude-opus"],
        slots: [{ aiAccountId: ollama.id, model: "claude-opus-5-5" }],
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: comboErrorCodes.slotModelMismatch });
  });
});
