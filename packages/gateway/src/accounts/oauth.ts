import { createHash, randomBytes } from "node:crypto";

// OAuth logins for subscription AI Accounts (PRD FR-35, FR-36), as the AI
// Provider's own CLI signs in, and refreshing their tokens. Either:
// - the authorization code flow with PKCE (RFC 7636): the Owner opens the
//   authorization URL, signs in, and pastes back the code the AI
//   Provider's page shows (Claude), or the address its sign-in ends on,
//   which holds the code (ChatGPT), and AI Office exchanges it for tokens;
// - or the device authorization flow (RFC 8628): AI Office asks for a
//   device code, the Owner approves its user code on the AI Provider's
//   page, and AI Office then asks for the tokens (xAI), proving the login
//   with PKCE where the AI Provider asks for it (Qwen).
// No token or code is ever logged or put in an error's message.

/** Where an AI Provider's OAuth login lives, and the client it signs in as. */
export interface OAuthProvider {
  /** How the Owner signs in: pasting back a code (by default), or a device. */
  readonly flow?: "pkce" | "device";
  readonly authorizeUrl: string;
  /** A device login's code endpoint. */
  readonly deviceCodeUrl?: string;
  /** Whether a device login is proved with PKCE (RFC 7636), as Qwen's is. */
  readonly devicePkce?: boolean;
  readonly tokenUrl: string;
  /** How token requests are sent: JSON (by default) or a form. */
  readonly tokenFormat?: "json" | "form";
  /** The page that shows the Owner the code to paste back. */
  readonly redirectUri: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** What else the authorization URL asks, as the AI Provider's CLI does. */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /**
   * Whether the code's exchange sends the login's `state` too, as
   * Anthropic's requires; true when absent.
   */
  readonly exchangeState?: boolean;
  /** The `anthropic-beta` flags a request made with its tokens needs. */
  readonly betas: readonly string[];
  /**
   * The headers a request made with an access token needs beside it, such
   * as the ChatGPT account it is for.
   */
  readonly requestHeaders?: (accessToken: string) => Record<string, string>;
  /**
   * Where the subscription's usage windows can be read with its access
   * token, without making a request through it; none for most.
   */
  readonly usageUrl?: string;
}

/**
 * Claude subscriptions sign in as Claude Code does (its public client).
 * Anthropic does not document these; they are what Claude Code uses.
 */
export const anthropicOAuth: OAuthProvider = {
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
  // Ask Claude's page to show the code, to paste back.
  authorizeParams: { code: "true" },
  betas: ["oauth-2025-04-20"],
  // What Claude Code's `/usage` reads.
  usageUrl: "https://api.anthropic.com/api/oauth/usage",
};

/** The claims in a JWT's payload; undefined for any other token. */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const [, payload] = token.split(".");
  if (payload === undefined) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return typeof claims === "object" && claims !== null
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ChatGPT account (workspace) an OpenAI access token is for, from its
 * `https://api.openai.com/auth` claim; undefined if it does not say.
 */
export function chatgptAccountIdOf(accessToken: string): string | undefined {
  const auth = jwtClaims(accessToken)?.["https://api.openai.com/auth"];
  const id =
    typeof auth === "object" && auth !== null
      ? (auth as Record<string, unknown>)["chatgpt_account_id"]
      : undefined;
  return typeof id === "string" && /^[\w-]{1,200}$/.test(id) ? id : undefined;
}

/** What a request with an OpenAI access token needs: its ChatGPT account. */
export function chatgptRequestHeaders(
  accessToken: string,
): Record<string, string> {
  const accountId = chatgptAccountIdOf(accessToken);
  return accountId === undefined ? {} : { "chatgpt-account-id": accountId };
}

/**
 * ChatGPT subscriptions sign in as OpenAI's Codex CLI does (its public
 * client), with PKCE. Its sign-in ends on Codex's local callback
 * (`localhost:1455`), which nothing serves here: the Owner pastes back the
 * address the browser shows, holding the code and the state. OpenAI does
 * not document these for other tools; they are what Codex uses. Its
 * answers' expiry is read from the access token (a JWT) when they do not
 * give `expires_in`, and each request names the ChatGPT account the token
 * is for.
 */
