import { z } from "zod";

// Retention (PRD §7, FR-65): how long AI Office keeps what it records.
// Request and response bodies go after 7 days, usage and request metadata
// after 90, the Activity Feed and Notices after a year and Connections'
// delivery logs after 90 days, unless the Owner sets other periods in the
// office admin. Storing bodies at all is a switch
// of its own (`requestBodiesSettingsSchema`). Admin's Storage card deletes
// the same kinds of history by hand, to free space; both read their
// minimums and defaults from here. The server and the web app share these.

/** The longest any record is kept, or can be deleted back to, in days. */
export const maxRetentionDays = 3650;

/** The retention rules, each named as `config.changed` names it. */
export const retentionRules = [
  "requestBodiesDays",
  "requestMetadataDays",
  "activityDays",
  "connectionDeliveriesDays",
] as const;
export type RetentionRule = (typeof retentionRules)[number];

/** The kinds of history AI Office keeps, as Admin's Storage card lists them. */
export const historyKinds = [
  "activity",
  "request_bodies",
  "requests",
  "usage_history",
  "sign_ins",
  "connection_deliveries",
] as const;
export type HistoryKind = (typeof historyKinds)[number];

/**
 * Each kind of history: the retention rule that deletes it, and the fewest
 * days of it always kept, whether retention or the Owner deletes it. Closed
 * Notices go by the Activity Feed's rule too, though Storage does not list
 * them.
 */
export const historyKindRetention: Readonly<
  Record<
    HistoryKind,
    { readonly rule: RetentionRule; readonly minDays: number }
  >
> = {
  // Work under way reads its own events back (an issue's address, its pull
  // request, the Token Caps it reached), however long ago it started.
  activity: { rule: "activityDays", minDays: 30 },
  request_bodies: { rule: "requestBodiesDays", minDays: 0 },
  // Hourly Analytics read up to 31 days of requests themselves; what older
  // requests used is kept a day at a time (`gateway_usage_days`).
  requests: { rule: "requestMetadataDays", minDays: 32 },
  usage_history: { rule: "requestMetadataDays", minDays: 0 },
  sign_ins: { rule: "activityDays", minDays: 1 },
  // A delivery still waiting to go (retried for up to 24 hours, or held
  // for quiet hours) is the outbound queue, not its log, and always stays.
  connection_deliveries: { rule: "connectionDeliveriesDays", minDays: 1 },
};

/** The fewest days a rule keeps: the most any kind it deletes keeps. */
export const retentionMinDays = Object.fromEntries(
  retentionRules.map((rule) => [
    rule,
    Math.max(
      ...historyKinds
        .filter((kind) => historyKindRetention[kind].rule === rule)
        .map((kind) => historyKindRetention[kind].minDays),
    ),
  ]),
) as Readonly<Record<RetentionRule, number>>;

const days = (what: string, min: number) =>
  z
    .number({ error: `${what} is a whole number of days.` })
    .int({ error: `${what} is a whole number of days.` })
    .min(min, {
      error:
        min === 0
          ? `${what} is kept for 0 days or more.`
          : `${what} is kept for at least ${String(min)} ${min === 1 ? "day" : "days"}.`,
    })
    .max(maxRetentionDays, {
      error: `${what} is kept for at most ${String(maxRetentionDays)} days.`,
    });

/** `GET` and `PUT /api/office/retention`. */
export const retentionSettingsSchema = z
  .strictObject({
    /** Request and response bodies (FR-44): 7 days by default. */
    requestBodiesDays: days(
      "A request's bodies",
      retentionMinDays.requestBodiesDays,
    ),
    /**
     * Each request's record (tokens, cost, timings, headers) and AI
     * Accounts' usage-window readings: 90 days by default. What Token Caps
     * and Analytics count is kept, a day at a time, once the records are
     * gone.
     */
    requestMetadataDays: days(
      "A request's record",
      retentionMinDays.requestMetadataDays,
    ),
    /** Activity Feed events, closed Notices and sign-ins: a year. */
    activityDays: days("The Activity Feed", retentionMinDays.activityDays),
    /** Each Connection's log of finished deliveries (FR-93): 90 days. */
    connectionDeliveriesDays: days(
      "A Connection's delivery log",
      retentionMinDays.connectionDeliveriesDays,
    ),
  })
  .refine(
    (settings) => settings.requestBodiesDays <= settings.requestMetadataDays,
    {
      error:
        "Bodies go with their request, so keep them no longer than requests' records.",
      path: ["requestBodiesDays"],
    },
  );
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

/** Until the Owner chooses: PRD §7's defaults. */
export const defaultRetentionSettings: RetentionSettings = {
  requestBodiesDays: 7,
  requestMetadataDays: 90,
  activityDays: 365,
  connectionDeliveriesDays: 90,
};

/** Records older than this, at `now`, are past `days` of retention. */
export const retentionCutoff = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
