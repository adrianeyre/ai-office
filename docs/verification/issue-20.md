# Issue #20: Floors: add from installed repositories, settings and archive — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GitHub App) against a fresh `git clone` of this branch at the
issue's last code commit (`0c997b3`), after `pnpm install
--frozen-lockfile`.

## What was built

- **`floors` table** (migration `0008_floors`). It is keyed by a slug id
  (`web-shop`) and is unique on GitHub's repository id, so a repository is
  at most one Floor, archived or not. Matching by GitHub's id means a
  rename does not matter. It holds:
  - the settings of PRD FR-7 with their defaults: name and default branch
    from GitHub; empty setup and test commands; Merge Policy `send_to_me`;
    Round Cap 3; no Token Cap overrides (daily and monthly); no concurrency
    limit; no required reviewer Agents yet (#21 fills it); plan approval
    on;
  - `created_at`, and `archived_at` (null while in use);
  - checks on the slug, the Merge Policy, the Round Cap, the caps and the
    limit.
- **Shared schemas** (`packages/shared/src/floors.ts`): the Floor, its
  settings with their bounds and plain-language errors, the add and update
  requests, the installed repositories, and the Floor error codes.
- **The orchestrator's Floors** (`packages/orchestrator/src/floors/`):
  - `installedRepositories()`: every repository the App is installed on,
    with the Floor each one is.
  - `add(owner/name)`: refuses a repository the App cannot see
    (`repository_not_installed`) and one that is already a Floor, archived
    or not (`floor_exists`). A second Floor of a same-named repository gets
    `web-shop-2`, and so on; after 100 ids it gives up.
  - `updateSettings`: records only the settings that changed. A new default
    branch must exist on GitHub (`branch_not_found`). An archived Floor
    cannot be changed (`floor_archived`).
  - `archive`: the Floor is hidden from `list()` and from `active()` (what
    intake will read). Its record stays readable, and its repository stays
    that Floor's.
  - **Events:** `floor.created`, `config.changed` (scope `floor`, naming the
    changed settings, never their values) and `floor.archived`.
  - **Stores:** `databaseFloorStore` (the table) and `memoryFloorStore`
    (tests).
- **The API** (`apps/server/src/floors/routes.ts`): every route needs a
  signed-in session and, to change anything, its CSRF token.

  | Route | Answers |
  | ----- | ------- |
  | `GET /api/github/repositories` | The App's repositories, each with its Floor |
  | `GET /api/floors` | The Floors in use (archived ones hidden) |
  | `POST /api/floors` | 201 with the new Floor; 409, 422 or 400 when refused |
  | `GET /api/floors/:floorId` | The Floor, archived or not; 404 |
  | `PATCH /api/floors/:floorId` | The updated Floor; 400, 409 or 422 when refused |
  | `POST /api/floors/:floorId/archive` | The archived Floor; 409 if already archived |

  Without the App configured, the GitHub routes answer
  `503 github_not_configured`. When GitHub cannot be reached they answer
  `502 github_unavailable`.
- **Server configuration:**
  - The server builds the GitHub App (#19) from `GITHUB_APP_ID` and
    `GITHUB_APP_PRIVATE_KEY`.
  - A new `GITHUB_API_URL` (default `https://api.github.com`) points it at
    GitHub Enterprise Server, or at a fake GitHub in the end-to-end tests.
    It is in `.env.example` and `docker-compose.yml`.
  - The Dockerfile now copies the `github` and `orchestrator` sources the
    server imports. `docker/deployment.test.ts` caught their absence.
- **The web app:**
  - Admin has a **Floors** card. It lists the Floors in use (each linking
    to its Floor admin) and the repositories the App is installed on, each
    with **Add Floor** or "Already a Floor". It says when the App is not
    configured.
  - `/admin/floors/:floorId` holds the Floor's settings in a form that
    sends only what changed, and checks bounds before sending. It has an
    **Archive** action that asks first, then returns to Admin. An archived
    Floor is shown read-only.
