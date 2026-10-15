import { createRedactor, redactedText } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createEventBus } from "./bus.ts";
import type { OfficeEvent, StoredEvent } from "./schema.ts";
import { memoryEventStore } from "./store.ts";
import { checkHistory, exampleEvents } from "./test-support.ts";

const start = new Date("2026-10-08T12:00:00.000Z");

function bus(options: { secrets?: string[] } = {}) {
  const store = memoryEventStore();
  let tick = 0;
  const errors: unknown[] = [];
  const events = createEventBus({
    store,
    redactor: createRedactor({ secrets: options.secrets ?? [] }),
    // Each event a millisecond after the one before.
    now: () => new Date(start.getTime() + tick++),
    onListenerError: (error) => errors.push(error),
  });
  return { bus: events, store, errors };
}

const status = (agentId: string, issue: number): OfficeEvent => ({
  type: "agent.status_changed",
  version: 1,
  floorId: "web-shop",
  agentId,
  status: "working",
  issue,
});

describe("the event bus", () => {
  it("stores published events in order, then delivers them to subscribers", async () => {
    const { bus: events, store } = bus();
    const received: StoredEvent[] = [];
    const storedWhenDelivered: number[] = [];
    events.subscribe((stored) => {
      received.push(stored);
      storedWhenDelivered.push(store.events.length);
    });

    const published = [
      exampleEvents["floor.created"],
      exampleEvents["agent.created"],
      exampleEvents.handoff,
    ];
    for (const event of published) {
      await events.publish(event);
    }

    expect(store.events.map(({ id, event }) => [id, event])).toEqual(
      published.map((event, index) => [index + 1, event]),
    );
    expect(received).toEqual(store.events);
    // Each was stored before anyone heard of it.
    expect(storedWhenDelivered).toEqual([1, 2, 3]);
    expect(received.map(({ occurredAt }) => occurredAt.getTime())).toEqual([
      start.getTime(),
      start.getTime() + 1,
      start.getTime() + 2,
    ]);
  });

  it("keeps the order of events published at once", async () => {
    const { bus: events, store } = bus();
    const received: number[] = [];
    events.subscribe(({ event }) => {
      if (event.type === "agent.status_changed") {
        received.push(event.issue ?? 0);
      }
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        events.publish(status("ada", index + 1)),
      ),
    );
    expect(results.map(({ id }) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(received).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(store.events).toHaveLength(20);
  });

  it("delivers to each subscriber only what matches its filter", async () => {
    const { bus: events } = bus();
    const ada = vi.fn();
    const issue7 = vi.fn();
    const handoffs = vi.fn();
    events.subscribe(ada, { agentId: "ada" });
    events.subscribe(issue7, { floorId: "web-shop", issue: 7 });
    events.subscribe(handoffs, { types: ["handoff"] });

    await events.publish(status("ada", 7));
    await events.publish(status("grace", 7));
    await events.publish(exampleEvents.handoff);

    const types = (listener: typeof ada) =>
      listener.mock.calls.map(([stored]) => (stored as StoredEvent).id);
    expect(types(ada)).toEqual([1, 3]);
    expect(types(issue7)).toEqual([1, 2]);
    expect(types(handoffs)).toEqual([3]);
  });

  it("stops delivering once unsubscribed", async () => {
    const { bus: events } = bus();
    const listener = vi.fn();
    const unsubscribe = events.subscribe(listener);
    await events.publish(status("ada", 1));
    unsubscribe();
    await events.publish(status("ada", 2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed event, storing and delivering nothing", async () => {
    const { bus: events, store } = bus();
    const listener = vi.fn();
    events.subscribe(listener);
    await expect(
      events.publish({
        ...exampleEvents["floor.archived"],
        floorId: "",
      }),
    ).rejects.toThrow();
    // A failure does not hold up the next event.
    await events.publish(exampleEvents["floor.archived"]);
    expect(store.events.map(({ id }) => id)).toEqual([1]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers to every subscriber even when one throws", async () => {
    const { bus: events, errors } = bus();
    const after = vi.fn();
    events.subscribe(() => {
      throw new Error("listener failed");
    });
    events.subscribe(() => Promise.reject(new Error("async listener failed")));
    events.subscribe(after);
    const stored = await events.publish(status("ada", 1));
    expect(after).toHaveBeenCalledWith(stored);
    await vi.waitFor(() => {
      expect(errors).toHaveLength(2);
    });
  });

  it("reads back the events after an id, filtered", async () => {
    const { bus: events } = bus();
    for (const issue of [1, 2, 3, 4]) {
      await events.publish(status(issue % 2 === 0 ? "ada" : "grace", issue));
    }
    const after = await events.eventsAfter(1, { agentId: "ada" });
    expect(after.map(({ id }) => id)).toEqual([2, 4]);
    expect(await events.eventsAfter(0, {}, 2)).toHaveLength(2);
  });

  it("reads the log back newest first, a page at a time (the Activity Feed)", async () => {
    let tick = 0;
    await checkHistory(
      createEventBus({
        store: memoryEventStore(),
        now: () => new Date(start.getTime() + 1000 * tick++),
      }),
    );
  });
});

describe("redaction on the bus", () => {
  it("removes a secret placed in a payload before it is stored or delivered", async () => {
    const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const registered = "a-registered-gateway-credential";
    const { bus: events, store } = bus({ secrets: [registered] });
    const received: StoredEvent[] = [];
    events.subscribe((stored) => {
      received.push(stored);
    });

    const event: OfficeEvent = {
      type: "notice.raised",
      version: 1,
      noticeId: "n-1",
      kind: "action",
      title: `AI Account rejected key ${apiKey}`,
      floorId: "web-shop",
    };
    const blocked: OfficeEvent = {
      type: "agent.status_changed",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      status: "blocked",
      reason: `git push failed: password=${registered}`,
    };
    const stored = await events.publish(event);
    await events.publish(blocked);

    expect(stored.event).toEqual({
      ...event,
      title: `AI Account rejected key ${redactedText}`,
    });
    expect(store.events[1]?.event).toEqual({
      ...blocked,
      reason: `git push failed: password=${redactedText}`,
    });
    const everything = JSON.stringify([store.events, received]);
    expect(everything).not.toContain(apiKey);
    expect(everything).not.toContain(registered);
    // The caller's object is left as it was.
    expect(event.title).toContain(apiKey);
  });
});
