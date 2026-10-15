# Issue #92: Available Skills list and modal — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) in the working tree of this branch, after `pnpm install
--frozen-lockfile`.

## What was built

### A Floor's Skill in full (`packages/shared`, `packages/orchestrator`, `apps/server`)

- **`floorSkillDetailSchema`** (`shared/src/skills.ts`): one of a Floor's
  Skills in full: `name`, `description`, `source` (`office` or
  `repository`), `folder`, `overridesOffice` and `files`, `SKILL.md` first.
- **`FloorSkills.available(floorId)`** (`orchestrator/src/skills/floor.ts`):
  the Floor's Skills with their files (the office library's enabled Skills
  and the repository's, read through the GitHub App at the default branch,
  a repository Skill in place of the office Skill of its name) and why the
  repository's could not be read. `list` now reads the repository the same
  way (`fromRepository`), unchanged in what it answers.
- **`FloorSkills.get(floorId, name)`**: one in full. The list reads only
  each repository Skill's `SKILL.md`, so for a repository Skill the whole
  folder is read with **`readGitHubSkillFolder`**
  (`skills/repository.ts`), as warily as a clone is: a symbolic link or a
  submodule, a file that is not text, or more than 200 files or 4 MB, and
  it cannot be read. An unknown name is `skill_not_found`.
- **`GET /api/floors/:floorId/skills/:skillName`**
  (`server/src/skills/routes.ts`): owner-only, like every Skills route;
  `404 skill_not_found`, `404 floor_not_found`.

### The list and its modal (`apps/web`)

- **`available-skills.tsx`**:
  - `AvailableSkillList({ floorId, onRun })`: each Skill's name (a button,
    "Open *name*"), its description, and an **Office** or **Repository**
    badge; why the repository's Skills could not be read, when they could
    not; an empty state.
  - Its modal (the shared `Dialog`): the description and where the Skill
    comes from (the repository folder, and whether it overrides the office
    Skill), a **Files** navigation with `SKILL.md` and **Supporting
    files**, each shown in the modal when picked (`aria-current` on the one
    shown): `SKILL.md`'s instructions rendered below its frontmatter, other
    Markdown files rendered, the rest as written. **Run /*name*** closes
    the modal and hands the name to `onRun`.
  - `withSkillCommand(text, name)`: the box's text with `/name ` first, in
    place of a Skill's command already there, keeping the rest as its
    arguments.
  - `managerChatHref(floorId, skill?)`:
    `/floors/<floor>/manager?skill=<name>`.
  - `AvailableSkillsCard`: Admin's **Available Skills** card, for the Floor
    picked in its **Floor** select; **Run** opens that Floor's Manager chat
    with the command in the box.
  - `FloorAvailableSkills`: the same, for the 3D Office's panel.
- **`skill-markdown.tsx`**: `react-markdown` with `remark-gfm` (new
  dependencies of `@ai-office/web`; `pnpm-lock.yaml` updated, no install
  scripts). It renders to React elements: HTML written in the Markdown is
  shown as text (no `rehype-raw`), links open in a new tab, `javascript:`
  links are dropped by react-markdown's URL check, images are not fetched
  (their text is shown), and headings start at `h3`, under the modal's
  title. Styles are `.skill-markdown` in `styles.css`.
- **Beside the Manager chat** (`manager-chat.tsx`): the page lays the chat
  and an **Available Skills** aside side by side (one above the other on
  narrow screens). `ManagerChatPanel` takes `insert` (`{ skill, seq }`):
  each new `seq` puts `/name ` in the box and focuses it, cursor at the
  end, once the modal has closed (the platform's `<dialog>` hands focus
  back to its opener when it closes, so the focus waits a task).
  `?skill=<name>` in the address (validated against the Skill name
  pattern, `router.tsx`) does the same as the page opens, and is then
  cleared from the address.
- **Admin**: the **Available Skills** card follows the **Skills** card.
  Adding, editing or removing a library Skill now also refreshes every
  Floor's Skills list (`skills-card.tsx`), so the card shows it at once.
- **The Manager's office bookshelf** (`scene/floor-layout.ts`,
  `inspectable.ts`, `inspector-panels.tsx`, `selection-store.ts`): a
  bookcase with books against the back wall of the Manager's glass office,
  right of its desk, and a new inspectable object type,
  `skills-bookshelf` (`/?floor=<floor>&inspect=skills-bookshelf:<floor>`),
  "The Manager's bookshelf". Its panel is the Floor's Available Skills;
  **Run** opens the Manager chat with the command, and a link opens the
  chat. It has a hit box, a camera view, an entry in the keyboard list and
  an address, like every inspectable object.

The guide documents it: [Available Skills](../guide/notices-and-skills.md#available-skills),
the [Manager chat](../guide/events-and-chat.md#the-manager-chat) and the
3D Office's [inspectable objects](../guide/web-app.md).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (2797 passed, 374 skipped). The Skills tests that run in
      Postgres too (`orchestrator/src/skills`, `server/src/skills`) were run
      against an embedded Postgres 18.4: 61 passed.
- [x] **Playwright: open a Skill, view a supporting file, run inserts
      `/name`.** `e2e/tests/available-skills.spec.ts`, in real Chromium
      against the built app, Postgres 18 and the test's fake GitHub, with a
      repository Skill (`.claude/skills/pdf-processing`, with
      `scripts/extract.py`) and an office Skill written in Admin's editor:
  - **beside the Manager chat**: the list shows both, with their
    descriptions and sources; **Open pdf-processing** shows the modal with
    `SKILL.md` rendered (its heading, its numbered list, `strong` text) and
    where it comes from; the supporting file `scripts/extract.py`, read
    from the repository through the GitHub App, is shown in the modal;
    **Run /pdf-processing** closes it and the box holds `/pdf-processing `,
    focused;
  - **from Admin**: the card shows the first Floor's Skills; opening
    `release-notes` shows it rendered, from the office library; **Run**
    opens `/floors/web-shop/manager` with `/release-notes ` in the box.

  Both pass (output below).

Besides, in Vitest (`apps/web`):

- `available-skills.test.tsx` (6 tests): the entries' name, source and
  description; the modal's rendered `SKILL.md` (heading, link opening in a
  new tab), its supporting files, a supporting Markdown file rendered, run;
  why the repository's could not be read; Admin's Floor select and run
  opening the chat with the command; `withSkillCommand`; HTML, images and
  `javascript:` links in a Skill's Markdown rendered harmlessly.
- `manager-chat.test.tsx` (2 new): the list beside the chat, run putting
  `/pdf ` before what was written and focusing the box, a second run
  replacing the command; `?skill=pdf` put in the box and cleared from the
  address.
- The 3D Office's tests now expect the new object wherever they list a
  Floor's objects (`inspectable.test.ts`, which also checks that its box
  covers the bookcase and that it stands inside the Manager's office;
  `inspectable-hotspots.test.tsx`; `stores.test.ts`; `office-view.test.tsx`,
  which opens its panel and checks its text and link).
- `orchestrator/src/skills/floor.test.ts` (2 new): `get` and `available`,
  a repository Skill's whole folder from GitHub, `SKILL.md` first;
  `readGitHubSkillFolder` refusing a symbolic link, a binary file, more
  than 200 files and a missing folder.
- `server/src/skills/floor-routes.test.ts` (2 new, in memory and in
  Postgres): the route's body, and its 404s.

### How Postgres and Chromium were run here

There is no Docker in this sandbox, so I used the method of the earlier
issues.

- **Postgres:** `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, outside the repository, on port 54329.
  - For the Postgres unit tests, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at that
    server through `SCRATCH_PG_URL`, with database names unique per
    worker. It was reverted with `git checkout`, and nothing from it is
    committed.
  - Playwright used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium:** installed with `playwright install chromium`. Its missing
  shared libraries were extracted from Debian bookworm's packages into
  `/tmp/chromelibs`, outside the repository, and used through
  `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against the embedded Postgres 18.4
  instead, and run in CI.
- **The real GitHub App and the `ai-office-sandbox` repository** (Owner
  action #18): a repository Skill's folder was read from the fake GitHub
  through the real App client (`repos.getContent`), not from GitHub.
- **The bookshelf's look in the 3D Office**, at the art direction's bar,
  is for the host (PRD §9). Its placement, hit box, camera view, keyboard
  entry, address and panel are covered by the unit tests above; it was not
  driven in Playwright.

## The whole Playwright suite

`pnpm e2e` with Playwright's default 8 workers overloaded this sandbox
(16 CPUs shared, and a host disk at 100%: one run ended in `ENOSPC: no
space left on device` while writing a trace), so 19 tests timed out on
pages this issue does not touch. Run with 2 workers, as CI runs it, in
two halves: **43 passed, 3 failed**. The 3 fail the same way at `HEAD`
without this issue's changes (checked with `git stash`, a rebuild and the
same run), because they look for cards on Admin that the merged AI
Settings page (#165) moved there:

- `agent-editor.spec.ts:59` and `manager-chat.spec.ts:110` wait for the
  **Add an AI Account** form on Admin (it is on AI Settings now);
- `gateway-requests.spec.ts:24` waits for **Keep request and response
  bodies (encrypted)** on Admin (also AI Settings now).

They are outside this issue and are left as they are. A fix is to open
**AI Settings** instead of **Admin** in those three specs.

## Output

### `pnpm lint`

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0
```

