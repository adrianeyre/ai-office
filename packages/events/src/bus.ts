import { createRedactor, type Redactor } from "@ai-office/shared";

import {
  matchesFilter,
  officeEventSchema,
  type EventFilter,
  type OfficeEvent,
  type StoredEvent,
} from "./schema.ts";
import type { EventHistoryQuery, EventStore } from "./store.ts";

// The in-process event bus (PRD §8). Publishing an event validates it,
// redacts it (PRD FR-5: central redaction on the bus), appends it to the
// log, and only then delivers it to subscribers, so nothing is seen that
// was not stored. Events are published one at a time, so ids are stored,
// committed and delivered in the same order.

export type EventListener = (stored: StoredEvent) => void | Promise<void>;

export interface EventBus {
  /**
   * Stores `event` and delivers it to the subscribers whose filter it
   * matches. Resolves with the event as stored (redacted, with its id).
   * Rejects with a `ZodError`, storing nothing, when `event` is malformed.
   */
  publish(event: OfficeEvent): Promise<StoredEvent>;
  /** Delivers every event published from now on that matches `filter`. */
  subscribe(listener: EventListener, filter?: EventFilter): () => void;
  /** Stored events after `afterId`, oldest first: to catch up or resume. */
  eventsAfter(
    afterId: number,
    filter?: EventFilter,
    limit?: number,
  ): Promise<StoredEvent[]>;
  /** Stored events newest first, a page at a time: the Activity Feed. */
  history(query: EventHistoryQuery): Promise<StoredEvent[]>;
}

export interface EventBusOptions {
  readonly store: EventStore;
  /** Removes secrets from every event; the server registers its own. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** Told when a subscriber throws; the other subscribers still get it. */
  readonly onListenerError?: (error: unknown, stored: StoredEvent) => void;
}

export function createEventBus(options: EventBusOptions): EventBus {
  const { store } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const subscribers = new Set<{
    readonly listener: EventListener;
    readonly filter: EventFilter;
  }>();

  const deliver = (stored: StoredEvent): void => {
    const report = (error: unknown): void => {
      options.onListenerError?.(error, stored);
    };
    for (const { listener, filter } of [...subscribers]) {
      if (!matchesFilter(stored.event, filter)) {
        continue;
      }
      try {
        const result = listener(stored);
        if (result instanceof Promise) {
          result.catch(report);
        }
      } catch (error) {
        report(error);
      }
    }
  };

  const storeAndDeliver = async (event: OfficeEvent): Promise<StoredEvent> => {
    const redacted = redactor.redact(officeEventSchema.parse(event));
    const occurredAt = now();
    const id = await store.append(redacted, occurredAt);
    const stored: StoredEvent = { id, occurredAt, event: redacted };
    deliver(stored);
    return stored;
  };

  // Each publish waits for the one before it, failed or not.
  let previous: Promise<unknown> = Promise.resolve();

  return {
    publish(event) {
      const published = previous.then(() => storeAndDeliver(event));
      previous = published.catch(() => undefined);
      return published;
    },

    subscribe(listener, filter = {}) {
      const subscriber = { listener, filter };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },

    eventsAfter(afterId, filter, limit) {
      return store.after(afterId, filter, limit);
    },

    history(query) {
      return store.history(query);
    },
  };
}
