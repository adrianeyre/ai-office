# Issue #152: The Owner's own Floor Templates: duplicate, save from a Floor, import and export — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display). `pnpm lint`, `pnpm typecheck` and `pnpm test`
ran in a fresh `git clone` of this branch at `8240567` (every code, test
and docs commit of the issue before this note), after `pnpm install
--frozen-lockfile`. The Postgres, Playwright and negative-check runs were
made in the working tree at the same code.

The blockers are built on this branch:

- #146, the Role library admin ([`issue-146.md`](issue-146.md)): the
  Roles a template's are copied from, duplicating a Role, and
  `role.created` / `role.changed`;
- #147, Floor Templates ([`issue-147.md`](issue-147.md)): the template
  format, its loader and checks, adding a Floor from a template and the
  picker, with #150 and #151's built-in templates and #153's themes;
- #113, configuration export and import ([`issue-113.md`](issue-113.md)),
  which already carried the Role library and now carries the Owner's
  templates.

## What was built

### A template is the files of its folder, wherever it comes from (`packages/orchestrator`, `templates/files.ts`, new)

The built-in templates were already folders under `templates/`
(`template.yaml`, `roles/<role>.md`, `skills/<name>/…`). This issue makes
that the one shape of every template:

- **`floorTemplateFromFiles(id, files)`** reads a template from its
  folder's files and checks every one: the manifest against the schema,
  each Role's file, each Skill's folder, and the template as a whole (the
  Roles its manifest lists each have a file and no others do, its
  required reviewers are review-Stage Roles, its Roles' Skills are beside
  them). It is #147's loader, moved out of `load.ts` so that nothing in it
  reads the disk. A failure is a `FloorTemplateError` naming the file at
  fault.
- **`loadFloorTemplate`** now reads the folder and calls it, so the
  built-in templates load exactly as before: `load.test.ts`,
  `lint.test.ts`, `online-store.test.ts` and `infrastructure.test.ts`
  pass unchanged.
- **`floorTemplateFiles(template)`** writes a template back as those
  files: `template.yaml`, then each Role's file (frontmatter, then its
  instructions), then each Skill's folder. `roleDocument` and
  `manifestDocument` are its parts.
- **`floorTemplateDigest(files)`**: the SHA-256 of the files by path,
  which a review names.

An export is these files in one JSON document, a Git import reads them
from a repository, and every edit is written as them and read back, so
every template the Owner makes passes the same checks as a built-in one.

### The model (`packages/shared`, `floor-template-library.ts`, new)

- **Sources**: `built-in`, and the Owner's own: `duplicate`, `floor`
  (saved from a Floor), `file` and `git`. `file` and `git` are imported
  and wait for review.
- **`floorTemplateBundleSchema`**, an exported template's file:
  `{format: "ai-office.floor-template", version: 1, exportedAt, id,
  files}`. `files` is the folder, each `{path, content}`: each path once,
  at most 500 files and 8 MB.
- **`floorTemplateDetailSchema`**, `GET /api/floor-templates/:id`: the
  picker's summary plus its source, Git origin, `reviewedAt`, `digest`,
  every Role in full (with its count), settings, the Manager's guidance,
  labels, every Skill with its files, its `clashes`, and when it was made
  and changed (null for a built-in one).
