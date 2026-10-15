import {
  googleFolderCredentialsSchema,
  type GoogleFolderCredentials,
} from "@ai-office/shared";

import { reportDeck, type Slide } from "../deck.ts";
import {
  deliveryProperty,
  driveMimeTypes,
  fileName,
  googleApi,
  type GoogleApiOptions,
  type Json,
} from "./google-api.ts";
import { DeliveryError, type ConnectionTransport } from "./transport.ts";

// Google Slides (PRD FR-91, FR-92), a publishing destination: each
// finished Batch's Wrap-up report becomes a short deck in the Owner's
// Google Drive folder, through the Owner's Google sign-in (`deck.ts`: the
// title, its outcomes, its issues and pull requests, its tokens and
// cost). The deck is made in the folder through Drive, then its slides
// written in one Slides batch update, which Google applies whole or not at
// all. It is idempotent, so a retry after a lost answer never makes a
// second deck or writes its slides twice: the deck is marked with its
// delivery's id and looked for by it before one is made, and its slides,
// whose ids AI Office chooses, are looked for before they are written.
// "Send test" only reads the folder. Nothing Google sends back is acted on
// beyond those ids (FR-95).

/** The prefix of every slide and text box AI Office writes. */
const slidePrefix = "aio_";

/** One placeholder's text: its paragraphs, then their bold and links. */
function textRequests(objectId: string, paragraphs: Slide["body"]): Json[] {
  const text = paragraphs
    .map((runs) => runs.map((run) => run.text).join(""))
    .join("\n");
  if (text === "") {
    return [];
  }
  const styles: Json[] = [];
  let at = 0;
  for (const runs of paragraphs) {
    for (const run of runs) {
      const range = {
        type: "FIXED_RANGE",
        startIndex: at,
        endIndex: at + run.text.length,
      };
      if (run.text !== "" && run.bold === true) {
        styles.push({
          updateTextStyle: {
            objectId,
            textRange: range,
            style: { bold: true },
            fields: "bold",
          },
        });
      }
      if (run.text !== "" && run.link !== undefined) {
        styles.push({
          updateTextStyle: {
            objectId,
            textRange: range,
            style: { link: { url: run.link } },
            fields: "link",
          },
        });
      }
      at += run.text.length;
    }
    // The newline between paragraphs.
    at += 1;
  }
  return [{ insertText: { objectId, insertionIndex: 0, text } }, ...styles];
}

/**
 * The requests that write `markdown`'s deck into a new presentation and
 * remove the slides it was made with (`existing`).
 */
export function deckRequests(
  markdown: string,
  existing: readonly string[],
): Json[] {
  const deck = reportDeck(markdown);
  const slide = (
    index: number,
    layout: "TITLE" | "TITLE_AND_BODY",
    { title, body }: Slide,
  ): Json[] => {
    const id = `${slidePrefix}s${String(index)}`;
    const [titleType, bodyType] =
      layout === "TITLE" ? ["CENTERED_TITLE", "SUBTITLE"] : ["TITLE", "BODY"];
    return [
      {
        createSlide: {
          objectId: id,
          insertionIndex: index,
          slideLayoutReference: { predefinedLayout: layout },
          placeholderIdMappings: [
            {
              layoutPlaceholder: { type: titleType, index: 0 },
              objectId: `${id}_title`,
            },
            {
              layoutPlaceholder: { type: bodyType, index: 0 },
              objectId: `${id}_body`,
            },
          ],
        },
      },
      ...textRequests(`${id}_title`, [[{ text: title }]]),
      ...textRequests(`${id}_body`, body),
    ];
  };
  return [
    ...slide(0, "TITLE", deck.cover),
    ...deck.slides.flatMap((one, index) =>
      slide(index + 1, "TITLE_AND_BODY", one),
    ),
    ...existing.map((objectId) => ({ deleteObject: { objectId } })),
  ];
}

export type GoogleSlidesTransportOptions = GoogleApiOptions;

export function googleSlidesTransport(
  options: GoogleSlidesTransportOptions,
): ConnectionTransport<GoogleFolderCredentials> {
  const api = googleApi("slides", options);

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
          "A Google Slides Connection publishes Wrap-up reports only.",
        );
      }
      const [found] = await api.filesWith(
        folderId,
        deliveryProperty,
        delivery.id,
      );
      const presentationId =
        found?.id ??
        (await api.create({
          name: fileName(message.title),
          folderId,
          mimeType: driveMimeTypes.presentation,
          properties: { [deliveryProperty]: delivery.id },
        }));
      const presentation = await api.call(
        "slides",
        "GET",
        `/v1/presentations/${encodeURIComponent(presentationId)}?fields=${encodeURIComponent("slides.objectId")}`,
      );
      const slides = ((presentation["slides"] ?? []) as Json[]).map((one) =>
        String(one["objectId"]),
      );
      // Written already, by an attempt whose answer was lost.
      if (slides.some((id) => id.startsWith(slidePrefix))) {
        return;
      }
      await api.call(
        "slides",
        "POST",
        `/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
        {
          json: {
            requests: deckRequests(message.document ?? message.title, slides),
          },
        },
      );
    },
  };
}
