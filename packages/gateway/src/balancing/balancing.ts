import {
  defaultLoadBalancingSettings,
  leastUsedWindowMs,
  type LoadBalancingSettings,
  type LoadBalancingStrategy,
} from "@ai-office/shared";

// Load balancing (PRD FR-37): which of the AI Accounts that can serve a
// request does. The candidates come in the Owner's priority order, paused
// accounts and those that cannot serve the request already left out, and
// every strategy respects priority: it ranks the accounts of the best
// (lowest) priority first, so an account of a worse priority serves only
// while none of a better one can. Within a priority:
// - `session` keeps a session (an Agent's sandbox run, or an Owner tool)
//   on the account it started on for a window (5 hours by default), and
//   starts each new session on the account with the fewest sessions;
// - `session_affinity` keeps a session on its account for as long as it
//   is in use (each call renews the window), and starts each new session
//   on the account that has used the fewest tokens lately;
// - `drain_soonest` starts each new session on the account whose usage
//   window resets first, so what is left of it is used rather than lost,
//   keeping sessions on their accounts as session-affinity does;
//   `drain_soonest_strict` sends every request there, sessions or not;
// - `least_used` sends each request to the account that has used the
//   fewest tokens in the last five hours.
// Each strategy ranks the candidates, best first: the AI Gateway serves
// from the first that is not held back, then tells the strategy which
// that was. Ties go to the account first in the Owner's order. A session
// keeps to its account only among those of its priority, so one that fell
// back to a worse priority, while the better accounts were held back,
// returns to them once their limit resets (FR-39's fallback back).

/** An AI Account a request could be served from. */
export interface Candidate {
  readonly id: string;
  /** 1 is used first. */
  readonly priority: number;
  /**
   * When its five-hour and weekly usage windows reset, where its AI
   * Provider reports them (drain-soonest); null or absent when unknown.
   */
  readonly fiveHourResetsAt?: Date | null;
  readonly weeklyResetsAt?: Date | null;
}

/** What a strategy knows of the request it chooses for. */
export interface BalancingRequest {
  /**
   * The session it belongs to, to keep on one account; null when it
   * belongs to none.
   */
  readonly sessionKey: string | null;
}

/** Ranks the candidates for a request, and learns which one served it. */
export interface Strategy {
  readonly name: LoadBalancingStrategy;
  /** `candidates` (in the Owner's order), best first. */
  rank<C extends Candidate>(
    candidates: readonly C[],
    request: BalancingRequest,
    now: Date,
  ): C[];
  /** Told the account that serves the request, so a session can stay on it. */
  served(account: Candidate, request: BalancingRequest, now: Date): void;
  /** The first of `rank`, told it serves: for a request nothing else filters. */
  choose<C extends Candidate>(
    candidates: readonly C[],
    request: BalancingRequest,
    now: Date,
  ): C | undefined;
}

/** A strategy from how it ranks and what it learns from each choice. */
function strategy(
  name: LoadBalancingStrategy,
  rank: Strategy["rank"],
  served: Strategy["served"] = () => undefined,
): Strategy {
  return {
    name,
    rank,
    served,
    choose(candidates, request, now) {
      const [chosen] = rank(candidates, request, now);
      if (chosen !== undefined) {
        served(chosen, request, now);
      }
      return chosen;
    },
  };
}

/** The candidates of the best priority among them, in order. */
export function bestTier<C extends Candidate>(candidates: readonly C[]): C[] {
  const best = Math.min(...candidates.map(({ priority }) => priority));
  return candidates.filter(({ priority }) => priority === best);
}

/**
 * `candidates` by priority, then by least `score`; a tie keeps the
 * Owner's order.
 */
function byPriorityThen<C extends Candidate>(
  candidates: readonly C[],
  score: (candidate: C) => number,
): C[] {
  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: score(candidate),
  }));
  scored.sort(
    (a, b) =>
      a.candidate.priority - b.candidate.priority ||
      a.score - b.score ||
      a.index - b.index,
  );
  return scored.map(({ candidate }) => candidate);
}

/**
 * `ranked` (by priority first), with the session's current account, if it
 * is a candidate, first among the accounts of its own priority. It never
 * goes ahead of a better priority: a session that fell back to a worse
 * one while the better accounts were held back moves back to them as
 * soon as one can serve again, its limit reset (FR-39).
 */
