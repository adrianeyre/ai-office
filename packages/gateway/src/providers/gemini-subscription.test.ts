// Contract tests for Gemini subscriptions (PRD FR-35, FR-36, §11): a
// Google AI Pro or Ultra plan, signed in to as Gemini CLI's Google sign-in
// does (its installed-app client, with PKCE and its client secret), against
// a fake OAuth server, and served through a fake of Google's Code Assist
// API, its answers in 7-byte chunks:
// - the sign-in looks up the Code Assist project the Google account is
//   set up with (onboarding it if it never was), and every request names
//   it;
// - opencode's Chat Completions are translated to Gemini's own format,
//   wrapped as Code Assist takes them, with the access token as a bearer
//   token, never the Gateway Key; the answers, whole or streamed, come
//   back as Chat Completions, with their tokens recorded;
// - it serves opencode only: Claude Code's Messages, and any other tool's
//   requests, go elsewhere or nowhere.
import type { ServerResponse } from "node:http";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { aiAccountKindOf, aiAccountErrorCodes } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts } from "../accounts/accounts.ts";
import {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "../accounts/fake-oauth.ts";
import { googleOAuth, tokensInLoginFile } from "../accounts/oauth.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type ReceivedRequest,
  type RunningGateway,
} from "../test-support.ts";
import { readSse } from "../translate/sse.ts";

const encryptor = encryptorFromKey(Buffer.alloc(32, 48));
const opencode = "opencode/1.2.0";
const project = "aio-test-project-0001";

let oauth: FakeOAuthServer | undefined;
let gateway: RunningGateway | undefined;
let codeAssist: FakeUpstream | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await oauth?.close();
  oauth = undefined;
  await codeAssist?.close();
  codeAssist = undefined;
});

const geminiAnswer = {
  response: {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "Checking the file.", thought: true },
            { text: "Hello" },
            {
              functionCall: { name: "read", args: { path: "a.ts" } },
              thoughtSignature: "c2lnbmF0dXJl",
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 8,
      thoughtsTokenCount: 4,
      cachedContentTokenCount: 100,
      totalTokenCount: 132,
    },
    modelVersion: "gemini-3.1-pro-preview",
    responseId: "resp-0001",
  },
};

const streamedAnswer = [
  {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }],
      modelVersion: "gemini-3.5-flash",
      responseId: "resp-0002",
    },
  },
  {
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "lo" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    },
  },
];

/**
 * A fake of Google's Code Assist API: a Google account already set up
 * with `project` (or, `onboarded` false, set up by `onboardUser`), and
 * answers to `generateContent` in 7-byte chunks.
 */
