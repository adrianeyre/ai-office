import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { openaiOAuth, type OAuthProvider } from "./oauth.ts";

// A fake AI Provider OAuth server, for tests: an authorization endpoint
// that signs the Owner in at once and shows the code to paste back, and a
// token endpoint that checks PKCE (the verifier must hash to the login's
// challenge), uses each code once, and rotates refresh tokens. It can be
// told to refuse refreshes (as when a subscription is signed out) or to
// fail (as when it cannot be reached). Its tokens are shaped like
// Anthropic's, so redaction treats them as it would the real ones.
// Started `{ device: true }`, it is shaped like xAI's instead: a device
// login (RFC 8628) whose user code the Owner approves, and token requests
// sent as forms. Started `{ openai: true }`, it is shaped like OpenAI's
// (Codex's sign-in): the sign-in ends by redirecting to the local callback,
// whose address the Owner pastes back; token requests are forms, without
// the state; and access tokens are JWTs naming their ChatGPT account and
// their expiry, with no `expires_in` beside them. Started `{ qwen: true }`,
// it is shaped like Qwen's: a device login proved with PKCE (the device
// code is asked for with a challenge, and the tokens with its verifier),
// whose answers name the host its API is at (`resource_url`).

export interface FakeOAuthServer {
  /** The provider, pointing at this server. */
  readonly provider: OAuthProvider;
  /** Every request to the token endpoint, its body parsed. */
  readonly tokenRequests: Record<string, string>[];
  /** Access tokens it issued, newest last. */
  readonly accessTokens: string[];
  /** How long new access tokens last, in seconds; 8 hours by default. */
  expiresIn: number;
  /** Answers refreshes with 400 `invalid_grant` while true. */
  refuseRefreshes: boolean;
  /** Answers every token request with this status while set (say 503). */
  failWith: number | undefined;
  /**
   * What the usage endpoint (Anthropic's and OpenAI's shapes) answers a
   * request with a token it issued; it answers this status instead while
   * set.
   */
  usage: unknown;
  usageFailWith: number | undefined;
  /**
   * Every request to the usage endpoint: its token, beta flags and (OpenAI's
   * shape) the ChatGPT account it names.
   */
  readonly usageRequests: {
    readonly token: string;
    readonly beta: string | undefined;
    readonly account?: string | undefined;
  }[];
  /** The clock OpenAI-shaped tokens' `exp` is set from; the real one by default. */
  now: () => Date;
  /** The `resource_url` Qwen-shaped answers name; none while undefined. */
  resourceUrl: string | undefined;
  /**
   * Signs the Owner in at `authorizeUrl`, as their browser would, and
   * returns what they paste back: `code#state`, as its page shows it, or
   * (OpenAI's shape) the callback address it redirected to.
   */
  signIn(authorizeUrl: string): Promise<string>;
  /** Whether a refresh token would still be taken. */
  refreshTokenValid(token: string): boolean;
  /** Approves (or denies) a device login, as the Owner would on its page. */
  approve(userCode: string, approved?: boolean): void;
  /** Issues tokens as if another client had signed in: for imports. */
  issue(): { access_token: string; refresh_token: string; expires_in: number };
  close(): Promise<void>;
}

const clientId = "fake-oauth-client";

/** The ChatGPT account the OpenAI-shaped server's tokens are for. */
export const fakeChatgptAccountId = "fake-chatgpt-account-0001";

/** A JWT with `claims`, unsigned (its signature is never checked here). */
const fakeJwt = (claims: Record<string, unknown>): string =>
  [{ alg: "RS256", typ: "JWT" }, claims, "signature"]
    .map((part, index) =>
      index === 2
        ? randomBytes(16).toString("base64url")
        : Buffer.from(JSON.stringify(part)).toString("base64url"),
    )
    .join(".");

