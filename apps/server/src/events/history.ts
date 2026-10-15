import type { EventBus } from "@ai-office/events";
import {
  eventHistoryPath,
  eventHistoryQuerySchema,
  type EventHistoryResponse,
} from "@ai-office/events/stream";
import type { FastifyInstance } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The event history (PRD FR-52): the Activity Feed's pages of stored
// events, newest first, with the live stream's filters (Floor, Agent,
// issue, type) and a time range. New events reach the feed by the stream.

export function registerEventHistory(
  app: FastifyInstance,
  options: { readonly bus: EventBus },
): void {
  app.get(
    eventHistoryPath,
    { config: { access: "owner" } },
    async (request, reply) => {
      const query = eventHistoryQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const { floorId, agentId, issue, type, from, to, before, limit } =
        query.data;
      const page = await options.bus.history({
        filter: { floorId, agentId, issue, types: type },
        beforeId: before,
        from: from === undefined ? undefined : new Date(from),
        to: to === undefined ? undefined : new Date(to),
        limit,
      });
      const body: EventHistoryResponse = {
        events: page.map(({ id, occurredAt, event }) => ({
          id,
          occurredAt: occurredAt.toISOString(),
          event,
        })),
        nextBefore: page.length === limit ? (page.at(-1)?.id ?? null) : null,
      };
      return body;
    },
  );
}
