import { gatewayRequestListSchema } from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { aiAccountsQuery } from "./ai-accounts-card.tsx";
import { getJson } from "./api.ts";
import {
  ChatStatusLine,
  type ContextUsageFigures,
} from "./chat-status-line.tsx";

export { servingAccounts } from "./chat-status-line.tsx";

// The Manager chat's status line (PRD FR-24, FR-85, FR-32, FR-36), on its
// page and, compact, in the 3D Office's panel (a Grilling Session's
// included): the chat status line (`chat-status-line.tsx`) for the
// Manager. Its Context Usage is the Floor's for the Manager, kept live by
// its `agent.context_usage` events; the account that served it is the one
// the AI Gateway's request history names for its latest request, found
// again after each of its model calls.

/** The Manager's latest request through the AI Gateway, or null for none. */
export const latestRequestQuery = (floorId: string, agentId: string) =>
  queryOptions({
    queryKey: ["gateway", "requests", "latest", { floorId, agentId }],
    queryFn: async () => {
      const search = new URLSearchParams({ floorId, agentId, limit: "1" });
      const { requests } = await getJson(
        `/api/gateway/requests?${search.toString()}`,
        gatewayRequestListSchema,
      );
      return requests[0] ?? null;
    },
  });

/**
 * The Manager's Context Usage, its tokens against its Token Caps, and its
 * subscription's plan usage, as one wrapping row of labelled meters.
 */
export function ManagerStatusLine({
  floorId,
  manager,
  contextUsage,
  compact = false,
  children,
}: {
  floorId: string;
  manager: { readonly id: string; readonly aiProvider: string };
  contextUsage: ContextUsageFigures | undefined;
  compact?: boolean;
  /** The Model and effort, first in the line. */
  children?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const latest = latestRequestQuery(floorId, manager.id);
  const { data: latestRequest } = useQuery(latest);
  return (
    <ChatStatusLine
      caller={{ kind: "agent", floorId, agentId: manager.id }}
      aiProvider={manager.aiProvider}
      label="The Manager's usage"
      contextUsage={contextUsage}
      latestAccountId={latestRequest?.aiAccountId}
      compact={compact}
      onRequest={() => {
        void queryClient.invalidateQueries(latest);
      }}
      onFloorEvent={({ event }, client) => {
        if (
          event.type === "model_call.completed" &&
          event.agentId === manager.id
        ) {
          void client.invalidateQueries(latest);
          void client.invalidateQueries(aiAccountsQuery);
        }
      }}
    >
      {children}
    </ChatStatusLine>
  );
}
