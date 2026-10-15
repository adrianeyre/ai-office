import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Facts about the database itself, as key/value pairs. The schema (src/schema-extras.sql)
// writes `application = ai-office`, so a connection can tell an AI Office
// database from any other. Domain tables arrive with the issues that need them.
export const schemaMeta = pgTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// The Owner's AI Accounts (PRD FR-35, FR-36), which the AI Gateway serves
// model calls from. The credential (an API key, an OAuth token, or a cloud
// platform's credentials as JSON: AWS Bedrock's IAM keys or profile, a
// Google service account's key) is only ever stored sealed with ENCRYPTION_KEY (`aio1:…`), with the context
// `ai_account.credential:<id>`, so it cannot be moved to another row. It is
// never sent back to the Owner. The Gateway uses the unpaused account with
// the lowest priority, the oldest first on a tie.
export const aiAccounts = pgTable(
  "ai_accounts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    /** `api_key`, `oauth`, `bedrock` or `vertex`. */
    accountType: text("account_type").notNull(),
    /** Which AI Provider's Models it serves, such as `Claude`. */
    aiProvider: text("ai_provider").notNull(),
    /** Sealed; never in clear. An OAuth account's access token. */
    credential: text("credential").notNull(),
    /** In place of the AI Provider's own API; null for that. */
    endpointUrl: text("endpoint_url"),
    // A cloud platform's account (FR-35): its region (an AWS region, or a
    // Vertex AI location), and a Vertex AI account's Google Cloud project.
    // Null for every other account.
    region: text("region"),
    projectId: text("project_id"),
    /** 1 is used first. */
    priority: integer("priority").notNull(),
    paused: boolean("paused").notNull().default(false),
    // An OAuth account's login (FR-36): its refresh token, sealed with
    // ENCRYPTION_KEY (context `ai_account.refresh_token:<id>`), when its
    // access token expires, and whether a refresh was refused, so the
    // Owner must sign in again. Null and false for a key-based account.
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    reauthenticationNeeded: boolean("reauthentication_needed")
      .notNull()
      .default(false),
    // Why the AI Gateway holds the account back (FR-38, FR-39), and until
    // when: `rate_limited` or `overloaded` until the AI Provider's reset,
    // `circuit_open` after failing too often in a row, or `extra_usage`
    // when it was served past its plan's limit with extra usage off
    // (FR-41). Both null while it is not held back.
    limitReason: text("limit_reason"),
    limitedUntil: timestamp("limited_until", { withTimezone: true }),
    // Its usage windows as its AI Provider last reported them (FR-36): the
    // share used of the five-hour and the weekly window, in percent, and
    // when each resets; null for windows it does not report. And the share
    // of each the Owner pauses it at, null for none.
    fiveHourUtilization: doublePrecision("five_hour_utilization"),
    fiveHourResetsAt: timestamp("five_hour_resets_at", {
      withTimezone: true,
    }),
    weeklyUtilization: doublePrecision("weekly_utilization"),
    weeklyResetsAt: timestamp("weekly_resets_at", { withTimezone: true }),
    fiveHourPauseThreshold: integer("five_hour_pause_threshold"),
    weeklyPauseThreshold: integer("weekly_pause_threshold"),
    // The Model it is always sent, whatever was asked for (FR-41); null
    // for the Model asked for. And whether it goes on past its plan's
    // limits on extra usage, which only a Claude subscription offers.
    forcedModel: text("forced_model"),
    extraUsage: boolean("extra_usage").notNull().default(false),
    // An API key's per-minute rate limits as its latest answer reported
    // them in its headers (requests, tokens, input and output tokens:
    // each `{ limit, remaining, resetsAt }`, and `observedAt`); null for
    // an account whose AI Provider reports none. And a prepaid account's
    // credit as its AI Provider's balance endpoint last gave it
    // (`{ currency, remaining, used, limit, observedAt }`); null where
    // none can be read. Both shown, never acted on.
    rateLimits: jsonb("rate_limits"),
    balance: jsonb("balance"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("ai_accounts_order_idx").on(table.priority, table.createdAt),
    check(
      "ai_accounts_limit_reason",
      sql`${table.limitReason} IS NULL OR ${table.limitReason} IN ('rate_limited', 'overloaded', 'circuit_open', 'extra_usage')`,
    ),
    check(
      "ai_accounts_limit",
      sql`(${table.limitReason} IS NULL) = (${table.limitedUntil} IS NULL)`,
    ),
    check(
      "ai_accounts_usage_windows",
      sql`(${table.fiveHourUtilization} IS NULL) = (${table.fiveHourResetsAt} IS NULL) AND (${table.weeklyUtilization} IS NULL) = (${table.weeklyResetsAt} IS NULL)`,
    ),
    check(
      "ai_accounts_pause_thresholds",
      sql`(${table.fiveHourPauseThreshold} IS NULL OR ${table.fiveHourPauseThreshold} BETWEEN 1 AND 100) AND (${table.weeklyPauseThreshold} IS NULL OR ${table.weeklyPauseThreshold} BETWEEN 1 AND 100)`,
    ),
    check(
      "ai_accounts_account_type",
      sql`${table.accountType} IN ('api_key', 'oauth', 'bedrock', 'vertex', 'endpoint')`,
    ),
    check(
      "ai_accounts_cloud",
      sql`(${table.accountType} IN ('bedrock', 'vertex')) = (${table.region} IS NOT NULL) AND (${table.accountType} = 'vertex') = (${table.projectId} IS NOT NULL)`,
    ),
    check(
      "ai_accounts_credential_sealed",
      sql`${table.credential} LIKE 'aio1:%'`,
    ),
    check("ai_accounts_priority", sql`${table.priority} BETWEEN 1 AND 100`),
    check(
      "ai_accounts_refresh_token_sealed",
      sql`${table.refreshToken} IS NULL OR ${table.refreshToken} LIKE 'aio1:%'`,
    ),
    check(
      "ai_accounts_extra_usage",
      sql`NOT ${table.extraUsage} OR (${table.aiProvider} = 'Claude' AND ${table.accountType} = 'oauth')`,
    ),
    check(
      "ai_accounts_oauth_login",
      sql`(${table.accountType} = 'oauth') = (${table.refreshToken} IS NOT NULL AND ${table.tokenExpiresAt} IS NOT NULL)`,
    ),
  ],
);

// AI Accounts' usage history (PRD FR-36, FR-43): each change of a usage
// window an AI Provider reports (the five-hour or the weekly one), with
// the share used, in percent, and when it resets. A reading is kept when
// it differs from the last by a whole percent or a new reset time.
export const aiAccountUsage = pgTable(
  "ai_account_usage",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    aiAccountId: text("ai_account_id")
      .notNull()
      .references(() => aiAccounts.id, { onDelete: "cascade" }),
    /** `five_hour` or `weekly`. */
    window: text("window").notNull(),
    utilization: doublePrecision("utilization").notNull(),
    resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("ai_account_usage_account_idx").on(
      table.aiAccountId,
      table.observedAt,
    ),
    check(
      "ai_account_usage_window",
      sql`${table.window} IN ('five_hour', 'weekly')`,
    ),
    check("ai_account_usage_utilization", sql`${table.utilization} >= 0`),
  ],
);

// Gateway Keys (PRD FR-46, ADR 0001): what the AI Gateway's callers present
// to say who they are, so each request is attributed (FR-42). Each Agent
// has one key in use, made with it; the Owner makes named keys for their
// own tools. Only a key's SHA-256 is kept for checking it. An Agent's key
// is also kept sealed with ENCRYPTION_KEY (context `gateway_key:<id>`),
// because its sandboxes are given it; an Owner tool's never is, so it is
// shown once only. A revoked key stays, for the requests it made.
export const gatewayKeys = pgTable(
  "gateway_keys",
  {
    id: text("id").primaryKey(),
    /** `agent`, `communications` (the Communications Agent's) or `owner_tool`. */
    kind: text("kind").notNull(),
    /** The Owner tool's name, or the Agent's when the key was made. */
    name: text("name").notNull(),
    /** The Agent it belongs to; null for an Owner tool's. */
    agentId: text("agent_id").references(() => agents.id),
    /** That Agent's Floor. */
    floorId: text("floor_id").references(() => floors.id),
    /** The SHA-256 of the key, hex-encoded. */
    keyHash: text("key_hash").notNull().unique(),
    /** The key's first characters, to tell keys apart. */
    hint: text("hint").notNull(),
    /** An Agent's key (the Communications Agent's too), sealed; null for an Owner tool's. */
    sealedKey: text("sealed_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Who uses the key: forename, surname, nickname and time zone, as
     * `ownerProfileSchema` (packages/shared) checks it; null until set.
     */
    profile: jsonb("profile"),
    /**
     * What the key may do: `proxy`, call models through the AI Gateway
     * only; or `proxy_and_ui`, sign in to the web app too (an Owner
     * tool's key only).
     */
    access: text("access").notNull().default("proxy"),
    /** False while the Owner has it disabled: refused, but kept. */
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [
    check(
      "gateway_keys_access",
      sql`${table.access} IN ('proxy', 'proxy_and_ui') AND (${table.access} = 'proxy' OR ${table.kind} = 'owner_tool')`,
    ),
    check(
      "gateway_keys_enabled",
      sql`${table.enabled} OR ${table.kind} = 'owner_tool'`,
    ),
    uniqueIndex("gateway_keys_one_per_agent")
      .on(table.agentId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("gateway_keys_owner_tool_name")
      .on(table.name)
      .where(sql`${table.kind} = 'owner_tool' AND ${table.revokedAt} IS NULL`),
    // The Communications Agent has one key in use at a time.
    uniqueIndex("gateway_keys_one_communications")
      .on(table.kind)
      .where(
        sql`${table.kind} = 'communications' AND ${table.revokedAt} IS NULL`,
      ),
    // So has the Terminal.
    uniqueIndex("gateway_keys_one_terminal")
      .on(table.kind)
      .where(sql`${table.kind} = 'terminal' AND ${table.revokedAt} IS NULL`),
    check(
      "gateway_keys_kind",
      sql`${table.kind} IN ('agent', 'communications', 'owner_tool', 'terminal')`,
    ),
    check(
      "gateway_keys_owner",
      sql`(${table.kind} = 'agent') = (${table.agentId} IS NOT NULL AND ${table.floorId} IS NOT NULL AND ${table.sealedKey} IS NOT NULL)`,
    ),
    check(
      "gateway_keys_owner_tool",
      sql`${table.kind} = 'agent' OR (${table.agentId} IS NULL AND ${table.floorId} IS NULL AND (${table.sealedKey} IS NULL) = (${table.kind} = 'owner_tool'))`,
    ),
    check(
      "gateway_keys_sealed",
      sql`${table.sealedKey} IS NULL OR ${table.sealedKey} LIKE 'aio1:%'`,
    ),
  ],
);

// Model prices the AI Gateway estimates costs from (PRD FR-43), in US
// dollars per million tokens, beside the pricing table in the repository
// (`packages/gateway/pricing.json`). A `published` row is a price an AI
// Provider publishes, refreshed automatically; an `override` row is the
// Owner's, set in the admin, and wins over both.
export const modelPrices = pgTable(
  "model_prices",
  {
    model: text("model").notNull(),
    /** `published` or `override`. */
    source: text("source").notNull(),
    input: doublePrecision("input").notNull(),
    output: doublePrecision("output").notNull(),
    cacheWrite: doublePrecision("cache_write").notNull(),
    cacheRead: doublePrecision("cache_read").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.model, table.source] }),
    check(
      "model_prices_source",
      sql`${table.source} IN ('published', 'override')`,
    ),
    check(
      "model_prices_not_negative",
      sql`${table.input} >= 0 AND ${table.output} >= 0 AND ${table.cacheWrite} >= 0 AND ${table.cacheRead} >= 0`,
    ),
  ],
);

// The AI Gateway's Combos (PRD FR-40): named, ordered fallback chains of
// (AI Account, Model) slots, each assigned to model families (as
// `modelFamilyOf` names them). `slots` is a JSON array of
// `{aiAccountId, model}`, in the order they are tried. A slot whose AI
// Account was deleted stays, and is skipped. No two enabled Combos share a
// model family; the AI Gateway checks that before it stores one.
export const gatewayCombos = pgTable(
  "gateway_combos",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    modelFamilies: text("model_families").array().notNull(),
    slots: jsonb("slots").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "gateway_combos_families",
      sql`cardinality(${table.modelFamilies}) > 0`,
    ),
    check(
      "gateway_combos_slots",
      sql`jsonb_typeof(${table.slots}) = 'array' AND jsonb_array_length(${table.slots}) > 0`,
    ),
  ],
);

