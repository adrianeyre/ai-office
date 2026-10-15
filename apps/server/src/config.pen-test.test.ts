import { readFileSync } from "node:fs";

import { createEncryptor, encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import {
  ConfigError,
  developmentSecrets,
  developmentSecretsInUse,
  environmentKeys,
  loadConfig,
  secretValues,
} from "./config.ts";
import { resealValues, sealedColumns } from "./reseal.ts";

// G1 (issue #195), "AI Gateway and credentials", H16: the secrets AI
// Office is started with. `.env.example` ships public sample secrets "so a
// copied `.env` runs in development as it is", and the server only warns
// when it starts with them (`server.ts`, "Using the sample secrets from
// .env.example, which are public"). With the public ENCRYPTION_KEY,
// anyone who reads the database (a backup, a dump) opens every AI Account
// credential, Agent Gateway Key and Connection credential sealed in it.
// These probes read the real `.env.example` and drive the real
// `loadConfig`, and show:
// - G1-8: a deployment beyond localhost loaded with every public sample
//   secret, the database password included, which nothing even named.
//   Fixed (issue #283): served beyond this machine, it refuses them.
// - G1-9: ENCRYPTION_KEY could not be rotated: the server was configured
//   with one key, though the sealed format carries a key version for it.
//   Fixed (issue #285): RETIRED_ENCRYPTION_KEYS beside a new, versioned
//   ENCRYPTION_KEY, and what they sealed is sealed again when it starts.
// And keep holding: secrets are sealed with AES-256-GCM, bound to their
// key version and field; and the configured secrets are the logger's.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/G1.md.

/** `.env.example`'s values, as a copied `.env` gives them. */
const example: Record<string, string> = Object.fromEntries(
  readFileSync(new URL("../../../.env.example", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);

/** The example as an Office served beyond this machine would run it. */
const exposed = {
  ...example,
  HOST: "0.0.0.0",
  PUBLIC_URL: "https://ai-office.example.com",
  TRUST_PROXY: "1",
  // TRUST_PROXY is taken only with it (A1-1, after this probe).
  PROXY_SECRET: "fake-pen-test-proxy-secret-000000000000000",
};

/** Secrets of the Owner's own, none of them `.env.example`'s. */
const ownSecrets = {
  SESSION_SECRET: "fake-pen-test-own-session-secret-00000000000",
  ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
  DATABASE_URL: "postgres://ai_office:fake-own-db-pass-0000@db:3048/ai_office",
};

/** The problems `loadConfig` refuses `env` with. */
const refusal = (env: Record<string, string>): readonly string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
};

describe("G1-8 (H16): the public sample secrets", () => {
  it("regression (G1-8): an Office served beyond localhost no longer loads with .env.example's secrets, and the database password is named among them", () => {
    expect(example["SESSION_SECRET"]).toBe(developmentSecrets.SESSION_SECRET);
    expect(example["ENCRYPTION_KEY"]).toBe(developmentSecrets.ENCRYPTION_KEY);
    expect(example["POSTGRES_PASSWORD"]).toBe(
      developmentSecrets.POSTGRES_PASSWORD,
    );
    expect(new URL(example["DATABASE_URL"] ?? "").password).toBe(
      developmentSecrets.POSTGRES_PASSWORD,
    );
    // What it once warned about and went on with, it now refuses, naming
    // each secret (the database password too) and never its value.
    const problems = refusal(exposed);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^SESSION_SECRET is the public sample/);
    expect(problems[1]).toMatch(/^ENCRYPTION_KEY is the public sample/);
    // Leaving it keeps what it sealed (G1-9).
    expect(problems[1]).toContain(
      "move it to RETIRED_ENCRYPTION_KEYS beside the new key, written as 2:<the new key>",
    );
    expect(problems[2]).toMatch(
      /^POSTGRES_PASSWORD \(the password in DATABASE_URL\) is the public sample/,
    );
    for (const problem of problems) {
      expect(problem).toContain("(HOST, PUBLIC_URL, TRUST_PROXY)");
      for (const value of Object.values(developmentSecrets)) {
        expect(problem).not.toContain(value);
      }
    }
    // On this machine, as copied, it still runs, and the warning names the
    // database password too.
    expect(developmentSecretsInUse(loadConfig(example))).toEqual([
      "SESSION_SECRET",
      "ENCRYPTION_KEY",
      "POSTGRES_PASSWORD",
    ]);
  });

  it("G1-8: an Office served beyond localhost does not start with .env.example's public secrets", () => {
    expect(() => loadConfig(exposed)).toThrow();
  });

  it("G1-8: each public secret alone is refused, by each way of serving AI Office beyond this machine", () => {
    const beyond: [string, Record<string, string>][] = [
      ["HOST", { HOST: "0.0.0.0" }],
      ["HOST", { HOST: "::" }],
      ["HOST", { HOST: "192.168.1.20" }],
      ["HOST", { HOST: "office.lan" }],
      // Under compose: HOST is the container's own, and the port is
      // published on AI_OFFICE_BIND_ADDRESS.
      ["PUBLISHED_ADDRESS", { HOST: "0.0.0.0", PUBLISHED_ADDRESS: "0.0.0.0" }],
      ["PUBLIC_URL", { PUBLIC_URL: "https://ai-office.example.com" }],
      ["PUBLIC_URL", { PUBLIC_URL: "http://10.0.0.5:3045" }],
      ["TRUST_PROXY", { TRUST_PROXY: "1", PROXY_SECRET: exposed.PROXY_SECRET }],
    ];
    const samples: [string, Record<string, string>][] = [
      ["SESSION_SECRET", { SESSION_SECRET: developmentSecrets.SESSION_SECRET }],
      ["ENCRYPTION_KEY", { ENCRYPTION_KEY: developmentSecrets.ENCRYPTION_KEY }],
      [
        "POSTGRES_PASSWORD",
        {
          // As compose builds it from POSTGRES_PASSWORD.
          DATABASE_URL: `postgres://ai_office:${developmentSecrets.POSTGRES_PASSWORD}@postgres:3048/ai_office`,
        },
      ],
    ];
    for (const [setting, served] of beyond) {
      // With the Owner's own secrets it starts.
      expect(() => loadConfig({ ...ownSecrets, ...served })).not.toThrow();
      for (const [secret, sample] of samples) {
        const problems = refusal({ ...ownSecrets, ...served, ...sample });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(new RegExp(`^${secret}\\b`));
        expect(problems[0]).toContain(`(${setting})`);
      }
    }
  });

  it("G1-8: on this machine alone the samples still run, as `pnpm dev` and compose's defaults use them", () => {
    const local: Record<string, string>[] = [
      // pnpm dev, as copied.
      {},
      { HOST: "localhost", PUBLIC_URL: "http://127.0.0.1:3045" },
      { HOST: "::1", PUBLIC_URL: "http://[::1]:3045" },
      { PUBLIC_URL: "http://office.localhost:3045" },
      // Compose, as copied: listening on every interface of its container,
      // published on the host's loopback.
      { HOST: "0.0.0.0", PUBLISHED_ADDRESS: "127.0.0.1" },
    ];
    for (const settings of local) {
      const config = loadConfig({ ...example, ...settings });
      expect(developmentSecretsInUse(config)).toHaveLength(3);
    }
  });
});

describe("G1-9 (H16): rotating ENCRYPTION_KEY", () => {
  const previous = Buffer.alloc(32, 3);
  const next = Buffer.alloc(32, 4);

  it("the sealed format is ready for it: values carry their key version, and a keyring opens each with its own", () => {
    const old = createEncryptor({
      keys: new Map([[1, previous]]),
      currentKeyVersion: 1,
    });
    const sealed = old.encrypt("a credential", "field:1");
    const ring = createEncryptor({
      keys: new Map([
        [1, previous],
        [2, next],
      ]),
      currentKeyVersion: 2,
    });
    expect(ring.keyVersionOf(sealed)).toBe(1);
    expect(ring.decrypt(sealed, "field:1")).toBe("a credential");
    expect(ring.keyVersionOf(ring.encrypt("a credential", "field:1"))).toBe(2);
  });

  it("regression (G1-9): the server is configured with every key, the new one as a version of its own, and a value sealed with the previous key still opens", () => {
    expect(environmentKeys.filter((key) => key.includes("ENCRYPTION"))).toEqual(
      ["ENCRYPTION_KEY", "RETIRED_ENCRYPTION_KEYS"],
    );
    // Sealed by the Office before the rotation: its one key, as version 1.
    const sealed = encryptorFromKey(previous).encrypt("a credential", "f:1");
    const config = loadConfig({
      ...example,
      ENCRYPTION_KEY: `2:${next.toString("base64")}`,
      RETIRED_ENCRYPTION_KEYS: previous.toString("base64"),
    });
    // As `startServer` builds it.
    const encryptor = createEncryptor(config.encryptionKeyring);
    expect(encryptor.currentKeyVersion).toBe(2);
    expect(encryptor.decrypt(sealed, "f:1")).toBe("a credential");
    expect(
      encryptor.keyVersionOf(encryptor.encrypt("a credential", "f:1")),
    ).toBe(2);
    // Without the retired key, as before, it would not open: that is what
    // the key beside it is for.
    expect(() =>
      createEncryptor({
        keys: new Map([[2, next]]),
        currentKeyVersion: 2,
      }).decrypt(sealed, "f:1"),
    ).toThrow(/no key for key version 1/);
  });

  it("G1-9: the server's configuration can carry a retired ENCRYPTION_KEY beside the current one, so a rotation keeps sealed values readable", () => {
    // Whatever it is called: a second variable naming an encryption key.
    expect(
      environmentKeys.filter((key) => key.includes("ENCRYPTION")).length,
    ).toBeGreaterThan(1);
  });

  it("G1-9: once AI Office has started beside the retired key, every value is the new key's, and opens with it alone", async () => {
    const credential = sealedColumns[0];
    if (credential === undefined) {
      throw new Error("no sealed column");
    }
    const old = encryptorFromKey(previous);
    const rows: Record<string, string> = {
      "account-1": old.encrypt(
        "sk-ant-api03-anaiaccountcredential-0000000000",
        credential.context("account-1"),
      ),
    };
    const config = loadConfig({
      ...example,
      ENCRYPTION_KEY: `2:${next.toString("base64")}`,
      RETIRED_ENCRYPTION_KEYS: previous.toString("base64"),
    });
    await resealValues({
      encryptor: createEncryptor(config.encryptionKeyring),
      columns: [credential],
      store: {
        notSealedAs: (_column, version) =>
          Promise.resolve(
            Object.entries(rows)
              .filter(
                ([, value]) => !value.startsWith(`aio1:${String(version)}:`),
              )
              .map(([key, value]) => ({ key, value })),
          ),
        replace: (_column, key, previousValue, value) => {
          const same = rows[key] === previousValue;
          if (same) {
            rows[key] = value;
          }
          return Promise.resolve(same);
        },
      },
    });
    // The retired key can go.
    const newKeyAlone = loadConfig({
      ...example,
      ENCRYPTION_KEY: `2:${next.toString("base64")}`,
    });
    expect(
      createEncryptor(newKeyAlone.encryptionKeyring).decrypt(
        rows["account-1"] ?? "",
        credential.context("account-1"),
      ),
    ).toBe("sk-ant-api03-anaiaccountcredential-0000000000");
  });

  it("G1-9: a rotation that would leave two keys one version, or the new key not the newest, is refused, naming no key", () => {
    const write = (version: number | undefined, key: Buffer) =>
      version === undefined
        ? key.toString("base64")
        : `${String(version)}:${key.toString("base64")}`;
    const cases: [string, Record<string, string>, RegExp][] = [
      [
        "the new key without a version of its own",
        {
          ENCRYPTION_KEY: write(undefined, next),
          RETIRED_ENCRYPTION_KEYS: write(undefined, previous),
        },
        /ENCRYPTION_KEY's key version must be after every retired one: write it as 2:<the new key>/,
      ],
      [
        "a new key older than a retired one",
        {
          ENCRYPTION_KEY: write(2, next),
          RETIRED_ENCRYPTION_KEYS: write(3, previous),
        },
        /write it as 4:<the new key>/,
      ],
      [
        "two retired keys as one version",
        {
          ENCRYPTION_KEY: write(3, next),
          RETIRED_ENCRYPTION_KEYS: `${write(1, previous)},${write(1, Buffer.alloc(32, 6))}`,
        },
        /RETIRED_ENCRYPTION_KEYS must give each key a key version of its own/,
      ],
      [
        "the new key among the retired ones",
        {
          ENCRYPTION_KEY: write(2, next),
          RETIRED_ENCRYPTION_KEYS: write(1, next),
        },
        /RETIRED_ENCRYPTION_KEYS must not hold ENCRYPTION_KEY/,
      ],
      [
        "a retired key that is not a key",
        {
          ENCRYPTION_KEY: write(2, next),
          RETIRED_ENCRYPTION_KEYS: "not-a-key-0000",
        },
        /RETIRED_ENCRYPTION_KEYS must be the keys ENCRYPTION_KEY replaced/,
      ],
    ];
    for (const [, env, why] of cases) {
      let message = "";
      try {
        loadConfig({ ...example, ...env });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(why);
      for (const key of [next, previous]) {
        expect(message).not.toContain(key.toString("base64"));
      }
    }
    // Several retired keys, each its own version, all open.
    const config = loadConfig({
      ...example,
      ENCRYPTION_KEY: write(3, next),
      RETIRED_ENCRYPTION_KEYS: `${write(undefined, previous)}, ${write(2, Buffer.alloc(32, 6))}`,
    });
    expect([...config.encryptionKeyring.keys.keys()].sort()).toEqual([1, 2, 3]);
  });

  it("G1-8 and G1-9 agree: the public sample key is refused as ENCRYPTION_KEY beyond this machine, but is how an Office leaves it, as a retired key", () => {
    const leaving = loadConfig({
      ...exposed,
      ...ownSecrets,
      ENCRYPTION_KEY: `2:${next.toString("base64")}`,
      RETIRED_ENCRYPTION_KEYS: developmentSecrets.ENCRYPTION_KEY,
    });
    expect(leaving.encryptionKeyring.keys.size).toBe(2);
    expect(developmentSecretsInUse(leaving)).toEqual([]);
    // Even under a version of its own, it is still the public key.
    expect(
      refusal({
        ...exposed,
        ...ownSecrets,
        ENCRYPTION_KEY: `2:${developmentSecrets.ENCRYPTION_KEY}`,
        RETIRED_ENCRYPTION_KEYS: next.toString("base64"),
      }),
    ).toEqual([expect.stringMatching(/^ENCRYPTION_KEY is the public sample/)]);
  });
});

describe("secrets at rest and in logs", () => {
  it("a sealed value is bound to its key version and its field: it opens in no other", () => {
    const encryptor = encryptorFromKey(Buffer.alloc(32, 5));
    const sealed = encryptor.encrypt(
      "sk-ant-api03-anaiaccountcredential-0000000000",
      "ai_account.credential:account-1",
    );
    const [format, version, iv, ciphertext, tag] = sealed.split(":");
    expect([format, version]).toEqual(["aio1", "1"]);
    expect(Buffer.from(iv ?? "", "base64url")).toHaveLength(12);
    expect(Buffer.from(tag ?? "", "base64url")).toHaveLength(16);
    expect(sealed).not.toContain("anaiaccountcredential");
    for (const context of [
      "ai_account.credential:account-2",
      "ai_account.refresh_token:account-1",
      "",
    ]) {
      expect(() => encryptor.decrypt(sealed, context)).toThrow();
    }
    // Relabelled to another key version, or its ciphertext changed.
    expect(() =>
      encryptor.decrypt(
        [format, "2", iv, ciphertext, tag].join(":"),
        "ai_account.credential:account-1",
      ),
    ).toThrow();
    const flipped = Buffer.from(ciphertext ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      encryptor.decrypt(
        [format, version, iv, flipped.toString("base64url"), tag].join(":"),
        "ai_account.credential:account-1",
      ),
    ).toThrow();
  });

  it("every configured secret is one the logger removes (GitHub's, kept in the database, are registered as they are opened)", () => {
    const config = loadConfig(example);
    expect(secretValues(config)).toEqual(
      expect.arrayContaining([
        config.sessionSecret,
        config.encryptionKey.toString("base64"),
        "devpassword",
      ]),
    );
  });
});
