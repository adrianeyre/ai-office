import {
  googleSheetsCredentialsSchema,
  messageKindNames,
  type GoogleSheetsCredentials,
  type OutboundMessage,
} from "@ai-office/shared";

import type { GoogleAccess } from "../google.ts";
import {
  DeliveryError,
  retryAfterMs,
  unreachable,
  type ConnectionTransport,
} from "./transport.ts";

// Google Sheets (PRD FR-91, FR-92), a publishing destination: a work log in
// the Owner's spreadsheet and tab, written through the Owner's Google
// sign-in. Each completed issue is one row (date, Floor, issue, title,
// pull request, Agents, Review Loop rounds, tokens, estimated cost), and
// with its Notices rule each Notice is one too; "Send test" writes a test
// row. The tab is made when the spreadsheet has none by its name, with a
// header row. Values are written `RAW`, so nothing a title says is ever
// read as a formula. Every row ends with its delivery's id, the same on
// every attempt, and the tab's ids are read before a row is appended: a
// retry after a lost answer never writes a row twice. Nothing Google sends
// back is acted on beyond that (FR-95).

/** The work log's columns, its header row. */
export const workLogHeader = [
  "Date",
  "Kind",
  "Floor",
  "Issue",
  "Title",
  "Pull request",
  "Agents",
  "Review Loop rounds",
  "Tokens",
  "Estimated cost (USD)",
  "AI Office",
  "AI Office ID",
] as const;

/** The column holding each row's id: the last. */
const idColumn = String.fromCharCode(
  "A".charCodeAt(0) + workLogHeader.length - 1,
);

type Cell = string | number;

/** When it happened, as a work log shows it: `2026-10-10 11:00 UTC`. */
const dateCell = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** A Notice's GitHub link, in the column it belongs in. */
const githubCells = (
  url: string | null,
): { readonly issue: string; readonly pullRequest: string } => ({
  issue: url !== null && /\/issues\/\d+/.test(url) ? url : "",
  pullRequest: url !== null && /\/pull\/\d+/.test(url) ? url : "",
});

/**
 * The row `message` makes in a work log, ending with `id`: a completed
 * issue's, a Notice's or a test's. At "links only" the message has no
 * Floor, title or Agents to give.
 */
export function workLogRow(message: OutboundMessage, id: string): Cell[] {
  const { workLog } = message;
  if (message.kind === "work_log" && workLog !== undefined) {
    return [
      dateCell(message.occurredAt),
      messageKindNames.work_log,
      message.floor?.name ?? "",
      workLog.issue.url,
      workLog.title ?? "",
      workLog.pullRequest.url,
      workLog.agents.join(", "),
      workLog.reviewRounds,
      workLog.tokens,
      Math.round(workLog.estimatedCostUsd * 100) / 100,
      message.aiOfficeUrl,
      id,
    ];
  }
  const github = githubCells(message.githubUrl);
  return [
    dateCell(message.occurredAt),
    messageKindNames[message.kind],
    message.floor?.name ?? "",
    github.issue,
    message.title,
    github.pullRequest,
    "",
    "",
    "",
    "",
    message.aiOfficeUrl,
    id,
  ];
}

/** A tab in A1 notation, quoted: `'Work log'!A1`. */
const inTab = (tab: string, range: string): string =>
  `'${tab.replaceAll("'", "''")}'!${range}`;

export interface GoogleSheetsTransportOptions {
  /** Where the access tokens come from: the Owner's Google sign-in. */
  readonly google: GoogleAccess;
  /** Google Sheets' API; `https://sheets.googleapis.com` by default. */
  readonly apiUrl?: string;
  /** How long one request may take; 20 seconds by default. */
  readonly timeoutMs?: number;
}

type Json = Record<string, unknown>;

