// The contract every OpenAI-format AI Account type with a key, or an
// endpoint, is held to (PRD FR-35, §9): OpenRouter's, DeepSeek's, Z.ai's,
// Minimax's, Kimi's and Ollama Cloud's API keys, and the Owner's own
// Ollama and OpenAI-compatible endpoints. Each type's test file describes
// its fixtures (`fixtures/<type>/`), and this replays every one through a
// real Gateway serving from a real account of that type, its AI
// Provider's answer in 7-byte chunks:
// - requests in OpenAI's formats pass through unchanged to the AI
//   Provider's own path (or the endpoint's), with the key as a bearer
//   token (none for an endpoint without one) and never the Gateway Key;
//   the caller gets the answer byte for byte; the record has the status,
//   tokens (cache reads and writes apart) and the estimated cost at the
//   type's prices; recorder mode saves the path as sent;
// - Claude Code's Messages are translated to Chat Completions;
// - the type's Models go only to its accounts, and no other AI Provider's
//   to them; or, for a compatible endpoint, any Model, and those no AI
//   Provider claims before any other account; it counts no tokens, and one
//   without a Responses API is sent no Responses;
// - each failure fixture falls back to a second account, holding the first
//   back as its answer says (or not at all, for a failure);
// - the key is never listed, and is known to be a credential; an endpoint
//   without one holds none.
// Not a test file itself: each type's `<type>.test.ts` calls it.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import type {
  AddAiAccountRequest,
  AiAccountLimitReason,
  apiKeyProviders,
  endpointProviders,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import { memoryAiAccountStore } from "../accounts/store.ts";
import { readFixture, type Fixture } from "../fixtures.ts";
import {
  createPricing,
  readPricingTable,
  type CostEstimator,
} from "../pricing/pricing.ts";
import { memoryModelPriceStore } from "../pricing/store.ts";
import { memoryRequestLog } from "../request-log.ts";
import {
  gatewayKey,
  replay,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "../test-support.ts";

/** An AI Provider whose API keys, or endpoints, can be added. */
type ApiKeyProvider =
  (typeof apiKeyProviders)[number] | (typeof endpointProviders)[number];

/** What one fixture's request is recorded as. */
export interface FixtureExpectation {
  readonly endpoint: "chat_completions" | "responses" | "systemone";
  readonly streamed: boolean;
  readonly status: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  /** At the type's prices; null for an unpriced Model or no tokens. */
  readonly estimatedCostUsd: number | null;
}

export interface ApiKeyContract {
  readonly aiProvider: ApiKeyProvider;
  /** Its fixtures' folder, under `packages/gateway/fixtures/`. */
  readonly folder: string;
  /** How its accounts are added: an API key (by default), or an endpoint. */
  readonly accountType?: "api_key" | "endpoint";
  /**
   * Two keys shaped as its AI Provider's are; null for an endpoint added
   * without one.
   */
  readonly keys: readonly [string, string] | null;
  /** The path of the endpoint's URL, as the Owner gives it; none by default. */
  readonly endpointPath?: string;
  /** Where its API's paths start, as the account is sent them. */
  readonly apiPath: string;
  /** Whether it is sent any Model asked of it (a compatible endpoint). */
  readonly anyModel?: boolean;
  /** Each fixture's expectation. A new fixture needs one. */
  readonly expectations: Readonly<Record<string, FixtureExpectation>>;
  /**
   * How many times the only account is sent a fixture's request: as often
   * as the Gateway tries, for a failure; once for any other.
   */
  readonly attempts?: Readonly<Record<string, number>>;
  /**
   * Its failures, each held back as `reason` for `seconds` (as the answer
   * says, or the default), or not held back at all (null): a failure.
   */
  readonly failures: readonly {
    readonly fixture: string;
    readonly reason: AiAccountLimitReason | null;
    readonly seconds?: number;
  }[];
  /** Whether its API has Responses. */
  readonly servesResponses: boolean;
  /** Its prices; the pricing table's by default. */
  readonly pricing?: () => Promise<CostEstimator>;
}

const encryptor = encryptorFromKey(Buffer.alloc(32, 45));
const claudeKey = "sk-ant-api03-apiKeyContractClaude0123456789abcdef";

/** The pricing table's prices, as the server estimates costs by default. */
export const tablePricing = (): Promise<CostEstimator> =>
  Promise.resolve(
    createPricing({
      table: readPricingTable(),
      store: memoryModelPriceStore(),
      events: createEventBus({ store: memoryEventStore() }),
    }),
  );

/** An Anthropic Message, as a Claude account answers. */
const claudeAnswer = (fixture: Fixture): Fixture => ({
  ...fixture,
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"Claude here."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":3}}',
  },
});

