import {
  subjectOf,
  type EventFilter,
  type EventType,
  type OfficeEvent,
} from "@ai-office/events/schema";
import {
  eventHistoryResponseSchema,
  eventHistoryUrl,
  type StreamedEvent,
} from "@ai-office/events/stream";
import type { Agent, Floor } from "@ai-office/shared";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { selectClass } from "@/lib/utils.ts";

import { AgentLink } from "./agent-link.tsx";
import { getJson } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import {
  describeEvent,
  eventTypeGroups,
  eventTypeLabels,
  type EventNames,
} from "./event-text.ts";
import { agentsQuery, floorsQuery } from "./floors.ts";

// The Activity Feed (PRD FR-52): every event, newest first, filtered by
// Floor, Agent, issue, type and time. Older events load as the Owner
// scrolls; new ones stream in at the top. Each entry links to its source:
// the issue on GitHub, the Agent, the Notice.

/** The feed's filters, as its address holds them. */
export interface ActivityFilters {
  readonly floorId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly issue?: number | undefined;
  readonly type?: EventType | undefined;
  /** ISO 8601: only events at or after it. */
  readonly from?: string | undefined;
  /** ISO 8601: only events before it. */
  readonly to?: string | undefined;
}

/** Every Agent on every Floor in use, by id. */
export function useAllAgents(floors: readonly Floor[] | undefined) {
  const results = useQueries({
    queries: (floors ?? []).map(({ id }) => agentsQuery(id)),
  });
  return new Map(
    results.flatMap(({ data }) => data ?? []).map((agent) => [agent.id, agent]),
  );
}

/** A `datetime-local` value (local time) for an ISO time, and back. */
const localInput = (iso: string | undefined): string => {
  if (iso === undefined) {
    return "";
  }
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};
const fromLocalInput = (value: string): string | undefined =>
  value === "" ? undefined : new Date(value).toISOString();

type SourceLink =
  | { readonly kind: "github"; readonly href: string; readonly label: string }
  | {
      readonly kind: "agent";
      readonly floorId: string;
      readonly agentId: string;
    }
  | { readonly kind: "notice"; readonly noticeId: string }
  | { readonly kind: "role"; readonly roleId: string };

/** Where an event came from: its issue on GitHub, its Agents, its Notice. */
export function sourceLinks(
  event: OfficeEvent,
  floors: readonly Floor[] | undefined,
): SourceLink[] {
  const links: SourceLink[] = [];
  const { floorId, agentIds, issue } = subjectOf(event);
  if (event.type === "issue.picked_up") {
    links.push({
      kind: "github",
      href: event.url,
      label: `#${String(event.issue)} on GitHub`,
    });
  } else if (issue !== null && floorId !== null) {
    const repository = floors?.find(({ id }) => id === floorId)?.repository;
    if (repository !== undefined) {
      links.push({
        kind: "github",
        href: `https://github.com/${repository}/issues/${String(issue)}`,
        label: `#${String(issue)} on GitHub`,
      });
    }
  }
  if (
    event.type === "pull_request.opened" ||
    event.type === "pull_request.merged"
  ) {
    links.push({
      kind: "github",
      href: event.url,
      label: `PR #${String(event.pullRequest)} on GitHub`,
    });
  }
  if (event.type === "review.posted") {
    links.push({
      kind: "github",
      href: event.url,
      label: `Review of PR #${String(event.pullRequest)} on GitHub`,
    });
  }
  if (event.type === "qa.reported") {
    links.push({
      kind: "github",
      href: event.url,
      label: `QA result on PR #${String(event.pullRequest)} on GitHub`,
    });
  }
  if (event.type === "design.reported") {
    links.push({
      kind: "github",
      href: event.url,
      label: `Design review on PR #${String(event.pullRequest)} on GitHub`,
    });
  }
  if (
    event.type === "memory.curated" &&
    event.url !== undefined &&
    event.pullRequest !== undefined
  ) {
    links.push({
      kind: "github",
      href: event.url,
      label: `Memory PR #${String(event.pullRequest)} on GitHub`,
    });
  }
  if (floorId !== null) {
    for (const agentId of agentIds) {
      links.push({ kind: "agent", floorId, agentId });
    }
  }
  if (event.type.startsWith("notice.") && "noticeId" in event) {
    links.push({ kind: "notice", noticeId: event.noticeId });
  }
  if (event.type === "role.created" || event.type === "role.changed") {
    links.push({ kind: "role", roleId: event.roleId });
  }
  return links;
}

