import {
  workingNowSchema,
  type WorkingAgent,
  type WorkingManager,
  type WorkingNow,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleStop, MessageSquare, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { getJson, postJson, readApiError } from "./api.ts";
import { StageBadge } from "./scene/wall-board-panel.tsx";
import { sessionQuery } from "./session.ts";

// The Overview page: every Agent's work, running or queued, and every Manager
// answering, across the Floors in use, in one place; any one of which the
// Owner can stop. It looks again every few seconds.

/** How often the page looks again, in milliseconds. */
export const workingNowRefreshMs = 5000;

export const workingNowQuery = queryOptions({
  queryKey: ["working-now"],
  queryFn: () => getJson("/api/working-now", workingNowSchema),
  refetchInterval: workingNowRefreshMs,
});

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

/** A count at the top of the page. */
function Tally({ label, count }: { label: string; count: number }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-xs">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{count}</dd>
    </div>
  );
}

const th = "py-2 pr-4 font-medium";
const td = "py-2 pr-4 align-middle";

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
      <table className="w-full text-left text-sm whitespace-nowrap">
        <caption className="sr-only">Managers answering</caption>
        <thead className="text-muted-foreground">
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
            <tr key={manager.floorId} className="border-b">
              <th scope="row" className={cn(td, "font-medium")}>
                {manager.agentName}
              </th>
              <td className={td}>{manager.floorName}</td>
              <td className={td}>
                <Badge tone={manager.phase === "writing" ? "info" : "violet"}>
                  {phaseText[manager.phase]}
                </Badge>
              </td>
              <td className={cn(td, "tabular-nums")}>
                <time dateTime={manager.since} title={manager.since}>
                  {elapsedText(manager.since, now)}
                </time>
              </td>
              <td className={cn(td, "text-right")}>
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
      <table className="w-full text-left text-sm whitespace-nowrap">
        <caption className="sr-only">Agents&apos; work</caption>
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className={th}>
              Agent
            </th>
            <th scope="col" className={th}>
              Floor
            </th>
            <th scope="col" className={th}>
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
            return (
              <tr key={item.id} className="border-b">
                <th scope="row" className={cn(td, "font-medium")}>
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
                <td className={td}>{item.floorName}</td>
                <td className={td}>
                  <a
                    href={`https://github.com/${item.repository}/issues/${String(item.issue)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono hover:underline"
                  >
                    #{item.issue}
                  </a>
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
                <td className={cn(td, "tabular-nums")}>
                  <time dateTime={since} title={since}>
                    {elapsedText(since, now)}
                  </time>
                </td>
                <td className={cn(td, "text-right")}>
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
 */
export function OverviewPage() {
  const queryClient = useQueryClient();
  const working = useQuery(workingNowQuery);
  const { data: session } = useQuery(sessionQuery);
  const now = useNow();
  const floorFilterId = useId();
  const [floorId, setFloorId] = useState<string>();
  const [stopping, setStopping] = useState<Stopping>();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [stopped, setStopped] = useState<string>();

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
    floorId !== undefined && floors.has(floorId) ? floorId : undefined;
  const onFloor = <T extends { floorId: string }>(rows: T[]) =>
    shownFloor === undefined
      ? rows
      : rows.filter((row) => row.floorId === shownFloor);
  const managers = onFloor(data?.managers ?? []);
  const work = onFloor(data?.work ?? []);
  const running = work.filter(({ status }) => status === "running");
  const queued = work.filter(({ status }) => status === "queued");

  const stop = async (what: Stopping) => {
    setPending(true);
    setProblem(undefined);
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
        return;
      }
      if (response.status === 404) {
        // It ended meanwhile: nothing to stop.
        setStopped(`${whoOf(what)} had already finished.`);
        setStopping(undefined);
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

  const nothing = data !== undefined && managers.length + work.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Every Agent and Manager at work across your Floors, live. Stop any one of them here; the rest carry on."
        actions={
          <>
            <span className="text-xs text-muted-foreground">
              Updates every {workingNowRefreshMs / 1000} seconds
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

      {working.isPending && (
        <LoadingMessage className="text-sm">
          Looking at what everyone is doing…
        </LoadingMessage>
      )}
      {working.isError && (
        <p role="alert" className="text-sm text-destructive">
          What is going on could not be loaded. It is tried again every few
          seconds.
        </p>
      )}

      {data !== undefined && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <dl className="grid flex-1 grid-cols-3 gap-3 sm:max-w-xl">
              <Tally label="Agents working" count={running.length} />
              <Tally label="Queued" count={queued.length} />
              <Tally label="Managers answering" count={managers.length} />
            </dl>
            {floors.size > 1 && (
              <div className="space-y-1">
                <Label htmlFor={floorFilterId}>Floor</Label>
                <select
                  id={floorFilterId}
                  className={cn(selectClass, "sm:w-56")}
                  value={shownFloor ?? ""}
                  onChange={(event) => {
                    setFloorId(
                      event.target.value === ""
                        ? undefined
                        : event.target.value,
                    );
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

          {nothing ? (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <p className="font-medium">Nothing is going on right now.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Work shows here as soon as an Agent picks up an issue or a
                Manager starts answering.{" "}
                <Link to="/" className="underline underline-offset-4">
                  Go to the Office
                </Link>
              </p>
            </div>
          ) : (
            <>
              <section aria-labelledby="working-managers" className="space-y-2">
                <h2 id="working-managers" className="text-lg font-semibold">
                  Managers
                </h2>
                {managers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No Manager is answering.
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
              <section aria-labelledby="working-agents" className="space-y-2">
                <h2 id="working-agents" className="text-lg font-semibold">
                  Agents
                </h2>
                {work.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No Agent has work running or queued.
                  </p>
                ) : (
                  <WorkTable
                    work={[...running, ...queued]}
                    now={now}
                    onStop={(item) => {
                      setProblem(undefined);
                      setStopping({ kind: "work", work: item });
                    }}
                  />
                )}
              </section>
            </>
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
          <p className="text-sm">
            {stopping.work.status === "running"
              ? "Its sandbox is stopped at once and the work is cancelled: it does not start again by itself."
              : "It is taken out of the queue and never starts."}{" "}
            The rest of {stopping.work.floorName} carries on.
          </p>
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
