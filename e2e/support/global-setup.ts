import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

import { applySchema, connect } from "@ai-office/db";
import { checkDocker, postgresImage } from "@ai-office/db/testing/docker";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

import {
  postgresServerEnv,
  skipEnv,
  templateDatabase,
  urlFor,
  webIndexHtml,
} from "./paths.ts";

/**
 * Runs once before the tests: checks the web app is built, starts Postgres
 * 18 with Testcontainers (or uses `E2E_POSTGRES_URL`, a superuser URL for
 * a Postgres you already run), and applies the schema to a template database that each
 * test's database is copied from. Without Docker the tests are skipped
 * with the reason, except in CI, where that fails them.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(webIndexHtml)) {
    throw new Error(
      `The web app is not built (${webIndexHtml} is missing). Run \`pnpm e2e\` from the repository root, which builds it first.`,
    );
  }

  let serverUrl = process.env["E2E_POSTGRES_URL"];
  let stopContainer = (): Promise<void> => Promise.resolve();
  if (serverUrl === undefined || serverUrl === "") {
    const docker = await checkDocker();
    if (!docker.available) {
      if (process.env["CI"]) {
        throw new Error(
          `${docker.reason}. CI must run the end-to-end tests, so they fail here instead of skipping.`,
        );
      }
      const message = `${docker.reason}, so the end-to-end tests are skipped. They run in CI and on the host, or set E2E_POSTGRES_URL.`;
      console.warn(message);
      process.env[skipEnv] = message;
      return () => Promise.resolve();
    }
    // The server redacts its database password from everything it emits, so
    // the default password, "test", would redact the word wherever it appears.
    const container = await new PostgreSqlContainer(postgresImage)
      .withPassword(randomBytes(16).toString("hex"))
      .start();
    serverUrl = container.getConnectionUri();
    stopContainer = async () => {
      await container.stop();
    };
  }

  const admin = new pg.Client({
    connectionString: urlFor(serverUrl, "postgres"),
  });
  await admin.connect();
  const dropTemplate = () =>
    admin.query(`DROP DATABASE IF EXISTS ${templateDatabase} WITH (FORCE)`);
  try {
    await dropTemplate();
    await admin.query(`CREATE DATABASE ${templateDatabase}`);
    const template = connect(urlFor(serverUrl, templateDatabase));
    try {
      await applySchema(template.db);
    } finally {
      await template.close();
    }
  } catch (error) {
    await admin.end();
    await stopContainer();
    throw error;
  }
  // The tests run in other processes, which inherit the environment.
  process.env[postgresServerEnv] = serverUrl;

  return async () => {
    try {
      await dropTemplate();
    } finally {
      await admin.end();
      await stopContainer();
    }
  };
}
