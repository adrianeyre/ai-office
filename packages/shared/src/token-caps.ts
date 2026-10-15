import { z } from "zod";

// Token accounting and Token Caps (PRD §6.7, FR-31, FR-32). Tokens are
// counted as Token Caps count them: input plus output, with cache reads
// (and cache writes) shown apart. They are added up per Agent, Floor,
// issue and Owner tool, per day and per month, in UTC.
//
// A Token Cap is a limit on the tokens an Agent may use in a period (the
// glossary). The office sets a daily and a monthly default; a Floor may
// override them for its Agents, an Agent for itself, and an issue for the
// work on it. The most specific cap set applies, period by period: the
// issue's, else the Agent's, else its Floor's, else the office's. An
// issue's cap counts the tokens used on that issue by every Agent; the
// others count the Agent's own.
//
// Enforcement (FR-33): at 80% of a cap in force the Owner is warned; at
// 100% the AI Gateway refuses the Agent's calls and AI Office pauses it,
// with a Notice offering to raise the cap or resume when its period
// resets.

/** The share of a cap at which the Owner is warned (FR-33). */
export const capWarningShare = 0.8;

/** The actions on a "Token Cap reached" Notice (FR-33, FR-48). */
export const tokenCapActions = {
  /** Raises the cap reached for the Agent's work, and resumes it. */
  raiseCap: "raise_cap",
  /** Resumes the Agent when its daily cap's day is over. */
  resumeTomorrow: "resume_tomorrow",
  /** Resumes the Agent when its monthly cap's month is over. */
  resumeNextMonth: "resume_next_month",
} as const;

/** The periods a Token Cap counts over. */
export const capPeriods = ["daily", "monthly"] as const;
export type CapPeriod = (typeof capPeriods)[number];

/** The levels a Token Cap is set at, least specific first (FR-32). */
export const capLevelsBySpecificity = [
  "office",
  "floor",
  "agent",
  "issue",
] as const;
export type CapLevel = (typeof capLevelsBySpecificity)[number];

/** One Token Cap: a whole number of tokens, more than 0; null for none. */
export const tokenCapSchema = z
  .number({ error: "A Token Cap is a whole number of tokens." })
  .int({ error: "A Token Cap is a whole number of tokens." })
  .positive({ error: "A Token Cap must be more than 0 tokens." })
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

/** A level's daily and monthly caps; null where it sets none. */
export const tokenCapsSchema = z.strictObject({
  daily: tokenCapSchema,
  monthly: tokenCapSchema,
});
export type TokenCaps = z.infer<typeof tokenCapsSchema>;

/** No caps of its own: the level falls back to the next. */
export const noTokenCaps: TokenCaps = { daily: null, monthly: null };

/**
 * The office's default Token Caps until the Owner sets them: the tokens
 * each Agent may use a day and a month.
 */
export const defaultOfficeTokenCaps = {
  daily: 5_000_000,
  monthly: 100_000_000,
} as const satisfies TokenCaps;

/** The office's caps, which always exist: the defaults for every Agent. */
export const officeTokenCapsSchema = z.strictObject({
  daily: tokenCapSchema.unwrap(),
  monthly: tokenCapSchema.unwrap(),
});
export type OfficeTokenCaps = z.infer<typeof officeTokenCapsSchema>;

/** The caps set at each level for one Agent's work; absent levels set none. */
export interface CapLevels {
  readonly office: OfficeTokenCaps;
  readonly floor?: TokenCaps | undefined;
  readonly agent?: TokenCaps | undefined;
  readonly issue?: TokenCaps | undefined;
}

/** The cap that applies in a period, and the level it is set at. */
export interface ResolvedCap {
  readonly level: CapLevel;
  readonly cap: number;
}

/**
 * The Token Cap that applies to an Agent's work in `period`: the most
 * specific level that sets one (issue, Agent, Floor, then the office).
 */
export function resolveTokenCap(
  levels: CapLevels,
  period: CapPeriod,
): ResolvedCap {
  for (const level of ["issue", "agent", "floor"] as const) {
    const cap = levels[level]?.[period];
    if (cap !== null && cap !== undefined) {
      return { level, cap };
    }
  }
  return { level: "office", cap: levels.office[period] };
}

