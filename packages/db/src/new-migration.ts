// `pnpm db:migration <name>`: after `pnpm db:generate` has written a changed
// `schema.sql`, writes the next migration file, from the schema the last
// migration ends at to today's. Its SQL is for you to write; to help, the
// change to `schema.sql` is put in it as comments when git still has the
// earlier version.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { schemaFile, schemaHash } from "./apply-schema.ts";
import {
  chainProblems,
  loadMigrations,
  migrationsFolder,
} from "./migrations.ts";

const name = (process.argv[2] ?? "").toLowerCase().replaceAll("-", "_");
if (!/^[a-z0-9_]+$/.test(name)) {
  console.error(
    "Name the migration, in lower case: pnpm db:migration add_browser_access",
  );
  process.exit(1);
}

const migrations = await loadMigrations();
const problems = chainProblems(migrations);
if (problems.length > 0) {
  console.error(`Fix the migrations first:\n${problems.join("\n")}`);
  process.exit(1);
}
const last = migrations.at(-1);
if (last === undefined) {
  throw new Error("unreachable: chainProblems requires a baseline");
}
const schemaSql = await readFile(schemaFile, "utf8");
const to = schemaHash(schemaSql);
if (last.to === to) {
  console.error(
    `schema.sql has not changed since ${last.name}, so there is nothing to migrate. Change src/schema.ts and run \`pnpm --filter @ai-office/db db:generate\` first.`,
  );
  process.exit(1);
}

/** schema.sql as git last had it at the hash `hash`, if it still has it. */
function earlierSchema(hash: string): string | undefined {
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: migrationsFolder,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    const root = git("rev-parse", "--show-toplevel").trim();
    const path = schemaFile.slice(root.length + 1);
    const commits = git("log", "--format=%H", "-n", "200", "--", path)
      .split("\n")
      .filter(Boolean);
    for (const commit of ["HEAD", ...commits]) {
      const text = git("show", `${commit}:${path}`);
      if (schemaHash(text) === hash) {
        return text;
      }
    }
  } catch {
    // No git, or not this file in it: the migration is written without help.
  }
  return undefined;
}

function changeAsComments(before: string): string {
  let diff: string;
  try {
    execFileSync("diff", ["-u", "-", schemaFile], {
      input: before,
      encoding: "utf8",
    });
    return "";
  } catch (error) {
    // diff exits 1 when the files differ, with the difference on stdout.
    const { stdout } = error as { stdout?: unknown };
    diff = typeof stdout === "string" ? stdout : "";
  }
  const body = diff
    .split("\n")
    .slice(2) // the two file-name lines
    .filter((line) => line !== "")
    .map((line) => `-- ${line}`.trimEnd());
  return `--\n-- The change to schema.sql (delete these lines once the SQL is written):\n${body.join("\n")}\n`;
}

const number = String(migrations.length).padStart(4, "0");
const file = `${number}_${name}.sql`;
const before = earlierSchema(last.to);
const text = `-- from: ${last.to}
-- to: ${to}
-- Takes a database made from the schema at \`from\` to the one at \`to\`, in
-- the transaction that then checks the result is the same as a fresh database
-- made from schema.sql, and commits it only if so.
${before === undefined ? "" : changeAsComments(before)}
-- Write the SQL here, such as:
-- ALTER TABLE "gateway_keys" ADD COLUMN "browser_access" jsonb;
`;
await writeFile(join(migrationsFolder, file), text, { flag: "wx" });
console.log(
  `Wrote packages/db/migrations/${file}. Write its SQL, then check it with \`pnpm --filter @ai-office/db test\`.`,
);
