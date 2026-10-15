import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowedInternalHostSchema,
  maxAllowedInternalHosts,
} from "@ai-office/shared";
import {
  parseVersionedEncryptionKey,
  type EncryptorOptions,
  type VersionedKey,
} from "@ai-office/shared/crypto";
import { z } from "zod";

import { isLoopback } from "./auth/setup-token.ts";

// Start-up configuration from the environment (PRD FR-67). Everything else
// is configuration in Postgres; only what the server needs before it can
// reach Postgres, and the secrets, live here.

/** Keys whose values are secrets: never logged, never echoed in errors. */
export const secretConfigKeys = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "RETIRED_ENCRYPTION_KEYS",
  "PROXY_SECRET",
] as const;

const required = (iss: { input: unknown }): string =>
  iss.input === undefined ? "is required" : "must be a string";

const port = z.coerce
  .number({ error: "must be a port number" })
  .int({ error: "must be a port number" })
  .min(1, { error: "must be a port number" })
  .max(65535, { error: "must be a port number" });

const isAddressOrRange = (entry: string): boolean => {
  const [address = "", prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  if (family === 0 || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
};

// A hop count, or addresses and CIDR ranges. Never "trust everyone": then
// any client could pick its own address and dodge the sign-in rate limit.
const trustProxy = z.string().transform((value, ctx) => {
  if (/^\d+$/.test(value) && Number(value) >= 1) {
    return Number(value);
  }
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.every(isAddressOrRange)) {
    return entries;
  }
  ctx.addIssue({
    code: "custom",
    message:
      "must be a hop count (1 or more) or a comma-separated list of IP addresses and CIDR ranges",
  });
  return z.NEVER;
});

const keyFormat =
  "must be 32 random bytes, base64-encoded (openssl rand -base64 32), after its key version and a colon (2:<key>) once it has replaced another";

const versionedKey = (value: string): VersionedKey | undefined => {
  try {
    return parseVersionedEncryptionKey(value);
  } catch {
    return undefined;
  }
};

// GitHub (ADR 0011): the GitHub Apps and access tokens are added in
// Floor Settings and kept in the database, never read from here. The
// variables that once gave them are warned of at start, naming them but
// never their values, so a credential left in an env file is not thought
// in use. They are not refused: GitHub is added again in Floor Settings,
// which needs the server running.
const retiredGitHubKey =
  /^GITHUB_(APP_ID|APP_PRIVATE_KEY|ACCESS_TOKEN|READ_ONLY_ACCESS_TOKEN)(_\d+)?$/;

/** The GitHub variables still set that AI Office no longer reads, by name. */
export const retiredGitHubVariables = (
  env: Readonly<Record<string, string | undefined>>,
): string[] =>
  Object.entries(env)
    .filter(
      ([name, value]) =>
        value !== undefined && value !== "" && retiredGitHubKey.test(name),
    )
    .map(([name]) => name);

const environmentSchema = z.object({
  DATABASE_URL: z.string({ error: required }).refine(
    (value) => {
      try {
        return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { error: "must be a postgres:// or postgresql:// URL" },
  ),
  SESSION_SECRET: z
    .string({ error: required })
    .min(32, { error: "must be at least 32 characters" }),
  // The key new values are sealed with: the key alone (key version 1), or
  // `<version>:<key>` once it has replaced another.
  ENCRYPTION_KEY: z.string({ error: required }).transform((value, ctx) => {
    const key = versionedKey(value);
    if (key === undefined) {
      ctx.addIssue({ code: "custom", message: keyFormat });
      return z.NEVER;
    }
    return key;
  }),
  // The keys ENCRYPTION_KEY has replaced, separated by commas, each written
  // as it was: what they sealed still opens, and is re-sealed with
  // ENCRYPTION_KEY when AI Office starts (pen-testing G1-9).
  RETIRED_ENCRYPTION_KEYS: z
    .string()
    .transform((value, ctx) => {
      const keys = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .map(versionedKey);
      if (keys.some((key) => key === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: `must be the keys ENCRYPTION_KEY replaced, separated by commas, each as ENCRYPTION_KEY was written: ${keyFormat}`,
        });
        return z.NEVER;
      }
      return keys.filter((key) => key !== undefined);
    })
    .optional(),
  // Ports avoid the common defaults (3000, 4000, 5173, 5432): the website
  // is on 3045 (Vite in development, the published port under compose),
  // and serves the AI Gateway's `/v1` paths too; the server on 3046; the
  // AI Gateway's own port, for sandboxes, on 3047; Postgres on 3048.
  PORT: port.default(3046),
  // This machine only, unless told otherwise: until the Owner has set the
  // password, whoever reaches the setup screen could try to (A1-2).
  // Compose sets 0.0.0.0, inside the app's container.
  HOST: z.string().default("127.0.0.1"),
  // Where the app's port is reached from when something in between decides
  // it: compose sets it from AI_OFFICE_BIND_ADDRESS, the address Docker
  // publishes the port on, as HOST is then the container's own (0.0.0.0).
  // Outside a container, HOST says. AI Office served beyond this machine
  // refuses .env.example's public secrets (pen-testing G1-8).
  PUBLISHED_ADDRESS: z.string().optional(),
  PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })
    .optional(),
  TRUST_PROXY: trustProxy.optional(),
  // What the proxy in front of AI Office sends in the X-AI-Office-Proxy
  // header: X-Forwarded-For is believed only from a request that carries it,
  // so a caller that reaches the app's port directly (another container on
  // its network, say) cannot choose the address it is limited by.
  PROXY_SECRET: z
    .string()
    .min(32, { error: "must be at least 32 characters" })
    .optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], {
      error: "must be one of fatal, error, warn, info, debug, trace, silent",
    })
    .default("info"),
  WEB_DIST_DIR: z.string().optional(),
  // GitHub's REST API: GitHub Enterprise Server's, or a fake GitHub's in the
  // end-to-end tests.
  GITHUB_API_URL: z
    .url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })
    .default("https://api.github.com"),
  // Sandboxes (PRD FR-19): where Agents' clones are made on the host, and
  // the AI Gateway's address as a sandbox reaches it (ADR 0001: sandboxes
  // reach models only through it). Agents work issues only once it is set.
  SANDBOX_WORK_DIR: z.string().optional(),
  SANDBOX_GATEWAY_URL: z
    .url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })
    .optional(),
  // The Docker network the sandbox relay is on: the one compose (or,
  // outside it, docker-compose.dev.yml) creates with no route out, never
  // Docker's default bridge, which has one (pen-testing S2-1). Each sandbox
  // has a network of its own, as closed, which the relay joins and on which
  // SANDBOX_GATEWAY_URL reaches the Gateway (S2-5, ADR 0006).
  SANDBOX_NETWORK: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, {
      error: "must be a Docker network's name",
    })
    .default("ai-office-sandboxes"),
  // The AI Gateway's own port (ADR 0001), the sandboxes' way to it: the
  // Owner's tools use the app's port, which serves the Gateway's `/v1`
  // paths too. Every request needs a Gateway Key, but it listens on
  // loopback unless told otherwise (compose keeps it inside the compose
  // network).
  GATEWAY_PORT: port.default(3047),
  GATEWAY_HOST: z.string().default("127.0.0.1"),
  GATEWAY_FIXTURES_DIR: z.string().optional(),
  // Where AI Office listens for a subscription sign-in's local callback
  // (ChatGPT's localhost:1455) while one waits: loopback, unless AI Office
  // runs in a container that publishes the port to the host's loopback.
  OAUTH_CALLBACK_HOST: z.string().default("127.0.0.1"),
  // Hosts on the Owner's own network, or the AI Office host itself, that
  // an address the Owner gives may name (ADR 0007): their own Ollama
  // (host.docker.internal under compose, localhost outside it), a webhook
  // receiver or a Git server on their network. Anything else internal, and
  // plain http:// to anything else, is refused. In the environment, so a
  // stolen session cannot widen it. None by default.
  ALLOWED_INTERNAL_HOSTS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    )
    .pipe(
      z.array(allowedInternalHostSchema).max(maxAllowedInternalHosts, {
        error: `must name at most ${String(maxAllowedInternalHosts)} hosts`,
      }),
    )
    .optional(),
  // AI Accounts are not configured here: the Owner adds them in Admin, and
  // they are kept in Postgres with their credentials encrypted (FR-35).
});

