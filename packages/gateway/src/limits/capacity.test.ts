// Model-capacity routing and usage throttling (PRD FR-38), through a real
// Gateway in memory: a rate limit for one model family leaves the
// account's other families be; optional five-hour and weekly pacing gates
// hold back an account ahead of its pace; and when nothing is left the
// caller gets a 429 for capacity, a 529 for throttling, or a 503.
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  defaultUsageThrottlingSettings,
  type UsageThrottlingSettings,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { readFixture } from "../fixtures.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type ReceivedRequest,
  type RunningGateway,
} from "../test-support.ts";
import { limitedModelFamily, outcomeOf } from "./detect.ts";

const fixture = (name: string) =>
  readFixture(
    fileURLToPath(new URL(`../../fixtures/limits/${name}`, import.meta.url)),
  );
// Written by hand (#45 will record real ones): a Claude subscription's
// weekly Opus limit, and Google's per-model quota.
const opusLimit = await fixture("anthropic-opus-weekly-limit.json");
const geminiQuota = await fixture("gemini-model-quota.json");
const served = await fixture("anthropic-served.json");

const encryptor = encryptorFromKey(Buffer.alloc(32, 57));
const start = Date.parse("2026-10-09T12:00:00.000Z");
const minute = 60 * 1000;
const hour = 60 * minute;

describe("a rate limit for one model family", () => {
  it("is told apart from one for the whole account", () => {
    const now = new Date(start);
    expect(
      outcomeOf(
        {
          status: opusLimit.response.status,
          headers: new Headers(opusLimit.response.headers),
          body: opusLimit.response.body,
        },
        now,
      ),
    ).toEqual({
      kind: "rate_limited",
      // The weekly limit's reset: Monday 09:00.
      until: new Date("2026-10-12T09:00:00.000Z"),
      modelFamily: "claude-opus",
    });
    expect(
      outcomeOf(
        {
          status: geminiQuota.response.status,
          headers: new Headers(geminiQuota.response.headers),
          body: geminiQuota.response.body,
        },
        now,
      ),
    ).toEqual({
      kind: "rate_limited",
      until: new Date(start + 23_000),
      modelFamily: "gemini-2.5-pro",
    });
    // An Anthropic rate limit saying nothing of a family limits the account.
    expect(
      limitedModelFamily(
        new Headers({
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        }),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      limitedModelFamily(
        new Headers({
          "anthropic-ratelimit-unified-representative-claim":
            "seven_day_sonnet",
        }),
        undefined,
      ),
    ).toBe("claude-sonnet");
  });
});

type Respond = (
  request: ReceivedRequest,
  response: ServerResponse,
) => Promise<void>;

interface Office {
  readonly accounts: AiAccounts;
  readonly gateway: RunningGateway;
  readonly upstreams: Record<string, FakeUpstream>;
  readonly answers: Record<string, Respond>;
  throttling: UsageThrottlingSettings;
  at(ms: number): void;
  /** Sends a Messages request for `model`, read whole. */
  send(model: string): Promise<Response>;
  /** `name`'s answers report its five-hour and weekly windows. */
  reports(
    name: string,
    windows: {
      fiveHour?: { utilization: number; resetsAt: Date };
      weekly?: { utilization: number; resetsAt: Date };
    },
  ): Promise<void>;
}

let office: Office | undefined;

afterEach(async () => {
  await office?.gateway.close();
  for (const upstream of Object.values(office?.upstreams ?? {})) {
    await upstream.close();
  }
  office = undefined;
});

/** Key-based Claude accounts of one priority, each serving by default. */
async function setUp(names: readonly string[]): Promise<Office> {
  let time = start;
  let id = 0;
  const holder = { throttling: { ...defaultUsageThrottlingSettings } };
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    now: () => new Date(time),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    throttling: () => holder.throttling,
  });
  const answers: Record<string, Respond> = {};
  const upstreams: Record<string, FakeUpstream> = {};
  for (const name of names) {
    answers[name] = replay(served, 1_000_000);
    upstreams[name] = await startFakeUpstream((request, response) =>
      answers[name]?.(request, response),
    );
    await accounts.add({
      name,
      aiProvider: "Claude",
      accountType: "api_key",
      credential: `sk-ant-api03-${name.toLowerCase()}-capacity-0123456789`,
      endpointUrl: upstreams[name].url,
      // One priority, so the strategy chooses among them all.
      priority: 1,
    });
  }
  const gateway = await startGateway({
    accounts,
    now: () => new Date(time),
    sleep: () => Promise.resolve(),
  });
  office = {
    accounts,
    gateway,
    upstreams,
    answers,
    get throttling() {
      return holder.throttling;
    },
    set throttling(value) {
      holder.throttling = value;
    },
    at(ms) {
      time = start + ms;
    },
    async send(model) {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          ...served.request.headers,
          "x-api-key": gatewayKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    },
    async reports(name, { fiveHour, weekly }) {
      const account = await accounts.select({
        agentTool: null,
        forcedAccount: name,
      });
      if (account === undefined) {
        throw new Error(`No account ${name}.`);
      }
      await accounts.report(
        account,
        { kind: "served" },
        {
          ...(fiveHour === undefined ? {} : { five_hour: fiveHour }),
          ...(weekly === undefined ? {} : { weekly }),
        },
      );
    },
  };
  return office;
}

