# Issue #6: `packages/db`: Drizzle, migrations and a Testcontainers Postgres harness — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the commit that
implemented the issue (`410f517`; the run used the same tree under its earlier hash `371fd0f`, before a trailer was added to the commit message), after `pnpm install --frozen-lockfile`.

## What was built

- **Connection:** `connect(databaseUrl)` in `packages/db/src/client.ts`
  returns a Drizzle database over a node-postgres pool, plus `ping()` and
  `databaseUrlFromEnv()` (refuses with a message naming `DATABASE_URL`).
- **Migrations:** `packages/db/migrations/` holds SQL migrations written by
  drizzle-kit from `src/schema.ts` (`pnpm --filter @ai-office/db db:generate`)
  and applied by Drizzle's own migrator (`runMigrations()`), so applying them
  never needs drizzle-kit. `pnpm db:migrate` (root, delegating to the
  package) applies pending migrations to `DATABASE_URL` and exits.
- **First migration:** `0000_schema_meta.sql` creates `schema_meta (key,
  value, updated_at)` and inserts `application = ai-office`.
- **Harness:** `@ai-office/db/testing` exports `postgresTest`, a Vitest
  `test` with a `database` fixture. One `postgres:18-alpine` container per
  test file (a file-scoped fixture) is migrated once into a template
  database; every test gets its own `CREATE DATABASE … TEMPLATE` copy, which
  is dropped afterwards. The template logic is `preparePostgresServer(url)`,
  separate from starting the container.
- **No Docker:** the tests are skipped with the reason as the skip note, and
  the same reason is printed with `console.warn`, because only the verbose
  reporter shows skip notes. **With `CI` set** (GitHub Actions sets it), a
  missing Docker fails the tests instead, so CI cannot go green by skipping
  them.
- `packages/db/vitest.config.ts` gives the package 120 s test and hook
  timeouts, because the first Postgres test in a file pulls the image and
  starts the container inside its own time budget.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below).
- [x] **Without Docker, the integration tests are reported as skipped with
      the reason, not failed.** `pnpm test` reports `5 skipped`. The default
      reporter prints the reason on stderr, and the verbose reporter prints it
      as each test's skip note (output below). I also checked that the skip
      is not hiding anything in CI: with `CI=true`, the same five tests fail
      with the reason (output below).

### Verified on the host

- [ ] **With Docker, the integration test migrates a fresh Postgres 18 and
      reads `schema_meta`.** Not verifiable here: no Docker. I ran the same
      code as far as I could without it (see "Partial check against a real
      Postgres 18" below), but the Testcontainers start itself has not been
      run.
- [ ] **CI runs the integration tests (not skipped).** Not verifiable here:
      the sandbox cannot push or run Actions. The workflow from #5 runs
      `pnpm test` on `ubuntu-latest`, which has Docker and sets `CI=true`, so
      the tests either run or fail; they cannot be skipped there.

## Partial check against a real Postgres 18

To check the migrations and the template/copy/drop SQL on a real server
without Docker, I installed `@embedded-postgres/linux-x64@18.3.0-beta.16` (a
packaged `postgres` 18.3 binary) in `/tmp/pg18`, outside the repository, and
started it on port 54329. I then ran a scratch copy of `src/migrate.test.ts`
that replaced only the container fixture with
`preparePostgresServer("postgres://postgres@127.0.0.1:54329/postgres")`.
The scratch file was deleted and nothing from this check is committed.

```text
 ✓ src/scratch-local-pg.test.ts > the migrations folder > lists every SQL migration in the journal, in order 3ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18 1088ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > create schema_meta and record the application 55ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > are a no-op when run again 75ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > hand each test its own database (write) 68ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > hand each test its own database (read) 78ms
 Tests  6 passed (6)
```

Negative check: I made every test share one database, and the isolation test
failed as it should:

```text
 FAIL  src/scratch-local-pg.test.ts > migrations against Postgres 18 > hand each test its own database (read)
AssertionError: expected [ { key: 'written-by', …(2) } ] to deeply equal []
```

`pnpm db:migrate` against the same server:

```text
$ DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm db:migrate
Migrations applied.
$ (again)
Migrations applied.
$ pnpm db:migrate            (DATABASE_URL unset)
DATABASE_URL is not set; it must be a postgres:// URL for the AI Office database.
[ELIFECYCLE] Command failed with exit code 1.
$ DATABASE_URL=postgres://postgres:hunter2secret@127.0.0.1:1/x pnpm db:migrate
Migration failed: connect ECONNREFUSED 127.0.0.1:1
```

The password in the URL is not printed.

## Output (fresh clone, `/tmp/clone6`)

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/db typecheck: Done
packages/github typecheck: Done
packages/orchestrator typecheck: Done
packages/shared typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  9 passed (9)
      Tests  12 passed | 5 skipped (17)
test exit=0

$ pnpm exec vitest run --project @ai-office/db     (default reporter)
 ✓  @ai-office/db  src/client.test.ts (4 tests) 8ms
stderr | src/migrate.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18
Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.

 ✓  @ai-office/db  src/migrate.test.ts (6 tests | 5 skipped) 6ms
 Test Files  2 passed (2)
      Tests  5 passed | 5 skipped (10)

$ pnpm exec vitest run --project @ai-office/db --reporter=verbose   (skipped lines)
 ↓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18 2ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ↓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > create schema_meta and record the application 0ms [Docker is not available (…), so the Postgres integration tests are skipped. They run in CI and on the host.]

$ CI=true pnpm exec vitest run --project @ai-office/db
 Failed Tests 5
Error: Docker is not available (Could not find a working container runtime strategy). CI must run the Postgres integration tests, so they fail here instead of skipping.
      Tests  5 failed | 5 passed (10)
```

## Notes for the reviewer

- **The sandbox hides console output from passing and skipped tests.** Vitest
  5 detects that a coding agent is running it (`AI_AGENT`, `CLAUDECODE`) and
  switches to the `minimal` reporter with `silent: "passed-only"`, so
  `pnpm test` *inside the sandbox* shows only `5 skipped`. The default-reporter
  output above was produced with those variables unset, as on the host. The
  verbose reporter shows the reason either way.
- **drizzle-orm is pinned to `~0.45.3`.** 0.45.4 was published today, and pnpm's
  minimum-release-age policy wanted an exclusion added to
  `pnpm-workspace.yaml`. As in #4, I used the newest version outside the
  window instead.
- **`allowBuilds`:** Testcontainers brings `ssh2` (with optional
  `cpu-features`) and `protobufjs`, which have install scripts. Their scripts
  only build optional native speed-ups or check versions, so they are listed
  as `false`. drizzle-kit brings two older esbuild versions, covered by the
  existing `esbuild: true`.
- `packages/db/migrations/meta/` is written by drizzle-kit and is excluded from
  Prettier. The `INSERT` at the end of `0000_schema_meta.sql` was added by hand.
  drizzle-kit's snapshots track only the schema, so this is safe.
- The placeholder `src/index.test.ts` from #4 was replaced by the package's
  real tests.

## Not verifiable in this sandbox

- Starting Postgres 18 with Testcontainers (no Docker): the `PostgreSqlContainer`
  start and stop, and the image pull.
- The CI run of the integration tests (no GitHub Actions from here).
