import { z } from "zod";

import { aiProviders } from "./agents.ts";
import { avatarSchema, type Avatar } from "./avatar.ts";
import type { GoogleService } from "./google.ts";
import { ownerHost, ownerUrl } from "./internal-hosts.ts";
import { defaultLobbyCast } from "./people.ts";
import { modelNameSchema } from "./pricing.ts";

// Communications (PRD §6.17): the one office-wide Communications Agent,
// and the Connections through which it tells the Owner, outside AI Office,
// about Notices and finished work: notification channels, which send short
// messages, and publishing destinations, which keep a written record (each
// Batch's Wrap-up report, and optionally a running changelog; in Google
// Slides a deck, and in Google Drive files; in Google Calendar an event
// per Batch; or, in Google Sheets, a work log with a row per completed
// issue). The server,
// the communications package and the web app share these.

/** The Communications Agent's Role: built in, never a library Role (ADR 0003). */
export const communicationsRole = "communications";

/**
 * Who the AI Gateway attributes the Communications Agent's model calls to
 * (FR-42): it has its own Gateway Key, but is not one of a Floor's Agents.
 */
export const communicationsAgentId = "communications";

/** The kinds of Connection AI Office can send to (FR-91). */
export const connectionTypes = [
  "webhook",
  "slack",
  "email",
  "ntfy",
  "pushover",
  "confluence",
  "notion",
  "google_sheets",
  "google_docs",
  "google_slides",
  "google_drive",
  "google_calendar",
] as const;
export type ConnectionType = (typeof connectionTypes)[number];

/** How each kind of Connection is named for people. */
export const connectionTypeNames: Record<ConnectionType, string> = {
  webhook: "Generic webhook",
  slack: "Slack",
  email: "Email (SMTP)",
  ntfy: "Phone push: ntfy",
  pushover: "Phone push: Pushover",
  confluence: "Confluence",
  notion: "Notion",
  google_sheets: "Google Sheets",
  google_docs: "Google Docs",
  google_slides: "Google Slides",
  google_drive: "Google Drive",
  google_calendar: "Google Calendar",
};

/**
 * The publishing destinations (FR-91), which keep a written record: a page
 * or document per Batch with its Wrap-up report, and optionally a running
 * changelog (Confluence, Notion, Google Docs); a deck per Batch (Google
 * Slides); the report as files (Google Drive); an event per Batch, from
 * its start to its finish (Google Calendar); or a work log, a row per
 * completed issue (Google Sheets). Every other type is a notification
 * channel, sending short messages.
 */
export const publishingTypes = [
  "confluence",
  "notion",
  "google_sheets",
  "google_docs",
  "google_slides",
  "google_drive",
  "google_calendar",
] as const;
export type PublishingType = (typeof publishingTypes)[number];

export const isPublishingDestination = (
  type: ConnectionType,
): type is PublishingType =>
  (publishingTypes as readonly ConnectionType[]).includes(type);

/**
 * The publishing destinations that keep a work log (FR-92): a row per
 * completed issue, and optionally a row per Notice. The others publish
 * Wrap-up reports and a changelog.
 */
export const workLogTypes = ["google_sheets"] as const;
export type WorkLogType = (typeof workLogTypes)[number];

export const isWorkLog = (type: ConnectionType): type is WorkLogType =>
  (workLogTypes as readonly ConnectionType[]).includes(type);

/**
 * The publishing destinations that keep a calendar (FR-92): an event per
 * Batch, made when it starts and changed to its finish when it finishes.
 * They publish no Wrap-up report and keep no changelog.
 */
export const calendarTypes = ["google_calendar"] as const;
export type CalendarType = (typeof calendarTypes)[number];

export const isCalendar = (type: ConnectionType): type is CalendarType =>
  (calendarTypes as readonly ConnectionType[]).includes(type);

/**
 * The publishing destinations that can keep a running changelog beside
 * their Wrap-up reports (FR-92): an entry per merged pull request.
 */
export const changelogTypes = ["confluence", "notion", "google_docs"] as const;
export type ChangelogType = (typeof changelogTypes)[number];

export const keepsChangelog = (type: ConnectionType): type is ChangelogType =>
  (changelogTypes as readonly ConnectionType[]).includes(type);

