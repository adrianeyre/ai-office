import { describe, expect, it } from "vitest";

import {
  aheadOfPace,
  AccountsUnavailableError,
  createSessionTable,
  drainSoonestStrategy,
  route,
  sessionStrategy,
  type Candidate,
  type Exclusion,
  type RoutingChecks,
} from "./balancing.ts";

// Routing a request (PRD FR-38) after any forced account: the strategy
// ranks the accounts, the model-capacity filter leaves out those exhausted
// for the request's model family, and usage throttling those held back or
// ahead of their pace. A check that leaves none answers for itself:
// capacity 429, throttling 529; no account at all is the caller's 503.

const minute = 60 * 1000;
const hour = 60 * minute;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + ms);

// Seeded usage windows: the strict drain-soonest strategy ranks Team
// (resetting in an hour), then Work (in four), then Key (an API key).
const work: Candidate = {
  id: "work",
  priority: 1,
  fiveHourResetsAt: at(4 * hour),
};
const team: Candidate = {
  id: "team",
  priority: 1,
  fiveHourResetsAt: at(1 * hour),
};
const key: Candidate = { id: "key", priority: 1 };
const all = [work, team, key];

const drain = drainSoonestStrategy({ strict: true });
const none = (): Exclusion | undefined => undefined;
const leaves =
  (out: Record<string, Exclusion>) =>
  (candidate: Candidate): Exclusion | undefined =>
    out[candidate.id];

const outOfOpus = (until: Date): Exclusion => ({
  message:
    "Every AI Account that can serve this request has no capacity left for claude-opus models.",
  until,
});
const aheadOfFiveHourPace = (until: Date): Exclusion => ({
  message:
    "Every AI Account that can serve this request is ahead of its five-hour pace.",
  until,
});

const routed = (
  checks: RoutingChecks<Candidate>,
  options: { avoid?: string[]; sessionKey?: string | null } = {},
) =>
  route(
    drain,
    all,
    { sessionKey: options.sessionKey ?? null, avoid: options.avoid ?? [] },
    at(0),
    checks,
  );

const refusal = (run: () => unknown): AccountsUnavailableError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccountsUnavailableError);
    return error as AccountsUnavailableError;
  }
  throw new Error("It was not refused.");
};

