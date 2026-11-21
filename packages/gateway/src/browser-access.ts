import type { FastifyInstance, FastifyRequest } from "fastify";

// Browser access to the AI Gateway (ADR 0013): an Owner tool's Gateway
// Key may be used from a web page in a browser, on the origins its Browser
// access lists or on any. A preflight presents no key, so it is answered,
// before anything else, when any key in use allows its origin; every
// answer to a page its key allows (refusals and errors too, or the browser
// would hide them) names its origin. No answer ever allows credentials:
// the Gateway authenticates by Gateway Key alone, so a cookie stays
// useless. A request without `Origin` is answered as it always was.

/** Whether a path is the Gateway's API: `/v1` and everything under it. */
const isV1Path = (url: string): boolean => /^\/v1(?:[/?#]|$)/.test(url);

/** The methods a page may use: the Gateway's routes take no other. */
const allowedMethods = ["GET", "POST"] as const;

/**
 * The request headers a page in a browser may send: a Gateway Key
 * (`authorization` or `x-api-key`), the body's type, and the headers
 * Anthropic's and OpenAI's SDKs add. Not `user-agent`, which the Gateway
 * reads to tell which agent tool is calling (FR-35): a page never claims
 * one, so a subscription is never served to a browser.
 */
const allowedRequestHeaders = new Set([
  "authorization",
  "x-api-key",
  "content-type",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "openai-organization",
  "openai-project",
]);

/**
 * Anthropic's and OpenAI's JavaScript SDKs send `x-stainless-*` headers
 * (their version, runtime and retry count) with every call, in a browser
 * too; a preflight that left them out would stop those SDKs calling at
 * all. They are information only: the Gateway decides nothing by them.
 */
const sdkHeader = /^x-stainless-[a-z0-9-]+$/;

/** The answer's headers a page in a browser may read. */
export const exposedResponseHeaders = (refusalHeader: string): string =>
  ["retry-after", "request-id", "x-request-id", refusalHeader].join(", ");

/** How long a browser may keep a preflight's answer, in seconds. */
export const preflightMaxAgeSeconds = 600;

/** The requested headers a preflight allows: those listed, lowercased. */
export function allowedHeadersOf(requested: string | undefined): string[] {
  if (requested === undefined) {
    return [];
  }
  const names = requested
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => allowedRequestHeaders.has(name) || sdkHeader.test(name));
  return [...new Set(names)];
}

const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * The origin of a request from a web page on another origin: its `Origin`
 * header, on a `/v1` path, unless it names the address the request was
 * sent to (a page of AI Office's own, which may send `Origin` with its own
 * requests). Undefined for a request that is not cross-origin.
 */
export function crossOriginOf(request: FastifyRequest): string | undefined {
  const origin = single(request.headers.origin);
  if (origin === undefined || !isV1Path(request.url)) {
    return undefined;
  }
  const host = single(request.headers.host)?.toLowerCase();
  let own: string | undefined;
  try {
    own = new URL(origin).host.toLowerCase();
  } catch {
    own = undefined;
  }
  return host !== undefined && own === host ? undefined : origin;
}

/**
 * Answers browsers' preflights for the origins some Gateway Key allows,
 * and names a page's origin on every answer to it that its key allows
 * (ADR 0013). Registered before any other hook, so a preflight is answered
 * before the Gateway Key is asked for, a request is recorded or a body is
 * read, and before an unknown route is refused.
 */
export function allowBrowserOrigins(
  app: FastifyInstance,
  options: {
    /**
     * Whether any Gateway Key in use allows a page on `origin`: for a
     * preflight, and an answer sent before a key was checked.
     */
    readonly anyKeyAllows: (origin: string) => Promise<boolean>;
    /**
     * Whether the key a request presented allows a page on `origin`;
     * undefined if no key in use was presented, or none checked yet.
     */
    readonly callerAllows: (
      request: FastifyRequest,
      origin: string,
    ) => boolean | undefined;
    /** The answer's header naming why AI Office refused a call itself. */
    readonly refusalHeader: string;
  },
): void {
  const exposed = exposedResponseHeaders(options.refusalHeader);
  /** Each cross-origin request, and its origin. */
  const crossOrigin = new WeakMap<FastifyRequest, string>();
  /** Each preflight granted. */
  const granted = new WeakSet<FastifyRequest>();
  const anyKeyAllows = async (request: FastifyRequest, origin: string) => {
    try {
      return await options.anyKeyAllows(origin);
    } catch (error) {
      request.log.error(
        { err: error },
        "The Gateway Keys' browser access could not be read.",
      );
      return false;
    }
  };

  app.addHook("onRequest", async (request, reply) => {
    const origin = crossOriginOf(request);
    if (origin === undefined) {
      return undefined;
    }
    crossOrigin.set(request, origin);
    if (request.method !== "OPTIONS") {
      return undefined;
    }
    const method = single(request.headers["access-control-request-method"]);
    if (
      method === undefined ||
      !(allowedMethods as readonly string[]).includes(method) ||
      !(await anyKeyAllows(request, origin))
    ) {
      // Not a preflight the Gateway grants: refused as any OPTIONS is.
      return undefined;
    }
    granted.add(request);
    const headers = allowedHeadersOf(
      single(request.headers["access-control-request-headers"]),
    );
    return reply
      .code(204)
      .headers({
        "access-control-allow-methods": allowedMethods.join(", "),
        ...(headers.length === 0
          ? {}
          : { "access-control-allow-headers": headers.join(", ") }),
        "access-control-max-age": String(preflightMaxAgeSeconds),
      })
      .send();
  });

  // On every answer to a page its key allows, however it was sent: a
  // route's, a refusal's, an error's or a stream's, just before its
  // headers go. Before a key was checked (none, or one not in use), when
  // any key allows the page: no more than its preflight already said.
  app.addHook("onSend", async (request, reply, payload) => {
    const origin = crossOrigin.get(request);
    if (origin === undefined) {
      return payload;
    }
    if (request.method === "OPTIONS") {
      if (!granted.has(request)) {
        return payload;
      }
    } else {
      const allowed =
        options.callerAllows(request, origin) ??
        (await anyKeyAllows(request, origin));
      if (!allowed) {
        return payload;
      }
      // What an AI Provider said about its own CORS is not passed on: the
      // key decides, and credentials are never allowed.
      for (const name of Object.keys(reply.getHeaders())) {
        if (name.toLowerCase().startsWith("access-control-")) {
          reply.removeHeader(name);
        }
      }
      reply.header("access-control-expose-headers", exposed);
    }
    const vary = reply.getHeader("vary");
    const varies =
      vary === undefined
        ? []
        : String(vary)
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== "");
    if (!varies.some((name) => name.toLowerCase() === "origin")) {
      varies.push("Origin");
    }
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", varies.join(", "));
    return payload;
  });
}
