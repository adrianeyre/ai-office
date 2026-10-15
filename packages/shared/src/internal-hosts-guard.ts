import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

import { Agent, buildConnector, type Dispatcher } from "undici";

import {
  allowedInternalHosts,
  internalHostProblem,
  isAllowedHost,
  isInternalAddress,
  isInternalHost,
  isIpAddress,
} from "./internal-hosts.ts";

// Where an Owner-triggered fetch is made (ADR 0007): a name the Owner gives
// may itself be public and still resolve to an internal address (a DNS
// name pointed at 169.254.169.254, or one that answers differently the
// second time). So each connection's addresses are checked as they are
// resolved, redirects' included, and a refused one never connects. A host
// the Owner allowed in ALLOWED_INTERNAL_HOSTS is reached whatever it
// resolves to. Node only; the address rules are `./internal-hosts.ts`.

/** A fetch AI Office refused: its host is, or resolves to, an internal address. */
export class InternalHostError extends Error {
  readonly host: string;

  constructor(host: string, what = "That address") {
    super(internalHostProblem(what, host));
    this.name = "InternalHostError";
    this.host = host;
  }
}

/** The hosts allowed: the server's, unless a caller says. */
type AllowedHosts = () => readonly string[];

/** Every address a name resolves to: the system's resolver by default. */
export type Resolve = (hostname: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (hostname) => lookup(hostname, { all: true });

/** Who is asking, and how names resolve. */
export interface GuardOptions {
  readonly allowed?: AllowedHosts;
  readonly resolve?: Resolve;
}

/** The host part of an address, as a connection is made to it. */
const hostOf = (url: string): string =>
  new URL(url).hostname.replace(/^\[|\]$/g, "");

/**
 * Checks a host the Owner gave before AI Office reaches it: by its form,
 * then by every address it resolves to. Resolves to the address to connect
 * to (undefined for an allowed host, or a name that does not resolve,
 * whose fetch fails on its own); throws `InternalHostError` otherwise.
 */
export async function checkOwnerHost(
  host: string,
  options: GuardOptions & { readonly what?: string } = {},
): Promise<string | undefined> {
  const name = host.replace(/^\[|\]$/g, "");
  const allowed = (options.allowed ?? allowedInternalHosts)();
  if (isAllowedHost(name, allowed)) {
    return undefined;
  }
  if (isInternalHost(name)) {
    throw new InternalHostError(name, options.what);
  }
  if (isIpAddress(name)) {
    return name;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await (options.resolve ?? systemResolve)(name);
  } catch {
    return undefined;
  }
  if (addresses.some(({ address }) => isInternalAddress(address))) {
    throw new InternalHostError(name, options.what);
  }
  return addresses[0]?.address;
}

/** `checkOwnerHost` for a URL's host. */
export const checkOwnerUrl = (
  url: string,
  options: GuardOptions & { readonly what?: string } = {},
): Promise<string | undefined> => checkOwnerHost(hostOf(url), options);

/**
 * A DNS lookup that fails for a name, not allowed, any of whose addresses
 * is internal.
 */
const guardedLookup =
  (allowed: AllowedHosts, resolve: Resolve): LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname).then(
      (resolved) => {
        const addresses = resolved.filter(
          ({ family }) =>
            options.family === undefined ||
            options.family === 0 ||
            family === options.family,
        );
        if (
          !isAllowedHost(hostname, allowed()) &&
          resolved.some(({ address }) => isInternalAddress(address))
        ) {
          callback(new InternalHostError(hostname), "", 0);
          return;
        }
        const [first] = addresses;
        if (first === undefined) {
          callback(
            Object.assign(new Error(`${hostname} has no address`), {
              code: "ENOTFOUND",
            }),
            "",
            0,
          );
        } else if (options.all === true) {
          callback(null, addresses);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => {
        callback(error as Error, "", 0);
      },
    );
  };

/**
 * A dispatcher whose every connection is checked: an IP address as given,
 * a name as it resolves.
 */
export function ownerDispatcher(options: GuardOptions = {}): Dispatcher {
  const allowed = options.allowed ?? allowedInternalHosts;
  const connect = buildConnector({
    lookup: guardedLookup(allowed, options.resolve ?? systemResolve),
  });
  return new Agent({
    connect: (options, callback) => {
      const host = options.hostname.replace(/^\[|\]$/g, "");
      // Node never looks an address up, so it is checked here.
      if (
        isIpAddress(host) &&
        isInternalAddress(host) &&
        !isAllowedHost(host, allowed())
      ) {
        callback(new InternalHostError(host), null);
        return;
      }
      connect(options, callback);
    },
  });
}

/**
 * A `fetch` for addresses the Owner gives: the host is checked first
 * (`checkOwnerUrl`, whose `InternalHostError` it throws as is), and then
 * every connection, redirects' included, as it is made.
 */
export function ownerFetch(
  options: GuardOptions & {
    /** The `fetch` underneath; Node's own by default. */
    readonly fetch?: typeof fetch;
  } = {},
): typeof fetch {
  const send = options.fetch ?? fetch;
  // undici's own agent, which Node's `fetch` takes, though its types are a
  // release behind.
  const dispatcher = ownerDispatcher(options) as unknown as NonNullable<
    RequestInit["dispatcher"]
  >;
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    await checkOwnerUrl(url, options);
    return send(input, { ...init, dispatcher });
  };
}
