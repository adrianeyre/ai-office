import {
  aiAccounts,
  aiAccountUsage,
  connectionDeliveries,
  connections,
  events,
  gatewayRequestBodies,
  gatewayRequests,
  gatewayUsageDays,
  signInEvents,
} from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import { sql } from "drizzle-orm";
import { describe, expect } from "vitest";

import { databaseStorageStore } from "./storage.ts";

// Storage (PRD §7): each kind of history's size, and deleting what is
// older than a time, in Postgres 18. The event log stays append-only to
// everything but the clean-up.

const old = new Date("2026-01-01T00:00:00.000Z");
const recent = new Date("2026-10-09T12:00:00.000Z");
const cutoff = new Date("2026-06-01T00:00:00.000Z");

describe("storage, in Postgres 18", () => {
  postgresTest(
    "tells each kind's rows, size and oldest, and deletes only what is older",
    async ({ database }) => {
      const { db } = database;
      await db.insert(events).values(
        [old, recent].map((occurredAt) => ({
          occurredAt,
          type: "floor.created",
          version: 1,
          payload: {},
        })),
      );
      const requests = await db
        .insert(gatewayRequests)
        .values(
          [old, recent].map((startedAt) => ({
            startedAt,
            endpoint: "messages",
            streamed: false,
            status: 200,
            latencyMs: 10,
            agentId: "ada",
            inputTokens: 1_000,
            outputTokens: 200,
          })),
        )
        .returning({ id: gatewayRequests.id });
      await db.insert(gatewayRequestBodies).values(
        requests.map(({ id }) => ({
          requestId: id,
          requestBody: "aio1:request",
          responseBody: "aio1:response",
        })),
      );
      await db.insert(aiAccounts).values({
        id: "account",
        name: "Work",
        accountType: "api_key",
        aiProvider: "Claude",
        credential: "aio1:1:a:b:c",
        priority: 1,
        createdAt: old,
        updatedAt: old,
      });
      await db.insert(aiAccountUsage).values(
        [old, recent].map((observedAt) => ({
          aiAccountId: "account",
          window: "five_hour",
          utilization: 10,
          resetsAt: observedAt,
          observedAt,
        })),
      );
      await db.insert(signInEvents).values(
        [old, recent].map((occurredAt) => ({
          occurredAt,
          outcome: "succeeded",
          ip: "127.0.0.1",
        })),
      );
      await db.insert(connections).values({
        id: "slack",
        name: "Team Slack",
        type: "slack",
        rules: {},
        credentials: "aio1:sealed",
        hint: "…/T0001",
        createdAt: old,
      });
      const deliveryOf = (eventId: number, createdAt: Date) => ({
        id: `delivery-${String(eventId)}`,
        connectionId: "slack",
        eventId,
        message: {},
        status: "delivered",
        attempts: 1,
        createdAt,
        deliveredAt: createdAt,
      });
      await db
        .insert(connectionDeliveries)
        .values([deliveryOf(1, old), deliveryOf(2, recent)]);
      const storage = databaseStorageStore(db);

      const usage = await storage.usage();
      expect(usage.databaseBytes).toBeGreaterThan(0);
      for (const category of usage.categories) {
        expect(category).toMatchObject({
          rows: 2,
          oldest: old.toISOString(),
        });
        expect(category.bytes).toBeGreaterThan(0);
      }

      expect(await storage.prune("activity", cutoff)).toBe(1);
      expect(await storage.prune("request_bodies", cutoff)).toBe(1);
      expect(await storage.prune("usage_history", cutoff)).toBe(1);
      expect(await storage.prune("sign_ins", cutoff)).toBe(1);
      expect(await storage.prune("connection_deliveries", cutoff)).toBe(1);
      // The request whose body went stays, until its own turn.
      expect(
        (await storage.usage()).categories.find(
          ({ category }) => category === "requests",
        )?.rows,
      ).toBe(2);
      expect(await storage.prune("requests", cutoff)).toBe(1);
      // What the deleted request used stays, by its day, for Token Caps
      // and Analytics, as when retention deletes it.
      expect(
        await db
          .select({
            day: gatewayUsageDays.day,
            agentId: gatewayUsageDays.agentId,
            requests: gatewayUsageDays.requests,
            inputTokens: gatewayUsageDays.inputTokens,
            outputTokens: gatewayUsageDays.outputTokens,
          })
          .from(gatewayUsageDays),
      ).toEqual([
        {
          day: old,
          agentId: "ada",
          requests: 1,
          inputTokens: 1_000,
          outputTokens: 200,
        },
      ]);
      for (const category of (await storage.usage()).categories) {
        expect(category).toMatchObject({
          rows: 1,
          oldest: recent.toISOString(),
        });
      }
      // Deleting everything: bodies go with their requests.
      expect(await storage.prune("requests", new Date("2027-01-01"))).toBe(1);
      expect(await db.select().from(gatewayRequestBodies)).toEqual([]);
      // A delivery still waiting to go is the outbound queue, and stays.
      await db.insert(connectionDeliveries).values({
        ...deliveryOf(3, old),
        status: "pending",
        attempts: 0,
        nextAttemptAt: recent,
        deliveredAt: null,
      });
      expect(
        await storage.prune("connection_deliveries", new Date("2027-01-01")),
      ).toBe(1);
      expect(
        (await db.select().from(connectionDeliveries)).map(({ id }) => id),
      ).toEqual(["delivery-3"]);

      // Outside the clean-up, the event log is still append-only, and the
      // flag migration 0043 let through no longer opens it: the clean-up
      // names its cutoff, as retention does.
      await expect(db.delete(events)).rejects.toThrow();
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ai_office.events_pruning = 'on'`);
          await tx.delete(events);
        }),
      ).rejects.toThrow();
      await expect(
        db.update(events).set({ type: "floor.archived" }),
      ).rejects.toThrow();
      await expect(db.execute(sql`TRUNCATE events`)).rejects.toThrow();
      expect(await db.select().from(events)).toHaveLength(1);
    },
  );
});
