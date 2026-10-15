// The Decision Model through the AI Gateway (PRD FR-17, ADR 0001): Jev's
// typed questions (`POST /v1/systemone`) come with a Gateway Key like any
// model call, are attributed to the Agent that asks (FR-42), refused at its
// Token Cap (FR-33), and served only by an AI Account that answers them
// (OpenRouter's), passed through unchanged, with their tokens and their
// cost at the pricing table's price recorded.
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts } from "./accounts/accounts.ts";
import { memoryAiAccountStore } from "./accounts/store.ts";
import { readFixture, type Fixture } from "./fixtures.ts";
import { staticKeys } from "./keys/keys.ts";
import { createPricing, readPricingTable } from "./pricing/pricing.ts";
import { memoryModelPriceStore } from "./pricing/store.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";
import { createAgentWork } from "./work.ts";

const managerKey = "aio_gk_decisionsmanagerkey0000000000000000000";
const openRouterKey =
  "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";
const claudeKey = "sk-ant-api03-decisionsClaude0123456789abcdef";

const decision = await readFixture(
  fileURLToPath(
    new URL("../fixtures/openrouter/systemone.json", import.meta.url),
  ),
);

/** A Messages answer, as a Claude account would give one. */
const claudeAnswer: Fixture = {
  ...decision,
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"Claude here."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":3}}',
  },
};

describe("the Decision Model's questions through the AI Gateway", () => {
  let gateway: RunningGateway | undefined;
  const upstreams: FakeUpstream[] = [];

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    for (const upstream of upstreams.splice(0)) {
      await upstream.close();
    }
  });

  /** AI Accounts in priority order, each answering as given. */
  async function office(
    accounts: readonly {
      aiProvider: "OpenRouter" | "Claude";
      answer: Fixture;
    }[],
    options: { capped?: boolean } = {},
  ) {
    // The work AI Office opens for its own calls (pen-testing G1-1).
    const work = createAgentWork();
    const aiAccounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor: encryptorFromKey(Buffer.alloc(32, 46)),
      events: createEventBus({ store: memoryEventStore() }),
    });
    const upstreamOf: Partial<Record<string, FakeUpstream>> = {};
    for (const [index, account] of accounts.entries()) {
      const upstream = await startFakeUpstream(replay(account.answer));
      upstreams.push(upstream);
      upstreamOf[account.aiProvider] = upstream;
      await aiAccounts.add({
        name: account.aiProvider,
        aiProvider: account.aiProvider,
        accountType: "api_key",
        credential: account.aiProvider === "Claude" ? claudeKey : openRouterKey,
        endpointUrl: upstream.url,
        priority: index + 1,
      });
    }
    const requestLog = memoryRequestLog();
    gateway = await startGateway({
      accounts: aiAccounts,
      requestLog,
      keys: staticKeys({
        [managerKey]: {
          kind: "agent",
          keyId: "key-manager",
          agentId: "web-shop-manager",
          floorId: "web-shop",
          name: "Margo",
        },
      }),
      pricing: createPricing({
        table: readPricingTable(),
        store: memoryModelPriceStore(),
        events: createEventBus({ store: memoryEventStore() }),
      }),
      sleep: () => Promise.resolve(),
      work,
      ...(options.capped === true
        ? {
            capCheck: () =>
              Promise.resolve({ message: "The daily Token Cap is reached." }),
          }
        : {}),
    });
    return { requestLog, upstreamOf, url: gateway.url, work };
  }

  const ask = (url: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${managerKey}`,
        ...headers,
      },
      body: decision.request.body,
    });

  it("go to OpenRouter's API unchanged, attributed to the Agent and its issue, at Jev's price", async () => {
    // Claude's account comes first, but answers no decisions.
    const { requestLog, upstreamOf, url, work } = await office([
      { aiProvider: "Claude", answer: claudeAnswer },
      { aiProvider: "OpenRouter", answer: decision },
    ]);
    // As the Decision Model's client asks, for #14's triage.
    const triage = work.open("web-shop-manager", { issue: 14 });
    const response = await ask(url, {
      "x-ai-office-issue": "14",
      "x-ai-office-work": triage.token,
    });
    triage.close();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(decision.response.body);

    expect(upstreamOf["Claude"]?.received).toHaveLength(0);
    const [sent] = upstreamOf["OpenRouter"]?.received ?? [];
    expect(sent?.url).toBe("/api/v1/systemone");
    expect(sent?.body).toBe(decision.request.body);
    expect(sent?.headers.authorization).toBe(`Bearer ${openRouterKey}`);
    expect(JSON.stringify(sent?.headers)).not.toContain(managerKey);
    expect(sent?.headers["x-ai-office-issue"]).toBeUndefined();
    expect(sent?.headers["x-ai-office-work"]).toBeUndefined();

    await vi.waitFor(() => {
      expect(requestLog.records).toHaveLength(1);
    });
    expect(requestLog.records[0]).toMatchObject({
      endpoint: "systemone",
      account: "OpenRouter",
      model: "typesafe/jev-1.13",
      agentId: "web-shop-manager",
      floorId: "web-shop",
      issue: 14,
      status: 200,
      inputTokens: 412,
      outputTokens: 38,
    });
    // 412 input tokens at $0.042 a million, as estimates are rounded;
    // output is free.
    expect(requestLog.records[0]?.estimatedCostUsd).toBe(0.0000173);
  });

  it("are a 503 when no AI Account answers them", async () => {
    const { upstreamOf, url } = await office([
      { aiProvider: "Claude", answer: claudeAnswer },
    ]);
    const response = await ask(url);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: "No AI Account is available." },
    });
    expect(upstreamOf["Claude"]?.received).toHaveLength(0);
  });

  it("are refused at the asking Agent's Token Cap, and go nowhere", async () => {
    const { upstreamOf, url } = await office(
      [{ aiProvider: "OpenRouter", answer: decision }],
      { capped: true },
    );
    const response = await ask(url);
    expect(response.status).toBe(403);
    expect(response.headers.get("x-ai-office-refusal")).toBe("token_cap");
    expect(upstreamOf["OpenRouter"]?.received).toHaveLength(0);
  });

  it("need a Gateway Key", async () => {
    const { upstreamOf, url } = await office([
      { aiProvider: "OpenRouter", answer: decision },
    ]);
    const response = await fetch(`${url}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: decision.request.body,
    });
    expect(response.status).toBe(401);
    expect(upstreamOf["OpenRouter"]?.received).toHaveLength(0);
  });
});
