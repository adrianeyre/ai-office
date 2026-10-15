import { describe, expect, it } from "vitest";

import { createRedactor, redactedText } from "./redact.ts";

// Fake credentials are assembled at run time so that no credential-shaped
// literal sits in the repository for secret scanners to report.
const chars = (length: number, alphabet = "aB3dE5gH7jK9mN1pQ2"): string =>
  Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join(
    "",
  );

const pem = (label: string): string =>
  [
    `-----BEGIN ${label}-----`,
    chars(64, "MIIEowIBAAKCAQEAwq3Jx0bLx3pQ"),
    chars(40, "kLk4aW3vQZf0Yb2dGv6rS1z7hP8y"),
    `-----END ${label}-----`,
  ].join("\n");

const shapes: [name: string, credential: string][] = [
  ["an RSA private key", pem("RSA PRIVATE KEY")],
  ["a PKCS #8 private key", pem("PRIVATE KEY")],
  ["an EC private key", pem("EC PRIVATE KEY")],
  ["an OpenSSH private key", pem("OPENSSH PRIVATE KEY")],
  ["an Anthropic API key", `sk-ant-api03-${chars(80)}-${chars(6)}AA`],
  ["an Anthropic OAuth access token", `sk-ant-oat01-${chars(80)}`],
  ["an Anthropic OAuth refresh token", `sk-ant-ort01-${chars(80)}`],
  ["an OpenAI project key", `sk-proj-${chars(120)}`],
  ["an OpenAI service account key", `sk-svcacct-${chars(80)}`],
  ["a legacy OpenAI key", `sk-${chars(48)}`],
  ["an xAI key", `xai-${chars(80)}`],
  ["a Google API key", `AIza${chars(35)}`],
  ["a Google OAuth access token", `ya29.${chars(150)}`],
  ["a Google OAuth refresh token", `1//0${chars(90)}`],
  ["a Google OAuth client secret", `GOCSPX-${chars(28)}`],
  ["a GitHub personal access token", `ghp_${chars(36)}`],
  ["a GitHub OAuth token", `gho_${chars(36)}`],
  ["a GitHub user-to-server token", `ghu_${chars(36)}`],
  ["a GitHub App installation token", `ghs_${chars(36)}`],
  ["a GitHub refresh token", `ghr_${chars(76)}`],
  ["a fine-grained GitHub token", `github_pat_${chars(22)}_${chars(59)}`],
  ["a btr- key", `btr-${chars(40)}`],
  ["a Gateway Key", `aio_gk_${chars(43)}`],
  ["an AWS access key ID", `AKIA${chars(16, "ABCDEFGHIJKLMNOP2345")}`],
  ["a Slack bot token", `xoxb-${chars(12, "0123456789")}-${chars(24)}`],
  [
    "a Slack incoming webhook's address",
    `https://hooks.slack.com/services/T${chars(10)}/B${chars(10)}/${chars(24)}`,
  ],
  ["an ntfy access token", `tk_${chars(29)}`],
  [
    "a JWT (an OAuth access token)",
    `eyJ${chars(30)}.eyJ${chars(120)}.${chars(43)}`,
  ],
];

