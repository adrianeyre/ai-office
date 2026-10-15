import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  readonly db: Database;
  readonly pool: pg.Pool;
  /** Closes every pooled connection. */
  close(): Promise<void>;
}

/**
 * Connects to Postgres at `databaseUrl` (a `postgres://` URL, normally the
 * `DATABASE_URL` from the environment). Connections are opened lazily, so this
 * never fails; the first query does if the database is unreachable.
 */
export function connect(databaseUrl: string): DatabaseConnection {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // An idle client that loses its connection emits `error` on the pool;
  // unhandled, that would crash the process. The next query reports it.
  pool.on("error", () => undefined);
  return {
    db: drizzle(pool, { schema }),
    pool,
    close: () => pool.end(),
  };
}

/** Whether the database answers a trivial query. */
export async function ping(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads `DATABASE_URL` from `env`, refusing with a message that names it
 * when it is missing.
 */
export function databaseUrlFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const url = env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is not set; it must be a postgres:// URL for the AI Office database.",
    );
  }
  return url;
}
