import {
  analyticsBreakdownSchema,
  analyticsDimensionLabels,
  analyticsDimensions,
  analyticsInsightsSchema,
  analyticsSeriesSchema,
  analyticsUsageWindowsSchema,
  nearLimitPercent,
  usageWindowLabels,
  type AnalyticsBucket,
  type AnalyticsDimension,
  type AnalyticsSeries,
  type AnalyticsTotals,
} from "@ai-office/shared";
import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { AlertTriangle, Check, OctagonAlert, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import {
  BarList,
  ChartTable,
  Meter,
  TimeChart,
  usageWindowSeries,
  type ChartSeries,
} from "./analytics-charts.tsx";
import { AgentLink } from "./agent-link.tsx";
import { getJson } from "./api.ts";
import { useFloorNames } from "./floors.ts";
import { useStoredLayout, WidgetGrid, type Widget } from "./widget-grid.tsx";
import type { WidgetLayout } from "./widget-layout.ts";

// The AI Gateway's analytics dashboards (PRD FR-43): for a time range,
// the headline totals; requests, tokens by type, estimated cost, latency
// and error rate over time; a breakdown by AI Account, AI Provider, Model,
// Floor, Agent, issue or Owner tool; insights (the top consumers, and the
// AI Accounts close to their limits); and each account's usage-window
// history. The range is the one filter, above everything it scopes.

/** The ranges the dashboard offers, newest last. */
export const analyticsRanges = {
  "24h": { label: "Last 24 hours", bucket: "hour", count: 24 },
  "7d": { label: "Last 7 days", bucket: "day", count: 7 },
  "30d": { label: "Last 30 days", bucket: "day", count: 30 },
  "90d": { label: "Last 90 days", bucket: "day", count: 90 },
} as const satisfies Record<
  string,
  { label: string; bucket: AnalyticsBucket; count: number }
>;
export type AnalyticsRange = keyof typeof analyticsRanges;

/**
 * A range's bounds as of `now`: whole hours or days (UTC), ending with the
 * current one, so every bucket is a full one.
 */
export function rangeBounds(
  range: AnalyticsRange,
  now: Date,
): { from: string; to: string; bucket: AnalyticsBucket } {
  const { bucket, count } = analyticsRanges[range];
  const end = new Date(now);
  if (bucket === "day") {
    end.setUTCHours(24, 0, 0, 0);
  } else {
    end.setUTCMinutes(60, 0, 0);
  }
  const step = bucket === "day" ? 86_400_000 : 3_600_000;
  return {
    from: new Date(end.getTime() - count * step).toISOString(),
    to: end.toISOString(),
    bucket,
  };
}

const search = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();

const seriesQuery = (from: string, to: string, bucket: AnalyticsBucket) =>
  queryOptions({
    queryKey: ["analytics", "series", from, to, bucket],
    queryFn: () =>
      getJson(
        `/api/analytics/series?${search({ from, to, bucket })}`,
        analyticsSeriesSchema,
      ),
    placeholderData: keepPreviousData,
  });

const breakdownQuery = (from: string, to: string, by: AnalyticsDimension) =>
  queryOptions({
    queryKey: ["analytics", "breakdown", from, to, by],
    queryFn: () =>
      getJson(
        `/api/analytics/breakdown?${search({ from, to, by })}`,
        analyticsBreakdownSchema,
      ),
    placeholderData: keepPreviousData,
  });

const insightsQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ["analytics", "insights", from, to],
    queryFn: () =>
      getJson(
        `/api/analytics/insights?${search({ from, to })}`,
        analyticsInsightsSchema,
      ),
    placeholderData: keepPreviousData,
  });

const usageWindowsQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ["analytics", "usage-windows", from, to],
    queryFn: () =>
      getJson(
        `/api/analytics/usage-windows?${search({ from, to })}`,
        analyticsUsageWindowsSchema,
      ),
    placeholderData: keepPreviousData,
  });

