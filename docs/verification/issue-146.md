# Issue #146: Role library admin — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in the working tree of this branch, holding
the code as committed at `7308207`: `pnpm lint`, `pnpm typecheck`, `pnpm
test` (without and with Postgres), `pnpm e2e` and the negative checks.

The blockers are built on this branch:

- #145, Roles as data ([`issue-145.md`](issue-145.md)): the `roles` table,
  `RoleStore`, Agents' Stages, and prompts that read the Role as each task
  starts;
- #61, the Floor admin's team ([`issue-61.md`](issue-61.md)): Add Agent,
  Remove and the Team card;
- #90, the Skill library ([`issue-90.md`](issue-90.md)): the Skills a
  Role's Skills are chosen from.

## What was built

### The model (`packages/shared`, `role-library.ts`, new)

- **`createRoleRequestSchema`** (`POST /api/roles`) holds a Role's fields:
  - name: one line, at most 40 characters, and never `manager`;
  - Stage;
  - one-line routing description;
  - instructions, at most 8000 characters;
  - Skills: Skill names, each once;
  - desk dressing;
  - suggested AI Provider (one of the four, or null for the office
    default) and suggested Model (null for its default). A Model needs an
    AI Provider.
- **`updateRoleRequestSchema`** (`PATCH`) takes any of those fields;
  **`duplicateRoleRequestSchema`** takes an optional `name`.
- **`roleSchema`**: a library Role plus `agents` (how many Agents fill
  it) and `inStartingTeam`. **`roleListSchema`**.
- **`roleErrorCodes`** and **`roleIdOf(name)`**, which makes a Role's id
  from its name (`Brand reviewer` is `brand-reviewer`).

### Events (`packages/events`)

Three new events are recorded in the Activity Feed. None of them carries
a Role's instructions or other text:

- **`role.created`**: `roleId`, `name`, `stage`, and `duplicatedFrom` (or
  null);
- **`role.changed`**: `roleId`, `name`, `keys` (which fields changed,
  never their values) and `agents`, how many Agents the change reaches;
- **`role.removed`**: `roleId` and `name`.

### The database (`packages/db`): migration `0067_role_library_admin`

(Written as `0045`, renumbered after main's `0044`–`0049` in
[the merge note](merge-main-into-131-to-153.md).)

- **`agents.role_id`** is now `CASE WHEN removed_at IS NULL THEN
  NULLIF(role, 'manager') END`. A removed Agent's row is kept, as before,
  but no longer keeps its Role in the library. An Agent that is not
  removed still does, through the foreign key.
  - The expression is changed in place with `ALTER COLUMN … SET
    EXPRESSION` (Postgres 17 and later; the project runs 18).
    `drizzle-kit generate` wrote a drop and re-add of the column, which
    would have dropped `agents_role_id_roles_id_fk` without adding it
    back. The SQL was hand-written instead; the snapshot is drizzle-kit's.
- **`role_memory.role`**'s foreign key is now `ON DELETE CASCADE`: a
  deleted Role's Role memory goes with it.

### The orchestrator (`packages/orchestrator`)

**`createRoleLibrary`** (`roles/library.ts`, new) has these operations:

- **`list`** and **`get`**: each Role with how many Agents fill it, on
  every Floor. Leaving Agents and archived Floors' Agents count; removed
  Agents do not. The counts come from `AgentStore.countByRole` (new, in
  memory and in the database).
- **`create`**: the id is made from the name, numbered when taken
  (`merchandiser-2`). Names are unique whatever their case.
- **`duplicate`**: copies a Role as "*name* copy" ("*name* copy 2"…) or
  under a given name. Its `role.created` names the Role it was copied
  from.
- **`update`**:
  - Only the fields that differ are stored and named in `role.changed`; a
    save that changes nothing records nothing.
  - A new AI Provider without a Model of its own suggests its default
    Model.
  - Each task already reads its Agent's Role as it starts (#145), so an
    edit reaches every Agent with the Role from its next task.
- **`remove`**: deletes the Role and its Role memory.

`update` and `remove` refuse these:

| What | Refused with |
| --- | --- |
| Deleting a Role that any Agent not removed fills | `role_in_use` |
| Deleting a Role every new Floor starts with (coder, reviewer, QA) | `role_in_starting_team` |
| Changing a Role's Stage while Agents fill it | `role_stage_in_use` |
| A Skill the office Skill library does not have | `role_skill_not_found` |
| A suggested Model not in the AI Provider's catalogue (checked only when it changes) | `model_not_in_catalogue` |
| A name another Role has | `role_name_taken` |

