// The sandbox relay (docker/sandbox-relay/relay.ts): the one thing a
// sandbox reaches on its internal network. Its Gateway port reaches the AI
// Gateway and nothing else; its HTTPS proxy reaches port 443 of the hosts
// SANDBOX_EGRESS_HOSTS names, and never the instance metadata service.
// Driven here on loopback, with the proxy's DNS and connections stood in
// for, so no request leaves this machine.
import { request as httpRequest, createServer, type Server } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEgressProxy,
  createGatewayRelay,
  isAllowedHost,
  isForbiddenAddress,
  parseAllowedHosts,
  refusal,
  type EgressLogEntry,
  type EgressProxyOptions,
  type Target,
} from "./relay.ts";

const servers: (Server | TcpServer)[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          if ("closeAllConnections" in server) {
            server.closeAllConnections();
          }
        }),
    ),
  );
});

const listening = async (server: Server | TcpServer) => {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
};

/** A stand-in AI Gateway that says it is one, and what it was asked. */
const fakeGateway = () =>
  listening(
    createServer((request, reply) => {
      reply.end(`gateway: ${request.method ?? ""} ${request.url ?? ""}`);
    }),
  );

/** A stand-in HTTPS host: it echoes what it is sent, prefixed. */
const echoHost = () =>
  listening(
    createTcpServer((socket) => {
      socket.on("data", (data) => socket.write(`echo: ${data.toString()}`));
    }),
  );

/** Asks the proxy at `port` to CONNECT to `target`. */
const askToConnect = (port: number, target: string) =>
  new Promise<{ status: number; socket: Socket; body: string }>(
    (resolve, reject) => {
      const asking = httpRequest({
        host: "127.0.0.1",
        port,
        method: "CONNECT",
        path: target,
      });
      asking.on("connect", (response, socket, head: Buffer) => {
        let body = head.toString();
        socket.on("data", (data: Buffer) => {
          body += data.toString();
        });
        const status = response.statusCode ?? 0;
        if (status === 200) {
          resolve({ status, socket, body });
        } else {
          socket.on("close", () => {
            resolve({ status, socket, body });
          });
        }
      });
      asking.on("error", reject);
      asking.end();
    },
  );

/** Writes `text` on `socket` and returns the first answer. */
const exchange = (socket: Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once("data", (data: Buffer) => {
      resolve(data.toString());
    });
    socket.write(text);
  });

/** An egress proxy whose DNS says `addresses` and whose connections go to the echo host. */
const proxyWith = async (
  options: Partial<EgressProxyOptions> & {
    addresses?: Record<string, readonly string[]>;
  },
) => {
  const echoPort = await echoHost();
  const connected: Target[] = [];
  const logged: EgressLogEntry[] = [];
  const port = await listening(
    createEgressProxy({
      allowedHosts: options.allowedHosts ?? [],
      lookup: (host) => {
        const found = options.addresses?.[host];
        return found === undefined
          ? Promise.reject(new Error("ENOTFOUND"))
          : Promise.resolve(found);
      },
      connect: (target) => {
        connected.push(target);
        return connect(echoPort, "127.0.0.1");
      },
      log: (entry) => logged.push(entry),
      now: () => new Date("2026-10-11T12:00:00Z"),
    }),
  );
  return { port, connected, logged };
};

describe("the Gateway relay", () => {
  it("forwards every connection to the AI Gateway, whatever the sandbox asks for", async () => {
    const gatewayPort = await fakeGateway();
    const port = await listening(
      createGatewayRelay({ host: "127.0.0.1", port: gatewayPort }),
    );
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`);
    expect(await response.text()).toBe("gateway: GET /v1/models");
    // A Host of the app's web app, or a sign-in route, still reaches the
    // Gateway: the relay has nowhere else to send it.
    const login = await fetch(`http://127.0.0.1:${String(port)}/api/login`, {
      method: "POST",
      headers: { host: "app:3045" },
    });
    expect(await login.text()).toBe("gateway: POST /api/login");
  });
});

