import {
  messageKindNames,
  slackCredentialsSchema,
  type OutboundMessage,
  type SlackCredentials,
} from "@ai-office/shared";

import {
  DeliveryError,
  retryAfterMs,
  fetchOwnerUrl,
  unreachable,
  type ConnectionTransport,
} from "./transport.ts";

// Slack (PRD FR-91): through an incoming webhook, or as a bot posting to a
// channel or user with `chat.postMessage`. Each message is in Slack's
// block format: its title, Floor and kind, and link buttons back to AI
// Office and to GitHub. The buttons only open links: nothing Slack sends
// back is acted on (FR-95). A 429 is retried after its `Retry-After`.

/** Escapes text for Slack's mrkdwn, where `&`, `<` and `>` are markup. */
const escape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Slack's limits: 3000 characters in a section, 75 in a button. */
const cut = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

/** A message as Slack's blocks, with `text` for notifications and old clients. */
export function slackBlocks(
  message: OutboundMessage,
  test: boolean,
): { text: string; blocks: unknown[] } {
  const kind = test ? "Test" : messageKindNames[message.kind];
  const context = [
    ...(message.floor === null
      ? []
      : [`*Floor:* ${escape(message.floor.name)}`]),
    `*Kind:* ${kind}`,
  ].join("  ·  ");
  const button = (text: string, url: string, id: string) => ({
    type: "button",
    action_id: id,
    text: { type: "plain_text", text, emoji: false },
    url,
  });
  return {
    text: cut(
      `${message.floor === null ? "" : `${message.floor.name}: `}${message.title}`,
      3000,
    ),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: cut(`*${escape(message.title)}*`, 3000) },
      },
      ...(message.summary === undefined
        ? []
        : [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: cut(escape(message.summary), 3000),
              },
            },
          ]),
      { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      {
        type: "actions",
        elements: [
          button("Open in AI Office", message.aiOfficeUrl, "ai_office"),
          ...(message.githubUrl === null
            ? []
            : [button("Open on GitHub", message.githubUrl, "github")]),
        ],
      },
    ],
  };
}

/** What Slack's Web API answers. */
interface SlackAnswer {
  readonly ok?: unknown;
  readonly error?: unknown;
}

/** Slack's error codes are short words; anything else is not shown. */
const errorCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-z_]{1,60}$/.test(value) ? value : undefined;

const refused = (what: string, code: string | undefined): DeliveryError =>
  new DeliveryError(
    code === "invalid_auth" ||
      code === "not_authed" ||
      code === "token_revoked" ||
      code === "account_inactive"
      ? `Slack refused the bot token (${code}).`
      : `Slack refused ${what}${code === undefined ? "" : ` (${code})`}.`,
  );

export interface SlackTransportOptions {
  /** Slack's Web API; a test's fake Slack in tests. */
  readonly apiUrl?: string;
  /** How long one request may take; 10 seconds by default. */
  readonly timeoutMs?: number;
}

export function slackTransport(
  options: SlackTransportOptions = {},
): ConnectionTransport<SlackCredentials> {
  const apiUrl = (options.apiUrl ?? "https://slack.com/api").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = options.timeoutMs ?? 10_000;

  /**
   * POSTs to Slack: its Web API, or an incoming webhook's address, which
   * the Owner gave and so may not be internal (`ownerGiven`, ADR 0007).
   */
  const post = async (
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
    ownerGiven = false,
  ): Promise<Response> => {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    };
    let response: Response;
    if (ownerGiven) {
      response = await fetchOwnerUrl("Slack", url, init);
    } else {
      try {
        response = await fetch(url, init);
      } catch (error) {
        throw unreachable("Slack", error);
      }
    }
    if (response.status === 429) {
      await response.body?.cancel();
      const wait = retryAfterMs(response.headers.get("retry-after"));
      throw new DeliveryError(
        "Slack is rate-limiting this Connection (429).",
        wait === undefined ? {} : { retryAfterMs: wait },
      );
    }
    return response;
  };

  return {
    credentials: slackCredentialsSchema,

    describe(credentials) {
      return credentials.mode === "webhook"
        ? {
            hint: new URL(credentials.webhookUrl).host,
            settings: { mode: "webhook" },
          }
        : {
            hint: "bot token",
            settings: { mode: "bot", channel: credentials.channel },
          };
    },

    details(settings) {
      return settings["mode"] === "bot"
        ? [`Posts to ${String(settings["channel"])} as a bot`]
        : ["Incoming webhook"];
    },

    async send(delivery, { credentials }) {
      const content = slackBlocks(delivery.message, delivery.test);
      if (credentials.mode === "webhook") {
        const response = await post(credentials.webhookUrl, content, {}, true);
        // An incoming webhook answers `ok`, or a short error as text.
        const text = (await response.text()).trim();
        if (!response.ok) {
          throw refused(
            `the message with ${String(response.status)}`,
            errorCode(text),
          );
        }
        return;
      }
      const response = await post(
        `${apiUrl}/chat.postMessage`,
        {
          channel: credentials.channel,
          ...content,
          unfurl_links: false,
          unfurl_media: false,
        },
        { authorization: `Bearer ${credentials.botToken}` },
      );
      const answer = (await response.json().catch(() => ({}))) as SlackAnswer;
      if (!response.ok || answer.ok !== true) {
        throw refused(
          `the message${response.ok ? "" : ` with ${String(response.status)}`}`,
          errorCode(answer.error),
        );
      }
    },
  };
}
