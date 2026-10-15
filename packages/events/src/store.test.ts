import { events } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import { createRedactor, redactedText } from "@ai-office/shared";
import { asc, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createEventBus } from "./bus.ts";
import type { OfficeEvent, StoredEvent } from "./schema.ts";
import {
  databaseEventStore,
  memoryEventStore,
  type EventStore,
} from "./store.ts";
import { checkHistory, exampleEvents } from "./test-support.ts";

const start = new Date("2026-10-08T12:00:00.000Z");

describe("the event bus against Postgres 18", () => {
  postgresTest(
    "reads the log back newest first, a page at a time (the Activity Feed)",
    async ({ database }) => {
      let tick = 0;
      await checkHistory(
        createEventBus({
          store: databaseEventStore(database.db),
          now: () => new Date(start.getTime() + 1000 * tick++),
        }),
      );
    },
  );

  postgresTest(
    "stores published events in order and delivers them to subscribers",
    async ({ database }) => {
      let tick = 0;
      const bus = createEventBus({
        store: databaseEventStore(database.db),
        now: () => new Date(start.getTime() + 1000 * tick++),
      });
      const received: StoredEvent[] = [];
      bus.subscribe((stored) => {
        received.push(stored);
      });

      const published = Object.values<OfficeEvent>(exampleEvents);
      // All at once: the bus still stores them one after another.
      const results = await Promise.all(
        published.map((event) => bus.publish(event)),
      );

      const rows = await database.db
        .select()
        .from(events)
        .orderBy(asc(events.id));
      expect(rows.map(({ id }) => id)).toEqual(
        published.map((_, index) => index + 1),
      );
      expect(rows.map(({ payload }) => payload)).toEqual(published);
      expect(rows.map(({ type, version }) => [type, version])).toEqual(
        published.map(({ type }) => [type, 1]),
      );
      expect(rows[0]?.occurredAt).toEqual(start);
      const handoffRow = rows.find(({ type }) => type === "handoff");
      expect(handoffRow).toMatchObject({
        floorId: "web-shop",
        agentIds: ["ada", "grace"],
        issue: 4,
      });

      expect(received).toEqual(results);
      expect(received.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
      expect(received.map(({ event }) => event)).toEqual(published);
    },
  );

  postgresTest(
    "redacts a secret placed in a payload in the stored row",
    async ({ database }) => {
      const githubToken = "ghs_abcdefghijklmnopqrstuvwxyz0123456789AB";
      const registered = "the-encryption-key-in-a-message";
      const bus = createEventBus({
        store: databaseEventStore(database.db),
        redactor: createRedactor({ secrets: [registered] }),
      });
      await bus.publish({
        type: "agent.status_changed",
        version: 1,
        floorId: "web-shop",
        agentId: "ada",
        status: "errored",
        reason: `clone with ${githubToken} failed; key ${registered}`,
      });

      const rows = await database.db.execute<{ payload: string }>(
        sql`SELECT payload::text AS payload FROM events`,
      );
      const [row] = rows.rows;
      expect(row?.payload).not.toContain(githubToken);
      expect(row?.payload).not.toContain(registered);
      expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
        reason: `clone with ${redactedText} failed; key ${redactedText}`,
      });
    },
  );

  postgresTest(
    "reads back the events after an id, by Floor, Agent, issue and type",
    async ({ database }) => {
      const bus = createEventBus({ store: databaseEventStore(database.db) });
      for (const event of [
        exampleEvents["floor.created"], // 1: web-shop
        exampleEvents.handoff, // 2: web-shop, ada and grace, #4
        exampleEvents["sign_in.failed"], // 3: no Floor
        { ...exampleEvents["issue.assigned"], floorId: "blog" }, // 4: blog #4
        exampleEvents["issue.assigned"], // 5: web-shop, ada, #4
      ] as OfficeEvent[]) {
        await bus.publish(event);
      }
      const ids = async (...args: Parameters<typeof bus.eventsAfter>) =>
        (await bus.eventsAfter(...args)).map(({ id }) => id);

      expect(await ids(0)).toEqual([1, 2, 3, 4, 5]);
      expect(await ids(2)).toEqual([3, 4, 5]);
      expect(await ids(0, {}, 2)).toEqual([1, 2]);
      expect(await ids(0, { floorId: "web-shop" })).toEqual([1, 2, 5]);
      expect(await ids(0, { agentId: "grace" })).toEqual([2]);
      expect(await ids(0, { floorId: "web-shop", issue: 4 })).toEqual([2, 5]);
      expect(await ids(0, { types: ["sign_in.failed", "handoff"] })).toEqual([
        2, 3,
      ]);
      const [stored] = await bus.eventsAfter(1, {}, 1);
      expect(stored?.event).toEqual(exampleEvents.handoff);
    },
  );

  postgresTest("is append-only", async ({ database }) => {
    const bus = createEventBus({ store: databaseEventStore(database.db) });
    await bus.publish(exampleEvents["floor.created"]);
    await expect(
      database.db.update(events).set({ type: "floor.archived" }),
    ).rejects.toThrow();
    await expect(database.db.delete(events)).rejects.toThrow();
    await expect(database.db.execute(sql`TRUNCATE events`)).rejects.toThrow();
    expect(await database.db.select().from(events)).toHaveLength(1);
  });
});

