# Issue #99: Session-affinity and drain-soonest strategies — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `5a92ee8` (every code commit of the issue and the
README).

## What was built

- **The strategies** (`packages/shared/src/load-balancing.ts`): the Owner
  chooses, at runtime, among `session`, `session_affinity`, `drain_soonest`,
  `drain_soonest_strict` and `least_used` (PRD FR-37).
  `PUT /api/office/load-balancing` takes each one. `office_settings`' check
  constraint now admits the three new values (migration
  `0033_load_balancing_strategies`).
- **Ranking** (`packages/gateway/src/balancing/balancing.ts`):
  - Every strategy now ranks the candidates, best first, and is then told
    which account served (`rank` and `served`). `choose` is the first of
    the ranking. This is the step #100's filters will sit between.
  - Every strategy ranks by priority first, so a worse priority serves only
    when no better one can. Ties keep the Owner's order.
  - `session` and `least_used` behave as before; their tests are
    unchanged and pass.
- **Session-affinity** (`sessionAffinityStrategy`):
  - A session stays on its account for as long as it is in use. Every call
    renews its window, and it lapses only after the session window (the
    same `sessionWindowMinutes` setting) passes with no call.
  - `session`, by contrast, ends a fixed window after the session started
    there.
  - A new session (or a request in none) starts on the least-used account
    (tokens in the last five hours).
  - A session whose account can no longer serve moves, and stays where it
    moved to.
- **Drain-soonest** (`drainSoonestStrategy`):
  - It prefers the account whose usage window resets first:
    `soonestReset` is the earlier of the account's five-hour and weekly
    resets that are still ahead (`fiveHourResetsAt` and `weeklyResetsAt`,
    as the AI Provider reports them, now on `Candidate`).
  - An account with no window (an API key) ranks after those with one.
  - **Not strict:** only a new session (or a request in none) goes to the
    soonest. A session in use stays on its account, as with
    session-affinity, so it is not moved mid-way.
  - **Strict:** every request goes to the soonest, so sessions move as soon
    as another account's window resets sooner.
- **Session table:** sessions that ended are now pruned whenever one is
  read, so a long-running Gateway does not keep every sandbox id it has
  seen.
- **Admin** (`apps/web/src/load-balancing-card.tsx`): the **Load balancing**
  card offers all five strategies, each with what it does. The session
  window's hint says how each strategy uses it.
- **README:** the **Load balancing** section describes each strategy and
  the API's values.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below): 1435 passed, 264 skipped (the Postgres cases,
      without Docker).
- [x] **Unit tests for each strategy against seeded usage windows.**
  - `packages/gateway/src/balancing/balancing.test.ts`:
    - **session-affinity:**
      - with a 30-minute window and a call every 20 minutes for six hours,
        the session never moves, even though another account becomes less
        used;
      - new sessions go to the least-used account, never to a worse
        priority;
      - an idle session lapses after the window and starts afresh;
      - a session whose account is gone moves, and stays.
    - **drain-soonest**, seeded with five-hour and weekly resets (Work in
      4 h, Team in 1 h, Spare of a worse priority in 10 min, an API key
      with none):
      - `soonestReset` picks the earlier window, ignores a reset already
        past, and is `Infinity` without windows;
      - the ranking is Team, Work, the key, then Spare;
      - once Team's window resets (its next is 6 h off), new sessions go
        to Work;
      - not strict, an in-use session stays on Team until it has been idle
        for the window;
      - strict, it moves to Work at once;
      - ties without windows keep the Owner's order, and an empty list
        chooses nothing.
    - **load balancer:** it switches between all five strategies at
      runtime, and each choice is the one that strategy should make.
  - `packages/gateway/src/balancing/routing.test.ts`, through
    `AiAccounts.select` (in memory; the same cases run in Postgres on the
    host):
    - drain-soonest with five-hour windows reported through
      `accounts.report`, the strict variant moving the session;
    - session-affinity keeping a session through 100 minutes of calls with
      a 30-minute window.
  - `apps/server/src/office/routes.test.ts`: `PUT` and `GET
    /api/office/load-balancing` with each new strategy.
  - `apps/web/src/load-balancing-card.test.tsx`: the card offers all five
    strategies, and saves "Drain soonest (strict)" and "Session affinity".

