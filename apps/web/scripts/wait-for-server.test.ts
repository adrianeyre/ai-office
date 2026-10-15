import { createServer, type Server } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { listening, waitForServerMiddleware } from "./wait-for-server.ts";

// `pnpm dev`'s proxied paths wait for the server rather than fail while it
// starts or restarts.

const request = (url: string) => ({ url }) as IncomingMessage;

/** A response that records what it was answered. */
function response() {
  const answered: { status?: number; body?: string | undefined } = {};
  const res = {
    writeHead(status: number) {
      answered.status = status;
      return res;
    },
    end(body?: string) {
      answered.body = body;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, answered };
}

/** Runs the middleware once: whether it called `next`, and what it answered. */
const pass = (
  middleware: ReturnType<typeof waitForServerMiddleware>,
  url: string,
) =>
  new Promise<{ next: boolean; status?: number | undefined }>((resolve) => {
    const { res, answered } = response();
    const original = res.end.bind(res);
    res.end = ((body?: string) => {
      original(body);
      resolve({ next: false, status: answered.status });
      return res;
    }) as typeof res.end;
    middleware(request(url), res, () => {
      resolve({ next: true });
    });
  });

describe("waiting for the server in pnpm dev", () => {
  it("lets every other path straight through", async () => {
    const middleware = waitForServerMiddleware({
      target: "http://localhost:1",
      paths: ["/api"],
      isUp: () => Promise.resolve(false),
    });
    expect(await pass(middleware, "/src/main.tsx")).toEqual({ next: true });
  });

  it("holds a proxied request until the server is up, saying so once", async () => {
    let checks = 0;
    const said: string[] = [];
    const middleware = waitForServerMiddleware({
      target: "http://localhost:3046",
      paths: ["/api", "/v1/"],
      pollMs: 1,
      isUp: () => Promise.resolve((checks += 1) > 3),
      log: (message) => said.push(message),
    });
    const [first, second] = await Promise.all([
      pass(middleware, "/api/session"),
      pass(middleware, "/api/floors"),
    ]);
    expect(first).toEqual({ next: true });
    expect(second).toEqual({ next: true });
    expect(said).toEqual([
      "Waiting for AI Office's server at http://localhost:3046…",
      "AI Office's server is up.",
    ]);
  });

  it("answers 503 when the server does not come up in time", async () => {
    const middleware = waitForServerMiddleware({
      target: "http://localhost:3046",
      paths: ["/api"],
      timeoutMs: 5,
      pollMs: 1,
      isUp: () => Promise.resolve(false),
    });
    expect(await pass(middleware, "/api/session")).toEqual({
      next: false,
      status: 503,
    });
  });
});

describe("whether the server is listening", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("is a TCP connection to its address", async () => {
    server = createServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        resolve(
          typeof address === "object" && address !== null ? address.port : 0,
        );
      });
    });
    expect(await listening(`http://127.0.0.1:${String(port)}`)).toBe(true);
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await listening(`http://127.0.0.1:${String(port)}`)).toBe(false);
  });
});
