import { z } from "zod";

import { ownerUrl } from "./internal-hosts.ts";

// The outbound HTTP proxy (PRD FR-35): optional, and off until the Owner
// sets one. While it is set, everything the AI Gateway sends upstream goes
// through it: requests to AI Accounts, model lists, published prices,
// subscriptions' sign-ins, token refreshes and usage, keep-alives and
// auto-refreshes. A server on the AI Office host itself (`localhost`,
// `127.0.0.1`, `::1`), such as the Owner's own Ollama, is reached
// directly, as is any host the Owner lists to bypass it. Its password is
// stored encrypted and never sent back. Set at runtime in the office
// admin. The server and the web app share these.

/** The most hosts the proxy may be bypassed for. */
export const maxNoProxyHosts = 50;

/**
 * The proxy's address: `http://` or `https://`, a host and a port, with
 * no path, and no credentials (they have their own fields). An internal
 * host only when ALLOWED_INTERNAL_HOSTS names it.
 */
export const outboundProxyUrlSchema = z
  .url({
    protocol: /^https?$/,
    error:
      "The proxy is an http:// or https:// URL, such as http://proxy:3128.",
    abort: true,
  })
  .refine(
    (value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    },
    {
      error:
        "Leave credentials out of the proxy URL; the username and password have their own fields.",
      abort: true,
    },
  )
  .refine(
    (value) => {
      const url = new URL(value);
      return url.pathname === "/" && url.search === "" && url.hash === "";
    },
    { error: "The proxy URL is a host and port, with no path or query." },
  )
  // Every upstream request goes through it (ADR 0007), most of them
  // https:// inside its own connection, so plain http:// is its norm.
  .superRefine(ownerUrl("The proxy", { plainHttp: true }))
  .transform((value) => new URL(value).origin);

/**
 * A host the proxy is bypassed for: a name (`ollama.lan`, which also
 * covers its subdomains), a domain (`.internal`), an IP address, or `*`
 * for every host.
 */
export const noProxyHostSchema = z
  .string({ error: "A host to bypass the proxy for is a name or address." })
  .trim()
  .toLowerCase()
  .regex(/^(?:\*|\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[0-9a-f:]*:[0-9a-f:]+)$/, {
    error:
      "A host to bypass the proxy for is a name (ollama.lan), a domain (.internal) or an IP address, without a port.",
  });

/** The proxy's username: one token, without a colon. */
const username = z
  .string({ error: "Enter the proxy's username." })
  .trim()
  .min(1, { error: "Enter the proxy's username." })
  .max(256, { error: "That is too long for the proxy's username." })
  .regex(/^[^\s:]*$/, {
    error: "The proxy's username has no spaces or colons in it.",
  });

/** The proxy's password: never sent back. */
const password = z
  .string({ error: "Enter the proxy's password." })
  .min(1, { error: "Enter the proxy's password." })
  .max(1024, { error: "That is too long for the proxy's password." })
  .regex(/^\S*$/, { error: "The proxy's password has no spaces in it." });

/**
 * The body of `PUT /api/office/outbound-proxy`. A null `url` turns the
 * proxy off, and forgets its username and password. An absent `password`
 * keeps the one stored, while the username stays the same; null removes
 * it.
 */
export const outboundProxyUpdateSchema = z
  .strictObject({
    url: outboundProxyUrlSchema.nullable(),
    username: username.nullable().optional(),
    password: password.nullable().optional(),
    noProxy: z
      .array(noProxyHostSchema)
      .max(maxNoProxyHosts, {
        error: `List at most ${String(maxNoProxyHosts)} hosts to bypass the proxy for.`,
      })
      .optional(),
  })
  .refine(
    (update) =>
      update.url !== null ||
      (update.username == null && update.password == null),
    {
      path: ["url"],
      error: "Enter the proxy's URL, or leave the username and password out.",
    },
  )
  .refine((update) => update.password == null || update.username != null, {
    path: ["username"],
    error: "Enter the username the password is for.",
  });
export type OutboundProxyUpdate = z.infer<typeof outboundProxyUpdateSchema>;

/** `GET /api/office/outbound-proxy`: everything but the password. */
export const outboundProxySettingsSchema = z.object({
  /** Null while there is no proxy. */
  url: z.string().nullable(),
  username: z.string().nullable(),
  /** Whether a password is stored; it is never sent back. */
  hasPassword: z.boolean(),
  /** Hosts reached directly, besides the AI Office host itself. */
  noProxy: z.array(z.string()),
});
export type OutboundProxySettings = z.infer<typeof outboundProxySettingsSchema>;

export const defaultOutboundProxySettings: OutboundProxySettings = {
  url: null,
  username: null,
  hasPassword: false,
  noProxy: [],
};

/**
 * The proxy as the AI Gateway uses it: its password opened. Never sent to
 * the web app, logged or put in an event.
 */
export interface OutboundProxy {
  readonly url: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly noProxy: readonly string[];
}

/** A loopback host: the AI Office host itself, never proxied. */
const loopback = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  /^127(?:\.\d{1,3}){3}$/.test(host) ||
  host === "::1" ||
  host === "[::1]";

/**
 * Whether a request to `url` bypasses `proxy`: one to the AI Office host
 * itself, or to a host the Owner listed (a name covering its subdomains,
 * a `.domain`, an address, or `*` for every host).
 */
export const bypassesProxy = (
  url: URL | string,
  noProxy: readonly string[],
): boolean => {
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    loopback(host) ||
    noProxy.some((entry) => {
      const listed = entry.toLowerCase();
      if (listed === "*") {
        return true;
      }
      const domain = listed.replace(/^\./, "");
      return host === domain || host.endsWith(`.${domain}`);
    })
  );
};
