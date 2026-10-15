import { and, isNull, lt, ne, sql } from "drizzle-orm";

import type { Database } from "./client.ts";
import {
  connectionDeliveries,
  events,
  gatewayRequests,
  gatewayUsageDays,
  managerChatAttachments,
} from "./schema.ts";

// Deleting old history (PRD §7): the deletes that need more than a plain
// DELETE, shared by the retention jobs and Admin's Storage clean-up so
// both go through the same door.

/**
 * Deletes the events that occurred before `before`; resolves with how many
 * went. The event log's trigger refuses every other change (src/schema-extras.sql): it lets a delete through only of events before the cutoff the
 * deleting transaction names, for that transaction alone.
 */
export async function deleteEventsBefore(
  db: Database,
  before: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('ai_office.events_retention_cutoff', ${before.toISOString()}, true)`,
    );
    const deleted = await tx
      .delete(events)
      .where(lt(events.occurredAt, before));
    return deleted.rowCount ?? 0;
  });
}

/**
 * Deletes the Gateway requests started before `before`, and their bodies;
 * resolves with how many requests went. What they used is added to its
 * UTC day's totals for its AI Account, Model and caller in
 * `gateway_usage_days` in the same statement, so Token Caps and Analytics
 * count it as before, and nothing is counted twice or lost.
 */
export async function deleteGatewayRequestsBefore(
  db: Database,
  before: Date,
): Promise<number> {
  // The requests go (their bodies with them, by the foreign key) as what
  // they used is added to their days' totals.
  const result = await db.execute<{ deleted: string }>(sql`
    WITH expired AS (
      DELETE FROM ${gatewayRequests}
      WHERE ${gatewayRequests.startedAt} < ${before.toISOString()}::timestamptz
      RETURNING "started_at", "account", "model", "floor_id", "agent_id",
        "issue", "owner_tool", "status", "input_tokens", "output_tokens",
        "cache_read_input_tokens", "cache_creation_input_tokens",
        "estimated_cost_usd", "latency_ms", "keep_alive"
    ), rolled_up AS (
      INSERT INTO ${gatewayUsageDays} AS "days" ("day", "account", "model",
        "floor_id", "agent_id", "issue", "owner_tool", "requests", "errors",
        "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "estimated_cost_usd", "latency_ms",
        "keep_alive_requests", "keep_alive_cost_usd")
      SELECT date_trunc('day', "started_at", 'UTC'), "account", "model",
        "floor_id", "agent_id", "issue", "owner_tool", count(*),
        count(*) FILTER (WHERE "status" >= 400),
        coalesce(sum("input_tokens"), 0),
        coalesce(sum("output_tokens"), 0),
        coalesce(sum("cache_read_input_tokens"), 0),
        coalesce(sum("cache_creation_input_tokens"), 0),
        coalesce(sum("estimated_cost_usd"), 0),
        coalesce(sum("latency_ms"), 0),
        count(*) FILTER (WHERE "keep_alive"),
        coalesce(sum("estimated_cost_usd") FILTER (WHERE "keep_alive"), 0)
      FROM expired
      GROUP BY 1, 2, 3, 4, 5, 6, 7
      ON CONFLICT ON CONSTRAINT "gateway_usage_days_caller" DO UPDATE SET
        "requests" = "days"."requests" + excluded."requests",
        "errors" = "days"."errors" + excluded."errors",
        "input_tokens" = "days"."input_tokens" + excluded."input_tokens",
        "output_tokens" = "days"."output_tokens" + excluded."output_tokens",
        "cache_read_tokens" = "days"."cache_read_tokens" + excluded."cache_read_tokens",
        "cache_write_tokens" = "days"."cache_write_tokens" + excluded."cache_write_tokens",
        "estimated_cost_usd" = "days"."estimated_cost_usd" + excluded."estimated_cost_usd",
        "latency_ms" = "days"."latency_ms" + excluded."latency_ms",
        "keep_alive_requests" = "days"."keep_alive_requests" + excluded."keep_alive_requests",
        "keep_alive_cost_usd" = "days"."keep_alive_cost_usd" + excluded."keep_alive_cost_usd"
      RETURNING 1
    )
    SELECT count(*) AS "deleted" FROM expired
  `);
  return Number(result.rows[0]?.deleted ?? 0);
}

/**
 * Deletes Connections' deliveries made before `before` that are finished
 * (delivered, failed or summarised in a Digest); resolves with how many
 * went. A pending one, retrying or held for quiet hours, is the outbound
 * queue (FR-94) rather than its log, and stays however old.
 */
export async function deleteConnectionDeliveriesBefore(
  db: Database,
  before: Date,
): Promise<number> {
  const deleted = await db
    .delete(connectionDeliveries)
    .where(
      and(
        lt(connectionDeliveries.createdAt, before),
        ne(connectionDeliveries.status, "pending"),
      ),
    );
  return deleted.rowCount ?? 0;
}

/**
 * Deletes the Manager chat attachments uploaded before `before` that no
 * message sent (PRD FR-24): the Owner attached them and never sent them.
 * Resolves with how many went. A sent one stays with its message, and goes
 * with it.
 */
export async function deleteUnsentChatAttachmentsBefore(
  db: Database,
  before: Date,
): Promise<number> {
  const deleted = await db
    .delete(managerChatAttachments)
    .where(
      and(
        isNull(managerChatAttachments.messageId),
        lt(managerChatAttachments.createdAt, before),
      ),
    );
  return deleted.rowCount ?? 0;
}
