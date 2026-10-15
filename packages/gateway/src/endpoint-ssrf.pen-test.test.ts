import {
  allowInternalHosts,
  allowedInternalHosts,
  type OutboundProxy,
} from "@ai-office/shared";
import { ownerFetch } from "@ai-office/shared/internal-hosts-guard";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { staticAccounts, type GatewayAccount } from "./gateway.ts";
import { staticKeys, type GatewayCaller } from "./keys/keys.ts";
import {
  accountKey,
  gatewayKey,
  startFakeUpstream,
  startFakeProxy,
  startGateway,
  testCaller,
  type FakeProxy,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";
import { createUpstreamFetch } from "./upstream.ts";

// I1 probe (pen-testing, "Infrastructure and delivery"): the Gateway half
// of an Owner-triggered fetch to an internal address (H13). A custom AI
// endpoint (FR-35) is the AI Account's `baseUrl`. The Owner sets it, so the
// attacker is position 4 (a stolen session that adds an AI Account) feeding
// position 3 (a sandbox holding a Gateway Key, which then reads the answer).
//
// Nothing in the Gateway checks where `baseUrl` points. So an AI Account
// whose endpoint is a loopback, link-local (169.254.169.254, the EC2
// metadata service) or private address is fetched like any other, and its
// body is handed back to the Gateway Key holder — the one place ADR 0001
// says an untrusted sandbox gets. The URL-shape half (the `endpoint`,
// `webhook` and import schemas accept such hosts, over plain http where
// they allow it) is in the schema probes; see docs/pen-testing/assessments/I1.md.
//
// The complement, G1-7 (#195), is the Gateway following a redirect off the
// account's origin. This is the account's own endpoint being internal.
//
// Fixed (I1-1, ADR 0007): the Gateway never connects to an internal
// address, by its form or by what its name resolves to, unless the Owner
// allowed the host in ALLOWED_INTERNAL_HOSTS. The package's tests allow
// loopback for their fake AI Providers (`test-setup.ts`); here, as the
// Gateway starts, nothing is allowed.

/** A sandbox's own Gateway Key (position 3). */
const sandboxKey = "aio_gk_i1sandboxkeyreadstheinternalanswer000";
const sandbox: GatewayCaller = {
  kind: "agent",
  keyId: "i1-sandbox",
  agentId: "ada",
  floorId: "web-shop",
  name: "Ada",
};
const keys = staticKeys({
  [gatewayKey]: testCaller,
  [sandboxKey]: sandbox,
});

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;
let proxy: FakeProxy | undefined;
/** The hosts the package's tests allow, put back after each test. */
const testsAllow = allowedInternalHosts();

beforeEach(() => {
  // As the Gateway starts: ALLOWED_INTERNAL_HOSTS names nothing.
  allowInternalHosts([]);
});

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  await proxy?.close();
  gateway = undefined;
  upstream = undefined;
  proxy = undefined;
  allowInternalHosts(testsAllow);
});

/** A body that stands in for the EC2 metadata service's role credentials. */
const metadataBody = JSON.stringify({
  AccessKeyId: "AKIAFAKEFAKEFAKEFAKE",
  SecretAccessKey: "fake-secret-not-a-real-credential",
  Token: "fake-session-token",
});

/** An internal service (metadata, Postgres' REST proxy, app:3047) on loopback. */
const internalService = () =>
  startFakeUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(metadataBody);
  });

const account = (baseUrl: string): GatewayAccount => ({
  id: "attacker-endpoint",
  name: "Owner's endpoint",
  apiKey: accountKey,
  baseUrl,
  apiFormat: "anthropic",
});

