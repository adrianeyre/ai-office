// Contract tests (PRD §9): every recorded fixture is replayed through the
// Gateway against a fake AI Provider that gives the recorded response. The
// response must arrive exactly as recorded and its usage must be recorded.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readFixture } from "./fixtures.ts";
import type { GatewayRequestRecord } from "./request-log.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  accountKey,
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";

const fixturesFolder = fileURLToPath(
  new URL("../fixtures/anthropic/", import.meta.url),
);

type Expected = Pick<
  GatewayRequestRecord,
  | "endpoint"
  | "model"
  | "streamed"
  | "status"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadInputTokens"
  | "cacheCreationInputTokens"
  | "upstreamRequestId"
>;

// What each fixture must be recorded as. A new fixture needs an entry here.
const expectations: Record<string, Expected> = {
  "messages.json": {
    endpoint: "messages",
    model: "claude-sonnet-5-5",
    streamed: false,
    status: 200,
    inputTokens: 14,
    outputTokens: 5,
    cacheReadInputTokens: 2048,
    cacheCreationInputTokens: 0,
    upstreamRequestId: "req_011CWgatewayMessages01",
  },
  "messages-streaming.json": {
    endpoint: "messages",
    model: "claude-sonnet-5-5",
    streamed: true,
    status: 200,
    inputTokens: 27,
    outputTokens: 12,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 1536,
    upstreamRequestId: "req_011CWgatewayStreaming01",
  },
  "messages-streaming-tool-use.json": {
    endpoint: "messages",
    model: "claude-opus-5-5",
    streamed: true,
    status: 200,
    inputTokens: 3,
    outputTokens: 58,
    cacheReadInputTokens: 40960,
    cacheCreationInputTokens: 120,
    upstreamRequestId: "req_011CWgatewayToolUse01",
  },
  "messages-streaming-overloaded.json": {
    endpoint: "messages",
    model: "claude-sonnet-5-5",
    streamed: true,
    status: 200,
    inputTokens: 410,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    upstreamRequestId: "req_011CWgatewayOverloaded01",
  },
  "messages-rate-limited.json": {
    endpoint: "messages",
    model: "claude-sonnet-5-5",
    streamed: false,
    status: 429,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    upstreamRequestId: "req_011CWgatewayRateLimited01",
  },
  "count-tokens.json": {
    endpoint: "count_tokens",
    model: "claude-sonnet-5-5",
    streamed: false,
    status: 200,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    upstreamRequestId: "req_011CWgatewayCountTokens01",
  },
};

const fixtureNames = (await readdir(fixturesFolder))
  .filter((name) => name.endsWith(".json"))
  .sort();

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
});

describe("the Anthropic fixtures", () => {
  it("each have an expectation, and each expectation a fixture", () => {
    expect(fixtureNames).toEqual(Object.keys(expectations).sort());
  });

  // Small chunks split events, lines and multi-byte characters; one chunk
  // is the whole body at once.
  describe.each(fixtureNames)("%s", (name) => {
    it.each([1, 7, 1_000_000])(
      "arrives intact through the Gateway and its usage is recorded (%i-byte chunks)",
      async (chunkSize) => {
        const fixture = await readFixture(`${fixturesFolder}${name}`);
        upstream = await startFakeUpstream(replay(fixture, chunkSize));
        const requestLog = memoryRequestLog();
        gateway = await startGateway({ upstream, requestLog });

        const response = await fetch(`${gateway.url}${fixture.request.path}`, {
          method: fixture.request.method,
          headers: {
            ...fixture.request.headers,
            // The caller's Gateway Key never reaches the AI Provider.
            "x-api-key": gatewayKey,
          },
          body: fixture.request.body,
        });

        // The response, exactly as the AI Provider sent it.
        expect(response.status).toBe(fixture.response.status);
        for (const [header, value] of Object.entries(
          fixture.response.headers,
        )) {
          expect(response.headers.get(header), header).toBe(value);
        }
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          Buffer.from(fixture.response.body, "utf8"),
        );

        // The request, exactly as the caller sent it, with the account's key.
        expect(upstream.received).toHaveLength(1);
        const [received] = upstream.received;
        expect(received?.url).toBe(fixture.request.path);
        expect(received?.body).toBe(fixture.request.body);
        for (const [header, value] of Object.entries(fixture.request.headers)) {
          if (header !== "accept-encoding") {
            expect(received?.headers[header], header).toBe(value);
          }
        }
        expect(received?.headers["x-api-key"]).toBe(accountKey);
        expect(JSON.stringify(received?.headers)).not.toContain(gatewayKey);

        await vi.waitFor(() => {
          expect(requestLog.records).toHaveLength(1);
        });
        const [record] = requestLog.records;
        expect(record).toMatchObject({
          ...expectations[name],
          account: "test-account",
        });
        expect(record?.latencyMs).toBeGreaterThanOrEqual(0);
      },
    );
  });
});