// The AI Gateway's model mappings and aliases (PRD FR-41): a name callers
// ask for (`from`), sent as another Model (`to`). With no AI Provider and
// account type it is an alias, for every request; with both, it applies
// when an AI Account of that kind serves. A name is mapped once per kind,
// and once as an alias.
export const gatewayModelMappings = pgTable(
  "gateway_model_mappings",
  {
    id: text("id").primaryKey(),
    from: text("from_model").notNull(),
    to: text("to_model").notNull(),
    aiProvider: text("ai_provider"),
    accountType: text("account_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("gateway_model_mappings_from_idx").on(
      sql`coalesce(${table.aiProvider}, '')`,
      sql`coalesce(${table.accountType}, '')`,
      table.from,
    ),
    check(
      "gateway_model_mappings_kind",
      sql`(${table.aiProvider} IS NULL) = (${table.accountType} IS NULL)`,
    ),
    check(
      "gateway_model_mappings_account_type",
      sql`${table.accountType} IS NULL OR ${table.accountType} IN ('api_key', 'oauth', 'bedrock', 'vertex', 'endpoint')`,
    ),
    check("gateway_model_mappings_to", sql`${table.from} <> ${table.to}`),
  ],
);

// The AI Gateway's live model catalogue (PRD FR-41): the Models each kind
// of AI Account (an AI Provider and an account type) lists, as its AI
// Provider's models endpoint last answered. A kind's rows are replaced each
// time its list is fetched; one that could not be fetched keeps its last.
export const modelCatalogue = pgTable(
  "model_catalogue",
  {
    aiProvider: text("ai_provider").notNull(),
    accountType: text("account_type").notNull(),
    model: text("model").notNull(),
    /** How the AI Provider names it, when it says. */
    displayName: text("display_name"),
    /** Its context window in tokens, when the AI Provider says (FR-84). */
    contextWindow: integer("context_window"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.aiProvider, table.accountType, table.model],
    }),
    check(
      "model_catalogue_account_type",
      sql`${table.accountType} IN ('api_key', 'oauth', 'bedrock', 'vertex', 'endpoint')`,
    ),
    check(
      "model_catalogue_context_window",
      sql`${table.contextWindow} IS NULL OR ${table.contextWindow} > 0`,
    ),
  ],
);

// The AI Providers' settings in the office admin (PRD FR-15): each one's
// default Model, chosen by the Owner from the model catalogue. An AI
// Provider without a row has no default yet (Claude's starts as
// `claude-opus-5-5`), and no Agent can use it until it has one.
export const aiProviderSettings = pgTable(
  "ai_provider_settings",
  {
    aiProvider: text("ai_provider").primaryKey(),
    defaultModel: text("default_model").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "ai_provider_settings_default_model",
      sql`length(${table.defaultModel}) BETWEEN 1 AND 200`,
    ),
  ],
);

// One row per request through the AI Gateway (PRD FR-44), written once the
// response has finished. Token counts are null when the response carried no
// usage (an error, or `count_tokens`, which uses none).
export const gatewayRequests = pgTable(
  "gateway_requests",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /**
     * The name of the AI Account that served it, when it did; null when
     * none was available. Kept when the account is renamed or deleted.
     */
    account: text("account"),
    /** That AI Account, while it exists. */
    aiAccountId: text("ai_account_id").references(() => aiAccounts.id, {
      onDelete: "set null",
    }),
    /** `messages` or `count_tokens`. */
    endpoint: text("endpoint").notNull(),
    /** The Model the caller asked for. */
    model: text("model"),
    /** Whether the response was a server-sent event stream. */
    streamed: boolean("streamed").notNull(),
    status: integer("status").notNull(),
    /** From the request arriving to the response's last byte. */
    latencyMs: integer("latency_ms").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    /** The AI Provider's own ID for the request, when it sent one. */
    upstreamRequestId: text("upstream_request_id"),
    // Who made it (FR-42), by the Gateway Key it presented.
    gatewayKeyId: text("gateway_key_id").references(() => gatewayKeys.id),
    /** The Agent that made it, and its Floor; null for an Owner tool. */
    agentId: text("agent_id"),
    floorId: text("floor_id"),
    /** The Owner tool's name, for a request one of them made. */
    ownerTool: text("owner_tool"),
    /**
     * The issue and pull request it was for, on its Floor's repository,
     * when its caller said (a sandbox's agent tool always does).
     */
    issue: integer("issue"),
    pullRequest: integer("pull_request"),
    /**
     * The Agent session it belongs to, when its caller named one (a
     * sandbox's run): Context Usage is measured per session (FR-84).
     */
    session: text("session"),
    /**
     * Its estimated cost in US dollars (FR-43), from its Model's price
     * when it was made; null when the Model has no price or nothing was
     * used.
     */
    estimatedCostUsd: doublePrecision("estimated_cost_usd"),
    /** From the request arriving to the AI Provider's answer starting. */
    timeToFirstByteMs: integer("time_to_first_byte_ms"),
    /**
     * The caller's headers and those of the answer it got, redacted: no
     * Gateway Key, AI Account key or cookie.
     */
    requestHeaders: jsonb("request_headers"),
    responseHeaders: jsonb("response_headers"),
    /**
     * Whether the AI Gateway sent it itself, to keep the prompt cache of
     * the Agent it is attributed to warm (FR-39).
     */
    keepAlive: boolean("keep_alive").notNull().default(false),
  },
  (table) => [
    index("gateway_requests_started_at_idx").on(table.startedAt),
    index("gateway_requests_agent_id_idx").on(table.agentId, table.id),
    index("gateway_requests_floor_id_idx").on(table.floorId, table.id),
    index("gateway_requests_floor_issue_idx").on(
      table.floorId,
      table.issue,
      table.id,
    ),
  ],
);

// Request and response bodies of Gateway requests (PRD FR-44, §7), kept
// only while the Owner has body storage on. Each is sealed with
// ENCRYPTION_KEY (context `gateway_request.body:<id>:request` or
// `…:response`), so it opens only for its own request. A body longer than
// the Gateway keeps is cut, and `truncated` says so.
export const gatewayRequestBodies = pgTable(
  "gateway_request_bodies",
  {
    requestId: bigint("request_id", { mode: "number" })
      .primaryKey()
      .references(() => gatewayRequests.id, { onDelete: "cascade" }),
    requestBody: text("request_body").notNull(),
    responseBody: text("response_body").notNull(),
    truncated: boolean("truncated").notNull().default(false),
  },
  (table) => [
    check(
      "gateway_request_bodies_sealed",
      sql`${table.requestBody} LIKE 'aio1:%' AND ${table.responseBody} LIKE 'aio1:%'`,
    ),
  ],
);

// What Gateway requests used, a day at a time (PRD §7, FR-31, FR-43): when
// retention or the storage clean-up deletes requests' records, what they
// used is added here first, per UTC day, AI Account, Model and caller, so
// Token Caps and Analytics still count it. A day's requests may be partly
// here and partly still in `gateway_requests`; both add the two.
export const gatewayUsageDays = pgTable(
  "gateway_usage_days",
  {
    /** The UTC day, as its first instant. */
    day: timestamp("day", { withTimezone: true }).notNull(),
    // What served them and who made them, as `gateway_requests` names them
    // (FR-42).
    account: text("account"),
    model: text("model"),
    floorId: text("floor_id"),
    agentId: text("agent_id"),
    issue: integer("issue"),
    ownerTool: text("owner_tool"),
    requests: bigint("requests", { mode: "number" }).notNull(),
    /** Answered with a status of 400 or more. */
    errors: bigint("errors", { mode: "number" }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", {
      mode: "number",
    }).notNull(),
    estimatedCostUsd: doublePrecision("estimated_cost_usd").notNull(),
    /** Their latencies, added up. */
    latencyMs: bigint("latency_ms", { mode: "number" }).notNull(),
    /** Those that were prompt-cache keep-alives (FR-39), and their cost. */
    keepAliveRequests: bigint("keep_alive_requests", { mode: "number" })
      .notNull()
      .default(0),
    keepAliveCostUsd: doublePrecision("keep_alive_cost_usd")
      .notNull()
      .default(0),
  },
  (table) => [
    unique("gateway_usage_days_caller")
      .on(
        table.day,
        table.account,
        table.model,
        table.floorId,
        table.agentId,
        table.issue,
        table.ownerTool,
      )
      .nullsNotDistinct(),
    check(
      "gateway_usage_days_day",
      sql`${table.day} = date_trunc('day', ${table.day}, 'UTC')`,
    ),
  ],
);

// The Owner (PRD §6.1): there is exactly one, so this table holds at most
// one row, with `id` 1. The row is written once, by the first-run setup
// screen; until it exists, AI Office has no password and asks for one.
//
// The optional TOTP second factor (PRD FR-3) lives here too. Its secret is
// only ever stored sealed with ENCRYPTION_KEY (`aio1:…`), never in clear.
export const owner = pgTable(
  "owner",
  {
    id: integer("id").primaryKey().default(1),
    /** An Argon2id hash in PHC string form; never the password itself. */
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The TOTP secret, sealed; null while TOTP is off. */
    totpSecret: text("totp_secret"),
    /** A sealed secret shown to the Owner but not yet confirmed with a code. */
    totpPendingSecret: text("totp_pending_secret"),
    /** The last TOTP time step used, so a code is accepted only once. */
    totpLastTimeStep: bigint("totp_last_time_step", { mode: "number" }),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  },
  (table) => [
    check("owner_single_row", sql`${table.id} = 1`),
    check(
      "owner_password_hash_argon2id",
      sql`${table.passwordHash} LIKE '$argon2id$%'`,
    ),
    check(
      "owner_totp_secret_sealed",
      sql`${table.totpSecret} IS NULL OR ${table.totpSecret} LIKE 'aio1:%'`,
    ),
    check(
      "owner_totp_pending_secret_sealed",
      sql`${table.totpPendingSecret} IS NULL OR ${table.totpPendingSecret} LIKE 'aio1:%'`,
    ),
    check(
      "owner_totp_enabled",
      sql`(${table.totpSecret} IS NULL) = (${table.totpEnabledAt} IS NULL)`,
    ),
  ],
);

// The Owner's TOTP recovery codes (PRD FR-3): ten are made when TOTP is
// turned on and shown once. Only each code's SHA-256 is stored. A code
// works once: using it sets `used_at`. Turning TOTP off deletes them all.
export const recoveryCodes = pgTable("recovery_codes", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  /** The SHA-256 of the normalised code, hex-encoded. */
  codeHash: text("code_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

// The Owner's passwords beyond the first (in `owner`): one each for the
// people who share the Owner's access to the web app. Each has a name, the
// nickname and time zone the lobby's receptionist greets them by, and an
// Argon2id hash, never the password. Removing one ends its sessions.
export const ownerPasswords = pgTable(
  "owner_passwords",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    nickname: text("nickname").notNull().default(""),
    timeZone: text("time_zone").notNull().default("Europe/London"),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** When it last signed in; null if never. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "owner_passwords_password_hash_argon2id",
      sql`${table.passwordHash} LIKE '$argon2id$%'`,
    ),
  ],
);

