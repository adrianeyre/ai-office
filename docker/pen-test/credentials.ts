// The credentials package (Enablement E4, #190;
// docs/pen-testing/credentials-package.md): what the red team gets for the
// pen-test stack, and nothing else. One Owner password, one UI-capable API
// key and one Gateway Key, minted in the stack's own database through AI
// Office's own code; the seeded Floor and fixture IDs (E2's fixture ID
// listing); and the pinned commit of the read-only source.
//
// It never holds the stack's ENCRYPTION_KEY, SESSION_SECRET, database
// password or GitHub App private key, an AI Account's credential, a CI
// credential or anything that writes to this repository: `packageProblems`
// refuses a package that does, and `writeCredentialsPackage` writes only one
// that passes, with 0600 permissions, never over another. Nothing here prints
// a credential: what it says names each credential by its name and id.
//
// Each credential is revoked at the end of the window (`revokeCredentials`):
// the Owner password is removed, which ends its sessions, and both keys are
// revoked, which the AI Gateway and sign-in refuse from then on.

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";

import type {
  AuthStore,
  OwnerPasswordRecord,
} from "../../apps/server/src/auth/store.ts";
import type {
  GatewayKeyInfo,
  GatewayKeys,
} from "../../packages/gateway/src/index.ts";
import type { GatewayKeyAccess } from "../../packages/shared/src/index.ts";
import type { FixtureListing } from "./fixtures.ts";

/** The red team's Owner password, by name: the only one with this name. */
export const redTeamPasswordName = "Pen-test red team";
/** The UI-capable API key: an Owner tool's key with "AI proxy and UI". */
export const uiKeyName = "Pen-test red team (UI)";
/** The Gateway Key: an Owner tool's key that only calls models. */
export const gatewayKeyName = "Pen-test red team (Gateway)";

/** The credentials a package holds, and no others. */
export const allowedCredentials = [
  "ownerPassword",
  "uiApiKey",
  "gatewayKey",
] as const;

/**
 * What the red team never gets (PRD, Engagement shape, "Type"), as the
 * environment variables that hold it in the stack. The package's check
 * refuses each one's value, wherever it is found.
 */
export const forbiddenSettings = [
  "ENCRYPTION_KEY",
  "SESSION_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "POSTGRES_PASSWORD",
] as const;

/**
 * Shapes no package may hold: a database URL, a private key, a GitHub
 * token (CI's, or one that writes to a repository), a stub AI Account's
 * canary credential, and the forbidden settings named as keys.
 */
