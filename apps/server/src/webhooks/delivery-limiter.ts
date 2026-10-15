// Bounds the deliveries one client sends that fail the signature check
// (W1-4). `POST /api/github/webhooks` is public: each forged delivery had
// the secret opened, up to 5 MiB hashed and a warning logged, as often as
// anyone sent one. Now a client (by `clientKey`, as the sign-in limiter
// counts them) may fail `freeFailures` times in a window; from the failure
// that reaches it, its deliveries are refused with 429 before they are
// verified, until the window ends.
//
// GitHub's own deliveries are never refused for it: they come from
// GitHub's addresses, which no forger sends from, and a delivery that
// verifies forgets its client's failures. Changing the secret (or turning
// webhooks off and on) forgets every client, so GitHub's deliveries refused
// while the secrets differed are taken again once they match.
//
// The state is in memory, so a restart forgets it; AI Office runs as one
// process.

export interface DeliveryLimits {
  /** How many failed deliveries a client may send in a window. */
  readonly freeFailures: number;
  /** How long a window lasts, from a client's first failure in it. */
  readonly windowMs: number;
}

export const defaultDeliveryLimits: DeliveryLimits = {
  freeFailures: 20,
  windowMs: 10 * 60_000,
};

export interface DeliveryLimiter {
  /**
   * Whole seconds until `client` (from `clientKey`) may send again (at
   * least 1); undefined while it may.
   */
  refusedFor(client: string): number | undefined;
  /**
   * A delivery from `client` failed the signature check. Answers whether
   * that failure reached the bound, so its later deliveries are refused.
   */
  failed(client: string): boolean;
  /** A delivery from `client` verified: its failures are forgotten. */
  passed(client: string): void;
  /** Forgets every client, as when the secret changes. */
  clear(): void;
}

interface ClientState {
  failures: number;
  /** When its window began: its first failure in it. */
  since: number;
}

/** Above this many clients, those whose window has ended are swept. */
const sweepAbove = 1000;

export function createDeliveryLimiter(
  options: Partial<DeliveryLimits> & { readonly now?: () => Date } = {},
): DeliveryLimiter {
  const limits = { ...defaultDeliveryLimits, ...options };
  const now = (): number => (options.now ?? (() => new Date()))().getTime();
  const clients = new Map<string, ClientState>();

  /** `client`'s state, if its window has not ended. */
  const current = (client: string, at: number): ClientState | undefined => {
    const state = clients.get(client);
    if (state !== undefined && at - state.since >= limits.windowMs) {
      clients.delete(client);
      return undefined;
    }
    return state;
  };

  return {
    refusedFor(client) {
      const at = now();
      const state = current(client, at);
      if (state === undefined || state.failures < limits.freeFailures) {
        return undefined;
      }
      return Math.max(
        1,
        Math.ceil((state.since + limits.windowMs - at) / 1000),
      );
    },
    failed(client) {
      const at = now();
      if (clients.size > sweepAbove) {
        for (const [key, state] of clients) {
          if (at - state.since >= limits.windowMs) {
            clients.delete(key);
          }
        }
      }
      const state = current(client, at) ?? { failures: 0, since: at };
      state.failures += 1;
      clients.set(client, state);
      return state.failures === limits.freeFailures;
    },
    passed(client) {
      clients.delete(client);
    },
    clear() {
      clients.clear();
    },
  };
}
