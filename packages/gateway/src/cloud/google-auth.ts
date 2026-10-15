import { createSign } from "node:crypto";

import type { ServiceAccountKey } from "@ai-office/shared";

import type { Fetch } from "../accounts/oauth.ts";

// A Google Vertex AI account signs in as a service account (PRD FR-35):
// AI Office signs a short JWT with the service account's private key and
// trades it at Google's token endpoint for an access token (OAuth 2.0's
// JWT bearer grant, RFC 7523), which every request carries as a bearer
// token. Tokens last an hour; each is kept in memory and a new one is
// fetched a few minutes before it expires. The private key never leaves
// AI Office.

/** Google's token endpoint, when the key does not name another. */
export const googleTokenUrl = "https://oauth2.googleapis.com/token";

/** What the access token may do: Vertex AI, through Cloud Platform. */
export const cloudPlatformScope =
  "https://www.googleapis.com/auth/cloud-platform";

/** A token is fetched again this long before it expires. */
const renewBeforeMs = 5 * 60 * 1000;

/** How long Google is given to answer. */
const tokenTimeoutMs = 15 * 1000;

/** Why no access token was had; its message never holds a credential. */
export class GoogleAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleAuthError";
  }
}

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

/** The JWT a service account signs to ask for an access token. */
export function serviceAccountAssertion(
  key: ServiceAccountKey,
  now: Date,
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      ...(key.private_key_id === undefined ? {} : { kid: key.private_key_id }),
    }),
  );
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: cloudPlatformScope,
      aud: key.token_uri ?? googleTokenUrl,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256")
      .update(`${header}.${claims}`)
      .sign(key.private_key);
  } catch {
    throw new GoogleAuthError(
      "The service account's private key could not sign: it is not a usable RSA key.",
    );
  }
  return `${header}.${claims}.${base64url(signature)}`;
}

/** An access token, and when it expires. */
export interface GoogleAccessToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

/** Trades a service account's signed JWT for an access token. */
export async function fetchServiceAccountToken(
  key: ServiceAccountKey,
  options: { readonly fetch: Fetch; readonly now: Date },
): Promise<GoogleAccessToken> {
  let response: Response;
  try {
    response = await options.fetch(key.token_uri ?? googleTokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: serviceAccountAssertion(key, options.now),
      }).toString(),
      signal: AbortSignal.timeout(tokenTimeoutMs),
    });
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      throw error;
    }
    throw new GoogleAuthError("Google's token endpoint could not be reached.", {
      cause: error,
    });
  }
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const fields = (typeof body === "object" && body !== null ? body : {}) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof fields.access_token !== "string") {
    // Google's error code (`invalid_grant`…) only: never the body.
    const code = typeof fields.error === "string" ? `: ${fields.error}` : "";
    throw new GoogleAuthError(
      `Google refused the service account's sign-in (${String(response.status)}${code}).`,
    );
  }
  const seconds =
    typeof fields.expires_in === "number" && fields.expires_in > 0
      ? fields.expires_in
      : 3600;
  return {
    accessToken: fields.access_token,
    expiresAt: new Date(options.now.getTime() + seconds * 1000),
  };
}

/**
 * Service accounts' access tokens, kept in memory per account and fetched
 * once however many requests want one at the same time.
 */
export interface GoogleTokenCache {
  /** A token for `id`'s key, valid for a few minutes more at least. */
  token(id: string, key: ServiceAccountKey): Promise<string>;
  /** Forgets `id`'s token: the account was deleted. */
  forget(id: string): void;
}

export function createGoogleTokenCache(options: {
  readonly fetch: Fetch;
  readonly now: () => Date;
  /** Told each access token, so it can be redacted. */
  readonly onToken?: (token: string) => void;
}): GoogleTokenCache {
  const tokens = new Map<
    string,
    { readonly keyId: string; readonly promise: Promise<GoogleAccessToken> }
  >();
  const token = async (id: string, key: ServiceAccountKey): Promise<string> => {
    // A new key for the account (it was added anew) gets a new token.
    const keyId = `${key.client_email}:${key.private_key_id ?? key.private_key}`;
    const held = tokens.get(id);
    if (held?.keyId === keyId) {
      // One being fetched is shared, refused or not.
      const current = await held.promise;
      if (
        current.expiresAt.getTime() - renewBeforeMs >
        options.now().getTime()
      ) {
        return current.accessToken;
      }
      if (tokens.get(id) !== held) {
        // Another request is already fetching its successor.
        return token(id, key);
      }
    }
    const promise = fetchServiceAccountToken(key, {
      fetch: options.fetch,
      now: options.now(),
    });
    tokens.set(id, { keyId, promise });
    try {
      const fetched = await promise;
      options.onToken?.(fetched.accessToken);
      return fetched.accessToken;
    } catch (error) {
      // The next request asks again.
      if (tokens.get(id)?.promise === promise) {
        tokens.delete(id);
      }
      throw error;
    }
  };
  return {
    token,
    forget(id) {
      tokens.delete(id);
    },
  };
}
