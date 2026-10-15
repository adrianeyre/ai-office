import type { LoadBalancingSettings } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  bestTier,
  createLoadBalancer,
  createSessionTable,
  createUsageTracker,
  drainSoonestStrategy,
  leastUsedStrategy,
  route,
  sessionAffinityStrategy,
  sessionStrategy,
  soonestReset,
  type Candidate,
  type RoutingChecks,
} from "./balancing.ts";

// Load-balancing strategies (PRD FR-37): session, session-affinity,
// drain-soonest (and its strict variant) and least-used, each choosing
// within the best priority among the accounts that can serve.

const minute = 60 * 1000;
const hour = 60 * minute;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + ms);

// In the Owner's order: priority, then oldest first.
const work: Candidate = { id: "work", priority: 1 };
const team: Candidate = { id: "team", priority: 1 };
const spare: Candidate = { id: "spare", priority: 2 };
const all = [work, team, spare];

const session = (key: string | null) => ({ sessionKey: key });

describe("the best priority tier", () => {
  it("is the accounts of the lowest priority number there is, in order", () => {
    expect(bestTier(all)).toEqual([work, team]);
    expect(bestTier([spare, { id: "last", priority: 9 }])).toEqual([spare]);
    expect(bestTier([])).toEqual([]);
  });
});

describe("the session strategy", () => {
  it("keeps a session on its account for the window, and spreads new sessions across the best priority", () => {
    const strategy = sessionStrategy(createSessionTable(), 5 * hour);
    expect(strategy.choose(all, session("ada:sbx-1"), at(0))).toBe(work);
    // A new session goes to the account with the fewest sessions.
    expect(strategy.choose(all, session("bea:sbx-2"), at(1 * minute))).toBe(
      team,
    );
    expect(strategy.choose(all, session("cy:sbx-3"), at(2 * minute))).toBe(
      work,
    );
    // Each stays where it started, whatever the others do.
    for (const minutes of [5, 60, 299]) {
      expect(
        strategy.choose(all, session("bea:sbx-2"), at(minutes * minute)),
      ).toBe(team);
      expect(
        strategy.choose(all, session("ada:sbx-1"), at(minutes * minute)),
      ).toBe(work);
    }
    // Never on an account of a worse priority while a better one serves.
    expect(
      [1, 2, 3, 4, 5].map(
        (n) =>
          strategy.choose(all, session(`new:${String(n)}`), at(3 * minute))?.id,
      ),
    ).not.toContain("spare");
  });

  it("chooses afresh once the window ends", () => {
    const sessions = createSessionTable();
    const strategy = sessionStrategy(sessions, 5 * hour);
    expect(strategy.choose(all, session("ada:sbx-1"), at(0))).toBe(work);
    expect(strategy.choose(all, session("bea:sbx-2"), at(hour))).toBe(team);
    // At five hours ada's session ends: it starts again where there are
    // fewest sessions (work, now empty), and stays for another window.
    expect(strategy.choose(all, session("ada:sbx-1"), at(5 * hour))).toBe(work);
    expect(sessions.get("ada:sbx-1", at(9 * hour))).toBe("work");
    expect(sessions.get("ada:sbx-1", at(10 * hour))).toBeUndefined();
  });

  it("moves a session whose account can no longer serve it, such as a paused one", () => {
    const strategy = sessionStrategy(createSessionTable(), 5 * hour);
    expect(strategy.choose(all, session("ada:sbx-1"), at(0))).toBe(work);
    // Work is paused: it is no longer a candidate.
    expect(
      strategy.choose([team, spare], session("ada:sbx-1"), at(minute)),
    ).toBe(team);
    // Resumed, the session stays where it moved to.
    expect(strategy.choose(all, session("ada:sbx-1"), at(2 * minute))).toBe(
      team,
    );
  });

  it("falls back to a worse priority only when no account of a better one can serve", () => {
    const strategy = sessionStrategy(createSessionTable(), 5 * hour);
    expect(strategy.choose([spare], session("ada:sbx-1"), at(0))).toBe(spare);
    expect(
      strategy.choose<Candidate>([], session("bea:sbx-2"), at(0)),
    ).toBeUndefined();
  });

  it("sends a request in no session where a new session would go, without keeping it", () => {
    const sessions = createSessionTable();
    const strategy = sessionStrategy(sessions, 5 * hour);
    strategy.choose(all, session("ada:sbx-1"), at(0));
    expect(strategy.choose(all, session(null), at(minute))).toBe(team);
    expect(sessions.sessionsOn("team", at(minute))).toBe(0);
  });
});

