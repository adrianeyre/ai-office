import type { StreamedEvent } from "@ai-office/events/stream";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  eventSources,
  eventsQueryKey,
  useEventStream,
  type EventSourceLike,
} from "./event-stream.ts";

/** A stand-in for the browser's EventSource that the test drives. */
class FakeEventSource implements EventSourceLike {
  static opened: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  send(data: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    );
  }

  /** The connection dropped; `giveUp` as the browser does on a 401. */
  fail(giveUp: boolean): void {
    this.readyState = giveUp ? 2 : 0;
    this.onerror?.(new Event("error"));
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

const latest = (): FakeEventSource => {
  const source = FakeEventSource.opened.at(-1);
  if (source === undefined) {
    throw new Error("No event stream was opened.");
  }
  return source;
};

const streamed = (id: number, issue = id): StreamedEvent => ({
  id,
  occurredAt: new Date(Date.UTC(2026, 9, 8, 12, 0, id)).toISOString(),
  event: {
    type: "agent.status_changed",
    version: 1,
    floorId: "web-shop",
    agentId: "ada",
    status: "working",
    issue,
  },
});

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  FakeEventSource.opened = [];
  vi.spyOn(eventSources, "open").mockImplementation(
    (url) => new FakeEventSource(url),
  );
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useEventStream", () => {
  it("opens the stream for its filter, and merges events into the query cache", async () => {
    const filter = {
      floorId: "web-shop",
      types: ["agent.status_changed"] as const,
    };
    const { result } = renderHook(
      () => useEventStream({ ...filter, types: [...filter.types] }),
      { wrapper },
    );
    expect(latest().url).toBe(
      "/api/events/stream?floorId=web-shop&type=agent.status_changed",
    );
    expect(result.current.status).toBe("connecting");

    act(() => {
      latest().open();
      latest().send(streamed(1));
      latest().send(streamed(2));
    });
    expect(result.current.status).toBe("open");
    await vi.waitFor(() => {
      expect(result.current.events.map(({ id }) => id)).toEqual([1, 2]);
    });
    expect(
      queryClient.getQueryData(
        eventsQueryKey({ ...filter, types: [...filter.types] }),
      ),
    ).toEqual([streamed(1), streamed(2)]);
  });

  it("opens only when enabled, starting after the event it is given", () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useEventStream({ floorId: "web-shop" }, { enabled, after: 41 }),
      { wrapper, initialProps: { enabled: false } },
    );
    expect(FakeEventSource.opened).toEqual([]);
    rerender({ enabled: true });
    expect(latest().url).toBe(
      "/api/events/stream?floorId=web-shop&lastEventId=41",
    );
    rerender({ enabled: false });
    expect(latest().closed).toBe(true);
  });

  it("resumes after its cached events rather than the event it is given", () => {
    queryClient.setQueryData(eventsQueryKey(), [streamed(50)]);
    renderHook(() => useEventStream({}, { after: 41 }), { wrapper });
    expect(latest().url).toBe("/api/events/stream?lastEventId=50");
  });

  it("keeps each event once, in id order, and ignores malformed ones", async () => {
    const { result } = renderHook(() => useEventStream(), { wrapper });
    act(() => {
      latest().open();
      latest().send(streamed(2));
      latest().send(streamed(1));
      latest().send(streamed(2));
      latest().send("not json");
      latest().send({ id: 3, occurredAt: "now", event: { type: "x" } });
    });
    await vi.waitFor(() => {
      expect(result.current.events.map(({ id }) => id)).toEqual([1, 2]);
    });
  });

  it("keeps only the newest events", async () => {
    const { result } = renderHook(() => useEventStream({}, { maxEvents: 2 }), {
      wrapper,
    });
    act(() => {
      for (const id of [1, 2, 3]) {
        latest().send(streamed(id));
      }
    });
    // The query cache tells its observers on the next tick.
    await vi.waitFor(() => {
      expect(result.current.events.map(({ id }) => id)).toEqual([2, 3]);
    });
  });

  it("lets the browser reconnect by itself while it can", () => {
    const { result } = renderHook(() => useEventStream(), { wrapper });
    act(() => {
      latest().open();
      latest().fail(false);
    });
    expect(result.current.status).toBe("reconnecting");
    expect(FakeEventSource.opened).toHaveLength(1);
    act(() => {
      latest().open();
    });
    expect(result.current.status).toBe("open");
  });

  it("reconnects itself when the browser gives up, resuming after the last event", async () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useEventStream({ agentId: "ada" }), {
      wrapper,
    });
    act(() => {
      latest().open();
      latest().send(streamed(5));
      latest().fail(true);
    });
    const first = FakeEventSource.opened[0];
    expect(first?.closed).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session"] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(latest().url).toBe("/api/events/stream?agentId=ada&lastEventId=5");

    // Each failure in a row waits twice as long.
    act(() => {
      latest().fail(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(FakeEventSource.opened).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.opened).toHaveLength(3);

    act(() => {
      latest().open();
      latest().send(streamed(6));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.events.map(({ id }) => id)).toEqual([5, 6]);
  });

  it("hands each new event to onEvent, to merge into other caches", () => {
    const onEvent = vi.fn((event: StreamedEvent, client: QueryClient) => {
      client.setQueryData(["agent", "ada", "status"], event.event);
    });
    renderHook(() => useEventStream({}, { onEvent }), { wrapper });
    act(() => {
      latest().send(streamed(1, 9));
      latest().send(streamed(1, 9));
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(["agent", "ada", "status"])).toEqual(
      streamed(1, 9).event,
    );
  });

  it("closes the stream when unmounted, or when the filter changes", () => {
    const { rerender, unmount } = renderHook(
      ({ issue }: { issue: number }) => useEventStream({ issue }),
      { wrapper, initialProps: { issue: 1 } },
    );
    // The same filter in a new object keeps the stream.
    rerender({ issue: 1 });
    expect(FakeEventSource.opened).toHaveLength(1);
    rerender({ issue: 2 });
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(FakeEventSource.opened[0]?.closed).toBe(true);
    expect(latest().url).toBe("/api/events/stream?issue=2");
    unmount();
    expect(latest().closed).toBe(true);
  });
});
