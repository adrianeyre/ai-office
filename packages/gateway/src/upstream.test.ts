// The outbound HTTP proxy (PRD FR-35): while the Owner has one set, every
// request the AI Gateway makes upstream goes through it, with its
// credentials: requests through AI Accounts, model lists, sign-ins and
// token refreshes, and published prices. The fake proxy here forwards to
// local servers under names nothing else can resolve, so a request that
// arrives went through it. A change applies to the next request, and the
// AI Office host, and hosts the Owner lists, are reached directly.
import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  allowInternalHosts,
  allowedInternalHosts,
  type OutboundProxy,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { createAiAccounts } from "./accounts/accounts.ts";
import {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "./accounts/fake-oauth.ts";
import { memoryAiAccountStore } from "./accounts/store.ts";
import { createModelCatalogue } from "./models/catalogue.ts";
import { memoryModelCatalogueStore } from "./models/store.ts";
import { openRouterPrices } from "./pricing/pricing.ts";
import {
  gatewayKey,
  startFakeProxy,
  startFakeUpstream,
  startGateway,
  type FakeProxy,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";
import { createUpstreamFetch, type UpstreamFetch } from "./upstream.ts";

const encryptor = encryptorFromKey(Buffer.alloc(32, 49));
const kimiKey = "sk-kimi-proxied0123456789abcdef0123456789abcdef";
const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const chatAnswer =
  '{"id":"c1","object":"chat.completion","created":1,"model":"kimi-k3","choices":[{"index":0,"message":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}';

let gateway: RunningGateway | undefined;
let proxy: FakeProxy | undefined;
let oauth: FakeOAuthServer | undefined;
let upstreamFetch: UpstreamFetch | undefined;
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await upstreamFetch?.close();
  upstreamFetch = undefined;
  await proxy?.close();
  proxy = undefined;
  await oauth?.close();
  oauth = undefined;
  for (const upstream of upstreams.splice(0)) {
    await upstream.close();
  }
});

/** A fake AI Provider answering every request with `body`. */
async function provider(body: string): Promise<FakeUpstream> {
  const upstream = await startFakeUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  upstreams.push(upstream);
  return upstream;
}

/** A Kimi account at `endpointUrl`, and a Gateway serving from it. */
async function gatewayAt(endpointUrl: string, fetch: typeof globalThis.fetch) {
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor,
    events: createEventBus({ store: memoryEventStore() }),
    fetch,
  });
  await accounts.add({
    name: "Kimi",
    aiProvider: "Kimi",
    accountType: "api_key",
    credential: kimiKey,
    endpointUrl,
  });
  gateway = await startGateway({
    accounts,
    fetch,
    sleep: () => Promise.resolve(),
    retries: () => ({ attempts: 1, delayMs: 0, multiplier: 1 }),
  });
  return { accounts, url: gateway.url };
}

