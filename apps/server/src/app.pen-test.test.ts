import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probedApp } from "./pen-test-support.ts";
import { signIn, webBuild } from "./test-support.ts";

// A1 probe (pen-testing, "Sign-in and sessions"): security headers on the
// app's own answers (H6). Position 1: a page the Owner's browser visits
// that frames AI Office, sniffs a response's type, or catches a first
// plain-http visit. Caddy's side is `docker/caddy/caddyfile.pen-test.test.ts`.

let web: Awaited<ReturnType<typeof webBuild>>;
beforeAll(async () => {
  web = await webBuild();
});
afterAll(async () => {
  await web.remove();
});

/** The headers a browser needs to keep a page and its data in its place. */
const securityHeaders = [
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "strict-transport-security",
] as const;

const present = (response: LightMyRequestResponse) =>
  securityHeaders.filter((name) => response.headers[name] !== undefined);

/** The app's answers a browser renders or reads: a page, the API, health. */
async function answers() {
  const { server } = await probedApp({
    webDistDir: web.dir,
    publicUrl: "https://ai-office.example.com",
    secureCookie: true,
  });
  const owner = await signIn(server);
  return {
    "the login page": await server.inject({ url: "/login" }),
    "a signed-in page": await server.inject({
      url: "/",
      headers: { cookie: owner.cookie },
    }),
    "GET /api/session": await server.inject({
      url: "/api/session",
      headers: { cookie: owner.cookie },
    }),
    "a built file": await server.inject({ url: "/assets/app.js" }),
  };
}

describe("A1-6: security headers on the app's answers", () => {
  it("pages and API answers carry CSP (frame-ancestors), X-Frame-Options, nosniff, Referrer-Policy and HSTS", async () => {
    for (const [what, response] of Object.entries(await answers())) {
      expect({ what, present: present(response) }).toEqual({
        what,
        present: [...securityHeaders],
      });
    }
  });

  it("regression (A1-6): no longer is none of them sent, on a page, the API or a built file", async () => {
    for (const [what, response] of Object.entries(await answers())) {
      expect({
        what,
        status: response.statusCode,
        present: present(response),
      }).not.toEqual({ what, status: 200, present: [] });
      expect(String(response.headers["content-security-policy"])).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers).toMatchObject({
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
        "strict-transport-security": "max-age=31536000",
      });
    }
  });
});

describe("A1-6 · the sibling paths: every answer, however it is sent", () => {
  /** The headers but HSTS, which only https answers carry. */
  const everywhere = securityHeaders.filter(
    (name) => name !== "strict-transport-security",
  );

  it("refusals carry them: no session, a wrong password, an unknown path, a cross-site request", async () => {
    const { server } = await probedApp({ webDistDir: web.dir });
    const refusals = {
      "a page signed out": await server.inject({ url: "/" }),
      "the API signed out": await server.inject({ url: "/api/session" }),
      "a wrong password": await server.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "Not-The-Password-1" },
      }),
      "an unknown file": await server.inject({ url: "/nothing.js" }),
      "a cross-site request": await server.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin: "https://elsewhere.example" },
        payload: { password: "Not-The-Password-1" },
      }),
      "a malformed body": await server.inject({
        method: "POST",
        url: "/api/login",
        headers: { "content-type": "application/json" },
        payload: "{",
      }),
    };
    for (const [what, response] of Object.entries(refusals)) {
      expect(response.statusCode).toBeGreaterThanOrEqual(300);
      expect({ what, present: present(response) }).toEqual({
        what,
        present: everywhere,
      });
    }
  });

  it("a live stream, which writes its own head, carries them", async () => {
    const probed = await probedApp({ webDistDir: web.dir });
    const owner = await signIn(probed.server);
    const baseUrl = await probed.server.listen({ port: 0, host: "127.0.0.1" });
    try {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/events/stream`, {
        headers: { cookie: owner.cookie },
        signal: controller.signal,
      });
      controller.abort();
      expect(response.status).toBe(200);
      expect(
        everywhere.filter((name) => response.headers.get(name) !== null),
      ).toEqual(everywhere);
    } finally {
      await probed.server.close();
    }
  });

  it("HSTS only over https: not for a plain-http PUBLIC_URL, nor with none", async () => {
    for (const publicUrl of ["http://localhost:3045", undefined]) {
      const { server } = await probedApp({
        webDistDir: web.dir,
        ...(publicUrl === undefined ? {} : { publicUrl }),
      });
      const page = await server.inject({ url: "/login" });
      expect(present(page)).toEqual(everywhere);
    }
  });

  it("a page allows its own inline scripts by their hashes, and no other inline script", async () => {
    const inline = "document.documentElement.dataset.ready = 'yes';";
    await writeFile(
      join(web.dir, "index.html"),
      `<!doctype html><script>${inline}</script><script type="module" src="/assets/app.js"></script>`,
    );
    try {
      const { server } = await probedApp({ webDistDir: web.dir });
      const page = await server.inject({ url: "/login" });
      const scriptSrc =
        String(page.headers["content-security-policy"])
          .split(";")
          .map((directive) => directive.trim())
          .find((directive) => directive.startsWith("script-src ")) ?? "";
      const hash = createHash("sha256").update(inline).digest("base64");
      expect(scriptSrc).toBe(
        `script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash}'`,
      );
      // An API answer allows no inline script at all.
      const api = await server.inject({ url: "/api/session" });
      expect(String(api.headers["content-security-policy"])).toContain(
        "script-src 'self' 'wasm-unsafe-eval';",
      );
    } finally {
      await writeFile(
        join(web.dir, "index.html"),
        "<!doctype html><p>AI Office",
      );
    }
  });
});

describe("headers where they hold", () => {
  it("the login page is served no-cache", async () => {
    const { server } = await probedApp({ webDistDir: web.dir });
    const page = await server.inject({ url: "/login" });
    expect(page.headers["cache-control"]).toBe("no-cache");
  });

  it("no answer names the server's software", async () => {
    const { server } = await probedApp({ webDistDir: web.dir });
    const page = await server.inject({ url: "/login" });
    expect(page.headers.server).toBeUndefined();
    expect(page.headers["x-powered-by"]).toBeUndefined();
  });
});
