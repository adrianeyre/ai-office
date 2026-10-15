import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  createAiAccounts,
  createRequestHistory,
  memoryAiAccountStore,
  memoryRequestHistoryStore,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import { memoryStores } from "@ai-office/orchestrator";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// G1 (issue #195), "AI Gateway and credentials": the AI Account usage
// windows and charts (FR-36, FR-43) as the web app reads them. An
// account's windows are read from its AI Provider's answers (numbers in
// `anthropic-ratelimit-unified-*` headers, `usage-windows.ts`) and, for a
// subscription, from its usage endpoint with its own token
// (`subscriptions.test.ts`, "never the key's"). This probe drives the real
// app and keeps holding that nothing credential-bearing reaches the web
// app through the analytics, the AI Accounts list or the request history.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/G1.md.

const now = new Date("2026-10-09T15:00:00.000Z");
const credential = "sk-ant-api03-theanalyticsprobesaccountkey-0000";
const range = new URLSearchParams({
  from: "2026-10-08T00:00:00.000Z",
  to: "2026-10-10T00:00:00.000Z",
}).toString();

describe("G1: AI Account usage windows and charts", () => {
  it("no analytics answer, the AI Accounts list nor the request history carries an AI Account's credential", async () => {
    const bus = createEventBus({ store: memoryEventStore() });
    const auth = await testAuth({ now: () => now });
    const accounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor: auth.encryptor,
      events: bus,
      now: () => now,
    });
    const history = createRequestHistory({
      store: memoryRequestHistoryStore(),
      encryptor: auth.encryptor,
    });
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    const server = await buildApp({
      logger: createLogger({ level: "silent", secrets: [] }),
      checkDatabase: () => Promise.resolve(true),
      webDistDir: "/nonexistent",
      auth,
      events: bus,
      stores: memoryStores(),
      github,
      requestHistory: history,
      aiAccounts: accounts,
    });
    const owner = await signIn(server);
    const added = await accounts.add({
      name: "Work",
      aiProvider: "Claude",
      accountType: "api_key",
      credential,
    });
    // An answer that reported its usage windows, as a served request does.
    const served = await accounts.select({ agentTool: null });
    if (served === undefined) {
      throw new Error("No account was chosen.");
    }
    await accounts.report(
      served,
      { kind: "served" },
      {
        five_hour: {
          utilization: 42,
          resetsAt: new Date("2026-10-09T17:00:00.000Z"),
        },
      },
    );
    await history.record({
      startedAt: new Date("2026-10-09T10:00:00.000Z"),
      account: "Work",
      accountId: added.id,
      endpoint: "messages",
      model: "claude-opus-5-5",
      streamed: false,
      status: 200,
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      upstreamRequestId: null,
      gatewayKeyId: "laptop-key",
      agentId: null,
      floorId: null,
      ownerTool: "laptop",
      issue: null,
      pullRequest: null,
      estimatedCostUsd: null,
      timeToFirstByteMs: 50,
      requestHeaders: { "x-api-key": "[REDACTED]" },
      responseHeaders: {},
    });

    const answers: string[] = [];
    for (const url of [
      `/api/analytics/series?${range}&bucket=hour`,
      `/api/analytics/series?${range}&bucket=hour&aiAccountId=${added.id}`,
      `/api/analytics/breakdown?${range}&by=ai_account`,
      `/api/analytics/insights?${range}`,
      `/api/analytics/usage-windows?${range}`,
      "/api/ai-accounts",
      "/api/gateway/requests",
    ]) {
      const response = await server.inject({ url, headers: owner.headers });
      expect(response.statusCode, url).toBe(200);
      answers.push(response.body);
    }
    // The windows did reach the chart, as numbers.
    expect(answers[4]).toContain('"utilization":42');
    for (const answer of answers) {
      expect(answer).not.toContain(credential);
      expect(answer).not.toContain("theanalyticsprobesaccountkey");
    }
    await server.close();
  });
});
