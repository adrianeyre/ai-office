// Combos through a real Gateway (PRD FR-40): a request for a Model of a
// family an enabled Combo is assigned to waterfalls through the Combo's
// slots in order, each asking for its own Model, skipping slots whose AI
// Account is paused, gone, held back or cannot serve; a disabled Combo is
// ignored, and while Combos are off (the default) no request waterfalls.
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  defaultGatewayRetrySettings,
  type AddComboRequest,
  type ComboSettings,
  type GatewayRetrySettings,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
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
import { createCombos, type Combos } from "./combos.ts";
import { memoryComboStore } from "./store.ts";

const fixture = (name: string) =>
  readFixture(
    fileURLToPath(new URL(`../../fixtures/limits/${name}`, import.meta.url)),
  );
const rateLimited = await fixture("anthropic-rate-limited.json");
const opusLimited = await fixture("anthropic-opus-weekly-limit.json");
const served = await fixture("anthropic-served.json");

/** A server error from an AI Provider. */
const broken: Fixture = {
  request: served.request,
  response: {
    status: 500,
    headers: { "content-type": "application/json" },
    body: '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
  },
};

/** Grok's answer, in OpenAI's Chat Completions format. */
const grokServed: Fixture = {
  request: served.request,
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "chatcmpl-combo",
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

const encryptor = encryptorFromKey(Buffer.alloc(32, 40));
const start = Date.parse("2026-10-10T12:00:00.000Z");

type Respond = (
  request: ReceivedRequest,
  response: ServerResponse,
) => Promise<void>;

interface Office {
  readonly accounts: AiAccounts;
  readonly combos: Combos;
  readonly gateway: RunningGateway;
  readonly requestLog: ReturnType<typeof memoryRequestLog>;
  readonly upstreams: Record<string, FakeUpstream>;
  readonly ids: Record<string, string>;
  /** What each account answers next, by its name. */
  readonly answers: Record<string, Respond>;
  /** Every request an AI Provider was sent: `account: model`, in order. */
  readonly sent: string[];
  readonly sleeps: number[];
  /** The switch for every Combo. */
  comboSettings: ComboSettings;
  retries: GatewayRetrySettings;
  at(ms: number): void;
  /** Asks the Gateway for `model`, reading the answer whole. */
  send(model: string): Promise<Response>;
  /** Adds an enabled Combo, its slots named by account. */
  combo(
    name: string,
    modelFamilies: string[],
    slots: [account: string, model: string][],
    enabled?: boolean,
  ): Promise<string>;
}

let office: Office | undefined;

afterEach(async () => {
  await office?.gateway.close();
  for (const upstream of Object.values(office?.upstreams ?? {})) {
    await upstream.close();
  }
  office = undefined;
});

/**
 * API-key accounts, one per entry, in priority order (1, 2, …), each with
 * its AI Provider (Claude unless it says) and first answer. Combos are on.
 */
async function setUp(
  initial: Record<
    string,
    Fixture | { readonly answer: Fixture; readonly aiProvider: "Grok" }
  >,
): Promise<Office> {
  let time = start;
  let id = 0;
  const bus = createEventBus({ store: memoryEventStore() });
  const holder: {
    comboSettings: ComboSettings;
    retries: GatewayRetrySettings;
  } = {
    comboSettings: { enabled: true },
    retries: { ...defaultGatewayRetrySettings },
  };
  const newId = () =>
    `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const now = () => new Date(time);
  const store = memoryAiAccountStore();
  const combos = createCombos({
    store: memoryComboStore(),
    accounts: store,
    events: bus,
    settings: () => holder.comboSettings,
    now,
    newId,
  });
  const accounts = createAiAccounts({
    store,
    encryptor,
    events: bus,
    now,
    newId,
    retries: () => holder.retries,
    combos,
  });
  const answers: Record<string, Respond> = {};
  const upstreams: Record<string, FakeUpstream> = {};
  const ids: Record<string, string> = {};
  const sent: string[] = [];
  let priority = 0;
  for (const [name, entry] of Object.entries(initial)) {
    const { answer, aiProvider } =
      "aiProvider" in entry
        ? entry
        : { answer: entry, aiProvider: "Claude" as const };
    answers[name] = replay(answer, 1_000_000);
    upstreams[name] = await startFakeUpstream((request, response) => {
      const { model } = JSON.parse(request.body) as { model: string };
      sent.push(`${name}: ${model}`);
      return answers[name]?.(request, response);
    });
    const account = await accounts.add({
      name,
      aiProvider,
      accountType: "api_key",
      credential: `sk-${name.toLowerCase()}-combo-routing-0123456789`,
      endpointUrl: upstreams[name].url,
      priority: (priority += 1),
    });
    ids[name] = account.id;
  }
  const requestLog = memoryRequestLog();
  const sleeps: number[] = [];
  const gateway = await startGateway({
    accounts,
    requestLog,
    now,
    retries: () => holder.retries,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  office = {
    accounts,
    combos,
    gateway,
    requestLog,
    upstreams,
    ids,
    answers,
    sent,
    sleeps,
    get comboSettings() {
      return holder.comboSettings;
    },
    set comboSettings(value) {
      holder.comboSettings = value;
    },
    get retries() {
      return holder.retries;
    },
    set retries(value) {
      holder.retries = value;
    },
    at(ms) {
      time = start + ms;
    },
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
    async combo(name, modelFamilies, slots, enabled = true) {
      const request: AddComboRequest = {
        name,
        modelFamilies,
        slots: slots.map(([account, model]) => ({
          aiAccountId: ids[account] ?? account,
          model,
        })),
        enabled,
      };
      return (await combos.add(request)).id;
    },
  };
  return office;
}

describe("a request for a family with an enabled Combo", () => {
  it("waterfalls through the slots in the Combo's order, each asking for its own Model", async () => {
    const office = await setUp({
      First: served,
      Second: served,
      Third: served,
    });
    // Not the priority order, and none of them the Model asked for.
    await office.combo(
      "Sonnet chain",
      ["claude-sonnet"],
      [
        ["Third", "claude-opus-5-5"],
        ["First", "claude-haiku-5-5"],
        ["Second", "claude-sonnet-4-5"],
      ],
    );
    office.answers["Third"] = replay(rateLimited);
    office.answers["First"] = replay(broken);

    const response = await office.send("claude-sonnet-5-5");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(served.response.body);
    expect(office.sent).toEqual([
      "Third: claude-opus-5-5",
      "First: claude-haiku-5-5",
      "Second: claude-sonnet-4-5",
    ]);
    // The next slot is tried at once: none of them had been tried.
    expect(office.sleeps).toEqual([]);
    await vi.waitFor(() => {
      expect(office.requestLog.records).toHaveLength(1);
    });
    // Recorded as the slot that served, with its Model.
    expect(office.requestLog.records[0]).toMatchObject({
      account: "Second",
      accountId: office.ids["Second"],
      model: "claude-sonnet-4-5",
      status: 200,
    });

    // The rate-limited slot is skipped until its reset; the one that
    // failed once is tried again first, and now serves.
    office.answers["First"] = replay(served);
    office.at(10_000);
    expect((await office.send("claude-sonnet-5-5")).status).toBe(200);
    expect(office.sent.slice(3)).toEqual(["First: claude-haiku-5-5"]);
  });

  it("gives every slot its turn, however few attempts the retry settings allow", async () => {
    const office = await setUp({
      First: broken,
      Second: broken,
      Third: served,
    });
    office.retries = { ...office.retries, attempts: 1 };
    await office.combo(
      "Opus chain",
      ["claude-opus"],
      [
        ["First", "claude-opus-5-5"],
        ["Second", "claude-opus-5-5"],
        ["Third", "claude-sonnet-5-5"],
      ],
    );

    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual([
      "First: claude-opus-5-5",
      "Second: claude-opus-5-5",
      "Third: claude-sonnet-5-5",
    ]);
  });

  it("skips slots whose AI Account is paused, deleted or held back", async () => {
    const office = await setUp({
      Paused: served,
      Deleted: served,
      Limited: rateLimited,
      Last: served,
    });
    await office.combo(
      "Opus chain",
      ["claude-opus"],
      [
        ["Paused", "claude-opus-5-5"],
        ["Deleted", "claude-opus-5-5"],
        ["Limited", "claude-opus-5-5"],
        ["Last", "claude-sonnet-5-5"],
      ],
    );
    await office.accounts.update(office.ids["Paused"] ?? "", { paused: true });
    await office.accounts.remove(office.ids["Deleted"] ?? "");

    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual([
      "Limited: claude-opus-5-5",
      "Last: claude-sonnet-5-5",
    ]);
    // Held back until its reset, the rate-limited slot is not sent the next.
    office.at(20_000);
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.slice(2)).toEqual(["Last: claude-sonnet-5-5"]);
    // Resumed, the paused account's slot is first again.
    await office.accounts.update(office.ids["Paused"] ?? "", { paused: false });
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.slice(3)).toEqual(["Paused: claude-opus-5-5"]);
  });

  it("uses one AI Account in two slots, with two Models", async () => {
    // Out of Opus for the week, the account still serves Sonnet.
    const office = await setUp({ Only: opusLimited });
    await office.combo(
      "Opus, else Sonnet",
      ["claude-opus"],
      [
        ["Only", "claude-opus-5-5"],
        ["Only", "claude-sonnet-5-5"],
      ],
    );
    office.answers["Only"] = (request, response) =>
      (request.body.includes('"claude-opus-5-5"')
        ? replay(opusLimited)
        : replay(served))(request, response);

    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual([
      "Only: claude-opus-5-5",
      "Only: claude-sonnet-5-5",
    ]);
    // Exhausted for Opus only: the next goes straight to the Sonnet slot.
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.slice(2)).toEqual(["Only: claude-sonnet-5-5"]);
  });

  it("reaches another AI Provider's account in that account's own format", async () => {
    const office = await setUp({
      Claude: rateLimited,
      Grok: { answer: grokServed, aiProvider: "Grok" },
    });
    await office.combo(
      "Sonnet, else Grok",
      ["claude-sonnet"],
      [
        ["Claude", "claude-sonnet-5-5"],
        ["Grok", "grok-4"],
      ],
    );

    const response = await office.send("claude-sonnet-5-5");
    expect(response.status).toBe(200);
    // Translated back to Anthropic's Messages format for the caller.
    expect(await response.json()).toMatchObject({
      type: "message",
      model: "grok-4",
      content: [{ type: "text", text: "Grok answers." }],
    });
    expect(office.sent).toEqual(["Claude: claude-sonnet-5-5", "Grok: grok-4"]);
    expect(office.upstreams["Grok"]?.received[0]?.url).toBe(
      "/v1/chat/completions",
    );
  });

  it("answers 429 once every slot is held back, until the first is back", async () => {
    const office = await setUp({
      First: rateLimited,
      Second: rateLimited,
      Outside: served,
    });
    await office.combo(
      "Sonnet chain",
      ["claude-sonnet"],
      [
        ["First", "claude-sonnet-5-5"],
        ["Second", "claude-sonnet-5-5"],
      ],
    );

    // The last slot's answer, as it came.
    expect((await office.send("claude-sonnet-5-5")).status).toBe(429);
    // Now the Combo is held back: an account outside it does not serve.
    office.at(1_000);
    const refused = await office.send("claude-sonnet-5-5");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(office.sent).toEqual([
      "First: claude-sonnet-5-5",
      "Second: claude-sonnet-5-5",
    ]);
    expect(office.upstreams["Outside"]?.received).toEqual([]);
  });

  it("leaves a request for another family to the strategy, with its own Model", async () => {
    const office = await setUp({ First: served, Second: served });
    await office.combo(
      "Opus chain",
      ["claude-opus"],
      [["Second", "claude-opus-5-5"]],
    );

    expect((await office.send("claude-sonnet-5-5")).status).toBe(200);
    expect(office.sent).toEqual(["First: claude-sonnet-5-5"]);
  });
});

describe("a disabled Combo", () => {
  it("is ignored: the strategy serves, with the Model asked for", async () => {
    const office = await setUp({ First: served, Second: served });
    const id = await office.combo(
      "Opus chain",
      ["claude-opus"],
      [["Second", "claude-sonnet-5-5"]],
      false,
    );

    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual(["First: claude-opus-5-5"]);

    // Enabled, it applies from the next request.
    await office.combos.update(id, { enabled: true });
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.slice(1)).toEqual(["Second: claude-sonnet-5-5"]);

    // Disabled again, it is ignored again.
    await office.combos.update(id, { enabled: false });
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.slice(2)).toEqual(["First: claude-opus-5-5"]);
  });

  it("leaves its family to another, enabled Combo", async () => {
    const office = await setUp({ First: served, Second: served });
    await office.combo(
      "Old chain",
      ["claude-opus"],
      [["First", "claude-haiku-5-5"]],
      false,
    );
    await office.combo(
      "New chain",
      ["claude-opus"],
      [["Second", "claude-sonnet-5-5"]],
    );

    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual(["Second: claude-sonnet-5-5"]);
  });
});

describe("the switch for every Combo", () => {
  it("is off by default, and turned on and off at runtime", async () => {
    const office = await setUp({ First: served, Second: served });
    await office.combo(
      "Opus chain",
      ["claude-opus"],
      [["Second", "claude-sonnet-5-5"]],
    );

    // Off: enabled or not, no Combo applies.
    office.comboSettings = { enabled: false };
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent).toEqual(["First: claude-opus-5-5"]);

    office.comboSettings = { enabled: true };
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.slice(1)).toEqual(["Second: claude-sonnet-5-5"]);

    office.comboSettings = { enabled: false };
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(office.sent.slice(2)).toEqual(["First: claude-opus-5-5"]);
  });

  it("is off when nothing turns it on", async () => {
    const bus = createEventBus({ store: memoryEventStore() });
    const store = memoryAiAccountStore();
    const accounts = createAiAccounts({ store, encryptor, events: bus });
    const { id } = await accounts.add({
      name: "Only",
      aiProvider: "Claude",
      accountType: "api_key",
      credential: "sk-only-combo-routing-0123456789",
    });
    const combos = createCombos({
      store: memoryComboStore(),
      accounts: store,
      events: bus,
    });
    await combos.add({
      name: "Opus chain",
      modelFamilies: ["claude-opus"],
      slots: [{ aiAccountId: id, model: "claude-sonnet-5-5" }],
      enabled: true,
    });
    expect(await combos.forModel("claude-opus-5-5")).toBeUndefined();
  });
});