/** When a period that holds `at` starts and ends (exclusive), in UTC. */
export function periodBounds(
  period: CapPeriod,
  at: Date,
): { readonly from: Date; readonly to: Date } {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  if (period === "monthly") {
    return {
      from: new Date(Date.UTC(year, month, 1)),
      to: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
  const day = at.getUTCDate();
  return {
    from: new Date(Date.UTC(year, month, day)),
    to: new Date(Date.UTC(year, month, day + 1)),
  };
}

const count = z.number().int().min(0);

/** What requests used in a period (FR-31). */
export const tokenTotalsSchema = z.object({
  requests: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  /** Input plus output: what Token Caps count. */
  tokens: count,
  /** For information only (FR-31, FR-43); priced requests only. */
  estimatedCostUsd: z.number().min(0),
});
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;

/** Nothing used. */
export const noTokens: TokenTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  tokens: 0,
  estimatedCostUsd: 0,
};

/**
 * What requests used in a period for one caller and issue: the finest grain
 * token accounting adds up from. An Agent's rows carry its Floor; an Owner
 * tool's its name.
 */
export interface TokenUsageRow {
  readonly floorId: string | null;
  readonly agentId: string | null;
  readonly issue: number | null;
  readonly ownerTool: string | null;
  readonly totals: TokenTotals;
}

/** `a` and `b` added up. */
export const addTokens = (a: TokenTotals, b: TokenTotals): TokenTotals => ({
  requests: a.requests + b.requests,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  tokens: a.tokens + b.tokens,
  estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
});

/** A day's and a month's totals. */
export const periodTotalsSchema = z.object({
  daily: tokenTotalsSchema,
  monthly: tokenTotalsSchema,
});
export type PeriodTotals = z.infer<typeof periodTotalsSchema>;

/** A cap in force, the level it comes from, and what it has counted. */
export const capUseSchema = z.object({
  level: z.enum(capLevelsBySpecificity),
  cap: count,
  /** Tokens counted against it in the period so far. */
  used: count,
});
export type CapUse = z.infer<typeof capUseSchema>;

/** A day's and a month's caps in force, with their use. */
export const periodCapUseSchema = z.object({
  daily: capUseSchema,
  monthly: capUseSchema,
});
export type PeriodCapUse = z.infer<typeof periodCapUseSchema>;

/** The body of `GET /api/office/token-caps`. */
export const officeTokenUsageSchema = z.object({
  /** The office's default caps, for every Agent without its own. */
  caps: officeTokenCapsSchema,
  /** What the whole Office used. */
  usage: periodTotalsSchema,
  /** The Agent that used the most in each period, against its cap. */
  busiestAgents: z.object({
    daily: z
      .object({ floorId: z.string(), agentId: z.string(), use: capUseSchema })
      .nullable(),
    monthly: z
      .object({ floorId: z.string(), agentId: z.string(), use: capUseSchema })
      .nullable(),
  }),
  floors: z.array(z.object({ floorId: z.string(), usage: periodTotalsSchema })),
  ownerTools: z.array(
    z.object({ ownerTool: z.string(), usage: periodTotalsSchema }),
  ),
});
export type OfficeTokenUsage = z.infer<typeof officeTokenUsageSchema>;

/** One issue's caps and use, as a Floor's token usage lists it. */
export const issueTokenUsageSchema = z.object({
  issue: z.number().int().positive(),
  /** Its own caps; null in a period it sets none. */
  caps: tokenCapsSchema,
  /** What every Agent used on it. */
  usage: periodTotalsSchema,
});
export type IssueTokenUsage = z.infer<typeof issueTokenUsageSchema>;

/** The body of `GET /api/floors/:floorId/token-usage`. */
export const floorTokenUsageSchema = z.object({
  floorId: z.string(),
  /** The Floor's own caps for its Agents; null uses the office's. */
  caps: tokenCapsSchema,
  /** The caps its Agents get unless they set their own. */
  agentDefaults: z.object({
    daily: z.object({ level: z.enum(capLevelsBySpecificity), cap: count }),
    monthly: z.object({ level: z.enum(capLevelsBySpecificity), cap: count }),
  }),
  /** What the whole Floor used. */
  usage: periodTotalsSchema,
  /** Each Agent's use against the cap in force for it (outside issue caps). */
  agents: z.array(
    z.object({
      agentId: z.string(),
      usage: periodTotalsSchema,
      caps: periodCapUseSchema,
    }),
  ),
  /** Issues with caps of their own, or used this month; newest first. */
  issues: z.array(issueTokenUsageSchema),
});
export type FloorTokenUsage = z.infer<typeof floorTokenUsageSchema>;

/** The body of `PUT /api/floors/:floorId/issues/:issue/token-caps`. */
export const issueTokenCapsRequestSchema = tokenCapsSchema;