describe("the least-used strategy", () => {
  it("chooses the account of the best priority that used the fewest tokens lately", () => {
    const usage = createUsageTracker({ windowMs: 5 * hour });
    const strategy = leastUsedStrategy(usage);
    // A tie goes to the first in the Owner's order.
    expect(strategy.choose(all, session("ada:sbx-1"), at(0))).toBe(work);

    usage.record("work", 5_000, at(0));
    expect(strategy.choose(all, session("ada:sbx-1"), at(minute))).toBe(team);
    usage.record("team", 8_000, at(2 * minute));
    expect(strategy.choose(all, session("ada:sbx-1"), at(3 * minute))).toBe(
      work,
    );
    // An unused account of a worse priority is not chosen over them.
    expect(usage.used("spare", at(3 * minute))).toBe(0);
    expect(
      strategy.choose(all, session("ada:sbx-1"), at(3 * minute))?.priority,
    ).toBe(1);
    // It falls back to it only when the better ones cannot serve.
    expect(strategy.choose([spare], session(null), at(3 * minute))).toBe(spare);
  });

  it("counts only the tokens used in its window", () => {
    const usage = createUsageTracker({ windowMs: 5 * hour });
    usage.record("work", 9_000, at(0));
    usage.record("team", 1_000, at(4 * hour));
    const strategy = leastUsedStrategy(usage);
    expect(strategy.choose(all, session(null), at(4 * hour))).toBe(team);
    // Work's tokens leave the window five hours after they were used.
    expect(usage.used("work", at(5 * hour))).toBe(0);
    expect(strategy.choose(all, session(null), at(5 * hour))).toBe(work);
  });
});

describe("the session-affinity strategy", () => {
  it("keeps a session on its account for as long as it is in use, however long that is", () => {
    const usage = createUsageTracker({ windowMs: 5 * hour });
    const strategy = sessionAffinityStrategy(
      createSessionTable(),
      usage,
      30 * minute,
    );
    expect(strategy.choose(all, session("ada:sbx-1"), at(0))).toBe(work);
    usage.record("work", 50_000, at(minute));
    // A call every 20 minutes for six hours: never moved, though Team is
    // now less used and the session is far older than its window.
    for (let minutes = 20; minutes <= 6 * 60; minutes += 20) {
      expect(
        strategy.choose(all, session("ada:sbx-1"), at(minutes * minute)),
      ).toBe(work);
    }
  });

  it("starts each new session on the least-used account of the best priority", () => {
    const usage = createUsageTracker({ windowMs: 5 * hour });
    usage.record("work", 9_000, at(0));
    usage.record("team", 2_000, at(0));
    const strategy = sessionAffinityStrategy(
      createSessionTable(),
      usage,
      30 * minute,
    );
    expect(strategy.choose(all, session("ada:sbx-1"), at(minute))).toBe(team);
    usage.record("team", 10_000, at(2 * minute));
    expect(strategy.choose(all, session("bea:sbx-2"), at(3 * minute))).toBe(
      work,
    );
    // Spare has used nothing, but its priority is worse.
    expect(usage.used("spare", at(3 * minute))).toBe(0);
    // A request in no session goes where a new session would, unkept.
    expect(strategy.choose(all, session(null), at(4 * minute))).toBe(work);
  });

  it("lets a session go once it has been idle for the window, and moves one whose account cannot serve it", () => {
    const usage = createUsageTracker({ windowMs: 5 * hour });
    const sessions = createSessionTable();
    const strategy = sessionAffinityStrategy(sessions, usage, 30 * minute);
    expect(strategy.choose(all, session("ada:sbx-1"), at(0))).toBe(work);
    usage.record("work", 9_000, at(minute));
    expect(strategy.choose(all, session("ada:sbx-1"), at(29 * minute))).toBe(
      work,
    );
    // Idle from 0:29 to 0:59: the affinity lapsed, so it starts afresh on
    // the least-used account.
    expect(sessions.get("ada:sbx-1", at(59 * minute))).toBeUndefined();
    expect(strategy.choose(all, session("ada:sbx-1"), at(59 * minute))).toBe(
      team,
    );
    // Team is paused: the session moves, and stays where it moved to.
    expect(
      strategy.choose([work, spare], session("ada:sbx-1"), at(60 * minute)),
    ).toBe(work);
    expect(strategy.choose(all, session("ada:sbx-1"), at(61 * minute))).toBe(
      work,
    );
  });
});

