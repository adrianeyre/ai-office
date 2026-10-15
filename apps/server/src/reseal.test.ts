import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { postgresTest } from "@ai-office/db/testing";
import { createEncryptor, type Encryptor } from "@ai-office/shared/crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  resealValues,
  resealWithCurrentKey,
  sealedColumns,
  type SealedColumn,
  type SealedValueStore,
} from "./reseal.ts";

// Rotating ENCRYPTION_KEY (pen-testing G1-9): with the key it replaced in
// RETIRED_ENCRYPTION_KEYS, every value sealed with the retired key is
// sealed again with the new one, so the retired key can go and nothing
// sealed is lost.

const retiredKey = Buffer.alloc(32, 21);
const newKey = Buffer.alloc(32, 22);
const lostKey = Buffer.alloc(32, 23);

/** The Office before the rotation: ENCRYPTION_KEY alone, as version 1. */
const before = createEncryptor({
  keys: new Map([[1, retiredKey]]),
  currentKeyVersion: 1,
});
/** During it: the new key as version 2, beside the one it replaced. */
const during = createEncryptor({
  keys: new Map([
    [1, retiredKey],
    [2, newKey],
  ]),
  currentKeyVersion: 2,
});
/** After it: the new key alone. */
const after = createEncryptor({
  keys: new Map([[2, newKey]]),
  currentKeyVersion: 2,
});

const name = (column: SealedColumn): string =>
  `${column.table}.${column.column}`;

/** Sealed values in memory, by `table.column` and then by row. */
function memorySealedValues(
  rows: Record<string, Record<string, string | null>>,
): SealedValueStore & { replaced: number } {
  const store = {
    replaced: 0,
    notSealedAs(
      column: SealedColumn,
      version: number,
      afterKey: string | undefined,
      limit: number,
    ) {
      const values = Object.entries(rows[name(column)] ?? {})
        .filter(
          (entry): entry is [string, string] =>
            entry[1] !== null &&
            !entry[1].startsWith(`aio1:${String(version)}:`) &&
            (afterKey === undefined || entry[0] > afterKey),
        )
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([key, value]) => ({ key, value }));
      return Promise.resolve(values);
    },
    replace(
      column: SealedColumn,
      key: string,
      previous: string,
      value: string,
    ) {
      const table = rows[name(column)];
      if (table?.[key] !== previous) {
        return Promise.resolve(false);
      }
      table[key] = value;
      store.replaced += 1;
      return Promise.resolve(true);
    },
  };
  return store;
}

const column = (table: string, columnName: string): SealedColumn => {
  const found = sealedColumns.find(
    (each) => each.table === table && each.column === columnName,
  );
  if (found === undefined) {
    throw new Error(`no sealed column ${table}.${columnName}`);
  }
  return found;
};

const seal = (
  encryptor: Encryptor,
  sealed: SealedColumn,
  key: string,
  value: string,
): string => encryptor.encrypt(value, sealed.context(key));

