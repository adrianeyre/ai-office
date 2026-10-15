import {
  connectionCredentialsContext,
  googleSealContext,
} from "@ai-office/communications";
import type { Database } from "@ai-office/db";
import {
  bodyContext,
  credentialContext,
  gatewayKeyContext,
  refreshTokenContext,
} from "@ai-office/gateway";
import {
  outboundProxyPasswordContext,
  webhookSecretContext,
} from "@ai-office/orchestrator";
import { githubConnectionSecretContext } from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";
import { sql } from "drizzle-orm";

import { totpSecretContext } from "./auth/totp.ts";

// Rotating ENCRYPTION_KEY (pen-testing G1-9). The Owner sets a new
// ENCRYPTION_KEY, with the one it replaces in RETIRED_ENCRYPTION_KEYS; when
// AI Office starts, every value sealed with a retired key is opened and
// sealed again with the new one, in place, so the retired key can then be
// removed. Values are never logged or returned: only counts are.

/**
 * A column that holds sealed values (`aio1:…`), with the context each
 * row's value is sealed with: it opens only there.
 */
export interface SealedColumn {
  readonly table: string;
  /** The row's primary key, which the context names. */
  readonly key: string;
  readonly column: string;
  readonly context: (key: string) => string;
}

/** Every column AI Office keeps a sealed value in. */
export const sealedColumns: readonly SealedColumn[] = [
  {
    table: "ai_accounts",
    key: "id",
    column: "credential",
    context: credentialContext,
  },
  {
    table: "ai_accounts",
    key: "id",
    column: "refresh_token",
    context: refreshTokenContext,
  },
  {
    table: "gateway_keys",
    key: "id",
    column: "sealed_key",
    context: gatewayKeyContext,
  },
  {
    table: "gateway_request_bodies",
    key: "request_id",
    column: "request_body",
    context: (key) => bodyContext(Number(key), "request"),
  },
  {
    table: "gateway_request_bodies",
    key: "request_id",
    column: "response_body",
    context: (key) => bodyContext(Number(key), "response"),
  },
  {
    table: "owner",
    key: "id",
    column: "totp_secret",
    context: () => totpSecretContext,
  },
  {
    table: "owner",
    key: "id",
    column: "totp_pending_secret",
    context: () => totpSecretContext,
  },
  {
    table: "office_settings",
    key: "id",
    column: "gateway_outbound_proxy_password",
    context: () => outboundProxyPasswordContext,
  },
  {
    table: "office_settings",
    key: "id",
    column: "github_webhook_secret",
    context: () => webhookSecretContext,
  },
  {
    table: "github_connections",
    key: "id",
    column: "private_key",
    context: (key) => githubConnectionSecretContext(key, "private_key"),
  },
  {
    table: "github_connections",
    key: "id",
    column: "token",
    context: (key) => githubConnectionSecretContext(key, "token"),
  },
  {
    table: "github_connections",
    key: "id",
    column: "read_only_token",
    context: (key) => githubConnectionSecretContext(key, "read_only_token"),
  },
  {
    table: "connections",
    key: "id",
    column: "credentials",
    context: connectionCredentialsContext,
  },
  {
    table: "google_sign_in",
    key: "id",
    column: "client_secret",
    context: () => googleSealContext.clientSecret,
  },
  {
    table: "google_sign_in",
    key: "id",
    column: "refresh_token",
    context: () => googleSealContext.refreshToken,
  },
  {
    table: "google_sign_in",
    key: "id",
    column: "access_token",
    context: () => googleSealContext.accessToken,
  },
];

/** A sealed value and the row it is in. */
export interface SealedValue {
  readonly key: string;
  readonly value: string;
}

/** Where sealed values are read and replaced. */
export interface SealedValueStore {
  /**
   * Up to `limit` values in `column` not sealed as key version `version`,
   * in key order, after the row `after` (from the first when undefined).
   */
  notSealedAs(
    column: SealedColumn,
    version: number,
    after: string | undefined,
    limit: number,
  ): Promise<SealedValue[]>;
  /**
   * Replaces the value in `column` of row `key` with `value`, if it is
   * still `previous`; whether it was.
   */
  replace(
    column: SealedColumn,
    key: string,
    previous: string,
    value: string,
  ): Promise<boolean>;
}