const received = (office: Office, name: string) =>
  office.upstreams[name]?.received.length ?? 0;

/** Answers Opus requests with the weekly Opus limit, others as served. */
const opusLimited: Respond = (request, response) =>
  (JSON.parse(request.body) as { model: string }).model.startsWith(
    "claude-opus",
  )
    ? replay(opusLimit, 1_000_000)(request, response)
    : replay(served, 1_000_000)(request, response);

describe("the model-capacity filter", () => {
  it("leaves out an account exhausted for the request's model family, and only for that family", async () => {
    const office = await setUp(["First", "Second"]);
    office.answers["First"] = opusLimited;

    // First is out of Opus: the request goes on to Second.
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect([received(office, "First"), received(office, "Second")]).toEqual([
      1, 1,
    ]);
    // Now Opus is never sent to First, which is not held back otherwise.
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(received(office, "First")).toBe(1);
    const first = (await office.accounts.list()).find(
      ({ name }) => name === "First",
    );
    expect(first?.limitReason).toBeNull();
    // With Second paused, First is left: out of Opus, it still serves
    // Sonnet and Haiku.
    const second = (await office.accounts.list()).find(
      ({ name }) => name === "Second",
    );
    await office.accounts.update(second?.id ?? "", { paused: true });
    expect((await office.send("claude-opus-5-5")).status).toBe(429);
    expect(received(office, "First")).toBe(1);
    for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
      const before = received(office, "First");
      expect((await office.send(model)).status).toBe(200);
      expect(received(office, "First")).toBe(before + 1);
    }
  });

  it("answers 429 when every account is exhausted for that family, until the first is back", async () => {
    const office = await setUp(["First", "Second"]);
    office.answers["First"] = opusLimited;
    office.answers["Second"] = opusLimited;
    // Both are tried, and the caller gets the last account's own answer.
    expect((await office.send("claude-opus-5-5")).status).toBe(429);
    const asked = received(office, "First") + received(office, "Second");

    office.at(hour);
    const refused = await office.send("claude-opus-5-5");
    expect(refused.status).toBe(429);
    // Until Monday 09:00, the weekly reset: 2 days, 20 hours on from 13:00.
    expect(refused.headers.get("retry-after")).toBe(String(68 * 60 * 60));
    expect(await refused.json()).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "Every AI Account that can serve this request has no capacity left for claude-opus models.",
      },
    });
    expect(received(office, "First") + received(office, "Second")).toBe(asked);
    // Another family is served.
    expect((await office.send("claude-sonnet-5-5")).status).toBe(200);
    // Force-resetting an account forgets its exhaustion.
    const second = (await office.accounts.list()).find(
      ({ name }) => name === "Second",
    );
    await office.accounts.resetLimits(second?.id ?? "");
    office.answers["Second"] = replay(served, 1_000_000);
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
  });
});