// The Owner's signed-in sessions (PRD FR-2), one row per browser sign-in.
// The cookie holds a random token; only its SHA-256 is stored here, so the
// table alone cannot be used to sign in. A session ends at `expires_at`
// (7 days after sign-in), at sign-out, or when every session is signed out.
export const sessions = pgTable(
  "sessions",
  {
    /** The SHA-256 of the session token, hex-encoded. */
    id: text("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * The API key that signed in, when one with UI access did rather than
     * the Owner's password; null for a password sign-in.
     */
    gatewayKeyId: text("gateway_key_id").references(() => gatewayKeys.id),
    /**
     * Which of the Owner's further passwords signed in; null for the first
     * (in `owner`) or an API key.
     */
    passwordId: text("password_id").references(() => ownerPasswords.id, {
      onDelete: "cascade",
    }),
    /**
     * When it was last used, to the minute; null if not since sign-in. One
     * unused for a day is refused (PRD FR-2, A1-8).
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [index("sessions_expires_at_idx").on(table.expiresAt)],
);

// Every sign-in attempt that was checked (PRD FR-4): a wrong password or a
// successful sign-in, never the password itself. Attempts refused by the
// rate limit before the password was checked are not recorded. The Activity
// Feed will show these.
export const signInEvents = pgTable(
  "sign_in_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** `succeeded` or `failed`. */
    outcome: text("outcome").notNull(),
    /** The client's address, as the server saw it (see TRUST_PROXY). */
    ip: text("ip").notNull(),
    /** The client's User-Agent header, cut to 512 characters. */
    userAgent: text("user_agent"),
    /**
     * The second factor checked: `totp` or `recovery_code`; null for a
     * password check.
     */
    secondFactor: text("second_factor"),
  },
  (table) => [
    index("sign_in_events_occurred_at_idx").on(table.occurredAt),
    check(
      "sign_in_events_outcome",
      sql`${table.outcome} IN ('succeeded', 'failed')`,
    ),
    check(
      "sign_in_events_second_factor",
      sql`${table.secondFactor} IN ('totp', 'recovery_code')`,
    ),
  ],
);

// The event log (PRD §8, FR-52): every event AI Office emits, in the order
// it was published, as `@ai-office/events` defines them. It is append-only:
// a trigger (src/schema-extras.sql) refuses UPDATE and DELETE, except deleting
// events before a cutoff, as retention and the storage clean-up do.
// `id` only grows, and the event bus publishes one event at a time, so ids
// commit in order and a reader can resume after the last id it saw.
// Payloads are redacted before they are stored.
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The event's type, such as `agent.state_changed`. */
    type: text("type").notNull(),
    /** The version of that type's schema the payload follows. */
    version: integer("version").notNull(),
    /** The Floor the event belongs to, if any (for filtering). */
    floorId: text("floor_id"),
    /** Every Agent the event concerns (a Handoff has two). */
    agentIds: text("agent_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** The GitHub issue number the event concerns, if any. */
    issue: integer("issue"),
    /** The whole event, redacted. */
    payload: jsonb("payload").notNull(),
  },
  (table) => [
    index("events_type_idx").on(table.type, table.id),
    // Retention deletes the oldest (PRD §7).
    index("events_occurred_at_idx").on(table.occurredAt),
    index("events_floor_id_idx").on(table.floorId, table.id),
    index("events_issue_idx").on(table.floorId, table.issue, table.id),
    index("events_agent_ids_idx").using("gin", table.agentIds),
    check("events_version_positive", sql`${table.version} >= 1`),
  ],
);