/** The Connections that publish through the Owner's Google sign-in (FR-91). */
export const googleConnectionTypes = [
  "google_sheets",
  "google_docs",
  "google_slides",
  "google_drive",
  "google_calendar",
] as const;
export type GoogleConnectionType = (typeof googleConnectionTypes)[number];

export const isGoogleConnection = (
  type: ConnectionType,
): type is GoogleConnectionType =>
  (googleConnectionTypes as readonly ConnectionType[]).includes(type);

/** The Google service each Google Connection uses, whose scopes it needs. */
export const googleServiceOf: Record<GoogleConnectionType, GoogleService> = {
  google_sheets: "sheets",
  google_docs: "docs",
  google_slides: "slides",
  google_drive: "drive",
  google_calendar: "calendar",
};

/**
 * How much of what happened a Connection is told (FR-95): kinds, counts
 * and links only, or titles and summaries too (the default).
 */
export const detailLevels = ["links_only", "titles_and_summaries"] as const;
export type DetailLevel = (typeof detailLevels)[number];

export const detailLevelNames: Record<DetailLevel, string> = {
  links_only: "Links only",
  titles_and_summaries: "Titles and summaries",
};

export const defaultDetailLevel: DetailLevel = "titles_and_summaries";

/** A Connection is `ok` until 5 deliveries in a row fail (FR-94). */
export const connectionStatuses = ["ok", "failing"] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

/** How many failed deliveries in a row make a Connection failing (FR-94). */
export const failingAfterFailures = 5;

const floorId = z.string().min(1).max(100);

/** A time of day on a 24-hour clock, such as `07:30`. */
const timeOfDaySchema = z
  .string({ error: "Give a time such as 07:30." })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Give a time such as 07:30." });

/** Whether `timeZone` is an IANA time zone this runtime knows. */
const knownTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** An IANA time zone, such as `Europe/London`. */
const timeZoneSchema = z
  .string({ error: "Choose a time zone." })
  .min(1, { error: "Choose a time zone." })
  .max(64)
  .refine(knownTimeZone, {
    error: "Choose a time zone such as Europe/London.",
  });

/**
 * A Connection's quiet hours (FR-92), from `start` to `end` on the clock of
 * `timeZone` (overnight when `end` is earlier). Messages that fall due in
 * them are held until they end, or summarised by a Digest that comes
 * first; with `actionNotices`, action Notices still go at once.
 */
export const quietHoursSchema = z
  .strictObject({
    start: timeOfDaySchema,
    end: timeOfDaySchema,
    timeZone: timeZoneSchema,
    actionNotices: z.boolean(),
  })
  .refine((hours) => hours.start !== hours.end, {
    error: "Quiet hours start and end at different times.",
  });
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** How often a Connection is sent a Digest (FR-92). */
export const digestFrequencies = ["hourly", "daily"] as const;
export type DigestFrequency = (typeof digestFrequencies)[number];

/**
 * A Connection's Digest (FR-92): a summary of what happened since the
 * last one, every hour on the hour, or every day at `at` on the clock of
 * `timeZone`.
 */
export const digestScheduleSchema = z.discriminatedUnion(
  "frequency",
  [
    z.strictObject({ frequency: z.literal("hourly") }),
    z.strictObject({
      frequency: z.literal("daily"),
      at: timeOfDaySchema,
      timeZone: timeZoneSchema,
    }),
  ],
  { error: "Choose an hourly or a daily Digest." },
);
export type DigestSchedule = z.infer<typeof digestScheduleSchema>;

/**
 * What a notification channel is sent (FR-92): action Notices (on by
 * default), info Notices (off) and work complete (on: a pull request
 * merged, closing its issue, or a Batch finished). `floorIds` keeps it to
 * those Floors' events; empty sends every Floor's. Notices about the whole
 * Office always pass it. Quiet hours and a Digest are optional: absent,
 * there are none.
 *
 * A publishing destination always publishes each finished Batch's Wrap-up
 * report, within its Floors, and (Confluence, Notion and Google Docs) a
 * running changelog with `changelog`; a calendar (Google Calendar) an
 * event per Batch, within its Floors; a
 * work log (Google Sheets) a row per completed issue, and with `notices` a
 * row per Notice too. The notification triggers, quiet hours and Digests
 * are not theirs, and are kept off.
 */
