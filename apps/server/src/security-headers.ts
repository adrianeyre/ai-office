import { createHash } from "node:crypto";

// Security headers on every answer the app sends (A1-6, H6): pages, the
// API, built files, live streams and refusals alike. The policy keeps the
// web app's pages to its own scripts, styles, images and connections, and
// lets no other site frame them. A page's own inline scripts (index.html's
// appearance script) are allowed by their hashes. A route may send a
// stricter policy of its own (the Manager chat's attachments do), which
// replaces this one.

/** The Content-Security-Policy, allowing these inline scripts' hashes. */
export function contentSecurityPolicy(
  scriptHashes: readonly string[] = [],
): string {
  return [
    "default-src 'self'",
    // The model loader's mesh decoder is WebAssembly.
    ["script-src 'self' 'wasm-unsafe-eval'", ...scriptHashes].join(" "),
    // Libraries set styles inline; styles run no code.
    "style-src 'self' 'unsafe-inline'",
    // The QR code and the company logo are data: URLs, a model's textures
    // blob: URLs. No other site's image: hostile Markdown cannot call out.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The CSP hashes (`'sha256-…'`) of `html`'s inline scripts: every
 * `<script>` without a `src`, its text exactly as served.
 */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes = ""]) => !/\bsrc\s*=/i.test(attributes))
    .map(
      ([, , text = ""]) =>
        `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`,
    );
}

/** One year: how long a browser keeps to https once it has seen it. */
const hstsMaxAgeSeconds = 365 * 24 * 60 * 60;

/** The headers every answer carries; HSTS only when served over https. */
export function securityHeaders({
  https,
}: {
  readonly https: boolean;
}): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    // No address in AI Office reaches another site (GitHub, through a
    // link); its own requests keep theirs.
    "referrer-policy": "same-origin",
    ...(https
      ? { "strict-transport-security": `max-age=${String(hstsMaxAgeSeconds)}` }
      : {}),
  };
}
