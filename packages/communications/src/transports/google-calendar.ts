import { createHash } from "node:crypto";

import {
  googleCalendarCredentialsSchema,
  type CalendarEntry,
  type GoogleCalendarCredentials,
  type OutboundMessage,
} from "@ai-office/shared";

import { calendarHtml, parseMarkdown } from "../markdown.ts";
import {
  GoogleApiError,
  googleApi,
  type GoogleApiOptions,
  type Json,
} from "./google-api.ts";
import { DeliveryError, type ConnectionTransport } from "./transport.ts";

// Google Calendar (PRD FR-91, FR-92), a publishing destination: an event
// per Batch on the Owner's chosen calendar, through the Owner's Google
// sign-in. It is made when the Batch starts, lasting an hour until it
// finishes, and changed to the Batch's finish when it finishes; its
// description links to the Batch's Plan and, once finished, says its
// outcome. There is only ever one per Batch: its id is AI Office's own,
// made from the Connection and the Batch, so every attempt of either
// delivery names the same event. A start looks for it before making it
// and leaves one already there as it is (a retry after a lost answer, or a
// start retried after the finish arrived). A finish changes it, or makes
// it whole when it was never made (its start given up, or the Connection
// added during the Batch). An event the Owner deleted stays deleted.
// "Send test" only reads the calendar. Nothing Google sends back is acted
// on beyond whether the event is there (FR-95).

/** How long a Batch's event lasts before the Batch finishes: an hour. */
export const inProgressMs = 60 * 60 * 1000;

/**
 * The id of a Batch's event on a Connection's calendar: the same on every
 * attempt of every delivery about that Batch, and never another
 * Connection's, since each Connection's id is random. Calendar takes ids
 * in base32hex (`a` to `v` and digits), which hex is within.
 */
export const calendarEventId = (
  connectionId: string,
  entry: Pick<CalendarEntry, "floorId" | "batchId">,
): string =>
  createHash("sha256")
    .update(`${connectionId}\n${entry.floorId}\n${String(entry.batchId)}`)
    .digest("hex");

const eventsPath = (calendarId: string): string =>
  `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

/**
 * The event `message` makes (`whole`), or changes a Batch's event to. A
 * change that does not know when the Batch started leaves the event's
 * start as it is; an event made without knowing starts at the finish.
 */
function eventOf(
  message: OutboundMessage,
  entry: CalendarEntry,
  whole: boolean,
): Json {
  const start = entry.startedAt ?? entry.finishedAt ?? message.occurredAt;
  const end =
    entry.finishedAt ??
    new Date(new Date(start).getTime() + inProgressMs).toISOString();
  return {
    summary: message.title,
    description: calendarHtml(parseMarkdown(message.document ?? "")),
    ...(whole || entry.startedAt !== null
      ? { start: { dateTime: start } }
      : {}),
    end: { dateTime: end },
    source: { title: "The Plan in AI Office", url: message.aiOfficeUrl },
    // AI Office working does not make the Owner busy.
    transparency: "transparent",
  };
}

export type GoogleCalendarTransportOptions = GoogleApiOptions;

export function googleCalendarTransport(
  options: GoogleCalendarTransportOptions,
): ConnectionTransport<GoogleCalendarCredentials> {
  const api = googleApi("calendar", options);

  /** Calls `api`; false when Google answers `status` instead. */
  const unless = async (
    status: number,
    call: () => Promise<unknown>,
  ): Promise<boolean> => {
    try {
      await call();
      return true;
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === status) {
        return false;
      }
      throw error;
    }
  };

  return {
    credentials: googleCalendarCredentialsSchema,

    describe(credentials) {
      return {
        hint:
          credentials.calendarId === "primary"
            ? "Primary calendar"
            : `Calendar ${credentials.calendarId.slice(0, 12)}…`,
        settings: { calendarId: credentials.calendarId },
      };
    },

    // The calendar is not secret; the tokens are the sign-in's.
    secrets: () => [],

    details(settings) {
      return [`On calendar ${String(settings["calendarId"])}`];
    },

    async send(delivery, { credentials }) {
      const { message } = delivery;
      const events = eventsPath(credentials.calendarId);
      if (delivery.test) {
        await api.call("calendar", "GET", `${events}?maxResults=1`);
        return;
      }
      const entry = message.calendar;
      if (
        (message.kind !== "batch_started" &&
          message.kind !== "batch_finished") ||
        entry === undefined
      ) {
        throw new DeliveryError(
          "A Google Calendar Connection puts Batches on the calendar only.",
        );
      }
      const id = calendarEventId(delivery.connectionId, entry);
      const at = `${events}/${id}`;
      // False when an event has that id already.
      const make = () =>
        unless(409, () =>
          api.call("calendar", "POST", events, {
            json: { id, ...eventOf(message, entry, true) },
          }),
        );
      // False when there is no event by that id to change.
      const change = () =>
        unless(404, () =>
          api.call("calendar", "PATCH", at, {
            json: eventOf(message, entry, false),
          }),
        );

      if (message.kind === "batch_started") {
        // An event there already, even one the Owner deleted, stands.
        if (await unless(404, () => api.call("calendar", "GET", at))) {
          return;
        }
        await make();
        return;
      }
      if ((await change()) || (await make())) {
        return;
      }
      // Made since it was not there to change: changed now. Still not
      // there, its id is a deleted event's, which stays deleted.
      await change();
    },
  };
}