describe("the egress proxy", () => {
  it("relays CONNECT to port 443 of a host SANDBOX_EGRESS_HOSTS names", async () => {
    const { port, connected, logged } = await proxyWith({
      allowedHosts: ["registry.npmjs.org"],
      addresses: { "registry.npmjs.org": ["203.0.113.10"] },
    });
    const { status, socket } = await askToConnect(
      port,
      "registry.npmjs.org:443",
    );
    expect(status).toBe(200);
    expect(await exchange(socket, "hello")).toBe("echo: hello");
    socket.destroy();
    // To the address it checked, not the name again.
    expect(connected).toEqual([{ host: "203.0.113.10", port: 443 }]);
    expect(logged).toEqual([
      {
        at: "2026-10-11T12:00:00.000Z",
        target: "registry.npmjs.org:443",
        outcome: "relayed",
      },
    ]);
  });

  it("relays to every name under a *.domain entry, but not the domain itself", async () => {
    const { port } = await proxyWith({
      allowedHosts: ["*.githubusercontent.com"],
      addresses: {
        "objects.githubusercontent.com": ["203.0.113.11"],
        "githubusercontent.com": ["203.0.113.12"],
      },
    });
    const allowed = await askToConnect(
      port,
      "objects.githubusercontent.com:443",
    );
    expect(allowed.status).toBe(200);
    allowed.socket.destroy();
    expect((await askToConnect(port, "githubusercontent.com:443")).status).toBe(
      403,
    );
  });

  it("refuses a host SANDBOX_EGRESS_HOSTS does not name, such as one the red team controls, and connects to nothing", async () => {
    const { port, connected, logged } = await proxyWith({
      allowedHosts: ["registry.npmjs.org"],
      addresses: { "red-team.example": ["203.0.113.66"] },
    });
    const { status, body } = await askToConnect(port, "red-team.example:443");
    expect(status).toBe(403);
    expect(body).toContain(refusal);
    expect(connected).toEqual([]);
    expect(logged).toMatchObject([
      {
        target: "red-team.example:443",
        outcome: "refused",
        reason: "not in SANDBOX_EGRESS_HOSTS",
      },
    ]);
  });

  it("refuses everything when SANDBOX_EGRESS_HOSTS is empty", async () => {
    const { port, connected } = await proxyWith({
      addresses: { "registry.npmjs.org": ["203.0.113.10"] },
    });
    expect((await askToConnect(port, "registry.npmjs.org:443")).status).toBe(
      403,
    );
    expect(connected).toEqual([]);
  });

  it("refuses any port but 443 on an allowed host, so nothing else it serves is reached", async () => {
    const { port, connected } = await proxyWith({
      allowedHosts: ["registry.npmjs.org"],
      addresses: { "registry.npmjs.org": ["203.0.113.10"] },
    });
    for (const target of [
      "registry.npmjs.org:80",
      "registry.npmjs.org:22",
      "registry.npmjs.org:3045",
    ]) {
      expect((await askToConnect(port, target)).status).toBe(403);
    }
    expect(connected).toEqual([]);
  });

  it("never reaches the app's web app, API or sign-in callback, even were SANDBOX_EGRESS_HOSTS to name the app (S2-3)", async () => {
    const { port, connected } = await proxyWith({
      allowedHosts: ["app"],
      addresses: { app: ["172.18.0.3"] },
    });
    for (const target of ["app:3045", "app:1455", "app:3047", "app:3048"]) {
      expect((await askToConnect(port, target)).status).toBe(403);
    }
    expect(connected).toEqual([]);
  });

  it("refuses an IP address, the instance metadata service's above all", async () => {
    const { port, connected } = await proxyWith({
      allowedHosts: ["registry.npmjs.org"],
    });
    for (const target of [
      "169.254.169.254:443",
      "203.0.113.10:443",
      "[fd00:ec2::254]:443",
    ]) {
      expect((await askToConnect(port, target)).status).toBe(403);
    }
    expect(connected).toEqual([]);
  });

  it("refuses an allowed name that resolves to the instance metadata service, loopback or link-local, even alongside a public address", async () => {
    const { port, connected, logged } = await proxyWith({
      allowedHosts: ["*.example.com"],
      addresses: {
        "imds.example.com": ["169.254.169.254"],
        "ecs.example.com": ["169.254.170.2"],
        "loop.example.com": ["127.0.0.1"],
        "v6.example.com": ["fd00:ec2::254"],
        "mixed.example.com": ["203.0.113.10", "169.254.169.254"],
        "mapped.example.com": ["::ffff:169.254.169.254"],
      },
    });
    for (const host of [
      "imds.example.com",
      "ecs.example.com",
      "loop.example.com",
      "v6.example.com",
      "mixed.example.com",
      "mapped.example.com",
    ]) {
      expect((await askToConnect(port, `${host}:443`)).status).toBe(403);
    }
    expect(connected).toEqual([]);
    expect(new Set(logged.map((entry) => entry.reason))).toEqual(
      new Set(["resolves to a forbidden address"]),
    );
  });

  it("refuses a name that does not resolve, and what is not host:port", async () => {
    const { port, connected } = await proxyWith({
      allowedHosts: ["registry.npmjs.org"],
    });
    expect((await askToConnect(port, "registry.npmjs.org:443")).status).toBe(
      403,
    );
    expect(
      (await askToConnect(port, "user@registry.npmjs.org:443")).status,
    ).toBe(403);
    expect(connected).toEqual([]);
  });

  it("refuses plain HTTP: it is not a forward proxy for anything but CONNECT", async () => {
    const { port, connected } = await proxyWith({
      allowedHosts: ["registry.npmjs.org"],
      addresses: { "registry.npmjs.org": ["203.0.113.10"] },
    });
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const asking = httpRequest({
          host: "127.0.0.1",
          port,
          path: "http://registry.npmjs.org/left-pad",
        });
        asking.on("response", (answer) => {
          let body = "";
          answer.on("data", (data: Buffer) => (body += data.toString()));
          answer.on("end", () => {
            resolve({ status: answer.statusCode ?? 0, body });
          });
        });
        asking.on("error", reject);
        asking.end();
      },
    );
    expect(response.status).toBe(403);
    expect(response.body).toContain(refusal);
    expect(connected).toEqual([]);
  });
});

