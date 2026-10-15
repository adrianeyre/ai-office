import { eventStreamUrl } from "@ai-office/events/stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharedEventStream } from "./shared-event-stream.ts";

/** A connection to the shared stream, driven by the test. */
class FakeSource {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /** Each stream's query, as the connection's URL gives it. */
  get streams(): string[] {
    return new URLSearchParams(this.url.split("?")[1] ?? "").getAll("stream");
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  send(stream: number, id: number): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          stream,
          event: {
            id,
            occurredAt: "2026-10-11T09:00:00.000Z",
            event: {
              type: "agent.status_changed",
              version: 1,
              floorId: "web-shop",
              agentId: "ada",
              status: "working",
              issue: id,
            },
          },
        }),
      }),
    );
  }

  fail(gone: boolean): void {
    this.readyState = gone ? 2 : 0;
    this.onerror?.(new Event("error"));
  }

  close(): void {
    this.readyState = 2;
  }
}

/** The shared stream, and every connection it made. */
function setUp() {
  const sources: FakeSource[] = [];
  const hub = new SharedEventStream((url) => {
    const source = new FakeSource(url);
    sources.push(source);
    return source;
  });
  return { hub, sources };
}

/** What a stand-in was given: the ids of its events, and its opens and errors. */
function watch(stream: {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
}) {
  const seen = { ids: [] as number[], opens: 0, errors: 0 };
  stream.onopen = () => {
    seen.opens += 1;
  };
  stream.onmessage = (message) => {
    seen.ids.push((JSON.parse(message.data) as { id: number }).id);
  };
  stream.onerror = () => {
    seen.errors += 1;
  };
  return seen;
}

const settled = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("SharedEventStream", () => {
  it("carries only the event stream's URLs", () => {
    expect(SharedEventStream.carries("/api/events/stream")).toBe(true);
    expect(
      SharedEventStream.carries(eventStreamUrl({ floorId: "web-shop" }, 4)),
    ).toBe(true);
    expect(SharedEventStream.carries("/api/terminal/stream")).toBe(false);
    expect(SharedEventStream.carries("/api/events/streams?stream=")).toBe(
      false,
    );
  });

  it("carries every stream the page opens at once over one connection", async () => {
    const { hub, sources } = setUp();
    const floor = hub.open(eventStreamUrl({ floorId: "web-shop" }));
    const agent = hub.open(eventStreamUrl({ agentId: "ada" }, 7));
    const floorSeen = watch(floor);
    const agentSeen = watch(agent);
    await settled();

    expect(sources).toHaveLength(1);
    expect(sources[0]?.url.startsWith("/api/events/streams?")).toBe(true);
    expect(sources[0]?.streams).toEqual([
      "floorId=web-shop",
      "agentId=ada&lastEventId=7",
    ]);
    sources[0]?.open();
    expect([floor.readyState, agent.readyState]).toEqual([1, 1]);
    expect([floorSeen.opens, agentSeen.opens]).toEqual([1, 1]);

    sources[0]?.send(0, 8);
    sources[0]?.send(1, 9);
    sources[0]?.send(1, 9);
    expect(floorSeen.ids).toEqual([8]);
    expect(agentSeen.ids).toEqual([9]);
  });

  it("replaces the connection as streams open, each resuming after its last event, missing nothing", async () => {
    const { hub, sources } = setUp();
    const floor = hub.open(eventStreamUrl({ floorId: "web-shop" }));
    const floorSeen = watch(floor);
    await settled();
    const [first] = sources;
    first?.open();
    first?.send(0, 3);

    const notices = hub.open(eventStreamUrl({ types: ["notice.raised"] }));
    const noticesSeen = watch(notices);
    await settled();
    const second = sources[1];
    expect(second?.streams).toEqual([
      "floorId=web-shop&lastEventId=3",
      "type=notice.raised",
    ]);
    // The old connection carries on until the new one is open.
    expect(first?.readyState).toBe(1);
    first?.send(0, 4);
    expect(notices.readyState).toBe(0);

    second?.open();
    expect(first?.readyState).toBe(2);
    expect(noticesSeen.opens).toBe(1);
    // What the old one gave already is not given again.
    second?.send(0, 4);
    second?.send(0, 5);
    second?.send(1, 6);
    expect(floorSeen.ids).toEqual([3, 4, 5]);
    expect(noticesSeen.ids).toEqual([6]);
    expect(floorSeen.opens).toBe(1);
  });

  it("lets the old connection go if the new one does not open", async () => {
    vi.useFakeTimers();
    const { hub, sources } = setUp();
    hub.open(eventStreamUrl({ floorId: "web-shop" }));
    await settled();
    sources[0]?.open();
    hub.open(eventStreamUrl({ floorId: "blog" }));
    await settled();
    expect(sources[0]?.readyState).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(sources[0]?.readyState).toBe(2);
  });

  it("drops a closed stream, and the connection once none is left", async () => {
    const { hub, sources } = setUp();
    const floor = hub.open(eventStreamUrl({ floorId: "web-shop" }));
    const blog = hub.open(eventStreamUrl({ floorId: "blog" }));
    const blogSeen = watch(blog);
    await settled();
    sources[0]?.open();

    floor.close();
    await settled();
    expect(sources[1]?.streams).toEqual(["floorId=blog"]);
    sources[1]?.open();
    expect(sources[0]?.readyState).toBe(2);
    sources[1]?.send(0, 2);
    expect(blogSeen.ids).toEqual([2]);

    blog.close();
    await settled();
    expect(sources).toHaveLength(2);
    expect(sources[1]?.readyState).toBe(2);
  });

  it("tells each stream when the connection drops, and when it is refused", async () => {
    const { hub, sources } = setUp();
    const floor = hub.open(eventStreamUrl({ floorId: "web-shop" }));
    const floorSeen = watch(floor);
    await settled();
    sources[0]?.open();

    // Dropped: the browser reconnects it.
    sources[0]?.fail(false);
    expect(floor.readyState).toBe(0);
    expect(floorSeen.errors).toBe(1);
    sources[0]?.open();
    expect(floor.readyState).toBe(1);

    // Refused: the stream is closed, and reconnects itself.
    sources[0]?.fail(true);
    expect(floor.readyState).toBe(2);
    expect(floorSeen.errors).toBe(2);
    floor.close();
    hub.open(eventStreamUrl({ floorId: "web-shop" }, 9));
    await settled();
    expect(sources[1]?.streams).toEqual(["floorId=web-shop&lastEventId=9"]);
  });
});
