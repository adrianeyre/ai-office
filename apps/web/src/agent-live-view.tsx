import type { EventOfType, EventType } from "@ai-office/events/schema";
import {
  eventHistoryResponseSchema,
  eventHistoryUrl,
  type StreamedEvent,
} from "@ai-office/events/stream";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

import { AgentLink, useAgentName } from "./agent-link.tsx";
import { roleLabel } from "./agents-card.tsx";
import { getJson } from "./api.ts";
import { ContextUsageGauge, useContextUsage } from "./context-usage.tsx";
import { useEventStream } from "./event-stream.ts";
import { agentsQuery, floorQuery } from "./floors.ts";

// One Agent's live activity (PRD FR-58, §5 scenario 2): what it says (its
// terminal output), the tools it calls, the files it changes, and its
// model calls with their tokens. The 2D page shows it, and the 3D desk
// monitors reuse the same component (#68).

/** The events the live view shows. */
export const liveViewEventTypes: readonly EventType[] = [
  "agent.status_changed",
  "sandbox.started",
  "sandbox.stopped",
  "sandbox.text",
  "sandbox.tool_call",
  "sandbox.diff",
  "model_call.completed",
];

/** How many earlier events the view starts with. */
const backlogSize = 200;

/** Within this many pixels of the bottom counts as at the bottom. */
const bottomSlackPx = 24;

const tokens = (count: number | null): string =>
  count === null ? "?" : count.toLocaleString("en-GB");

function Diff({ event }: { event: EventOfType<"sandbox.diff"> }) {
  return (
    // In the terminal's own colours, whatever the page's mode.
    <figure className="overflow-hidden rounded-md border border-zinc-800">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1 font-mono text-xs text-zinc-200">
        <span>{event.path}</span>
        <span>
          <span className="text-emerald-400">+{event.added}</span>{" "}
          <span className="text-red-400">−{event.removed}</span>
        </span>
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5">
        {event.diff.split("\n").map((line, index) => (
          <span
            // Lines may repeat; their order never changes.
            key={index}
            className={cn(
              "block",
              line.startsWith("+") && "bg-emerald-950/60 text-emerald-300",
              line.startsWith("-") && "bg-red-950/60 text-red-300",
              line.startsWith("@@") && "text-sky-300",
            )}
          >
            {line}
          </span>
        ))}
      </pre>
    </figure>
  );
}

/** One line of the live view, by its event's type. */
export function LiveEntry({ stored }: { stored: StreamedEvent }) {
  const { event } = stored;
  const system = "text-xs text-zinc-400";
  switch (event.type) {
    case "sandbox.text":
      return (
        <pre className="font-mono text-sm whitespace-pre-wrap text-zinc-100">
          {event.text}
        </pre>
      );
    case "sandbox.tool_call":
      return (
        <p className="font-mono text-sm break-all text-amber-200">
          <span className="sr-only">Tool call: </span>
          <span aria-hidden>▸ </span>
          <span className="font-semibold">{event.name}</span> {event.args}
        </p>
      );
    case "sandbox.diff":
      return <Diff event={event} />;
    case "model_call.completed":
      return (
        <p className="font-mono text-xs text-sky-200">
          Model call · {event.aiProvider}
          {event.model === null ? "" : ` ${event.model}`} ·{" "}
          {tokens(event.inputTokens)} in · {tokens(event.outputTokens)} out
          {event.cacheReadTokens === null || event.cacheReadTokens === 0
            ? ""
            : ` · ${tokens(event.cacheReadTokens)} cache read`}{" "}
          · {event.latencyMs} ms
          {event.status === 200 ? "" : ` · ${String(event.status)}`}
        </p>
      );
    case "sandbox.started":
      return (
        <p className={system}>
          Sandbox started for #{event.issue} on {event.branch}
        </p>
      );
    case "sandbox.stopped":
      return (
        <p className={system}>
          Sandbox for #{event.issue}{" "}
          {
            {
              finished: "finished",
              failed: "failed",
              cancelled: "was cancelled",
              timed_out: "timed out",
              fresh_start: "stopped for a Fresh Start",
            }[event.outcome]
          }
        </p>
      );
    case "agent.status_changed":
      return (
        <p className={system}>
          Now {event.status}
          {event.issue === undefined ? "" : ` on #${String(event.issue)}`}
          {event.reason === undefined ? "" : `: ${event.reason}`}
        </p>
      );
    default:
      return null;
  }
}

