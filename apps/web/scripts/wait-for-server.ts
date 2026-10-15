import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import type { Connect, Plugin } from "vite";

// In `pnpm dev`, Vite is often ready before the server listens (it starts
// in parallel and takes a few seconds more), and the server restarts on
// every change (`node --watch`). A page already open in the browser asks
// for the API at once, and Vite's proxy answers each such request with a
// 502 and an `http proxy error … ECONNREFUSED` in the terminal. So the
// proxied paths wait here for the server instead, as long as it takes to
// start, and only then go through the proxy; one line says it is waited
// for. A server that is not up within `timeoutMs` is answered 503.

/** Whether something accepts connections at `target`'s host and port. */
export function listening(target: string): Promise<boolean> {
  const { hostname, port } = new URL(target);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export interface WaitForServerOptions {
  /** The server's address, as the proxy's `target`. */
  readonly target: string;
  /** The paths the proxy sends to it. */
  readonly paths: readonly string[];
  /** How long a request waits for the server; 30 seconds by default. */
  readonly timeoutMs?: number;
  /** How often it looks again while it waits; every quarter second by default. */
  readonly pollMs?: number;
  /** Says it is waiting, and when the server is up; Vite's logger in a plugin. */
  readonly log?: (message: string) => void;
  /** Whether the server is up; a TCP connection by default. */
  readonly isUp?: () => Promise<boolean>;
}

/**
 * The middleware that holds a proxied request until the server is up:
 * every request waiting at once shares one wait, so the line is said once.
 */
export function waitForServerMiddleware(
  options: WaitForServerOptions,
): Connect.NextHandleFunction {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const isUp = options.isUp ?? (() => listening(options.target));
  let waiting: Promise<boolean> | undefined;

  const up = async (): Promise<boolean> => {
    if (await isUp()) {
      return true;
    }
    waiting ??= (async () => {
      options.log?.(`Waiting for AI Office's server at ${options.target}…`);
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        await sleep(pollMs);
        if (await isUp()) {
          options.log?.("AI Office's server is up.");
          return true;
        }
      }
      return false;
    })().finally(() => {
      waiting = undefined;
    });
    return waiting;
  };

  return (request, response, next) => {
    const path = request.url ?? "";
    if (!options.paths.some((prefix) => path.startsWith(prefix))) {
      next();
      return;
    }
    void up().then((ready) => {
      if (ready) {
        next();
        return;
      }
      response.writeHead(503, {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": "2",
      });
      response.end(
        `AI Office's server at ${options.target} is not running: see the server's output in the terminal.\n`,
      );
    });
  };
}

/** The plugin: the middleware, ahead of Vite's own proxy. */
export function waitForServer(
  options: Omit<WaitForServerOptions, "log">,
): Plugin {
  return {
    name: "ai-office-wait-for-server",
    apply: "serve",
    configureServer(server) {
      // Added here, not in a returned hook, so it runs before Vite's
      // internal middlewares, the proxy among them.
      server.middlewares.use(
        waitForServerMiddleware({
          ...options,
          log: (message) => {
            server.config.logger.info(message, { timestamp: true });
          },
        }),
      );
    },
  };
}
