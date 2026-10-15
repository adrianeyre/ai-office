import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  InternalHostError,
  checkOwnerHost,
  ownerFetch,
  type Resolve,
} from "./internal-hosts-guard.ts";

// Where an Owner-triggered fetch is made (ADR 0007): a host is checked by
// its form, then by what it resolves to, and every connection as it is
// made, a redirect's included.

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A local server; `answer` gives each request's status and headers. */
async function local(
  answer: (request: IncomingMessage) => {
    status: number;
    headers?: Record<string, string>;
  } = () => ({ status: 200 }),
): Promise<{ port: number; received: IncomingMessage[] }> {
  const received: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    received.push(request);
    const { status, headers } = answer(request);
    response.writeHead(status, headers).end("internal-only");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, received };
}

/** A resolver that knows the names given, and nothing else. */
const resolving =
  (names: Record<string, string>): Resolve =>
  (hostname) => {
    const address = names[hostname];
    return address === undefined
      ? Promise.reject(
          Object.assign(new Error(`${hostname} not found`), {
            code: "ENOTFOUND",
          }),
        )
      : Promise.resolve([{ address, family: address.includes(":") ? 6 : 4 }]);
  };

describe("checking a host before it is reached", () => {
  it("refuses an internal host by its form, and one whose name resolves to an internal address", async () => {
    const resolve = resolving({
      "metadata.attacker.example": "169.254.169.254",
      "api.example.com": "93.184.215.14",
    });
    for (const host of ["127.0.0.1", "[::1]", "localhost", "app"]) {
      await expect(checkOwnerHost(host, { resolve }), host).rejects.toThrow(
        InternalHostError,
      );
    }
    await expect(
      checkOwnerHost("metadata.attacker.example", { resolve }),
    ).rejects.toThrow(
      "That address is on an internal address (metadata.attacker.example), which AI Office reaches only if ALLOWED_INTERNAL_HOSTS names it.",
    );
    await expect(checkOwnerHost("api.example.com", { resolve })).resolves.toBe(
      "93.184.215.14",
    );
  });

  it("lets through a host the Owner allowed, whatever it resolves to, and a name that does not resolve, whose fetch fails on its own", async () => {
    const resolve = resolving({ "ollama.lan": "192.168.1.20" });
    await expect(
      checkOwnerHost("ollama.lan", { resolve, allowed: () => [".lan"] }),
    ).resolves.toBeUndefined();
    await expect(
      checkOwnerHost("nowhere.example", { resolve }),
    ).resolves.toBeUndefined();
  });
});

describe("ownerFetch", () => {
  it("never connects to an internal address the Owner did not allow", async () => {
    const service = await local();
    await expect(
      ownerFetch({ allowed: () => [] })(
        `http://127.0.0.1:${String(service.port)}/`,
      ),
    ).rejects.toThrow(InternalHostError);
    expect(service.received).toHaveLength(0);
  });

  it("reaches one they allowed", async () => {
    const service = await local();
    const response = await ownerFetch({ allowed: () => ["127.0.0.1"] })(
      `http://127.0.0.1:${String(service.port)}/`,
    );
    expect(response.status).toBe(200);
    expect(service.received).toHaveLength(1);
  });

  it("checks what a name resolves to as the connection is made, so a name that answers differently the second time is still refused", async () => {
    const service = await local();
    let asked = 0;
    // A public address when checked, loopback when connected: rebinding.
    const resolve: Resolve = () =>
      Promise.resolve([
        {
          address: (asked += 1) === 1 ? "93.184.215.14" : "127.0.0.1",
          family: 4,
        },
      ]);
    await expect(
      ownerFetch({ allowed: () => [], resolve })(
        `http://rebind.example:${String(service.port)}/`,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TypeError && error.cause instanceof InternalHostError,
    );
    expect(service.received).toHaveLength(0);
  });

  it("refuses a redirect from a host they allowed to one they did not", async () => {
    const internal = await local();
    const allowed = await local(() => ({
      status: 307,
      headers: { location: `http://127.0.0.1:${String(internal.port)}/` },
    }));
    const resolve = resolving({ "ollama.lan": "127.0.0.1" });
    await expect(
      ownerFetch({ allowed: () => ["ollama.lan"], resolve })(
        `http://ollama.lan:${String(allowed.port)}/`,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TypeError && error.cause instanceof InternalHostError,
    );
    expect(allowed.received).toHaveLength(1);
    expect(internal.received).toHaveLength(0);
  });
});