/** Every environment variable the server reads (`.env.example` lists them). */
export const environmentKeys = Object.keys(environmentSchema.shape);

export interface Config {
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  /** The key new values are sealed with. */
  readonly encryptionKey: Buffer;
  /**
   * Every key a stored value may be sealed with, by key version:
   * ENCRYPTION_KEY's as the current one, and RETIRED_ENCRYPTION_KEYS'.
   */
  readonly encryptionKeyring: EncryptorOptions;
  readonly port: number;
  readonly host: string;
  /** Where the app's port is published, when not on `host` (compose). */
  readonly publishedAddress?: string;
  readonly publicUrl: string;
  /** Which proxies to believe about the client's address; none if unset. */
  readonly trustProxy?: number | readonly string[];
  /** What the proxy proves itself with; set exactly when `trustProxy` is. */
  readonly proxySecret?: string;
  readonly logLevel: string;
  /** Where the built web app is; it may not exist (nothing to serve yet). */
  readonly webDistDir: string;
  /**
   * GitHub's REST API. The GitHub Apps and access tokens AI Office reaches
   * it through are added in Floor Settings (ADR 0011).
   */
  readonly githubApiUrl: string;
  readonly sandboxes: {
    /** Where clones are made, one directory per run. */
    readonly workDir: string;
    /** The AI Gateway as sandboxes reach it; Agents work only once it is set. */
    readonly gatewayUrl?: string;
    /**
     * What SANDBOX_GATEWAY_URL said, when it named a host other than the
     * sandbox relay: `gatewayUrl` is the relay's address instead.
     */
    readonly givenGatewayUrl?: string;
    /**
     * The Docker network the sandbox relay is on, which has no route out;
     * each sandbox has one of its own, which the relay joins.
     */
    readonly network: string;
  };
  /** Where a sign-in's local callback is listened for (OAUTH_CALLBACK_HOST). */
  readonly oauthCallbackHost: string;
  /** Internal hosts an address the Owner gives may name (ADR 0007). */
  readonly allowedInternalHosts: readonly string[];
  readonly gateway: {
    readonly port: number;
    readonly host: string;
    /** Recorder mode: where request/response fixtures are written. */
    readonly fixturesDir?: string;
  };
}

