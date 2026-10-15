# Issue #147: Floor Templates: the template format, Development and Blank, and the picker — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in the working tree of this branch. `pnpm
lint`, `pnpm typecheck` and `pnpm test` (without Docker) ran at `7928748`,
the last code commit. The Postgres runs, `pnpm e2e` and the negative checks
ran at `884fcb6`, whose only later change is the type of one test helper's
return value in `apps/server/src/floors/templates.test.ts`.

The blockers are built on this branch:

- #145, Roles as data ([`issue-145.md`](issue-145.md)), with #146's Role
  library admin ([`issue-146.md`](issue-146.md)): the `roles` table,
  `RoleStore`, and Agents in library Roles on four Stages. A template's
  Roles are added to this library;
- #20, Floors ([`issue-20.md`](issue-20.md)): adding a Floor from an
  installed repository, which now takes a template;
- #61, the Floor admin's team ([`issue-61.md`](issue-61.md)): team size
  per Role and Add Agent, which put a Blank Floor's team together.

## What was built

### The template format (`packages/shared`, `floor-templates.ts`, new)

A template is a folder under `templates/`, and the folder's name is the
template's id:

```text
templates/<id>/template.yaml          the manifest
templates/<id>/roles/<role id>.md    each of its Roles
templates/<id>/skills/<name>/…       each of its Skills (SKILL.md and its files)
```

**`floorTemplateManifestSchema`** checks `template.yaml` (FR-99). Its
fields:

| Field | What it holds |
| --- | --- |
| `name` | at most 40 characters, one line |
| `description` | one line, at most 200 characters |
| `icon` | one of `floorTemplateIcons`: ten lucide icon names, which the web app draws |
| `theme` | the 3D theme id, a slug |
| `roles` | `{role, count}` each, count 0 to 10; 0 brings a Role into the library without an Agent |
| `settings` | `setupCommand`, `testCommand`, `mergePolicy`, `roundCap` and `requiredReviewers` (Role ids) |
| `manager` | `planningGuidance`, and `firstIssue` (`{title, body}` or null) |
| `labels` | `{name, color, description}` each |

The schema refuses:

- a Role listed twice;
- a required reviewer the template starts no Agent in;
- one of AI Office's own labels (`ai-office`, the Stage labels and the
  others), a label listed twice whatever its case, and a colour that is not
  six hex digits;
- Manager's instructions longer than an Agent's extra instructions (4000
  characters);
- an unknown field.

Other parts of the module:

- **`parseRoleDocument(id, text)`** reads `roles/<id>.md`. Its YAML
  frontmatter holds the name, Stage, description, Skills, desk dressing
  and suggested AI Provider and Model; the Markdown below it is the
  instructions, exactly as a Stage's prompt carries them. It is checked
  with the Role library's own `createRoleRequestSchema`, so a template
  Role obeys the same rules as one the Owner makes.
- **`managerInstructionsOf(manager)`** joins the planning guidance and
  the suggested first set-up issue into the Manager's own instructions.
  It gives an empty string when the template has neither.
- **`floorTemplateSummarySchema`** and **`floorTemplateListSchema`** are
  the picker's API.
- In `floors.ts`:
  - `templateIdSchema` and `developmentTemplateId`;
  - `floorTemplateRefSchema`, and the Floor's `template: {id, name}`;
  - `addFloorRequestSchema` takes an optional `template`;
  - two new error codes, `template_not_found` and
    `template_role_name_taken`.
- `splitFrontmatter` in `skills.ts` is now exported, for Role files.

### The built-in templates (`templates/`, new)

- **Development**: coder, reviewer and QA, one Agent each, in
  `roles/coder.md`, `roles/reviewer.md` and `roles/qa.md`.
  - Each file's Role is exactly the built-in Role (`builtInRoles`): the
    same instructions, character for character, and the same suggestions.
  - Its settings are no setup or test command, "send to me" and Round
    Cap 3, with the reviewer as required reviewer.
  - Its Manager has no planning guidance and no first issue, and it brings
    no labels. Its icon is `code` and its theme `office`.
- **Blank**: no Roles, the same settings, and no required reviewer.
  - Its planning guidance tells the Manager that the Floor has no Agents
    yet, and to say which Roles to add before planning work.
  - Its icon is `square` and its theme `office`.

### Loading them (`packages/orchestrator`, `templates/load.ts`, new)

**`loadFloorTemplates(root)`** loads every template, Development first and
then the rest by name. It checks:

- that every file under `templates/` belongs to a template;
- that each template has a manifest;
- each manifest, Role file and Skill folder (with the Skill library's own
  `skillProblems`);
- that a template holds together:
  - each Role it lists has a file, and no other Role does;
  - its required reviewers are review-Stage Roles;
  - its Roles' Skills are in its `skills/` folder;
  - no two of its Roles share a name;
- that a Role two templates both bring is the same in both, and that no
  two templates' Roles share a name under different ids.

Any problem throws a **`FloorTemplateError`** with the `path` of the file
at fault, and its message starts with that path.

`builtInTemplatesDir` is `templates/` beside the sources, so the
Dockerfile now copies `templates` into the app image, and
`docker/deployment.test.ts` checks that it does.

### Adding a Floor from a template (`packages/orchestrator`)

**`Floors.add(repository, template?)`** works through these steps, using
Development when no template is given:

1. A template there is not is `template_not_found`.
2. **Roles.** The template's Roles that the library has no Role of that id
   for are added to it.
   - A Role the library already has, perhaps edited by the Owner, is kept
     as it is.
   - A missing Role whose name another Role has, under another id, is
     `template_role_name_taken`. This is checked before anything changes.
   - Each Role added is a `role.created` event, with `template: {id,
     name}`.
3. **Labels.** The template's labels are created on the repository
   (`ensureLabel`, which leaves an existing label as it is).
4. **Team.** **`templateTeam`** (`agents/agents.ts`, new) gives the Floor:
   - a Manager, whose extra instructions are `managerInstructionsOf`;
   - then each Role as many times as its count, in the manifest's order,
     each Agent on its Role's suggested AI Provider and Model as the
     library has them.

   The Agents are made with the same names, Avatars and timestamps as
   `defaultTeam`.
5. **Settings.** The template's setup and test commands, Merge Policy and
   Round Cap. The required reviewers are its `requiredReviewers` Roles'
   Agents.
6. **The record.** The Floor records `template: {id, name}` as it was
   then, and `floor.created` carries it.

When no templates are given (`templates` absent), `add` is the code as it
was before: `defaultTeam` and the default settings, recorded as
Development. Many existing tests use this path, and so does the
"before templates existed" side of the comparison below.

**`FloorRecord.template`**: the memory store copies it, and the database
store reads and writes `template_id` and `template_name`.

**The Role library** (`roles/library.ts`) takes `templates`. A Role is
`inStartingTeam` while a template starts Floors with Agents in it, so
#146's note is now met: "should follow them". Deleting such a Role is
refused with `role_in_starting_team`, naming the template ("The
Development Floor Template starts Floors with a coder Agent…"). Without
`templates`, the starting team is Development's, as before.

### The database (`packages/db`): migration `0068_floor_templates`

(Written as `0046`, renumbered after main's `0044`–`0049` in
[the merge note](merge-main-into-131-to-153.md).)

`floors.template_id text NOT NULL DEFAULT 'development'` and
`floors.template_name text NOT NULL DEFAULT 'Development'`, as drizzle-kit
generated them, with a comment. Every existing Floor is recorded as
Development (FR-97).

`testing/migrations.ts` (new) holds `migrationsBefore` and `migrateUpTo`,
moved out of `roles-migration.test.ts`, which now uses them.

### Events (`packages/events`)

`floor.created` and `role.created` take an optional `template: {id,
name}`. It is optional, so stored events from before still parse; a test
checks this.

### The server (`apps/server`)

- **`GET /api/floor-templates`** returns the templates, Development first,
  each with its starting team, plus `defaultTemplate: "development"`. The
  team is the Manager, then each Role the template starts Agents in, with
  that Role's name and Stage as the library has them.
- **`POST /api/floors`** takes `template`. An unknown one is `422
  template_not_found`; a template Role whose name is taken is `409
  template_role_name_taken`.
- `buildApp` loads the built-in templates unless given `templates`. A
  broken template stops AI Office starting with "AI Office failed to
  start: <path>: <problems>".

### The web app (`apps/web`)

- **The picker.** Admin's **Add a Floor** has a **Floor Template** radio
  group. Each choice shows its icon, name, description and starting team
  ("Starting team: Manager, coder, reviewer, QA"), and Development is
  chosen at first.
  - Each radio is named by the template's name and described by its
    description and team (`aria-describedby`).
  - **Add Floor** sends the template chosen, and stays disabled until the
    templates have loaded. If they fail to load, the picker says so and a
    Floor is added from Development.
- **The template a Floor started from** is shown in:
  - the **Floors in use** list ("blog adrianeyre/blog · started from
    Blank");
  - the Floor admin page ("It started from the Blank Floor Template.").
- **The Activity Feed**:
  - 'Floor "blog" added for adrianeyre/blog, from the Blank Floor
    Template.';
  - 'Role "merchandiser" added to the library by the Online store Floor
    Template, in the work Stage.'.

  Events from before templates read as they did.
- The Role library's disabled **Delete** now says "A Floor Template starts
  Floors with a coder Agent, so it stays."

### Docs

- README: a "Floor Templates" section, and `templates/` in the
  documentation table.
- [Floors and Agents](../guide/floors-and-agents.md): "Floor Templates"
  (new) covers the picker, what adding a Floor from a template does,
  Development and Blank, the format with an annotated `template.yaml`,
  loading and its errors, the API and events.
- [Setting up a Floor](../processes/setting-up-a-floor.md): pick a
  template in step 4, and a template's own labels.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.**
  - `pnpm lint` and `pnpm typecheck` exit 0.
  - `pnpm test` without Docker: **244 files, 2801 passed, 397 skipped**
    (the Postgres cases, skipped with the reason), exit 0.
  - Against an embedded **Postgres 18.3** (below): **244 files, 3176
    passed, 22 skipped**, exit 0.
    - The 22 skipped are the GitHub contract against the real App (it
      needs `GITHUB_APP_ID`) and the checks that need Docker.
    - The work-queue test that is known to flake (`issue-83.md`,
      `issue-146.md`) passed this time.

- [x] **Unit tests: every file under `templates/` passes the schema; a
      broken manifest fails with its path.**
  `packages/orchestrator/src/templates/load.test.ts` (11 tests):
  - **"every file under templates/ passes the schema, as part of its
    template"**:
    - the built-in templates load as `development` then `blank`;
    - every file found by walking `templates/` is one of the files a
      template was loaded from, and the two lists are equal, so no file
      goes unchecked.
  - "Development is the team and settings every Floor had before
    templates": the Manager plus its Roles is `defaultTeamRoles`, each
    Role equals `builtInRole(id)`, its settings are `defaultFloorSettings`'
    with the reviewer required, and its Manager instructions are empty.
    "Blank is a Manager only…".
  - **"fails a broken manifest with its path"**: Blank's manifest with
    `mergePolicy: merge_whenever` and `roundCap: 0` fails.
    - `error.path` is `<root>/blank/template.yaml`, and the message starts
      with it.
    - The problems are exactly "settings.mergePolicy: The Merge Policy is
      send_to_me or auto_merge." and "settings.roundCap: The Round Cap is
      at least 1.".
  - Each of these fails with the path of the file at fault:
    - a manifest that is not YAML, or misses fields;
    - a folder with no manifest, a stray file in a template, and a file at
      the top of `templates/`;
    - a Role's bad Stage, or a Role file with no frontmatter;
    - a listed Role with no file, and a Role file not listed;
    - a required reviewer outside the review Stage;
    - a broken `SKILL.md`, and a Role's Skill missing from the template;
    - a Role name two templates share under different ids, and a Role two
      templates bring differently.
  - "reads every part of the format" loads a fixture template, Corner
    shop (`templates/testing.ts`). It has Roles with counts 2, 1 and 0, a
    Skill, a label, its own settings, planning guidance and a first issue.

  `packages/shared/src/floor-templates.test.ts` (9 tests) covers the
  manifest's refinements, `managerInstructionsOf` and `parseRoleDocument`.

- [x] **Integration tests: a Floor added from Development matches a Floor
      added before templates existed; a Blank Floor has only a Manager;
      nothing depends on the template after creation.**
  `packages/orchestrator/src/floors/templates.test.ts`: 5 cases, each in
  memory and in Postgres 18 (10 tests, all pass).
  - **"a Floor added from Development matches a Floor added before
    templates existed"**: one Floor is added by `createFloors` without
    templates (the code from before), the other from the loaded
    Development. Both use the same seeded random and clock. They have:
    - the same settings, template and required reviewer (compared by
      name);
    - the same team: names, Avatars, Roles, Stages, AI Providers, Models
      and empty extra instructions, ids aside;
    - the same events;
    - no `role.created`, an unchanged library (`builtInRoles`) and the
      same labels on GitHub.

    A third Floor added with no choice matches too.
  - **"a Blank Floor has only a Manager"**: the template is `{blank,
    Blank}`, there are no required reviewers, the Manager's instructions
    are Blank's guidance, the events are only `floor.created` and one
    `agent.created`, and the library is unchanged.
  - "a template's missing Roles join the library, then the Floor gets its
    team, settings, labels and Manager's instructions" uses Corner shop:
    - Manager, 2 merchandisers on `claude-sonnet-5-5`, and a brand
      reviewer on the office default, who is the required reviewer;
    - the `product` label on GitHub;
    - three `role.created` events naming the template, the copywriter's
      without an Agent.

    The Owner then edits the merchandiser. A second Floor from Corner shop
    keeps the edit and adds no Role again.
  - **"nothing depends on the template after the Floor is added"**: a
    `Floors` without Corner shop reads the Floor and its team unchanged.
    It changes the Floor's settings (and the template stays recorded),
    adds a merchandiser and a copywriter through `Agents`, and edits the
    Manager's instructions. Only a new Floor from Corner shop is refused
    (`template_not_found`).
  - "refuses a template there is not, or whose Role's name the library has
    under another id, changing nothing": no Floor, Role, label or event is
    left behind.

  `apps/server/src/floors/templates.test.ts`: 4 cases through the API, in
  memory and in Postgres 18 (8 tests, all pass):
  - the picker's exact list, and `401` when signed out;
  - a Blank Floor (Manager only), and a Floor with no choice from
    Development (four Agents, the reviewer required), with `GET
    /api/floors` naming each one's template;
  - `422 template_not_found`, and `400` for a malformed id;
  - **"a Floor keeps working once its template has gone"**: the app is
    started with Corner shop and the Floor added, then started again over
    the same stores with only the built-in templates. Then:
    - the Floor and its Agents read the same;
    - `PATCH` of its settings works;
    - a copywriter Agent can be added;
    - the merchandiser is no longer `inStartingTeam`, and editing it
      reaches its 2 Agents.

  `packages/db/src/floor-templates-migration.test.ts` (Postgres): two
  Floors inserted before `0052` (one archived) are both
  `development`/`Development` after it.

- [x] **Playwright: add a Floor and pick a template.**
  `e2e/tests/floors.spec.ts` > "adds a Floor from the Floor Template
  picked" passes in Chromium against the built app, Postgres 18 and the
  fake GitHub:
  1. The picker has two radios. Development is checked, and each one's
     accessible description is its description and starting team.
  2. Blank is picked, and adrianeyre/blog is added. **Floors in use** reads
     "blog adrianeyre/blog · started from Blank".
  3. Development is picked again, and web-shop is added from it.
  4. blog's admin page says "It started from the Blank Floor Template.".
     Its Agents table has one row, the Manager, and the Team card's Coder
     count is 0.
  5. web-shop's admin page names Development, and its table has the
     Manager, a coder, a reviewer and QA.
  6. The Activity Feed shows each Floor's template.

  The specs that read these texts were updated for the new `floor.created`
  wording: `activity.spec.ts` and `phone.spec.ts`. Both pass. So does the
  accessibility spec, which checks the Admin page, picker included, with
  axe in light and dark.

**The rest of "What to build", and how it was checked:**

- **Built-in templates are loaded from these files at start**:
  - `buildApp` loads them. Every server test (and `main.test.ts`, which
    starts the real server) runs with them.
  - The e2e server runs `startOffice`, so the picker in the browser lists
    them.
- **The picker shows name, description, icon and starting team, and
  defaults to Development**: `floors.test.tsx` > "picks the Floor Template
  a new Floor starts from…" checks the radios, Development checked, the
  descriptions and teams ("Manager, 2 × coder, reviewer, QA"), and the
  `POST` body `{"repository","template":"blank"}`. The existing add test
  now sends `"template":"development"`.
- **The Floor remembers and shows which template it started from**: the
  API, the list, the admin page and the feed. Each is covered above.
- **Existing Floors are recorded as Development**: the migration test,
  plus `floor.created` events from before templates still parsing
  (`schema.test.ts`).

**Negative checks.** Each sabotage was applied to the working tree, the
named tests run, then reverted with `git checkout` (`git status` clean
after each).

| Sabotage | Tests | Failed |
| --- | --- | --- |
| `templateTeam` gives at most one Agent per Role | `floors/templates.test.ts`; server `floors/templates.test.ts` (in memory) | 1 of 5; 1 of 4 |
| Development's `testCommand` set to `pnpm test` | `templates/load.test.ts` + `floors/templates.test.ts` | 2 of 16 |
| A template's settings not applied | `floors/templates.test.ts`; server's | 1 of 5; 1 of 4 |
| Stray files in a template allowed | `templates/load.test.ts` | 1 of 11 |
| A template's missing Roles not added | `floors/templates.test.ts`; server's | 2 of 5; 1 of 4 |
| The database store forgets the template | the same, in Postgres | 1 of 10; 2 of 8 |
| Migration 0052's default is `blank` | `floor-templates-migration.test.ts` (Postgres) | 1 of 1 |
| The picker sends no template | `floors.test.tsx`; `e2e/tests/floors.spec.ts` (web rebuilt) | 2 of 27; 1 of 3 |

### `pnpm e2e`

The whole suite (46 tests) ran once with 4 workers: **40 passed, 6
failed**.

- **Three passed when run again**, alone and one at a time:
  - `sign-in.spec.ts` ("signs out everywhere…") and `whiteboard.spec.ts`
    timed out under the host's load;
  - `notice-alerts.spec.ts` launches full Chromium, not the headless
    shell, and full Chromium needed `libcups.so.2`, which the sandbox
    lacked. Once Debian's `libcups2` was extracted beside the other
    libraries, it passed.
- **Three fail with or without this issue**: `agent-editor.spec.ts`,
  `gateway-requests.spec.ts` and `manager-chat.spec.ts`.
  - They fail on the same lines (`selectOption("xAI API key")`,
    `toBeChecked()`, `getByLabel("Name").fill("Work")`). Those lines look
    on the Admin page for what #165 moved to AI Settings.
  - #146 found the same three failing at its base commit `2945657`
    ([`issue-146.md`](issue-146.md#pnpm-e2e)).

This issue's specs all pass: `floors.spec.ts` (3 tests),
`activity.spec.ts`, `phone.spec.ts`, `role-library.spec.ts`,
`floor-admin.spec.ts` and `accessibility.spec.ts` (21 tests together).

### How Postgres and Chromium were run here

As for earlier issues, outside the repository:

- **Postgres**: `@embedded-postgres/linux-x64@18.3.0-beta.16` in
  `/tmp/pg18`, on port 54329.
  - For `pnpm test`, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at it
    through `SCRATCH_PG_URL`, with database names unique per test file.
    It was reverted with `git checkout` after each run and never
    committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`.