describe("the drain-soonest strategy", () => {
  // Seeded usage windows: Work's five-hour window resets in four hours,
  // Team's in one, Spare's (a worse priority) in ten minutes; Key is an
  // API key, reporting none.
  const seeded = {
    work: {
      ...work,
      fiveHourResetsAt: at(4 * hour),
      weeklyResetsAt: at(90 * hour),
    },
    team: {
      ...team,
      fiveHourResetsAt: at(1 * hour),
      weeklyResetsAt: at(100 * hour),
    },
    spare: {
      ...spare,
      fiveHourResetsAt: at(10 * minute),
      weeklyResetsAt: null,
    },
    key: {
      id: "key",
      priority: 1,
      fiveHourResetsAt: null,
      weeklyResetsAt: null,
    },
  };
  const accounts = [seeded.key, seeded.work, seeded.team, seeded.spare];

  it("knows when each account's first window resets, and that an API key's never does", () => {
    expect(soonestReset(seeded.work, at(0))).toBe(at(4 * hour).getTime());
    // Whichever window resets first, weekly or five-hour.
    expect(
      soonestReset(
        {
          ...work,
          fiveHourResetsAt: at(2 * hour),
          weeklyResetsAt: at(30 * minute),
        },
        at(0),
      ),
    ).toBe(at(30 * minute).getTime());
    // A reset already past says nothing.
    expect(soonestReset(seeded.team, at(2 * hour))).toBe(
      at(100 * hour).getTime(),
    );
    expect(soonestReset(seeded.key, at(0))).toBe(Infinity);
    expect(soonestReset({ id: "bare", priority: 1 }, at(0))).toBe(Infinity);
  });

  it("starts new sessions on the account of the best priority whose window resets first", () => {
    const strategy = drainSoonestStrategy({
      strict: false,
      sessions: createSessionTable(),
      windowMs: 30 * minute,
    });
    expect(
      strategy.rank(accounts, session(null), at(0)).map(({ id }) => id),
    ).toEqual(["team", "work", "key", "spare"]);
    expect(strategy.choose(accounts, session("ada:sbx-1"), at(0))).toBe(
      seeded.team,
    );
    expect(strategy.choose(accounts, session("bea:sbx-2"), at(minute))).toBe(
      seeded.team,
    );
    // Team's window reset at 1:00 and its next one is a week off: Work's
    // now resets first.
    const later = [
      seeded.key,
      seeded.work,
      { ...seeded.team, fiveHourResetsAt: at(6 * hour) },
      seeded.spare,
    ];
    expect(strategy.choose(later, session("cy:sbx-3"), at(61 * minute))).toBe(
      seeded.work,
    );
  });

  it("keeps a session on its account while it is in use, though another's window now resets sooner", () => {
    const strategy = drainSoonestStrategy({
      strict: false,
      sessions: createSessionTable(),
      windowMs: 30 * minute,
    });
    expect(strategy.choose(accounts, session("ada:sbx-1"), at(0))).toBe(
      seeded.team,
    );
    const later = [
      seeded.key,
      seeded.work,
      { ...seeded.team, fiveHourResetsAt: at(6 * hour) },
      seeded.spare,
    ];
    for (const minutes of [20, 40, 60, 80]) {
      expect(
        strategy.choose(later, session("ada:sbx-1"), at(minutes * minute))?.id,
      ).toBe("team");
    }
    // Idle for the window, it starts again on the soonest.
    expect(
      strategy.choose(later, session("ada:sbx-1"), at(111 * minute))?.id,
    ).toBe("work");
  });

  it("strict, sends every request to the soonest, moving sessions as soon as another resets sooner", () => {
    const strategy = drainSoonestStrategy({ strict: true });
    expect(strategy.choose(accounts, session("ada:sbx-1"), at(0))).toBe(
      seeded.team,
    );
    const later = [
      seeded.key,
      seeded.work,
      { ...seeded.team, fiveHourResetsAt: at(6 * hour) },
      seeded.spare,
    ];
    expect(strategy.choose(later, session("ada:sbx-1"), at(61 * minute))).toBe(
      seeded.work,
    );
    expect(strategy.choose(later, session(null), at(62 * minute))).toBe(
      seeded.work,
    );
  });

  it("uses accounts without windows only after those with them, and a worse priority only when none of a better one can serve", () => {
    const strategy = drainSoonestStrategy({ strict: true });
    expect(
      strategy.choose([seeded.key, seeded.spare], session(null), at(0)),
    ).toBe(seeded.key);
    expect(strategy.choose([seeded.spare], session(null), at(0))).toBe(
      seeded.spare,
    );
    // With no windows anywhere, the Owner's order decides.
    const bare = [
      { id: "first", priority: 1 },
      { id: "second", priority: 1 },
    ];
    expect(strategy.choose(bare, session(null), at(0))?.id).toBe("first");
    expect(
      strategy.choose<Candidate>([], session(null), at(0)),
    ).toBeUndefined();
  });
});