const forbiddenShapes: readonly (readonly [string, RegExp])[] = [
  ["a database URL", /postgres(?:ql)?:\/\//i],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_)/],
  [
    "an AI Account's canary credential",
    /pen-test-canary-(?:anthropic|xai|gemini|openai)-/,
  ],
  ["a forbidden setting", new RegExp(`"(?:${forbiddenSettings.join("|")})"`)],
];

/** One of the package's credentials, with what it is for. */
export interface PackagedPassword {
  readonly id: string;
  readonly name: string;
  readonly password: string;
}

export interface PackagedKey {
  readonly id: string;
  readonly name: string;
  readonly access: GatewayKeyAccess;
  readonly key: string;
}

/** The credentials package, as the file holds it. */
export interface CredentialsPackage {
  readonly about: string;
  readonly mintedAt: string;
  /** Where the red team uses the credentials. */
  readonly stack: {
    /** The web app and API: the Owner password and the UI-capable API key. */
    readonly url: string;
    /** The AI Gateway, where the Gateway Key is presented. */
    readonly gatewayUrl: string;
  };
  /** The read-only source: this repository at the pinned commit. */
  readonly source: { readonly commit: string; readonly access: "read-only" };
  readonly credentials: {
    readonly ownerPassword: PackagedPassword;
    readonly uiApiKey: PackagedKey;
    readonly gatewayKey: PackagedKey;
  };
  /** The seeded Floor and fixture IDs (E2's fixture ID listing). */
  readonly fixtures: FixtureListing;
}

/** Thrown with what to do, rather than a stack trace. */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

/** Where the package's credentials are minted and revoked. */
export interface CredentialStores {
  readonly auth: Pick<
    AuthStore,
    | "passwordHash"
    | "ownerPasswords"
    | "addOwnerPassword"
    | "deleteOwnerPassword"
  >;
  readonly gatewayKeys: Pick<
    GatewayKeys,
    "list" | "createOwnerToolKey" | "revoke"
  >;
}

/** A new password: 32 characters, 192 random bits, a passphrase by length. */
export const newRedTeamPassword = (): string =>
  randomBytes(24).toString("base64url");

/** The package's credentials in the stack now, by name. */
async function inStack(stores: CredentialStores): Promise<{
  readonly passwords: OwnerPasswordRecord[];
  readonly keys: GatewayKeyInfo[];
}> {
  const passwords = (await stores.auth.ownerPasswords()).filter(
    ({ name }) => name === redTeamPasswordName,
  );
  // `list` gives only the keys in use.
  const keys = (await stores.gatewayKeys.list()).filter(
    ({ kind, name }) =>
      kind === "owner_tool" && (name === uiKeyName || name === gatewayKeyName),
  );
  return { passwords, keys };
}

/** The credentials minted, in clear: only ever written to the package. */
export interface MintedCredentials {
  readonly ownerPassword: PackagedPassword;
  readonly uiApiKey: PackagedKey;
  readonly gatewayKey: PackagedKey;
  readonly mintedAt: Date;
}

/**
 * Mints the package's credentials in the stack: a further Owner password
 * for the red team, a UI-capable API key and a Gateway Key. It refuses
 * before the Owner has set the stack's password (the setup screen would
 * still be open, H4), and while any of them is still in use: one of each,
 * revoked before the next are minted.
 */
export async function mintCredentials(options: {
  readonly stores: CredentialStores;
  readonly hashPassword: (password: string) => Promise<string>;
  readonly newPassword?: () => string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}): Promise<MintedCredentials> {
  const { stores } = options;
  const now = options.now ?? (() => new Date());
  if ((await stores.auth.passwordHash()) === undefined) {
    throw new CredentialsError(
      "The pen-test stack has no Owner password yet: open it and set one on the setup screen, then mint the credentials package.",
    );
  }
  const current = await inStack(stores);
  const inUse = [
    ...current.passwords.map(({ name }) => `the Owner password "${name}"`),
    ...current.keys.map(({ name }) => `the key "${name}"`),
  ];
  if (inUse.length > 0) {
    throw new CredentialsError(
      `The red team's credentials are already minted (${inUse.join(", ")}): revoke them before minting new ones.`,
    );
  }

  const mintedAt = now();
  const password = (options.newPassword ?? newRedTeamPassword)();
  const record: OwnerPasswordRecord = {
    id: (options.newId ?? randomUUID)(),
    name: redTeamPasswordName,
    nickname: "Red team",
    timeZone: "UTC",
    passwordHash: await options.hashPassword(password),
    createdAt: mintedAt,
    lastUsedAt: null,
  };
  await stores.auth.addOwnerPassword(record);
  const ui = await stores.gatewayKeys.createOwnerToolKey(
    uiKeyName,
    "proxy_and_ui",
  );
  const gateway = await stores.gatewayKeys.createOwnerToolKey(
    gatewayKeyName,
    "proxy",
  );
  return {
    ownerPassword: { id: record.id, name: record.name, password },
    uiApiKey: {
      id: ui.gatewayKey.id,
      name: ui.gatewayKey.name,
      access: "proxy_and_ui",
      key: ui.key,
    },
    gatewayKey: {
      id: gateway.gatewayKey.id,
      name: gateway.gatewayKey.name,
      access: "proxy",
      key: gateway.key,
    },
    mintedAt,
  };
}

/** What revocation did, and what else was made while the package was out. */
export interface Revocation {
  /** One line per credential revoked, by name and id. */
  readonly revoked: string[];
  /**
   * Owner passwords and Owner tools' keys made since the package was
   * minted, which are not the package's: what the red team may have made
   * with it (H5), for the Owner to look at.
   */
  readonly madeSince: string[];
}

/**
 * Revokes the package's credentials: removes the red team's Owner password
 * (its sessions go with it) and revokes both keys (sessions an API key
 * began are refused from their next request). Running it again revokes
 * nothing more.
 */
export async function revokeCredentials(
  stores: CredentialStores,
): Promise<Revocation> {
  const current = await inStack(stores);
  const since = Math.min(
    ...current.passwords.map(({ createdAt }) => createdAt.getTime()),
    ...current.keys.map(({ createdAt }) => createdAt.getTime()),
  );
  const ours = new Set([
    ...current.passwords.map(({ id }) => id),
    ...current.keys.map(({ id }) => id),
  ]);

  const revoked: string[] = [];
  for (const { id, name } of current.passwords) {
    if (await stores.auth.deleteOwnerPassword(id)) {
      revoked.push(`the Owner password "${name}" (${id}), and its sessions`);
    }
  }
  for (const { id, name, access } of current.keys) {
    await stores.gatewayKeys.revoke(id);
    revoked.push(
      `${access === "proxy_and_ui" ? "the UI-capable API key" : "the Gateway Key"} "${name}" (${id})`,
    );
  }

  const madeSince = Number.isFinite(since)
    ? [
        ...(await stores.auth.ownerPasswords())
          .filter(
            ({ id, createdAt }) =>
              !ours.has(id) && createdAt.getTime() >= since,
          )
          .map(({ id, name }) => `the Owner password "${name}" (${id})`),
        ...(await stores.gatewayKeys.list())
          .filter(
            ({ id, kind, createdAt }) =>
              kind === "owner_tool" &&
              !ours.has(id) &&
              createdAt.getTime() >= since,
          )
          .map(({ id, name }) => `the key "${name}" (${id})`),
      ]
    : [];
  return { revoked, madeSince };
}

/** The package: the minted credentials, where to use them, the fixtures. */
export function credentialsPackage(
  minted: MintedCredentials,
  options: {
    readonly url: string;
    readonly gatewayUrl: string;
    readonly commit: string;
    readonly fixtures: FixtureListing;
  },
): CredentialsPackage {
  return {
    about:
      "The pen-test stack's credentials package (docs/pen-testing/credentials-package.md). Handed over out of band; never pasted into an issue, a commit, a chat, an email or a log. Revoked at the end of the window and destroyed at teardown.",
    mintedAt: minted.mintedAt.toISOString(),
    stack: { url: options.url, gatewayUrl: options.gatewayUrl },
    source: { commit: options.commit, access: "read-only" },
    credentials: {
      ownerPassword: minted.ownerPassword,
      uiApiKey: minted.uiApiKey,
      gatewayKey: minted.gatewayKey,
    },
    fixtures: options.fixtures,
  };
}

/**
 * The values the package must never hold, from `env`: each forbidden
 * setting that is set, and the database password in DATABASE_URL.
 */
export function forbiddenValues(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const values: string[] = forbiddenSettings
    .map((key) => env[key] ?? "")
    .filter((value) => value !== "");
  const databaseUrl = env["DATABASE_URL"] ?? "";
  if (databaseUrl !== "") {
    try {
      const password = decodeURIComponent(new URL(databaseUrl).password);
      if (password !== "") {
        values.push(password);
      }
    } catch {
      // Not a URL: nothing to take from it.
    }
  }
  return values;
}

/**
 * Why `credentials` may not be handed over, if it may not: exactly the
 * allowed credentials, each of its kind, and nothing forbidden anywhere in
 * it. The problems name what is wrong, never a value.
 */
export function packageProblems(
  credentials: CredentialsPackage,
  forbidden: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const names = Object.keys(credentials.credentials).sort();
  if (names.join() !== [...allowedCredentials].sort().join()) {
    problems.push(
      `It holds the credentials ${names.join(", ")}; it holds exactly ${allowedCredentials.join(", ")}.`,
    );
  }
  const { ownerPassword, uiApiKey, gatewayKey } = credentials.credentials;
  if (uiApiKey.access !== "proxy_and_ui") {
    problems.push("Its UI-capable API key has no UI access.");
  }
  if (gatewayKey.access !== "proxy") {
    problems.push("Its Gateway Key may do more than call models.");
  }
  if (
    ownerPassword.password === "" ||
    uiApiKey.key === "" ||
    gatewayKey.key === ""
  ) {
    problems.push("One of its credentials is empty.");
  }
  const text = JSON.stringify(credentials);
  for (const [what, shape] of forbiddenShapes) {
    if (shape.test(text)) {
      problems.push(`It holds ${what}.`);
    }
  }
  if (forbidden.some((value) => value.length > 0 && text.includes(value))) {
    problems.push(
      `It holds the value of one of ${forbiddenSettings.join(", ")}.`,
    );
  }
  return problems;
}

/**
 * Writes the package to `path` with 0600 permissions, only if it passes
 * `packageProblems`, and never over a file already there.
 */
export function writeCredentialsPackage(
  path: string,
  credentials: CredentialsPackage,
  forbidden: readonly string[] = [],
): void {
  const problems = packageProblems(credentials, forbidden);
  if (problems.length > 0) {
    throw new CredentialsError(
      `The credentials package was not written:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }
  try {
    writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw new CredentialsError(
        `${path} is already there: revoke its credentials, or hand that one over.`,
      );
    }
    throw error;
  }
  // The mode given is masked by the umask, which can only take bits away;
  // set it outright all the same, and check it.
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new CredentialsError(`${path} could not be made 0600.`);
  }
}

/**
 * `mint` or `revoke`, as the `credentials` service runs them
 * (`credentials-cli.ts`). `mint` reads PACKAGE_FILE, FIXTURES_FILE,
 * PUBLIC_URL and PINNED_COMMIT from `env`, and refuses to hand over any
 * value of `env`'s forbidden settings. What it says (`log`) names each
 * credential by its name and id, never the credential.
 */
export async function runCredentials(
  command: "mint" | "revoke",
  options: {
    readonly stores: CredentialStores;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly hashPassword: (password: string) => Promise<string>;
    readonly log: (line: string) => void;
  },
): Promise<void> {
  const { stores, env, log } = options;
  const setting = (name: string): string => {
    const value = env[name] ?? "";
    if (value === "") {
      throw new CredentialsError(`${name} is not set.`);
    }
    return value;
  };

  if (command === "revoke") {
    const { revoked, madeSince } = await revokeCredentials(stores);
    if (revoked.length === 0) {
      log("None of the credentials package's credentials is in use.");
    }
    for (const line of revoked) {
      log(`Revoked ${line}.`);
    }
    for (const line of madeSince) {
      log(
        `Made since the package was minted, and not revoked: ${line}. Look at it in API Key Management.`,
      );
    }
    return;
  }

  const packageFile = setting("PACKAGE_FILE");
  const url = setting("PUBLIC_URL");
  const commit = setting("PINNED_COMMIT");
  const fixtures = JSON.parse(
    readFileSync(setting("FIXTURES_FILE"), "utf8"),
  ) as FixtureListing;
  const minted = await mintCredentials({
    stores,
    hashPassword: options.hashPassword,
  });
  try {
    writeCredentialsPackage(
      packageFile,
      credentialsPackage(minted, {
        url,
        gatewayUrl: "http://sandbox-relay:3047",
        commit,
        fixtures,
      }),
      forbiddenValues(env),
    );
  } catch (error) {
    // Nothing was handed over, so nothing minted stays in use.
    await revokeCredentials(stores);
    throw error;
  }
  log(
    `Minted the Owner password "${minted.ownerPassword.name}" (${minted.ownerPassword.id}).`,
  );
  log(
    `Minted the UI-capable API key "${minted.uiApiKey.name}" (${minted.uiApiKey.id}).`,
  );
  log(
    `Minted the Gateway Key "${minted.gatewayKey.name}" (${minted.gatewayKey.id}).`,
  );
  log(`Wrote the credentials package, 0600, to ${packageFile}.`);
}
