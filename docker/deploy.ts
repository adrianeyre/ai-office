// `pnpm redeploy`: builds and deploys AI Office on this machine with docker
// compose, from this working tree, migrating its database on the way:
//
//   1. checks the working tree is clean (everything under it is built into
//      the image) and, with --pull, fast-forwards it;
//   2. works out what the database needs: nothing, a fresh schema, or the
//      migrations in packages/db/migrations from its schema to this one, and
//      stops before anything changes if no migration leads there;
//   3. backs the database up with pg_dump (unless --skip-backup);
//   4. builds any sandbox image not built yet, and the app's image, while the
//      running app keeps serving;
//   5. replaces the app (and starts the sandbox relay), waiting for it to be
//      healthy. The app runs the migrations as it starts, in one transaction
//      that is committed only if the result matches schema.sql
//      (ADR 0017);
//   6. if the new app never gets healthy and its database was left as it
//      was, puts the previous image back. If the database was migrated, it
//      prints how to restore the backup instead of doing it itself.
//
// Options: --pull, --skip-backup, --allow-dirty, --allow-branch (deploy a
// branch other than main), --yes (no confirmation). AI_OFFICE_BACKUP_DIR
// (~/ai-office-backups by default) and AI_OFFICE_BACKUPS_KEPT (5) say where
// backups go and how many are kept.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

import { schemaFile, schemaHash } from "../packages/db/src/apply-schema.ts";
import {
  loadMigrations,
  migrationPath,
} from "../packages/db/src/migrations.ts";

const root = join(import.meta.dirname, "..");
const appImage = "ai-office:local";
const rollbackImage = "ai-office:rollback";

