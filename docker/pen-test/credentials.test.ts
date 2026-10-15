// The credentials package (credentials.ts, Enablement E4, #190): against
// memory stores, it mints exactly one Owner password, one UI-capable API key
// and one Gateway Key, each of which works; the package holds exactly those,
// the fixture IDs and the pinned commit, and none of what the red team never
// gets; it is written 0600, never over another; nothing echoes a
// credential; and revocation leaves none of them working. Against a real
// database (in CI, or wherever Docker runs), the `credentials` service's own
// CLI does the same in a process of its own, and prints no credential.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashPassword,
  verifyPassword,
} from "../../apps/server/src/auth/password.ts";
import {
  databaseAuthStore,
  memoryAuthStore,
} from "../../apps/server/src/auth/store.ts";
import { postgresTest } from "../../packages/db/src/testing/postgres.ts";
import {
  createEventBus,
  memoryEventStore,
} from "../../packages/events/src/index.ts";
import {
  createGatewayKeys,
  databaseGatewayKeyStore,
  memoryGatewayKeyStore,
} from "../../packages/gateway/src/index.ts";
import {
  encryptorFromKey,
  parseEncryptionKey,
} from "../../packages/shared/src/crypto.ts";
import { ownerPasswordSchema } from "../../packages/shared/src/index.ts";

import { corpusCanary } from "./corpus.ts";
import {
  allowedCredentials,
  credentialsPackage,
  CredentialsError,
  forbiddenSettings,
  forbiddenValues,
  gatewayKeyName,
  mintCredentials,
  packageProblems,
  redTeamPasswordName,
  revokeCredentials,
  runCredentials,
  uiKeyName,
  writeCredentialsPackage,
  type CredentialsPackage,
  type CredentialStores,
} from "./credentials.ts";
import type { FixtureListing } from "./fixtures.ts";

// Obviously fake values for what the red team never gets.
const fakeEnvironment = {
  ENCRYPTION_KEY: Buffer.from("fake-pen-test-encryption-key-0123").toString(
    "base64",
  ),
  SESSION_SECRET: "fake-pen-test-session-secret-0123456789",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\\nfake-pen-test-app-key\\n-----END RSA PRIVATE KEY-----",
  POSTGRES_PASSWORD: "fake-pen-test-postgres-password",
  DATABASE_URL:
    "postgres://ai_office:fake-pen-test-database-password@postgres:3048/ai_office",
};

const fixtures: FixtureListing = {
  generatedAt: "2026-10-11T12:00:00.000Z",
  targetRepository: "acme/pen-test-target",
  floors: [
    {
      id: "pen-test-target",
      repository: "acme/pen-test-target",
      mergePolicy: "auto_merge",
      agents: [{ id: "a1", name: "Ada", role: "coder", stage: "work" }],
    },
    {
      id: "pen-test-review",
      repository: "acme/pen-test-review",
      mergePolicy: "send_to_me",
      agents: [{ id: "b1", name: "Fin", role: "reviewer", stage: "review" }],
    },
  ],
  aiAccounts: ["Claude (pen-test stub)"],
  corpus: {
    skill: { id: "pen-test-corpus-skill", name: "pen-test-release-helper" },
    template: { id: "pen-test-corpus-template", name: "Pen-test target kit" },
    memoryProposal: { id: 7, floorId: "pen-test-target" },
    items: [
      {
        id: "claude-md",
        kind: "file",
        hypothesis: "H10",
        canary: corpusCanary("claude-md"),
      },
    ],
  },
  issues: [{ id: "issue-override", canary: "x", number: 3 }],
};

const pinnedCommit = "0123456789abcdef0123456789abcdef01234567";