describe("credential shapes", () => {
  const redactor = createRedactor();

  it.each(shapes)("removes %s from text", (_, credential) => {
    const text = `before ${credential} after`;
    const result = redactor.redactText(text);
    expect(result).toBe(`before ${redactedText} after`);
  });

  it.each(shapes)("removes %s from a JSON log line", (_, credential) => {
    const line = JSON.stringify({ msg: `calling with ${credential}`, n: 1 });
    const result = redactor.redactText(line);
    expect(result).not.toContain(credential.split("\n")[1] ?? credential);
    expect(JSON.parse(result)).toEqual({
      msg: `calling with ${redactedText}`,
      n: 1,
    });
  });

  it("removes an unterminated private key up to the end", () => {
    const truncated = pem("RSA PRIVATE KEY").slice(0, 60);
    expect(redactor.redactText(`key: ${truncated}`)).toBe(
      `key: ${redactedText}`,
    );
  });

  it("keeps the scheme of an Authorization header", () => {
    expect(
      redactor.redactText(`Authorization: Bearer ${chars(40, "a1b2.c3_d4-")}`),
    ).toBe(`Authorization: Bearer ${redactedText}`);
    expect(
      redactor.redactText(`authorization: basic ${btoa("owner:hunter2!x")}`),
    ).toBe(`authorization: basic ${redactedText}`);
  });

  it("keeps the user and host of a URL with a password", () => {
    expect(
      redactor.redactText(
        "DATABASE_URL is postgres://ai_office:s3cr3t-Pa55@db:5432/ai_office",
      ),
    ).toBe(
      `DATABASE_URL is postgres://ai_office:${redactedText}@db:5432/ai_office`,
    );
  });

  it("removes credentials from query strings", () => {
    expect(
      redactor.redactText(
        "GET /callback?code_challenge=x&token=abc123def456&state=7&id_token=t0k3n",
      ),
    ).toBe(
      `GET /callback?code_challenge=x&token=${redactedText}&state=7&id_token=${redactedText}`,
    );
  });

  it("removes the secret from a TOTP otpauth:// URI", () => {
    expect(
      redactor.redactText(
        "otpauth://totp/AI%20Office:Owner?secret=JBSWY3DPEHPK3PXPJBSWY3DP&issuer=AI%20Office",
      ),
    ).toBe(
      `otpauth://totp/AI%20Office:Owner?secret=${redactedText}&issuer=AI%20Office`,
    );
  });

  it("removes credential assignments in text", () => {
    expect(
      redactor.redactText(
        "DB_PASSWORD=hunter2hunter2 client_secret: 'abc123xyz' api_key=k-12345",
      ),
    ).toBe(
      `DB_PASSWORD=${redactedText} client_secret: '${redactedText}' api_key=${redactedText}`,
    );
  });

  it("never reaches past the end of the line for an assignment's value", () => {
    const envFile = "SESSION_SECRET=\n# A comment\nPORT=3000";
    expect(redactor.redactText(envFile)).toBe(envFile);
  });

  it("removes credential values in JSON and keeps it valid", () => {
    const line = JSON.stringify({
      password: 'hunter2 "quoted"',
      apiKey: "k-12345",
      sessionSecret: "abc",
      inputTokens: 1234,
    });
    expect(JSON.parse(redactor.redactText(line))).toEqual({
      password: redactedText,
      apiKey: redactedText,
      sessionSecret: redactedText,
      inputTokens: 1234,
    });
  });

  it("is idempotent", () => {
    const text = `Bearer ${chars(40)} ${pem("PRIVATE KEY")} password=${chars(12)}`;
    const once = redactor.redactText(text);
    expect(redactor.redactText(once)).toBe(once);
  });

  it.each([
    "Ada (coder, Claude claude-opus-5-5) opened PR #14 for issue 4 using 12,345 tokens.",
    "Merged 3f9c2a7e1b0d4c5a6f7e8d9c0b1a2f3e4d5c6b7a into main.",
    "Floor web-shop: Token Cap 80% reached (risk-assessment for 550e8400-e29b-41d4-a716-446655440000).",
    "The branch is ai-office/12-task-sk-handoff and the image is postgres:18-alpine.",
    "See https://github.com/adrianeyre/ai-office/pull/14?tab=files",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(redactor.redactText(text)).toBe(text);
  });

  it("accepts extra shapes, such as a future Gateway Key prefix", () => {
    const withGatewayKeys = createRedactor({
      patterns: [
        { name: "Gateway Key", pattern: /\baio-gk-[A-Za-z0-9]{24,}/g },
      ],
    });
    expect(withGatewayKeys.redactText(`key aio-gk-${chars(32)}`)).toBe(
      `key ${redactedText}`,
    );
  });
});