export function googleSheetsTransport(
  options: GoogleSheetsTransportOptions,
): ConnectionTransport<GoogleSheetsCredentials> {
  const { google } = options;
  const apiUrl = (options.apiUrl ?? "https://sheets.googleapis.com").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = options.timeoutMs ?? 20_000;

  /**
   * Calls the Sheets API with the sign-in's access token; its JSON answer,
   * or a `DeliveryError`. A refused token is refreshed once and the call
   * made again: Google can end a token before it said it would.
   */
  const call = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Json> => {
    for (let attempt = 0; ; attempt += 1) {
      const token = await google.accessToken("sheets", {
        refresh: attempt > 0,
      });
      let response: Response;
      try {
        response = await fetch(`${apiUrl}/v4/spreadsheets/${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": "AI-Office",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json; charset=utf-8" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw unreachable("Google Sheets", error);
      }
      const json = (await response.json().catch(() => ({}))) as Json;
      if (response.ok) {
        return json;
      }
      const status = String(response.status);
      const said = (json["error"] as Json | undefined)?.["message"];
      switch (response.status) {
        case 401:
          if (attempt === 0) {
            continue;
          }
          throw new DeliveryError(
            `Google refused AI Office's access token (${status}): sign in to Google again.`,
          );
        case 403:
          throw new DeliveryError(
            `The Google account signed in cannot edit the spreadsheet: share it with that account (${status}).`,
          );
        case 404:
          throw new DeliveryError(
            `Google Sheets has no spreadsheet with that id (${status}).`,
          );
        case 429: {
          const wait = retryAfterMs(response.headers.get("retry-after"));
          throw new DeliveryError(
            "Google Sheets is rate-limiting this Connection (429).",
            wait === undefined ? {} : { retryAfterMs: wait },
          );
        }
        default:
          throw new DeliveryError(
            `Google Sheets answered ${status}${
              typeof said === "string" ? `: ${said.slice(0, 300)}` : ""
            }.`,
          );
      }
    }
  };

  /** Makes the tab unless the spreadsheet has one by its name. */
  const ensureTab = async ({
    spreadsheetId,
    tab,
  }: GoogleSheetsCredentials): Promise<void> => {
    const spreadsheet = await call(
      "GET",
      `${spreadsheetId}?fields=sheets.properties.title`,
    );
    const tabs = ((spreadsheet["sheets"] ?? []) as Json[]).map(
      (sheet) => (sheet["properties"] as Json | undefined)?.["title"],
    );
    if (!tabs.includes(tab)) {
      await call("POST", `${spreadsheetId}:batchUpdate`, {
        requests: [{ addSheet: { properties: { title: tab } } }],
      });
    }
  };

  /** Every id in the tab's id column, its header included. */
  const idsIn = async ({
    spreadsheetId,
    tab,
  }: GoogleSheetsCredentials): Promise<string[]> => {
    const range = inTab(tab, `${idColumn}:${idColumn}`);
    const answer = await call(
      "GET",
      `${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=COLUMNS`,
    );
    const [column] = (answer["values"] ?? []) as unknown[][];
    return (column ?? []).map(String);
  };

  return {
    credentials: googleSheetsCredentialsSchema,

    describe(credentials) {
      return {
        hint: `"${credentials.tab}" in ${credentials.spreadsheetId.slice(0, 8)}…`,
        settings: {
          spreadsheetId: credentials.spreadsheetId,
          tab: credentials.tab,
        },
      };
    },

    // Neither the spreadsheet nor the tab is secret; the tokens are the
    // sign-in's, kept out of everything there.
    secrets: () => [],

    details(settings) {
      return [
        `Spreadsheet ${String(settings["spreadsheetId"])}`,
        `Tab "${String(settings["tab"])}"`,
      ];
    },

    async send(delivery, { credentials }) {
      const { message } = delivery;
      if (
        message.kind !== "work_log" &&
        message.kind !== "action_notice" &&
        message.kind !== "info_notice" &&
        message.kind !== "test"
      ) {
        throw new DeliveryError(
          "A Google Sheets Connection keeps a work log: completed issues and Notices only.",
        );
      }
      await ensureTab(credentials);
      const ids = await idsIn(credentials);
      // Already written, by an attempt whose answer was lost.
      if (ids.includes(delivery.id)) {
        return;
      }
      const row = workLogRow(message, delivery.id);
      const range = inTab(credentials.tab, "A1");
      await call(
        "POST",
        `${credentials.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          range,
          majorDimension: "ROWS",
          // An empty tab starts with the header row.
          values: ids.length === 0 ? [[...workLogHeader], row] : [row],
        },
      );
    },
  };
}