/** The Office as the Owner left it after setup: one password, no keys. */
async function office() {
  const auth = memoryAuthStore({
    passwordHash: await hashPassword("fake-owner-password-for-tests"),
  });
  const gatewayKeys = createGatewayKeys({
    store: memoryGatewayKeyStore(),
    encryptor: encryptorFromKey(
      parseEncryptionKey(randomBytes(32).toString("base64")),
    ),
    events: createEventBus({ store: memoryEventStore() }),
  });
  const stores: CredentialStores = { auth, gatewayKeys };
  return { auth, gatewayKeys, stores };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pen-test-credentials-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Every credential in a package, in clear. */
const secretsOf = (credentials: CredentialsPackage): string[] => [
  credentials.credentials.ownerPassword.password,
  credentials.credentials.uiApiKey.key,
  credentials.credentials.gatewayKey.key,
];

/** Runs `mint` as the `credentials` service does, into `dir`. */
async function mint(
  stores: CredentialStores,
  log: (line: string) => void = () => undefined,
) {
  const fixturesFile = join(dir, "pen-test-fixtures.json");
  writeFileSync(fixturesFile, JSON.stringify(fixtures));
  const packageFile = join(dir, "credentials-package.json");
  await runCredentials("mint", {
    stores,
    env: {
      ...fakeEnvironment,
      PACKAGE_FILE: packageFile,
      FIXTURES_FILE: fixturesFile,
      PUBLIC_URL: "http://localhost:3145",
      PINNED_COMMIT: pinnedCommit,
    },
    hashPassword,
    log,
  });
  return {
    packageFile,
    credentials: JSON.parse(
      readFileSync(packageFile, "utf8"),
    ) as CredentialsPackage,
  };
}

describe("minting", () => {
  it("mints one Owner password, one UI-capable API key and one Gateway Key, each of which works", async () => {
    const { auth, gatewayKeys, stores } = await office();
    const { credentials } = await mint(stores);
    const { ownerPassword, uiApiKey, gatewayKey } = credentials.credentials;

    // A further Owner password, which signs in as any of them does.
    const [stored, ...others] = await auth.ownerPasswords();
    expect(others).toEqual([]);
    expect(stored?.name).toBe(redTeamPasswordName);
    expect(stored?.id).toBe(ownerPassword.id);
    expect(
      await verifyPassword(stored?.passwordHash ?? "", ownerPassword.password),
    ).toBe(true);
    expect(ownerPasswordSchema.safeParse(ownerPassword.password).success).toBe(
      true,
    );
    // Only its hash is kept.
    expect(
      JSON.stringify([...auth.state.ownerPasswords.values()]),
    ).not.toContain(ownerPassword.password);

    // The API key signs in to the web app, and calls models.
    expect((await gatewayKeys.uiKey(uiApiKey.key))?.id).toBe(uiApiKey.id);
    expect(await gatewayKeys.authenticate(uiApiKey.key)).toMatchObject({
      kind: "owner_tool",
      name: uiKeyName,
    });
    // The Gateway Key only calls models.
    expect(await gatewayKeys.uiKey(gatewayKey.key)).toBeUndefined();
    expect(await gatewayKeys.authenticate(gatewayKey.key)).toMatchObject({
      kind: "owner_tool",
      name: gatewayKeyName,
    });
    expect(
      (await gatewayKeys.list()).map(({ name, access }) => [name, access]),
    ).toEqual(
      expect.arrayContaining([
        [uiKeyName, "proxy_and_ui"],
        [gatewayKeyName, "proxy"],
      ]),
    );
    expect(await gatewayKeys.list()).toHaveLength(2);
  });

  it("refuses before the Owner has set the stack's password", async () => {
    const stores: CredentialStores = {
      auth: memoryAuthStore(),
      gatewayKeys: (await office()).gatewayKeys,
    };
    await expect(mintCredentials({ stores, hashPassword })).rejects.toThrow(
      /no Owner password yet/,
    );
    expect(await stores.gatewayKeys.list()).toEqual([]);
  });

  it("refuses while the red team's credentials are in use, and mints new ones once they are revoked", async () => {
    const { stores } = await office();
    const first = await mintCredentials({ stores, hashPassword });
    await expect(mintCredentials({ stores, hashPassword })).rejects.toThrow(
      /already minted .*revoke them/,
    );
    await revokeCredentials(stores);
    const second = await mintCredentials({ stores, hashPassword });
    expect(second.ownerPassword.password).not.toBe(
      first.ownerPassword.password,
    );
    expect(second.uiApiKey.key).not.toBe(first.uiApiKey.key);
    expect(second.gatewayKey.key).not.toBe(first.gatewayKey.key);
  });
});

describe("the package", () => {
  it("holds exactly the allowed credentials, the fixture IDs and the pinned commit, and none of the forbidden ones", async () => {
    const { stores } = await office();
    const { packageFile, credentials } = await mint(stores);
    const text = readFileSync(packageFile, "utf8");

    expect(Object.keys(credentials).sort()).toEqual(
      [
        "about",
        "credentials",
        "fixtures",
        "mintedAt",
        "source",
        "stack",
      ].sort(),
    );
    expect(Object.keys(credentials.credentials).sort()).toEqual(
      [...allowedCredentials].sort(),
    );
    expect(credentials.credentials.uiApiKey.access).toBe("proxy_and_ui");
    expect(credentials.credentials.gatewayKey.access).toBe("proxy");
    expect(credentials.fixtures).toEqual(fixtures);
    expect(credentials.source).toEqual({
      commit: pinnedCommit,
      access: "read-only",
    });
    expect(credentials.stack).toEqual({
      url: "http://localhost:3145",
      gatewayUrl: "http://sandbox-relay:3047",
    });

    // None of what the red team never gets: the stack's secrets, by value
    // or by name, the database URL or its password, a private key, an AI
    // Account's credential or a GitHub token.
    for (const value of Object.values(fakeEnvironment)) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain("fake-pen-test-database-password");
    for (const setting of forbiddenSettings) {
      expect(text).not.toContain(setting);
    }
    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).not.toMatch(/PRIVATE KEY/);
    expect(text).not.toMatch(/pen-test-canary-(anthropic|xai|gemini|openai)-/);
    expect(text).not.toMatch(/\b(gh[pousr]_|github_pat_)/);
    expect(
      packageProblems(credentials, forbiddenValues(fakeEnvironment)),
    ).toEqual([]);
  });

  it("is refused when the database password is a word it holds, as testcontainers' default \"test\" is, and written with a password of the stand-up's kind", async () => {
    // The CLI test's database once had testcontainers' default password,
    // and "Pen-test red team" holds "test": the check was right to refuse.
    // The harness now gives each container a random password, as stand-up
    // gives the stack's database.
    const { stores } = await office();
    const minted = await mintCredentials({ stores, hashPassword });
    const credentials = credentialsPackage(minted, {
      url: "http://localhost:3145",
      gatewayUrl: "http://sandbox-relay:3047",
      commit: pinnedCommit,
      fixtures,
    });
    const databaseUrl = (password: string) => ({
      DATABASE_URL: `postgres://test:${password}@localhost:5432/test_1`,
    });
    expect(JSON.stringify(credentials)).toContain("test");
    expect(
      packageProblems(credentials, forbiddenValues(databaseUrl("test"))),
    ).toEqual([
      `It holds the value of one of ${forbiddenSettings.join(", ")}.`,
    ]);
    expect(
      packageProblems(
        credentials,
        forbiddenValues(databaseUrl(randomBytes(16).toString("hex"))),
      ),
    ).toEqual([]);
  });

  it("is written 0600, and never over a package already there", async () => {
    const { stores } = await office();
    const { packageFile, credentials } = await mint(stores);
    expect(statSync(packageFile).mode & 0o777).toBe(0o600);
    expect(() => {
      writeCredentialsPackage(packageFile, credentials);
    }).toThrow(/already there/);
    expect(readFileSync(packageFile, "utf8")).toBe(
      `${JSON.stringify(credentials, null, 2)}\n`,
    );
  });

  it("refuses to write a package holding anything forbidden, naming it but never its value", async () => {
    const { stores } = await office();
    const minted = await mintCredentials({ stores, hashPassword });
    const good = credentialsPackage(minted, {
      url: "http://localhost:3145",
      gatewayUrl: "http://sandbox-relay:3047",
      commit: pinnedCommit,
      fixtures,
    });
    const forbidden = forbiddenValues(fakeEnvironment);
    expect(forbidden).toContain("fake-pen-test-database-password");
    expect(forbidden).toContain(fakeEnvironment.ENCRYPTION_KEY);

    const withFixtures = (extra: unknown): CredentialsPackage => ({
      ...good,
      fixtures: { ...good.fixtures, extra } as unknown as FixtureListing,
    });
    const bad: [string, CredentialsPackage, RegExp][] = [
      [
        "a further credential",
        {
          ...good,
          credentials: {
            ...good.credentials,
            encryptionKey: "x",
          } as CredentialsPackage["credentials"],
        },
        /holds exactly ownerPassword, uiApiKey, gatewayKey/,
      ],
      [
        "an API key without UI access",
        {
          ...good,
          credentials: {
            ...good.credentials,
            uiApiKey: { ...good.credentials.uiApiKey, access: "proxy" },
          },
        },
        /no UI access/,
      ],
      [
        "a Gateway Key with UI access",
        {
          ...good,
          credentials: {
            ...good.credentials,
            gatewayKey: {
              ...good.credentials.gatewayKey,
              access: "proxy_and_ui",
            },
          },
        },
        /more than call models/,
      ],
      [
        "the encryption key's value",
        withFixtures(fakeEnvironment.ENCRYPTION_KEY),
        /value of one of ENCRYPTION_KEY/,
      ],
      [
        "the session secret's value",
        withFixtures(fakeEnvironment.SESSION_SECRET),
        /value of one of/,
      ],
      [
        "the database password",
        withFixtures("fake-pen-test-database-password"),
        /value of one of/,
      ],
      [
        "a forbidden setting by name",
        withFixtures({ SESSION_SECRET: "x" }),
        /a forbidden setting/,
      ],
      ["a database URL", withFixtures("postgres://u:p@h/d"), /a database URL/],
      [
        "the GitHub App's private key",
        withFixtures(fakeEnvironment.GITHUB_APP_PRIVATE_KEY),
        /a private key/,
      ],
      [
        "an AI Account's canary credential",
        withFixtures("pen-test-canary-anthropic-0123abcd"),
        /canary credential/,
      ],
      [
        "a CI or repository-writing GitHub token",
        withFixtures("ghs_fakefakefakefakefake"),
        /a GitHub token/,
      ],
    ];
    for (const [index, [what, credentials, problem]] of bad.entries()) {
      const problems = packageProblems(credentials, forbidden);
      expect({ what, problems: problems.join(" ") }).toEqual({
        what,
        problems: expect.stringMatching(problem) as string,
      });
      for (const value of [...forbidden, ...secretsOf(good)]) {
        expect(problems.join(" ")).not.toContain(value);
      }
      const path = join(dir, `bad-${String(index)}.json`);
      expect(() => {
        writeCredentialsPackage(path, credentials, forbidden);
      }).toThrow(CredentialsError);
      expect(existsSync(path)).toBe(false);
    }
  });

  it("revokes what it minted when the package cannot be written", async () => {
    const { auth, gatewayKeys, stores } = await office();
    writeFileSync(join(dir, "credentials-package.json"), "already here");
    await expect(mint(stores)).rejects.toThrow(/already there/);
    expect(await auth.ownerPasswords()).toEqual([]);
    expect(await gatewayKeys.list()).toEqual([]);
  });
});