export async function startFakeOAuthServer(
  options: {
    readonly device?: boolean;
    readonly openai?: boolean;
    readonly qwen?: boolean;
  } = {},
): Promise<FakeOAuthServer> {
  const qwen = options.qwen === true;
  const device = options.device === true || qwen;
  const openai = options.openai === true;
  /** Whether token requests are forms (xAI's and OpenAI's) or JSON. */
  const forms = device || openai;
  /**
   * Device logins: their user code, whether approved (or denied), and
   * (Qwen's) their PKCE challenge.
   */
  const devices = new Map<
    string,
    { userCode: string; approved: boolean | undefined; challenge?: string }
  >();
  /** Codes not yet used: what they were issued for. */
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; state: string }
  >();
  const refreshTokens = new Set<string>();
  let issued = 0;

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const issue = () => {
    issued += 1;
    const suffix = `${String(issued)}-${randomBytes(12).toString("hex")}`;
    if (openai) {
      // OpenAI's: a JWT that says when it expires and for which account.
      const tokens = {
        access_token: fakeJwt({
          iss: "https://auth.openai.com",
          exp: Math.floor(fake.now().getTime() / 1000) + fake.expiresIn,
          "https://api.openai.com/auth": {
            chatgpt_account_id: fakeChatgptAccountId,
            chatgpt_plan_type: "plus",
          },
        }),
        refresh_token: `rt_fake-${suffix}`,
        id_token: fakeJwt({ email: "owner@example.com" }),
        token_type: "Bearer",
      };
      refreshTokens.add(tokens.refresh_token);
      fake.accessTokens.push(tokens.access_token);
      return { ...tokens, expires_in: fake.expiresIn };
    }
    const tokens = {
      access_token: qwen
        ? `qwen-oat-fake-${suffix}`
        : device
          ? `xai-oat-fake-${suffix}`
          : `sk-ant-oat01-fake-${suffix}`,
      refresh_token: qwen
        ? `qwen-ort-fake-${suffix}`
        : device
          ? `xai-ort-fake-${suffix}`
          : `sk-ant-ort01-fake-${suffix}`,
      expires_in: fake.expiresIn,
      token_type: "Bearer",
      ...(qwen && fake.resourceUrl !== undefined
        ? { resource_url: fake.resourceUrl }
        : {}),
    };
    refreshTokens.add(tokens.refresh_token);
    fake.accessTokens.push(tokens.access_token);
    return tokens;
  };

  /** Tokens as the token endpoint sends them: OpenAI's without `expires_in`. */
  const answer = () =>
    openai
      ? Object.fromEntries(
          Object.entries(issue()).filter(([field]) => field !== "expires_in"),
        )
      : issue();

  /** A token or device request's body: JSON, or a form for xAI's shape. */
  const parseBody = (text: string, type: string): Record<string, string> =>
    type.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(text))
      : (JSON.parse(text) as Record<string, string>);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    if (
      device &&
      request.method === "POST" &&
      url.pathname === "/oauth2/device/code"
    ) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = parseBody(
          Buffer.concat(chunks).toString("utf8"),
          request.headers["content-type"] ?? "",
        );
        if (body["client_id"] !== clientId || body["scope"] === undefined) {
          send(response, 400, { error: "invalid_client" });
          return;
        }
        // Qwen's asks for a PKCE challenge.
        const challenge = body["code_challenge"] ?? "";
        if (
          qwen &&
          (body["code_challenge_method"] !== "S256" ||
            !/^[A-Za-z0-9_-]{43}$/.test(challenge))
        ) {
          send(response, 400, { error: "invalid_request" });
          return;
        }
        const deviceCode = randomBytes(16).toString("hex");
        const userCode = `ABCD-${String(devices.size + 1).padStart(4, "0")}`;
        devices.set(deviceCode, {
          userCode,
          approved: undefined,
          ...(qwen ? { challenge } : {}),
        });
        send(response, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${base}/device`,
          verification_uri_complete: `${base}/device?user_code=${userCode}`,
          expires_in: 600,
          interval: 5,
        });
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      const query = url.searchParams;
      const challenge = query.get("code_challenge") ?? "";
      const state = query.get("state") ?? "";
      if (
        query.get("client_id") !== clientId ||
        query.get("response_type") !== "code" ||
        query.get("code_challenge_method") !== "S256" ||
        query.get("redirect_uri") !== fake.provider.redirectUri ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        state === ""
      ) {
        send(response, 400, { error: "invalid_request" });
        return;
      }
      if (
        openai &&
        (query.get("codex_cli_simplified_flow") !== "true" ||
          query.get("code") !== null)
      ) {
        send(response, 400, { error: "invalid_request" });
        return;
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge,
        redirectUri: query.get("redirect_uri") ?? "",
        state,
      });
      if (openai) {
        // Back to the CLI's local callback, which the Owner's browser
        // cannot open: its address holds the code.
        const callback = new URL(fake.provider.redirectUri);
        callback.search = new URLSearchParams({
          code,
          scope: query.get("scope") ?? "",
          state,
        }).toString();
        response.writeHead(302, { location: callback.toString() });
        response.end();
        return;
      }
      // The page the Owner sees: the code to paste back.
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`${code}#${state}`);
      return;
    }
    if (
      request.method === "GET" &&
      ((!forms && url.pathname === "/api/oauth/usage") ||
        (openai && url.pathname === "/backend-api/wham/usage"))
    ) {
      const token = /^Bearer (.+)$/.exec(
        request.headers.authorization ?? "",
      )?.[1];
      fake.usageRequests.push({
        token: token ?? "",
        beta: request.headers["anthropic-beta"] as string | undefined,
        account: request.headers["chatgpt-account-id"] as string | undefined,
      });
      if (token === undefined || !fake.accessTokens.includes(token)) {
        send(response, 401, { error: "invalid_token" });
        return;
      }
      if (fake.usageFailWith !== undefined) {
        send(response, fake.usageFailWith, { error: "server_error" });
        return;
      }
      send(response, 200, fake.usage);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/oauth/token") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const type = request.headers["content-type"] ?? "";
        // xAI's and OpenAI's shapes take forms only; Anthropic's, JSON only.
        if (forms !== type.includes("application/x-www-form-urlencoded")) {
          send(response, 415, { error: "invalid_request" });
          return;
        }
        const body = parseBody(Buffer.concat(chunks).toString("utf8"), type);
        fake.tokenRequests.push(body);
        if (fake.failWith !== undefined) {
          send(response, fake.failWith, { error: "server_error" });
          return;
        }
        if (body["client_id"] !== clientId) {
          send(response, 401, { error: "invalid_client" });
          return;
        }
        if (body["grant_type"] === "authorization_code") {
          const login = codes.get(body["code"] ?? "");
          // A code is used once, whatever happens.
          codes.delete(body["code"] ?? "");
          const challenge = createHash("sha256")
            .update(body["code_verifier"] ?? "")
            .digest("base64url");
          // OpenAI's exchange takes no state, as Codex sends none.
          const verified =
            login?.challenge === challenge &&
            body["redirect_uri"] === login.redirectUri &&
            (openai
              ? body["state"] === undefined
              : body["state"] === login.state);
          if (!verified) {
            send(response, 400, { error: "invalid_grant" });
            return;
          }
          send(response, 200, answer());
          return;
        }
        if (
          device &&
          body["grant_type"] === "urn:ietf:params:oauth:grant-type:device_code"
        ) {
          const login = devices.get(body["device_code"] ?? "");
          if (login === undefined) {
            send(response, 400, { error: "expired_token" });
            return;
          }
          if (
            login.challenge !== undefined &&
            createHash("sha256")
              .update(body["code_verifier"] ?? "")
              .digest("base64url") !== login.challenge
          ) {
            send(response, 400, { error: "invalid_grant" });
            return;
          }
          if (login.approved === undefined) {
            send(response, 400, { error: "authorization_pending" });
            return;
          }
          devices.delete(body["device_code"] ?? "");
          send(
            response,
            login.approved ? 200 : 400,
            login.approved ? answer() : { error: "access_denied" },
          );
          return;
        }
        if (body["grant_type"] === "refresh_token") {
          const token = body["refresh_token"] ?? "";
          if (fake.refuseRefreshes || !refreshTokens.has(token)) {
            send(response, 400, { error: "invalid_grant" });
            return;
          }
          // Rotated: the old refresh token is used up.
          refreshTokens.delete(token);
          send(response, 200, answer());
          return;
        }
        send(response, 400, { error: "unsupported_grant_type" });
      });
      return;
    }
    send(response, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;

  const fake: FakeOAuthServer = {
    provider: openai
      ? {
          // OpenAI's own settings (Codex's), pointed at this server.
          ...openaiOAuth,
          authorizeUrl: `${base}/oauth/authorize`,
          tokenUrl: `${base}/v1/oauth/token`,
          clientId,
          usageUrl: `${base}/backend-api/wham/usage`,
        }
      : device
        ? {
            ...(qwen ? { devicePkce: true } : {}),
            flow: "device",
            authorizeUrl: `${base}/oauth/authorize`,
            deviceCodeUrl: `${base}/oauth2/device/code`,
            tokenUrl: `${base}/v1/oauth/token`,
            tokenFormat: "form",
            redirectUri: "",
            clientId,
            scopes: ["api:access", "offline_access"],
            betas: [],
          }
        : {
            authorizeUrl: `${base}/oauth/authorize`,
            tokenUrl: `${base}/v1/oauth/token`,
            redirectUri: `${base}/oauth/code/callback`,
            clientId,
            scopes: ["user:inference"],
            authorizeParams: { code: "true" },
            betas: ["oauth-2025-04-20"],
            usageUrl: `${base}/api/oauth/usage`,
          },
    tokenRequests: [],
    accessTokens: [],
    expiresIn: 8 * 60 * 60,
    refuseRefreshes: false,
    failWith: undefined,
    usage: {},
    usageFailWith: undefined,
    usageRequests: [],
    now: () => new Date(),
    resourceUrl: undefined,
    async signIn(authorizeUrl) {
      const response = await fetch(authorizeUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status === 302 && location !== null) {
        return location;
      }
      if (!response.ok) {
        throw new Error(`The fake sign-in refused: ${String(response.status)}`);
      }
      return response.text();
    },
    refreshTokenValid: (token) => refreshTokens.has(token),
    approve(userCode, approved = true) {
      for (const login of devices.values()) {
        if (login.userCode === userCode) {
          login.approved = approved;
        }
      }
    },
    issue: () => issue(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  return fake;
}
