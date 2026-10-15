// Prompt-cache keep-alive (PRD FR-39): while it is on, an Agent session's
// latest cached Messages request is sent again as a minimal request
// (`max_tokens: 0`) a minute before its cache would expire, so a pause
// does not cost a whole new cache write. Only active sessions are kept
// warm, each stops once its Agent has been idle for the idle time, each AI
// Account gets a bounded number an hour, and every keep-alive is recorded
// as a request, marked as one. With a fake clock and a fake AI Provider.
import type { PromptCacheKeepAliveSettings } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { GatewayAccount } from "../gateway.ts";
import type { AccountOutcome } from "../limits/detect.ts";
import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
} from "../test-support.ts";
import { createAgentWork } from "../work.ts";
import {
  createPromptCacheKeepAlive,
  keepAliveRequestOf,
  type ObservedRequest,
  type PromptCacheKeepAlive,
} from "./keep-alive.ts";

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const start = Date.parse("2026-10-10T12:00:00.000Z");

const maxId = "00000000-0000-4000-8000-000000000001";
const consoleId = "00000000-0000-4000-8000-000000000002";
const accessToken = "sk-ant-oat01-keepaliveaccesstoken-0123456789";
const apiKey = "sk-ant-api03-keepaliveconsolekey-0123456789";

const max: GatewayAccount = {
  id: maxId,
  name: "Max",
  apiKey: accessToken,
  baseUrl: "https://api.anthropic.com",
  authorization: "bearer",
  betas: ["oauth-2025-04-20"],
};
const console_: GatewayAccount = {
  id: consoleId,
  name: "Console",
  apiKey,
  baseUrl: "https://api.anthropic.com/",
};

