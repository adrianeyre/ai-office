import {
  gatewayEndpoints,
  gatewayLogLineSchema,
  gatewayRequestDetailSchema,
  gatewayRequestListSchema,
  gatewayRequestSummarySchema,
  type GatewayEndpointName,
  type GatewayLogLine,
  type GatewayRequestSummary,
} from "@ai-office/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { LoadingMessage, Spinner } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { AgentLink } from "./agent-link.tsx";
import { getJson } from "./api.ts";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { useFloorNames } from "./floors.ts";

// Request history (PRD FR-44): every request through the AI Gateway,
// searchable and filterable, new ones streaming in at the top; one
// request's detail; and the Gateway's own log, live.

/** The request list's filters, as the address keeps them. */
export interface RequestFilters {
  readonly q?: string | undefined;
  readonly status?: "2xx" | "3xx" | "4xx" | "5xx" | undefined;
  readonly endpoint?: GatewayEndpointName | undefined;
  readonly floorId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly ownerTool?: string | undefined;
}

const queryString = (fields: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

/** The first page of requests (`GET /api/gateway/requests`). */
export const requestsQuery = (filters: RequestFilters) =>
  queryOptions({
    queryKey: ["gateway", "requests", filters],
    queryFn: () =>
      getJson(
        `/api/gateway/requests${queryString({ ...filters })}`,
        gatewayRequestListSchema,
      ),
  });

/** One request (`GET /api/gateway/requests/:id`). */
export const requestQuery = (id: number) =>
  queryOptions({
    queryKey: ["gateway", "requests", "one", id],
    queryFn: () =>
      getJson(
        `/api/gateway/requests/${String(id)}`,
        gatewayRequestDetailSchema,
      ),
  });

/** How long to wait before opening a stream again that the browser gave up. */
const reopenAfterMs = 2000;

/**
 * Keeps a server-sent event stream open at `url` while `url` is given,
 * telling `onData` each message's parsed data. The browser reconnects by
 * itself, resuming after the last id; one it gives up on is opened again.
 */
export function useServerSentData(
  url: string | undefined,
  onData: (data: unknown) => void,
): boolean {
  const handler = useRef(onData);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    handler.current = onData;
  });
  useEffect(() => {
    if (url === undefined) {
      return;
    }
    let source: EventSourceLike | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      source = eventSources.open(url);
      source.onopen = () => {
        setOpen(true);
      };
      source.onmessage = (message) => {
        try {
          handler.current(JSON.parse(message.data));
        } catch {
          // Not this stream's: ignored.
        }
      };
      source.onerror = () => {
        setOpen(false);
        if (source?.readyState === 2 && !stopped) {
          timer = setTimeout(connect, reopenAfterMs);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
      setOpen(false);
    };
  }, [url]);
  return open;
}

const formatNumber = (value: number | null): string =>
  value === null ? "–" : value.toLocaleString("en-GB");

const formatCost = (value: number | null): string =>
  value === null
    ? "–"
    : `$${value.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

const endpointLabel: Record<GatewayEndpointName, string> = {
  messages: "Messages",
  count_tokens: "Count tokens",
  chat_completions: "Chat Completions",
  responses: "Responses",
  responses_compact: "Responses compact",
  systemone: "Decisions (Jev)",
};

const endpointName = (endpoint: string): string =>
  (gatewayEndpoints as readonly string[]).includes(endpoint)
    ? endpointLabel[endpoint as GatewayEndpointName]
    : endpoint;

/** The issue and pull request a request was for, such as "#4, PR #7". */
const workText = (request: GatewayRequestSummary): string | null =>
  request.issue === null && request.pullRequest === null
    ? null
    : [
        ...(request.issue === null ? [] : [`#${String(request.issue)}`]),
        ...(request.pullRequest === null
          ? []
          : [`PR #${String(request.pullRequest)}`]),
      ].join(", ");

