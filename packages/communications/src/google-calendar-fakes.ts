import type { ServerResponse } from "node:http";

import { send } from "./publishing-fakes.ts";

// The fake Google's Calendar API, for the Google Calendar Connection's
// contract tests (PRD §9: a contract suite per Connection type against
// local fakes). `serveFakeGoogle` serves it beside its OAuth endpoints and
// its Sheets, Drive, Docs and Slides APIs, once it has checked the access
// token and its `calendar.events` scope. It keeps in memory what Calendar
// keeps: each calendar's events, by an id the caller may choose (base32hex,
// 5 to 1024 characters) and never gives out twice, deleted events
// included; `insert` refuses an id already used (409), `get` and `patch`
// find an event, deleted or not, until it is purged (404), `patch` changes
// only the fields given and never brings a deleted event back, and an
// event may not end before it starts. A write can be carried out with its
// answer lost.

type Json = Record<string, unknown>;

/** An event on the fake Calendar, as the test reads it. */
export interface FakeCalendarEvent {
  readonly id: string;
  /** `confirmed`, or `cancelled` once deleted. */
  readonly status: string;
  readonly summary: string;
  /** Its description, as the HTML it was given. */
  readonly description: string;
  readonly start: string;
  readonly end: string;
  readonly source: { readonly title: string; readonly url: string } | null;
  readonly transparency: string;
  /** How many times it was changed after it was made. */
  readonly sequence: number;
}

interface StoredEvent {
  id: string;
  status: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  source: { title: string; url: string } | null;
  transparency: string;
  sequence: number;
  /** Purged: its id stays taken, but it is gone. */
  purged: boolean;
}

class CalendarError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const eventIdPattern = /^[a-v0-9]{5,1024}$/;

/** An event time's instant, from `{ dateTime }`; refuses anything else. */
function dateTimeOf(value: unknown, field: string): string {
  const dateTime = (value as Json | undefined)?.["dateTime"];
  if (
    typeof dateTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
      dateTime,
    )
  ) {
    throw new CalendarError(400, "required", `Missing ${field} time.`);
  }
  return new Date(dateTime).toISOString();
}

/** The fields an insert or a patch sets, checked as Calendar checks them. */
function fieldsOf(body: Json, whole: boolean): Partial<StoredEvent> {
  const fields: Partial<StoredEvent> = {};
  if (whole || "start" in body) {
    fields.start = dateTimeOf(body["start"], "start");
  }
  if (whole || "end" in body) {
    fields.end = dateTimeOf(body["end"], "end");
  }
  if (typeof body["summary"] === "string") {
    fields.summary = body["summary"];
  }
  if (typeof body["description"] === "string") {
    fields.description = body["description"];
  }
  if (typeof body["transparency"] === "string") {
    fields.transparency = body["transparency"];
  }
  const source = body["source"] as Json | undefined;
  if (source !== undefined) {
    if (typeof source["url"] !== "string" || !/^https?:/.test(source["url"])) {
      throw new CalendarError(400, "invalid", "Invalid source URL.");
    }
    fields.source = {
      title: typeof source["title"] === "string" ? source["title"] : "",
      url: source["url"],
    };
  }
  return fields;
}

const json = (event: StoredEvent): Json => ({
  kind: "calendar#event",
  id: event.id,
  status: event.status,
  summary: event.summary,
  description: event.description,
  start: { dateTime: event.start },
  end: { dateTime: event.end },
  ...(event.source === null ? {} : { source: event.source }),
  transparency: event.transparency,
  sequence: event.sequence,
});