// Retention (PRD §7): events that occurred before a cutoff are deleted, and
// nothing else; the rest of the log reads back as before, and new events
// carry on from the last id.
async function checkRetention(store: EventStore): Promise<void> {
  let now = new Date("2025-10-01T00:00:00.000Z");
  const bus = createEventBus({ store, now: () => now });
  await bus.publish(exampleEvents["floor.created"]);
  now = new Date("2025-11-01T00:00:00.000Z");
  await bus.publish(exampleEvents.handoff);
  now = new Date("2026-10-08T00:00:00.000Z");
  await bus.publish(exampleEvents["issue.assigned"]);

  expect(await store.deleteBefore(new Date("2025-11-01T00:00:00.000Z"))).toBe(
    1,
  );
  expect((await bus.eventsAfter(0)).map(({ id }) => id)).toEqual([2, 3]);
  expect(await store.deleteBefore(new Date("2025-11-01T00:00:00.000Z"))).toBe(
    0,
  );
  expect((await bus.history({})).map(({ id }) => id)).toEqual([3, 2]);
  const next = await bus.publish(exampleEvents["sign_in.failed"]);
  expect(next.id).toBe(4);
}

describe("retention of events kept in memory", () => {
  it("deletes the events before a cutoff, and only those", () =>
    checkRetention(memoryEventStore()));
});

describe("retention of events in Postgres 18", () => {
  postgresTest(
    "deletes the events before a cutoff, and only those",
    async ({ database }) => {
      await checkRetention(databaseEventStore(database.db));
    },
  );

  postgresTest(
    "is still append-only outside retention",
    async ({ database }) => {
      const store = databaseEventStore(database.db);
      let now = new Date("2025-01-01T00:00:00.000Z");
      const bus = createEventBus({ store, now: () => now });
      await bus.publish(exampleEvents["floor.created"]);
      now = new Date("2026-10-08T00:00:00.000Z");
      await bus.publish(exampleEvents.handoff);
      // Retention deletes only what is before its own cutoff.
      expect(
        await store.deleteBefore(new Date("2026-01-01T00:00:00.000Z")),
      ).toBe(1);
      // The cutoff lasted for its transaction alone.
      await expect(database.db.delete(events)).rejects.toThrow();
      // A transaction naming a cutoff still cannot delete a later event,
      // nor change one.
      await expect(
        database.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('ai_office.events_retention_cutoff', '2026-01-01T00:00:00.000Z', true)`,
          );
          await tx.delete(events);
        }),
      ).rejects.toThrow();
      await expect(
        database.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('ai_office.events_retention_cutoff', '2027-01-01T00:00:00.000Z', true)`,
          );
          await tx.update(events).set({ type: "floor.archived" });
        }),
      ).rejects.toThrow();
      await expect(database.db.execute(sql`TRUNCATE events`)).rejects.toThrow();
      expect(await database.db.select().from(events)).toHaveLength(1);
    },
  );
});