export const connectionRulesSchema = z.strictObject({
  actionNotices: z.boolean(),
  infoNotices: z.boolean(),
  workComplete: z.boolean(),
  floorIds: z
    .array(floorId)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      error: "Choose each Floor once.",
    }),
  quietHours: quietHoursSchema.optional(),
  digest: digestScheduleSchema.optional(),
  /** A publishing destination's running changelog: an entry per merged pull request. */
  changelog: z.boolean().optional(),
  /** A work log's row per Notice, beside its row per completed issue. */
  notices: z.boolean().optional(),
});
export type ConnectionRules = z.infer<typeof connectionRulesSchema>;

export const defaultConnectionRules: ConnectionRules = {
  actionNotices: true,
  infoNotices: false,
  workComplete: true,
  floorIds: [],
};

/** A publishing destination's rules: every Floor's reports, no changelog. */
export const defaultPublishingRules: ConnectionRules = {
  actionNotices: false,
  infoNotices: false,
  workComplete: false,
  floorIds: [],
  changelog: false,
};

/** A work log's rules: every Floor's completed issues, no Notices. */
export const defaultWorkLogRules: ConnectionRules = {
  actionNotices: false,
  infoNotices: false,
  workComplete: false,
  floorIds: [],
  notices: false,
};

/** The rules a new Connection of `type` starts with. */
export const defaultRulesFor = (type: ConnectionType): ConnectionRules =>
  isWorkLog(type)
    ? defaultWorkLogRules
    : isPublishingDestination(type)
      ? defaultPublishingRules
      : defaultConnectionRules;

/**
 * `rules` as a Connection of `type` keeps them: a work log keeps only its
 * Floors and its Notices; any other publishing destination only its
 * Floors and, if it can keep one, its changelog.
 */
export const rulesFor = (
  type: ConnectionType,
  rules: ConnectionRules,
): ConnectionRules =>
  isWorkLog(type)
    ? {
        ...defaultWorkLogRules,
        floorIds: rules.floorIds,
        notices: rules.notices ?? false,
      }
    : isPublishingDestination(type)
      ? {
          ...defaultPublishingRules,
          floorIds: rules.floorIds,
          changelog: keepsChangelog(type) && (rules.changelog ?? false),
        }
      : rules;

/** A Connection's name: unique among the Connections. */
export const connectionNameSchema = z
  .string({ error: "Name the Connection." })
  .trim()
  .min(1, { error: "Name the Connection." })
  .max(60, { error: "Use at most 60 characters for the name." })
  .regex(/^[^\p{Cc}]*$/u, { error: "Use one line for the name." });

/**
 * Where a webhook is sent: an https address, or http to a host the Owner
 * allows. Never an internal host they did not allow (ADR 0007, I1-2).
 */
const webhookUrlSchema = z
  .url({
    protocol: /^https?$/,
    error: "Give the webhook's address, starting https:// (or http://).",
  })
  .superRefine(ownerUrl("The webhook"));

/**
 * The generic webhook (FR-91): a JSON POST to its address, signed with
 * HMAC-SHA256 when it has a secret. The address can itself be a secret
 * (as Slack's, Discord's and Teams' are), so both are credentials.
 */
export const webhookCredentialsSchema = z.strictObject({
  url: webhookUrlSchema,
  secret: z
    .string()
    .min(16, { error: "Use at least 16 characters for the signing secret." })
    .max(256, { error: "Use at most 256 characters for the signing secret." })
    .optional(),
});
export type WebhookCredentials = z.infer<typeof webhookCredentialsSchema>;

/**
 * Slack (FR-91): an incoming webhook's address, or a bot token and the
 * channel or user it posts to. The address and the token are secrets.
 */
