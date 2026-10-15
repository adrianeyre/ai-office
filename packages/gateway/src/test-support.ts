// Helpers for the Gateway's own tests: a fake AI Provider, a running
// Gateway in front of it, and a fake outbound proxy. Not exported from the
// package.
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type AddressInfo } from "node:net";

import { pino } from "pino";

import type { Fixture, FixtureRecorder } from "./fixtures.ts";
import {
  buildGateway,
  staticAccounts,
  type AccountSource,
  type ApiFormat,
  type GatewayAccount,
  type GatewayOptions,
} from "./gateway.ts";
import {
  staticKeys,
  type GatewayCaller,
  type GatewayKeyAuthenticator,
} from "./keys/keys.ts";
import type { CostEstimator } from "./pricing/pricing.ts";
import { memoryRequestLog, type RequestLog } from "./request-log.ts";

export const accountKey = "sk-ant-api03-gatewaytestaccountkey-000000000000";

/** The Gateway Key tests call the Gateway with: an Owner tool's. */
export const gatewayKey = "aio_gk_gatewaytestownertoolkey000000000000000";

/** Who `gatewayKey` belongs to. */
export const testCaller: GatewayCaller = {
  kind: "owner_tool",
  keyId: "test-key",
  name: "test-tool",
};

export interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeUpstream {
  readonly url: string;
  readonly received: ReceivedRequest[];
  close(): Promise<void>;
}

