import {
  aiProviderOfModel,
  nearLimitPercent,
  type AccountNearLimit,
  type AnalyticsBreakdown,
  type AnalyticsBucket,
  type AnalyticsDimension,
  type AnalyticsSeries,
  type AnalyticsTotals,
  type TopConsumer,
} from "@ai-office/shared";

import { limitOf, type AiAccountInfo } from "../accounts/accounts.ts";
import { bucketStart, type AnalyticsRow } from "../history/store.ts";

// The AI Gateway's analytics (PRD FR-43), rolled up from the request
// history's finest grain (`analyticsRows`): the totals over time, the
// breakdowns by AI Account, AI Provider, Model, Floor, Agent, issue and
// Owner tool, and the insights. Prompt-cache keep-alives (FR-39) are
// requests like any other, and are also counted apart. Pure functions, so the routes and their
// tests share them.

/** How the analytics name what they count: Floors and Agents by id. */
export interface AnalyticsNames {
  floor(floorId: string): string;
  agent(agentId: string): string;
}

/** A row's sums, before the rates and means are worked out. */
interface Sums {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  timeToFirstByteMs: number;
  timedRequests: number;
  keepAliveRequests: number;
  keepAliveCostUsd: number;
}

const noSums = (): Sums => ({
  requests: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
  latencyMs: 0,
  timeToFirstByteMs: 0,
  timedRequests: 0,
  keepAliveRequests: 0,
  keepAliveCostUsd: 0,
});

const add = (sums: Sums, row: AnalyticsRow): Sums => {
  sums.requests += row.requests;
  sums.errors += row.errors;
  sums.inputTokens += row.inputTokens;
  sums.outputTokens += row.outputTokens;
  sums.cacheReadTokens += row.cacheReadTokens;
  sums.cacheWriteTokens += row.cacheWriteTokens;
  sums.estimatedCostUsd += row.estimatedCostUsd;
  sums.latencyMs += row.latencyMs;
  sums.timeToFirstByteMs += row.timeToFirstByteMs ?? 0;
  sums.timedRequests += row.timedRequests ?? 0;
  sums.keepAliveRequests += row.keepAliveRequests;
  sums.keepAliveCostUsd += row.keepAliveCostUsd;
  return sums;
};

/** Costs to a ten-thousandth of a cent, so sums do not drift. */
const dollars = (value: number): number => Math.round(value * 1e6) / 1e6;

const totalsOf = (sums: Sums): AnalyticsTotals => ({
  requests: sums.requests,
  errors: sums.errors,
  errorRate: sums.requests === 0 ? 0 : sums.errors / sums.requests,
  inputTokens: sums.inputTokens,
  outputTokens: sums.outputTokens,
  cacheReadTokens: sums.cacheReadTokens,
  cacheWriteTokens: sums.cacheWriteTokens,
  tokens: sums.inputTokens + sums.outputTokens,
  estimatedCostUsd: dollars(sums.estimatedCostUsd),
  averageLatencyMs:
    sums.requests === 0 ? null : Math.round(sums.latencyMs / sums.requests),
  averageTimeToFirstByteMs:
    sums.timedRequests === 0
      ? null
      : Math.round(sums.timeToFirstByteMs / sums.timedRequests),
  keepAliveRequests: sums.keepAliveRequests,
  keepAliveCostUsd: dollars(sums.keepAliveCostUsd),
});

const stepMs: Record<AnalyticsBucket, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/**
 * The totals for [`from`, `to`), and for every bucket in it, oldest
 * first: empty buckets too, so a chart's time axis has no gaps.
 */
export function seriesOf(
  rows: readonly AnalyticsRow[],
  from: Date,
  to: Date,
  bucket: AnalyticsBucket,
): AnalyticsSeries {
  const buckets = new Map<number, Sums>();
  for (
    let at = bucketStart(from, bucket).getTime();
    at < to.getTime();
    at += stepMs[bucket]
  ) {
    buckets.set(at, noSums());
  }
  const total = noSums();
  for (const row of rows) {
    add(total, row);
    const at = bucketStart(row.at, bucket).getTime();
    let sums = buckets.get(at);
    if (sums === undefined) {
      sums = noSums();
      buckets.set(at, sums);
    }
    add(sums, row);
  }
  return {
    bucket,
    totals: totalsOf(total),
    points: [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([at, sums]) => ({
        at: new Date(at).toISOString(),
        ...totalsOf(sums),
      })),
  };
}

/** What a row is, by a dimension: its key, label and Floor; or none. */
type Grouping = (
  row: AnalyticsRow,
  names: AnalyticsNames,
) => { key: string | null; label: string; floorId: string | null } | undefined;