function stickyFirst<C extends Candidate>(
  sessions: SessionTable,
  request: BalancingRequest,
  now: Date,
  ranked: C[],
): C[] {
  const current =
    request.sessionKey === null
      ? undefined
      : sessions.get(request.sessionKey, now);
  const sticky = ranked.find(({ id }) => id === current);
  if (sticky === undefined) {
    return ranked;
  }
  const rest = ranked.filter((candidate) => candidate !== sticky);
  const better = rest.filter(({ priority }) => priority < sticky.priority);
  return [...better, sticky, ...rest.slice(better.length)];
}

/** Which account each session is on, and until when. */
export interface SessionTable {
  /** The session's account, if its window has not ended. */
  get(key: string, now: Date): string | undefined;
  set(key: string, accountId: string, until: Date): void;
  /** How many sessions are on the account now. */
  sessionsOn(accountId: string, now: Date): number;
}

export function createSessionTable(): SessionTable {
  const sessions = new Map<string, { accountId: string; until: Date }>();
  const prune = (now: Date) => {
    for (const [key, session] of sessions) {
      if (session.until <= now) {
        sessions.delete(key);
      }
    }
  };
  return {
    get(key, now) {
      // Sessions that ended are forgotten, so the table stays small.
      prune(now);
      return sessions.get(key)?.accountId;
    },
    set(key, accountId, until) {
      sessions.set(key, { accountId, until });
    },
    sessionsOn(accountId, now) {
      prune(now);
      let count = 0;
      for (const session of sessions.values()) {
        if (session.accountId === accountId) {
          count += 1;
        }
      }
      return count;
    },
  };
}

/**
 * Sticks each session to one account for `windowMs` from when it started
 * there. A session whose account can no longer serve it starts again on
 * another. A request in no session goes where a new session would.
 */
export function sessionStrategy(
  sessions: SessionTable,
  windowMs: number,
): Strategy {
  return strategy(
    "session",
    (candidates, request, now) =>
      stickyFirst(
        sessions,
        request,
        now,
        byPriorityThen(candidates, ({ id }) => sessions.sessionsOn(id, now)),
      ),
    (account, { sessionKey }, now) => {
      // A new window only when the session starts, or moves.
      if (sessionKey !== null && sessions.get(sessionKey, now) !== account.id) {
        sessions.set(
          sessionKey,
          account.id,
          new Date(now.getTime() + windowMs),
        );
      }
    },
  );
}

/** Keeps the session on `account` until `windowMs` after this call. */
const renew =
  (sessions: SessionTable, windowMs: number): Strategy["served"] =>
  (account, { sessionKey }, now) => {
    if (sessionKey !== null) {
      sessions.set(sessionKey, account.id, new Date(now.getTime() + windowMs));
    }
  };

/** Tokens each account has used lately. */
export interface UsageSource {
  /** Input and output tokens the account used in the window before `now`. */
  used(accountId: string, now: Date): number;
}

/**
 * Keeps each session on its account for as long as it is in use: every
 * call renews it, and it lapses only after `windowMs` without one. A new
 * session (or a request in none) goes to the least-used account.
 */
export function sessionAffinityStrategy(
  sessions: SessionTable,
  usage: UsageSource,
  windowMs: number,
): Strategy {
  return strategy(
    "session_affinity",
    (candidates, request, now) =>
      stickyFirst(
        sessions,
        request,
        now,
        byPriorityThen(candidates, ({ id }) => usage.used(id, now)),
      ),
    renew(sessions, windowMs),
  );
}

/**
 * When the first of an account's usage windows resets after `now`, in
 * milliseconds since the epoch; Infinity when none is known, so an account
 * without windows (an API key) comes after those with them.
 */
export function soonestReset(candidate: Candidate, now: Date): number {
  const resets = [candidate.fiveHourResetsAt, candidate.weeklyResetsAt]
    .filter((at): at is Date => at != null && at > now)
    .map((at) => at.getTime());
  return resets.length === 0 ? Infinity : Math.min(...resets);
}

/**
 * Drains the account whose usage window resets first. Not strict, a
 * session stays on its account while in use, as with session-affinity, and
 * only a new session (or a request in none) goes to the soonest; strict,
 * every request does, so sessions move as soon as another account's
 * window resets sooner.
 */
