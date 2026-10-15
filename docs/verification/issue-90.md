# Issue #90: Skill library — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `42085b8` (every code
commit of the issue, plus the README), after `pnpm install
--frozen-lockfile`.

## What was built

### The format (`packages/shared`, `skills.ts`)

A Skill is in the [Agent Skills format](https://agentskills.io/specification)
(PRD FR-71): a folder with a `SKILL.md`, then any supporting files.

- **`parseSkillDocument`** reads a `SKILL.md`. Its YAML frontmatter must sit
  between a first line `---` and the next one, and be a set of fields.
  - `name`: 1 to 64 characters, lowercase `a-z`, `0-9` and single hyphens,
    not first or last.
  - `description`: 1 to 1024 characters, not blank.
  - `license`, `compatibility` (1 to 500 characters), `metadata` (text to
    text) and `allowed-tools` (one string) are checked when present.
  - Any other field (Claude Code's `disable-model-invocation`, say) is kept.
  - YAML aliases are refused, so a small file cannot expand. Duplicate keys
    are refused.
  - A byte-order mark and Windows line endings are fine.
- **`skillProblems`** checks a Skill's files as a whole:
  - a valid `SKILL.md` at the top;
  - paths relative, `/`-separated, without `.` or `..`, backslashes or
    control characters;
  - no path given twice, even differing only in case;
  - no file where another needs a folder;
  - text only (no NUL);
  - at most 200 files and 4 MB;
  - the name matches the folder's, when the folder is known (upload, or a
    subfolder in Git).
- **Request schemas:**
  - `addSkillRequestSchema`: upload or editor, with `folder` for an upload.
  - `importSkillRequestSchema`: a public `https://` URL with no credentials,
    query or fragment; a branch or tag that cannot pass for an option; a
    folder path.
  - `skillUpdateSchema`: `files` or `enabled`.
  - `reviewSkillRequestSchema`: the SHA-256 `digest` of what was read.
- **Responses and errors:** the response schemas, and `skillErrorCodes`.
  Every message here is shared with the web app, so the editor and the
  upload say what is wrong before anything is sent.
- `yaml` (already the root's dev dependency) is now a dependency of
  `@ai-office/shared`.

### Events (`packages/events`)

`skill.added` (with its source and whether it starts enabled),
`skill.changed` (`edited`, `reviewed`, `enabled` or `disabled`) and
`skill.removed`. Each names the Skill (id and name), never its contents.
The Activity Feed has a **Skills** type group and a sentence for each, such
as `Skill "pdf" imported from Git; it waits for review before it can be
enabled.`

### `skills` (`packages/db`, migration `0015_skills`)

- **Columns:**
  - `name` (unique) and `description`, read from the frontmatter;
  - `source` (`upload`, `git` or `editor`);
  - for Git: `git_url`, `git_ref`, `git_commit` and `git_path`;
  - `files` (jsonb `{ path, content }`), and `digest`, the SHA-256 of
    `files`;
  - `enabled` and `reviewed_at`;
  - the times.
- **Checks:**
  - `skills_enabled_reviewed`: `NOT enabled OR reviewed_at IS NOT NULL`, so
    the database itself refuses an enabled Skill nobody reviewed;
  - `skills_git_origin`: a Git Skill has its URL, commit and folder, and
    nothing else does;
  - `skills_source`;
  - `skills_digest`.

### The library (`packages/orchestrator`, `skills/`)

- **`createSkillLibrary({ store, events, repository })`** provides `list`,
  `get`, `add` (upload or editor), `importFromGit`, `update` (files or
  enabled), `review(id, digest)` and `remove`.
  - **Written in the editor:** the Owner's own, so it starts enabled and
    reviewed.
  - **Uploaded or imported from Git:** it starts disabled with
    `reviewedAt` null. `update({ enabled: true })` is refused with
    `skill_not_reviewed`.
  - **`review`** enables the Skill only if its files still have the digest
    the Owner read (`skill_changed` otherwise). The check is a conditional
    `UPDATE … WHERE digest = $1`, so it holds even if a change lands
    between reading and confirming.
  - **Edits:** editing is not reviewing, so an unreviewed Skill stays
    unreviewed after an edit. A reviewed one stays reviewed, since the edit
    is the Owner's.
  - **Renames:** an edit takes the Skill's name and description from its
    new `SKILL.md`, so a rename shows up as `skill_name_taken` when another
    Skill has that name.
  - **Events:** each add, change and removal publishes its event. A change
    that changes nothing publishes nothing.
- **`memorySkillStore` / `databaseSkillStore`** are part of `OfficeStores`.
- **`gitSkillRepository({ scratchDir })`** reads one Skill from a Git
  repository.
  - **The clone:** `git -c core.hooksPath=/dev/null clone --depth 1
    --no-tags --single-branch --no-recurse-submodules [--branch ref] --
    url`. It runs with `GIT_ALLOW_PROTOCOL=https` (redirects and submodules
    included), `GIT_LFS_SKIP_SMUDGE=1`, and no system or global config
    (`runGit`, #24). It has a 60-second timeout, and the clone is deleted
    afterwards.
  - **Finding the Skill:** without a folder, a repository's only Skill (or
    the one at its top) is taken. When it holds several, the answer is
    `skill_path_required` with their folders, for the Owner to pick one.
  - **What is read:** only regular files, decoded as strict UTF-8. Links
    are refused, never followed, including a folder on the way. Binary
    files are refused, and so is anything over the size limits.

### `apps/server`

`/api/skills` (`skills/routes.ts`). Every route needs a session, and CSRF
for changes.

- **Reading:** `GET /api/skills` lists Skills, each file with its path and
  size. `GET /api/skills/:id` gives one with every file in full.
- **Adding:** `POST /api/skills` (upload or editor) and
  `POST /api/skills/import`.
- **Changing:** `PATCH /api/skills/:id` (`files` or `enabled`),
  `POST /api/skills/:id/review` (`digest`) and `DELETE /api/skills/:id`.
- **Errors:**
  - `400 invalid_request` with the problems;
  - `404 skill_not_found`;
  - `409` for `skill_name_taken`, `skill_not_reviewed` and `skill_changed`;
  - `422` for `invalid_skill`, `no_skill_in_repository` and
    `skill_path_required`, with the problems or folders;
  - `502 skill_import_failed`, with Git's own last line.
- **Body limit:** the routes that take files accept 16 MiB, because a 4 MB
  Skill escaped as JSON is more than Fastify's default 1 MiB.
- **The library:** `buildApp` makes it from `stores.skills` (the `skills`
  table in the server), importing into the system's temporary directory.

### `apps/web`

Admin has a **Skills** card (`skills-card.tsx`).

- **The library**, by name. Each Skill shows its status (**Needs review**,
  **Enabled** or **Disabled**), its description, its source, how many files
  it has, and its repository for a Git Skill.
- **Review** (for a Skill not yet reviewed):
  - It shows every file in full, as plain text, and for Git the
    repository, branch or tag, commit and folder.
  - Only **I have read it all: enable *name*** enables the Skill, sending
    the digest of what was shown.
  - If the Skill changed meanwhile, the card says so and reloads the
    contents.
  - Such a Skill has no **Enable** button in the list.
- **Other actions:** **View**, **Edit** (`SKILL.md` and supporting files:
  add, rename, remove), **Enable**/**Disable** once reviewed, and
  **Delete**, which asks for confirmation first.
- **Add a Skill:**
  - **Upload a folder:** a folder picker (`webkitdirectory`). Files are
    read as strict UTF-8, the folder's own name is taken off their paths
    and sent as `folder`, and `.git/` and `.DS_Store` are left out. The
    problems are shown before anything is sent.
  - **Import from Git:** the URL, then the branch or tag and folder, both
    optional. When the repository holds several Skills, each folder is a
    button that fills in the folder.
  - **Write one:** the editor, started from a valid template.

The README has a **Skill library** section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker the Postgres tests
      skip with the reason (804 passed, 134 skipped). Against Postgres 18
      (below), 923 passed and 15 skipped.
- [x] **Tests: frontmatter validation.**
      `packages/shared/src/skills.test.ts` (19 tests) checks:
  - the fields read;
  - valid and invalid names: upper case, a leading or trailing hyphen,
    `--`, `_`, a space, non-ASCII, 65 characters, missing, not text;
  - descriptions: missing, blank, not text, exactly 1024 and 1025;
  - `compatibility`, `metadata`, `allowed-tools` and `license`;
  - frontmatter that is missing, unterminated, empty, a list, invalid YAML,
    or has a duplicate key;
  - YAML aliases refused;
  - the editor's template;
  - every rule on paths, case, text, size and the folder's name;
  - the request schemas, including the refusal of `http://`, `file://`,
    `ssh://`, URLs with credentials and refs shaped like options.

  The same validation is exercised through the library
  (`skills.test.ts`), the API (`400` with the problems) and the web app
  (the editor and the upload refuse before sending).
- [x] **Tests: an imported Skill starts disabled until reviewed.**
  - **`packages/orchestrator/src/skills/skills.test.ts`**, in memory and in
    Postgres 18:
    - a Skill imported from Git and an uploaded one each start with
      `enabled: false` and `reviewedAt: null`;
    - enabling either is refused with `skill_not_reviewed` and leaves it
      disabled;
    - an edit does not count as a review;
    - a review naming the digest from before an edit is refused with
      `skill_changed`;
    - a review of the current digest enables it, after which it can be
      turned off and on;
    - a Skill written in the editor starts enabled;
    - each step's event is checked.

    In Postgres, `the table itself refuses an enabled Skill that was never
    reviewed` checks that the check constraint refuses an `UPDATE` and an
    `INSERT`.
  - **`apps/server/src/skills/routes.test.ts`**, in memory and in Postgres
    18: the same through the real routes. `PATCH {enabled:true}` is a `409
    skill_not_reviewed`, a stale review a `409 skill_changed`, and a review
    enables the Skill.
  - **`apps/web/src/skills-card.test.tsx`** (8 tests):
    - an imported Skill shows **Needs review** and no **Enable** button;
    - **Review** shows every file in full and its origin, then enables it,
      sending the digest with the CSRF token;
    - a stale review is reported and the contents reloaded;
    - uploading and importing say the Skill "stays disabled until you
      review it".

  **Negative checks** (each reverted afterwards, across the 64 Skill tests
  of `shared`, `orchestrator`, `server` and `web`, against Postgres):

  | Sabotage | Failed |
  | --- | --- |
  | Imported Skills start enabled and reviewed | 9 |
  | Enabling an unreviewed Skill is not refused | 6 |
  | A review ignores the digest | 4 |
  | Any name passes the frontmatter check (`skillNamePattern = /^.+$/`) | 7 |

#### Beyond the criteria

- **`pnpm e2e`** (`e2e/tests/skills.spec.ts`) runs in real Chromium against
  the built app and Postgres 18:
  - it writes a Skill in the editor, which is enabled;
  - it uploads a folder with Playwright's directory upload, which shows
    **Needs review** with no **Enable**;
  - it reloads, and the Skill is still unreviewed;
  - it reviews the Skill, checking both files are shown in full, and
    enables it;
  - it reloads, and the Skill is still enabled;
  - it deletes the written Skill, once confirmed;
  - it finds all four steps in the Activity Feed, and the review in the
    server's log.

  The whole suite passed: 17 tests (output below).
- **Importing over real HTTPS.** The tests clone repositories on disk over
  `file://`, which only they allow, so the HTTPS path was also run by hand
  against `https://github.com/anthropics/skills`. The script ran from
  `packages/orchestrator` and was deleted afterwards.
  - Without a folder, the answer was `skill_path_required` with the
    repository's Skills.
  - With `skills/pdf`, the Skill was imported with `enabled: false`,
    `reviewedAt: null`, 12 files, the commit (`9d63080…`), and one
    `skill.added` event with `enabled: false`.
  - Every Skill in that repository was then imported in turn (output
    below). At the first limits, 12 of 20 imported.
    - 7 were refused for binary files or size.
    - `template` is refused because its name (`template-skill`) does not
      match its folder, as the format requires.
  - The first limits were 100 files and 1 MB. They refused `claude-api`
    (92 files, 2.0 MB of text) and `docx`, `pptx` and `xlsx` (about 1.1 MB
    each), so they were raised to 200 files and 4 MB (`b3fd3b9`).
  - Re-run at the new limits, `docx`, `pptx` and `xlsx` import (disabled,
    as they should be). `claude-api` is then refused because its
    description is longer than the format's 1024 characters.
    `canvas-design` (fonts, 5.5 MB) is still over the limits.

### How Postgres and Chromium were run here

There is no Docker in this sandbox, so I used the method of #6 to #34.

- **Postgres:** `@embedded-postgres/linux-x64@18.3.0-beta.16` in
  `/tmp/pg18`, outside the repository, on port 54329.
  - For the unit and integration tests, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at that
    server through `SCRATCH_PG_URL`, with database names unique per worker.
    It was reverted with `git checkout` each time, and nothing from it is
    committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium:** installed with `playwright install chromium`. Its missing
  shared libraries (`libnss3`, `libgbm1`, `libasound2`, `libavahi-client3`…)
  were extracted from Debian bookworm's packages into `/tmp/chromelibs`,
  outside the repository, and used through `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against the embedded Postgres 18.3
  instead, and run in CI.
- **Other browsers:** the folder picker was driven by Playwright in
  Chromium only. Firefox and Safari also support `webkitdirectory`, but
  were not run.

## Notes

- **An upload is an import.** FR-76 asks for review of imported Skills. An
  uploaded folder came from outside AI Office just as a Git repository
  did, and FR-101 calls taking a template "from a file" an import too. So
  both start disabled. Only a Skill written in the editor, which the Owner
  typed, starts enabled.
- **Text only.** The review must show a Skill's full contents, and a binary
  file cannot be read in full, so supporting files must be UTF-8 text. That
  refuses Skills with fonts, images, PDFs or archives: `theme-factory`
  and `web-artifacts-builder` of Anthropic's 20, and `canvas-design`
  (fonts) too. Allowing
  binary assets would need a decision on what reviewing them means; see
  below.
- **Extra frontmatter fields are kept.** The format lists six fields, but
  Claude Code's Skills (which a Floor's `.claude/skills/` will hold, FR-72)
  use more, so unknown fields are kept rather than refused. They are shown
  in review with the rest of `SKILL.md`.
- **ASCII names.** The format's text says "unicode lowercase alphanumeric",
  then lists `a-z` and `0-9`. Names are limited to `a-z0-9-`. They become
  `/skill-name` commands and folder names in sandboxes, so ASCII is the
  safe reading.
- **The review shows plain text.** Rendering `SKILL.md` as Markdown belongs
  to the Available Skills modal (FR-73). For a review, the raw text shows
  exactly what an Agent would be given.
- **Events name the Skill.** Unlike `config.changed` for AI Accounts,
  `skill.*` events carry the Skill's name. It is an identifier from the
  frontmatter, not a credential, and the Activity Feed would be useless
  without it. The bus redacts it like everything else.
- **One Skill per import.** A repository with several Skills asks for one
  folder at a time, rather than importing all of them, each waiting for its
  own review.

## Outside this issue

- **Flaky e2e port clash.** In one of four `pnpm e2e` runs,
  `floors.spec.ts › changes a Floor's settings, then archives it` failed
  with `EADDRINUSE` when its server started. `POST /api/setup` then
  answered 404 from another test's server. That spec and the harness are
  unchanged here, and the next three runs passed. The free-port choice in
  `e2e/support/office.ts` looks racy between workers.
- **Updating an imported Skill.** Taking a newer commit of a Git Skill
  (re-import, with a diff to review) is not built. Today it is delete,
  then import again.
- **Private repositories.** Only public repositories can be imported; URLs
  with credentials are refused. Importing from a Floor's own repository
  with the GitHub App's read-only token fits with Repository Skills (#91).
- **Binary supporting files** (see Notes) need a product decision: perhaps
  allowed under `assets/`, listed with their size and hash, and never
  mounted as instructions.
- **Configuration export (FR-65)** does not exist yet. When it does, it
  should include the Skill library.

## Output

### Fresh clone (`/tmp/clone90`, `42085b8`)

```text
$ pnpm install --frozen-lockfile
Done in 7.5s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  83 passed (83)
      Tests  804 passed | 134 skipped (938)
test exit=0
```

### Against the embedded Postgres 18.3

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  83 passed (83)
      Tests  923 passed | 15 skipped (938)
test exit=0
```

The 15 skips are the migration tests that start their own container, the
real-App GitHub contract (#18), and the Docker image and compose checks.

The Skill tests and the migrations, verbose (timings removed):

```text
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > reads the name, description, other fields and instructions
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > takes Windows line endings, a byte-order mark and an empty body
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > names valid Skills as the format allows
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > refuses names the format does not allow
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > needs a description of 1 to 1024 characters
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > checks the optional fields the format defines
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > needs frontmatter between two --- lines, as a set of fields
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > refuses YAML aliases, so a small file cannot expand
✓ |@ai-office/shared| src/skills.test.ts > SKILL.md frontmatter > starts the editor with a valid Skill
✓ |@ai-office/shared| src/skills.test.ts > a Skill's files > are a SKILL.md and any supporting files
✓ |@ai-office/shared| src/skills.test.ts > a Skill's files > must include a valid SKILL.md at the top of the folder
✓ |@ai-office/shared| src/skills.test.ts > a Skill's files > keeps every path relative and inside the folder
✓ |@ai-office/shared| src/skills.test.ts > a Skill's files > refuses repeated paths, paths that differ only in case, and a file used as a folder
✓ |@ai-office/shared| src/skills.test.ts > a Skill's files > holds only text
✓ |@ai-office/shared| src/skills.test.ts > a Skill's files > stays within the file count and size limits
✓ |@ai-office/shared| src/skills.test.ts > a Skill's files > must be named as its folder, when the folder is known
✓ |@ai-office/shared| src/skills.test.ts > requests > adds a Skill by upload or from the editor, checking its folder's name
✓ |@ai-office/shared| src/skills.test.ts > requests > imports from a public https repository, without credentials
✓ |@ai-office/shared| src/skills.test.ts > requests > changes a Skill's files, or turns it on or off
✓ |@ai-office/orchestrator| src/skills/git.test.ts > gitSkillRepository > reads a Skill's folder at a branch, every file as text
✓ |@ai-office/orchestrator| src/skills/git.test.ts > gitSkillRepository > asks which Skill, when a repository holds several
✓ |@ai-office/orchestrator| src/skills/git.test.ts > gitSkillRepository > takes a repository's only Skill, or the one at its top
✓ |@ai-office/orchestrator| src/skills/git.test.ts > gitSkillRepository > says when there is no Skill to import
✓ |@ai-office/orchestrator| src/skills/git.test.ts > gitSkillRepository > refuses links and binary files rather than reading them
✓ |@ai-office/orchestrator| src/skills/git.test.ts > gitSkillRepository > refuses a folder holding more than a Skill may
✓ |@ai-office/orchestrator| src/skills/git.test.ts > gitSkillRepository > says why a clone failed, and uses HTTPS alone
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in memory > an imported Skill starts disabled, and cannot be enabled until reviewed
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in memory > an uploaded Skill is imported too, and waits for review
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in memory > a Skill written in the editor is the Owner's own, so starts enabled
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in memory > refuses a Skill whose frontmatter is invalid, from any source
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in memory > edits a Skill's files, renaming it from its frontmatter
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in memory > refuses a second Skill of one name, however it arrives
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in memory > lists Skills by name, and removes them
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > an imported Skill starts disabled, and cannot be enabled until reviewed
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > an uploaded Skill is imported too, and waits for review
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > a Skill written in the editor is the Owner's own, so starts enabled
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > refuses a Skill whose frontmatter is invalid, from any source
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > edits a Skill's files, renaming it from its frontmatter
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > refuses a second Skill of one name, however it arrives
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > lists Skills by name, and removes them
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > the Skill library, kept in Postgres 18 > the table itself refuses an enabled Skill that was never reviewed
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > importing from Git > refuses a repository's Skill that is not valid
✓ |@ai-office/orchestrator| src/skills/skills.test.ts > importing from Git > is refused without a repository to import from
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in memory > imports a Skill from Git, disabled until its full contents are reviewed
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in memory > refuses a review of contents that have changed since
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in memory > writes a Skill in the editor, edits it, turns it off and removes it
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in memory > says what is wrong with a Skill, and refuses a second of one name
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in memory > asks which Skill to import, and refuses a URL it will not clone
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in memory > takes a Skill of up to 4 MB
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in Postgres 18 > imports a Skill from Git, disabled until its full contents are reviewed
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in Postgres 18 > refuses a review of contents that have changed since
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in Postgres 18 > writes a Skill in the editor, edits it, turns it off and removes it
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in Postgres 18 > says what is wrong with a Skill, and refuses a second of one name
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in Postgres 18 > asks which Skill to import, and refuses a URL it will not clone
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API, in Postgres 18 > takes a Skill of up to 4 MB
✓ |@ai-office/server| src/skills/routes.test.ts > the Skill library API's access > needs a session, and the CSRF token to change anything
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > says when there are none
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > shows an imported Skill's full contents for review before it can be enabled
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > asks for a fresh review when the Skill changed while it was read
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > imports a Skill from Git, offering the repository's Skills to choose from
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > uploads a Skill's folder as text, without the folder's own name
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > refuses an upload that is not a valid, text-only Skill before sending it
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > writes a Skill in the editor, checking its frontmatter first
✓ |@ai-office/web| src/skills-card.test.tsx > the Skill library in Admin > edits, disables and deletes a Skill, deleting only once confirmed
✓ |@ai-office/db| src/migrate.test.ts > the migrations folder > lists every SQL migration in the journal, in order
✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18
✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > create schema_meta and record the application
✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > are a no-op when run again
✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > hand each test its own database (write)
✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > hand each test its own database (read)
      Tests  70 passed (70)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium), at `b3fd3b9`

```text
Running 17 tests using 8 workers
  ✓ [chromium] › tests/skills.spec.ts:35:1 › writes a Skill, and uploads one that is reviewed before it is enabled (4.8s)
  …the 16 existing specs, each ✓…
  17 passed (17.2s)
```

### Importing every Skill in `https://github.com/anthropics/skills` (commit `9d63080`)

```text
skills/academy-guide         ok (2 files)
skills/algorithmic-art       ok (4 files)
skills/brand-guidelines      ok (2 files)
skills/canvas-design         invalid_skill: A Skill holds at most 100 files and 1 MB; this folder holds more.
skills/claude-api            invalid_skill: A Skill holds at most 100 files and 1 MB; this folder holds more.
skills/discernment-nudge     ok (2 files)
skills/doc-coauthoring       ok (1 files)
skills/docx                  invalid_skill: A Skill holds at most 100 files and 1 MB; this folder holds more.
skills/frontend-design       ok (2 files)
skills/internal-comms        ok (6 files)
skills/mcp-builder           ok (10 files)
skills/pdf                   ok (12 files)
skills/pptx                  invalid_skill: A Skill holds at most 100 files and 1 MB; this folder holds more.
skills/skill-creator         ok (18 files)
skills/slack-gif-creator     ok (7 files)
skills/theme-factory         invalid_skill: "theme-showcase.pdf" is not a text file; Skills hold text only.
skills/web-artifacts-builder invalid_skill: "scripts/shadcn-components.tar.gz" is not a text file; Skills hold text only.
skills/webapp-testing        ok (6 files)
skills/xlsx                  invalid_skill: A Skill holds at most 100 files and 1 MB; this folder holds more.
template                     invalid_skill: The Skill is named "template-skill", so its folder is "template-skill", not "template".
```

This run used the first limits. The five Skills over them, measured
afterwards (files, bytes):

```text
canvas-design files=83 bytes=5554003
claude-api    files=92 bytes=1987276
docx          files=61 bytes=1128695
pptx          files=56 bytes=1139175
xlsx          files=53 bytes=1102893
```

The same five, imported again at the new limits (200 files, 4 MB):

```text
skills/claude-api            invalid_skill: A Skill's description is at most 1024 characters.
skills/xlsx                  ok (53 files, enabled=false)
skills/docx                  ok (61 files, enabled=false)
skills/pptx                  ok (56 files, enabled=false)
skills/canvas-design         invalid_skill: A Skill holds at most 200 files and 4 MB; this folder holds more.
```