/** Who made a request: its Agent (linked) or the Owner's tool, and for what. */
function Caller({ request }: { request: GatewayRequestSummary }) {
  const floorName = useFloorNames();
  const work = workText(request);
  const forWork =
    work === null ? null : (
      <span className="text-muted-foreground"> for {work}</span>
    );
  if (request.agentId !== null && request.floorId !== null) {
    return (
      <>
        <AgentLink floorId={request.floorId} agentId={request.agentId} />{" "}
        <span className="text-muted-foreground">
          on {floorName(request.floorId)}
        </span>
        {forWork}
      </>
    );
  }
  return (
    <>
      {request.ownerTool ?? "–"}
      {forWork}
    </>
  );
}

function StatusBadge({ status }: { status: number }) {
  return (
    <Badge
      className="tabular-nums"
      tone={status >= 500 ? "danger" : status >= 400 ? "warning" : "success"}
    >
      {status}
    </Badge>
  );
}

/** The live Gateway log: the recent lines, then each new one. */
export function GatewayLogPanel() {
  const [lines, setLines] = useState<GatewayLogLine[]>([]);
  const live = useServerSentData("/api/gateway/logs/stream", (data) => {
    const line = gatewayLogLineSchema.safeParse(data);
    if (line.success) {
      setLines((current) =>
        current.some(({ id }) => id === line.data.id)
          ? current
          : [...current, line.data].slice(-200),
      );
    }
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Gateway log</h2>
        </CardTitle>
        <CardDescription>
          The AI Gateway&apos;s own log, live{live ? "" : " (connecting…)"}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
        ) : (
          // Focusable, so the keyboard can scroll it (WCAG 2.1.1).
          <div
            role="region"
            aria-label="Gateway log, scrollable"
            tabIndex={0}
            className="max-h-80 overflow-y-auto rounded-md"
          >
            <ol
              aria-label="Gateway log"
              className="space-y-1 font-mono text-xs"
            >
              {lines.map((line) => (
                <li key={line.id} className="flex gap-2">
                  <time
                    dateTime={line.time}
                    className="shrink-0 text-muted-foreground"
                  >
                    {new Date(line.time).toLocaleTimeString()}
                  </time>
                  <span
                    className={cn(
                      "w-12 shrink-0 uppercase",
                      line.level === "warn" && "text-tone-warning-foreground",
                      (line.level === "error" || line.level === "fatal") &&
                        "text-destructive",
                    )}
                  >
                    {line.level}
                  </span>
                  <span className="min-w-0 break-words">{line.message}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Filters({
  filters,
  onChange,
}: {
  filters: RequestFilters;
  onChange: (next: RequestFilters) => void;
}) {
  const [q, setQ] = useState(filters.q ?? "");
  return (
    <form
      role="search"
      aria-label="Filter Gateway requests"
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ ...filters, q: q.trim() === "" ? undefined : q.trim() });
      }}
    >
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="requests-q">Search</Label>
        <Input
          id="requests-q"
          type="search"
          placeholder="Model, account, tool, Agent or request id"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="requests-status">Status</Label>
        <select
          id="requests-status"
          className={selectClass}
          value={filters.status ?? ""}
          onChange={(event) => {
            onChange({
              ...filters,
              status:
                event.target.value === ""
                  ? undefined
                  : (event.target.value as RequestFilters["status"]),
            });
          }}
        >
          <option value="">Any</option>
          <option value="2xx">2xx: served</option>
          <option value="4xx">4xx: refused</option>
          <option value="5xx">5xx: failed</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="requests-endpoint">Endpoint</Label>
        <select
          id="requests-endpoint"
          className={selectClass}
          value={filters.endpoint ?? ""}
          onChange={(event) => {
            onChange({
              ...filters,
              endpoint:
                event.target.value === ""
                  ? undefined
                  : (event.target.value as GatewayEndpointName),
            });
          }}
        >
          <option value="">Any</option>
          {gatewayEndpoints.map((endpoint) => (
            <option key={endpoint} value={endpoint}>
              {endpointLabel[endpoint]}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="sr-only">
        Search
      </button>
    </form>
  );
}

/**
 * The request history page (PRD FR-44): the requests, newest first, with
 * new ones streaming in at the top, and the Gateway's live log.
 */
export function GatewayRequestsPage({
  filters,
  onFiltersChange,
}: {
  filters: RequestFilters;
  onFiltersChange: (next: RequestFilters) => void;
}) {
  const first = useQuery(requestsQuery(filters));
  const [live, setLive] = useState<GatewayRequestSummary[]>([]);
  const [older, setOlder] = useState<GatewayRequestSummary[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const key = JSON.stringify(filters);
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    // Other filters: start again from their first page.
    setShownKey(key);
    setLive([]);
    setOlder([]);
    setNextBefore(undefined);
  }

  // The stream opens once the first page is read, resuming right after
  // its newest request, so nothing between the two is missed.
  const newest = first.data?.requests[0]?.id ?? 0;
  const streamUrl =
    first.data === undefined
      ? undefined
      : `/api/gateway/requests/stream${queryString({
          ...filters,
          lastEventId: newest,
        })}`;
  const connected = useServerSentData(streamUrl, (data) => {
    const request = gatewayRequestSummarySchema.safeParse(data);
    if (request.success) {
      setLive((current) => [request.data, ...current].slice(0, 500));
    }
  });

  const seen = new Set<number>();
  const requests = [...live, ...(first.data?.requests ?? []), ...older]
    .filter(({ id }) => !seen.has(id) && seen.add(id))
    .sort((a, b) => b.id - a.id);
  const more = nextBefore === undefined ? first.data?.nextBefore : nextBefore;

  const loadOlder = async () => {
    if (more === null || more === undefined) {
      return;
    }
    setLoadingOlder(true);
    try {
      const page = await getJson(
        `/api/gateway/requests${queryString({ ...filters, before: more })}`,
        gatewayRequestListSchema,
      );
      setOlder((current) => [...current, ...page.requests]);
      setNextBefore(page.nextBefore);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <section className="space-y-6">
      <PageHeader
        title="Gateway requests"
        description={
          <>
            Every model call through the AI Gateway, newest first.{" "}
            <span role="status">
              {!connected && (
                <Spinner className="mr-1 inline size-3.5 align-[-2px]" />
              )}
              {connected ? "Live." : "Connecting…"}
            </span>
          </>
        }
      />
      <Filters
        key={key}
        filters={filters}
        onChange={(next) => {
          onFiltersChange(next);
        }}
      />
      {first.isError && (
        <p role="alert" className="text-sm text-destructive">
          The Gateway requests could not be loaded.
        </p>
      )}
      {first.data !== undefined && requests.length === 0 && (
        <p className="text-sm text-muted-foreground">No requests yet.</p>
      )}
      {requests.length > 0 && (
        <TableFrame label="Gateway requests, scrollable">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <caption className="sr-only">Gateway requests</caption>
            <thead className="text-muted-foreground">
              <tr className="border-b">
                {[
                  "Time",
                  "Endpoint",
                  "Model",
                  "Caller",
                  "AI Account",
                  "Status",
                  "Tokens in / out",
                  "Cost",
                  "Latency",
                ].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="py-2 pr-4 font-medium"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr
                  key={request.id}
                  aria-label={`Request ${String(request.id)}`}
                  className="border-b last:border-0"
                >
                  <td className="py-2 pr-4 whitespace-nowrap">
                    <Link
                      to="/gateway/requests/$requestId"
                      params={{ requestId: String(request.id) }}
                      className="hover:underline"
                    >
                      {new Date(request.startedAt).toLocaleString()}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    {endpointName(request.endpoint)}
                    {request.streamed && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (streamed)
                      </span>
                    )}
                    {request.keepAlive && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (keep-alive)
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 font-mono">
                    {request.model ?? "–"}
                  </td>
                  <td className="py-2 pr-4">
                    <Caller request={request} />
                  </td>
                  <td className="py-2 pr-4">{request.account ?? "–"}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={request.status} />
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatNumber(request.inputTokens)} /{" "}
                    {formatNumber(request.outputTokens)}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatCost(request.estimatedCostUsd)}
                  </td>
                  <td className="py-2 tabular-nums">
                    {formatNumber(request.latencyMs)} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
      {more !== null && more !== undefined && (
        <Button
          pending={loadingOlder}
          variant="outline"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
        >
          {loadingOlder ? "Loading…" : "Load older requests"}
        </Button>
      )}
      <GatewayLogPanel />
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function HeadersTable({
  title,
  headers,
}: {
  title: string;
  headers: Record<string, string> | null;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {headers === null ? (
        <p className="text-sm text-muted-foreground">Not kept.</p>
      ) : (
        <table aria-label={title} className="w-full text-left text-xs">
          <tbody>
            {Object.entries(headers)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, value]) => (
                <tr key={name} className="border-b last:border-0">
                  <th scope="row" className="py-1 pr-4 font-mono font-normal">
                    {name}
                  </th>
                  <td className="py-1 font-mono break-all">{value}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** One request's detail (PRD FR-44). */
export function GatewayRequestPage({ requestId }: { requestId: number }) {
  const { data: request, isError } = useQuery(requestQuery(requestId));
  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        There is no such Gateway request.
      </p>
    );
  }
  if (request === undefined) {
    return <LoadingMessage className="text-sm">Loading…</LoadingMessage>;
  }
  return (
    <section className="space-y-6">
      <PageHeader
        title={<>Request {request.id}</>}
        eyebrow={<Link to="/gateway">Gateway requests</Link>}
        description={
          <>
            {endpointName(request.endpoint)} · {request.model ?? "no Model"} ·{" "}
            <StatusBadge status={request.status} />
          </>
        }
      >
        {request.keepAlive && (
          <p className="text-sm text-muted-foreground">
            A prompt-cache keep-alive: the AI Gateway sent it to keep this
            Agent&apos;s prompt cache warm.
          </p>
        )}
      </PageHeader>
      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Started">
              {new Date(request.startedAt).toLocaleString()}
            </Field>
            <Field label="Latency">{formatNumber(request.latencyMs)} ms</Field>
            <Field label="Time to first byte">
              {request.timeToFirstByteMs === null
                ? "–"
                : `${formatNumber(request.timeToFirstByteMs)} ms`}
            </Field>
            <Field label="Input tokens">
              {formatNumber(request.inputTokens)}
            </Field>
            <Field label="Output tokens">
              {formatNumber(request.outputTokens)}
            </Field>
            <Field label="Cache read / write">
              {formatNumber(request.cacheReadInputTokens)} /{" "}
              {formatNumber(request.cacheCreationInputTokens)}
            </Field>
            <Field label="Estimated cost">
              {formatCost(request.estimatedCostUsd)}
            </Field>
            <Field label="AI Account">{request.account ?? "–"}</Field>
            <Field label="Caller">
              <Caller request={request} />
            </Field>
            <Field label="AI Provider's request id">
              <span className="font-mono">
                {request.upstreamRequestId ?? "–"}
              </span>
            </Field>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-6 pt-6 md:grid-cols-2">
          <HeadersTable
            title="Request headers"
            headers={request.requestHeaders}
          />
          <HeadersTable
            title="Response headers"
            headers={request.responseHeaders}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Bodies</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {request.bodies === null ? (
            <p className="text-sm text-muted-foreground">
              Bodies were not kept for this request: body storage was off.
            </p>
          ) : (
            <>
              {request.bodies.truncated && (
                <p className="text-sm text-muted-foreground">
                  A body was longer than the Gateway keeps, and is cut short.
                </p>
              )}
              <section aria-label="Request body" className="space-y-1">
                <h3 className="text-sm font-medium">Request</h3>
                <pre className="max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
                  {request.bodies.request}
                </pre>
              </section>
              <section aria-label="Response body" className="space-y-1">
                <h3 className="text-sm font-medium">Response</h3>
                <pre className="max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
                  {request.bodies.response}
                </pre>
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
