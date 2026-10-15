import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapCheckSubject } from "./gateway.ts";
import { staticKeys } from "./keys/keys.ts";
import type { memoryRequestLog } from "./request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  testCaller,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";
import { createAgentWork } from "./work.ts";

// Token Caps at the Gateway (PRD FR-33, ADR 0001): before each of an
// Agent's calls the Gateway asks whether it is paused at a cap, and if it
// is, refuses the call with a cap error its agent tool does not retry,
// sending nothing to the AI Provider.

const agentKey = "aio_gk_adasownkeyforhersandboxcalls00000000000";
const keys = staticKeys({
  [gatewayKey]: testCaller,
  [agentKey]: {
    kind: "agent",
    keyId: "ada-key",
    agentId: "ada",
    floorId: "web-shop",
    name: "Ada",
  },
});

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;
let work = createAgentWork();

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = undefined;
  upstream = undefined;
  work = createAgentWork();
});

const message = JSON.stringify({
  type: "message",
  usage: { input_tokens: 3, output_tokens: 4 },
});

const call = (
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${gateway?.url ?? ""}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${key}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

const records = () =>
  gateway === undefined
    ? []
    : (gateway.requestLog as ReturnType<typeof memoryRequestLog>).records;

const capMessage =
  "Ada reached its own daily Token Cap (1,000 tokens), so AI Office has paused it.";

async function start(refuse: (subject: CapCheckSubject) => boolean) {
  const asked: CapCheckSubject[] = [];
  upstream = await startFakeUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(message);
  });
  gateway = await startGateway({
    upstream,
    keys,
    work,
    capCheck: (subject) => {
      asked.push(subject);
      return Promise.resolve(
        refuse(subject) ? { message: capMessage } : undefined,
      );
    },
  });
  return asked;
}

