import type { EventType } from "@ai-office/events/schema";
import {
  workingNowSchema,
  type WorkingAgent,
  type WorkingManager,
  type WorkingNow,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleStop,
  Eye,
  MessageSquare,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { getJson, postJson, readApiError } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { StageBadge } from "./scene/wall-board-panel.tsx";
import { sessionQuery } from "./session.ts";

// The Overview page: every Agent's work, running or queued, and every
// Manager answering, across the Floors in use, in one place; any one of
// which the Owner can stop. Each sandbox's latest step streams in as it
// happens; everything else is looked at again on the events that change
// it, and every few seconds whatever happens.

/** How often the page looks again regardless, in milliseconds. */
export const workingNowRefreshMs = 5000;

/** Work running at least this long is flagged, in milliseconds. */
export const longRunningMs = 30 * 60_000;

export const workingNowQuery = queryOptions({
  queryKey: ["working-now"],
  queryFn: () => getJson("/api/working-now", workingNowSchema),
  refetchInterval: workingNowRefreshMs,
});

/** The Overview's filters, kept in its address so a view can be shared. */
export const overviewSearchSchema = z.object({
  floor: z.string().min(1).optional().catch(undefined),
  q: z.string().min(1).optional().catch(undefined),
  status: z.enum(["running", "queued"]).optional().catch(undefined),
});
export type OverviewFilters = z.infer<typeof overviewSearchSchema>;

/** How long since `iso`, short: "45s", "12m", "3h 5m", "2d 4h". */
export function elapsedText(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0
      ? `${String(hours)}h`
      : `${String(hours)}h ${String(minutes % 60)}m`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0
    ? `${String(days)}d`
    : `${String(days)}d ${String(hours % 24)}h`;
}

/** Whether a row holds `query`, in any case: its Agent, Role, Floor or issue. */
export function matchesQuery(
  row: WorkingAgent | WorkingManager,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  if (needle === "") {
    return true;
  }
  const haystack =
    "issue" in row
      ? [
          row.agentName,
          row.role,
          row.floorName,
          String(row.issue),
          row.issueTitle,
          row.latest?.text,
        ]
      : [row.agentName, "manager", row.floorName];
  return haystack.some((each) => each?.toLowerCase().includes(needle));
}

/** How long ago `at` was, for "Updated …": "just now" under 5 seconds. */
export function agoText(at: number, now: number): string {
  return now - at < 5000
    ? "just now"
    : `${elapsedText(new Date(at).toISOString(), now)} ago`;
}

/** The time now, a second at a time, for durations that count up. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/** Events after which what is going on may have changed: look again. */
const changes: EventType[] = [
  "sandbox.started",
  "sandbox.stopped",
  "agent.queue_changed",
  "agent.status_changed",
  "agent.removed",
  "issue.assigned",
  "issue.picked_up",
  "floor.stopped",
  "floor.continued",
  "floor.archived",
  "floor.renamed",
];
/** A sandbox's steps, which update its row in place. */
const steps: EventType[] = ["sandbox.text", "sandbox.tool_call"];

/**
 * Keeps the page live: each sandbox step updates its row at once, and any
 * other change has the page look again, at most once a second.
 */
function useLiveWork(): "live" | "polling" {
  const queryClient = useQueryClient();
  const lastAsked = useRef(0);
  const later = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(later.current);
    },
    [],
  );
  const { status } = useEventStream(
    { types: [...changes, ...steps] },
    {
      maxEvents: 1,
      onEvent: ({ event, occurredAt }) => {
        if (
          event.type === "sandbox.text" ||
          event.type === "sandbox.tool_call"
        ) {
          const latest: NonNullable<WorkingAgent["latest"]> =
            event.type === "sandbox.text"
              ? { kind: "text", text: event.text, at: occurredAt }
              : {
                  kind: "tool",
                  text: `${event.name} ${event.args}`.trim(),
                  at: occurredAt,
                };
          queryClient.setQueryData<WorkingNow>(
            workingNowQuery.queryKey,
            (now) =>
              now && {
                ...now,
                work: now.work.map((item) =>
                  item.status === "running" &&
                  item.floorId === event.floorId &&
                  item.agentId === event.agentId &&
                  item.issue === event.issue
                    ? { ...item, latest }
                    : item,
                ),
              },
          );
          return;
        }
        const wait = Math.max(0, lastAsked.current + 1000 - Date.now());
        clearTimeout(later.current);
        later.current = setTimeout(() => {
          lastAsked.current = Date.now();
          void queryClient.invalidateQueries(workingNowQuery);
        }, wait);
      },
    },
  );
  return status === "open" ? "live" : "polling";
}