describe("SANDBOX_EGRESS_HOSTS", () => {
  it("is host names and *.domain entries, separated by commas or spaces; empty is none", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
    expect(
      parseAllowedHosts(
        "registry.npmjs.org, API.github.com  *.githubusercontent.com,",
      ),
    ).toEqual([
      "registry.npmjs.org",
      "api.github.com",
      "*.githubusercontent.com",
    ]);
  });

  it("refuses an IP address, a port, a URL or a bare wildcard", () => {
    for (const value of [
      "169.254.169.254",
      "registry.npmjs.org:443",
      "https://registry.npmjs.org",
      "*",
      "*.*.example.com",
    ]) {
      expect(() => parseAllowedHosts(value)).toThrow(/SANDBOX_EGRESS_HOSTS/);
    }
  });

  it("matches names exactly, or under a *.domain entry", () => {
    const allowed = ["registry.npmjs.org", "*.example.com"];
    expect(isAllowedHost("registry.npmjs.org", allowed)).toBe(true);
    expect(isAllowedHost("a.b.example.com", allowed)).toBe(true);
    expect(isAllowedHost("example.com", allowed)).toBe(false);
    expect(isAllowedHost("evilexample.com", allowed)).toBe(false);
    expect(isAllowedHost("registry.npmjs.org.evil.test", allowed)).toBe(false);
  });
});

describe("the addresses a sandbox never reaches", () => {
  it("are the metadata services, link-local, loopback, unspecified and multicast", () => {
    for (const address of [
      "169.254.169.254",
      "169.254.170.2",
      "127.0.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fd00:ec2::254",
      "::ffff:169.254.169.254",
      "not an address",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    for (const address of ["203.0.113.10", "104.16.0.1", "2606:4700::1"]) {
      expect(isForbiddenAddress(address), address).toBe(false);
    }
  });
});
