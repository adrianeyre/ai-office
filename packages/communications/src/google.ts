import { createHash, randomBytes } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  createRedactor,
  googleErrorCodes,
  googleRedirectPath,
  googleScopesFor,
  googleServiceNames,
  googleServiceOf,
  googleServiceScopes,
  googleServices,
  isGoogleConnection,
  type GoogleClientRequest,
  type GoogleErrorCode,
  type GoogleService,
  type GoogleSignInCompleteRequest,
  type GoogleSignInStatus,
  type Redactor,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";

import { officeUrl } from "./messages.ts";
import type { CommunicationsStore, GoogleSignInRecord } from "./store.ts";
import {
  DeliveryError,
  retryAfterMs,
  unreachable,
} from "./transports/transport.ts";

// Google sign-in (PRD FR-91): the Owner registers an OAuth client in Google
// Cloud and enters its ID and secret here; then signs in to one Google
// account through it, with the authorization code flow and PKCE. Signing in
// asks only for the scopes of the Google services the Google Connections
// use, with no incremental grant of anything asked for before. The refresh
// token, the access token and the client's secret are sealed with
// ENCRYPTION_KEY; the access token is refreshed a minute before it
// expires, or when Google refuses it. When Google refuses the refresh token
// itself (`invalid_grant`: the Owner revoked AI Office's access, or the
// grant expired), the sign-in is `revoked` and every Google Connection is
// marked failing, until the Owner signs in again. No token, code or secret
// is ever logged or put in an error's message.

/** Where Google's OAuth endpoints are. */
export interface GoogleEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
}

export const googleEndpoints: GoogleEndpoints = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
};

/** Why a Google sign-in operation was refused; `code` is one of `googleErrorCodes`. */
export class GoogleSignInError extends Error {
  readonly code: GoogleErrorCode;

  constructor(code: GoogleErrorCode, message: string) {
    super(message);
    this.name = "GoogleSignInError";
    this.code = code;
  }
}

/** Google sign-in, as the office admin shows it: never a secret or a token. */
export interface GoogleSignInInfo {
  readonly status: GoogleSignInStatus;
  readonly clientId: string | null;
  /** The address to register as the OAuth client's redirect URI. */
  readonly redirectUri: string;
  /** The services the Google Connections use. */
  readonly services: readonly GoogleService[];
  /** The scopes signing in asks for. */
  readonly scopes: readonly string[];
  readonly grantedScopes: readonly string[];
  /** Services whose scopes the last sign-in did not grant. */
  readonly missingServices: readonly GoogleService[];
  readonly signedInAt: Date | null;
}

/** What a Google Connection's transport asks of the sign-in. */
export interface GoogleAccess {
  /**
   * A current access token for `service`: the one kept, unless it expires
   * within a minute or `refresh` is asked, when Google is asked for a new
   * one. Throws a `DeliveryError` when there is none to have, saying why.
   */
  accessToken(
    service: GoogleService,
    options?: { readonly refresh?: boolean },
  ): Promise<string>;
}

export interface GoogleAuth extends GoogleAccess {
  info(): Promise<GoogleSignInInfo>;
  /** Enters the OAuth client; a new client ID signs the account out. */
  configure(client: GoogleClientRequest): Promise<GoogleSignInInfo>;
  /** Begins a sign-in: where the Owner consents. */
  start(): Promise<{ readonly url: string }>;
  /** Finishes a sign-in with what Google's redirect brought back. */
  complete(request: GoogleSignInCompleteRequest): Promise<GoogleSignInInfo>;
  /** Signs out, revoking the grant at Google as well as it can. */
  signOut(): Promise<GoogleSignInInfo>;
  /** Told when Google refuses the refresh token, before it is said. */
  onRevoked(listener: () => Promise<void>): () => void;
  /** Told after each sign-in. */
  onSignedIn(listener: () => Promise<void>): () => void;
}

