import { z } from "zod";

import { ownerProofSchema, sessionResponseSchema } from "./auth.ts";

// The Owner's optional TOTP second factor and its recovery codes (PRD FR-3).
// The server and the web app share these.

/** How many recovery codes are made when TOTP is turned on. */
export const recoveryCodeCount = 10;

/** A six-digit code from an authenticator app (spaces allowed). */
export const totpCodePattern = /^\d{6}$/;

/** A code with its spaces and dashes removed, in lower case. */
export const normaliseCode = (code: string): string =>
  code.replaceAll(/[\s-]/g, "").toLowerCase();

/** Whether `code` is a TOTP code, rather than a recovery code. */
export const isTotpCode = (code: string): boolean =>
  totpCodePattern.test(normaliseCode(code));

/**
 * The body of a request that carries a code: `POST /api/login/totp`,
 * `POST /api/totp/enable` and `POST /api/totp/disable`. A sign-in or
 * turning TOTP off takes a TOTP code or an unused recovery code.
 */
export const totpCodeRequestSchema = z.object({
  code: z.string().trim().min(1).max(64),
});
export type TotpCodeRequest = z.infer<typeof totpCodeRequestSchema>;

/**
 * The body of `POST /api/totp/setup`: turning TOTP on needs a fresh proof
 * of the Owner (A1-3), the current password, so a stolen session cannot
 * lock the Owner out with a secret of its own.
 */
export const totpSetupRequestSchema = ownerProofSchema;
export type TotpSetupRequest = z.infer<typeof totpSetupRequestSchema>;

/**
 * The body of a successful `POST /api/login`: the session, or (when TOTP is
 * on) a request for the second factor at `POST /api/login/totp`.
 */
export const loginResponseSchema = z.union([
  sessionResponseSchema,
  z.object({ secondFactor: z.literal("totp") }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** `GET /api/totp`. */
export const totpStatusSchema = z.object({
  enabled: z.boolean(),
  /** Unused recovery codes; 0 while TOTP is off. */
  recoveryCodesLeft: z.number().int().min(0),
});
export type TotpStatus = z.infer<typeof totpStatusSchema>;

/**
 * `POST /api/totp/setup`: a new secret to add to an authenticator app. TOTP
 * is not on until a code from it is confirmed at `POST /api/totp/enable`.
 */
export const totpSetupResponseSchema = z.object({
  /** Base32, for typing into an app that cannot scan. */
  secret: z.string(),
  /** The `otpauth://totp/…` URI the QR code holds. */
  otpauthUrl: z.string(),
  /** The QR code, as an SVG `data:` URL. */
  qrCode: z.string(),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

/** `POST /api/totp/enable`: the recovery codes, shown this once. */
export const totpEnableResponseSchema = z.object({
  recoveryCodes: z.array(z.string()).length(recoveryCodeCount),
});
export type TotpEnableResponse = z.infer<typeof totpEnableResponseSchema>;