/** A fake Calendar holding the calendars given, each one empty. */
export function fakeCalendar(calendarIds: readonly string[]) {
  const calendars = new Map(
    calendarIds.map((id) => [id, new Map<string, StoredEvent>()]),
  );
  let made = 0;

  const ofCalendar = (calendarId: string): Map<string, StoredEvent> => {
    const found = calendars.get(calendarId);
    if (found === undefined) {
      throw new CalendarError(404, "notFound", "Not Found");
    }
    return found;
  };

  const ofEvent = (
    events: Map<string, StoredEvent>,
    eventId: string,
  ): StoredEvent => {
    const found = events.get(eventId);
    if (found === undefined || found.purged) {
      throw new CalendarError(404, "notFound", "Not Found");
    }
    return found;
  };

  const checked = (event: StoredEvent): StoredEvent => {
    if (Date.parse(event.end) < Date.parse(event.start)) {
      throw new CalendarError(
        400,
        "timeRangeEmpty",
        "The specified time range is empty.",
      );
    }
    return event;
  };

  return {
    /** Whether `pathname` is Calendar's. */
    handles: (pathname: string): boolean =>
      pathname.startsWith("/calendar/v3/calendars/"),

    /** Answers a request to Calendar; `lost` loses a write's answer. */
    handle(
      method: string,
      url: URL,
      raw: string,
      response: ServerResponse,
      lost: () => boolean,
    ): void {
      const done = (body: unknown) => {
        if (method !== "GET" && lost()) {
          send(response, 502, { error: { code: 502, message: "Bad gateway" } });
          return;
        }
        send(response, 200, body);
      };
      try {
        const path =
          /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(
            url.pathname,
          );
        if (path === null) {
          throw new CalendarError(404, "notFound", "Not Found");
        }
        const events = ofCalendar(decodeURIComponent(path[1] ?? ""));
        const eventId =
          path[2] === undefined ? undefined : decodeURIComponent(path[2]);
        if (eventId === undefined && method === "GET") {
          const max = Number(url.searchParams.get("maxResults") ?? "250");
          done({
            kind: "calendar#events",
            items: [...events.values()]
              .filter((event) => event.status !== "cancelled" && !event.purged)
              .slice(0, max)
              .map(json),
          });
          return;
        }
        if (eventId === undefined && method === "POST") {
          const body = JSON.parse(raw) as Json;
          const id =
            typeof body["id"] === "string"
              ? body["id"]
              : `fake${String((made += 1)).padStart(8, "0")}`;
          if (!eventIdPattern.test(id)) {
            throw new CalendarError(
              400,
              "invalid",
              "Invalid resource id value.",
            );
          }
          if (events.has(id)) {
            throw new CalendarError(
              409,
              "duplicate",
              "The requested identifier already exists.",
            );
          }
          const event = checked({
            id,
            status: "confirmed",
            summary: "",
            description: "",
            source: null,
            transparency: "opaque",
            sequence: 0,
            purged: false,
            start: "",
            end: "",
            ...fieldsOf(body, true),
          });
          events.set(id, event);
          done(json(event));
          return;
        }
        if (eventId !== undefined && method === "GET") {
          done(json(ofEvent(events, eventId)));
          return;
        }
        if (eventId !== undefined && method === "PATCH") {
          const found = ofEvent(events, eventId);
          const changed = checked({
            ...found,
            ...fieldsOf(JSON.parse(raw) as Json, false),
            sequence: found.sequence + 1,
          });
          events.set(eventId, changed);
          done(json(changed));
          return;
        }
        throw new CalendarError(404, "notFound", "Not Found");
      } catch (error) {
        if (error instanceof CalendarError) {
          send(response, error.status, {
            error: {
              code: error.status,
              message: error.message,
              errors: [
                {
                  domain: "global",
                  reason: error.reason,
                  message: error.message,
                },
              ],
            },
          });
          return;
        }
        throw error;
      }
    },

    /** A calendar's events, deleted ones too but not purged, oldest first. */
    events: (calendarId: string): FakeCalendarEvent[] =>
      [...(calendars.get(calendarId)?.values() ?? [])]
        .filter((event) => !event.purged)
        .map(
          ({
            id,
            status,
            summary,
            description,
            start,
            end,
            source,
            transparency,
            sequence,
          }) => ({
            id,
            status,
            summary,
            description,
            start,
            end,
            source,
            transparency,
            sequence,
          }),
        ),

    /**
     * The Owner deletes an event in Calendar: it is cancelled, or with
     * `purge` gone, its id taken still.
     */
    deleteEvent: (
      calendarId: string,
      eventId: string,
      options: { readonly purge?: true } = {},
    ): void => {
      const found = calendars.get(calendarId)?.get(eventId);
      if (found !== undefined) {
        found.status = "cancelled";
        found.purged = options.purge === true;
      }
    },
  };
}
