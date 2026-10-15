import { z } from "zod";

// The Owner's password and the API around it (PRD §6.1). The server and the
// web app share these, so both judge a password by the same rules.

export const passwordMinLength = 12;
/** Long enough for any passphrase; it bounds the work of hashing. */
export const passwordMaxLength = 256;
/** From this length a password needs no mix of character classes. */
export const passphraseLength = 20;
const minimumDistinctCharacters = 6;

const characterClasses = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/] as const;

/**
 * What is wrong with `password` as the Owner's password, in plain words;
 * empty when it is acceptable. It must be at least 12 characters, use at
 * least 6 different characters, and mix three of lower case, upper case,
 * digits and symbols unless it is a passphrase of 20 or more.
 */
export function passwordProblems(password: string): string[] {
  // Characters as people count them: an emoji with modifiers is one.
  const characters = Array.from(
    new Intl.Segmenter().segment(password),
    ({ segment }) => segment,
  );
  const length = characters.length;
  if (length < passwordMinLength) {
    return [`Use at least ${String(passwordMinLength)} characters.`];
  }
  if (length > passwordMaxLength) {
    return [`Use at most ${String(passwordMaxLength)} characters.`];
  }
  const problems: string[] = [];
  if (new Set(characters).size < minimumDistinctCharacters) {
    problems.push(
      `Use at least ${String(minimumDistinctCharacters)} different characters.`,
    );
  }
  const classes = characterClasses.filter((pattern) =>
    pattern.test(password),
  ).length;
  if (length < passphraseLength && classes < 3) {
    problems.push(
      `Mix at least three of lower case, upper case, digits and symbols, or use ${String(passphraseLength)} or more characters.`,
    );
  }
  return problems;
}

/** A password the Owner may set. */
export const ownerPasswordSchema = z.string().superRefine((password, ctx) => {
  for (const message of passwordProblems(password)) {
    ctx.addIssue({ code: "custom", message });
  }
});

/**
 * A fresh proof of the Owner (A1-3): one of the Owner's passwords, and a
 * TOTP or recovery code when TOTP is on. A change that adds a way to sign
 * in needs one: adding an Owner password, making or widening an API key
 * with UI access, and turning TOTP on. A session begun with an API key
 * cannot give one. Each check counts against the sign-in rate limit and is
 * recorded as a sign-in attempt is (A1-4).
 */
export const ownerProofShape = {
  currentPassword: z
    .string()
    .min(1)
    .max(4 * passwordMaxLength)
    .optional(),
  code: z.string().trim().min(1).max(64).optional(),
};
export const ownerProofSchema = z.object(ownerProofShape);
export type OwnerProof = z.infer<typeof ownerProofSchema>;

/** The body of `POST /api/owner-passwords`: a further Owner password. */
export const addOwnerPasswordRequestSchema = z.object({
  ...ownerProofShape,
  name: z
    .string()
    .trim()
    .min(1, { error: "Give the password a name." })
    .max(60, { error: "Use at most 60 characters for the name." }),
  nickname: z.string().trim().max(40).default(""),
  timeZone: z.string().default("Europe/London"),
  password: ownerPasswordSchema,
});
export type AddOwnerPasswordRequest = z.infer<
  typeof addOwnerPasswordRequestSchema
>;

/**
 * What `PUT /api/owner-passwords/:id` takes beside the password's name,
 * nickname and time zone to replace the password itself (A1-9): the new
 * one, and a fresh proof of the one it replaces (that password, and a code
 * when TOTP is on). Replacing it ends the sessions it began.
 */
export const replaceOwnerPasswordRequestSchema = z.object({
  ...ownerProofShape,
  password: ownerPasswordSchema.optional(),
});
export type ReplaceOwnerPasswordRequest = z.infer<
  typeof replaceOwnerPasswordRequestSchema
>;

/**
 * The body of `POST /api/setup`. From anywhere but this machine's loopback
 * it needs the one-time setup token AI Office wrote to a file as it
 * started (A1-2).
 */
