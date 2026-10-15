import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseWebhookPayload,
  signWebhook,
  verifyWebhookSignature,
} from "./webhooks.ts";

// Webhook signatures (PRD FR-8): GitHub's HMAC-SHA256 of the raw body.

const secret = "a-webhook-secret-of-some-length";
const body = JSON.stringify({
  action: "labeled",
  zen: "Keep it logically awesome.",
});

describe("webhook signatures", () => {
  it("signs as GitHub does: sha256= and the hex HMAC of the raw body", () => {
    expect(signWebhook(secret, body)).toBe(
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    );
    expect(signWebhook(secret, Buffer.from(body))).toBe(
      signWebhook(secret, body),
    );
  });

  it("accepts the right signature, in either case", () => {
    const signature = signWebhook(secret, body);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    const upper = `sha256=${signature.slice("sha256=".length).toUpperCase()}`;
    expect(verifyWebhookSignature(secret, Buffer.from(body), upper)).toBe(true);
  });

  it("refuses a missing, malformed or wrong signature", () => {
    const right = signWebhook(secret, body);
    for (const signature of [
      undefined,
      "",
      "sha256=",
      "sha1=0123",
      right.slice(0, -1),
      `${right}0`,
      signWebhook("another-secret-entirely", body),
      // GitHub's older SHA-1 header's format is not accepted.
      `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`,
    ]) {
      expect(verifyWebhookSignature(secret, body, signature)).toBe(false);
    }
  });

  it("refuses a body changed after signing", () => {
    const signature = signWebhook(secret, body);
    expect(verifyWebhookSignature(secret, `${body} `, signature)).toBe(false);
  });

  it("refuses everything without a secret", () => {
    expect(verifyWebhookSignature("", body, signWebhook("", body))).toBe(false);
  });
});

describe("webhook payloads", () => {
  it("reads the action, the repository and the label", () => {
    expect(
      parseWebhookPayload(
        JSON.stringify({
          action: "labeled",
          issue: { number: 7 },
          label: { name: "ai-office" },
          repository: { full_name: "adrianeyre/web-shop" },
        }),
      ),
    ).toEqual({
      action: "labeled",
      label: "ai-office",
      repository: "adrianeyre/web-shop",
    });
    expect(parseWebhookPayload(Buffer.from("{}"))).toEqual({});
  });

  it("is undefined for a body that is not a JSON object", () => {
    for (const text of ["", "not json", "[]", "null", "42"]) {
      expect(parseWebhookPayload(text)).toBeUndefined();
    }
  });
});
