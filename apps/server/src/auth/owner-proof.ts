import {
  apiErrorCodes,
  type ApiError,
  type OwnerProof,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";
import type { EventBus } from "@ai-office/events";
import type { FastifyReply, FastifyRequest } from "fastify";

import { clientOf, matchingPassword, recordAttempt } from "./attempts.ts";
import { clientKey, type LoginLimiter } from "./login-limiter.ts";
import { sendTooManyAttempts } from "./responses.ts";
import { sessionOf } from "./sessions.ts";
import type { AuthStore } from "./store.ts";
import { useSecondFactor } from "./totp-routes.ts";

// A fresh proof of the Owner (A1-3). A session is enough to use the Office,
// but not to add a way to sign in that outlives it: adding an Owner
// password, making or widening an API key with UI access, and turning TOTP
// on each need one of the Owner's passwords, and a TOTP or recovery code
// when TOTP is on. A session begun with an API key never asked for either,
// so it cannot give one. Each check is a guess at the Owner's password, so
// it counts against the sign-in limiter and is recorded as a sign-in
// attempt is (A1-4): a session learns no faster than a sign-in would
// whether a candidate is an Owner password. Replacing an Owner password
// needs that password itself (A1-9), not just any of them.

/**
 * Checks the proof `request` carries. True when it holds; otherwise the
 * refusal has been sent on `reply`, and the route must stop. `of` names
 * the password `currentPassword` must be: null for the first, or a
 * further one's id; any of them when absent.
 */
export type ProveOwner = (
  request: FastifyRequest,
  reply: FastifyReply,
  proof: OwnerProof,
  options?: { readonly of?: string | null },
) => Promise<boolean>;

const refuse = (
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
): false => {
  void reply.code(status).send({ error, message } satisfies ApiError);
  return false;
};

export function createOwnerProof(options: {
  readonly store: AuthStore;
  readonly encryptor: Encryptor;
  /** The sign-in limiter: each check counts as a sign-in attempt does. */
  readonly loginLimiter: LoginLimiter;
  /** Where failed checks and lockouts are published, for the Activity Feed. */
  readonly events: EventBus;
  readonly now: () => Date;
}): ProveOwner {
  const { store, encryptor, loginLimiter, events, now } = options;

  return async (request, reply, proof, { of } = {}) => {
    if ((sessionOf(request).gatewayKeyId ?? null) !== null) {
      return refuse(
        reply,
        403,
        apiErrorCodes.proofRequired,
        "This adds a way to sign in, so it needs your password: a session begun with an API key cannot. Sign in with a password first.",
      );
    }
    const totp = await store.totp();
    const totpOn = totp.secret !== null;
    if (
      proof.currentPassword === undefined ||
      (totpOn && proof.code === undefined)
    ) {
      return refuse(
        reply,
        403,
        apiErrorCodes.proofRequired,
        totpOn
          ? "This adds a way to sign in: confirm it with your current password and a code from your authenticator app."
          : "This adds a way to sign in: confirm it with your current password.",
      );
    }
    const client = clientKey(request.ip);
    const attempt = loginLimiter.attempt(client);
    if (!attempt.allowed) {
      await sendTooManyAttempts(reply, attempt.retryAfterSeconds);
      return false;
    }
    const event = clientOf(request, now);
    const failed = async (secondFactor?: "totp" | "recovery_code") => {
      await recordAttempt(
        { store, events },
        {
          ...event,
          outcome: "failed",
          ...(secondFactor === undefined ? {} : { secondFactor }),
        },
        { lockoutMs: attempt.lockoutMs },
      );
      request.log.warn(
        { client, ...(secondFactor === undefined ? {} : { secondFactor }) },
        "A change that adds a way to sign in was refused: the proof was wrong.",
      );
    };

    const matched = await matchingPassword(store, proof.currentPassword);
    if (matched === undefined || (of !== undefined && matched !== of)) {
      await failed();
      return refuse(
        reply,
        422,
        apiErrorCodes.wrongPassword,
        "That is not your current password.",
      );
    }
    let secondFactor: "totp" | "recovery_code" | undefined;
    if (totp.secret !== null) {
      const used = await useSecondFactor({
        store,
        encryptor,
        totp: { ...totp, secret: totp.secret },
        code: proof.code ?? "",
        now: event.occurredAt,
      });
      secondFactor = used.factor;
      if (!used.valid) {
        await failed(used.factor);
        return refuse(
          reply,
          422,
          apiErrorCodes.wrongCode,
          "That code is not right, or was already used.",
        );
      }
    }
    attempt.succeeded();
    // In `sign_in_events`, but no sign-in for the Activity Feed to show.
    await recordAttempt(
      { store, events },
      {
        ...event,
        outcome: "succeeded",
        ...(secondFactor === undefined ? {} : { secondFactor }),
      },
      { announceSuccess: false },
    );
    return true;
  };
}
