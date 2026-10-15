import type { GoogleService } from "@ai-office/shared";

import type { GoogleAccess } from "../google.ts";
import { DeliveryError, retryAfterMs, unreachable } from "./transport.ts";

// Calls to Google's Drive, Docs, Slides and Calendar APIs for the Google
// Docs, Slides, Drive and Calendar Connections (PRD FR-91, FR-92), through
// the Owner's Google sign-in: each with a current access token for the
// Connection's service, refreshed once when Google refuses it early. Errors
// say what is wrong, never a token: a folder or calendar the account cannot
// reach, a rate limit (Drive's is a 403 with a reason, or a 429) with its
// `Retry-After`; and each carries the status Google answered, for a caller
// to whom a 404 or a 409 says something.

export type Json = Record<string, unknown>;

/** Where Google's APIs are; Google's own by default. */
export interface GoogleApiUrls {
  /** Drive's API and uploads; `https://www.googleapis.com`. */
  readonly driveUrl?: string;
  /** Docs' API; `https://docs.googleapis.com`. */
  readonly docsUrl?: string;
  /** Slides' API; `https://slides.googleapis.com`. */
  readonly slidesUrl?: string;
  /** Calendar's API; `https://www.googleapis.com`. */
  readonly calendarUrl?: string;
}

export interface GoogleApiOptions extends GoogleApiUrls {
  /** Where the access tokens come from: the Owner's Google sign-in. */
  readonly google: GoogleAccess;
  /** How long one request may take; 20 seconds by default. */
  readonly timeoutMs?: number;
}

/** Google's answer was not a success: a `DeliveryError` with its status. */
export class GoogleApiError extends DeliveryError {
  readonly status: number;

  constructor(
    message: string,
    status: number,
    options: ErrorOptions & { readonly retryAfterMs?: number } = {},
  ) {
    super(message, options);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

/** A request's body: JSON, or bytes of a content type. */
export type GoogleBody =
  | { readonly json: unknown }
  | { readonly contentType: string; readonly bytes: Uint8Array };

/** Google Drive's MIME types for a folder, a document and a deck. */
export const driveMimeTypes = {
  folder: "application/vnd.google-apps.folder",
  document: "application/vnd.google-apps.document",
  presentation: "application/vnd.google-apps.presentation",
} as const;

/**
 * The private property AI Office marks each file it makes with: the
 * delivery's id, the same on every attempt, so a retry after a lost answer
 * finds the file instead of making a second.
 */
export const deliveryProperty = "aiOfficeDelivery";

const trimmed = (url: string): string => url.replace(/\/+$/, "");

export function googleApi(service: GoogleService, options: GoogleApiOptions) {
  const { google } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const urls = {
    drive: trimmed(options.driveUrl ?? "https://www.googleapis.com"),
    docs: trimmed(options.docsUrl ?? "https://docs.googleapis.com"),
    slides: trimmed(options.slidesUrl ?? "https://slides.googleapis.com"),
    calendar: trimmed(options.calendarUrl ?? "https://www.googleapis.com"),
  };
  const api = {
    drive: "Google Drive",
    docs: "Google Docs",
    slides: "Google Slides",
    calendar: "Google Calendar",
  } as const;

  /**
   * Calls `api` at `path`; its JSON answer, or a `DeliveryError`. A refused
   * token is refreshed once and the call made again: Google can end a
   * token before it said it would.
   */
  const call = async (
    to: keyof typeof urls,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: GoogleBody,
  ): Promise<Json> => {
    const name = api[to];
    for (let attempt = 0; ; attempt += 1) {
      const token = await google.accessToken(service, {
        refresh: attempt > 0,
      });
      let response: Response;
      try {
        response = await fetch(`${urls[to]}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": "AI-Office",
            ...(body === undefined
              ? {}
              : {
                  "content-type":
                    "json" in body
                      ? "application/json; charset=utf-8"
                      : body.contentType,
                }),
          },
          ...(body === undefined
            ? {}
            : {
                body: "json" in body ? JSON.stringify(body.json) : body.bytes,
              }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw unreachable(name, error);
      }
      const json = (await response.json().catch(() => ({}))) as Json;
      if (response.ok) {
        return json;
      }
      const status = String(response.status);
      const error = (json["error"] ?? {}) as Json;
      const said = error["message"];
      const reasons = ((error["errors"] ?? []) as Json[]).map(
        (one) => one["reason"],
      );
      const wait = retryAfterMs(response.headers.get("retry-after"));
      const retry = wait === undefined ? {} : { retryAfterMs: wait };
      if (
        response.status === 429 ||
        reasons.some(
          (reason) =>
            reason === "rateLimitExceeded" ||
            reason === "userRateLimitExceeded",
        )
      ) {
        throw new GoogleApiError(
          `${name} is rate-limiting this Connection (${status}).`,
          response.status,
          retry,
        );
      }
      switch (response.status) {
        case 401:
          if (attempt === 0) {
            continue;
          }
          throw new GoogleApiError(
            `Google refused AI Office's access token (${status}): sign in to Google again.`,
            response.status,
          );
        case 403:
          throw new GoogleApiError(
            to === "calendar"
              ? `The Google account signed in may not do that: share the calendar with that account, with permission to make changes to events (${status}).`
              : `The Google account signed in may not do that: share the folder with that account, as an editor (${status}).`,
            response.status,
          );
        case 404:
          throw new GoogleApiError(
            to === "calendar"
              ? `${name} cannot find the calendar or an event on it: check its id, and share it with the Google account signed in (${status}).`
              : `${name} cannot find the folder or a file in it: check its address, and share it with the Google account signed in (${status}).`,
            response.status,
          );
        default:
          throw new GoogleApiError(
            `${name} answered ${status}${
              typeof said === "string" ? `: ${said.slice(0, 300)}` : ""
            }.`,
            response.status,
            retry,
          );
      }
    }
  };

  /** A query's string, quoted for Drive's search: `'it''s'`. */
  const quoted = (value: string): string =>
    `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

  return {
    call,

    /** Reads the folder, and says so when it is not one. */
    async folder(folderId: string): Promise<void> {
      const file = await call(
        "drive",
        "GET",
        `/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`,
      );
      if (file["mimeType"] !== driveMimeTypes.folder) {
        throw new DeliveryError(
          "That Google Drive address is a file, not a folder: give a folder's.",
        );
      }
      if (file["trashed"] === true) {
        throw new DeliveryError("The Google Drive folder is in the bin.");
      }
    },

    /**
     * The files in `folderId` (not in the bin) whose private property
     * `key` is `value`, oldest first.
     */
    async filesWith(
      folderId: string,
      key: string,
      value: string,
    ): Promise<{ readonly id: string; readonly mimeType: string }[]> {
      const q = [
        `${quoted(folderId)} in parents`,
        `appProperties has { key=${quoted(key)} and value=${quoted(value)} }`,
        "trashed = false",
      ].join(" and ");
      const answer = await call(
        "drive",
        "GET",
        `/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,mimeType)")}&orderBy=createdTime&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      );
      return ((answer["files"] ?? []) as Json[]).map((file) => ({
        id: String(file["id"]),
        mimeType: String(file["mimeType"]),
      }));
    },