export const openaiOAuth: OAuthProvider = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  tokenFormat: "form",
  redirectUri: "http://localhost:1455/auth/callback",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  authorizeParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  },
  exchangeState: false,
  betas: [],
  requestHeaders: (accessToken) => chatgptRequestHeaders(accessToken),
  // What Codex's `/status` reads.
  usageUrl: "https://chatgpt.com/backend-api/wham/usage",
};

/**
 * Grok subscriptions sign in as xAI's Grok CLI does (its public client),
 * with the device flow. xAI does not document these; they are what the
 * CLI is reported to use, and its access tokens last about six hours.
 */
export const xaiOAuth: OAuthProvider = {
  flow: "device",
  authorizeUrl: "https://auth.x.ai/oauth2/auth",
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  tokenFormat: "form",
  redirectUri: "",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "grok-cli:access",
    "api:access",
  ],
  betas: [],
};

/**
 * Qwen sign-ins, as Qwen Code signs in (its public client), with the
 * device flow and PKCE. Each answer names the host its API is at
 * (`resource_url`). Qwen does not document these for other tools; they
 * are what Qwen Code uses.
 */
export const qwenOAuth: OAuthProvider = {
  flow: "device",
  devicePkce: true,
  authorizeUrl: "https://chat.qwen.ai/authorize",
  deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
  tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
  tokenFormat: "form",
  redirectUri: "",
  clientId: "f0304373b74a44d2b584a3fb70ca9e56",
  scopes: ["openid", "profile", "email", "model.completion"],
  betas: [],
};

/** A login's tokens. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  /**
   * Where its API is, when the answer says (Qwen's `resource_url`): an
   * address without the `/v1` its paths start with.
   */
  readonly apiUrl?: string;
}

/**
 * The API address in a `resource_url`: a host (`portal.qwen.ai`), which is
 * reached over HTTPS, or a whole `http(s)://` address, as Qwen Code takes
 * it; with or without `/v1`. Undefined for anything else.
 */
