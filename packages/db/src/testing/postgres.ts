// A Vitest harness for tests that need a real Postgres 18. One container is
// started per test file and given the schema once in a template database; every
// test then gets its own fresh database copied from that template, so tests
// never see each other's rows.
//
// Without Docker (the Sandcastle sandbox, for one) the tests are skipped with
// the reason. In CI (`CI` set) a missing Docker fails them instead, so CI can
// never pass by quietly skipping its integration tests.
import { randomBytes } from "node:crypto";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { test } from "vitest";

import { applySchema } from "../apply-schema.ts";
import { connect, type DatabaseConnection } from "../client.ts";
import { checkDocker, postgresImage } from "./docker.ts";

export { checkDocker, postgresImage, type DockerStatus } from "./docker.ts";

const templateDatabase = "ai_office_template";

export interface PostgresServer {
  /** Creates a database with the schema and nothing else and returns its URL. */
  createDatabase(): Promise<string>;
  dropDatabase(url: string): Promise<void>;
  /** Drops the template and closes the admin connection. */
  close(): Promise<void>;
}

/**
 * Prepares a running Postgres server for tests: applies the schema to a
 * template database once, then copies it for each test. `serverUrl` is a superuser URL for
 * the server; its database part is ignored.
 */
export async function preparePostgresServer(
  serverUrl: string,
): Promise<PostgresServer> {
  const urlFor = (database: string): string => {
    const url = new URL(serverUrl);
    url.pathname = `/${database}`;
    return url.toString();
  };

  // Connected to the maintenance database, so CREATE and DROP DATABASE can
  // run while no one is connected to the database they act on.
  const admin = new pg.Pool({ connectionString: urlFor("postgres"), max: 1 });
  const dropDatabase = async (name: string): Promise<void> => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  };

  try {
    await admin.query(`CREATE DATABASE ${templateDatabase}`);
    const template = connect(urlFor(templateDatabase));
    try {
      await applySchema(template.db);
    } finally {
      await template.close();
    }
  } catch (error) {
    await admin.end();
    throw error;
  }

  let databases = 0;
  return {
    async createDatabase() {
      databases += 1;
      const name = `test_${String(databases)}`;
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${templateDatabase}`);
      return urlFor(name);
    },
    async dropDatabase(url) {
      await dropDatabase(new URL(url).pathname.slice(1));
    },
    async close() {
      try {
        await dropDatabase(templateDatabase);
      } finally {
        await admin.end();
      }
    },
  };
}

async function startPostgres(): Promise<{
  server: PostgresServer;
  stop: () => Promise<void>;
}> {
  // A password of its own, as a deployment's is: the default, "test", is a
  // word, and code that refuses or redacts the database password wherever
  // it appears (the pen-test credentials package, for one) finds it in
  // "Pen-test" and elsewhere.
  const container = await new PostgreSqlContainer(postgresImage)
    .withPassword(randomBytes(16).toString("hex"))
    .start();
  let server: PostgresServer;
  try {
    server = await preparePostgresServer(container.getConnectionUri());
  } catch (error) {
    await container.stop();
    throw error;
  }
  return {
    server,
    stop: async () => {
      await server.close();
      await container.stop();
    },
  };
}

export interface TestDatabase extends DatabaseConnection {
  /** The database's `postgres://` URL, as `DATABASE_URL` would hold it. */
  readonly url: string;
}

/**
 * `test` with a `database` fixture: a fresh Postgres 18 database with the schema
 * for each test that asks for it, dropped afterwards.
 *
 * ```ts
 * postgresTest("reads schema_meta", async ({ database }) => {
 *   const rows = await database.db.select().from(schemaMeta);
 * });
 * ```
 */
export const postgresTest = test
  .extend(
    "postgresServer",
    { scope: "file" },
    // Vitest reads a fixture's dependencies from its destructuring pattern,
    // so a fixture that depends on nothing must destructure nothing.
    // eslint-disable-next-line no-empty-pattern
    async ({}, { onCleanup }): Promise<PostgresServer | string> => {
      const docker = await checkDocker();
      if (!docker.available) {
        if (process.env["CI"]) {
          throw new Error(
            `${docker.reason}. CI must run the Postgres integration tests, so they fail here instead of skipping.`,
          );
        }
        const message = `${docker.reason}, so the Postgres integration tests are skipped. They run in CI and on the host.`;
        // Every reporter shows this; only the verbose one shows skip notes.
        console.warn(message);
        return message;
      }
      const { server, stop } = await startPostgres();
      onCleanup(stop);
      return server;
    },
  )
  .extend(
    "database",
    async ({ postgresServer, skip }, { onCleanup }): Promise<TestDatabase> => {
      if (typeof postgresServer === "string") {
        return skip(postgresServer);
      }
      const url = await postgresServer.createDatabase();
      const connection = connect(url);
      onCleanup(async () => {
        await connection.close();
        await postgresServer.dropDatabase(url);
      });
      return { ...connection, url };
    },
  );
