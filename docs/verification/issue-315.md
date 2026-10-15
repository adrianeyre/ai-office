# Issue #315: [fix] I1-8 — FR-1 and FR-2 describe a single password and name neither further Owner passwords nor API-key sign-in — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0,
git 2.39.5; no Docker and no Postgres). The fix is commit `3dcb32d`,
`fix(security): I1-8 FR-1 and FR-2 name every way the Owner signs in: any Owner password, or an API key with UI access`,
on top of `60f0423`. Its blocker, the I1 probe (#197), is in the tree:
`docs/pen-testing/assessments/I1.md` and
`test/documentation-drift.pen-test.test.ts`.

This is the remediation of finding **I1-8** (`severity:low`, H17). This
run also works I1-9 (#317), I1-10 (#319) and I1-11 (#321), each its own
commit and note; the full output of the checks, run once on the finished
tree, is [below](#real-output-of-the-checks).

## What was fixed

FR-1 and FR-2 spoke of "the password" alone. The code has two more ways
in: further Owner passwords (`POST /api/owner-passwords`, added
2026-10-10), and sign-in with an API key that has UI access
(`POST /api/login/api-key`), which asks for no second factor. An Owner
hardening a deployment from the requirements under-counted the ways in.

In `docs/product-requirements-document/ai-office.md` (the issue asks for
this change to the canon):

- **FR-1:** setup sets the *first* Owner password, with no default.
  Once signed in, the Owner can add further Owner passwords, one per
  person who shares the Owner's access, each different from every
  other, and remove any but the first. Every one is an Argon2id hash.
- **FR-2:** a session begins with any of the Owner's passwords (then a
  TOTP code when FR-3's second factor is on), or with an API key that
  has UI access. That is a key the Owner made for their own tools in API
  Key Management (FR-46), and it asks for no second factor. FR-2's
  routes that need no session now include GitHub's webhook deliveries,
  which are signed with the webhook secret instead.

The wording follows the glossary's **Owner**: "any of the Owner's
passwords or … an API key that has UI access; however many there are,
they all belong to the one Owner".

### Sibling paths

The same flaw ("one password") sat in every other place an Owner reads
the access surface from. All were fixed:

- **PRD §1 Summary:** "The whole application sits behind a single
  password" now reads "… behind the Owner's sign-in: any of the Owner's
  passwords, or an API key with UI access."
- **PRD §4 Non-goals:** "There is one Owner and one password" now reads
  "There is one Owner, to whom every Owner password and API key belongs
  however many there are".
- **PRD FR-3:** TOTP applies to every Owner password, and signing in
  with an API key does not ask for it.
- **PRD FR-65:** "Password, TOTP and sessions" now reads "Owner
  passwords, TOTP and sessions".
- **PRD §7 Security:** "Single-password access" now reads "Access for
  the Owner alone: the Owner's passwords and API keys with UI access".
- **PRD §12 Decisions log:** the dated "One Owner and one password"
  entry is kept, with a note that further Owner passwords and API-key
  sign-in were added on 2026-10-10.
- **`docs/processes/deploying-to-ec2.md` §3 Restrict access:** "AI
  Office has one password" now names any Owner password and an API key
  with UI access, which asks for no TOTP. The TOTP step no longer says
  "Signing in then takes the password and a code" as if that were every
  sign-in; it says an API key with UI access still signs in without a
  code.
- **`docs/guide/running.md` Signing in:** named only `POST /api/login`.
  It now says that route takes any Owner password, and names
  `POST /api/login/api-key`, which asks for no second factor.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "FR-1
      and FR-2 describe every way the Owner signs in: several
      passwords, and an API key" is an `it`. Its assertion is
      unchanged.
- [x] **The "pins today" test becomes a regression test; it is not
      deleted.** "regression (I1-8): FR-1 and FR-2 no longer speak of a
      single password alone; they name further Owner passwords and
      API-key sign-in". FR-1 no longer says "set the password", and it
      names the first and further Owner passwords. FR-2 names any of the
      Owner's passwords, an API key that has UI access, and that the key
      asks for no second factor. The test beside it, "confirms the code
      has several Owner passwords and API-key sign-in", is unchanged.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "the PRD's summary, non-goals and security requirements name the
        Owner's passwords and API keys, never a single password" (FR-3
        included);
      - "the EC2 process names every way in, and that an API key skips
        TOTP";
      - "the running guide's sign-in names every Owner password and
        API-key sign-in".

      Mutation check: with the old documents put back (`git stash` of
      `docs/`), the five I1-8 tests fail (the regression test, the
      former `it.fails` and the three siblings). With the new ones, they
      pass.
- [x] **The assessment's findings table marks `I1-8` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #315),
      with the commit's subject (the hash is filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on tests that failed before
      this work, for reasons this work does not touch (see
      [Noticed, out of scope](#noticed-out-of-scope)). Every other test
      passes, and the two I1-9 tests that failed before now pass
      ([#317](issue-317.md)).

### The probe tests, verbose (I1-8)

```
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-8 (H17): FR-1/FR-2 describe one password; the code has more ways in > regression (I1-8): FR-1 and FR-2 no longer speak of a single password alone; they name further Owner passwords and API-key sign-in
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-8 (H17): FR-1/FR-2 describe one password; the code has more ways in > confirms the code has several Owner passwords and API-key sign-in the documents do not
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-8 (H17): FR-1/FR-2 describe one password; the code has more ways in > FR-1 and FR-2 describe every way the Owner signs in: several passwords, and an API key
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-8 siblings: nothing else the Owner hardens from speaks of one password > the PRD's summary, non-goals and security requirements name the Owner's passwords and API keys, never a single password
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-8 siblings: nothing else the Owner hardens from speaks of one password > the EC2 process names every way in, and that an API key skips TOTP
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-8 siblings: nothing else the Owner hardens from speaks of one password > the running guide's sign-in names every Owner password and API-key sign-in
```

The whole file passes: `Tests  14 passed (14)`.

## Decisions

These are for the Owner to review.

1. **The canon is changed.** `ai-office.md` is changed only when an
   issue asks. This one asks for FR-1 and FR-2. The same document's
   summary, non-goal, FR-3, FR-65 and §7 say the same wrong thing, so
   they were fixed as siblings. Leaving them would have kept the drift
   the finding is about.
2. **The decisions log is annotated, not rewritten.** §12 records what
   was settled on 2026-10-08. Its "One Owner and one password" entry
   stays, followed by a dated note on what was added since (the date of
   the commits that added further Owner passwords and API-key sign-in,
   `60573d7` and `9bc9c03`). This follows the log's own "added …"
   entries.
3. **FR-2 states that an API key asks for no second factor.** It is what
   the code does (`apps/server/src/auth/routes.ts`: "The key is a long
   random secret, so no second factor is asked for"), and an Owner
   hardening a deployment needs to know it. The requirements now
   describe the code; they do not endorse it. A1-3 (open) owns whether
   such a key may be made without fresh proof of the Owner.
4. **FR-2 also names GitHub's webhook deliveries** among the routes that
   need no session. That route is public by design and listed in
   `route-access.test.ts`, and FR-2 is a list of exactly those
   exceptions. The built web app's files, `robots.txt` and
   `sitemap.xml` are also public, but they are static and are no way
   in, so they are not listed.

## Noticed, out of scope

- **Three tests fail before and after this work.** All of them come from
  changes merged from `main` after the probes were written, as
  [#307's note](issue-307.md#noticed-out-of-scope) records:
  - the published-ports test in `supply-chain.pen-test.test.ts`, because
    the Gateway's 3047 is no longer published;
  - one test in `caddyfile.pen-test.test.ts`, because Caddy proxies
    `/v1` now;
  - one test in `pen-test/compose.test.ts`.

  The two I1-9 tests that #307's note listed with them now pass.
- **`whiteboard.test.tsx` timed out once.** The test "opens on the Batch
  a Notice names; …" hit its 5-second limit in the first full run here
  (320 s, against 190 s for the previous run's). It passed 3 times out
  of 3 run alone, and in the second full run (below). Nothing this work
  changed reaches the whiteboard.
- **Open A1 findings will change these words again.** FR-1 now says the
  first Owner password cannot be removed (A1-9 is open: a leaked first
  password signs in for good). FR-2 says a session can add credentials
  with no fresh proof (A1-3). A fix to either should update FR-1/FR-2
  with it.
- **`docs/guide/running.md`, "Never a credential."** The configuration
  export section says "the password". Every Owner password is equally
  excluded, so the meaning holds, but the wording is singular.

## What could not be verified here

Nothing in this fix runs. It is documentation, checked by tests that
read it. Whether the documents read clearly to an Owner hardening a
deployment is for the Owner to judge.

## Real output of the checks

These were run once, on the finished tree with all four fixes
(`8558a06`). The test output is cut to its failures and summary.

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

```
$ pnpm typecheck
$ tsc && pnpm --recursive typecheck
packages/db typecheck$ tsc
packages/github typecheck$ tsc
packages/shared typecheck$ tsc
packages/db typecheck: Done
packages/shared typecheck: Done
packages/events typecheck$ tsc
packages/github typecheck: Done
packages/events typecheck: Done
apps/web typecheck$ tsc
packages/communications typecheck$ tsc
packages/orchestrator typecheck$ tsc
packages/gateway typecheck$ tsc
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

The first full run:

```
$ pnpm test
$ vitest run
…
 FAIL  |@ai-office/web| src/whiteboard.test.tsx > the whiteboard > opens on the Batch a Notice names; the Owner moves, drops and annotates its issues, saves them to be replanned, then approves
Error: Test timed out in 5000ms.
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
…
 Test Files  4 failed | 466 passed (470)
      Tests  4 failed | 5229 passed | 83 expected fail | 603 skipped (5919)
   Duration  320.62s (tests 66%, import 20%, transform 7%, environment 5%, setup 3%)
exit 1
```

```
$ pnpm exec vitest run apps/web/src/whiteboard.test.tsx   # three times
      Tests  6 passed (6)
      Tests  6 passed (6)
      Tests  6 passed (6)
```

The second full run, on the same tree:

```
$ pnpm test
$ vitest run
…
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
…
 Test Files  3 failed | 467 passed (470)
      Tests  3 failed | 5230 passed | 83 expected fail | 603 skipped (5919)
   Duration  203.59s (tests 65%, import 21%, transform 6%, environment 5%, setup 3%)
exit 1
```

Before this work (#307's note, at `5e0b3f3`), the run had
`Tests  5 failed | 5179 passed | 86 expected fail`. The two I1-9 tests
were among those five; the other three are the ones above. The three
fewer expected fails are I1-8, I1-10 and I1-11's `it.fails`, which are
`it`s now. I1-9's `it.fails` already passed, so it counted as a failure.
