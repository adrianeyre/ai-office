import type { InstallationToken } from "./types.ts";

// Installation tokens last an hour. Each is minted once, kept, and used
// until shortly before it expires; then the next call mints a fresh one.
// Concurrent calls for the same key share one mint, and a failed mint is
// not kept, so the next call tries again.

/** How long before expiry a token is replaced: five minutes by default. */
export const defaultRefreshBeforeMs = 5 * 60 * 1000;

export interface TokenCache {
  /** A token for `key` that will not expire within the refresh margin. */
  get(
    key: string,
    mint: () => Promise<InstallationToken>,
  ): Promise<InstallationToken>;
  /** Forgets `key`'s token, so the next `get` mints a new one. */
  forget(key: string): void;
}

export function createTokenCache(
  options: {
    readonly now?: () => Date;
    readonly refreshBeforeMs?: number;
  } = {},
): TokenCache {
  const now = options.now ?? (() => new Date());
  const refreshBeforeMs = options.refreshBeforeMs ?? defaultRefreshBeforeMs;
  const tokens = new Map<string, Promise<InstallationToken>>();

  const fresh = (token: InstallationToken): boolean =>
    token.expiresAt.getTime() - now().getTime() > refreshBeforeMs;

  return {
    async get(key, mint) {
      const cached = tokens.get(key);
      if (cached !== undefined) {
        const token = await cached.catch(() => undefined);
        if (token !== undefined && fresh(token)) {
          return token;
        }
        // Another call may have replaced it while this one waited.
        if (tokens.get(key) !== cached) {
          return this.get(key, mint);
        }
      }
      const minting = mint();
      tokens.set(key, minting);
      minting.catch(() => {
        if (tokens.get(key) === minting) {
          tokens.delete(key);
        }
      });
      return minting;
    },
    forget(key) {
      tokens.delete(key);
    },
  };
}
