// Contract tests for rate limits (PRD FR-38, FR-39, §5 scenario 6): the
// recorded 429 and 529 answers are replayed through a real Gateway serving
// from real AI Accounts. A rate-limited or overloaded account is held back
// until its reset and the request falls back to the next account; when
// every account is held back the caller gets the specified error (429 for
// capacity, 529 for throttling, 503 for none); failures are retried with
// exponential backoff and open the account's circuit breaker.
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import {
  createEventBus,
  memoryEventStore,
  type EventOfType,
} from "@ai-office/events";
import {
  defaultGatewayRetrySettings,
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

const fixture = (name: string) =>
  readFixture(
    fileURLToPath(new URL(`../../fixtures/limits/${name}`, import.meta.url)),
  );
const rateLimited = await fixture("anthropic-rate-limited.json");
const overloaded = await fixture("anthropic-overloaded.json");
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

const encryptor = encryptorFromKey(Buffer.alloc(32, 21));
// The fixtures' rate limit resets at 12:01:00, 60 seconds on.
const start = Date.parse("2026-10-09T12:00:00.000Z");

type Respond = (
  request: ReceivedRequest,
  response: ServerResponse,
) => Promise<void>;

interface Office {
  readonly accounts: AiAccounts;
  readonly gateway: RunningGateway;
  readonly requestLog: ReturnType<typeof memoryRequestLog>;
  /** Each account's AI Provider, by the account's name. */
  readonly upstreams: Record<string, FakeUpstream>;
  readonly ids: Record<string, string>;
  /** What each account answers next, by its name. */
  readonly answers: Record<string, Respond>;
  readonly limitEvents: EventOfType<"ai_account.limit_changed">[];
  /** Each wait before an account was tried again. */
  readonly sleeps: number[];
  settings: GatewayRetrySettings;
  /** Sets the clock this far after the start. */
  at(ms: number): void;
  /**
   * Sends the fixtures' request through the Gateway; the answer is read
   * whole, so no connection is left open.
   */
  send(headers?: Record<string, string>): Promise<Response>;
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
 * Key-based Claude accounts, one per entry, in priority order (1, 2, …),
 * each answering with its fixture.
 */
async function setUp(
  initial: Record<string, Fixture>,
  aiProvider = "Claude",
): Promise<Office> {
  let time = start;
  let id = 0;
  const bus = createEventBus({ store: memoryEventStore() });
  const limitEvents: EventOfType<"ai_account.limit_changed">[] = [];
  bus.subscribe(({ event }) => {
    if (event.type === "ai_account.limit_changed") {
      limitEvents.push(event);
    }
  });
  const holder = { settings: { ...defaultGatewayRetrySettings } };
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: bus,
    now: () => new Date(time),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    retries: () => holder.settings,
  });
  const answers: Record<string, Respond> = {};
  const upstreams: Record<string, FakeUpstream> = {};
  const ids: Record<string, string> = {};
  let priority = 0;
  for (const [name, answer] of Object.entries(initial)) {
    answers[name] = replay(answer, 1_000_000);
    upstreams[name] = await startFakeUpstream((request, response) =>
      answers[name]?.(request, response),
    );
    const account = await accounts.add({
      name,
      aiProvider: aiProvider as "Claude",
      accountType: "api_key",
      credential: `sk-ant-api03-${name.toLowerCase()}-limits-0123456789`,
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
    now: () => new Date(time),
    retries: () => holder.settings,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  office = {
    accounts,
    gateway,
    requestLog,
    upstreams,
    ids,
    answers,
    limitEvents,
    sleeps,
    get settings() {
      return holder.settings;
    },
    set settings(value) {
      holder.settings = value;
    },
    at(ms) {
      time = start + ms;
    },
    async send(headers = {}) {
      const response = await fetch(`${gateway.url}${served.request.path}`, {
        method: "POST",
        headers: {
          ...served.request.headers,
          "x-api-key": gatewayKey,
          ...headers,
        },
        body: served.request.body,
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    },
  };
  return office;
}

const received = (office: Office, name: string) =>
  office.upstreams[name]?.received.length ?? 0;

const accountNamed = async (office: Office, name: string) =>
  (await office.accounts.list()).find((account) => account.name === name);

describe("a rate-limited or overloaded AI Account", () => {
  it.each([
    {
      answer: rateLimited,
      reason: "rate_limited",
      // The input-tokens limit, the latest with nothing left, resets at
      // 12:01:00; retry-after says 40 seconds.
      until: "2026-10-09T12:01:00.000Z",
    },
    {
      answer: overloaded,
      reason: "overloaded",
      // No reset given: the default 30 seconds.
      until: "2026-10-09T12:00:30.000Z",
    },
  ])(
    "is held back until its reset, and the request falls back to the second account ($reason)",
    async ({ answer, reason, until }) => {
      const office = await setUp({ First: answer, Second: served });

      const response = await office.send();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(served.response.body);
      expect(received(office, "First")).toBe(1);
      expect(received(office, "Second")).toBe(1);
      // Falling back to another account does not wait.
      expect(office.sleeps).toEqual([]);

      const first = await accountNamed(office, "First");
      expect(first).toMatchObject({
        limitReason: reason,
        limitedUntil: new Date(until),
      });
      expect(office.limitEvents).toEqual([
        expect.objectContaining({
          aiAccountId: office.ids["First"],
          name: "First",
          aiProvider: "Claude",
          reason,
          until,
          // The second account still serves.
          providerAvailable: true,
        }),
      ]);
      await vi.waitFor(() => {
        expect(office.requestLog.records).toHaveLength(1);
      });
      expect(office.requestLog.records[0]).toMatchObject({
        account: "Second",
        accountId: office.ids["Second"],
        status: 200,
        inputTokens: 370,
        outputTokens: 11,
      });

      // Until its reset, the next request goes straight to the second.
      office.at(20_000);
      expect((await office.send()).status).toBe(200);
      expect(received(office, "First")).toBe(1);
      expect(received(office, "Second")).toBe(2);

      // After it, the session that fell back moves back to the first, the
      // better priority (FR-39's fallback back), and so does a new one.
      office.answers["First"] = replay(served);
      office.at(61_000);
      expect((await office.send()).status).toBe(200);
      expect(received(office, "First")).toBe(2);
      expect(received(office, "Second")).toBe(2);
      expect(
        (await office.send({ "x-ai-office-session": "another" })).status,
      ).toBe(200);
      expect(received(office, "First")).toBe(3);
      expect(received(office, "Second")).toBe(2);
      // Serving lifts the limit, and tells it.
      expect(await accountNamed(office, "First")).toMatchObject({
        limitReason: null,
        limitedUntil: null,
      });
      expect(office.limitEvents.at(-1)).toMatchObject({
        name: "First",
        reason: null,
        until: null,
        providerAvailable: true,
      });
    },
  );

  it("is lifted when its reset passes, by the minute's check", async () => {
    const office = await setUp({ First: rateLimited, Second: served });
    await office.send();
    expect(await office.accounts.checkLimits()).toEqual([]);
    office.at(60_000);
    expect(await office.accounts.checkLimits()).toEqual([office.ids["First"]]);
    expect(await accountNamed(office, "First")).toMatchObject({
      limitReason: null,
      limitedUntil: null,
    });
    expect(office.limitEvents.at(-1)).toMatchObject({
      name: "First",
      reason: null,
      providerAvailable: true,
    });
  });

  it("falls back for a translated request too, answered in the caller's format", async () => {
    const office = await setUp({ First: rateLimited, Second: served });
    const response = await fetch(`${office.gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Explain the failing test." }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toBe(
      "The test expects the old error text.",
    );
    expect(received(office, "First")).toBe(1);
    expect(received(office, "Second")).toBe(1);
  });
});

describe("when every AI Account is exhausted", () => {
  it("answers 429 for rate limits: the last account's own answer, then the Gateway's, until the soonest reset", async () => {
    const office = await setUp({ First: rateLimited, Second: rateLimited });

    const response = await office.send();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("40");
    expect(await response.text()).toBe(rateLimited.response.body);
    expect(received(office, "First")).toBe(1);
    expect(received(office, "Second")).toBe(1);
    // The AI Provider has no account left.
    expect(office.limitEvents.map((event) => event.providerAvailable)).toEqual([
      true,
      false,
    ]);

    // Now neither is tried: a capacity exclusion is a 429, until the
    // first reset.
    office.at(15_000);
    const refused = await office.send();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("45");
    expect(await refused.json()).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "Every AI Account that can serve this request is rate-limited.",
      },
    });
    expect(received(office, "First")).toBe(1);
    expect(received(office, "Second")).toBe(1);
    await vi.waitFor(() => {
      expect(office.requestLog.records).toHaveLength(2);
    });
    expect(office.requestLog.records.map(({ status }) => status)).toEqual([
      429, 429,
    ]);
  });

  it("answers 529 for overloads (throttling)", async () => {
    const office = await setUp({ First: overloaded, Second: overloaded });

    const response = await office.send();
    expect(response.status).toBe(529);
    expect(await response.text()).toBe(overloaded.response.body);
    expect(received(office, "First")).toBe(1);
    expect(received(office, "Second")).toBe(1);

    const refused = await office.send();
    expect(refused.status).toBe(529);
    expect(refused.headers.get("retry-after")).toBe("30");
    expect(await refused.json()).toMatchObject({
      error: {
        type: "overloaded_error",
        message: "Every AI Account that can serve this request is overloaded.",
      },
    });
    expect(received(office, "First") + received(office, "Second")).toBe(2);
  });

  it("checks capacity before throttling: rate-limited and overloaded is 529", async () => {
    const office = await setUp({ First: rateLimited, Second: overloaded });
    expect((await office.send()).status).toBe(529);
    // The capacity filter leaves the overloaded account, which throttling
    // then leaves out.
    const refused = await office.send();
    expect(refused.status).toBe(529);
  });

  it("answers in OpenAI's format to an OpenAI client", async () => {
    const office = await setUp({ First: rateLimited });
    await office.send();
    const refused = await fetch(`${office.gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: {
        message:
          "Every AI Account that can serve this request is rate-limited.",
        type: "rate_limit_error",
        param: null,
        code: null,
      },
    });
  });

  it("answers 503 when there is no account at all", async () => {
    const office = await setUp({});
    const response = await office.send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { type: "api_error", message: "No AI Account is available." },
    });
  });

  it("still lets an Owner tool force a held-back account, once, as a probe", async () => {
    const office = await setUp({ First: rateLimited, Second: served });
    await office.send();
    expect(received(office, "First")).toBe(1);

    // Still rate-limited: the probe gets its answer, not the second's.
    const probe = await office.send({ "x-ai-office-account": "First" });
    expect(probe.status).toBe(429);
    expect(received(office, "First")).toBe(2);
    expect(received(office, "Second")).toBe(1);

    // Its limit lifted early: the probe is served, and lifts it.
    office.answers["First"] = replay(served);
    const lifted = await office.send({ "x-ai-office-account": "First" });
    expect(lifted.status).toBe(200);
    expect(await accountNamed(office, "First")).toMatchObject({
      limitReason: null,
    });
  });
});

describe("retries and the circuit breaker", () => {
  it("retries an account that failed, waiting longer each time, as configured", async () => {
    const office = await setUp({ Only: broken });
    office.settings = {
      ...office.settings,
      attempts: 4,
      delayMs: 100,
      multiplier: 3,
    };
    const response = await office.send();
    // The last failure is sent on.
    expect(response.status).toBe(500);
    expect(received(office, "Only")).toBe(4);
    expect(office.sleeps).toEqual([100, 300, 900]);
  });

  it("tries the next account at once after a failure, and goes back to one with a wait", async () => {
    const office = await setUp({ First: broken, Second: broken });
    const response = await office.send();
    expect(response.status).toBe(500);
    // First, then Second at once; then, both tried, First again after the
    // first wait: one failure does not hold it back, and it is the better
    // priority, so the session goes back to it (FR-39's fallback back).
    expect(received(office, "First")).toBe(2);
    expect(received(office, "Second")).toBe(1);
    expect(office.sleeps).toEqual([500]);
  });

  it("answers once a retry is served", async () => {
    const office = await setUp({ Only: broken });
    let calls = 0;
    office.answers["Only"] = (request, response) => {
      calls += 1;
      return replay(calls === 1 ? broken : served)(request, response);
    };
    const response = await office.send();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(served.response.body);
    expect(office.sleeps).toEqual([500]);
  });

  it("does not retry what the request itself got wrong", async () => {
    const office = await setUp({
      First: {
        ...served,
        response: {
          status: 400,
          headers: { "content-type": "application/json" },
          body: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}',
        },
      },
      Second: served,
    });
    expect((await office.send()).status).toBe(400);
    expect(received(office, "Second")).toBe(0);
  });

  it("makes one attempt when set to", async () => {
    const office = await setUp({ First: rateLimited, Second: served });
    office.settings = { ...office.settings, attempts: 1 };
    expect((await office.send()).status).toBe(429);
    expect(received(office, "Second")).toBe(0);
  });

  it("opens an account's circuit after failures in a row, then lets one request try it after the cooldown", async () => {
    const office = await setUp({ Only: broken });
    office.settings = {
      ...office.settings,
      attempts: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownSeconds: 60,
    };
    for (let failure = 1; failure <= 3; failure += 1) {
      expect((await office.send()).status).toBe(500);
    }
    expect(await accountNamed(office, "Only")).toMatchObject({
      limitReason: "circuit_open",
      limitedUntil: new Date(start + 60_000),
    });
    expect(office.limitEvents).toEqual([
      expect.objectContaining({
        reason: "circuit_open",
        providerAvailable: false,
      }),
    ]);

    // Open: nothing is sent, and the request is a 503.
    const refused = await office.send();
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({
      error: {
        message:
          "Every AI Account that can serve this request is failing; the AI Gateway is giving them a rest.",
      },
    });
    expect(received(office, "Only")).toBe(3);

    // Half-open after the cooldown: one failure opens it again at once.
    office.at(61_000);
    expect((await office.send()).status).toBe(500);
    expect(received(office, "Only")).toBe(4);
    expect(await accountNamed(office, "Only")).toMatchObject({
      limitReason: "circuit_open",
      limitedUntil: new Date(start + 121_000),
    });

    // A success closes it: the count starts again.
    office.at(122_000);
    office.answers["Only"] = replay(served);
    expect((await office.send()).status).toBe(200);
    expect(await accountNamed(office, "Only")).toMatchObject({
      limitReason: null,
    });
    office.answers["Only"] = replay(broken);
    expect((await office.send()).status).toBe(500);
    expect(await accountNamed(office, "Only")).toMatchObject({
      limitReason: null,
    });
  });

  it("counts an account that cannot be reached as failing", async () => {
    const office = await setUp({ First: served, Second: served });
    // The first account's AI Provider is gone.
    await office.upstreams["First"]?.close();
    office.settings = { ...office.settings, circuitBreakerThreshold: 1 };
    const response = await office.send();
    expect(response.status).toBe(200);
    expect(received(office, "Second")).toBe(1);
    expect(await accountNamed(office, "First")).toMatchObject({
      limitReason: "circuit_open",
    });
  });
});