export interface AgentLiveViewProps {
  readonly agentId: string;
  readonly className?: string;
}

/**
 * The Agent's activity, oldest at the top, following new events as they
 * arrive. Scrolling up pauses that; "Jump to latest" resumes it.
 */
export function AgentLiveView({ agentId, className }: AgentLiveViewProps) {
  const filter = { agentId, types: liveViewEventTypes };
  const backlog = useQuery({
    queryKey: ["agent-live-view", agentId],
    queryFn: () =>
      getJson(
        eventHistoryUrl(filter, {}, undefined, backlogSize),
        eventHistoryResponseSchema,
      ),
    // New events come by the stream.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const earlier = backlog.data?.events.toReversed() ?? [];
  const newestEarlier = earlier.at(-1)?.id ?? 0;
  // Opened once the backlog is read, resuming right after it.
  const { events: streamed, status } = useEventStream(filter, {
    maxEvents: 1000,
    enabled: backlog.isSuccess,
    after: newestEarlier,
  });
  const entries = [
    ...earlier,
    ...streamed.filter(({ id }) => id > newestEarlier),
  ];

  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [seen, setSeen] = useState(0);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (following && element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries.length, following]);

  const onScroll = () => {
    const element = scroller.current;
    if (element === null) {
      return;
    }
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <=
      bottomSlackPx;
    if (atBottom !== following) {
      setFollowing(atBottom);
      setSeen(entries.length);
    }
  };

  const unseen = following ? 0 : entries.length - seen;

  return (
    <div className={cn("relative flex flex-col", className)}>
      <div
        ref={scroller}
        role="log"
        aria-label="Live activity"
        tabIndex={0}
        onScroll={onScroll}
        className="min-h-48 flex-1 overflow-y-auto rounded-xl bg-zinc-950 p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {backlog.isError && (
          <p role="alert" className="text-sm text-red-300">
            The Agent&apos;s activity could not be loaded.
          </p>
        )}
        {backlog.isSuccess && entries.length === 0 && (
          <p className="text-sm text-zinc-400">
            Nothing yet. What the Agent does appears here as it happens.
          </p>
        )}
        <ol className="space-y-2">
          {entries.map((stored) => (
            <li key={stored.id} data-type={stored.event.type}>
              <LiveEntry stored={stored} />
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-2 flex min-h-9 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span
          role="status"
          aria-label="Connection"
          className="inline-flex items-center gap-1.5"
        >
          {status !== "open" && <Spinner className="size-3" />}
          {status === "open"
            ? "Live"
            : status === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…"}
        </span>
        {!following && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setFollowing(true);
            }}
          >
            <ArrowDown aria-hidden />
            {unseen > 0
              ? `Jump to latest (${String(unseen)} new)`
              : "Jump to latest"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The Agent live view's page: who the Agent is, with its Context Usage
 * (FR-85; a reviewer's calls are stateless and have none), then its live
 * view.
 */
export function AgentLivePage({
  floorId,
  agentId,
}: {
  floorId: string;
  agentId: string;
}) {
  const name = useAgentName(floorId, agentId);
  const { data: agents, isError } = useQuery(agentsQuery(floorId));
  const agent = agents?.find(({ id }) => id === agentId);
  const { data: floor } = useQuery(floorQuery(floorId));
  const contextUsage = useContextUsage(floorId);
  return (
    <section className="flex h-full flex-col gap-4">
      <PageHeader
        title={
          <AgentLink floorId={floorId} agentId={agentId}>
            {() => name ?? "Agent"}
          </AgentLink>
        }
      >
        {agent !== undefined && (
          <p className="text-muted-foreground">
            {roleLabel(agent.role)} on{" "}
            <Link
              to="/floor-settings/$floorId"
              params={{ floorId }}
              className="hover:underline"
            >
              {floor?.name ?? floorId}
            </Link>{" "}
            · {agent.aiProvider} {agent.model}
          </p>
        )}
        {agent !== undefined && agent.stage !== "review" && (
          <p className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Context Usage</span>
            <ContextUsageGauge usage={contextUsage.usageOf(agentId)} />
          </p>
        )}
        {(isError || (agents !== undefined && agent === undefined)) && (
          <p role="alert" className="text-sm text-destructive">
            There is no such Agent on this Floor.
          </p>
        )}
      </PageHeader>
      <AgentLiveView agentId={agentId} className="h-[70vh]" />
    </section>
  );
}
