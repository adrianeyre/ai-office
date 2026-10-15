import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type EventStore,
  type OfficeEvent,
} from "@ai-office/events";
import {
  eventStreamsUrl,
  maxSharedStreams,
  sharedStreamEventSchema,
  sharedStreamQuery,
  streamedEventSchema,
  type SharedStreamEvent,
  type StreamedEvent,
} from "@ai-office/events/stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

const status = (
  agentId: string,
  issue: number,
  floorId = "web-shop",
): OfficeEvent => ({
  type: "agent.status_changed",
  version: 1,
  floorId,
  agentId,
  status: "working",
  issue,
});

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A signed-in app listening on a free port, with an in-memory event log. */
async function app(
  options: { heartbeatMs?: number; store?: EventStore } = {},
): Promise<{
  server: FastifyInstance;
  bus: EventBus;
  baseUrl: string;
  owner: SignedIn;
}> {
  const bus = createEventBus({ store: options.store ?? memoryEventStore() });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    ...(options.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: options.heartbeatMs }),
  });
  servers.push(server);
  const owner = await signIn(server);
  const baseUrl = await server.listen({ port: 0, host: "127.0.0.1" });
  return { server, bus, baseUrl, owner };
}

interface Frame {
  readonly id?: string;
  readonly data?: string;
  readonly retry?: string;
  readonly comments: readonly string[];
}

const parseFrame = (text: string): Frame => {
  const frame: { -readonly [Key in keyof Frame]: Frame[Key] } = {
    comments: [],
  };
  const comments: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(":")) {
      comments.push(line.slice(1).trim());
      continue;
    }
    const separator = line.indexOf(":");
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();
    if (field === "id" || field === "data" || field === "retry") {
      frame[field] = value;
    }
  }
  return { ...frame, comments };
};

