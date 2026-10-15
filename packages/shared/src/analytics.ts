import { z } from "zod";

import { usageReadingSchema } from "./ai-accounts.ts";

// The AI Gateway's analytics (PRD FR-43): requests, tokens by type,
// estimated cost, latency and errors over time; the same broken down by AI
// Account, AI Provider, Model, Floor, Agent, issue and Owner tool; each AI
// Account's usage-window history; and insights (the top consumers, and the
// accounts close to their limits). Everything is read from the request
// history (`gateway_requests`) and the accounts' usage readings, for a time
// range the Owner chooses. Prompt-cache keep-alives (FR-39) count as
// requests, and are also counted apart.

/** How the time series is cut: by the hour, or by the day (UTC). */
export const analyticsBuckets = ["hour", "day"] as const;
export type AnalyticsBucket = (typeof analyticsBuckets)[number];

/** What requests can be broken down by. */
export const analyticsDimensions = [
  "ai_account",
  "ai_provider",
  "model",
  "floor",
  "agent",
  "issue",
  "owner_tool",
] as const;
export type AnalyticsDimension = (typeof analyticsDimensions)[number];

/** How the dashboard names each dimension. */
export const analyticsDimensionLabels: Record<AnalyticsDimension, string> = {
  ai_account: "AI Account",
  ai_provider: "AI Provider",
  model: "Model",
  floor: "Floor",
  agent: "Agent",
  issue: "Issue",
  owner_tool: "Owner tool",
};

/** The longest range analytics read, and the longest cut by the hour. */
export const maxAnalyticsDays = 366;
export const maxHourlyAnalyticsDays = 31;

/** An AI Account's usage window counts as close to its limit from here. */
export const nearLimitPercent = 80;

const rangeShape = {
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
};

const dayMs = 24 * 60 * 60 * 1000;

/** `from` before `to`, and not too far apart. */
const inRange = (
  query: { readonly from: string; readonly to: string },
  context: z.RefinementCtx,
  maxDays: number,
) => {
  const span = Date.parse(query.to) - Date.parse(query.from);
  if (span <= 0) {
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "The range must end after it starts.",
    });
  } else if (span > maxDays * dayMs) {
    context.addIssue({
      code: "custom",
      path: ["from"],
      message: `Analytics read at most ${String(maxDays)} days at a time.`,
    });
  }
};

/** A time range: the query of every analytics route. */
export const analyticsRangeSchema = z
  .object(rangeShape)
  .superRefine((query, context) => {
    inRange(query, context, maxAnalyticsDays);
  });

/**
 * The query of `GET /api/analytics/series`: every request's, or only one
 * AI Account's (`aiAccountId`, its chart in AI Settings).
 */
export const analyticsSeriesQuerySchema = z
  .object({
    ...rangeShape,
    bucket: z.enum(analyticsBuckets).default("day"),
    aiAccountId: z.string().min(1).max(200).optional(),
  })
  .superRefine((query, context) => {
    inRange(
      query,
      context,
      query.bucket === "hour" ? maxHourlyAnalyticsDays : maxAnalyticsDays,
    );
  });
export type AnalyticsSeriesQuery = z.infer<typeof analyticsSeriesQuerySchema>;

/** The query of `GET /api/analytics/breakdown`. */
export const analyticsBreakdownQuerySchema = z
  .object({ ...rangeShape, by: z.enum(analyticsDimensions) })
  .superRefine((query, context) => {
    inRange(query, context, maxAnalyticsDays);
  });

const count = z.number().int().min(0);

