# Issue #145: Roles as data: the Role library, the four Stages and needs-work — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) in the working tree of this branch. `pnpm lint` and `pnpm
typecheck` ran at `e6dcdb9` (every code and docs commit of the issue);
the test runs were made on the same code (the in-memory runs just before
the commits, whose only later code change is the order of one import
list; the Postgres run at `e6dcdb9` with a scratch edit, below). The
blockers are built: the Review Loop and Round Cap (#54, `issue-54.md`),
the Merge Policy (#57, `issue-57.md`) and the Floor admin's team (#58,
`issue-58.md`).

## What was built

### The model (`packages/shared`)

- **`roles.ts`** (new): the four **`stages`** (`work`, `review`, `qa`,
  `docs`) and each one's label, **`stageLabels`** (`needs-work`,
  `needs-review`, `needs-qa`, `needs-docs`), with `stageOfLabel`;
  **`sandboxStages`** (work, QA and docs: FR-19); **`managerRole`**
  (`manager`, built in, never a library Role); **`roleIdSchema`**;
  **`deskDressings`** (`monitor`, `dual-monitors`, `printouts`,
  `test-devices`, `books`); **`roleDefinitionSchema`** (id, name,
  Stage, one-line routing description, instructions, Skills, desk
  dressing, suggested AI Provider and Model); and **`builtInRoles`**:
  coder (work), reviewer (review), QA (qa), docs (docs, suggesting
  `claude-haiku-5-5`, as docs Agents had by default) and designer
  (work), under the ids Agents already had. `roleName(id)` and
  `inLibraryOrder(ids)` for display.
- **Each built-in Role's instructions are the text its prompt always
  had**, moved out of code: the coder's "Make the smallest change…"
  bullet, QA's checks 2 and 3, docs' steps 2 to 5 and the reviewer's
  "Review the change against the issue…". The designer had no prompt of
  its own, so its instructions are the coder's bullet with "in keeping
  with the design the repository already has".
- **`agents.ts`**: `Role` is now a library Role's id or `manager` (a
  string, not an enum). The fixed `roles`, `roleNames`, `smallModels` and
  `roleDefaultModel` are gone (the Role's suggestion replaces the last
  two). The API's Agent carries its Role's **`stage`** (null for the
  Manager); a new error code, **`role_not_found`**.
- **`pipeline.ts`**: `needs-code` is now **`needs-work`** ("AI Office:
  waiting for its work"), and `renamedPipelineLabels` says `needs-code`
  became it. The wall board's "Work" column follows.
- Role memory's `role` and the `agent.created` and `memory.role_*`
  events' `role` (`packages/events`) accept any library Role's id;
  stored events still parse.

### The database (`packages/db`)

Migration **`0066_roles_as_data`** (written as `0044`, renumbered after
main's `0044`–`0049` in [the merge note](merge-main-into-131-to-153.md)):

- creates **`roles`** (`id` slug, never `manager`; unique `name`;
  `stage` in the four; `description`; `instructions`; `skills` jsonb;
  `desk_dressing` in the five; `ai_provider` and `model`, a model only
  with an AI Provider) and inserts the five built-in Roles (the seed rows
  were generated from `builtInRoles`, and a test checks they still
  match);
- drops the `agents_role` and `role_memory_role` checks. An Agent now
  references its library Role through **`agents.role_id`**, a stored
  generated column (`NULLIF(role, 'manager')`) with a foreign key to
  `roles(id)`: every Agent but the Manager must be in a library Role,
  and existing rows (`coder`, `reviewer`, `qa`, `docs`, `designer`) are
  already. `role_memory.role` has a foreign key to `roles(id)`;
- renames `needs-code` to `needs-work` in `work_queue.stage`,
  `handoffs.stage` and `manager_decisions.stage`/`to_stage`, then puts
  back the stage checks with `needs-work`.

### The orchestrator (`packages/orchestrator`)

- **The Role library** (`roles/store.ts`): `RoleStore` (`list`, `get`,
  `create`, `update`) kept in memory or in `roles`; `OfficeStores.roles`.
  `roles/roles.ts`: `stageIn`, **`startingModel`** (a Role's suggested AI
  Provider and Model, or the office default, Claude with its default
  Model, when the Owner has no AI Account for the suggested one; the
  office default needs none) and **`roleOfAgent`** (a task reads its
  Agent's Role as it starts).
- **`AgentRecord.stage`**: each Agent's Role's Stage, as the library has
  it when the Agent is read (the database store joins `roles`; the
  memory store looks it up in its library).
- **By Stage, never by name** (ADR 0003):
  - dispatch (`chooseAgent`, `rebalance`, `freeAgent`) gives work at a
    label to the Agents in its Stage (`sandboxStageAt` replaces the
    `sandboxRoles` map);
  - the pipeline's `stageAfter` skips QA or docs when no Agent is in
    that Stage;
  - required reviewers are the review-Stage Agents (Agents and Floors);
  - the watchdog reassigns only to an Agent in the work's Stage;
  - a Plan gives issues to work-Stage Agents (`plannableCoders`);
  - the queue holds work for sandbox-Stage Agents paused or leaving.
- **Prompts**: the work, review, QA and docs prompts take the Agent's
  Role (`role: { name, instructions }`): "You are Ada, a *coder* Agent…"
  is the Role's name, and its instructions sit where the Stage's work is
  set out. The Agent's extra instructions still end the prompt, as "The
  Owner's instructions for you". For the built-in Roles the work, QA and
  docs prompts are as before, character for character; the reviewer's
  one paragraph is now two (its Role's instructions, then "You are given
  the issue, …"). The coder, QA, docs and review flows read the Role
  from the library every task (`roles` option), and each reviewer is
  given its own Role's memory.
- **Agents**: `createAgents` and `createFloors` take the library and the
  AI Providers the Owner has an AI Account for (`aiAccountProviders`). A
  new Agent (or a new Floor's team) starts on its Role's suggestion, with
  the fallback above; a Role the library does not have is
  `role_not_found`.
- **Skills**: a sandbox is given Skills for any Role whose Stage works in
  sandboxes, not only the built-in ones.
- **The label rename** (`renameRetiredLabels`, intake): `needs-code` is
  renamed `needs-work` on a Floor's repository, with `needs-work`'s
  colour and description, before intake creates the labels. A
  repository that has both keeps both.

### GitHub (`packages/github`)

`renameLabel(name, { name, color?, description? })` on the App's client
(`PATCH /repos/{owner}/{repo}/labels/{name}`), the in-memory fake (the
label stays on its issues, renamed, with no label event, as on GitHub;
`422` for a taken name) and the fake's HTTP server. The Manager's
restricted client refuses it, as repository settings.

### The server and the web app

- **`apps/server`**: the stores' Role library and the AI Accounts'
  providers are given to the Agents, Floors, Floor Skills and the four
  flows. Before the work queue starts, each Floor's repository has
  `needs-code` renamed (logged; a failure is a warning and intake tries
  again). `PUT /team/:role` and `POST /agents` answer `404
  role_not_found` for a Role the library does not have (they answered
  `404 Not Found` and `400 invalid_request` before).
- **`apps/web`**: compiles against string Roles. The Team card and Add
  Agent list the built-in Roles (see Notes); Role memory lists the Roles
  its entries name; the desk's dressing and Stage colour come from the
  Role's desk dressing and Stage.

### Docs

README: "Roles and Stages" (new) and the guide table. The guides
(Floors and Agents: "Roles and the Role library", new; the issue
pipeline: Stages and dispatch by Stage; the rest `needs-work`) and the
setup guide's label table and rename note.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck exit 0. `pnpm test` with Vitest's default workers had one
      failure: a 5 s timeout in the 3D scene's `floor-layout.test.ts`
      ("keep every path of 7 Agents' Floor clear…", host load average
      about 41 on 16 cores), the same load timeout #88 and #89 recorded.
      That file passes alone, here and on the base commit `d864dec` in a
      separate worktree, in the same time (about 2 s for its slowest
      test), and this issue's change to it (`deskOf(role)` without a
      cast) does not change what it computes. With `--maxWorkers=4`, and
      against Postgres, every file passes (output below):
  - without Docker: **236 files, 2747 passed, 374 skipped** (the
    Postgres tests skip with the reason), exit 0;
  - against an embedded **Postgres 18.4** (below): **236 files, 3099
    passed, 22 skipped** (the GitHub contract against the real App,
    which needs `GITHUB_APP_ID`, and the checks that need Docker), exit
    0.
- [x] **Migration test: existing Agents keep their Roles and
      instructions; a Development Floor's scenario tests (Review Loop,
      Round Cap, Merge Policy) pass unchanged.**
  - `packages/db/src/roles-migration.test.ts` (**Postgres 18.4**):
    empties the database, migrates it to `0043`, adds a Floor with a
    Manager, coder (extra instructions "Prefer small functions."),
    reviewer (ChatGPT), QA (its own extra instructions), docs (on
    `claude-haiku-5-5`) and designer (Gemini), work at `needs-code`
    (queued and finished) and a QA Role memory entry; then runs every
    migration. Each Agent keeps its `role`, AI Provider, Model override
    and extra instructions; its `role_id` is its Role (null for the
    Manager) and the join gives the Role's Stage and instructions (the
    coder's "Make the smallest change…", the reviewer's "Review the
    change against the issue"); the library is exactly the five Roles
    (QA named `QA`); both work rows are at `needs-work`; the memory
    entry keeps `qa`. An Agent in a Role the library does not have is
    refused until the Role is added; a library Role called `manager` is
    refused.
  - `roles.test.ts` > "is seeded by the migration with exactly the
    built-in Roles" (no Postgres needed): every field of every
    `builtInRoles` entry is in its row of the migration's `INSERT`, and
    there are no other rows.
  - `roles.test.ts` > "keeps an existing Agent in its Role, with its
    Role's instructions and its own on top": a new Floor's coder, as
    stored before (`role: "coder"`), reads as Stage `work`, its Role is
    the built-in coder, and its prompt has "a coder Agent", the coder's
    bullet between the test command and "AI Office pushes your branch",
    as before, and its extra instructions after it.
  - **The scenario tests are unchanged** but for the label: for
    `review/loop.test.ts` (Review Loop, Round Cap and stalls),
    `merge/merge-loop.test.ts` (Merge Policy), `qa/qa-loop.test.ts`,
    `docs/docs-loop.test.ts`, `review/conflict-loop.test.ts`,
    `review/reviewer.test.ts` and `qa/caps.test.ts`, the file at `d864dec`
    and this branch's with `needs-work` put back to `needs-code` are
    identical (`diff` prints nothing; below). They pass, in memory and
    in Postgres.
- [x] **Integration test: `needs-code` is renamed `needs-work` on a
      Floor's repository in the fake GitHub, and issues keep the label.**
  - `intake/intake.test.ts` > "renames needs-code to needs-work on an
    existing Floor's repository, and its issues keep it": a Floor's
    repository with `needs-code` (`#1d76db`, "waiting for a coder"), an
    issue at it and one at `needs-review`. After one intake poll the
    first is `ai-office` + `needs-work` with no new label event (renamed,
    not removed and added), the second is unchanged, `needs-work` has its
    new colour and description, `needs-code` is gone, nothing is queued
    (both are in the pipeline), and renaming again renames nothing.
  - "leaves both labels when a repository has needs-work already": the
    rename is refused, and the issue keeps `needs-code`.
  - `packages/github/src/contract.test.ts` > "renames a label, which its
    issues keep under the new name", against the in-memory fake **and
    the App's own client over HTTP** to the fake's server: the issue
    keeps it under the new name, a missing label answers false, a taken
    name is `422`.
  - The server renames it on every Floor before the work queue starts
    (`apps/server/src/server.ts`); that start-up path is not under test
    (it needs the GitHub App and the real server: see below).