describe("Token Caps at the Gateway", () => {
  it("asks for each of an Agent's calls, with its Floor and the issue AI Office gave its work, and serves it under its cap", async () => {
    const asked = await start(() => false);
    // Ada's sandbox works #12 (pen-testing G1-1), then its run ends.
    const release = work.hold("ada", { issue: 12 });
    const response = await call(
      "/v1/messages",
      agentKey,
      { model: "claude-haiku-5-5" },
      { "x-ai-office-issue": "12" },
    );
    expect(response.status).toBe(200);
    release();
    await call(
      "/v1/messages",
      agentKey,
      { model: "claude-haiku-5-5" },
      { "x-ai-office-issue": "12" },
    );
    expect(asked).toEqual([
      { floorId: "web-shop", agentId: "ada", issue: 12 },
      { floorId: "web-shop", agentId: "ada", issue: undefined },
    ]);
    expect(upstream?.received).toHaveLength(2);
  });

  it("refuses a capped Agent's call with a cap error in Anthropic's format, sending nothing on", async () => {
    await start(() => true);
    const response = await call("/v1/messages", agentKey, {
      model: "claude-haiku-5-5",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-ai-office-refusal")).toBe("token_cap");
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "permission_error", message: capMessage },
    });
    expect(upstream?.received).toEqual([]);
    // Recorded, as the Agent's, with no account and no tokens.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(records()).toEqual([
      expect.objectContaining({
        agentId: "ada",
        floorId: "web-shop",
        status: 403,
        account: null,
        inputTokens: null,
        outputTokens: null,
      }),
    ]);
  });

  it("refuses it in OpenAI's format to an OpenAI client such as Codex or opencode", async () => {
    await start(() => true);
    const response = await call("/v1/responses", agentKey, {
      model: "gpt-5.5",
      input: "Hi",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.message).toBe(capMessage);
    expect(upstream?.received).toEqual([]);
  });

  it("never asks an Agent's caps for an Owner tool's calls", async () => {
    const asked = await start(() => true);
    const response = await call("/v1/messages", gatewayKey, {
      model: "claude-haiku-5-5",
    });
    expect(response.status).toBe(200);
    expect(asked).toEqual([]);
  });

  it("G1-3: asks for an Owner tool's calls, the Terminal's too, against the office's caps by its name, refusing it at one", async () => {
    const terminalKey = "aio_gk_theterminalsownkey000000000000000000000";
    const reached = new Set<string>();
    const asked: string[] = [];
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    gateway = await startGateway({
      upstream,
      keys: staticKeys({
        [gatewayKey]: testCaller,
        [terminalKey]: {
          kind: "owner_tool",
          keyId: "terminal-key",
          name: "Terminal",
        },
      }),
      capCheck: () => Promise.reject(new Error("Not an Agent's call.")),
      ownerToolCapCheck: (ownerTool) => {
        asked.push(ownerTool);
        return Promise.resolve(
          reached.has(ownerTool)
            ? { message: `${ownerTool} reached the office's daily Token Cap.` }
            : undefined,
        );
      },
    });
    const model = { model: "claude-haiku-5-5" };
    expect((await call("/v1/messages", gatewayKey, model)).status).toBe(200);
    reached.add("test-tool");
    const refused = await call("/v1/messages", gatewayKey, model);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-ai-office-refusal")).toBe("token_cap");
    expect(await refused.json()).toEqual({
      type: "error",
      error: {
        type: "permission_error",
        message: "test-tool reached the office's daily Token Cap.",
      },
    });
    // The Terminal is counted on its own.
    expect((await call("/v1/messages", terminalKey, model)).status).toBe(200);
    expect(asked).toEqual(["test-tool", "test-tool", "Terminal"]);
    expect(upstream.received).toHaveLength(2);
  });

  it("G1-3: refuses an Owner tool's call with a 503 when Token Caps cannot be read", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    gateway = await startGateway({
      upstream,
      keys,
      ownerToolCapCheck: () =>
        Promise.reject(new Error("The database is down.")),
    });
    const response = await call("/v1/messages", gatewayKey, {
      model: "claude-haiku-5-5",
    });
    expect(response.status).toBe(503);
    expect(upstream.received).toEqual([]);
  });

  it("asks for the Communications Agent's calls against the office's caps, refusing it at one", async () => {
    const communicationsKey =
      "aio_gk_thecommunicationsagentsdigestkey000000000";
    let reached = false;
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    gateway = await startGateway({
      upstream,
      keys: staticKeys({
        [communicationsKey]: {
          kind: "communications",
          keyId: "communications-key",
          name: "Reception",
        },
      }),
      capCheck: () => Promise.reject(new Error("Not an Agent's call.")),
      communicationsCapCheck: () =>
        Promise.resolve(
          reached
            ? {
                message:
                  "The Communications Agent reached the office's daily Token Cap (1,000 tokens).",
              }
            : undefined,
        ),
    });
    expect(
      (
        await call("/v1/messages", communicationsKey, {
          model: "claude-haiku-5-5",
        })
      ).status,
    ).toBe(200);
    reached = true;
    const refused = await call("/v1/messages", communicationsKey, {
      model: "claude-haiku-5-5",
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-ai-office-refusal")).toBe("token_cap");
    expect(upstream.received).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(records()).toEqual([
      expect.objectContaining({
        agentId: "communications",
        floorId: null,
        ownerTool: null,
        status: 200,
      }),
      expect.objectContaining({
        agentId: "communications",
        floorId: null,
        status: 403,
      }),
    ]);
  });

  it("refuses with a 503 when Token Caps cannot be read, rather than serving without them", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    gateway = await startGateway({
      upstream,
      keys,
      capCheck: () => Promise.reject(new Error("The database is down.")),
    });
    const response = await call("/v1/messages", agentKey, {
      model: "claude-haiku-5-5",
    });
    expect(response.status).toBe(503);
    expect(upstream.received).toEqual([]);
  });
});

