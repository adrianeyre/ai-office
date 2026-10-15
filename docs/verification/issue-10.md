# Issue #10: First-run setup screen sets the Owner password — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit
of the issue (`27b12d2`), after `pnpm install --frozen-lockfile`.

## What was built

- **`owner` table** (`packages/db`, migration `0002_owner`): one row at most
  (`id` 1, `CHECK (id = 1)`), holding `password_hash` and `created_at`.
  A second check constraint refuses any `password_hash` that does not start
  with `$argon2id$`, so even a bug elsewhere cannot store a plain password.
- **Password rules** (`packages/shared/src/auth.ts`), shared by the server
  and the web app:
  - at least 12 and at most 256 characters, counted as people count them
    (grapheme clusters, so an emoji with modifiers is one);
  - at least 6 different characters;
  - a mix of three of lower case, upper case, digits and symbols, unless the
    password is a passphrase of 20 characters or more.

  `ownerPasswordSchema` and `setupRequestSchema` (Zod) report every problem
  in plain words; `apiErrorSchema` is the body of every API error.
- **Hashing** (`apps/server/src/auth/password.ts`): `@node-rs/argon2`, with
  OWASP's parameters (19 MiB, 2 passes, 1 lane) and a fresh salt per hash.
  Argon2id is the library's default; it is not named in the options because
  `Algorithm` is a const enum, which isolated modules cannot read. The tests
  and the table's check constraint pin the `$argon2id$` prefix instead.
- **Route access** (`apps/server/src/auth/access.ts`): every route declares
  `config.access`:
  - `public` (always: `/health` and the built web files);
  - `setup` (only until a password exists: `POST /api/setup`);
  - `owner` (the default for a route that declares nothing).

  One `onRequest` hook enforces it. Before setup:
  - every `owner` route, and every unknown `/api/…` path, answers
    `403 {"error":"setup_required","message":"AI Office has no password yet; set one at /setup."}`;
  - every page redirects (302) to `/setup`.

  After setup:
  - `/setup` (page and `POST /api/setup`) is a 404 for good, including after
    a restart;
  - pages are served again.

  `app.routeAccess()` lists every registered route with its access, for
  tests (#11 builds its route-registration test on it).
- **`POST /api/setup`**: JSON only, so a cross-site HTML form cannot reach it
  (415). It checks the shared rules (400 with `problems`), then hashes and
  inserts. The insert is `ON CONFLICT DO NOTHING` on the one-row table, so of
  two concurrent setups exactly one wins and the other gets a 404. The
  password is never logged; only "The Owner's password was set." is.
- **No default password, nothing from the environment.** The config schema
  (`apps/server/src/config.ts`) was not given any password variable, and
  `.env.example` lists none.
- **Web** (`apps/web`): a standalone `/setup` page (outside the app layout)
  built with React Hook Form and the shared Zod rules. It asks for the
  password twice, lists what is wrong with a weak one, and loads `/` once
  the server answers 204. shadcn/ui `Input` and `Label` were added. The
  shadcn CLI also added a stray `cn` package and the whole `radix-ui` bundle,
  so both were removed and `Label` uses a native `<label>`.
- **Static files**: `@fastify/static` no longer serves `/` itself
  (`index: false`). Every page, `/` included, goes through the access
  decision; the files under `assets/` stay public.
- **README**: a "First run: the setup screen" section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). `pnpm build` passes too.
- [x] **Integration test: before setup every API route returns a
      setup-required response; after setup `/setup` is gone.**
      `apps/server/src/auth/setup.test.ts` builds the real app with
      `buildApp` and drives it with `inject`:
      - *before setup*: it walks every API route the app has registered
        (from `app.routeAccess()`), plus two unknown paths, and expects
        `403 setup_required` from each. To show that routes added later are
        covered, the test adds two routes that declare no access
        (`GET`/`POST /api/example`). Pages redirect to `/setup`; `/setup`,
        the built files and `/health` are served.
      - *after setup*: `GET /setup` and `POST /api/setup` are 404 (also
        after a "restart" on the same store), the stored hash is unchanged,
        and API routes and pages work.
      - **Negative check:** with the `setup_required` branch removed from
        the hook, `answers every API route with setup_required` fails
        (`Tests  1 failed | 16 passed (17)`); restored afterwards.
- [x] **The stored value is an Argon2id hash, never the password.**
      - In memory: the test matches the stored value against
        `^\$argon2id\$v=19\$m=19456,t=2,p=1\$<salt>\$<hash>$`, checks it
        does not contain the password, and that `verify` accepts the password
        and refuses another. It also checks that two setups with the same
        password store different hashes (salted), and that the log does not
        contain the password.
      - In Postgres: `apps/server/src/auth/store.test.ts` (Testcontainers;
        skipped here without Docker) sets the password through
        `POST /api/setup` and reads the `owner` row. It checks that the table
        refuses a plain value and a second row. I ran it against a real
        Postgres 18.3 (below).
      - End to end with the real server (below): the row in `owner` is
        `$argon2id$v=19$m=19456,t=2,p=1$…`.

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written** (4 new ones in
  `apps/server/src/auth/store.test.ts`), because there is no Docker. They
  skip with the reason here, and fail in CI if Docker is missing. They were
  run against an embedded Postgres 18.3 instead, using the method from #6
  and #33: `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp/pg18`
  (outside the repository) on port 54329, with scratch copies of the test
  files that replace only the container fixture with
  `preparePostgresServer(…54329…)`. The scratch files were deleted and
  nothing from this check is committed.
