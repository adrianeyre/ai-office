# Issue #217: [fix] A1-4 — POST /api/owner-passwords confirms a guess at any Owner password with 409 password_in_use, unthrottled and unrecorded — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `68b5dac`,
`fix(security): A1-4 a session's proof is limited and recorded as a sign-in attempt is`,
on top of `b482e7f` (A1-3's fix, #215, which it completes). Its blocker,
the A1 probe (#192), is in the tree: `docs/pen-testing/assessments/A1.md`
and `apps/server/src/auth/password-routes.pen-test.test.ts`.

This is the remediation of finding **A1-4** (`severity:medium`, H5).

## What was fixed

The oracle had two halves: `POST /api/owner-passwords` compared any
candidate with every Owner password and said `409 password_in_use` for a
hit, and nothing limited or recorded the comparison.

- **The comparison is no longer reachable from a session alone** (A1-3,
  #215): the route checks a fresh proof of the Owner first, so the
  candidate is compared only for someone who has just proved they hold an
  Owner password (and the code, when TOTP is on). That moved a session's
  guessing to the proof's `currentPassword` itself.
- **The proof is now limited as sign-in is**
  (`apps/server/src/auth/owner-proof.ts`): each check starts an attempt on
  the **same** sign-in limiter, keyed on the client's address (A1-1's,
  which the client cannot choose): five free failures, then a doubling
  lockout from one minute to an hour, `429` with `Retry-After`. A right
  proof forgets the client's failures, as a sign-in does. One limiter
  serves both, so guesses here lock out `/api/login` from the same client,
  and the other way round.
- **Each check is recorded as a sign-in attempt is**
  (`apps/server/src/auth/attempts.ts`, `recordAttempt`): a row in
  `sign_in_events` (time, address, user agent, and the second factor when
  a code was checked), and for a failure `sign_in.failed` in the Activity
  Feed, with `sign_in.locked_out` when it starts a lockout. Never the
  guess. A right proof is a row in `sign_in_events` but not a
  `sign_in.succeeded` event: nobody signed in.

### Sibling paths

Every route that asks for the proof shares it, so all are limited and
recorded: making an API key with UI access, giving a key UI access or
enabling it again, and turning TOTP on (`POST /api/totp/setup`), as well
as adding an Owner password. Guesses at the TOTP code in a proof count
too. `POST /api/totp/disable`, which checks a code from a session, was
already limited (and A1-5 owns recording its refusals).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "a session
      cannot test guesses at the Owner's password without limit" is now an
      `it`. Its body is the one #215 left: ten misses through the proof,
      then the Owner's own password must not be confirmed. It is answered
      `429`.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** It is now "regression
      (A1-4): misses are no longer answered without limit, nor the Owner's
      own confirmed, and every guess is on record": five `422`s then five
      `429`s, the Owner's password `429`, no password added, five
      `sign_in.failed` and one `sign_in.locked_out` in the Activity Feed,
      five failed rows in `sign_in_events`, and no guess anywhere in the
      feed.
- [x] **Sibling paths with the same flaw are fixed and tested.** New
      `describe("A1-4 · every route that checks a fresh proof is limited
      and recorded")`: making a UI key, giving a key UI access and turning
      TOTP on each give five `422`s then `429` (the right password too
      while locked out), five `sign_in.failed` and five failed rows; five
      wrong proofs lock out `/api/login` from the same client; with TOTP
      on, wrong codes are limited and recorded with `secondFactor:
      "totp"`; a right proof is a `succeeded` row and no sign-in event.
- [x] **The assessment's findings table marks `A1-4` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #217) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below.

## Real output of the checks

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

Run at `6fdba40`, after all four fixes:

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  2 failed | 422 passed (424)
      Tests  2 failed | 4827 passed | 22 expected fail | 600 skipped (5451)
test exit 1
```

Both expect the first release heading of `CHANGELOG.md` to carry a date
(`expected '1.0.0' to match /^1.0.0 \(/`). They failed the same way in a
run before any of these changes, and neither `CHANGELOG.md` nor either
test is touched by them (`git diff 3c081be --stat -- CHANGELOG.md
apps/web/src/site-footer.tsx apps/web/src/site-footer.test.tsx
apps/web/src/legal` is empty). The 600 skipped are the Postgres-backed
tests (no Docker here). The 22 expected fails are the open findings'
`it.fails` (A1-5 to A1-9, S2's and the others'); none of A1-1 to A1-4's
remain.

### The probe tests, verbose

```
✓ password-routes.pen-test.test.ts > A1-4: 409 password_in_use as an oracle > a session cannot test guesses at the Owner's password without limit
✓ password-routes.pen-test.test.ts > A1-4: 409 password_in_use as an oracle > regression (A1-4): misses are no longer answered without limit, nor the Owner's own confirmed, and every guess is on record
✓ password-routes.pen-test.test.ts > A1-4 · every route that checks a fresh proof is limited and recorded > making an API key with UI access: five wrong passwords, then 429, each a failed sign-in attempt
✓ password-routes.pen-test.test.ts > A1-4 · every route that checks a fresh proof is limited and recorded > giving a key UI access: five wrong passwords, then 429, each a failed sign-in attempt
✓ password-routes.pen-test.test.ts > A1-4 · every route that checks a fresh proof is limited and recorded > turning TOTP on: five wrong passwords, then 429, each a failed sign-in attempt
✓ password-routes.pen-test.test.ts > A1-4 · every route that checks a fresh proof is limited and recorded > shares one limit with sign-ins: guesses here lock out sign-in from the same client
✓ password-routes.pen-test.test.ts > A1-4 · every route that checks a fresh proof is limited and recorded > with TOTP on, guesses at the code are limited and recorded too
✓ password-routes.pen-test.test.ts > A1-4 · every route that checks a fresh proof is limited and recorded > a right proof is recorded in sign_in_events, but is no sign-in for the Activity Feed
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **`409 password_in_use` stays, after the proof.** No two Owner
   passwords may be the same, because a password says who signed in, so
   the route must refuse a duplicate. Only someone who has just proved an
   Owner password (and the code) reaches it, and each request costs one
   proof, limited and recorded.
2. **One limiter for sign-ins and proofs**, not a second one: a client
   that guesses here is a client guessing the Owner's password, so it is
   locked out everywhere, as the finding asks ("no faster than the sign-in
   limiter allows").
3. **A right proof is not announced as a sign-in** in the Activity Feed,
   where "Signed in" would be wrong; it is in `sign_in_events` with the
   other checked attempts. A wrong one is announced as a failed sign-in,
   as FR-4 asks of repeated failures.

## Noticed, out of scope

- **A1-7:** the limiter, and so this fix, forgets its lockouts on a
  restart; `sign_in_events` keeps the record.
- **A1-5:** refused codes to turn TOTP off are limited but not yet in the
  Activity Feed.

## What could not be verified here

- **Postgres:** `sign_in_events` rows were checked in the in-memory store,
  which mirrors `databaseAuthStore`'s insert; there is no Postgres here.
