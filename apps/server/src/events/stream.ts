import {
  type EventBus,
  type EventFilter,
  type EventType,
  type StoredEvent,
} from "@ai-office/events";
import {
  eventStreamPath,
  eventStreamQuerySchema,
  eventStreamsPath,
  eventStreamsQuerySchema,
  lastEventIdSchema,
  type SharedStreamEvent,
  type StreamedEvent,
} from "@ai-office/events/stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The live event stream (PRD §8): server-sent events for a signed-in
// session, filtered by Floor, Agent, issue and type, with resume from
// `Last-Event-ID` out of the stored log (#15); and the shared stream,
// which carries many such filters over one connection (see
// `eventStreamsPath`).
//
// On connecting, the stream subscribes to the bus first and holds what is
// published, then replays the stored events after the client's last id,
// then sends what it held (skipping anything already sent), and from then
// on sends events as they are published. So nothing published while it
// catches up is lost or sent twice.

export interface EventStreamOptions {
  readonly bus: EventBus;
  /** How often a heartbeat comment is sent (and the session re-checked). */
  readonly heartbeatMs: number;
  /** Whether the request's session is still signed in. */
  readonly signedIn: (request: FastifyRequest) => Promise<boolean>;
}

/** How long a browser waits before reconnecting when a stream drops. */
const reconnectAfterMs = 2000;
/** How many stored events are read at a time while catching up. */
const replayPageSize = 500;

const frame = ({ id, occurredAt, event }: StoredEvent): string => {
  const data: StreamedEvent = {
    id,
    occurredAt: occurredAt.toISOString(),
    event,
  };
  return `id: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
};

/** An event on the shared stream, for its `stream`th filter; no id. */
const sharedFrame = (
  stream: number,
  { id, occurredAt, event }: StoredEvent,
): string => {
  const data: SharedStreamEvent = {
    stream,
    event: { id, occurredAt: occurredAt.toISOString(), event },
  };
  return `data: ${JSON.stringify(data)}\n\n`;
};

/**
 * Follows `filter` for one stream: subscribes first and holds what is
 * published, replays the stored events after `lastEventId` if given, then
 * sends what it held and, from then on, each event as it is published,
 * skipping anything already sent. Answers how to stop following.
 */
function follow(
  bus: EventBus,
  filter: EventFilter,
  lastEventId: number | undefined,
  write: (stored: StoredEvent) => void,
  isEnded: () => boolean,
): { readonly caughtUp: Promise<void>; readonly unsubscribe: () => void } {
  let lastSent = lastEventId ?? 0;
  let live = false;
  const held: StoredEvent[] = [];
  const send = (stored: StoredEvent): void => {
    if (!isEnded() && stored.id > lastSent) {
      lastSent = stored.id;
      write(stored);
    }
  };
  const unsubscribe = bus.subscribe((stored) => {
    if (live) {
      send(stored);
    } else {
      held.push(stored);
    }
  }, filter);
  const catchUp = async (): Promise<void> => {
    if (lastEventId !== undefined) {
      for (;;) {
        const page = await bus.eventsAfter(lastSent, filter, replayPageSize);
        for (const stored of page) {
          send(stored);
        }
        if (page.length < replayPageSize || isEnded()) {
          break;
        }
      }
    }
    for (const stored of held) {
      send(stored);
    }
    held.length = 0;
    live = true;
  };
  return { caughtUp: catchUp(), unsubscribe };
}

/**
 * Opens a server-sent event stream on `reply`, with a heartbeat that also
 * re-checks the session, and an end when the client goes, the session ends
 * or the server shuts down. `start` follows what the stream sends; it is
 * given whether the stream has ended, and answers how to stop.
 */
async function openStream(
  request: FastifyRequest,
  reply: FastifyReply,
  options: EventStreamOptions,
  open: Set<() => void>,
  start: (
    write: (text: string) => void,
    isEnded: () => boolean,
  ) => { readonly caughtUp: Promise<void>; readonly unsubscribe: () => void },
): Promise<void> {
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

  // Read through a function: TypeScript would otherwise assume the
  // callbacks below never change it.
  let ended = false;
  const isEnded = (): boolean => ended;
  const following = start((text) => {
    response.write(text);
  }, isEnded);
  const heartbeat = setInterval(() => {
    void options.signedIn(request).then(
      (signedIn) => {
        if (!signedIn) {
          request.log.info("An event stream ended: the session ended.");
          end();
          return;
        }
        if (!ended) {
          response.write(": heartbeat\n\n");
        }
      },
      () => {
        end();
      },
    );
  }, options.heartbeatMs);

  const end = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    clearInterval(heartbeat);
    following.unsubscribe();
    open.delete(end);
    response.end();
  };
  open.add(end);
  request.raw.on("close", end);

  try {
    await following.caughtUp;
  } catch (error) {
    request.log.error({ err: error }, "An event stream failed to catch up.");
    end();
  }
}

export function registerEventStream(
  app: FastifyInstance,
  options: EventStreamOptions,
): void {
  const { bus } = options;
  /** Ends every open stream: the server is shutting down. */
  const open = new Set<() => void>();
  app.addHook("preClose", (done) => {
    for (const end of [...open]) {
      end();
    }
    done();
  });

  app.get(
    eventStreamPath,
    { config: { access: "owner" } },
    async (request, reply) => {
      const query = eventStreamQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const header = request.headers["last-event-id"];
      const lastEventId =
        header === undefined
          ? { success: true as const, data: query.data.lastEventId }
          : lastEventIdSchema.safeParse(header);
      if (!lastEventId.success) {
        return sendInvalidRequest(reply, lastEventId.error);
      }
      const filter = filterOf(query.data);
      await openStream(request, reply, options, open, (write, isEnded) =>
        follow(
          bus,
          filter,
          lastEventId.data,
          (stored) => {
            write(frame(stored));
          },
          isEnded,
        ),
      );
      return undefined;
    },
  );

  // Many filters over one connection, each resuming after its own last
  // event. Its events carry no id: a client reconnects it itself, giving
  // each filter's last event again.
  app.get(
    eventStreamsPath,
    { config: { access: "owner" } },
    async (request, reply) => {
      const query = eventStreamsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      await openStream(request, reply, options, open, (write, isEnded) => {
        const followed = query.data.stream.map((stream, index) =>
          follow(
            bus,
            filterOf(stream),
            stream.lastEventId,
            (stored) => {
              write(sharedFrame(index, stored));
            },
            isEnded,
          ),
        );
        return {
          caughtUp: Promise.all(followed.map(({ caughtUp }) => caughtUp)).then(
            () => undefined,
          ),
          unsubscribe: () => {
            for (const { unsubscribe } of followed) {
              unsubscribe();
            }
          },
        };
      });
      return undefined;
    },
  );
}

/** A stream's query as a filter. */
const filterOf = (query: {
  readonly floorId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly issue?: number | undefined;
  readonly type?: EventType[] | undefined;
}): EventFilter => ({
  floorId: query.floorId,
  agentId: query.agentId,
  issue: query.issue,
  types: query.type,
});
