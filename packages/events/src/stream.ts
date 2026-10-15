import { z } from "zod";

import {
  eventTypes,
  officeEventSchema,
  type EventFilter,
  type EventType,
} from "./schema.ts";

// The live event stream (PRD §8: SSE with resume via `Last-Event-ID`):
// its address, its query and the shape of each event on the wire. The
// server and the web app share these. Zod only, so the browser can use it.

export const eventStreamPath = "/api/events/stream";

/**
 * The stream's query: a filter, and where to resume. `type` is a
 * comma-separated list. `lastEventId` stands in for the `Last-Event-ID`
 * header, which a browser's EventSource sends only when it reconnects by
 * itself; the header wins when both are given.
 */
export const eventStreamQuerySchema = z.strictObject({
  floorId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  issue: z.coerce.number().int().positive().optional(),
  type: z
    .string()
    .transform((value) => value.split(",").filter((type) => type !== ""))
    .pipe(z.array(z.enum(eventTypes as [EventType, ...EventType[]])))
    .optional(),
  lastEventId: z.coerce.number().int().min(0).optional(),
});

/** `Last-Event-ID`: the id of the last event the client received. */
export const lastEventIdSchema = z
  .string()
  .regex(/^\d+$/, { error: "Last-Event-ID must be an event id." })
  .transform(Number);

/** An event as the stream sends it, in each message's `data`. */
export const streamedEventSchema = z.strictObject({
  id: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  event: officeEventSchema,
});
export type StreamedEvent = z.infer<typeof streamedEventSchema>;

/** The stream's URL for `filter`, resuming after `lastEventId` if given. */
export function eventStreamUrl(
  filter: EventFilter = {},
  lastEventId?: number,
): string {
  const params = new URLSearchParams();
  if (filter.floorId !== undefined) {
    params.set("floorId", filter.floorId);
  }
  if (filter.agentId !== undefined) {
    params.set("agentId", filter.agentId);
  }
  if (filter.issue !== undefined) {
    params.set("issue", String(filter.issue));
  }
  if (filter.types !== undefined && filter.types.length > 0) {
    params.set("type", filter.types.join(","));
  }
  if (lastEventId !== undefined) {
    params.set("lastEventId", String(lastEventId));
  }
  const query = params.toString();
  return query === "" ? eventStreamPath : `${eventStreamPath}?${query}`;
}

// The shared stream: many of the stream's filters, each resuming after its
// own last event, over one connection. A browser opens at most six
// connections to a server over HTTP/1.1, and every open stream holds one,
// so a page that opened one stream per filter could leave none for its own
// requests (a chat's message, say), which would then wait for ever.

export const eventStreamsPath = "/api/events/streams";

/** The most filters one shared stream carries. */
export const maxSharedStreams = 32;

/**
 * The shared stream's query: each `stream` is one stream's query, as
 * `eventStreamUrl` writes it after its `?`.
 */
export const eventStreamsQuerySchema = z.strictObject({
  stream: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(
      z
        .array(
          z
            .string()
            .transform((query): Record<string, unknown> =>
              Object.fromEntries(new URLSearchParams(query)),
            )
            .pipe(eventStreamQuerySchema),
        )
        .min(1)
        .max(maxSharedStreams),
    ),
});

/** One stream's query on the shared stream: its filter, resuming after `lastEventId`. */
export const sharedStreamQuery = (
  filter: EventFilter = {},
  lastEventId?: number,
): string => eventStreamUrl(filter, lastEventId).split("?")[1] ?? "";

/** The shared stream's URL for `streams`, each one stream's query. */
export const eventStreamsUrl = (streams: readonly string[]): string =>
  `${eventStreamsPath}?${streams
    .map((query) => `stream=${encodeURIComponent(query)}`)
    .join("&")}`;

/** An event on the shared stream: which of its streams it is for. */
export const sharedStreamEventSchema = z.strictObject({
  stream: z.number().int().min(0),
  event: streamedEventSchema,
});
export type SharedStreamEvent = z.infer<typeof sharedStreamEventSchema>;

// The event history (the Activity Feed, PRD FR-52): the stored events,
// newest first, a page at a time, with the stream's filters and a time
// range.

export const eventHistoryPath = "/api/events";

/** How many events a page holds unless asked otherwise, and at most. */
export const eventHistoryPageSize = 50;
export const maxEventHistoryPageSize = 200;

/** The history's query: the stream's filters, a time range and a page. */
export const eventHistoryQuerySchema = eventStreamQuerySchema
  .omit({ lastEventId: true })
  .extend({
    /** Only events at or after this time. */
    from: z.iso.datetime({ offset: true }).optional(),
    /** Only events before this time. */
    to: z.iso.datetime({ offset: true }).optional(),
    /** The page after one ending with this event id. */
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(maxEventHistoryPageSize)
      .default(eventHistoryPageSize),
  });

/** A page of the history, and where the next (older) one starts. */
export const eventHistoryResponseSchema = z.strictObject({
  events: z.array(streamedEventSchema),
  /** Pass as `before` for the next page; null when this was the last. */
  nextBefore: z.number().int().positive().nullable(),
});
export type EventHistoryResponse = z.infer<typeof eventHistoryResponseSchema>;

/** A time range for the history; either end may be open. */
export interface EventTimeRange {
  /** ISO 8601. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/**
 * The history's URL for `filter` and `range`, before event `before`, with
 * pages of `limit` events (`eventHistoryPageSize` when absent).
 */
export function eventHistoryUrl(
  filter: EventFilter = {},
  range: EventTimeRange = {},
  before?: number,
  limit?: number,
): string {
  const params = new URLSearchParams(
    eventStreamUrl(filter).split("?")[1] ?? "",
  );
  if (range.from !== undefined) {
    params.set("from", range.from);
  }
  if (range.to !== undefined) {
    params.set("to", range.to);
  }
  if (before !== undefined) {
    params.set("before", String(before));
  }
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  const query = params.toString();
  return query === "" ? eventHistoryPath : `${eventHistoryPath}?${query}`;
}
