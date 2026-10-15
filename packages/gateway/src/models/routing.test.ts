// Model mappings, aliases and forced Models through a real Gateway (PRD
// FR-41): each AI Account is sent the Model `modelSentTo` gives it, most
// specific first (its forced Model, a Combo slot's, its kind's mapping,
// an alias, the Model asked for), is chosen by that Model's AI Provider
// and family, and the request is recorded with the Model that served.
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  aiAccountErrorCodes,
  type ModelMappingRequest,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiAccountError,
  createAiAccounts,
  type AiAccounts,
} from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { createCombos } from "../combos/combos.ts";
import { memoryComboStore } from "../combos/store.ts";
import { readFixture, type Fixture } from "../fixtures.ts";
import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type ReceivedRequest,
  type RunningGateway,
} from "../test-support.ts";
import { createModelMappings, type ModelMappings } from "./mappings.ts";
import { memoryModelMappingStore } from "./mappings-store.ts";

const served = await readFixture(
  fileURLToPath(
    new URL("../../fixtures/limits/anthropic-served.json", import.meta.url),
  ),
);

/** Grok's answer, in OpenAI's Chat Completions format. */
const grokServed: Fixture = {
  request: served.request,
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "chatcmpl-mapping",
      object: "chat.completion",
      created: 1_791_633_600,
      model: "grok-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Grok answers." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }),
  },
};

const encryptor = encryptorFromKey(Buffer.alloc(32, 42));
const start = Date.parse("2026-10-10T12:00:00.000Z");

type Respond = (
  request: ReceivedRequest,
  response: ServerResponse,
) => Promise<void>;

interface Office {
  readonly accounts: AiAccounts;
  readonly mappings: ModelMappings;
  readonly gateway: RunningGateway;
  readonly requestLog: ReturnType<typeof memoryRequestLog>;
  readonly upstreams: Record<string, FakeUpstream>;
  readonly ids: Record<string, string>;
  /** Every request an AI Provider was sent: `account: model`, in order. */
  readonly sent: string[];
  /** Asks the Gateway for `model`, reading the answer whole. */
  send(model: string): Promise<Response>;
  /** Adds a mapping: an alias unless it names a kind of AI Account. */
  map(
    from: string,
    to: string,
    kind?: Pick<ModelMappingRequest, "aiProvider" | "accountType">,
  ): Promise<string>;
  /** Forces `name`'s Model, or (null) no longer. */
  force(name: string, model: string | null): Promise<void>;
}

let office: Office | undefined;

afterEach(async () => {
  await office?.gateway.close();
  for (const upstream of Object.values(office?.upstreams ?? {})) {
    await upstream.close();
  }
  office = undefined;
});

const claudeKeys = { aiProvider: "Claude", accountType: "api_key" } as const;

