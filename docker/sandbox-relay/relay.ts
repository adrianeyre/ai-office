// The sandbox relay: the one container on the sandboxes' Docker network
// that is not a sandbox (pen-testing S2-1, S2-2, S2-3). That network is
// `internal`, so it has no route out, and the app is not on it. A sandbox
// therefore reaches nothing but this relay, which:
// - forwards its Gateway port (3047) to the AI Gateway (RELAY_GATEWAY:
//   `app:3047` under compose, the host's Gateway outside it), byte for byte,
//   and to nothing else of the app or the host;
// - is an HTTPS proxy (3128) to the hosts the Owner names in
//   SANDBOX_EGRESS_HOSTS, and to no other. It relays only `CONNECT` to port
//   443 of a listed name, never to an IP address a sandbox names, and never
//   when the name resolves to the instance metadata service or any other
//   link-local, loopback, unspecified or multicast address. Plain HTTP is
//   refused.
// The sandbox images name it as their HTTPS proxy (`HTTPS_PROXY`), so
// package managers, `git` and `gh` use it; each connection, allowed or
// refused, is one JSON line on its output.
//
// It uses nothing but Node, so compose runs it from the Node image as it
// is: `node relay.ts`.
import { lookup as dnsLookup } from "node:dns/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import {
  BlockList,
  connect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";

/** The relay's name on the sandboxes' network, and its ports there. */
export const sandboxRelay = {
  host: "sandbox-relay",
  /** Forwarded to the AI Gateway. */
  gatewayPort: 3047,
  /** The HTTPS proxy to the allowed hosts. */
  egressPort: 3128,
} as const;

/** The only port a sandbox may reach on an allowed host. */
export const egressTargetPort = 443;

/** Where a TCP connection goes. */
export interface Target {
  readonly host: string;
  readonly port: number;
}

/**
 * The Gateway relay: every connection to it is piped to `gateway`, whatever
 * the sandbox sends, so it reaches the AI Gateway and nothing else.
 */
export function createGatewayRelay(gateway: Target): Server {
  return createServer((sandbox) => {
    const upstream = connect(gateway.port, gateway.host);
    pipeBoth(sandbox, upstream);
  });
}

/** `a` and `b` piped into each other; either failing or closing ends both. */
function pipeBoth(a: Duplex, b: Duplex): void {
  a.pipe(b).pipe(a);
  const end = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", end).on("close", end);
  b.on("error", end).on("close", end);
}

const hostLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const allowedEntry = new RegExp(
  `^(?:\\*\\.)?${hostLabel}(?:\\.${hostLabel})*$`,
);

/**
 * SANDBOX_EGRESS_HOSTS as a list: host names, or `*.example.com` for every
 * name under example.com, separated by commas or spaces. Anything else,
 * such as an IP address, a port or a URL, is refused, naming it.
 */
export function parseAllowedHosts(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    if (!allowedEntry.test(entry) || isIP(entry) !== 0) {
      throw new Error(
        `SANDBOX_EGRESS_HOSTS must list host names (or *.domain), not "${entry}".`,
      );
    }
  }
  return entries;
}

/** Whether `host`, a lower-case name, is one `allowed` lists. */
export function isAllowedHost(
  host: string,
  allowed: readonly string[],
): boolean {
  return allowed.some((entry) =>
    entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry,
  );
}

const forbiddenAddresses = new BlockList();
// This network, loopback, link-local (the instance metadata service at
// 169.254.169.254, ECS's at 169.254.170.2), multicast, reserved and
// broadcast.
forbiddenAddresses.addSubnet("0.0.0.0", 8, "ipv4");
forbiddenAddresses.addSubnet("127.0.0.0", 8, "ipv4");
forbiddenAddresses.addSubnet("169.254.0.0", 16, "ipv4");
forbiddenAddresses.addSubnet("224.0.0.0", 4, "ipv4");
forbiddenAddresses.addSubnet("240.0.0.0", 4, "ipv4");
// The same for IPv6, and EC2's IPv6 metadata service.
forbiddenAddresses.addAddress("::", "ipv6");
forbiddenAddresses.addAddress("::1", "ipv6");
forbiddenAddresses.addSubnet("fe80::", 10, "ipv6");
forbiddenAddresses.addSubnet("ff00::", 8, "ipv6");
forbiddenAddresses.addAddress("fd00:ec2::254", "ipv6");

/**
 * Whether `address` is one a sandbox never reaches, whatever name it came
 * from: the instance metadata service, or any link-local, loopback,
 * unspecified, multicast or reserved address.
 */
export function isForbiddenAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) {
    return isForbiddenAddress(mapped);
  }
  const family = isIP(address);
  return (
    family === 0 ||
    forbiddenAddresses.check(address, family === 4 ? "ipv4" : "ipv6")
  );
}