/** A local HTTP server standing in for the AI Provider. */
export async function startFakeUpstream(
  respond: (
    request: ReceivedRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<FakeUpstream> {
  const received: ReceivedRequest[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(entry);
      void respond(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Answers with `fixture.response`, writing the body in `chunkSize`-byte pieces. */
export function replay(fixture: Fixture, chunkSize = 7) {
  return async (_request: ReceivedRequest, response: ServerResponse) => {
    response.writeHead(fixture.response.status, fixture.response.headers);
    const body = Buffer.from(fixture.response.body, "utf8");
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      response.write(body.subarray(offset, offset + chunkSize));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  };
}

export interface RunningGateway {
  readonly url: string;
  readonly requestLog: RequestLog;
  close(): Promise<void>;
}

export async function startGateway(
  options: {
    account?: GatewayAccount | undefined;
    /** Where accounts come from; by default, `account` alone. */
    accounts?: AccountSource;
    upstream?: FakeUpstream;
    requestLog?: RequestLog;
    fixtureRecorder?: FixtureRecorder;
    logger?: pino.Logger;
    /** Who may call; by default `gatewayKey`, as `testCaller`. */
    keys?: GatewayKeyAuthenticator;
    /** The API the default account speaks; Anthropic Messages by default. */
    apiFormat?: ApiFormat;
    /** The clock translated responses are stamped with. */
    now?: () => Date;
    /** Estimates each request's cost. */
    pricing?: CostEstimator;
    /** Whether request and response bodies are kept. */
    storeBodies?: () => boolean;
    /** How often, and after how long, requests are tried again. */
    retries?: GatewayOptions["retries"];
    /** Waits before an account is tried again. */
    sleep?: GatewayOptions["sleep"];
    /** The Token Cap an Agent's call is refused at, if any. */
    capCheck?: GatewayOptions["capCheck"];
    /** The office's Token Cap the Communications Agent is refused at. */
    communicationsCapCheck?: GatewayOptions["communicationsCapCheck"];
    /** The office's Token Cap an Owner tool is refused at. */
    ownerToolCapCheck?: GatewayOptions["ownerToolCapCheck"];
    /** The work AI Office gave each Agent, which its calls count against. */
    work?: GatewayOptions["work"];
    /** The TTL given to prompt-cache breakpoints. */
    promptCacheTtl?: GatewayOptions["promptCacheTtl"];
    /** Prompt-cache keep-alive, shown each served Agent request. */
    keepAlive?: GatewayOptions["keepAlive"];
    /** How AI Providers are reached: through an outbound proxy, say. */
    fetch?: GatewayOptions["fetch"];
    /** AI Office's tool-call screen, for Agents' sandboxes to ask. */
    toolCallScreen?: GatewayOptions["toolCallScreen"];
  } = {},
): Promise<RunningGateway> {
  const requestLog = options.requestLog ?? memoryRequestLog();
  const account =
    "account" in options
      ? options.account
      : options.upstream && {
          id: null,
          name: "test-account",
          apiKey: accountKey,
          baseUrl: options.upstream.url,
          apiFormat: options.apiFormat ?? "anthropic",
        };
  const app = await buildGateway({
    logger: options.logger ?? pino({ level: "silent" }),
    accounts: options.accounts ?? staticAccounts(account),
    keys: options.keys ?? staticKeys({ [gatewayKey]: testCaller }),
    requestLog,
    fixtureRecorder: options.fixtureRecorder,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.storeBodies === undefined
      ? {}
      : { storeBodies: options.storeBodies }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.capCheck === undefined ? {} : { capCheck: options.capCheck }),
    ...(options.communicationsCapCheck === undefined
      ? {}
      : { communicationsCapCheck: options.communicationsCapCheck }),
    ...(options.ownerToolCapCheck === undefined
      ? {}
      : { ownerToolCapCheck: options.ownerToolCapCheck }),
    ...(options.work === undefined ? {} : { work: options.work }),
    ...(options.promptCacheTtl === undefined
      ? {}
      : { promptCacheTtl: options.promptCacheTtl }),
    ...(options.keepAlive === undefined
      ? {}
      : { keepAlive: options.keepAlive }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.toolCallScreen === undefined
      ? {}
      : { toolCallScreen: options.toolCallScreen }),
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { url, requestLog, close: () => app.close() };
}

/** One request a fake proxy forwarded: plain, or a `CONNECT` tunnel. */
export interface ProxiedRequest {
  readonly method: string;
  /** The absolute URL asked for, or `host:port` for a tunnel. */
  readonly target: string;
  readonly proxyAuthorization: string | undefined;
}

export interface FakeProxy {
  readonly url: string;
  readonly proxied: ProxiedRequest[];
  close(): Promise<void>;
}

/**
 * A local HTTP proxy standing in for the Owner's outbound proxy: it
 * forwards plain requests (`GET http://host/…`) and tunnels `CONNECT`s,
 * to the local server `hosts` names for each host (which nothing else can
 * resolve), so a request reaches it only through the proxy. It answers
 * 407 to any request without `proxyAuthorization`, when that is given.
 */
export async function startFakeProxy(options: {
  readonly hosts: Readonly<Record<string, string>>;
  readonly proxyAuthorization?: string;
}): Promise<FakeProxy> {
  const proxied: ProxiedRequest[] = [];
  /** Tunnels' sockets, which closing the server does not end. */
  const tunnels = new Set<{ destroy(): void }>();
  /** The local `host:port` a host:port stands in for, if any. */
  const target = (host: string): { host: string; port: number } | undefined => {
    const name = host.replace(/:\d+$/, "");
    const local = options.hosts[name];
    if (local === undefined) {
      return undefined;
    }
    const url = new URL(local);
    return { host: url.hostname, port: Number(url.port) };
  };
  const allowed = (authorization: string | undefined) =>
    options.proxyAuthorization === undefined ||
    authorization === options.proxyAuthorization;
  const server = createServer((request, response) => {
    const authorization = request.headers["proxy-authorization"];
    proxied.push({
      method: request.method ?? "",
      target: request.url ?? "",
      proxyAuthorization: authorization,
    });
    if (!allowed(authorization)) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="fake"' });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/");
    const to = target(url.host);
    if (to === undefined) {
      response.writeHead(502);
      response.end();
      return;
    }
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const forwarded = httpRequest(
      {
        ...to,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    forwarded.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(forwarded);
  });
  server.on("connect", (request: IncomingMessage, socket, head: Buffer) => {
    const authorization = request.headers["proxy-authorization"];
    proxied.push({
      method: "CONNECT",
      target: request.url ?? "",
      proxyAuthorization: authorization,
    });
    const to = target(request.url ?? "");
    if (!allowed(authorization) || to === undefined) {
      socket.end(
        `HTTP/1.1 ${allowed(authorization) ? "502 Bad Gateway" : "407 Proxy Authentication Required"}\r\n\r\n`,
      );
      return;
    }
    const tunnel = connect(to.port, to.host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      tunnel.write(head);
      tunnel.pipe(socket);
      socket.pipe(tunnel);
    });
    tunnels.add(socket).add(tunnel);
    tunnel.on("error", () => socket.destroy());
    socket.on("error", () => tunnel.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    proxied,
    close: () =>
      new Promise((resolve) => {
        for (const socket of tunnels) {
          socket.destroy();
        }
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
