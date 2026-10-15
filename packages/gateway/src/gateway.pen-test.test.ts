import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentToolOf,
  staticAccounts,
  type AccountRequest,
  type AccountSource,
  type GatewayAccount,
} from "./gateway.ts";
import { staticKeys, type GatewayCaller } from "./keys/keys.ts";
import type { memoryRequestLog } from "./request-log.ts";
import {
  accountKey,
  gatewayKey,
  startFakeUpstream,
  startGateway,
  testCaller,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";
import { createAgentWork } from "./work.ts";

// G1 (issue #195), "AI Gateway and credentials": a Gateway Key holder (a
// sandbox's own key, position 3, or a stolen one, position 4) against the
// Owner's AI Accounts, their credentials and the attribution of their use.
// These probes drive the real Gateway (`buildGateway`, listening on
// loopback) in front of a fake AI Provider, and show:
// - G1-1 (H11), the Gateway's half: the issue and pull request a call is
//   billed to are whatever its caller names. What that does to Token Caps
//   is `apps/server/src/token-caps/enforcement.pen-test.test.ts`.
// - G1-5 (fixed): a subscription AI Account served whoever claimed its
//   agent tool's User-Agent (FR-35); now an Agent is served only as its
//   own AI Provider's agent tool.
// - G1-6 (fixed): the AI Provider's error text reached the Gateway Key
//   holder unredacted, credential and all; now no answer carries it.
// - G1-7 (fixed): an AI Provider's redirect was followed, sending the AI
//   Account's `x-api-key` and the prompt to another origin; now no
//   redirect is followed, nor passed on.
// And keep holding: session pinning is per key; only an Owner tool forces
// an account; AI Office's headers and the caller's credentials never go
// upstream; the query string cannot move a request off its account's host;
// and on the host's loopback (H19) nothing but `/health` answers without a
// Gateway Key.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/G1.md.

/** A sandbox's own key: Ada, a coder on web-shop. */
const adaKey = "aio_gk_adasownsandboxkeyforherissue0000000000";
const ada: GatewayCaller = {
  kind: "agent",
  keyId: "ada-key",
  agentId: "ada",
  floorId: "web-shop",
  name: "Ada",
};
/** Another Agent's key on another Floor. */
const graceKey = "aio_gk_gracesownsandboxkeyonthebloggers00000";
const grace: GatewayCaller = {
  kind: "agent",
  keyId: "grace-key",
  agentId: "grace",
  floorId: "blog",
  name: "Grace",
};
const keys = staticKeys({
  [gatewayKey]: testCaller,
  [adaKey]: ada,
  [graceKey]: grace,
});

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  gateway = undefined;
  upstream = undefined;
});

const message = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "Done." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 4 },
});

/** An AI Provider that answers every call with `message`. */
const answering = () =>
  startFakeUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(message);
  });

