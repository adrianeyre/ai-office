# Issue #287: [pen-test] I2 — The Gateway on the app's own port, and the sandbox directory (H21) — verification

Checks were run in the Sandcastle sandbox: Node 26.10.0, pnpm 12.10.0. There
was no Docker, no EC2, no second host account, no GitHub and no live model,
and no network beyond the registry and the model; the process is non-root.
The probe was assessed at commit `23d9f9d`, the `feat/pen-testing` head with
a clean worktree at the start. `pnpm lint`, `pnpm typecheck` and `pnpm test`
were run with the probe's tests and assessment committed.

This issue is a **probe**, not a fix. It answers H21 on both halves — the
AI Gateway served on the app's own port, and the sandbox work directory
under compose — produces an assessment and committed probe tests, and
changes no production code.

## Blockers

The issue names #197 (I1) as the sibling that owns the rest of
infrastructure and delivery, and notes that main's "one entry point" change
(#207–#209) and Agents under compose landed after I1 started. All of that
work exists in the tree:

- the one entry point: `apps/server/src/gateway-entry.ts` (`gatewayEntry`,
  `isGatewayPath`), wired into `buildApp` (`serverFactory`) and `startServer`;
- the real Gateway and its test support (`packages/gateway`,
  `buildGateway`, `staticKeys`, `staticAccounts`, `memoryRequestLog`);
- the `sandbox-dir` service, the app's bind mount and `AI_OFFICE_SANDBOX_DIR`
  in `docker-compose.yml`, and `DOCKER_GID`/`AI_OFFICE_DOMAIN` in
  `.env.example`;
- the Caddyfile and the Vite dev proxy;
- the cross-reference test (`test/pen-testing.test.ts`).

The siblings this probe cross-references (G1-8 the public secrets, A1-1/A1-6
the limiter and headers, S2 the sandbox mounts and the bind address, H19 the
loopback publish) are present in `docs/pen-testing/assessments/` and the
code. No blocker is missing.

## What was produced

- **Assessment** `docs/pen-testing/assessments/I2.md`. It records the commit
  it was assessed at, and has a verdict on every "What to probe" bullet:
  - path confusion between the Gateway and the app (HOLDS): `//v1`, `/V1`,
    `/v1/../api/…`, percent-encoding, and `/v1` with a session cookie all
    stay on the correct side; CORS preflight refused (HOLDS);
  - which app-wide controls no longer apply to `/v1`: security headers
    (FINDING I2-1), body limits (FINDING I2-2), the limiter (FINDING I2-3);
    logging and redaction (HOLD);
  - Gateway Key guessing without a limiter (FINDING I2-3);
  - whatever `AI_OFFICE_BIND_ADDRESS` opens opens the Gateway too (HOLDS,
    ADR 0001's stated consequence);
  - symlink and pre-creation of the sandbox directory by another local user
    (FINDING I2-4); the clones' permissions (FINDING I2-5); what the bind
    mount exposes (folded into I2-4/I2-5);
  - `.env.example` re-assessed with G1-8: the public secrets re-confirm
    G1-8 (not re-filed); `DOCKER_GID=0` and `AI_OFFICE_DOMAIN=localhost`
    (HOLD).

  Its **Findings** table (I2-1 to I2-5) gives, for each: a one-line
  statement, the attacker position, the hypothesis (H21), the claimed
  severity with the PRD's definitions, the probe tests, and what the fix
  must make true. It says what could not be exercised here and how the stack
  would exercise it.

- **Two probe test files**, beside the code they probe:
  - `apps/server/src/gateway-entry.pen-test.test.ts`: the real app and
    Gateway over a **real listening socket** (so the server factory's split
    runs; `inject` would skip it), with `node:http` sending raw paths. It
    holds the split, and finds I2-1 (no security headers on `/v1`), I2-2
    (the body read before refusal) and I2-3 (unlimited, unrecorded key
    guessing); redaction holds.
  - `docker/sandbox-dir.pen-test.test.ts`: the `sandbox-dir` service read
    from compose, and its own shell command run against a stand-in `/tmp` as
    a local user who got there first — I2-4 (pre-creation adopted, symlink
    followed) and I2-5 (the work directory created `0755`) — plus the
    `.env.example` defaults re-assessed with G1-8.

### The findings

| ID | Statement | Position | Severity |
|---|---|---|---|
| I2-1 | `/v1` is served before any app hook runs, so a hook-set security header never reaches it and `/v1` answers carry none | 1 | low |
| I2-2 | An unauthenticated `/v1` body is read in full (up to 32 MiB) before the Gateway Key is checked, while the app refuses 2 MiB with 413 | 1, 4 | low |
| I2-3 | Gateway Key guesses at `/v1` draw no rate limit and no Activity Feed record, unlike `/api/login/api-key`'s | 1, 4 | low |
| I2-4 | The root `sandbox-dir` step runs `mkdir -p`/`chown` on a `/tmp` path with no symlink-safe or ownership check, so a local user who got there first has the chown follow their symlink and controls the clone directory | local user on the host (outside 1–5) | low |
| I2-5 | The sandboxes' work directory is created `0755`, so any local user or bind mount reads every Floor's clone | local user on the host (outside 1–5) | low |

I2-4 and I2-5 are rated low on the engagement's single-Owner,
never-shared-host deployment and flagged to re-rate to high on any
multi-user host (`I2.md`, "Why these severities").

What holds, each kept holding by a plain `it`:

- the `/v1` split, under path confusion, a session cookie and a CORS
  preflight;
- a session cookie is never forwarded to an AI Provider;
- a presented Gateway Key (right or wrong) and a bearer token appear in no
  log line, the app's or the Gateway's;
- the same host path is bind-mounted read-write; `AI_OFFICE_DOMAIN=localhost`
  keeps the `tls` profile on localhost's own CA; `DOCKER_GID=0` is no wider
  than the Docker socket the app already holds.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      Each bullet is a section of `I2.md` with a HOLDS or FINDING verdict on
      every part, including what could not be exercised and the stack check
      for it.
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.** There are six `it.fails` (I2-1, I2-2, I2-3
      one each; I2-4 two — the compose-guard and the symlink-refusal; I2-5
      one), each beside a passing pin, and the table names the file and both
      tests. Each `it.fails` was flipped to `it` once, all together, to see
      it fails on its own property assertion and not a setup error:

      ```
      # apps/server/src/gateway-entry.pen-test.test.ts
      × I2-1 … AssertionError: expected undefined to be 'nosniff'
      × I2-2 … AssertionError: expected false to be true
      × I2-3 … AssertionError: expected [ 401, 401, … ] to include 429
      # docker/sandbox-dir.pen-test.test.ts
      × I2-4 (guard)   … AssertionError: expected false to be true
      × I2-4 (refusal) … AssertionError: promise resolved … instead of rejecting
      × I2-5 … AssertionError: expected 45 to be +0
      ```

      They were then put back as `it.fails`, and both files run green
      alongside the cross-reference test:

      ```
       Test Files  3 passed (3)
            Tests  37 passed | 6 expected fail (43)
      ```

      The cross-reference test (`repository` project) finds both files
      linked from `I2.md`.
- [x] **Nothing in production code changes.** `git diff 23d9f9d --stat`
      lists only the two probe tests and the assessment (the verification
      note follows in its own commit):

      ```
       apps/server/src/gateway-entry.pen-test.test.ts | 493 +++++++++++++++++++
       docker/sandbox-dir.pen-test.test.ts            | 248 ++++++++++
       docs/pen-testing/assessments/I2.md             | 361 +++++++++++++
      ```

- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` exits 1 with **pre-existing failures that
      the #207–#209 one-entry-point merge introduced into I1's and the
      pen-test-stack's pins**, plus load-induced timing flakes — none in
      this probe's diff. The probe's own files and the cross-reference test
      are green. See below.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
LINT EXIT 0
```

### `pnpm typecheck`: exit 0

```
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
TYPECHECK EXIT 0
```

### `pnpm test`: exit 1 — the probe is green; the suite carries pre-existing drift failures and timing flakes

The whole-repository run (`vitest run`, 456.18 s) finished:

```
 Test Files  9 failed | 457 passed (466)
      Tests  11 failed | 4995 passed | 94 expected fail | 603 skipped (5703)
```

The **94 expected fail** are the earlier probes' `it.fails` and this
probe's six, each passing by failing. The skips are the Postgres and Docker
tests. **None of the 11 failures is in a file this probe added.** Running
the probe's two files and the cross-reference test is green (the block
above).

**Six of the failures are reproducible and pre-existing**, in files this
probe did not touch. Running only those four files (and not the probe's)
reproduces exactly the six:

```
 FAIL |repository| test/documentation-drift.pen-test.test.ts > I1-9 … pins today: .env.example says the Gateway 'has no authentication of its own yet'
 FAIL |repository| test/documentation-drift.pen-test.test.ts > I1-9 … .env.example says a Gateway Key is required, as the code demands
 FAIL |deployment| docker/supply-chain.pen-test.test.ts > I1-4 … pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL |deployment| docker/supply-chain.pen-test.test.ts > bullet 1 … binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values
 Test Files  4 failed (4)
      Tests  6 failed | 30 passed | 5 expected fail | 1 skipped (42)
```

These pin a state the **one-entry-point change (#207–#209) invalidated**,
and which I1 was assessed before (I1's pinned commit `7b0bdb4` predates the
`origin/main` merge `cf83e42` that brought it onto this branch). They are
exactly the drift this I2 probe documents the new truth of: the Caddyfile
now proxies `/v1` too (so "never the Gateway" is false), and `.env.example`
now says "every Gateway request needs a Gateway Key" (so I1-9's `it.fails`
now passes — the drift it named is effectively remediated). They belong to
**I1's retest and the pen-test-stack issue**, not to #287, and a probe never
remediates production or a sibling's tests, so they are left as they are and
recorded here.

**The remaining failures are load-induced timing flakes.** Under the heavy
parallel run each timed out; each passes on its own with nothing competing:

```
# pnpm vitest run --project @ai-office/web src/scene/idle-behaviours.test.ts
 Test Files  1 passed (1)
      Tests  45 passed (45)
# pnpm vitest run --project @ai-office/orchestrator src/sandbox/runner.test.ts
 Test Files  1 passed (1)
      Tests  27 passed (27)
```

The exact set varies run to run (a second enumeration run had the six
drift failures plus three `idle-behaviours` cases and no `runner` case),
which is the signature of worker starvation under load, not a logic
regression. This probe adds no production, web, scene or orchestrator code.

No test was skipped, deleted or weakened to reach this state.

## What could not be exercised here

No Docker, no second host account, no EC2, non-root:

- **I2-4 end to end:** as a second non-root local user, pre-create or
  symlink `/tmp/ai-office-sandboxes`, then `docker compose up` and watch the
  root `sandbox-dir` container `chown` the attacker's target to `1000:1000`
  and the app clone Floors into the attacker's directory. Here the symlink
  follow and the pre-creation adoption were shown against a stand-in `/tmp`;
  the root `chown` following the symlink is read from the command (no
  `--no-dereference`).
- **I2-5 on the real host:** confirm the work directory's mode on a stock
  Linux host and that a second local user reads a Floor's clone beneath it.
- **I2-1, I2-2, I2-3 through Caddy:** confirm the same gaps behind the `tls`
  profile — Caddy forwards `/v1` to `app:3045`.
- **The bind address opening `/v1`:** set `AI_OFFICE_BIND_ADDRESS=0.0.0.0`
  and confirm `/v1` answers from another host with a Gateway Key, refuses
  without one.
