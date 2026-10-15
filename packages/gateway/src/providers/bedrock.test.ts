// Contract tests for AWS Bedrock AI Accounts (PRD FR-35): the answers in
// `fixtures/bedrock/` are replayed through a real Gateway serving from a
// real AWS Bedrock account. Claude Code's Messages go to Claude in Amazon
// Bedrock's own Messages API (`/anthropic/v1/messages`) unchanged, but for
// the Model's `anthropic.` prefix, signed with SigV4 for `bedrock-mantle`
// in the account's region: with its IAM access key, or its profile's,
// read from the AWS CLI's files. No key, and no Gateway Key, is ever sent;
// the secret is never recorded or logged. AWS's throttling holds the
// account back and the request falls back.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import type { AwsCredentials } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import type { AwsConfigFiles } from "../cloud/aws-profile.ts";
import { signAwsRequest, type AwsAccessKey } from "../cloud/aws-sigv4.ts";
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
  new URL("../../fixtures/bedrock/", import.meta.url),
);
const fixture = (name: string) => readFixture(`${folder}${name}`);

const encryptor = encryptorFromKey(Buffer.alloc(32, 45));
const accessKey = {
  accessKeyId: "AKIAAIOFFICECONTRACT1",
  secretAccessKey: "bedrockContractSecretKey/0123456789abcdefGH",
} as const;
const otherAccessKey = {
  accessKeyId: "AKIAAIOFFICECONTRACT2",
  secretAccessKey: "bedrockContractSecretKey/other0123456789abcd",
} as const;
const region = "us-east-1";

// What each fixture is recorded as, and the Model Claude Code asked for.
// A new fixture needs an entry here.
const expectations: Record<
  string,
  {
    asked: string;
    streamed: boolean;
    status: number;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }
> = {
  "messages.json": {
    asked: "claude-opus-5-5",
    streamed: false,
    status: 200,
    model: "anthropic.claude-opus-5-5",
    inputTokens: 24,
    outputTokens: 11,
  },
  "messages-streaming.json": {
    asked: "claude-sonnet-5-5",
    streamed: true,
    status: 200,
    model: "anthropic.claude-sonnet-5-5",
    inputTokens: 27,
    outputTokens: 12,
  },
  "messages-throttled.json": {
    asked: "claude-opus-5-5",
    streamed: false,
    status: 429,
    model: "anthropic.claude-opus-5-5",
    inputTokens: null,
    outputTokens: null,
  },
  "messages-overloaded.json": {
    asked: "claude-opus-5-5",
    streamed: false,
    status: 529,
    model: "anthropic.claude-opus-5-5",
    inputTokens: null,
    outputTokens: null,
  },
  "messages-access-denied.json": {
    asked: "claude-opus-5-5",
    streamed: false,
    status: 403,
    model: "anthropic.claude-opus-5-5",
    inputTokens: null,
    outputTokens: null,
  },
};

const names = (await readdir(folder))
  .filter((name) => name.endsWith(".json"))
  .sort();

let gateway: RunningGateway | undefined;
const upstreams: FakeUpstream[] = [];
const directories: string[] = [];

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** AWS CLI files in a new directory, with these contents. */
async function awsFiles(contents: {
  credentials?: string;
  config?: string;
}): Promise<AwsConfigFiles> {
  const directory = await mkdtemp(join(tmpdir(), "ai-office-aws-"));
  directories.push(directory);
  const files = {
    credentials: join(directory, "credentials"),
    config: join(directory, "config"),
  };
  if (contents.credentials !== undefined) {
    await writeFile(files.credentials, contents.credentials);
  }
  if (contents.config !== undefined) {
    await writeFile(files.config, contents.config);
  }
  return files;
}

/** Bedrock accounts, each answering with its fixture, in priority order. */
async function office(
  accounts: readonly {
    name: string;
    answer: Fixture;
    credentials: AwsCredentials;
  }[],
  options: { saved?: Fixture[]; files?: AwsConfigFiles; log?: string[] } = {},
) {
  const requestLog = memoryRequestLog();
  const aiAccounts: AiAccounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    awsConfigFiles: options.files ?? (await awsFiles({})),
  });
  const upstreamOf: Record<string, FakeUpstream> = {};
  for (const [index, account] of accounts.entries()) {
    const upstream = await startFakeUpstream(replay(account.answer, 7));
    upstreams.push(upstream);
    upstreamOf[account.name] = upstream;
    await aiAccounts.add({
      name: account.name,
      aiProvider: "Claude",
      accountType: "bedrock",
      region,
      awsCredentials: account.credentials,
      endpointUrl: upstream.url,
      priority: index + 1,
    });
  }
  const { saved, log } = options;
  gateway = await startGateway({
    accounts: aiAccounts,
    requestLog,
    ...(log === undefined
      ? {}
      : {
          logger: pino(
            { level: "debug" },
            new Writable({
              write(chunk: Buffer, _encoding, callback) {
                log.push(chunk.toString("utf8"));
                callback();
              },
            }),
          ),
        }),
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
  return { aiAccounts, requestLog, upstreamOf, url: gateway.url };
}

/** The time a request was signed at, from its `x-amz-date`. */
const signedAt = (received: ReceivedRequest): Date =>
  new Date(
    String(received.headers["x-amz-date"]).replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6Z",
    ),
  );