export function apiUrlOf(resourceUrl: unknown): string | undefined {
  if (typeof resourceUrl !== "string" || resourceUrl.trim() === "") {
    return undefined;
  }
  const text = resourceUrl.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

/**
 * Why tokens could not be had: `refused` when the AI Provider said no (a
 * bad code, or a refresh token it no longer takes), `unavailable` when it
 * could not be reached or failed, `pending` while a device login waits for
 * the Owner to approve it.
 */
export class OAuthError extends Error {
  readonly reason: "refused" | "unavailable" | "pending";

  constructor(
    reason: "refused" | "unavailable" | "pending",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OAuthError";
    this.reason = reason;
  }
}

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** Where the Owner signs in, for a login with `challenge` and `state`. */
export function authorizationUrl(
  provider: OAuthProvider,
  login: { readonly challenge: string; readonly state: string },
): string {
  const url = new URL(provider.authorizeUrl);
  url.search = new URLSearchParams({
    ...provider.authorizeParams,
    client_id: provider.clientId,
    response_type: "code",
    redirect_uri: provider.redirectUri,
    scope: provider.scopes.join(" "),
    code_challenge: login.challenge,
    code_challenge_method: "S256",
    state: login.state,
  }).toString();
  return url.toString();
}

/**
 * The code and state in what the Owner pasted: `code#state`, as Claude's
 * page shows it, or the address a sign-in ended on, with `code` and
 * `state` in its query (ChatGPT's). An address without a code (one that
 * says `error=`) gives an empty code.
 */
export function pastedCode(pasted: string): { code: string; state?: string } {
  const text = pasted.trim();
  if (/^https?:\/\//i.test(text)) {
    let query: URLSearchParams;
    try {
      query = new URL(text).searchParams;
    } catch {
      return { code: "" };
    }
    const code = query.get("code") ?? "";
    const state = query.get("state") ?? "";
    return state === "" ? { code } : { code, state };
  }
  const [code = "", state] = text.split("#", 2);
  return state === undefined || state === "" ? { code } : { code, state };
}

export type Fetch = typeof fetch;

/** Asks the token endpoint for tokens; `previous` keeps a refresh token. */
async function requestTokens(
  provider: OAuthProvider,
  body: Record<string, string>,
  options: {
    readonly fetch: Fetch;
    readonly now: Date;
    readonly previousRefreshToken?: string;
  },
): Promise<OAuthTokens> {
  let response: Response;
  try {
    const fields = { ...body, client_id: provider.clientId };
    response = await options.fetch(provider.tokenUrl, {
      method: "POST",
      headers: {
        "content-type":
          provider.tokenFormat === "form"
            ? "application/x-www-form-urlencoded"
            : "application/json",
        accept: "application/json",
      },
      body:
        provider.tokenFormat === "form"
          ? new URLSearchParams(fields).toString()
          : JSON.stringify(fields),
      signal: AbortSignal.timeout(30_000),
      // A code or refresh token goes to the token endpoint only
      // (pen-testing G1-7).
      redirect: "manual",
    });
  } catch (error) {
    throw new OAuthError(
      "unavailable",
      "The AI Provider's sign-in could not be reached.",
      { cause: error },
    );
  }
  const parsed = (await response.json().catch(() => undefined)) as
    Record<string, unknown> | undefined;
  if (!response.ok) {
    // Its error code (such as `invalid_grant`), never its whole body.
    const error = parsed?.["error"];
    if (error === "authorization_pending" || error === "slow_down") {
      throw new OAuthError("pending", "The sign-in has not been approved yet.");
    }
    const code = typeof error === "string" ? ` (${error})` : "";
    throw new OAuthError(
      response.status >= 400 && response.status < 500
        ? "refused"
        : "unavailable",
      `The AI Provider's sign-in answered ${String(response.status)}${code}.`,
    );
  }
  const accessToken = parsed?.["access_token"];
  const refreshToken =
    parsed?.["refresh_token"] ?? options.previousRefreshToken;
  const expiresIn = parsed?.["expires_in"];
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof refreshToken !== "string" ||
    refreshToken === ""
  ) {
    throw new OAuthError(
      "unavailable",
      "The AI Provider's sign-in answered without the tokens.",
    );
  }
  // Its lifetime, or else the access token's own `exp`.
  const expiresAt =
    typeof expiresIn === "number" && expiresIn > 0
      ? new Date(options.now.getTime() + expiresIn * 1000)
      : jwtExpiry(accessToken);
  if (expiresAt === undefined || expiresAt <= options.now) {
    throw new OAuthError(
      "unavailable",
      "The AI Provider's sign-in answered without the tokens' expiry.",
    );
  }
  const apiUrl = apiUrlOf(parsed?.["resource_url"]);
  return {
    accessToken,
    refreshToken,
    expiresAt,
    ...(apiUrl === undefined ? {} : { apiUrl }),
  };
}

/** Exchanges a pasted code for tokens, proving the login with its verifier. */
export const exchangeCode = (
  provider: OAuthProvider,
  login: {
    readonly code: string;
    readonly state: string;
    readonly verifier: string;
  },
  options: { readonly fetch: Fetch; readonly now: Date },
): Promise<OAuthTokens> =>
  requestTokens(
    provider,
    {
      grant_type: "authorization_code",
      code: login.code,
      ...(provider.exchangeState === false ? {} : { state: login.state }),
      redirect_uri: provider.redirectUri,
      code_verifier: login.verifier,
    },
    options,
  );

/** New tokens for a refresh token; the same one if no new one is given. */
export const refreshTokens = (
  provider: OAuthProvider,
  refreshToken: string,
  options: { readonly fetch: Fetch; readonly now: Date },
): Promise<OAuthTokens> =>
  requestTokens(
    provider,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    { ...options, previousRefreshToken: refreshToken },
  );

/** A device login started: the code the Owner approves, and where. */
export interface DeviceLogin {
  readonly deviceCode: string;
  readonly userCode: string;
  /** The AI Provider's page, with the code filled in if it offers that. */
  readonly verificationUrl: string;
  readonly expiresAt: Date;
}

/**
 * Asks the AI Provider for a device login (RFC 8628), with the PKCE
 * `challenge` where it proves logins so.
 */
