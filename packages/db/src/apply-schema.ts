import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import type { Database } from "./client.ts";

/** The whole schema as plain SQL, written by `pnpm db:generate`. */
export const schemaFile = fileURLToPath(
  new URL("../schema.sql", import.meta.url),
);

/** The `schema_meta` key under which the applied schema's hash is kept. */
export const schemaHashKey = "schema_hash";

/** The sha256 (hex) of a schema's SQL, as `applySchema` records it. */
export function schemaHash(schemaSql: string): string {
  return createHash("sha256").update(schemaSql).digest("hex");
}

/** Thrown when the database was made from a different `schema.sql`. */
export class SchemaMismatchError extends Error {
  constructor(found: string | undefined, expected: string) {
    super(
      `The database was made from a different schema (${found === undefined ? "no schema hash recorded" : `hash ${found}`}, expected ${expected}), and it cannot be updated in place: AI Office has no migrations. Recreate the database: \`pnpm db:reset\` for the development Postgres (this deletes its data).`,
    );
    this.name = "SchemaMismatchError";
  }
}

/**
 * Makes sure the database has the schema in `schema.sql`. An empty database
 * (one with no `schema_meta` table) gets the whole of it, in one transaction,
 * with its sha256 recorded in `schema_meta` under `schema_hash`. A database
 * that already has this schema is left alone. One made from any other
 * version of it is refused with a `SchemaMismatchError`: there are no
 * migrations, so it can only be made again.
 */
export async function applySchema(
  db: Database,
  { schemaSql }: { schemaSql?: string } = {},
): Promise<void> {
  const sqlText = schemaSql ?? (await readFile(schemaFile, "utf8"));
  const expected = schemaHash(sqlText);
  await db.transaction(async (tx) => {
    // Two processes starting at once (the server and a test, say) must not
    // both create the schema.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('ai-office schema'))`,
    );
    const exists = await tx.execute<{ present: boolean }>(
      sql`SELECT to_regclass('public.schema_meta') IS NOT NULL AS present`,
    );
    if (exists.rows[0]?.present === true) {
      const found = await tx.execute<{ value: string }>(
        sql`SELECT value FROM schema_meta WHERE key = ${schemaHashKey}`,
      );
      const recorded = found.rows[0]?.value;
      if (recorded !== expected) {
        throw new SchemaMismatchError(recorded, expected);
      }
      return;
    }
    // No parameters, so Postgres takes it as one simple query: every
    // statement in the file, in this transaction.
    await tx.execute(sql.raw(sqlText));
    await tx.execute(
      sql`INSERT INTO schema_meta (key, value, updated_at) VALUES (${schemaHashKey}, ${expected}, now())`,
    );
  });
}
