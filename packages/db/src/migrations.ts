// Schema migrations: plain SQL files in `packages/db/migrations`, each taking
// a database made from one version of `schema.sql` to the next. A version is
// named by its sha256 (see `schemaHash`), so each file says which version it
// starts `from` and which it ends at (`to`), and they form one chain:
//
//   0000_baseline.sql            -- to: <the first version migrations start from>
//   0001_add_browser_access.sql  -- from: <0000's to>  -- to: <the next>
//   …
//
// The last one's `to` is always the hash of today's `schema.sql`, which a
// test checks, so a change to the schema cannot ship without its migration.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder the migrations are kept in. */
export const migrationsFolder = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

export interface Migration {
  /** The file's name, such as `0001_add_browser_access.sql`. */
  readonly name: string;
  /** The hash of the schema it starts from; undefined for the baseline. */
  readonly from: string | undefined;
  /** The hash of the schema it ends at. */
  readonly to: string;
  /** The whole file, run as it is. */
  readonly sql: string;
}

/** A migration file that cannot be read as one. */
export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationFileError";
  }
}

const fileNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const hashLine = (key: "from" | "to"): RegExp =>
  new RegExp(`^-- ${key}: ([0-9a-f]{64})\\s*$`, "m");

/** Reads one migration file's `-- from:` and `-- to:` lines. */
export function parseMigration(name: string, text: string): Migration {
  if (!fileNamePattern.test(name)) {
    throw new MigrationFileError(
      `${name}: a migration's file name is four digits, an underscore and a lower-case name, such as 0001_add_browser_access.sql`,
    );
  }
  const to = hashLine("to").exec(text)?.[1];
  if (to === undefined) {
    throw new MigrationFileError(
      `${name} has no "-- to: <sha256>" line, naming the schema it ends at`,
    );
  }
  return { name, from: hashLine("from").exec(text)?.[1], to, sql: text };
}

/** Every migration in `folder`, in the order of their numbers. */
export async function loadMigrations(
  folder: string = migrationsFolder,
): Promise<Migration[]> {
  const names = (await readdir(folder))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) =>
      parseMigration(name, await readFile(join(folder, name), "utf8")),
    ),
  );
}

/**
 * What is wrong with a folder of migrations, if anything: they must be
 * numbered 0000, 0001, … with no gaps, start with the one baseline (no
 * `from`), and each must start from the schema the one before it ends at.
 */
export function chainProblems(migrations: readonly Migration[]): string[] {
  const problems: string[] = [];
  if (migrations.length === 0) {
    return ["There are no migrations: the folder needs its 0000 baseline."];
  }
  migrations.forEach((migration, index) => {
    const number = String(index).padStart(4, "0");
    if (!migration.name.startsWith(`${number}_`)) {
      problems.push(`${migration.name} should be numbered ${number}.`);
    }
    const previous = migrations[index - 1];
    if (previous === undefined) {
      if (migration.from !== undefined) {
        problems.push(
          `${migration.name} is the first, so it is the baseline: it has a "-- to:" line and no "-- from:".`,
        );
      }
    } else if (migration.from !== previous.to) {
      problems.push(
        migration.from === undefined
          ? `${migration.name} has no "-- from:" line; it should start from ${previous.to}, where ${previous.name} ends.`
          : `${migration.name} starts from ${migration.from}, but ${previous.name} ends at ${previous.to}.`,
      );
    }
  });
  return problems;
}

/**
 * The migrations that take a database made from the schema `from` to the
 * schema `to`, in the order to run them, or undefined when the chain has no
 * way from one to the other.
 */
export function migrationPath(
  migrations: readonly Migration[],
  from: string,
  to: string,
): Migration[] | undefined {
  const start = migrations.findIndex((migration) => migration.to === from);
  if (start === -1) {
    return undefined;
  }
  const path: Migration[] = [];
  let at = from;
  for (const migration of migrations.slice(start + 1)) {
    if (migration.from !== at) {
      return undefined;
    }
    path.push(migration);
    at = migration.to;
    if (at === to) {
      return path;
    }
  }
  return undefined;
}
