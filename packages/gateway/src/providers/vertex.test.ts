// Contract tests for Google Vertex AI AI Accounts (PRD FR-35): the answers
// in `fixtures/vertex/` are replayed through a real Gateway serving from a
// real Vertex AI account. Claude Code's Messages go to Vertex AI's
// `rawPredict` (or `streamRawPredict` for a stream) for the Model named in
// the path, with `anthropic_version` in the body in place of the Model;
// counting tokens goes to `count-tokens:rawPredict`. Each carries an access
// token the service account signs in for at Google's token endpoint (a
// fake one here), kept until shortly before it expires. The private key
// never leaves AI Office. Vertex AI's quota and overload answers hold the
// account back and the request falls back.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
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

const folder = fileURLToPath(
  new URL("../../fixtures/vertex/", import.meta.url),
);
const fixture = (name: string) => readFixture(`${folder}${name}`);

const encryptor = encryptorFromKey(Buffer.alloc(32, 46));
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const project = "ai-office-test";

// What each fixture is recorded as, at which caller path, and the Model
// Claude Code asked for. A new fixture needs an entry here.
const expectations: Record<
  string,
  {
    callerPath: string;
    asked: string;
    streamed: boolean;
    status: number;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }
> = {
  "messages.json": {
    callerPath: "/v1/messages",
    asked: "claude-opus-5-5",
    streamed: false,
    status: 200,
    model: "claude-opus-5-5",
    inputTokens: 24,
    outputTokens: 11,
  },
  "messages-streaming.json": {
    callerPath: "/v1/messages",
    asked: "claude-sonnet-5-5",
    streamed: true,
    status: 200,
    model: "claude-sonnet-5-5",
    inputTokens: 27,
    outputTokens: 12,
  },
  "count-tokens.json": {
    callerPath: "/v1/messages/count_tokens",
    asked: "claude-opus-5-5",
    streamed: false,
    status: 200,
    model: "claude-opus-5-5",
    inputTokens: null,
    outputTokens: null,
  },
  "messages-rate-limited.json": {
    callerPath: "/v1/messages",
    asked: "claude-opus-5-5",
    streamed: false,
    status: 429,
    model: "claude-opus-5-5",
    inputTokens: null,
    outputTokens: null,
  },
  "messages-overloaded.json": {
    callerPath: "/v1/messages",
    asked: "claude-opus-5-5",
    streamed: false,
    status: 529,
    model: "claude-opus-5-5",
    inputTokens: null,
    outputTokens: null,
  },
};

const names = (await readdir(folder))
  .filter((name) => name.endsWith(".json"))
  .sort();

let gateway: RunningGateway | undefined;
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
});

/**
 * A fake Google token endpoint: it checks each JWT the service account
 * signs, and answers with a new access token that lasts `expiresIn`
 * seconds; or refuses while `refuse` is set.
 */
async function startTokenEndpoint(
  options: { expiresIn?: number; refuse?: () => boolean } = {},
) {
  let issued = 0;
  const assertions: Record<string, unknown>[] = [];
  const endpoint = await startFakeUpstream((request, response) => {
    const form = new URLSearchParams(request.body);
    const assertion = form.get("assertion") ?? "";
    const [header = "", claims = "", signature = ""] = assertion.split(".");
    const valid = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    if (
      options.refuse?.() === true ||
      !valid ||
      form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
    ) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Invalid JWT Signature.",
        }),
      );
      return;
    }
    assertions.push({
      header: JSON.parse(
        Buffer.from(header, "base64url").toString(),
      ) as unknown,
      ...(JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<
        string,
        unknown
      >),
    });
    issued += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: `ya29.contract-token-${String(issued)}`,
        expires_in: options.expiresIn ?? 3599,
        token_type: "Bearer",
      }),
    );
  });
  upstreams.push(endpoint);
  return {
    url: `${endpoint.url}/token`,
    assertions,
    issued: () => issued,
  };
}

/** A service account key file's contents, as Google Cloud gives it. */
const serviceAccountKey = (tokenUri: string) => ({
  type: "service_account" as const,
  project_id: project,
  private_key_id: "0123456789abcdef0123456789abcdef01234567",
  private_key: privateKey,
  client_email: `ai-office@${project}.iam.gserviceaccount.com`,
  token_uri: tokenUri,
});

/** Vertex AI accounts, each answering with its fixture, in priority order. */
async function office(
  accounts: readonly { name: string; answer: Fixture }[],
  options: {
    saved?: Fixture[];
    tokens?: Awaited<ReturnType<typeof startTokenEndpoint>>;
    now?: () => Date;
    region?: string;
  } = {},
) {
  const tokens = options.tokens ?? (await startTokenEndpoint());
  const requestLog = memoryRequestLog();
  const told: string[] = [];
  const aiAccounts: AiAccounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    onCredential: (credential) => told.push(credential),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const upstreamOf: Record<string, FakeUpstream> = {};
  for (const [index, account] of accounts.entries()) {
    const upstream = await startFakeUpstream(replay(account.answer, 7));
    upstreams.push(upstream);
    upstreamOf[account.name] = upstream;
    await aiAccounts.add({
      name: account.name,
      aiProvider: "Claude",
      accountType: "vertex",
      region: options.region ?? "global",
      serviceAccount: serviceAccountKey(tokens.url),
      endpointUrl: upstream.url,
      priority: index + 1,
    });
  }
  const { saved } = options;
  gateway = await startGateway({
    accounts: aiAccounts,
    requestLog,
    ...(saved === undefined
      ? {}
      : {
          fixtureRecorder: {
            save: (recorded) => {
              saved.push(recorded);
              return Promise.resolve();
            },
          },
        }),
  });
  return { aiAccounts, requestLog, upstreamOf, url: gateway.url, tokens, told };
}