- **The setup page in a real browser.** It is covered by jsdom tests
  (`apps/web/src/setup-page.test.tsx`) and was served by the real server
  (below), but not clicked through in a browser. The PRD plans Playwright
  for login (§9), which does not exist in the workspace yet.
- **`docker compose up` with setup**: no Docker here (see #9).

## Output

### Fresh clone (`/tmp/clone10`)

```text
27b12d2 feat(web): the setup page
$ pnpm install --frozen-lockfile
Done in 1.4s using pnpm v12.10.0
$ pnpm lint
lint exit=0
Checking formatting...
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit=0
apps/web typecheck: Done
apps/server typecheck: Done
$ pnpm test
test exit=0
 Test Files  24 passed (24)
      Tests  271 passed | 13 skipped (284)
$ pnpm build
build exit=0
✓ built in 305ms
```

The 13 skipped tests:
- 11 Postgres integration tests (5 in `db`, 2 in `gateway`, 4 new in
  `server`), skipped without Docker;
- `docker compose config validates the file`, skipped without Compose;
- the opt-in compose end-to-end test.

```text
$ pnpm exec vitest run --project @ai-office/server --reporter=verbose src/auth
 ✓ src/auth/setup.test.ts > before setup > answers every API route with setup_required
 ✓ src/auth/setup.test.ts > before setup > redirects the page / to /setup
 ✓ src/auth/setup.test.ts > before setup > redirects the page /notices to /setup
 ✓ src/auth/setup.test.ts > before setup > redirects the page /admin?tab=gateway to /setup
 ✓ src/auth/setup.test.ts > before setup > redirects the page /login to /setup
 ✓ src/auth/setup.test.ts > before setup > serves the setup page, the built files and /health
 ✓ src/auth/setup.test.ts > before setup > has no default password: the store starts empty
 ✓ src/auth/setup.test.ts > POST /api/setup > refuses {"password":"short"} and stores nothing
 ✓ src/auth/setup.test.ts > POST /api/setup > refuses {"password":"onlylowercase"} and stores nothing
 ✓ src/auth/setup.test.ts > POST /api/setup > refuses {} and stores nothing
 ✓ src/auth/setup.test.ts > POST /api/setup > accepts only JSON, so a cross-site form cannot set the password
 ✓ src/auth/setup.test.ts > POST /api/setup > stores an Argon2id hash of the password, never the password
 ✓ src/auth/setup.test.ts > POST /api/setup > salts each hash
 ✓ src/auth/setup.test.ts > POST /api/setup > lets only one of two concurrent setups set the password
 ✓ src/auth/setup.test.ts > after setup > makes /setup a 404, as a page and as an API route
 ✓ src/auth/setup.test.ts > after setup > keeps /setup gone after a restart
 ✓ src/auth/setup.test.ts > after setup > stops answering setup_required and serves pages
 ↓ src/auth/store.test.ts > databaseAuthStore against Postgres 18 > … (4 tests) [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
      Tests  17 passed | 4 skipped (21)
```

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > has no password until one is created 1673ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > creates the password only once 78ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > refuses to store anything but an Argon2id hash 78ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > stores the setup screen's password as an Argon2id hash 144ms
      Tests  4 passed (4)
 ✓ src/scratch-local-pg-migrate.test.ts > the migrations folder > lists every SQL migration in the journal, in order 2ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18 1009ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > create schema_meta and record the application 78ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > are a no-op when run again 67ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > hand each test its own database (write) 126ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > hand each test its own database (read) 202ms
      Tests  6 passed (6)
```

### The real server against Postgres 18.3

`pnpm db:migrate` on an empty database, then `node apps/server/src/main.ts`
with the web app built, on port 3310:

```text
Migrations applied.
/              302 http://127.0.0.1:3310/setup
/notices       302 http://127.0.0.1:3310/setup
/setup         200
/assets/       302 http://127.0.0.1:3310/setup
/health        200
/api/anything  403
{"error":"setup_required","message":"AI Office has no password yet; set one at /setup."}
$ POST /api/setup {"password":"weakpass"}
{"error":"invalid_request","problems":["Use at least 12 characters."]} 400
$ POST /api/setup {"password":"<a valid password>"}
204
/        200
/setup   404
$ POST /api/setup again
{"error":"Not Found"} 404
$ select id, password_hash from owner
[ { id: 1, password_hash: '$argon2id$v=19$m=19456,t=2,p=1$VeBIxicStwCz8k1ctBXi4A$yvyjMndy8q12gzO9/LlhNN/qVSva6zejuRFB3WY+g0s' } ]
$ grep -c '<the password>' server.log
0
```
