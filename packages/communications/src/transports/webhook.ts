import { createHmac, timingSafeEqual } from "node:crypto";

import {
  webhookCredentialsSchema,
  type WebhookCredentials,
} from "@ai-office/shared";

import {
  DeliveryError,
  retryAfterMs,
  fetchOwnerUrl,
  type ConnectionTransport,
  type OutboundDelivery,
} from "./transport.ts";

// The generic webhook (PRD FR-91): each message is a JSON POST to the
// Owner's address, which covers Discord, Microsoft Teams, Zapier, n8n and
// the like. With a secret, the body is signed with HMAC-SHA256, as
// GitHub's webhooks are, so the receiver can check it came from AI Office.

/** The header that carries the signature: `sha256=` and the hex digest. */
export const signatureHeader = "x-ai-office-signature-256";
/** The header that carries the delivery's id, the same on every attempt. */
export const deliveryHeader = "x-ai-office-delivery";

/** The JSON a webhook receives. */
export interface WebhookBody {
  /** The delivery's id: a repeat of one already received can be dropped. */
  readonly id: string;
  readonly test: boolean;
  readonly kind: string;
  readonly title: string;
  /** A Digest's text; absent from other messages. */
  readonly summary?: string;
  readonly floor: { readonly id: string; readonly name: string } | null;
  readonly links: {
    readonly aiOffice: string;
    readonly github: string | null;
  };
  readonly occurredAt: string;
}

export const webhookBody = (delivery: OutboundDelivery): WebhookBody => ({
  id: delivery.id,
  test: delivery.test,
  kind: delivery.message.kind,
  title: delivery.message.title,
  ...(delivery.message.summary === undefined
    ? {}
    : { summary: delivery.message.summary }),
  floor: delivery.message.floor,
  links: {
    aiOffice: delivery.message.aiOfficeUrl,
    github: delivery.message.githubUrl,
  },
  occurredAt: delivery.message.occurredAt,
});

/** The signature header's value for `body`. */
export const signBody = (body: string, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** Whether `signature` is `body` signed with `secret`: for receivers. */
export function verifySignature(
  body: string,
  secret: string,
  signature: string | undefined,
): boolean {
  if (signature === undefined) {
    return false;
  }
  const expected = Buffer.from(signBody(body, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface WebhookTransportOptions {
  /** How long one POST may take; 10 seconds by default. */
  readonly timeoutMs?: number;
}

export function webhookTransport(
  options: WebhookTransportOptions = {},
): ConnectionTransport<WebhookCredentials> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    credentials: webhookCredentialsSchema,

    describe(credentials) {
      return {
        hint: new URL(credentials.url).host,
        settings: { signed: credentials.secret !== undefined },
      };
    },

    details(settings) {
      return [
        settings["signed"] === true ? "Signed with HMAC-SHA256" : "Not signed",
      ];
    },

    async send(delivery, { credentials }) {
      const body = JSON.stringify(webhookBody(delivery));
      const response = await fetchOwnerUrl("The webhook", credentials.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "AI-Office",
          [deliveryHeader]: delivery.id,
          ...(credentials.secret === undefined
            ? {}
            : { [signatureHeader]: signBody(body, credentials.secret) }),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Its answer is not read: nothing that comes back is acted on (FR-95).
      await response.body?.cancel();
      if (!response.ok) {
        const wait = retryAfterMs(response.headers.get("retry-after"));
        throw new DeliveryError(
          `The webhook answered ${String(response.status)}.`,
          wait === undefined ? {} : { retryAfterMs: wait },
        );
      }
    },
  };
}
