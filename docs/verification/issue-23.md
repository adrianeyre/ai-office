# Issue #23: Git identity and the `Agent:` commit trailer — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) against a fresh `git clone` of this branch at the
issue's last code commit (`82650e4`), after `pnpm install
--frozen-lockfile`.

## What was built

- **The default identity** (`packages/shared/src/git-identity.ts`):
  - **Name: `adrianeyre`.** ADR 0002 and the issue call the default
    "GitHub user `adrianeyre`", and the Owner's own commits in this
    repository use that name.
  - **Email: `21265837+adrianeyre@users.noreply.github.com`.** This is
    the GitHub noreply address. The user id `21265837` was read from
    `https://api.github.com/users/adrianeyre`.
  - **Validation** (`gitIdentitySchema`): a name of 1 to 100 characters
    with no `<`, `>` or line break (Git would refuse those), and a valid
    email.
- **Storage** (migration `0010_git_identity`):
  - `office_settings` is a one-row table of office-wide settings (PRD
    FR-65), each null until the office admin sets it. The Git identity is
    the first.
  - `floors` gains `git_name` and `git_email`, null to use the office's.
  - Both tables check "both or neither".
- **The orchestrator**:
  - `gitIdentityFor(office, floor)`: the Floor's own identity if it has
    one, else the office's.
  - `gitEnvironment(identity)`: `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
    `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` for a sandbox.
  - `agentTrailer(agent)`: `Agent: <name> (<role>, <AI Provider>
    <Model>)`, on one line, with the Role written as the glossary does
    (`QA`).
  - `withAgentTrailer(message, agent)`: ends a commit message with the
    trailer, after a blank line, or inside the trailer block the message
    already ends with. It never adds it twice.
  - `createOfficeSettings`: keeps the office's identity (default until
    set) and records `config.changed` (scope `office`, key `gitIdentity`,
    never the value) when it changes. `floorGitIdentity(floorId)` resolves
    a Floor's. The stores trio is now `databaseStores` / `memoryStores`
    with `office`.
- **The API:** `GET` and `PUT /api/office/git-identity` (signed in; `PUT`
  needs the CSRF token). A Floor's override is `gitIdentity` in `PATCH
  /api/floors/:floorId`, and `null` clears it.
- **The web app:**
  - Admin has a **Git identity** card: it shows the identity, says when it
    is the default, and saves another.
  - Each Floor's settings have **Commit author name** and **email**: both
    empty use the office's, and one without the other is refused before it
    is sent.
- **README:** a "Git identity" section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone (output below).
- [x] **Unit tests: Floor override wins; trailer format is exact.**
      `packages/orchestrator/src/git/identity.test.ts` (11 tests):
      - **The Floor override wins:** `gitIdentityFor` gives the Floor's
        own identity over the office's. Without one it gives the office's.
        The default is `adrianeyre <21265837+adrianeyre@users.noreply.github.com>`.
      - **The trailer format is exact:** `agentTrailer` gives exactly
        `Agent: Ada (coder, Claude claude-opus-5-5)`, the PRD's own
        example. All six Roles are checked (`manager`, `coder`,
        `reviewer`, `QA`, `docs`, `designer`), as is `Agent: Radia (QA,
        Gemini gemini-pro)`. A line break in a name cannot add a forged
        trailer line. Messages come out exactly as specified: subject only,
        with a body, with an existing `Co-Authored-By:` block, and given
        twice.
      - **The environment:** `gitEnvironment` sets author and committer to
        the identity.
      - **With real Git:** a commit made in a temporary repository, with
        only `gitEnvironment(...)` as Git's identity (`HOME` emptied,
        `GIT_CONFIG_NOSYSTEM=1`), has the Floor's identity as author and
        committer. `git log --format=%(trailers:key=Agent,valueonly)`
        reads `Ada (coder, Claude claude-opus-5-5)`.

      Also, in memory and in Postgres 18:
      `packages/orchestrator/src/office/settings.test.ts` (resolving a
      Floor's identity, with and without its override, and the event) and
      `apps/server/src/office/routes.test.ts` (the API, its refusals, and a
      Floor's override set and cleared).

### Also checked here

- **Postgres:** without Docker the Postgres runs are skipped with the
  reason. They were run against an embedded Postgres 18.3 with the scratch
  fixture of #20 (nothing from it is committed). Every Postgres-backed
  suite in the orchestrator, server, db and events packages passed, 314
  tests, including the 7 new Git identity runs and `0010_git_identity`.
- **Web unit tests:** `apps/web/src/git-identity-card.test.tsx` (3 tests:
  the default shown; saving another, with the CSRF token; a name with `<`
  and a bad email refused without sending). `apps/web/src/floors.test.tsx
  > sets the Floor's own Git identity, and clears it` checks that a name
  without an email is refused, then `{gitIdentity: {…}}` and
  `{gitIdentity: null}` are sent.
- **The end-to-end suite** still passes, 8 of 8, with the new fields on
  the Floor admin page.
- **Negative checks**, each restored afterwards:
  - With `gitIdentityFor` returning the office's identity, 3 tests failed:
    "the override wins", the real-Git commit, and the resolved Floor
    identity.
  - With the Role written as a capitalised label (`Coder`), 6 trailer
    tests failed (`Expected: "Agent: Ada (coder, …)"`, `Received: "Agent:
    Ada (Coder, …)"`).

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written**, because there is no
  Docker. They ran against an embedded Postgres 18.3 instead (above).
