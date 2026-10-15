import {
  emailCredentialsSchema,
  emailTlsModeNames,
  messageKindNames,
  type EmailCredentials,
  type EmailTlsMode,
  type OutboundMessage,
} from "@ai-office/shared";
import {
  InternalHostError,
  checkOwnerHost,
} from "@ai-office/shared/internal-hosts-guard";
import { createTransport } from "nodemailer";

import {
  DeliveryError,
  type ConnectionTransport,
  type OutboundDelivery,
} from "./transport.ts";

// Email (PRD FR-91): each message is sent over the Owner's SMTP server, as
// plain text and HTML, with links back to AI Office and GitHub. Replies
// are not read: nothing that comes back is acted on (FR-95).

/** The header that carries the delivery's id, the same on every attempt. */
export const emailDeliveryHeader = "X-AI-Office-Delivery";

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** One line for a header: no line breaks, at most 200 characters. */
const oneLine = (text: string): string => {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
};

/** A message as an email: its subject, plain text and HTML. */
export function emailContent(
  message: OutboundMessage,
  test: boolean,
): { subject: string; text: string; html: string } {
  const kind = test ? "Test" : messageKindNames[message.kind];
  const links = [
    { label: "Open in AI Office", url: message.aiOfficeUrl },
    ...(message.githubUrl === null
      ? []
      : [{ label: "Open on GitHub", url: message.githubUrl }]),
  ];
  const facts = [
    ...(message.floor === null ? [] : [["Floor", message.floor.name]]),
    ["Kind", kind],
  ] as const;
  const text = [
    message.title,
    "",
    ...(message.summary === undefined ? [] : [message.summary, ""]),
    ...facts.map(([name, value]) => `${name}: ${value}`),
    "",
    ...links.map(({ label, url }) => `${label}: ${url}`),
    "",
    "-- ",
    "Sent by AI Office's Communications Agent. Replies are not read.",
    "",
  ].join("\n");
  const html = [
    "<!doctype html>",
    '<html><body style="font-family: sans-serif; line-height: 1.5">',
    `<p style="font-size: 1.1em"><strong>${escapeHtml(message.title)}</strong></p>`,
    ...(message.summary === undefined
      ? []
      : [`<p>${escapeHtml(message.summary).replaceAll("\n", "<br>")}</p>`]),
    "<p>",
    facts
      .map(
        ([name, value]) =>
          `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(value)}`,
      )
      .join("<br>"),
    "</p>",
    "<p>",
    links
      .map(
        ({ label, url }) =>
          `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
      )
      .join(" &middot; "),
    "</p>",
    '<p style="color: #666; font-size: 0.9em">Sent by AI Office\'s Communications Agent. Replies are not read.</p>',
    "</body></html>",
    "",
  ].join("\n");
  return {
    subject: oneLine(
      `[AI Office] ${message.floor === null ? "" : `${message.floor.name}: `}${message.title}`,
    ),
    text,
    html,
  };
}

/** Why the SMTP server did not take it, without anything it echoed. */
function deliveryError(error: unknown): DeliveryError {
  const { code, responseCode } = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
  };
  const status =
    typeof responseCode === "number" ? ` (${String(responseCode)})` : "";
  switch (code) {
    case "EAUTH":
      return new DeliveryError(
        `The SMTP server refused the username or password${status}.`,
        { cause: error },
      );
    case "ENOAUTH":
      return new DeliveryError(
        "The SMTP server needs a username and password.",
        { cause: error },
      );
    case "EENVELOPE":
      return new DeliveryError(
        `The SMTP server refused the sender or a recipient${status}.`,
        { cause: error },
      );
    case "ETLS":
      return new DeliveryError("The SMTP server's TLS could not be set up.", {
        cause: error,
      });
    case "ECONNECTION":
    case "ETIMEDOUT":
    case "ESOCKET":
    case "EDNS":
      return new DeliveryError(
        `The SMTP server could not be reached (${code}).`,
        { cause: error },
      );
    default:
      return new DeliveryError(
        `The SMTP server did not take the message${status}.`,
        { cause: error },
      );
  }
}

const tlsOptions: Record<
  EmailTlsMode,
  { secure: boolean; requireTLS: boolean; ignoreTLS: boolean }
> = {
  starttls: { secure: false, requireTLS: true, ignoreTLS: false },
  tls: { secure: true, requireTLS: false, ignoreTLS: false },
  none: { secure: false, requireTLS: false, ignoreTLS: true },
};

export interface EmailTransportOptions {
  /** How long connecting, the greeting and each reply may take; 10 seconds. */
  readonly timeoutMs?: number;
}

export function emailTransport(
  options: EmailTransportOptions = {},
): ConnectionTransport<EmailCredentials> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  const send = async (
    delivery: OutboundDelivery,
    credentials: EmailCredentials,
  ): Promise<void> => {
    // The address checked is the one connected to, so a name that answers
    // differently the second time cannot reach an internal host the Owner
    // did not allow (ADR 0007); TLS still checks the server's name.
    let address: string | undefined;
    try {
      address = await checkOwnerHost(credentials.host, {
        what: "The SMTP server",
      });
    } catch (error) {
      throw error instanceof InternalHostError
        ? new DeliveryError(error.message, { cause: error })
        : error;
    }
    const pinned =
      address === undefined ||
      address === credentials.host.replace(/^\[|\]$/g, "")
        ? { host: credentials.host }
        : { host: address, servername: credentials.host };
    const transporter = createTransport({
      ...pinned,
      port: credentials.port,
      ...tlsOptions[credentials.tls],
      ...(credentials.username === undefined ||
      credentials.password === undefined
        ? {}
        : {
            auth: { user: credentials.username, pass: credentials.password },
          }),
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs * 2,
      // Never a log line: they could carry the conversation.
      logger: false,
      debug: false,
    });
    try {
      await transporter.sendMail({
        from: credentials.from,
        to: [...credentials.to],
        ...emailContent(delivery.message, delivery.test),
        headers: { [emailDeliveryHeader]: delivery.id },
      });
    } catch (error) {
      throw deliveryError(error);
    } finally {
      transporter.close();
    }
  };

  return {
    credentials: emailCredentialsSchema,

    describe(credentials) {
      return {
        hint: `${credentials.host}:${String(credentials.port)}`,
        settings: {
          tls: credentials.tls,
          username: credentials.username ?? null,
          from: credentials.from,
          to: credentials.to,
        },
      };
    },

    details(settings) {
      const tls = settings["tls"] as EmailTlsMode | undefined;
      const username = settings["username"];
      const to = settings["to"];
      return [
        `TLS: ${tls === undefined ? "?" : emailTlsModeNames[tls]}`,
        typeof username === "string"
          ? `Signs in as ${username}`
          : "Does not sign in",
        `From ${String(settings["from"])}`,
        `To ${Array.isArray(to) ? to.join(", ") : String(to)}`,
      ];
    },

    send: (delivery, { credentials }) => send(delivery, credentials),
  };
}