describe("nothing is echoed", () => {
  it("minting and revoking say each credential's name and id, and print no credential anywhere", async () => {
    const { stores } = await office();
    const printed: string[] = [];
    const capture = (chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      });
    }
    const said: string[] = [];
    const { credentials } = await mint(stores, (line) => said.push(line));
    await runCredentials("revoke", {
      stores,
      env: {},
      hashPassword,
      log: (line) => said.push(line),
    });
    vi.restoreAllMocks();

    expect(said).toEqual([
      `Minted the Owner password "${redTeamPasswordName}" (${credentials.credentials.ownerPassword.id}).`,
      `Minted the UI-capable API key "${uiKeyName}" (${credentials.credentials.uiApiKey.id}).`,
      `Minted the Gateway Key "${gatewayKeyName}" (${credentials.credentials.gatewayKey.id}).`,
      `Wrote the credentials package, 0600, to ${join(dir, "credentials-package.json")}.`,
      `Revoked the Owner password "${redTeamPasswordName}" (${credentials.credentials.ownerPassword.id}), and its sessions.`,
      expect.stringMatching(/^Revoked the (UI-capable API key|Gateway Key) /),
      expect.stringMatching(/^Revoked the (UI-capable API key|Gateway Key) /),
    ]);
    const everything = [...said, ...printed].join("\n");
    for (const secret of secretsOf(credentials)) {
      expect(everything).not.toContain(secret);
    }
    // Not even a key's first characters past the prefix.
    expect(everything).not.toMatch(/aio_gk_\w/);
  });
});