export async function startDeviceLogin(
  provider: OAuthProvider,
  options: {
    readonly fetch: Fetch;
    readonly now: Date;
    readonly challenge?: string;
  },
): Promise<DeviceLogin> {
  if (provider.deviceCodeUrl === undefined) {
    throw new OAuthError("unavailable", "This sign-in has no device login.");
  }
  let response: Response;
  try {
    response = await options.fetch(provider.deviceCodeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: provider.clientId,
        scope: provider.scopes.join(" "),
        ...(provider.devicePkce === true && options.challenge !== undefined
          ? {
              code_challenge: options.challenge,
              code_challenge_method: "S256",
            }
          : {}),
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OAuthError(
      "unavailable",
      "The AI Provider's sign-in could not be reached.",
      { cause: error },
    );
  }
  const parsed = (await response.json().catch(() => undefined)) as
    Record<string, unknown> | undefined;
  const deviceCode = parsed?.["device_code"];
  const userCode = parsed?.["user_code"];
  const verificationUrl =
    parsed?.["verification_uri_complete"] ?? parsed?.["verification_uri"];
  const expiresIn = parsed?.["expires_in"];
  if (
    !response.ok ||
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUrl !== "string" ||
    !/^https?:\/\//.test(verificationUrl)
  ) {
    throw new OAuthError(
      "unavailable",
      `The AI Provider's sign-in answered ${String(response.status)} without a device code.`,
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresAt: new Date(
      options.now.getTime() +
        (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 900) *
          1000,
    ),
  };
}

/**
 * The tokens for an approved device login, proved with its PKCE
 * `verifier` where the AI Provider asks for one; an `OAuthError` `pending`
 * while the Owner has not approved it yet.
 */
export const pollDeviceLogin = (
  provider: OAuthProvider,
  deviceCode: string,
  options: {
    readonly fetch: Fetch;
    readonly now: Date;
    readonly verifier?: string;
  },
): Promise<OAuthTokens> =>
  requestTokens(
    provider,
    {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      ...(provider.devicePkce === true && options.verifier !== undefined
        ? { code_verifier: options.verifier }
        : {}),
    },
    options,
  );

/** Field names a CLI's login file may use for each token. */
const accessTokenFields = ["access_token", "accessToken"];
const refreshTokenFields = ["refresh_token", "refreshToken"];
const expiryFields = ["expires_at", "expiresAt", "expiry", "expires"];

/** When a JWT expires, from its `exp` claim; undefined for any other token. */
function jwtExpiry(token: string): Date | undefined {
  const exp = jwtClaims(token)?.["exp"];
  return typeof exp === "number" ? new Date(exp * 1000) : undefined;
}

/** A time given as ISO 8601, or seconds or milliseconds since the epoch. */
function expiryOf(value: unknown): Date | undefined {
  if (typeof value === "number" && value > 0) {
    return new Date(value > 1e12 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return expiryOf(number);
    }
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? undefined : at;
  }
  return undefined;
}

/**
 * The tokens in a CLI's login file (such as the Grok CLI's
 * `~/.grok/auth.json`): the first object, at any depth, holding both an
 * access and a refresh token. Its expiry is its own field, or the access
 * token's `exp` claim; with neither it is taken as expiring now, so it is
 * refreshed at once. Undefined when the file holds no such tokens.
 */
export function tokensInLoginFile(
  text: string,
  now: Date,
): OAuthTokens | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const pick = (
    object: Record<string, unknown>,
    fields: readonly string[],
  ): unknown => fields.map((field) => object[field]).find((v) => v != null);
  const search = (value: unknown, depth: number): OAuthTokens | undefined => {
    if (typeof value !== "object" || value === null || depth > 6) {
      return undefined;
    }
    const object = value as Record<string, unknown>;
    const accessToken = pick(object, accessTokenFields);
    const refreshToken = pick(object, refreshTokenFields);
    if (
      typeof accessToken === "string" &&
      accessToken !== "" &&
      typeof refreshToken === "string" &&
      refreshToken !== ""
    ) {
      return {
        accessToken,
        refreshToken,
        expiresAt:
          expiryOf(pick(object, expiryFields)) ?? jwtExpiry(accessToken) ?? now,
      };
    }
    for (const child of Object.values(object)) {
      const found = search(child, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return search(parsed, 0);
}