/** Raised when the environment is missing or has malformed values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `AI Office cannot start: its configuration is invalid.\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const defaultWebDistDir = fileURLToPath(
  new URL("../../web/dist", import.meta.url),
);

/**
 * Reads and validates the configuration from `env`. Throws a `ConfigError`
 * naming every missing or malformed key (but never echoing a value).
 */
/** The AI Gateway as every sandbox reaches it: through the sandbox relay (ADR 0008). */
export const sandboxRelayGatewayUrl = "http://sandbox-relay:3047";

/**
 * SANDBOX_GATEWAY_URL, as sandboxes can use it. A sandbox's network has no
 * route out and no DNS beyond it, so the relay is the one host it reaches
 * (pen-testing S2-1, ADR 0008): any other, such as the
 * `http://host.docker.internal:3047` older `.env.example`s gave, cannot
 * even be looked up, and the agent tool retries for minutes before it
 * fails ("EAI_AGAIN"). Such a value is replaced with the relay's address,
 * and kept as `givenGatewayUrl` for the warning at startup.
 */
function sandboxGateway(value: string | undefined): {
  gatewayUrl?: string;
  givenGatewayUrl?: string;
} {
  if (value === undefined) {
    return {};
  }
  return new URL(value).hostname === new URL(sandboxRelayGatewayUrl).hostname
    ? { gatewayUrl: value }
    : { gatewayUrl: sandboxRelayGatewayUrl, givenGatewayUrl: value };
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Config {
  // An empty variable (`FOO=` in an env file) counts as unset.
  const present = Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
  const result = environmentSchema.safeParse(present, { reportInput: false });
  const problems = result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join(".")} ${issue.message}`,
      );

  if (result.success) {
    const {
      GATEWAY_PORT,
      PORT,
      TRUST_PROXY,
      PROXY_SECRET,
      ENCRYPTION_KEY,
      RETIRED_ENCRYPTION_KEYS = [],
    } = result.data;
    if (GATEWAY_PORT === PORT) {
      problems.push("GATEWAY_PORT must differ from PORT");
    }
    if ((TRUST_PROXY === undefined) !== (PROXY_SECRET === undefined)) {
      problems.push(
        "TRUST_PROXY and PROXY_SECRET must be set together, or neither: X-Forwarded-For is believed only from a proxy that sends PROXY_SECRET",
      );
    }
    problems.push(...keyringProblems(ENCRYPTION_KEY, RETIRED_ENCRYPTION_KEYS));
  }
  if (!result.success || problems.length > 0) {
    throw new ConfigError(problems);
  }

  const values = result.data;
  const config: Config = {
    databaseUrl: values.DATABASE_URL,
    sessionSecret: values.SESSION_SECRET,
    encryptionKey: values.ENCRYPTION_KEY.key,
    encryptionKeyring: {
      keys: new Map(
        [...(values.RETIRED_ENCRYPTION_KEYS ?? []), values.ENCRYPTION_KEY].map(
          ({ version, key }) => [version, key],
        ),
      ),
      currentKeyVersion: values.ENCRYPTION_KEY.version,
    },
    port: values.PORT,
    host: values.HOST,
    ...(values.PUBLISHED_ADDRESS === undefined
      ? {}
      : { publishedAddress: values.PUBLISHED_ADDRESS }),
    publicUrl: values.PUBLIC_URL ?? "http://localhost:3045",
    ...(values.TRUST_PROXY === undefined || values.PROXY_SECRET === undefined
      ? {}
      : { trustProxy: values.TRUST_PROXY, proxySecret: values.PROXY_SECRET }),
    logLevel: values.LOG_LEVEL,
    webDistDir: values.WEB_DIST_DIR ?? defaultWebDistDir,
    githubApiUrl: values.GITHUB_API_URL,
    sandboxes: {
      workDir: values.SANDBOX_WORK_DIR ?? join(tmpdir(), "ai-office-sandboxes"),
      ...sandboxGateway(values.SANDBOX_GATEWAY_URL),
      network: values.SANDBOX_NETWORK,
    },
    oauthCallbackHost: values.OAUTH_CALLBACK_HOST,
    allowedInternalHosts: values.ALLOWED_INTERNAL_HOSTS ?? [],
    gateway: {
      port: values.GATEWAY_PORT,
      host: values.GATEWAY_HOST,
      ...(values.GATEWAY_FIXTURES_DIR === undefined
        ? {}
        : { fixturesDir: values.GATEWAY_FIXTURES_DIR }),
    },
  };

  // The sample secrets are for this machine only (pen-testing G1-8): with
  // the public ENCRYPTION_KEY, a copy of the database opens every
  // credential sealed in it, and with the public password, whoever reaches
  // Postgres reads it.
  const beyond = servedBeyondThisMachine(config);
  if (beyond.length > 0) {
    const samples = developmentSecretsInUse(config);
    if (samples.length > 0) {
      throw new ConfigError(
        samples.map(
          (key) =>
            `${sampleNames[key]} is the public sample from .env.example, which AI Office refuses once it is served beyond this machine (${beyond.join(", ")}): generate your own (see .env.example)${key === "ENCRYPTION_KEY" ? ", and to keep what it sealed, move it to RETIRED_ENCRYPTION_KEYS beside the new key, written as 2:<the new key>" : ""}`,
        ),
      );
    }
  }
  return config;
}

/**
 * What is wrong with ENCRYPTION_KEY beside the keys it replaced: a rotation
 * must give the new key a version of its own, after every retired one, so
 * each sealed value names the one key that opens it.
 */
function keyringProblems(
  current: VersionedKey,
  retired: readonly VersionedKey[],
): string[] {
  const problems: string[] = [];
  const versions = new Set(retired.map(({ version }) => version));
  if (versions.size < retired.length) {
    problems.push(
      "RETIRED_ENCRYPTION_KEYS must give each key a key version of its own",
    );
  }
  const keys = [...retired, current].map(({ key }) => key.toString("base64"));
  if (new Set(keys).size < keys.length) {
    problems.push(
      "RETIRED_ENCRYPTION_KEYS must not hold ENCRYPTION_KEY, nor one key twice",
    );
  }
  const latest = Math.max(0, ...versions);
  if (current.version <= latest) {
    problems.push(
      `ENCRYPTION_KEY's key version must be after every retired one: write it as ${String(latest + 1)}:<the new key>`,
    );
  }
  return problems;
}

