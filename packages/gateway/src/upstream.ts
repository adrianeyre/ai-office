import {
  bypassesProxy,
  isAllowedHost,
  isInternalHost,
  type OutboundProxy,
} from "@ai-office/shared";
import {
  InternalHostError,
  checkOwnerUrl,
  ownerFetch,
} from "@ai-office/shared/internal-hosts-guard";
import { ProxyAgent, type Dispatcher } from "undici";

// How the AI Gateway reaches upstream (PRD FR-35): every request it makes
// to an AI Provider (requests through AI Accounts, model lists, published
// prices, OAuth sign-ins, token refreshes, usage, keep-alives and
// auto-refreshes) goes through one `fetch`, which sends it through the
// Owner's outbound HTTP proxy while one is set. The proxy is asked for on
// every request, so a change applies to the next one without a restart. A
// request to the AI Office host itself, or to a host the Owner listed, is
// sent directly. The proxy's password goes only to the proxy, as its
// `proxy-authorization`. No redirect is followed (pen-testing G1-7): an AI
// Account's credential, a token or a prompt goes only where it was sent.
//
// None of it reaches an internal address the Owner did not allow in
// ALLOWED_INTERNAL_HOSTS (ADR 0007, I1-1): a direct request is checked as
// each connection is made, whatever its name resolves to; through the
// proxy, the proxy is checked so, and the host asked for by its form,
// since the proxy resolves it in its own network.

/** A `fetch`, and a way to let its proxy's connections go. */
export interface UpstreamFetch {
  readonly fetch: typeof fetch;
  /** Closes the proxy's connections, if one was used. */
  close(): Promise<void>;
}

/** `proxy-authorization` for a proxy's username and password. */
const proxyAuthorization = (proxy: OutboundProxy): string | undefined =>
  proxy.username === null
    ? undefined
    : `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}`;

/** The URL a `fetch` call asks for, whichever way it was given. */
const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

/**
 * A `fetch` that goes through `proxy()`'s proxy while there is one (null
 * for none), and directly otherwise.
 */
export function createUpstreamFetch(options: {
  readonly proxy: () => OutboundProxy | null;
  /**
   * The `fetch` underneath; by default Node's own, refusing internal
   * addresses the Owner did not allow (`ownerFetch`).
   */
  readonly fetch?: typeof fetch;
}): UpstreamFetch {
  const direct = options.fetch ?? ownerFetch();
  const viaProxy = options.fetch ?? fetch;
  /** The agent for the proxy last used, kept while it stays the same. */
  let current: { key: string; agent: ProxyAgent } | undefined;

  const agentFor = (proxy: OutboundProxy): Dispatcher => {
    const token = proxyAuthorization(proxy);
    const key = JSON.stringify([proxy.url, token ?? null]);
    if (current?.key !== key) {
      const previous = current?.agent;
      current = {
        key,
        agent: new ProxyAgent({
          uri: proxy.url,
          ...(token === undefined ? {} : { token }),
        }),
      };
      // Requests still on the old proxy finish first.
      void previous?.close().catch(() => undefined);
    }
    return current.agent;
  };

  return {
    fetch: async (input, init) => {
      // A redirect is not followed unless the caller asks: what is sent
      // upstream (an AI Account's credential, a token, a prompt) goes only
      // where it was addressed (pen-testing G1-7).
      const sent: RequestInit = { redirect: "manual", ...init };
      const proxy = options.proxy();
      if (proxy === null || bypassesProxy(urlOf(input), proxy.noProxy)) {
        return direct(input, sent);
      }
      const { hostname } = new URL(urlOf(input));
      if (!isAllowedHost(hostname) && isInternalHost(hostname)) {
        throw new InternalHostError(hostname);
      }
      await checkOwnerUrl(proxy.url, { what: "The proxy" });
      // undici's own agent, which Node's `fetch` takes, though its types
      // are a release behind.
      const dispatcher = agentFor(proxy) as unknown as NonNullable<
        RequestInit["dispatcher"]
      >;
      return viaProxy(input, { ...sent, dispatcher });
    },
    async close() {
      const agent = current?.agent;
      current = undefined;
      await agent?.close();
    },
  };
}