/** API-key accounts in priority order, each Claude's unless it says. */
async function setUp(
  initial: Record<string, "Claude" | "Grok">,
  options: { readonly combo?: [account: string, model: string][] } = {},
): Promise<Office> {
  let id = 0;
  const bus = createEventBus({ store: memoryEventStore() });
  const newId = () =>
    `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const now = () => new Date(start);
  const store = memoryAiAccountStore();
  const mappings = createModelMappings({
    store: memoryModelMappingStore(),
    events: bus,
    now,
    newId,
  });
  const combos = createCombos({
    store: memoryComboStore(),
    accounts: store,
    events: bus,
    settings: () => ({ enabled: true }),
    now,
    newId,
  });
  const accounts = createAiAccounts({
    store,
    encryptor,
    events: bus,
    now,
    newId,
    combos,
    modelMappings: mappings,
  });
  const upstreams: Record<string, FakeUpstream> = {};
  const ids: Record<string, string> = {};
  const sent: string[] = [];
  let priority = 0;
  for (const [name, aiProvider] of Object.entries(initial)) {
    const answer: Respond = replay(
      aiProvider === "Grok" ? grokServed : served,
      1_000_000,
    );
    upstreams[name] = await startFakeUpstream((request, response) => {
      const { model } = JSON.parse(request.body) as { model: string };
      sent.push(`${name}: ${model}`);
      return answer(request, response);
    });
    ids[name] = (
      await accounts.add({
        name,
        aiProvider,
        accountType: "api_key",
        credential: `sk-${name.toLowerCase()}-model-mapping-0123456789`,
        endpointUrl: upstreams[name].url,
        priority: (priority += 1),
      })
    ).id;
  }
  if (options.combo !== undefined) {
    await combos.add({
      name: "Opus chain",
      modelFamilies: ["claude-opus"],
      slots: options.combo.map(([account, model]) => ({
        aiAccountId: ids[account] ?? account,
        model,
      })),
      enabled: true,
    });
  }
  const requestLog = memoryRequestLog();
  const gateway = await startGateway({ accounts, requestLog, now });
  office = {
    accounts,
    mappings,
    gateway,
    requestLog,
    upstreams,
    ids,
    sent,
    async send(model) {
      const response = await fetch(`${gateway.url}${served.request.path}`, {
        method: "POST",
        headers: { ...served.request.headers, "x-api-key": gatewayKey },
        body: JSON.stringify({
          ...(JSON.parse(served.request.body) as object),
          model,
        }),
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    },
    async map(from, to, kind = { aiProvider: null, accountType: null }) {
      return (await mappings.add({ from, to, ...kind })).id;
    },
    async force(name, model) {
      await accounts.update(ids[name] ?? name, { forcedModel: model });
    },
  };
  return office;
}

/** The Model each request was recorded with, in order. */
const recordedModels = async (office: Office, count: number) => {
  await vi.waitFor(() => {
    expect(office.requestLog.records).toHaveLength(count);
  });
  return office.requestLog.records.map(
    ({ account, model }) => `${account ?? "none"}: ${model ?? "none"}`,
  );
};

describe("the Model an AI Account is sent, in order of precedence", () => {
  it("is the forced Model, then the kind's mapping, then the alias, then the Model asked for", async () => {
    const office = await setUp({ Key: "Claude" });
    await office.map("opus", "claude-opus-5-5");
    const kindMapping = await office.map(
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      claudeKeys,
    );
    await office.force("Key", "claude-haiku-5-5");

    expect((await office.send("opus")).status).toBe(200);
    await office.force("Key", null);
    expect((await office.send("opus")).status).toBe(200);
    await office.mappings.remove(kindMapping);
    expect((await office.send("opus")).status).toBe(200);
    expect((await office.send("claude-sonnet-4-5")).status).toBe(200);

    expect(office.sent).toEqual([
      // Forced: whatever was asked for.
      "Key: claude-haiku-5-5",
      // The alias's Model, as Claude API keys map it.
      "Key: claude-sonnet-5-5",
      // The alias's Model.
      "Key: claude-opus-5-5",
      // Nothing maps it.
      "Key: claude-sonnet-4-5",
    ]);
    // Recorded with the Model that served.
    expect(await recordedModels(office, 4)).toEqual([
      "Key: claude-haiku-5-5",
      "Key: claude-sonnet-5-5",
      "Key: claude-opus-5-5",
      "Key: claude-sonnet-4-5",
    ]);
  });

  it("is a kind's own mapping of the name asked for, before the alias's", async () => {
    const office = await setUp({ Key: "Claude" });
    await office.map("opus", "claude-opus-5-5");
    await office.map("opus", "claude-opus-4-5", claudeKeys);
    // A mapping for subscriptions does not apply to an API key.
    await office.map("claude-opus-5-5", "claude-haiku-5-5", {
      aiProvider: "Claude",
      accountType: "oauth",
    });

    expect((await office.send("opus")).status).toBe(200);
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual([
      "Key: claude-opus-4-5",
      "Key: claude-opus-5-5",
    ]);
  });

  it("is the forced Model before a Combo slot's, which comes before a mapping", async () => {
    const office = await setUp(
      { Key: "Claude", Spare: "Claude" },
      { combo: [["Spare", "claude-opus-4-5"]] },
    );
    await office.map("claude-opus-5-5", "claude-sonnet-5-5", claudeKeys);

    // The Combo for Opus serves from its slot, with its slot's Model.
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    await office.force("Spare", "claude-haiku-5-5");
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    // Another family goes to the strategy, mapped as its kind maps it.
    expect((await office.send("claude-sonnet-4-5")).status).toBe(200);

    expect(office.sent).toEqual([
      "Spare: claude-opus-4-5",
      "Spare: claude-haiku-5-5",
      "Key: claude-sonnet-4-5",
    ]);
  });
});

describe("routing by the Model sent", () => {
  it("routes an alias as the Model it stands for, to that AI Provider's accounts", async () => {
    const office = await setUp({ Key: "Claude", Grok: "Grok" });
    await office.map("fast", "grok-4");

    const response = await office.send("fast");
    expect(response.status).toBe(200);
    // Grok's answer, translated back to Anthropic's format.
    expect(await response.json()).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "Grok answers." }],
    });
    expect(office.sent).toEqual(["Grok: grok-4"]);
    expect(await recordedModels(office, 1)).toEqual(["Grok: grok-4"]);
  });

  it("lets a kind's mapping serve a Model of another AI Provider", async () => {
    const office = await setUp({ Key: "Claude" });
    // No ChatGPT account: nothing can serve it.
    expect((await office.send("gpt-5-codex")).status).toBe(503);

    await office.map("gpt-5-codex", "claude-sonnet-5-5", claudeKeys);
    expect((await office.send("gpt-5-codex")).status).toBe(200);
    expect(office.sent).toEqual(["Key: claude-sonnet-5-5"]);
  });

  it("judges an account's capacity by the family of the Model it is sent", async () => {
    const office = await setUp({ Key: "Claude", Spare: "Claude" });
    const key = await office.accounts.select({
      agentTool: null,
      forcedAccount: "Key",
    });
    if (key === undefined) {
      throw new Error("No account Key.");
    }
    // Key is out of Opus for the day, but has Sonnet left.
    await office.accounts.report(key, {
      kind: "rate_limited",
      until: new Date(start + 24 * 60 * 60 * 1000),
      modelFamily: "claude-opus",
    });
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual(["Spare: claude-opus-5-5"]);

    // Forced to Sonnet, Key serves Opus requests again, with Sonnet.
    await office.force("Key", "claude-sonnet-5-5");
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.at(-1)).toBe("Key: claude-sonnet-5-5");
  });

  it("sends an account the Owner forces with a header its own forced Model", async () => {
    const office = await setUp({ Key: "Claude", Spare: "Claude" });
    await office.force("Spare", "claude-haiku-5-5");
    const response = await fetch(
      `${office.gateway.url}${served.request.path}`,
      {
        method: "POST",
        headers: {
          ...served.request.headers,
          "x-api-key": gatewayKey,
          "x-ai-office-account": "Spare",
        },
        body: served.request.body,
      },
    );
    expect(response.status).toBe(200);
    expect(office.sent).toEqual(["Spare: claude-haiku-5-5"]);
  });
});

describe("an AI Account's forced Model", () => {
  it("is one of its own AI Provider's, and is told as a change", async () => {
    const office = await setUp({ Key: "Claude", Grok: "Grok" });
    const refused = await office.accounts
      .update(office.ids["Key"] ?? "", { forcedModel: "grok-4" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AiAccountError);
    expect((refused as AiAccountError).code).toBe(
      aiAccountErrorCodes.forcedModelMismatch,
    );
    expect((refused as AiAccountError).message).toBe(
      "grok-4 is Grok's, but Key is a Claude account.",
    );
    // A name of no known AI Provider may be forced: a custom endpoint's.
    expect(
      await office.accounts.update(office.ids["Grok"] ?? "", {
        forcedModel: "my-local-model",
      }),
    ).toMatchObject({ forcedModel: "my-local-model" });
    expect(
      await office.accounts.update(office.ids["Grok"] ?? "", {
        forcedModel: null,
      }),
    ).toMatchObject({ forcedModel: null });
  });
});
