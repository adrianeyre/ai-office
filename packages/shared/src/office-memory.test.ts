import { describe, expect, it } from "vitest";

import {
  looksLikeSecret,
  officeMemoryUpdateSchema,
  roleMemoryDecisionsSchema,
  secretLikeLines,
} from "./office-memory.ts";
import { createRedactor } from "./redact.ts";

// The credential check on office-wide and Role memory (PRD FR-56): memory
// never holds a credential, so whatever looks like a secret is refused.

describe("the memory credential check", () => {
  it.each([
    ["an Anthropic key", "Use sk-ant-api03-abcdefghijklmnop for the tests."],
    ["an OpenAI key", "OPENAI: sk-proj-abcdefghijklmnopqrstuvwxyz012345"],
    ["a GitHub token", "Push with ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["a Gateway Key", "Our key is aio_gk_abcdefghijklmnopqrstuv."],
    ["an AWS access key id", "AWS id AKIAABCDEFGHIJKLMNOP for S3."],
    ["a password", "The staging database password: hunter2-staging"],
    ["a URL with a password", "postgres://app:s3cret@db.internal:5432/app"],
    ["a bearer token", "curl -H 'Authorization: Bearer abcdef0123456789'"],
    ["a Slack token", "Slack: xoxb-1234567890-abcdefghij"],
    ["a Stripe key", "Stripe sk_live_abcdefghijklmnop0123 for checkout."],
    ["an npm token", "npm_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["a token given a value", "DEPLOY_TOKEN=f3a9c2e1b7d04a6f9e8c3b2a1d0e9f8c"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["a redaction already made", "The key is [REDACTED]."],
  ])("refuses %s", (_what, text) => {
    expect(looksLikeSecret(text)).toBe(true);
  });

  it.each([
    "Use pnpm, never npm: the lockfile is pnpm-lock.yaml.",
    "Prefer zod for validation; schemas live in packages/shared.",
    "Every public function has a TSDoc comment.",
    "The cache key: the tenant id and the user id, joined by a colon.",
    "Run `pnpm test` before every commit; it takes about two minutes.",
    "Rebase on main at 4f9804d77b2e before touching the migrations.",
    "Read the token count from usage.input_tokens, not the headers.",
  ])("accepts %j", (text) => {
    expect(looksLikeSecret(text)).toBe(false);
  });

  it("refuses a secret registered with the redactor, whatever its shape", () => {
    const redactor = createRedactor({ secrets: ["plain-looking-value-42"] });
    expect(
      looksLikeSecret("Log in with plain-looking-value-42.", redactor),
    ).toBe(true);
    expect(looksLikeSecret("Log in with plain-looking-value-42.")).toBe(false);
  });

  it("names the lines that look like secrets, never what they hold", () => {
    const memory = [
      "# Coding standards",
      "",
      "- Use pnpm.",
      "- The deploy key: sk-ant-api03-abcdefghijklmnop",
      "- Prefer zod.",
      "- password = correct-horse-battery",
    ].join("\n");
    expect(secretLikeLines(memory)).toEqual([4, 6]);
    expect(secretLikeLines("# Standards\n\n- Use pnpm.\n")).toEqual([]);
  });
});

describe("the office-wide memory", () => {
  it("is at most 12,000 characters", () => {
    expect(
      officeMemoryUpdateSchema.safeParse({ content: "a".repeat(12_000) })
        .success,
    ).toBe(true);
    const tooLong = officeMemoryUpdateSchema.safeParse({
      content: "a".repeat(12_001),
    });
    expect(tooLong.error?.issues.map(({ message }) => message)).toEqual([
      "The office-wide memory is at most 12,000 characters.",
    ]);
  });
});

describe("the Manager's review of Role memory", () => {
  it("is a decision with a reason for each proposal", () => {
    expect(
      roleMemoryDecisionsSchema.safeParse({
        decisions: [
          { id: 1, decision: "accept", reason: "True of every coder here." },
          { id: 2, decision: "reject", reason: "Only about issue #4." },
        ],
      }).success,
    ).toBe(true);
    expect(
      roleMemoryDecisionsSchema
        .safeParse({ decisions: [{ id: 1, decision: "maybe", reason: "" }] })
        .error?.issues.map(({ message }) => message),
    ).toEqual([
      'decision is "accept" or "reject".',
      "Each decision gives its reason.",
    ]);
  });
});
