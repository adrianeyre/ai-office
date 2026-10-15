import { createHash, randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { readCookie } from "./sessions.ts";

// When TOTP is on, a right password does not start a session: it starts a
// sign-in challenge, which `POST /api/login/totp` finishes with a code. The
// challenge is a random token in an HttpOnly cookie scoped to `/api/login`;
// only its SHA-256 is kept, in memory, for five minutes. A restart forgets
// it, and the Owner types the password again.

export const signInChallengeCookie = "ai_office_sign_in";
export const signInChallengeLifetimeMs = 5 * 60_000;

export interface SignInChallenges {
  /**
   * Starts a challenge and sets its cookie on `reply`; `passwordId` is the
   * further Owner password that was right, null for the first.
   */
  start(reply: FastifyReply, passwordId?: string | null): void;
  /** Whether the request carries a challenge that has not expired. */
  isOpen(request: FastifyRequest): boolean;
  /** Which password the request's open challenge began with. */
  passwordIdOf(request: FastifyRequest): string | null;
  /** Ends the request's challenge and clears its cookie. */
  end(request: FastifyRequest, reply: FastifyReply): void;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export function createSignInChallenges(options: {
  readonly secureCookie: boolean;
  readonly now: () => Date;
}): SignInChallenges {
  /** Each open challenge's hash, and when it expires (ms). */
  const challenges = new Map<
    string,
    { readonly expiresAt: number; readonly passwordId: string | null }
  >();

  const cookie = (value: string, maxAgeSeconds: number): string =>
    [
      `${signInChallengeCookie}=${value}`,
      "Path=/api/login",
      `Max-Age=${String(maxAgeSeconds)}`,
      "HttpOnly",
      "SameSite=Strict",
      ...(options.secureCookie ? ["Secure"] : []),
    ].join("; ");

  const idOf = (request: FastifyRequest): string | undefined => {
    const token = readCookie(request.headers.cookie, signInChallengeCookie);
    return token === undefined || token === "" ? undefined : sha256(token);
  };

  return {
    start(reply, passwordId = null) {
      const at = options.now().getTime();
      for (const [id, { expiresAt }] of challenges) {
        if (expiresAt <= at) {
          challenges.delete(id);
        }
      }
      const token = randomBytes(32).toString("base64url");
      challenges.set(sha256(token), {
        expiresAt: at + signInChallengeLifetimeMs,
        passwordId,
      });
      void reply.header(
        "set-cookie",
        cookie(token, signInChallengeLifetimeMs / 1000),
      );
    },

    isOpen(request) {
      const id = idOf(request);
      const expiresAt =
        id === undefined ? undefined : challenges.get(id)?.expiresAt;
      return expiresAt !== undefined && expiresAt > options.now().getTime();
    },

    passwordIdOf(request) {
      const id = idOf(request);
      return (
        (id === undefined ? undefined : challenges.get(id)?.passwordId) ?? null
      );
    },

    end(request, reply) {
      const id = idOf(request);
      if (id !== undefined) {
        challenges.delete(id);
      }
      void reply.header("set-cookie", cookie("", 0));
    },
  };
}
