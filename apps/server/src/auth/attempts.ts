import type { EventBus } from "@ai-office/events";
import type { FastifyRequest } from "fastify";

import { clientKey, type LoginLimiter } from "./login-limiter.ts";
import type { AuthStore, SignInEvent } from "./store.ts";
import { verifyPassword } from "./password.ts";

// Checked attempts at the Owner's credentials (PRD FR-4): sign-ins, and the
// fresh proofs a session gives before it adds a way to sign in (A1-3, A1-4).
// Each is recorded in `sign_in_events`; failures, and the lockouts they
// start, also go to the Activity Feed.

/** What `sign_in_events` records about the request's client, now. */
export function clientOf(
  request: FastifyRequest,
  now: () => Date,
): Pick<SignInEvent, "occurredAt" | "ip" | "userAgent"> {
  const userAgent = request.headers["user-agent"] ?? "";
  return {
    occurredAt: now(),
    ip: request.ip,
    // An empty or missing User-Agent is recorded as none.
    userAgent: userAgent === "" ? null : userAgent.slice(0, 512),
  };
}

/**
 * Records a checked attempt: in `sign_in_events`, and as an event for the
 * Activity Feed, with the lockout it started if any. A successful fresh
 * proof is no sign-in, so `announceSuccess: false` keeps it out of the
 * Activity Feed (it is still in `sign_in_events`).
 */
export async function recordAttempt(
  options: { readonly store: AuthStore; readonly events: EventBus },
  attempt: SignInEvent,
  { lockoutMs = 0, announceSuccess = true } = {},
): Promise<void> {
  await options.store.recordSignInEvent(attempt);
  const { outcome, ip, userAgent, secondFactor } = attempt;
  if (outcome === "failed" || announceSuccess) {
    await options.events.publish({
      type: outcome === "failed" ? "sign_in.failed" : "sign_in.succeeded",
      version: 1,
      ip,
      userAgent,
      ...(secondFactor === undefined ? {} : { secondFactor }),
    });
  }
  if (lockoutMs > 0) {
    await options.events.publish({
      type: "sign_in.locked_out",
      version: 1,
      ip,
      lockoutSeconds: Math.ceil(lockoutMs / 1000),
    });
  }
}

/**
 * Which of the Owner's passwords `password` is: null for the first (in
 * `owner`), a further one's id, or undefined for none.
 */
export async function matchingPassword(
  store: AuthStore,
  password: string,
): Promise<string | null | undefined> {
  const first = await store.passwordHash();
  if (first !== undefined && (await verifyPassword(first, password))) {
    return null;
  }
  for (const further of await store.ownerPasswords()) {
    if (await verifyPassword(further.passwordHash, password)) {
      return further.id;
    }
  }
  return undefined;
}

/**
 * Starts `limiter` from the attempts `sign_in_events` kept since `since`,
 * so a lockout outlives a restart (A1-7). A client whose last attempt is
 * older than the limiter forgets has nothing to restore.
 */
export async function restoreLimiter(
  limiter: LoginLimiter,
  store: AuthStore,
  since: Date,
): Promise<void> {
  limiter.restore(
    (await store.signInEventsSince(since)).map(
      ({ ip, occurredAt, outcome }) => ({
        client: clientKey(ip),
        at: occurredAt,
        outcome,
      }),
    ),
  );
}
