import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createEncryptor,
  DecryptionError,
  encryptorFromKey,
  parseEncryptionKey,
  encryptorFromVersionedKey,
  parseVersionedEncryptionKey,
} from "./crypto.ts";

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const secret = "an AI Account credential, correct horse battery staple";

/** Replaces the part at `index` of a sealed value. */
const withPart = (sealed: string, index: number, part: string): string => {
  const parts = sealed.split(":");
  parts[index] = part;
  return parts.join(":");
};

/** Flips one bit in the base64url part at `index`. */
const flipBit = (sealed: string, index: number): string => {
  const bytes = Buffer.from(sealed.split(":")[index] ?? "", "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return withPart(sealed, index, bytes.toString("base64url"));
};

describe("encryption round trip", () => {
  const encryptor = encryptorFromKey(key1);

  it.each([
    ["a credential", secret],
    ["an empty string", ""],
    ["Unicode", "pässwörd 🔑 秘密"],
    [
      "a PEM key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    ],
    ["a large body", "x".repeat(1_000_000)],
  ])("returns %s unchanged", (_, plaintext) => {
    expect(encryptor.decrypt(encryptor.encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips with a context", () => {
    const sealed = encryptor.encrypt(secret, "ai_account.credential:7");
    expect(encryptor.decrypt(sealed, "ai_account.credential:7")).toBe(secret);
  });

  it("never contains the plaintext and is tagged with its key version", () => {
    const sealed = encryptor.encrypt(secret);
    expect(sealed).not.toContain(secret);
    expect(sealed).toMatch(/^aio1:1:[\w-]{16}:[\w-]+:[\w-]{22}$/);
    expect(encryptor.keyVersionOf(sealed)).toBe(1);
  });

  it("uses a fresh IV each time", () => {
    const sealed = new Set(
      Array.from({ length: 100 }, () => encryptor.encrypt(secret)),
    );
    expect(sealed.size).toBe(100);
  });
});

describe("tampering", () => {
  const encryptor = encryptorFromKey(key1);
  const sealed = encryptor.encrypt(secret, "context");

  it.each([
    ["the IV", 2],
    ["the ciphertext", 3],
    ["the tag", 4],
  ])("a flipped bit in %s fails to decrypt", (_, index) => {
    expect(() => encryptor.decrypt(flipBit(sealed, index), "context")).toThrow(
      DecryptionError,
    );
  });

  it("a truncated tag fails to decrypt", () => {
    const tag = sealed.split(":")[4] ?? "";
    expect(() =>
      encryptor.decrypt(withPart(sealed, 4, tag.slice(0, 10)), "context"),
    ).toThrow(DecryptionError);
  });

  it("truncated ciphertext fails to decrypt", () => {
    const ciphertext = sealed.split(":")[3] ?? "";
    expect(() =>
      encryptor.decrypt(
        withPart(sealed, 3, ciphertext.slice(0, -2)),
        "context",
      ),
    ).toThrow(DecryptionError);
  });

  it("the wrong context fails to decrypt", () => {
    expect(() => encryptor.decrypt(sealed, "another field")).toThrow(
      DecryptionError,
    );
    expect(() => encryptor.decrypt(sealed)).toThrow(DecryptionError);
  });

  it("the wrong key fails to decrypt", () => {
    expect(() => encryptorFromKey(key2).decrypt(sealed, "context")).toThrow(
      DecryptionError,
    );
  });

  it("a relabelled key version fails to decrypt, even when the key exists", () => {
    // Both versions hold the same key, so only the authenticated version
    // number can catch the relabelling.
    const both = createEncryptor({
      keys: new Map([
        [1, key1],
        [2, key1],
      ]),
      currentKeyVersion: 1,
    });
    const relabelled = withPart(both.encrypt(secret), 1, "2");
    expect(() => both.decrypt(relabelled)).toThrow(DecryptionError);
  });

  it.each([
    "",
    "not sealed",
    secret,
    "aio1:1:abc",
    "aio2:1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA",
    "aio1:0:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA",
    "aio1:x:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA",
    "aio1:1:AAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA",
    "aio1:1:AAAAAAAAAAAAAAAA:AA+A:AAAAAAAAAAAAAAAAAAAAAA",
    "aio1:1:AAAAAAAAAAAAAAAA:AAAA:AAAAAAAAAAAAAAAAAAAAAA:extra",
  ])("a malformed value (%j) fails to decrypt", (value) => {
    expect(() => encryptor.decrypt(value)).toThrow(DecryptionError);
  });

  it("never puts the plaintext or the key in the error", () => {
    let message = "";
    try {
      encryptorFromKey(key2).decrypt(sealed, "context");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Cannot decrypt/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(key1.toString("base64"));
    expect(message).not.toContain(key2.toString("base64"));
  });
});

describe("key versions", () => {
  it("opens values sealed with an earlier key and seals new ones with the current key", () => {
    const old = encryptorFromKey(key1);
    const sealedWithV1 = old.encrypt(secret);

    const rotated = createEncryptor({
      keys: new Map([
        [1, key1],
        [2, key2],
      ]),
      currentKeyVersion: 2,
    });
    expect(rotated.decrypt(sealedWithV1)).toBe(secret);

    const sealedWithV2 = rotated.encrypt(secret);
    expect(rotated.keyVersionOf(sealedWithV2)).toBe(2);
    expect(rotated.decrypt(sealedWithV2)).toBe(secret);
    expect(() => old.decrypt(sealedWithV2)).toThrow(/no key for key version 2/);
  });

  it("refuses a current version with no key", () => {
    expect(() =>
      createEncryptor({ keys: new Map([[1, key1]]), currentKeyVersion: 2 }),
    ).toThrow(/no key for the current key version 2/);
  });

  it.each([
    ["a short key", new Map([[1, randomBytes(16)]])],
    ["version 0", new Map([[0, key1]])],
    ["a fractional version", new Map([[1.5, key1]])],
  ])("refuses %s", (_, keys) => {
    expect(() => createEncryptor({ keys, currentKeyVersion: 1 })).toThrow();
  });
});

describe("parseEncryptionKey", () => {
  it("decodes 32 base64-encoded bytes", () => {
    expect(parseEncryptionKey(key1.toString("base64"))).toEqual(key1);
  });

  it.each([
    ["16 bytes", randomBytes(16).toString("base64")],
    ["64 bytes", randomBytes(64).toString("base64")],
    ["hex", key1.toString("hex")],
    ["base64url", Buffer.alloc(32, 0xfb).toString("base64url")],
    ["text", "correct horse battery staple correct horse"],
    ["empty", ""],
  ])("refuses %s", (_, value) => {
    expect(() => parseEncryptionKey(value)).toThrow(/32 random bytes/);
  });
});

describe("parseVersionedEncryptionKey (pen-testing G1-9)", () => {
  it("reads a key alone as key version 1, and <version>:<key> as that version", () => {
    expect(parseVersionedEncryptionKey(key1.toString("base64"))).toEqual({
      version: 1,
      key: key1,
    });
    expect(parseVersionedEncryptionKey(`2:${key2.toString("base64")}`)).toEqual(
      { version: 2, key: key2 },
    );
    expect(
      parseVersionedEncryptionKey(`123456789:${key2.toString("base64")}`)
        .version,
    ).toBe(123456789);
  });

  it.each([
    ["version 0", `0:${key1.toString("base64")}`, /key version/],
    ["a negative version", `-1:${key1.toString("base64")}`, /key version/],
    [
      "a version that is not a number",
      `v2:${key1.toString("base64")}`,
      /key version/,
    ],
    [
      "no version before the colon",
      `:${key1.toString("base64")}`,
      /key version/,
    ],
    [
      "a version too long to seal",
      `1234567890:${key1.toString("base64")}`,
      /key version/,
    ],
    [
      "a short key",
      `2:${randomBytes(16).toString("base64")}`,
      /32 random bytes/,
    ],
    ["two versions", `2:3:${key1.toString("base64")}`, /32 random bytes/],
  ])("refuses %s, never saying the key", (_, value, why) => {
    let message = "";
    try {
      parseVersionedEncryptionKey(value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(why);
    expect(message).not.toContain(key1.toString("base64"));
  });
});

describe("encryptorFromVersionedKey (pen-testing G1-9)", () => {
  it("seals as the key's own version, so the server's keyring opens it", () => {
    const sealed = encryptorFromVersionedKey(
      `2:${key2.toString("base64")}`,
    ).encrypt(secret, "context");
    const keyring = createEncryptor({
      keys: new Map([
        [1, key1],
        [2, key2],
      ]),
      currentKeyVersion: 2,
    });
    expect(keyring.keyVersionOf(sealed)).toBe(2);
    expect(keyring.decrypt(sealed, "context")).toBe(secret);
    expect(
      encryptorFromVersionedKey(key1.toString("base64")).currentKeyVersion,
    ).toBe(1);
  });
});
