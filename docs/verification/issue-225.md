# Issue #225: [fix] A1-7 — A restart forgets every sign-in lockout — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `0d9e194`,
`fix(security): A1-7 a lockout outlives a restart, replayed from sign_in_events`,
on top of `6122d84` (A1-9's fix). Its blocker, the A1 probe (#192), is in
the tree: `docs/pen-testing/assessments/A1.md` and
`apps/server/src/auth/login-limiter.pen-test.test.ts`.

This is the remediation of finding **A1-7** (`severity:low`, H7).

## What was fixed

The sign-in limiter keeps each client's failures and lockout in memory,
so a new process started every client afresh, though `sign_in_events`
held each failure.

- **`LoginLimiter.restore`** (`apps/server/src/auth/login-limiter.ts`)
  replays recorded attempts, oldest first, through the same counting a
  live attempt uses: a failure counts at the time it happened (locking the
  client out, and doubling, as it did then); a success forgets the client.
- **`restoreLimiter`** (`auth/attempts.ts`) reads the attempts from
  `AuthStore.signInEventsSince` (a new read, by the existing
  `sign_in_events_occurred_at_idx`) for as long as the limiter remembers a
  client, a day by default (`forgetAfterMs`), and keys each by
  `clientKey(ip)`, as live attempts are.
- **`buildApp`** restores the limiter before any route can be reached. If
  the database cannot be read, AI Office still starts, as it did before
  (`/health` reports the database), and logs "The sign-in limiter could
  not read sign_in_events: lockouts from before this start are
  forgotten." No one can sign in until the database answers: every
  password is in it.

No schema change: every attempt the limiter counts is already recorded in
`sign_in_events` (A1-4 and A1-5 made the last ones so).

### Sibling paths

The limiter is shared by everything that guesses at the Owner's
credentials: password and code sign-ins, API-key sign-ins, the fresh proof
(A1-3, A1-4) and the codes to turn TOTP off (A1-5). Each records its
checked attempts in `sign_in_events`, so a lockout from any of them is
restored. The sign-in challenges (the step between a right password and
its code) stay in memory and fail closed after a restart: the probe's
"holds" test still passes.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "a client
      locked out stays locked out after a restart" is an `it`, unchanged:
      after five failures and a restart on the same store, a sixth guess is
      `429`.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (A1-7): a
      restart no longer forgets every lockout that sign_in_events kept":
      the five failures are still on record, and the new process no longer
      answers `[401, 401, 401, 401, 401, 429]`: it answers `429` six
      times, and to the right password; once the minute is up, the next
      failure doubles the lockout, as without the restart.
- [x] **Sibling paths with the same flaw are fixed and tested.** "failures
      short of a lockout still count after a restart"; "a success before the
      restart still forgets the client's failures"; "a lockout from
      guessing through a fresh proof, or at turning TOTP off, outlives a
      restart too"; "what the limiter would have forgotten, a day without
      attempts, is not restored"; "a start without the database still
      starts, saying lockouts were not restored". Unit tests of `restore`
      in `login-limiter.test.ts`; `signInEventsSince` in memory and in
      Postgres (`store.test.ts`, the latter skipped here, runs in CI).
- [x] **The assessment's findings table marks `A1-7` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #225) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below:
      lint and typecheck pass; `pnpm test` has only the two failures that
      were there before this run, unrelated.

## Real output of the checks

The checks were run once on the finished tree, at `3eb8303` (all five
fixes of this run); see
[issue-227.md](issue-227.md#real-output-of-the-checks) for the output of
all three, shared by the five notes.

### The probe tests, verbose

```
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > a client locked out stays locked out after a restart
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > regression (A1-7): a restart no longer forgets every lockout that sign_in_events kept
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > A1-7 sibling: failures short of a lockout still count after a restart
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > A1-7 sibling: a success before the restart still forgets the client's failures
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > A1-7 sibling: a lockout from guessing through a fresh proof, or at turning TOTP off, outlives a restart too
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > A1-7 sibling: what the limiter would have forgotten, a day without attempts, is not restored
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > A1-7: a start without the database still starts, saying lockouts were not restored
✓ login-limiter.pen-test.test.ts > A1-7: the limiter across a restart > a sign-in challenge does not survive a restart: it fails closed
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **Rebuilt from `sign_in_events`, not kept in a table of its own.** The
   record was already complete and kept (with the Activity Feed, a year by
   default); a second copy of the limiter's state would have to be kept
   in step with it. The limiter stays in memory between starts, as AI
   Office runs as one process.
2. **The last day is replayed**, the limiter's own memory
   (`forgetAfterMs`). A client failing less than once a day for longer
   than a day has only its last day's failures counted after a restart:
   at most a guess a day, which the limiter would not stop either.
3. **Without the database, AI Office starts anyway**, as it did, rather
   than refusing to start: with no database nobody can sign in, so
   nothing is guessed, and `/health` already says why.

## Noticed, out of scope

- **Storage's "delete older history"** deletes `sign_in_events` with the
  Activity Feed. Deleting the last day's would also forget the day's
  lockouts at the next restart. The Owner chooses it; nothing an attacker
  holds can.

## What could not be verified here

- **Postgres:** `signInEventsSince`'s query was read, not run; its
  Postgres test runs in CI. The probes restart on the same in-memory
  store, as a restart on the same Postgres would.
- **A real restart** (the process killed and started under compose) needs
  Docker; the probe's restart is a second app on the same store.