// Numbers as the dashboard says them.
const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const wholeFormat = new Intl.NumberFormat("en-US");
export const compact = (value: number): string => compactFormat.format(value);
export const dollars = (value: number): string =>
  value === 0
    ? "$0"
    : value < 0.01
      ? "<$0.01"
      : `$${value.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
export const latency = (ms: number): string =>
  ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;
export const percent = (share: number): string =>
  `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`;

const resetFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** A stat tile: a label, its value, and what is under it. */
function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | undefined;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {note === undefined ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{note}</p>
      )}
    </div>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="h-full gap-4">
      <CardHeader className="pr-12">
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** The charts over time, from the series: a widget each. */
function overTimeWidgets(series: AnalyticsSeries): Widget[] {
  const times = series.points.map(({ at }) => at);
  const { bucket, points } = series;
  const one = (
    key: string,
    label: string,
    values: (number | null)[],
  ): ChartSeries[] => [{ key, label, color: "var(--viz-series-1)", values }];
  const per = bucket === "day" ? "day" : "hour";
  return [
    {
      id: "requests",
      title: "Requests",
      content: (
        <ChartCard
          title="Requests"
          description={`Requests through the Gateway each ${per}.`}
        >
          <TimeChart
            label="Requests"
            times={times}
            bucket={bucket}
            kind="columns"
            format={compact}
            series={one(
              "requests",
              "Requests",
              points.map(({ requests }) => requests),
            )}
          />
        </ChartCard>
      ),
    },
    {
      id: "tokens",
      title: "Tokens by type",
      content: (
        <ChartCard
          title="Tokens by type"
          description="Input and output count towards Token Caps; cache reads and writes are shown apart."
        >
          <TimeChart
            label="Tokens by type"
            times={times}
            bucket={bucket}
            kind="stacked"
            format={compact}
            series={[
              {
                key: "input",
                label: "Input",
                color: "var(--viz-series-1)",
                values: points.map(({ inputTokens }) => inputTokens),
              },
              {
                key: "output",
                label: "Output",
                color: "var(--viz-series-2)",
                values: points.map(({ outputTokens }) => outputTokens),
              },
              {
                key: "cache-read",
                label: "Cache read",
                color: "var(--viz-series-3)",
                values: points.map(({ cacheReadTokens }) => cacheReadTokens),
              },
              {
                key: "cache-write",
                label: "Cache write",
                color: "var(--viz-series-4)",
                values: points.map(({ cacheWriteTokens }) => cacheWriteTokens),
              },
            ]}
          />
        </ChartCard>
      ),
    },
    {
      id: "cost",
      title: "Estimated cost",
      content: (
        <ChartCard
          title="Estimated cost"
          description="In US dollars, from each Model's price; for information only."
        >
          <TimeChart
            label="Estimated cost"
            times={times}
            bucket={bucket}
            kind="lines"
            format={dollars}
            series={one(
              "cost",
              "Estimated cost",
              points.map(({ estimatedCostUsd }) => estimatedCostUsd),
            )}
          />
        </ChartCard>
      ),
    },
    {
      id: "latency",
      title: "Latency",
      content: (
        <ChartCard
          title="Latency"
          description={`The mean time to answer, each ${per}.`}
        >
          <TimeChart
            label="Mean latency"
            times={times}
            bucket={bucket}
            kind="lines"
            format={latency}
            series={one(
              "latency",
              "Mean latency",
              points.map(({ averageLatencyMs }) => averageLatencyMs),
            )}
          />
        </ChartCard>
      ),
    },
    {
      id: "errors",
      title: "Error rate",
      content: (
        <ChartCard
          title="Error rate"
          description="The share of requests answered with a status of 400 or more."
        >
          <TimeChart
            label="Error rate"
            times={times}
            bucket={bucket}
            kind="lines"
            format={percent}
            series={one(
              "errors",
              "Error rate",
              points.map(({ requests, errorRate }) =>
                requests === 0 ? null : errorRate,
              ),
            )}
          />
        </ChartCard>
      ),
    },
    {
      id: "keep-alives",
      title: "Prompt-cache keep-alives",
      content: (
        <ChartCard
          title="Prompt-cache keep-alives"
          description={`The requests the Gateway sent itself each ${per} to keep Agents' prompt caches warm; counted in the requests above.`}
        >
          <TimeChart
            label="Prompt-cache keep-alives"
            times={times}
            bucket={bucket}
            kind="columns"
            format={compact}
            series={one(
              "keep-alives",
              "Keep-alives",
              points.map(({ keepAliveRequests }) => keepAliveRequests),
            )}
          />
        </ChartCard>
      ),
    },
    {
      id: "time-to-first-byte",
      title: "Time to first byte",
      content: (
        <ChartCard
          title="Time to first byte"
          description={`How soon answers began to arrive, on average, each ${per}.`}
        >
          <TimeChart
            label="Mean time to first byte"
            times={times}
            bucket={bucket}
            kind="lines"
            format={latency}
            series={one(
              "time-to-first-byte",
              "Mean time to first byte",
              points.map(
                ({ averageTimeToFirstByteMs }) => averageTimeToFirstByteMs,
              ),
            )}
          />
        </ChartCard>
      ),
    },
    {
      id: "cache-reads",
      title: "Cache reads",
      content: (
        <ChartCard
          title="Cache reads"
          description={`The share of input tokens served from the prompt cache, each ${per}.`}
        >
          <TimeChart
            label="Cache read share"
            times={times}
            bucket={bucket}
            kind="lines"
            max={1}
            format={percent}
            series={one(
              "cache-reads",
              "Cache read share",
              points.map((point) => cacheReadShare(point)),
            )}
          />
        </ChartCard>
      ),
    },
  ];
}

