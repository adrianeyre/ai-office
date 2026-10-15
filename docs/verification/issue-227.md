# Issue #227: [fix] A1-8 — A session never idles out: a stolen cookie works for its full 7 days unused — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `3eb8303`,
`fix(security): A1-8 a session left 24 hours unused is refused`, on top of
`0d9e194` (A1-7's fix). Its blocker, the A1 probe (#192), is in the tree:
`docs/pen-testing/assessments/A1.md` and
`apps/server/src/auth/sessions.pen-test.test.ts`.

This is the remediation of finding **A1-8** (`severity:low`, H7). The
issue asks for an idle period "the Owner can see (and the PRD states)", so
FR-2 in `ai-office.md` was changed to state it.

## What was fixed

A session lasted a fixed 7 days from sign-in, used or not.

- **`sessionIdleMs`** (`packages/shared/src/auth.ts`): 24 hours.
- **`sessions.last_seen_at`** (`packages/db/src/schema.ts`, and the one
  migration regenerated with `db:generate`): when the session was last
  used, to the minute; null until first used after sign-in, when its
  `created_at` stands for it.
- **`Sessions.authenticate`** (`apps/server/src/auth/sessions.ts`), which
  every path that accepts a session goes through, refuses and deletes a
  session last used more than 24 hours ago, as it does an expired one,
  and otherwise notes the use (`AuthStore.touchSession`) when the last
  note is a minute old or more. The 7 days still bound it however it is
  used.
- **What the Owner sees:** FR-2 now reads "Sessions expire after 7 days,
  or after 24 hours unused." The login page says "You stay signed in for 7
  days from signing in, or 24 hours unused."; the cookie policy's
  `ai_office_session` row and the privacy policy say the same, from the
  same constants (`apps/web/src/session-length.ts`). The guide
  (`docs/guide/running.md`, Signing in) says it too.

### Sibling paths

Every way a session is presented goes through `authenticate`: guarded API
routes, pages (`access.page`), the live streams' heartbeats, and sessions
begun with an API key. Each is tested. The time of last use is in the
database, so a restart neither forgets nor resets it (the A1-7 flaw does
not repeat here).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "A1-8: a
      session left unused for most of a week is refused (an idle timeout)"
      is an `it`, unchanged: unused for 6 days 23 hours, `401`.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "A1-8 regression: a cookie
      unused for 6 days 23 hours no longer works, and the session is gone":
      no longer `200`; `401`, and the session deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** New
      `describe("A1-8 · the idle timeout on every path")`: 24 hours exactly
      (kept a minute before, refused just after); use keeps it alive, is
      noted at most once a minute, and never past 7 days; a session begun
      with an API key idles out; an idle session's page redirects to
      `/login` and its live stream is `401`; the time of last use outlives
      a restart. Web: the login page and the cookie policy state it
      (`login-page.test.tsx`, `legal/legal.test.tsx`). Postgres: "notes
      when a session was last used (A1-8)" (`store.test.ts`, skipped here,
      runs in CI).
- [x] **The assessment's findings table marks `A1-8` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #227) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below:
      lint and typecheck pass; `pnpm test` has only the two failures that
      were there before this run, unrelated.

Two existing tests in `apps/server/src/auth/sessions.test.ts` let a
session sit unused for days to test its fixed 7-day life: "expires 7 days
after sign-in, and is then rejected" (unused until a millisecond before
the 7 days) and "is not extended by use" (unused for 3½ days). Each now
uses the session within every day on the way, then makes the same
assertions; what they test, that the 7 days are fixed from sign-in and
use never extends them, is unchanged. The pen-test "ends 7 days after
sign-in, however much it is used" (used every 24 hours) passes unchanged.

## Real output of the checks