async function startCodeAssist(
  options: { readonly onboarded?: boolean } = {},
): Promise<FakeUpstream> {
  const send = async (response: ServerResponse, type: string, body: string) => {
    response.writeHead(200, { "content-type": type });
    for (let offset = 0; offset < body.length; offset += 7) {
      response.write(body.slice(offset, offset + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  };
  return startFakeUpstream(async (request: ReceivedRequest, response) => {
    if (request.url === "/v1internal:loadCodeAssist") {
      await send(
        response,
        "application/json",
        JSON.stringify(
          options.onboarded === false
            ? {
                allowedTiers: [
                  { id: "free-tier", isDefault: false },
                  { id: "standard-tier", isDefault: true },
                ],
              }
            : {
                currentTier: { id: "standard-tier" },
                cloudaicompanionProject: project,
              },
        ),
      );
    } else if (request.url === "/v1internal:onboardUser") {
      await send(
        response,
        "application/json",
        JSON.stringify({
          done: true,
          response: { cloudaicompanionProject: { id: project } },
        }),
      );
    } else if (request.url === "/v1internal:generateContent") {
      await send(response, "application/json", JSON.stringify(geminiAnswer));
    } else if (request.url === "/v1internal:streamGenerateContent?alt=sse") {
      await send(
        response,
        "text/event-stream",
        streamedAnswer
          .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
          .join(""),
      );
    } else {
      response.writeHead(404).end();
    }
  });
}

/** The Google client the Owner gives, as the fake sign-in knows it. */
const client = {
  clientId: "fake-oauth-client",
  clientSecret: "fake-client-secret",
};

/** Gemini sign-ins against fakes of Google's sign-in and Code Assist. */
async function office(
  options: { readonly onboarded?: boolean; readonly now?: () => Date } = {},
) {
  oauth = await startFakeOAuthServer();
  codeAssist = await startCodeAssist(options);
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    oauthProviders: { Gemini: oauth.provider },
    codeAssistUrl: codeAssist.url,
    sleep: () => Promise.resolve(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { accounts, oauth, codeAssist };
}

/** Signs a Gemini subscription in, as the Owner would. */
async function signIn(setup: Awaited<ReturnType<typeof office>>) {
  const login = await setup.accounts.startLogin({
    name: "Gemini",
    aiProvider: "Gemini",
    acceptedTerms: true,
    client,
  });
  const pasted = await setup.oauth.signIn(login.authorizeUrl);
  return setup.accounts.completeLogin(login.loginId, pasted);
}

const chat = (
  url: string,
  body: Record<string, unknown>,
  userAgent = opencode,
) =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": userAgent,
      authorization: `Bearer ${gatewayKey}`,
    },
    body: JSON.stringify(body),
  });

describe("Gemini's sign-in", () => {
  it("is Gemini CLI's Google sign-in, its code shown on Google's page", () => {
    // Gemini CLI's client is given to the server, never kept in the code.
    const client = {
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
    };
    const provider = googleOAuth(client);
    expect(provider).toMatchObject({
      ...client,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      tokenFormat: "form",
      redirectUri: "https://codeassist.google.com/authcode",
      authorizeParams: { access_type: "offline", prompt: "consent" },
    });
    expect(provider.scopes).toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );
    expect(
      aiAccountKindOf({ aiProvider: "Gemini", accountType: "oauth" }),
    ).toMatchObject({ servesOnly: "opencode", apiFormat: "gemini" });
  });

  it("cannot start without Gemini CLI's client", async () => {
    const accounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
    });
    await expect(
      accounts.startLogin({
        name: "Gemini",
        aiProvider: "Gemini",
        acceptedTerms: true,
      }),
    ).rejects.toMatchObject({
      code: aiAccountErrorCodes.notOAuthAccount,
      message:
        "A Gemini subscription needs Gemini CLI's OAuth client ID and secret.",
    });
  });

  it("refreshes, and signs in again, as the client it was given", async () => {
    let time = Date.now();
    const setup = await office({ now: () => new Date(time) });
    setup.oauth.expiresIn = 60 * 60;
    const { account } = await signIn(setup);
    time += 55 * 60 * 1000;
    expect((await setup.accounts.refreshTokens()).refreshed).toEqual([
      account.id,
    ]);
    expect(
      setup.oauth.tokenRequests.find(
        (request) => request["grant_type"] === "refresh_token",
      ),
    ).toMatchObject({
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    // Signing in again needs no client: the account has it.
    const again = await setup.accounts.startLogin({ accountId: account.id });
    const pasted = await setup.oauth.signIn(again.authorizeUrl);
    expect(
      (await setup.accounts.completeLogin(again.loginId, pasted)).added,
    ).toBe(false);
    // The client is no credential, but stays with the account only.
    expect(JSON.stringify(await setup.accounts.list())).not.toContain(
      client.clientSecret,
    );
  });

  it("adds an account set up with its Code Assist project, sending the client secret", async () => {
    const setup = await office();
    const { account, added } = await signIn(setup);
    expect(added).toBe(true);
    expect(account).toMatchObject({
      aiProvider: "Gemini",
      accountType: "oauth",
      reauthenticationNeeded: false,
    });
    expect(setup.oauth.tokenRequests[0]).toMatchObject({
      grant_type: "authorization_code",
      client_secret: "fake-client-secret",
    });
    const [load] = setup.codeAssist.received;
    expect(load?.url).toBe("/v1internal:loadCodeAssist");
    expect(load?.headers.authorization).toBe(
      `Bearer ${setup.oauth.accessTokens[0] ?? ""}`,
    );
  });

  it("onboards a Google account that has never used Code Assist, to its default tier", async () => {
    const setup = await office({ onboarded: false });
    await signIn(setup);
    const onboard = setup.codeAssist.received.find(
      (request) => request.url === "/v1internal:onboardUser",
    );
    expect(JSON.parse(onboard?.body ?? "{}")).toMatchObject({
      tierId: "standard-tier",
    });
  });

  it("is not added when the Google account cannot use Code Assist", async () => {
    oauth = await startFakeOAuthServer();
    codeAssist = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ineligibleTiers: [{ reasonMessage: "Not available in your region." }],
        }),
      );
    });
    const accounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      oauthProviders: { Gemini: oauth.provider },
      codeAssistUrl: codeAssist.url,
    });
    await expect(signIn({ accounts, oauth, codeAssist })).rejects.toMatchObject(
      {
        code: aiAccountErrorCodes.oauthUnavailable,
        message: "Not available in your region.",
      },
    );
    expect(await accounts.list()).toEqual([]);
  });

  it("imports Gemini CLI's own login file", () => {
    const tokens = tokensInLoginFile(
      JSON.stringify({
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        token_type: "Bearer",
        expiry_date: 1_790_000_000_000,
      }),
      new Date(0),
    );
    expect(tokens).toEqual({
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      expiresAt: new Date(1_790_000_000_000),
    });
  });
});

