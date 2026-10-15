import { createHash, randomBytes } from "node:crypto";

import { normaliseCode, recoveryCodeCount } from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";

// The Owner's optional TOTP second factor (PRD FR-3), with `otplib`: SHA-1,
// six digits and 30-second steps, which every authenticator app reads. The
// secret is sealed with ENCRYPTION_KEY before it is stored.

/** The issuer and label authenticator apps show for AI Office. */
const issuer = "AI Office";
const label = "Owner";

/**
 * How far a code may be from the clock, in seconds: one step either way,
 * for a phone whose clock drifts or a code typed as it changes.
 */
const toleranceSeconds = 30;

/** The context a TOTP secret is sealed with, so it opens only as one. */
export const totpSecretContext = "owner.totp_secret";

export function sealTotpSecret(encryptor: Encryptor, secret: string): string {
  return encryptor.encrypt(secret, totpSecretContext);
}

export function openTotpSecret(encryptor: Encryptor, sealed: string): string {
  return encryptor.decrypt(sealed, totpSecretContext);
}

/** A new secret, with the URI and QR code that add it to an app. */
export async function newTotpSecret(): Promise<{
  secret: string;
  otpauthUrl: string;
  qrCode: string;
}> {
  const secret = generateSecret();
  const otpauthUrl = generateURI({ issuer, label, secret });
  const svg = await QRCode.toString(otpauthUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
  });
  return {
    secret,
    otpauthUrl,
    qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  };
}

/**
 * The time step `code` belongs to, if it is a valid code for `secret` at
 * `now` and its step is after `afterTimeStep` (each code works once).
 */
export async function verifyTotpCode(options: {
  readonly secret: string;
  readonly code: string;
  readonly now: Date;
  readonly afterTimeStep?: number | undefined;
}): Promise<number | undefined> {
  const token = normaliseCode(options.code);
  if (!/^\d{6}$/.test(token)) {
    return undefined;
  }
  const result = await verify({
    secret: options.secret,
    token,
    epoch: Math.floor(options.now.getTime() / 1000),
    epochTolerance: toleranceSeconds,
    ...(options.afterTimeStep === undefined
      ? {}
      : { afterTimeStep: options.afterTimeStep }),
  });
  // The functional API's result covers HOTP too, which has no time step.
  return result.valid && "timeStep" in result ? result.timeStep : undefined;
}

// Recovery codes: 16 characters of Crockford's base32 (no i, l, o or u, so
// nothing is misread), 80 random bits, written in groups of four.
const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

function recoveryCode(): string {
  // 256 is a multiple of 32, so each byte maps to a character unbiased.
  const characters = [...randomBytes(16)].map(
    (byte) => alphabet[byte % alphabet.length] ?? "",
  );
  return characters.join("").replaceAll(/(.{4})(?!$)/g, "$1-");
}

/** Ten fresh recovery codes, as the Owner is shown them. */
export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < recoveryCodeCount) {
    codes.add(recoveryCode());
  }
  return [...codes];
}

/** What is stored for a recovery code: the SHA-256 of its normal form. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseCode(code)).digest("hex");
}
