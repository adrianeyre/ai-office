import type { EventBus } from "@ai-office/events";
import type { GatewayKeyCheck } from "@ai-office/gateway";
import type { FastifyBaseLogger } from "fastify";

import {
  clientKey,
  createLoginLimiter,
  type LoginLimitOptions,
} from "../auth/login-limiter.ts";

// Gateway Keys presented at /v1 on the app's port (pen-testing I2-3) are
// limited per client, as sign-ins are (PRD FR-4): the same limits and
// lockouts, but a limiter of their own, so an Owner's tool left with a
// revoked key never locks the Owner out of signing in, nor a run of wrong
// passwords their tools. A key is checked in a moment, without hashing,
// and a tool sends many requests at once, so only a key not in use counts,
// once it is known: counting every request before its check, as a sign-in
// does, would lock out a busy tool's right key. Each key not in use, and
// each lockout it starts, is in the Activity Feed. The sandboxes' requests,
// on the Gateway's own port, all come from the sandbox relay's one address,
// so they are not limited: one sandbox would lock every Agent out.

export interface KeyGuesses {
  /** Starts the check of a key `ip` presents (with `userAgent`, if any). */
  check(ip: string, userAgent: string | undefined): GatewayKeyCheck;
}

export function createKeyGuesses(options: {
  readonly events: EventBus;
  readonly logger: FastifyBaseLogger;
  readonly now: () => Date;
  readonly limits?: Partial<LoginLimitOptions>;
}): KeyGuesses {
  const { events, logger } = options;
  const limiter = createLoginLimiter({ ...options.limits, now: options.now });
  const published = (event: Parameters<EventBus["publish"]>[0]) => {
    events.publish(event).catch((error: unknown) => {
      logger.error(
        { err: error },
        "A Gateway Key not in use could not be recorded.",
      );
    });
  };
  return {
    check(ip, userAgent) {
      const client = clientKey(ip);
      const retryAfterSeconds = limiter.lockedOutFor(client);
      if (retryAfterSeconds > 0) {
        return { allowed: false, retryAfterSeconds };
      }
      return {
        allowed: true,
        succeeded() {
          limiter.forget(client);
        },
        failed() {
          // Counted now it is known, unless a failure checked alongside it
          // has just locked the client out.
          const counted = limiter.attempt(client);
          published({
            type: "gateway_key.failed",
            version: 1,
            ip,
            // An empty or missing User-Agent is recorded as none.
            userAgent:
              userAgent === undefined || userAgent === ""
                ? null
                : userAgent.slice(0, 512),
          });
          if (counted.allowed && counted.lockoutMs > 0) {
            logger.warn(
              { client, lockoutSeconds: counted.lockoutMs / 1000 },
              "Gateway Keys from this client are locked out after repeated keys not in use.",
            );
            published({
              type: "gateway_key.locked_out",
              version: 1,
              ip,
              lockoutSeconds: Math.ceil(counted.lockoutMs / 1000),
            });
          }
        },
      };
    },
  };
}
