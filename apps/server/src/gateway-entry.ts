import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { FastifyInstance, FastifyServerFactory } from "fastify";

/**
 * Whether a request is the AI Gateway's: `/v1` and everything under it
 * (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`, …). The app's
 * own paths (`/api`, `/health`, the web app's pages) never start so.
 */
export const isGatewayPath = (url: string): boolean =>
  /^\/v1(?:[/?#]|$)/.test(url);

/**
 * One entry point (Q32): a server factory for the app that hands every
 * Gateway path, untouched, to the AI Gateway's own Fastify instance (the
 * one that also listens on GATEWAY_PORT for sandboxes) and everything
 * else to the app.
 *
 * Nothing is proxied or copied: the request and response streams are the
 * Gateway's to read and write, so bodies arrive as the bytes sent and
 * server-sent events stream as they do on the Gateway's own port. None of
 * the app's hooks (sessions, CSRF, access) or content-type parsers ever
 * see a Gateway request; it authenticates by Gateway Key alone. `before`
 * is what each Gateway request gets from the app first, all the same: the
 * app's own requests get it from its `rewriteUrl` and hooks.
 */
export function gatewayEntry(
  gateway: Pick<FastifyInstance, "routing">,
  before: (request: IncomingMessage, response: ServerResponse) => void = () =>
    undefined,
): FastifyServerFactory {
  return (handler, options): Server => {
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        if (isGatewayPath(request.url ?? "")) {
          before(request, response);
          gateway.routing(request, response);
        } else {
          handler(request, response);
        }
      },
    );
    // As Fastify sets up its own server (its defaults are in `options`).
    const number = (key: string): number | undefined => {
      const value = options[key];
      return typeof value === "number" ? value : undefined;
    };
    server.keepAliveTimeout = number("keepAliveTimeout") ?? 72_000;
    server.requestTimeout = number("requestTimeout") ?? 0;
    server.setTimeout(number("connectionTimeout") ?? 0);
    const perSocket = number("maxRequestsPerSocket") ?? 0;
    if (perSocket > 0) {
      server.maxRequestsPerSocket = perSocket;
    }
    return server;
  };
}
