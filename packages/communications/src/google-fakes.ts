import { createHash, randomBytes } from "node:crypto";

import {
  fakeCalendar,
  type FakeCalendarEvent,
} from "./google-calendar-fakes.ts";
import {
  fakeWorkspace,
  type FakeDocParagraph,
  type FakeDriveFile,
  type FakeSlideView,
} from "./google-workspace-fakes.ts";
import { faults, listen, send, type Faults } from "./publishing-fakes.ts";

// A fake Google, for Google sign-in's and the Google Sheets Connection's
// contract tests (PRD §9: a contract suite per Connection type against
// local fakes). Its OAuth endpoints answer as Google's do for a web
// application client: the consent screen (which the test plays the Owner
// on) checks the client, its redirect URI and PKCE, and grants the scopes
// asked for or fewer; the token endpoint exchanges a code once, refreshes,
// and refuses a revoked grant with `invalid_grant`. Its Sheets API keeps
// spreadsheets in memory, takes only valid, unexpired access tokens with
// the spreadsheets scope, adds tabs, reads a column and appends rows. Its
// Drive, Docs and Slides APIs (`google-workspace-fakes.ts`) take only
// tokens with the drive scope, and keep the folders given, their files,
// documents and decks. Its Calendar API (`google-calendar-fakes.ts`) takes
// only tokens with the calendar.events scope, and keeps the calendars
// given and their events. It can carry out a write but lose its answer,
// and answer 429s.

/** What Google's redirect brings back to AI Office after the consent screen. */
export interface FakeConsent {
  readonly redirectUri: string;
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

/** One consent screen the Owner was shown. */
export interface ConsentScreen {
  /** The scopes it asked for. */
  readonly scopes: readonly string[];
  /** Every parameter of the authorization URL. */
  readonly params: Readonly<Record<string, string>>;
}

export interface FakeGoogle extends Faults {
  /** Google's OAuth endpoints, as `createGoogleAuth`'s `endpoints`. */
  readonly endpoints: {
    readonly authorizeUrl: string;
    readonly tokenUrl: string;
    readonly revokeUrl: string;
  };
  /** Google Sheets' API, as `googleSheetsTransport`'s `apiUrl`. */
  readonly sheetsUrl: string;
  /** Drive's, Docs' and Slides' APIs, as the Google Docs, Slides and Drive transports' URLs. */
  readonly apiUrls: {
    readonly driveUrl: string;
    readonly docsUrl: string;
    readonly slidesUrl: string;
    readonly calendarUrl: string;
  };
  /**
   * The Owner on the consent screen for `authorizationUrl`: approving
   * every scope asked for (or only `grant`), or declining. Throws, as
   * Google shows an error page, for a request that is not a valid one.
   */
  consent(
    authorizationUrl: string,
    choice?: { readonly grant?: readonly string[]; readonly decline?: true },
  ): FakeConsent;
  readonly consents: ConsentScreen[];
  /** The Owner removes AI Office's access in their Google account: every token stops. */
  revokeGrant(): void;
  /** Ends every access token now, before it said it would; refresh tokens stand. */
  expireAccessTokens(): void;
  /** Every request to the token endpoint, by its grant type. */
  readonly tokenRequests: { readonly grantType: string }[];
  /** Every refresh token revoked through the revoke endpoint. */
  readonly revoked: string[];
  /** Every token Google gave out, to look for in what AI Office keeps. */
  readonly issuedTokens: string[];
  /** A tab's rows; undefined when the spreadsheet has no such tab. */
  rows(spreadsheetId: string, tab: string): unknown[][] | undefined;
  tabs(spreadsheetId: string): string[];
  /** A folder's files (not in the bin), oldest first. */
  files(folderId: string): FakeDriveFile[];
  /** A document's paragraphs; undefined when there is no such document. */
  document(documentId: string): FakeDocParagraph[] | undefined;
  /** A deck's slides; undefined when there is no such deck. */
  presentation(presentationId: string): FakeSlideView[] | undefined;
  /** Every Drive, Docs and Slides request, as method and path. */
  readonly workspaceRequests: {
    readonly method: string;
    readonly path: string;
  }[];
  /** A calendar's events, deleted ones too, oldest first. */
  calendarEvents(calendarId: string): FakeCalendarEvent[];
  /**
   * The Owner deletes an event in Calendar: it is cancelled, or with
   * `purge` gone, its id taken still.
   */
  deleteEvent(
    calendarId: string,
    eventId: string,
    options?: { readonly purge?: true },
  ): void;
  /** Every Calendar request, as method and path. */
  readonly calendarRequests: {
    readonly method: string;
    readonly path: string;
  }[];
  /** Every Sheets request, as method, path and its `valueInputOption`. */
  readonly sheetsRequests: {
    readonly method: string;
    readonly path: string;
    readonly valueInputOption: string | null;
  }[];
  close(): Promise<void>;
}

const sheetsScope = "https://www.googleapis.com/auth/spreadsheets";
const driveScope = "https://www.googleapis.com/auth/drive";
const calendarScope = "https://www.googleapis.com/auth/calendar.events";

const token = (prefix: string): string =>
  `${prefix}${randomBytes(30).toString("base64url")}`;

/** A column's index from its letters: `A` is 0, `L` is 11. */
const columnIndex = (letters: string): number => {
  let index = 0;
  for (let at = 0; at < letters.length; at += 1) {
    index = index * 26 + letters.toUpperCase().charCodeAt(at) - 64;
  }
  return index - 1;
};

/** A range in A1 notation: its tab and what follows the `!`. */
function parseRange(range: string): { tab: string; cells: string } {
  const quoted = /^'((?:[^']|'')+)'!(.+)$/.exec(range);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { tab: quoted[1].replaceAll("''", "'"), cells: quoted[2] };
  }
  const [tab = "", cells = "A1"] = range.split("!");
  return { tab, cells };
}

