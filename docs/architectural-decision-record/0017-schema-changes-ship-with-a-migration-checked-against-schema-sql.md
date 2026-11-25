# Schema changes ship with a migration, checked against `schema.sql` before it is committed

Until now AI Office had no migrations: the schema was one generated file, `packages/db/schema.sql`, applied to an empty database, and a database made from any other version was refused, to be recreated. That suited a project not yet in production. It no longer does: the Owner runs AI Office for real, and every schema change left the app's container restarting on a `SchemaMismatchError` until someone altered the database by hand or deleted its data. So **each change to `schema.sql` now ships with a hand-written SQL migration** in `packages/db/migrations`, and the app runs the ones a database needs as it starts. **`schema.sql` stays the one source of truth**: a migrated database is compared with a fresh one built from it, and committed only if they are the same.

## Considered Options

- **Keep recreating the database**: loses the Owner's data (accounts, keys, history) on every release that touches the schema.
- **drizzle-kit migrations** (`drizzle-kit generate`, with its journal and snapshots): AI Office used them once and replaced them with the single `schema.sql`. They would bring back a second description of the schema (the snapshots) beside `schema.ts`, and generated SQL that still needs reading, for what is a handful of `ALTER TABLE`s a release.
- **Diff the live schema against `schema.sql` and apply the difference automatically**: cannot tell a rename from a drop and an add, nor fill a new column for existing rows, and would quietly drop what it does not recognise.
- **Hand-written SQL migrations chained by schema hash, each result compared with `schema.sql`** (chosen).

## Consequences

- A version of the schema is named by the sha256 of `schema.sql`, as `schema_meta.schema_hash` already recorded it. Each migration file names the version it starts from (`-- from:`) and ends at (`-- to:`); they are numbered and form one chain from `0000_baseline` (release 1.13.0's schema, which has a `-- to:` only). A database older than the baseline can still only be recreated.
- A test checks the chain is unbroken and ends at today's `schema.sql`, so a schema change cannot be merged without its migration. `pnpm db:migration <name>` writes the next file's header, and the change to `schema.sql` as comments to write the SQL from.
- The migrations, the comparison and the new hash are one transaction, under the advisory lock that already kept two processes from creating the schema at once. A migration that fails, or leaves the database different from `schema.sql` (a missing constraint, a wrong default), rolls back: the container exits as before, but the database is untouched and the error names each difference.
- The comparison builds `schema.sql` in a scratch Postgres schema (`ai_office_schema_check`, dropped again) and compares the two from the catalog: tables, columns (not their order), constraints, indexes, triggers, functions, sequences, views and enums. Expressions are compared without their parentheses and white space, because a database restored from `pg_dump` prints them flatter. Starting rows (the built-in Roles, `schema_meta`'s own) are not compared: a migration that changes them must say so itself.
- A released migration is never edited, since databases have already run it; a mistake is fixed with the next one.