/** Claude Code's request for `fixture`: Anthropic's, with the Model. */
function callerBody(recorded: Fixture, model: string): string {
  const body = JSON.parse(recorded.request.body) as Record<string, unknown>;
  delete body["anthropic_version"];
  return JSON.stringify("model" in body ? body : { model, ...body });
}

/** Claude Code's request through the Gateway, its answer read whole. */
const ask = (url: string, recorded: Fixture, path: string, model: string) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { ...recorded.request.headers, "x-api-key": gatewayKey },
    body: callerBody(recorded, model),
  }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  }));

/** Checks `received` carries the access token, and nothing else of ours. */
function expectToken(received: ReceivedRequest | undefined, token: string) {
  expect(received?.headers.authorization).toBe(`Bearer ${token}`);
  expect(received?.headers["x-api-key"]).toBeUndefined();
  const headers = JSON.stringify(received?.headers);
  expect(headers).not.toContain(gatewayKey);
  expect(headers).not.toContain("PRIVATE KEY");
}

describe("the Google Vertex AI fixtures", () => {
  it("each have an expectation, and each expectation a fixture", () => {
    expect(names).toEqual(Object.keys(expectations).sort());
  });

  it.each(names)(
    "%s goes to Vertex AI with the service account's token, with its usage recorded",
    async (name) => {
      const recorded = await fixture(name);
      const { callerPath, asked, ...expectation } = expectations[name] ?? {
        callerPath: "",
        asked: "",
      };
      const saved: Fixture[] = [];
      const { requestLog, upstreamOf, url, tokens } = await office(
        [{ name: "Vertex", answer: recorded }],
        { saved },
      );
      const response = await ask(url, recorded, callerPath, asked);
      expect(response.status).toBe(recorded.response.status);
      expect(response.text).toBe(recorded.response.body);

      expect(upstreamOf["Vertex"]?.received).toHaveLength(1);
      const [received] = upstreamOf["Vertex"]?.received ?? [];
      // The Model in Vertex AI's path, `anthropic_version` in the body.
      expect(received?.url).toBe(recorded.request.path);
      expect(received?.body).toBe(recorded.request.body);
      expectToken(received, "ya29.contract-token-1");
      // The service account signed in once, for Vertex AI.
      expect(tokens.assertions).toEqual([
        expect.objectContaining({
          header: {
            alg: "RS256",
            typ: "JWT",
            kid: "0123456789abcdef0123456789abcdef01234567",
          },
          iss: `ai-office@${project}.iam.gserviceaccount.com`,
          scope: "https://www.googleapis.com/auth/cloud-platform",
          aud: tokens.url,
        }),
      ]);

      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(1);
        expect(saved).toHaveLength(1);
      });
      expect(requestLog.records[0]).toMatchObject({
        ...expectation,
        endpoint: callerPath === "/v1/messages" ? "messages" : "count_tokens",
        account: "Vertex",
      });
      // Recorder mode saves the path as sent to Google, never the token.
      expect(saved[0]?.request.path).toBe(recorded.request.path);
      const kept = JSON.stringify([saved, requestLog.records]);
      expect(kept).not.toContain("ya29.contract-token");
      expect(kept).not.toContain("PRIVATE KEY");
    },
  );
});

