import { deleteEventsBefore, events, type Database } from "@ai-office/db";
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
} from "drizzle-orm";

import {
  matchesFilter,
  officeEventSchema,
  subjectOf,
  type EventFilter,
  type OfficeEvent,
  type StoredEvent,
} from "./schema.ts";

/** A page of the event log, read newest first (the Activity Feed). */
export interface EventHistoryQuery {
  readonly filter?: EventFilter | undefined;
  /** Only events with an id before this: the page after one already read. */
  readonly beforeId?: number | undefined;
  /** Only events that occurred at or after this. */
  readonly from?: Date | undefined;
  /** Only events that occurred before this. */
  readonly to?: Date | undefined;
  /** How many at most; `defaultReadLimit` when absent. */
  readonly limit?: number | undefined;
}

/** Where the bus keeps the event log. */
export interface EventStore {
  /** Appends a (redacted) event; resolves with its id. */
  append(event: OfficeEvent, occurredAt: Date): Promise<number>;
  /** Stored events with an id after `afterId`, oldest first. */
  after(
    afterId: number,
    filter?: EventFilter,
    limit?: number,
  ): Promise<StoredEvent[]>;
  /** Stored events matching `query`, newest first. */
  history(query: EventHistoryQuery): Promise<StoredEvent[]>;
  /**
   * Deletes the events that occurred before `before`: retention (PRD §7),
   * the one exception to the log being append-only. Resolves with how many
   * went.
   */
  deleteBefore(before: Date): Promise<number>;
}

/** How many events one read returns, at most. */
export const defaultReadLimit = 500;

/** The conditions on the `events` table that `filter` makes. */
function filterConditions(filter: EventFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.floorId !== undefined) {
    conditions.push(eq(events.floorId, filter.floorId));
  }
  if (filter.agentId !== undefined) {
    conditions.push(arrayContains(events.agentIds, [filter.agentId]));
  }
  if (filter.issue !== undefined) {
    conditions.push(eq(events.issue, filter.issue));
  }
  if (filter.types !== undefined && filter.types.length > 0) {
    conditions.push(inArray(events.type, [...filter.types]));
  }
  return conditions;
}

const columns = {
  id: events.id,
  occurredAt: events.occurredAt,
  payload: events.payload,
};

const toStored = (row: {
  id: number;
  occurredAt: Date;
  payload: unknown;
}): StoredEvent => ({
  id: row.id,
  occurredAt: row.occurredAt,
  event: officeEventSchema.parse(row.payload),
});

/** Keeps the event log in the `events` table. */
export function databaseEventStore(db: Database): EventStore {
  return {
    async append(event, occurredAt) {
      const subject = subjectOf(event);
      const [row] = await db
        .insert(events)
        .values({
          occurredAt,
          type: event.type,
          version: event.version,
          floorId: subject.floorId,
          agentIds: [...subject.agentIds],
          issue: subject.issue,
          payload: event,
        })
        .returning({ id: events.id });
      if (row === undefined) {
        throw new Error("Storing an event returned no id.");
      }
      return row.id;
    },

    async after(afterId, filter = {}, limit = defaultReadLimit) {
      const rows = await db
        .select(columns)
        .from(events)
        .where(and(gt(events.id, afterId), ...filterConditions(filter)))
        .orderBy(asc(events.id))
        .limit(limit);
      return rows.map(toStored);
    },

    async history({ filter = {}, beforeId, from, to, limit }) {
      const conditions = filterConditions(filter);
      if (beforeId !== undefined) {
        conditions.push(lt(events.id, beforeId));
      }
      if (from !== undefined) {
        conditions.push(gte(events.occurredAt, from));
      }
      if (to !== undefined) {
        conditions.push(lt(events.occurredAt, to));
      }
      const rows = await db
        .select(columns)
        .from(events)
        .where(and(...conditions))
        .orderBy(desc(events.id))
        .limit(limit ?? defaultReadLimit);
      return rows.map(toStored);
    },

    // The table's trigger refuses deletes, except of events before the
    // cutoff the deleting transaction names (packages/db/src/schema-extras.sql).
    deleteBefore: (before) => deleteEventsBefore(db, before),
  };
}

/** Keeps the event log in memory, for tests. */
export function memoryEventStore(): EventStore & {
  readonly events: StoredEvent[];
} {
  const stored: StoredEvent[] = [];
  let lastId = 0;
  return {
    events: stored,
    append(event, occurredAt) {
      lastId += 1;
      const id = lastId;
      // A copy, as a database would hold: later changes to `event` are not
      // seen.
      stored.push({ id, occurredAt, event: structuredClone(event) });
      return Promise.resolve(id);
    },
    after(afterId, filter = {}, limit = defaultReadLimit) {
      return Promise.resolve(
        stored
          .filter(
            ({ id, event }) => id > afterId && matchesFilter(event, filter),
          )
          .slice(0, limit),
      );
    },
    history({ filter = {}, beforeId, from, to, limit }) {
      return Promise.resolve(
        stored
          .filter(
            ({ id, occurredAt, event }) =>
              (beforeId === undefined || id < beforeId) &&
              (from === undefined || occurredAt >= from) &&
              (to === undefined || occurredAt < to) &&
              matchesFilter(event, filter),
          )
          .reverse()
          .slice(0, limit ?? defaultReadLimit),
      );
    },
    deleteBefore(before) {
      const kept = stored.filter(({ occurredAt }) => occurredAt >= before);
      const deleted = stored.length - kept.length;
      stored.splice(0, stored.length, ...kept);
      return Promise.resolve(deleted);
    },
  };
}