const groupings: Record<AnalyticsDimension, Grouping> = {
  ai_account: (row) => ({
    key: row.account,
    // Refused before any account served it, such as at a Token Cap.
    label: row.account ?? "No AI Account",
    floorId: null,
  }),
  ai_provider: (row) => {
    const aiProvider =
      row.model === null ? undefined : aiProviderOfModel(row.model);
    return {
      key: aiProvider ?? null,
      label: aiProvider ?? "Other",
      floorId: null,
    };
  },
  model: (row) => ({
    key: row.model,
    label: row.model ?? "No Model",
    floorId: null,
  }),
  floor: (row, names) =>
    row.floorId === null
      ? { key: null, label: "Owner tools", floorId: null }
      : {
          key: row.floorId,
          label: names.floor(row.floorId),
          floorId: row.floorId,
        },
  agent: (row, names) =>
    row.agentId === null
      ? undefined
      : {
          key: row.agentId,
          label: names.agent(row.agentId),
          floorId: row.floorId,
        },
  issue: (row, names) => {
    if (row.issue === null) {
      return undefined;
    }
    const where =
      row.floorId === null ? (row.ownerTool ?? "") : names.floor(row.floorId);
    return {
      key: `${row.floorId ?? row.ownerTool ?? ""}#${String(row.issue)}`,
      label: `${where} #${String(row.issue)}`,
      floorId: row.floorId,
    };
  },
  owner_tool: (row) =>
    row.ownerTool === null
      ? undefined
      : { key: row.ownerTool, label: row.ownerTool, floorId: null },
};

/**
 * The totals broken down `by` a dimension, most tokens first (then most
 * requests, then by name). Requests the dimension does not apply to (an
 * Owner tool's, by Agent) are left out.
 */
export function breakdownOf(
  rows: readonly AnalyticsRow[],
  by: AnalyticsDimension,
  names: AnalyticsNames,
): AnalyticsBreakdown {
  const groups = new Map<
    string,
    { key: string | null; label: string; floorId: string | null; sums: Sums }
  >();
  for (const row of rows) {
    const group = groupings[by](row, names);
    if (group === undefined) {
      continue;
    }
    const id = JSON.stringify([group.key, group.floorId]);
    const current = groups.get(id) ?? { ...group, sums: noSums() };
    add(current.sums, row);
    groups.set(id, current);
  }
  const items = [...groups.values()].map(({ sums, ...group }) => ({
    ...group,
    ...totalsOf(sums),
  }));
  items.sort(
    (a, b) =>
      b.tokens - a.tokens ||
      b.requests - a.requests ||
      a.label.localeCompare(b.label),
  );
  return { by, items };
}

/** The Agents and Owner tools that used the most tokens, most first. */
export function topConsumersOf(
  rows: readonly AnalyticsRow[],
  names: AnalyticsNames,
  limit = 5,
): TopConsumer[] {
  const consumers = new Map<
    string,
    Omit<TopConsumer, "share" | "tokens" | "requests" | "estimatedCostUsd"> & {
      sums: Sums;
    }
  >();
  let tokens = 0;
  for (const row of rows) {
    tokens += row.inputTokens + row.outputTokens;
    const consumer =
      row.agentId !== null
        ? {
            kind: "agent" as const,
            key: row.agentId,
            label: names.agent(row.agentId),
            floorId: row.floorId,
          }
        : row.ownerTool !== null
          ? {
              kind: "owner_tool" as const,
              key: row.ownerTool,
              label: row.ownerTool,
              floorId: null,
            }
          : undefined;
    if (consumer === undefined) {
      continue;
    }
    const id = `${consumer.kind}:${consumer.key}`;
    const current = consumers.get(id) ?? { ...consumer, sums: noSums() };
    add(current.sums, row);
    consumers.set(id, current);
  }
  return [...consumers.values()]
    .map(({ sums, ...consumer }) => {
      const used = sums.inputTokens + sums.outputTokens;
      return {
        ...consumer,
        tokens: used,
        requests: sums.requests,
        estimatedCostUsd: dollars(sums.estimatedCostUsd),
        share: tokens === 0 ? 0 : used / tokens,
      };
    })
    .filter(({ tokens: used }) => used > 0)
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * The AI Accounts close to a usage window's limit (`nearLimitPercent` or
 * more of a window that has not reset), or held back by a limit now, in
 * the Gateway's order.
 */
export function accountsNearLimits(
  accounts: readonly AiAccountInfo[],
  at: Date,
): AccountNearLimit[] {
  return accounts.flatMap((account) => {
    const windows = (
      [
        ["five_hour", account.fiveHourUtilization, account.fiveHourResetsAt],
        ["weekly", account.weeklyUtilization, account.weeklyResetsAt],
      ] as const
    ).flatMap(([window, utilization, resetsAt]) =>
      utilization !== null &&
      resetsAt !== null &&
      resetsAt > at &&
      utilization >= nearLimitPercent
        ? [{ window, utilization, resetsAt: resetsAt.toISOString() }]
        : [],
    );
    const limit = limitOf(account, at);
    return windows.length === 0 && limit === undefined
      ? []
      : [
          {
            accountId: account.id,
            name: account.name,
            aiProvider: account.aiProvider,
            windows,
            limitReason: limit?.reason ?? null,
            limitedUntil: limit?.until.toISOString() ?? null,
          },
        ];
  });
}