// The Floors (PRD §6.2): each is exactly one GitHub repository the App is
// installed on, and each repository is at most one Floor, archived or not
// (FR-6). A Floor is matched to its repository by GitHub's id, which
// survives a rename; `repository` is its `owner/name` when it was added.
// Archiving (FR-9) stops intake and hides the Floor, keeping its row and
// its history.
export const floors = pgTable(
  "floors",
  {
    /** A slug from the repository's name, such as `web-shop`. */
    id: text("id").primaryKey(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" })
      .notNull()
      .unique(),
    /** `owner/name` on GitHub. */
    repository: text("repository").notNull(),
    // The Floor's settings (FR-7).
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    /** Run in the sandbox before work starts; empty for none. */
    setupCommand: text("setup_command").notNull().default(""),
    /** Run in the sandbox to test the work; empty for none. */
    testCommand: text("test_command").notNull().default(""),
    /** `send_to_me` (the default) or `auto_merge` (FR-29). */
    mergePolicy: text("merge_policy").notNull().default("send_to_me"),
    roundCap: integer("round_cap").notNull().default(3),
    /** Token Cap overrides (FR-32); null uses the office's. */
    dailyTokenCap: bigint("daily_token_cap", { mode: "number" }),
    monthlyTokenCap: bigint("monthly_token_cap", { mode: "number" }),
    /** A lower limit on running sandboxes than the office's (FR-22). */
    concurrencyLimit: integer("concurrency_limit"),
    /** Higher first in the work queue (FR-22), from 0 to 10. */
    priority: integer("priority").notNull().default(0),
    /** The reviewer Agents every Review Loop round needs (FR-27). */
    requiredReviewerAgentIds: text("required_reviewer_agent_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Whether work waits for the Owner to approve the Plan (FR-25). */
    planApproval: boolean("plan_approval").notNull().default(true),
    /**
     * The most Agents it may have besides its Manager, the Owner's and
     * Contractors alike (FR-10); null for no limit.
     */
    mostAgents: integer("most_agents").default(8),
    /**
     * Whether the Manager turns the Owner's chat requests into Batches,
     * filing their issues and adding Contractors (FR-24, ADR 0004).
     */
    spinOffFromChat: boolean("spin_off_from_chat").notNull().default(true),
    /**
     * Whether it gives a Status update every hour while its Agents work
     * (FR-23a).
     */
    hourlyStatusUpdates: boolean("hourly_status_updates")
      .notNull()
      .default(true),
    /**
     * The Context Usage, in percent, at which a sandbox Agent makes a
     * Fresh Start (FR-86); an Agent's own overrides it.
     */
    freshStartThreshold: integer("fresh_start_threshold").notNull().default(85),
    /** Who the Floor's commits are by (FR-68); null uses the office's. */
    gitName: text("git_name"),
    gitEmail: text("git_email"),
    /**
     * The Floor Template it started from, as it was then (FR-97): shown,
     * never read again. Floors from before Floor Templates are Development.
     */
    templateId: text("template_id").notNull().default("development"),
    templateName: text("template_name").notNull().default("Development"),
    /**
     * The 3D theme it is dressed in (FR-57): its template's when it was
     * added, so it is never read from the template again. Decoration only.
     */
    theme: text("theme").notNull().default("office"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    check("floors_id_slug", sql`${table.id} ~ '^[a-z0-9][a-z0-9-]*$'`),
    check(
      "floors_merge_policy",
      sql`${table.mergePolicy} IN ('send_to_me', 'auto_merge')`,
    ),
    check("floors_round_cap", sql`${table.roundCap} >= 1`),
    check(
      "floors_token_caps",
      sql`(${table.dailyTokenCap} IS NULL OR ${table.dailyTokenCap} > 0) AND (${table.monthlyTokenCap} IS NULL OR ${table.monthlyTokenCap} > 0)`,
    ),
    check(
      "floors_concurrency_limit",
      sql`${table.concurrencyLimit} IS NULL OR ${table.concurrencyLimit} >= 1`,
    ),
    check(
      "floors_most_agents",
      sql`${table.mostAgents} IS NULL OR ${table.mostAgents} >= 1`,
    ),
    check("floors_priority", sql`${table.priority} BETWEEN 0 AND 10`),
    check(
      "floors_theme",
      sql`${table.theme} IN ('office', 'stockroom', 'studio', 'editorial', 'library', 'atelier', 'observatory', 'data-centre', 'device-lab')`,
    ),
    check(
      "floors_fresh_start_threshold",
      sql`${table.freshStartThreshold} BETWEEN 10 AND 100`,
    ),
    check(
      "floors_git_identity",
      sql`(${table.gitName} IS NULL) = (${table.gitEmail} IS NULL)`,
    ),
  ],
);

// The office Role library (PRD FR-98, ADR 0003): Roles are data, each on
// one of the four fixed Stages. An Agent fills a Role from here; editing a
// Role changes every Agent with it. The schema (src/schema-extras.sql) seeds the
// built-in Roles (coder, reviewer, QA, docs and designer), whose ids are
// the Roles' ids from before Roles were data. The Manager and the
// Communications Agent are built in, not library Roles.
export const roles = pgTable(
  "roles",
  {
    /** Lowercase words joined by hyphens, such as `coder`; never `manager`. */
    id: text("id").primaryKey(),
    /** As people read it, such as `QA`; unique in the library. */
    name: text("name").notNull(),
    /** `work`, `review`, `qa` or `docs`. */
    stage: text("stage").notNull(),
    /** One line the Manager routes work between work Roles by. */
    description: text("description").notNull(),
    /** What its Agents are told about their work, in their Stage's prompt. */
    instructions: text("instructions").notNull(),
    /** The names of the Skills its Agents are given. */
    skills: jsonb("skills").notNull().default([]),
    /** What sits on its desks in the Office: decoration only. */
    deskDressing: text("desk_dressing").notNull(),
    /** The AI Provider a new Agent in it starts with; null for the office default. */
    aiProvider: text("ai_provider"),
    /** The Model that Agent overrides its AI Provider's default with; null for none. */
    model: text("model"),
    /**
     * A one-off Role's Floor (ADR 0004): the Manager wrote it for a
     * Contractor there, and it is in no library. Null for the library's.
     */
    floorId: text("floor_id").references(() => floors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // A one-off Role's name may be a library Role's: it is in no library.
    uniqueIndex("roles_name_unique")
      .on(table.name)
      .where(sql`${table.floorId} IS NULL`),
    // A one-off Role is always in the work Stage.
    check(
      "roles_one_off_stage",
      sql`${table.floorId} IS NULL OR ${table.stage} = 'work'`,
    ),
    check(
      "roles_id",
      sql`${table.id} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${table.id}) <= 40 AND ${table.id} <> 'manager'`,
    ),
    check(
      "roles_stage",
      sql`${table.stage} IN ('work', 'review', 'qa', 'docs')`,
    ),
    check(
      "roles_desk_dressing",
      sql`${table.deskDressing} IN ('monitor', 'dual-monitors', 'printouts', 'test-devices', 'books', 'notebooks', 'product-samples')`,
    ),
    check(
      "roles_model",
      sql`${table.model} IS NULL OR ${table.aiProvider} IS NOT NULL`,
    ),
  ],
);

// The Agents (PRD §6.3): each works on one Floor in one Role (FR-11). A
// Floor has exactly one Manager: a new Floor is created with its Manager,
// and this table refuses a second one (`agents_one_manager_per_floor`).
// Every other Agent that is not removed fills a Role in the Role library
// (`role_id`), so a Role is deleted only once no such Agent fills it.
// Names are unique on a Floor.
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    name: text("name").notNull(),
    /** `manager`, or the id of its Role in the library, such as `coder`. */
    role: text("role").notNull(),
    /**
     * Its library Role: `role`, but null for the Manager, which is built
     * in, and once it is removed, so its Role can be deleted.
     */
    roleId: text("role_id")
      .generatedAlwaysAs(
        sql`CASE WHEN removed_at IS NULL THEN NULLIF(role, 'manager') END`,
      )
      .references(() => roles.id),
    /** Such as `Claude`; more come as the AI Gateway supports them. */
    aiProvider: text("ai_provider").notNull(),
    /** Its own Model; null uses its AI Provider's default. */
    modelOverride: text("model_override"),
    /** Its effort or reasoning level; null uses its AI Provider's default. */
    effort: text("effort"),
    extraInstructions: text("extra_instructions").notNull().default(""),
    /** False while the Agent is paused. */
    enabled: boolean("enabled").notNull().default(true),
    /** How it looks (FR-13), as `@ai-office/shared` defines an Avatar. */
    avatar: jsonb("avatar").notNull(),
    /** Token Cap overrides (FR-32); null uses the Floor's. */
    dailyTokenCap: bigint("daily_token_cap", { mode: "number" }),
    monthlyTokenCap: bigint("monthly_token_cap", { mode: "number" }),
    /**
     * The Context Usage, in percent, at which it makes a Fresh Start
     * (FR-86); null uses its Floor's.
     */
    freshStartThreshold: integer("fresh_start_threshold"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /**
     * When the Owner removed it while it was in the middle of a task
     * (FR-10): it takes no new work, finishes that task, then is removed.
     */
    leavingAt: timestamp("leaving_at", { withTimezone: true }),
    /**
     * When it was removed from its Floor. Its row is kept, for the work,
     * Gateway Keys and requests that name it.
     */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    /**
     * What a Contractor does (ADR 0004): `work` or `research`; null for an
     * ordinary Agent, as a Contractor the Owner kept on the team becomes.
     */
    contractorKind: text("contractor_kind"),
    /** The Batch a `work` Contractor was added for. */
    contractorBatchId: bigint("contractor_batch_id", {
      mode: "number",
    }).references((): AnyPgColumn => batches.id),
  },
  (table) => [
    check(
      "agents_contractor_kind",
      sql`${table.contractorKind} IS NULL OR ${table.contractorKind} IN ('work', 'research')`,
    ),
    check(
      "agents_contractor_batch",
      sql`${table.contractorBatchId} IS NULL OR ${table.contractorKind} = 'work'`,
    ),
    // A removed Agent's name is free again.
    uniqueIndex("agents_floor_name_unique")
      .on(table.floorId, table.name)
      .where(sql`${table.removedAt} IS NULL`),
    uniqueIndex("agents_one_manager_per_floor")
      .on(table.floorId)
      .where(sql`${table.role} = 'manager'`),
    check(
      "agents_token_caps",
      sql`(${table.dailyTokenCap} IS NULL OR ${table.dailyTokenCap} > 0) AND (${table.monthlyTokenCap} IS NULL OR ${table.monthlyTokenCap} > 0)`,
    ),
    check(
      "agents_fresh_start_threshold",
      sql`${table.freshStartThreshold} IS NULL OR ${table.freshStartThreshold} BETWEEN 10 AND 100`,
    ),
  ],
);

// Office-wide settings (PRD FR-65): one row, with `id` 1, holding what the
// office admin has set. Each setting is null until it is set, and its
// default applies; settings arrive with the issues that need them.
export const officeSettings = pgTable(
  "office_settings",
  {
    id: integer("id").primaryKey().default(1),
    /** Who agent commits are by (FR-68); null for the default, the Owner. */
    gitName: text("git_name"),
    gitEmail: text("git_email"),
    /**
     * The Owner's GitHub login (FR-8): only their issues, or issues they
     * labelled themselves, are taken in. Null for the default, `adrianeyre`.
     */
    ownerLogin: text("owner_login"),
    /** How often intake checks each Floor's issues; null for 60 seconds. */
    intakeIntervalSeconds: integer("intake_interval_seconds"),
    /** How many sandboxes may run at once (FR-22); null for 3. */
    sandboxConcurrencyLimit: integer("sandbox_concurrency_limit"),
    /**
     * Whether the AI Gateway keeps request and response bodies, encrypted
     * (FR-44, §7); null for the default, on.
     */
    gatewayStoreBodies: boolean("gateway_store_bodies"),
    /**
     * How the AI Gateway chooses each request's AI Account (FR-37):
     * `session`, `session_affinity`, `drain_soonest`,
     * `drain_soonest_strict` or `least_used`; null for the default, `session`.
     */
    gatewayStrategy: text("gateway_strategy"),
    /** How long a session stays on its account; null for 300 minutes. */
    gatewaySessionWindowMinutes: integer("gateway_session_window_minutes"),
    // Retries and the circuit breaker (FR-39); each null for its default:
    // 3 attempts, 500 ms doubling, opening after 5 failures for 60 s.
    gatewayRetryAttempts: integer("gateway_retry_attempts"),
    gatewayRetryDelayMs: integer("gateway_retry_delay_ms"),
    gatewayRetryMultiplier: doublePrecision("gateway_retry_multiplier"),
    gatewayCircuitBreakerThreshold: integer(
      "gateway_circuit_breaker_threshold",
    ),
    gatewayCircuitBreakerCooldownSeconds: integer(
      "gateway_circuit_breaker_cooldown_seconds",
    ),
    // Usage throttling (FR-38): the five-hour and weekly pacing gates;
    // each null for its default, off.
    gatewayFiveHourPacing: boolean("gateway_five_hour_pacing"),
    gatewayWeeklyPacing: boolean("gateway_weekly_pacing"),
    // Auto-refresh (FR-39): whether each usage window is started anew once
    // it resets; null for its default, off.
    gatewayAutoRefresh: boolean("gateway_auto_refresh"),
    // Combos (FR-40): whether requests waterfall through the Combos the
    // Owner enabled; null for its default, off.
    gatewayCombos: boolean("gateway_combos"),
    /**
     * The TTL the AI Gateway gives every prompt-cache breakpoint of a
     * request to Anthropic's API: `5m` or `1h`; null for the default, the
     * caller's own.
     */
    gatewayPromptCacheTtl: text("gateway_prompt_cache_ttl"),
    // Prompt-cache keep-alive (FR-39): whether Agents' prompt caches are
    // kept warm, for how long after their last request, and how many
    // keep-alives each AI Account may be sent an hour; each null for its
    // default: off, 30 minutes, 60.
    gatewayKeepAlive: boolean("gateway_keep_alive"),
    gatewayKeepAliveIdleMinutes: integer("gateway_keep_alive_idle_minutes"),
    gatewayKeepAliveMaxPerAccountPerHour: integer(
      "gateway_keep_alive_max_per_account_per_hour",
    ),
    // The outbound HTTP proxy (FR-35) every upstream request goes through:
    // its URL (null for none), its username, its password sealed with
    // ENCRYPTION_KEY, and the hosts reached without it.
    gatewayOutboundProxyUrl: text("gateway_outbound_proxy_url"),
    gatewayOutboundProxyUsername: text("gateway_outbound_proxy_username"),
    gatewayOutboundProxyPassword: text("gateway_outbound_proxy_password"),
    gatewayOutboundProxyNoProxy: jsonb("gateway_outbound_proxy_no_proxy").$type<
      string[]
    >(),
    // The Decision Model (FR-17, FR-89): whether the Managers and safety
    // checks ask Jev, which of Jev's Models, and whether it writes
    // summaries; each null for its default: off, `typesafe/jev-1.13`, off.
    decisionModelEnabled: boolean("decision_model_enabled"),
    decisionModel: text("decision_model"),
    decisionModelSummaries: boolean("decision_model_summaries"),
    /**
     * The office's default Token Caps (FR-32): the tokens each Agent may
     * use a day and a month unless its Floor, it or its issue has its own.
     * Null for the defaults.
     */
    dailyTokenCap: bigint("daily_token_cap", { mode: "number" }),
    monthlyTokenCap: bigint("monthly_token_cap", { mode: "number" }),
    /**
     * Retention (PRD §7), in days; each null for its default: request and
     * response bodies 7, requests' records and usage readings 90, the
     * Activity Feed, closed Notices and sign-ins 365, and Connections'
     * delivery logs 90.
     */
    retentionRequestBodiesDays: integer("retention_request_bodies_days"),
    retentionRequestMetadataDays: integer("retention_request_metadata_days"),
    retentionActivityDays: integer("retention_activity_days"),
    retentionConnectionDeliveriesDays: integer(
      "retention_connection_deliveries_days",
    ),
    /**
     * Whether the GitHub App's webhooks are taken (FR-8); null for the
     * default, off. Intake's polling carries on either way.
     */
    githubWebhooksEnabled: boolean("github_webhooks_enabled"),
    /**
     * The secret GitHub signs each webhook delivery with, sealed with
     * ENCRYPTION_KEY (`aio1:…`), never in clear; null until one is set.
     */
    githubWebhookSecret: text("github_webhook_secret"),
    /**
     * The Owner's profile: forename, surname, nickname and time zone, as
     * `ownerProfileSchema` (packages/shared) checks it; null until set.
     */
    ownerProfile: jsonb("owner_profile"),
    /**
     * The lobby's receptionist and visitor, each a name and an Avatar, by
     * role; a role not in it is the default's.
     */
    lobbyCast: jsonb("lobby_cast"),
    /**
     * The idle activities turned off on each Floor, by Floor id: the names
     * the web app's activities go by. A Floor not in it has them all.
     */
    floorActivities: jsonb("floor_activities"),
    /**
     * The seasonal events (Christmas, Halloween, Easter, New Year), as
     * `seasonalEventsSchema` (packages/shared) checks them; null until set.
     */
    seasonalEvents: jsonb("seasonal_events"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("office_settings_single_row", sql`${table.id} = 1`),
    check(
      "office_settings_outbound_proxy",
      sql`(${table.gatewayOutboundProxyUrl} IS NOT NULL OR ${table.gatewayOutboundProxyUsername} IS NULL) AND (${table.gatewayOutboundProxyUsername} IS NOT NULL OR ${table.gatewayOutboundProxyPassword} IS NULL) AND (${table.gatewayOutboundProxyPassword} IS NULL OR ${table.gatewayOutboundProxyPassword} LIKE 'aio1:%')`,
    ),
    check(
      "office_settings_sandbox_concurrency_limit",
      sql`${table.sandboxConcurrencyLimit} IS NULL OR ${table.sandboxConcurrencyLimit} >= 1`,
    ),
    check(
      "office_settings_intake_interval",
      sql`${table.intakeIntervalSeconds} IS NULL OR ${table.intakeIntervalSeconds} >= 10`,
    ),
    check(
      "office_settings_git_identity",
      sql`(${table.gitName} IS NULL) = (${table.gitEmail} IS NULL)`,
    ),
    check(
      "office_settings_gateway_strategy",
      sql`${table.gatewayStrategy} IS NULL OR ${table.gatewayStrategy} IN ('session', 'session_affinity', 'drain_soonest', 'drain_soonest_strict', 'least_used')`,
    ),
    check(
      "office_settings_gateway_session_window",
      sql`${table.gatewaySessionWindowMinutes} IS NULL OR ${table.gatewaySessionWindowMinutes} BETWEEN 1 AND 10080`,
    ),
    check(
      "office_settings_gateway_retries",
      sql`(${table.gatewayRetryAttempts} IS NULL OR ${table.gatewayRetryAttempts} BETWEEN 1 AND 10) AND (${table.gatewayRetryDelayMs} IS NULL OR ${table.gatewayRetryDelayMs} BETWEEN 0 AND 60000) AND (${table.gatewayRetryMultiplier} IS NULL OR ${table.gatewayRetryMultiplier} BETWEEN 1 AND 10)`,
    ),
    check(
      "office_settings_gateway_prompt_cache_ttl",
      sql`${table.gatewayPromptCacheTtl} IS NULL OR ${table.gatewayPromptCacheTtl} IN ('5m', '1h')`,
    ),
    check(
      "office_settings_gateway_keep_alive",
      sql`(${table.gatewayKeepAliveIdleMinutes} IS NULL OR ${table.gatewayKeepAliveIdleMinutes} BETWEEN 5 AND 480) AND (${table.gatewayKeepAliveMaxPerAccountPerHour} IS NULL OR ${table.gatewayKeepAliveMaxPerAccountPerHour} BETWEEN 1 AND 600)`,
    ),
    check(
      "office_settings_token_caps",
      sql`(${table.dailyTokenCap} IS NULL OR ${table.dailyTokenCap} > 0) AND (${table.monthlyTokenCap} IS NULL OR ${table.monthlyTokenCap} > 0)`,
    ),
    check(
      "office_settings_retention",
      sql`(${table.retentionRequestBodiesDays} IS NULL OR ${table.retentionRequestBodiesDays} BETWEEN 0 AND 3650) AND (${table.retentionRequestMetadataDays} IS NULL OR ${table.retentionRequestMetadataDays} BETWEEN 32 AND 3650) AND (${table.retentionActivityDays} IS NULL OR ${table.retentionActivityDays} BETWEEN 30 AND 3650) AND (${table.retentionConnectionDeliveriesDays} IS NULL OR ${table.retentionConnectionDeliveriesDays} BETWEEN 1 AND 3650)`,
    ),
    check(
      "office_settings_github_webhook_secret_sealed",
      sql`${table.githubWebhookSecret} IS NULL OR ${table.githubWebhookSecret} LIKE 'aio1:%'`,
    ),
    check(
      "office_settings_github_webhooks_secret",
      sql`${table.githubWebhooksEnabled} IS NOT TRUE OR ${table.githubWebhookSecret} IS NOT NULL`,
    ),
    check(
      "office_settings_gateway_circuit_breaker",
      sql`(${table.gatewayCircuitBreakerThreshold} IS NULL OR ${table.gatewayCircuitBreakerThreshold} BETWEEN 1 AND 100) AND (${table.gatewayCircuitBreakerCooldownSeconds} IS NULL OR ${table.gatewayCircuitBreakerCooldownSeconds} BETWEEN 1 AND 3600)`,
    ),
  ],
);

// The work queue (PRD FR-22): each row is one piece of work for an Agent,
// an issue at a stage, which runs in a sandbox. Work waits (`queued`)
// while as many sandboxes as the office allows are running, then runs by
// its Floor's priority, oldest first. An issue is queued at most once per
// stage at a time. Rows are kept when the work ends, with its outcome.
export const workQueue = pgTable(
  "work_queue",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    issue: integer("issue").notNull(),
    /** The pipeline stage it is for, such as `needs-work`. */
    stage: text("stage").notNull(),
    /** The Agent it waits for; null until one is chosen. */
    agentId: text("agent_id").references(() => agents.id),
    /**
     * The Role whose Agent does it, when it is not its stage's first: a
     * designer's review at `needs-qa`, after the QA Agent's. Null for the
     * stage's own Role.
     */
    role: text("role"),
    /** `queued`, `running`, `finished`, `failed` or `cancelled`. */
    status: text("status").notNull().default("queued"),
    /**
     * The issue's priority from the Manager's triage (FR-23): `high`,
     * `normal` or `low`. Within a Floor's priority, higher starts first.
     */
    priority: text("priority").notNull().default("normal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("work_queue_status_idx").on(table.status, table.createdAt),
    // A Floor's latest work, which the Manager's watchdog reads.
    index("work_queue_floor_idx").on(table.floorId, table.id),
    check(
      "work_queue_priority",
      sql`${table.priority} IN ('high', 'normal', 'low')`,
    ),
    uniqueIndex("work_queue_one_active_per_stage")
      .on(table.floorId, table.issue, table.stage)
      .where(sql`${table.status} IN ('queued', 'running')`),
    check(
      "work_queue_status",
      sql`${table.status} IN ('queued', 'running', 'finished', 'failed', 'cancelled')`,
    ),
    check("work_queue_role", sql`${table.role} IN ('designer')`),
    check(
      "work_queue_stage",
      sql`${table.stage} IN ('needs-work', 'needs-review', 'needs-qa', 'needs-docs', 'ready-to-merge', 'needs-human')`,
    ),
  ],
);

// Notices (PRD §6.9, FR-48): what the Owner should see or act on. An
// action Notice offers one-click actions; an info Notice offers none. Each
// stays on the Notice Board until the Owner dismisses it or takes one of
// its actions; the row is kept either way, until retention deletes it a
// year after it closed (PRD §7). Titles, links and positions are redacted
// before they are stored.
export const notices = pgTable(
  "notices",
  {
    id: text("id").primaryKey(),
    /** `action` or `info`. */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** The Floor it is about; null for the whole Office. */
    floorId: text("floor_id").references(() => floors.id),
    /** The Agent it is about, whose desk it links to. */
    agentId: text("agent_id"),
    // Its links (FR-48): the issue, the pull request and the CI run.
    issue: integer("issue"),
    issueUrl: text("issue_url"),
    pullRequest: integer("pull_request"),
    pullRequestUrl: text("pull_request_url"),
    ciRunUrl: text("ci_run_url"),
    /** More links, as `{ label, url }`, in order: each round of a Review Loop. */
    links: jsonb("links")
      .notNull()
      .default(sql`'[]'`),
    /**
     * The sides of a conflict between Roles, as `{ label, text, url? }`, in
     * the order they arose (FR-30).
     */
    positions: jsonb("positions")
      .notNull()
      .default(sql`'[]'`),
    /** The actions it offers, as `{ id, label, href? }`, in order. */
    actions: jsonb("actions")
      .notNull()
      .default(sql`'[]'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    actedAt: timestamp("acted_at", { withTimezone: true }),
    /** The id of the action taken. */
    actedOn: text("acted_on"),
  },
  (table) => [
    index("notices_open_idx")
      .on(table.createdAt)
      .where(sql`${table.dismissedAt} IS NULL AND ${table.actedAt} IS NULL`),
    index("notices_floor_id_idx").on(table.floorId, table.createdAt),
    check("notices_kind", sql`${table.kind} IN ('action', 'info')`),
    check(
      "notices_closed_once",
      sql`${table.dismissedAt} IS NULL OR ${table.actedAt} IS NULL`,
    ),
    check(
      "notices_acted_on",
      sql`(${table.actedAt} IS NULL) = (${table.actedOn} IS NULL)`,
    ),
    check(
      "notices_issue_link",
      sql`(${table.issue} IS NULL) = (${table.issueUrl} IS NULL)`,
    ),
    check(
      "notices_pull_request_link",
      sql`(${table.pullRequest} IS NULL) = (${table.pullRequestUrl} IS NULL)`,
    ),
  ],
);

// Token Caps per issue (PRD FR-32): the most specific level. An issue's cap
// limits the tokens used on it, by every Agent, in the period; a period
// without one (null) falls back to the Agent's cap. An issue with neither
// has no row.
export const issueTokenCaps = pgTable(
  "issue_token_caps",
  {
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** The issue's number on its Floor's repository. */
    issue: integer("issue").notNull(),
    dailyTokenCap: bigint("daily_token_cap", { mode: "number" }),
    monthlyTokenCap: bigint("monthly_token_cap", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.floorId, table.issue] }),
    check("issue_token_caps_issue", sql`${table.issue} > 0`),
    check(
      "issue_token_caps_caps",
      sql`(${table.dailyTokenCap} IS NULL OR ${table.dailyTokenCap} > 0) AND (${table.monthlyTokenCap} IS NULL OR ${table.monthlyTokenCap} > 0) AND (${table.dailyTokenCap} IS NOT NULL OR ${table.monthlyTokenCap} IS NOT NULL)`,
    ),
  ],
);

// Floors where the Owner stopped everything from the Meeting Room: no
// work starts there, and what was running went back in the queue, until
// the Owner continues. One row per stopped Floor, so a stop outlasts a
// restart.
export const floorStops = pgTable("floor_stops", {
  floorId: text("floor_id")
    .primaryKey()
    .references(() => floors.id, { onDelete: "cascade" }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }).notNull(),
});

// Agents paused at a Token Cap (PRD FR-33, §5 scenario 5): the AI Gateway
// refuses a paused Agent's calls and no new work starts for it, until the
// Owner raises the cap or the pause's resume time comes ("resume
// tomorrow"). One row per paused Agent, naming the cap it reached.
export const agentCapPauses = pgTable(
  "agent_cap_pauses",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** The issue it was working, when its calls named one. */
    issue: integer("issue"),
    /** `daily` or `monthly`. */
    period: text("period").notNull(),
    /** Where the cap is set: `office`, `floor`, `agent` or `issue`. */
    level: text("level").notNull(),
    cap: bigint("cap", { mode: "number" }).notNull(),
    /** Tokens counted against it when it was reached. */
    used: bigint("used", { mode: "number" }).notNull(),
    /** The action Notice offering to raise the cap or resume. */
    noticeId: text("notice_id"),
    pausedAt: timestamp("paused_at", { withTimezone: true }).notNull(),
    /** When it resumes by itself; null until the Owner chooses. */
    resumeAt: timestamp("resume_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "agent_cap_pauses_period",
      sql`${table.period} IN ('daily', 'monthly')`,
    ),
    check(
      "agent_cap_pauses_level",
      sql`${table.level} IN ('office', 'floor', 'agent', 'issue')`,
    ),
    check(
      "agent_cap_pauses_issue",
      sql`${table.issue} IS NULL OR ${table.issue} > 0`,
    ),
  ],
);

// The Review Loop (PRD FR-27, FR-28): each required reviewer's verdict in
// each round of an issue's pull request, as it was posted. The loop counts
// rounds from them, gives the coder the blocking comments, and links each
// round when the Round Cap is reached. They outlast a removed Agent.
export const reviewVerdicts = pgTable(
  "review_verdicts",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    issue: integer("issue").notNull(),
    pullRequest: integer("pull_request").notNull(),
    /** The round of the Review Loop, from 1. */
    round: integer("round").notNull(),
    /** The reviewer Agent. */
    agentId: text("agent_id").notNull(),
    /** The pull request's head commit it reviewed. */
    headSha: text("head_sha").notNull(),
    /** `approve` or `changes_requested`. */
    verdict: text("verdict").notNull(),
    summary: text("summary").notNull(),
    /** Its comments, as `{ severity, path, line, body }`. */
    comments: jsonb("comments")
      .notNull()
      .default(sql`'[]'`),
    /** The review on GitHub. */
    reviewUrl: text("review_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("review_verdicts_one_per_round").on(
      table.floorId,
      table.issue,
      table.round,
      table.agentId,
    ),
    check(
      "review_verdicts_verdict",
      sql`${table.verdict} IN ('approve', 'changes_requested')`,
    ),
    check(
      "review_verdicts_numbers",
      sql`${table.issue} > 0 AND ${table.pullRequest} > 0 AND ${table.round} > 0`,
    ),
  ],
);

/**
 * Each round of QA on an issue's pull request (PRD FR-28): the QA Agent's
 * result, one per round, kept so QA's Round Cap and the overall cap per
 * pull request count across restarts.
 */
export const qaReports = pgTable(
  "qa_reports",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    issue: integer("issue").notNull(),
    pullRequest: integer("pull_request").notNull(),
    /** The round of QA, from 1. */
    round: integer("round").notNull(),
    /** The QA Agent. */
    agentId: text("agent_id").notNull(),
    /** The pull request's head commit it checked, with any tests it added. */
    headSha: text("head_sha").notNull(),
    /** `pass` or `fail`. */
    result: text("result").notNull(),
    summary: text("summary").notNull(),
    /** The steps that reproduce a failure; empty for a pass. */
    steps: text("steps").notNull(),
    /** Its comment on the pull request. */
    commentUrl: text("comment_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("qa_reports_one_per_round").on(
      table.floorId,
      table.issue,
      table.round,
    ),
    check("qa_reports_result", sql`${table.result} IN ('pass', 'fail')`),
    check(
      "qa_reports_numbers",
      sql`${table.issue} > 0 AND ${table.pullRequest} > 0 AND ${table.round} > 0`,
    ),
  ],
);

/**
 * Each round of a designer's review of an issue's pull request (PRD FR-10,
 * FR-18): what it found in the screenshots it took, one per round, kept so
 * the designer's Round Cap counts across restarts and the coder can take
 * its findings.
 */
export const designReviews = pgTable(
  "design_reviews",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    issue: integer("issue").notNull(),
    pullRequest: integer("pull_request").notNull(),
    /** The round of design review, from 1. */
    round: integer("round").notNull(),
    /** The designer Agent. */
    agentId: text("agent_id").notNull(),
    /** The pull request's head commit it reviewed, with any changes it made. */
    headSha: text("head_sha").notNull(),
    /** `pass` or `changes`. */
    result: text("result").notNull(),
    summary: text("summary").notNull(),
    /** What it asks the coder to change; empty for a pass. */
    findings: text("findings").notNull(),
    /** Its comment on the pull request. */
    commentUrl: text("comment_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("design_reviews_one_per_round").on(
      table.floorId,
      table.issue,
      table.round,
    ),
    check("design_reviews_result", sql`${table.result} IN ('pass', 'changes')`),
    check(
      "design_reviews_numbers",
      sql`${table.issue} > 0 AND ${table.pullRequest} > 0 AND ${table.round} > 0`,
    ),
  ],
);

// Handoffs (PRD FR-26): the short structured summary an issue carries to
// its next stage (what changed, what to check, known risks), never a
// transcript. The Agents at that stage read the latest one.
export const handoffs = pgTable(
  "handoffs",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    issue: integer("issue").notNull(),
    /** The stage it hands the issue to, such as `needs-review`. */
    stage: text("stage").notNull(),
    /** The Agent handing it on. */
    fromAgentId: text("from_agent_id").notNull(),
    changed: text("changed").notNull(),
    toCheck: text("to_check").notNull(),
    risks: text("risks").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("handoffs_issue_idx").on(
      table.floorId,
      table.issue,
      table.stage,
      table.createdAt,
    ),
    check(
      "handoffs_stage",
      sql`${table.stage} IN ('needs-work', 'needs-review', 'needs-qa', 'needs-docs', 'ready-to-merge', 'needs-human')`,
    ),
    check("handoffs_issue", sql`${table.issue} > 0`),
  ],
);

// The office Skill library (PRD §6.14, FR-71, FR-72, FR-76): Skills in the
// Agent Skills format, added by upload, by import from a Git repository or
// in the editor, or brought by a built-in Floor Template (FR-99) as a
// Floor was added from it. `files` holds the whole folder as `{ path, content }`, text
// only, with `SKILL.md` among them; `name` and `description` are read from
// its frontmatter. Skills are instructions that reach models, so an
// imported one starts disabled, and can be enabled only once the Owner has
// reviewed its full contents: `reviewed_at` is set by that review (or when
// the Owner writes a Skill in the editor). `digest` is the SHA-256 of
// `files`, which a review names, so a review covers exactly what was read.
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull(),
    /** `upload`, `git`, `editor` or `template`. */
    source: text("source").notNull(),
    // For a Skill imported from Git: the repository, the branch or tag
    // asked for (null for the default), the commit read and the folder.
    gitUrl: text("git_url"),
    gitRef: text("git_ref"),
    gitCommit: text("git_commit"),
    gitPath: text("git_path"),
    files: jsonb("files").notNull(),
    digest: text("digest").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "skills_source",
      sql`${table.source} IN ('upload', 'git', 'editor', 'template')`,
    ),
    // Only a reviewed Skill can be enabled (FR-76).
    check(
      "skills_enabled_reviewed",
      sql`NOT ${table.enabled} OR ${table.reviewedAt} IS NOT NULL`,
    ),
    check(
      "skills_git_origin",
      sql`(${table.source} = 'git') = (${table.gitUrl} IS NOT NULL AND ${table.gitCommit} IS NOT NULL AND ${table.gitPath} IS NOT NULL)`,
    ),
    check("skills_digest", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
  ],
);

// The Owner's own Floor Templates (PRD FR-101): duplicated from another
// template, saved from a Floor's set-up, or imported from a file or a Git
// repository. The built-in templates are files under `templates/`, never
// rows. `files` holds the template's whole folder as `{ path, content }`
// (`template.yaml`, `roles/<role>.md`, `skills/<skill>/…`), the template
// holding its own copy of its Roles and Skills; `name` is read from its
// manifest, unique whatever its case. Role instructions and Skills reach
// models, so an imported template waits for the Owner's review before a
// Floor can be added from it: `reviewed_at` is set by that review, or when
// the Owner makes the template. `digest` is the SHA-256 of `files`, which
// a review names.
export const floorTemplates = pgTable(
  "floor_templates",
  {
    /** A slug from its name, such as `garden-centre`; never a built-in's. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** `duplicate`, `floor`, `file` or `git`. */
    source: text("source").notNull(),
    // For a template imported from Git: the repository, the branch or tag
    // asked for (null for the default), the commit read and the folder.
    gitUrl: text("git_url"),
    gitRef: text("git_ref"),
    gitCommit: text("git_commit"),
    gitPath: text("git_path"),
    files: jsonb("files").notNull(),
    digest: text("digest").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("floor_templates_name_unique").on(sql`lower(${table.name})`),
    check(
      "floor_templates_id",
      sql`${table.id} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${table.id}) <= 40`,
    ),
    check(
      "floor_templates_source",
      sql`${table.source} IN ('duplicate', 'floor', 'file', 'git')`,
    ),
    check(
      "floor_templates_git_origin",
      sql`(${table.source} = 'git') = (${table.gitUrl} IS NOT NULL AND ${table.gitCommit} IS NOT NULL AND ${table.gitPath} IS NOT NULL)`,
    ),
    check("floor_templates_digest", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
  ],
);

// The Manager chat (PRD FR-24): each Floor's conversation between the Owner
// and its Manager, oldest first by `id`. `kind` says who wrote a message
// and how: the Owner (`owner`); the Manager in plain code, saying what a
// command was understood as (`command`, with the command) or why one was
// refused (`hint`); or the Manager's Model (`reply`), or why it did not
// answer (`error`). Each of the Manager's messages answers one of the
// Owner's (`reply_to`), and names the Manager and, from its Model, the
// Model.
export const managerChatMessages = pgTable(
  "manager_chat_messages",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** `owner`, `command`, `hint`, `reply`, `error` or `report`. */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    /** What a `command` message understood, as `ManagerCommand`. */
    command: jsonb("command"),
    /** The Owner's message the Manager answers; none for a daily report. */
    replyTo: bigint("reply_to", { mode: "number" }).references(
      (): AnyPgColumn => managerChatMessages.id,
    ),
    /** The Manager who answered. */
    agentId: text("agent_id"),
    /** The Model that answered (or was asked). */
    model: text("model"),
    /**
     * The Skill it ran, as `ManagerChatSkill` (FR-74): on the Owner's
     * `/name` message, or on a reply whose Skill the Manager chose.
     */
    skill: jsonb("skill"),
    /** That Skill's instructions as they were loaded, redacted. */
    skillInstructions: text("skill_instructions"),
    /** The Grilling Session it belongs to (FR-77), if any. */
    grillingSessionId: bigint("grilling_session_id", {
      mode: "number",
    }).references((): AnyPgColumn => grillingSessions.id),
    /** The round of that session whose questions it asks, if any. */
    grillingRound: integer("grilling_round"),
    /**
     * What a `summary` replaced, as `ManagerChatCompaction` (FR-87): who
     * compacted the conversation, and up to which message.
     */
    compaction: jsonb("compaction"),
    /**
     * The tools the Manager's session used for a `reply`, as
     * `ManagerChatToolUse`s (FR-24): files read, searches, fetches.
     */
    tools: jsonb("tools").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("manager_chat_messages_floor_idx").on(table.floorId, table.id),
    index("manager_chat_messages_grilling_idx").on(
      table.grillingSessionId,
      table.id,
    ),
    check(
      "manager_chat_messages_kind",
      sql`${table.kind} IN ('owner', 'command', 'hint', 'reply', 'error', 'report', 'grilling', 'clear', 'summary', 'plan', 'progress')`,
    ),
    // Only a message of a session asks one of its rounds.
    check(
      "manager_chat_messages_grilling_round",
      sql`${table.grillingRound} IS NULL OR (${table.grillingSessionId} IS NOT NULL AND ${table.grillingRound} > 0)`,
    ),
    // The Owner's messages answer nothing; every one of the Manager's
    // answers one, but for a status report or a summary it writes of its
    // own accord (the daily report; compacting at the Context Usage
    // threshold), and only a command message has a command.
    check(
      "manager_chat_messages_reply_to",
      sql`${table.kind} IN ('report', 'summary') OR (${table.kind} = 'owner') = (${table.replyTo} IS NULL)`,
    ),
    check(
      "manager_chat_messages_compaction",
      sql`(${table.kind} = 'summary') = (${table.compaction} IS NOT NULL)`,
    ),
    check(
      "manager_chat_messages_agent",
      sql`(${table.kind} = 'owner') = (${table.agentId} IS NULL)`,
    ),
    check(
      "manager_chat_messages_command",
      sql`(${table.kind} = 'command') = (${table.command} IS NOT NULL)`,
    ),
    // A Skill is run by the Owner's message or chosen in a reply, and is
    // kept with the instructions it loaded.
    check(
      "manager_chat_messages_skill",
      sql`${table.skill} IS NULL OR ${table.kind} IN ('owner', 'reply')`,
    ),
    check(
      "manager_chat_messages_skill_instructions",
      sql`(${table.skill} IS NULL) = (${table.skillInstructions} IS NULL)`,
    ),
  ],
);

/** Raw bytes, as Postgres `bytea`. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// The files and images the Owner attaches to Manager chat messages (PRD
// FR-24): a screenshot, a log. Each is uploaded first, unsent
// (`message_id` null), and kept with the message that sends it; one never
// sent is deleted within a day. Images are at most 5 MiB, text files 1 MiB.
export const managerChatAttachments = pgTable(
  "manager_chat_attachments",
  {
    id: text("id").primaryKey(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** The Owner's message that sent it; null until one does. */
    messageId: bigint("message_id", { mode: "number" }).references(
      (): AnyPgColumn => managerChatMessages.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    /** One of `chatAttachmentMediaTypes`. */
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    content: bytea("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("manager_chat_attachments_message_idx").on(table.messageId),
    index("manager_chat_attachments_unsent_idx")
      .on(table.createdAt)
      .where(sql`${table.messageId} IS NULL`),
    check(
      "manager_chat_attachments_size",
      sql`${table.size} >= 0 AND ${table.size} <= 5242880`,
    ),
  ],
);

// Each Manager chat conversation's agent session (PRD FR-24, ADR 0004):
// the Manager answers in a continuing, read-only session of its agent tool
// (Claude Code or Codex), resumed turn to turn, and after a restart, by the
// tool's own session id. A conversation is the chat since its latest
// clear or compaction (`conversation`, as the chat names its calls).
export const managerChatSessions = pgTable(
  "manager_chat_sessions",
  {
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** The conversation, such as `manager-chat:web-shop:41`. */
    conversation: text("conversation").notNull(),
    /** `Claude Code` or `Codex`. */
    tool: text("tool").notNull(),
    /** The agent tool's own session id, which it resumes. */
    toolSessionId: text("tool_session_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.floorId, table.conversation] })],
);

// Direct chats: the Owner's one-to-one conversations with each of a Floor's
// Agents (`chat` is `agent:<id>`, with its Floor and Agent), and with the
// AI itself in the Terminal (`chat` is `terminal`, with neither), oldest
// first by `id`. `kind` says who wrote a message: the Owner (`owner`), a
// Model (`reply`, naming it), why one did not answer (`error`), or where
// the Owner cleared the conversation (`clear`). Each reply or error
// answers one of the Owner's messages (`reply_to`). An Agent's chat goes
// with its Floor.
export const directChatMessages = pgTable(
  "direct_chat_messages",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    chat: text("chat").notNull(),
    floorId: text("floor_id").references(() => floors.id, {
      onDelete: "cascade",
    }),
    agentId: text("agent_id"),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    replyTo: bigint("reply_to", { mode: "number" }).references(
      (): AnyPgColumn => directChatMessages.id,
      { onDelete: "cascade" },
    ),
    /** The Model that answered (or was asked). */
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("direct_chat_messages_chat_idx").on(table.chat, table.id),
    index("direct_chat_messages_floor_idx").on(table.floorId),
    check(
      "direct_chat_messages_kind",
      sql`${table.kind} IN ('owner', 'reply', 'error', 'clear')`,
    ),
    check(
      "direct_chat_messages_reply_to",
      sql`(${table.kind} IN ('owner', 'clear')) = (${table.replyTo} IS NULL)`,
    ),
    check(
      "direct_chat_messages_agent",
      sql`(${table.chat} = 'terminal' AND ${table.floorId} IS NULL AND ${table.agentId} IS NULL) OR (${table.chat} = 'agent:' || ${table.agentId} AND ${table.floorId} IS NOT NULL)`,
    ),
  ],
);

// Each Floor's Grilling Sessions (PRD FR-77, FR-78, FR-79, FR-80, FR-82):
// the Manager interviews the Owner in rounds of numbered questions until
// no open questions remain and the Owner confirms, finding facts itself in
// a read-only sandbox, and keeping the Floor's documents current on a
// branch. `questions`, `decisions`, `terms`, `facts`, `outline`, `adrs`
// and `processes` hold the session's structured data, as
// `@ai-office/shared`'s `grillingQuestionSchema` and the rest have it, so
// a compacted chat can be given them back word for word (FR-88);
// `documents` is where they stand on GitHub (`grillingDocumentsSchema`),
// null until first written; `issues` the issues drafted from them and the
// issues filed (FR-81, `grillingIssuesSchema`), null until drafted.
// `skill` is the built-in Skill that started it (`/grilling`,
// `/grill-with-docs`, `/wayfinder`, `/to-tickets` or `/to-spec`, FR-83b),
// and `sources` the documents `/to-tickets` read into it
// (`grillingSourceSchema`). A Floor runs at most one session at a time;
// the rest are paused or ended, and every one is kept.
export const grillingSessions = pgTable(
  "grilling_sessions",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** What `/grilling` was given; empty for nothing. */
    topic: text("topic").notNull(),
    /** The built-in Skill that started it, such as `grilling` or `wayfinder`. */
    skill: text("skill").notNull().default("grilling"),
    /** `active`, `paused` or `ended`. */
    status: text("status").notNull(),
    /** The latest round asked; 0 before the first. */
    round: integer("round").notNull(),
    /** No open questions remain, and the Owner is asked to confirm. */
    awaitingConfirmation: boolean("awaiting_confirmation").notNull(),
    questions: jsonb("questions").notNull(),
    decisions: jsonb("decisions").notNull(),
    terms: jsonb("terms").notNull(),
    facts: jsonb("facts").notNull().default([]),
    outline: jsonb("outline").notNull().default([]),
    adrs: jsonb("adrs").notNull().default([]),
    processes: jsonb("processes").notNull().default([]),
    documents: jsonb("documents"),
    issues: jsonb("issues"),
    sources: jsonb("sources").notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("grilling_sessions_floor_idx").on(table.floorId, table.id),
    uniqueIndex("grilling_sessions_one_active")
      .on(table.floorId)
      .where(sql`${table.status} = 'active'`),
    check(
      "grilling_sessions_status",
      sql`${table.status} IN ('active', 'paused', 'ended')`,
    ),
    check("grilling_sessions_round", sql`${table.round} >= 0`),
    check(
      "grilling_sessions_skill",
      sql`${table.skill} IN ('grilling', 'grill-with-docs', 'wayfinder', 'to-tickets', 'to-spec')`,
    ),
    check(
      "grilling_sessions_paused",
      sql`(${table.status} = 'paused') = (${table.pausedAt} IS NOT NULL)`,
    ),
    check(
      "grilling_sessions_ended",
      sql`(${table.status} = 'ended') = (${table.endedAt} IS NOT NULL)`,
    ),
  ],
);

// The Manager's triage of each issue (PRD FR-23): before work starts on a
// picked-up issue, whether it is clear enough to work, and its priority.
// An unclear issue waits for the Owner, with an action Notice, until its
// text changes (`fingerprint`) or the Owner has it worked as it is. One row
// per issue, its latest triage.
export const issueTriage = pgTable(
  "issue_triage",
  {
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** The issue's number on its Floor's repository. */
    issue: integer("issue").notNull(),
    /**
     * `clear` (it may be worked), `waiting` (for the Owner's answer) or
     * `routing` (clear, waiting for the Owner to choose its work Role).
     */
    status: text("status").notNull(),
    /** `high`, `normal` or `low`. */
    priority: text("priority").notNull(),
    /**
     * Who judged: `model` (the Manager's), `decision_model` (Jev), `rules`
     * or `owner`.
     */
    judgedBy: text("judged_by").notNull(),
    /** The Manager whose triage it was. */
    agentId: text("agent_id"),
    /** A SHA-256 of the issue's title and body as they were judged. */
    fingerprint: text("fingerprint").notNull(),
    /** The action Notice asking the Owner, while it waits. */
    noticeId: text("notice_id"),
    /**
     * The work Role chosen to work it (ADR 0003), a library Role's id; null
     * until one is, and on a Floor with no work Agents.
     */
    role: text("role"),
    /** The work Roles the Owner is asked to choose from, while `routing`. */
    candidates: jsonb("candidates").notNull().default([]),
    triagedAt: timestamp("triaged_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.floorId, table.issue] }),
    check("issue_triage_issue", sql`${table.issue} > 0`),
    check(
      "issue_triage_status",
      sql`${table.status} IN ('clear', 'waiting', 'routing')`,
    ),
    check(
      "issue_triage_priority",
      sql`${table.priority} IN ('high', 'normal', 'low')`,
    ),
    check(
      "issue_triage_judged_by",
      sql`${table.judgedBy} IN ('model', 'decision_model', 'rules', 'owner')`,
    ),
  ],
);

// The work Roles an issue's Batch's Plan gives it (PRD FR-25 (1), ADR
// 0003), such as a merchandiser then a copywriter, which take turns on its
// one branch before review: whose turn it is, and the files each Role's
// commits changed, so the Review Loop sends a fix to the Role whose
// changes its blocking comments concern. One record per issue.
export const issueWorkTurns = pgTable(
  "issue_work_turns",
  {
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** The issue's number on its Floor's repository. */
    issue: integer("issue").notNull(),
    /** The Batch whose Plan gave the Roles. */
    batchId: bigint("batch_id", { mode: "number" }).references(
      () => batches.id,
    ),
    /** The work Roles (library Roles' ids), in the order they take turns. */
    roles: jsonb("roles").notNull(),
    /** The index in `roles` of the Role whose turn it is. */
    turn: integer("turn").notNull(),
    /** Whether the last Role has handed it to review: then turns are fixes. */
    reviewing: boolean("reviewing").notNull(),
    /** The files each Role's commits changed, by Role id. */
    files: jsonb("files").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.floorId, table.issue] }),
    check("issue_work_turns_issue", sql`${table.issue} > 0`),
    check(
      "issue_work_turns_turn",
      sql`${table.turn} >= 0 AND ${table.turn} < jsonb_array_length(${table.roles})`,
    ),
  ],
);

// The Manager's decision log (PRD FR-23): each decision its watchdog took
// about an issue's work (retry, reassign, relabel, pause or escalate),
// with what led to it. Each is also a comment on the issue and a
// `manager.decision` event. `key` names the condition it answered, such as
// one stalled run of a piece of work, so each is decided once, across
// restarts too.
export const managerDecisions = pgTable(
  "manager_decisions",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** The issue's number on its Floor's repository. */
    issue: integer("issue").notNull(),
    /** The Manager that decided. */
    agentId: text("agent_id").notNull(),
    /** `retry`, `reassign`, `relabel`, `pause` or `escalate`. */
    action: text("action").notNull(),
    /** `stalled`, `failing` or `near_cap`. */
    trigger: text("trigger").notNull(),
    /** The stage of the work it concerns, such as `needs-work`. */
    stage: text("stage").notNull(),
    /** The Agent whose work it took away, or that it paused. */
    fromAgentId: text("from_agent_id"),
    /** The Agent it gave the work to. */
    toAgentId: text("to_agent_id"),
    /** The stage it moved the issue to, such as `needs-human`. */
    toStage: text("to_stage"),
    /** The condition it answered: decided once. */
    key: text("key").notNull(),
    /** Why, as the comment on the issue says it. */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("manager_decisions_once").on(table.floorId, table.key),
    index("manager_decisions_issue_idx").on(table.floorId, table.issue),
    check("manager_decisions_issue", sql`${table.issue} > 0`),
    check(
      "manager_decisions_action",
      sql`${table.action} IN ('retry', 'reassign', 'relabel', 'pause', 'escalate')`,
    ),
    check(
      "manager_decisions_trigger",
      sql`${table.trigger} IN ('stalled', 'failing', 'near_cap')`,
    ),
  ],
);

// Which Skills each Floor's Roles are given (PRD FR-75): the Floor admin
// turns a Skill (by name, from the office library or the Floor's
// repository) on or off for one Role. A Skill is on for every Role until a
// row turns it off; a row is kept either way, so a Skill that leaves and
// comes back keeps its setting.
export const floorSkillToggles = pgTable(
  "floor_skill_toggles",
  {
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    skillName: text("skill_name").notNull(),
    /** A Role whose Agents work in sandboxes: `coder`, `qa`, `docs` or `designer`. */
    role: text("role").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.floorId, table.skillName, table.role] }),
    check(
      "floor_skill_toggles_role",
      sql`${table.role} IN ('coder', 'qa', 'docs', 'designer')`,
    ),
    check(
      "floor_skill_toggles_skill_name",
      sql`${table.skillName} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${table.skillName}) <= 64`,
    ),
  ],
);

// Each Floor's Status updates (PRD FR-23a): one row per Floor and day, the
// Owner's day (`YYYY-MM-DD`, in their profile's time zone). The first time
// the Owner opens a Floor on a day, AI Office gives the day's Status update
// unless the row is there; the key makes it once a day however many
// browsers ask at once. `message_id` is its message in the Manager chat.
// The hourly ones, given while a Floor's Agents work, are not kept here.
export const statusUpdates = pgTable(
  "status_updates",
  {
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    day: text("day").notNull(),
    /** `owner` (the Status update button) or `daily` (opening the Floor). */
    trigger: text("trigger").notNull(),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull(),
    messageId: bigint("message_id", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.floorId, table.day] }),
    check("status_updates_day", sql`${table.day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    check(
      "status_updates_trigger",
      sql`${table.trigger} IN ('owner', 'daily')`,
    ),
  ],
);

// The repository Skills the Owner has reviewed on each Floor (PRD FR-76,
// pen-test finding P1-10): a Skill in the Floor's repository
// (`.agents/skills/`, `.claude/skills/`) reaches an Agent or the Manager's
// chat only while its folder's files are exactly those the Owner read,
// by `digest` (the SHA-256 of its files, as an office Skill's). One row
// per folder: a later review replaces it.
export const repositorySkillReviews = pgTable(
  "repository_skill_reviews",
  {
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** Its folder from the repository's top, such as `.claude/skills/pdf`. */
    folder: text("folder").notNull(),
    digest: text("digest").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.floorId, table.folder] }),
    check(
      "repository_skill_reviews_folder",
      sql`${table.folder} ~ '^\\.(agents|claude)/skills/[^/]+$' AND length(${table.folder}) <= 200`,
    ),
    check(
      "repository_skill_reviews_digest",
      sql`${table.digest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

// Batches (PRD FR-25, §5 scenario 1): the issues the Owner handed a
// Floor's Manager in one command, such as "complete issues 1 to 5", in the
// order named (1 to 50 of them), or those the Manager filed for one of the
// Owner's chat requests (`chat_message_id`; FR-24, ADR 0004). A Batch's Plan waits for the Owner's
// approval (`awaiting_approval`), or its work has started (`in_progress`),
// or every issue is closed or blocked and it has finished (`finished`),
// keeping its Wrap-up's results (`wrap_up`, as `@ai-office/shared`'s
// `wrapUpSchema` has it). A Batch handed over "in one PR" works its issues
// one after another on one branch, in one pull request
// (`one_pull_request`; ADR 0010).
export const batches = pgTable(
  "batches",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    issues: integer("issues").array().notNull(),
    /** `awaiting_approval`, `in_progress` or `finished`. */
    status: text("status").notNull(),
    /** The Floor's Manager, whose Batch it is. */
    agentId: text("agent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** When its work started. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When it finished. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Its Wrap-up's results, once it finished. */
    wrapUp: jsonb("wrap_up"),
    /**
     * The Owner's chat message it was filed for (FR-24, ADR 0004); null for
     * a Batch handed over by command, such as "complete issues 1 to 5".
     */
    chatMessageId: bigint("chat_message_id", { mode: "number" }).references(
      (): AnyPgColumn => managerChatMessages.id,
    ),
    /** Its issues go in one pull request, from one branch (ADR 0010). */
    onePullRequest: boolean("one_pull_request").notNull().default(false),
  },
  (table) => [
    index("batches_floor_idx").on(table.floorId, table.id),
    index("batches_finished_idx").on(table.finishedAt),
    check(
      "batches_status",
      sql`${table.status} IN ('awaiting_approval', 'in_progress', 'finished')`,
    ),
    check("batches_issues", sql`cardinality(${table.issues}) BETWEEN 1 AND 50`),
    check(
      "batches_started",
      sql`(${table.status} = 'awaiting_approval') = (${table.startedAt} IS NULL)`,
    ),
    check(
      "batches_finished",
      sql`(${table.status} = 'finished') = (${table.finishedAt} IS NOT NULL AND ${table.wrapUp} IS NOT NULL)`,
    ),
  ],
);

// Each assigned Agent's acknowledgement of a Batch's Plan at its Kickoff
// (PRD FR-25.2): "OK" (`ok`) or one concern (`concern`, with its text),
// from the Agent's Model (`model`) or AI Office's rules (`rules`). Once per
// Agent per Batch.
export const batchAcknowledgements = pgTable(
  "batch_acknowledgements",
  {
    batchId: bigint("batch_id", { mode: "number" })
      .notNull()
      .references(() => batches.id),
    agentId: text("agent_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    response: text("response").notNull(),
    concern: text("concern"),
    acknowledgedBy: text("acknowledged_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.agentId] }),
    check(
      "batch_acknowledgements_response",
      sql`(${table.response} = 'ok' AND ${table.concern} IS NULL) OR (${table.response} = 'concern' AND length(${table.concern}) BETWEEN 1 AND 300)`,
    ),
    check(
      "batch_acknowledgements_by",
      sql`${table.acknowledgedBy} IN ('model', 'rules')`,
    ),
  ],
);

// Each version of a Batch's Plan (PRD FR-25): version 1 is the Manager's
// first draft, and each change is a new version, the earlier ones kept.
// `items` holds the Batch's issues in the order to work them (each with
// its title, the issues it depends on, its likely files, its coder and a
// note), `overlaps` the issues likely to change the same files, `parallel`
// which issues run at once, and `left_out` the issues named that the Batch
// leaves out, with why: each as `@ai-office/shared`'s `planSchema` has it.
// A version the Manager replanned after the Owner edited the Plan on the
// whiteboard names the version edited (`edited_from`), an earlier one.
export const plans = pgTable(
  "plans",
  {
    batchId: bigint("batch_id", { mode: "number" })
      .notNull()
      .references(() => batches.id),
    version: integer("version").notNull(),
    /** `model` (the Manager's) or `rules` (AI Office's own). */
    draftedBy: text("drafted_by").notNull(),
    /** The Floor's Manager, whose Plan it is. */
    agentId: text("agent_id").notNull(),
    summary: text("summary").notNull(),
    items: jsonb("items").notNull(),
    overlaps: jsonb("overlaps").notNull(),
    parallel: jsonb("parallel").notNull(),
    leftOut: jsonb("left_out").notNull(),
    /** The version the Owner edited, which this one replans; null if none. */
    editedFrom: integer("edited_from"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.version] }),
    check("plans_version", sql`${table.version} > 0`),
    check("plans_drafted_by", sql`${table.draftedBy} IN ('model', 'rules')`),
    check(
      "plans_edited_from",
      sql`${table.editedFrom} IS NULL OR (${table.editedFrom} > 0 AND ${table.editedFrom} < ${table.version})`,
    ),
  ],
);

// The issues of a Batch whose work has started (PRD FR-25): each once,
// when the issues it depends on were done. In a Batch whose issues go in one
// pull request (ADR 0010), `base_sha` is where its branch stood as the
// issue started, so the issue's own work is what came after; null for the
// first, which starts the branch.
export const batchIssues = pgTable(
  "batch_issues",
  {
    batchId: bigint("batch_id", { mode: "number" })
      .notNull()
      .references(() => batches.id),
    issue: integer("issue").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    baseSha: text("base_sha"),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.issue] }),
    check("batch_issues_issue", sql`${table.issue} > 0`),
  ],
);

// Each time a Floor's Manager curated its repository memory (PRD FR-53):
// at the end of a Batch (`batch`, once per Batch) or as the weekly tidy-up
// (`weekly`). `curated_by` is `model` (the Manager's) or `rules` (AI
// Office's own); `entries` how many the memory keeps; `pull_request` the
// pull request it opened or updated on GitHub, null when the memory was
// already as curated.
export const memoryCurations = pgTable(
  "memory_curations",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** `batch` or `weekly`. */
    reason: text("reason").notNull(),
    /** The Batch that ended, for `batch`. */
    batchId: bigint("batch_id", { mode: "number" }).references(
      () => batches.id,
    ),
    /** `model` or `rules`. */
    curatedBy: text("curated_by").notNull(),
    /** The Floor's Manager. */
    agentId: text("agent_id").notNull(),
    summary: text("summary").notNull(),
    entries: integer("entries").notNull(),
    pullRequest: integer("pull_request"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("memory_curations_floor_idx").on(table.floorId, table.id),
    unique("memory_curations_batch").on(table.batchId),
    check(
      "memory_curations_reason",
      sql`${table.reason} IN ('batch', 'weekly')`,
    ),
    check(
      "memory_curations_batch_reason",
      sql`(${table.reason} = 'batch') = (${table.batchId} IS NOT NULL)`,
    ),
    check(
      "memory_curations_curated_by",
      sql`${table.curatedBy} IN ('model', 'rules')`,
    ),
    check("memory_curations_entries", sql`${table.entries} >= 0`),
    check(
      "memory_curations_pull_request",
      sql`${table.pullRequest} IS NULL OR ${table.pullRequest} > 0`,
    ),
  ],
);

// The memory entries Agents proposed in their Handoffs (PRD FR-53), each
// one line, redacted, with the issue and Agent it came from. It waits
// (`curation_id` null) until the Manager's next curation takes it.
export const memoryProposals = pgTable(
  "memory_proposals",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    issue: integer("issue").notNull(),
    agentId: text("agent_id").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    curationId: bigint("curation_id", { mode: "number" }).references(
      () => memoryCurations.id,
    ),
  },
  (table) => [
    index("memory_proposals_pending_idx")
      .on(table.floorId, table.id)
      .where(sql`${table.curationId} IS NULL`),
    check("memory_proposals_issue", sql`${table.issue} > 0`),
    check(
      "memory_proposals_text",
      sql`length(${table.text}) BETWEEN 1 AND 300 AND position(E'\\n' in ${table.text}) = 0`,
    ),
  ],
);

// The office-wide memory (PRD FR-54, FR-56): one row, with `id` 1, holding
// the Markdown the Owner keeps in the office admin (coding standards,
// preferred libraries, review rules), mounted read-only into every sandbox
// and quoted in every reviewer's prompt. It never holds a credential: the
// credential check refuses it before it is kept.
export const officeMemory = pgTable(
  "office_memory",
  {
    id: integer("id").primaryKey().default(1),
    content: text("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("office_memory_single_row", sql`${table.id} = 1`),
    check("office_memory_content", sql`length(${table.content}) <= 12000`),
  ],
);

// Role memory (PRD FR-55, FR-56): what Agents of one Role on one Floor have
// learned, one line per entry. An Agent proposes an entry in its Handoff
// (`proposed`); the Floor's Manager or the Owner (`decided_by`) accepts or
// rejects it, and the Owner may remove an accepted one. Agents of its Role
// read the accepted entries. Rows are kept whatever becomes of them.
export const roleMemory = pgTable(
  "role_memory",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    floorId: text("floor_id")
      .notNull()
      .references(() => floors.id),
    /** Its library Role's id, such as `coder`; it goes with its Role. */
    role: text("role")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** One line, never a credential. */
    text: text("text").notNull(),
    /** `proposed`, `recommended`, `accepted`, `rejected` or `removed`. */
    status: text("status").notNull().default("proposed"),
    /** The issue whose Handoff proposed it. */
    issue: integer("issue").notNull(),
    /** The Agent that proposed it. */
    agentId: text("agent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /**
     * `manager` or `owner`; null while it is proposed. Only the Manager
     * recommends, and only the Owner accepts (ADR 0005).
     */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
  },
  (table) => [
    index("role_memory_floor_idx").on(table.floorId, table.role, table.id),
    check(
      "role_memory_text",
      sql`length(${table.text}) BETWEEN 1 AND 300 AND position(E'\\n' in ${table.text}) = 0`,
    ),
    check(
      "role_memory_status",
      sql`${table.status} IN ('proposed', 'recommended', 'accepted', 'rejected', 'removed')`,
    ),
    check("role_memory_issue", sql`${table.issue} > 0`),
    check(
      "role_memory_decided",
      sql`(${table.status} = 'proposed') = (${table.decidedBy} IS NULL) AND (${table.decidedBy} IS NULL) = (${table.decidedAt} IS NULL) AND (${table.decidedBy} IS NULL OR ${table.decidedBy} IN ('manager', 'owner')) AND (${table.status} <> 'recommended' OR ${table.decidedBy} = 'manager') AND (${table.status} NOT IN ('accepted', 'removed') OR ${table.decidedBy} = 'owner')`,
    ),
    check(
      "role_memory_reason",
      sql`${table.reason} IS NULL OR length(${table.reason}) <= 300`,
    ),
  ],
);

// The Communications Agent (PRD FR-90): the one office-wide Agent, made at
// first start, that tells the Owner outside AI Office through Connections.
// One row, with `id` 1. It belongs to no Floor, has no sandbox and no
// repository access, so it is not in `agents`. `event_cursor` is the last
// event it has taken in, so deliveries are queued from the event bus
// without missing any across a restart. `avatar` is how it looks at the
// lobby's reception desk (FR-90, FR-96).
export const communicationsAgent = pgTable(
  "communications_agent",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * How it looks (FR-13), as `@ai-office/shared` defines an Avatar; null
     * until set, when it has the default look.
     */
    avatar: jsonb("avatar"),
    /** Such as `Claude`: for Digests and reports only. */
    aiProvider: text("ai_provider").notNull(),
    /** Its own Model; null uses its AI Provider's default. */
    modelOverride: text("model_override"),
    /** False while it is paused: deliveries queue until it resumes. */
    enabled: boolean("enabled").notNull().default(true),
    eventCursor: bigint("event_cursor", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("communications_agent_single_row", sql`${table.id} = 1`),
    check("communications_agent_event_cursor", sql`${table.eventCursor} >= 0`),
  ],
);

// GitHub connections (ADR 0011): each GitHub App and access token the
// Owner added in Floor Settings, through which AI Office reaches GitHub.
// An App keeps its ID and PEM private key; an access token, itself and the
// read-only token sandboxes get. The key and the tokens are sealed with
// ENCRYPTION_KEY and never read back by the API; `hint` (their last
// characters) tells them apart. A disabled one is kept but not used.
export const githubConnections = pgTable(
  "github_connections",
  {
    id: text("id").primaryKey(),
    /** `app` or `access-token`. */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    appId: text("app_id"),
    privateKey: text("private_key"),
    token: text("token"),
    readOnlyToken: text("read_only_token"),
    hint: text("hint").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("github_connections_app_id_unique").on(table.appId),
    check(
      "github_connections_kind",
      sql`(${table.kind} = 'app' AND ${table.appId} IS NOT NULL AND ${table.privateKey} IS NOT NULL AND ${table.token} IS NULL AND ${table.readOnlyToken} IS NULL) OR (${table.kind} = 'access-token' AND ${table.appId} IS NULL AND ${table.privateKey} IS NULL AND ${table.token} IS NOT NULL AND ${table.readOnlyToken} IS NOT NULL)`,
    ),
    check(
      "github_connections_private_key_sealed",
      sql`${table.privateKey} IS NULL OR ${table.privateKey} LIKE 'aio1:%'`,
    ),
    check(
      "github_connections_token_sealed",
      sql`${table.token} IS NULL OR ${table.token} LIKE 'aio1:%'`,
    ),
    check(
      "github_connections_read_only_token_sealed",
      sql`${table.readOnlyToken} IS NULL OR ${table.readOnlyToken} LIKE 'aio1:%'`,
    ),
  ],
);

// Connections (PRD FR-91, FR-93): each outbound integration the Owner set
// up. Its credentials (a webhook's address and signing secret, a token, a
// password) are one JSON value sealed with ENCRYPTION_KEY, never read back
// by the API; `hint` identifies them without giving them away. `settings`
// holds what is not secret. After 5 failed deliveries in a row it is
// `failing` (FR-94).
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * A notification channel (`webhook`, `slack`, `email`, `ntfy` or
     * `pushover`) or a publishing destination (`confluence`, `notion`,
     * `google_sheets`, `google_docs`, `google_slides`, `google_drive` or
     * `google_calendar`).
     */
    type: text("type").notNull(),
    /** What it is sent, as `@ai-office/shared` defines Connection rules. */
    rules: jsonb("rules").notNull(),
    /** `links_only` or `titles_and_summaries` (FR-95). */
    detailLevel: text("detail_level").notNull().default("titles_and_summaries"),
    settings: jsonb("settings").notNull().default({}),
    credentials: text("credentials").notNull(),
    hint: text("hint").notNull(),
    paused: boolean("paused").notNull().default(false),
    /** `ok` or `failing`. */
    status: text("status").notNull().default("ok"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /**
     * Its Digest's progress (FR-92): the last event a Digest summarised,
     * and when the last one was made (or the Digest was turned on).
     */
    digestCursor: bigint("digest_cursor", { mode: "number" })
      .notNull()
      .default(0),
    lastDigestAt: timestamp("last_digest_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("connections_name_unique").on(table.name),
    check(
      "connections_type",
      sql`${table.type} IN ('webhook', 'slack', 'email', 'ntfy', 'pushover', 'confluence', 'notion', 'google_sheets', 'google_docs', 'google_slides', 'google_drive', 'google_calendar')`,
    ),
    check(
      "connections_detail_level",
      sql`${table.detailLevel} IN ('links_only', 'titles_and_summaries')`,
    ),
    check("connections_status", sql`${table.status} IN ('ok', 'failing')`),
    check(
      "connections_consecutive_failures",
      sql`${table.consecutiveFailures} >= 0`,
    ),
  ],
);

// Google sign-in (PRD FR-91): the OAuth client the Owner registered in
// Google Cloud, and the one Google account signed in through it for the
// Google Connections. One row, with `id` 1. The client's secret and the
// tokens are sealed with ENCRYPTION_KEY and never read back by the API;
// the client's ID is not secret. `status` is `signed_out`, `signed_in`, or
// `revoked` once Google refused the refresh token.
export const googleSignIn = pgTable(
  "google_sign_in",
  {
    id: integer("id").primaryKey(),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret").notNull(),
    status: text("status").notNull().default("signed_out"),
    refreshToken: text("refresh_token"),
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    /** The scopes Google granted at the last sign-in. */
    grantedScopes: jsonb("granted_scopes").notNull().default([]),
    signedInAt: timestamp("signed_in_at", { withTimezone: true }),
  },
  (table) => [
    check("google_sign_in_single_row", sql`${table.id} = 1`),
    check(
      "google_sign_in_status",
      sql`${table.status} IN ('signed_out', 'signed_in', 'revoked')`,
    ),
    // Signed in means a refresh token to sign in with.
    check(
      "google_sign_in_refresh_token",
      sql`${table.status} <> 'signed_in' OR ${table.refreshToken} IS NOT NULL`,
    ),
  ],
);

// The outbound queue and each Connection's delivery log (PRD FR-93,
// FR-94): one row per event per Connection (so each event is delivered at
// most once to each), or per "Send test" or Digest. A pending row waits for
// `next_attempt_at`; a failed one is retried with exponential backoff until
// 24 hours after its first attempt. The message is rendered, from a
// template, when the row is queued, and redacted.
export const connectionDeliveries = pgTable(
  "connection_deliveries",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** The event it tells of; null for a test. */
    eventId: bigint("event_id", { mode: "number" }),
    test: boolean("test").notNull().default(false),
    message: jsonb("message").notNull(),
    /**
     * `pending`, `delivered`, `failed` (given up) or `summarised` (by a
     * Digest, instead of being sent after quiet hours).
     */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Why its last attempt failed, redacted. */
    error: text("error"),
  },
  (table) => [
    uniqueIndex("connection_deliveries_event_unique").on(
      table.connectionId,
      table.eventId,
    ),
    index("connection_deliveries_log_idx").on(
      table.connectionId,
      table.createdAt,
    ),
    index("connection_deliveries_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    check(
      "connection_deliveries_status",
      sql`${table.status} IN ('pending', 'delivered', 'failed', 'summarised')`,
    ),
    check(
      "connection_deliveries_pending",
      sql`(${table.status} = 'pending') = (${table.nextAttemptAt} IS NOT NULL)`,
    ),
    check(
      "connection_deliveries_delivered",
      sql`(${table.status} = 'delivered') = (${table.deliveredAt} IS NOT NULL)`,
    ),
    // A test, like a Digest, tells of no one event.
    check(
      "connection_deliveries_test",
      sql`NOT ${table.test} OR ${table.eventId} IS NULL`,
    ),
    check("connection_deliveries_attempts", sql`${table.attempts} >= 0`),
  ],
);
