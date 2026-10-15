# Issue #192: [pen-test] A1 — Sign-in and sessions — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no browser, no network beyond the registry and the
model). The probe was assessed at commit `18e9c71` (the branch head; the
worktree was clean). `pnpm lint`, `pnpm typecheck` and `pnpm test` were run
at `61ee9b9`, with the probe's tests and assessment committed.

This issue is a **probe**, not a fix: it answers H3 (the client address and
the limiter), H4, H5, H6 and H7, produces an assessment and committed probe
tests, and changes no production code.

## What was produced

- **Assessment** `docs/pen-testing/assessments/A1.md`: a verdict on every
  "What to probe" bullet (including the #204 routes and the version check),
  the commit it was assessed at, the table of every route that answers
  without a session and why, and a Findings table (A1-1 to A1-9) with each
  finding's one-line statement, attacker position, hypothesis, claimed
  severity against the PRD's definitions, the probe tests that show it, and
  what the fix must make true.
- **Eight probe test files**, beside the code they probe, driving the real
  Fastify app through `inject` (and a real socket for the live streams):
  - `apps/server/src/auth/login-limiter.pen-test.test.ts`
  - `apps/server/src/auth/setup.pen-test.test.ts`
  - `apps/server/src/auth/password-routes.pen-test.test.ts`
  - `apps/server/src/auth/sessions.pen-test.test.ts`
  - `apps/server/src/auth/totp.pen-test.test.ts`
  - `apps/server/src/auth/route-access.pen-test.test.ts`
  - `apps/server/src/app.pen-test.test.ts`
  - `docker/caddy/caddyfile.pen-test.test.ts`
- **One test-only helper**, `apps/server/src/pen-test-support.ts`: the real
  app on a clock the probe moves, with its Activity Feed and log readable.

### The findings

| ID | Statement | Severity |
|---|---|---|
| A1-1 | The sign-in limiter keys on an `X-Forwarded-For` any caller that bypasses Caddy chooses, so a sandbox can guess passwords, TOTP codes and keys without limit (H3) | high |
| A1-2 | Setup makes whoever reaches it first the Owner, with nothing binding it to the host or a one-time token, and a DNS-rebinding page can reach it (H4) | high |
| A1-3 | A session adds credentials that outlive sign-out-everywhere with no fresh proof of the Owner: an Owner password, a Gateway Key with UI access that skips TOTP, or TOTP with the attacker's own secret (H5, widened) | high |
| A1-4 | `POST /api/owner-passwords` confirms a guess at any Owner password with `409 password_in_use`, unthrottled and unrecorded (H5) | medium |
| A1-5 | Adding or removing an Owner password, turning TOTP on or off, and refused codes to turn it off never reach the Activity Feed (new) | medium |
| A1-6 | Neither the app nor Caddy sends CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy` or HSTS (H6) | medium |
| A1-9 | The first Owner password can be neither changed nor removed, so a leaked one signs in for good (new) | medium |
| A1-7 | A restart forgets every sign-in lockout (H7) | low |
| A1-8 | A session never idles out: a stolen cookie works for its full 7 days unused (H7) | low |

What holds, each kept holding by a plain `it`: Argon2id with OWASP's
parameters; the limiter with a real address (concurrency, TOTP withdrawal,
IPv6 /64, `TRUST_PROXY` unset); sign-in failures and lockouts in the
Activity Feed without the secret; the session cookie's flags and 256-bit
token; the fixed 7-day life; fixation; sign-out-everywhere ending password
and Gateway Key sessions and closing their live streams; CSRF on every
state-changing route (enumerated from the app) and on the attachment
upload; TOTP enrolment, replay and recovery codes; turning TOTP off; and
every route, stream and (absent) WebSocket that answers without a session.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      `A1.md` has a section per bullet — setup, login, repeated failures,
      `POST /api/owner-passwords`, TOTP, sessions, restart, security
      headers, prove the negative — and the #204 additions (the Manager
      chat's attachments and file mentions, CSRF on the upload, the version
      check, recorded as not public).
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.** 18 `it.fails` across the nine findings
      (A1-1 ×2, A1-2 ×2, A1-3 ×3, A1-4 ×1, A1-5 ×5, A1-6 ×2, A1-7 ×1,
      A1-8 ×1, A1-9 ×1), each beside a passing pin; the table names the
      file and test. Each `it.fails` was also flipped to `it` once, by
      hand, to see that it fails on its own assertion (an `AssertionError`
      about the property) and not on an incidental error; it was then put
      back.
- [x] **Nothing in production code changes.** `git diff 18e9c71 --stat`
      lists only the eight `*.pen-test.test.ts` files, the test-only
      `apps/server/src/pen-test-support.ts` and `A1.md` (this note added
      after).
- [x] **`pnpm lint`, `pnpm typecheck` pass; `pnpm test`** — see below:
      every probe test passes, and the two failures are pre-existing and
      outside the probe's diff.

## Real output of the checks

### `pnpm lint` — exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck` — exit 0

```
$ tsc && pnpm --recursive typecheck
…
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

### `pnpm test` — the probe's tests pass; the suite carries two pre-existing failures

The whole-repo run (`vitest run`, 131.11 s) finished:

```
 Test Files  2 failed | 409 passed (411)
      Tests  2 failed | 4612 passed | 18 expected fail | 597 skipped (5229)
```

The **18 expected fail** are this probe's `it.fails` (they pass by failing,
as the findings workflow intends; S1's became plain `it`s with #201 and
#203). The skips are the Postgres and Docker tests, skipped with their
reason in this sandbox. **Neither failure is in a file this probe added or
in a project it touches.** The two projects its files live in are green
on their own:

```
# pnpm exec vitest run --project @ai-office/server --project deployment
 Test Files  62 passed (62)
      Tests  528 passed | 18 expected fail | 174 skipped (720)
```

The two failures are both in `@ai-office/web` and both read the root
`CHANGELOG.md`, which opens `## 1.0.0` with no release date, while the
tests expect `1.0.0 (YYYY-MM-DD)`. The changelog came from main (`3ca0165
docs: Changelog`); this probe changes neither it nor `apps/web`, and the
two files fail the same way run alone:

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/

# cd apps/web && pnpm exec vitest run src/site-footer.test.tsx src/legal/legal.test.tsx
 Test Files  2 failed (2)
      Tests  2 failed | 14 passed (16)
```

No test was skipped, deleted or weakened to reach this state.

## What could not be exercised here

- **Caddy itself** needs Docker: the Caddyfile is pinned as text, and
  Caddy's handling of a client's `X-Forwarded-For` (ignored unless the
  client is in `trusted_proxies`) and `Host` (passed through) is from its
  documentation. The live checks are in the assessment.
- **A sandbox reaching `app:3045`** is #193; the probe stands for it with a
  peer address on the sandboxes' subnet.
- **DNS rebinding end to end** needs a browser and a DNS server; the probe
  shows the server accepts the request such a page sends.
- **Postgres-backed auth** (`databaseAuthStore`) was read, not run; the
  probes use the in-memory store.
- **The Manager chat's and direct chats' streams** closing on
  sign-out-everywhere need a Floor; they share the heartbeat check of the
  four streams that were probed.