/**
 * Checks `received` is signed with SigV4 by `key`, for Claude in Amazon
 * Bedrock in the account's region, over the very body and host it came
 * with.
 */
function expectSigned(
  received: ReceivedRequest | undefined,
  upstream: FakeUpstream | undefined,
  key: AwsAccessKey,
) {
  expect(received).toBeDefined();
  if (received === undefined || upstream === undefined) {
    return;
  }
  const url = `${upstream.url}${received.url}`;
  expect(received.headers.host).toBe(new URL(url).host);
  const at = signedAt(received);
  expect(Math.abs(at.getTime() - Date.now())).toBeLessThan(60_000);
  const expected = signAwsRequest(
    { method: "POST", url, body: received.body },
    { key, region, service: "bedrock-mantle", now: at },
  );
  expect(received.headers.authorization).toBe(expected.authorization);
  expect(received.headers.authorization).toMatch(
    new RegExp(
      `^AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/\\d{8}/${region}/bedrock-mantle/aws4_request, SignedHeaders=host;x-amz-date(;x-amz-security-token)?, Signature=[0-9a-f]{64}$`,
    ),
  );
  expect(received.headers["x-amz-security-token"]).toBe(
    key.sessionToken ?? undefined,
  );
  // Never a key of its own, or the caller's Gateway Key.
  expect(received.headers["x-api-key"]).toBeUndefined();
  expect(JSON.stringify(received.headers)).not.toContain(gatewayKey);
  expect(JSON.stringify(received.headers)).not.toContain(key.secretAccessKey);
}

/** Claude Code's request for `fixture`, asking for `model`. */
const callerBody = (recorded: Fixture, model: string): string =>
  JSON.stringify({
    ...(JSON.parse(recorded.request.body) as Record<string, unknown>),
    model,
  });

/** Claude Code's request through the Gateway, its answer read whole. */
const ask = (url: string, recorded: Fixture, model: string) =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { ...recorded.request.headers, "x-api-key": gatewayKey },
    body: callerBody(recorded, model),
  }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  }));

describe("the AWS Bedrock fixtures", () => {
  it("each have an expectation, and each expectation a fixture", () => {
    expect(names).toEqual(Object.keys(expectations).sort());
  });

  it.each(names)(
    "%s goes to Claude in Amazon Bedrock signed with SigV4, with its usage recorded",
    async (name) => {
      const recorded = await fixture(name);
      const { asked, ...expectation } = expectations[name] ?? { asked: "" };
      const saved: Fixture[] = [];
      const log: string[] = [];
      const { requestLog, upstreamOf, url } = await office(
        [{ name: "Bedrock", answer: recorded, credentials: accessKey }],
        { saved, log },
      );
      const response = await ask(url, recorded, asked);
      expect(response.status).toBe(recorded.response.status);
      expect(response.text).toBe(recorded.response.body);

      const upstream = upstreamOf["Bedrock"];
      expect(upstream?.received).toHaveLength(1);
      const [received] = upstream?.received ?? [];
      // Bedrock's path, the body with Bedrock's name for the Model.
      expect(received?.url).toBe(recorded.request.path);
      expect(received?.body).toBe(recorded.request.body);
      expect(received?.headers["anthropic-version"]).toBe("2023-06-01");
      expectSigned(received, upstream, accessKey);

      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(1);
        expect(saved).toHaveLength(1);
      });
      expect(requestLog.records[0]).toMatchObject({
        ...expectation,
        endpoint: "messages",
        account: "Bedrock",
      });
      // Recorder mode saves the path as sent to AWS, never the signature.
      expect(saved[0]?.request.path).toBe(recorded.request.path);
      expect(saved[0]?.request.body).toBe(recorded.request.body);
      const kept = JSON.stringify([saved, requestLog.records, log]);
      expect(kept).not.toContain(accessKey.secretAccessKey);
      expect(kept).not.toContain(accessKey.accessKeyId);
      expect(kept).not.toContain("AWS4-HMAC-SHA256");
    },
  );
});