/** An open stream, read one frame at a time. */
async function connect(
  baseUrl: string,
  options: {
    cookie?: string;
    query?: string;
    headers?: Record<string, string>;
    /** The whole path and query, in place of the stream's own. */
    path?: string;
  },
) {
  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}${options.path ?? `/api/events/stream${options.query ?? ""}`}`,
    {
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...options.headers,
      },
      signal: controller.signal,
    },
  );
  const body = response.body;
  if (body === null) {
    throw new Error("The stream has no body.");
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** The next frame, or undefined when the stream has ended. */
  const nextFrame = async (): Promise<Frame | undefined> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return parseFrame(text);
      }
      const { value, done } = await reader.read();
      if (done) {
        return undefined;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };

  return {
    response,
    nextFrame,
    /** The next event, skipping `retry` and comment frames. */
    async nextEvent(): Promise<StreamedEvent & { frameId: string }> {
      for (;;) {
        const frame = await nextFrame();
        if (frame === undefined) {
          throw new Error("The stream ended.");
        }
        if (frame.data !== undefined) {
          return {
            ...streamedEventSchema.parse(JSON.parse(frame.data)),
            frameId: frame.id ?? "",
          };
        }
      }
    },
    /** The shared stream's next event, skipping `retry` and comment frames. */
    async nextSharedEvent(): Promise<SharedStreamEvent & { frameId?: string }> {
      for (;;) {
        const frame = await nextFrame();
        if (frame === undefined) {
          throw new Error("The stream ended.");
        }
        if (frame.data !== undefined) {
          return {
            ...sharedStreamEventSchema.parse(JSON.parse(frame.data)),
            ...(frame.id === undefined ? {} : { frameId: frame.id }),
          };
        }
      }
    },
    close() {
      controller.abort();
    },
  };
}

describe("GET /api/events/stream", { timeout: 10_000 }, () => {
  it("answers 401 without a session", async () => {
    const { server, baseUrl } = await app();
    const injected = await server.inject({ url: "/api/events/stream" });
    expect(injected.statusCode).toBe(401);
    expect(injected.json()).toMatchObject({ error: "unauthorized" });

    const stale = await fetch(`${baseUrl}/api/events/stream`, {
      headers: { cookie: "ai_office_session=not-a-session" },
    });
    expect(stale.status).toBe(401);
    expect(stale.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("streams events published after connecting, as server-sent events", async () => {
    const { bus, baseUrl, owner } = await app();
    const stream = await connect(baseUrl, { cookie: owner.cookie });
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(stream.response.headers.get("cache-control")).toContain("no-cache");
    expect(await stream.nextFrame()).toEqual({
      retry: "2000",
      comments: [],
    });

    const published = await bus.publish(status("ada", 4));
    const received = await stream.nextEvent();
    expect(received).toEqual({
      id: published.id,
      frameId: String(published.id),
      occurredAt: published.occurredAt.toISOString(),
      event: status("ada", 4),
    });
    stream.close();
  });

  it("resumes from Last-Event-ID: disconnect, publish two, reconnect, receive both in order", async () => {
    const { bus, baseUrl, owner } = await app();
    const first = await connect(baseUrl, { cookie: owner.cookie });
    const one = await bus.publish(status("ada", 1));
    const seen = await first.nextEvent();
    expect(seen.id).toBe(one.id);
    first.close();

    const two = await bus.publish(status("ada", 2));
    const three = await bus.publish(status("ada", 3));

    const again = await connect(baseUrl, {
      cookie: owner.cookie,
      headers: { "last-event-id": seen.frameId },
    });
    const missed = [await again.nextEvent(), await again.nextEvent()];
    expect(missed.map(({ id, event }) => [id, event])).toEqual([
      [two.id, status("ada", 2)],
      [three.id, status("ada", 3)],
    ]);
    // Then it carries on live, without repeating anything.
    const four = await bus.publish(status("ada", 4));
    expect((await again.nextEvent()).id).toBe(four.id);
    again.close();
  });

  it("resumes from the lastEventId query parameter too", async () => {
    const { bus, baseUrl, owner } = await app();
    const [one, two, three] = [
      await bus.publish(status("ada", 1)),
      await bus.publish(status("ada", 2)),
      await bus.publish(status("ada", 3)),
    ];
    const stream = await connect(baseUrl, {
      cookie: owner.cookie,
      query: `?lastEventId=${String(one.id)}`,
    });
    expect((await stream.nextEvent()).id).toBe(two.id);
    expect((await stream.nextEvent()).id).toBe(three.id);
    stream.close();
  });

  it("loses nothing published while it catches up, and repeats nothing", async () => {
    const store = memoryEventStore();
    const late: { bus?: EventBus } = {};
    let caughtUp = false;
    // While the stream reads the log, two more events are published: one
    // the read already includes, and one it does not.
    const slowStore: EventStore = {
      append: (event, at) => store.append(event, at),
      async after(afterId, filter, limit) {
        if (!caughtUp && late.bus !== undefined) {
          caughtUp = true;
          await late.bus.publish(status("ada", 3));
          const page = await store.after(afterId, filter, limit);
          await late.bus.publish(status("ada", 4));
          return page;
        }
        return store.after(afterId, filter, limit);
      },
      history: (query) => store.history(query),
      deleteBefore: (before) => store.deleteBefore(before),
    };
    const { bus, baseUrl, owner } = await app({ store: slowStore });
    late.bus = bus;
    const one = await bus.publish(status("ada", 1));
    await bus.publish(status("ada", 2));

    const stream = await connect(baseUrl, {
      cookie: owner.cookie,
      headers: { "last-event-id": String(one.id) },
    });
    const received = [];
    for (let count = 0; count < 3; count += 1) {
      received.push((await stream.nextEvent()).event);
    }
    // Issue 2 was stored before; 3 and 4 were published while it caught up.
    expect(received).toEqual([2, 3, 4].map((issue) => status("ada", issue)));
    await bus.publish(status("ada", 5));
    expect((await stream.nextEvent()).event).toEqual(status("ada", 5));
    stream.close();
  });

  it("filters by Floor, Agent, issue and type", async () => {
    const { bus, baseUrl, owner } = await app();
    const stream = await connect(baseUrl, {
      cookie: owner.cookie,
      query:
        "?floorId=web-shop&agentId=ada&issue=7&type=agent.status_changed,handoff",
    });
    await stream.nextFrame();
    await bus.publish(status("ada", 7, "blog")); // 1: another Floor
    await bus.publish(status("grace", 7)); // 2: another Agent
    await bus.publish(status("ada", 8)); // 3: another issue
    await bus.publish({
      type: "issue.assigned",
      version: 1,
      floorId: "web-shop",
      issue: 7,
      agentId: "ada",
    }); // 4: another type
    await bus.publish({
      type: "handoff",
      version: 1,
      floorId: "web-shop",
      issue: 7,
      fromAgentId: "grace",
      toAgentId: "ada",
      stage: "needs-review",
      summary: { changed: "x", check: "y", risks: "z" },
    }); // 5
    const sixth = await bus.publish(status("ada", 7)); // 6
    expect((await stream.nextEvent()).id).toBe(sixth.id - 1);
    expect((await stream.nextEvent()).id).toBe(sixth.id);
    stream.close();
  });

  it("refuses a malformed filter or Last-Event-ID", async () => {
    const { server, owner } = await app();
    for (const [query, headers] of [
      ["?type=floor.flooded", {}],
      ["?issue=seven", {}],
      ["?colour=red", {}],
      ["", { "last-event-id": "seven" }],
    ] as const) {
      const response = await server.inject({
        url: `/api/events/stream${query}`,
        headers: { cookie: owner.cookie, ...headers },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_request" });
    }
  });

  it("sends a heartbeat", async () => {
    const { baseUrl, owner } = await app({ heartbeatMs: 20 });
    const stream = await connect(baseUrl, { cookie: owner.cookie });
    await stream.nextFrame();
    expect(await stream.nextFrame()).toEqual({ comments: ["heartbeat"] });
    stream.close();
  });

  it("ends when the session ends", async () => {
    const { server, baseUrl, owner } = await app({ heartbeatMs: 20 });
    const stream = await connect(baseUrl, { cookie: owner.cookie });
    await stream.nextFrame();
    await server.inject({
      method: "POST",
      url: "/api/logout/everywhere",
      headers: owner.headers,
    });
    let frame = await stream.nextFrame();
    while (frame !== undefined) {
      frame = await stream.nextFrame();
    }
    // Reconnecting is refused.
    const again = await fetch(`${baseUrl}/api/events/stream`, {
      headers: { cookie: owner.cookie },
    });
    expect(again.status).toBe(401);
  });

  it("does not hold up the server's shutdown", async () => {
    const { server, baseUrl, owner } = await app();
    const stream = await connect(baseUrl, { cookie: owner.cookie });
    await stream.nextFrame();
    await server.close();
    expect(await stream.nextFrame()).toBeUndefined();
  });
});

describe("GET /api/events/streams", { timeout: 10_000 }, () => {
  it("answers 401 without a session", async () => {
    const { server } = await app();
    const injected = await server.inject({
      url: eventStreamsUrl([sharedStreamQuery()]),
    });
    expect(injected.statusCode).toBe(401);
  });

  it("carries many filters over one connection, each resuming after its own last event", async () => {
    const { bus, baseUrl, owner } = await app();
    const one = await bus.publish(status("ada", 1, "web-shop"));
    await bus.publish(status("bob", 2, "blog"));
    const three = await bus.publish(status("ada", 3, "web-shop"));
    const stream = await connect(baseUrl, {
      cookie: owner.cookie,
      path: eventStreamsUrl([
        // The web shop's, after the first: the third is replayed.
        sharedStreamQuery({ floorId: "web-shop" }, one.id),
        // The blog's, from now on: nothing is replayed.
        sharedStreamQuery({ floorId: "blog" }),
      ]),
    });
    expect(stream.response.status).toBe(200);
    const replayed = await stream.nextSharedEvent();
    expect(replayed).toEqual({
      stream: 0,
      event: {
        id: three.id,
        occurredAt: three.occurredAt.toISOString(),
        event: status("ada", 3, "web-shop"),
      },
    });
    // Without an id, so a browser's own reconnection resumes nothing.
    expect(replayed.frameId).toBeUndefined();

    const four = await bus.publish(status("bob", 4, "blog"));
    const five = await bus.publish(status("ada", 5, "web-shop"));
    const live = [
      await stream.nextSharedEvent(),
      await stream.nextSharedEvent(),
    ];
    expect(live.map(({ stream: index, event }) => [index, event.id])).toEqual([
      [1, four.id],
      [0, five.id],
    ]);
    stream.close();
  });

  it("gives an event to every filter it matches", async () => {
    const { bus, baseUrl, owner } = await app();
    const stream = await connect(baseUrl, {
      cookie: owner.cookie,
      path: eventStreamsUrl([
        sharedStreamQuery({ floorId: "web-shop" }),
        sharedStreamQuery({ agentId: "ada" }),
      ]),
    });
    await stream.nextFrame();
    const published = await bus.publish(status("ada", 1));
    const both = [
      await stream.nextSharedEvent(),
      await stream.nextSharedEvent(),
    ];
    expect(both.map(({ stream: index, event }) => [index, event.id])).toEqual([
      [0, published.id],
      [1, published.id],
    ]);
    stream.close();
  });

  it("refuses no filter, too many, or a malformed one", async () => {
    const { server, owner } = await app();
    const many = Array.from({ length: maxSharedStreams + 1 }, () =>
      sharedStreamQuery(),
    );
    for (const url of [
      "/api/events/streams",
      eventStreamsUrl(many),
      eventStreamsUrl(["type=not.a.type"]),
      eventStreamsUrl(["lastEventId=-1"]),
      eventStreamsUrl(["colour=blue"]),
    ]) {
      const injected = await server.inject({
        url,
        headers: { cookie: owner.cookie },
      });
      expect(injected.statusCode, url).toBe(400);
    }
  });
});

describe("GET /api/events/stream against Postgres 18", () => {
  postgresTest(
    "resumes from Last-Event-ID out of the events table",
    async ({ database }) => {
      const { bus, baseUrl, owner } = await app({
        store: databaseEventStore(database.db),
      });
      const first = await connect(baseUrl, { cookie: owner.cookie });
      await bus.publish(status("ada", 1));
      const seen = await first.nextEvent();
      first.close();

      const two = await bus.publish(status("ada", 2));
      const three = await bus.publish(status("grace", 3));

      const again = await connect(baseUrl, {
        cookie: owner.cookie,
        headers: { "last-event-id": seen.frameId },
      });
      const missed = [await again.nextEvent(), await again.nextEvent()];
      expect(missed.map(({ id, event }) => [id, event])).toEqual([
        [two.id, status("ada", 2)],
        [three.id, status("grace", 3)],
      ]);
      again.close();
    },
  );
});
