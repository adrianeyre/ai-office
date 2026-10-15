import {
  googleFolderCredentialsSchema,
  type GoogleFolderCredentials,
  type OutboundMessage,
} from "@ai-office/shared";

import { confluenceStorage, escapeXml, parseMarkdown } from "../markdown.ts";
import { changelogLine, changelogTitle } from "./confluence.ts";
import {
  deliveryProperty,
  driveMimeTypes,
  fileName,
  googleApi,
  type GoogleApiOptions,
  type Json,
} from "./google-api.ts";
import { DeliveryError, type ConnectionTransport } from "./transport.ts";

// Google Docs (PRD FR-91, FR-92), a publishing destination: each finished
// Batch's Wrap-up report becomes a document in the Owner's Google Drive
// folder, through the Owner's Google sign-in. The document is made in one
// request, its report uploaded as HTML that Drive converts (headings,
// lists, the Results table, bold and links). With a running changelog,
// each merged pull request is an entry in one "AI Office changelog"
// document in the folder, made with the first, appended through the Docs
// API. Both are idempotent, so a retry after a lost answer never makes a
// second document or entry: a report's document is marked with its
// delivery's id and looked for by it before one is made, the changelog
// document by its own mark, and an entry by its pull request's link.
// "Send test" only reads the folder. Nothing Google sends back is acted on
// beyond those ids (FR-95).

/** The private property marking the changelog document. */
const changelogProperty = "aiOfficeChangelog";

/** Blocks as an HTML document Drive converts into a Google Doc. */
export const reportHtml = (title: string, markdown: string): string =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeXml(
    title,
  )}</title></head><body>${confluenceStorage(parseMarkdown(markdown))}</body></html>`;

/** The text runs of a Google Doc's body, in order. */
const runsOf = (document: Json): Json[] =>
  (((document["body"] as Json | undefined)?.["content"] ?? []) as Json[])
    .flatMap(
      (element) =>
        ((element["paragraph"] as Json | undefined)?.["elements"] ??
          []) as Json[],
    )
    .flatMap((element) => {
      const run = element["textRun"] as Json | undefined;
      return run === undefined ? [] : [run];
    });

/**
 * The requests that append a changelog entry to the end of a document
 * whose body ends at `endIndex`: a new paragraph, its date bold and its
 * title a link to its pull request. Whatever style the text before it had
 * is cleared first, as inserted text takes it on.
 */
export function changelogRequests(
  message: OutboundMessage,
  endIndex: number,
): Json[] {
  const line = changelogLine(message);
  const prefix = `${line.date}${line.floor === null ? " · " : ` · ${line.floor} · `}`;
  const text = `${prefix}${line.title}`;
  // Before the body's closing newline: the new paragraph starts after it.
  const at = endIndex - 1;
  const start = at + 1;
  const end = start + text.length;
  return [
    { insertText: { location: { index: at }, text: `\n${text}` } },
    {
      updateTextStyle: {
        range: { startIndex: start, endIndex: end },
        textStyle: {},
        fields: "bold,link",
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: start, endIndex: start + line.date.length },
        textStyle: { bold: true },
        fields: "bold",
      },
    },
    ...(line.url === null
      ? []
      : [
          {
            updateTextStyle: {
              range: { startIndex: start + prefix.length, endIndex: end },
              textStyle: { link: { url: line.url } },
              fields: "link",
            },
          },
        ]),
  ];
}

export type GoogleDocsTransportOptions = GoogleApiOptions;

export function googleDocsTransport(
  options: GoogleDocsTransportOptions,
): ConnectionTransport<GoogleFolderCredentials> {
  const api = googleApi("docs", options);

  /** The changelog document in the folder, made when there is none: its id. */
  const changelogDocument = async (folderId: string): Promise<string> => {
    const [found] = await api.filesWith(folderId, changelogProperty, "1");
    if (found !== undefined) {
      return found.id;
    }
    return api.upload({
      name: changelogTitle,
      folderId,
      mimeType: driveMimeTypes.document,
      properties: { [changelogProperty]: "1" },
      contentType: "text/html; charset=utf-8",
      content: Buffer.from(
        reportHtml(
          changelogTitle,
          `# ${changelogTitle}\n\nEach pull request AI Office merges, newest last.\n`,
        ),
        "utf8",
      ),
    });
  };

  return {
    credentials: googleFolderCredentialsSchema,

    describe(credentials) {
      return {
        hint: `Folder ${credentials.folderId.slice(0, 8)}…`,
        settings: { folderId: credentials.folderId },
      };
    },

    // The folder is not secret; the tokens are the sign-in's, kept out of
    // everything there.
    secrets: () => [],

    details(settings) {
      return [`In folder ${String(settings["folderId"])}`];
    },

    async send(delivery, { credentials }) {
      const { message } = delivery;
      const { folderId } = credentials;
      if (delivery.test) {
        await api.folder(folderId);
        return;
      }
      switch (message.kind) {
        case "report": {
          const [made] = await api.filesWith(
            folderId,
            deliveryProperty,
            delivery.id,
          );
          if (made !== undefined) {
            return;
          }
          await api.upload({
            name: fileName(message.title),
            folderId,
            mimeType: driveMimeTypes.document,
            properties: { [deliveryProperty]: delivery.id },
            contentType: "text/html; charset=utf-8",
            content: Buffer.from(
              reportHtml(message.title, message.document ?? message.title),
              "utf8",
            ),
          });
          return;
        }
        case "changelog": {
          const documentId = await changelogDocument(folderId);
          const document = await api.call(
            "docs",
            "GET",
            `/v1/documents/${encodeURIComponent(documentId)}`,
          );
          // An entry is its pull request's link: one already there stands.
          if (
            message.githubUrl !== null &&
            runsOf(document).some(
              (run) =>
                (
                  (run["textStyle"] as Json | undefined)?.["link"] as
                    Json | undefined
                )?.["url"] === message.githubUrl,
            )
          ) {
            return;
          }
          const content = ((document["body"] as Json | undefined)?.[
            "content"
          ] ?? []) as Json[];
          const endIndex = Number(content.at(-1)?.["endIndex"] ?? 1);
          await api.call(
            "docs",
            "POST",
            `/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
            {
              json: {
                requests: changelogRequests(message, endIndex),
                // Written where the document ended when it was read.
                writeControl: { requiredRevisionId: document["revisionId"] },
              },
            },
          );
          return;
        }
        default:
          throw new DeliveryError(
            "A Google Docs Connection publishes Wrap-up reports and changelog entries only.",
          );
      }
    },
  };
}