/** Whether `name` (a host name or an address) is this machine's alone. */
const isThisMachine = (name: string): boolean => {
  const bare = name.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return (
    bare === "localhost" || bare.endsWith(".localhost") || isLoopback(bare)
  );
};

/**
 * The settings that serve AI Office beyond this machine, by name: an app
 * port reached from beyond loopback (HOST, or PUBLISHED_ADDRESS under
 * compose), a PUBLIC_URL that is not this machine's, or a proxy in front of
 * it (TRUST_PROXY). None means this machine only.
 */
export function servedBeyondThisMachine(
  config: Pick<
    Config,
    "host" | "publishedAddress" | "publicUrl" | "trustProxy"
  >,
): string[] {
  const reasons: string[] = [];
  const [setting, address] =
    config.publishedAddress === undefined
      ? ["HOST", config.host]
      : ["PUBLISHED_ADDRESS", config.publishedAddress];
  if (!isThisMachine(address)) {
    reasons.push(setting);
  }
  if (!isThisMachine(new URL(config.publicUrl).hostname)) {
    reasons.push("PUBLIC_URL");
  }
  if (config.trustProxy !== undefined) {
    reasons.push("TRUST_PROXY");
  }
  return reasons;
}

/**
 * The sample secrets `.env.example` ships with, so a copied `.env` runs in
 * development as it is: the database password is the one its DATABASE_URL
 * holds, and compose builds DATABASE_URL from. They are public, so the
 * server warns when it starts with any of them, and refuses them once it is
 * served beyond this machine (pen-testing G1-8).
 */