export function drainSoonestStrategy(
  options:
    | { readonly strict: true }
    | {
        readonly strict: false;
        readonly sessions: SessionTable;
        readonly windowMs: number;
      },
): Strategy {
  const ranked = <C extends Candidate>(candidates: readonly C[], now: Date) =>
    byPriorityThen(candidates, (candidate) => soonestReset(candidate, now));
  if (options.strict) {
    return strategy("drain_soonest_strict", (candidates, _request, now) =>
      ranked(candidates, now),
    );
  }
  const { sessions, windowMs } = options;
  return strategy(
    "drain_soonest",
    (candidates, request, now) =>
      stickyFirst(sessions, request, now, ranked(candidates, now)),
    renew(sessions, windowMs),
  );
}

/** Sends each request to the account that has used the fewest tokens. */
export function leastUsedStrategy(usage: UsageSource): Strategy {
  return strategy("least_used", (candidates, _request, now) =>
    byPriorityThen(candidates, ({ id }) => usage.used(id, now)),
  );
}

/** Tokens each account used, kept for a window: least-used's source. */
export interface UsageTracker extends UsageSource {
  /** Counts tokens an account used at `at`. */
  record(accountId: string, tokens: number, at: Date): void;
}

export function createUsageTracker(
  options: { readonly windowMs?: number } = {},
): UsageTracker {
  const windowMs = options.windowMs ?? leastUsedWindowMs;
  const entries = new Map<string, { tokens: number; at: number }[]>();
  return {
    record(accountId, tokens, at) {
      if (tokens <= 0) {
        return;
      }
      const list = entries.get(accountId) ?? [];
      list.push({ tokens, at: at.getTime() });
      entries.set(accountId, list);
    },
    used(accountId, now) {
      const since = now.getTime() - windowMs;
      const list = (entries.get(accountId) ?? []).filter(
        ({ at }) => at > since,
      );
      entries.set(accountId, list);
      return list.reduce((sum, { tokens }) => sum + tokens, 0);
    },
  };
}

/** Chooses each request's account by the strategy the Owner chose. */
export interface LoadBalancer {
  /** The candidates, best first, by the strategy the Owner chose. */
  rank<C extends Candidate>(
    candidates: readonly C[],
    request: BalancingRequest,
    now: Date,
  ): C[];
  /** Tells the strategy which account serves the request. */
  served(account: Candidate, request: BalancingRequest, now: Date): void;
  /** The first of `rank`, told it serves. */
  choose<C extends Candidate>(
    candidates: readonly C[],
    request: BalancingRequest,
    now: Date,
  ): C | undefined;
}

export function createLoadBalancer(
  options: {
    /** The Owner's settings, asked on every request: no restart needed. */
    readonly settings?: () => LoadBalancingSettings;
    /** Tokens each account used lately, for least-used and session-affinity. */
    readonly usage?: UsageSource;
    readonly sessions?: SessionTable;
  } = {},
): LoadBalancer {
  const settings = options.settings ?? (() => defaultLoadBalancingSettings);
  const sessions = options.sessions ?? createSessionTable();
  const usage = options.usage ?? createUsageTracker();
  const current = (): Strategy => {
    const { strategy: name, sessionWindowMinutes } = settings();
    const windowMs = sessionWindowMinutes * 60 * 1000;
    switch (name) {
      case "session":
        return sessionStrategy(sessions, windowMs);
      case "session_affinity":
        return sessionAffinityStrategy(sessions, usage, windowMs);
      case "drain_soonest":
        return drainSoonestStrategy({ strict: false, sessions, windowMs });
      case "drain_soonest_strict":
        return drainSoonestStrategy({ strict: true });
      case "least_used":
        return leastUsedStrategy(usage);
    }
  };
  return {
    rank(candidates, request, now) {
      return current().rank(candidates, request, now);
    },
    served(account, request, now) {
      current().served(account, request, now);
    },
    choose(candidates, request, now) {
      return current().choose(candidates, request, now);
    },
  };
}

/** Why a check leaves an account out, and until when. */
export interface Exclusion {
  /** What the AI Gateway says when the check leaves every account out. */
  readonly message: string;
  readonly until: Date;
}

