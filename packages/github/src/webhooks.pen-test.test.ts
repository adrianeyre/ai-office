import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseWebhookPayload,
  signWebhook,
  verifyWebhookSignature,
} from "./webhooks.ts";

// Probe W1 (docs/pen-testing/assessments/W1.md), "Signature: confirm
// HMAC-SHA256 over the raw body, constant-time; missing or malformed
// header; secret unset" (H12, and the PRD's "Confirm, don't re-test":
// the HMAC comparison is constant-time). The real `verifyWebhookSignature`
// is driven with every shape of header a spoofed GitHub (position 5) could
// send. Each control holds; these tests keep it holding. Every secret here
// is a fake.

// `timingSafeEqual` is GitHub's own advice for this comparison: it is
// spied on, so a later change to `===` fails here.
const compared = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return {
    ...crypto,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls += 1;
      return crypto.timingSafeEqual(a, b);
    },
  };
});

afterEach(() => {
  compared.calls = 0;
});

const secret = "fake-w1-webhook-secret-0123456789";
const body = Buffer.from(
  '{"action":"labeled","repository":{"full_name":"adrianeyre/web-shop"}}',
);

describe("the signature: HMAC-SHA256 over the raw body", () => {
  it("is GitHub's: sha256= and the hex HMAC-SHA256 of the body's bytes with the secret", () => {
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    expect(signWebhook(secret, body)).toBe(`sha256=${expected}`);
    expect(verifyWebhookSignature(secret, body, `sha256=${expected}`)).toBe(
      true,
    );
  });

  it("is over the bytes as sent: the same JSON re-serialised, or bytes that are not UTF-8, verify only as signed", () => {
    const pretty = Buffer.from(
      JSON.stringify(JSON.parse(body.toString("utf8")), null, 2),
    );
    expect(
      verifyWebhookSignature(secret, pretty, signWebhook(secret, body)),
    ).toBe(false);
    // 0xff is not UTF-8: read as text it becomes U+FFFD, a different body.
    const raw = Buffer.concat([body, Buffer.from([0xff, 0xfe])]);
    const lossy = Buffer.from(raw.toString("utf8"));
    expect(verifyWebhookSignature(secret, raw, signWebhook(secret, raw))).toBe(
      true,
    );
    expect(
      verifyWebhookSignature(secret, lossy, signWebhook(secret, raw)),
    ).toBe(false);
  });

  it("refuses a body changed by one byte, and a signature made with another secret", () => {
    const signature = signWebhook(secret, body);
    const changed = Buffer.from(body);
    changed[changed.length - 2] = 0x20;
    expect(verifyWebhookSignature(secret, changed, signature)).toBe(false);
    expect(
      verifyWebhookSignature(
        secret,
        body,
        signWebhook("fake-w1-another-secret-012345", body),
      ),
    ).toBe(false);
  });
});

describe("the comparison is constant-time", () => {
  it("compares a well-formed signature with timingSafeEqual, never ===", () => {
    expect(
      verifyWebhookSignature(secret, body, signWebhook(secret, body)),
    ).toBe(true);
    expect(
      verifyWebhookSignature(secret, body, `sha256=${"0".repeat(64)}`),
    ).toBe(false);
    expect(compared.calls).toBe(2);
  });

  it("refuses a malformed header before comparing: what is refused early says nothing of the secret", () => {
    for (const header of [
      "",
      "sha256=",
      `sha256=${"0".repeat(63)}`,
      `sha256=${"0".repeat(65)}`,
      `sha256=${"g".repeat(64)}`,
      `sha1=${"0".repeat(40)}`,
      `SHA256 ${"0".repeat(64)}`,
      `sha256=${"0".repeat(64)},sha256=${"1".repeat(64)}`,
      "sha256=../../etc/passwd",
    ]) {
      expect(verifyWebhookSignature(secret, body, header)).toBe(false);
    }
    // Only the format decides it, never a prefix of the right answer.
    expect(compared.calls).toBe(0);
  });
});

describe("a missing header, and the secret unset", () => {
  it("refuses a delivery with no signature", () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
  });

  it("refuses everything while the secret is empty, even a signature made with the empty secret", () => {
    expect(verifyWebhookSignature("", body, signWebhook("", body))).toBe(false);
    expect(verifyWebhookSignature("", body, undefined)).toBe(false);
  });

  it("takes the header in either case, and with surrounding whitespace: the same signature, not a weaker one", () => {
    const signature = signWebhook(secret, body);
    expect(
      verifyWebhookSignature(secret, body, `  ${signature.toUpperCase()}\t`),
    ).toBe(true);
  });
});

describe("what the payload is read for", () => {
  it("reads only the action, the repository's name and the label: never an installation, a sender or an issue", () => {
    const payload = parseWebhookPayload(
      JSON.stringify({
        action: "labeled",
        repository: { full_name: "adrianeyre/web-shop" },
        label: { name: "ai-office" },
        installation: { id: 99 },
        sender: { login: "adrianeyre" },
        issue: { number: 1, user: { login: "adrianeyre" } },
      }),
    );
    expect(payload).toEqual({
      action: "labeled",
      repository: "adrianeyre/web-shop",
      label: "ai-office",
    });
  });
});