/**
 * A fake Google: one OAuth web client (`clientId`, `clientSecret`, its one
 * `redirectUri`), and the spreadsheets given, each with its tabs, every one
 * editable by the account that signs in.
 */
export async function serveFakeGoogle(options: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly spreadsheets: readonly {
    readonly id: string;
    readonly tabs: readonly string[];
  }[];
  /** Drive folders, each editable by the account that signs in. */
  readonly folders?: readonly { readonly id: string; readonly name: string }[];
  /** Calendars by their ids, each one the account that signs in can change events on. */
  readonly calendars?: readonly string[];
  /** How long an access token lasts; an hour by default. */
  readonly accessTokenSeconds?: number;
  readonly now?: () => Date;
}): Promise<FakeGoogle> {
  const fault = faults();
  const now = options.now ?? (() => new Date());
  const lifetime = options.accessTokenSeconds ?? 3600;
  const consents: ConsentScreen[] = [];
  const tokenRequests: { grantType: string }[] = [];
  const revoked: string[] = [];
  const issuedTokens: string[] = [];
  const sheetsRequests: {
    method: string;
    path: string;
    valueInputOption: string | null;
  }[] = [];
  const codes = new Map<
    string,
    { scopes: string[]; challenge: string; redirectUri: string }
  >();
  /** Each grant: its scopes and whether it still stands. */
  const grants: { scopes: string[]; revoked: boolean }[] = [];
  const refreshTokens = new Map<string, number>();
  const accessTokens = new Map<string, { grant: number; expiresAt: number }>();
  const workspace = fakeWorkspace(options.folders ?? []);
  const workspaceRequests: { method: string; path: string }[] = [];
  const calendar = fakeCalendar(options.calendars ?? []);
  const calendarRequests: { method: string; path: string }[] = [];
  const sheets = new Map(
    options.spreadsheets.map(({ id, tabs }) => [
      id,
      new Map(tabs.map((tab) => [tab, [] as unknown[][]])),
    ]),
  );

  const issueAccessToken = (grant: number) => {
    const access = token("ya29.");
    issuedTokens.push(access);
    accessTokens.set(access, {
      grant,
      expiresAt: now().getTime() + lifetime * 1000,
    });
    return access;
  };

  const listening = await listen((request, response, raw, bytes) => {
    const url = new URL(request.url ?? "/", "http://google.invalid");
    const method = request.method ?? "GET";

    if (method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      const grantType = form.get("grant_type") ?? "";
      tokenRequests.push({ grantType });
      if (
        form.get("client_id") !== options.clientId ||
        form.get("client_secret") !== options.clientSecret
      ) {
        send(response, 401, {
          error: "invalid_client",
          error_description: "The OAuth client was not found.",
        });
        return;
      }
      if (grantType === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          code?.redirectUri !== form.get("redirect_uri") ||
          createHash("sha256").update(verifier).digest("base64url") !==
            code.challenge
        ) {
          send(response, 400, {
            error: "invalid_grant",
            error_description: "Malformed auth code.",
          });
          return;
        }
        grants.push({ scopes: code.scopes, revoked: false });
        const grant = grants.length - 1;
        const refresh = token("1//0");
        issuedTokens.push(refresh);
        refreshTokens.set(refresh, grant);
        send(response, 200, {
          access_token: issueAccessToken(grant),
          expires_in: lifetime,
          refresh_token: refresh,
          scope: code.scopes.join(" "),
          token_type: "Bearer",
        });
        return;
      }
      if (grantType === "refresh_token") {
        const grant = refreshTokens.get(form.get("refresh_token") ?? "");
        if (grant === undefined || grants[grant]?.revoked !== false) {
          send(response, 400, {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          });
          return;
        }
        send(response, 200, {
          access_token: issueAccessToken(grant),
          expires_in: lifetime,
          scope: grants[grant].scopes.join(" "),
          token_type: "Bearer",
        });
        return;
      }
      send(response, 400, { error: "unsupported_grant_type" });
      return;
    }

    if (method === "POST" && url.pathname === "/revoke") {
      const revoking = new URLSearchParams(raw).get("token") ?? "";
      const grant = refreshTokens.get(revoking);
      if (grant === undefined) {
        send(response, 400, { error: "invalid_token" });
        return;
      }
      revoked.push(revoking);
      const standing = grants[grant];
      if (standing !== undefined) {
        standing.revoked = true;
      }
      send(response, 200, {});
      return;
    }

    const toWorkspace = workspace.handles(url.pathname);
    const toCalendar = calendar.handles(url.pathname);
    if (
      !toWorkspace &&
      !toCalendar &&
      !url.pathname.startsWith("/v4/spreadsheets/")
    ) {
      send(response, 404, { error: { code: 404, message: "Not found." } });
      return;
    }
    if (toWorkspace) {
      workspaceRequests.push({ method, path: url.pathname });
    } else if (toCalendar) {
      calendarRequests.push({ method, path: url.pathname });
    } else {
      sheetsRequests.push({
        method,
        path: url.pathname,
        valueInputOption: url.searchParams.get("valueInputOption"),
      });
    }
    if (fault.limit(response)) {
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    const access = accessTokens.get(bearer?.[1] ?? "");
    const grant = access === undefined ? undefined : grants[access.grant];
    if (
      access === undefined ||
      grant === undefined ||
      grant.revoked ||
      access.expiresAt <= now().getTime()
    ) {
      send(response, 401, {
        error: {
          code: 401,
          message: "Request had invalid authentication credentials.",
          status: "UNAUTHENTICATED",
        },
      });
      return;
    }
    if (
      !grant.scopes.includes(
        toWorkspace ? driveScope : toCalendar ? calendarScope : sheetsScope,
      )
    ) {
      send(response, 403, {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
        },
      });
      return;
    }
    if (toCalendar) {
      calendar.handle(method, url, raw, response, () => fault.lost());
      return;
    }
    if (toWorkspace) {
      workspace.handle(
        method,
        url,
        request.headers["content-type"] ?? "",
        raw,
        bytes,
        response,
        () => fault.lost(),
      );
      return;
    }
    // /v4/spreadsheets/{id}[:batchUpdate | /values/{range}[:append]]
    const rest = url.pathname.slice("/v4/spreadsheets/".length);
    const [head = "", values, rawRange = ""] = rest.split("/");
    const batchUpdate = head.endsWith(":batchUpdate");
    const spreadsheetId = batchUpdate
      ? head.slice(0, -":batchUpdate".length)
      : head;
    const spreadsheet = sheets.get(spreadsheetId);
    if (spreadsheet === undefined) {
      send(response, 404, {
        error: {
          code: 404,
          message: "Requested entity was not found.",
          status: "NOT_FOUND",
        },
      });
      return;
    }
    if (method === "GET" && values === undefined && !batchUpdate) {
      send(response, 200, {
        spreadsheetId,
        sheets: [...spreadsheet.keys()].map((title, index) => ({
          properties: { sheetId: index, title },
        })),
      });
      return;
    }
    if (method === "POST" && batchUpdate) {
      const body = JSON.parse(raw) as {
        requests?: { addSheet?: { properties?: { title?: string } } }[];
      };
      for (const one of body.requests ?? []) {
        const title = one.addSheet?.properties?.title;
        if (title === undefined || spreadsheet.has(title)) {
          send(response, 400, {
            error: {
              code: 400,
              message: `Invalid requests[0].addSheet: A sheet with the name "${String(title)}" already exists.`,
            },
          });
          return;
        }
        spreadsheet.set(title, []);
      }
      send(response, 200, { spreadsheetId, replies: [{ addSheet: {} }] });
      return;
    }
    if (values !== "values") {
      send(response, 400, { error: { code: 400, message: "Bad request." } });
      return;
    }
    const appending = rawRange.endsWith(":append");
    const range = decodeURIComponent(
      appending ? rawRange.slice(0, -":append".length) : rawRange,
    );
    const { tab, cells } = parseRange(range);
    const rows = spreadsheet.get(tab);
    if (rows === undefined) {
      send(response, 400, {
        error: { code: 400, message: `Unable to parse range: ${range}` },
      });
      return;
    }
    if (method === "GET" && !appending) {
      const column = /^([A-Z]+):\1$/.exec(cells)?.[1];
      if (column === undefined) {
        send(response, 400, { error: { code: 400, message: "Bad range." } });
        return;
      }
      const index = columnIndex(column);
      const cellsOf = rows.map((row) => row[index] ?? "");
      while (cellsOf.at(-1) === "") {
        cellsOf.pop();
      }
      send(response, 200, {
        range,
        majorDimension: url.searchParams.get("majorDimension") ?? "ROWS",
        ...(cellsOf.length === 0 ? {} : { values: [cellsOf] }),
      });
      return;
    }
    if (method === "POST" && appending) {
      const inputOption = url.searchParams.get("valueInputOption");
      if (inputOption !== "RAW" && inputOption !== "USER_ENTERED") {
        send(response, 400, {
          error: { code: 400, message: "valueInputOption is required." },
        });
        return;
      }
      const body = JSON.parse(raw) as { values?: unknown[][] };
      const added = body.values ?? [];
      rows.push(...added.map((row) => [...row]));
      if (fault.lost()) {
        send(response, 502, { error: { code: 502, message: "Bad gateway" } });
        return;
      }
      send(response, 200, {
        spreadsheetId,
        updates: { updatedRows: added.length },
      });
      return;
    }
    send(response, 400, { error: { code: 400, message: "Bad request." } });
  });

  return {
    ...fault.control,
    endpoints: {
      authorizeUrl: `${listening.url}/o/oauth2/v2/auth`,
      tokenUrl: `${listening.url}/token`,
      revokeUrl: `${listening.url}/revoke`,
    },
    sheetsUrl: listening.url,
    apiUrls: {
      driveUrl: listening.url,
      docsUrl: listening.url,
      slidesUrl: listening.url,
      calendarUrl: listening.url,
    },
    consent(authorizationUrl, choice = {}) {
      const url = new URL(authorizationUrl);
      const params = Object.fromEntries(url.searchParams);
      const scopes = (params["scope"] ?? "")
        .split(" ")
        .filter((scope) => scope !== "");
      if (
        `${url.origin}${url.pathname}` !==
          `${listening.url}/o/oauth2/v2/auth` ||
        params["client_id"] !== options.clientId ||
        params["redirect_uri"] !== options.redirectUri ||
        params["response_type"] !== "code" ||
        params["code_challenge_method"] !== "S256" ||
        (params["code_challenge"] ?? "") === "" ||
        (params["state"] ?? "") === "" ||
        scopes.length === 0
      ) {
        throw new Error("Error 400: invalid_request");
      }
      consents.push({ scopes, params });
      const state = params["state"] ?? "";
      if (choice.decline === true) {
        return {
          redirectUri: options.redirectUri,
          state,
          error: "access_denied",
        };
      }
      const code = token("4/0");
      codes.set(code, {
        scopes: (choice.grant ?? scopes).filter((scope) =>
          scopes.includes(scope),
        ),
        challenge: params["code_challenge"] ?? "",
        redirectUri: options.redirectUri,
      });
      return { redirectUri: options.redirectUri, state, code };
    },
    consents,
    revokeGrant() {
      for (const grant of grants) {
        grant.revoked = true;
      }
    },
    expireAccessTokens() {
      for (const access of accessTokens.values()) {
        access.expiresAt = now().getTime();
      }
    },
    tokenRequests,
    revoked,
    issuedTokens,
    rows: (spreadsheetId, tab) =>
      sheets
        .get(spreadsheetId)
        ?.get(tab)
        ?.map((row) => [...row]),
    tabs: (spreadsheetId) => [...(sheets.get(spreadsheetId)?.keys() ?? [])],
    sheetsRequests,
    files: workspace.files,
    document: workspace.document,
    presentation: workspace.presentation,
    workspaceRequests,
    calendarEvents: calendar.events,
    deleteEvent: calendar.deleteEvent,
    calendarRequests,
    close: listening.close,
  };
}