    /**
     * Makes a file in Drive with its content, in one request; its id. A
     * `mimeType` of Google's own (a document) converts the content into
     * one.
     */
    async upload(file: {
      readonly name: string;
      readonly folderId: string;
      readonly mimeType: string;
      readonly properties: Readonly<Record<string, string>>;
      readonly contentType: string;
      readonly content: Uint8Array;
    }): Promise<string> {
      const boundary = `ai-office-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({
        name: file.name,
        mimeType: file.mimeType,
        parents: [file.folderId],
        appProperties: file.properties,
      });
      const bytes = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${file.contentType}\r\n\r\n`,
          "utf8",
        ),
        Buffer.from(file.content),
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
      ]);
      const made = await call(
        "drive",
        "POST",
        "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id",
        { contentType: `multipart/related; boundary=${boundary}`, bytes },
      );
      return String(made["id"]);
    },

    /** Makes an empty file of Google's own (a deck) in Drive; its id. */
    async create(file: {
      readonly name: string;
      readonly folderId: string;
      readonly mimeType: string;
      readonly properties: Readonly<Record<string, string>>;
    }): Promise<string> {
      const made = await call(
        "drive",
        "POST",
        "/drive/v3/files?supportsAllDrives=true&fields=id",
        {
          json: {
            name: file.name,
            mimeType: file.mimeType,
            parents: [file.folderId],
            appProperties: file.properties,
          },
        },
      );
      return String(made["id"]);
    },
  };
}

export type GoogleApi = ReturnType<typeof googleApi>;

/** A file's name in Drive: the report's title, on one line. */
export const fileName = (title: string): string =>
  title.replaceAll(/\p{Cc}/gu, " ").slice(0, 200);
