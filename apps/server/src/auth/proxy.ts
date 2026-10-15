import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Who may tell the app about the client (A1-1). Sign-ins are limited and
// recorded per client address (PRD FR-4), and behind a reverse proxy that
// address comes from X-Forwarded-For. A hop count or an address range
// cannot tell the proxy from anything else that reaches the app's port
// directly, such as another container on the same Docker network, so the
// proxy also proves itself: it sends PROXY_SECRET in the X-AI-Office-Proxy
// header (`header_up` in the Caddyfile). The X-Forwarded-* headers of any
// other request are dropped before Fastify reads them, whatever TRUST_PROXY
// says.

/** The header the proxy in front of AI Office sends PROXY_SECRET in. */
export const proxyHeader = "x-ai-office-proxy";

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/**
 * Makes the function that keeps a request's X-Forwarded-* headers only when
 * it carries `secret` in `x-ai-office-proxy`, compared in constant time.
 * The proof itself is always removed, so nothing after it (a log line, a
 * route) can see it. With no secret, no request is believed.
 */
export function believeOnlyTheProxy(
  secret: string | undefined,
): (request: IncomingMessage) => void {
  const expected = secret === undefined ? undefined : digest(secret);
  return (request) => {
    const { headers } = request;
    const proof = headers["x-ai-office-proxy"];
    delete headers["x-ai-office-proxy"];
    const proven =
      expected !== undefined &&
      typeof proof === "string" &&
      timingSafeEqual(digest(proof), expected);
    if (!proven) {
      // What only the proxy may tell the app.
      delete headers["x-forwarded-for"];
      delete headers["x-forwarded-host"];
      delete headers["x-forwarded-proto"];
    }
  };
}