- **End-to-end:** each test's server now has a GitHub App pointed at the
  test's own fake GitHub over HTTP (`office.github`, from #19).
  `e2e/tests/floors.spec.ts` adds a Floor from the admin page. A second
  test changes a Floor's settings and archives it.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone (output below).
- [x] **Integration tests against the fake GitHub: add, refuse a duplicate
      repository, edit settings, archive.**
      - **The orchestrator** (`packages/orchestrator/src/floors/floors.test.ts`):
        12 cases, each run twice: with the Floors in memory, and in
        Postgres 18. They cover:
        - add with the defaults, and `floor.created`;
        - the repository list;
        - refusing a duplicate, also with other letter case, at the same
          moment, and after archiving;
        - refusing a repository the App is not installed on;
        - same-named repositories getting distinct ids;
        - editing settings, with `config.changed` naming only what changed;
        - refusing a default branch that does not exist;
        - archiving, and refusing changes after it;
        - a 404.
      - **The server** (`apps/server/src/floors/routes.test.ts`): the same
        through the HTTP API, 8 cases, each in memory and in Postgres 18.
        It also covers the 400s for out-of-bounds and unknown settings, the
        503 and 502 without a working GitHub, and the CSRF check.
      - Without Docker the Postgres runs are skipped with the reason (as
        #16 set up). They were run here against an embedded Postgres 18.3
        instead, with a scratch Vitest config that swaps the Testcontainers
        fixture for one on that server (the method of #12 to #17; nothing
        from it is committed). All 53 passed: the 13 orchestrator cases, the
        8 server cases, and the 5 migration tests with `0008_floors` (output
        below).
- [x] **Playwright: add a Floor from the admin page.**
      `e2e/tests/floors.spec.ts > adds a Floor from the admin page`:
      1. The fake GitHub has `adrianeyre/web-shop` and `adrianeyre/blog`
         installed.
      2. The Owner signs in and opens Admin, which says "No Floors yet." and
         lists both repositories with **Add Floor**.
      3. Clicking it for `web-shop` turns the row into "Already a Floor".
      4. After a reload, the `web-shop` link opens `/admin/floors/web-shop`,
         which shows the default settings.

      The second test changes the Merge Policy, Round Cap and test command,
      sees them survive a reload, archives the Floor, and sees it leave the
      list. Both passed, with the 5 sign-in tests (7 of 7), in real Chromium
      against the real server and the embedded Postgres 18.3 through
      `E2E_POSTGRES_URL` (as in #17; output below).

### Also checked here

- **Web unit tests** (`apps/web/src/floors.test.tsx`, 7 tests): adding a
  Floor, with the CSRF token sent; the not-configured message; saving only
  what changed; refusing out-of-bounds settings without sending them;
  archiving after asking; an archived Floor read-only; an unknown Floor.
- **Negative checks**, each restored afterwards:
  - With the duplicate refusal removed from the service and the memory
    store, 4 tests failed across the orchestrator and the server.
    This also showed that a store that always answered "id taken" made
    `add()` loop forever. The loop is now bounded (`0c997b3`), with a test.
  - With the **Add Floor** button sending `…-typo`, both Floor specs
    failed. The page showed the server's refusal: "The GitHub App is not
    installed on adrianeyre/web-shop-typo. Install it there first."

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written**, because there is no
  Docker. They ran against an embedded Postgres 18.3 instead (above).
- **`pnpm e2e` with Testcontainers**, for the same reason. It ran with
  `E2E_POSTGRES_URL` instead.
- **A real GitHub App.** #18 (the Owner creates the App and
  `ai-office-sandbox`) is not done, so listing a real installation's
  repositories is untested here. The real App client is covered by #19's
  contract suite against the fake over HTTP, and the server talks to it
  through that same client.
- **The image build** (`docker compose up --build`): the Dockerfile gained
  two `COPY` lines, checked statically by `docker/deployment.test.ts`
  only.

### Notes

- **"Each repository is at most one Floor" (FR-6) covers archived Floors
  too.** Re-adding an archived Floor's repository is refused with
  `floor_exists`. There is no way to unarchive yet; that belongs to the
  full Floor admin (#61).
- **"Archive stops intake":** there is no intake yet (#22). Intake is to
  read `floors.active()`, which leaves archived Floors out; the tests check
  it.
- **Required reviewer Agents** (FR-7) are part of the Floor but not
  editable through `PATCH` yet. With no Agents (#21) there is nothing to
  name.

## Output

### Fresh clone (`/tmp/clone20`, at `0c997b3`)

```text
$ pnpm install --frozen-lockfile --offline
Done in 417ms using pnpm v12.10.0
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0
$ pnpm typecheck
packages/shared typecheck: Done
packages/db typecheck: Done
packages/github typecheck: Done
packages/events typecheck: Done
packages/gateway typecheck: Done
e2e typecheck: Done
packages/orchestrator typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
typecheck exit=0
$ pnpm test
 Test Files  43 passed (43)
      Tests  520 passed | 54 skipped (574)
test exit=0
```

The 54 skipped tests are 33 from before (Postgres without Docker, Compose,
the real-App contract suite) and the 21 new Postgres runs of the Floor
cases.

### The Floor tests (orchestrator and server), verbose

```text
 ✓ src/floors/floors.test.ts > Floors, kept in memory > adds a Floor from an installed repository, with the default settings
 ✓ src/floors/floors.test.ts > Floors, kept in memory > lists the installed repositories, with the Floor each one has
 ✓ src/floors/floors.test.ts > Floors, kept in memory > refuses a repository that is already a Floor
 ✓ src/floors/floors.test.ts > Floors, kept in memory > refuses the same repository added twice at once
 ✓ src/floors/floors.test.ts > Floors, kept in memory > refuses an archived Floor's repository: it is still that Floor
 ✓ src/floors/floors.test.ts > Floors, kept in memory > refuses a repository the App is not installed on
 ✓ src/floors/floors.test.ts > Floors, kept in memory > gives Floors of repositories with the same name different ids
 ✓ src/floors/floors.test.ts > Floors, kept in memory > changes settings, recording which ones changed
 ✓ src/floors/floors.test.ts > Floors, kept in memory > changes the default branch only to a branch the repository has
 ✓ src/floors/floors.test.ts > Floors, kept in memory > archives a Floor: hidden, its intake stopped, its record kept
 ✓ src/floors/floors.test.ts > Floors, kept in memory > refuses to change or archive an archived Floor
 ✓ src/floors/floors.test.ts > Floors, kept in memory > answers floor_not_found for a Floor that does not exist
 ↓ src/floors/floors.test.ts > Floors, kept in Postgres 18 > … (13 tests) [skipped: no Docker]
 ✓ src/floors/floors.test.ts > Floors without a working GitHub > refuses to add a Floor while the App is not configured
 ✓ src/floors/floors.test.ts > Floors without a working GitHub > says when GitHub cannot be reached
 ✓ src/floors/floors.test.ts > a Floor's id > is a slug of the repository's name
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > lists the repositories the App is installed on
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > adds a Floor with the default settings
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > refuses a repository that is already a Floor
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > refuses a repository the App is not installed on, or no repository
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > edits a Floor's settings
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > refuses settings out of bounds, unknown ones and missing branches
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > archives a Floor, hiding it and keeping its record
 ✓ src/floors/routes.test.ts > the Floor API, with Floors in memory > answers 404 for a Floor that does not exist
 ↓ src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > … (8 tests) [skipped: no Docker]
 ✓ src/floors/routes.test.ts > the Floor API without a working GitHub > says the GitHub App is not configured
 ✓ src/floors/routes.test.ts > the Floor API without a working GitHub > says when GitHub cannot be reached
 ✓ src/floors/routes.test.ts > the Floor API's access > needs the session's CSRF token to change anything
```

(Run at `ac6c07f`. The bounded-id test added in `0c997b3` makes the
orchestrator 16 passed, 13 skipped.)

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > adds a Floor from an installed repository, with the default settings
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > lists the installed repositories, with the Floor each one has
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > refuses a repository that is already a Floor
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > refuses the same repository added twice at once
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > refuses an archived Floor's repository: it is still that Floor
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > refuses a repository the App is not installed on
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > gives Floors of repositories with the same name different ids
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > changes settings, recording which ones changed
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > changes the default branch only to a branch the repository has
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > archives a Floor: hidden, its intake stopped, its record kept
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > refuses to change or archive an archived Floor
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > answers floor_not_found for a Floor that does not exist
 ✓ packages/orchestrator/src/floors/floors.test.ts > Floors, kept in Postgres 18 > allows one Floor per repository, archived or not
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > lists the repositories the App is installed on
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > adds a Floor with the default settings
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > refuses a repository that is already a Floor
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > refuses a repository the App is not installed on, or no repository
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > edits a Floor's settings
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > refuses settings out of bounds, unknown ones and missing branches
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > archives a Floor, hiding it and keeping its record
 ✓ apps/server/src/floors/routes.test.ts > the Floor API, with Floors in Postgres 18 > answers 404 for a Floor that does not exist
 ✓ packages/db/src/migrate.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18
 ✓ packages/db/src/migrate.test.ts > migrations against Postgres 18 > create schema_meta and record the application
 ✓ packages/db/src/migrate.test.ts > migrations against Postgres 18 > are a no-op when run again
 ✓ packages/db/src/migrate.test.ts > migrations against Postgres 18 > hand each test its own database (write)
 ✓ packages/db/src/migrate.test.ts > migrations against Postgres 18 > hand each test its own database (read)
      Tests  53 passed (53)
```

### Web unit tests

```text
 ✓ src/floors.test.tsx > the Floors on the admin page > adds a Floor from a repository the App is installed on
 ✓ src/floors.test.tsx > the Floors on the admin page > says when the GitHub App is not configured
 ✓ src/floors.test.tsx > the Floor admin page > shows the Floor's settings, and saves only what changed
 ✓ src/floors.test.tsx > the Floor admin page > refuses settings out of bounds before sending them
 ✓ src/floors.test.tsx > the Floor admin page > archives the Floor after asking, then goes back to the admin page
 ✓ src/floors.test.tsx > the Floor admin page > shows an archived Floor read-only
 ✓ src/floors.test.tsx > the Floor admin page > says when there is no such Floor
      Tests  7 passed (7)
```

### Playwright (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium)

```text
Running 7 tests using 7 workers

  ✓  3 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (1.4s)
  ✓  5 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (1.6s)
  ✓  6 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (1.8s)
  ✓  7 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (1.7s)
  ✓  1 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (1.9s)
  ✓  4 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (2.1s)
  ✓  2 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (2.2s)

  7 passed (3.5s)
```

### Negative checks

```text
$ # duplicate refusal removed from the service and the memory store
     × refuses a repository that is already a Floor
     × refuses an archived Floor's repository: it is still that Floor
     × refuses a repository that is already a Floor
     × archives a Floor, hiding it and keeping its record
      Tests  4 failed | 175 passed | 33 skipped (212)

$ # Add Floor sends `${repository.fullName}-typo`
  ✘  4 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (7.1s)
  ✘  5 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (30.1s)
    Error: expect(locator).toHaveText(expected) failed
    Expected pattern: /adrianeyre\/web-shop\s*Already a Floor/
    Received string:  "adrianeyre/web-shopAdd FloorThe GitHub App is not installed on adrianeyre/web-shop-typo. Install it there first."
  2 failed
```