/** The sealed values in Postgres. */
export function databaseSealedValues(db: Database): SealedValueStore {
  return {
    async notSealedAs(column, version, after, limit) {
      const table = sql.identifier(column.table);
      const key = sql.identifier(column.key);
      const value = sql.identifier(column.column);
      const result = await db.execute<{ key: string; value: string }>(sql`
        SELECT ${key}::text AS "key", ${value} AS "value"
        FROM ${table}
        WHERE ${value} IS NOT NULL
          AND ${value} NOT LIKE ${`aio1:${String(version)}:%`}
          ${after === undefined ? sql.empty() : sql`AND ${key} > ${after}`}
        ORDER BY ${key}
        LIMIT ${limit}
      `);
      return result.rows;
    },
    async replace(column, key, previous, value) {
      const result = await db.execute(sql`
        UPDATE ${sql.identifier(column.table)}
        SET ${sql.identifier(column.column)} = ${value}
        WHERE ${sql.identifier(column.key)} = ${key}
          AND ${sql.identifier(column.column)} = ${previous}
      `);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

/** What a re-seal did, column by column. */
export interface ResealOutcome {
  /** Values now sealed with the current key. */
  readonly resealed: number;
  /**
   * Values no configured key opens, by `table.column`: sealed with a key
   * neither ENCRYPTION_KEY nor RETIRED_ENCRYPTION_KEYS holds. Left as they
   * are.
   */
  readonly unreadable: Readonly<Record<string, number>>;
}

/**
 * Seals again, with `encryptor`'s current key, every value in `columns`
 * sealed with another key it holds. A value changed meanwhile is left to
 * whoever changed it (sealed with the current key, as everything new is).
 */
export async function resealValues(options: {
  readonly store: SealedValueStore;
  readonly encryptor: Encryptor;
  readonly columns?: readonly SealedColumn[];
  readonly batchSize?: number;
}): Promise<ResealOutcome> {
  const { store, encryptor } = options;
  const columns = options.columns ?? sealedColumns;
  const batchSize = options.batchSize ?? 100;
  let resealed = 0;
  const unreadable: Record<string, number> = {};
  for (const column of columns) {
    let after: string | undefined;
    for (;;) {
      const batch = await store.notSealedAs(
        column,
        encryptor.currentKeyVersion,
        after,
        batchSize,
      );
      for (const { key, value } of batch) {
        const context = column.context(key);
        let plaintext: string;
        try {
          plaintext = encryptor.decrypt(value, context);
        } catch {
          const name = `${column.table}.${column.column}`;
          unreadable[name] = (unreadable[name] ?? 0) + 1;
          continue;
        }
        if (
          await store.replace(
            column,
            key,
            value,
            encryptor.encrypt(plaintext, context),
          )
        ) {
          resealed += 1;
        }
      }
      if (batch.length < batchSize) {
        break;
      }
      after = batch.at(-1)?.key;
    }
  }
  return { resealed, unreadable };
}

/** The part of the server's logger a re-seal reports to. */
export interface ResealLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/**
 * Re-seals what Postgres holds with ENCRYPTION_KEY as AI Office starts
 * beside RETIRED_ENCRYPTION_KEYS, and says when the retired keys can go.
 * A failure is logged, never fatal: every value still opens with the keys
 * configured, and the next start tries again.
 */
export async function resealWithCurrentKey(
  db: Database,
  encryptor: Encryptor,
  logger: ResealLogger,
): Promise<ResealOutcome | undefined> {
  const keyVersion = encryptor.currentKeyVersion;
  let outcome: ResealOutcome;
  try {
    outcome = await resealValues({
      store: databaseSealedValues(db),
      encryptor,
    });
  } catch (error) {
    logger.error(
      { err: error, keyVersion },
      "Sealed values were not all re-sealed with ENCRYPTION_KEY; they still open with RETIRED_ENCRYPTION_KEYS, so keep it, and the next start tries again.",
    );
    return undefined;
  }
  const { resealed, unreadable } = outcome;
  if (Object.keys(unreadable).length > 0) {
    logger.warn(
      { resealed, keyVersion, unreadable },
      "Some sealed values open with neither ENCRYPTION_KEY nor RETIRED_ENCRYPTION_KEYS, so they were left as they are: they were sealed with a key AI Office is no longer given. Add it to RETIRED_ENCRYPTION_KEYS to keep them.",
    );
  } else {
    logger.info(
      { resealed, keyVersion },
      "Every sealed value is sealed with ENCRYPTION_KEY: RETIRED_ENCRYPTION_KEYS can be removed.",
    );
  }
  return outcome;
}
