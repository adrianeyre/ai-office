import { isIPv4, isIPv6 } from "node:net";

// Rate-limits sign-ins per client (PRD FR-4), with an exponential lockout:
// a client may fail `freeFailures` times in a row; the failure that reaches
// that number locks it out for `lockoutMs`, and each failure after a
// lockout doubles it, up to `maxLockoutMs`. A successful sign-in forgets
// the client; so does a day without attempts.
//
// Each attempt counts as a failure the moment it starts, before the
// password is checked, so parallel guesses cannot all slip in while the
// first ones are still being hashed. A success then takes it back. A right
// password that still needs its TOTP code is withdrawn instead: it does not
// count, but earlier failures stand, and wrong codes count like wrong
// passwords.
//
// The state is in memory (AI Office runs as one process), but every checked
// attempt is also in `sign_in_events`, and a new process replays them
// (`restore`), so a lockout outlives a restart (A1-7).

export interface LoginLimitOptions {
  readonly freeFailures: number;
  readonly lockoutMs: number;
  readonly maxLockoutMs: number;
  /** A client with no attempt for this long starts afresh. */
  readonly forgetAfterMs: number;
}

export const defaultLoginLimits: LoginLimitOptions = {
  freeFailures: 5,
  lockoutMs: 60_000,
  maxLockoutMs: 60 * 60_000,
  forgetAfterMs: 24 * 60 * 60_000,
};

export type LoginAttempt =
  | {
      readonly allowed: true;
      /** The attempt succeeded: forget the client's failures. */
      succeeded(): void;
      /**
       * The attempt neither failed nor finished signing in (a right
       * password that still needs its second factor): take it back, but
       * keep the client's earlier failures.
       */
      withdraw(): void;
      /** How long the client is now locked out for; 0 if it is not. */
      readonly lockoutMs: number;
    }
  | {
      readonly allowed: false;
      /** Whole seconds until the client may try again (at least 1). */
      readonly retryAfterSeconds: number;
    };

/** A checked attempt, as `sign_in_events` kept it. */
export interface RecordedAttempt {
  /** Its client, from `clientKey`. */
  readonly client: string;
  readonly at: Date;
  readonly outcome: "succeeded" | "failed";
}

export interface LoginLimiter {
  /** Starts an attempt by `client` (from `clientKey`), if it may try. */
  attempt(client: string): LoginAttempt;
  /**
   * Whole seconds until `client` may try again, 0 when it may, counting
   * nothing: for checks too quick and too frequent to count before they
   * run, such as a Gateway Key's (pen-testing I2-3), which count only a
   * failure, with `attempt`, once it is known.
   */
  lockedOutFor(client: string): number;
  /** Forgets `client`'s failures, as a successful attempt does. */
  forget(client: string): void;
  /**
   * Replays attempts checked before this process started, oldest first:
   * each failure counts as it did then, and each success forgets its
   * client, so whoever was locked out still is.
   */
  restore(attempts: Iterable<RecordedAttempt>): void;
}

interface ClientState {
  failures: number;
  lockedUntil: number;
  lastAttemptAt: number;
}

/** Above this many clients, stale ones are swept on the next attempt. */
const sweepAbove = 1000;

export function createLoginLimiter(
  options: Partial<LoginLimitOptions> & { now?: () => Date } = {},
): LoginLimiter {
  const limits = { ...defaultLoginLimits, ...options };
  const now = (): number => (options.now ?? (() => new Date()))().getTime();
  const clients = new Map<string, ClientState>();

  const isStale = (state: ClientState, at: number): boolean =>
    state.lockedUntil <= at && at - state.lastAttemptAt >= limits.forgetAfterMs;

  /**
   * Counts a failure by `client` at `at`, locking it out once it reaches
   * the limit; returns the lockout it had before, and the one it has now.
   */
  const countFailure = (client: string, at: number) => {
    let state = clients.get(client);
    if (state === undefined || isStale(state, at)) {
      state = { failures: 0, lockedUntil: 0, lastAttemptAt: at };
      clients.set(client, state);
    }
    const before = { lockedUntil: state.lockedUntil };
    state.failures += 1;
    state.lastAttemptAt = at;
    const overLimit = state.failures - limits.freeFailures;
    const lockoutMs =
      overLimit < 0
        ? 0
        : Math.min(limits.lockoutMs * 2 ** overLimit, limits.maxLockoutMs);
    state.lockedUntil = at + lockoutMs;
    return { before, lockoutMs };
  };

  /** Whole seconds `state` is still locked out for at `at`; 0 if none. */
  const lockedFor = (state: ClientState | undefined, at: number): number =>
    state === undefined || state.lockedUntil <= at
      ? 0
      : Math.max(1, Math.ceil((state.lockedUntil - at) / 1000));

  return {
    attempt(client) {
      const at = now();
      if (clients.size > sweepAbove) {
        for (const [key, state] of clients) {
          if (isStale(state, at)) {
            clients.delete(key);
          }
        }
      }
      const retryAfterSeconds = lockedFor(clients.get(client), at);
      if (retryAfterSeconds > 0) {
        return { allowed: false, retryAfterSeconds };
      }
      const { before, lockoutMs } = countFailure(client, at);
      return {
        allowed: true,
        lockoutMs,
        succeeded() {
          clients.delete(client);
        },
        withdraw() {
          const current = clients.get(client);
          if (current === undefined) {
            return;
          }
          current.failures = Math.max(0, current.failures - 1);
          // Undo this attempt's lockout, unless a later one replaced it.
          if (current.lockedUntil === at + lockoutMs) {
            current.lockedUntil = before.lockedUntil;
          }
        },
      };
    },

    lockedOutFor(client) {
      return lockedFor(clients.get(client), now());
    },

    forget(client) {
      clients.delete(client);
    },

    restore(attempts) {
      for (const { client, at, outcome } of attempts) {
        if (outcome === "failed") {
          countFailure(client, at.getTime());
        } else {
          clients.delete(client);
        }
      }
    },
  };
}

/**
 * The key a client is limited by: its IPv4 address, or the /64 network of
 * its IPv6 address (one host usually holds a whole /64, so per-address
 * limits would be trivial to dodge). IPv4-mapped IPv6 counts as IPv4.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] !== undefined) {
    return mapped[1];
  }
  if (isIPv4(ip) || !isIPv6(ip)) {
    return ip;
  }
  const [head = "", tail = ""] = ip.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::")
    ? [
        ...headGroups,
        ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"),
        ...tailGroups,
      ]
    : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}
