# Issue #215: [fix] A1-3 — A session adds credentials that outlive sign-out-everywhere with no fresh proof of the Owner — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no browser, no network beyond the registry and the
model). The fix is commit `b482e7f`,
`fix(security): A1-3 adding a way to sign in needs a fresh proof of the Owner`,
on top of `8b6bf5f` (A1-2's fix, #213). Its blocker, the A1 probe (#192),
is in the tree: `docs/pen-testing/assessments/A1.md` and
`apps/server/src/auth/password-routes.pen-test.test.ts`.

This is the remediation of finding **A1-3** (`severity:high`, H5
widened). A1-4 (#217), the `409 password_in_use` oracle, is the next
commit; see "A1-4's tests" below for how this one leaves them.

## What was fixed

A stolen session cookie, or a session begun with a UI-capable API key
(which never asks for TOTP), could add a credential that outlives
sign-out-everywhere: another Owner password, an API key that signs in
with no TOTP code, or TOTP itself with the attacker's secret and recovery
codes. Each now needs a **fresh proof of the Owner**
(`apps/server/src/auth/owner-proof.ts`, `createOwnerProof`):

- **What the proof is:** `currentPassword`, one of the Owner's passwords,
  and, when TOTP is on, `code`, a current TOTP code or an unused recovery
  code (used up, exactly as at sign-in, through `useSecondFactor`).
- **Who cannot give it:** a session begun with an API key, even one that
  sends the right password: `403 proof_required`, "sign in with a password
  first". It never asked for a second factor, so it cannot vouch for one.
- **Answers:** `403 proof_required` when it is missing (saying whether a
  code is needed too), `422 wrong_password` or `422 wrong_code` when it is
  wrong (`422`, not `401`: the session is fine, as `POST
  /api/totp/disable` already answers).
- **Where it is asked for:**
  - `POST /api/owner-passwords`, always, before the new password is
    compared with the others (`password-routes.ts`);
  - `POST /api/gateway-keys` with `access: "proxy_and_ui"`
    (`gateway-keys/routes.ts`); a proxy-only key, which cannot sign in,
    needs none;
  - `PATCH /api/gateway-keys/:id` when the change lets the key sign in
    where it could not: UI access given to an enabled key, or a UI key
    enabled again. Disabling, narrowing to proxy-only and renaming need
    none. The proof fields are taken off before the change reaches the
    key store;
  - `POST /api/totp/setup` (`totp-routes.ts`), with `{currentPassword}`:
    TOTP is off at that point. `enable` then only finishes what a proven
    setup started (its secret was shown to the prover alone).
- **Sign-out-everywhere tells the Owner what still signs in.** `POST
  /api/logout/everywhere` now answers `200` with `{"sessionsEnded",
  "stillSignIn": {"passwords": [{id, name}], "apiKeys": [{id, name}]}}`:
  every Owner password (the first named "The first password, set at
  setup"), and every Owner tool's key with UI access that is enabled and
  not revoked. Names only, never a credential; `Cache-Control: no-store`.
  The web app keeps it in `sessionStorage` for the login page, which
  shows it once.
- **Schemas** (`packages/shared`): `ownerProofShape`/`ownerProofSchema`,
  added to `addOwnerPasswordRequestSchema`,
  `createGatewayKeyRequestSchema`, `gatewayKeyUpdateRequestSchema` (whose
  "change something" rule now ignores the proof fields) and the new
  `totpSetupRequestSchema`; `signedOutEverywhereSchema`;
  `apiErrorCodes.proofRequired`.
- **Refactor:** `matchingPassword`, `clientOf` and `recordAttempt` moved
  from `auth/routes.ts` to `auth/attempts.ts`, unchanged, so the proof
  checks a password as sign-in does.

### The web app

Each form asks for the proof in a fieldset, "Confirm it is you"
(`apps/web/src/owner-proof.tsx`): **Your current password**, and **Code
from your authenticator app** when TOTP is on. Empty fields are caught
before sending; `wrong_password`, `wrong_code`, `proof_required` and
`too_many_attempts` are shown by the fields. In a session begun with an
API key the fields are replaced by a note ("You signed in with an API
key, so you cannot do this here…") and the action is disabled.

- **Add an Owner password** always asks for it.
- **Make a Gateway Key** asks for it only for **AI proxy and UI**.
- **API Key Management** asks for it when a key's settings would give an
  enabled key UI access, and **Enable** on a disabled UI key opens a
  confirm step with it ("Yes, enable …").
- **Turn on TOTP** first asks for the current password ("Continue"), then
  shows the QR code as before.
- **Sign out everywhere** keeps the answer's names (only names) in
  `sessionStorage` (`apps/web/src/still-sign-in.ts`); the login page shows
  them once in a status notice: "You are signed out everywhere. Signing
  out removes no password and no API key. These still sign in: …", then
  forgets them.
- `totpQuery` moved from `totp-settings.tsx` to `session.ts`, unchanged.

The web project's tests cover each of these
(`owner-passwords.test.tsx`, `gateway-keys-card.test.tsx`,
`api-keys-page.test.tsx`, `totp-settings.test.tsx`,
`login-page.test.tsx`). The end-to-end specs (`api-keys.spec.ts`,
`accessibility.spec.ts`, `sign-in.spec.ts`) fill the new field and check
the notice; they typecheck, and were not run here.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** The three
      `it.fails` in `password-routes.pen-test.test.ts` (adding an Owner
      password, making a key that can sign in with TOTP on, turning TOTP
      on) are now `it`, with their bodies unchanged, and pass.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** Each pin is now a
      `regression (A1-3): …`:
      - a stolen session's password is refused without a proof (`403`)
        and with a guessed one (`422`); no password is added;
        sign-out-everywhere answers that only the first password still
        signs in; the attacker cannot sign in;
      - with TOTP on, a stolen session's UI key is refused with no proof,
        with the password alone and with a wrong code; a proxy-only key is
        still made; sign-out-everywhere names no UI key. The Owner, with
        password and code, makes one, and sign-out-everywhere then names
        it. A session begun with that key cannot add a password or another
        UI key even with the right password (`403 proof_required`);
      - a stolen session cannot set up TOTP with no proof or a wrong
        password, no secret is pending, and the Owner's password alone
        still signs in.
- [x] **Sibling paths with the same flaw are fixed and tested.** New
      `describe("A1-3 · the sibling paths: …")`: giving a proxy-only key
      UI access needs the proof; enabling a disabled UI key needs it, and
      disabling, narrowing and renaming do not; the proof reaches no log
      line, event or response; the Owner adds a password with the
      password and, TOTP on, the code. The sign-out-everywhere answer is
      asserted in `sessions.test.ts` too.
- [x] **The assessment's findings table marks `A1-3` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #215) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below.

### Existing tests that changed with the contract

The proof is now part of the requests these tests make as the Owner, so
they send `currentPassword` (the test password): `totp.test.ts` (five
setups), `password-routes.test.ts` (five adds), `gateway-keys/routes.test.ts`
(the UI key), `sessions.pen-test.test.ts` and `totp.pen-test.test.ts` (the
UI keys and setups they make), and the probe's own helper `enableTotp`
(`pen-test-support.ts`). Sign-out-everywhere's `204` became `200` in
`sessions.test.ts` and `sessions.pen-test.test.ts`. The A1-5 pins and
`it.fails` in `password-routes.pen-test.test.ts` take the Owner's proof in
their set-up steps; their assertions are unchanged, and A1-5's `it.fails`
still fail (A1-5 is not fixed). No assertion was weakened.

### A1-4's tests

A1-4's probe guessed through the `409` of `POST /api/owner-passwords`.
With the proof checked first, a session without the Owner's password can
no longer reach that comparison, so its guessing channel became the proof
itself (`422` for a miss, a password added for a hit). This commit moves
A1-4's `guess` helper to that channel and keeps A1-4's `it.fails` and pin
honest about it: at this commit the proof is checked without limit and
recorded nowhere, so the `it.fails` still fails and the pin pins ten
`422`s and a hit, with nothing on record. #217 limits and records it.

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
✓ password-routes.pen-test.test.ts > A1-3: a session adds credentials that outlive it, with no fresh proof of the Owner > adding an Owner password needs the current password, not just a session
✓ password-routes.pen-test.test.ts > A1-3: a session adds credentials that outlive it, with no fresh proof of the Owner > regression (A1-3): a stolen session no longer adds a password that signs in again after sign-out-everywhere
✓ password-routes.pen-test.test.ts > A1-3: a session adds credentials that outlive it, with no fresh proof of the Owner > making an API key that can sign in needs a fresh proof of the Owner, and the TOTP code when on
✓ password-routes.pen-test.test.ts > A1-3: a session adds credentials that outlive it, with no fresh proof of the Owner > regression (A1-3): with TOTP on, a stolen session no longer mints a UI key that signs in again with no code, after sign-out-everywhere
✓ password-routes.pen-test.test.ts > A1-3: a session adds credentials that outlive it, with no fresh proof of the Owner > turning TOTP on needs the current password, so a stolen session cannot lock the Owner out with its own secret
✓ password-routes.pen-test.test.ts > A1-3: a session adds credentials that outlive it, with no fresh proof of the Owner > regression (A1-3): a stolen session no longer turns TOTP on with the attacker's secret, and the Owner's password alone still signs in
✓ password-routes.pen-test.test.ts > A1-3 · the sibling paths: widening a key, and the Owner's own steps > giving a proxy-only key UI access needs the proof
✓ password-routes.pen-test.test.ts > A1-3 · the sibling paths: widening a key, and the Owner's own steps > enabling a disabled UI key again needs the proof; disabling it, or narrowing it, does not
✓ password-routes.pen-test.test.ts > A1-3 · the sibling paths: widening a key, and the Owner's own steps > the proof never reaches the key it guards, a log line or the Activity Feed
✓ password-routes.pen-test.test.ts > A1-3 · the sibling paths: widening a key, and the Owner's own steps > the Owner adds a password with the current one, and with the code when TOTP is on
✓ password-routes.pen-test.test.ts > A1-3 where it holds > turning TOTP off needs a current code, so a stolen session cannot
✓ password-routes.pen-test.test.ts > A1-3 where it holds > a proxy-only Gateway Key, as every Agent's (what a sandbox holds) is, cannot sign in
✓ password-routes.pen-test.test.ts > A1-3 where it holds > revoking a UI key ends the sessions it began, at once
✓ password-routes.pen-test.test.ts > A1-3 where it holds > removing an Owner password ends the sessions it began
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **Any of the Owner's passwords is a proof**, not only the one the
   session began with: they all belong to the one Owner (GLOSSARY), and
   the first password's holder must be able to act on a session another
   password began.
2. **A recovery code counts as the second factor**, as at sign-in, and is
   used up.
3. **A session begun with an API key can never give a proof**, even with
   the right password: the finding says it cannot, and whoever holds the
   password can sign in with it.
4. **Turning TOTP on asks for the password at `setup`**, not again at
   `enable`: the secret `setup` returns is shown only to the prover, and
   `enable` needs a code from it.
5. **Re-enabling a disabled UI key needs the proof**, because a disabled
   key does not sign in and an enabled one does. Narrowing, disabling,
   renaming and revoking take credentials away and need none.
6. **Sign-out-everywhere answers `200` with a body**, not `204`, and lists
   by name only. It does not remove anything itself: the Owner decides
   what to remove.

## Noticed, out of scope

- **A1-5:** none of these changes (a password added or removed, TOTP on or
  off) reaches the Activity Feed yet.
- **A1-9:** the first password still cannot be replaced, so a leaked first
  password keeps signing in after sign-out-everywhere; the answer names it
  so the Owner at least knows.
- **Agents' keys** are proxy-only and cannot be given UI access (`409
  agent_key_no_ui`), so rotating one needs no proof.

## What could not be verified here

- **The end-to-end tests** (`e2e/tests/api-keys.spec.ts`,
  `accessibility.spec.ts`, `sign-in.spec.ts`), updated for the new fields
  and the sign-out-everywhere notice, need Postgres and a browser. They
  typecheck; they were not run.
- **Postgres-backed stores** were read, not run: the proof reads the
  same `AuthStore` methods sign-in does.