/**
 * The checks after the strategy (FR-38), in order: the model-capacity
 * filter, then usage throttling. Each says why it leaves a candidate out,
 * or undefined to keep it.
 */
export interface RoutingChecks<C extends Candidate> {
  /** Exhausted for the request's model family, or rate-limited. */
  readonly capacity: (candidate: C) => Exclusion | undefined;
  /** Overloaded, at a usage pause threshold, or ahead of its pace. */
  readonly throttling: (candidate: C) => Exclusion | undefined;
}

/**
 * Routes a request among `candidates`, the accounts that can serve it
 * (FR-38; a forced account is the caller's to honour first): the strategy
 * ranks them, then the model-capacity filter and usage throttling each
 * leave out what they must, and the first left serves (one not yet tried
 * for this request, if there is one). The strategy is told which. When a
 * check leaves none, the error says which: 429 for capacity, 529 for
 * throttling, with when the first it left out is back. Undefined when
 * there are no candidates at all (the caller's 503).
 */
export function route<C extends Candidate>(
  balancer: Pick<LoadBalancer, "rank" | "served">,
  candidates: readonly C[],
  request: BalancingRequest & { readonly avoid?: readonly string[] },
  now: Date,
  checks: RoutingChecks<C>,
): C | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  let left = balancer.rank(candidates, request, now);
  for (const [check, status] of [
    [checks.capacity, 429],
    [checks.throttling, 529],
  ] as const) {
    const exclusions = left.map((candidate) => check(candidate));
    const kept = left.filter((_, index) => exclusions[index] === undefined);
    if (kept.length === 0) {
      const [first] = exclusions;
      throw new AccountsUnavailableError(
        status,
        first?.message ?? "No AI Account can serve this request.",
        new Date(
          Math.min(
            ...exclusions.map((exclusion) => exclusion?.until.getTime() ?? 0),
          ),
        ),
      );
    }
    left = kept;
  }
  const avoid = new Set(request.avoid ?? []);
  const chosen = left.find(({ id }) => !avoid.has(id)) ?? left[0];
  if (chosen !== undefined) {
    balancer.served(chosen, request, now);
  }
  return chosen;
}

/**
 * When a usage window used `utilization` percent, resetting at `resetsAt`,
 * is back within an even pace through its `windowMs` plus
 * `headroomPercent` (FR-38 usage throttling); undefined when it is within
 * it now. Halfway through a window, half of it (plus the headroom) may be
 * used; the rest waits for the window to go on.
 */
export function aheadOfPace(
  window: { readonly utilization: number; readonly resetsAt: Date },
  windowMs: number,
  headroomPercent: number,
  now: Date,
): Date | undefined {
  const reset = window.resetsAt.getTime();
  const left = reset - now.getTime();
  if (left <= 0) {
    // The window is over: its next starts afresh.
    return undefined;
  }
  // In percent, worked out whole so an hour of five is exactly 20.
  const elapsed = Math.min(
    100,
    Math.max(0, ((windowMs - left) * 100) / windowMs),
  );
  if (window.utilization <= elapsed + headroomPercent) {
    return undefined;
  }
  // When the even pace reaches what is used, or the window resets.
  const start = reset - windowMs;
  return new Date(
    Math.min(
      reset,
      start + ((window.utilization - headroomPercent) / 100) * windowMs,
    ),
  );
}

/**
 * Why a request's forced AI Account (FR-38) cannot serve it: there is no
 * such account, it is paused, or it cannot serve this request. The request
 * is refused rather than served from another account.
 */
export class ForcedAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForcedAccountError";
  }
}

/**
 * Why no AI Account can serve a request, though some could but for being
 * held back (FR-38): all failing (503), rate-limited (a capacity
 * exclusion, 429) or overloaded (throttling, 529). `retryAt` is when the
 * first of them is expected back.
 */
export class AccountsUnavailableError extends Error {
  readonly status: 429 | 503 | 529;
  readonly retryAt: Date | undefined;

  constructor(
    status: 429 | 503 | 529,
    message: string,
    retryAt: Date | undefined,
  ) {
    super(message);
    this.name = "AccountsUnavailableError";
    this.status = status;
    this.retryAt = retryAt;
  }
}
