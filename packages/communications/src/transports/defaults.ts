import type { Transports } from "../communications.ts";
import type { GoogleAccess } from "../google.ts";
import { confluenceTransport } from "./confluence.ts";
import { emailTransport } from "./email.ts";
import { googleCalendarTransport } from "./google-calendar.ts";
import { googleDocsTransport } from "./google-docs.ts";
import { googleDriveTransport } from "./google-drive.ts";
import { googleSheetsTransport } from "./google-sheets.ts";
import { googleSlidesTransport } from "./google-slides.ts";
import { notionTransport } from "./notion.ts";
import { ntfyTransport } from "./ntfy.ts";
import { pushoverTransport } from "./pushover.ts";
import { slackTransport } from "./slack.ts";
import { DeliveryError } from "./transport.ts";
import { webhookTransport } from "./webhook.ts";

/** Google, when no sign-in is given: nothing can be published there. */
const noGoogle: GoogleAccess = {
  accessToken: () =>
    Promise.reject(
      new DeliveryError(
        "Google sign-in is not set up: enter the OAuth client and sign in on the Connections page.",
      ),
    ),
};

/**
 * A transport for each type of Connection, as AI Office sends. The Google
 * Connections publish through `google`, the Owner's Google sign-in.
 */
export const defaultTransports = (
  options: { readonly google?: GoogleAccess } = {},
): Transports => {
  const google = options.google ?? noGoogle;
  return {
    webhook: webhookTransport(),
    slack: slackTransport(),
    email: emailTransport(),
    ntfy: ntfyTransport(),
    pushover: pushoverTransport(),
    confluence: confluenceTransport(),
    notion: notionTransport(),
    google_sheets: googleSheetsTransport({ google }),
    google_docs: googleDocsTransport({ google }),
    google_slides: googleSlidesTransport({ google }),
    google_drive: googleDriveTransport({ google }),
    google_calendar: googleCalendarTransport({ google }),
  };
};
