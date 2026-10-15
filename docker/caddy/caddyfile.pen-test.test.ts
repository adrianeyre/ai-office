import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// A1 probe (pen-testing, "Sign-in and sessions"): what Caddy adds in front
// of the app (H6, and the client address of H3). Read from the Caddyfile
// itself: running Caddy needs Docker, which the probe's sandbox lacks. The
// app's own answers are probed in `apps/server/src/app.pen-test.test.ts`.

const caddyfile = await readFile(
  join(import.meta.dirname, "Caddyfile"),
  "utf8",
);

/** The Caddyfile's lines, without comments or blank lines. */
const directives = caddyfile
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter((line) => line !== "");

const securityHeaders = [
  "Strict-Transport-Security",
  "Content-Security-Policy",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
];

/** The response headers a `header` directive sets, by name. */
const headersSet = () =>
  directives
    .filter((line) => /^header\b/.test(line) || /^[A-Z][\w-]+\s/.test(line))
    .flatMap((line) =>
      securityHeaders.filter((name) =>
        line.toLowerCase().includes(name.toLowerCase()),
      ),
    );

describe("A1-6: security headers through Caddy", () => {
  it("Caddy adds HSTS, CSP, X-Frame-Options, nosniff and Referrer-Policy", () => {
    expect(headersSet()).toEqual(securityHeaders);
  });

  it("regression (A1-6): the Caddyfile no longer has no header directive", () => {
    expect(directives.some((line) => /^header\b/.test(line))).toBe(true);
    expect(headersSet()).not.toEqual([]);
  });
});

describe("A1-6 · the sibling paths through Caddy", () => {
  /** Each `header` line's field and value: `[field, value]`. */
  const headerLines = directives
    .map((line) => /^header\s+(\S+)\s+"(.*)"$/.exec(line))
    .filter((match) => match !== null)
    .map(([, field = "", value = ""]) => [field, value] as const);

  it("each only fills a header the app did not send, so the app's own policies are kept", () => {
    // `?` sets a default; without it Caddy would replace a page's policy
    // (its inline scripts' hashes) and an attachment's stricter one.
    expect(headerLines.map(([field]) => field)).toEqual(
      securityHeaders.map((name) => `?${name}`),
    );
  });

  it("Caddy's own answers (the app down) may be framed by no site and run nothing", () => {
    expect(new Map(headerLines).get("?Content-Security-Policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(new Map(headerLines).get("?X-Frame-Options")).toBe("DENY");
  });

  it("HSTS without includeSubDomains or preload: other names under the Owner's domain are theirs", () => {
    expect(new Map(headerLines).get("?Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
  });
});

describe("Caddy where it holds", () => {
  it("trusts no proxy, so it replaces a client's X-Forwarded-For with the real peer", () => {
    // Caddy's reverse_proxy ignores incoming X-Forwarded-* unless the
    // client is in trusted_proxies; with TRUST_PROXY=1 the app then sees
    // the real client. The gap is callers that bypass Caddy (A1-1).
    expect(caddyfile).not.toMatch(/trusted_proxies/);
    expect(caddyfile).not.toMatch(/header_up\s+X-Forwarded-For/i);
  });

  it("proxies to the app's web port only, never the Gateway", () => {
    expect(
      directives.filter((line) => line.startsWith("reverse_proxy")),
    ).toEqual(["reverse_proxy app:3045 {"]);
  });

  it("A1-1: proves to the app that a request came through it, with PROXY_SECRET", () => {
    // The app believes X-Forwarded-For only from a request that carries it.
    expect(directives).toContain(
      "header_up X-AI-Office-Proxy {env.PROXY_SECRET}",
    );
  });
});

// Since one entry point (origin/main, merged into the pen-testing fixes),
// Caddy proxies the AI Gateway's /v1 paths to the app's port as well. They
// must go the same way as every other path: with the proof (A1-1), which
// the app takes off before the Gateway sees it, and with the security
// headers' defaults (A1-6), which the app's own /v1 answers carry anyway.
describe("A1-1, A1-6 · the AI Gateway's /v1 through Caddy", () => {
  it("is proxied by the one reverse_proxy that sends the proof, with no path matcher to send /v1 another way", () => {
    expect(
      directives.filter((line) => line.startsWith("reverse_proxy")),
    ).toEqual(["reverse_proxy app:3045 {"]);
    // A matcher (`@name`, a path) or a route of its own would let /v1 skip
    // the proof or the headers.
    expect(
      directives.filter((line) =>
        /^(handle|handle_path|route|respond|rewrite|uri|@)/.test(line),
      ),
    ).toEqual([]);
    const proxy = directives.slice(
      directives.indexOf("reverse_proxy app:3045 {"),
    );
    expect(proxy.slice(0, proxy.indexOf("}"))).toContain(
      "header_up X-AI-Office-Proxy {env.PROXY_SECRET}",
    );
  });

  it("gives /v1 the security headers' defaults: no header directive names a path", () => {
    const headerLines = directives.filter((line) => /^header\b/.test(line));
    expect(headerLines).toHaveLength(securityHeaders.length);
    for (const line of headerLines) {
      expect(line).toMatch(/^header \?[A-Z]/);
    }
  });
});