export const developmentSecrets = {
  SESSION_SECRET: "development-only-session-secret-change-me",
  ENCRYPTION_KEY: "ZGV2LW9ubHktYWktb2ZmaWNlLWVuY3J5cHRpb24ta3k=",
  POSTGRES_PASSWORD: "devpassword",
} as const;

type DevelopmentSecret = keyof typeof developmentSecrets;

/** How a refusal names each sample secret, so the Owner knows what to set. */
const sampleNames: Record<DevelopmentSecret, string> = {
  SESSION_SECRET: "SESSION_SECRET",
  ENCRYPTION_KEY: "ENCRYPTION_KEY",
  POSTGRES_PASSWORD: "POSTGRES_PASSWORD (the password in DATABASE_URL)",
};

/** The names of the sample secrets from `.env.example` that `config` uses. */
export function developmentSecretsInUse(
  config: Pick<Config, "sessionSecret" | "encryptionKey" | "databaseUrl">,
): DevelopmentSecret[] {
  const { password } = new URL(config.databaseUrl);
  let databasePassword = password;
  try {
    databasePassword = decodeURIComponent(password);
  } catch {
    // Not percent-encoded as a URL's should be; compared as written.
  }
  return [
    ...(config.sessionSecret === developmentSecrets.SESSION_SECRET
      ? (["SESSION_SECRET"] as const)
      : []),
    ...(config.encryptionKey.toString("base64") ===
    developmentSecrets.ENCRYPTION_KEY
      ? (["ENCRYPTION_KEY"] as const)
      : []),
    ...(databasePassword === developmentSecrets.POSTGRES_PASSWORD
      ? (["POSTGRES_PASSWORD"] as const)
      : []),
  ];
}

/**
 * The secret values in `config`, in every form they might be written: the
 * logger removes each of them from anything it emits.
 */
export function secretValues(config: Config): string[] {
  const values = [
    config.databaseUrl,
    config.sessionSecret,
    config.encryptionKey.toString("base64"),
    ...[...config.encryptionKeyring.keys.values()]
      .filter((key) => !key.equals(config.encryptionKey))
      .map((key) => key.toString("base64")),
  ];
  const { password } = new URL(config.databaseUrl);
  if (password !== "") {
    values.push(password, decodeURIComponent(password));
  }
  if (config.proxySecret !== undefined) {
    values.push(config.proxySecret);
  }
  return values;
}