**`RoleStore.remove`** (new) answers `in_use` when the database's foreign
key refuses the delete (`23503`), so a race with a new Agent cannot
delete a filled Role. The memory store does the same through its
`inUse` option. `memoryStores()` wires it to the Agents, and deletes the
Role's Role memory as the cascade does.

### The server (`apps/server`, `roles/routes.ts`, new)

| Route | Answers |
| --- | --- |
| `GET /api/roles` | the list |
| `GET /api/roles/:roleId` | one Role |
| `POST /api/roles` | `201` with the new Role |
| `POST /api/roles/:roleId/duplicate` | `201` with the copy |
| `PATCH /api/roles/:roleId` | the Role, with `agents` |
| `DELETE /api/roles/:roleId` | `204` |

- Errors: `404 role_not_found`; `409` for a Role in use, one in every new
  Floor's team, a Stage change while Agents fill the Role, or a taken
  name; `400` for a Skill or Model the library or catalogue does not
  have, and for an invalid body.
- `buildApp` makes the library from the stores and the model catalogue
  (`roles` option).

### The web app (`apps/web`)

- **The Role library page**, `/admin/roles` (new; Admin's "Role library"
  card links to it). It has a "Roles" table: each Role's name, Stage,
  routing description and Agents, with three actions:
  - **Open** shows the Role's form (`?role=` in the address). Every field
    can be edited: the Skills are checkboxes from the Skill library, and
    the suggested Model is chosen from the AI Provider's catalogue.
    - It says how many Agents a change reaches ("1 Agent fills this Role.
      A change reaches it from its next task; its own extra instructions
      still apply on top.").
    - The Stage is disabled while Agents fill the Role, with the reason.
    - **Save** sends only what changed, and is disabled until something
      does.
  - **Duplicate** makes the copy and opens it.
  - **Delete** asks first ("Its Role memory on every Floor goes with
    it."). It is disabled, with the reason, for a Role in use or one in
    every new Floor's team.
  - **New Role** opens an empty form.
- **Add Agent** (Floor admin) offers every Role in the library, by name,
  and is disabled until the library has loaded.
- **The Agents table and Team card** name Roles from the library.
  - The Team card has a count for every library Role.
  - Its concurrency warning counts sandbox Agents by Stage. The wording
    changes from "(coder, QA, docs and designer)" to "(in the work, QA
    and docs Stages)", in the unit and end-to-end tests too.
- **The Activity Feed** describes each Role event, and links `role.created`
  and `role.changed` to the Role library page:
  - `role.created`: 'Role "copywriter" made, in the work Stage.';
  - `role.changed`: 'Role "copywriter" changed: instructions. It reaches
    1 Agent from their next task.';
  - `role.removed`: 'Role "copywriter" deleted, with its Role memory.'.

  Its type filter has a "Roles" group.

### The end-to-end harness (`e2e/`)

The stand-in sandbox runner keeps each task's prompt. A new control
command, `office.sandboxPrompt(agentId, issue)`, reads it, so a test can
see what an Agent's next task was told. `sandboxTasks()`'s records are
unchanged.

### Docs

- README: "Roles and Stages" names the Role library page.
- [Floors and Agents](../guide/floors-and-agents.md): "The Role library
  page" (new): fields, actions, refusals, events and API. The concurrency
  warning now names Stages.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.**
  - `pnpm lint` and `pnpm typecheck` exit 0.
  - `pnpm test` without Docker, with Vitest's default workers: **239
    files, 2768 passed, 387 skipped** (the Postgres cases, skipped with
    the reason), exit 0.
  - Against an embedded **Postgres 18.3** (see below), two full runs each
    had **3132 passed, 22 skipped and 1 failed**.
    - The failure, both times, is `work/queue.test.ts` > "two coders share
      four issues, the next going to whichever coder is free" (in
      Postgres). It is a known flake, recorded in `issue-83.md` and
      `issue-84.md`.
    - Alone, it failed 2 of 5 runs on this branch and 3 of 6 on the base
      commit `2945657`, with the same assertion. This issue changes no
      work-queue code.
    - Every other file passed, including all of this issue's Postgres
      cases.
