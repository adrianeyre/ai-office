# Merging main into #131 to #153 — verification

This branch built #145 to #151 and #153: Roles as data on four Stages,
the Role library, Floor Templates, routing between work Roles, ordered
work Roles, the built-in templates and 3D Floor themes
([`issue-145.md`](issue-145.md) to [`issue-153.md`](issue-153.md)).
`origin/main` was then merged in (`363d310`), bringing configuration
export and import (#113), Context Usage (#120), Fresh Starts (#121), the
Communications Agent and Connections (#125 to #130), Grilling, Skills in
the Manager chat, the Kickoff and the Wrap-up, webhooks, Agent Settings,
the lobby's receptionist and visitor, calling the lift and more.

The merge commit resolved the textual conflicts and renumbered this
branch's migrations from `0044`–`0050` to `0050`–`0056`, after main's
`0044`–`0049`, with snapshots of main's schema plus ours (`200fa8c`
renamed the migration tests' tags). It did not build: `pnpm typecheck`
stopped at `packages/shared/src/configuration.ts`, which still imported
the fixed `roles` list and `roleMemoryRoles` that #145 replaced.

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display). `pnpm lint`, `pnpm typecheck`, `pnpm test`
and `drizzle-kit generate` ran in a fresh `git clone` of this branch at
`5509ef7` (every commit below but this note) after `pnpm install
--frozen-lockfile`. The Postgres, end-to-end and screenshot runs were made
in the working tree at the same code.

## What had to change, and why

### Configuration export and import carry the Role library (`75effa5`)

#113's export (`shared/src/configuration.ts`,
`orchestrator/src/configuration/configuration.ts`) was written against
the fixed Roles: an Agent's `role` was `z.enum(roles)`, Role memory
`z.enum(roleMemoryRoles)`, and a required reviewer had to be an Agent
whose Role was `reviewer`. With Roles as data (ADR 0003) an export of a
Floor added from Online store would not parse, and an import onto a new
Office would lose the Owner's own Roles, so its Agents could not be
added (`agents.role` references `roles`).

- **The document holds the Role library** (`roles`, in the library's
  order): each Role's id, name, Stage, routing description,
  instructions, Skills, desk dressing and suggested AI Provider and
  Model (`configurationRoleSchema`, the Role library's own field rules
  plus the id). It also holds each Floor's **template** and **theme**,
  which a Floor record needs and which #147 and #153 say the Floor keeps.
- **Validated against the library, not a fixed enum.** An Agent's Role is
  `manager` or a Role id; on import it must be in the Role library here
  or the document's, as must a Role memory entry's. A required reviewer
  must be an Agent in a **review-Stage** Role: the document checks it
  against its own library, the import against the library as the import
  leaves it.
- **Roles are imported before the Floors** whose Agents fill them: a Role
  not here is added (`role.created`), one that differs is changed
  (`role.changed`, with its fields and how many Agents it reaches).
  Refused, like the Role library refuses them: a Role whose name another
  Role here has, a Stage change while Agents fill the Role, a Skill
  neither library has, a suggested AI Provider AI Office does not know.
  An Agent's stage is read from the library the import leaves.
- **Role instructions reach models** (ADR 0003, FR-101), so the preview
  notes each Role whose instructions it adds or changes; the web app's
  preview names the area "Role library".
- A Floor that is here already keeps its own template and theme: neither
  is a Floor setting, and nothing changes them after the Floor is added.