- **Requests**: duplicate (`{name?}`), save a Floor (`{floorId, name,
  description, icon?}`), update (any of `name`, `description`, `icon`,
  `theme`, `roles` as `{role, count}`, `settings`, `manager`, `labels`),
  import a file (`{bundle, name?}`), import from Git (`{url, ref?, path?,
  name?}`, the URL and folder checked as a Skill import's are) and review
  (`{digest}`).
- **Error codes** (`floorTemplateErrorCodes`): `template_not_found`,
  `template_built_in`, `template_name_taken`, `invalid_template`,
  `template_changed`, `role_not_found`, `floor_not_found`,
  `import_failed`, `no_template_in_repository`, `template_path_required`.
- `floorTemplateSummarySchema` (the picker's) gains `builtIn` and
  `enabled`. The manifest's name and description schemas are exported.

### Events (`packages/events`)

- **`floor_template.added`**: id, name, source, the template it was
  duplicated from or the Floor it was saved from (or null), and whether
  it is enabled;
- **`floor_template.changed`**: `edited` with the parts that changed
  (never what they say), `reviewed`, or `replaced` by a configuration
  import;
- **`floor_template.removed`**.

### The database (`packages/db`): migration `0078_owner_floor_templates`

A `floor_templates` table, as drizzle-kit generated it, with a comment:
id (a slug, checked), name (unique whatever its case:
`floor_templates_name_unique` on `lower(name)`), source (checked), the Git
origin's URL, ref, commit and folder (all present exactly when the source
is `git`), `files` (jsonb), `digest` (checked as 64 hex digits),
`reviewed_at` (null while it waits), `created_at` and `updated_at`. The
built-in templates are never rows. `OfficeStores` gains
`floorTemplates`, in memory and in Postgres (`templates/store.ts`).

### The template library (`packages/orchestrator`, `templates/library.ts`, new)

**`createFloorTemplateLibrary`** holds the built-in templates and the
Owner's own:

- **`list()`**: the built-in ones (Development first), then the Owner's
  by name. **`enabled()`**: all but those waiting for review; it is what
  a Floor is added from.
- **`duplicate(id, name?)`**: "<its name> copy", then "copy 2"…, under an
  id made from its name. A copy of a built-in or reviewed template starts
  enabled; **a copy of one waiting for review waits too**, so a review
  cannot be skipped by duplicating.
- **`saveFloor({floorId, name, description, icon?})`**: the Floor's set-up
  as it is:
  - its Roles: those of its Agents (not the Manager, nor one leaving),
    each with how many Agents fill it, in the team's order;
  - its settings: setup and test commands, Merge Policy and Round Cap,
    and as required reviewers the Roles of its required reviewer Agents;
  - the Manager's planning guidance: the Manager's own instructions,
    with no first issue. A template's guidance and first issue were
    joined into them when the Floor was added (`managerInstructionsOf`),
    so a Floor from the saved template gets the same instructions;
  - its theme; and the icon and labels of the template it started from,
    if that is still here (a Floor keeps no record of its labels).
- **`update(id, changes)`**: any of its parts. Roles are given as
  `{role, count}`, each a library Role or one the template holds.
  The `floor_template.changed` event names the parts that changed, and
  nothing changed is no event.
- **`remove(id)`**, **`exportBundle(id)`** (a built-in one too),
  **`importBundle(bundle, name?)`** and **`importFromGit(request)`**.
  An import keeps the file's id (or the folder's name) unless it is taken,
  then the next free one (`corner-shop-2`). It is stored disabled.
- **`review(id, digest)`**: enables it, refused (`template_changed`) if
  its files no longer have that digest.
