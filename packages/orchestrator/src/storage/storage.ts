import {
  aiAccountUsage,
  connectionDeliveries,
  deleteConnectionDeliveriesBefore,
  deleteEventsBefore,
  deleteGatewayRequestsBefore,
  events,
  gatewayRequestBodies,
  gatewayRequests,
  signInEvents,
  type Database,
} from "@ai-office/db";
import {
  storageCategories,
  type StorageCategory,
  type StorageCategoryUsage,
  type StorageUsage,
} from "@ai-office/shared";
import { count, eq, lt, min, sql } from "drizzle-orm";

// Storage (PRD §7, FR-65): how much of the database each kind of history
// takes, and deleting what is older than a time, so the Owner can free
// space from Admin. Each kind goes as the retention jobs delete it
// (`@ai-office/db`'s deletes): the event log, append-only otherwise, lets
// through a delete of events before the cutoff its transaction names
// (migration 0044), and what deleted requests used is kept a day at a time
// for Token Caps and Analytics. Postgres reuses the space deleted rows leave; autovacuum returns it.

export interface StorageStore {
  usage(): Promise<StorageUsage>;
  /** Deletes the category's rows from before `before`; how many went. */
  prune(category: StorageCategory, before: Date): Promise<number>;
}

/** Nothing is kept: for tests. */
export function memoryStorageStore(): StorageStore {
  return {
    usage: () =>
      Promise.resolve({
        categories: storageCategories.map((category) => ({
          category,
          rows: 0,
          bytes: null,
          oldest: null,
        })),
        databaseBytes: null,
      }),
    prune: () => Promise.resolve(0),
  };
}

/** Each category's table, as Postgres names it. */
const tables: Record<StorageCategory, string> = {
  activity: "events",
  request_bodies: "gateway_request_bodies",
  requests: "gateway_requests",
  usage_history: "ai_account_usage",
  sign_ins: "sign_in_events",
  connection_deliveries: "connection_deliveries",
};

const bytesOf = async (db: Database, table: string): Promise<number> => {
  const result = await db.execute<{ bytes: string | number }>(
    sql`SELECT pg_total_relation_size(${table}::regclass) AS bytes`,
  );
  return Number(result.rows[0]?.bytes ?? 0);
};

/** The rows and the oldest time of each category. */
const countsOf = async (
  db: Database,
  category: StorageCategory,
): Promise<{ rows: number; oldest: Date | null }> => {
  const [row] = await (() => {
    switch (category) {
      case "activity":
        return db
          .select({ rows: count(), oldest: min(events.occurredAt) })
          .from(events);
      case "request_bodies":
        return db
          .select({ rows: count(), oldest: min(gatewayRequests.startedAt) })
          .from(gatewayRequestBodies)
          .innerJoin(
            gatewayRequests,
            eq(gatewayRequestBodies.requestId, gatewayRequests.id),
          );
      case "requests":
        return db
          .select({ rows: count(), oldest: min(gatewayRequests.startedAt) })
          .from(gatewayRequests);
      case "usage_history":
        return db
          .select({ rows: count(), oldest: min(aiAccountUsage.observedAt) })
          .from(aiAccountUsage);
      case "sign_ins":
        return db
          .select({ rows: count(), oldest: min(signInEvents.occurredAt) })
          .from(signInEvents);
      case "connection_deliveries":
        return db
          .select({
            rows: count(),
            oldest: min(connectionDeliveries.createdAt),
          })
          .from(connectionDeliveries);
    }
  })();
  return { rows: row?.rows ?? 0, oldest: row?.oldest ?? null };
};

export function databaseStorageStore(db: Database): StorageStore {
  return {
    async usage() {
      const categories: StorageCategoryUsage[] = [];
      for (const category of storageCategories) {
        const { rows, oldest } = await countsOf(db, category);
        categories.push({
          category,
          rows,
          bytes: await bytesOf(db, tables[category]),
          oldest: oldest?.toISOString() ?? null,
        });
      }
      const database = await db.execute<{ bytes: string | number }>(
        sql`SELECT pg_database_size(current_database()) AS bytes`,
      );
      return {
        categories,
        databaseBytes: Number(database.rows[0]?.bytes ?? 0),
      };
    },

    async prune(category, before) {
      switch (category) {
        case "activity":
          return deleteEventsBefore(db, before);
        case "request_bodies": {
          const deleted = await db.execute(
            sql`DELETE FROM ${gatewayRequestBodies} USING ${gatewayRequests}
              WHERE ${gatewayRequestBodies.requestId} = ${gatewayRequests.id}
              AND ${gatewayRequests.startedAt} < ${before}`,
          );
          return deleted.rowCount ?? 0;
        }
        case "requests":
          // Their bodies go with them; what they used stays, by the day.
          return deleteGatewayRequestsBefore(db, before);
        case "usage_history": {
          const deleted = await db
            .delete(aiAccountUsage)
            .where(lt(aiAccountUsage.observedAt, before));
          return deleted.rowCount ?? 0;
        }
        case "sign_ins": {
          const deleted = await db
            .delete(signInEvents)
            .where(lt(signInEvents.occurredAt, before));
          return deleted.rowCount ?? 0;
        }
        case "connection_deliveries":
          // Those still waiting to go are the outbound queue, and stay.
          return deleteConnectionDeliveriesBefore(db, before);
      }
    },
  };
}