describe("Google Vertex AI AI Accounts", () => {
  it("keep their access token until shortly before it expires, then sign in again", async () => {
    const recorded = await fixture("messages.json");
    let at = Date.now();
    const { upstreamOf, url, tokens, told } = await office(
      [{ name: "Vertex", answer: recorded }],
      { now: () => new Date(at) },
    );
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await ask(url, recorded, "/v1/messages", "claude-opus-5-5")).status,
      ).toBe(200);
    }
    expect(tokens.issued()).toBe(1);
    // 55 minutes on, the hour's token is renewed before it expires.
    at += 55 * 60 * 1000 + 1000;
    await ask(url, recorded, "/v1/messages", "claude-opus-5-5");
    expect(tokens.issued()).toBe(2);
    const received = upstreamOf["Vertex"]?.received ?? [];
    expectToken(received[2], "ya29.contract-token-1");
    expectToken(received[3], "ya29.contract-token-2");
    // Each token, and the private key, are told for redaction.
    expect(told).toEqual(
      expect.arrayContaining([
        privateKey,
        "ya29.contract-token-1",
        "ya29.contract-token-2",
      ]),
    );
  });

  it("sign in once for requests that arrive together", async () => {
    const recorded = await fixture("messages.json");
    const { url, tokens } = await office([
      { name: "Vertex", answer: recorded },
    ]);
    const answers = await Promise.all(
      [1, 2, 3, 4].map(() =>
        ask(url, recorded, "/v1/messages", "claude-opus-5-5"),
      ),
    );
    expect(answers.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect(tokens.issued()).toBe(1);
  });

  it("answer 502 while Google refuses the service account, and serve once it signs in", async () => {
    const recorded = await fixture("messages.json");
    let refusing = true;
    const tokens = await startTokenEndpoint({ refuse: () => refusing });
    const { upstreamOf, url } = await office(
      [{ name: "Vertex", answer: recorded }],
      { tokens },
    );
    const refused = await ask(url, recorded, "/v1/messages", "claude-opus-5-5");
    expect(refused.status).toBe(502);
    const body = refused.text;
    expect(body).toContain(
      "The AI Gateway could not sign in to the AI Provider with this AI Account's credentials.",
    );
    expect(body).not.toContain("invalid_grant");
    expect(upstreamOf["Vertex"]?.received).toHaveLength(0);
    refusing = false;
    expect(
      (await ask(url, recorded, "/v1/messages", "claude-opus-5-5")).status,
    ).toBe(200);
  });

  it.each([
    {
      region: "us-east5",
      path: `/v1/projects/${project}/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict`,
      asked: "claude-haiku-4-5-20251001",
    },
    {
      region: "eu",
      path: `/v1/projects/${project}/locations/eu/publishers/anthropic/models/claude-opus-5-5:rawPredict`,
      asked: "claude-opus-5-5",
    },
  ])(
    "name the region, and a dated Model as Vertex AI does ($region)",
    async ({ region, path, asked }) => {
      const recorded = await fixture("messages.json");
      const { upstreamOf, url } = await office(
        [{ name: "Vertex", answer: recorded }],
        { region },
      );
      await ask(url, recorded, "/v1/messages", asked);
      expect(upstreamOf["Vertex"]?.received[0]?.url).toBe(path);
    },
  );

  it("serve Codex too, translated from Responses to Messages", async () => {
    const recorded = await fixture("messages.json");
    const { upstreamOf, url } = await office([
      { name: "Vertex", answer: recorded },
    ]);
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        input: "Summarise PR #14 in one line.",
        store: false,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "response",
      usage: { input_tokens: 24, output_tokens: 11 },
    });
    const [received] = upstreamOf["Vertex"]?.received ?? [];
    expect(received?.url).toBe(recorded.request.path);
    const sent = JSON.parse(received?.body ?? "{}") as Record<string, unknown>;
    expect(sent["model"]).toBeUndefined();
    expect(sent["anthropic_version"]).toBe("vertex-2023-10-16");
  });

  it("refuse a request that names no Model, which Vertex AI needs", async () => {
    const recorded = await fixture("messages.json");
    const { upstreamOf, url } = await office([
      { name: "Vertex", answer: recorded },
    ]);
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { ...recorded.request.headers, "x-api-key": gatewayKey },
      body: JSON.stringify({ max_tokens: 16, messages: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "The request names no Model, which Vertex AI needs." },
    });
    expect(upstreamOf["Vertex"]?.received).toHaveLength(0);
  });

  it.each([
    { name: "messages-rate-limited.json", reason: "rate_limited", seconds: 60 },
    { name: "messages-overloaded.json", reason: "overloaded", seconds: 30 },
  ])(
    "fall back after Vertex AI's $reason answer, which holds the account back",
    async ({ name, reason, seconds }) => {
      const failure = await fixture(name);
      const served = await fixture("messages.json");
      const { aiAccounts, upstreamOf, url } = await office([
        { name: "Vertex", answer: failure },
        { name: "Vertex spare", answer: served },
      ]);
      const before = Date.now();
      const response = await ask(
        url,
        served,
        "/v1/messages",
        "claude-opus-5-5",
      );
      expect(response.status).toBe(200);
      expect(response.text).toBe(served.response.body);
      expect(upstreamOf["Vertex"]?.received).toHaveLength(1);
      expect(upstreamOf["Vertex spare"]?.received).toHaveLength(1);
      const [first] = await aiAccounts.list();
      expect(first?.limitReason).toBe(reason);
      const until = first?.limitedUntil?.getTime() ?? 0;
      expect(until - before).toBeGreaterThanOrEqual((seconds - 1) * 1000);
      expect(until - Date.now()).toBeLessThanOrEqual(seconds * 1000);
    },
  );

  it("hold the service account's key as a secret: never listed, and kept out of sandboxes", async () => {
    const recorded = await fixture("messages.json");
    const { aiAccounts } = await office([{ name: "Vertex", answer: recorded }]);
    const listed = JSON.stringify(await aiAccounts.list());
    expect(listed).not.toContain("PRIVATE KEY");
    expect(await aiAccounts.list()).toMatchObject([
      { accountType: "vertex", region: "global", projectId: project },
    ]);
    expect(await aiAccounts.holdsCredential(`key: ${privateKey}`)).toBe(true);
    expect(await aiAccounts.holdsCredential(project)).toBe(false);
  });
});
