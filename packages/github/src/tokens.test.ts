import { describe, expect, it } from "vitest";

import { createTokenCache, defaultRefreshBeforeMs } from "./tokens.ts";
import type { InstallationToken } from "./types.ts";

const hour = 60 * 60 * 1000;
const minute = 60 * 1000;

/** A cache on a clock the test moves, minting hour-long numbered tokens. */
function cache() {
  const clock = { now: new Date("2026-10-08T12:00:00.000Z") };
  const minted: string[] = [];
  const tokens = createTokenCache({ now: () => clock.now });
  const mint = (key: string) => (): Promise<InstallationToken> => {
    const token = `${key}-${String(minted.length + 1)}`;
    minted.push(token);
    return Promise.resolve({
      token,
      expiresAt: new Date(clock.now.getTime() + hour),
    });
  };
  const advance = (ms: number): void => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { tokens, mint, minted, advance };
}

describe("the installation token cache", () => {
  it("keeps a token until near its expiry", async () => {
    const { tokens, mint, minted, advance } = cache();
    expect((await tokens.get("web-shop", mint("web-shop"))).token).toBe(
      "web-shop-1",
    );
    // Still used with just over five minutes left.
    advance(hour - defaultRefreshBeforeMs - 1000);
    expect((await tokens.get("web-shop", mint("web-shop"))).token).toBe(
      "web-shop-1",
    );
    expect(minted).toEqual(["web-shop-1"]);
  });

  it("mints a fresh one once it is within five minutes of expiry", async () => {
    const { tokens, mint, minted, advance } = cache();
    await tokens.get("web-shop", mint("web-shop"));
    advance(hour - defaultRefreshBeforeMs);
    const refreshed = await tokens.get("web-shop", mint("web-shop"));
    expect(refreshed.token).toBe("web-shop-2");
    // And keeps the new one in turn.
    advance(30 * minute);
    expect((await tokens.get("web-shop", mint("web-shop"))).token).toBe(
      "web-shop-2",
    );
    expect(minted).toEqual(["web-shop-1", "web-shop-2"]);
  });

  it("mints after expiry too", async () => {
    const { tokens, mint, advance } = cache();
    await tokens.get("web-shop", mint("web-shop"));
    advance(2 * hour);
    expect((await tokens.get("web-shop", mint("web-shop"))).token).toBe(
      "web-shop-2",
    );
  });

  it("keeps one token per key", async () => {
    const { tokens, mint, minted } = cache();
    await tokens.get("web-shop", mint("web-shop"));
    await tokens.get("blog", mint("blog"));
    await tokens.get("web-shop", mint("web-shop"));
    await tokens.get("blog", mint("blog"));
    expect(minted).toEqual(["web-shop-1", "blog-2"]);
  });

  it("shares one mint between concurrent callers", async () => {
    const { tokens, mint, minted } = cache();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => tokens.get("web-shop", mint("web-shop"))),
    );
    expect(new Set(results.map(({ token }) => token))).toEqual(
      new Set(["web-shop-1"]),
    );
    expect(minted).toHaveLength(1);
  });

  it("does not keep a failed mint", async () => {
    const { tokens, mint, minted } = cache();
    await expect(
      tokens.get("web-shop", () => Promise.reject(new Error("GitHub is down"))),
    ).rejects.toThrow("GitHub is down");
    expect((await tokens.get("web-shop", mint("web-shop"))).token).toBe(
      "web-shop-1",
    );
    expect(minted).toHaveLength(1);
  });

  it("mints again for a key it was told to forget", async () => {
    const { tokens, mint } = cache();
    await tokens.get("web-shop", mint("web-shop"));
    tokens.forget("web-shop");
    expect((await tokens.get("web-shop", mint("web-shop"))).token).toBe(
      "web-shop-2",
    );
  });

  it("takes a different refresh margin", async () => {
    const clock = { now: new Date("2026-10-08T12:00:00.000Z") };
    const tokens = createTokenCache({
      now: () => clock.now,
      refreshBeforeMs: 30 * minute,
    });
    let minted = 0;
    const mint = () => {
      minted += 1;
      return Promise.resolve({
        token: `t${String(minted)}`,
        expiresAt: new Date(clock.now.getTime() + hour),
      });
    };
    await tokens.get("web-shop", mint);
    clock.now = new Date(clock.now.getTime() + 29 * minute);
    await tokens.get("web-shop", mint);
    expect(minted).toBe(1);
    clock.now = new Date(clock.now.getTime() + 2 * minute);
    await tokens.get("web-shop", mint);
    expect(minted).toBe(2);
  });
});