describe("the load balancer", () => {
  it("uses the strategy and window the Owner chose, as they change", () => {
    let settings: LoadBalancingSettings = {
      strategy: "session",
      sessionWindowMinutes: 30,
    };
    const usage = createUsageTracker();
    const balancer = createLoadBalancer({ settings: () => settings, usage });

    expect(balancer.choose(all, session("ada:sbx-1"), at(0))).toBe(work);
    usage.record("work", 10_000, at(minute));
    expect(balancer.choose(all, session("ada:sbx-1"), at(2 * minute))).toBe(
      work,
    );

    settings = { ...settings, strategy: "least_used" };
    expect(balancer.choose(all, session("ada:sbx-1"), at(3 * minute))).toBe(
      team,
    );

    // Back to sessions, with a 30-minute window: ada is on work until 0:30.
    settings = { ...settings, strategy: "session" };
    expect(balancer.choose(all, session("ada:sbx-1"), at(29 * minute))).toBe(
      work,
    );
    // Then chosen afresh: work and team have no other sessions.
    expect(balancer.choose(all, session("bea:sbx-2"), at(30 * minute))).toBe(
      work,
    );
    expect(balancer.choose(all, session("ada:sbx-1"), at(31 * minute))).toBe(
      team,
    );
  });

  it("switches between every strategy at runtime", () => {
    let settings: LoadBalancingSettings = {
      strategy: "drain_soonest_strict",
      sessionWindowMinutes: 30,
    };
    const usage = createUsageTracker();
    usage.record("work", 1_000, at(0));
    const balancer = createLoadBalancer({ settings: () => settings, usage });
    const windows = [
      { ...work, fiveHourResetsAt: at(3 * hour) },
      { ...team, fiveHourResetsAt: at(1 * hour) },
      spare,
    ];

    expect(balancer.choose(windows, session("ada:sbx-1"), at(minute))?.id).toBe(
      "team",
    );
    settings = { ...settings, strategy: "least_used" };
    expect(balancer.choose(windows, session("ada:sbx-1"), at(minute))?.id).toBe(
      "team",
    );
    usage.record("team", 5_000, at(minute));
    expect(
      balancer.choose(windows, session("ada:sbx-1"), at(2 * minute))?.id,
    ).toBe("work");
    settings = { ...settings, strategy: "session_affinity" };
    expect(
      balancer.choose(windows, session("bea:sbx-2"), at(3 * minute))?.id,
    ).toBe("work");
    settings = { ...settings, strategy: "drain_soonest" };
    // Bea's session stays on Work; a new one goes to Team, resetting first.
    expect(
      balancer.choose(windows, session("bea:sbx-2"), at(4 * minute))?.id,
    ).toBe("work");
    expect(
      balancer.choose(windows, session("cy:sbx-3"), at(4 * minute))?.id,
    ).toBe("team");
    settings = { ...settings, strategy: "session" };
    expect(
      balancer.choose(windows, session("cy:sbx-3"), at(5 * minute))?.id,
    ).toBe("team");
  });

  it("balances by session for five hours by default", () => {
    const balancer = createLoadBalancer();
    expect(balancer.choose(all, session("ada:sbx-1"), at(0))).toBe(work);
    expect(balancer.choose(all, session("bea:sbx-2"), at(0))).toBe(team);
    expect(balancer.choose(all, session("ada:sbx-1"), at(5 * hour - 1))).toBe(
      work,
    );
  });
});