Run once on the finished tree, at `3eb8303`, after all five fixes of this
run (#219, #221, #223, #225, #227); the other four notes point here.

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: two failures, both pre-existing and unrelated

```
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 Test Files  2 failed | 422 passed (424)
      Tests  2 failed | 4868 passed | 12 expected fail | 603 skipped (5485)
test exit 1
```

Both expect the first release heading of `CHANGELOG.md` to carry a date
(`expected '1.0.0' to match /^1.0.0 \(/`). They failed the same way before
this run (the A1-1 to A1-4 notes record them), and nothing this run
changed touches `CHANGELOG.md`, the footer or the changelog's test
(`git diff 4f20228 --stat -- CHANGELOG.md apps/web/src/site-footer.tsx
apps/web/src/site-footer.test.tsx apps/web/src/legal/changelog.tsx` is
empty). The 603 skipped are the Postgres-backed tests (no Docker here),
among them the new store tests of this run. The 12 expected fails are the
open findings' `it.fails` of the other probes (S1, S2 and the rest): before
this run there were 22, and the ten of A1-5 to A1-9 are now `it`s. One run
during the work had a third failure, `idle-behaviours.test.ts` timing out
at 30 s while another suite ran beside it; it passed alone (45 of 45) and
in this run.

### The probe tests, verbose

```
✓ sessions.pen-test.test.ts > session lifetime > ends 7 days after sign-in, however much it is used
✓ sessions.pen-test.test.ts > session lifetime > A1-8: a session left unused for most of a week is refused (an idle timeout)
✓ sessions.pen-test.test.ts > session lifetime > A1-8 regression: a cookie unused for 6 days 23 hours no longer works, and the session is gone
✓ sessions.pen-test.test.ts > A1-8 · the idle timeout on every path > is 24 hours: refused just after, kept just before
✓ sessions.pen-test.test.ts > A1-8 · the idle timeout on every path > use keeps it alive, noted at most once a minute, but never past 7 days
✓ sessions.pen-test.test.ts > A1-8 · the idle timeout on every path > a session begun with an API key idles out too
✓ sessions.pen-test.test.ts > A1-8 · the idle timeout on every path > an idle session's pages send it to sign in, and its live streams are refused
✓ sessions.pen-test.test.ts > A1-8 · the idle timeout on every path > the time it was last used outlives a restart
```

## Decisions

Neither the PRD nor an ADR decided the idle period. This is the most
conservative option that keeps the product working, recorded here for the
Owner to review:

1. **24 hours.** A cookie stolen and left unused stops working within a
   day instead of a week. A page left open in a browser keeps its session
   in use (its live stream's heartbeat goes through `authenticate` every
   15 seconds), so the Office on a second monitor all day is never signed
   out; the Owner who closes the browser signs in again the next day. A
   shorter period would sign the Owner out of a phone or a second machine
   between uses for little gain, as the 7 days still bound every session.
2. **Any authenticated request is use**, the live streams' heartbeats
   included. A thief who keeps a stream open keeps the session, as the
   Owner's open page does; the 7 days and sign-out-everywhere still end
   it.
3. **Noted at most once a minute**, so a busy page does not write to the
   database on every request; the 24 hours are therefore exact to within
   a minute.
4. **`last_seen_at` is nullable**, null meaning "not used since sign-in"
   (its `created_at`), so a session needs no write to begin and existing
   rows stay valid.
5. **FR-2 is changed** to state the period, as the issue asks.

## Noticed, out of scope

- **Sessions refused for idling are deleted when next presented**; one
  never presented again stays in `sessions` until its 7 days are up, when
  the next sign-in sweeps it with the other expired ones. It cannot be
  used meanwhile.
- **The schema changed** (one column). AI Office keeps its schema as one
  migration, so a development database made before this needs `pnpm
  db:reset` (the server says the schema has changed).

## What could not be verified here

- **Postgres:** the `last_seen_at` column and `touchSession` were read,
  not run; their Postgres test runs in CI. The migration was regenerated
  with `pnpm --filter @ai-office/db db:generate`, which adds only the
  column.
- **A browser** left open across a day was not tried (no browser here);
  that the heartbeat keeps a session in use is tested through the same
  `authenticate` the heartbeat calls.

## The A1 probe after this run

Every A1 finding is now fixed: the A1 probe files hold no `it.fails`, and
`docs/pen-testing/assessments/A1.md` marks A1-1 to A1-9 **fixed**.