function Breakdown({
  from,
  to,
  by,
  onByChange,
}: {
  from: string;
  to: string;
  by: AnalyticsDimension;
  onByChange: (by: AnalyticsDimension) => void;
}) {
  const { data, isFetching } = useQuery(breakdownQuery(from, to, by));
  const name = analyticsDimensionLabels[by];
  return (
    <section className="h-full space-y-3" aria-labelledby="breakdown-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="breakdown-heading" className="text-lg font-semibold">
          Breakdown by
        </h2>
        <select
          aria-label="Break down by"
          className={cn(selectClass, "w-auto")}
          value={by}
          onChange={(event) => {
            onByChange(event.target.value as AnalyticsDimension);
          }}
        >
          {analyticsDimensions.map((dimension) => (
            <option key={dimension} value={dimension}>
              {analyticsDimensionLabels[dimension]}
            </option>
          ))}
        </select>
      </div>
      <Card className={cn("gap-4", isFetching && "opacity-60")}>
        <CardHeader>
          <CardTitle>
            <h3>Tokens by {name}</h3>
          </CardTitle>
          <CardDescription>
            Input plus output tokens, most first.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data === undefined ? (
            <LoadingMessage className="text-sm">Loading…</LoadingMessage>
          ) : (
            <>
              <BarList
                label={`Tokens by ${name}`}
                format={compact}
                items={data.items.map((item) => ({
                  key: JSON.stringify([item.key, item.floorId]),
                  label: item.label,
                  value: item.tokens,
                  details: [
                    { label: "tokens", value: wholeFormat.format(item.tokens) },
                    {
                      label: "requests",
                      value: wholeFormat.format(item.requests),
                    },
                    {
                      label: "estimated cost",
                      value: dollars(item.estimatedCostUsd),
                    },
                  ],
                }))}
              />
              <ChartTable
                caption={`Requests by ${name}`}
                columns={[
                  name,
                  "Requests",
                  "Tokens",
                  "Cache read",
                  "Cache write",
                  "Estimated cost",
                  "Mean latency",
                  "Error rate",
                ]}
                rows={data.items.map((item) => [
                  item.label,
                  wholeFormat.format(item.requests),
                  wholeFormat.format(item.tokens),
                  wholeFormat.format(item.cacheReadTokens),
                  wholeFormat.format(item.cacheWriteTokens),
                  dollars(item.estimatedCostUsd),
                  item.averageLatencyMs === null
                    ? "–"
                    : latency(item.averageLatencyMs),
                  percent(item.errorRate),
                ])}
              />
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** The share of input tokens served from the prompt cache; null with none. */
export const cacheReadShare = (
  item: Pick<AnalyticsTotals, "inputTokens" | "cacheReadTokens">,
): number | null => {
  const all = item.inputTokens + item.cacheReadTokens;
  return all === 0 ? null : item.cacheReadTokens / all;
};

const dash = "–";

/**
 * How each Floor, Agent, AI Provider, AI Account or Model performed and
 * what it used over the range: requests, its share of the tokens, cost,
 * mean latency and time to first byte, error rate and cache reads; most
 * tokens first. Agents also show the busiest, by requests.
 */
function Performance({
  from,
  to,
  by,
  title,
  description,
}: {
  from: string;
  to: string;
  by: AnalyticsDimension;
  title: string;
  description: string;
}) {
  const { data, isFetching } = useQuery(breakdownQuery(from, to, by));
  const name = analyticsDimensionLabels[by];
  const allTokens =
    data?.items.reduce((sum, { tokens }) => sum + tokens, 0) ?? 0;
  const busiest = [...(data?.items ?? [])]
    .filter(({ requests }) => requests > 0)
    .sort((a, b) => b.requests - a.requests);
  return (
    <div className={cn("h-full", isFetching && "opacity-60")}>
      <ChartCard title={title} description={description}>
        {data === undefined ? null : data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No requests in this range.
          </p>
        ) : (
          <div className="space-y-4">
            {by === "agent" ? (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Busiest, by requests</h3>
                <BarList
                  label={`The busiest ${name}s, by requests`}
                  format={compact}
                  limit={5}
                  items={busiest.map((item) => ({
                    key: JSON.stringify([item.key, item.floorId]),
                    label: item.label,
                    value: item.requests,
                    details: [
                      {
                        label: "requests",
                        value: wholeFormat.format(item.requests),
                      },
                    ],
                  }))}
                />
              </div>
            ) : null}
            <TableFrame label={`${title}, scrollable`}>
              <table className="w-full text-left text-sm tabular-nums">
                <caption className="sr-only">
                  {title}: each {name}&apos;s usage and performance
                </caption>
                <thead className="text-muted-foreground">
                  <tr>
                    {[
                      name,
                      "Requests",
                      "Share of tokens",
                      "Tokens",
                      "Estimated cost",
                      "Mean latency",
                      "Time to first byte",
                      "Error rate",
                      "Cache reads",
                    ].map((column) => (
                      <th
                        key={column}
                        scope="col"
                        className="py-1 pr-3 font-medium whitespace-nowrap"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.items.map((item) => {
                    const cached = cacheReadShare(item);
                    const share = allTokens === 0 ? 0 : item.tokens / allTokens;
                    return (
                      <tr key={JSON.stringify([item.key, item.floorId])}>
                        <th scope="row" className="py-1 pr-3 font-medium">
                          {item.label}
                        </th>
                        <td className="py-1 pr-3">
                          {wholeFormat.format(item.requests)}
                        </td>
                        <td className="py-1 pr-3">
                          <span className="flex items-center gap-2">
                            <span className="w-24">
                              <Meter
                                value={share}
                                max={1}
                                label={`${item.label}'s share of the tokens`}
                              />
                            </span>
                            {percent(share)}
                          </span>
                        </td>
                        <td className="py-1 pr-3">{compact(item.tokens)}</td>
                        <td className="py-1 pr-3">
                          {dollars(item.estimatedCostUsd)}
                        </td>
                        <td className="py-1 pr-3">
                          {item.averageLatencyMs === null
                            ? dash
                            : latency(item.averageLatencyMs)}
                        </td>
                        <td className="py-1 pr-3">
                          {item.averageTimeToFirstByteMs === null
                            ? dash
                            : latency(item.averageTimeToFirstByteMs)}
                        </td>
                        <td className="py-1 pr-3">{percent(item.errorRate)}</td>
                        <td className="py-1 pr-3">
                          {cached === null ? dash : percent(cached)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableFrame>
          </div>
        )}
      </ChartCard>
    </div>
  );
}

/** The performance widgets: Floors, Agents, AI Providers, AI Accounts and Models. */
const performanceWidgets = (from: string, to: string): Widget[] =>
  (
    [
      [
        "floors",
        "floor",
        "Floors",
        "Each Floor's requests, share of the tokens, cost, speed and errors.",
      ],
      [
        "agents",
        "agent",
        "Agents",
        "Each Agent's usage and performance, and the busiest by requests.",
      ],
      [
        "ai-providers",
        "ai_provider",
        "AI Providers",
        "How each AI Provider answered: speed, errors and cache reads.",
      ],
      [
        "ai-accounts",
        "ai_account",
        "AI Accounts",
        "What each AI Account served, and how well.",
      ],
      [
        "models",
        "model",
        "Models",
        "Each Model's usage, cost, speed and errors.",
      ],
    ] as const
  ).map(([id, by, title, description]) => ({
    id,
    title,
    content: (
      <Performance
        from={from}
        to={to}
        by={by}
        title={title}
        description={description}
      />
    ),
  }));

function TopConsumers({ from, to }: { from: string; to: string }) {
  const { data, isFetching } = useQuery(insightsQuery(from, to));
  const floorName = useFloorNames();
  return (
    <div className={cn("h-full", isFetching && "opacity-60")}>
      <ChartCard
        title="Top consumers"
        description="The Agents and Owner tools that used the most tokens."
      >
        {data === undefined ? null : data.topConsumers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing used tokens in this range.
          </p>
        ) : (
          <ol className="space-y-3">
            {data.topConsumers.map((consumer) => (
              <li
                key={`${consumer.kind}:${consumer.key}`}
                className="space-y-1"
              >
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {consumer.kind === "agent" && consumer.floorId !== null ? (
                      <span className="font-medium">
                        <AgentLink
                          floorId={consumer.floorId}
                          agentId={consumer.key}
                        >
                          {() => consumer.label}
                        </AgentLink>
                      </span>
                    ) : (
                      <span className="font-medium">{consumer.label}</span>
                    )}{" "}
                    <span className="text-muted-foreground">
                      {consumer.kind === "agent"
                        ? `Agent on ${
                            consumer.floorId === null
                              ? "a Floor"
                              : floorName(consumer.floorId)
                          }`
                        : "Owner tool"}
                    </span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {compact(consumer.tokens)} tokens ·{" "}
                    {percent(consumer.share)}
                  </span>
                </div>
                <Meter
                  value={consumer.share}
                  max={1}
                  label={`${consumer.label}'s share of the tokens`}
                />
              </li>
            ))}
          </ol>
        )}
      </ChartCard>
    </div>
  );
}

function AccountsNearLimits({ from, to }: { from: string; to: string }) {
  const { data, isFetching } = useQuery(insightsQuery(from, to));
  return (
    <div className={cn("h-full", isFetching && "opacity-60")}>
      <ChartCard
        title="AI Accounts near their limits"
        description={`Usage windows at ${String(nearLimitPercent)}% or more, and accounts held back now.`}
      >
        {data === undefined ? null : data.accountsNearLimits.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Check aria-hidden className="size-4" />
            No AI Account is close to a limit.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.accountsNearLimits.map((account) => (
              <li key={account.accountId} className="space-y-1 text-sm">
                <p className="font-medium">
                  {account.name}{" "}
                  <span className="font-normal text-muted-foreground">
                    {account.aiProvider}
                  </span>
                </p>
                {account.limitReason === null ? null : (
                  <p className="flex items-center gap-2">
                    <OctagonAlert
                      aria-hidden
                      className="size-4"
                      style={{ color: "var(--viz-status-critical)" }}
                    />
                    Held back ({account.limitReason.replaceAll("_", " ")})
                    {account.limitedUntil === null
                      ? ""
                      : ` until ${resetFormat.format(new Date(account.limitedUntil))} UTC`}
                  </p>
                )}
                {account.windows.map((window) => (
                  <div key={window.window} className="viz space-y-1">
                    <p className="flex items-center gap-2">
                      <AlertTriangle
                        aria-hidden
                        className="size-4"
                        style={{
                          color:
                            window.utilization >= 100
                              ? "var(--viz-status-critical)"
                              : "var(--viz-status-warning)",
                        }}
                      />
                      {usageWindowLabels[window.window]} window{" "}
                      {String(Math.round(window.utilization))}% used, resets{" "}
                      {resetFormat.format(new Date(window.resetsAt))} UTC
                    </p>
                    <Meter
                      value={window.utilization}
                      max={100}
                      color={
                        window.utilization >= 100
                          ? "var(--viz-status-critical)"
                          : "var(--viz-status-warning)"
                      }
                      label={`${account.name}'s ${usageWindowLabels[window.window]} window`}
                    />
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </ChartCard>
    </div>
  );
}

function UsageWindows({
  from,
  to,
  series,
}: {
  from: string;
  to: string;
  series: AnalyticsSeries;
}) {
  const { data } = useQuery(usageWindowsQuery(from, to));
  const times = series.points.map(({ at }) => at);
  return (
    <section
      className="h-full space-y-3"
      aria-labelledby="usage-windows-heading"
    >
      <h2 id="usage-windows-heading" className="text-lg font-semibold">
        Usage-window history
      </h2>
      {data === undefined ? null : data.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No AI Account reported a usage window in this range. Subscriptions
          report theirs with each answer; API keys have none.
        </p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          {data.accounts.map((account) => (
            <ChartCard
              key={account.accountId}
              title={account.name}
              description={`${account.aiProvider}: the share of each window used, the highest reading each ${series.bucket}.`}
            >
              <TimeChart
                label={`${account.name}'s usage windows`}
                times={times}
                bucket={series.bucket}
                kind="lines"
                connectGaps
                max={100}
                format={(value) => `${String(Math.round(value))}%`}
                series={usageWindowSeries(account.readings, times)}
              />
            </ChartCard>
          ))}
        </div>
      )}
    </section>
  );
}

// Drawn the same way for one account in AI Settings.
export { usageWindowSeries } from "./analytics-charts.tsx";

/** Where this browser keeps the analytics widgets' layout. */
export const analyticsLayoutKey = "ai-office:analytics-layout";

/**
 * Where each analytics widget starts: the totals across the top, the
 * charts two by two (the prompt-cache keep-alives among them), then the
 * insights, how each Floor, Agent, AI
 * Provider, AI Account and Model performed, the breakdown and the usage
 * windows.
 */
export const defaultAnalyticsLayout: WidgetLayout = {
  // Two rows of three totals; it grows if they take more.
  totals: { x: 0, y: 0, w: 12, h: 6 },
  requests: { x: 0, y: 6, w: 6, h: 8 },
  tokens: { x: 6, y: 6, w: 6, h: 8 },
  cost: { x: 0, y: 14, w: 6, h: 8 },
  latency: { x: 6, y: 14, w: 6, h: 8 },
  errors: { x: 0, y: 22, w: 6, h: 8 },
  "top-consumers": { x: 6, y: 22, w: 6, h: 8 },
  "time-to-first-byte": { x: 0, y: 30, w: 6, h: 8 },
  "cache-reads": { x: 6, y: 30, w: 6, h: 8 },
  "keep-alives": { x: 0, y: 38, w: 6, h: 8 },
  "near-limits": { x: 6, y: 38, w: 6, h: 8 },
  floors: { x: 0, y: 46, w: 12, h: 8 },
  agents: { x: 0, y: 54, w: 12, h: 11 },
  "ai-providers": { x: 0, y: 65, w: 6, h: 8 },
  "ai-accounts": { x: 6, y: 65, w: 6, h: 8 },
  models: { x: 0, y: 73, w: 12, h: 8 },
  breakdown: { x: 0, y: 81, w: 12, h: 6 },
  "usage-windows": { x: 0, y: 87, w: 12, h: 9 },
};

export function AnalyticsPage({
  range,
  by,
  onChange,
  now = () => new Date(),
}: {
  range: AnalyticsRange;
  by: AnalyticsDimension;
  onChange: (next: { range: AnalyticsRange; by: AnalyticsDimension }) => void;
  now?: () => Date;
}) {
  // The bounds stay put while the page is open, so queries do not chase
  // the clock; choosing a range again reads afresh.
  const [anchor, setAnchor] = useState(now);
  const { from, to, bucket } = rangeBounds(range, anchor);
  const series = useQuery(seriesQuery(from, to, bucket));
  const totals = series.data?.totals;
  const { layout, setLayout, reset, changed } = useStoredLayout(
    analyticsLayoutKey,
    defaultAnalyticsLayout,
  );
  return (
    <section className="space-y-6">
      <PageHeader
        title="Analytics"
        description={
          <>
            The AI Gateway's requests, tokens, costs, latency and errors, and
            the prompt-cache keep-alives it sent. Times are in UTC.
          </>
        }
      />
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Time range"
      >
        {(Object.keys(analyticsRanges) as AnalyticsRange[]).map((key) => (
          <Button
            key={key}
            variant="outline"
            aria-pressed={key === range}
            onClick={() => {
              setAnchor(now());
              onChange({ range: key, by });
            }}
            className={cn(
              "font-normal",
              key === range && "bg-accent font-semibold text-accent-foreground",
            )}
          >
            {key === range ? <Check aria-hidden /> : null}
            {analyticsRanges[key].label}
          </Button>
        ))}
      </div>
      {series.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The analytics could not be read.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Drag a widget by its grip to move it, or by its corner to resize it.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!changed}
          onClick={reset}
        >
          <RotateCcw aria-hidden />
          Reset layout
        </Button>
      </div>
      <WidgetGrid
        label="Analytics widgets"
        layout={layout}
        onLayoutChange={setLayout}
        widgets={[
          {
            id: "totals",
            title: "Totals",
            // Every total shows, however many lines they take.
            fitContent: true,
            content: (
              <div
                className={cn(
                  "grid gap-4 pr-10 sm:grid-cols-3 2xl:grid-cols-6",
                  series.isFetching && "opacity-60",
                )}
              >
                <StatTile
                  label="Requests"
                  value={totals === undefined ? "–" : compact(totals.requests)}
                />
                <StatTile
                  label="Tokens"
                  value={totals === undefined ? "–" : compact(totals.tokens)}
                  note={
                    totals === undefined
                      ? undefined
                      : `${compact(totals.cacheReadTokens)} cache read, ${compact(totals.cacheWriteTokens)} cache write`
                  }
                />
                <StatTile
                  label="Estimated cost"
                  value={
                    totals === undefined
                      ? "–"
                      : dollars(totals.estimatedCostUsd)
                  }
                />
                <StatTile
                  label="Mean latency"
                  value={
                    totals?.averageLatencyMs === null || totals === undefined
                      ? "–"
                      : latency(totals.averageLatencyMs)
                  }
                />
                <StatTile
                  label="Keep-alives"
                  value={
                    totals === undefined
                      ? "–"
                      : compact(totals.keepAliveRequests)
                  }
                  note={
                    totals === undefined
                      ? undefined
                      : `${dollars(totals.keepAliveCostUsd)} to keep prompt caches warm`
                  }
                />
                <StatTile
                  label="Error rate"
                  value={totals === undefined ? "–" : percent(totals.errorRate)}
                  note={
                    totals === undefined
                      ? undefined
                      : `${wholeFormat.format(totals.errors)} of ${wholeFormat.format(totals.requests)} requests`
                  }
                />
              </div>
            ),
          },
          ...(series.data === undefined
            ? []
            : overTimeWidgets(series.data).map((widget) => ({
                ...widget,
                content: (
                  <div
                    className={cn("h-full", series.isFetching && "opacity-60")}
                  >
                    {widget.content}
                  </div>
                ),
              }))),
          {
            id: "top-consumers",
            title: "Top consumers",
            content: <TopConsumers from={from} to={to} />,
          },
          {
            id: "near-limits",
            title: "AI Accounts near their limits",
            content: <AccountsNearLimits from={from} to={to} />,
          },
          ...performanceWidgets(from, to),
          {
            id: "breakdown",
            title: "Breakdown",
            content: (
              <Breakdown
                from={from}
                to={to}
                by={by}
                onByChange={(next) => {
                  onChange({ range, by: next });
                }}
              />
            ),
          },
          ...(series.data === undefined
            ? []
            : [
                {
                  id: "usage-windows",
                  title: "Usage-window history",
                  content: (
                    <UsageWindows from={from} to={to} series={series.data} />
                  ),
                },
              ]),
        ]}
      />
    </section>
  );
}