- `configurationVersion` stays 1: no configuration export has left a
  release (the README's status is "planning"), and a document without
  `roles`, `template` or `theme` is refused with the field named.

### Main's code onto Roles as data and Stages (`8617363`, `38a2d6e`)

- **The Kickoff** (`batches/kickoff.ts`, #85) named an Agent's Role with
  the removed `roleNames` record. It now names it as the Floor's work
  Roles do in the Role library, and presents an issue's ordered work
  Roles ("by its work Roles in turn: merchandiser, then copywriter"). The
  merge had also left `batches.ts` calling `kickoff` with an `agents`
  that no longer existed; it is the team the Plan was drafted for.
- **Context Usage** (`context/usage.ts`, #120) left reviewers out by the
  `reviewer` Role; reviewer calls are stateless by **Stage** (FR-84), so
  it leaves out review-Stage Agents, whatever their Role is called. The
  Agent live view's gauge (`agent-live-view.tsx`) likewise.
- **Agent Settings** (`agent-settings-page.tsx`, #169) names each Agent's
  Role from the Role library ("Store QA", not "Store-qa").
- **The Floor admin's required reviewers** offered only Agents in the
  `reviewer` Role, though the server checks the review Stage, so a brand
  reviewer could not be chosen. A leftover of #145, found while checking
  this shared page; it now offers every review-Stage Agent.

### Both sides of intake and webhooks (`42dd746`)

Main's webhooks (#122) make a pipeline label again when it is deleted or
renamed on GitHub; #148 gives each work Role a `role:<name>` label, made
once per process. A deleted or renamed `role:` label now starts the same
re-check, and `recheckLabels` forgets the Floor's made `role:` labels too.

### Main's tests (`3e1f6a1`)

Main's tests still expected `needs-code` (the coder's Fresh Start cap,
webhooks, a Batch's Wrap-up), Agents without a `stage` and Floors
without a `template` or `theme` (Agent Settings, Available Skills, the
whiteboard), and the scene fixture's Floor had no Fresh Start threshold.
They were brought onto `needs-work` and today's shapes; no expectation
was loosened.

### A race in the work queue, in Postgres (`c2d70f4`)

In Postgres, `work/queue.test.ts` "two coders share four issues, the next
going to whichever coder is free" failed now and then: Grace's ticket
pile was told as `[1, 0]` or `[1, 2, 1, 0]`, not `[1, 0, 1, 0]`. The test
and the queue are the same on both sides; it is a race between the
dispatch search an `enqueue` sets off and the next `enqueue`, so a queue
length was read after two changes. Measured with the scratch Postgres
below: at `cda6fc1` (before the merge) it failed 1 run in 11; merged, 2
in 8, and 3 whole-file runs in a row before them. `enqueue` now resolves
once the search it set off is done, so each change is told in order: 0
failures in 10 runs, and the orchestrator's 1,128 tests pass in memory
and in Postgres.

### The Floor theme screenshots (`5509ef7`)

`pnpm scenes` failed for all nine themes, each by the same 2,070 pixels
(1%) of its overview. The references were taken before the merge; main's
Floors now rest the lift with its doors shut until it is called (#169)
and have the Skills bookshelf in the Manager's office (#92, FR-73).
Compared pixel by pixel, every retaken screenshot changed in those two
places only (2,598 pixels in a box around the Manager's office and the
lift in each overview, 5,352 around the bookshelf in each close-up), the
same in all nine themes; no theme's props changed. Retaken with
`--update-snapshots=all`, then run again without it: 10 passed.

### Docs (`d1c4261`, `f1b6087`)

- The migration numbers in [`issue-145.md`](issue-145.md) (`0050`),
  [`issue-146.md`](issue-146.md) (`0051`), [`issue-147.md`](issue-147.md)
  (`0052`), [`issue-148.md`](issue-148.md) (`0053`),
  [`issue-149.md`](issue-149.md) (`0054`), [`issue-150.md`](issue-150.md)
  (`0055`) and [`issue-153.md`](issue-153.md) (`0056`), each saying what
  it was written as. Recorded output in those notes is left as it was
  run.
- [Running AI Office](../guide/running.md#configuration-export-and-import):
  the export's Role library, each Floor's template and theme, and the new
  problems an import names.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass**, from a fresh
      clone at `5509ef7` (output below). Without Docker: **300 files,
      3371 passed, 493 skipped** (the Postgres tests skip with the
      reason). Against an embedded **Postgres 18.4**: **300 files, 3837
      passed, 27 skipped**: the GitHub contract against the real App (14),
      the Docker and hadolint checks of the compose stack and sandbox
      images (10) and the email contract against Mailpit (3).
- [x] **`drizzle-kit generate` reports no schema changes**: "No schema
      changes, nothing to migrate", and no file was written.
- [x] **The migration tests pass on embedded Postgres**: `migrate.test.ts`
      (every migration on a fresh Postgres 18, then a no-op again) and
      the three of this branch's renumbered migrations,
      `roles-migration.test.ts` (`0050`), `floor-templates-migration.test.ts`
      (`0052`) and `floor-themes-migration.test.ts` (`0056`).
- [x] **Every feature from both sides still works**: the whole Playwright
      suite, **51 passed** (below), among them the specs on Roles
      (`role-library`), Floors and templates (`floors`), the Floor admin
      (`floor-admin`, `agents`), Batches and the whiteboard (`batch`,
      `whiteboard`), Connections (`connections`), accessibility and the
      phone and tablet views (`phone`); and `pnpm scenes`, **10 passed**.
      The three end-to-end failures recorded since #146
      ([`issue-153.md`](issue-153.md#pnpm-e2e)) pass now.

New and changed tests (all ✓):

- `orchestrator/src/configuration/configuration.test.ts`, in memory and in
  Postgres: "carries the Role library, so a Floor's Agents arrive in the
  Owner's own Roles, on a Floor of its template and theme" (an Online
  store Floor, an edited built-in Role and a legal reviewer of the
  Owner's, a required reviewer in it, merchandiser memory: exported,
  imported into an empty Office, exported again the same, and a second
  import changes nothing); "checks each Agent's Role against the Role
  library, never a fixed list" (a Stage change of a filled Role, a name
  taken, a Role in neither library, a work-Stage required reviewer: all
  four named, nothing applied).
- `shared/src/configuration.test.ts`: the export's format with its Role
  library; a coder is still refused as a required reviewer, now by its
  Role's Stage.
- `orchestrator/src/intake/intake.test.ts`: "makes a work Role's
  role:<name> label again once a webhook says it was renamed";
  `webhooks.test.ts`: a deleted `role:copywriter` label starts the
  re-check.
- `apps/web/src/agent-settings-page.test.tsx`: a Store QA Agent is named
  as the library names its Role; `floors.test.tsx`: a brand reviewer is
  offered as a required reviewer, a copywriter is not.

**Negative checks.** Each sabotage was applied to the working tree, the
test run, then reverted; `git status` was clean after each.

| Sabotage | Failed |
| --- | --- |
| `recheckLabels` forgets only the pipeline labels | intake "makes a work Role's role:<name> label again…" |
| Agent Settings names Roles without the library | Agent Settings "shows every Agent on a Floor…" |
| The Floor admin offers only the `reviewer` Role | Floors "chooses the Floor's required reviewers among its review-Stage Agents" |

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of the
  end-to-end suite (both ran against the embedded Postgres instead), the
  compose stack, the sandbox images and hadolint, and the email contract
  against Mailpit.
- **The GitHub contract against a real GitHub App**, and real Connections
  (Slack, ntfy and the rest run against their fakes).
- **The 3D office on a real GPU**: its look and frame rate. The
  screenshots are SwiftShader's, as CI draws them; whether CI's machines
  draw them within the threshold is first seen in CI, as before.

## Notes

- **Imported Roles are not held for review.** ADR 0003 and FR-101 say an
  imported Role or template shows its full contents for review before it
  is enabled. The Role library has no "enabled" state to hold a Role in
  (FR-101's template import is not built yet), and adding one would be a
  feature. A configuration import is the Owner's own document, previewed
  before anything is applied; the preview marks each Role whose
  instructions it adds or changes, and the Skills it brings still wait
  for review (FR-76).
- **Unchanged from #145, outside the merge:** the Manager chat's team
  list, the Agent card and the live view's header write a Role by the
  built-in names (a Role of the Owner's reads as its id), and Skills are
  turned on or off per built-in sandbox Role only (`sandboxRoles`), so a
  configuration's Skill settings stay keyed by those.
- **The first full Postgres run** (made while Chromium downloaded, in
  158 s rather than 55 s) also had four tests over Vitest's 5-second
  timeout: three floor-layout path checks and one Role library page
  test. Each passed alone, and all passed in the second full run.

## How Postgres and Chromium were run here

As for earlier issues, outside the repository:

- **Postgres**: `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, on port 54329. For `pnpm test`, a scratch edit to
  `packages/db/src/testing/postgres.ts` pointed `postgresTest` at it
  through `SCRATCH_PG_URL`, with database names unique per test file; it
  was reverted with `git checkout` and never committed. The end-to-end
  suite used `E2E_POSTGRES_URL`.
- **Chromium**: `playwright install chromium` (Chromium 156, headless
  shell 1248). Its missing shared libraries came from Debian bookworm's
  packages, downloaded from `deb.debian.org`, extracted to
  `/tmp/chromelibs` and put on `LD_LIBRARY_PATH`.

## Output

### Before: `pnpm typecheck` at `200fa8c`

```text
packages/shared/src/configuration.ts(3,49): error TS2724: '"./agents.ts"' has no exported member named 'roles'. Did you mean 'Role'?
packages/shared/src/configuration.ts(19,3): error TS2724: '"./office-memory.ts"' has no exported member named 'roleMemoryRoles'. Did you mean 'RoleMemoryList'?
```

Package by package, the orchestrator also had `batches.ts(1466,35):
Cannot find name 'agents'`, `kickoff.ts(3,3): no exported member named
'roleNames'`, and two in `configuration.ts` (an Agent without `stage`, a
Floor without `template` and `theme`); the web app, the scene fixture's
Floor and a whiteboard test's Batch.

### `pnpm lint`, `pnpm typecheck` and `drizzle-kit generate`, fresh clone at `5509ef7`

```text
$ pnpm install --frozen-lockfile --prefer-offline
Done in 523ms using pnpm v12.10.0
install exit=0

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

$ pnpm --filter @ai-office/db exec drizzle-kit generate
No config path provided, using default 'drizzle.config.ts'
Reading config file '/tmp/fresh/packages/db/drizzle.config.ts'
44 tables
…
No schema changes, nothing to migrate 😴
drizzle exit=0
```

### `pnpm test`, without Docker, fresh clone at `5509ef7`

```text
$ pnpm test
 Test Files  300 passed (300)
      Tests  3371 passed | 493 skipped (3864)
   Duration  49.55s
test exit=0
```

### `pnpm test` against the embedded Postgres 18.4

At `c2d70f4`; the commits after it change only docs and screenshots.

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test
 Test Files  300 passed (300)
      Tests  3837 passed | 27 skipped (3864)
   Duration  55.05s
exit=0
```

The first full run, at `38a2d6e`, before the queue's fix:

```text
 FAIL  |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > two coders share four issues, the next going to whichever coder is free
AssertionError: expected [ 1, 2, 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
 FAIL  |@ai-office/web| src/role-library.test.tsx > the Role library page > makes a Role, opens it, and edits it, saying how many Agents the change reaches
Error: Test timed out in 5000ms.
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 10 Agents' Floor clear of furniture and walls
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 11 Agents' Floor clear of furniture and walls
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 12 Agents' Floor clear of furniture and walls
Error: Test timed out in 5000ms.
 Test Files  3 failed | 297 passed (300)
      Tests  5 failed | 3832 passed | 27 skipped (3864)
   Duration  157.73s
exit=1
```

The migration tests, verbose:

```text
 ✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18 551ms
 ✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > create schema_meta and record the application 110ms
 ✓ |@ai-office/db| src/migrate.test.ts > migrations against Postgres 18 > are a no-op when run again 82ms
 ✓ |@ai-office/db| src/floor-templates-migration.test.ts > records every Floor from before Floor Templates as Development 951ms
 ✓ |@ai-office/db| src/roles-migration.test.ts > keeps every existing Agent's Role and instructions, and moves needs-code work to needs-work 972ms
 ✓ |@ai-office/db| src/floor-themes-migration.test.ts > gives every Floor from before themes its template's theme 993ms
```

The queue test, 10 runs in Postgres before and after `c2d70f4`:

```text
$ for i in 1…8; vitest run src/work/queue.test.ts -t "two coders share four"   # SCRATCH_PG_URL set
/tmp/wt-ours (cda6fc1, before the merge)   failed 0/8  (and 1 of 3 whole-file runs before them)
/home/agent/workspace (38a2d6e, merged)    failed 2/8  (and 3 of 3 whole-file runs before them)
$ for i in 1…10; vitest run src/work/queue.test.ts   # at c2d70f4
failed 0/10
```

### `pnpm e2e`, embedded Postgres 18.4, 4 workers

At `c2d70f4`'s code, after `pnpm build`; the lines are sorted by spec,
not in the order the workers finished them.

```text
$ E2E_POSTGRES_URL=postgres://postgres@localhost:54329/postgres playwright test --workers=4
Running 51 tests using 4 workers
  ✓ tests/accessibility.spec.ts:29:1 › the setup and sign-in screens (7.7s)
  ✓ tests/accessibility.spec.ts:339:3 › every page, in use (dark) (48.6s)
  ✓ tests/accessibility.spec.ts:339:3 › every page, in use (light) (49.3s)
  ✓ tests/accessibility.spec.ts:353:3 › the 3D Office's panels (dark) (50.6s)
  ✓ tests/accessibility.spec.ts:353:3 › the 3D Office's panels (light) (47.7s)
  ✓ tests/accessibility.spec.ts:403:3 › the editors and forms that open in place (dark) (17.5s)
  ✓ tests/accessibility.spec.ts:403:3 › the editors and forms that open in place (light) (17.8s)
  ✓ tests/accessibility.spec.ts:471:1 › Admin in every theme, in light and dark mode (32.8s)
  ✓ tests/accessibility.spec.ts:497:1 › the Office in a browser without WebGL 2 (3.5s)
  ✓ tests/accessibility.spec.ts:514:1 › the footer's dialogs, and the navigation on a narrow screen (8.0s)
  ✓ tests/accessibility.spec.ts:552:1 › the keyboard: the skip link, a policy dialog and an object's panel (13.1s)
  ✓ tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (3.9s)
  ✓ tests/activity.spec.ts:83:1 › the Activity Feed loads older events as it scrolls (6.6s)
  ✓ tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (5.8s)
  ✓ tests/agent-live-view.spec.ts:11:1 › an Agent's events stream into its live view (5.0s)
  ✓ tests/agent-live-view.spec.ts:108:1 › the live view follows new output, and pauses while the Owner reads back (4.7s)
  ✓ tests/agent-settings.spec.ts:9:1 › the receptionist greets the Owner by nickname, and Agent Settings edits the lobby and a Floor (14.9s)
  ✓ tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (5.0s)
  ✓ tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it (12.9s)
  ✓ tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests (5.5s)
  ✓ tests/available-skills.spec.ts:49:1 › opens a Skill beside the Manager chat, views a supporting file, and run puts /name in the box (6.4s)
  ✓ tests/available-skills.spec.ts:95:1 › runs a Skill from Admin's Available Skills, which opens the Floor's Manager chat with /name (5.8s)
  ✓ tests/available-skills.spec.ts:116:1 › autocompletes /name in the Manager chat from the Floor's Skills (#93) (5.8s)
  ✓ tests/avatar-editor.spec.ts:10:1 › an Agent's new hair colour and outfit outlast a reload (13.4s)
  ✓ tests/batch.spec.ts:13:1 › "complete issues 1 and 2" with plan approval off: the Plan is kept, shown in the chat, and work starts (6.0s)
  ✓ tests/connections.spec.ts:10:1 › adds a webhook Connection, sends a test, pauses and deletes it (6.2s)
  ✓ tests/floor-admin.spec.ts:24:1 › edits each of a Floor's settings, and they are kept (8.0s)
  ✓ tests/floor-admin.spec.ts:110:1 › adds a second coder; removing the Manager is refused (7.3s)
  ✓ tests/floor-admin.spec.ts:184:1 › sets coders to 3 and warns when the concurrency limit is lower (12.1s)
  ✓ tests/floors.spec.ts:18:1 › adds a Floor from the admin page (5.6s)
  ✓ tests/floors.spec.ts:53:1 › adds a Floor from the Floor Template picked (5.8s)
  ✓ tests/floors.spec.ts:130:1 › changes a Floor's settings, then archives it (5.4s)
  ✓ tests/gateway-keys.spec.ts:15:1 › makes a Gateway Key for a tool, uses it, then revokes it (3.1s)
  ✓ tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (3.1s)
  ✓ tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (6.5s)
  ✓ tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (4.2s)
  ✓ tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (3.0s)
  ✓ tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (3.0s)
  ✓ tests/phone.spec.ts:53:3 › on a phone › the Office is in 2D, with no canvas, and every section is in reach (3.6s)
  ✓ tests/phone.spec.ts:133:3 › on a phone › an Agent's name brings its entry into view, and the phone on its side stays 2D (3.1s)
  ✓ tests/phone.spec.ts:159:3 › on a phone › the Notice Board, the Activity Feed and the admin pages fit the screen (3.5s)
  ✓ tests/phone.spec.ts:188:3 › on a tablet › the Office is the 3D one, with every panel inside its view, upright or on its side (38.0s)
  ✓ tests/role-library.spec.ts:17:1 › makes a proofreader Role, adds a proofreader Agent to a Floor, then edits the Role's instructions (4.0s)
  ✓ tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.3s)
  ✓ tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (1.9s)
  ✓ tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (2.4s)
  ✓ tests/sign-in.spec.ts:79:3 › signing in and out › signs out (2.9s)
  ✓ tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (23.4s)
  ✓ tests/skills.spec.ts:35:1 › writes a Skill, and uploads one that is reviewed before it is enabled (4.3s)
  ✓ tests/status-report.spec.ts:13:1 › "status" in the Manager chat: the report lists the blocked issue and those needing the Owner, and is an info Notice (4.1s)
  ✓ tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: the Manager replans, and work starts in the new order (19.6s)
  51 passed (2.7m)
exit=0
```

### `pnpm scenes`

Before the screenshots were retaken (each of the nine themes failed the
same way):

```text
  ✘   1 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the office theme, from development (31.8s)
    Error: expect(page).toHaveScreenshot(expected) failed
      2070 pixels (ratio 0.01 of all image pixels) are different.
      Snapshot: floor-office.png
  …
  9 failed
  1 passed (2.1m)
```

After, at `5509ef7`:

```text
$ pnpm scenes
  ✓   1 [chromium] › scenes/floor-themes.spec.ts:22:1 › covers every theme (4ms)
  ✓   2 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the office theme, from development (47.5s)
  ✓   3 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the studio theme, from website-and-marketing (48.8s)
  ✓   4 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the stockroom theme, from online-store (49.9s)
  ✓   5 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the editorial theme, from content-and-blog (1.3m)
  ✓   6 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the library theme, from documentation (1.3m)
  ✓   7 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the atelier theme, from design-system (1.3m)
  ✓   8 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the observatory theme, from data-and-analytics (54.8s)
  ✓   9 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the data-centre theme, from infrastructure (54.6s)
  ✓  10 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the device-lab theme, from mobile-app (55.3s)
  10 passed (3.2m)
exit=0
```