export const setupRequestSchema = z.object({
  password: ownerPasswordSchema,
  token: z.string().trim().min(1).max(256).optional(),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/** The body of `POST /api/login`. Any string is checked, however weak. */
export const loginRequestSchema = z.object({
  password: z
    .string()
    .min(1)
    .max(4 * passwordMaxLength),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** The body of `POST /api/login/api-key`: an API key with UI access. */
export const apiKeyLoginRequestSchema = z.object({
  key: z.string().min(1).max(512),
});
export type ApiKeyLoginRequest = z.infer<typeof apiKeyLoginRequestSchema>;

/** The signed-in session: the body of `GET /api/session` and of a login. */
export const sessionResponseSchema = z.object({
  /** Sent back in the `x-csrf-token` header with every state change. */
  csrfToken: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  /**
   * The API key that signed in, when one with UI access did; null for the
   * Owner's password.
   */
  gatewayKeyId: z.string().nullable().default(null),
  /**
   * Which of the Owner's further passwords signed in; null for the first
   * password, or an API key.
   */
  passwordId: z.string().nullable().default(null),
  /**
   * The internal hosts an address the Owner gives may name
   * (ALLOWED_INTERNAL_HOSTS, ADR 0007), so the web app's forms agree with
   * the server.
   */
  allowedInternalHosts: z.array(z.string()).default([]),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** A credential that still signs in, by name: never the credential. */
const signInCredentialSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The body of `POST /api/logout/everywhere`: how many sessions ended, and
 * what still signs in (A1-3), so the Owner can remove what they do not
 * recognise. Ending sessions removes no password and no API key.
 */
export const signedOutEverywhereSchema = z.object({
  sessionsEnded: z.number().int().min(0),
  stillSignIn: z.object({
    /** The Owner's passwords, the first (set at setup) first. */
    passwords: z.array(signInCredentialSchema),
    /** API keys with UI access, enabled and not revoked. */
    apiKeys: z.array(signInCredentialSchema),
  }),
});
export type SignedOutEverywhere = z.infer<typeof signedOutEverywhereSchema>;

/** The header that carries the session's CSRF token. */
export const csrfHeader = "x-csrf-token";

/** How long a session lasts from sign-in (PRD FR-2): 7 days. */
export const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a session may go unused before it is refused (PRD FR-2, A1-8):
 * 24 hours. A page open in a browser uses it all the time.
 */
export const sessionIdleMs = 24 * 60 * 60 * 1000;

/** Codes in the `error` field of an API error body. */
export const apiErrorCodes = {
  /** No password exists yet: the Owner must use `/setup` first. */
  setupRequired: "setup_required",
  /**
   * Setting the first password from anywhere but this machine needs the
   * one-time setup token, and this request had none, or a wrong one.
   */
  setupTokenRequired: "setup_token_required",
  /** The request was for a name AI Office is not served at (PUBLIC_URL). */
  wrongHost: "wrong_host",
  invalidRequest: "invalid_request",
  /** No session, or an expired one: sign in at `/login`. */
  unauthorized: "unauthorized",
  wrongPassword: "wrong_password",
  /** No API key in use, enabled and with UI access, is this one. */
  wrongApiKey: "wrong_api_key",
  /** Too many failed sign-ins from this client; see `Retry-After`. */
  tooManyAttempts: "too_many_attempts",
  /** A state change without the session's CSRF token, or from another site. */
  csrf: "csrf_refused",
  /** A TOTP or recovery code that is wrong, or already used. */
  wrongCode: "wrong_code",
  /** No password step to finish with a code, or it took too long. */
  signInExpired: "sign_in_expired",
  /** TOTP is already on: turn it off before setting it up again. */
  totpEnabled: "totp_enabled",
  /** TOTP is off, so there is nothing to turn off. */
  totpDisabled: "totp_disabled",
  /** `POST /api/totp/enable` before `POST /api/totp/setup`. */
  totpNotSetUp: "totp_not_set_up",
  /** Another of the Owner's passwords is already that password. */
  passwordInUse: "password_in_use",
  /**
   * The change adds a way to sign in, so it needs a fresh proof of the
   * Owner (`currentPassword`, and `code` when TOTP is on), which a session
   * begun with an API key cannot give.
   */
  proofRequired: "proof_required",
  /** The first password, set at setup, cannot be removed, only replaced. */
  firstPasswordNotRemovable: "first_password_not_removable",
  ownerPasswordNotFound: "owner_password_not_found",
} as const;

/** The body of every API error response. */
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  /** What was wrong with the request, one line each. */
  problems: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