- [x] **Unit tests: dispatch and the pipeline choose by Stage; a new
      work-Stage Role with a new name is dispatched like a coder.**
  - `manager/dispatch.test.ts` > "choosing by Stage, never by a Role's
    name": a `copywriter` Agent (Stage work) gets new `needs-work` work,
    is the free Agent, and takes waiting work in `rebalance`; with two
    coders it shares the load and takes work waiting behind a busy
    coder; and an Agent whose Role is called `qa` but is in the docs
    Stage gets `needs-docs` work and never `needs-qa`. The existing
    dispatch tests build Agents with their built-in Role's Stage.
  - `pipeline/pipeline.test.ts` > `stageAfter`: by Stages (the Manager's
    `null`, `work`, `review`, `qa`, `docs`); and "goes by the Agents'
    Stages, whatever their Roles are called": a Floor whose QA-Stage
    Role is `store-qa` (from the library, through the memory Agent
    store) goes from review to `needs-qa`, then to `ready-to-merge`.
  - `roles/roles.test.ts` > "is dispatched like a coder…" (end to end,
    the scenario harness's new `workRole` option): a `copywriter` Role is
    added to the library and its Agent, Cora, replaces the Floor's coder.
    Intake's work goes to Cora (`issue.assigned`), whose prompt is "You
    are Cora, a copywriter Agent…" with the copywriter's instructions and
    not the coder's; then review, QA and the Merge Policy run as for a
    coder: `ready-to-merge`, every stage finished.

**The rest of "What to build", and how it was checked:**

- **Editing a Role changes every Agent with it, an Agent's own extra
  instructions still on top**: `roles.test.ts` > "editing a Role…": the
  built-in coder's instructions are changed in the library before the
  pipeline runs; the coder's prompt has the new ones, not the old, and
  its extra instructions after them.
- **A suggested AI Provider with no AI Account falls back to the office
  default**: `roles.test.ts`: a library Role suggesting Gemini and
  `gemini-3-pro` gives a new Agent Gemini with that Model when the Owner
  has a Gemini AI Account, and Claude with its default Model when not;
  the docs Role's suggestion (Claude, the office default) stands with no
  AI Account at all, so a new Floor's docs Agent still gets
  `claude-haiku-5-5` (`agents.test.ts`'s case for it, unchanged, passes). An unknown
  Role is `role_not_found`.
- **The Manager stays built in**: no library Role is `manager` (schema,
  `roles_id` check, `roleIdSchema`); `agents.role_id` is null for it.
- **The README** has "Roles and Stages".

**Negative checks.** Each sabotage was applied to the working tree, the
tests named run, and reverted with `git checkout` (`git status` clean
afterwards).

| Sabotage | Tests | Failed |
| --- | --- | --- |
| `chooseAgentByLoad` picks by Role name (`coder` for work) | `dispatch.test.ts`, `roles.test.ts` | 3 of 24 |
| Intake no longer renames retired labels | `intake.test.ts` | 1 of 11 |
| The work prompt hard-codes the coder's bullet instead of the Role's instructions | `roles.test.ts`, `coder/` | 2 of 23 |
| `stageAfter` never counts a QA-Stage Agent | `pipeline.test.ts` | 2 of 10 |
| `startingModel` ignores whether there is an AI Account | `roles.test.ts` | 1 of 8 |

### Not verifiable in this sandbox

- **Testcontainers**: the Postgres tests' Docker path. They ran against
  an embedded Postgres 18.4 instead
  (`@embedded-postgres/linux-x64@18.4.0-beta.17`, unpacked in `/tmp`,
  port 54329), the Vitest fixture pointed at it by a scratch edit to
  `packages/db/src/testing/postgres.ts` (a `SCRATCH_PG_URL` server, and a
  random suffix on the template and test database names), reverted and
  never committed. CI runs them with Docker.
- **`pnpm e2e`** (Playwright) was not run: the host's disk had under
  1 GB free, too little for Chromium and its system libraries. It
  typechecks, and its only change is the label in
  `status-report.spec.ts`.
- **A real GitHub repository**: the rename against GitHub itself (the
  contract suite's real-App target needs `GITHUB_APP_ID`), and the
  server renaming every Floor's label as it starts, for the host.
- **The 3D Office**: desks are dressed as before (the dressing now comes
  from the Role's desk dressing, the same for each built-in Role, and a
  floor-layout test still checks each Stage's stripe colour), but how it
  looks needs the host's GPU.

## Notes

- **Designer Agents now get work.** The designer was a Role with no
  Stage, so dispatch never gave it any. Every library Role is in one
  Stage (ADR 0003), and the designer's is work, so a Floor that has a
  designer now shares its work between its coders and designer as one
  team. Routing between work Roles by their descriptions (or a
  `role:<name>` label) is #148. A Development Floor has no designer, so
  it behaves as before.
- **Prompts.** The reviewer's prompt is the only built-in one whose text
  changed: its job sentence and "You are given …" are now two
  paragraphs, since a Role's instructions may be several lines.
- **Owner-made Roles' names outside prompts.** Commit trailers, progress
  comments, the Manager's team list and Role memory headings name a
  Role by `roleName(id)`: the built-in Roles' names, or else the id.
  Prompts use the library's name. No Owner-made Role exists until the
  Role library's admin (#146); its ids should be slugs of their names.
- **A Role's Skills** are stored, for the Role library's admin and
  Floor Templates; mounting still follows FR-75 (every Skill on for every
  sandbox Role unless the Floor turns it off).
- **Status codes.** A Role the library does not have is `404
  role_not_found` in `POST /agents` (was `400 invalid_request`) and `PUT
  /team/:role` (was `404 Not Found`); `team.test.ts` says so.
- **Stored events** keep the labels they were recorded with
  (`needs-code` in old `issue.label_changed` events): the Activity Feed
  is history.

## Noticed, out of scope

- **The web app lists the built-in Roles** (Team card, Add Agent, the
  Floor admin's Skill toggles, whose `floor_skill_toggles` check still
  names the four built-in sandbox Roles). Reading the library from the
  API, and adding, editing and importing Roles, is the Role library's
  admin (#146).
- **Routing between several work Roles** and the `role:<name>` label
  (#148); **Floor Templates** (#147).
- **`floor-layout.test.ts`'s 5 s timeouts under load**, as #88 and #89
  recorded: its slowest test takes about 2 s alone.

## Output

### `pnpm lint` and `pnpm typecheck` at `e6dcdb9`

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

### `pnpm test`, without Docker

With Vitest's default workers (host load average 40.65 on 16 cores):

```text
$ pnpm test
     × keep every path of 7 Agents' Floor clear of furniture and walls 5151ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 7 Agents' Floor clear of furniture and walls
 Test Files  1 failed | 235 passed (236)
      Tests  1 failed | 2746 passed | 374 skipped (3121)
exit 1
```

The file alone, here and on `d864dec` (a separate worktree):

```text
$ pnpm vitest run src/scene/floor-layout.test.ts   # this branch
      Tests  77 passed (77)
   Duration  16.65s
$ pnpm vitest run src/scene/floor-layout.test.ts   # d864dec
      Tests  77 passed (77)
   Duration  13.36s
```

With four workers:

```text
$ pnpm test --maxWorkers=4
 Test Files  236 passed (236)
      Tests  2747 passed | 374 skipped (3121)
   Duration  177.63s
exit 0
```

### `pnpm test` against the embedded Postgres 18.4, at `e6dcdb9`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=2
 Test Files  236 passed (236)
      Tests  3099 passed | 22 skipped (3121)
   Duration  344.41s
exit 0
```

The migration test and the Postgres variants of the Agent, team, Floor,
memory, queue, watchdog, Plan and cap tests, on their own:

```text
$ SCRATCH_PG_URL=… vitest run src/roles-migration.test.ts src/migrate.test.ts   # packages/db
 Test Files  2 passed (2)
      Tests  7 passed (7)
$ SCRATCH_PG_URL=… vitest run --maxWorkers=1 src/agents src/manager src/skills src/memory src/work src/floors src/review/store.test.ts src/wall-board src/batches src/caps   # packages/orchestrator
 Test Files  32 passed (32)
      Tests  444 passed (444)
```

### The scenario tests differ from `d864dec` only by the label

```text
$ for f in review/loop merge/merge-loop qa/qa-loop docs/docs-loop review/conflict-loop review/reviewer qa/caps; do
    diff <(git show d864dec:packages/orchestrator/src/$f.test.ts) \
         <(sed 's/needs-work/needs-code/g' packages/orchestrator/src/$f.test.ts) | wc -l
  done
0
0
0
0
0
0
0
```

### The new and changed tests

`roles.test.ts` (8), `dispatch.test.ts` (16), `pipeline.test.ts` (10)
and `intake.test.ts` (11), in memory; and the GitHub contract (the
in-memory fake and the App over HTTP; the real App skipped):

```text
$ vitest run src/roles src/manager/dispatch.test.ts src/pipeline src/intake/intake.test.ts   # packages/orchestrator
 Test Files  4 passed (4)
      Tests  45 passed (45)
$ vitest run src/contract.test.ts   # packages/github
 Test Files  1 passed (1)
      Tests  28 passed | 14 skipped (42)
```
