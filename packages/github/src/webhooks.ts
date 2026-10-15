import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub App webhooks (PRD FR-8): GitHub POSTs each event to the App's
// webhook URL, signing the raw body with the App's webhook secret
// (HMAC-SHA256, hex, in `X-Hub-Signature-256` as `sha256=…`). A delivery is
// believed only when that signature matches; anything else is refused
// before its body is read as JSON.

/** The header GitHub signs each delivery's body in. */
export const webhookSignatureHeader = "x-hub-signature-256";
/** The header naming the delivery's event, such as `issues`. */
export const webhookEventHeader = "x-github-event";
/** The header carrying the delivery's own id, for the logs. */
export const webhookDeliveryHeader = "x-github-delivery";

/** The `X-Hub-Signature-256` value GitHub sends for `body`. */
export function signWebhook(secret: string, body: string | Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Whether `signature` is GitHub's signature of `body` with `secret`,
 * compared in constant time. A missing or malformed signature is not.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string | Uint8Array,
  signature: string | undefined,
): boolean {
  if (secret === "" || signature === undefined) {
    return false;
  }
  const given = signature.trim().toLowerCase();
  if (!/^sha256=[0-9a-f]{64}$/.test(given)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(signWebhook(secret, body)),
    Buffer.from(given),
  );
}

/** What AI Office reads of a delivery's payload. */
export interface WebhookPayload {
  /** What happened, such as `labeled`; absent for events without one. */
  readonly action?: string;
  /** `owner/name` of the repository it happened in, if any. */
  readonly repository?: string;
  /** The label a `labeled`, `unlabeled` or `label` event is about. */
  readonly label?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringAt = (
  record: Record<string, unknown>,
  key: string,
  inner?: string,
): string | undefined => {
  const value = record[key];
  if (inner === undefined) {
    return typeof value === "string" ? value : undefined;
  }
  return isRecord(value) && typeof value[inner] === "string"
    ? value[inner]
    : undefined;
};

/**
 * Reads a delivery's JSON body (once its signature is verified). Undefined
 * when the body is not a JSON object.
 */
export function parseWebhookPayload(
  body: string | Uint8Array,
): WebhookPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof body === "string" ? body : Buffer.from(body).toString("utf8"),
    );
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const action = stringAt(parsed, "action");
  const repository = stringAt(parsed, "repository", "full_name");
  const label = stringAt(parsed, "label", "name");
  return {
    ...(action === undefined ? {} : { action }),
    ...(repository === undefined ? {} : { repository }),
    ...(label === undefined ? {} : { label }),
  };
}