/** What a set of requests added up to. */
export const analyticsTotalsSchema = z.object({
  requests: count,
  /** Answered with a status of 400 or more. */
  errors: count,
  /** `errors` over `requests`, 0 to 1; 0 with no requests. */
  errorRate: z.number().min(0).max(1),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  /** Input plus output: what Token Caps count (FR-31). */
  tokens: count,
  /** For information only; priced requests only. */
  estimatedCostUsd: z.number().min(0),
  /** The mean latency; null with no requests. */
  averageLatencyMs: z.number().min(0).nullable(),
  /**
   * The mean time to the first byte of the answer, of the requests that
   * have one; null with none.
   */
  averageTimeToFirstByteMs: z.number().min(0).nullable().default(null),
  /**
   * Of `requests`, those the AI Gateway sent itself to keep a prompt
   * cache warm (FR-39), and their share of `estimatedCostUsd`.
   */
  keepAliveRequests: count,
  keepAliveCostUsd: z.number().min(0),
});
export type AnalyticsTotals = z.infer<typeof analyticsTotalsSchema>;

/** The body of `GET /api/analytics/series`. */
export const analyticsSeriesSchema = z.object({
  bucket: z.enum(analyticsBuckets),
  totals: analyticsTotalsSchema,
  /** Every bucket in the range, oldest first, empty ones too. */
  points: z.array(
    analyticsTotalsSchema.extend({ at: z.iso.datetime({ offset: true }) }),
  ),
});
export type AnalyticsSeries = z.infer<typeof analyticsSeriesSchema>;

/** One item of a breakdown. */
export const analyticsBreakdownItemSchema = analyticsTotalsSchema.extend({
  /** What it is by: an account's name, a Model, an Agent's id…; null for none. */
  key: z.string().nullable(),
  /** How the dashboard names it. */
  label: z.string(),
  /** The Floor it belongs to, for Agents and issues. */
  floorId: z.string().nullable(),
});
export type AnalyticsBreakdownItem = z.infer<
  typeof analyticsBreakdownItemSchema
>;

/** The body of `GET /api/analytics/breakdown`: most tokens first. */
export const analyticsBreakdownSchema = z.object({
  by: z.enum(analyticsDimensions),
  items: z.array(analyticsBreakdownItemSchema),
});
export type AnalyticsBreakdown = z.infer<typeof analyticsBreakdownSchema>;

/** One of the top consumers: an Agent or an Owner tool. */
export const topConsumerSchema = z.object({
  kind: z.enum(["agent", "owner_tool"]),
  /** The Agent's id, or the Owner tool's name. */
  key: z.string(),
  label: z.string(),
  floorId: z.string().nullable(),
  tokens: count,
  requests: count,
  estimatedCostUsd: z.number().min(0),
  /** Its share of every token in the range, 0 to 1. */
  share: z.number().min(0).max(1),
});
export type TopConsumer = z.infer<typeof topConsumerSchema>;

/** An AI Account close to, or at, one of its limits. */
export const accountNearLimitSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  aiProvider: z.string(),
  /** Its usage windows at `nearLimitPercent` or more. */
  windows: z.array(
    z.object({
      window: usageReadingSchema.shape.window,
      utilization: z.number().min(0),
      resetsAt: z.iso.datetime({ offset: true }),
    }),
  ),
  /** Why it is held back now, if it is: `rate_limited`, `overloaded`…. */
  limitReason: z.string().nullable(),
  limitedUntil: z.iso.datetime({ offset: true }).nullable(),
});
export type AccountNearLimit = z.infer<typeof accountNearLimitSchema>;

/** The body of `GET /api/analytics/insights`. */
export const analyticsInsightsSchema = z.object({
  /** The Agents and Owner tools that used the most tokens, most first. */
  topConsumers: z.array(topConsumerSchema),
  /** Accounts close to a usage window's limit, or held back by one now. */
  accountsNearLimits: z.array(accountNearLimitSchema),
});
export type AnalyticsInsights = z.infer<typeof analyticsInsightsSchema>;

/** The body of `GET /api/analytics/usage-windows`. */
export const analyticsUsageWindowsSchema = z.object({
  /** Every account with readings in the range, in the Gateway's order. */
  accounts: z.array(
    z.object({
      accountId: z.string(),
      name: z.string(),
      aiProvider: z.string(),
      /** Its readings in the range, oldest first. */
      readings: z.array(usageReadingSchema),
    }),
  ),
});
export type AnalyticsUsageWindows = z.infer<typeof analyticsUsageWindowsSchema>;