/** Claude Code's conversation: cached system prompt and last message. */
const conversation = {
  model: "claude-opus-5-5",
  max_tokens: 32_000,
  stream: true,
  thinking: { type: "adaptive" },
  system: [
    {
      type: "text",
      text: "You are the coder.",
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: [
    { role: "user", content: "Fix issue 42." },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "Tests: 120 passed.",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ],
};

/** The headers Claude Code's request was sent with, credentials dropped. */
const sentHeaders = {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219",
  "user-agent": "claude-cli/2.1.0",
  accept: "text/event-stream",
};

/** An Agent's request at `ms` after 12:00, served by Max. */
const observed = (
  ms: number,
  change: Partial<ObservedRequest> = {},
): ObservedRequest => ({
  startedAt: new Date(start + ms),
  sessionKey: "key-1:session-1",
  gatewayKeyId: "key-1",
  agentId: "agent-1",
  floorId: "floor-1",
  issue: 42,
  pullRequest: null,
  accountId: maxId,
  path: "/v1/messages?beta=true",
  headers: sentHeaders,
  body: JSON.stringify(conversation),
  ...change,
});

/** A served keep-alive: nothing generated, the conversation read from cache. */
const served = () =>
  new Response(
    JSON.stringify({
      id: "msg_keepalive",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: "max_tokens",
      usage: {
        input_tokens: 3,
        output_tokens: 0,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 0,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_1" },
    },
  );

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

interface Office {
  readonly keepAlive: PromptCacheKeepAlive;
  readonly requestLog: ReturnType<typeof memoryRequestLog>;
  /** Every keep-alive sent to the AI Provider. */
  readonly sent: Sent[];
  /** What the accounts were told of each answer. */
  readonly reported: { id: string | null; outcome: AccountOutcome }[];
  /** Accounts that cannot serve now. */
  readonly unavailable: Set<string>;
  /** What the AI Provider answers next; unreachable when undefined. */
  answer: (() => Response) | undefined;
  settings: PromptCacheKeepAliveSettings;
  /** Agents paused at a Token Cap. */
  readonly capped: Set<string>;
  at(ms: number): void;
  /** Runs a round at `ms` after 12:00. */
  roundAt(ms: number): ReturnType<PromptCacheKeepAlive["run"]>;
}

function setUp(): Office {
  let time = start;
  const requestLog = memoryRequestLog();
  const sent: Sent[] = [];
  const reported: Office["reported"] = [];
  const unavailable = new Set<string>();
  const capped = new Set<string>();
  const office: Office = {
    keepAlive: createPromptCacheKeepAlive({
      accounts: {
        keepAliveAccount: (id) =>
          Promise.resolve(
            unavailable.has(id)
              ? undefined
              : [max, console_].find((account) => account.id === id),
          ),
        report(account, outcome) {
          reported.push({ id: account.id, outcome });
          return Promise.resolve();
        },
      },
      requestLog,
      settings: () => office.settings,
      pricing: {
        estimate: (_model, usage) => (usage.cacheReadInputTokens ?? 0) * 2e-7,
      },
      capCheck: ({ agentId }) =>
        Promise.resolve(
          capped.has(agentId)
            ? { message: "The Agent's daily Token Cap is reached." }
            : undefined,
        ),
      // Keep-alive sends a string URL and a JSON string body.
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: input as string,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(init?.body as string) as Record<string, unknown>,
        });
        const answer = office.answer;
        return answer === undefined
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(answer());
      },
      now: () => new Date(time),
    }),
    requestLog,
    sent,
    reported,
    unavailable,
    capped,
    answer: served,
    settings: { enabled: true, idleMinutes: 30, maxPerAccountPerHour: 60 },
    at(ms) {
      time = start + ms;
    },
    roundAt(ms) {
      office.at(ms);
      return office.keepAlive.run();
    },
  };
  return office;
}

/** The minutes after 12:00 at which keep-alives were recorded. */
const recordedAt = (office: Office) =>
  office.requestLog.records.map(
    ({ startedAt }) => (startedAt.getTime() - start) / minute,
  );

describe("a request's keep-alive", () => {
  it("is the request as sent, with max_tokens 0 and not streamed", () => {
    const kept = keepAliveRequestOf(JSON.stringify(conversation));
    expect(kept?.model).toBe("claude-opus-5-5");
    expect(kept?.ttlMs).toBe(5 * minute);
    const rest: Partial<typeof conversation> = { ...conversation };
    delete rest.stream;
    expect(JSON.parse(kept?.body ?? "")).toEqual({ ...rest, max_tokens: 0 });
  });

  it("lasts an hour only when every breakpoint does", () => {
    const withTtl = (ttls: (string | undefined)[]) =>
      keepAliveRequestOf(
        JSON.stringify({
          model: "claude-opus-5-5",
          tools: ttls.map((ttl, index) => ({
            name: `tool_${String(index)}`,
            input_schema: { type: "object" },
            cache_control:
              ttl === undefined
                ? { type: "ephemeral" }
                : { type: "ephemeral", ttl },
          })),
          messages: [{ role: "user", content: "Hi" }],
        }),
      )?.ttlMs;
    expect(withTtl(["1h", "1h"])).toBe(hour);
    expect(withTtl(["1h", "5m"])).toBe(5 * minute);
    expect(withTtl(["1h", undefined])).toBe(5 * minute);
    // Automatic caching's breakpoint, at the top level, counts too.
    expect(
      keepAliveRequestOf(
        JSON.stringify({
          model: "claude-opus-5-5",
          cache_control: { type: "ephemeral", ttl: "1h" },
          messages: [{ role: "user", content: "Hi" }],
        }),
      )?.ttlMs,
    ).toBe(hour);
  });

  it("is none for a request with nothing cached, or that max_tokens 0 cannot be sent with", () => {
    const changed = (change: Record<string, unknown>) =>
      keepAliveRequestOf(JSON.stringify({ ...conversation, ...change }));
    expect(
      keepAliveRequestOf(
        JSON.stringify({
          model: "claude-opus-5-5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      ),
    ).toBeUndefined();
    expect(
      changed({ thinking: { type: "enabled", budget_tokens: 2048 } }),
    ).toBeUndefined();
    expect(
      changed({ output_config: { format: { type: "json_schema" } } }),
    ).toBeUndefined();
    expect(changed({ tool_choice: { type: "any" } })).toBeUndefined();
    expect(
      changed({ tool_choice: { type: "tool", name: "read" } }),
    ).toBeUndefined();
    expect(changed({ tool_choice: { type: "auto" } })).toBeDefined();
    expect(changed({ output_config: { effort: "high" } })).toBeDefined();
    expect(keepAliveRequestOf("{not json")).toBeUndefined();
    expect(keepAliveRequestOf("[]")).toBeUndefined();
  });
});

describe("prompt-cache keep-alive", () => {
  it("keeps an active session's cache warm a minute before it would expire", async () => {
    const office = setUp();
    office.keepAlive.observe(observed(0));
    expect(office.keepAlive.sessions()).toBe(1);

    // The cache lasts until 12:05: nothing before 12:04.
    for (const ms of [0, 2 * minute, 4 * minute - 1]) {
      expect(await office.roundAt(ms)).toEqual({
        served: 0,
        failed: [],
        waiting: 0,
        stopped: 0,
      });
    }
    expect(office.sent).toEqual([]);

    // At 12:04: the request again, as the account presents every request.
    expect(await office.roundAt(4 * minute)).toEqual({
      served: 1,
      failed: [],
      waiting: 0,
      stopped: 0,
    });
    const rest: Partial<typeof conversation> = { ...conversation };
    delete rest.stream;
    expect(office.sent).toEqual([
      {
        url: "https://api.anthropic.com/v1/messages?beta=true",
        headers: {
          ...sentHeaders,
          accept: "application/json",
          "accept-encoding": "identity",
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        },
        body: { ...rest, max_tokens: 0 },
      },
    ]);
    expect(office.reported).toEqual([
      { id: maxId, outcome: { kind: "served" } },
    ]);

    // Recorded as a request: the Agent's, on its issue, marked as a
    // keep-alive, with what it read from the cache and what it cost.
    expect(office.requestLog.records).toEqual([
      {
        startedAt: new Date(start + 4 * minute),
        account: "Max",
        accountId: maxId,
        gatewayKeyId: "key-1",
        agentId: "agent-1",
        floorId: "floor-1",
        ownerTool: null,
        issue: 42,
        pullRequest: null,
        endpoint: "messages",
        model: "claude-opus-5-5",
        streamed: false,
        status: 200,
        latencyMs: expect.any(Number) as number,
        inputTokens: 3,
        outputTokens: 0,
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 0,
        upstreamRequestId: "req_1",
        estimatedCostUsd: 50_000 * 2e-7,
        timeToFirstByteMs: expect.any(Number) as number,
        requestHeaders: sentHeaders,
        responseHeaders: {
          "content-type": "application/json",
          "request-id": "req_1",
        },
        keepAlive: true,
      },
    ]);

    // The keep-alive read the cache at 12:04, so the next is due at 12:08.
    expect((await office.roundAt(8 * minute - 1)).served).toBe(0);
    expect((await office.roundAt(8 * minute)).served).toBe(1);
    expect(recordedAt(office)).toEqual([4, 8]);
    // No credential is ever recorded.
    expect(JSON.stringify(office.requestLog.records)).not.toContain(
      accessToken,
    );
  });

  it("stops once the session has been idle for the idle time", async () => {
    const office = setUp();
    office.keepAlive.observe(observed(0));
    // A round every 15 seconds for an hour.
    let stopped = 0;
    for (let ms = 0; ms <= hour; ms += 15 * second) {
      stopped += (await office.roundAt(ms)).stopped;
    }
    // Every four minutes while the Agent was last active under 30 minutes
    // ago; then it is let go, and nothing more is sent.
    expect(recordedAt(office)).toEqual([4, 8, 12, 16, 20, 24, 28]);
    expect(stopped).toBe(1);
    expect(office.keepAlive.sessions()).toBe(0);

    // A shorter idle time stops sooner.
    const brief = setUp();
    brief.settings = { ...brief.settings, idleMinutes: 10 };
    brief.keepAlive.observe(observed(0));
    for (let ms = 0; ms <= hour; ms += 15 * second) {
      await brief.roundAt(ms);
    }
    expect(recordedAt(brief)).toEqual([4, 8]);
  });

  it("is not sent while the Agent's own requests keep the cache warm", async () => {
    const office = setUp();
    // The Agent asks every three minutes until 12:30, then pauses.
    for (let ms = 0; ms <= 45 * minute; ms += 15 * second) {
      if (ms <= 30 * minute && ms % (3 * minute) === 0) {
        office.keepAlive.observe(observed(ms));
      }
      await office.roundAt(ms);
    }
    // Only its pause is bridged: from its last request at 12:30.
    expect(recordedAt(office)).toEqual([34, 38, 42]);
  });

  it("sends the session's latest request, not one that finished late", async () => {
    const office = setUp();
    const latest = { role: "user", content: "And issue 43." };
    const later = JSON.stringify({
      ...conversation,
      messages: [...conversation.messages, latest],
    });
    office.keepAlive.observe(observed(2 * minute, { body: later }));
    // An earlier request, finishing after it.
    office.keepAlive.observe(observed(0));
    expect((await office.roundAt(6 * minute - 1)).served).toBe(0);
    expect((await office.roundAt(6 * minute)).served).toBe(1);
    expect(office.sent[0]?.body["messages"]).toEqual([
      ...conversation.messages,
      latest,
    ]);
  });

  it("starts again with the Agent's next request after it was let go", async () => {
    const office = setUp();
    office.settings = { ...office.settings, idleMinutes: 5 };
    office.keepAlive.observe(observed(0));
    expect((await office.roundAt(4 * minute)).served).toBe(1);
    expect((await office.roundAt(5 * minute)).stopped).toBe(1);
    expect((await office.roundAt(20 * minute)).served).toBe(0);
    office.keepAlive.observe(observed(30 * minute));
    expect((await office.roundAt(34 * minute)).served).toBe(1);
    expect(recordedAt(office)).toEqual([4, 34]);
  });

  it("keeps nothing warm for sessions it never saw a cached request from", async () => {
    const office = setUp();
    office.keepAlive.observe(
      observed(0, {
        body: JSON.stringify({
          model: "claude-opus-5-5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }),
    );
    office.keepAlive.observe(
      observed(0, {
        body: JSON.stringify({
          ...conversation,
          thinking: { type: "enabled", budget_tokens: 2048 },
        }),
      }),
    );
    expect(office.keepAlive.sessions()).toBe(0);
    for (let ms = 0; ms <= 10 * minute; ms += 15 * second) {
      await office.roundAt(ms);
    }
    expect(office.sent).toEqual([]);
  });

  it("does nothing while off, and lets every session go when turned off", async () => {
    const office = setUp();
    office.settings = { ...office.settings, enabled: false };
    office.keepAlive.observe(observed(0));
    expect(office.keepAlive.sessions()).toBe(0);
    expect((await office.roundAt(4 * minute)).served).toBe(0);

    office.settings = { ...office.settings, enabled: true };
    office.keepAlive.observe(observed(5 * minute));
    office.settings = { ...office.settings, enabled: false };
    expect((await office.roundAt(9 * minute)).stopped).toBe(1);
    office.settings = { ...office.settings, enabled: true };
    expect((await office.roundAt(9 * minute)).served).toBe(0);
    expect(office.sent).toEqual([]);
  });

  it("sends each AI Account at most its number of keep-alives in any hour", async () => {
    const office = setUp();
    office.settings = { ...office.settings, maxPerAccountPerHour: 2 };
    // Three sessions on Max, one on Console.
    for (const session of ["a", "b", "c"]) {
      office.keepAlive.observe(
        observed(0, { sessionKey: `key-1:${session}`, agentId: session }),
      );
    }
    office.keepAlive.observe(
      observed(0, {
        sessionKey: "key-2:d",
        agentId: "d",
        accountId: consoleId,
      }),
    );
    // At 12:04 Max is sent two, and the third waits; Console is sent one,
    // presented with its API key.
    expect(await office.roundAt(4 * minute)).toEqual({
      served: 3,
      failed: [],
      waiting: 1,
      stopped: 0,
    });
    const perAccount = (records = office.requestLog.records) => ({
      Max: records.filter(({ account }) => account === "Max").length,
      Console: records.filter(({ account }) => account === "Console").length,
    });
    expect(perAccount()).toEqual({ Max: 2, Console: 1 });
    const toConsole = office.sent.find(({ headers }) => "x-api-key" in headers);
    expect(toConsole?.headers["x-api-key"]).toBe(apiKey);
    expect(toConsole?.headers["authorization"]).toBeUndefined();
    expect(toConsole?.url).toBe(
      "https://api.anthropic.com/v1/messages?beta=true",
    );

    // The third's cache expires at 12:05 unkept, so it is let go; Max's
    // bound holds for the rest of the hour.
    let stopped = 0;
    for (let ms = 4 * minute; ms < hour + 4 * minute; ms += 15 * second) {
      stopped += (await office.roundAt(ms)).stopped;
    }
    const firstHour = office.requestLog.records.filter(
      ({ startedAt }) => startedAt.getTime() < start + hour + 4 * minute,
    );
    expect(perAccount(firstHour).Max).toBe(2);
    // Console's own session is kept warm on its own bound: 12:04, 12:08.
    expect(perAccount(firstHour).Console).toBe(2);
    expect(stopped).toBeGreaterThanOrEqual(1);
  });

  it("waits while the account cannot serve, and lets go an Agent paused at a Token Cap", async () => {
    const office = setUp();
    office.unavailable.add(maxId);
    office.keepAlive.observe(observed(0));
    expect(await office.roundAt(4 * minute)).toEqual({
      served: 0,
      failed: [],
      waiting: 1,
      stopped: 0,
    });
    // It can serve again before the cache expires: the keep-alive goes.
    office.unavailable.delete(maxId);
    expect((await office.roundAt(4 * minute + 15 * second)).served).toBe(1);
    // Waiting does not count towards the bound: one sent, one recorded.
    expect(office.sent).toHaveLength(1);

    office.capped.add("agent-1");
    expect(await office.roundAt(8 * minute + 15 * second)).toEqual({
      served: 0,
      failed: [],
      waiting: 0,
      stopped: 1,
    });
    expect(office.keepAlive.sessions()).toBe(0);
    expect(office.sent).toHaveLength(1);
  });

  it("gives back the slots of sessions that waited for their account", async () => {
    const office = setUp();
    office.settings = { ...office.settings, maxPerAccountPerHour: 2 };
    for (const session of ["a", "b"]) {
      office.keepAlive.observe(
        observed(0, { sessionKey: `key-1:${session}`, agentId: session }),
      );
    }
    office.unavailable.add(maxId);
    expect((await office.roundAt(4 * minute)).waiting).toBe(2);
    // Neither used a slot, so both go once the account can serve.
    office.unavailable.delete(maxId);
    expect(await office.roundAt(4 * minute + 15 * second)).toEqual({
      served: 2,
      failed: [],
      waiting: 0,
      stopped: 0,
    });
  });

  it("lets the session go when a keep-alive is not served, telling the accounts", async () => {
    const office = setUp();
    office.answer = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Rate limited." },
        }),
        { status: 429, headers: { "retry-after": "120" } },
      );
    office.keepAlive.observe(observed(0));
    const report = await office.roundAt(4 * minute);
    expect(report.served).toBe(0);
    expect(report.failed).toHaveLength(1);
    expect(office.reported[0]?.outcome.kind).toBe("rate_limited");
    expect(office.requestLog.records[0]).toMatchObject({
      status: 429,
      keepAlive: true,
      inputTokens: null,
    });
    expect(office.keepAlive.sessions()).toBe(0);
    expect((await office.roundAt(4 * minute + 15 * second)).served).toBe(0);
    expect(office.sent).toHaveLength(1);

    // An unreachable AI Provider counts as a failure, recorded as a 502,
    // and the error does not hold the credential.
    const unreachable = setUp();
    unreachable.answer = undefined;
    unreachable.keepAlive.observe(observed(0));
    const failed = await unreachable.roundAt(4 * minute);
    expect(failed.failed).toHaveLength(1);
    expect(String(failed.failed[0]?.error)).not.toContain(accessToken);
    expect(unreachable.reported).toEqual([
      { id: maxId, outcome: { kind: "failed" } },
    ]);
    expect(unreachable.requestLog.records[0]).toMatchObject({
      status: 502,
      keepAlive: true,
    });
    expect(unreachable.keepAlive.sessions()).toBe(0);
  });

  it("keeps an hour's cache warm only when the idle time outlasts it", async () => {
    const hourLong = JSON.stringify({
      ...conversation,
      system: [
        {
          type: "text",
          text: "You are the coder.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: "Fix issue 42." }],
    });
    const office = setUp();
    office.keepAlive.observe(observed(0, { body: hourLong }));
    for (let ms = 0; ms <= 2 * hour; ms += minute) {
      await office.roundAt(ms);
    }
    // The cache outlives the 30 minutes' idle time on its own.
    expect(office.sent).toEqual([]);

    const patient = setUp();
    patient.settings = { ...patient.settings, idleMinutes: 90 };
    patient.keepAlive.observe(observed(0, { body: hourLong }));
    for (let ms = 0; ms <= 2 * hour; ms += minute) {
      await patient.roundAt(ms);
    }
    expect(recordedAt(patient)).toEqual([59]);
  });
});

describe("keep-alive through the Gateway", () => {
  const agentKey = "aio_gk_keepaliveagentkey00000000000000000000";

  it("is shown each Agent's served Messages request, and nothing else", async () => {
    let status = 200;
    const upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        status === 200
          ? JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [{ type: "text", text: "Done." }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          : JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "No." },
            }),
      );
    });
    const seen: ObservedRequest[] = [];
    // Ada's sandbox works #42 (pen-testing G1-1).
    const work = createAgentWork();
    work.hold("agent-1", { issue: 42 });
    const gateway = await startGateway({
      account: {
        id: maxId,
        name: "Console",
        apiKey,
        baseUrl: upstream.url,
      },
      keys: {
        authenticate: (key) =>
          Promise.resolve(
            key === agentKey
              ? {
                  kind: "agent" as const,
                  keyId: "key-1",
                  agentId: "agent-1",
                  floorId: "floor-1",
                  name: "Ada",
                }
              : key === gatewayKey
                ? { kind: "owner_tool" as const, keyId: "key-2", name: "cli" }
                : undefined,
          ),
      },
      keepAlive: {
        observe: (request) => {
          seen.push(request);
        },
      },
      work,
    });
    try {
      const send = (key: string, path = "/v1/messages?beta=true") =>
        fetch(`${gateway.url}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": key,
            "x-ai-office-session": "session-1",
            "x-ai-office-issue": "42",
          },
          body: JSON.stringify({ ...conversation, stream: false }),
        });
      expect((await send(agentKey)).status).toBe(200);
      // An Owner tool's request, a count of tokens and a refused request
      // are not kept warm.
      expect((await send(gatewayKey)).status).toBe(200);
      expect((await send(agentKey, "/v1/messages/count_tokens")).status).toBe(
        200,
      );
      status = 400;
      expect((await send(agentKey)).status).toBe(400);
      // The response is recorded once it has finished; so is the observation.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen).toHaveLength(1);
      const [request] = seen;
      expect(request).toMatchObject({
        sessionKey: "key-1:session-1",
        gatewayKeyId: "key-1",
        agentId: "agent-1",
        floorId: "floor-1",
        issue: 42,
        pullRequest: null,
        accountId: maxId,
        path: "/v1/messages?beta=true",
      });
      expect(JSON.parse(request?.body ?? "")).toEqual({
        ...conversation,
        stream: false,
      });
      // Neither the Gateway Key nor the account's key is kept with it.
      expect(JSON.stringify(request?.headers)).not.toContain(agentKey);
      expect(JSON.stringify(request?.headers)).not.toContain(apiKey);
      expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });
});