describe("revocation", () => {
  it("removes the Owner password with its sessions, and revokes both keys, so none of them works", async () => {
    const { auth, gatewayKeys, stores } = await office();
    const { credentials } = await mint(stores);
    const { ownerPassword, uiApiKey, gatewayKey } = credentials.credentials;
    await auth.createSession({
      id: "a-session-the-red-team-began",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      passwordId: ownerPassword.id,
    });

    const { revoked, madeSince } = await revokeCredentials(stores);
    expect(revoked).toHaveLength(3);
    expect(madeSince).toEqual([]);

    expect(await auth.ownerPasswords()).toEqual([]);
    expect(await auth.findSession("a-session-the-red-team-began")).toBe(
      undefined,
    );
    expect(await gatewayKeys.authenticate(uiApiKey.key)).toBeUndefined();
    expect(await gatewayKeys.uiKey(uiApiKey.key)).toBeUndefined();
    expect(await gatewayKeys.allowsUi(uiApiKey.id)).toBe(false);
    expect(await gatewayKeys.authenticate(gatewayKey.key)).toBeUndefined();
    // The Owner's own password is untouched.
    expect(await auth.passwordHash()).toMatch(/^\$argon2id\$/);

    // A second run revokes nothing more.
    expect(await revokeCredentials(stores)).toEqual({
      revoked: [],
      madeSince: [],
    });
  });

  it("names what else was made while the package was out, and leaves it for the Owner", async () => {
    const { auth, gatewayKeys, stores } = await office();
    await mint(stores);
    await auth.addOwnerPassword({
      id: "made-with-the-package",
      name: "Persistence",
      nickname: "",
      timeZone: "UTC",
      passwordHash: "$argon2id$fake",
      createdAt: new Date(Date.now() + 1000),
      lastUsedAt: null,
    });
    const { gatewayKey } = await gatewayKeys.createOwnerToolKey(
      "Another way in",
      "proxy_and_ui",
    );
    const { madeSince } = await revokeCredentials(stores);
    expect(madeSince).toEqual([
      'the Owner password "Persistence" (made-with-the-package)',
      `the key "Another way in" (${gatewayKey.id})`,
    ]);
    expect((await auth.ownerPasswords()).map(({ name }) => name)).toEqual([
      "Persistence",
    ]);
  });
});