const ask = (url: string) =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewayKey}`,
    },
    body: JSON.stringify({
      model: "kimi-k3",
      messages: [{ role: "user", content: "Hi" }],
    }),
  }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  }));

describe("the outbound proxy", () => {
  it("carries every request through an AI Account, with the proxy's credentials and the account's key", async () => {
    const kimi = await provider(chatAnswer);
    proxy = await startFakeProxy({
      hosts: { "api.kimi.test": kimi.url },
      proxyAuthorization: basic("office", "pr0xy-pa55"),
    });
    const set: OutboundProxy = {
      url: proxy.url,
      username: "office",
      password: "pr0xy-pa55",
      noProxy: [],
    };
    upstreamFetch = createUpstreamFetch({ proxy: () => set });
    const { url } = await gatewayAt(
      "http://api.kimi.test",
      upstreamFetch.fetch,
    );

    const answer = await ask(url);
    expect(answer).toEqual({ status: 200, text: chatAnswer });
    expect(proxy.proxied).toEqual([
      {
        method: "POST",
        target: "http://api.kimi.test/v1/chat/completions",
        proxyAuthorization: basic("office", "pr0xy-pa55"),
      },
    ]);
    // The AI Provider gets the account's key, and nothing of the proxy's.
    const [received] = kimi.received;
    expect(received?.headers.authorization).toBe(`Bearer ${kimiKey}`);
    expect(received?.headers["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(received?.headers)).not.toContain("pr0xy-pa55");
  });

  it("applies a change to the next request, without a restart", async () => {
    const kimi = await provider(chatAnswer);
    proxy = await startFakeProxy({ hosts: { "api.kimi.test": kimi.url } });
    let set: OutboundProxy | null = null;
    upstreamFetch = createUpstreamFetch({ proxy: () => set });
    const { url } = await gatewayAt(
      "http://api.kimi.test",
      upstreamFetch.fetch,
    );
    // No proxy: the name resolves nowhere, so the AI Provider is unreachable.
    expect((await ask(url)).status).toBe(502);
    expect(proxy.proxied).toHaveLength(0);

    set = { url: proxy.url, username: null, password: null, noProxy: [] };
    expect((await ask(url)).status).toBe(200);
    expect(proxy.proxied).toHaveLength(1);
    expect(proxy.proxied[0]?.proxyAuthorization).toBeUndefined();

    set = null;
    expect((await ask(url)).status).toBe(502);
    expect(proxy.proxied).toHaveLength(1);
  });

  it("reaches the AI Office host itself, and each host the Owner lists, directly", async () => {
    // The Owner's proxy is on their own network, which they allow.
    const allowed = allowedInternalHosts();
    allowInternalHosts([...allowed, "proxy.corp"]);
    onTestFinished(() => {
      allowInternalHosts(allowed);
    });
    const sent: { url: string; proxied: boolean }[] = [];
    const spy: typeof fetch = (input, init) => {
      sent.push({
        url: input instanceof Request ? input.url : input.toString(),
        proxied: init !== undefined && "dispatcher" in init,
      });
      return Promise.resolve(new Response("{}"));
    };
    upstreamFetch = createUpstreamFetch({
      proxy: () => ({
        url: "http://proxy.corp:3128",
        username: null,
        password: null,
        noProxy: ["ollama.lan", ".internal"],
      }),
      fetch: spy,
    });
    for (const url of [
      "http://localhost:11434/v1/chat/completions",
      "http://127.0.0.1:11434/v1/models",
      "http://[::1]:11434/v1/models",
      "http://gpu.ollama.lan:11434/v1/models",
      "http://llm.internal/v1/chat/completions",
      "https://api.moonshot.ai/v1/chat/completions",
    ]) {
      await upstreamFetch.fetch(url, { method: "POST" });
    }
    expect(sent).toEqual([
      { url: "http://localhost:11434/v1/chat/completions", proxied: false },
      { url: "http://127.0.0.1:11434/v1/models", proxied: false },
      { url: "http://[::1]:11434/v1/models", proxied: false },
      { url: "http://gpu.ollama.lan:11434/v1/models", proxied: false },
      { url: "http://llm.internal/v1/chat/completions", proxied: false },
      { url: "https://api.moonshot.ai/v1/chat/completions", proxied: true },
    ]);
  });

  it("carries model lists through it", async () => {
    const kimi = await provider('{"data":[{"id":"kimi-k3"}]}');
    proxy = await startFakeProxy({ hosts: { "api.kimi.test": kimi.url } });
    upstreamFetch = createUpstreamFetch({
      proxy: () => ({
        url: proxy?.url ?? "",
        username: null,
        password: null,
        noProxy: [],
      }),
    });
    const { accounts } = await gatewayAt(
      "http://api.kimi.test",
      upstreamFetch.fetch,
    );
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
      fetch: upstreamFetch.fetch,
    });
    expect((await catalogue.refresh()).refreshed).toEqual([
      { aiProvider: "Kimi", accountType: "api_key", models: 1 },
    ]);
    expect(proxy.proxied.map(({ target }) => target)).toEqual([
      "http://api.kimi.test/v1/models",
    ]);
  });

  it("carries sign-ins and token refreshes through it", async () => {
    oauth = await startFakeOAuthServer({ qwen: true });
    const base = new URL(oauth.provider.tokenUrl).origin;
    proxy = await startFakeProxy({ hosts: { "chat.qwen.test": base } });
    const rehosted = (url: string | undefined) =>
      (url ?? "").replace(base, "http://chat.qwen.test");
    upstreamFetch = createUpstreamFetch({
      proxy: () => ({
        url: proxy?.url ?? "",
        username: null,
        password: null,
        noProxy: [],
      }),
    });
    let time = Date.now();
    const accounts = createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor,
      events: createEventBus({ store: memoryEventStore() }),
      oauthProviders: {
        Qwen: {
          ...oauth.provider,
          deviceCodeUrl: rehosted(oauth.provider.deviceCodeUrl),
          tokenUrl: rehosted(oauth.provider.tokenUrl),
        },
      },
      fetch: upstreamFetch.fetch,
      now: () => new Date(time),
    });
    const login = await accounts.startLogin({
      name: "Qwen",
      aiProvider: "Qwen",
      acceptedTerms: true,
    });
    oauth.approve(login.userCode ?? "");
    await accounts.completeLogin(login.loginId, undefined);
    time += oauth.expiresIn * 1000 - 60 * 1000;
    expect((await accounts.refreshTokens()).refreshed).toHaveLength(1);
    expect(proxy.proxied.map(({ target }) => target)).toEqual([
      "http://chat.qwen.test/oauth2/device/code",
      "http://chat.qwen.test/v1/oauth/token",
      "http://chat.qwen.test/v1/oauth/token",
    ]);
  });

  it("carries published prices through it", async () => {
    const openRouter = await provider(
      '{"data":[{"id":"moonshotai/kimi-k3","pricing":{"prompt":"0.000003","completion":"0.000015"}}]}',
    );
    proxy = await startFakeProxy({
      hosts: { "openrouter.test": openRouter.url },
    });
    upstreamFetch = createUpstreamFetch({
      proxy: () => ({
        url: proxy?.url ?? "",
        username: null,
        password: null,
        noProxy: [],
      }),
    });
    const prices = await openRouterPrices({
      url: "http://openrouter.test/api/v1/models",
      fetch: upstreamFetch.fetch,
    }).fetchPrices();
    expect(prices["moonshotai/kimi-k3"]).toMatchObject({
      input: 3,
      output: 15,
    });
    expect(proxy.proxied.map(({ target }) => target)).toEqual([
      "http://openrouter.test/api/v1/models",
    ]);
  });

  it("uses a new connection once the proxy changes, letting the old one go", async () => {
    const kimi = await provider(chatAnswer);
    proxy = await startFakeProxy({ hosts: { "api.kimi.test": kimi.url } });
    const second = await startFakeProxy({
      hosts: { "api.kimi.test": kimi.url },
    });
    try {
      let set: OutboundProxy = {
        url: proxy.url,
        username: null,
        password: null,
        noProxy: [],
      };
      upstreamFetch = createUpstreamFetch({ proxy: () => set });
      const { url } = await gatewayAt(
        "http://api.kimi.test",
        upstreamFetch.fetch,
      );
      expect((await ask(url)).status).toBe(200);
      set = { ...set, url: second.url };
      expect((await ask(url)).status).toBe(200);
      await vi.waitFor(() => {
        expect(proxy?.proxied).toHaveLength(1);
        expect(second.proxied).toHaveLength(1);
      });
    } finally {
      await second.close();
    }
  });
});

describe("redirects (pen-testing G1-7)", () => {
  /**
   * A Kimi endpoint that answers 307 to `elsewhere`, and `elsewhere`, which
   * would take anything it is sent.
   */
  async function redirecting(location: (elsewhere: string) => string) {
    const elsewhere = await provider(chatAnswer);
    const kimi = await startFakeUpstream((request, response) => {
      response.writeHead(307, {
        location: `${location(elsewhere.url)}${request.url}`,
      });
      response.end();
    });
    upstreams.push(kimi);
    return { kimi, elsewhere };
  }

  it("no request through it follows a redirect, directly or through the proxy: the account's key and the prompt go nowhere else", async () => {
    const { kimi, elsewhere } = await redirecting((url) =>
      url.replace("127.0.0.1", "localhost"),
    );
    upstreamFetch = createUpstreamFetch({ proxy: () => null });
    const direct = await gatewayAt(kimi.url, upstreamFetch.fetch);
    expect((await ask(direct.url)).status).toBe(502);
    expect(elsewhere.received).toEqual([]);
    await gateway?.close();
    await upstreamFetch.close();

    // Through the proxy, to a name only it resolves, redirected to another.
    const proxied = await redirecting(() => "http://elsewhere.test");
    proxy = await startFakeProxy({
      hosts: {
        "api.kimi.test": proxied.kimi.url,
        "elsewhere.test": proxied.elsewhere.url,
      },
    });
    const set: OutboundProxy = {
      url: proxy.url,
      username: null,
      password: null,
      noProxy: [],
    };
    upstreamFetch = createUpstreamFetch({ proxy: () => set });
    const through = await gatewayAt(
      "http://api.kimi.test",
      upstreamFetch.fetch,
    );
    expect((await ask(through.url)).status).toBe(502);
    expect(proxy.proxied.map(({ target }) => target)).toEqual([
      "http://api.kimi.test/v1/chat/completions",
    ]);
    expect(proxied.elsewhere.received).toEqual([]);
  });

  it("a model list is not fetched, with the account's key, from where its endpoint redirects", async () => {
    const { kimi, elsewhere } = await redirecting((url) =>
      url.replace("127.0.0.1", "localhost"),
    );
    upstreamFetch = createUpstreamFetch({ proxy: () => null });
    const { accounts } = await gatewayAt(kimi.url, upstreamFetch.fetch);
    const catalogue = createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => accounts.catalogueSources(),
      fetch: upstreamFetch.fetch,
    });
    const refresh = await catalogue.refresh();
    expect(refresh.refreshed).toEqual([]);
    expect(kimi.received.map(({ url }) => url)).toEqual(["/v1/models"]);
    expect(elsewhere.received).toEqual([]);
  });

  it("follows one only when the caller asks it to", async () => {
    const { kimi, elsewhere } = await redirecting((url) => url);
    upstreamFetch = createUpstreamFetch({ proxy: () => null });
    const answer = await upstreamFetch.fetch(`${kimi.url}/v1/models`, {
      redirect: "follow",
    });
    expect(answer.status).toBe(200);
    expect(elsewhere.received.map(({ url }) => url)).toEqual(["/v1/models"]);
  });
});