export const slackCredentialsSchema = z.discriminatedUnion(
  "mode",
  [
    z.strictObject({
      mode: z.literal("webhook"),
      webhookUrl: z
        .url({
          protocol: /^https?$/,
          error:
            "Give the incoming webhook's address, starting https://hooks.slack.com/.",
        })
        .superRefine(ownerUrl("The incoming webhook")),
    }),
    z.strictObject({
      mode: z.literal("bot"),
      botToken: z
        .string({ error: "Give the bot token." })
        .trim()
        .regex(/^xox[bp]-[\w-]{8,}$/, {
          error: "A bot token starts xoxb- (or xoxp- for a user token).",
        })
        .max(300),
      /** A channel (`#ops` or its id) or a user's id to post to. */
      channel: z
        .string({ error: "Give a channel or user to post to." })
        .trim()
        .regex(/^(#[a-z0-9][a-z0-9._-]{0,79}|[CDGU][A-Z0-9]{2,20})$/, {
          error:
            "Give a channel such as #ops, or a channel's or user's id such as C0123456789.",
        }),
    }),
  ],
  { error: "Choose an incoming webhook or a bot token." },
);
export type SlackCredentials = z.infer<typeof slackCredentialsSchema>;

/**
 * How an email Connection secures its SMTP connection: STARTTLS (usually
 * port 587), TLS from the start (465), or none (only for a server on the
 * same machine or network).
 */
export const emailTlsModes = ["starttls", "tls", "none"] as const;
export type EmailTlsMode = (typeof emailTlsModes)[number];

export const emailTlsModeNames: Record<EmailTlsMode, string> = {
  starttls: "STARTTLS",
  tls: "TLS",
  none: "None",
};

const emailAddressSchema = z.email({
  error: "Give each address as name@example.com.",
});

/**
 * Email (FR-91): an SMTP server (host, port, TLS, username and password),
 * a from address and one or more to addresses. The password is the
 * secret; the rest is shown.
 */
export const emailCredentialsSchema = z
  .strictObject({
    host: z
      .string({ error: "Give the SMTP server's host." })
      .trim()
      .regex(/^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$/, {
        error: "Give the SMTP server's host, such as smtp.example.com.",
      })
      // Never an internal host the Owner did not allow (ADR 0007).
      .superRefine(ownerHost("The SMTP server")),
    port: z
      .number({ error: "The port is a whole number." })
      .int({ error: "The port is a whole number." })
      .min(1, { error: "The port is from 1 to 65535." })
      .max(65535, { error: "The port is from 1 to 65535." }),
    tls: z.enum(emailTlsModes, { error: "Choose how to secure it." }),
    username: z
      .string()
      .trim()
      .min(1, { error: "Give the username, or leave both out." })
      .max(320, { error: "Use at most 320 characters for the username." })
      .optional(),
    password: z
      .string()
      .min(1, { error: "Give the password, or leave both out." })
      .max(1000, { error: "Use at most 1000 characters for the password." })
      .optional(),
    from: emailAddressSchema,
    to: z
      .array(emailAddressSchema)
      .min(1, { error: "Give at least one address to send to." })
      .max(20, { error: "Send to at most 20 addresses." }),
  })
  .refine(
    (value) =>
      (value.username === undefined) === (value.password === undefined),
    {
      error: "Give both a username and a password, or neither.",
    },
  );
export type EmailCredentials = z.infer<typeof emailCredentialsSchema>;

/**
 * Phone push through ntfy (FR-91): a server (ntfy.sh, or the Owner's own),
 * a topic, and an optional access token for a topic that needs one. On a
 * public server the topic is itself a secret, as anyone who knows it can
 * subscribe, so it is a credential and never shown.
 */
export const ntfyCredentialsSchema = z.strictObject({
  server: z
    .url({
      protocol: /^https?$/,
      error: "Give the ntfy server's address, such as https://ntfy.sh.",
    })
    .superRefine(ownerUrl("The ntfy server")),
  topic: z
    .string({ error: "Give the topic." })
    .trim()
    .regex(/^[-_A-Za-z0-9]{1,64}$/, {
      error: "A topic is 1 to 64 letters, digits, hyphens and underscores.",
    }),
  accessToken: z
    .string()
    .trim()
    .regex(/^tk_[A-Za-z0-9]{29}$/, {
      error: "An access token starts tk_ and has 32 characters.",
    })
    .optional(),
});
export type NtfyCredentials = z.infer<typeof ntfyCredentialsSchema>;