describe("usage throttling", () => {
  // Five-hour windows from 10:00 to 15:00: at 12:00 two fifths have gone
  // by, so up to 50% may be used (40% plus 10 points of headroom).
  const fiveHourReset = new Date(start + 3 * hour);
  const weeklyReset = new Date(start + 6 * 24 * hour);

  it("is off until the Owner turns a pacing gate on", async () => {
    const office = await setUp(["First", "Second"]);
    await office.reports("First", {
      fiveHour: { utilization: 90, resetsAt: fiveHourReset },
    });
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(received(office, "First")).toBe(1);
  });

  it("holds back an account ahead of its five-hour pace, which serves again once the pace catches up", async () => {
    const office = await setUp(["First", "Second"]);
    office.throttling = { fiveHourPacing: true, weeklyPacing: false };
    await office.reports("First", {
      fiveHour: { utilization: 70, resetsAt: fiveHourReset },
    });
    await office.reports("Second", {
      fiveHour: { utilization: 45, resetsAt: fiveHourReset },
    });
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect([received(office, "First"), received(office, "Second")]).toEqual([
      0, 1,
    ]);
    // Left alone, First is ahead of its pace until 13:00, when 60% of the
    // window has gone by.
    const second = (await office.accounts.list()).find(
      ({ name }) => name === "Second",
    );
    await office.accounts.update(second?.id ?? "", { paused: true });
    office.at(hour - minute);
    expect((await office.send("claude-opus-5-5")).status).toBe(529);
    office.at(hour);
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    expect(received(office, "First")).toBe(1);
  });

  it("answers 529 when every account is ahead of its pace, until the first catches up", async () => {
    const office = await setUp(["First", "Second"]);
    office.throttling = { fiveHourPacing: false, weeklyPacing: true };
    // A day into the week (1/7, about 14%), up to about 24% may be used.
    await office.reports("First", {
      weekly: { utilization: 60, resetsAt: weeklyReset },
    });
    await office.reports("Second", {
      weekly: { utilization: 38, resetsAt: weeklyReset },
    });
    const refused = await office.send("claude-opus-5-5");
    expect(refused.status).toBe(529);
    // Second is within pace once 28% of the week has gone by: 47.04
    // hours into it, 23.04 hours from now.
    expect(refused.headers.get("retry-after")).toBe(
      String(Math.ceil(23.04 * 60 * 60)),
    );
    expect(await refused.json()).toEqual({
      type: "error",
      error: {
        type: "overloaded_error",
        message:
          "Every AI Account that can serve this request is ahead of its weekly pace.",
      },
    });
    expect(received(office, "First") + received(office, "Second")).toBe(0);
    // Turned off, it serves at once.
    office.throttling = { fiveHourPacing: false, weeklyPacing: false };
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
  });

  it("never paces an account that reports no windows", async () => {
    const office = await setUp(["Key"]);
    office.throttling = { fiveHourPacing: true, weeklyPacing: true };
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
  });

  it("comes after the model-capacity filter: out of capacity on one, ahead of pace on the other, is a 529", async () => {
    const office = await setUp(["First", "Second"]);
    office.throttling = { fiveHourPacing: true, weeklyPacing: false };
    office.answers["First"] = opusLimited;
    expect((await office.send("claude-opus-5-5")).status).toBe(200);
    await office.reports("Second", {
      fiveHour: { utilization: 80, resetsAt: fiveHourReset },
    });
    const refused = await office.send("claude-opus-5-5");
    expect(refused.status).toBe(529);
    // Both out of capacity is a 429, whatever their pace.
    office.answers["Second"] = opusLimited;
    office.throttling = { fiveHourPacing: false, weeklyPacing: false };
    await office.send("claude-opus-5-5");
    office.throttling = { fiveHourPacing: true, weeklyPacing: false };
    expect((await office.send("claude-opus-5-5")).status).toBe(429);
  });
});

describe("when no AI Account can serve at all", () => {
  it("answers 503", async () => {
    const office = await setUp([]);
    const refused = await office.send("claude-opus-5-5");
    expect(refused.status).toBe(503);
  });
});