export interface GoogleAuthOptions {
  /** Where the sign-in is kept, and the Connections whose services it serves. */
  readonly store: Pick<
    CommunicationsStore,
    "googleSignIn" | "saveGoogleSignIn" | "connections"
  >;
  readonly events: Pick<EventBus, "publish">;
  readonly encryptor: Encryptor;
  /** Where AI Office is reached (PUBLIC_URL), for the redirect URI. */
  readonly publicUrl: string;
  readonly endpoints?: GoogleEndpoints;
  /** Removes the secret and the tokens from whatever is kept or logged. */
  readonly redactor?: Redactor;
  /** How long one request to Google may take; 20 seconds by default. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/** How long a begun sign-in can be finished. */
const signInLifetimeMs = 10 * 60 * 1000;

/** How long before it expires an access token is refreshed. */
const refreshAheadMs = 60 * 1000;

/** The contexts the Google sign-in's secret and tokens are sealed with. */
export const googleSealContext = {
  clientSecret: "google.client_secret",
  refreshToken: "google.refresh_token",
  accessToken: "google.access_token",
} as const;

/** The services the Google Connections use, in `googleServices`' order. */
async function servicesInUse(
  store: Pick<CommunicationsStore, "connections">,
): Promise<GoogleService[]> {
  const used = new Set<GoogleService>();
  for (const { type } of await store.connections()) {
    if (isGoogleConnection(type)) {
      used.add(googleServiceOf[type]);
    }
  }
  return googleServices.filter((service) => used.has(service));
}

const granted = (
  service: GoogleService,
  grantedScopes: readonly string[],
): boolean =>
  googleServiceScopes[service].every((scope) => grantedScopes.includes(scope));

type Json = Record<string, unknown>;

export function createGoogleAuth(options: GoogleAuthOptions): GoogleAuth {
  const { store, events, encryptor } = options;
  const endpoints = options.endpoints ?? googleEndpoints;
  const redactor = options.redactor ?? createRedactor();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now ?? (() => new Date());
  const redirectUri = officeUrl(options.publicUrl, googleRedirectPath);
  const revokedListeners = new Set<() => Promise<void>>();
  const signedInListeners = new Set<() => Promise<void>>();
  /** Begun sign-ins, by their state: each finished at most once. */
  const pending = new Map<
    string,
    { readonly verifier: string; readonly startedAt: Date }
  >();

  const open = (sealed: string, context: string): string => {
    const value = encryptor.decrypt(sealed, context);
    redactor.register(value);
    return value;
  };
  const seal = (value: string, context: string): string => {
    redactor.register(value);
    return encryptor.encrypt(value, context);
  };

  const info = async (): Promise<GoogleSignInInfo> => {
    const record = await store.googleSignIn();
    const services = await servicesInUse(store);
    const grantedScopes = record?.grantedScopes ?? [];
    return {
      status: record?.status ?? "not_configured",
      clientId: record?.clientId ?? null,
      redirectUri,
      services,
      scopes: googleScopesFor(services),
      grantedScopes: [...grantedScopes],
      missingServices:
        record?.status === "signed_in"
          ? services.filter((service) => !granted(service, grantedScopes))
          : [],
      signedInAt: record?.signedInAt ?? null,
    };
  };

  /** Posts a form to Google's token endpoint; its status and JSON answer. */
  const postForm = async (
    url: string,
    form: Record<string, string>,
  ): Promise<{ readonly response: Response; readonly json: Json }> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "AI-Office",
        },
        body: new URLSearchParams(form).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw unreachable("Google", error);
    }
    const json = (await response.json().catch(() => ({}))) as Json;
    return { response, json };
  };

  /** Google's error code in an OAuth answer, such as `invalid_grant`. */
  const oauthError = (json: Json): string =>
    typeof json["error"] === "string" && /^[a-z_]{1,64}$/.test(json["error"])
      ? json["error"]
      : "error";

  const signedOut = (record: GoogleSignInRecord): GoogleSignInRecord => ({
    ...record,
    status: "signed_out",
    refreshToken: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    grantedScopes: [],
    signedInAt: null,
  });

  const revokedMessage =
    "Google refused AI Office's sign-in: the grant was revoked or has expired. Sign in to Google again on the Connections page.";

  /** Google refused the refresh token: the sign-in is revoked, and said so. */
  const revoke = async (record: GoogleSignInRecord): Promise<void> => {
    await store.saveGoogleSignIn({
      ...signedOut(record),
      status: "revoked",
      grantedScopes: record.grantedScopes,
      signedInAt: record.signedInAt,
    });
    const google = (await store.connections()).filter(({ type }) =>
      isGoogleConnection(type),
    );
    for (const listener of revokedListeners) {
      await listener();
    }
    await events.publish({
      type: "google.grant_revoked",
      version: 1,
      connections: google.length,
    });
  };

  /** Asks Google for a new access token with the refresh token. */
  const refresh = async (record: GoogleSignInRecord): Promise<string> => {
    if (record.refreshToken === null) {
      throw new DeliveryError(revokedMessage);
    }
    const { response, json } = await postForm(endpoints.tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: open(record.refreshToken, googleSealContext.refreshToken),
      client_id: record.clientId,
      client_secret: open(record.clientSecret, googleSealContext.clientSecret),
    });
    const status = String(response.status);
    if (!response.ok) {
      const error = oauthError(json);
      if (error === "invalid_grant") {
        await revoke(record);
        throw new DeliveryError(revokedMessage);
      }
      if (error === "invalid_client" || error === "unauthorized_client") {
        throw new DeliveryError(
          `Google refused the OAuth client (${status} ${error}): check its ID and secret.`,
        );
      }
      const wait = retryAfterMs(response.headers.get("retry-after"));
      throw new DeliveryError(
        `Google could not refresh the sign-in (${status} ${error}).`,
        wait === undefined ? {} : { retryAfterMs: wait },
      );
    }
    const accessToken = json["access_token"];
    const expiresIn = json["expires_in"];
    if (typeof accessToken !== "string" || typeof expiresIn !== "number") {
      throw new DeliveryError("Google answered the refresh without a token.");
    }
    // Google may hand out a new refresh token; the old one then stops.
    const rotated = json["refresh_token"];
    await store.saveGoogleSignIn({
      ...record,
      ...(typeof rotated === "string"
        ? { refreshToken: seal(rotated, googleSealContext.refreshToken) }
        : {}),
      accessToken: seal(accessToken, googleSealContext.accessToken),
      accessTokenExpiresAt: new Date(now().getTime() + expiresIn * 1000),
    });
    return accessToken;
  };

  // One refresh at a time: requests that need one wait for it together.
  let refreshing: Promise<string> | undefined;

  return {
    info,

    async configure(client) {
      const before = await store.googleSignIn();
      const keys = [
        ...(before?.clientId === client.clientId ? [] : ["clientId"]),
        ...(before !== undefined &&
        open(before.clientSecret, googleSealContext.clientSecret) ===
          client.clientSecret
          ? []
          : ["clientSecret"]),
      ];
      if (keys.length === 0) {
        return info();
      }
      const clientSecret = seal(
        client.clientSecret,
        googleSealContext.clientSecret,
      );
      // A refresh token belongs to the client it was granted to.
      const record: GoogleSignInRecord =
        before === undefined
          ? {
              clientId: client.clientId,
              clientSecret,
              status: "signed_out",
              refreshToken: null,
              accessToken: null,
              accessTokenExpiresAt: null,
              grantedScopes: [],
              signedInAt: null,
            }
          : before.clientId === client.clientId
            ? { ...before, clientSecret }
            : { ...signedOut(before), clientId: client.clientId, clientSecret };
      await store.saveGoogleSignIn(record);
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "google",
        keys,
      });
      if (before?.status === "signed_in" && record.status === "signed_out") {
        await events.publish({ type: "google.signed_out", version: 1 });
      }
      return info();
    },

    async start() {
      const record = await store.googleSignIn();
      if (record === undefined) {
        throw new GoogleSignInError(
          googleErrorCodes.notConfigured,
          "Enter the OAuth client's ID and secret first.",
        );
      }
      const services = await servicesInUse(store);
      if (services.length === 0) {
        throw new GoogleSignInError(
          googleErrorCodes.noServices,
          "Add a Google Connection first: signing in asks only for what the Google Connections need.",
        );
      }
      const at = now();
      for (const [state, begun] of pending) {
        if (at.getTime() - begun.startedAt.getTime() > signInLifetimeMs) {
          pending.delete(state);
        }
      }
      const state = randomBytes(24).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      pending.set(state, { verifier, startedAt: at });
      const url = new URL(endpoints.authorizeUrl);
      url.search = new URLSearchParams({
        client_id: record.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: googleScopesFor(services).join(" "),
        // A refresh token, every time, so a new sign-in replaces the old.
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return { url: url.href };
    },

    async complete(request) {
      const begun = pending.get(request.state);
      pending.delete(request.state);
      if (
        begun === undefined ||
        now().getTime() - begun.startedAt.getTime() > signInLifetimeMs
      ) {
        throw new GoogleSignInError(
          googleErrorCodes.signInNotFound,
          "That sign-in is unknown, finished or too old: sign in to Google again.",
        );
      }
      if ("error" in request) {
        throw new GoogleSignInError(
          googleErrorCodes.signInRefused,
          request.error === "access_denied"
            ? "Google sign-in was cancelled: nothing was granted."
            : "Google did not complete the sign-in.",
        );
      }
      const record = await store.googleSignIn();
      if (record === undefined) {
        throw new GoogleSignInError(
          googleErrorCodes.notConfigured,
          "Enter the OAuth client's ID and secret first.",
        );
      }
      redactor.register(request.code);
      let answer: { readonly response: Response; readonly json: Json };
      try {
        answer = await postForm(endpoints.tokenUrl, {
          grant_type: "authorization_code",
          code: request.code,
          client_id: record.clientId,
          client_secret: open(
            record.clientSecret,
            googleSealContext.clientSecret,
          ),
          redirect_uri: redirectUri,
          code_verifier: begun.verifier,
        });
      } catch (error) {
        throw new GoogleSignInError(
          googleErrorCodes.unavailable,
          error instanceof Error
            ? error.message
            : "Google could not be reached.",
        );
      }
      const { response, json } = answer;
      if (!response.ok) {
        const status = String(response.status);
        throw response.status === 400 || response.status === 401
          ? new GoogleSignInError(
              googleErrorCodes.signInRefused,
              `Google refused the sign-in (${status} ${oauthError(json)}).`,
            )
          : new GoogleSignInError(
              googleErrorCodes.unavailable,
              `Google answered ${status}.`,
            );
      }
      const accessToken = json["access_token"];
      const refreshToken = json["refresh_token"];
      const expiresIn = json["expires_in"];
      if (
        typeof accessToken !== "string" ||
        typeof refreshToken !== "string" ||
        typeof expiresIn !== "number"
      ) {
        throw new GoogleSignInError(
          googleErrorCodes.signInRefused,
          "Google signed in without a refresh token: sign in again.",
        );
      }
      // What the Owner allowed on the consent screen, which can be less
      // than was asked for.
      const scopes =
        typeof json["scope"] === "string"
          ? json["scope"].split(" ").filter((scope) => scope !== "")
          : [];
      const at = now();
      await store.saveGoogleSignIn({
        ...record,
        status: "signed_in",
        refreshToken: seal(refreshToken, googleSealContext.refreshToken),
        accessToken: seal(accessToken, googleSealContext.accessToken),
        accessTokenExpiresAt: new Date(at.getTime() + expiresIn * 1000),
        grantedScopes: scopes,
        signedInAt: at,
      });
      await events.publish({
        type: "google.signed_in",
        version: 1,
        scopes: scopes.slice(0, 20),
      });
      for (const listener of signedInListeners) {
        await listener();
      }
      return info();
    },

    async signOut() {
      const record = await store.googleSignIn();
      if (record === undefined || record.status === "signed_out") {
        return info();
      }
      if (record.refreshToken !== null) {
        // As well as it can: signed out here whatever Google says.
        await postForm(endpoints.revokeUrl, {
          token: open(record.refreshToken, googleSealContext.refreshToken),
        }).catch(() => undefined);
      }
      await store.saveGoogleSignIn(signedOut(record));
      await events.publish({ type: "google.signed_out", version: 1 });
      return info();
    },

    async accessToken(service, { refresh: force = false } = {}) {
      const record = await store.googleSignIn();
      if (record === undefined) {
        throw new DeliveryError(
          "Google sign-in is not set up: enter the OAuth client and sign in on the Connections page.",
        );
      }
      if (record.status === "revoked") {
        throw new DeliveryError(revokedMessage);
      }
      if (record.status === "signed_out") {
        throw new DeliveryError(
          "Nobody is signed in to Google: sign in on the Connections page.",
        );
      }
      if (!granted(service, record.grantedScopes)) {
        throw new DeliveryError(
          `The Google sign-in does not allow ${googleServiceNames[service]}: sign in to Google again to allow it.`,
        );
      }
      if (
        !force &&
        record.accessToken !== null &&
        record.accessTokenExpiresAt !== null &&
        record.accessTokenExpiresAt.getTime() - now().getTime() > refreshAheadMs
      ) {
        return open(record.accessToken, googleSealContext.accessToken);
      }
      refreshing ??= refresh(record).finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },

    onRevoked(listener) {
      revokedListeners.add(listener);
      return () => {
        revokedListeners.delete(listener);
      };
    },

    onSignedIn(listener) {
      signedInListeners.add(listener);
      return () => {
        signedInListeners.delete(listener);
      };
    },
  };
}
