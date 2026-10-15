import { describe, expect, it } from "vitest";

import {
  clientKey,
  createLoginLimiter,
  type LoginAttempt,
} from "./login-limiter.ts";

const start = new Date("2026-10-08T12:00:00.000Z");

function limiter() {
  const clock = { now: start };
  const at = (ms: number) => {
    clock.now = new Date(start.getTime() + ms);
  };
  return { limiter: createLoginLimiter({ now: () => clock.now }), at };
}

const failTimes = (
  limits: ReturnType<typeof createLoginLimiter>,
  client: string,
  times: number,
): LoginAttempt[] =>
  Array.from({ length: times }, () => limits.attempt(client));

describe("createLoginLimiter", () => {
  it("allows five failures, then locks the client out for a minute", () => {
    const { limiter: limits } = limiter();
    const attempts = failTimes(limits, "203.0.113.7", 5);
    expect(attempts.map((attempt) => attempt.allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      attempts.map((attempt) => attempt.allowed && attempt.lockoutMs),
    ).toEqual([0, 0, 0, 0, 60_000]);
    expect(limits.attempt("203.0.113.7")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("rounds the wait up to whole seconds", () => {
    const { limiter: limits, at } = limiter();
    failTimes(limits, "a", 5);
    at(59_001);
    expect(limits.attempt("a")).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    at(30_500);
    expect(limits.attempt("a")).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
  });

  it("doubles the lockout with each failure after one, up to an hour", () => {
    const { limiter: limits, at } = limiter();
    failTimes(limits, "a", 5);
    let elapsed = 0;
    const lockouts: number[] = [];
    let lockout = 60_000;
    for (let index = 0; index < 8; index += 1) {
      elapsed += lockout;
      at(elapsed);
      const attempt = limits.attempt("a");
      if (!attempt.allowed) {
        throw new Error("expected the lockout to have ended");
      }
      lockout = attempt.lockoutMs;
      lockouts.push(lockout / 60_000);
    }
    expect(lockouts).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("refuses refused attempts without lengthening the lockout", () => {
    const { limiter: limits, at } = limiter();
    failTimes(limits, "a", 5);
    failTimes(limits, "a", 20);
    at(60_000);
    const attempt = limits.attempt("a");
    expect(attempt.allowed && attempt.lockoutMs).toBe(120_000);
  });

  it("forgets a client's failures when it succeeds", () => {
    const { limiter: limits } = limiter();
    failTimes(limits, "a", 4);
    const fifth = limits.attempt("a");
    expect(fifth.allowed).toBe(true);
    if (fifth.allowed) {
      fifth.succeeded();
    }
    const next = failTimes(limits, "a", 5);
    expect(next.every((attempt) => attempt.allowed)).toBe(true);
  });

  it("takes back a withdrawn attempt, keeping earlier failures", () => {
    const { limiter: limits } = limiter();
    failTimes(limits, "a", 4);
    // The fifth would lock the client out; withdrawn, it does not.
    const fifth = limits.attempt("a");
    expect(fifth.allowed && fifth.lockoutMs).toBe(60_000);
    if (fifth.allowed) {
      fifth.withdraw();
    }
    const next = limits.attempt("a");
    expect(next.allowed && next.lockoutMs).toBe(60_000);
    expect(limits.attempt("a").allowed).toBe(false);
  });

  it("forgets a client after a day without attempts", () => {
    const { limiter: limits, at } = limiter();
    failTimes(limits, "a", 4);
    at(24 * 60 * 60_000);
    const next = failTimes(limits, "a", 5);
    expect(next.every((attempt) => attempt.allowed)).toBe(true);
    expect(limits.attempt("a").allowed).toBe(false);
  });

  it("keeps each client's count apart", () => {
    const { limiter: limits } = limiter();
    failTimes(limits, "a", 5);
    expect(limits.attempt("a").allowed).toBe(false);
    expect(limits.attempt("b").allowed).toBe(true);
  });

  it("says how long a client is locked out for without counting an attempt", () => {
    const { limiter: limits, at } = limiter();
    expect(limits.lockedOutFor("a")).toBe(0);
    failTimes(limits, "a", 4);
    // Asking, however often, counts nothing.
    for (let asked = 0; asked < 10; asked += 1) {
      expect(limits.lockedOutFor("a")).toBe(0);
    }
    failTimes(limits, "a", 1);
    expect(limits.lockedOutFor("a")).toBe(60);
    at(59_500);
    expect(limits.lockedOutFor("a")).toBe(1);
    at(60_000);
    expect(limits.lockedOutFor("a")).toBe(0);
  });

  it("forgets a client's failures when told to", () => {
    const { limiter: limits } = limiter();
    failTimes(limits, "a", 5);
    expect(limits.lockedOutFor("a")).toBe(60);
    limits.forget("a");
    expect(limits.lockedOutFor("a")).toBe(0);
    const next = failTimes(limits, "a", 4);
    expect(next.every((attempt) => attempt.allowed && !attempt.lockoutMs)).toBe(
      true,
    );
  });
});

describe("restoring the limiter (A1-7)", () => {
  const recorded = (
    client: string,
    ms: number,
    outcome: "succeeded" | "failed" = "failed",
  ) => ({ client, at: new Date(start.getTime() + ms), outcome });

  it("replays recorded failures, so a lockout runs on as it would have", () => {
    const { limiter: limits, at } = limiter();
    limits.restore(
      Array.from({ length: 5 }, (_, index) =>
        recorded("203.0.113.7", index * 1000),
      ),
    );
    at(5_000);
    // Locked out at 4 s for a minute: 59 s left.
    expect(limits.attempt("203.0.113.7")).toEqual({
      allowed: false,
      retryAfterSeconds: 59,
    });
    at(64_000);
    const next = limits.attempt("203.0.113.7");
    expect(next.allowed && next.lockoutMs).toBe(120_000);
  });

  it("forgets a client at a recorded success, and keeps clients apart", () => {
    const { limiter: limits, at } = limiter();
    limits.restore([
      ...Array.from({ length: 5 }, (_, index) =>
        recorded("203.0.113.7", index),
      ),
      recorded("203.0.113.7", 10, "succeeded"),
      ...Array.from({ length: 4 }, (_, index) =>
        recorded("203.0.113.8", index),
      ),
    ]);
    at(1000);
    expect(limits.attempt("203.0.113.7").allowed).toBe(true);
    const fifth = limits.attempt("203.0.113.8");
    expect(fifth.allowed && fifth.lockoutMs).toBe(60_000);
  });
});

describe("clientKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::ffff", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:aaaa::1", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
  ])("limits %s as %s", (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });
});