const call = (
  path: string,
  key: string | undefined,
  body: unknown = { model: "claude-haiku-5-5", max_tokens: 16, messages: [] },
  headers: Record<string, string> = {},
) =>
  fetch(`${gateway?.url ?? ""}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  });

const records = () =>
  gateway === undefined
    ? []
    : (gateway.requestLog as ReturnType<typeof memoryRequestLog>).records;

/** An account source that records what each request asked of it. */
function recordingAccounts(account: GatewayAccount): {
  source: AccountSource;
  asked: AccountRequest[];
} {
  const asked: AccountRequest[] = [];
  return {
    asked,
    source: {
      select: (request) => {
        asked.push(request);
        return Promise.resolve(account);
      },
    },
  };
}

const accountAt = (url: string): GatewayAccount => ({
  id: "work",
  name: "Work",
  apiKey: accountKey,
  baseUrl: url,
  apiFormat: "anthropic",
});

describe("G1-1 (H11): the issue a call is billed to is the caller's word", () => {
  it("regression (G1-1): an Agent's key no longer bills whatever issue and pull request its call names, or none: it bills the work AI Office gave it", async () => {
    upstream = await answering();
    const work = createAgentWork();
    gateway = await startGateway({ upstream, keys, work });
    const named = {
      "x-ai-office-issue": "99",
      "x-ai-office-pull-request": "98",
    };

    // Ada is given nothing: naming #99 (another Agent's issue on her
    // Floor) bills nothing. Before the fix it billed #99 and PR #98.
    await call("/v1/messages", adaKey, undefined, named);
    // Ada's sandbox works #12, whose pull request is #13: naming #99, and
    // naming nothing, both bill #12 and #13.
    const release = work.hold("ada", { issue: 12, pullRequest: 13 });
    await call("/v1/messages", adaKey, undefined, named);
    await call("/v1/messages", adaKey);
    // Its run has ended: nothing again.
    release();
    await call("/v1/messages", adaKey, undefined, named);
    await vi.waitFor(() => {
      expect(records()).toHaveLength(4);
    });
    expect(
      records().map(({ agentId, floorId, issue, pullRequest }) => ({
        agentId,
        floorId,
        issue,
        pullRequest,
      })),
    ).toEqual([
      { agentId: "ada", floorId: "web-shop", issue: null, pullRequest: null },
      { agentId: "ada", floorId: "web-shop", issue: 12, pullRequest: 13 },
      { agentId: "ada", floorId: "web-shop", issue: 12, pullRequest: 13 },
      { agentId: "ada", floorId: "web-shop", issue: null, pullRequest: null },
    ]);
  });

  it("G1-1: without the work AI Office gave, an Agent's calls count against no issue, whatever they name", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys });
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-issue": "99",
      "x-ai-office-pull-request": "98",
    });
    await vi.waitFor(() => {
      expect(records()).toHaveLength(1);
    });
    expect(records()[0]).toMatchObject({ issue: null, pullRequest: null });
  });

  it("G1-1: AI Office's own call bills the work it opened, with its token, for its own Agent only and only while it is open", async () => {
    upstream = await answering();
    const work = createAgentWork();
    gateway = await startGateway({ upstream, keys, work });
    const held = work.hold("ada", { issue: 12 });
    const review = work.open("ada", { issue: 14, pullRequest: 15 });
    // Ada's own token: #14 and PR #15, though her sandbox works #12.
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-work": review.token,
    });
    // Grace sending Ada's token gets nothing of it.
    await call("/v1/messages", graceKey, undefined, {
      "x-ai-office-work": review.token,
    });
    // Closed, or made up, it names nothing: Ada's held work counts.
    review.close();
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-work": review.token,
    });
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-work": "made-up",
    });
    held();
    await vi.waitFor(() => {
      expect(records()).toHaveLength(4);
    });
    expect(
      records().map(({ agentId, issue, pullRequest }) => ({
        agentId,
        issue,
        pullRequest,
      })),
    ).toEqual([
      { agentId: "ada", issue: 14, pullRequest: 15 },
      { agentId: "grace", issue: null, pullRequest: null },
      { agentId: "ada", issue: 12, pullRequest: null },
      { agentId: "ada", issue: 12, pullRequest: null },
    ]);
    // The token is never kept, nor sent on.
    for (const record of records()) {
      expect(record.requestHeaders?.["x-ai-office-work"]).not.toBe(
        review.token,
      );
    }
    for (const received of upstream.received) {
      expect(received.headers["x-ai-office-work"]).toBeUndefined();
    }
  });

  it("G1-1: an Owner tool's calls still bill the issue and pull request they name", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys, work: createAgentWork() });
    await call("/v1/messages", gatewayKey, undefined, {
      "x-ai-office-issue": "99",
      "x-ai-office-pull-request": "98",
    });
    await vi.waitFor(() => {
      expect(records()).toHaveLength(1);
    });
    expect(records()[0]).toMatchObject({
      ownerTool: "test-tool",
      floorId: null,
      issue: 99,
      pullRequest: 98,
    });
  });

  it("the Agent and Floor come from the key alone: a call cannot name another", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys });
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-agent": "grace",
      "x-ai-office-floor": "blog",
    });
    await vi.waitFor(() => {
      expect(records()).toHaveLength(1);
    });
    expect(records()[0]).toMatchObject({
      gatewayKeyId: "ada-key",
      agentId: "ada",
      floorId: "web-shop",
      ownerTool: null,
    });
  });
});

describe("session pinning and forced accounts (FR-37, FR-38)", () => {
  it("a session is pinned within the caller's own key: one sandbox cannot join another key's session", async () => {
    upstream = await answering();
    const { source, asked } = recordingAccounts(accountAt(upstream.url));
    gateway = await startGateway({ accounts: source, keys });
    await call("/v1/messages", graceKey, undefined, {
      "x-ai-office-session": "run-7",
    });
    // Ada names Grace's session, and Grace's key id as if it were part of it.
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-session": "run-7",
    });
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-session": "grace-key:run-7",
    });
    expect(asked.map(({ sessionKey }) => sessionKey)).toEqual([
      "grace-key:run-7",
      "ada-key:run-7",
      "ada-key:grace-key:run-7",
    ]);
  });

  it("only an Owner tool may force an AI Account; an Agent's choice is ignored", async () => {
    upstream = await answering();
    const { source, asked } = recordingAccounts(accountAt(upstream.url));
    gateway = await startGateway({ accounts: source, keys });
    await call("/v1/messages", adaKey, undefined, {
      "x-ai-office-account": "Work",
    });
    await call("/v1/messages", gatewayKey, undefined, {
      "x-ai-office-account": "Work",
    });
    expect(asked.map(({ forcedAccount }) => forcedAccount)).toEqual([
      null,
      "Work",
    ]);
  });
});

describe("what goes upstream with the AI Account's credential", () => {
  it("AI Office's headers and the caller's own credentials never reach the AI Provider", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys });
    await call("/v1/messages", adaKey, undefined, {
      "x-api-key": graceKey,
      cookie: "ai_office_session=stolen",
      "proxy-authorization": "Basic c2FuZGJveDpzZWNyZXQ=",
      "x-ai-office-issue": "12",
      "x-ai-office-pull-request": "13",
      "x-ai-office-session": "run-1",
      "x-ai-office-account": "Work",
    });
    const [received] = upstream.received;
    expect(received?.headers["x-api-key"]).toBe(accountKey);
    for (const name of [
      "authorization",
      "cookie",
      "proxy-authorization",
      "x-ai-office-issue",
      "x-ai-office-pull-request",
      "x-ai-office-session",
      "x-ai-office-account",
    ]) {
      expect(received?.headers[name]).toBeUndefined();
    }
    expect(JSON.stringify(received)).not.toContain(adaKey);
    expect(JSON.stringify(received)).not.toContain(graceKey);
  });

  it("the query string cannot move a request off its AI Account's host", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys });
    for (const query of [
      "?@attacker.example/",
      "?x=1#@attacker.example",
      "?//attacker.example/v1/messages",
    ]) {
      const response = await call(`/v1/messages${query}`, adaKey);
      expect(response.status).toBe(200);
    }
    expect(upstream.received.map(({ url }) => url)).toEqual([
      "/v1/messages?@attacker.example/",
      "/v1/messages?x=1",
      "/v1/messages?//attacker.example/v1/messages",
    ]);
  });

  it("the request history keeps the presented Gateway Key redacted", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys });
    await call("/v1/messages", undefined, undefined, { "x-api-key": adaKey });
    await vi.waitFor(() => {
      expect(records()).toHaveLength(1);
    });
    expect(records()[0]?.requestHeaders?.["x-api-key"]).toBe("[REDACTED]");
    expect(JSON.stringify(records()[0])).not.toContain(adaKey);
    expect(JSON.stringify(records()[0])).not.toContain(accountKey);
  });
});

describe("G1-5: a subscription serves whoever claims its agent tool's User-Agent (FR-35)", () => {
  // A Claude subscription serves only Claude Code (FR-35, "as that
  // provider's terms require"): `accounts.select` keeps it for requests
  // whose `agentTool` is "Claude Code" (`subscriptions.test.ts`, "serves
  // only Claude Code from a subscription"). The Gateway decided `agentTool`
  // from the request's User-Agent alone, which the caller sets. Fixed: an
  // Agent's claim counts only for its own AI Provider's agent tool, as AI
  // Office knows it (`servedAs`).
  const claudeCodeAgent = "claude-cli/2.1.3 (external, cli)";

  it("regression (G1-5): a plain HTTP call that says it is Claude Code is no longer told to the accounts as Claude Code", async () => {
    // The User-Agent still claims it…
    expect(agentToolOf("messages", { "user-agent": claudeCodeAgent })).toBe(
      "Claude Code",
    );
    upstream = await answering();
    const { source, asked } = recordingAccounts(accountAt(upstream.url));
    gateway = await startGateway({ accounts: source, keys });
    // Grace's Agent runs opencode (Grok), not Claude Code; her sandbox's
    // code calls the Messages API itself, with Claude Code's User-Agent.
    const response = await call("/v1/messages", graceKey, undefined, {
      "user-agent": claudeCodeAgent,
    });
    expect(response.status).toBe(200);
    // …but a key whose Agent's AI Provider is not known runs no agent tool.
    expect(asked[0]?.agentTool).toBeNull();
    // Its User-Agent still goes upstream as it was sent.
    expect(upstream.received[0]?.headers["user-agent"]).toBe(claudeCodeAgent);
  });

  it("G1-5: an Agent whose agent tool is not Claude Code is never served as Claude Code, whatever User-Agent it sends", async () => {
    upstream = await answering();
    const { source, asked } = recordingAccounts(accountAt(upstream.url));
    // Grace's key, with what AI Office knows of her: Grok, opencode.
    const graceOnGrok = { ...grace, aiProvider: "Grok" };
    gateway = await startGateway({
      accounts: source,
      keys: staticKeys({ [graceKey]: graceOnGrok }),
    });
    await call("/v1/messages", graceKey, undefined, {
      "user-agent": claudeCodeAgent,
    });
    expect(asked.map(({ agentTool }) => agentTool)).not.toContain(
      "Claude Code",
    );
  });

  it("G1-5: each agent tool is served only to an Agent whose AI Provider runs it; the Communications Agent is served as none", async () => {
    upstream = await answering();
    const { source, asked } = recordingAccounts(accountAt(upstream.url));
    const onClaude = "aio_gk_anagentonclaudeitsagenttoolclaudecode0";
    const onChatGpt = "aio_gk_anagentonchatgptitsagenttoolcodex0000";
    const onGrok = "aio_gk_anagentongrokitsagenttoolopencode0000";
    const communications = "aio_gk_thecommunicationsagentrunsnotool0000";
    const agentOn = (aiProvider: string): GatewayCaller => ({
      ...ada,
      keyId: aiProvider,
      aiProvider,
    });
    gateway = await startGateway({
      accounts: source,
      keys: staticKeys({
        [onClaude]: agentOn("Claude"),
        [onChatGpt]: agentOn("ChatGPT"),
        [onGrok]: agentOn("Grok"),
        [communications]: {
          kind: "communications",
          keyId: "communications-key",
          name: "Reception",
        },
      }),
    });
    const codex = "codex_exec/0.50.0";
    const opencode = "opencode/1.2.0";
    const responses = { model: "gpt-5.5", input: "Hi" };
    const chat = {
      model: "grok-5",
      messages: [{ role: "user", content: "Hi" }],
    };
    const claims: [string, string, unknown, string][] = [
      // Each Agent's own agent tool: served as it, as before.
      [onClaude, "/v1/messages", undefined, claudeCodeAgent],
      [onChatGpt, "/v1/responses", responses, codex],
      [onGrok, "/v1/chat/completions", chat, opencode],
      // Another AI Provider's agent tool: served as none.
      [onClaude, "/v1/responses", responses, codex],
      [onChatGpt, "/v1/messages", undefined, claudeCodeAgent],
      [onChatGpt, "/v1/chat/completions", chat, opencode],
      [onGrok, "/v1/messages", undefined, claudeCodeAgent],
      [communications, "/v1/messages", undefined, claudeCodeAgent],
    ];
    for (const [key, path, body, userAgent] of claims) {
      await call(path, key, body, { "user-agent": userAgent });
    }
    expect(asked.map(({ agentTool }) => agentTool)).toEqual([
      "Claude Code",
      "Codex",
      "opencode",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("an Owner tool, the Owner's own Claude Code, is still served as what it says it is", async () => {
    upstream = await answering();
    const { source, asked } = recordingAccounts(accountAt(upstream.url));
    gateway = await startGateway({ accounts: source, keys });
    await call("/v1/messages", gatewayKey, undefined, {
      "user-agent": claudeCodeAgent,
    });
    expect(asked[0]?.agentTool).toBe("Claude Code");
  });
});

describe("G1-6: the AI Provider's error text reaches the Gateway Key holder unredacted", () => {
  // An AI Provider (or a compatible endpoint, or a proxy in front of one)
  // that names the credential it was given in its error. AI Office's own
  // usage refresh never keeps such a body ("it is the AI Provider's, and
  // may echo the token", accounts.ts); the Gateway sends it to the caller.
  const echoing = () =>
    startFakeUpstream((request, response) => {
      const presented =
        (request.headers["x-api-key"] as string | undefined) ??
        (request.headers.authorization ?? "").replace(/^Bearer /, "");
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: `This key is not allowed this model: ${presented}`,
          },
        }),
      );
    });

  it("regression (G1-6): the caller no longer gets the AI Account's credential back, passed through or translated", async () => {
    upstream = await echoing();
    gateway = await startGateway({ upstream, keys });
    const passedThrough = await call("/v1/messages", adaKey);
    expect(passedThrough.status).toBe(401);
    const passedText = await passedThrough.text();
    expect(passedText).not.toContain(accountKey);
    // The AI Provider's error is still sent, its credential redacted.
    expect(passedText).toContain(
      "This key is not allowed this model: [REDACTED]",
    );
    await gateway.close();

    // An OpenAI-format account, asked by an Anthropic client: translated.
    gateway = await startGateway({ upstream, keys, apiFormat: "openai" });
    const translated = await call("/v1/messages", adaKey);
    expect(translated.status).toBe(401);
    const translatedText = await translated.text();
    expect(translatedText).not.toContain(accountKey);
    expect(translatedText).toContain(
      "This key is not allowed this model: [REDACTED]",
    );
  });

  it("G1-6: no answer to a Gateway Key holder carries its AI Account's credential", async () => {
    upstream = await echoing();
    gateway = await startGateway({ upstream, keys });
    const passedThrough = await call("/v1/messages", adaKey);
    expect(await passedThrough.text()).not.toContain(accountKey);
    await gateway.close();
    gateway = await startGateway({ upstream, keys, apiFormat: "openai" });
    const translated = await call("/v1/messages", adaKey);
    expect(await translated.text()).not.toContain(accountKey);
  });

  it("G1-6: nor its headers, a streamed answer (the credential split across chunks), nor the body kept in request history", async () => {
    upstream = await startFakeUpstream((request, response) => {
      const presented = request.headers["x-api-key"] as string;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-echoed-key": presented,
        "request-id": `req_${presented}`,
      });
      const event = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Your key is ${presented}."}}\n\n`;
      // Split inside the credential, one piece at a time.
      const at = event.indexOf(presented) + 10;
      response.write(event.slice(0, at));
      setTimeout(() => {
        response.end(event.slice(at));
      }, 20);
    });
    gateway = await startGateway({ upstream, keys, storeBodies: () => true });
    const response = await call("/v1/messages", adaKey, {
      model: "claude-haiku-5-5",
      max_tokens: 16,
      stream: true,
      messages: [],
    });
    const text = await response.text();
    expect(text).not.toContain(accountKey);
    expect(text).toContain('"text":"Your key is [REDACTED]."');
    expect(response.headers.get("x-echoed-key")).toBe("[REDACTED]");
    expect(response.headers.get("request-id")).toBe("req_[REDACTED]");
    await vi.waitFor(() => {
      expect(records()).toHaveLength(1);
    });
    expect(records()[0]?.bodies?.response).not.toContain(accountKey);
    expect(records()[0]?.upstreamRequestId).toBe("req_[REDACTED]");
  });

  it("G1-6: nor a translated answer, whole or streamed, from an account that takes a bearer token", async () => {
    // An OpenAI-format account, given its key as a bearer token, that
    // writes it into its answer.
    upstream = await startFakeUpstream((request, response) => {
      const presented = (request.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      if (!request.body.includes('"stream":true')) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            created: 1,
            model: "gpt-5.5",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `Key: ${presented}` },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.5",
        choices: [
          {
            index: 0,
            delta: { content: `Key: ${presented}` },
            finish_reason: null,
          },
        ],
      })}\n\n`;
      // Written in two pieces, split inside the credential.
      const at = delta.indexOf(presented) + 12;
      response.write(delta.slice(0, at));
      setTimeout(() => {
        response.write(delta.slice(at));
        response.end("data: [DONE]\n\n");
      }, 20);
    });
    gateway = await startGateway({ upstream, keys, apiFormat: "openai" });
    const whole = await call("/v1/messages", adaKey, {
      model: "gpt-5.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(whole.status).toBe(200);
    const wholeText = await whole.text();
    expect(wholeText).not.toContain(accountKey);
    expect(wholeText).toContain("Key: [REDACTED]");
    const streamed = await call("/v1/messages", adaKey, {
      model: "gpt-5.5",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(streamed.status).toBe(200);
    const streamedText = await streamed.text();
    expect(streamedText).not.toContain(accountKey);
    expect(streamedText).toContain("Key: [REDACTED]");
  });
});

describe("G1-7: an AI Provider's redirect takes the AI Account's credential to another origin", () => {
  /**
   * An AI Account whose endpoint answers 307 to another origin (a
   * compromised or spoofed endpoint, or a proxy in front of a plain-http
   * one), and that other origin, which records what it is sent.
   */
  async function redirected(): Promise<{
    account: GatewayAccount;
    elsewhere: { headers: Record<string, unknown>; body: string }[];
  }> {
    const elsewhere: { headers: Record<string, unknown>; body: string }[] = [];
    const other = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        elsewhere.push({
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(message);
      });
    });
    servers.push(other);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = (other.address() as AddressInfo).port;
    upstream = await startFakeUpstream((_request, response) => {
      // `localhost`, not 127.0.0.1: another origin.
      response.writeHead(307, {
        location: `http://localhost:${String(otherPort)}/collect`,
      });
      response.end();
    });
    return { account: accountAt(upstream.url), elsewhere };
  }

  const prompt = {
    model: "claude-haiku-5-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "The Owner's private source" }],
  };

  it("regression (G1-7): the redirect is no longer followed: the other origin gets neither the AI Account's x-api-key nor the prompt", async () => {
    const { account, elsewhere } = await redirected();
    gateway = await startGateway({
      accounts: staticAccounts(account),
      keys,
      sleep: () => Promise.resolve(),
    });
    const response = await call("/v1/messages", adaKey, prompt);
    // As an AI Provider that cannot be reached: a 502, and no Location,
    // which the caller's client would follow with its Gateway Key.
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("redirect");
    expect(elsewhere).toHaveLength(0);
  });

  it("G1-7: an AI Account's credential is sent only to its own endpoint's origin", async () => {
    const { account, elsewhere } = await redirected();
    gateway = await startGateway({
      accounts: staticAccounts(account),
      keys,
    });
    await call("/v1/messages", adaKey, prompt);
    expect(JSON.stringify(elsewhere)).not.toContain(accountKey);
  });

  it("G1-7: nor an OpenAI-format account's bearer token, translated; and another account serves while one redirects", async () => {
    const { account, elsewhere } = await redirected();
    gateway = await startGateway({
      accounts: staticAccounts({ ...account, apiFormat: "openai" }),
      keys,
      sleep: () => Promise.resolve(),
    });
    const translated = await call("/v1/messages", adaKey, prompt);
    expect(translated.status).toBe(502);
    expect(translated.headers.get("location")).toBeNull();
    expect(elsewhere).toHaveLength(0);
    await gateway.close();

    // The redirecting account is held back as a failing one, and the next
    // account serves the call.
    const serving = await answering();
    const tried: string[] = [];
    gateway = await startGateway({
      accounts: {
        select: ({ avoid }) => {
          const next = (avoid ?? []).includes("redirecting")
            ? { ...accountAt(serving.url), id: "serving" }
            : { ...account, id: "redirecting" };
          tried.push(next.id);
          return Promise.resolve(next);
        },
      },
      keys,
    });
    const served = await call("/v1/messages", adaKey, prompt);
    expect(served.status).toBe(200);
    expect(tried).toEqual(["redirecting", "serving"]);
    expect(elsewhere).toHaveLength(0);
    await serving.close();
  });
});

