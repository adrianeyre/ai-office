# Issue #17: Playwright end-to-end harness in CI — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last commit of
the issue (`d4a47c6`), after `pnpm install --frozen-lockfile`.

## What was built

- **`e2e/`**, a workspace package (`@ai-office/e2e`) with
  `@playwright/test` 1.64. `pnpm e2e` at the root runs `pnpm build`, then
  `playwright test`.
- **Global setup** (`e2e/support/global-setup.ts`):
  - It fails early, saying what to run, when `apps/web/dist` is not built.
  - It starts Postgres 18 (`postgres:18-alpine`, the image the Vitest
    harness uses) with Testcontainers and migrates a template database.
    `E2E_POSTGRES_URL` (a superuser URL) uses a Postgres you already run
    instead.
  - Without Docker, the tests are skipped with the reason (exit 0). With
    `CI` set, that fails them instead, as the Postgres integration tests
    do.
- **Per-test fixture** (`e2e/support/office.ts`). Every test gets a fresh
  AI Office:
  - a database copied from the template;
  - the real server (`node apps/server/src/main.ts`, as the app image runs
    it) on a free port, with fresh secrets, serving the built web app;
  - Playwright's `baseURL` pointing at it.

  So each test starts from a first run, and tests run in parallel. The
  server gets only the environment it needs. When a test fails, its
  server log is attached alongside the trace (`trace:
  "retain-on-failure"`) and screenshot.
- **The first suite** (`e2e/tests/sign-in.spec.ts`, 5 tests):
  1. The first run: `/admin` goes to `/setup`; a weak password is refused
     in the form; the password is set; the browser lands on `/login`,
     signs in with the new password, and sees the Office; `/setup` is
     then a 404.
  2. A signed-out visitor goes to `/login`, and the API answers 401.
  3. A wrong password is refused and cleared, then the right one signs
     in. The session survives navigation and reload.
  4. Sign out: the browser lands on `/login`, and `/` goes back there.
  5. Sign out everywhere: a second browser context's session ends too
     (its reload goes to `/login`, and its API call gets 401).
- **CI** (`.github/workflows/ci.yml`): a second job, `End-to-end`, runs on
  `ubuntu-latest`.
  - Its first steps match the existing job: checkout, Node and pnpm from
    the pins, and the frozen install.
  - It then runs `playwright install --with-deps chromium` and `pnpm e2e`.
  - On failure, it uploads `e2e/test-results/` (traces, screenshots,
    server logs) and `e2e/playwright-report/` as the `playwright-traces`
    artifact for 14 days.
  - `actions/upload-artifact` is pinned to the commit of v7.0.2
    (`cf430e0…`, from `git ls-remote`), like the other actions.
- **Shared harness parts.** `postgresImage` and `checkDocker` moved to
  `@ai-office/db/testing/docker`, which does not import Vitest, so
  Playwright can use them. `@ai-office/db/testing` re-exports both,
  unchanged.
- **Workspace changes:**
  - `pnpm-workspace.yaml` gains `e2e`.
  - The Dockerfile copies `e2e/package.json`, so the frozen install still
    matches the lockfile.
  - `docker/deployment.test.ts` now lists workspace packages from
    `pnpm-workspace.yaml` instead of only `apps/` and `packages/`.
  - ESLint and `.gitignore` ignore `test-results/` and
    `playwright-report/`.
- **README:** an "End-to-end tests" section and the `pnpm e2e` row.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone (output below).
- [x] **Playwright specs typecheck and lint.**
      - `pnpm typecheck` runs `tsc` in `e2e` ("e2e typecheck: Done",
        below).
      - `pnpm lint` lints `e2e/**/*.ts` type-aware, through
        `e2e/tsconfig.json`.
      - **Negative check:** with `const unused: number = "not a number";`
        added to the spec, ESLint reports `no-unused-vars` and `tsc`
        reports TS2322 and TS6133 (output below). It was restored
        afterwards.
      - `actionlint` 1.7.12 (checksum verified) reports 0 errors in the
        workflow.

### Verified on the host

