import {
  googleFolderCredentialsSchema,
  type GoogleFolderCredentials,
} from "@ai-office/shared";

import { reportPdf } from "../pdf.ts";
import {
  deliveryProperty,
  fileName,
  googleApi,
  type GoogleApiOptions,
} from "./google-api.ts";
import { DeliveryError, type ConnectionTransport } from "./transport.ts";

// Google Drive (PRD FR-91, FR-92), a publishing destination: each finished
// Batch's Wrap-up report is saved in the Owner's Google Drive folder as a
// Markdown file and a PDF file (`pdf.ts`), through the Owner's Google
// sign-in, each made in one request. Both are idempotent, so a retry after
// a lost answer never saves either twice: each file is marked with its
// delivery's id, and the folder is searched for them before the one
// missing is saved. "Send test" only reads the folder. Nothing Google
// sends back is acted on beyond those ids (FR-95).

/** The two files each report is saved as. */
export const reportFiles = {
  markdown: { extension: "md", mimeType: "text/markdown" },
  pdf: { extension: "pdf", mimeType: "application/pdf" },
} as const;

export type GoogleDriveTransportOptions = GoogleApiOptions;

export function googleDriveTransport(
  options: GoogleDriveTransportOptions,
): ConnectionTransport<GoogleFolderCredentials> {
  const api = googleApi("drive", options);

  return {
    credentials: googleFolderCredentialsSchema,

    describe(credentials) {
      return {
        hint: `Folder ${credentials.folderId.slice(0, 8)}…`,
        settings: { folderId: credentials.folderId },
      };
    },

    // The folder is not secret; the tokens are the sign-in's.
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
      if (message.kind !== "report") {
        throw new DeliveryError(
          "A Google Drive Connection saves Wrap-up reports only.",
        );
      }
      const markdown = message.document ?? `# ${message.title}\n`;
      const saved = new Set(
        (await api.filesWith(folderId, deliveryProperty, delivery.id)).map(
          ({ mimeType }) => mimeType,
        ),
      );
      for (const [kind, file] of Object.entries(reportFiles)) {
        if (saved.has(file.mimeType)) {
          continue;
        }
        await api.upload({
          name: `${fileName(message.title)}.${file.extension}`,
          folderId,
          mimeType: file.mimeType,
          properties: { [deliveryProperty]: delivery.id },
          contentType:
            kind === "markdown"
              ? `${file.mimeType}; charset=utf-8`
              : file.mimeType,
          content:
            kind === "markdown"
              ? Buffer.from(markdown, "utf8")
              : reportPdf(markdown),
        });
      }
    },
  };
}