describe("AWS Bedrock AI Accounts", () => {
  it("send a temporary key's session token, signed", async () => {
    const recorded = await fixture("messages.json");
    const temporary = {
      accessKeyId: "ASIAAIOFFICECONTRACT3",
      secretAccessKey: "bedrockContractTemporarySecret/0123456789ab",
      sessionToken: "IQoJb3JpZ2luX2VjEContractSessionToken/0123456789+abcdef==",
    };
    const { upstreamOf, url } = await office([
      { name: "Bedrock", answer: recorded, credentials: temporary },
    ]);
    const response = await ask(url, recorded, "claude-opus-5-5");
    expect(response.status).toBe(200);
    expectSigned(
      upstreamOf["Bedrock"]?.received[0],
      upstreamOf["Bedrock"],
      temporary,
    );
  });

  it("sign with their profile's key, read again each time", async () => {
    const recorded = await fixture("messages.json");
    const files = await awsFiles({
      credentials: `[default]\naws_access_key_id = AKIADEFAULTNOTUSED00\naws_secret_access_key = notUsed\n\n[ai-office]\naws_access_key_id = ${accessKey.accessKeyId}\naws_secret_access_key = ${accessKey.secretAccessKey}\n`,
    });
    const { upstreamOf, url } = await office(
      [
        {
          name: "Bedrock",
          answer: recorded,
          credentials: { profile: "ai-office" },
        },
      ],
      { files },
    );
    expect((await ask(url, recorded, "claude-opus-5-5")).status).toBe(200);
    expectSigned(
      upstreamOf["Bedrock"]?.received[0],
      upstreamOf["Bedrock"],
      accessKey,
    );

    // A rotated key is used at once.
    await writeFile(
      files.credentials,
      `[ai-office]\naws_access_key_id = ${otherAccessKey.accessKeyId}\naws_secret_access_key = ${otherAccessKey.secretAccessKey}\n`,
    );
    expect((await ask(url, recorded, "claude-opus-5-5")).status).toBe(200);
    expectSigned(
      upstreamOf["Bedrock"]?.received[1],
      upstreamOf["Bedrock"],
      otherAccessKey,
    );
  });

  it("are not added with a profile that has no key", async () => {
    const files = await awsFiles({
      config:
        "[profile sso]\nsso_session = work\nsso_account_id = 123456789012\n",
    });
    const aiAccounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      awsConfigFiles: files,
    });
    const adding = (profile: string) =>
      aiAccounts.add({
        name: "Bedrock",
        aiProvider: "Claude",
        accountType: "bedrock",
        region,
        awsCredentials: { profile },
      });
    await expect(adding("sso")).rejects.toMatchObject({
      code: "cloud_credentials_unusable",
      message: expect.stringContaining(
        'The AWS profile "sso" has no access key',
      ) as unknown,
    });
    await expect(adding("missing")).rejects.toMatchObject({
      code: "cloud_credentials_unusable",
      message: expect.stringContaining(
        'There is no AWS profile "missing"',
      ) as unknown,
    });
    expect(await aiAccounts.list()).toEqual([]);
  });

  it("fail over when their profile is gone, and the caller gets a 502 when none is left", async () => {
    const recorded = await fixture("messages.json");
    const files = await awsFiles({
      credentials: `[ai-office]\naws_access_key_id = ${accessKey.accessKeyId}\naws_secret_access_key = ${accessKey.secretAccessKey}\n`,
    });
    const { aiAccounts, upstreamOf, url } = await office(
      [
        {
          name: "Bedrock",
          answer: recorded,
          credentials: { profile: "ai-office" },
        },
        {
          name: "Bedrock spare",
          answer: recorded,
          credentials: otherAccessKey,
        },
      ],
      { files },
    );
    await rm(files.credentials);
    const response = await ask(url, recorded, "claude-opus-5-5");
    expect(response.status).toBe(200);
    expect(upstreamOf["Bedrock"]?.received).toHaveLength(0);
    expectSigned(
      upstreamOf["Bedrock spare"]?.received[0],
      upstreamOf["Bedrock spare"],
      otherAccessKey,
    );

    const [spare] = (await aiAccounts.list()).filter(
      ({ name }) => name === "Bedrock spare",
    );
    await aiAccounts.update(spare?.id ?? "", { paused: true });
    const refused = await ask(url, recorded, "claude-opus-5-5");
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.text)).toMatchObject({
      type: "error",
      error: {
        message:
          "The AI Gateway could not sign in to the AI Provider with this AI Account's credentials.",
      },
    });
  });

  it("serve Codex too, translated from Responses to Messages", async () => {
    const recorded = await fixture("messages.json");
    const { upstreamOf, url } = await office([
      { name: "Bedrock", answer: recorded, credentials: accessKey },
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
      status: "completed",
      usage: { input_tokens: 24, output_tokens: 11 },
    });
    const [received] = upstreamOf["Bedrock"]?.received ?? [];
    expect(received?.url).toBe("/anthropic/v1/messages");
    expect(JSON.parse(received?.body ?? "{}")).toMatchObject({
      model: "anthropic.claude-opus-5-5",
    });
    expectSigned(received, upstreamOf["Bedrock"], accessKey);
  });

  it("count no tokens: Claude in Amazon Bedrock has no such endpoint", async () => {
    const recorded = await fixture("messages.json");
    const { upstreamOf, url } = await office([
      { name: "Bedrock", answer: recorded, credentials: accessKey },
    ]);
    const response = await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { ...recorded.request.headers, "x-api-key": gatewayKey },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "How many tokens is this?" }],
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ type: "error" });
    expect(upstreamOf["Bedrock"]?.received).toHaveLength(0);
  });

  it("send a Bedrock inference profile as it is", async () => {
    const recorded = await fixture("messages.json");
    const { upstreamOf, url } = await office([
      { name: "Bedrock", answer: recorded, credentials: accessKey },
    ]);
    await ask(url, recorded, "us.anthropic.claude-opus-5-5");
    expect(
      JSON.parse(upstreamOf["Bedrock"]?.received[0]?.body ?? "{}"),
    ).toMatchObject({ model: "us.anthropic.claude-opus-5-5" });
  });

  it.each([
    { name: "messages-throttled.json", reason: "rate_limited", seconds: 60 },
    { name: "messages-overloaded.json", reason: "overloaded", seconds: 30 },
  ])(
    "fall back after AWS's $reason answer, which holds the account back",
    async ({ name, reason, seconds }) => {
      const failure = await fixture(name);
      const served = await fixture("messages.json");
      const { aiAccounts, upstreamOf, url } = await office([
        { name: "Bedrock", answer: failure, credentials: accessKey },
        { name: "Bedrock spare", answer: served, credentials: otherAccessKey },
      ]);
      const before = Date.now();
      const response = await ask(url, served, "claude-opus-5-5");
      expect(response.status).toBe(200);
      expect(response.text).toBe(served.response.body);
      expect(upstreamOf["Bedrock"]?.received).toHaveLength(1);
      expectSigned(
        upstreamOf["Bedrock spare"]?.received[0],
        upstreamOf["Bedrock spare"],
        otherAccessKey,
      );
      const [first] = await aiAccounts.list();
      expect(first?.limitReason).toBe(reason);
      const until = first?.limitedUntil?.getTime() ?? 0;
      expect(until - before).toBeGreaterThanOrEqual((seconds - 1) * 1000);
      expect(until - Date.now()).toBeLessThanOrEqual(seconds * 1000);
    },
  );

  it("hold their keys as secrets: never listed, and kept out of sandboxes", async () => {
    const recorded = await fixture("messages.json");
    const told: string[] = [];
    const aiAccounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      awsConfigFiles: await awsFiles({}),
      onCredential: (credential) => told.push(credential),
    });
    await aiAccounts.add({
      name: "Bedrock",
      aiProvider: "Claude",
      accountType: "bedrock",
      region,
      awsCredentials: accessKey,
      endpointUrl: recorded.request.path,
    });
    const listed = JSON.stringify(await aiAccounts.list());
    expect(listed).not.toContain(accessKey.secretAccessKey);
    expect(listed).not.toContain(accessKey.accessKeyId);
    expect(await aiAccounts.list()).toMatchObject([
      { accountType: "bedrock", region, projectId: null },
    ]);
    expect(told).toEqual(
      expect.arrayContaining([
        accessKey.accessKeyId,
        accessKey.secretAccessKey,
      ]),
    );
    expect(
      await aiAccounts.holdsCredential(
        `export KEY=${accessKey.secretAccessKey}`,
      ),
    ).toBe(true);
    expect(await aiAccounts.holdsCredential("region=us-east-1")).toBe(false);
  });
});