### `pnpm typecheck`

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test` (no Docker: the Postgres tests skip)

```text
 Test Files  241 passed (241)
      Tests  2797 passed | 374 skipped (3171)
exit=0
```

### The Skills tests against the embedded Postgres 18.4

```text
$ SCRATCH_PG_URL=… pnpm vitest run --project @ai-office/server --project @ai-office/orchestrator src/skills
 Test Files  5 passed (5)
      Tests  61 passed (61)
```

### Playwright (`E2E_POSTGRES_URL`, embedded Postgres 18.4, Chromium, 2 workers)

```text
$ pnpm exec playwright test --workers=2 tests/sign-in.spec.ts tests/accessibility.spec.ts tests/available-skills.spec.ts tests/skills.spec.ts
  19 passed (3.0m)

$ pnpm exec playwright test --workers=2 <the other 18 spec files>
  ✘   3 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (31.7s)
  ✘  17 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (14.3s)
  ✘  18 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (32.0s)
  3 failed
  24 passed (2.4m)

# The same three at HEAD, without this issue's changes:
  ✘  4 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (10.6s)
  ✘  3 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (31.6s)
  ✘  5 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (30.2s)
```

## Notes

- **"In the office admin".** Available Skills are a Floor's (the
  repository's Skills differ per Floor), so Admin's card has a Floor
  select, and its run button opens that Floor's Manager chat with the
  command, as there is no chat on Admin.
- **"On the Manager's office bookshelf".** The glass office had no
  bookshelf, and the Floor's bookshelf is its memory (FR-58), so this adds
  one in the Manager's office. Clicking the glass office does not open the
  chat in the 3D Office yet (FR-24's "clicking the Manager's glass office"
  is not built on this branch), so the bookshelf's run opens the 2D chat
  page.
- **Which Skills.** Every Skill on the Floor is listed. The Floor admin's
  per-Role switches are for the Roles whose Agents work in sandboxes
  (FR-75); the Manager has none.
- **Run** inserts `/name ` with a trailing space, for the arguments
  (FR-74). Running a Skill (`/name` in the chat) is #93.

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `97de0fe`, after merging `feat/issues-110-130-b` into the
integration branch (`d5ae18f`) and its follow-ups: `1b5254a`
(configuration export and import carry Fresh Start thresholds) and
`97de0fe` (a Kickoff acknowledgement is no working context).

- **Migrations.** The integration branch keeps `0044_retention` to
  `0047_connection_delivery_retention`. This branch's
  `0044_context_usage_and_fresh_starts`, `0045_manager_chat_skills`,
  `0046_grilling_sessions` and `0047_manager_chat_compaction` are replaced
  by one regenerated `0048_context_usage_skills_and_grilling`, which this
  file now names. `drizzle-kit generate` finds nothing more to generate.
  It has not been applied to a real Postgres here (no Docker).

- **The bookshelf in the Manager's office** joins the Floor beside the
  other side's meeting walks and idle activities; the layout, meeting-walk
  and idle-behaviour tests check every path against all furniture,
  this bookshelf included, and pass.
- **Admin** shows the Available Skills card beside the other side's
  configuration and webhooks cards.

### Output of the checks

```text
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  279 passed (279)
      Tests  3179 passed | 448 skipped (3627)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 448 skipped tests need what the sandbox lacks: Postgres 18 and
