import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { schemaFile, schemaHash } from "./apply-schema.ts";
import {
  chainProblems,
  loadMigrations,
  type Migration,
  MigrationFileError,
  migrationPath,
  parseMigration,
} from "./migrations.ts";

const hash = (letter: string): string => letter.repeat(64);
const migration = (
  name: string,
  from: string | undefined,
  to: string,
): Migration => ({ name, from, to, sql: "" });

describe("parseMigration", () => {
  it("reads the from and to lines", () => {
    const text = `-- from: ${hash("a")}\n-- to: ${hash("b")}\nALTER TABLE x ADD COLUMN y int;\n`;
    expect(parseMigration("0001_add_y.sql", text)).toEqual({
      name: "0001_add_y.sql",
      from: hash("a"),
      to: hash("b"),
      sql: text,
    });
  });

  it("reads a baseline, which has no from", () => {
    expect(
      parseMigration("0000_baseline.sql", `-- to: ${hash("a")}\n`).from,
    ).toBe(undefined);
  });

  it("refuses a file with no to line, or a badly named one", () => {
    expect(() =>
      parseMigration("0001_x.sql", `-- from: ${hash("a")}\n`),
    ).toThrow(MigrationFileError);
    expect(() =>
      parseMigration("1_Add-Y.sql", `-- to: ${hash("a")}\n`),
    ).toThrow(/four digits/);
  });
});

describe("chainProblems", () => {
  it("accepts an unbroken chain from the baseline", () => {
    expect(
      chainProblems([
        migration("0000_baseline.sql", undefined, hash("a")),
        migration("0001_one.sql", hash("a"), hash("b")),
      ]),
    ).toEqual([]);
  });

  it("names a broken link, a gap in the numbers and a second baseline", () => {
    expect(
      chainProblems([
        migration("0000_baseline.sql", undefined, hash("a")),
        migration("0001_one.sql", hash("c"), hash("b")),
        migration("0003_two.sql", undefined, hash("d")),
      ]),
    ).toEqual([
      `0001_one.sql starts from ${hash("c")}, but 0000_baseline.sql ends at ${hash("a")}.`,
      "0003_two.sql should be numbered 0002.",
      `0003_two.sql has no "-- from:" line; it should start from ${hash("b")}, where 0001_one.sql ends.`,
    ]);
  });
});

describe("migrationPath", () => {
  const chain = [
    migration("0000_baseline.sql", undefined, hash("a")),
    migration("0001_one.sql", hash("a"), hash("b")),
    migration("0002_two.sql", hash("b"), hash("c")),
  ];

  it("runs every migration after the one the database is at", () => {
    expect(
      migrationPath(chain, hash("a"), hash("c"))?.map((m) => m.name),
    ).toEqual(["0001_one.sql", "0002_two.sql"]);
    expect(
      migrationPath(chain, hash("b"), hash("c"))?.map((m) => m.name),
    ).toEqual(["0002_two.sql"]);
  });

  it("finds no way from a schema the chain does not know, or to one", () => {
    expect(migrationPath(chain, hash("z"), hash("c"))).toBe(undefined);
    expect(migrationPath(chain, hash("a"), hash("z"))).toBe(undefined);
  });
});

describe("the migrations folder", () => {
  it("is one unbroken chain from its baseline", async () => {
    expect(chainProblems(await loadMigrations())).toEqual([]);
  });

  it("ends at today's schema.sql, so no schema change ships without its migration", async () => {
    const migrations = await loadMigrations();
    const current = schemaHash(await readFile(schemaFile, "utf8"));
    const last = migrations.at(-1);
    expect(
      last?.to,
      `schema.sql (${current}) has changed since the last migration, ${String(last?.name)}: add one with \`pnpm db:migration <name>\` (or, if that migration is yours and not yet released, set its "-- to:" line to ${current})`,
    ).toBe(current);
  });
});
