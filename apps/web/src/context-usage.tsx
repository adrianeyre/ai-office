import type { EventOfType } from "@ai-office/events/schema";
import {
  contextUsageBand,
  contextUsageBandTokens,
  contextUsagePercent,
  contextUsageText,
  floorContextUsageSchema,
  type AgentContextUsage,
  type FloorContextUsage,
} from "@ai-office/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { cn } from "@/lib/utils.ts";

import { getJson } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { backgroundOf } from "./scene/stage-colours.ts";

// Context Usage in the 2D views (PRD FR-84, FR-85): how full each Agent's
// working context is, read from `GET /api/floors/:floorId/context-usage`
// and kept live by the Floor's `agent.context_usage` events, shown as a
// small gauge coloured green below 60%, amber from 60% and red from 85%.

/** A Floor's Agents with a session going, and their Context Usage. */
export const contextUsageQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "context-usage"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/context-usage`,
        floorContextUsageSchema,
      ),
  });

/** A Floor's Context Usage with an `agent.context_usage` event applied. */
export function withContextUsageEvent(
  usage: FloorContextUsage,
  event: EventOfType<"agent.context_usage">,
  occurredAt: string,
): FloorContextUsage {
  const others = usage.agents.filter(
    ({ agentId }) => agentId !== event.agentId,
  );
  if (!event.active || event.model === undefined) {
    return { agents: others };
  }
  const updated: AgentContextUsage = {
    agentId: event.agentId,
    floorId: event.floorId,
    issue: event.issue ?? null,
    model: event.model,
    inputTokens: event.inputTokens ?? 0,
    contextWindow: event.contextWindow ?? null,
    contextUsage: event.contextUsage,
    updatedAt: occurredAt,
  };
  return {
    agents: [...others, updated].sort((a, b) =>
      a.agentId.localeCompare(b.agentId),
    ),
  };
}

/**
 * Each of the Floor's Agents' Context Usage, kept live: undefined for an
 * Agent without a session going.
 */
export function useContextUsage(floorId: string): {
  readonly usageOf: (agentId: string) => AgentContextUsage | undefined;
  readonly isError: boolean;
} {
  const query = contextUsageQuery(floorId);
  const { data, isError, refetch } = useQuery(query);
  const { status } = useEventStream(
    { floorId, types: ["agent.context_usage"] },
    {
      maxEvents: 20,
      onEvent: ({ event, occurredAt }, client) => {
        if (event.type !== "agent.context_usage") {
          return;
        }
        client.setQueryData(query.queryKey, (current) =>
          current === undefined
            ? current
            : withContextUsageEvent(current, event, occurredAt),
        );
      },
    },
  );
  // What changed while the stream was down is read again once it is up.
  useEffect(() => {
    if (status === "open") {
      void refetch();
    }
  }, [status, refetch]);
  return {
    usageOf: (agentId) =>
      data?.agents.find((entry) => entry.agentId === agentId),
    isError,
  };
}

const tokens = new Intl.NumberFormat("en-US");

/**
 * An Agent's Context Usage as a small gauge, coloured by its band, with
 * the percentage as text: `Unknown` when its Model's context window is
 * not in the catalogue, and a dash without a session going.
 */
export function ContextUsageGauge({
  usage,
  className,
}: {
  usage:
    | Pick<
        AgentContextUsage,
        "model" | "inputTokens" | "contextWindow" | "contextUsage"
      >
    | undefined;
  className?: string;
}) {
  if (usage === undefined) {
    return (
      <span
        className={cn("text-muted-foreground", className)}
        data-band="none"
        aria-label="Context Usage: no session"
      >
        —
      </span>
    );
  }
  const band = contextUsageBand(usage.contextUsage);
  const detail = `${tokens.format(usage.inputTokens)} of ${
    usage.contextWindow === null
      ? "an unknown number of"
      : tokens.format(usage.contextWindow)
  } tokens (${usage.model})`;
  if (usage.contextUsage === null) {
    return (
      <span
        className={cn("text-muted-foreground", className)}
        data-band={band}
        title={detail}
        aria-label={`Context Usage: unknown, ${detail}`}
      >
        Unknown
      </span>
    );
  }
  const percent = contextUsagePercent(usage.contextUsage);
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      data-band={band}
      title={detail}
    >
      <span
        role="meter"
        aria-label="Context Usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${contextUsageText(usage.contextUsage)}, ${detail}`}
        className="h-2 w-16 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "block h-full rounded-full",
            backgroundOf(contextUsageBandTokens[band]),
          )}
          style={{ width: `${String(percent)}%` }}
        />
      </span>
      <span className="tabular-nums">
        {contextUsageText(usage.contextUsage)}
      </span>
    </span>
  );
}
