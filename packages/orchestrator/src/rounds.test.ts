import { afterEach, describe, expect, it, vi } from "vitest";

import { createRounds } from "./rounds.ts";

// Rounds every interval, and a round asked for now (as a GitHub webhook
// asks, PRD FR-8): at once, or straight after the round running.

afterEach(() => {
  vi.useRealTimers();
});

function counting(intervalMs = 60_000) {
  let runs = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const rounds = createRounds({
    run: async () => {
      runs += 1;
      if (hold) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    intervalMs: () => Promise.resolve(intervalMs),
  });
  return {
    rounds,
    runs: () => runs,
    holdNext: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      release?.();
    },
  };
}

describe("rounds", () => {
  it("run now or after an interval, then every interval, until stopped", async () => {
    vi.useFakeTimers();
    const now = counting();
    now.rounds.start({ now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(now.runs()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(now.runs()).toBe(2);
    await now.rounds.stop();

    const later = counting();
    later.rounds.start({ now: false });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(later.runs()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(later.runs()).toBe(1);
    await later.rounds.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(later.runs()).toBe(1);
  });

  it("run a round asked for at once, and wait the interval again from it", async () => {
    vi.useFakeTimers();
    const { rounds, runs } = counting();
    rounds.start({ now: false });
    await vi.advanceTimersByTimeAsync(30_000);

    await rounds.trigger();
    expect(runs()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(runs()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs()).toBe(2);
    await rounds.stop();
  });

  it("run rounds asked for during one straight after it, as one", async () => {
    const { rounds, runs, holdNext, release } = counting();
    holdNext();
    rounds.start({ now: true });
    await expect.poll(runs).toBe(1);

    const first = rounds.trigger();
    const second = rounds.trigger();
    expect(runs()).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(runs()).toBe(2);
    await rounds.stop();
  });

  it("do nothing asked for while stopped", async () => {
    const { rounds, runs } = counting();
    await rounds.trigger();
    expect(runs()).toBe(0);
  });

  it("carry on after a round that fails", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const rounds = createRounds({
      run: () => {
        runs += 1;
        return Promise.reject(new Error("GitHub is down."));
      },
      intervalMs: () => Promise.resolve(1_000),
    });
    rounds.start({ now: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toBe(3);
    await rounds.trigger();
    expect(runs).toBe(4);
    await rounds.stop();
  });
});
