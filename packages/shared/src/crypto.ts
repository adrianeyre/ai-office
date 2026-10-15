// Encryption at rest for secret fields (PRD FR-5): AI Account credentials,
// the GitHub App key, Gateway Keys and request bodies. AES-256-GCM, so a
// tampered value fails to decrypt rather than decrypting to garbage.
//
// A sealed value is one ASCII string:
//
//   aio1:<key version>:<iv>:<ciphertext>:<tag>      (each part base64url)
//
// The key version says which key sealed it, so the key can be rotated
// (pen-testing G1-9): new values use the current key, old ones still open
// with the retired key that sealed them until they are re-sealed. The format prefix, the key version and an optional context
// (say, which column and row) are authenticated as associated data, so a
// value cannot be relabelled or moved to another field undetected.
//
// Node-only: import it as `@ai-office/shared/crypto`, never from the web app.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const format = "aio1";
const keyLength = 32;
const ivLength = 12;
const tagLength = 16;

/** Raised for a malformed, tampered or undecryptable value. */
export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`Cannot decrypt a sealed value: ${reason}.`);
    this.name = "DecryptionError";
  }
}

/**
 * Decodes `ENCRYPTION_KEY`: 32 random bytes, base64-encoded (as
 * `openssl rand -base64 32` prints them). Throws when it is anything else.
 */
export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    key.length !== keyLength ||
    key.toString("base64") !== base64
  ) {
    throw new Error(
      `The encryption key must be ${String(keyLength)} random bytes, base64-encoded (openssl rand -base64 32).`,
    );
  }
  return key;
}

/** A key and the version it seals values as. */
export interface VersionedKey {
  readonly version: number;
  readonly key: Buffer;
}

/**
 * Decodes a key as `ENCRYPTION_KEY` (or one of `RETIRED_ENCRYPTION_KEYS`)
 * writes it: the key alone, as key version 1, or `<version>:<key>`. Throws
 * when it is anything else, never saying what it was.
 */
export function parseVersionedEncryptionKey(value: string): VersionedKey {
  const at = value.indexOf(":");
  if (at === -1) {
    return { version: 1, key: parseEncryptionKey(value) };
  }
  const version = value.slice(0, at);
  if (!/^[1-9]\d{0,8}$/.test(version)) {
    throw new Error(
      "A key version must be a whole number from 1, before the key and a colon (2:<key>).",
    );
  }
  return {
    version: Number(version),
    key: parseEncryptionKey(value.slice(at + 1)),
  };
}

export interface Encryptor {
  /** The key version new values are sealed with. */
  readonly currentKeyVersion: number;
  /** Seals `plaintext`; `context` must be given again to open it. */
  encrypt(plaintext: string, context?: string): string;
  /** Opens a sealed value, or throws a `DecryptionError`. */
  decrypt(sealed: string, context?: string): string;
  /** The key version that sealed `sealed`, without decrypting it. */
  keyVersionOf(sealed: string): number;
}

export interface EncryptorOptions {
  /** Every key that may have sealed a stored value, by version. */
  readonly keys: ReadonlyMap<number, Buffer>;
  /** The version of the key to seal new values with. */
  readonly currentKeyVersion: number;
}

const associatedData = (keyVersion: number, context: string): Buffer =>
  Buffer.from(`${format}:${String(keyVersion)}:${context}`, "utf8");

const base64url = /^[A-Za-z0-9_-]*$/;

function parseSealed(sealed: string): {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
} {
  const parts = sealed.split(":");
  const [prefix, version, iv, ciphertext, tag] = parts;
  if (
    parts.length !== 5 ||
    prefix !== format ||
    version === undefined ||
    !/^[1-9]\d{0,8}$/.test(version) ||
    iv === undefined ||
    ciphertext === undefined ||
    tag === undefined ||
    ![iv, ciphertext, tag].every((part) => base64url.test(part))
  ) {
    throw new DecryptionError("it is not a sealed value");
  }
  return {
    keyVersion: Number(version),
    iv: Buffer.from(iv, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
    tag: Buffer.from(tag, "base64url"),
  };
}

/** Seals and opens secret fields with a set of versioned keys. */
export function createEncryptor(options: EncryptorOptions): Encryptor {
  for (const [version, key] of options.keys) {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("Key versions must be positive integers.");
    }
    if (key.length !== keyLength) {
      throw new Error(
        `Key version ${String(version)} must be ${String(keyLength)} bytes.`,
      );
    }
  }
  const currentKey = options.keys.get(options.currentKeyVersion);
  if (currentKey === undefined) {
    throw new Error(
      `There is no key for the current key version ${String(options.currentKeyVersion)}.`,
    );
  }

  return {
    currentKeyVersion: options.currentKeyVersion,

    encrypt(plaintext, context = "") {
      const iv = randomBytes(ivLength);
      const cipher = createCipheriv(algorithm, currentKey, iv, {
        authTagLength: tagLength,
      });
      cipher.setAAD(associatedData(options.currentKeyVersion, context));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        format,
        String(options.currentKeyVersion),
        iv.toString("base64url"),
        ciphertext.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(":");
    },

    decrypt(sealed, context = "") {
      const { keyVersion, iv, ciphertext, tag } = parseSealed(sealed);
      const key = options.keys.get(keyVersion);
      if (key === undefined) {
        throw new DecryptionError(
          `there is no key for key version ${String(keyVersion)}`,
        );
      }
      if (iv.length !== ivLength || tag.length !== tagLength) {
        throw new DecryptionError("it is not a sealed value");
      }
      try {
        const decipher = createDecipheriv(algorithm, key, iv, {
          authTagLength: tagLength,
        });
        decipher.setAAD(associatedData(keyVersion, context));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new DecryptionError(
          "it was altered, sealed with another key, or opened with the wrong context",
        );
      }
    },

    keyVersionOf(sealed) {
      return parseSealed(sealed).keyVersion;
    },
  };
}

/**
 * The encryptor for a single key, as key version 1. The server builds its
 * own from every key it is configured with (`ENCRYPTION_KEY` and
 * `RETIRED_ENCRYPTION_KEYS`), so a rotated key's values still open.
 */
export function encryptorFromKey(key: Buffer): Encryptor {
  return createEncryptor({ keys: new Map([[1, key]]), currentKeyVersion: 1 });
}

/**
 * The encryptor for `ENCRYPTION_KEY` as written (`<version>:<key>`, or the
 * key alone as version 1), for a tool that only seals new values beside the
 * server, as the server seals them.
 */
export function encryptorFromVersionedKey(value: string): Encryptor {
  const { version, key } = parseVersionedEncryptionKey(value);
  return createEncryptor({
    keys: new Map([[version, key]]),
    currentKeyVersion: version,
  });
}