describe("the fallback back to a preferred account (FR-39)", () => {
  // Preferred is priority 1; Backup and Other (priority 2) serve only
  // while it is held back. It is rate-limited from 12:00 until its reset
  // at 12:30: the model-capacity filter leaves it out until then.
  const preferred: Candidate = { id: "preferred", priority: 1 };
  const backup: Candidate = { id: "backup", priority: 2 };
  const other: Candidate = { id: "other", priority: 2 };
  const reset = at(30 * minute);
  const checks = (now: Date): RoutingChecks<Candidate> => ({
    capacity: ({ id }) =>
      id === preferred.id && now < reset
        ? { message: "Every AI Account is rate-limited.", until: reset }
        : undefined,
    throttling: () => undefined,
  });

  it.each(["session", "session_affinity", "drain_soonest"] as const)(
    "moves a session that fell back to a worse priority back once the preferred account resets (%s)",
    (strategy) => {
      const sessions = createSessionTable();
      const balancer = createLoadBalancer({
        settings: () => ({ strategy, sessionWindowMinutes: 5 * 60 }),
        sessions,
      });
      const serve = (key: string, now: Date) =>
        route(
          balancer,
          [preferred, backup],
          { sessionKey: key },
          now,
          checks(now),
        )?.id;

      // Held back: the session falls back, and stays there until the reset.
      expect(serve("ada:sbx-1", at(0))).toBe("backup");
      expect(serve("ada:sbx-1", at(15 * minute))).toBe("backup");
      expect(serve("ada:sbx-1", at(30 * minute - 1))).toBe("backup");
      // At the reset it goes back, with no one telling it to; so do new
      // sessions.
      expect(serve("ada:sbx-1", at(30 * minute))).toBe("preferred");
      expect(serve("bea:sbx-2", at(30 * minute))).toBe("preferred");
      // It is now the preferred account's session, for a whole new window.
      expect(sessions.get("ada:sbx-1", at(30 * minute + 5 * hour - 1))).toBe(
        "preferred",
      );
      expect(serve("ada:sbx-1", at(31 * minute))).toBe("preferred");
    },
  );

  it("keeps a fallen-back session on its own account among those of its priority", () => {
    const sessions = createSessionTable();
    const balancer = createLoadBalancer({
      settings: () => ({ strategy: "session", sessionWindowMinutes: 5 * 60 }),
      sessions,
    });
    const serve = (key: string, now: Date) =>
      route(
        balancer,
        [preferred, backup, other],
        { sessionKey: key },
        now,
        checks(now),
      )?.id;
    // Two sessions fall back, one to each account of priority 2.
    expect(serve("ada:sbx-1", at(0))).toBe("backup");
    expect(serve("bea:sbx-2", at(minute))).toBe("other");
    // Neither is swapped while the preferred account is held back.
    for (const minutes of [5, 10, 29]) {
      expect(serve("ada:sbx-1", at(minutes * minute))).toBe("backup");
      expect(serve("bea:sbx-2", at(minutes * minute))).toBe("other");
    }
    // Then both return.
    expect(serve("ada:sbx-1", at(30 * minute))).toBe("preferred");
    expect(serve("bea:sbx-2", at(30 * minute))).toBe("preferred");
  });

  it("does not move a session between accounts of the best priority", () => {
    const sessions = createSessionTable();
    const strategy = sessionStrategy(sessions, 5 * hour);
    expect(strategy.choose([work, team], session("ada:sbx-1"), at(0))).toBe(
      work,
    );
    expect(strategy.choose([work, team], session("bea:sbx-2"), at(0))).toBe(
      team,
    );
    // Bea's session keeps to Team, though Work comes first in the order.
    expect(
      strategy.choose([work, team, spare], session("bea:sbx-2"), at(hour)),
    ).toBe(team);
  });
});
