import type { EventFilter } from "@ai-office/events/schema";
import {
  eventStreamUrl,
  streamedEventSchema,
  type StreamedEvent,
} from "@ai-office/events/stream";
import {
  skipToken,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { sessionQuery } from "./session.ts";
import { SharedEventStream } from "./shared-event-stream.ts";

// The web app's view of the live event stream (PRD §8: the web app is a
// view over one event stream). `useEventStream` keeps an EventSource open
// for a filter, reconnects when it drops, and merges each event into the
// TanStack Query cache under `eventsQueryKey(filter)`. Every filter's
// stream on the page shares one connection (shared-event-stream.ts).

/** The part of the browser's EventSource the hook uses. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

/** `EventSource.CLOSED`: the browser will not reconnect by itself. */
const closed = 2;

/**
 * The page's one connection for the live event stream, made when first
 * needed: every stream at `eventStreamPath` is carried by it, so they hold
 * one of the browser's few connections to the server between them.
 */
let shared: SharedEventStream | undefined;

/** Opens event streams; tests replace it. */
export const eventSources = {
  open(url: string): EventSourceLike {
    if (!SharedEventStream.carries(url)) {
      return new EventSource(url);
    }
    shared ??= new SharedEventStream((sharedUrl) => new EventSource(sharedUrl));
    return shared.open(url);
  },
};

/** The cache key of a filter's events; equal filters share it. */
export const eventsQueryKey = (filter: EventFilter = {}) =>
  [
    "events",
    {
      floorId: filter.floorId ?? null,
      agentId: filter.agentId ?? null,
      issue: filter.issue ?? null,
      types: [...(filter.types ?? [])].sort(),
    },
  ] as const;

type EventsQueryKey = ReturnType<typeof eventsQueryKey>;

const filterOf = ([, key]: EventsQueryKey): EventFilter => ({
  ...(key.floorId === null ? {} : { floorId: key.floorId }),
  ...(key.agentId === null ? {} : { agentId: key.agentId }),
  ...(key.issue === null ? {} : { issue: key.issue }),
  ...(key.types.length === 0 ? {} : { types: key.types }),
});

/** `events` with `event` in id order, once, keeping the newest `max`. */
function merge(
  events: StreamedEvent[],
  event: StreamedEvent,
  max: number,
): StreamedEvent[] {
  if (events.some(({ id }) => id === event.id)) {
    return events;
  }
  const merged = [...events, event];
  if (merged.length > 1 && (events.at(-1)?.id ?? 0) > event.id) {
    merged.sort((a, b) => a.id - b.id);
  }
  return merged.slice(-max);
}

export type EventStreamStatus = "connecting" | "open" | "reconnecting";

export interface EventStreamOptions {
  /** How many events the cache keeps; 200 by default. */
  readonly maxEvents?: number;
  /** Whether to keep the stream open; true by default. */
  readonly enabled?: boolean;
  /**
   * Where to start when the cache holds no events yet: after this event
   * id, as a page of stored events read first ends with it. Otherwise
   * only events published from now on arrive.
   */
  readonly after?: number;
  /** Called for each new event, to update other queries' caches. */
  readonly onEvent?: (event: StreamedEvent, queryClient: QueryClient) => void;
}

/** The longest wait between reconnection attempts. */
const maxBackoffMs = 30_000;

/**
 * The live events matching `filter`, oldest first, while the component is
 * mounted. When the stream drops, the browser reconnects with
 * `Last-Event-ID`; when the browser gives up (the server refused it, or
 * the session ended), the hook reconnects itself with growing waits,
 * resuming after the last event in the cache, and rechecks the session so
 * the app can send the Owner to the login page.
 */
export function useEventStream(
  filter: EventFilter = {},
  options: EventStreamOptions = {},
): { events: readonly StreamedEvent[]; status: EventStreamStatus } {
  const queryClient = useQueryClient();
  const queryKey = eventsQueryKey(filter);
  // The effect depends on the filter's value, not its identity.
  const keyText = JSON.stringify(queryKey);
  const maxEvents = options.maxEvents ?? 200;
  const enabled = options.enabled ?? true;
  // Read when the stream opens, not a reason to reopen it.
  const after = useRef(options.after);
  useEffect(() => {
    after.current = options.after;
  });
  // The status of the stream for `keyText`; a new filter starts connecting.
  const [state, setState] = useState<{
    readonly keyText: string;
    readonly status: EventStreamStatus;
  }>({ keyText, status: "connecting" });
  const status = state.keyText === keyText ? state.status : "connecting";
  const onEvent = useRef(options.onEvent);
  useEffect(() => {
    onEvent.current = options.onEvent;
  });

  const { data: events = [] } = useQuery({
    queryKey,
    // Filled only by the stream, never fetched.
    queryFn: skipToken,
    initialData: [] as StreamedEvent[],
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const key = JSON.parse(keyText) as EventsQueryKey;
    let source: EventSourceLike | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const setStatus = (status: EventStreamStatus): void => {
      setState({ keyText, status });
    };

    const open = (): void => {
      const lastId =
        queryClient.getQueryData<StreamedEvent[]>(key)?.at(-1)?.id ??
        after.current;
      const current = eventSources.open(eventStreamUrl(filterOf(key), lastId));
      source = current;
      current.onopen = () => {
        failures = 0;
        setStatus("open");
      };
      current.onmessage = (message) => {
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        const parsed = streamedEventSchema.safeParse(data);
        if (!parsed.success) {
          return;
        }
        queryClient.setQueryData<StreamedEvent[]>(key, (old = []) =>
          merge(old, parsed.data, maxEvents),
        );
        onEvent.current?.(parsed.data, queryClient);
      };
      current.onerror = () => {
        setStatus("reconnecting");
        if (current.readyState !== closed) {
          return;
        }
        current.close();
        void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
        failures += 1;
        retry = setTimeout(
          open,
          Math.min(maxBackoffMs, 1000 * 2 ** (failures - 1)),
        );
      };
    };

    open();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [keyText, maxEvents, queryClient, enabled]);

  return { events, status };
}
