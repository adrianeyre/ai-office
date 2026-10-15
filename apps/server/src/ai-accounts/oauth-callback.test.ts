import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../logger.ts";
import {
  createOAuthCallbacks,
  localCallback,
  type OAuthCallbacks,
} from "./oauth-callback.ts";

// A sign-in's local callback (ChatGPT's localhost:1455), served while the
// sign-in waits: the browser's landing finishes it, and the port is let go
// once nothing waits for it.

const open: OAuthCallbacks[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((callbacks) => callbacks.close()));
});

/** A port nothing listens on. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(
          typeof address === "object" && address !== null ? address.port : 0,
        );
      });
    });
  });

const logger = createLogger({
  level: "silent",
  secrets: [],
  destination: { write: () => true },
});

async function setUp(complete: (url: string) => Promise<unknown>) {
  const port = await freePort();
  const redirectUri = `http://localhost:${String(port)}/auth/callback`;
  const state = { awaiting: true, completed: [] as string[] };
  const callbacks = createOAuthCallbacks({
    host: "127.0.0.1",
    complete: async (url) => {
      state.completed.push(url);
      return complete(url);
    },
    awaiting: () => state.awaiting,
    logger,
    checkMs: 20,
  });
  open.push(callbacks);
  return { port, redirectUri, state, callbacks };
}

describe("a sign-in's local callback", () => {
  it("finishes the sign-in the browser lands with, then lets the port go", async () => {
    const setup = await setUp(() => {
      setup.state.awaiting = false;
      return Promise.resolve();
    });
    await setup.callbacks.expect(setup.redirectUri);
    const landed = `http://127.0.0.1:${String(setup.port)}/auth/callback?code=ac_1&state=abc`;
    const response = await fetch(landed);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Signed in");
    expect(setup.state.completed).toEqual([
      `http://localhost:${String(setup.port)}/auth/callback?code=ac_1&state=abc`,
    ]);
    await expect
      .poll(() =>
        fetch(landed).then(
          () => "open",
          () => "closed",
        ),
      )
      .toBe("closed");
  });

  it("says why when the sign-in was refused, or its code was", async () => {
    const setup = await setUp(() =>
      Promise.reject(new Error("The AI Provider refused that code.")),
    );
    await setup.callbacks.expect(setup.redirectUri);
    const base = `http://127.0.0.1:${String(setup.port)}/auth/callback`;
    const denied = await fetch(`${base}?error=access_denied&state=abc`);
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("cancelled or refused");
    const refused = await fetch(`${base}?code=ac_1&state=abc`);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(
      "The AI Provider refused that code.",
    );
    expect(
      (await fetch(`http://127.0.0.1:${String(setup.port)}/`)).status,
    ).toBe(404);
  });

  // The listener is not the app's, so the app's hooks never set them
  // (pen-testing I2-1, as /v1's).
  it("carries the security headers on every answer, its page, a refusal and a 404, with its own stricter Referrer-Policy", async () => {
    const setup = await setUp(() => Promise.resolve());
    await setup.callbacks.expect(setup.redirectUri);
    const base = `http://127.0.0.1:${String(setup.port)}`;
    for (const path of [
      "/auth/callback?code=ac_1&state=abc",
      "/auth/callback?error=access_denied&state=abc",
      "/elsewhere",
    ]) {
      const { headers } = await fetch(`${base}${path}`);
      expect(headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(headers.get("x-frame-options"), path).toBe("DENY");
      expect(headers.get("content-security-policy"), path).toContain(
        "frame-ancestors 'none'",
      );
      expect(headers.get("referrer-policy"), path).toBe(
        path === "/elsewhere" ? "same-origin" : "no-referrer",
      );
      // Plain http on this machine: no HSTS.
      expect(headers.get("strict-transport-security"), path).toBeNull();
    }
  });

  it("leaves the Owner to paste the address when the port is in use", async () => {
    const setup = await setUp(() => Promise.resolve());
    const busy = createServer();
    await new Promise<void>((resolve) => {
      busy.listen(setup.port, "127.0.0.1", resolve);
    });
    try {
      await expect(setup.callbacks.expect(setup.redirectUri)).resolves.toBe(
        undefined,
      );
    } finally {
      busy.close();
    }
  });

  it("serves only local addresses", () => {
    expect(localCallback("http://localhost:1455/auth/callback")).toEqual({
      port: 1455,
      path: "/auth/callback",
    });
    expect(
      localCallback("https://console.anthropic.com/oauth/code/callback"),
    ).toBe(undefined);
    expect(localCallback("http://localhost/callback")).toBeUndefined();
  });
});