/** One event: when, its type and Floor, what happened, and its sources. */
export function ActivityEntry({
  stored,
  floors,
  names,
}: {
  stored: StreamedEvent;
  floors: readonly Floor[] | undefined;
  names: EventNames;
}) {
  const { event } = stored;
  const floorId = subjectOf(event).floorId;
  const floorName =
    floorId === null
      ? undefined
      : (floors?.find(({ id }) => id === floorId)?.name ?? floorId);
  const links = sourceLinks(event, floors);
  return (
    <li className="space-y-1 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <time dateTime={stored.occurredAt}>
          {new Date(stored.occurredAt).toLocaleString()}
        </time>
        <Badge>{eventTypeLabels[event.type]}</Badge>
        {floorName !== undefined && <span>{floorName}</span>}
      </div>
      <p className="line-clamp-3 text-sm break-words">
        {describeEvent(event, names)}
      </p>
      {links.length > 0 && (
        <ul
          aria-label="Sources"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        >
          {links.map((link) => (
            <li
              key={
                link.kind === "agent"
                  ? link.agentId
                  : link.kind === "notice"
                    ? link.noticeId
                    : link.kind === "role"
                      ? link.roleId
                      : link.href
              }
            >
              {link.kind === "github" ? (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  {link.label}
                  <ExternalLink aria-hidden className="size-3" />
                </a>
              ) : link.kind === "agent" ? (
                <AgentLink floorId={link.floorId} agentId={link.agentId} />
              ) : link.kind === "role" ? (
                <Link
                  to="/general-settings/roles"
                  search={{ role: link.roleId }}
                  className="hover:underline"
                >
                  Role library
                </Link>
              ) : (
                <Link
                  to="/notices"
                  search={{ notice: link.noticeId }}
                  className="hover:underline"
                >
                  Notice
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Filters({
  filters,
  floors,
  agents,
  onChange,
}: {
  filters: ActivityFilters;
  floors: readonly Floor[] | undefined;
  agents: readonly Agent[];
  onChange: (filters: ActivityFilters) => void;
}) {
  const set = (changes: ActivityFilters) => {
    onChange({ ...filters, ...changes });
  };
  const floorAgents = agents.filter(
    ({ floorId }) =>
      filters.floorId === undefined || floorId === filters.floorId,
  );
  return (
    <form
      aria-label="Filters"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="activity-floor">Floor</Label>
        <select
          id="activity-floor"
          className={selectClass}
          value={filters.floorId ?? ""}
          onChange={(event) => {
            const floorId = event.target.value || undefined;
            // An Agent belongs to one Floor.
            set({ floorId, agentId: undefined });
          }}
        >
          <option value="">All Floors</option>
          {floors?.map((floor) => (
            <option key={floor.id} value={floor.id}>
              {floor.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="activity-agent">Agent</Label>
        <select
          id="activity-agent"
          className={selectClass}
          value={filters.agentId ?? ""}
          onChange={(event) => {
            set({ agentId: event.target.value || undefined });
          }}
        >
          <option value="">All Agents</option>
          {floorAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {filters.floorId === undefined
                ? `${agent.name} (${
                    floors?.find(({ id }) => id === agent.floorId)?.name ??
                    agent.floorId
                  })`
                : agent.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="activity-issue">Issue</Label>
        <Input
          id="activity-issue"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="Any"
          defaultValue={filters.issue ?? ""}
          key={filters.issue ?? ""}
          onChange={(event) => {
            const issue = Number(event.target.value);
            if (event.target.value === "") {
              set({ issue: undefined });
            } else if (Number.isInteger(issue) && issue > 0) {
              set({ issue });
            }
          }}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="activity-type">Type</Label>
        <select
          id="activity-type"
          className={selectClass}
          value={filters.type ?? ""}
          onChange={(event) => {
            set({ type: (event.target.value || undefined) as EventType });
          }}
        >
          <option value="">All types</option>
          {eventTypeGroups.map(({ label, types }) => (
            <optgroup key={label} label={label}>
              {types.map((type) => (
                <option key={type} value={type}>
                  {eventTypeLabels[type]}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="activity-from">From</Label>
        <Input
          id="activity-from"
          type="datetime-local"
          value={localInput(filters.from)}
          onChange={(event) => {
            set({ from: fromLocalInput(event.target.value) });
          }}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="activity-to">To</Label>
        <Input
          id="activity-to"
          type="datetime-local"
          value={localInput(filters.to)}
          onChange={(event) => {
            set({ to: fromLocalInput(event.target.value) });
          }}
        />
      </div>
    </form>
  );
}

/** Whether `target` is on screen, as the Owner scrolls. */
function useOnScreen(target: RefObject<Element | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (element === null || !("IntersectionObserver" in globalThis)) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some(({ isIntersecting }) => isIntersecting));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [target]);
  return onScreen;
}

export interface ActivityFeedPageProps {
  readonly filters: ActivityFilters;
  readonly onFiltersChange: (filters: ActivityFilters) => void;
}

export function ActivityFeedPage({
  filters,
  onFiltersChange,
}: ActivityFeedPageProps) {
  const { data: floors } = useQuery(floorsQuery);
  const agents = useAllAgents(floors);
  const names: EventNames = {
    agent: (agentId) => agents.get(agentId)?.name ?? agentId,
    floor: (floorId) =>
      floors?.find(({ id }) => id === floorId)?.name ?? floorId,
  };

  const filter: EventFilter = {
    floorId: filters.floorId,
    agentId: filters.agentId,
    issue: filters.issue,
    types: filters.type === undefined ? undefined : [filters.type],
  };
  const range = { from: filters.from, to: filters.to };
  const historyKey = ["activity", filter, range] as const;
  const history = useInfiniteQuery({
    queryKey: historyKey,
    queryFn: ({ pageParam }) =>
      getJson(
        eventHistoryUrl(filter, range, pageParam),
        eventHistoryResponseSchema,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    // New events come by the stream, so what was read stays current.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  const loaded = history.data?.pages.flatMap((page) => page.events) ?? [];
  const newestLoaded = loaded[0]?.id ?? 0;

  // New events stream in, unless the range ends before now. The stream
  // opens once the first page is read, resuming right after its newest
  // event, so nothing in between is missed.
  const live = filters.to === undefined;
  const { events: streamed } = useEventStream(filter, {
    maxEvents: 500,
    enabled: live && history.isSuccess,
    // With nothing read, there is nothing to replay: unless a `from` hid
    // older events, which the stream need not send again.
    ...(newestLoaded > 0 || filters.from === undefined
      ? { after: newestLoaded }
      : {}),
  });
  const fresh = live
    ? streamed
        .filter(
          ({ id, occurredAt }) =>
            id > newestLoaded &&
            (filters.from === undefined || occurredAt >= filters.from),
        )
        .toReversed()
    : [];
  const entries = [...fresh, ...loaded];

  // The next page loads while the end of the list is on screen: as it
  // scrolls into view, and again after a page if it is still there (its
  // position is read afresh, as the page just read has moved it).
  const end = useRef<HTMLDivElement>(null);
  const endOnScreen = useOnScreen(end);
  const { hasNextPage, isFetching, fetchNextPage } = history;
  useEffect(() => {
    const element = end.current;
    if (
      endOnScreen &&
      element !== null &&
      hasNextPage &&
      !isFetching &&
      element.getBoundingClientRect().top <= window.innerHeight
    ) {
      void fetchNextPage();
    }
  }, [endOnScreen, hasNextPage, isFetching, fetchNextPage, loaded.length]);

  return (
    <section className="space-y-6">
      <PageHeader
        title="Activity"
        description={
          <>
            The Activity Feed: a complete, read-only record of everything that
            happens in the Office, newest first.
          </>
        }
      />
      <Filters
        filters={filters}
        floors={floors}
        agents={[...agents.values()]}
        onChange={onFiltersChange}
      />
      {history.isError && (
        <p role="alert" className="text-sm text-destructive">
          The Activity Feed could not be loaded.
        </p>
      )}
      {history.isSuccess && entries.length === 0 && (
        <p className="text-muted-foreground">Nothing matches these filters.</p>
      )}
      {entries.length > 0 && (
        <ol aria-label="Activity" className="rounded-xl border px-4">
          {entries.map((stored) => (
            <ActivityEntry
              key={stored.id}
              stored={stored}
              floors={floors}
              names={names}
            />
          ))}
        </ol>
      )}
      {/* Not a scroll anchor: older events push it down as they load. */}
      <div
        ref={end}
        className="flex justify-center"
        style={{ overflowAnchor: "none" }}
      >
        {history.hasNextPage ? (
          <Button
            pending={history.isFetchingNextPage}
            variant="outline"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load older events"}
          </Button>
        ) : (
          history.isSuccess &&
          entries.length > 0 && (
            <p className="text-sm text-muted-foreground">That is everything.</p>
          )
        )}
      </div>
    </section>
  );
}
