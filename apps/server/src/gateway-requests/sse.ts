import type { FastifyReply, FastifyRequest } from "fastify";

// A server-sent event stream to a signed-in session, as the live event
// stream sends one: a reconnection delay first, a heartbeat comment that
// also re-checks the session, and an end when the client goes, the
// session ends or the server shuts down.

/** How long a browser waits before reconnecting when a stream drops. */
const reconnectAfterMs = 2000;

export interface SseStream {
  /** Sends one event with its id; nothing once the stream has ended. */
  send(id: number, data: unknown): void;
  /**
   * Sends one event without an id, so a reconnection still resumes after
   * the last event that had one.
   */
  sendData(data: unknown): void;
  end(): void;
  readonly ended: boolean;
}

export interface SseOptions {
  readonly heartbeatMs: number;
  /** Whether the request's session is still signed in. */
  readonly signedIn: (request: FastifyRequest) => Promise<boolean>;
  /** Every open stream's `end`, so the server can end them as it closes. */
  readonly open: Set<() => void>;
  /** Called once as the stream ends. */
  readonly onEnd?: () => void;
}

export function openSse(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SseOptions,
): SseStream {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    // Reverse proxies must pass each event on as it is written.
    "x-accel-buffering": "no",
  });
  response.write(`retry: ${String(reconnectAfterMs)}\n\n`);

  let ended = false;
  const end = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    clearInterval(heartbeat);
    options.open.delete(end);
    options.onEnd?.();
    response.end();
  };
  const heartbeat = setInterval(() => {
    void options.signedIn(request).then(
      (signedIn) => {
        if (!signedIn) {
          end();
        } else if (!ended) {
          response.write(": heartbeat\n\n");
        }
      },
      () => {
        end();
      },
    );
  }, options.heartbeatMs);
  options.open.add(end);
  request.raw.on("close", end);

  return {
    get ended() {
      return ended;
    },
    send(id, data) {
      if (!ended) {
        response.write(`id: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
    sendData(data) {
      if (!ended) {
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    },
    end,
  };
}