const modelOf = (fixture: Fixture): string =>
  (JSON.parse(fixture.request.body) as { model: string }).model;

export function describeApiKeyContract(contract: ApiKeyContract): void {
  const { aiProvider, apiPath, expectations } = contract;
  const [key, otherKey] = contract.keys ?? [null, null];
  /** The `authorization` its account is sent: its key, or none. */
  const authorization = key === null ? undefined : `Bearer ${key}`;
  const accountType = contract.accountType ?? "api_key";
  const folder = fileURLToPath(
    new URL(`../../fixtures/${contract.folder}/`, import.meta.url),
  );
  const fixture = (name: string) => readFixture(`${folder}${name}`);
  const pricing = contract.pricing ?? tablePricing;

  let gateway: RunningGateway | undefined;
  const upstreams: FakeUpstream[] = [];

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    for (const upstream of upstreams.splice(0)) {
      await upstream.close();
    }
  });

  /** AI Accounts, each answering with its fixture, in priority order. */
  async function office(
    accounts: readonly {
      name: string;
      aiProvider: ApiKeyProvider;
      answer: Fixture;
      credential: string | null;
    }[],
    options: { saved?: Fixture[] } = {},
  ) {
    const requestLog = memoryRequestLog();
    const told: string[] = [];
    const aiAccounts: AiAccounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      onCredential: (credential) => told.push(credential),
    });
    const upstreamOf: Record<string, FakeUpstream> = {};
    for (const [index, account] of accounts.entries()) {
      const upstream = await startFakeUpstream(replay(account.answer, 7));
      upstreams.push(upstream);
      upstreamOf[account.name] = upstream;
      const added = {
        name: account.name,
        endpointUrl: `${upstream.url}${contract.endpointPath ?? ""}`,
        priority: index + 1,
      };
      await aiAccounts.add(
        account.aiProvider === aiProvider && accountType === "endpoint"
          ? ({
              ...added,
              aiProvider: account.aiProvider,
              accountType: "endpoint",
              credential: account.credential,
            } as AddAiAccountRequest)
          : ({
              ...added,
              aiProvider: account.aiProvider,
              accountType: "api_key",
              credential: account.credential ?? "",
            } as AddAiAccountRequest),
      );
    }
    const { saved } = options;
    gateway = await startGateway({
      accounts: aiAccounts,
      requestLog,
      pricing: await pricing(),
      // Retries go at once.
      sleep: () => Promise.resolve(),
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
    return { aiAccounts, requestLog, upstreamOf, told, url: gateway.url };
  }

  /** One account of the type, answering with `answer`. */
  const alone = (answer: Fixture, options: { saved?: Fixture[] } = {}) =>
    office(
      [{ name: aiProvider, aiProvider, answer, credential: key }],
      options,
    );

  const post = (url: string, path: string, body: string) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayKey}`,
      },
      body,
    }).then(async (response) => ({
      status: response.status,
      text: await response.text(),
    }));

  /** The Gateway's own path for a fixture's request. */
  const callerPath = (recorded: Fixture): string =>
    `/v1${recorded.request.path.slice(apiPath.length)}`;

  describe(`the ${aiProvider} fixtures`, () => {
    it("each have an expectation, and each expectation a fixture", async () => {
      const names = (await readdir(folder))
        .filter((name) => name.endsWith(".json"))
        .sort();
      expect(names).toEqual(Object.keys(expectations).sort());
      for (const { fixture: name } of contract.failures) {
        expect(names).toContain(name);
      }
    });

    it.each(Object.keys(expectations).sort())(
      `%s passes through unchanged to ${aiProvider}'s API, with its usage and cost recorded`,
      async (name) => {
        const recorded = await fixture(name);
        const expected = expectations[name];
        const saved: Fixture[] = [];
        const { requestLog, upstreamOf, url } = await alone(recorded, {
          saved,
        });
        const response = await fetch(`${url}${callerPath(recorded)}`, {
          method: "POST",
          headers: {
            ...recorded.request.headers,
            authorization: `Bearer ${gatewayKey}`,
          },
          body: recorded.request.body,
        });
        expect(response.status).toBe(recorded.response.status);
        expect(await response.text()).toBe(recorded.response.body);

        const received = upstreamOf[aiProvider]?.received ?? [];
        expect(received).toHaveLength(contract.attempts?.[name] ?? 1);
        for (const request of received) {
          // Its own path, the very body, the key as a bearer token, and
          // never the Gateway Key.
          expect(request.url).toBe(recorded.request.path);
          expect(request.body).toBe(recorded.request.body);
          expect(request.headers.authorization).toBe(authorization);
          expect(request.headers["x-api-key"]).toBeUndefined();
          expect(JSON.stringify(request.headers)).not.toContain(gatewayKey);
        }

        await vi.waitFor(() => {
          expect(requestLog.records).toHaveLength(1);
          expect(saved).toHaveLength(1);
        });
        expect(requestLog.records[0]).toMatchObject({
          ...expected,
          account: aiProvider,
          model: modelOf(recorded),
        });
        // Recorder mode saves the path as sent, and never the key.
        expect(saved[0]?.request.path).toBe(recorded.request.path);
        if (key !== null) {
          expect(JSON.stringify(saved[0])).not.toContain(key);
        }
      },
    );
  });

  describe(`${aiProvider} AI Accounts`, () => {
    it("serve Claude Code too, translated from Messages to Chat Completions", async () => {
      const recorded = await fixture("chat-completions.json");
      const expected = expectations["chat-completions.json"];
      const { upstreamOf, url } = await alone(recorded);
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/2.1.0 (external, cli)",
          "x-api-key": gatewayKey,
        },
        body: JSON.stringify({
          model: modelOf(recorded),
          max_tokens: 256,
          messages: [
            { role: "user", content: "Summarise PR #14 in one line." },
          ],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Adds retries and a circuit breaker to the AI Gateway.",
          },
        ],
        usage: {
          input_tokens: expected?.inputTokens,
          output_tokens: expected?.outputTokens,
          cache_read_input_tokens: expected?.cacheReadInputTokens,
        },
      });
      const [received] = upstreamOf[aiProvider]?.received ?? [];
      expect(received?.url).toBe(`${apiPath}/chat/completions`);
      expect(received?.headers.authorization).toBe(authorization);
    });

    if (contract.anyModel === true) {
      it("are sent any Model, and those no AI Provider claims before any other account", async () => {
        const chat = await fixture("chat-completions.json");
        // Claude first, so it would be chosen if the Model did not decide.
        const { upstreamOf, url } = await office([
          {
            name: "Claude",
            aiProvider: "Claude",
            answer: claudeAnswer(chat),
            credential: claudeKey,
          },
          { name: aiProvider, aiProvider, answer: chat, credential: key },
        ]);
        const ask = (model: string) =>
          post(
            url,
            "/v1/chat/completions",
            JSON.stringify({
              model,
              messages: [{ role: "user", content: "Hi" }],
            }),
          );
        // Its own Model, which no AI Provider claims by name.
        expect((await ask(modelOf(chat))).status).toBe(200);
        expect(upstreamOf[aiProvider]?.received).toHaveLength(1);
        expect(upstreamOf["Claude"]?.received).toHaveLength(0);
        // A Claude Model goes to the Claude account first, by priority.
        expect((await ask("claude-sonnet-5-5")).status).toBe(200);
        expect(upstreamOf["Claude"]?.received).toHaveLength(1);
        expect(upstreamOf[aiProvider]?.received).toHaveLength(1);
        // A Grok Model, which no other account here can serve, it is sent.
        expect((await ask("grok-4")).status).toBe(200);
        expect(upstreamOf[aiProvider]?.received).toHaveLength(2);
        expect(upstreamOf["Claude"]?.received).toHaveLength(1);
      });
    } else {
      it(`serve only ${aiProvider}'s Models, and no other AI Provider's`, async () => {
        const chat = await fixture("chat-completions.json");
        // Claude first, so it would be chosen if the Model did not decide.
        const { upstreamOf, url } = await office([
          {
            name: "Claude",
            aiProvider: "Claude",
            answer: claudeAnswer(chat),
            credential: claudeKey,
          },
          { name: aiProvider, aiProvider, answer: chat, credential: key },
        ]);
        const ask = (model: string) =>
          post(
            url,
            "/v1/chat/completions",
            JSON.stringify({
              model,
              messages: [{ role: "user", content: "Hi" }],
            }),
          );
        expect((await ask(modelOf(chat))).status).toBe(200);
        expect(upstreamOf[aiProvider]?.received).toHaveLength(1);
        expect(upstreamOf["Claude"]?.received).toHaveLength(0);
        expect((await ask("claude-sonnet-5-5")).status).toBe(200);
        expect(upstreamOf["Claude"]?.received).toHaveLength(1);
        expect(upstreamOf[aiProvider]?.received).toHaveLength(1);
        // A Grok Model has no account here.
        expect((await ask("grok-4")).status).toBe(503);
        expect(upstreamOf[aiProvider]?.received).toHaveLength(1);
      });
    }

    it(
      contract.servesResponses
        ? "count no tokens, which their API cannot"
        : "count no tokens, and serve no Responses, which their API lacks",
      async () => {
        const recorded = await fixture("chat-completions.json");
        const { upstreamOf, url } = await alone(recorded);
        const model = modelOf(recorded);
        const counted = await fetch(`${url}/v1/messages/count_tokens`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": gatewayKey,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });
        expect(counted.status).toBe(503);
        await counted.body?.cancel();
        if (!contract.servesResponses) {
          const responses = await post(
            url,
            "/v1/responses",
            JSON.stringify({ model, input: "Hi", store: false }),
          );
          expect(responses.status).toBe(503);
        }
        expect(upstreamOf[aiProvider]?.received).toHaveLength(0);
      },
    );

    it.each(
      contract.failures.map((failure) => ({
        ...failure,
        held:
          failure.reason === null
            ? "a failure, which holds nothing back"
            : `which holds the account back as ${failure.reason}`,
      })),
    )(
      `fall back after ${aiProvider}'s $fixture, $held`,
      async ({ fixture: name, reason, seconds }) => {
        const failure = await fixture(name);
        const served = await fixture("chat-completions.json");
        const { aiAccounts, upstreamOf, url } = await office([
          { name: aiProvider, aiProvider, answer: failure, credential: key },
          {
            name: `${aiProvider} spare`,
            aiProvider,
            answer: served,
            credential: otherKey,
          },
        ]);
        const before = Date.now();
        const response = await post(
          url,
          callerPath(served),
          served.request.body,
        );
        expect(response.status).toBe(200);
        expect(response.text).toBe(served.response.body);
        expect(upstreamOf[aiProvider]?.received).toHaveLength(1);
        expect(upstreamOf[`${aiProvider} spare`]?.received).toHaveLength(1);
        const [first] = await aiAccounts.list();
        expect(first?.limitReason).toBe(reason);
        if (reason !== null && seconds !== undefined) {
          const until = first?.limitedUntil?.getTime() ?? 0;
          expect(until - before).toBeGreaterThanOrEqual((seconds - 1) * 1000);
          expect(until - Date.now()).toBeLessThanOrEqual(seconds * 1000);
        }
      },
    );

    it(
      key === null
        ? "hold no credential, and keep nothing else out of sandboxes"
        : "hold the key as a secret: never listed, and kept out of sandboxes",
      async () => {
        const recorded = await fixture("chat-completions.json");
        const { aiAccounts, told, url } = await alone(recorded);
        expect(await aiAccounts.list()).toMatchObject([
          { aiProvider, accountType, region: null, projectId: null },
        ]);
        expect(await aiAccounts.holdsCredential("export KEY=nothing")).toBe(
          false,
        );
        await post(url, callerPath(recorded), recorded.request.body);
        if (key === null) {
          // No key is not an empty one, which every value would hold.
          expect(told).toEqual([]);
          return;
        }
        expect(JSON.stringify(await aiAccounts.list())).not.toContain(key);
        expect(await aiAccounts.holdsCredential(`export KEY=${key}`)).toBe(
          true,
        );
        // Once opened to serve, the key is told for redaction.
        expect(told).toContain(key);
      },
    );
  });
}
