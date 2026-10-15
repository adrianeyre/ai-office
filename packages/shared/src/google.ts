import { z } from "zod";

// Google sign-in for the Google publishing destinations (PRD FR-91): the
// Owner registers an OAuth client in Google Cloud, enters its ID and secret
// in the office admin, and signs in to one Google account. AI Office asks
// only for the scopes of the Google services its Connections use, keeps
// the refresh token sealed, and refreshes the access token itself. A grant
// Google no longer honours (revoked, or expired) marks every Google
// Connection failing until the Owner signs in again. The server, the
// communications package and the web app share these.

/** The Google services a Connection can use. */
export const googleServices = [
  "sheets",
  "docs",
  "slides",
  "drive",
  "calendar",
] as const;
export type GoogleService = (typeof googleServices)[number];

export const googleServiceNames: Record<GoogleService, string> = {
  sheets: "Google Sheets",
  docs: "Google Docs",
  slides: "Google Slides",
  drive: "Google Drive",
  calendar: "Google Calendar",
};

/** Google Drive's scope: every file the signed-in account can reach. */
const driveScope = "https://www.googleapis.com/auth/drive";

/**
 * The OAuth scopes each service needs, and no more: Sheets writes rows to
 * the spreadsheet a Connection names, so it needs `spreadsheets` (Drive's
 * `drive.file` would reach only spreadsheets AI Office made itself). Docs,
 * Slides and Drive make files in the folder a Connection names, which
 * only `drive` reaches for the same reason; and `drive` covers the Docs
 * and Slides APIs too, so `documents` and `presentations` would add
 * nothing. Calendar makes and changes events on the calendar a Connection
 * names, which may be one shared with the account rather than its own, so
 * it needs `calendar.events` (neither `calendar.events.owned` nor
 * `calendar.app.created` reaches a shared calendar), and never the whole
 * of `calendar`, which could change calendars' settings and sharing.
 */
export const googleServiceScopes: Record<GoogleService, readonly string[]> = {
  sheets: ["https://www.googleapis.com/auth/spreadsheets"],
  docs: [driveScope],
  slides: [driveScope],
  drive: [driveScope],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
};

/** The scopes `services` need, each once, in a stable order. */
export const googleScopesFor = (services: readonly GoogleService[]): string[] =>
  [
    ...new Set(services.flatMap((service) => googleServiceScopes[service])),
  ].sort((a, b) => a.localeCompare(b));

/**
 * Where Google sends the Owner back after consent: a page of the web app,
 * served without a session (Google's redirect does not carry AI Office's
 * SameSite=Strict cookie). It holds nothing; it hands the code to the API,
 * which needs the session. The OAuth client's redirect URI is this path on
 * PUBLIC_URL.
 */
export const googleRedirectPath = "/admin/connections/google";

/** Where Google sign-in is shown in the office admin. */
export const googleSignInPath = "/general-settings/connections?google=1";

/**
 * Whether Google sign-in can be used: `not_configured` (no OAuth client
 * yet), `signed_out`, `signed_in`, or `revoked` (Google refused the
 * refresh token: the Owner signs in again).
 */
export const googleSignInStatuses = [
  "not_configured",
  "signed_out",
  "signed_in",
  "revoked",
] as const;
export type GoogleSignInStatus = (typeof googleSignInStatuses)[number];

/** Google sign-in, as the office admin shows it: never a secret or a token. */
export const googleSignInSchema = z.object({
  status: z.enum(googleSignInStatuses),
  /** The OAuth client's ID, which is not secret; null before one is entered. */
  clientId: z.string().nullable(),
  /** The address to register as the client's authorised redirect URI. */
  redirectUri: z.string(),
  /** The services the Google Connections use. */
  services: z.array(z.enum(googleServices)),
  /** The scopes signing in asks for: the services', and no more. */
  scopes: z.array(z.string()),
  /** The scopes Google granted at the last sign-in. */
  grantedScopes: z.array(z.string()),
  /** Services whose scopes were not granted: signing in again asks for them. */
  missingServices: z.array(z.enum(googleServices)),
  signedInAt: z.iso.datetime({ offset: true }).nullable(),
});
export type GoogleSignIn = z.infer<typeof googleSignInSchema>;

/** The body of `PUT /api/google/client`: the OAuth client, both write-only after. */
export const googleClientRequestSchema = z.strictObject({
  clientId: z
    .string({ error: "Give the OAuth client's ID." })
    .trim()
    .regex(/^[A-Za-z0-9-]{1,200}\.apps\.googleusercontent\.com$/, {
      error: "A client ID ends .apps.googleusercontent.com.",
    }),
  clientSecret: z
    .string({ error: "Give the OAuth client's secret." })
    .trim()
    .min(10, { error: "Give the OAuth client's secret." })
    .max(200, { error: "Use at most 200 characters for the secret." })
    .regex(/^[\x21-\x7e]+$/, {
      error: "A client secret is one word, such as GOCSPX-….",
    }),
});
export type GoogleClientRequest = z.infer<typeof googleClientRequestSchema>;

/** The body of `POST /api/google/sign-in`: where the Owner consents. */
export const googleSignInStartSchema = z.object({
  url: z.string(),
});
export type GoogleSignInStart = z.infer<typeof googleSignInStartSchema>;

/**
 * The body of `POST /api/google/sign-in/complete`: what Google's redirect
 * brought back, the code (or why there is none) and the sign-in's state.
 */
export const googleSignInCompleteRequestSchema = z.union([
  z.strictObject({
    code: z.string().min(1).max(2000),
    state: z.string().min(1).max(200),
  }),
  z.strictObject({
    error: z.string().min(1).max(200),
    state: z.string().min(1).max(200),
  }),
]);
export type GoogleSignInCompleteRequest = z.infer<
  typeof googleSignInCompleteRequestSchema
>;

/** Codes in the `error` field of the Google sign-in API's errors. */
export const googleErrorCodes = {
  /** No OAuth client has been entered. */
  notConfigured: "google_not_configured",
  /** No Google Connection needs a service, so there is nothing to ask for. */
  noServices: "google_no_services",
  /** The sign-in's state is unknown, used or too old. */
  signInNotFound: "google_sign_in_not_found",
  /** Google refused the code, or the Owner declined consent. */
  signInRefused: "google_sign_in_refused",
  /** Google could not be reached, or failed. */
  unavailable: "google_unavailable",
} as const;
export type GoogleErrorCode =
  (typeof googleErrorCodes)[keyof typeof googleErrorCodes];
