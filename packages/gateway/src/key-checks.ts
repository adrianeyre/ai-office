import type { IncomingMessage } from "node:http";

// Guesses at Gateway Keys, limited per client (pen-testing I2-3). Whoever
// hands a request to the Gateway may limit the check of the key it
// presents: the app's one entry point does for `/v1`, by the client's
// address, as it limits sign-ins (PRD FR-4). A request no one limits, such
// as the sandboxes' through the sandbox relay on the Gateway's own port,
// is checked as before.

/** What a limit on checking one request's Gateway Key says. */
export type GatewayKeyCheck =
  | {
      /** Its client tried too many keys not in use: refused unchecked. */
      readonly allowed: false;
      /** Whole seconds until the client may try again (at least 1). */
      readonly retryAfterSeconds: number;
    }
  | {
      readonly allowed: true;
      /** The key is in use. */
      succeeded(): void;
      /** The key presented is not in use. */
      failed(): void;
    };

const unlimited: GatewayKeyCheck = {
  allowed: true,
  succeeded: () => undefined,
  failed: () => undefined,
};

const limits = new WeakMap<IncomingMessage, () => GatewayKeyCheck>();

/**
 * Limits the check of the Gateway Key `request` presents, before the
 * request is handed to the Gateway: `start` is asked as the key is about
 * to be checked, and told whether it was in use. A request without a key
 * is refused without asking.
 */
export function limitKeyCheck(
  request: IncomingMessage,
  start: () => GatewayKeyCheck,
): void {
  limits.set(request, start);
}

/** Starts the check of `request`'s key, as its limit says, if it has one. */
export function startKeyCheck(request: IncomingMessage): GatewayKeyCheck {
  return limits.get(request)?.() ?? unlimited;
}