const call = (key: string) =>
  fetch(`${gateway?.url ?? ""}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 16,
      messages: [],
    }),
  });

/**
 * Whether a URL is one the Gateway should never fetch an AI Account from:
 * a loopback, link-local or private address, or a bare internal name. The
 * property I1-1 asserts should hold; nothing in the Gateway computes it.
 */
const isInternalEndpoint = (baseUrl: string): boolean => {
  const { hostname } = new URL(baseUrl);
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("169.254.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // A bare single-label name resolved on the stack's own network (app, postgres).
    !host.includes(".")
  );
};

describe("I1-1 (H13): a custom AI endpoint on an internal address", () => {
  it("regression (I1-1): the Gateway no longer fetches a loopback endpoint, nor returns its body to the Gateway Key holder", async () => {
    upstream = await internalService();
    gateway = await startGateway({
      accounts: staticAccounts(account(upstream.url)),
      keys,
    });

    const response = await call(sandboxKey);

    // The endpoint is 127.0.0.1 (a stand-in for the metadata service). The
    // Gateway did not connect to it, and its answer is its own.
    expect(isInternalEndpoint(upstream.url)).toBe(true);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("AKIAFAKEFAKEFAKEFAKE");
    expect(upstream.received).toHaveLength(0);
  });

  it("the Gateway refuses an AI Account whose endpoint is a loopback, link-local or private address", async () => {
    upstream = await internalService();
    const baseUrl = upstream.url;
    gateway = await startGateway({
      accounts: staticAccounts(account(baseUrl)),
      keys,
    });

    const response = await call(sandboxKey);

    // The property: an internal endpoint is never fetched, so its body
    // never reaches the caller.
    expect(isInternalEndpoint(baseUrl)).toBe(true);
    const body = await response.text();
    expect(body).not.toContain("AKIAFAKEFAKEFAKEFAKE");
    expect(upstream.received).toHaveLength(0);
  });

  it("the Gateway fetches an internal endpoint the Owner allowed, such as their own Ollama", async () => {
    upstream = await internalService();
    allowInternalHosts(["127.0.0.1"]);
    gateway = await startGateway({
      accounts: staticAccounts(account(upstream.url)),
      keys,
    });

    const response = await call(sandboxKey);

    expect(response.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
  });
});

describe("I1-1 siblings: every other way the Gateway reaches upstream", () => {
  it("an endpoint whose public-looking name resolves to an internal address is refused as it connects", async () => {
    upstream = await internalService();
    const port = new URL(upstream.url).port;
    // A hostile DNS answer: a public-looking name for the loopback service.
    // The Gateway's own fetch, with the system resolver swapped for one
    // that answers so (there is no DNS here).
    const resolve = (hostname: string) =>
      hostname === "metadata.attacker.example"
        ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
        : Promise.reject(new Error(`${hostname} not found`));
    const endpoint = `http://metadata.attacker.example:${port}`;
    gateway = await startGateway({
      accounts: staticAccounts(account(endpoint)),
      keys,
      fetch: ownerFetch({ resolve }),
    });

    const response = await call(sandboxKey);

    expect(await response.text()).not.toContain("AKIAFAKEFAKEFAKEFAKE");
    expect(upstream.received).toHaveLength(0);
    // The name does reach the service once the Owner allows it.
    await ownerFetch({
      resolve,
      allowed: () => ["metadata.attacker.example"],
    })(endpoint);
    expect(upstream.received).toHaveLength(1);
  });

  it("the upstream fetch the server gives every Gateway path (model lists, prices, sign-ins, keep-alives) refuses an internal host, directly or through the proxy", async () => {
    upstream = await internalService();
    let set: OutboundProxy | null = null;
    const upstreamFetch = createUpstreamFetch({ proxy: () => set });
    try {
      // Directly.
      await expect(
        upstreamFetch.fetch(`${upstream.url}/v1/models`),
      ).rejects.toThrow(/internal address/);
      // Through the Owner's proxy: an internal host it would be asked for,
      // and a proxy that is itself internal.
      proxy = await startFakeProxy({ hosts: { app: upstream.url } });
      set = { url: proxy.url, username: null, password: null, noProxy: [] };
      await expect(
        upstreamFetch.fetch("http://app:3047/v1/models"),
      ).rejects.toThrow(/internal address \(app\)/);
      await expect(
        upstreamFetch.fetch("https://api.example.com/v1/models"),
      ).rejects.toThrow(/The proxy is on an internal address/);
      expect(upstream.received).toHaveLength(0);
      expect(proxy.proxied).toHaveLength(0);
    } finally {
      await upstreamFetch.close();
    }
  });
});