/** Pushover's application tokens and user (or group) keys: 30 letters and digits. */
const pushoverKeySchema = (what: string) =>
  z
    .string({ error: `Give the ${what}.` })
    .trim()
    .regex(/^[A-Za-z0-9]{30}$/, {
      error: `The ${what} is 30 letters and digits.`,
    });

/**
 * Phone push through Pushover (FR-91): an application token (the
 * Owner's Pushover application) and the user or group key it sends to.
 * Both are secrets.
 */
export const pushoverCredentialsSchema = z.strictObject({
  applicationToken: pushoverKeySchema("application token"),
  userKey: pushoverKeySchema("user key"),
});
export type PushoverCredentials = z.infer<typeof pushoverCredentialsSchema>;

/**
 * An address to an Atlassian or Notion page: https, or http to a host the
 * Owner allows. Never an internal host they did not allow (ADR 0007).
 */
const pageServiceUrl = (error: string, what: string) =>
  z.url({ protocol: /^https?$/, error }).superRefine(ownerUrl(what));

/**
 * Confluence (FR-91): the site's address, an Atlassian account's email
 * and API token, and the space and parent page under which each Batch's
 * Wrap-up report is a child page. The API token is the secret.
 */
export const confluenceCredentialsSchema = z.strictObject({
  siteUrl: pageServiceUrl(
    "Give the Confluence site's address, such as https://example.atlassian.net.",
    "The Confluence site",
  ),
  email: z.email({ error: "Give the Atlassian account's email address." }),
  apiToken: z
    .string({ error: "Give the API token." })
    .trim()
    .min(10, { error: "Give the API token." })
    .max(500, { error: "Use at most 500 characters for the API token." }),
  /** The space's key, such as `ENG`, or a personal space's `~…`. */
  spaceKey: z
    .string({ error: "Give the space's key." })
    .trim()
    .regex(/^~?[A-Za-z0-9]{1,255}$/, {
      error: "Give the space's key, such as ENG.",
    }),
  /** The parent page's id: the number in its address. */
  parentPageId: z
    .string({ error: "Give the parent page's id." })
    .trim()
    .regex(/^\d{1,20}$/, {
      error: "Give the parent page's id: the number in its address.",
    }),
});
export type ConfluenceCredentials = z.infer<typeof confluenceCredentialsSchema>;

/** Where a Notion Connection's pages go: under a page, or in a database. */
export const notionParentTypes = ["page", "database"] as const;
export type NotionParentType = (typeof notionParentTypes)[number];

/**
 * Notion (FR-91): an internal integration's token and the parent page or
 * database each Batch's Wrap-up report is made a page in, shared with the
 * integration. The token is the secret. The parent's id is its 32 hex
 * digits (with or without hyphens), as at the end of its address.
 */
export const notionCredentialsSchema = z.strictObject({
  token: z
    .string({ error: "Give the integration token." })
    .trim()
    .regex(/^(secret_|ntn_)[A-Za-z0-9]{20,100}$/, {
      error: "An integration token starts secret_ or ntn_.",
    }),
  parentType: z.enum(notionParentTypes, {
    error: "Choose a parent page or a database.",
  }),
  parentId: z
    .string({ error: "Give the parent's id." })
    .trim()
    .transform((id) => id.replaceAll("-", "").toLowerCase())
    .pipe(
      z.string().regex(/^[0-9a-f]{32}$/, {
        error:
          "Give the parent's id: the 32 letters and digits ending its address.",
      }),
    ),
});
export type NotionCredentials = z.infer<typeof notionCredentialsSchema>;

/** A spreadsheet's id, as in its address after `/spreadsheets/d/`. */
const spreadsheetIdPattern = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * Google Sheets (FR-91, FR-92): the spreadsheet and tab of the work log,
 * written through the Owner's Google sign-in. The spreadsheet is given by
 * its id or its address. Neither is secret: the sign-in's tokens are kept
 * with the sign-in, never with a Connection.
 */