describe("re-sealing with a new ENCRYPTION_KEY (pen-testing G1-9)", () => {
  it("seals every value in every sealed column again with the new key, so it opens once the retired key is gone", async () => {
    const rows: Record<string, Record<string, string | null>> = {};
    const plaintexts = new Map<string, string>();
    for (const sealed of sealedColumns) {
      const key = sealed.table === "gateway_request_bodies" ? "42" : "row-1";
      const value = `fake-${sealed.table}-${sealed.column}-value`;
      rows[name(sealed)] = { [key]: seal(before, sealed, key, value) };
      plaintexts.set(name(sealed), value);
    }
    const outcome = await resealValues({
      store: memorySealedValues(rows),
      encryptor: during,
    });
    expect(outcome).toEqual({
      resealed: sealedColumns.length,
      unreadable: {},
    });
    for (const sealed of sealedColumns) {
      const [[key, value]] = Object.entries(rows[name(sealed)] ?? {}) as [
        [string, string],
      ];
      expect(after.keyVersionOf(value)).toBe(2);
      expect(after.decrypt(value, sealed.context(key))).toBe(
        plaintexts.get(name(sealed)),
      );
    }
  });

  it("goes through every row, a batch at a time, leaving alone what is already the new key's, what is empty, and what no key opens", async () => {
    const credential = column("ai_accounts", "credential");
    const keyRow = column("gateway_keys", "sealed_key");
    const lost = createEncryptor({
      keys: new Map([[3, lostKey]]),
      currentKeyVersion: 3,
    });
    const credentials: Record<string, string | null> = {};
    for (const id of ["a", "b", "c", "d", "e"]) {
      credentials[id] = seal(before, credential, id, `fake-credential-${id}`);
    }
    const alreadyNew = seal(after, credential, "f", "fake-credential-f");
    credentials["f"] = alreadyNew;
    const unopenable = seal(lost, credential, "g", "fake-credential-g");
    credentials["g"] = unopenable;
    const rows = {
      [name(credential)]: credentials,
      [name(keyRow)]: { "owner-tool": null },
    };
    const store = memorySealedValues(rows);
    const outcome = await resealValues({
      store,
      encryptor: during,
      columns: [credential, keyRow],
      batchSize: 2,
    });
    expect(outcome).toEqual({
      resealed: 5,
      unreadable: { "ai_accounts.credential": 1 },
    });
    expect(store.replaced).toBe(5);
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      expect(after.decrypt(credentials[id] ?? "", credential.context(id))).toBe(
        `fake-credential-${id}`,
      );
    }
    expect(credentials["f"]).toBe(alreadyNew);
    expect(credentials["g"]).toBe(unopenable);
    expect(rows[name(keyRow)]).toEqual({ "owner-tool": null });
  });

  it("leaves a value changed meanwhile to whoever changed it", async () => {
    const credential = column("ai_accounts", "credential");
    const credentials: Record<string, string | null> = {
      a: seal(before, credential, "a", "fake-credential-a"),
    };
    const store = memorySealedValues({ [name(credential)]: credentials });
    const changed = seal(during, credential, "a", "fake-credential-changed");
    const outcome = await resealValues({
      store: {
        notSealedAs: (...args) => store.notSealedAs(...args),
        replace: async (sealed, key, previous, value) => {
          // Saved with the new key just before this re-seal writes.
          credentials[key] = changed;
          return store.replace(sealed, key, previous, value);
        },
      },
      encryptor: during,
      columns: [credential],
    });
    expect(outcome.resealed).toBe(0);
    expect(credentials["a"]).toBe(changed);
  });

  it("knows every column the schema keeps a sealed value in", () => {
    const schema = readFileSync(
      new URL("../../../packages/db/schema.sql", import.meta.url),
      "utf8",
    );
    const constrained = [
      ...schema.matchAll(/"([a-z_]+)"\."([a-z_]+)" LIKE 'aio1:%'/g),
    ].map(([, table, columnName]) => `${table ?? ""}.${columnName ?? ""}`);
    expect(constrained.length).toBeGreaterThan(0);
    const known = sealedColumns.map(name);
    expect(constrained.filter((each) => !known.includes(each))).toEqual([]);
    // And each one the schema names, sealed with no constraint to say so.
    for (const each of known) {
      const [table, columnName] = each.split(".");
      expect(schema).toMatch(
        new RegExp(
          `CREATE TABLE "${table ?? ""}" \\([^;]*"${columnName ?? ""}" text`,
        ),
      );
    }
  });

  it("knows every module that seals a value: a new one needs its columns here", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const sealing: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") {
            visit(path);
          }
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          readFileSync(path, "utf8").includes(".encrypt(")
        ) {
          sealing.push(relative(root, path));
        }
      }
    };
    for (const source of [
      "apps/server/src",
      "packages/gateway/src",
      "packages/communications/src",
      "packages/orchestrator/src",
    ]) {
      visit(join(root, source));
    }
    // Each with the columns above that its values are kept in.
    expect(sealing.sort()).toEqual([
      "apps/server/src/auth/totp.ts", // owner.totp_secret, totp_pending_secret
      "apps/server/src/reseal.ts", // every column above, sealed again
      "packages/communications/src/communications.ts", // connections.credentials
      "packages/communications/src/google.ts", // google_sign_in.*
      "packages/gateway/src/accounts/accounts.ts", // ai_accounts.*
      "packages/gateway/src/history/history.ts", // gateway_request_bodies.*
      "packages/gateway/src/keys/keys.ts", // gateway_keys.sealed_key
      "packages/orchestrator/src/github-connections/connections.ts", // github_connections.*
      "packages/orchestrator/src/office/settings.ts", // office_settings.gateway_outbound_proxy_password
      "packages/orchestrator/src/webhooks/webhooks.ts", // office_settings.github_webhook_secret
    ]);
  });
});