- **A commit pushed to GitHub, showing on the Owner's account.** That
  needs the App (#18) and a sandbox run. Here the commit was made and read
  back with local Git.

### Notes

- **Nothing calls the helpers yet.** Sandboxes and commits come with the
  coder Agent's work (PRD phase 1, later issues). These are the helpers
  that work will use: `createOfficeSettings(…).floorGitIdentity(floorId)`,
  `gitEnvironment` and `withAgentTrailer`.
- **The trailer's Model** is the Agent's Model in use: its override, or
  its AI Provider's default (`modelOf` from #21).
- **The default name** could equally be the Owner's display name ("Adrian
  Eyre") from their GitHub profile. The login was chosen because the ADR
  says "GitHub user `adrianeyre`", and the Owner's commits here use it.
  GitHub links a commit to the account by the email either way, and the
  Owner can change it in Admin.

## Output

### Fresh clone (`/tmp/clone23`, at `82650e4`)

```text
$ pnpm install --frozen-lockfile --offline
Done in 289ms using pnpm v12.10.0
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0
$ pnpm typecheck
typecheck exit=0
$ pnpm test
 Test Files  51 passed (51)
      Tests  559 passed | 71 skipped (630)
test exit=0
```

The 71 skipped tests are the 64 of #21 and the 7 new Postgres runs.

### The Git identity tests, verbose

```text
 ✓ src/git/identity.test.ts > a Floor's Git identity > is the Floor's own when it has one: the override wins
 ✓ src/git/identity.test.ts > a Floor's Git identity > is the office's otherwise
 ✓ src/git/identity.test.ts > a Floor's Git identity > is the Owner, adrianeyre, by default
 ✓ src/git/identity.test.ts > the Git environment for a sandbox > makes the identity both author and committer
 ✓ src/git/identity.test.ts > the Agent: trailer > is exactly `Agent: <name> (<role>, <AI Provider> <Model>)`
 ✓ src/git/identity.test.ts > the Agent: trailer > writes each Role as the glossary does
 ✓ src/git/identity.test.ts > the Agent: trailer > stays on one line
 ✓ src/git/identity.test.ts > the Agent: trailer > ends a commit message, after a blank line
 ✓ src/git/identity.test.ts > the Agent: trailer > joins a trailer block the message already ends with
 ✓ src/git/identity.test.ts > the Agent: trailer > is not added twice
 ✓ src/git/identity.test.ts > a commit made with them > is authored and committed as the identity, and Git reads the trailer
 ✓ src/office/settings.test.ts > the Git identity, kept in memory > is the Owner's GitHub noreply identity until it is set
 ✓ src/office/settings.test.ts > the Git identity, kept in memory > is set in the office admin, recording that it changed
 ✓ src/office/settings.test.ts > the Git identity, kept in memory > gives a Floor the office's identity, unless the Floor's own wins
 ✓ src/office/settings.test.ts > the Git identity, kept in memory > answers floor_not_found for a Floor that does not exist
 ↓ src/office/settings.test.ts > the Git identity, kept in Postgres 18 > … (4 tests) [skipped: no Docker]
 ✓ src/office/routes.test.ts > the office's Git identity, in memory > has the Owner's noreply identity by default, and sets another
 ✓ src/office/routes.test.ts > the office's Git identity, in memory > refuses a name or an email Git could not use
 ✓ src/office/routes.test.ts > the office's Git identity, in memory > overrides it for a Floor, and clears the override
 ↓ src/office/routes.test.ts > the office's Git identity, in Postgres 18 > … (3 tests) [skipped: no Docker]
```

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ apps/server/src/office/routes.test.ts > the office's Git identity, in Postgres 18 > has the Owner's noreply identity by default, and sets another
 ✓ apps/server/src/office/routes.test.ts > the office's Git identity, in Postgres 18 > refuses a name or an email Git could not use
 ✓ apps/server/src/office/routes.test.ts > the office's Git identity, in Postgres 18 > overrides it for a Floor, and clears the override
 ✓ packages/orchestrator/src/office/settings.test.ts > the Git identity, kept in Postgres 18 > is the Owner's GitHub noreply identity until it is set
 ✓ packages/orchestrator/src/office/settings.test.ts > the Git identity, kept in Postgres 18 > is set in the office admin, recording that it changed
 ✓ packages/orchestrator/src/office/settings.test.ts > the Git identity, kept in Postgres 18 > gives a Floor the office's identity, unless the Floor's own wins
 ✓ packages/orchestrator/src/office/settings.test.ts > the Git identity, kept in Postgres 18 > answers floor_not_found for a Floor that does not exist
 Test Files  26 passed (26)
      Tests  314 passed (314)
```

### Negative checks

```text
--- negative: office identity wins over the Floor's
     × is the Floor's own when it has one: the override wins
     × is authored and committed as the identity, and Git reads the trailer
     × gives a Floor the office's identity, unless the Floor's own wins
      Tests  3 failed | 206 passed | 50 skipped (259)
--- negative: Role written as a label (Coder)
     × is exactly `Agent: <name> (<role>, <AI Provider> <Model>)`
     × writes each Role as the glossary does
     × stays on one line
     × ends a commit message, after a blank line
     × joins a trailer block the message already ends with
     × is authored and committed as the identity, and Git reads the trailer
Expected: "Agent: Ada (coder, Claude claude-opus-5-5)"
Received: "Agent: Ada (Coder, Claude claude-opus-5-5)"
```
