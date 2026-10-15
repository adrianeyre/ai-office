import { createRedactor, redactedText } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.ts";
import { loadConfig, secretConfigKeys, secretValues } from "./config.ts";
import { createLogger } from "./logger.ts";
import { testAuth } from "./test-support.ts";

const privateKey = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAwq3Jx0bLx3pQkLk4aW3vQZf0Yb2dGv6rS1z7hP8yNqXcT1mO",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const env = {
  DATABASE_URL: "postgres://ai_office:pg%2Fpass-58c1e2@db:5432/ai_office",
  SESSION_SECRET: "session-secret-6b1d0e9f4c2a8b7e5d3f1a0c9e8b7d6a",
  ENCRYPTION_KEY: `2:${Buffer.alloc(32, 9).toString("base64")}`,
  // A key it replaced (pen-testing G1-9) is a secret too.
  RETIRED_ENCRYPTION_KEYS: Buffer.alloc(32, 10).toString("base64"),
  TRUST_PROXY: "1",
  PROXY_SECRET: "proxy-secret-4e7a1c9b3d5f8a2e6c0b4d7f1a3e5c9b",
};

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("the logger", () => {
  const config = loadConfig(env);
  // Each secret config key's value, plus the database password in the
  // forms it can take.
  const forbidden = [
    ...secretConfigKeys.map((key) => env[key]),
    "pg%2Fpass-58c1e2",
    "pg/pass-58c1e2",
    Buffer.alloc(32, 9).toString("base64"),
    // No part of the key survives: it is replaced whole.
    "MIIEowIBAAKCAQEAwq3Jx0bLx3pQkLk4aW3vQZf0Yb2dGv6rS1z7hP8yNqXcT1mO",
  ];

  it("never emits the value of a secret config key", () => {
    const output = capture();
    const logger = createLogger({
      level: "trace",
      secrets: secretValues(config),
      destination: output,
    });

    logger.info({ config }, "the whole config");
    logger.info({ env }, "the raw environment");
    logger.warn(`connecting to ${env.DATABASE_URL}`);
    logger.debug({ nested: { deeper: [{ key: privateKey }] } }, "nested");
    logger.error(
      new Error(`login failed with secret ${env.SESSION_SECRET}`),
      "an error",
    );
    logger.child({ encryptionKey: env.ENCRYPTION_KEY }).info("a child");
    logger.info(`password alone: pg/pass-58c1e2`);

    expect(output.lines).toHaveLength(7);
    const text = output.lines.join("");
    for (const value of forbidden) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain(redactedText);
    // Scrubbing leaves each line valid JSON.
    for (const line of output.lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it("removes credential shapes and sensitive keys it was not told about", () => {
    const output = capture();
    const logger = createLogger({
      level: "info",
      secrets: [],
      destination: output,
    });
    const githubToken = `ghs_${"x1Y2z3".repeat(6)}`;

    logger.info(
      { headers: { authorization: "token-not-shaped-like-anything" } },
      `pushing with ${githubToken}`,
    );
    logger.child({ apiKey: "plain-api-key-value" }).info("child");

    const text = output.lines.join("");
    expect(text).not.toContain(githubToken);
    expect(text).not.toContain("token-not-shaped-like-anything");
    expect(text).not.toContain("plain-api-key-value");
    expect(JSON.parse(output.lines[0] ?? "")).toMatchObject({
      headers: { authorization: redactedText },
      msg: `pushing with ${redactedText}`,
    });
  });

  it("removes values registered with its redactor after it was made", () => {
    const output = capture();
    const redactor = createRedactor();
    const logger = createLogger({
      level: "info",
      secrets: secretValues(config),
      redactor,
      destination: output,
    });
    // Not shaped like an Anthropic key, so only its registration removes
    // it: as an AI Account's credential is, once it is added or opened.
    const credential = "anthropic-account-key-3b8f2d9a1c7e";
    logger.info(`before: ${credential}`);
    redactor.register(credential);
    logger.info(`after: ${credential}`);
    logger.warn(`and still ${env.SESSION_SECRET}`);

    expect(output.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({ msg: `before: ${credential}` }),
      expect.objectContaining({ msg: `after: ${redactedText}` }),
      expect.objectContaining({ msg: `and still ${redactedText}` }),
    ]);
  });

  it("scrubs the server's own request logs", async () => {
    const output = capture();
    const app = await buildApp({
      logger: createLogger({
        level: "info",
        secrets: secretValues(config),
        destination: output,
      }),
      checkDatabase: () => Promise.resolve(true),
      webDistDir: "/nonexistent",
      auth: await testAuth(),
    });
    await app.inject({
      url: `/health?leak=${encodeURIComponent(env.SESSION_SECRET)}`,
    });
    await app.close();

    const text = output.lines.join("");
    expect(text).toContain("/health?leak=");
    for (const value of forbidden) {
      expect(text).not.toContain(value);
    }
  });
});
