import {
  createCommunications,
  defaultTransports,
  memoryCommunicationsStore,
  webhookTransport,
} from "@ai-office/communications";
import {
  serveFakeWebhook,
  type FakeWebhook,
} from "@ai-office/communications/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  createAiAccounts,
  createRequestHistory,
  memoryAiAccountStore,
  memoryRequestHistoryStore,
} from "@ai-office/gateway";
import { createNotices, memoryStores } from "@ai-office/orchestrator";
import { createRedactor } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.ts";
import { testEncryptor } from "./test-support.ts";

// G1 (issue #195), "AI Gateway and credentials": redaction everywhere
// FR-5 and FR-95 name, wired as `server.ts` wires it: one redactor for
// everything AI Office writes, every AI Account credential registered with
// it as the process opens it (`onCredential`), and anything shaped like a
// credential removed by pattern. The credential here is an
// Anthropic-compatible endpoint's key of no known shape, so only its
// registration can remove it. These probes keep holding that, once the
// Gateway has opened the account, neither it nor a Gateway Key reaches a
// log line, the Activity Feed, a Notice, the request history's bodies as
// they are read back, or what a Connection is sent.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/G1.md.

/** An endpoint's key that matches no credential pattern. */
const endpointKey = "cmpk.Q7mZt2Rx9LwV4pNc8yHd";
/** A Gateway Key, which the patterns know by its prefix. */
const gatewayKey = "aio_gk_asandboxkeythatleakedintoatitle000000";
const leak = `left in a title: ${endpointKey} and ${gatewayKey}`;

const webhooks: FakeWebhook[] = [];
afterEach(async () => {
  await Promise.all(webhooks.splice(0).map((server) => server.close()));
});

async function office() {
  const redactor = createRedactor();
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    secrets: [],
    redactor,
    destination: { write: (line) => lines.push(line) },
  });
  const eventStore = memoryEventStore();
  const bus = createEventBus({ store: eventStore, redactor });
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor: testEncryptor,
    events: bus,
    onCredential: (credential) => {
      redactor.register(credential);
    },
  });
  await accounts.add({
    name: "Team endpoint",
    aiProvider: "Anthropic-compatible",
    accountType: "endpoint",
    endpointUrl: "https://llm.example.com",
    credential: endpointKey,
  });
  // The Gateway opens it to serve a request.
  const chosen = await accounts.select({ agentTool: null });
  expect(chosen?.apiKey).toBe(endpointKey);
  return { redactor, lines, logger, bus, eventStore, accounts };
}

describe("redaction of AI Account credentials and Gateway Keys", () => {
  it("a credential the Gateway has opened, and any Gateway Key, never reach a log line, the Activity Feed or a Notice", async () => {
    const { redactor, lines, logger, bus, eventStore } = await office();
    logger.warn(
      { err: new Error(leak), detail: { note: leak } },
      `The AI Provider said: ${leak}`,
    );
    const stores = memoryStores();
    const notices = createNotices({
      store: stores.notices,
      events: bus,
      redactor,
    });
    await notices.raise({ kind: "action", title: leak, floorId: "web-shop" });
    await bus.publish({
      type: "notice.raised",
      version: 1,
      noticeId: "n-1",
      kind: "info",
      title: leak,
    });
    const written = [
      ...lines,
      JSON.stringify(eventStore.events),
      JSON.stringify(await notices.open()),
    ].join("\n");
    expect(written).toContain("[REDACTED]");
    expect(written).not.toContain(endpointKey);
    expect(written).not.toContain(gatewayKey);
  });

  it("request history bodies are sealed at rest and redacted as they are read back", async () => {
    const { redactor } = await office();
    const store = memoryRequestHistoryStore();
    const history = createRequestHistory({
      store,
      encryptor: testEncryptor,
      redactor,
    });
    await history.record({
      startedAt: new Date(),
      account: "Team endpoint",
      accountId: null,
      gatewayKeyId: "ada-key",
      agentId: "ada",
      floorId: "web-shop",
      ownerTool: null,
      issue: 4,
      pullRequest: null,
      endpoint: "messages",
      model: "claude-haiku-5-5",
      streamed: false,
      status: 401,
      latencyMs: 3,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      upstreamRequestId: null,
      estimatedCostUsd: null,
      timeToFirstByteMs: null,
      requestHeaders: { authorization: `Bearer ${gatewayKey}` },
      responseHeaders: {},
      bodies: { request: leak, response: leak, truncated: false },
    });
    const [listed] = (await history.list({ limit: 10 })).requests;
    const detail = await history.get(listed?.id ?? 0);
    const shown = JSON.stringify(detail);
    expect(shown).not.toContain(endpointKey);
    expect(shown).not.toContain(gatewayKey);
    expect(detail?.bodies?.request).toContain("[REDACTED]");
  });

  it("what a Connection is sent passes the same redaction (FR-95)", async () => {
    const { redactor, bus } = await office();
    const webhook = await serveFakeWebhook();
    webhooks.push(webhook);
    const communications = createCommunications({
      store: memoryCommunicationsStore(),
      events: bus,
      encryptor: testEncryptor,
      transports: {
        ...defaultTransports(),
        webhook: webhookTransport({ timeoutMs: 2000 }),
      },
      publicUrl: "https://office.example.com",
      floorName: () => Promise.resolve("Web shop"),
      // The Notice as a store that did not redact it would give it.
      notice: (id) =>
        Promise.resolve({
          id,
          kind: "action" as const,
          title: leak,
          floorId: "web-shop",
          issue: null,
          pullRequest: null,
          ciRunUrl: null,
          links: [],
        }),
      raiseNotice: () => Promise.resolve({ id: "n-failing" }),
      defaultModels: () => Promise.resolve({ Claude: "claude-opus-5-5" }),
      agentName: () => "Grace",
      redactor,
    });
    await communications.add({
      type: "webhook",
      name: "Team chat",
      credentials: { url: webhook.url },
    });
    await bus.publish({
      type: "notice.raised",
      version: 1,
      noticeId: "n-1",
      kind: "action",
      title: leak,
      floorId: "web-shop",
    });
    await communications.takeIn();
    await communications.takeIn();
    expect(await communications.deliverDue()).toBe(1);
    const sent = JSON.stringify(webhook.received.map(({ body }) => body));
    expect(sent).toContain("[REDACTED]");
    expect(sent).not.toContain(endpointKey);
    expect(sent).not.toContain(gatewayKey);
  });
});