- **Chromium**: from `playwright install chromium`. Its missing shared
  libraries came from Debian bookworm's packages (now `libcups2` among
  them), extracted to `/tmp/chromelibs`.

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`, both run against the embedded Postgres 18.3 instead. Also the app
  image itself: that `COPY templates templates` puts the templates where
  the server looks for them (`/app/templates`). Only the Dockerfile's text
  is checked (`docker/deployment.test.ts`).
- **The 3D Office**: a template's theme id is in the format, but nothing
  draws it yet (#153). No GPU here either.
- **A real repository's labels**: template labels are created through the
  fake GitHub's `ensureLabel`. Development and Blank have none.

## Notes

- **Development's Roles are the built-in ones, twice.** `builtInRoles` in
  `packages/shared` stays the source for the web app, the migration's
  seeds and many tests. Development's `roles/*.md` repeat it, and
  `load.test.ts` holds them equal, character for character.
- **docs and designer belong to no template.** Development is exactly
  coder, reviewer and QA (FR-100). The migration from #145 still seeds
  docs and designer into the library. FR-98 says the library holds the
  Roles from every built-in template, so they will want a template of
  their own, or to join one (#150, #151).
- **The Manager's planning guidance and first issue go in its extra
  instructions.** That is where the Owner already edits them, and where
  each Manager prompt (chat, triage, Plan) puts them under "The Owner's
  instructions for you". Nothing depends on the template, and
  Development's Manager has none, as before. There is no "file this
  issue" button: the Manager suggests the issue.
- **A Role the library has is kept**, even if the template's file
  differs, so the Owner's edits win. The picker names Roles as the library
  has them.
- **Roles and labels come before the Floor's row.** If adding the Floor
  then fails, for example because another request added the repository
  first, the Roles stay in the library and the labels on GitHub. Both are
  harmless: such a Role has no Agent and can be deleted, and the labels
  are created again idempotently. A Role name clash is checked before
  anything is changed.
- **`role_in_starting_team` still keeps coder, reviewer and QA**, now
  because Development starts Floors with them. A Development Floor would
  add them back if they were missing, so the refusal could be dropped
  later.
- **The picker orders templates** Development first, then by name. With
  ten templates, Blank comes second, though the PRD's table lists it
  last.

## Noticed, out of scope

- **A template's Skills are not added to the Skill library.** The format
  carries them, the loader checks them, and a Role's Skills must be
  beside it. But adding a Floor adds only the Roles, as the issue says,
  and Development and Blank ship no Skills. The first template that ships
  one (#150, #151) needs to install its Skills, probably as a new Skill
  source, `template`.
- **The 3D theme is not copied onto the Floor.** Nothing reads it yet. So
  that nothing depends on the template, #153 should copy it onto the
  Floor when it is created, not look it up by template id.
- **The other eight built-in templates** (#150, #151), **3D themes**
  (#153) and **the Owner's own templates** (#152).
- **Three end-to-end specs go to Admin for what is now in AI Settings**
  (`agent-editor`, `gateway-requests`, `manager-chat`), as #146 recorded.
- **Full Chromium needs `libcups2`** in this sandbox, for
  `notice-alerts.spec.ts`. Earlier notes listed only the headless shell's
  libraries.

## Output

### `pnpm lint` and `pnpm typecheck`, at `7928748`

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
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck: Done
typecheck exit 0
```

The typecheck at `884fcb6` failed once, in this issue's own server test.
Its helper's `request` was typed as `inject`'s return value, which may be
a chain rather than a promise:

```text
apps/server typecheck: src/floors/templates.test.ts(76,11): error TS2322: Type '(templates?: readonly FloorTemplate[] | undefined) => Promise<{ server: …; request: (…) => Promise<Response>; }>' is not assignable to type '(templates?: readonly FloorTemplate[] | undefined) => Promise<Office>'.
```

`7928748` types it as `Promise<LightMyRequestResponse>`.

### `pnpm test`, without Docker, at `7928748`

```text
$ pnpm test
 Test Files  244 passed (244)
      Tests  2801 passed | 397 skipped (3198)
   Duration  95.25s
test exit 0
```

### `pnpm test` against the embedded Postgres 18.3, at `884fcb6`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=4
 Test Files  244 passed (244)
      Tests  3176 passed | 22 skipped (3198)
test exit 0
```

This issue's files alone, in Postgres:

```text
$ SCRATCH_PG_URL=… vitest run src/floors src/templates src/roles      # packages/orchestrator
 Test Files  5 passed (5)
      Tests  75 passed (75)
$ SCRATCH_PG_URL=… vitest run src/floors src/roles                    # apps/server
 Test Files  3 passed (3)
      Tests  37 passed (37)
$ SCRATCH_PG_URL=… vitest run src/floor-templates-migration.test.ts src/roles-migration.test.ts src/migrate.test.ts   # packages/db
      Tests  8 passed (8)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium), at `884fcb6`

```text
$ pnpm build && playwright test --workers=4
Running 46 tests using 4 workers
    > 70 |   await account.getByLabel("Account type").selectOption("xAI API key");
    > 82 |   await expect(storage).toBeChecked();
    > 121 |   await form.getByLabel("Name").fill("Work");
    > 111 |       await elsewhere.close();
    > 168 |   await page.getByRole("link", { name: "Notices" }).click();
    - [pid=38393] <process did exit: exitCode=127, signal=null>
  6 failed
    [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses
    [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens
    [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in
    [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not
    [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session
    [chromium] › tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: the Manager replans, and work starts in the new order
  40 passed (2.9m)
```

The three that are not the known failures, again:

```text
$ playwright test tests/notice-alerts.spec.ts tests/sign-in.spec.ts tests/whiteboard.spec.ts --workers=1
    [pid=38554][err] …/chromium-1248/chrome-linux64/chrome: error while loading shared libraries: libcups.so.2: cannot open shared object file: No such file or directory
  1 failed
    [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not
  6 passed (29.9s)

# libcups2 and its dependencies extracted to /tmp/chromelibs
$ playwright test tests/notice-alerts.spec.ts --workers=1
  1 passed (5.4s)
```

This issue's specs, and those it touches:

```text
$ playwright test tests/floors.spec.ts --workers=2
[1/3] [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page
[2/3] [chromium] › tests/floors.spec.ts:53:1 › adds a Floor from the Floor Template picked
[3/3] [chromium] › tests/floors.spec.ts:122:1 › changes a Floor's settings, then archives it
  3 passed (8.0s)
$ playwright test tests/activity.spec.ts tests/phone.spec.ts tests/role-library.spec.ts tests/floor-admin.spec.ts tests/accessibility.spec.ts --workers=3
Running 21 tests using 3 workers
  21 passed (1.9m)
```