/** One connection a sandbox asked the proxy for. */
export interface EgressLogEntry {
  readonly at: string;
  /** What the sandbox asked for, as it asked. */
  readonly target: string;
  readonly outcome: "relayed" | "refused";
  /** Why it was refused. */
  readonly reason?: string;
}

export interface EgressProxyOptions {
  /** `parseAllowedHosts(SANDBOX_EGRESS_HOSTS)`. */
  readonly allowedHosts: readonly string[];
  /** Every address a name resolves to; DNS unless given. */
  readonly lookup?: (host: string) => Promise<readonly string[]>;
  /** Opens the connection to an allowed address; TCP unless given. */
  readonly connect?: (target: Target) => Socket;
  readonly log?: (entry: EgressLogEntry) => void;
  readonly now?: () => Date;
}

const resolveAll = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true })).map(({ address }) => address);

/** What a refusal says: the same for every refusal, naming the setting. */
export const refusal =
  "AI Office's sandboxes reach only the hosts SANDBOX_EGRESS_HOSTS names, over HTTPS (port 443).";

/** `CONNECT host:port`'s host and port, or nothing if it is not that. */
function connectTarget(authority: string): Target | undefined {
  const match = /^([^:[\]/@\s]+):(\d{1,5})$/.exec(authority);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return {
    host: match[1].toLowerCase().replace(/\.$/, ""),
    port: Number(match[2]),
  };
}

/**
 * The egress proxy: `CONNECT` to port 443 of a host `allowedHosts` names,
 * at an address that is not forbidden, is relayed; everything else is
 * answered 403.
 */
export function createEgressProxy(options: EgressProxyOptions): HttpServer {
  const lookup = options.lookup ?? resolveAll;
  const open =
    options.connect ?? ((target: Target) => connect(target.port, target.host));
  const now = options.now ?? (() => new Date());
  const log = (entry: Omit<EgressLogEntry, "at">) =>
    options.log?.({ at: now().toISOString(), ...entry });

  const server = createHttpServer((request, reply) => {
    log({
      target: request.url ?? "",
      outcome: "refused",
      reason: "not CONNECT",
    });
    reply.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    reply.end(`${refusal}\n`);
  });

  server.on(
    "connect",
    (request: IncomingMessage, sandbox: Duplex, head: Buffer) => {
      const asked = request.url ?? "";
      sandbox.on("error", () => sandbox.destroy());
      const refuse = (reason: string) => {
        log({ target: asked, outcome: "refused", reason });
        const body = `${refusal}\n`;
        sandbox.end(
          `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`,
        );
      };
      void (async () => {
        const target = connectTarget(asked);
        if (target === undefined) {
          refuse("not host:port");
          return;
        }
        if (target.port !== egressTargetPort) {
          refuse("not port 443");
          return;
        }
        if (isIP(target.host) !== 0) {
          refuse("an IP address, not a name");
          return;
        }
        if (!isAllowedHost(target.host, options.allowedHosts)) {
          refuse("not in SANDBOX_EGRESS_HOSTS");
          return;
        }
        let addresses: readonly string[];
        try {
          addresses = await lookup(target.host);
        } catch {
          refuse("does not resolve");
          return;
        }
        // Every address is checked, and the one connected to is one of
        // them, so a name cannot be re-pointed between the check and the
        // connection.
        const [address] = addresses;
        if (address === undefined || addresses.some(isForbiddenAddress)) {
          refuse("resolves to a forbidden address");
          return;
        }
        const upstream = open({ host: address, port: target.port });
        upstream.once("error", () => {
          refuse("unreachable");
        });
        upstream.once("connect", () => {
          upstream.removeAllListeners("error");
          log({ target: asked, outcome: "relayed" });
          sandbox.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) {
            upstream.write(head);
          }
          pipeBoth(sandbox, upstream);
        });
      })();
    },
  );
  return server;
}

if (import.meta.main) {
  const [gatewayHost = "", gatewayPort = ""] = (
    process.env["RELAY_GATEWAY"] ?? "app:3047"
  ).split(":");
  const allowedHosts = parseAllowedHosts(process.env["SANDBOX_EGRESS_HOSTS"]);
  const gateway = createGatewayRelay({
    host: gatewayHost,
    port: Number(gatewayPort),
  });
  const egress = createEgressProxy({
    allowedHosts,
    log: (entry) => {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    },
  });
  gateway.listen(sandboxRelay.gatewayPort, "0.0.0.0");
  egress.listen(sandboxRelay.egressPort, "0.0.0.0", () => {
    console.error(
      `The sandbox relay forwards ${String(sandboxRelay.gatewayPort)} to ${gatewayHost}:${gatewayPort}, and relays HTTPS on ${String(sandboxRelay.egressPort)} to ${allowedHosts.length === 0 ? "no host" : allowedHosts.join(", ")}.`,
    );
  });
  const stop = () => {
    gateway.close();
    egress.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