// --- Against a real database, through the CLI ---------------------------------

const run = promisify(execFile);
const cli = join(import.meta.dirname, "credentials-cli.ts");

describe("the credentials CLI, against a database", () => {
  postgresTest(
    "mints and revokes in a process of its own, writing 0600 and printing no credential",
    async ({ database }) => {
      const auth = databaseAuthStore(database.db);
      await auth.createPasswordHash(
        await hashPassword("fake-owner-password-for-tests"),
      );
      const fixturesFile = join(dir, "pen-test-fixtures.json");
      writeFileSync(fixturesFile, JSON.stringify(fixtures));
      const packageFile = join(dir, "credentials-package.json");
      const env = {
        PATH: process.env["PATH"] ?? "",
        DATABASE_URL: database.url,
        PACKAGE_FILE: packageFile,
        FIXTURES_FILE: fixturesFile,
        PUBLIC_URL: "http://localhost:3145",
        PINNED_COMMIT: pinnedCommit,
      };

      const minted = await run("node", [cli, "mint"], { env });
      expect(statSync(packageFile).mode & 0o777).toBe(0o600);
      const credentials = JSON.parse(
        readFileSync(packageFile, "utf8"),
      ) as CredentialsPackage;
      expect(Object.keys(credentials.credentials).sort()).toEqual(
        [...allowedCredentials].sort(),
      );
      expect(packageProblems(credentials, forbiddenValues(env))).toEqual([]);

      const gatewayKeys = createGatewayKeys({
        store: databaseGatewayKeyStore(database.db),
        encryptor: encryptorFromKey(
          parseEncryptionKey(randomBytes(32).toString("base64")),
        ),
        events: createEventBus({ store: memoryEventStore() }),
      });
      const { uiApiKey, gatewayKey } = credentials.credentials;
      expect((await gatewayKeys.uiKey(uiApiKey.key))?.id).toBe(uiApiKey.id);
      expect(await gatewayKeys.authenticate(gatewayKey.key)).toBeDefined();

      const revoked = await run("node", [cli, "revoke"], { env });
      expect(revoked.stdout).toContain("Revoked the Owner password");
      expect(await auth.ownerPasswords()).toEqual([]);
      expect(await gatewayKeys.uiKey(uiApiKey.key)).toBeUndefined();
      expect(await gatewayKeys.authenticate(gatewayKey.key)).toBeUndefined();

      const printed = [
        minted.stdout,
        minted.stderr,
        revoked.stdout,
        revoked.stderr,
      ].join("\n");
      expect(printed).toContain(`Minted the Owner password`);
      for (const secret of secretsOf(credentials)) {
        expect(printed).not.toContain(secret);
      }
      expect(printed).not.toContain(database.url);
    },
  );
});
