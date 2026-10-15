import {
  messageKindNames,
  pushoverCredentialsSchema,
  type OutboundMessage,
  type PushoverCredentials,
} from "@ai-office/shared";

import {
  DeliveryError,
  retryAfterMs,
  unreachable,
  type ConnectionTransport,
} from "./transport.ts";

// Phone push through Pushover (PRD FR-91): each message is sent with the
// Owner's application token to their user (or group) key. Its link opens
// it in AI Office; the GitHub link is in the text. Action Notices are sent
// at high priority, which sounds even in the phone's quiet hours. Nothing
// Pushover sends back is acted on (FR-95).

/** Pushover's priorities: 1 is high, 0 normal. */
export const pushoverPriority = (message: OutboundMessage): number =>
  message.kind === "action_notice" ? 1 : 0;

/** Pushover's limits: a title of 250 characters, a message of 1024, a URL of 512. */
const cut = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

/** What Pushover is sent for a message, without the credentials. */
export function pushoverFields(
  message: OutboundMessage,
  test: boolean,
): Record<string, string> {
  const kind = test ? "Test" : messageKindNames[message.kind];
  const lines = [
    message.summary ??
      (message.floor === null ? kind : `${message.floor.name} · ${kind}`),
    ...(message.githubUrl === null ? [] : [`GitHub: ${message.githubUrl}`]),
  ];
  return {
    title: cut(message.title, 250),
    message: cut(lines.join("\n"), 1024),
    priority: String(pushoverPriority(message)),
    url: message.aiOfficeUrl.slice(0, 512),
    url_title: "Open in AI Office",
    timestamp: String(Math.floor(Date.parse(message.occurredAt) / 1000)),
  };
}

/** What Pushover answers. */
interface PushoverAnswer {
  readonly status?: unknown;
  readonly token?: unknown;
  readonly user?: unknown;
}

export interface PushoverTransportOptions {
  /** Pushover's API; a test's fake Pushover in tests. */
  readonly apiUrl?: string;
  /** How long one request may take; 10 seconds by default. */
  readonly timeoutMs?: number;
}

export function pushoverTransport(
  options: PushoverTransportOptions = {},
): ConnectionTransport<PushoverCredentials> {
  const apiUrl = (options.apiUrl ?? "https://api.pushover.net").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    credentials: pushoverCredentialsSchema,

    describe(credentials) {
      return {
        hint: `user key ${credentials.userKey.slice(0, 4)}…`,
        settings: {},
      };
    },

    details() {
      return ["Pushover"];
    },

    async send(delivery, { credentials }) {
      let response: Response;
      try {
        response = await fetch(`${apiUrl}/1/messages.json`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "AI-Office",
          },
          body: new URLSearchParams({
            token: credentials.applicationToken,
            user: credentials.userKey,
            ...pushoverFields(delivery.message, delivery.test),
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw unreachable("Pushover", error);
      }
      const status = String(response.status);
      if (response.status === 429) {
        await response.body?.cancel();
        const wait = retryAfterMs(response.headers.get("retry-after"));
        throw new DeliveryError(
          "Pushover's application has reached its message limit (429).",
          wait === undefined ? {} : { retryAfterMs: wait },
        );
      }
      const answer = (await response
        .json()
        .catch(() => ({}))) as PushoverAnswer;
      if (response.ok && answer.status === 1) {
        return;
      }
      // Only what Pushover says was invalid is shown, never its text.
      if (answer.token === "invalid") {
        throw new DeliveryError(
          `Pushover refused the application token (${status}).`,
        );
      }
      if (answer.user === "invalid") {
        throw new DeliveryError(`Pushover refused the user key (${status}).`);
      }
      throw new DeliveryError(
        response.status >= 500
          ? `Pushover answered ${status}.`
          : `Pushover refused the message (${status}).`,
      );
    },
  };
}