### Real output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck`:

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`:

```text
 Test Files  148 passed (148)
      Tests  1435 passed | 264 skipped (1699)
exit 0
```

The strategy tests (`--reporter=verbose`, excerpt):

```text
 ✓ src/balancing/balancing.test.ts > the session strategy > keeps a session on its account for the window, and spreads new sessions across the best priority
 ✓ src/balancing/balancing.test.ts > the session strategy > chooses afresh once the window ends
 ✓ src/balancing/balancing.test.ts > the session strategy > moves a session whose account can no longer serve it, such as a paused one
 ✓ src/balancing/balancing.test.ts > the session strategy > falls back to a worse priority only when no account of a better one can serve
 ✓ src/balancing/balancing.test.ts > the session strategy > sends a request in no session where a new session would go, without keeping it
 ✓ src/balancing/balancing.test.ts > the least-used strategy > chooses the account of the best priority that used the fewest tokens lately
 ✓ src/balancing/balancing.test.ts > the least-used strategy > counts only the tokens used in its window
 ✓ src/balancing/balancing.test.ts > the session-affinity strategy > keeps a session on its account for as long as it is in use, however long that is
 ✓ src/balancing/balancing.test.ts > the session-affinity strategy > starts each new session on the least-used account of the best priority
 ✓ src/balancing/balancing.test.ts > the session-affinity strategy > lets a session go once it has been idle for the window, and moves one whose account cannot serve it
 ✓ src/balancing/balancing.test.ts > the drain-soonest strategy > knows when each account's first window resets, and that an API key's never does
 ✓ src/balancing/balancing.test.ts > the drain-soonest strategy > starts new sessions on the account of the best priority whose window resets first
 ✓ src/balancing/balancing.test.ts > the drain-soonest strategy > keeps a session on its account while it is in use, though another's window now resets sooner
 ✓ src/balancing/balancing.test.ts > the drain-soonest strategy > strict, sends every request to the soonest, moving sessions as soon as another resets sooner
 ✓ src/balancing/balancing.test.ts > the drain-soonest strategy > uses accounts without windows only after those with them, and a worse priority only when none of a better one can serve
 ✓ src/balancing/balancing.test.ts > the load balancer > uses the strategy and window the Owner chose, as they change
 ✓ src/balancing/balancing.test.ts > the load balancer > switches between every strategy at runtime
 ✓ src/balancing/routing.test.ts > routing, with AI Accounts in memory > drains the account whose usage window resets first, from the windows its AI Provider reports, once the Owner chooses it
 ✓ src/balancing/routing.test.ts > routing, with AI Accounts in memory > keeps a session on its account while it is in use, once the Owner chooses session-affinity
 ✓ src/balancing/routing.test.ts > routing, with AI Accounts in memory > honours a forced account before any strategy, whatever its priority
 ✓ src/load-balancing-card.test.tsx > load balancing in Admin > switches to least-used and changes the window, saving at once
 ✓ src/office/routes.test.ts > the office's settings, in memory > balances by session for five hours by default, and sets another strategy at runtime
 ✓ src/load-balancing-card.test.tsx > load balancing in Admin > offers every strategy, and saves session affinity or drain soonest (strict)
```

## Not verifiable in this sandbox

- **Postgres 18 (Docker):** migration `0030` (the new check constraint), and
  the routing and office-settings cases in Postgres, skip here with the
  reason. They run on the host and in CI.
- **Real AI Accounts:** that real Claude subscriptions report their windows
  so drain-soonest can order them is #45's recorded fixtures and the host's
  work. Here the windows are seeded, or reported through the same
  `report` path the Gateway uses.

## Notes

- The PRD names session-affinity and the strict variant without defining
  them (FR-37). Here, session-affinity is stickiness that lasts while a
  session is in use (renewed by each call), as opposed to `session`'s
  fixed window from its start. The strict variant of drain-soonest is the
  one that moves sessions. The README and the Admin card say so.
- Sessions are still kept in memory, as before, so a restart starts them
  afresh.
