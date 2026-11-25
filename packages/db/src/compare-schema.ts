// Checks that a migrated database has exactly the schema a fresh one would:
// `schema.sql` is run in a scratch Postgres schema inside the same
// transaction, both are described from the catalog, and the descriptions
// compared. So a migration that misses a column, a constraint or an index is
// caught before anything is committed.
import { sql } from "drizzle-orm";

import type { Database } from "./client.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The scratch schema `schema.sql` is built in, and dropped again. */
export const scratchSchema = "ai_office_schema_check";

// Each query names one kind of thing in the schema `$ns`, a line each.
// Column order is left out: a column a migration adds comes last, wherever
// `schema.ts` puts it. Postgres 18's NOT NULL constraints are left out too
// (`attnotnull` says it), since their names follow the column's first name.
const describeQueries = (ns: string): ReturnType<typeof sql>[] => [
  sql`SELECT 'relation ' || c.relkind::text || ' ' || c.relname AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ns} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
  sql`SELECT 'column ' || c.relname || '.' || a.attname || ' '
        || format_type(a.atttypid, a.atttypmod)
        || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
        || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
        || CASE a.attidentity WHEN 'a' THEN ' identity always'
             WHEN 'd' THEN ' identity by default' ELSE '' END
        || CASE a.attgenerated WHEN 's' THEN ' generated stored'
             WHEN 'v' THEN ' generated virtual' ELSE '' END
        || coalesce(' collate ' || co.collname, '') AS line
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation co
        ON co.oid = a.attcollation AND a.attcollation <> t.typcollation
      WHERE n.nspname = ${ns} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.attnum > 0 AND NOT a.attisdropped`,
  sql`SELECT 'constraint ' || c.relname || '.' || con.conname || ' '
        || pg_get_constraintdef(con.oid) AS line
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ns} AND con.contype <> 'n'`,
  sql`SELECT 'index ' || pg_get_indexdef(i.indexrelid) AS line
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = ${ns}`,
  sql`SELECT 'trigger ' || pg_get_triggerdef(t.oid) AS line
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ns} AND NOT t.tgisinternal`,
  sql`SELECT 'function ' || pg_get_functiondef(p.oid) AS line
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${ns} AND p.prokind IN ('f', 'p')`,
  sql`SELECT 'sequence ' || c.relname || ' ' || format_type(s.seqtypid, NULL)
        || ' start ' || s.seqstart || ' increment ' || s.seqincrement
        || ' min ' || s.seqmin || ' max ' || s.seqmax || ' cache ' || s.seqcache
        || CASE WHEN s.seqcycle THEN ' cycle' ELSE '' END AS line
      FROM pg_sequence s
      JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ns}`,
  sql`SELECT 'view ' || c.relname || ' ' || pg_get_viewdef(c.oid) AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${ns} AND c.relkind IN ('v', 'm')`,
  sql`SELECT 'enum ' || t.typname || ' '
        || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS line
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ${ns}
      GROUP BY t.typname`,
];

/**
 * Every table, column, constraint, index, trigger, function, sequence, view
 * and enum in the Postgres schema `ns`, a sorted line each, with `ns`'s own
 * name taken out so two schemas built alike describe alike.
 */
export async function describeSchema(
  tx: Transaction,
  ns: string,
): Promise<string[]> {
  // Names in `ns` print unqualified while it is the search path.
  await tx.execute(sql`SELECT set_config('search_path', ${`"${ns}"`}, true)`);
  const lines: string[] = [];
  for (const query of describeQueries(ns)) {
    const result = await tx.execute<{ line: string }>(query);
    for (const row of result.rows) {
      lines.push(row.line.replaceAll(`"${ns}".`, "").replaceAll(`${ns}.`, ""));
    }
  }
  return lines.sort();
}

export interface SchemaDifferences {
  /** In a fresh database made from `schema.sql`, but not in this one. */
  readonly missing: string[];
  /** In this database, but not in a fresh one. */
  readonly unexpected: string[];
}

/**
 * How the database's current schema differs from what `schemaSql` makes,
 * inside the transaction `tx`. The scratch schema it builds is dropped again
 * and the search path put back.
 */
export async function compareWithSchemaSql(
  tx: Transaction,
  schemaSql: string,
): Promise<SchemaDifferences> {
  const setting = await tx.execute<{ path: string; current: string }>(
    sql`SELECT current_setting('search_path') AS path, current_schema() AS current`,
  );
  const { path, current } = setting.rows[0] ?? {};
  if (path === undefined || current === undefined) {
    throw new Error("Postgres did not say its search path.");
  }
  await tx.execute(
    sql.raw(
      `DROP SCHEMA IF EXISTS "${scratchSchema}" CASCADE; CREATE SCHEMA "${scratchSchema}"`,
    ),
  );
  await tx.execute(
    sql`SELECT set_config('search_path', ${`"${scratchSchema}"`}, true)`,
  );
  // drizzle-kit names "public" for foreign keys' tables; the rest is
  // unqualified and lands in the search path's schema.
  await tx.execute(
    sql.raw(schemaSql.replaceAll('"public".', `"${scratchSchema}".`)),
  );
  const expected = await describeSchema(tx, scratchSchema);
  const actual = await describeSchema(tx, current);
  await tx.execute(sql.raw(`DROP SCHEMA "${scratchSchema}" CASCADE`));
  await tx.execute(sql`SELECT set_config('search_path', ${path}, true)`);
  const actualKeys = new Set(actual.map(comparisonKey));
  const expectedKeys = new Set(expected.map(comparisonKey));
  return {
    missing: expected.filter((line) => !actualKeys.has(comparisonKey(line))),
    unexpected: actual.filter((line) => !expectedKeys.has(comparisonKey(line))),
  };
}

/**
 * A line as it is compared: without parentheses or white space. Postgres
 * prints an expression as it was parsed, and a database restored from
 * `pg_dump` has had its expressions parsed again, which flattens
 * `((a AND b) AND c)` to `(a AND b AND c)`; the two must compare alike. The
 * price is that two expressions differing only in where their parentheses
 * fall compare alike too, which no migration is likely to do by mistake.
 */
function comparisonKey(line: string): string {
  return line.replaceAll(/[()\s]/g, "");
}