describe("the routing pipeline", () => {
  it("serves the strategy's first choice when no check leaves it out", () => {
    expect(routed({ capacity: none, throttling: none })).toBe(team);
  });

  it("filters after the strategy ranks: the next in the strategy's order serves, not the Owner's first", () => {
    // Team is out of Opus capacity: Work, next by its reset, serves
    // rather than Key, though Key is not ranked last in the Owner's order.
    expect(
      routed({
        capacity: leaves({ team: outOfOpus(at(30 * minute)) }),
        throttling: none,
      }),
    ).toBe(work);
    // Then throttling: Work is ahead of its pace, so Key serves.
    expect(
      routed({
        capacity: leaves({ team: outOfOpus(at(30 * minute)) }),
        throttling: leaves({ work: aheadOfFiveHourPace(at(20 * minute)) }),
      }),
    ).toBe(key);
  });

  it("answers 429 when the model-capacity filter leaves none, until the first is back", () => {
    const error = refusal(() =>
      routed({
        capacity: leaves({
          team: outOfOpus(at(30 * minute)),
          work: outOfOpus(at(10 * minute)),
          key: outOfOpus(at(50 * minute)),
        }),
        throttling: none,
      }),
    );
    expect(error.status).toBe(429);
    expect(error.message).toBe(outOfOpus(at(0)).message);
    expect(error.retryAt).toEqual(at(10 * minute));
  });

  it("answers 529 when throttling leaves none of what capacity left", () => {
    const error = refusal(() =>
      routed({
        capacity: leaves({ team: outOfOpus(at(30 * minute)) }),
        throttling: leaves({
          work: aheadOfFiveHourPace(at(40 * minute)),
          key: aheadOfFiveHourPace(at(25 * minute)),
        }),
      }),
    );
    expect(error.status).toBe(529);
    expect(error.message).toBe(aheadOfFiveHourPace(at(0)).message);
    // Only what throttling left out counts: Team is out of capacity.
    expect(error.retryAt).toEqual(at(25 * minute));
  });

  it("checks capacity before throttling: an account both out of capacity and throttled is a 429", () => {
    const everyone = Object.fromEntries(
      all.map(({ id }) => [id, outOfOpus(at(hour))]),
    );
    const throttled = Object.fromEntries(
      all.map(({ id }) => [id, aheadOfFiveHourPace(at(hour))]),
    );
    expect(
      refusal(() =>
        routed({ capacity: leaves(everyone), throttling: leaves(throttled) }),
      ).status,
    ).toBe(429);
    // And throttling is never asked about what capacity left out.
    const asked: string[] = [];
    routed({
      capacity: leaves({ team: outOfOpus(at(hour)) }),
      throttling: (candidate) => {
        asked.push(candidate.id);
        return undefined;
      },
    });
    expect(asked).toEqual(["work", "key"]);
  });

  it("answers nothing for no candidates at all, which the AI Gateway answers with a 503", () => {
    expect(
      route<Candidate>(drain, [], { sessionKey: null }, at(0), {
        capacity: none,
        throttling: none,
      }),
    ).toBeUndefined();
  });

  it("prefers an account not yet tried for the request, among those the checks left", () => {
    expect(
      routed({ capacity: none, throttling: none }, { avoid: ["team"] }),
    ).toBe(work);
    expect(
      routed(
        { capacity: none, throttling: none },
        { avoid: ["team", "work", "key"] },
      ),
    ).toBe(team);
  });

  it("moves a session whose account a check leaves out, and tells the strategy where it went", () => {
    const sessions = createSessionTable();
    const strategy = sessionStrategy(sessions, 5 * hour);
    const request = { sessionKey: "ada:sbx-1" };
    expect(
      route(strategy, all, request, at(0), {
        capacity: none,
        throttling: none,
      }),
    ).toBe(work);
    expect(
      route(strategy, all, request, at(minute), {
        capacity: leaves({ work: outOfOpus(at(hour)) }),
        throttling: none,
      }),
    ).toBe(team);
    expect(sessions.get("ada:sbx-1", at(2 * minute))).toBe("team");
  });
});

describe("pacing a usage window", () => {
  const fiveHours = 5 * hour;
  // A five-hour window from 12:00 to 17:00.
  const window = (utilization: number) => ({
    utilization,
    resetsAt: at(fiveHours),
  });

  it("lets a window be used as fast as it goes by, plus the headroom", () => {
    expect(aheadOfPace(window(10), fiveHours, 10, at(0))).toBeUndefined();
    // An hour in (20%), up to 30% may be used.
    expect(aheadOfPace(window(30), fiveHours, 10, at(hour))).toBeUndefined();
    expect(
      aheadOfPace(window(100), fiveHours, 10, at(fiveHours - 1)),
    ).toBeUndefined();
  });

  it("holds back a window ahead of its pace until the pace catches up", () => {
    // An hour in, 35% used: back once 25% of the window has gone by.
    expect(aheadOfPace(window(35), fiveHours, 10, at(hour))).toEqual(
      at(1.25 * hour),
    );
    // At the start, 11% is already ahead.
    expect(aheadOfPace(window(11), fiveHours, 10, at(0))).toEqual(
      at(0.01 * fiveHours),
    );
    // Never past the reset.
    expect(aheadOfPace(window(100), fiveHours, 0, at(0))).toEqual(
      at(fiveHours),
    );
  });

  it("paces a weekly window over its week", () => {
    const week = 7 * 24 * hour;
    const weekly = { utilization: 50, resetsAt: at(6 * 24 * hour) };
    // A day in (1/7, about 14%), half used: ahead, until 40% of the week.
    expect(aheadOfPace(weekly, week, 10, at(0))).toEqual(
      new Date(at(-24 * hour).getTime() + 0.4 * week),
    );
    expect(aheadOfPace(weekly, week, 10, at(3 * 24 * hour))).toBeUndefined();
  });

  it("says nothing of a window that has already reset", () => {
    expect(
      aheadOfPace(window(90), fiveHours, 10, at(fiveHours)),
    ).toBeUndefined();
  });
});
