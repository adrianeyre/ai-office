import { gatewayKeys, gatewayRequests } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import { describe, expect, vi } from "vitest";

import { databaseRequestLog } from "./request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  testCaller,
} from "./test-support.ts";

describe("databaseRequestLog against Postgres 18", () => {
  postgresTest("stores a record in gateway_requests", async ({ database }) => {
    const startedAt = new Date("2026-10-08T12:00:00.000Z");
    await databaseRequestLog(database.db).record({
      startedAt,
      account: "test-account",
      accountId: null,
      endpoint: "messages",
      model: "claude-sonnet-5-5",
      streamed: true,
      status: 200,
      latencyMs: 812,
      inputTokens: 27,
      outputTokens: 12,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1536,
      upstreamRequestId: "req_1",
      gatewayKeyId: null,
      agentId: "agent-1",
      floorId: "web-shop",
      ownerTool: null,
      issue: 4,
      pullRequest: 7,
      estimatedCostUsd: 0.000231,
      timeToFirstByteMs: 300,
      requestHeaders: { "x-api-key": "[REDACTED]", "user-agent": "claude-cli" },
      responseHeaders: { "content-type": "text/event-stream" },
    });
    const rows = await database.db.select().from(gatewayRequests);
    expect(rows).toEqual([
      {
        id: 1,
        startedAt,
        account: "test-account",
        aiAccountId: null,
        endpoint: "messages",
        model: "claude-sonnet-5-5",
        streamed: true,
        status: 200,
        latencyMs: 812,
        inputTokens: 27,
        outputTokens: 12,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 1536,
        upstreamRequestId: "req_1",
        gatewayKeyId: null,
        agentId: "agent-1",
        floorId: "web-shop",
        ownerTool: null,
        issue: 4,
        pullRequest: 7,
        estimatedCostUsd: 0.000231,
        keepAlive: false,
        timeToFirstByteMs: 300,
        requestHeaders: {
          "x-api-key": "[REDACTED]",
          "user-agent": "claude-cli",
        },
        responseHeaders: { "content-type": "text/event-stream" },
        session: null,
      },
    ]);
  });

  postgresTest(
    "records a request through the Gateway",
    async ({ database }) => {
      const upstream = await startFakeUpstream((_request, response) => {
        response.writeHead(200, {
          "content-type": "application/json",
          "request-id": "req_2",
        });
        response.end(
          JSON.stringify({
            type: "message",
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
        );
      });
      // The Owner tool's key the test calls with (`testCaller`).
      await database.db.insert(gatewayKeys).values({
        id: testCaller.keyId,
        kind: "owner_tool",
        name: testCaller.name,
        keyHash: "0".repeat(64),
        hint: "aio_gk_test",
        createdAt: new Date(),
      });
      const gateway = await startGateway({
        upstream,
        requestLog: databaseRequestLog(database.db),
      });
      try {
        await (
          await fetch(`${gateway.url}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": gatewayKey,
            },
            body: JSON.stringify({ model: "claude-haiku-5-5" }),
          })
        ).text();
        await vi.waitFor(async () => {
          expect(await database.db.select().from(gatewayRequests)).toHaveLength(
            1,
          );
        });
        const [row] = await database.db.select().from(gatewayRequests);
        expect(row).toMatchObject({
          account: "test-account",
          endpoint: "messages",
          model: "claude-haiku-5-5",
          streamed: false,
          status: 200,
          inputTokens: 5,
          outputTokens: 2,
          cacheReadInputTokens: null,
          upstreamRequestId: "req_2",
          gatewayKeyId: "test-key",
          agentId: null,
          floorId: null,
          ownerTool: "test-tool",
        });
      } finally {
        await gateway.close();
        await upstream.close();
      }
    },
  );
});