describe("G1-2: a capped caller's calls, one at a time", () => {
  // A Token Cap is checked before a call and counted once it is recorded,
  // so each capped caller's call waits until the one before it has been
  // recorded (pen-testing G1-2).
  const communicationsKey = "aio_gk_thecommunicationsagentsdigestkey000000000";
  const both = staticKeys({
    [agentKey]: {
      kind: "agent",
      keyId: "ada-key",
      agentId: "ada",
      floorId: "web-shop",
      name: "Ada",
    },
    [communicationsKey]: {
      kind: "communications",
      keyId: "communications-key",
      name: "Reception",
    },
    [gatewayKey]: testCaller,
  });

  /** An AI Provider that answers only when told to, one call at a time. */
  async function holding() {
    const held: ServerResponse[] = [];
    const provider = await startFakeUpstream((_request, response) => {
      held.push(response);
    });
    upstream = provider;
    return {
      upstream: provider,
      held,
      answer: () => {
        const response = held.shift();
        response?.writeHead(200, { "content-type": "application/json" });
        response?.end(message);
      },
    };
  }

  it.each([
    ["an Agent's", agentKey],
    ["the Communications Agent's", communicationsKey],
    ["an Owner tool's", gatewayKey],
  ])(
    "%s next call reaches the AI Provider only once the one before has been recorded",
    async (_who, key) => {
      const provider = await holding();
      const asked: number[] = [];
      gateway = await startGateway({
        upstream: provider.upstream,
        keys: both,
        capCheck: () => {
          asked.push(records().length);
          return Promise.resolve(undefined);
        },
        communicationsCapCheck: () => {
          asked.push(records().length);
          return Promise.resolve(undefined);
        },
        ownerToolCapCheck: () => {
          asked.push(records().length);
          return Promise.resolve(undefined);
        },
      });
      const first = call("/v1/messages", key, { model: "claude-haiku-5-5" });
      await vi.waitFor(() => {
        expect(provider.held).toHaveLength(1);
      });
      const second = call("/v1/messages", key, { model: "claude-haiku-5-5" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The second waits, unasked, while the first is in flight.
      expect(upstream?.received).toHaveLength(1);
      expect(asked).toEqual([0]);
      provider.answer();
      expect((await first).status).toBe(200);
      await vi.waitFor(() => {
        expect(provider.held).toHaveLength(1);
      });
      // Asked once the first was recorded, so its tokens count.
      expect(asked).toEqual([0, 1]);
      provider.answer();
      expect((await second).status).toBe(200);
    },
  );

  it("ends a refused call's turn, so the next is asked", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(message);
    });
    let refusals = 1;
    gateway = await startGateway({
      upstream,
      keys: both,
      capCheck: () =>
        Promise.resolve(refusals-- > 0 ? { message: capMessage } : undefined),
    });
    const statuses = await Promise.all(
      [1, 2].map(
        async () =>
          (await call("/v1/messages", agentKey, { model: "claude-haiku-5-5" }))
            .status,
      ),
    );
    expect(statuses.sort()).toEqual([200, 403]);
  });

  it("sends nothing for a call whose caller leaves while it waits, and the calls after it go on", async () => {
    const provider = await holding();
    gateway = await startGateway({
      upstream: provider.upstream,
      keys: both,
      capCheck: () => Promise.resolve(undefined),
    });
    const first = call("/v1/messages", agentKey, { model: "claude-haiku-5-5" });
    await vi.waitFor(() => {
      expect(provider.held).toHaveLength(1);
    });
    const leaving = new AbortController();
    const left = fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ model: "claude-haiku-5-5" }),
      signal: leaving.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    leaving.abort();
    await left;
    const third = call("/v1/messages", agentKey, { model: "claude-haiku-5-5" });
    provider.answer();
    expect((await first).status).toBe(200);
    await vi.waitFor(() => {
      expect(provider.held).toHaveLength(1);
    });
    provider.answer();
    expect((await third).status).toBe(200);
    // The one that left reached nothing.
    expect(upstream?.received).toHaveLength(2);
  });
});