export const googleSheetsCredentialsSchema = z.strictObject({
  spreadsheetId: z
    .string({ error: "Give the spreadsheet's address or id." })
    .trim()
    .transform(
      (value) =>
        /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(value)?.[1] ?? value,
    )
    .pipe(
      z.string().regex(spreadsheetIdPattern, {
        error:
          "Give the spreadsheet's address, https://docs.google.com/spreadsheets/d/…, or the id in it.",
      }),
    ),
  /** The tab (sheet) the rows go in; made when the spreadsheet has none by that name. */
  tab: z
    .string({ error: "Name the tab." })
    .trim()
    .min(1, { error: "Name the tab." })
    .max(100, { error: "Use at most 100 characters for the tab." })
    .regex(/^[^\p{Cc}[\]*?:/\\]*$/u, {
      error: "A tab's name has no [ ] * ? : / or \\.",
    }),
});
export type GoogleSheetsCredentials = z.infer<
  typeof googleSheetsCredentialsSchema
>;

/** A Google Drive folder's id, as in its address after `/folders/`. */
const folderIdPattern = /^[A-Za-z0-9_-]{10,100}$/;

/**
 * A Google Docs, Slides or Drive Connection (FR-91, FR-92): the Google
 * Drive folder its documents, decks or files are made in, written through
 * the Owner's Google sign-in. The folder is given by its id or its
 * address. It is not secret: the sign-in's tokens are kept with the
 * sign-in, never with a Connection.
 */
export const googleFolderCredentialsSchema = z.strictObject({
  folderId: z
    .string({ error: "Give the folder's address or id." })
    .trim()
    .transform(
      (value) => /\/folders\/([A-Za-z0-9_-]+)/.exec(value)?.[1] ?? value,
    )
    .pipe(
      z.string().regex(folderIdPattern, {
        error:
          "Give the folder's address, https://drive.google.com/drive/folders/…, or the id in it.",
      }),
    ),
});
export type GoogleFolderCredentials = z.infer<
  typeof googleFolderCredentialsSchema
>;

/**
 * A calendar's id as the Owner may paste it: the id itself, or a
 * calendar's address that carries it (`…/calendar/embed?src=<id>` or
 * `…/calendar/ical/<id>/…`).
 */
