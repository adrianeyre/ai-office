# Issue #223: [fix] A1-9 — The first Owner password can be neither changed nor removed, so a leaked one signs in for good — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `6122d84`,
`fix(security): A1-9 any Owner password, the first's too, can be replaced with proof of it`,
on top of `a3b5009` (A1-6's fix). Its blocker, the A1 probe (#192), is in
the tree: `docs/pen-testing/assessments/A1.md` and
`apps/server/src/auth/password-routes.pen-test.test.ts`. The fresh proof
it uses is A1-3's and A1-4's (#215, #217), in the tree.

This is the remediation of finding **A1-9** (`severity:medium`, new).

## What was fixed

`PUT /api/owner-passwords/first` set only the first password's name,
nickname and time zone, ignoring a `password` in its body; `DELETE` refused
it. Nothing else could change it.

- **`PUT /api/owner-passwords/:id`** (`first` for the first) now takes
  `password` beside the settings, with a fresh proof
  (`replaceOwnerPasswordRequestSchema` in `packages/shared/src/auth.ts`):
  - **The proof must be the password being replaced**
    (`currentPassword`), and a TOTP or recovery code when TOTP is on.
    Another Owner password is refused, `422 wrong_password`. A session
    begun with an API key cannot give one, `403 proof_required`. The check
    is A1-3's `proveOwner`, which now takes `{ of }` (null for the first,
    or a further password's id), so it is limited by the sign-in limiter
    and recorded in `sign_in_events` as every proof is (A1-4).
  - The new password must pass the same policy as any Owner password
    (`400`), and be unlike every Owner password, the one it replaces
    included (`409 password_in_use`).
  - **`AuthStore.replaceOwnerPassword`** replaces the hash and ends every
    session that password began, in one transaction in Postgres: for the
    first, the sessions neither a further password nor an API key began;
    for a further one, those with its `password_id`. If the request's own
    session was one of them, its cookie is cleared too.
  - It is in the Activity Feed as `config.changed`, `security`,
    `ownerPasswords.replaced` (A1-5's helper), never the password.
  - Without `password`, the route changes the settings as before, and
    needs no proof.
- **API Key Management** (`apps/web/src/owner-passwords.tsx`) has **Change
  password** on each password's card: the new password, then "Confirm it is
  you" (that password as it is now, and the code when TOTP is on). The
  first's card says "it cannot be removed, but it can be changed".

### Sibling paths

Further Owner passwords could already be removed (and added again), so they
did not share the flaw, but they are replaced the same way, through the
same route and check, so there is one way to change any password. The
first still cannot be removed (`409 first_password_not_removable`): there
is always one password set at setup.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "the Owner
      can replace the first password, so a leaked one stops signing in" is
      an `it`. Its request now carries the Owner's proof (its helper,
      "the only way the API offers", takes an optional proof), as the
      property is replacing it *with proof of the current one*; the
      assertion is unchanged: the old password is refused, `401`.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** It is now "regression
      (A1-9): the first password is no longer one that can be neither
      changed nor removed and keeps signing in": the same request without
      proof is no longer silently ignored (`403 proof_required`, hash
      unchanged); with proof the hash changes, both sessions the first
      password began are refused (`401`) and the cookie is cleared, the
      old password no longer signs in and the new one does, `DELETE` still
      answers `409`, and the feed has `ownerPasswords.replaced` without the
      password.
- [x] **Sibling paths with the same flaw are fixed and tested.** New
      `describe("A1-9 · the sibling paths: replacing any Owner password")`:
      a further password is replaced with proof of itself, ending only its
      own sessions; the proof must be the password replaced (Sam cannot
      replace the first with Sam's password, nor the Owner Sam's with the
      first; each a failed attempt); with TOTP on it needs the code, and a
      session begun with an API key cannot; the new password must differ
      from every Owner password, and a weak one is `400`; an unknown id is
      `404` with no proof checked; renaming still needs no proof. The web
      app: "changes the first password with proof of it, refusing a weak
      one first (A1-9)" (`owner-passwords.test.tsx`). Postgres:
      "replaces an Owner password, and ends only the sessions it began
      (A1-9)" (`store.test.ts`, skipped here, runs in CI).
- [x] **The assessment's findings table marks `A1-9` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #223) with the
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
✓ password-routes.pen-test.test.ts > A1-9: retiring the first Owner password > the Owner can replace the first password, so a leaked one stops signing in
✓ password-routes.pen-test.test.ts > A1-9: retiring the first Owner password > regression (A1-9): the first password is no longer one that can be neither changed nor removed and keeps signing in
✓ password-routes.pen-test.test.ts > A1-9 · the sibling paths: replacing any Owner password > a further password is replaced with proof of itself, ending only its own sessions
✓ password-routes.pen-test.test.ts > A1-9 · the sibling paths: replacing any Owner password > the proof must be the password being replaced, not another Owner password
✓ password-routes.pen-test.test.ts > A1-9 · the sibling paths: replacing any Owner password > with TOTP on, it needs the code too; a session begun with an API key cannot
✓ password-routes.pen-test.test.ts > A1-9 · the sibling paths: replacing any Owner password > the new password must be unlike every Owner password, the one it replaces included
✓ password-routes.pen-test.test.ts > A1-9 · the sibling paths: replacing any Owner password > a password that is not there is a 404, with no proof checked
✓ password-routes.pen-test.test.ts > A1-9 · the sibling paths: replacing any Owner password > renaming a password still needs no proof
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **The proof is the password being replaced**, not any Owner password.
   The finding asks for "proof of the current one", and the Owner's
   passwords are one per person: whoever holds Sam's password cannot
   change the first, nor the other way round. Someone who has lost a
   further password has it removed and added again.
2. **Replacing a password ends every session it began, this one too.**
   The point is to retire a leaked password, so a session its thief began
   with it must end, and a session cannot be told from the thief's by
   anything but its cookie. The Owner signs in again with the new one. The
   web app then shows the sign-in page, as when a password the session
   began with is removed.
3. **The same `PUT` route, with `password`**, rather than a new one: the
   probe found no way to change it through the route that names the
   password, and the settings and the password are one record.
4. **The first still cannot be removed**: replacing it retires a leaked
   one, and there is always the password set at setup.

## Noticed, out of scope

- FR-1 and FR-65 still speak of "the password" (one). That the Owner has
  several, and can now change each, is H17's documentation drift (the I
  series).

## What could not be verified here

- **Postgres:** `replaceOwnerPassword`'s transaction (the hash, then the
  sessions it began) was read, not run; its Postgres test runs in CI. The
  probes use the in-memory store, which mirrors it.
- **The web app** was tested in jsdom; it was not looked at in a browser
  (none here).