- [x] **Integration tests: a Role in use cannot be deleted; an edit reaches
      every Agent with that Role; changes are recorded.**
  `apps/server/src/roles/routes.test.ts` runs 5 cases through the API,
  each in memory and in Postgres 18 (10 tests, all pass):
  - **"a Role in use cannot be deleted; once no Agent fills it, it
    can"**:
    1. A `copywriter` Role is made, and an Agent, Cora, is added in it to
       a Floor.
    2. `DELETE /api/roles/copywriter` answers `409 role_in_use` ("1 Agent
       fills copywriter: remove it from its Floor before deleting the
       Role."). The Role and Cora are still listed.
    3. `designer` and `docs` (no Agents) are deleted. `reviewer` is `409
       role_in_starting_team`.
    4. Cora is removed. The copywriter's count is 0, and the delete
       answers `204`.
    5. The library is coder, reviewer and QA. `GET` is `404`, and adding
       an Agent in the Role is `404 role_not_found`.

    In Postgres this also checks the migration: Cora's kept row no longer
    blocks the delete.
  - **"an edit reaches every Agent with the Role, on every Floor, from its
    next task"**:
    1. There are three copywriter Agents on two Floors. Bram has his own
       extra instructions.
    2. `PATCH /api/roles/copywriter` changes the instructions and
       description, and answers `agents: 3`.
    3. For each Agent, as listed by the API, the work prompt its next
       task is given (`roleOfAgent` then `coderPrompt`, as the coder flow
       builds it) has the new instructions and not the old.
    4. Bram's prompt still ends with "## The Owner's instructions for
       you", after the Role's.
    5. A change of Stage is `409 role_stage_in_use`, and Cora stays in
       `work`.
  - **"records every change in the Activity Feed: made, duplicated,
    edited and deleted"**:
    1. Through `GET /api/events?type=role.created,role.changed,role.removed`
       (the Activity Feed's history): exactly `role.created` (copywriter),
       `role.created` (copywriter copy, `duplicatedFrom: "copywriter"`),
       `role.changed` (`keys: ["name","stage","deskDressing"]`, `agents:
       0`) and `role.removed`.
    2. A save that changes nothing, and a refused name ("Copywriter",
       `409 role_name_taken`), record nothing.
    3. The events never hold the instructions' text.
  - "lists the library's Roles with their Stage and how many Agents fill
    each" (two Floors and an extra coder: coder 3, reviewer 2, QA 2), and
    "refuses Skills the Skill library does not have, and Models not in
    the catalogue" (a Role called "Manager" too).

  `packages/orchestrator/src/roles/library.test.ts` runs 8 cases on the
  library itself, in memory and in Postgres (16 tests), plus `roleIdOf`.
  The cases cover:
  - ids numbered when taken;
  - duplicate names ("copy", "copy 2", or one given);
  - counts with leaving and removed Agents;
  - `role.changed` keys, and nothing for a no-op;
  - a new AI Provider's default Model;
  - the Stage kept while in use, and changeable while not (the next Agent
    in it is in the new Stage);
  - Skills and catalogue Models;
  - deleting with Role memory: only the deleted Role's entries go;
  - "the store itself refuses to delete a Role an Agent fills" (`in_use`
    from the foreign key in Postgres).
- [x] **Playwright: create a copywriter Role, add a copywriter Agent to a
      Floor, then edit the Role's instructions.**
  `e2e/tests/role-library.spec.ts` passes in Chromium against the built
  app, Postgres 18 and the fake GitHub:
  1. Admin → **Open the Role library**: the five built-in Roles.
  2. **New Role**: copywriter, Stage work, its routing description and
     instructions ("Write in British English…"), books on its desk,
     Claude. The table row is "Work · Writes the product copy… · 0".
  3. The Floor admin's **Add Agent** offers `copywriter`. Cora is added
     ("Added Cora, a copywriter Agent…"), her row reads "Copywriter
     Claude claude-opus-5-5", and the Team card has "Copywriter: 1".
     Coders are set to 0.
  4. Back in the library, the copywriter has 1 Agent. **Delete** is
     disabled ("1 Agent fills it: remove it from its Floor first.").
  5. **Open** says "1 Agent fills this Role. A change reaches it from its
     next task…", and the Stage is disabled.
  6. The instructions are changed to "Write in American English…" and
     saved: "Saved copywriter. 1 Agent with it uses the change from their
     next task." The change is still there after a reload.
  7. The Activity Feed shows 'Role "copywriter" changed: instructions. It
     reaches 1 Agent from their next task.' and 'Role "copywriter" made,
     in the work Stage.'.
  8. An issue is filed and intake polled. Cora's task is the only one, and
     its prompt (`office.sandboxPrompt`) is "You are Cora, a copywriter
     Agent…" with the American English instructions and no British
     English.

  The accessibility spec now also checks the Role library page with axe
  in light and dark mode ("every page, in use"), and a Role's form, the
  New Role form and the delete confirmation open together ("the editors
  and forms that open in place"). Both pass. That last test checks four
  pages' forms now, so it has an explicit 60 s timeout, as the file's
  other long tests have. It passes in about 11 s alone, but timed out at
  30 s with four workers on this host (load average about 50).

**The rest of "What to build", and how it was checked:**

- **View, create, duplicate and edit a Role, every field**:
  `apps/web/src/role-library.test.tsx` (3 tests):
  - the table's Stage, description and Agent counts, and why coder cannot
    be deleted;
  - making a Role with a Skill, desk dressing, AI Provider and catalogue
    Model (the exact `POST` body), which then opens at `?role=copywriter`;
  - the coder's form: its reach text, the disabled Stage, Save disabled
    until changed, and only `instructions` in the `PATCH`;
  - duplicating, which opens the copy with its Stage free;
  - deleting after asking.
- **Delete a Role no Agent uses**: above, in the API, the library, the web
  page and its disabled Delete.
- **Editing shows how many Agents the change affects**: the form's status
  line and the save message (web tests, Playwright). The API's `agents`
  is checked in the integration tests.
- **Every change goes to the Activity Feed**: the events above, their text
  and links in the feed (Playwright), and their schema
  (`schema.test.ts`: `role` is a family, and each example event parses).
- **In the Floor admin, adding an Agent offers any Role in the library**:
  `floors.test.tsx` > "offers every Role in the library, the Owner's own
  too, in Add Agent and the Team card":
  - a library without designer and with a copywriter lists coder,
    reviewer, QA, docs and Copywriter;
  - adding Cass posts `role: "copywriter"`;
  - the Team card counts 2 copywriters and has no Designer;
  - the sandbox warning counts the copywriters by their Stage.

  Playwright step 3 checks the same against the real server.

**Negative checks.** Each sabotage was applied to the working tree, the
named tests run, then reverted with `git checkout` (`git status` clean
after).

| Sabotage | Tests | Failed |
| --- | --- | --- |
| `remove` skips the usage check and the memory store ignores `inUse` | `roles/routes.test.ts`, `roles/library.test.ts` (in memory) | 1 of 5, 2 of 9 |
| The memory store's `update` keeps the old Role | the same | 2 of 5, 1 of 9 |
| No `role.changed` event is published | the same | 1 of 5, 1 of 9 |
| A Stage change is allowed while Agents fill the Role | the same | 1 of 5, 1 of 9 |
| Migration 0051 without its `SET EXPRESSION` (removed Agents still pin their Role) | `roles/routes.test.ts`, in Postgres | 1 of 10 |

### `pnpm e2e`

The whole suite (45 tests) ran once with Playwright's default 8 workers:
37 passed and 8 failed. Then:

- **Five passed when run again** with 2 workers (`agent-live-view` ×2,
  `ai-accounts`, `analytics`, `avatar-editor`). The 3D Office's panels
  (light) passed alone. Those first failures were the host's disk filling
  up during the run (`ENOSPC: no space left on device` from Playwright
  and Postgres) and timeouts under its load.
- **Three fail with or without this issue:** `agent-editor.spec.ts`
  ("an Agent's new AI Provider and Model…"), `gateway-requests.spec.ts`
  and `manager-chat.spec.ts`.
  - They look on the Admin page for the "Add an AI Account" form and the
    "Keep request and response bodies" checkbox. #165 moved both to AI
    Settings, and the Admin page already lacked them at the base commit
    `2945657`.
  - Built from `2945657` (its `apps`, `packages` and `e2e`, then restored
    and rebuilt), the same three fail with the same errors (output
    below).

This issue's tests all pass: `role-library.spec.ts`, `floor-admin.spec.ts`
(whose warning text changed) and the accessibility spec.

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
  libraries came from Debian bookworm's packages, extracted to
  `/tmp/chromelibs`.

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`. Both ran against the embedded Postgres 18.3 instead.
- **The 3D Office**: how a Role's desk dressing looks. The scene still
  dresses desks from the built-in Roles (see below), and cannot be seen
  here without a GPU.
- **A real Agent's sandbox**: the end-to-end test reads the prompt the
  stand-in runner was given, not what a real Claude Code run did with it.

## Notes

- **Owner-made Roles are deleted, built-in ones may be too.** Any Role no
  Agent fills can be deleted, designer and docs included, except coder,
  reviewer and QA. Every new Floor starts with those three (FR-10), and
  `defaultTeam` would fail without them. When Floor Templates (#147)
  bring their own starting teams, `inStartingTeam` should follow them.
- **A Role's Stage is kept while Agents fill it.** The PRD lists the Stage
  as editable. But an Agent's work, the issues it holds at its Stage's
  label, and a Floor's required reviewers (review-Stage Agents) all go by
  it (ADR 0003), so moving a filled Role would strand that work. The
  form says so, and points to Duplicate. A Role no Agent fills changes
  Stage freely.
- **Deleting a Role deletes its Role memory** on every Floor (`ON DELETE
  CASCADE`). The confirmation says so, and so does the feed entry. A
  Role's memory is lessons for that Role, which no Agent can read once
  the Role is gone.
- **A Role's id is made once, from its first name.** Renaming keeps the
  id, as Agents and Role memory refer to it.
- **A Role's Skills are stored and edited here.** Which Skills are
  mounted into a sandbox still follows FR-75 (every enabled Skill, unless
  the Floor admin turns it off for a Role), as #145 noted.
- **Counts include archived Floors' Agents.** They are not removed, still
  reference their Role, and would be stranded by its deletion.

## Noticed, out of scope

- **Built-in names outside the Floor admin.** The 3D Office's desks
  (`scene/desk-set.ts`: dressing and Stage stripe), the Agent card, the
  live view's heading, the 2D Office and Role memory headings still look
  Roles up among the built-in ones. An Owner-made Role there gets a plain
  monitor and is named by its id, which is its name as a slug. Reading
  the library in the scene is a change to the 3D Office.
- **The Floor admin's Skill toggles** are still for the built-in sandbox
  Roles: `floor_skill_toggles` has a check naming them, as #145 noted.
- **Three end-to-end specs go to Admin for what is now in AI Settings**
  (`agent-editor`, `gateway-requests`, `manager-chat`; above). They fail
  on the base commit too.
- **The flaky work-queue test** in Postgres (above; also #83, #84).
- **Importing and exporting Roles** (#152) and **Floor Templates** (#147).

## Output

### `pnpm lint` and `pnpm typecheck`, at `7308207`

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0

$ pnpm typecheck
…
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`, without Docker, at `7308207`

```text
$ pnpm test
 Test Files  239 passed (239)
      Tests  2768 passed | 387 skipped (3155)
   Duration  57.85s
test exit 0
```

The run before it (at `3217dbb`) had one failure: the events schema test,
which lists every event family, did not yet have `role`. `7308207` adds
it.

### `pnpm test` against the embedded Postgres 18.3, at `7308207`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=4
     × two coders share four issues, the next going to whichever coder is free 595ms
 FAIL  |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > two coders share four issues, the next going to whichever coder is free
AssertionError: expected [ 1, 2, 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
 Test Files  1 failed | 238 passed (239)
      Tests  1 failed | 3132 passed | 22 skipped (3155)
test exit 1
```

A second full run had the same single failure (3132 passed, 22 skipped).
The 22 skipped are the GitHub contract against the real App, which needs
`GITHUB_APP_ID`, and the checks that need Docker. The flaky file alone:

```text
$ SCRATCH_PG_URL=… vitest run src/work/queue.test.ts    # this branch, 5 runs
      Tests  38 passed (38)
      Tests  1 failed | 37 passed (38)
      Tests  38 passed (38)
      Tests  38 passed (38)
      Tests  1 failed | 37 passed (38)
$ SCRATCH_PG_URL=… vitest run src/work/queue.test.ts    # 2945657, 6 runs
AssertionError: expected [ 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
      Tests  1 failed | 37 passed (38)
      Tests  38 passed (38)
      Tests  38 passed (38)
AssertionError: expected [ 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
      Tests  1 failed | 37 passed (38)
      Tests  38 passed (38)
AssertionError: expected [ 1, 2, 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
      Tests  1 failed | 37 passed (38)
```

### This issue's tests, in Postgres

```text
$ SCRATCH_PG_URL=… vitest run src/roles          # apps/server
 Test Files  1 passed (1)
      Tests  10 passed (10)
$ SCRATCH_PG_URL=… vitest run src/roles/library.test.ts   # packages/orchestrator
 Test Files  1 passed (1)
      Tests  17 passed (17)
$ SCRATCH_PG_URL=… vitest run src/roles-migration.test.ts src/migrate.test.ts   # packages/db
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium), at `7308207`

```text
$ pnpm e2e
Running 45 tests using 8 workers
  ✓  38 [chromium] › tests/role-library.spec.ts:17:1 › makes a copywriter Role, adds a copywriter Agent to a Floor, then edits the Role's instructions (8.2s)
  ✓  22 [chromium] › tests/floor-admin.spec.ts:24:1 › edits each of a Floor's settings, and they are kept (12.2s)
  ✓  23 [chromium] › tests/floor-admin.spec.ts:110:1 › adds a second coder; removing the Manager is refused (14.3s)
  ✓  24 [chromium] › tests/floor-admin.spec.ts:184:1 › sets coders to 3 and warns when the concurrency limit is lower (13.3s)
  ✓   6 [chromium] › tests/accessibility.spec.ts:319:3 › every page, in use (light) (52.5s)
  ✓   5 [chromium] › tests/accessibility.spec.ts:319:3 › every page, in use (dark) (57.5s)
  ✓   3 [chromium] › tests/accessibility.spec.ts:383:3 › the editors and forms that open in place (dark) (26.1s)
  ✓   4 [chromium] › tests/accessibility.spec.ts:383:3 › the editors and forms that open in place (light) (31.2s)
  ✘  16 [chromium] › tests/agent-live-view.spec.ts:108:1 › the live view follows new output, and pauses while the Owner reads back (11.3s)
  ✘  18 [chromium] › tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it (7.8s)
  ✘  14 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (30.5s)
  ✘  20 [chromium] › tests/avatar-editor.spec.ts:10:1 › an Agent's new hair colour and outfit outlast a reload (17.1s)
  ✘   2 [chromium] › tests/accessibility.spec.ts:333:3 › the 3D Office's panels (light) (1.3m)
  ✘  19 [chromium] › tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests (30.3s)
  ✘  28 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (16.6s)
  ✘  29 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (30.4s)
    Error: browserContext.close: ENOSPC: no space left on device, write
    Error: The server refused publish: Failed query: insert into "events" …
  8 failed
  37 passed (2.4m)
```

The failed ones, again:

```text
$ playwright test tests/agent-live-view.spec.ts tests/agent-editor.spec.ts tests/ai-accounts.spec.ts tests/analytics.spec.ts tests/avatar-editor.spec.ts tests/gateway-requests.spec.ts tests/manager-chat.spec.ts --workers=2
  ✓  1 › tests/agent-live-view.spec.ts:11:1 › an Agent's events stream into its live view (2.6s)
  ✓  3 › tests/agent-live-view.spec.ts:108:1 › the live view follows new output, and pauses while the Owner reads back (3.6s)
  ✓  4 › tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it (4.1s)
  ✓  5 › tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests (3.1s)
  ✓  6 › tests/avatar-editor.spec.ts:10:1 › an Agent's new hair colour and outfit outlast a reload (4.7s)
  ✘  7 › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (11.0s)
  ✘  2 › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (30.3s)
  ✘  8 › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (30.2s)
    > 70 |   await account.getByLabel("Account type").selectOption("xAI API key");
    > 82 |   await expect(storage).toBeChecked();
    > 121 |   await form.getByLabel("Name").fill("Work");
  3 failed
  5 passed (1.0m)

$ playwright test tests/accessibility.spec.ts -g "3D Office's panels" --workers=1
  ✓  1 › tests/accessibility.spec.ts:333:3 › the 3D Office's panels (light) (58.4s)
  ✓  2 › tests/accessibility.spec.ts:333:3 › the 3D Office's panels (dark) (36.9s)
  2 passed (1.6m)
```

The three, built from the base commit `2945657`:

```text
$ git checkout 2945657 -- apps packages e2e && pnpm build
$ playwright test tests/agent-editor.spec.ts tests/gateway-requests.spec.ts tests/manager-chat.spec.ts --workers=2
  ✘  3 › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (30.3s)
    Error: locator.selectOption: Test timeout of 30000ms exceeded.
    Error: expect(locator).toBeChecked() failed
    Error: element(s) not found
    Error: locator.fill: Test timeout of 30000ms exceeded.
  3 failed
$ git checkout HEAD -- apps packages e2e && pnpm build
```