describe("re-sealing in Postgres as AI Office starts (pen-testing G1-9)", () => {
  postgresTest(
    "seals each value again with the new key, in place, and says the retired key can go",
    async ({ database }) => {
      const { db } = database;
      const sealWith = (table: string, columnName: string, key: string) =>
        seal(
          before,
          column(table, columnName),
          key,
          `fake-${table}-${columnName}`,
        );
      const now = new Date().toISOString();
      await db.execute(sql`
        INSERT INTO "ai_accounts" ("id", "name", "account_type", "ai_provider",
          "credential", "priority", "created_at", "updated_at")
        VALUES ('acct-1', 'Fake account', 'api_key', 'Claude',
          ${sealWith("ai_accounts", "credential", "acct-1")}, 1, ${now}, ${now})
      `);
      // TOTP on: owner_totp_enabled holds a secret only with its time.
      await db.execute(sql`
        INSERT INTO "owner" ("id", "password_hash", "totp_secret",
          "totp_enabled_at")
        VALUES (1, '$argon2id$fake', ${sealWith("owner", "totp_secret", "1")},
          ${now})
      `);
      await db.execute(sql`
        INSERT INTO "connections" ("id", "name", "type", "rules",
          "credentials", "hint", "created_at")
        VALUES ('conn-1', 'Fake webhook', 'webhook', '{}'::jsonb,
          ${sealWith("connections", "credentials", "conn-1")}, '…0000', ${now})
      `);
      await db.execute(sql`
        INSERT INTO "google_sign_in" ("id", "client_id", "client_secret")
        VALUES (1, 'fake-client-id',
          ${sealWith("google_sign_in", "client_secret", "1")})
      `);
      await db.execute(sql`
        INSERT INTO "office_settings" ("id", "github_webhook_secret", "updated_at")
        VALUES (1, ${sealWith("office_settings", "github_webhook_secret", "1")}, ${now})
        ON CONFLICT ("id") DO UPDATE
          SET "github_webhook_secret" = excluded."github_webhook_secret"
      `);
      await db.execute(sql`
        INSERT INTO "github_connections" ("id", "kind", "name", "token",
          "read_only_token", "hint", "created_at")
        VALUES ('github-1', 'access-token', 'Fake token',
          ${sealWith("github_connections", "token", "github-1")},
          ${sealWith("github_connections", "read_only_token", "github-1")},
          '0000', ${now})
      `);

      const logged: { level: string; details: object; message: string }[] = [];
      const logger = {
        info: (details: object, message: string) =>
          logged.push({ level: "info", details, message }),
        warn: (details: object, message: string) =>
          logged.push({ level: "warn", details, message }),
        error: (details: object, message: string) =>
          logged.push({ level: "error", details, message }),
      };
      const outcome = await resealWithCurrentKey(db, during, logger);
      expect(outcome).toEqual({ resealed: 7, unreadable: {} });
      expect(logged).toEqual([
        {
          level: "info",
          details: { resealed: 7, keyVersion: 2 },
          message: expect.stringContaining(
            "RETIRED_ENCRYPTION_KEYS can be removed",
          ) as string,
        },
      ]);

      const read = async (table: string, columnName: string, key: string) => {
        const result = await db.execute<{ value: string }>(
          sql`SELECT ${sql.identifier(columnName)} AS "value" FROM ${sql.identifier(table)} WHERE ${sql.identifier(column(table, columnName).key)} = ${key}`,
        );
        const value = result.rows[0]?.value ?? "";
        expect(
          after.decrypt(value, column(table, columnName).context(key)),
        ).toBe(`fake-${table}-${columnName}`);
      };
      await read("ai_accounts", "credential", "acct-1");
      await read("owner", "totp_secret", "1");
      await read("connections", "credentials", "conn-1");
      await read("google_sign_in", "client_secret", "1");
      await read("office_settings", "github_webhook_secret", "1");
      await read("github_connections", "token", "github-1");
      await read("github_connections", "read_only_token", "github-1");
      // A second start has nothing left to do.
      expect(await resealWithCurrentKey(db, during, logger)).toEqual({
        resealed: 0,
        unreadable: {},
      });
    },
  );
});
