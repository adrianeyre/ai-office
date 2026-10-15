# Issue #219: [fix] A1-5 — Adding or removing an Owner password, turning TOTP on or off, and refused codes to turn it off never reach the Activity Feed — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `addc27e`,
`fix(security): A1-5 every change to how the Owner signs in is in the Activity Feed`,
on top of `4f20228`. Its blocker, the A1 probe (#192), is in the tree:
`docs/pen-testing/assessments/A1.md` and the probe tests it names,
`apps/server/src/auth/password-routes.pen-test.test.ts` and
`apps/server/src/auth/totp.pen-test.test.ts`. A1-3 and A1-4's fixes
(#215, #217), whose fresh proof this builds on, are in the tree too.

This is the remediation of finding **A1-5** (`severity:medium`, new).

## What was fixed

Each change to how the Owner signs in was written to the log and nowhere
the Owner looks. The `config.changed` event already had a `security`
scope nothing used.

- **`apps/server/src/auth/sign-in-changes.ts`** (`signInChanged`)
  publishes one `config.changed` in the `security` scope naming the change,
  never a password, a secret or a code: `ownerPasswords.added`,
  `ownerPasswords.removed`, `totp.enabled` and `totp.disabled`. The
  Activity Feed shows it as "Security settings changed: …", like every
  other `config.changed`.
- **`password-routes.ts`** publishes it once a further password is added
  or removed; **`totp-routes.ts`** once TOTP is turned on (the confirming
  code accepted) or off.
- **Refused codes to turn TOTP off** (`POST /api/totp/disable`) were
  already limited, but recorded nowhere. Each is now recorded as a sign-in
  attempt is (`recordAttempt`, A1-4's): a failed row in `sign_in_events`
  with its second factor, `sign_in.failed` in the Activity Feed ("A
  sign-in from … failed at the second factor"), and `sign_in.locked_out`
  when it starts a lockout. Never the code. A right code is a succeeded
  row, but no sign-in for the feed: the change itself is what is
  announced.

### Sibling paths

- **Setting the first password at setup** (`POST /api/setup`) is a change
  to how the Owner signs in too, and was not recorded: it is now
  `ownerPasswords.firstSet`.
- **Replacing a password** (A1-9, #223, later in this run) publishes
  `ownerPasswords.replaced` through the same helper, so the two fixes
  agree.
- **API keys that sign in** were already recorded
  (`gatewayKeys.created`, `.access`, `.enabled`, `.profile`, `.revoked` in
  the `gateway` scope), and the probe's "holds for Gateway Keys" still
  passes.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** The four
      "is recorded in the Activity Feed" (adding and removing an Owner
      password, turning TOTP on and off) in
      `password-routes.pen-test.test.ts`, and "are recorded in the Activity
      Feed" in `totp.pen-test.test.ts`, are now `it`s, unchanged, and pass.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** Each "pins today: leaves
      nothing in the Activity Feed" is now "regression (A1-5): no longer
      leaves nothing in the Activity Feed, and names the change, never the
      secret": the feed after the change is not empty, and is exactly one
      `config.changed` (`scope: "security"`, the change's key), so no
      password, secret or code, and the proof or code it took is no
      sign-in. TOTP's "pins today: leave nothing" is now "regression
      (A1-5): no longer leave nothing in the Activity Feed: each is a
      failed sign-in at the second factor, never the code": three
      `sign_in.failed` with `secondFactor: "totp"`.
- [x] **Sibling paths with the same flaw are fixed and tested.** "A1-5
      sibling: setting the first password at setup is recorded, without
      it" (`password-routes.pen-test.test.ts`); "A1-5 sibling: each is a
      failed attempt in sign_in_events, the lockout they start is in the
      Activity Feed, and a right code is recorded too"
      (`totp.pen-test.test.ts`): five wrong codes are five failed rows and
      five `sign_in.failed` then `sign_in.locked_out`, no code in the feed,
      and after the lockout the right code is a succeeded row and only
      `totp.disabled` in the feed. A1-9's regression test checks
      `ownerPasswords.replaced`.
- [x] **The assessment's findings table marks `A1-5` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #219) with the
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
✓ totp.pen-test.test.ts > A1-5: refused attempts to turn TOTP off > are recorded in the Activity Feed
✓ totp.pen-test.test.ts > A1-5: refused attempts to turn TOTP off > regression (A1-5): no longer leave nothing in the Activity Feed: each is a failed sign-in at the second factor, never the code
✓ totp.pen-test.test.ts > A1-5: refused attempts to turn TOTP off > A1-5 sibling: each is a failed attempt in sign_in_events, the lockout they start is in the Activity Feed, and a right code is recorded too
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > adding an Owner password > is recorded in the Activity Feed
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > adding an Owner password > regression (A1-5): no longer leaves nothing in the Activity Feed, and names the change, never the secret
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > removing an Owner password > is recorded in the Activity Feed
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > removing an Owner password > regression (A1-5): no longer leaves nothing in the Activity Feed, and names the change, never the secret
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > turning TOTP on > is recorded in the Activity Feed
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > turning TOTP on > regression (A1-5): no longer leaves nothing in the Activity Feed, and names the change, never the secret
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > turning TOTP off > is recorded in the Activity Feed
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > turning TOTP off > regression (A1-5): no longer leaves nothing in the Activity Feed, and names the change, never the secret
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > A1-5 sibling: setting the first password at setup is recorded, without it
✓ password-routes.pen-test.test.ts > A1-5: changes to the Owner's credentials in the Activity Feed (FR-52) > holds for Gateway Keys: making one is recorded, without the key
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **`config.changed` in the `security` scope**, not a new event type.
   FR-52 lists configuration changes among what the feed records, the
   scope was there unused for this, and the Activity Feed's Settings
   filter already shows it. The keys name the change; the value (a
   password, a secret) is never in it.
2. **A refused code to turn TOTP off is a failed sign-in attempt**, as a
   wrong fresh proof is since A1-4 (its decision 3): it is a guess at the
   Owner's second factor, limited by the same limiter, so it is recorded
   the same way and the feed groups it with the other guesses.
3. **A right code to turn TOTP off is recorded in `sign_in_events` but not
   announced as a sign-in**; `totp.disabled` is announced instead. Being
   in `sign_in_events` also lets the limiter's restore after a restart
   (A1-7) forget the client's failures, as the live limiter did.

## Noticed, out of scope

- **Renaming a further password** (its name, nickname or time zone) is
  not in the Activity Feed; renaming the first is, as the Owner's profile
  (`ownerProfile`, `office` scope). It changes no way to sign in.
- **The feed's text for these keys is the raw key** ("Security settings
  changed: totp.disabled."), as for every other `config.changed`.

## What could not be verified here

- **Postgres:** the events go through the same event bus whatever the
  store; `sign_in_events` rows were checked in the in-memory store, which
  mirrors `databaseAuthStore`'s insert. There is no Postgres here.
- **The Activity Feed page** itself was not looked at in a browser (no
  browser here); the events are of a type it already renders.