describe("Gemini subscriptions", () => {
  it("serve opencode's Chat Completions, translated through Code Assist", async () => {
    const setup = await office();
    await signIn(setup);
    const requestLog = memoryRequestLog();
    gateway = await startGateway({ accounts: setup.accounts, requestLog });
    const response = await chat(gateway.url, {
      model: "gemini-3.1-pro-preview",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      model: "gemini-3.1-pro-preview",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello",
            reasoning_content: "Checking the file.",
            tool_calls: [
              {
                type: "function",
                function: { name: "read", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 12 },
    });
    const sent = setup.codeAssist.received.find(
      (request) => request.url === "/v1internal:generateContent",
    );
    expect(sent?.headers.authorization).toBe(
      `Bearer ${setup.oauth.accessTokens[0] ?? ""}`,
    );
    expect(JSON.stringify(sent?.headers)).not.toContain(gatewayKey);
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({
      model: "gemini-3.1-pro-preview",
      project,
      request: {
        systemInstruction: { parts: [{ text: "Be brief." }] },
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "read",
                parametersJsonSchema: { type: "object", properties: {} },
              },
            ],
          },
        ],
      },
    });
    await vi.waitFor(() => {
      expect(requestLog.records).toHaveLength(1);
    });
    expect(requestLog.records[0]).toMatchObject({
      endpoint: "chat_completions",
      account: "Gemini",
      status: 200,
      inputTokens: 20,
      outputTokens: 12,
      cacheReadInputTokens: 100,
    });
  });

  it("stream their answers back as Chat Completion chunks", async () => {
    const setup = await office();
    await signIn(setup);
    gateway = await startGateway({ accounts: setup.accounts });
    const response = await chat(gateway.url, {
      model: "gemini-3.5-flash",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(response.status).toBe(200);
    const events = readSse(await response.text());
    expect(events.at(-1)?.data).toBe("[DONE]");
    const chunks = events
      .slice(0, -1)
      .map((event) => JSON.parse(event.data) as Record<string, unknown>);
    const said = chunks
      .flatMap(
        (chunk) =>
          (chunk["choices"] as { delta: { content?: string } }[] | undefined) ??
          [],
      )
      .map((choice) => choice.delta.content ?? "")
      .join("");
    expect(said).toBe("Hello");
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  });

  it("serve opencode only: not Claude Code, nor any other tool", async () => {
    const setup = await office();
    await signIn(setup);
    gateway = await startGateway({ accounts: setup.accounts });
    const before = setup.codeAssist.received.length;
    const body = {
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "Hi" }],
    };
    const other = await chat(gateway.url, body, "curl/8.9.0");
    expect(other.status).toBe(503);
    await other.text();
    const fromClaudeCode = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.0 (external, cli)",
        "x-api-key": gatewayKey,
      },
      body: JSON.stringify({ ...body, max_tokens: 16 }),
    });
    expect(fromClaudeCode.status).toBe(503);
    await fromClaudeCode.text();
    expect(setup.codeAssist.received).toHaveLength(before);
  });
});
