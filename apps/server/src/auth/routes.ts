import type { EventBus } from "@ai-office/events";
import {
  allowedInternalHosts,
  apiErrorCodes,
  apiKeyLoginRequestSchema,
  firstPasswordId,
  loginRequestSchema,
  setupRequestSchema,
  totpCodeRequestSchema,
  type ApiError,
  type LoginResponse,
  type SessionResponse,
  type SignedOutEverywhere,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";
import type { FastifyInstance } from "fastify";

import { clientOf, matchingPassword, recordAttempt } from "./attempts.ts";
import { clientKey, type LoginLimiter } from "./login-limiter.ts";
import { hashPassword } from "./password.ts";
import {
  notFoundBody,
  sendInvalidRequest,
  sendTooManyAttempts,
} from "./responses.ts";
import { sessionOf, type Session, type Sessions } from "./sessions.ts";
import { isLoopback, isServedAt, type SetupToken } from "./setup-token.ts";
import { signInChanged } from "./sign-in-changes.ts";
import type { SignInChallenges } from "./sign-in-challenges.ts";
import type { AuthStore, SignInEvent } from "./store.ts";
import { useSecondFactor } from "./totp-routes.ts";

const sessionResponse = (session: Session): SessionResponse => ({
  csrfToken: session.csrfToken,
  expiresAt: session.expiresAt.toISOString(),
  gatewayKeyId: session.gatewayKeyId ?? null,
  passwordId: session.passwordId ?? null,
  allowedInternalHosts: [...allowedInternalHosts()],
});

/** Finds an API key that may sign in to the web app. */
export interface UiKeys {
  /** The key's id, if it is in use, enabled and has UI access. */
  uiKey(key: string): Promise<{ readonly id: string } | undefined>;
  /** Every key that may sign in now, by name: never the key. */
  signInKeys(): Promise<{ readonly id: string; readonly name: string }[]>;
}

/**
 * The routes that set the password, sign in and out, and describe the
 * session. Their access is enforced by the hook in `access.ts`.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  options: {
    readonly store: AuthStore;
    readonly sessions: Sessions;
    readonly challenges: SignInChallenges;
    readonly encryptor: Encryptor;
    readonly loginLimiter: LoginLimiter;
    readonly now: () => Date;
    /** Where sign-ins and sign-outs are published, for the Activity Feed. */
    readonly events: EventBus;
    readonly onPasswordSet: () => void;
    /** API keys that may sign in; none, and no key signs in. */
    readonly uiKeys?: UiKeys | undefined;
    /** The address AI Office is reached at (PUBLIC_URL), if known. */
    readonly publicUrl?: string | undefined;
    /**
     * The one-time setup token, written to a file as the server started
     * with no password; without one, only this machine may set it up.
     */
    readonly setupToken?: SetupToken | undefined;
  },
): void {
  const { store, sessions, challenges, loginLimiter, now, events } = options;

  /** Records a checked sign-in attempt (FR-4), with the lockout it started. */
  const recorded = (attempt: SignInEvent, lockoutMs = 0) =>
    recordAttempt({ store, events }, attempt, { lockoutMs });

  /** Starts a session for a password sign-in, noting a further one's use. */
  const signedIn = async (
    reply: Parameters<Sessions["start"]>[0],
    passwordId: string | null,
  ) => {
    if (passwordId !== null) {
      await store.touchOwnerPassword(passwordId, now());
    }
    return sessions.start(reply, { passwordId });
  };

  // The first-run setup screen (PRD FR-1). Whoever sets the password is
  // the Owner, so it takes something from the host (A1-2): a request from
  // this machine's loopback, or the one-time setup token; and only for a
  // name AI Office is served at, never a rebound one.
  app.post(
    "/api/setup",
    { config: { access: "setup" } },
    async (request, reply) => {
      if (!isServedAt(request.host, options.publicUrl)) {
        const body: ApiError = {
          error: apiErrorCodes.wrongHost,
          message:
            "AI Office is not served at that name. Open it at its own address (PUBLIC_URL) to set the password.",
        };
        return reply.code(421).send(body);
      }
      const parsed = setupRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { token } = parsed.data;
      const fromHost =
        isLoopback(request.ip) ||
        (token !== undefined && options.setupToken?.matches(token) === true);
      if (!fromHost) {
        request.log.warn(
          { client: request.ip, withToken: token !== undefined },
          "A setup from another machine was refused: it needs the setup token.",
        );
        const where = options.setupToken?.where;
        const body: ApiError = {
          error: apiErrorCodes.setupTokenRequired,
          message:
            where === undefined
              ? "Set the password from the machine AI Office runs on."
              : `Setting the password from another machine needs the one-time setup token AI Office wrote to ${where} as it started. Under docker compose: docker compose exec app cat ${where}`,
        };
        return reply.code(403).send(body);
      }
      const created = await store.createPasswordHash(
        await hashPassword(parsed.data.password),
      );
      if (!created) {
        // Another setup request got there first.
        return reply.code(404).send(notFoundBody);
      }
      await options.setupToken?.spend();
      options.onPasswordSet();
      await signInChanged(events, "ownerPasswords.firstSet");
      request.log.info("The Owner's password was set.");
      return reply.code(204).send();
    },
  );

  // Rate-limited per client (PRD FR-4); every checked attempt is recorded
  // in `sign_in_events`. With TOTP on (FR-3), a right password starts a
  // sign-in challenge that `POST /api/login/totp` finishes.
  app.post(
    "/api/login",
    { config: { access: "sign-in" } },
    async (request, reply) => {
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const client = clientKey(request.ip);
      const attempt = loginLimiter.attempt(client);
      if (!attempt.allowed) {
        return sendTooManyAttempts(reply, attempt.retryAfterSeconds);
      }

      const passwordId = await matchingPassword(store, parsed.data.password);
      const correct = passwordId !== undefined;
      const event = clientOf(request, now);
      if (!correct) {
        await recorded({ ...event, outcome: "failed" }, attempt.lockoutMs);
        request.log.warn({ client }, "A sign-in failed: wrong password.");
        if (attempt.lockoutMs > 0) {
          request.log.warn(
            { client, lockoutSeconds: attempt.lockoutMs / 1000 },
            "Sign-ins from this client are locked out after repeated failures.",
          );
        }
        const body: ApiError = {
          error: apiErrorCodes.wrongPassword,
          message: "That password is not right.",
        };
        return reply.code(401).send(body);
      }
      if ((await store.totp()).secret !== null) {
        // Not a failure, and not yet a sign-in: earlier failures stand,
        // and each wrong code will count.
        attempt.withdraw();
        challenges.start(reply, passwordId);
        request.log.info(
          { client },
          "The password was right; awaiting a code.",
        );
        return { secondFactor: "totp" } satisfies LoginResponse;
      }
      attempt.succeeded();
      await recorded({ ...event, outcome: "succeeded" });
      const session = await signedIn(reply, passwordId);
      request.log.info({ client }, "The Owner signed in.");
      return sessionResponse(session) satisfies LoginResponse;
    },
  );

  // Signing in with an API key that has UI access (AI proxy and UI),
  // rate-limited and recorded as a password sign-in is. The key is a
  // long random secret, so no second factor is asked for.
  app.post(
    "/api/login/api-key",
    { config: { access: "sign-in" } },
    async (request, reply) => {
      const parsed = apiKeyLoginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const client = clientKey(request.ip);
      const attempt = loginLimiter.attempt(client);
      if (!attempt.allowed) {
        return sendTooManyAttempts(reply, attempt.retryAfterSeconds);
      }
      const found = await options.uiKeys?.uiKey(parsed.data.key);
      const event = clientOf(request, now);
      if (found === undefined) {
        await recorded({ ...event, outcome: "failed" }, attempt.lockoutMs);
        request.log.warn({ client }, "A sign-in with an API key failed.");
        const body: ApiError = {
          error: apiErrorCodes.wrongApiKey,
          message:
            "That API key cannot sign in: it is not one in use, enabled, with UI access.",
        };
        return reply.code(401).send(body);
      }
      attempt.succeeded();
      await recorded({ ...event, outcome: "succeeded" });
      const session = await sessions.start(reply, { gatewayKeyId: found.id });
      request.log.info(
        { client, gatewayKeyId: found.id },
        "Signed in with an API key.",
      );
      return sessionResponse(session) satisfies LoginResponse;
    },
  );

  // The second step of a sign-in with TOTP on: a code from the Owner's
  // authenticator app, or one of their recovery codes (used up by this).
  app.post(
    "/api/login/totp",
    { config: { access: "sign-in" } },
    async (request, reply) => {
      const parsed = totpCodeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const totp = await store.totp();
      if (!challenges.isOpen(request) || totp.secret === null) {
        challenges.end(request, reply);
        const body: ApiError = {
          error: apiErrorCodes.signInExpired,
          message: "Enter the password again.",
        };
        return reply.code(401).send(body);
      }
      const client = clientKey(request.ip);
      const attempt = loginLimiter.attempt(client);
      if (!attempt.allowed) {
        return sendTooManyAttempts(reply, attempt.retryAfterSeconds);
      }

      const event = clientOf(request, now);
      const { factor, valid } = await useSecondFactor({
        store,
        encryptor: options.encryptor,
        totp: { ...totp, secret: totp.secret },
        code: parsed.data.code,
        now: event.occurredAt,
      });
      if (!valid) {
        await recorded(
          { ...event, outcome: "failed", secondFactor: factor },
          attempt.lockoutMs,
        );
        request.log.warn(
          { client, secondFactor: factor },
          "A sign-in failed: wrong code.",
        );
        if (attempt.lockoutMs > 0) {
          request.log.warn(
            { client, lockoutSeconds: attempt.lockoutMs / 1000 },
            "Sign-ins from this client are locked out after repeated failures.",
          );
        }
        const body: ApiError = {
          error: apiErrorCodes.wrongCode,
          message: "That code is not right, or was already used.",
        };
        return reply.code(401).send(body);
      }
      attempt.succeeded();
      const challengedId = challenges.passwordIdOf(request);
      challenges.end(request, reply);
      await recorded({
        ...event,
        outcome: "succeeded",
        secondFactor: factor,
      });
      const session = await signedIn(reply, challengedId);
      if (factor === "recovery_code") {
        request.log.warn(
          {
            client,
            recoveryCodesLeft: (await store.totp()).recoveryCodesLeft,
          },
          "The Owner signed in with a recovery code.",
        );
      } else {
        request.log.info({ client }, "The Owner signed in with TOTP.");
      }
      return sessionResponse(session) satisfies LoginResponse;
    },
  );

  app.get("/api/session", { config: { access: "owner" } }, (request) =>
    sessionResponse(sessionOf(request)),
  );

  app.post(
    "/api/logout",
    { config: { access: "owner" } },
    async (request, reply) => {
      await sessions.end(sessionOf(request), reply);
      await events.publish({
        type: "signed_out",
        version: 1,
        everywhere: false,
      });
      request.log.info("The Owner signed out.");
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/logout/everywhere",
    { config: { access: "owner" } },
    async (request, reply) => {
      const ended = await sessions.endAll(reply);
      await events.publish({
        type: "signed_out",
        version: 1,
        everywhere: true,
      });
      request.log.info({ sessions: ended }, "The Owner signed out everywhere.");
      // Ending sessions takes away no password and no API key, so the
      // Owner is told what still signs in, to remove what they do not
      // recognise (A1-3).
      const body: SignedOutEverywhere = {
        sessionsEnded: ended,
        stillSignIn: {
          passwords: [
            { id: firstPasswordId, name: "The first password, set at setup" },
            ...(await store.ownerPasswords()).map(({ id, name }) => ({
              id,
              name,
            })),
          ],
          apiKeys: (await options.uiKeys?.signInKeys()) ?? [],
        },
      };
      return reply.header("cache-control", "no-store").send(body);
    },
  );
}
