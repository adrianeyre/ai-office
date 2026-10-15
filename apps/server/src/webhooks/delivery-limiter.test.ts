import { describe, expect, it } from "vitest";

import { createDeliveryLimiter } from "./delivery-limiter.ts";

// The bound on one client's deliveries that fail the signature check
// (W1-4): twenty in ten minutes, then refused until the window ends.

const start = new Date("2026-10-11T12:00:00.000Z");
const forger = "203.0.113.9";

function limiter() {
  const clock = { now: start };
  const at = (ms: number) => {
    clock.now = new Date(start.getTime() + ms);
  };
  return { limits: createDeliveryLimiter({ now: () => clock.now }), at };
}

const failTimes = (
  limits: ReturnType<typeof createDeliveryLimiter>,
  client: string,
  times: number,
): boolean[] => Array.from({ length: times }, () => limits.failed(client));

describe("createDeliveryLimiter", () => {
  it("lets a client fail twenty times, says so at the twentieth, then refuses it until ten minutes from its first", () => {
    const { limits, at } = limiter();
    expect(limits.refusedFor(forger)).toBeUndefined();
    const reached = failTimes(limits, forger, 20);
    expect(reached.indexOf(true)).toBe(19);
    expect(reached.filter(Boolean)).toHaveLength(1);
    expect(limits.refusedFor(forger)).toBe(600);
    at(4 * 60_000 + 500);
    expect(limits.refusedFor(forger)).toBe(360);
    at(10 * 60_000 - 1);
    expect(limits.refusedFor(forger)).toBe(1);
    at(10 * 60_000);
    expect(limits.refusedFor(forger)).toBeUndefined();
    // A new window: twenty more.
    expect(failTimes(limits, forger, 19)).not.toContain(true);
    expect(limits.refusedFor(forger)).toBeUndefined();
  });

  it("counts each client on its own", () => {
    const { limits } = limiter();
    failTimes(limits, forger, 20);
    expect(limits.refusedFor(forger)).toBe(600);
    expect(limits.refusedFor("140.82.115.1")).toBeUndefined();
  });

  it("forgets a client whose delivery verified, and every client when cleared", () => {
    const { limits } = limiter();
    failTimes(limits, forger, 19);
    limits.passed(forger);
    expect(failTimes(limits, forger, 19)).not.toContain(true);
    failTimes(limits, forger, 1);
    failTimes(limits, "198.51.100.4", 20);
    limits.clear();
    expect(limits.refusedFor(forger)).toBeUndefined();
    expect(limits.refusedFor("198.51.100.4")).toBeUndefined();
  });

  it("sweeps clients whose window has ended once it counts more than a thousand", () => {
    const { limits, at } = limiter();
    for (let client = 0; client <= 1000; client += 1) {
      limits.failed(`10.0.${String(client >> 8)}.${String(client & 255)}`);
    }
    at(10 * 60_000);
    // The sweep runs on the next failure; old windows count for nothing.
    limits.failed(forger);
    expect(limits.refusedFor("10.0.0.0")).toBeUndefined();
    expect(failTimes(limits, "10.0.0.0", 19)).not.toContain(true);
  });
});