- [ ] **`pnpm e2e` passes locally with Docker.** Not verifiable here: there
      is no Docker, so the Testcontainers path of the global setup has not
      run.

      Everything after Postgres has been run here, though. `pnpm e2e` from
      the fresh clone passed 5 of 5 in real Chromium (headless shell
      156.0.8078.4). It used `E2E_POSTGRES_URL` with an embedded Postgres
      18.3 (`@embedded-postgres/linux-x64@18.3.0-beta.16`, as in #12 to
      #16), on 5 parallel workers (below). Chromium needed system libraries
      the sandbox lacks: NSS, ATK, X11 and others were extracted from
      Debian bookworm's own `.deb`s into `/tmp` and put on
      `LD_LIBRARY_PATH`. None of that is committed.
- [ ] **The CI job runs the suite green.** Not verifiable here: the
      sandbox cannot push or run GitHub Actions.

### Also checked here

- **The skip path:** with no Docker and no `E2E_POSTGRES_URL`, the run
  prints the reason, skips all 5 tests and exits 0.
- **The CI path without Docker:** with `CI=1` it fails in the global
  setup instead, exit 1.
- **The CI configuration:** with `CI=1` and Postgres, it runs on 2
  workers with the GitHub reporter, and all 5 pass.
- **Negative check (the suite tests the app):** with the web app's "Sign
  out everywhere" button changed to call `/api/logout`, the sign-out
  everywhere test fails (the other context stays signed in) and the other
  4 pass. It was restored and rebuilt afterwards.
- **The failure artifacts:** a failing run kept `trace.zip`, the
  screenshots, `error-context.md` and the `server.log` attachment under
  `e2e/test-results/` (seen while developing).

### Notes

- **Browsers.** Locally, `pnpm --filter @ai-office/e2e exec playwright
  install chromium` is needed once (README). CI installs Chromium with
  its system dependencies on each run.
- **Retries.** CI retries a failed test once. Each retry gets a fresh
  server and database, so a retry never sees a half-finished first run.

## Output

### Fresh clone (`/tmp/clone17`)

```text
d4a47c6 ci: run the end-to-end tests, uploading traces on failure
$ pnpm install --frozen-lockfile
Done in 481ms using pnpm v12.10.0
$ pnpm lint
lint exit=0
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit=0
e2e typecheck$ tsc
e2e typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
$ pnpm test
test exit=0
 Test Files  37 passed (37)
      Tests  445 passed | 25 skipped (470)
```

The 25 skipped tests are those of #16: 23 Postgres integration tests
without Docker, `docker compose config` without Compose, and the opt-in
compose end-to-end test.

```text
$ E2E_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm e2e   (embedded Postgres 18.3)
e2e exit=0
✓ built in 627ms
Running 5 tests using 5 workers
  ✓  1 [chromium] › tests/sign-in.spec.ts:54:3 › signing in and out › sends a signed-out visitor to the login page (2.8s)
  ✓  5 [chromium] › tests/sign-in.spec.ts:64:3 › signing in and out › refuses a wrong password, then signs in (2.8s)
  ✓  3 [chromium] › tests/sign-in.spec.ts:18:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.8s)
  ✓  4 [chromium] › tests/sign-in.spec.ts:95:3 › signing in and out › signs out everywhere, ending every other session (2.8s)
  ✓  2 [chromium] › tests/sign-in.spec.ts:85:3 › signing in and out › signs out (2.8s)
  5 passed (4.1s)
```

### Without Docker, and in CI mode

```text
=== no Docker, no E2E_POSTGRES_URL
$ playwright test
Docker is not available (Could not find a working container runtime strategy), so the end-to-end tests are skipped. They run in CI and on the host, or set E2E_POSTGRES_URL.
Running 5 tests using 5 workers
  -  1 [chromium] › tests/sign-in.spec.ts:64:3 › signing in and out › refuses a wrong password, then signs in
  -  2 [chromium] › tests/sign-in.spec.ts:85:3 › signing in and out › signs out
  -  3 [chromium] › tests/sign-in.spec.ts:18:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it
  -  5 [chromium] › tests/sign-in.spec.ts:95:3 › signing in and out › signs out everywhere, ending every other session
  -  4 [chromium] › tests/sign-in.spec.ts:54:3 › signing in and out › sends a signed-out visitor to the login page
  5 skipped
exit=0
=== CI set, no Docker
Error: Docker is not available (Could not find a working container runtime strategy). CI must run the end-to-end tests, so they fail here instead of skipping.
exit=1
=== CI set, with Postgres
Running 5 tests using 2 workers
  ✓  2 [chromium] › tests/sign-in.spec.ts:54:3 › signing in and out › sends a signed-out visitor to the login page (2.2s)
  ✓  1 [chromium] › tests/sign-in.spec.ts:18:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.2s)
  ✓  4 [chromium] › tests/sign-in.spec.ts:85:3 › signing in and out › signs out (1.2s)
  ✓  3 [chromium] › tests/sign-in.spec.ts:64:3 › signing in and out › refuses a wrong password, then signs in (1.3s)
  ✓  5 [chromium] › tests/sign-in.spec.ts:95:3 › signing in and out › signs out everywhere, ending every other session (1.5s)
::notice title=🎭 Playwright Run Summary::  5 passed (6.0s)
exit=0
```

### Negative checks

```text
$ # spec: `const unused: number = "not a number";` appended
  117:7  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars
✖ 1 problem (1 error, 0 warnings)
tests/sign-in.spec.ts(117,7): error TS2322: Type 'string' is not assignable to type 'number'.
tests/sign-in.spec.ts(117,7): error TS6133: 'unused' is declared but its value is never read.

$ # layout.tsx: "Sign out everywhere" calls /api/logout instead
  ✓  4 [chromium] › tests/sign-in.spec.ts:54:3 › signing in and out › sends a signed-out visitor to the login page (3.3s)
  ✓  2 [chromium] › tests/sign-in.spec.ts:18:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (3.3s)
  ✓  3 [chromium] › tests/sign-in.spec.ts:85:3 › signing in and out › signs out (3.3s)
  ✓  5 [chromium] › tests/sign-in.spec.ts:64:3 › signing in and out › refuses a wrong password, then signs in (3.3s)
  ✘  1 [chromium] › tests/sign-in.spec.ts:95:3 › signing in and out › signs out everywhere, ending every other session (6.8s)
    Error: expect(page).toHaveURL(expected) failed
    Expected pattern: /\/login$/
    Received string:  "http://127.0.0.1:38027/"
```

### actionlint

```text
$ /tmp/dl-actionlint/actionlint -verbose
verbose: Found 0 parse errors in 0 ms for .github/workflows/ci.yml
verbose: Found total 0 errors in 0 ms for .github/workflows/ci.yml
actionlint exit=0
```