const calendarIdOf = (value: string): string => {
  const ical = /\/calendar\/ical\/([^/?#]+)\//.exec(value)?.[1];
  const embedded = /[?&]src=([^&#]+)/.exec(value)?.[1];
  const found = ical ?? embedded;
  if (found === undefined) {
    return value;
  }
  try {
    return decodeURIComponent(found);
  } catch {
    return found;
  }
};

/**
 * Google Calendar (FR-91, FR-92): the calendar each Batch's event goes on,
 * written through the Owner's Google sign-in. It is `primary` (the signed-in
 * account's own calendar) or a calendar's id, which looks like an email
 * address (`…@group.calendar.google.com` for a calendar the Owner made),
 * given as it is or in the calendar's address. It is not secret: the
 * sign-in's tokens are kept with the sign-in, never with a Connection.
 */
export const googleCalendarCredentialsSchema = z.strictObject({
  calendarId: z
    .string({ error: "Give the calendar's id." })
    .trim()
    .transform(calendarIdOf)
    .pipe(
      z
        .string()
        .max(254, { error: "Give the calendar's id." })
        .regex(/^(primary|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/, {
          error:
            "Give the calendar's id, from its settings (Integrate calendar), such as …@group.calendar.google.com, or primary.",
        }),
    ),
});
export type GoogleCalendarCredentials = z.infer<
  typeof googleCalendarCredentialsSchema
>;

/** The body of `POST /api/connections`: a new Connection of any type. */
export const addConnectionRequestSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject({
      type: z.literal("webhook"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: webhookCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("slack"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: slackCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("email"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: emailCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("ntfy"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: ntfyCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("pushover"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: pushoverCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("confluence"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: confluenceCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("notion"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: notionCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("google_sheets"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: googleSheetsCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("google_docs"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: googleFolderCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("google_slides"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: googleFolderCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("google_drive"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: googleFolderCredentialsSchema,
    }),
    z.strictObject({
      type: z.literal("google_calendar"),
      name: connectionNameSchema,
      rules: connectionRulesSchema.optional(),
      detailLevel: z.enum(detailLevels).optional(),
      credentials: googleCalendarCredentialsSchema,
    }),
  ],
  { error: "Choose a type of Connection." },
);
export type AddConnectionRequest = z.infer<typeof addConnectionRequestSchema>;

/**
 * The body of `PATCH /api/connections/:connectionId`: rename it, change
 * its rules or detail level, or pause or resume it. Its credentials are
 * never changed or read back.
 */
export const updateConnectionRequestSchema = z
  .strictObject({
    name: connectionNameSchema,
    rules: connectionRulesSchema,
    detailLevel: z.enum(detailLevels, { error: "Choose a detail level." }),
    /** True pauses it: nothing is sent to it until it resumes. */
    paused: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    error: "Change at least one setting.",
  });
export type UpdateConnectionRequest = z.infer<
  typeof updateConnectionRequestSchema
>;

/**
 * What a message is about (FR-92): to a notification channel, a Notice,
 * work complete, a Digest or a test; to a publishing destination, a
 * Batch's Wrap-up report, a changelog entry, a work log's row for a
 * completed issue (or a Notice), or a calendar's event for a Batch that
 * started or finished.
 */
export const messageKinds = [
  "action_notice",
  "info_notice",
  "work_complete",
  "digest",
  "test",
  "report",
  "changelog",
  "work_log",
  "batch_started",
  "batch_finished",
] as const;
export type MessageKind = (typeof messageKinds)[number];

/** How each kind of message is named for people. */
export const messageKindNames: Record<MessageKind, string> = {
  action_notice: "Action Notice",
  info_notice: "Info Notice",
  work_complete: "Work complete",
  digest: "Digest",
  test: "Test",
  report: "Wrap-up report",
  changelog: "Changelog entry",
  work_log: "Issue completed",
  batch_started: "Batch started",
  batch_finished: "Batch finished",
};

/** The longest Wrap-up report a publishing destination is sent. */
export const maxReportLength = 100_000;

const githubLink = z.object({
  number: z.number().int().positive(),
  url: z.string(),
});

/**
 * A work log's row for a completed issue (FR-92): its issue (and title)
 * and pull request, the Agents that worked it, its Review Loop rounds, and
 * the tokens and estimated cost it used. At "links only" it has no title
 * and names no Agent.
 */
export const workLogEntrySchema = z.object({
  issue: githubLink,
  /** The issue's title, as intake read it. */
  title: z.string().min(1).max(300).optional(),
  pullRequest: githubLink,
  agents: z.array(z.string().min(1).max(100)).max(50),
  reviewRounds: z.number().int().min(0),
  tokens: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
});
export type WorkLogEntry = z.infer<typeof workLogEntrySchema>;

/**
 * A calendar's event for a Batch (FR-92): which Batch it is, so there is
 * one event per Batch on the calendar, and when it started and finished.
 * Before it finishes, `finishedAt` is null; when AI Office does not know
 * when it started, `startedAt` is.
 */
export const calendarEntrySchema = z.object({
  floorId: z.string().min(1).max(100),
  batchId: z.number().int().positive(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

/**
 * One message to a notification channel, from a deterministic template
 * (FR-92): its title, Floor and kind, and links to it in AI Office and
 * on GitHub. A Digest also has its summary. Never a credential, code, a
 * diff or an issue's body (FR-95).
 */
export const outboundMessageSchema = z.object({
  kind: z.enum(messageKinds),
  title: z.string().min(1).max(300),
  /** A Digest's text, written from titles, outcomes and counts. */
  summary: z.string().min(1).max(3000).optional(),
  /**
   * A Wrap-up report, in Markdown, for a publishing destination; or a
   * calendar event's description.
   */
  document: z.string().min(1).max(maxReportLength).optional(),
  /** A completed issue's row, for a work log. */
  workLog: workLogEntrySchema.optional(),
  /** A Batch's event, for a calendar. */
  calendar: calendarEntrySchema.optional(),
  floor: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Where the Owner reads it in AI Office, such as the Notice. */
  aiOfficeUrl: z.string(),
  /** Its pull request, issue or CI run on GitHub; null when it has none. */
  githubUrl: z.string().nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

/**
 * Where a delivery is: waiting (to be retried, or held for quiet hours),
 * sent, given up, or summarised by a Digest instead of being sent.
 */
export const deliveryStatuses = [
  "pending",
  "delivered",
  "failed",
  "summarised",
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

/** One delivery to a Connection, as its log shows it (FR-93). */
export const connectionDeliverySchema = z.object({
  id: z.string(),
  message: outboundMessageSchema,
  /** True for a "Send test". */
  test: z.boolean(),
  status: z.enum(deliveryStatuses),
  attempts: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
  /** When it is next tried, while it is pending. */
  nextAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
  /** Why its last attempt failed; null when it did not. */
  error: z.string().nullable(),
});
export type ConnectionDelivery = z.infer<typeof connectionDeliverySchema>;

/** A Connection, as the API sends it: never its credentials. */
export const connectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(connectionTypes),
  rules: connectionRulesSchema,
  detailLevel: z.enum(detailLevels),
  /**
   * What identifies its credentials without giving them away, such as
   * the webhook's host.
   */
  hint: z.string(),
  /** What else is not secret about it, one line each, such as "Signed". */
  details: z.array(z.string()),
  paused: z.boolean(),
  status: z.enum(connectionStatuses),
  /** Failed deliveries in a row; 5 make it failing. */
  consecutiveFailures: z.number().int().min(0),
  /** Its latest delivery or test, as its log has it; null before any. */
  lastDelivery: connectionDeliverySchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Connection = z.infer<typeof connectionSchema>;

/** The body of `GET /api/connections`, oldest first. */
export const connectionListSchema = z.object({
  connections: z.array(connectionSchema),
});

/** The body of `GET /api/connections/:connectionId/deliveries`, newest first. */
export const connectionDeliveryListSchema = z.object({
  deliveries: z.array(connectionDeliverySchema),
});

/** The body of `POST /api/connections/:connectionId/test`. */
export const connectionTestResultSchema = z.object({
  delivered: z.boolean(),
  /** Why it was not, redacted. */
  error: z.string().nullable(),
  connection: connectionSchema,
});
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;

/**
 * How the Communications Agent looks at the lobby's reception desk until
 * the Owner changes it (FR-90, FR-96): the look the lobby's receptionist,
 * who sat there before, had by default.
 */
export const defaultCommunicationsAgentAvatar: Avatar =
  defaultLobbyCast.receptionist.avatar;

/** The Communications Agent, as the office admin shows it (FR-90). */
export const communicationsAgentSchema = z.object({
  name: z.string(),
  role: z.literal(communicationsRole),
  /** How it looks at the lobby's reception desk (FR-96). */
  avatar: avatarSchema,
  aiProvider: z.string(),
  /** The Model it uses for Digests and reports: its own or its AI Provider's default. */
  model: z.string().nullable(),
  modelOverride: z.string().nullable(),
  /** False while it is paused: deliveries wait until it resumes. */
  enabled: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type CommunicationsAgent = z.infer<typeof communicationsAgentSchema>;

/** The body of `PATCH /api/communications-agent`. */
export const updateCommunicationsAgentRequestSchema = z
  .strictObject({
    name: z
      .string({ error: "Name the Communications Agent." })
      .trim()
      .min(1, { error: "Name the Communications Agent." })
      .max(40, { error: "Use at most 40 characters for the name." })
      .regex(/^[^\p{Cc}]*$/u, { error: "Use one line for the name." }),
    aiProvider: z.enum(aiProviders, { error: "Choose an AI Provider." }),
    /** Null uses its AI Provider's default Model. */
    modelOverride: modelNameSchema.nullable(),
    /** False pauses it: nothing is sent, and deliveries queue. */
    enabled: z.boolean(),
    avatar: avatarSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    error: "Change at least one setting.",
  });
export type UpdateCommunicationsAgentRequest = z.infer<
  typeof updateCommunicationsAgentRequestSchema
>;

/** Codes in the `error` field of the Connections API's errors. */
export const connectionErrorCodes = {
  connectionNotFound: "connection_not_found",
  /** Another Connection has that name. */
  nameTaken: "connection_name_taken",
} as const;
export type ConnectionErrorCode =
  (typeof connectionErrorCodes)[keyof typeof connectionErrorCodes];