- **`clashes(template)`**: where its Roles and Skills meet the
  libraries': a Role of the same id that differs (a Floor gets the
  library's), a Role whose name a library Role has under another id
  (adding a Floor is refused until one is renamed), and a Skill of the
  same name that differs (the library's is kept).

How a template is made:

- **It holds its own Roles and Skills**, as a built-in one does. Whenever
  the Owner makes or edits one, each Role is copied in as the Role
  library has it (or as the template holds it, if the library no longer
  has it), and each of their Skills as the Skill library has it. A Skill
  in neither is no longer that Role's.
- **Every template is composed as its files and read back** through
  `floorTemplateFromFiles`, so an edit that would not hold together is
  refused naming why (`invalid_template`: `template.yaml:
  settings.requiredReviewers.0: "reviewer" is a required reviewer, so the
  template starts at least one Agent in it.`).
- **A name another template has**, built-in or the Owner's, whatever its
  case, is `template_name_taken`.
- **A built-in template is read-only**: `update`, `remove` and `review`
  of one are `template_built_in` ("Development is a built-in Floor
  Template, so it is read-only: duplicate it, then change the copy.").

**`Floors`** (`floors/floors.ts`) now takes `templates` as a list or as a
function it calls as each Floor is added. The server passes
`library.enabled()`, so a new or newly reviewed template is offered at
once, and one waiting for review is `template_not_found`. Adding a Floor
from an Owner's template is exactly #147's path: its missing Roles and
Skills join the libraries (Skills enabled, as the template was reviewed),
then the team, settings, labels and theme.

### Importing from Git (`templates/git.ts`, new; `skills/git.ts`)

The Skill import's hardened clone is shared rather than copied:
`withShallowClone` (HTTPS only, no hooks, no LFS filters, no submodules,
a scratch directory deleted afterwards, a time limit),
`findFoldersHolding`, `readTextFolder` (regular text files only, links
refused, within limits) and `linkOnTheWay`. `gitSkillRepository` uses
them with its own messages unchanged (`skills/git.test.ts` passes
unchanged); **`gitTemplateRepository`** looks for `template.yaml` (at the
top, the only one, or the folder named), and asks which when there are
several.

### Configuration export and import (`shared/configuration.ts`, `orchestrator/configuration/configuration.ts`)

- The document gains **`floorTemplates`**: each of the Owner's templates
  as `{id, source, origin, files, enabled}`. The built-in ones ship with
  AI Office, so they are not in it. It defaults to `[]`, so an export
  from before reads as having none.
- **Importing** previews each as a `floor_template` change. One that
  arrives, or whose files or source differ from the template of its id
  here, is added (or replaced) **disabled, whatever the document says**,
  with the note "It waits for your review before a Floor can be added
  from it."; replacing is a `floor_template.changed` with `replaced`.
- **Problems that stop an import**: files that are not a valid template,
  an id that is a built-in template's, a name another template here has,
  and a source of `git` without an origin (or the other way round).
- The Admin page's configuration preview names the area "Floor
  Templates".

### The server (`apps/server`, `floor-templates/routes.ts`, new)

`GET /api/floor-templates` moved here from the Floor routes and lists
every template, with `builtIn` and `enabled`. Besides it:

| Route | What it does |
| --- | --- |
| `GET /api/floor-templates/:id` | full contents and clashes |
| `POST /api/floor-templates` | saves a Floor (`201`) |
| `POST /api/floor-templates/:id/duplicate` | `201` with the copy |
| `PATCH /api/floor-templates/:id` | edits one of the Owner's |
| `DELETE /api/floor-templates/:id` | `204` |
| `GET /api/floor-templates/:id/export` | the file, as `<id>.floor-template.json` |
| `POST /api/floor-templates/import` | from a file (`201`; body limit 32 MB) |
| `POST /api/floor-templates/import/git` | from Git (`201`) |
| `POST /api/floor-templates/:id/review` | enables one, naming its digest |

Statuses: `404` not found (template or Floor), `409` built in, name taken
or changed since read, `422` invalid, a Role not found, no template in the
repository or several, `502` a clone that failed. Each change is logged
without its contents. `buildApp` gives the library a Git reader over
HTTPS into the OS's temporary directory, and the configuration service
the built-in templates.

### The web app (`apps/web`)

- **Admin → Floor Templates** (`/admin/templates`, `floor-templates-page.tsx`,
  new), linked from a card on the Admin page that counts the built-in
  templates, the Owner's own and those waiting:
  - a table of every template: its icon and name, its kind (**Built
    in**, **Yours**, **Waiting for review**), its starting team, and
    **Open** (or **Review**), **Duplicate**, **Export** (a download link)
    and, for the Owner's own, **Delete** with a confirmation;
  - a built-in template opens read-only, with its full contents;
  - one of the Owner's opens in an **editor**: name, description, icon,
    3D theme; Roles and counts (each Role named with its Stage, removed,
    or added from the Role library); setup and check commands, Merge
    Policy, Round Cap and required reviewers (checkboxes for its
    review-Stage Roles with Agents); the Manager's planning guidance and
    an optional first issue; labels. Saving sends only the parts that
    changed. Its full contents are below, folded;
  - an imported one opens its **review**: where it came from (and the
    commit, for Git), its clashes, and its full contents: settings, the
    Manager's guidance and first issue, labels, every Role with its
    Stage, count, suggestions, Skills and instructions, and every Skill
    with each file. **I have read it: enable <name>** sends the digest of
    what is shown;
  - **Import a Floor Template**: an exported file (checked in the browser
    first) or a Git repository's URL, branch or tag and folder, each with
    an optional name. The imported template's review opens.
- **A Floor's admin page** has **Save as a Floor Template** (a name and a
  description), which says what was saved ("Saved Web team: Manager, 2 ×
  coder, reviewer, QA, docs.") and links to it.
- **The picker** offers only enabled templates.
- **The Activity Feed** reads the new events ('Floor Template "Web team"
  saved from the web-shop Floor's set-up.', '… imported from a file; it
  waits for review before a Floor can be added from it.', '… changed:
  Roles and counts, Manager's guidance, 3D theme.', '… reviewed and
  enabled: a Floor can be added from it.', '… deleted. Floors added from
  it keep everything it set up.'), filtered under "Floor Templates".

### Docs

- README, "Floor Templates": the Owner's own templates, and the guide's
  table entry.
- [Floors and Agents](../guide/floors-and-agents.md): a section "Your own
  Floor Templates" (duplicating and editing, saving a Floor and what it
  takes, each template holding its own Roles and Skills, the export file,
  importing from a file or Git, the review and its clashes, deleting, the
  events, the storage and the API), and the list API's new fields.
- [Running AI Office](../guide/running.md), configuration export and
  import: the templates in it, and that imported ones wait for review.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 in a fresh clone at `8240567` (output below):
  - without Docker: **382 files, 4208 passed, 565 skipped** (the Postgres
    and Mailpit tests skip with the reason);
  - against an embedded **Postgres 18.4**, in the working tree: **4745
    passed, 27 skipped, 1 failed**. The failure is
    `batches/batches.test.ts` > "at the Kickoff, an Agent whose Model
    cannot be asked is acknowledged for by AI Office's rules…" in
    Postgres. It fails the same way, alone, on the base commit `e0b41ae`
    (2 of 2 runs) as on this branch (3 of 3); this issue changes nothing
    it uses (see "Noticed, out of scope"). The 27 skipped are the GitHub
    contract against the real App and the checks that need Docker or
    Mailpit.
  - In earlier full runs here, `scene/grilling-room.test.tsx` failed once
    and passed alone: the flaky test #133, #134 and #137's notes record.

- [x] **Integration test: export then import round-trips a template.**
  `packages/orchestrator/src/templates/library.test.ts` > "export then
  import round-trips a template saved from a Floor, with its Roles and
  Skills", in memory and in Postgres 18 (each "office" its own database):
  1. A Floor is added from Corner shop (#147's fixture: 2 merchandisers, a
     brand reviewer, a Skill, a label, guidance and a first issue). The
     Owner makes a proofreader Role, with the `price-check` Skill, and adds
     a proofreader Agent to it.
  2. `saveFloor` gives "My shop" (`my-shop`): Roles merchandiser ×2,
     brand-reviewer ×1, proofreader ×1; the Floor's settings and its
     required reviewer's Role; the Manager's instructions as guidance; the
     template's label and icon; the Floor's theme; the `price-check`
     Skill; one `floor_template.added` event naming the Floor.
  3. The export, through JSON and `floorTemplateBundleSchema`, holds
     `template.yaml`, the three Roles' files and `skills/price-check/SKILL.md`.
  4. Imported into **another office**, the template is **equal** to the
     saved one, with the same digest and no clashes. Reviewed, a Floor is
     added from it there: the same team, settings and theme; the
     proofreader joins that library exactly as it was here; `price-check`
     joins its Skill library, enabled. Exported again from there, the
     files are the same.

  `templates/files.test.ts`: **every built-in template** written as its
  files reads back as the same template, and the files are the same
  written again (so the digest is stable). The API does the same round
  trip: `apps/server/src/floor-templates/routes.test.ts` > "saves a Floor
  as a template, exports it to a file and imports it back…", in memory
  and in Postgres 18 (the download's `content-disposition`, the full
  instructions and Skill files after the import, and the events). The
  configuration document carries the Owner's templates too
  (`configuration/configuration.test.ts` > "the Owner's own Floor
  Templates are in it, and an imported one waits for review", in memory
  and into Postgres 18).

- [x] **Integration test: an imported template is disabled until
      reviewed.** `library.test.ts` > "an imported template is disabled
      until the Owner reviews its full contents", in memory and Postgres:
  - Corner shop's export under its own name is refused: 'Another Floor
    Template is called "Corner shop": give this one another name.'
  - Imported as "Imported shop", it is `corner-shop-2`, `enabled: false`,
    `reviewedAt: null`. `enabled()` lists only the built-in three, and
    adding a Floor from it is `template_not_found`.
  - Its copy is disabled too.
  - A review naming another digest is `template_changed`. After an edit,
    a review naming the digest from before it is `template_changed` as
    well, and it stays disabled.
  - A review naming the current digest enables it, and a Floor is added
    from it with its team.
  - The four events, exactly: added (disabled), the copy added
    (disabled), changed (`edited`, `description`), changed (`reviewed`).

  Through the API: an imported template is listed `enabled: false`;
  `POST /api/floors` with it is `422 template_not_found`; a stale review
  is `409 template_changed`; the right one enables it, and the Floor is
  added. A configuration import adds it disabled whatever the document
  says, and replaces a changed one, disabled again.

- [x] **Integration test: a built-in template cannot be edited in
      place.** `library.test.ts` > "a built-in template cannot be edited in
      place; it is duplicated and the copy edited", in memory and Postgres:
  - Changing Development's Roles, renaming it, deleting it and reviewing
    it are each `template_built_in`: "Development is a built-in Floor
    Template, so it is read-only: duplicate it, then change the copy."
  - Development reads the same afterwards, and there is no event.
  - Its duplicate, "Development copy", equals it but for its id and name.
    Edited to 2 coders, a reviewer and QA, Round Cap 5 and the `studio`
    theme, it is one `edited` event with `theme`, `roles` and `settings`.
  - A Floor from the copy has that team and those settings. A Floor added
    without a choice is still Development's.
  - Deleting the copy leaves its Floor with `{id: "development-copy",
    name: "Development copy"}` and all five Agents.

  Through the API (`routes.test.ts`, in memory and Postgres): `PATCH` and
  `DELETE` of `development`, and its review, are `409 template_built_in`
  with that message, and it reads the same afterwards. Its duplicate is
  edited, an edit that does not hold together is `422 invalid_template`
  naming why, a name a built-in template has is `409
  template_name_taken`, and a Floor from the copy has its team.

- [x] **Playwright: save a Floor as a template, then add a new Floor
      from it.** `e2e/tests/floor-templates.spec.ts` passes in Chromium
      against the built app, Postgres 18.4 and the fake GitHub:
  1. web-shop is added from Development. In Agent Settings its team
     becomes 2 coders and a docs Agent (6 Agents); on its admin page,
     Merge Policy auto-merge, Round Cap 4 and the test command `pnpm
     test`.
  2. **Save as a Floor Template**, "Web team", says "Saved Web team:
     Manager, 2 × coder, reviewer, QA, docs." and links to it.
  3. On the Floor Templates page it is "Yours", with that starting team,
     and its editor has auto-merge, Round Cap 4, `pnpm test` and a coder
     count of 2.
  4. In Admin's picker, "Web team" is described by its description and
     starting team. Picked, adrianeyre/blog is added: "started from Web
     team".
  5. blog's admin page says "It started from the Web team Floor
     Template." and has auto-merge, Round Cap 4 and `pnpm test`. Its
     Agent Settings has 6 Agents: a Manager, 2 coders, a reviewer, QA and
     docs.
  6. The Activity Feed has 'Floor Template "Web team" saved from the
     web-shop Floor's set-up.' and 'Floor "blog" added for
     adrianeyre/blog, from the Web team Floor Template.'.

**The rest of "What to build", and how it was checked:**

- **Duplicate and edit a template's Roles and counts, settings,
  guidance, labels and theme**: the library and API tests above; the
  web page's tests (`floor-templates-page.test.tsx`, 5 tests): a built-in
  template opens read-only with its Roles' instructions, **Duplicate**
  opens the copy's editor, and an edit (a coder count, the theme, a Role
  added and one removed) sends exactly `{theme, roles}`. The API test
  edits Roles, settings, guidance, labels and theme together.
- **Import from a Git repository**: `templates/git.test.ts` (4 tests,
  real Git against repositories on disk over `file://`, which only the
  tests allow): a template's folder at a path, which imports as
  `corner-shop`, `source: "git"`, with its origin and commit, disabled;
  several templates ask for a folder, listing them, and one at the top
  is the repository's; none there, a symbolic link
  (`"roles/secret.md" is a symbolic link; a Floor Template holds files
  only.`), a clone that fails, and a stray file refused with its path.
  `skills/git.test.ts` passes unchanged on the shared clone. The API
  refuses a URL that is not HTTPS (`400`). Git over HTTPS to a real host
  is for the host (below).
- **Its full contents for review, and name clashes reported**: the
  page's test shows an imported template's Role instructions, Skill
  file, guidance and first issue, where it came from, and its clash; and
  **I have read it: enable** sends its digest, then the row reads
  "Yours". `library.test.ts` > "reports where an imported template's
  Roles and Skills clash with the libraries'" gives the three clashes
  word for word (a Role of the same id that differs, a Role name under
  another id, a Skill that differs). Template name clashes are refused
  on import and on rename, in the library, the API and the configuration
  import.
- **Stored in AI Office**: `floor_templates`, through every Postgres run
  above. The migration was generated by drizzle-kit, and `migrate.test.ts`
  applies every migration in Postgres.
- **Built-in templates are read-only and can be duplicated**: above, and
  the page offers no **Delete** for one.
- **Every add, change or removal to the Activity Feed**: the events in
  each test above; `activity-feed.test.tsx` > "says what happened to each
  of the Owner's Floor Templates" checks all eight wordings; and the
  events schema test lists the new `floor_template` family.
- **Templates and Roles in configuration export and import**: the Role
  library was already in it (#113, #146); the templates now are
  (`configuration.test.ts` above; `shared/configuration.test.ts` reads an
  export from before as having none and refuses a template twice; the
  Admin card's test posts `floorTemplates: []`).
- **The picker** offers only enabled templates: `floors.test.tsx`'s
  picker now has an imported template waiting, and its radios are
  `development` and `blank` only.
- **Accessibility**: `e2e/tests/accessibility.spec.ts` now checks the
  Floor Templates page, and a copy of Development open in its editor
  with its full contents, with axe in light and dark. Both pass. The
  first run found the page's report list had lost its list role to
  `role="status"`; the status now wraps the list.

**Negative checks.** Each sabotage was applied to the working tree, the
named tests run, then reverted with `git checkout` (`git status` clean
after each).

| Sabotage | Tests | Failed |
| --- | --- | --- |
| An imported template starts enabled | `templates/library.test.ts`; server `floor-templates/routes.test.ts` (in memory) | 2 of 4; 2 of 3 |
| A copy of a template waiting for review starts enabled | `library.test.ts` | 1 of 4 |
| A review ignores the digest | `library.test.ts`; server `routes.test.ts` | 1 of 4; 1 of 3 |
| A built-in template is not read-only | `library.test.ts`; server `routes.test.ts` | 1 of 4; 1 of 3 |
| An export leaves out the Skills | `files.test.ts` + `library.test.ts`; server `routes.test.ts` | 5 of 7; 1 of 3 |
| Saving a Floor counts one Agent per Role | `library.test.ts`; server `routes.test.ts`; `e2e/tests/floor-templates.spec.ts` | 1 of 4; 1 of 3; 1 of 1 |
| A configuration import enables the templates it brings | `configuration/configuration.test.ts` (in memory) | 1 of 8 |
| The picker offers templates waiting for review | web `floors.test.tsx` | 1 of 29 |
| The page's review sends another digest | web `floor-templates-page.test.tsx` | 1 of 5 |

### `pnpm e2e`

The whole suite (55 tests) ran with 3 workers against the embedded
Postgres 18.4: **51 passed, 4 failed**. All four fail the same way on the
base commit `e0b41ae`, run in a worktree of it here:

- `accessibility.spec.ts` > "the 3D Office's panels" (light and dark):
  `page.goto` of `/?floor=web-shop&inspect=wall-board:web-shop` is
  `net::ERR_ABORTED` while the CPU draws the scene. At `e0b41ae`: 2 of 2
  failed, on the same line.
- `floors.spec.ts` > "adds a Floor from the Floor Template picked" and
  `role-library.spec.ts`: both look on a Floor's admin page for its Agents
  table and Add Agent form, which an earlier merge moved to Agent
  Settings. At `e0b41ae`: both failed on the same lines (103 and 74). In
  `floors.spec.ts` everything this issue touches passes first: the
  picker's 10 radios (no template of the Owner's was made), each one's
  description and adding Floors from Blank and Development.

This issue's spec passes, and so do the specs it touches or that read
the Admin page: `floor-templates.spec.ts`, `accessibility.spec.ts`'s
other tests (the editors in light and dark included), `activity.spec.ts`,
`floor-admin.spec.ts`, `phone.spec.ts` and `skills.spec.ts`.

### How Postgres and Chromium were run here

As for earlier issues, outside the repository:

- **Postgres**: `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4) in `/tmp/pg18`, on port 54329.
  - For `pnpm test`, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at it
    through `SCRATCH_PG_URL`, with database names unique per test file.
    It was reverted with `git checkout` after each run and never
    committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`.
- **Chromium**: from `playwright install chromium`. Its missing shared
  libraries (`libnss3`, `libgbm1`, `libcups2` and the others) came from
  Debian bookworm's packages, downloaded from `deb.debian.org`,
  extracted to `/tmp/chromelibs` and put on `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`. Both ran against the embedded Postgres 18.4 instead; they run in
  CI.
- **Importing from a real Git host over HTTPS.** The import is tested
  with real Git against repositories on disk (`file://`, which only the
  tests allow). Cloning from, say, GitHub over HTTPS through the app
  image's Git is the same code path as a Skill's import, and is for the
  host.
- **The 3D Office**: a Floor from an Owner's template is dressed in the
  template's theme, which is #153's code and data. No GPU here, and this
  issue changes nothing the scene draws.

### Verified on the host

Nothing in this issue needs the host beyond the Git import above.

## Notes

- **An Owner's template holds its own copy of its Roles and Skills**,
  as a built-in one does, rather than naming library Roles. So an export
  is whole, an import has something to show for review, and nothing
  depends on the libraries later (FR-97). The copies are taken from the
  libraries whenever the Owner makes or edits a template, because a Floor
  added from it gets the library's Role where the library has one: the
  template should say what the Floor will get. An imported template keeps
  the file's copies until the Owner edits it.
- **"Enabled" is "reviewed".** An Owner's template is enabled exactly
  when it has been reviewed (`reviewed_at`): one the Owner made is
  reviewed as it is made, and an imported one once they read it. There is
  no separate switch to turn a template off; deleting it does that.
- **Adding a Floor from a template waiting for review** is `422
  template_not_found` ("There is no Floor Template …"), #147's error, as
  `Floors` is given only the enabled templates. The picker never offers
  one, so only the API can ask.
- **Saving a Floor takes its labels and icon from the template it
  started from**, if that is still here, since a Floor keeps no record of
  its labels; otherwise none and the `code` icon. Agents' own AI
  Providers, Models, effort, instructions and Token Caps are not part of
  a template (FR-99): a new Floor's Agents start on their Roles'
  suggestions.
- **An export is the built-in folder format in JSON** (`{path,
  content}` per file), so the same parser reads the built-in templates,
  files and Git. A file exported here can be unpacked into `templates/`
  as a new built-in template.
- **The Role library keeps only built-in templates' starting Roles**
  (`role_in_starting_team`). An Owner's template carries its Roles, so
  deleting one from the library does not break the template: a Floor
  from it brings the Role back.
- **Git imports share the Skill import's clone** (`withShallowClone`,
  `readTextFolder`), so the same protections hold; its scratch
  directories are now `git-import-*` rather than `skill-import-*`.

## Noticed, out of scope

- **A Floor added from a template waiting for review** could say that it
  waits, rather than that there is no such template.
- **The Role library page's report list** has the same `<ul
  role="status">` that axe flagged on this page; its accessibility check
  never shows a report, so it has not been flagged there.
- **Four end-to-end tests fail on this branch before this issue** (see
  `pnpm e2e`): the 3D Office's panels in light and dark, and the
  `floors.spec.ts` and `role-library.spec.ts` steps that look for a
  Floor's Agents on its admin page, which now live in Agent Settings.
- **`batches.test.ts`'s Kickoff case fails in Postgres** on this branch
  and on `e0b41ae` alike ("expected … to have a length of 2 but got 1"
  acknowledgements).
- **A public template gallery** is out of scope, as the issue says.

## Output

### `pnpm lint` and `pnpm typecheck`, fresh clone at `8240567`

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0

$ pnpm typecheck
packages/db typecheck: Done
packages/shared typecheck: Done
packages/github typecheck: Done
packages/events typecheck: Done
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`, without Docker, fresh clone at `8240567`

```text
$ pnpm test
 Test Files  382 passed (382)
      Tests  4208 passed | 565 skipped (4773)
   Duration  60.58s (tests 43%, import 38%, environment 10%, transform 8%, setup 1%)
test exit 0
```

### `pnpm test` against the embedded Postgres 18.4, at `8240567`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=4
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
AssertionError: expected [ { …(6) } ] to have a length of 2 but got 1
 ❯ cases.ada.ada src/batches/batches.test.ts:1835:32
 Test Files  1 failed | 381 passed (382)
      Tests  1 failed | 4745 passed | 27 skipped (4773)
   Duration  279.59s (tests 79%, import 15%, environment 4%, transform 1%, setup 1%)
test exit 1
```

The same file alone, on this branch and on the base commit:

```text
# this branch, 3 runs
      Tests  1 failed | 31 passed (32)
      Tests  1 failed | 31 passed (32)
      Tests  1 failed | 31 passed (32)
# e0b41ae, 2 runs
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
      Tests  1 failed | 31 passed (32)
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
      Tests  1 failed | 31 passed (32)
```

### This issue's tests (verbose), in memory and Postgres 18.4

```text
$ SCRATCH_PG_URL=… vitest run src/templates src/configuration src/floors     # packages/orchestrator
 Test Files  10 passed (10)
      Tests  120 passed (120)
 ✓ src/templates/library.test.ts > the Owner's own Floor Templates > kept in memory > export then import round-trips a template saved from a Floor, with its Roles and Skills
 ✓ … > kept in memory > an imported template is disabled until the Owner reviews its full contents
 ✓ … > kept in memory > a built-in template cannot be edited in place; it is duplicated and the copy edited
 ✓ … > kept in memory > reports where an imported template's Roles and Skills clash with the libraries'
 ✓ … > kept in Postgres 18 > export then import round-trips a template saved from a Floor, with its Roles and Skills
 ✓ … > kept in Postgres 18 > an imported template is disabled until the Owner reviews its full contents
 ✓ … > kept in Postgres 18 > a built-in template cannot be edited in place; it is duplicated and the copy edited
 ✓ … > kept in Postgres 18 > reports where an imported template's Roles and Skills clash with the libraries'
$ SCRATCH_PG_URL=… vitest run src/floor-templates src/floors src/configuration   # apps/server
 ✓ src/floor-templates/routes.test.ts > … > in memory > saves a Floor as a template, exports it to a file and imports it back, disabled until it is reviewed
 ✓ … > in memory > a built-in template cannot be edited in place; a duplicate of it can
 ✓ … > in memory > refuses what it cannot do: an unknown template, a clashing name, a malformed file, and anyone signed out
 ✓ … > in Postgres 18 > saves a Floor as a template, exports it to a file and imports it back, disabled until it is reviewed
 ✓ … > in Postgres 18 > a built-in template cannot be edited in place; a duplicate of it can
 ✓ … > in Postgres 18 > refuses what it cannot do: an unknown template, a clashing name, a malformed file, and anyone signed out
      Tests  39 passed (39)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.4, Chromium), at `8240567`

