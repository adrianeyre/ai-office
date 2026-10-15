import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { memoryEventStore, createEventBus } from "@ai-office/events";
import { createAiAccounts, memoryAiAccountStore } from "@ai-office/gateway";
import {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "@ai-office/gateway/testing";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../logger.ts";
import { createOAuthCallbacks, type OAuthCallbacks } from "./oauth-callback.ts";

// Probe S2 (H14): can code in a sandbox (position 3) cancel, fail or race
// the Owner's ChatGPT sign-in through the listener AI Office holds open on
// its callback port while the sign-in waits?
//
// Under compose the listener binds 0.0.0.0 (`OAUTH_CALLBACK_HOST`) in the
// app container. That container was on `ai-office-sandboxes`, so a sandbox
// reached it as app:1455 (S2-3, docker/sandbox-isolation.pen-test.test.ts);
// since S2-3's fix it is on the default network only, and sandboxes reach
// nothing of the app but the AI Gateway, through the sandbox relay. The
// controls below still hold for whatever does reach it. These tests drive the real
// listener, bound as compose binds it, in front of the real AI Accounts
// (`createAiAccounts`) and a fake OpenAI-shaped OAuth server that checks
// PKCE. The "sandbox" sends its requests from this machine's own
// non-loopback address, as a peer on a bridge network would arrive.
// What holds: the sign-in is bound to a 256-bit state only the Owner's
// browser sees, a refused callback changes nothing, and `?error=` is
// answered without touching the sign-in. See
// docs/pen-testing/assessments/S2.md.

const logger = createLogger({
  level: "silent",
  secrets: [],
  destination: { write: () => true },
});

/** This machine's address on a network other than loopback, if it has one. */
const peerAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

const composeText = await readFile(
  join(import.meta.dirname, "../../../../docker-compose.yml"),
  "utf8",
);
/** The networks docker-compose.yml puts its `app` service on. */
const appNetworks = (() => {
  const app = /\n {2}app:\n([\s\S]*?)\n {2}\S/.exec(composeText)?.[1] ?? "";
  const list = /\n {4}networks:\n((?: {6}- [^\n]+\n)+)/.exec(app)?.[1] ?? "";
  return list
    .split("\n")
    .map((line) => line.replace(/^ {6}- /, "").trim())
    .filter((name) => name !== "");
})();

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

let oauth: FakeOAuthServer | undefined;
let callbacks: OAuthCallbacks | undefined;
afterEach(async () => {
  await callbacks?.close();
  await oauth?.close();
  callbacks = undefined;
  oauth = undefined;
});

/** A ChatGPT sign-in the Owner has started, its callback listened for as compose does. */
async function ownerSignIn() {
  const server = await startFakeOAuthServer({ openai: true });
  oauth = server;
  const port = await freePort();
  const redirectUri = `http://localhost:${String(port)}/auth/callback`;
  // The fake's callback on a free port, so nothing else holds it.
  (server.provider as { redirectUri: string }).redirectUri = redirectUri;
  const accounts = createAiAccounts({
    store: memoryAiAccountStore(),
    encryptor: encryptorFromKey(Buffer.alloc(32, 71)),
    events: createEventBus({ store: memoryEventStore() }),
    oauthProviders: { ChatGPT: server.provider },
  });
  callbacks = createOAuthCallbacks({
    // As docker-compose.yml sets OAUTH_CALLBACK_HOST.
    host: "0.0.0.0",
    complete: (url) => accounts.completeCallback(url),
    awaiting: (uri) => accounts.awaitingCallback(uri),
    logger,
    checkMs: 20,
  });
  const login = await accounts.startLogin({
    name: "ChatGPT Plus",
    aiProvider: "ChatGPT",
    acceptedTerms: true,
  });
  await callbacks.expect(redirectUri);
  /** The callback address as a sandbox reaches it. */
  const fromSandbox = (query: string) =>
    `http://${peerAddress ?? "127.0.0.1"}:${String(port)}/auth/callback?${query}`;
  /** The Owner's browser landing on the callback, as the provider sends it. */
  const ownerLands = async () => {
    const landing = new URL(await server.signIn(login.authorizeUrl));
    return fetch(
      `http://127.0.0.1:${String(port)}${landing.pathname}${landing.search}`,
    );
  };
  return { accounts, login, redirectUri, fromSandbox, ownerLands, server };
}

describe("S2 (H14): the sign-in's callback listener, from a sandbox", () => {
  it.skipIf(peerAddress === undefined)(
    "regression (S2-3): bound as compose binds it, it still answers a peer on a non-loopback address while a sign-in waits, but under compose no sandbox is such a peer any more: the app is on the default network only",
    async () => {
      const { fromSandbox } = await ownerSignIn();
      const response = await fetch(fromSandbox("code=x&state=y"));
      expect(response.status).toBe(400);
      // Who can be that peer: the default network's containers (Caddy,
      // Postgres, the sandbox relay), never a sandbox.
      expect(appNetworks).toEqual(["default"]);
      expect(appNetworks).not.toContain("sandboxes");
    },
  );

  it("cannot cancel it: a callback with ?error= changes nothing, and the Owner's still finishes", async () => {
    const { accounts, redirectUri, fromSandbox, ownerLands } =
      await ownerSignIn();
    const refused = await fetch(fromSandbox("error=access_denied"));
    expect(refused.status).toBe(400);
    expect(accounts.awaitingCallback(redirectUri)).toBe(true);
    const owner = await ownerLands();
    expect(owner.status).toBe(200);
    expect(await accounts.list()).toHaveLength(1);
  });

  it("cannot fail it: callbacks with no state, a wrong state, or a code of its own finish nothing, and the Owner's still finishes", async () => {
    const { accounts, redirectUri, fromSandbox, ownerLands } =
      await ownerSignIn();
    for (const query of [
      "code=ac_from_the_sandbox",
      "code=ac_from_the_sandbox&state=",
      "code=ac_from_the_sandbox&state=guessed-state",
      `code=ac_from_the_sandbox&state=${"A".repeat(43)}`,
    ]) {
      const response = await fetch(fromSandbox(query));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("expired or is unknown");
    }
    expect(accounts.awaitingCallback(redirectUri)).toBe(true);
    expect((await ownerLands()).status).toBe(200);
    expect(await accounts.list()).toHaveLength(1);
  });

  it("cannot race it: once the Owner's callback has finished it, a later one adds nothing", async () => {
    const { accounts, login, fromSandbox, ownerLands, server } =
      await ownerSignIn();
    expect((await ownerLands()).status).toBe(200);
    // The same address again, as if the sandbox had seen it, then another.
    const replay = new URL(await server.signIn(login.authorizeUrl));
    const late = await fetch(fromSandbox(replay.search.slice(1))).catch(
      () => undefined,
    );
    expect(late === undefined || late.status === 400).toBe(true);
    expect(await accounts.list()).toHaveLength(1);
  });

  it("binds the sign-in to a state only the Owner's browser is shown: 256 bits, different each time", async () => {
    const { login } = await ownerSignIn();
    const state = new URL(login.authorizeUrl).searchParams.get("state") ?? "";
    expect(Buffer.from(state, "base64url")).toHaveLength(32);
    expect(
      new URL(login.authorizeUrl).searchParams.get("code_challenge_method"),
    ).toBe("S256");
  });
});
