import { createServer, type Server } from "node:http";

import type { FastifyBaseLogger } from "fastify";

import { securityHeaders } from "../security-headers.ts";

// A subscription sign-in that ends on a local callback, as ChatGPT's does
// (`http://localhost:1455/auth/callback`, Codex CLI's, the only address
// OpenAI allows for its client). While such a sign-in waits, AI Office
// listens on that port itself, so when the browser is on the same machine
// as AI Office the sign-in finishes on its own: the page the browser lands
// on says so, and the AI Accounts card sees the account added. When the
// browser is elsewhere, the page does not load and the Owner pastes its
// address back, as before. The port is held only while a sign-in waits,
// so the Codex CLI's own sign-in can use it the rest of the time.
//
// The listener is not the app's, so none of the app's hooks run for it:
// each answer sets the security headers itself, as /v1's do (A1-6, I2-1).

export interface OAuthCallbacksOptions {
  /** Where to listen: loopback unless AI Office runs in a container. */
  readonly host: string;
  /** Finishes the sign-in whose callback was `url`. */
  readonly complete: (url: string) => Promise<unknown>;
  /** Whether a sign-in ending on `redirectUri` still waits. */
  readonly awaiting: (redirectUri: string) => boolean;
  readonly logger: FastifyBaseLogger;
  /** How often to check whether to stop listening; a minute by default. */
  readonly checkMs?: number;
}

export interface OAuthCallbacks {
  /**
   * Listens for a sign-in ending on `redirectUri`, if it is a local
   * address (`localhost` or `127.0.0.1` on a port), until no sign-in ending
   * there waits. Anything else is left to the Owner to paste back.
   */
  expect(redirectUri: string): Promise<void>;
  /** Stops every listener. */
  close(): Promise<void>;
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The page the browser lands on: a heading and what to do next. */
export const callbackPage = (heading: string, text: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(heading)} · AI Office</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#0f172a;background:#fff}@media (prefers-color-scheme:dark){body{color:#e2e8f0;background:#0f172a}}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;

/** The local port and path a redirect address is served on, if it is local. */
export function localCallback(
  redirectUri: string,
): { readonly port: number; readonly path: string } | undefined {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.port === ""
  ) {
    return undefined;
  }
  return { port: Number(url.port), path: url.pathname };
}

export function createOAuthCallbacks(
  options: OAuthCallbacksOptions,
): OAuthCallbacks {
  const { logger } = options;
  const checkMs = options.checkMs ?? 60_000;
  const listening = new Map<
    string,
    { server: Server; timer: ReturnType<typeof setInterval> }
  >();

  const stop = async (redirectUri: string): Promise<void> => {
    const open = listening.get(redirectUri);
    if (open === undefined) {
      return;
    }
    listening.delete(redirectUri);
    clearInterval(open.timer);
    await new Promise<void>((resolve) => {
      open.server.close(() => {
        resolve();
      });
      open.server.closeAllConnections();
    });
  };

  return {
    async expect(redirectUri) {
      const local = localCallback(redirectUri);
      if (local === undefined || listening.has(redirectUri)) {
        return;
      }
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (request.method !== "GET" || url.pathname !== local.path) {
          response.writeHead(404, {
            ...securityHeaders({ https: false }),
            "content-type": "text/plain",
          });
          response.end("Not found");
          return;
        }
        const send = (status: number, heading: string, text: string) => {
          response.writeHead(status, {
            // Served over plain http on this machine, so no HSTS.
            ...securityHeaders({ https: false }),
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          response.end(callbackPage(heading, text));
        };
        if (url.searchParams.has("error")) {
          send(
            400,
            "The sign-in did not finish",
            "It was cancelled or refused. Go back to AI Office and start it again.",
          );
          return;
        }
        // The address holds the code: never logged.
        options.complete(url.href).then(
          () => {
            logger.info("A subscription sign-in finished on its callback.");
            send(
              200,
              "Signed in",
              "The account is added to AI Office. You can close this tab and go back to AI Office.",
            );
            if (!options.awaiting(redirectUri)) {
              void stop(redirectUri);
            }
          },
          (error: unknown) => {
            send(
              400,
              "The sign-in did not finish",
              `${error instanceof Error ? error.message : "Something went wrong."} You can also paste this page's address into AI Office.`,
            );
          },
        );
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(local.port, options.host, () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        // Such as the Codex CLI's own sign-in holding the port: the Owner
        // pastes the address back instead.
        logger.warn(
          { err: error, port: local.port },
          "The sign-in's callback port is in use, so the address must be pasted back.",
        );
        return;
      }
      const timer = setInterval(() => {
        if (!options.awaiting(redirectUri)) {
          void stop(redirectUri);
        }
      }, checkMs);
      timer.unref();
      listening.set(redirectUri, { server, timer });
    },

    async close() {
      await Promise.all([...listening.keys()].map(stop));
    },
  };
}
