import {
  messageKindNames,
  ntfyCredentialsSchema,
  type NtfyCredentials,
  type OutboundMessage,
} from "@ai-office/shared";

import {
  DeliveryError,
  retryAfterMs,
  fetchOwnerUrl,
  type ConnectionTransport,
} from "./transport.ts";

// Phone push through ntfy (PRD FR-91): each message is published to the
// Owner's topic as JSON, on ntfy.sh or their own server, with an access
// token when the topic needs one. Tapping the notification opens it in AI
// Office; an "Open on GitHub" button opens GitHub. Action Notices are sent
// at high priority, so the phone makes itself heard. Nothing ntfy sends
// back is acted on (FR-95). A 429 is retried after its `Retry-After`.

/** ntfy's priorities: 4 is high, 3 the default. */
export const ntfyPriority = (message: OutboundMessage): number =>
  message.kind === "action_notice" ? 4 : 3;

/** What ntfy is sent for a message: its JSON publishing format. */
export function ntfyBody(
  message: OutboundMessage,
  test: boolean,
  topic: string,
): Record<string, unknown> {
  const kind = test ? "Test" : messageKindNames[message.kind];
  return {
    topic,
    title: message.title,
    message:
      message.summary ??
      (message.floor === null ? kind : `${message.floor.name} · ${kind}`),
    priority: ntfyPriority(message),
    click: message.aiOfficeUrl,
    ...(message.githubUrl === null
      ? {}
      : {
          actions: [
            {
              action: "view",
              label: "Open on GitHub",
              url: message.githubUrl,
              clear: false,
            },
          ],
        }),
  };
}

export interface NtfyTransportOptions {
  /** How long one request may take; 10 seconds by default. */
  readonly timeoutMs?: number;
}

export function ntfyTransport(
  options: NtfyTransportOptions = {},
): ConnectionTransport<NtfyCredentials> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    credentials: ntfyCredentialsSchema,

    describe(credentials) {
      return {
        hint: new URL(credentials.server).host,
        settings: { signedIn: credentials.accessToken !== undefined },
      };
    },

    // The server is not a secret; the topic and the token are.
    secrets(credentials) {
      return [
        credentials.topic,
        ...(credentials.accessToken === undefined
          ? []
          : [credentials.accessToken]),
      ];
    },

    details(settings) {
      return [
        settings["signedIn"] === true
          ? "Publishes with an access token"
          : "Publishes without an access token",
      ];
    },

    async send(delivery, { credentials }) {
      // JSON is published to the server's root, the topic in the body.
      const url = `${credentials.server.replace(/\/+$/, "")}/`;
      const response = await fetchOwnerUrl("ntfy", url, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "AI-Office",
          ...(credentials.accessToken === undefined
            ? {}
            : { authorization: `Bearer ${credentials.accessToken}` }),
        },
        body: JSON.stringify(
          ntfyBody(delivery.message, delivery.test, credentials.topic),
        ),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Its answer is not read beyond its status: it could echo the topic.
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
      const status = String(response.status);
      switch (response.status) {
        case 401:
        case 403:
          throw new DeliveryError(
            credentials.accessToken === undefined
              ? `ntfy needs an access token to publish to this topic (${status}).`
              : `ntfy refused the access token (${status}).`,
          );
        case 429: {
          const wait = retryAfterMs(response.headers.get("retry-after"));
          throw new DeliveryError(
            "ntfy is rate-limiting this Connection (429).",
            wait === undefined ? {} : { retryAfterMs: wait },
          );
        }
        default:
          throw new DeliveryError(`ntfy answered ${status}.`);
      }
    },
  };
}