describe("H19: the Gateway on the host's loopback", () => {
  const modelRoutes = [
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/systemone",
  ];

  it("answers nothing but /health without a Gateway Key, and grants no other origin", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys });
    const url = gateway.url;
    for (const path of modelRoutes) {
      const response = await call(path, undefined);
      expect(response.status, path).toBe(401);
      // Nor with a key that is not in use, nor with one in the wrong place.
      expect(
        (await call(path, "aio_gk_notakeyinuse0000000000000")).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${url}${path}`, {
            method: "POST",
            headers: { cookie: `x-api-key=${adaKey}` },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    }
    for (const path of [
      "/v1/models",
      "/models",
      "/usage",
      "/metrics",
      "/v1/usage",
      "/api/gateway/requests",
      "/",
    ]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status, path).toBe(404);
    }
    // A cross-origin page's preflight: no route, and no CORS grant.
    const preflight = await fetch(`${url}/v1/messages`, {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(404);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    // A "simple" cross-origin POST, which a browser sends unasked: refused.
    const simple = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ model: "claude-haiku-5-5" }),
    });
    expect(simple.status).toBe(401);
    expect(simple.headers.get("access-control-allow-origin")).toBeNull();
    expect(upstream.received).toEqual([]);
  });

  it("pins today: /health answers any Host, so a DNS-rebinding page reads whether an account is available, and nothing else", async () => {
    upstream = await answering();
    gateway = await startGateway({ upstream, keys });
    const { port } = new URL(gateway.url);
    // Node's fetch will not set Host; a raw request does, as a rebound
    // browser would send `Host: attacker.example:3047`.
    const body = await new Promise<string>((resolve, reject) => {
      get(
        {
          host: "127.0.0.1",
          port: Number(port),
          path: "/health",
          headers: { host: `attacker.example:${port}` },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => (text += chunk.toString()));
          response.on("end", () => {
            resolve(text);
          });
        },
      ).on("error", reject);
    });
    expect(JSON.parse(body)).toEqual({ status: "ok", account: "available" });
  });
});