Mailpit through Testcontainers (Docker), Docker, hadolint or Caddy for
the deployment, or the real GitHub App. They run on the host and in CI.

The Available Skills and Floor layout tests:

```text
 Test Files  4 passed (4)
      Tests  102 passed | 6 skipped (108)
```

## Playwright on the integration branch

The Owner's run of the suite on the host found 5 failures: three that
also fail on `main`, and this issue's and #93's Available Skills tests.
Each was reproduced here, and in each case the test was stale, not the
app:

- **`available-skills.spec.ts:44` and `:110`** (#92, #93; now `:49` and
  `:116`). Since #94 merged, every Floor also has AI Office's own
  `/grilling` Skill. The list shows it as **Built in** and the Manager
  chat's autocomplete offers it, as the guide says
  ([Grilling Sessions](../guide/events-and-chat.md#grilling-sessions)).
  It sorts first, so both lists now have three entries. The tests expect
  it, with its full description, and the autocomplete test takes two
  ArrowDowns to reach `/release-notes`. It also now checks that the
  first option starts selected and that each ArrowDown moves the
  selection by one (`a1f7487`).
- **`agent-editor.spec.ts:59`, `manager-chat.spec.ts:110` and
  `gateway-requests.spec.ts:24`** (from #47, #78 and #53). #165 moved the
  AI Providers, AI Accounts, Gateway Keys and request bodies cards from
  Admin to **AI Settings**, but the tests still looked for them on Admin.
  They now add the AI Account (and Grok's default Model) and untick
  **Keep request and response bodies (encrypted)** on AI Settings, and
  add the Floor on Admin. No assertion changed. #166 played no part
  (`84aab40`).

The run used the same set-up as above: `E2E_POSTGRES_URL` pointed at an
embedded Postgres 18.4 (`@embedded-postgres/linux-x64@18.4.0-beta.17` in
`/tmp/pg18`), and Chromium's libraries came from Debian bookworm's
packages in `/tmp/chromelibs`, `libcups2` included for the full Chromium
that `notice-alerts.spec.ts` launches. All of it is outside the
repository. The suite was run with 2 workers, after `pnpm build`, at
`84aab40`:

```text
$ pnpm build && pnpm --filter @ai-office/e2e exec playwright test --workers=2
Running 48 tests using 2 workers
  ✓  14 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (3.8s)
  ✓  20 [chromium] › tests/available-skills.spec.ts:49:1 › opens a Skill beside the Manager chat, views a supporting file, and run puts /name in the box (2.8s)
  ✓  22 [chromium] › tests/available-skills.spec.ts:116:1 › autocompletes /name in the Manager chat from the Floor's Skills (#93) (2.5s)
  ✓  32 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (2.4s)
  ✓  33 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (3.0s)
  …
  48 passed (3.0m)

$ pnpm lint
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  279 passed (279)
      Tests  3179 passed | 448 skipped (3627)
test exit=0
```

The 448 skipped tests need Docker (Postgres and Mailpit through
Testcontainers, and the deployment checks), as above. Only e2e specs
changed, so they are unaffected.