describe("registered secret values", () => {
  const secret = "v4lue-only-we-know/with+symbols";
  const multiLine = "line one of a secret\nline two of a secret";

  it("are removed from text, wherever they appear", () => {
    const redactor = createRedactor({ secrets: [secret] });
    expect(redactor.redactText(`x${secret}y and ${secret}`)).toBe(
      `x${redactedText}y and ${redactedText}`,
    );
  });

  it("are removed in their JSON-escaped and URL-encoded forms", () => {
    const redactor = createRedactor({ secrets: [secret, multiLine] });
    const line = JSON.stringify({ msg: multiLine });
    expect(JSON.parse(redactor.redactText(line))).toEqual({
      msg: redactedText,
    });
    expect(redactor.redactText(`/cb?state=${encodeURIComponent(secret)}`)).toBe(
      `/cb?state=${redactedText}`,
    );
  });

  it("are removed inside nested objects, arrays, Maps, Sets and Errors", () => {
    const redactor = createRedactor({ secrets: [secret] });
    const error = new Error(`refused ${secret}`);
    const input = {
      floor: "web-shop",
      agents: [
        {
          name: "Ada",
          notes: [`uses ${secret}`, { deeper: { value: secret } }],
        },
      ],
      byAccount: new Map([["claude-1", { last: `token ${secret}` }]]),
      seen: new Set([secret, "plain"]),
      error,
    };

    const output = redactor.redact(input);

    expect(output.floor).toBe("web-shop");
    expect(output.agents[0]?.notes).toEqual([
      `uses ${redactedText}`,
      { deeper: { value: redactedText } },
    ]);
    expect(output.byAccount.get("claude-1")).toEqual({
      last: `token ${redactedText}`,
    });
    expect([...output.seen]).toEqual([redactedText, "plain"]);
    expect(output.error).toBeInstanceOf(Error);
    expect(output.error.message).toBe(`refused ${redactedText}`);
    expect(output.error.stack).not.toContain(secret);
    expect(JSON.stringify([...output.byAccount], null, 0)).not.toContain(
      secret,
    );
    expect(JSON.stringify({ ...output, byAccount: undefined })).not.toContain(
      secret,
    );
  });

  it("can be registered after the redactor is created", () => {
    const redactor = createRedactor();
    expect(redactor.redactText(secret)).toBe(secret);
    redactor.register(secret);
    expect(redactor.redactText(secret)).toBe(redactedText);
  });

  it("ignores values too short to be credentials", () => {
    const redactor = createRedactor({ secrets: ["", "ab"] });
    expect(redactor.redactText("a cab ab")).toBe("a cab ab");
  });

  it("removes the longer of two overlapping values whole", () => {
    const redactor = createRedactor({ secrets: ["abcd", "abcdefgh"] });
    expect(redactor.redactText("abcdefgh")).toBe(redactedText);
  });
});

describe("redact (objects)", () => {
  const redactor = createRedactor();

  it("replaces the values of sensitive keys, whatever their shape", () => {
    const output = redactor.redact({
      password: "hunter2",
      apiKey: "k",
      "x-api-key": "k",
      Authorization: "Bearer abc",
      headers: { cookie: "sid=1", "set-cookie": ["sid=2"] },
      encryptionKey: new Uint8Array([1, 2, 3]),
      privateKey: "pem",
      refresh_token: "r",
      inputTokens: 1234,
      tokens: { input: 1, output: 2 },
      maxTokens: 4096,
      totpSecret: "JBSWY3DPEHPK3PXP",
      recoveryCodes: ["abcd-efgh-jkmn-pqrs"],
    });
    expect(output).toEqual({
      password: redactedText,
      apiKey: redactedText,
      "x-api-key": redactedText,
      Authorization: redactedText,
      headers: { cookie: redactedText, "set-cookie": [redactedText] },
      encryptionKey: redactedText,
      privateKey: redactedText,
      refresh_token: redactedText,
      inputTokens: 1234,
      tokens: { input: 1, output: 2 },
      maxTokens: 4096,
      totpSecret: redactedText,
      recoveryCodes: [redactedText],
    });
  });

  it("redacts inside a sensitive key's container one value at a time", () => {
    expect(
      redactor.redact({
        credentials: {
          kind: "oauth",
          accessToken: "a",
          note: `ghp_${chars(36)}`,
        },
      }),
    ).toEqual({
      credentials: {
        kind: "oauth",
        accessToken: redactedText,
        note: redactedText,
      },
    });
  });

  it("leaves null and undefined sensitive values alone", () => {
    expect(redactor.redact({ password: null, apiKey: undefined })).toEqual({
      password: null,
      apiKey: undefined,
    });
  });

  it("does not change its input", () => {
    const input = { password: "hunter2", nested: { note: `ghp_${chars(36)}` } };
    const snapshot = structuredClone(input);
    redactor.redact(input);
    expect(input).toEqual(snapshot);
  });

  it("copes with cycles", () => {
    const input: { name: string; password: string; self?: unknown } = {
      name: "loop",
      password: "hunter2",
    };
    input.self = input;
    const output = redactor.redact(input);
    expect(output.password).toBe(redactedText);
    expect(output.self).toBe(output);
  });

  it("returns primitives and other objects as they are", () => {
    const date = new Date(0);
    expect(redactor.redact(42)).toBe(42);
    expect(redactor.redact(null)).toBe(null);
    expect(redactor.redact(true)).toBe(true);
    expect(redactor.redact({ at: date }).at).toBe(date);
  });
});