const { values: options } = parseArgs({
  options: {
    pull: { type: "boolean", default: false },
    "skip-backup": { type: "boolean", default: false },
    "allow-dirty": { type: "boolean", default: false },
    "allow-branch": { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
  },
});

function step(message: string): void {
  console.log(`\n▶ ${message}`);
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/** Runs a command in the repository, its output shown, or fails. */
function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}`,
    );
  }
}

/** Runs a command in the repository and returns its output. */
function output(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const compose = (...args: string[]): void => {
  run("docker", ["compose", ...args]);
};

function imageExists(image: string): boolean {
  return (
    spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" })
      .status === 0
  );
}

/** The schema hash the database records; undefined if it has no schema. */
function databaseSchemaHash(): string | undefined {
  const value = output("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username=ai_office",
    "--dbname=ai_office",
    "--no-align",
    "--tuples-only",
    "--command",
    "SELECT CASE WHEN to_regclass('public.schema_meta') IS NULL THEN '' ELSE (SELECT coalesce(max(value), '') FROM schema_meta WHERE key = 'schema_hash') END",
  ]);
  return value === "" ? undefined : value;
}

async function confirm(question: string): Promise<boolean> {
  if (options.yes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    fail(`${question} Pass --yes to answer yes without a terminal.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function backUp(): Promise<string> {
  const folder =
    process.env["AI_OFFICE_BACKUP_DIR"] ?? join(homedir(), "ai-office-backups");
  const kept = Number(process.env["AI_OFFICE_BACKUPS_KEPT"] ?? "5");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const file = join(folder, `ai-office-${stamp}.dump`);
  const child = spawn(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "--username=ai_office",
      "--dbname=ai_office",
      "--format=custom",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  await pipeline(child.stdout, createWriteStream(file, { mode: 0o600 }));
  const code = await exited;
  const { size } = await stat(file);
  if (code !== 0 || size === 0) {
    await rm(file, { force: true });
    throw new Error(`pg_dump exited ${String(code)}; no backup was made`);
  }
  // Keep only the newest few.
  const old = (await readdir(folder))
    .filter((name) => /^ai-office-.*\.dump$/.test(name))
    .sort()
    .slice(0, -Math.max(kept, 1));
  for (const name of old) {
    await rm(join(folder, name));
  }
  console.log(`Backed up to ${file} (${(size / 1024 / 1024).toFixed(0)} MB).`);
  return file;
}

// 1. The working tree.
step("Checking the working tree");
if (!existsSync(join(root, ".env"))) {
  fail(".env is missing: copy .env.example and set its secrets first.");
}
if (options.pull) {
  run("git", ["pull", "--ff-only"]);
}
const dirty = output("git", ["status", "--porcelain"]);
if (dirty !== "" && !options["allow-dirty"]) {
  fail(
    `The working tree has changes, which would be built into the image:\n${dirty}\nCommit or stash them, or pass --allow-dirty.`,
  );
}
const branch = output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const commit = output("git", ["log", "-1", "--format=%h %s"]);
if (branch !== "main" && !options["allow-branch"]) {
  fail(
    `On branch ${branch}, not main. Pass --allow-branch to deploy it anyway.`,
  );
}
console.log(`Deploying ${branch} at ${commit}.`);

// 2. What the database needs.
step("Checking the database schema");
compose("up", "--detach", "--wait", "postgres");
const target = schemaHash(await readFile(schemaFile, "utf8"));
const current = databaseSchemaHash();
let plan: string;
if (current === undefined) {
  plan = "The database is empty: the app will create the schema.";
} else if (current === target) {
  plan = "The schema is unchanged: no migrations to run.";
} else {
  const path = migrationPath(await loadMigrations(), current, target);
  if (path === undefined) {
    fail(
      `The database's schema (${current}) has no chain of migrations to this version's (${target}), so the new app would refuse to start. Nothing was changed. Add the missing migration (pnpm db:migration <name>) and try again.`,
    );
  }
  plan = `The app will migrate the database with: ${path.map((m) => m.name).join(", ")}.`;
}
console.log(plan);
if (!(await confirm("Deploy?"))) {
  fail("Stopped; nothing was changed.");
}

// 3. Backup.
let backup: string | undefined;
if (current !== undefined && !options["skip-backup"]) {
  step("Backing up the database");
  backup = await backUp();
}

// 4. Images, built while the old app keeps running.
step("Building any missing sandbox images");
run("node", ["docker/sandbox-build.ts", "--missing"], {
  AGENT_UID: "1000",
  AGENT_GID: "1000",
});
if (imageExists(appImage)) {
  run("docker", ["tag", appImage, rollbackImage]);
}
step("Building the app image");
compose("build", "app");

// 5. Replace the app.
step("Starting the new app (it migrates the database as it starts)");
try {
  compose("up", "--detach", "--wait", "app", "sandbox-relay");
} catch {
  console.error("\nThe new app did not become healthy. Its last log lines:");
  spawnSync("docker", ["compose", "logs", "--tail=60", "app"], {
    cwd: root,
    stdio: "inherit",
  });
  // 6. Roll back what can be rolled back safely.
  const after = databaseSchemaHash();
  if (after === current && imageExists(rollbackImage)) {
    step("The database was left as it was: putting the previous image back");
    run("docker", ["tag", rollbackImage, appImage]);
    compose("up", "--detach", "--wait", "--no-build", "app", "sandbox-relay");
    fail(
      "Rolled back to the previous image; the database is unchanged. See the logs above.",
    );
  }
  fail(
    after === current
      ? "There was no previous image to roll back to. See the logs above."
      : `The database was migrated (to ${String(after)}) but the new app is unhealthy, so the previous image cannot simply be put back. To go back, check out the previous release, then:\n  docker compose stop app\n  docker compose exec -T postgres pg_restore --username=ai_office --dbname=ai_office --clean --if-exists < ${backup ?? "<your backup>"}\n  docker compose up --detach --build --wait app`,
  );
}

step("Done");
console.log(`AI Office is running ${commit}.`);
console.log(plan);
if (backup !== undefined) {
  console.log(`Backup: ${backup}`);
}
console.log(
  `The previous image is kept as ${rollbackImage}; \`docker image prune\` clears old layers.`,
);
