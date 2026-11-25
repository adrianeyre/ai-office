import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import type { Database } from "./client.ts";
import { compareWithSchemaSql } from "./compare-schema.ts";
import { errorMessage } from "./error-message.ts";
import { loadMigrations, migrationPath, type Migration } from "./migrations.ts";

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

/**
 * Thrown when the database was made from a different `schema.sql` and no
 * chain of migrations leads from that one to this.
 */
export class SchemaMismatchError extends Error {
  constructor(found: string | undefined, expected: string) {
    super(
      found === undefined
        ? `The database has no schema hash recorded (expected ${expected}), so no migration can start from it. Recreate the database: \`pnpm db:reset\` for the development Postgres (this deletes its data).`
        : `The database was made from a different schema (hash ${found}, expected ${expected}), and no migration in packages/db/migrations leads from it to this one. Add one (\`pnpm db:migration <name>\`), or recreate the database: \`pnpm db:reset\` for the development Postgres (this deletes its data).`,
    );
    this.name = "SchemaMismatchError";
  }
}

/**
 * Thrown when migrating failed, or left the database different from what
 * `schema.sql` makes; either way nothing was changed.
 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** What `applySchema` did. */
export type SchemaOutcome =
  | { readonly action: "created" | "unchanged" }
  | {
      readonly action: "migrated";
      readonly from: string;
      /** The migrations' file names, in the order they ran. */
      readonly migrations: readonly string[];
    };

/** At most this many differences are named when a migration falls short. */
const differencesShown = 30;

/**
 * Makes sure the database has the schema in `schema.sql`, all in one
 * transaction:
 *
 * - an empty database (one with no `schema_meta` table) gets the whole of
 *   it, with its sha256 recorded in `schema_meta` under `schema_hash`;
 * - a database that already has this schema is left alone;
 * - one made from an earlier version is migrated: the migrations from its
 *   recorded hash to this one run in order (see `migrations.ts`), then the
 *   result is compared with a fresh copy of `schema.sql`, and only if they
 *   are the same is it committed, with the new hash. A migration that fails
 *   or falls short is a `MigrationError`, and nothing is changed;
 * - one that no chain of migrations leads from is a `SchemaMismatchError`.
 */
export async function applySchema(
  db: Database,
  {
    schemaSql,
    migrations,
  }: { schemaSql?: string; migrations?: readonly Migration[] } = {},
): Promise<SchemaOutcome> {
  const sqlText = schemaSql ?? (await readFile(schemaFile, "utf8"));
  const expected = schemaHash(sqlText);
  return db.transaction(async (tx): Promise<SchemaOutcome> => {
    // Two processes starting at once (the server and a test, say) must not
    // both create or migrate the schema.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('ai-office schema'))`,
    );
    const exists = await tx.execute<{ present: boolean }>(
      sql`SELECT to_regclass('public.schema_meta') IS NOT NULL AS present`,
    );
    if (exists.rows[0]?.present !== true) {
      // No parameters, so Postgres takes it as one simple query: every
      // statement in the file, in this transaction.
      await tx.execute(sql.raw(sqlText));
      await tx.execute(
        sql`INSERT INTO schema_meta (key, value, updated_at) VALUES (${schemaHashKey}, ${expected}, now())`,
      );
      return { action: "created" };
    }
    const found = await tx.execute<{ value: string }>(
      sql`SELECT value FROM schema_meta WHERE key = ${schemaHashKey}`,
    );
    const recorded = found.rows[0]?.value;
    if (recorded === expected) {
      return { action: "unchanged" };
    }
    if (recorded === undefined) {
      throw new SchemaMismatchError(recorded, expected);
    }
    const path = migrationPath(
      migrations ?? (await loadMigrations()),
      recorded,
      expected,
    );
    if (path === undefined) {
      throw new SchemaMismatchError(recorded, expected);
    }
    for (const migration of path) {
      try {
        await tx.execute(sql.raw(migration.sql));
      } catch (error) {
        throw new MigrationError(
          `Migration ${migration.name} failed, so nothing was changed: ${errorMessage(error)}`,
        );
      }
    }
    const { missing, unexpected } = await compareWithSchemaSql(tx, sqlText);
    if (missing.length > 0 || unexpected.length > 0) {
      const lines = [
        ...missing.map((line) => `  missing:    ${line}`),
        ...unexpected.map((line) => `  unexpected: ${line}`),
      ];
      const more = lines.length - differencesShown;
      throw new MigrationError(
        [
          `The migrations ${path.map((m) => m.name).join(", ")} ran, but left the database different from a fresh one made from schema.sql, so nothing was changed. Fix the migration. "missing" is in schema.sql but not the migrated database; "unexpected" the other way round:`,
          ...lines.slice(0, differencesShown),
          ...(more > 0 ? [`  … and ${String(more)} more`] : []),
        ].join("\n"),
      );
    }
    await tx.execute(
      sql`UPDATE schema_meta SET value = ${expected}, updated_at = now() WHERE key = ${schemaHashKey}`,
    );
    return {
      action: "migrated",
      from: recorded,
      migrations: path.map((migration) => migration.name),
    };
  });
}