```text
$ pnpm build && playwright test --workers=3
Running 55 tests using 3 workers
    Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
    > 402 |       await page.goto(address);
    Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
    > 402 |       await page.goto(address);
    Error: expect(locator).toHaveCount(expected) failed
    > 103 |   await expect(blogAgents.getByRole("row", { name: /Manager/ })).toHaveCount(1);
    Error: locator.selectOption: Test timeout of 30000ms exceeded.
    > 74 |   await add.getByLabel("Role").selectOption("proofreader");
  4 failed
    [chromium] › tests/accessibility.spec.ts:360:3 › the 3D Office's panels (light)
    [chromium] › tests/accessibility.spec.ts:360:3 › the 3D Office's panels (dark)
    [chromium] › tests/floors.spec.ts:53:1 › adds a Floor from the Floor Template picked
    [chromium] › tests/role-library.spec.ts:17:1 › makes a proofreader Role, adds a proofreader Agent to a Floor, then edits the Role's instructions
  51 passed (5.3m)
```

The same four at the base commit `e0b41ae`, in a worktree of it:

```text
$ playwright test tests/accessibility.spec.ts -g "3D Office" --workers=1
    Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
    Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
  2 failed
    [chromium] › tests/accessibility.spec.ts:354:3 › the 3D Office's panels (light)
    [chromium] › tests/accessibility.spec.ts:354:3 › the 3D Office's panels (dark)
$ playwright test tests/floors.spec.ts tests/role-library.spec.ts --workers=2
    > 103 |   await expect(blogAgents.getByRole("row", { name: /Manager/ })).toHaveCount(1);
    > 74 |   await add.getByLabel("Role").selectOption("proofreader");
  2 failed
    [chromium] › tests/floors.spec.ts:53:1 › adds a Floor from the Floor Template picked
    [chromium] › tests/role-library.spec.ts:17:1 › makes a proofreader Role, adds a proofreader Agent to a Floor, then edits the Role's instructions
  2 passed (40.1s)
```

This issue's spec, and the axe checks of its page:

```text
$ playwright test tests/floor-templates.spec.ts --workers=1
[1/1] [chromium] › tests/floor-templates.spec.ts:8:1 › saves a Floor as a template, then adds a new Floor from it
  1 passed (6.5s)
$ playwright test tests/accessibility.spec.ts -g "editors and forms|3D Office" --workers=1
[3/4] [chromium] › tests/accessibility.spec.ts:410:3 › the editors and forms that open in place (light)
[4/4] [chromium] › tests/accessibility.spec.ts:410:3 › the editors and forms that open in place (dark)
  2 failed      (the 3D Office's panels, as above)
  2 passed (7.0m)
```