const phaseText: Record<WorkingManager["phase"], string> = {
  writing: "Writing a reply",
  acting: "Carrying out a request",
  busy: "Busy",
};

/** What the Owner asked to stop, waiting for them to confirm. */
type Stopping =
  | { readonly kind: "work"; readonly work: WorkingAgent }
  | { readonly kind: "manager"; readonly manager: WorkingManager };

const whoOf = (stopping: Stopping): string =>
  stopping.kind === "manager"
    ? stopping.manager.agentName
    : (stopping.work.agentName ?? "Unassigned work");

const issueUrl = (item: WorkingAgent) =>
  `https://github.com/${item.repository}/issues/${String(item.issue)}`;

/**
 * A count at the top of the page. With `onToggle` it is a filter too,
 * pressed while it filters.
 */
function Tally({
  label,
  count,
  tone,
  pressed,
  onToggle,
}: {
  label: string;
  count: number;
  tone: "success" | "neutral" | "info";
  pressed?: boolean;
  onToggle?: () => void;
}) {
  const dot = {
    success: "bg-tone-success-foreground",
    neutral: "bg-muted-foreground",
    info: "bg-tone-info-foreground",
  }[tone];
  const body = (
    <>
      <span className="flex items-center gap-2 text-sm whitespace-nowrap text-muted-foreground">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} />
        {label}
      </span>
      <span className="block text-3xl font-semibold tracking-tight tabular-nums">
        {count}
      </span>
    </>
  );
  const frame =
    "block w-full rounded-xl border bg-card px-4 py-3 text-left shadow-xs";
  return onToggle === undefined ? (
    <div className={frame}>{body}</div>
  ) : (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        frame,
        "transition-[border-color,box-shadow] duration-150 outline-none hover:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        pressed === true && "border-primary ring-1 ring-primary",
      )}
    >
      {body}
      <span className="sr-only">
        {pressed === true ? ": shown alone, press to show all" : ": show alone"}
      </span>
    </button>
  );
}

const th = "py-2.5 pr-4 font-medium";
const td = "py-3 pr-4 align-middle";

