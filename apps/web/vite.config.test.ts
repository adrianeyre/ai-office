// `pnpm dev`'s Vite server proxies the API and the AI Gateway's `/v1`
// paths to the server (one entry point), server-sent events streamed as
// they arrive.
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("the dev server's proxy", () => {
  let backend: Server;
  let vite: ViteDevServer;
  let base: string;
  let release: () => void = () => undefined;
  const held = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const seen: { url: string; body: string; authorization?: string }[] = [];

  beforeAll(async () => {
    // Stands in for the server on PORT.
    backend = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
        });
        if (request.url === "/v1/messages") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("event: message_start\ndata: {}\n\n");
          void held().then(() => {
            response.end("event: message_stop\ndata: {}\n\n");
          });
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ url: request.url }));
      });
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const { port } = backend.address() as AddressInfo;
    process.env["PORT"] = String(port);
    vite = await createServer({
      configFile: join(import.meta.dirname, "vite.config.ts"),
      logLevel: "silent",
      server: { port: 0, strictPort: false, host: "127.0.0.1" },
    });
    await vite.listen();
    const address = vite.httpServer?.address() as AddressInfo;
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    release();
    await vite.close();
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    delete process.env["PORT"];
  });

  it("proxies /api and /v1 to the server", async () => {
    for (const path of ["/api/session", "/v1/chat/completions"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer aio_gk_key" },
        body: "{}",
      });
      expect(await response.json()).toEqual({ url: path });
    }
    expect(seen.at(-1)).toEqual({
      url: "/v1/chat/completions",
      body: "{}",
      authorization: "Bearer aio_gk_key",
    });
  });

  it("streams /v1's server-sent events as they arrive", async () => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    // The first event, while the server still holds the rest back.
    expect(decoder.decode(first.value)).toBe(
      "event: message_start\ndata: {}\n\n",
    );
    release();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      rest += decoder.decode(value, { stream: true });
    }
    expect(rest).toBe("event: message_stop\ndata: {}\n\n");
  });
});