/** Placeholder rows while the page first loads, so nothing jumps. */
function SkeletonRows({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      data-testid={`${label}-skeleton`}
      className="space-y-2 rounded-xl border bg-card p-4 shadow-xs"
    >
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="h-9 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

function ManagersTable({
  managers,
  now,
  onStop,
}: {
  managers: WorkingManager[];
  now: number;
  onStop: (manager: WorkingManager) => void;
}) {
  return (
    <TableFrame label="Managers answering, scrollable">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Managers answering</caption>
        <thead className="text-xs tracking-wide text-muted-foreground uppercase">
          <tr className="border-b">
            <th scope="col" className={th}>
              Manager
            </th>
            <th scope="col" className={th}>
              Floor
            </th>
            <th scope="col" className={th}>
              Doing
            </th>
            <th scope="col" className={th}>
              For
            </th>
            <th scope="col" className={th}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {managers.map((manager) => (
            <tr key={manager.floorId} className="border-b hover:bg-muted/40">
              <th
                scope="row"
                className={cn(td, "font-medium whitespace-nowrap")}
              >
                {manager.agentName}
              </th>
              <td className={cn(td, "whitespace-nowrap")}>
                {manager.floorName}
              </td>
              <td className={td}>
                <Badge tone={manager.phase === "writing" ? "info" : "violet"}>
                  {phaseText[manager.phase]}
                </Badge>
              </td>
              <td className={cn(td, "whitespace-nowrap tabular-nums")}>
                <time dateTime={manager.since} title={manager.since}>
                  {elapsedText(manager.since, now)}
                </time>
              </td>
              <td className={cn(td, "text-right whitespace-nowrap")}>
                <span className="inline-flex gap-2">
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      to="/floors/$floorId/manager"
                      params={{ floorId: manager.floorId }}
                    >
                      <MessageSquare aria-hidden />
                      Open chat
                      <span className="sr-only">
                        {" "}
                        with {manager.agentName} on {manager.floorName}
                      </span>
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Stop ${manager.agentName} on ${manager.floorName}`}
                    onClick={() => {
                      onStop(manager);
                    }}
                  >
                    <CircleStop aria-hidden />
                    Stop
                  </Button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

function WorkTable({
  work,
  now,
  onStop,
}: {
  work: WorkingAgent[];
  now: number;
  onStop: (work: WorkingAgent) => void;
}) {
  return (
    <TableFrame label="Agents' work, scrollable">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Agents&apos; work</caption>
        <thead className="text-xs tracking-wide text-muted-foreground uppercase">
          <tr className="border-b">
            <th scope="col" className={th}>
              Agent
            </th>
            <th scope="col" className={th}>
              Floor
            </th>
            <th scope="col" className={cn(th, "min-w-64")}>
              Issue
            </th>
            <th scope="col" className={th}>
              Stage
            </th>
            <th scope="col" className={th}>
              Status
            </th>
            <th scope="col" className={th}>
              For
            </th>
            <th scope="col" className={th}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {work.map((item) => {
            const since = item.startedAt ?? item.queuedAt;
            const who = item.agentName ?? "No Agent yet";
            const long =
              item.status === "running" &&
              now - Date.parse(since) >= longRunningMs;
            return (
              <tr key={item.id} className="border-b hover:bg-muted/40">
                <th
                  scope="row"
                  className={cn(td, "font-medium whitespace-nowrap")}
                >
                  {item.agentId === null ? (
                    <span className="text-muted-foreground">{who}</span>
                  ) : (
                    <Link
                      to="/floors/$floorId/agents/$agentId"
                      params={{ floorId: item.floorId, agentId: item.agentId }}
                      className="hover:underline"
                    >
                      {who}
                    </Link>
                  )}
                  {item.role !== null && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {item.role}
                    </span>
                  )}
                </th>
                <td className={cn(td, "whitespace-nowrap")}>
                  {item.floorName}
                </td>
                <td className={cn(td, "max-w-md")}>
                  <a
                    href={issueUrl(item)}
                    target="_blank"
                    rel="noreferrer"
                    className="group block hover:underline"
                  >
                    <span className="font-mono text-muted-foreground">
                      #{item.issue}
                    </span>
                    {item.issueTitle !== null && <> {item.issueTitle}</>}
                  </a>
                  {item.latest !== null && (
                    <p
                      className="mt-1 truncate font-mono text-xs text-muted-foreground"
                      title={item.latest.text}
                    >
                      <span className="sr-only">Latest step: </span>
                      {item.latest.kind === "tool" ? "$ " : ""}
                      {item.latest.text}
                    </p>
                  )}
                </td>
                <td className={td}>
                  <StageBadge stage={item.stage} />
                </td>
                <td className={td}>
                  <Badge
                    tone={item.status === "running" ? "success" : "neutral"}
                  >
                    {item.status === "running" ? "Running" : "Queued"}
                  </Badge>
                </td>
                <td className={cn(td, "whitespace-nowrap tabular-nums")}>
                  <time dateTime={since} title={since}>
                    {elapsedText(since, now)}
                  </time>
                  {long && (
                    <Badge tone="warning" className="ml-2">
                      <TriangleAlert aria-hidden className="size-3" />
                      Long-running
                    </Badge>
                  )}
                </td>
                <td className={cn(td, "text-right whitespace-nowrap")}>
                  <span className="inline-flex gap-2">
                    {item.status === "running" && item.agentId !== null && (
                      <Button asChild size="sm" variant="ghost">
                        <Link
                          to="/floors/$floorId/agents/$agentId"
                          params={{
                            floorId: item.floorId,
                            agentId: item.agentId,
                          }}
                        >
                          <Eye aria-hidden />
                          Watch
                          <span className="sr-only">
                            {" "}
                            {who} on #{item.issue}
                          </span>
                        </Link>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Stop ${who}'s work on #${String(item.issue)} in ${item.floorName}`}
                      onClick={() => {
                        onStop(item);
                      }}
                    >
                      <CircleStop aria-hidden />
                      Stop
                    </Button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableFrame>
  );
}

/**
 * The Overview page: what every Agent and Manager is doing across the
 * Floors in use, each of which can be stopped once the Owner confirms.
 * Its filters are kept in its address (`filters`), so a view can be
 * shared or bookmarked.
 */
export function OverviewPage({
  filters = {},
  onFiltersChange = () => undefined,
}: {
  filters?: OverviewFilters;
  onFiltersChange?: (next: OverviewFilters) => void;
}) {
  const queryClient = useQueryClient();
  const working = useQuery(workingNowQuery);
  const { data: session } = useQuery(sessionQuery);
  const live = useLiveWork();
  const now = useNow();
  const floorFilterId = useId();
  const searchId = useId();
  const [stopping, setStopping] = useState<Stopping>();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [stopped, setStopped] = useState<string>();
  // Typed at once; kept in the address as it is typed.
  const [query, setQuery] = useState(filters.q ?? "");
  const managersHeading = useRef<HTMLHeadingElement>(null);
  const agentsHeading = useRef<HTMLHeadingElement>(null);

  const data = working.data;
  const floors = new Map<string, string>();
  for (const { floorId: id, floorName } of [
    ...(data?.work ?? []),
    ...(data?.managers ?? []),
  ]) {
    floors.set(id, floorName);
  }
  // A Floor with nothing going on any more is every Floor.
  const shownFloor =
    filters.floor !== undefined && floors.has(filters.floor)
      ? filters.floor
      : undefined;
  const shown = <T extends WorkingAgent | WorkingManager>(rows: T[]) =>
    rows.filter(
      (row) =>
        (shownFloor === undefined || row.floorId === shownFloor) &&
        matchesQuery(row, query),
    );
  const managers = shown(data?.managers ?? []);
  const work = shown(data?.work ?? []);
  // Running first, the longest-running first; then queued, oldest first.
  const running = work
    .filter(({ status }) => status === "running")
    .sort((a, b) =>
      (a.startedAt ?? a.queuedAt).localeCompare(b.startedAt ?? b.queuedAt),
    );
  const queued = work
    .filter(({ status }) => status === "queued")
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const listed =
    filters.status === "running"
      ? running
      : filters.status === "queued"
        ? queued
        : [...running, ...queued];
  const showManagers = filters.status === undefined;
  const filtered =
    shownFloor !== undefined ||
    query.trim() !== "" ||
    filters.status !== undefined;

  const change = (next: Partial<OverviewFilters>) => {
    onFiltersChange({ ...filters, ...next });
  };
  const clear = () => {
    setQuery("");
    onFiltersChange({});
  };

  const stop = async (what: Stopping) => {
    setPending(true);
    setProblem(undefined);
    // Where focus goes once its row is gone.
    const after = what.kind === "work" ? agentsHeading : managersHeading;
    try {
      const response = await postJson(
        what.kind === "work"
          ? `/api/working-now/work/${String(what.work.id)}/stop`
          : `/api/working-now/managers/${encodeURIComponent(what.manager.floorId)}/stop`,
        {},
        session?.csrfToken,
      );
      if (response.ok) {
        queryClient.setQueryData<WorkingNow>(
          workingNowQuery.queryKey,
          workingNowSchema.parse(await response.json()),
        );
        setStopped(
          what.kind === "work"
            ? `Stopped ${whoOf(what)}'s work on #${String(what.work.issue)}.`
            : `Stopped ${whoOf(what)} on ${what.manager.floorName}.`,
        );
        setStopping(undefined);
        requestAnimationFrame(() => after.current?.focus());
        return;
      }
      if (response.status === 404) {
        // It ended meanwhile: nothing to stop.
        setStopped(`${whoOf(what)} had already finished.`);
        setStopping(undefined);
        requestAnimationFrame(() => after.current?.focus());
        await queryClient.invalidateQueries(workingNowQuery);
        return;
      }
      setProblem(
        (await readApiError(response)).message ?? "It could not be stopped.",
      );
    } catch {
      setProblem("AI Office could not be reached. Try again.");
    } finally {
      setPending(false);
    }
  };

  const nothingAtAll =
    data !== undefined && data.managers.length + data.work.length === 0;
  const nothingShown =
    data !== undefined &&
    !nothingAtAll &&
    (showManagers ? managers.length : 0) + listed.length === 0;
  // Shown when a refresh fails but what was there before still is.
  const stale = working.isError && data !== undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Every Agent and Manager at work across your Floors, live. Stop any one of them here; the rest carry on."
        actions={
          <>
            <span
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title={
                live === "live"
                  ? "Each step streams in as it happens."
                  : `Looked at again every ${String(workingNowRefreshMs / 1000)} seconds.`
              }
            >
              <span aria-hidden className="relative flex size-2">
                {live === "live" && (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-tone-success-foreground opacity-60 motion-reduce:hidden" />
                )}
                <span
                  className={cn(
                    "relative inline-flex size-2 rounded-full",
                    live === "live"
                      ? "bg-tone-success-foreground"
                      : "bg-muted-foreground",
                  )}
                />
              </span>
              {live === "live" ? "Live" : "Updating"}
              {working.dataUpdatedAt > 0 && (
                <span className="tabular-nums">
                  · updated {agoText(working.dataUpdatedAt, now)}
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              pending={working.isFetching}
              onClick={() => void working.refetch()}
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
          </>
        }
      />

      <p role="status" className="text-sm empty:hidden">
        {stopped}
      </p>

      {stale && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-tone-warning-foreground/30 bg-tone-warning px-3 py-2 text-sm text-tone-warning-foreground"
        >
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          AI Office cannot be reached: this is what was going on{" "}
          {agoText(working.dataUpdatedAt, now)}. It is tried again every few
          seconds.
        </p>
      )}
      {working.isError && data === undefined && (
        <p role="alert" className="text-sm text-destructive">
          What is going on could not be loaded. It is tried again every few
          seconds.
        </p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div
          role="group"
          aria-label="Counts, and filters by status"
          className="grid flex-1 grid-cols-1 gap-3 min-[480px]:grid-cols-3 sm:max-w-2xl"
        >
          <Tally
            label="Agents working"
            tone="success"
            count={data === undefined ? 0 : running.length}
            pressed={filters.status === "running"}
            onToggle={() => {
              change({
                status: filters.status === "running" ? undefined : "running",
              });
            }}
          />
          <Tally
            label="Queued"
            tone="neutral"
            count={data === undefined ? 0 : queued.length}
            pressed={filters.status === "queued"}
            onToggle={() => {
              change({
                status: filters.status === "queued" ? undefined : "queued",
              });
            }}
          />
          <Tally
            label="Managers answering"
            tone="info"
            count={data === undefined ? 0 : managers.length}
          />
        </div>
        <div className="flex w-full flex-wrap items-end gap-3 sm:w-auto">
          <div className="min-w-0 flex-1 space-y-1 sm:w-64 sm:flex-none">
            <Label htmlFor={searchId}>Find</Label>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={searchId}
                type="search"
                autoComplete="off"
                spellCheck={false}
                placeholder="Agent, Role or issue"
                className="pl-9"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  change({
                    q:
                      event.target.value.trim() === ""
                        ? undefined
                        : event.target.value,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query !== "") {
                    event.preventDefault();
                    setQuery("");
                    change({ q: undefined });
                  }
                }}
              />
            </div>
          </div>
          {floors.size > 1 && (
            <div className="space-y-1">
              <Label htmlFor={floorFilterId}>Floor</Label>
              <select
                id={floorFilterId}
                className={cn(selectClass, "sm:w-48")}
                value={shownFloor ?? ""}
                onChange={(event) => {
                  change({
                    floor:
                      event.target.value === ""
                        ? undefined
                        : event.target.value,
                  });
                }}
              >
                <option value="">Every Floor</option>
                {[...floors].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {data === undefined && !working.isError && (
        <div className="space-y-6" aria-busy>
          <p className="sr-only" role="status">
            Looking at what everyone is doing…
          </p>
          <SkeletonRows label="managers" />
          <SkeletonRows label="agents" />
        </div>
      )}

      {nothingAtAll && (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="font-medium">Nothing is going on right now.</p>
          <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
            Work shows here as soon as an Agent picks up an issue or a Manager
            starts answering.{" "}
            <Link to="/" className="underline underline-offset-4">
              Go to the Office
            </Link>
          </p>
        </div>
      )}

      {nothingShown && (
        <div className="space-y-3 rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">Nothing matches these filters.</p>
          <Button size="sm" variant="outline" onClick={clear}>
            Clear the filters
          </Button>
        </div>
      )}

      {data !== undefined && !nothingAtAll && !nothingShown && (
        <>
          {showManagers && (
            <section aria-labelledby="working-managers" className="space-y-2">
              <h2
                id="working-managers"
                ref={managersHeading}
                tabIndex={-1}
                className="flex items-baseline gap-2 text-lg font-semibold outline-none"
              >
                Managers
                <span className="text-sm font-normal text-muted-foreground tabular-nums">
                  {managers.length}
                </span>
              </h2>
              {managers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No Manager is answering
                  {filtered ? " among those shown" : ""}.
                </p>
              ) : (
                <ManagersTable
                  managers={managers}
                  now={now}
                  onStop={(manager) => {
                    setProblem(undefined);
                    setStopping({ kind: "manager", manager });
                  }}
                />
              )}
            </section>
          )}
          <section aria-labelledby="working-agents" className="space-y-2">
            <h2
              id="working-agents"
              ref={agentsHeading}
              tabIndex={-1}
              className="flex items-baseline gap-2 text-lg font-semibold outline-none"
            >
              Agents
              <span className="text-sm font-normal text-muted-foreground tabular-nums">
                {listed.length}
              </span>
            </h2>
            {listed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Agent has work {filters.status ?? "running or queued"}
                {filtered ? " among those shown" : ""}.
              </p>
            ) : (
              <WorkTable
                work={listed}
                now={now}
                onStop={(item) => {
                  setProblem(undefined);
                  setStopping({ kind: "work", work: item });
                }}
              />
            )}
          </section>
          {filtered && (
            <p className="text-sm text-muted-foreground">
              Filtered.{" "}
              <button
                type="button"
                className="underline underline-offset-4 hover:text-foreground"
                onClick={clear}
              >
                Show everything
              </button>
            </p>
          )}
        </>
      )}

      <Dialog
        open={stopping !== undefined}
        onClose={() => {
          if (!pending) {
            setStopping(undefined);
          }
        }}
        title={
          stopping === undefined
            ? "Stop"
            : stopping.kind === "work"
              ? `Stop ${whoOf(stopping)}'s work on #${String(stopping.work.issue)}?`
              : `Stop ${whoOf(stopping)}?`
        }
        closeLabel="Keep it going"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setStopping(undefined);
              }}
            >
              Keep it going
            </Button>
            <Button
              variant="destructive"
              pending={pending}
              disabled={pending || session === undefined}
              onClick={() => {
                if (stopping !== undefined) {
                  void stop(stopping);
                }
              }}
            >
              <CircleStop aria-hidden />
              {pending ? "Stopping…" : "Stop"}
            </Button>
          </div>
        }
      >
        {stopping?.kind === "work" && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-muted/60 p-3">
              <dt className="text-muted-foreground">Issue</dt>
              <dd>
                #{stopping.work.issue}
                {stopping.work.issueTitle === null
                  ? ""
                  : ` ${stopping.work.issueTitle}`}
              </dd>
              <dt className="text-muted-foreground">Floor</dt>
              <dd>{stopping.work.floorName}</dd>
              {stopping.work.latest !== null && (
                <>
                  <dt className="text-muted-foreground">Doing</dt>
                  <dd className="truncate font-mono text-xs leading-5">
                    {stopping.work.latest.text}
                  </dd>
                </>
              )}
            </dl>
            <p>
              {stopping.work.status === "running"
                ? "Its sandbox is stopped at once and the work is cancelled: it does not start again by itself."
                : "It is taken out of the queue and never starts."}{" "}
              The rest of {stopping.work.floorName} carries on.
            </p>
          </div>
        )}
        {stopping?.kind === "manager" && (
          <p className="text-sm">
            {phaseText[stopping.manager.phase]} on {stopping.manager.floorName}{" "}
            stops at once; the chat keeps what it said so far and why it
            stopped. The Floor&apos;s Agents carry on.
          </p>
        )}
        {problem !== undefined && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {problem}
          </p>
        )}
      </Dialog>
    </div>
  );
}
