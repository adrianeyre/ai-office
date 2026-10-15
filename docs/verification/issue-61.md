# Issue #61: Floor admin: settings and team management — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code commit
(`19be18e`), with the README commit after it (`538ae2b`) changing only
Markdown.

The blockers are built on this branch:

- #47, the Agent config editor ([`issue-47.md`](issue-47.md)): the Floor
  admin's Agents table, `PATCH /api/floors/:floorId/agents/:agentId` and
  the editor, which a newly added Agent's editor reuses;
- #60, the Merge Policy ([`issue-60.md`](issue-60.md)): the Merge Policy
  setting and the gate, which reads the required reviewers this slice
  makes editable.

The issue's comment listed what was built already (the FR-7 form, the
Agents table) and what was still to do. This slice does the "still to do"
part.

## What was built

### A Floor's team (PRD FR-10), in the orchestrator

`packages/orchestrator/src/agents/agents.ts`:

- **`addToTeam(floorId, role, name?)`** adds an Agent copied from the
  Role's first Agent (the oldest staying one): its AI Provider, Model
  override, effort, extra instructions and Token Caps (`copyOfFirst`). The
  name is the Owner's or random, and the Avatar is random and unlike the
  others on the Floor (`newAgentRecord`, as for a new Floor). Its own
  Gateway Key comes from `agent.created`, as for every Agent since #48. A
  Role with no Agent starts from the defaults (a docs Agent gets its small
  Model). A new Agent is always created after every other on its Floor, so
  "first" and "newest" hold even for copies made in the same millisecond.
  (The server test first showed that tie.)
- **`remove(floorId, agentId)`.** An idle Agent is removed at once
  (`agent.removed`). An Agent in the middle of a task becomes **leaving**:
  `leavingAt` is set and a `config.changed` event names `leaving`. A
  leaving Agent takes no new work, its waiting work moves to another Agent
  of its Role, and it finishes its task. An Agent is "in the middle of a
  task" when work of its own is running in the work queue, or when it is a
  required reviewer and a review round is running on its Floor. The
  Manager is refused (`manager_not_removable`).
- **`setTeamSize(floorId, role, count)`** counts the Role's staying
  Agents; leaving ones are not counted. Raising the count adds copies.
  Lowering it removes Agents in the order of `leavers`: idle ones first,
  newest first, then busy ones, which become leaving. The Manager's count
  is fixed at 1: 0 is `manager_not_removable` and 2 is `manager_exists`.
  The API takes 0 to 10 per Role (`maxTeamSize`).
- **`settle(floorId?)`** removes the leaving Agents whose task has ended.
  The work queue has a new `onEnded` hook, called once each piece of work's
  end is recorded. The server calls `settle` from it, and once more at
  start: work left running by a stopped server is queued again for another
  Agent, so its leaving Agents can go.
- **Dispatch** (`manager/dispatch.ts`). `takesWork` means enabled and not
  leaving. `chooseAgent`, `rebalance` and `freeAgent` use it, and the
  queue's claim passes over leaving Agents as it does paused ones.
- **Required reviewers follow the team.** A removed reviewer is dropped
  from `requiredReviewerAgentIds`. A Floor with reviewers but none required
  requires its oldest staying reviewer, so a first reviewer added to an
  empty Role is required at once. A leaving required reviewer stays
  required until it is removed. Each change is a `config.changed` event
  for the Floor (`requiredReviewerAgentIds`).

The **store** (`agents/store.ts`) has new `leave` and `remove` methods.
Migration `0036_agents_leaving` adds `agents.leaving_at` and
`agents.removed_at`. A removed Agent's row is kept, because `gateway_keys`
and `work_queue` reference it, and so do request records. `list` leaves it
out. `agents_floor_name_unique` is now a unique index over Agents not
removed, so a removed Agent's name is free again. The code that reads the
constraint's name (`isNameTaken`) is unchanged.

### Required reviewers (FR-7, FR-27)

- `floorSettingsUpdateSchema` now takes `requiredReviewerAgentIds`: at
  least one, each listed once.
- `Floors.updateSettings` checks that each one is a staying reviewer Agent
  on the Floor. Anything else is `422 not_a_reviewer`.

### The API (`apps/server/src/agents/routes.ts`)

- `POST /api/floors/:floorId/agents` with `{"role","name"}` (`name` is
  optional) answers `201` with the Agent.
- `DELETE /api/floors/:floorId/agents/:agentId` and
  `PUT /api/floors/:floorId/team/:role` with `{"count"}` answer
  `{"added","removed","leaving"}` (`teamChangeSchema`).
- A Role that does not exist is a 404.
- Agents now carry `leavingAt`.
- Log lines name counts and ids, never names typed by the Owner.
- `server.ts` builds the Agents service itself, with the work queue's
  store, and passes it to `buildApp` (`AppOptions.agents`), so the work
  queue's `onEnded` can settle leaving Agents.
- `catalogueOf` replaces two copies of the catalogue lookup.

### The Floor admin (`apps/web`)

- **Settings**: a **Required reviewers** checkbox per staying reviewer,
  showing its AI Provider and Model. Choosing none is refused before
  sending. The checkboxes follow changes made elsewhere (a reviewer
  removed) unless the Owner is editing them. Every other FR-7 setting was
  there already.
- **Team** (`team-card.tsx`): a count per Role. The Manager's is shown as
  1, read-only and "Fixed". Leaving Agents are noted under their Role.
  **Save team** sends one `PUT` per changed Role and says what happened:
  "Added Ada and Alan, copied from the first coder.", "Removed …", or "…
  is in the middle of a task, and leaves once it ends."
- **The concurrency warning** shows, as the counts are typed and after
  saving, when the coder, QA, docs and designer Agents outnumber the
  sandboxes that may run at once. That limit is the office's
  (`GET /api/office/sandboxes`), or the Floor's own when it is lower, and
  the warning says which one it is.
- **Agents**:
  - **Status** is the Agent's state as the Office shows it: Working,
    Waiting on review or Idle, plus paused, paused at a Token Cap, leaving
    once its task ends, and how many tasks wait. `agentStateText` moved
    from `office-2d.tsx` to `agent-status.tsx` and gained "leaving".
  - **Current issue** comes from the Floor's wall board: the issue, its
    stage, Working or Waiting, and its PR, linked to GitHub.
  - The table is kept live by the Floor's event stream
    (`useLiveWallBoard`, which now takes an `onEvent`).
  - **Remove** asks first. The Manager's Remove is disabled, with the
    reason as its accessible description.
  - **Add an Agent** (any Role but the Manager's, with an optional name)
    opens the new Agent's editor, to choose its AI Provider and Model (§5
    scenario 7).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). Without Docker: 2532 passed, 321 skipped
      (the Postgres tests, with the reason). With `postgresTest` on an
      embedded Postgres 18: 2832 passed, 21 skipped. Those 21 are 13 from
      the GitHub contract suite's real-App target (no `GITHUB_APP_ID`)
      and 8 from the Docker deployment and sandbox-image checks.
- [x] **Playwright: edit each setting; add a second coder; removing the
      Manager is refused.** `e2e/tests/floor-admin.spec.ts`, headless
      Chromium against the built app, Postgres 18 and the fake GitHub:
  - *Edits each of a Floor's settings, and they are kept.* The test
    first adds a second reviewer, Rex. It then changes the name, the
    default branch (`develop`, a branch pushed to the fake), the setup and
    test commands, Merge Policy, Round Cap, daily and monthly Token Caps,
    concurrency limit, priority, commit author name and email, plan
    approval, and Rex as a required reviewer. After a reload every value
    is kept, Rex shows "required reviewer" in the Agents table, and a
    branch the repository lacks is refused with GitHub's reason.
  - *Adds a second coder; removing the Manager is refused.* **Add Agent**
    with Role coder and the name Hopper opens Hopper's editor. Effort
    `high` is saved. After a reload there are two coders, the first and
    Hopper, Hopper with a Gateway Key of its own, and the team count says
    2. The Manager's Remove is disabled, and its accessible description
    is "The Manager cannot be removed: every Floor has exactly one.".
    `DELETE` on the Manager through the API answers `409
    manager_not_removable` with its message. After a reload the Manager
    is still there. Hopper, idle, is then removed at once.
- [x] **Integration tests: raising the coder count to 3 creates two
      copies with distinct names, Avatars and Gateway Keys; lowering it
      removes idle Agents first and lets a busy one finish.** These are in
      `apps/server/src/agents/team.test.ts`, in memory and in Postgres 18
      (8 cases, all passed). Each runs the app with the parts wired as
      the server wires them: the Agents service, a real work queue whose
      `onEnded` settles leaving Agents, and real Gateway Keys.
  - *Raising:* `PUT …/team/coder {"count":3}` adds two copies of the first
    coder, which carries effort `high`, extra instructions and a daily cap
    of 50,000. Both copies carry the same settings. Every name and every
    Avatar on the Floor is distinct. Each coder has its own Gateway Key:
    three different `aio_gk_…` keys, each of which authenticates as its
    own Agent.
  - *Lowering:* an issue is queued and runs for the first coder. Lowering
    to 1 removes the two idle copies (newest first) and revokes their
    keys, and the busy one stays. Lowering to 0 makes it leaving: listed
    with `leavingAt`, its key still calling models, and `DELETE` saying
    it is still leaving. When its work finishes, it is removed and its key
    no longer authenticates. The `agent.removed` events are third, second,
    first.
  - The orchestrator's own `agents/team.test.ts` (7 cases, memory and
    Postgres) covers copies, defaults for an empty Role, idle-first
    order, leaving and settling, removal, the Manager rule, required
    reviewers following the team (including a reviewer busy in a review
    round), and `updateSettings`' reviewer check.
  - `work/queue.test.ts` has a new case with the real queue. A coder
    removed mid-task finishes it and starts nothing more. It is removed
    once its work ends, and the issue that waited for it starts with the
    other coder.
- [x] **Playwright: set coders to 3 and see the concurrency warning when
      the limit is lower.** In `floor-admin.spec.ts`, a new Floor (one
      coder and one QA Agent, with the office limit of 3) shows no
      warning. Typing 3 coders gives "web-shop would have 4 sandbox Agents
      (coder, QA, docs and designer), but at most 3 sandboxes run at once
      under the office's concurrency limit. The rest wait their turn."
      After saving and a reload there are three coders, each with a
      distinct name and its own key, and the warning remains. With the
      Floor's own limit set to 2, the warning names that limit instead.
      Back to 1 coder, the warning goes and the copies are removed.
      The whole Playwright suite passed: 30 tests (27 before this slice).

### Other tests added or changed

- `apps/web/src/floors.test.tsx` has 6 new cases: status and current
  issue from the wall board; adding an Agent (options, request, editor
  opened, random name); removing (confirmation, idle at once, busy
  leaving, the Manager's disabled Remove); team size and the warning
  (office limit, and the Floor's lower one); required reviewers (sent,
  and none refused).
- `manager/dispatch.test.ts`: a leaving Agent takes no new work, and its
  waiting work moves.
- **Changed to the new behaviour, not weakened:**
  - the Agents table's expected cells (the new Current issue column,
    status as the Office says it, Remove);
  - `e2e/tests/agents.spec.ts` (`Idle` where it said `Enabled`);
  - `floors/routes.test.ts`, which held that required reviewers could not
    be set through `PATCH /api/floors/:floorId` ("Set with the Agents
    (#21), not here"). It now refuses an empty list and a non-list. A
    non-reviewer's `422` is in `agents/team.test.ts`.
  - Agent fixtures gained `leavingAt: null`.
- **Mutation checks** (each reverted; failing tests counted):
  - removing busy Agents before idle ones: 2;
  - `settle` ignoring work still running: 1;
  - `remove` ignoring a busy Agent: 3;
  - copies not copying the first Agent: 2;
  - the Manager removable: 2;
  - a leaving Agent taking new work: 2;
  - the concurrency warning never showing: 2;
  - any id accepted as a required reviewer: 2.

### How Postgres and Chromium were run here

As for earlier issues:

- **Postgres.** Postgres 18.3 from
  `@embedded-postgres/linux-x64@18.3.0-beta.16`, in `/tmp/pgpkg`, ran on
  port 54329 with default durability.
- **The scratch patch.** It pointed `postgresTest` at that server, with a
  template database per test file. It was applied only for the run and
  reverted after.
- **The end-to-end tests.** `pnpm e2e` ran with `E2E_POSTGRES_URL`.
- **Chromium.** It came from `playwright install chromium`, with Debian
  bookworm's libraries extracted to `/tmp/chromelibs`.

None of this is in the repository.

## Not verifiable in this sandbox

- **Docker:** the Testcontainers Postgres and the compose stack. The
  Postgres tests ran against the embedded Postgres 18 instead.
- **Real sandboxes:** "a busy Agent finishes its task" was checked with
  the work queue and a stand-in task, not a real Sandcastle run. A real
  run ends through the same `onEnded`.
- **The 3D Office:** that a Floor's desks reflow as Agents join and leave
  was not seen. The Floor layout is generated from the Agents, and its
  tests cover teams of 1 to 12. No GPU or display was available.
- **Real GitHub:** the default branch check ran against the fake.

## Noticed, out of scope

- **A removed Agent in the Activity Feed:** past entries for a removed
  Agent show its id, not its name, because `GET
  /api/floors/:floorId/agents` no longer lists it (`useAllAgents`). The
  row is kept, so a later slice could list removed Agents' names.
- **A leaving required reviewer** stays required until it is removed. If a
  second review round on the Floor starts while it finishes the first,
  it reviews that round too and leaves after both.
- **Floor Templates and Roles as data** (#145, FR-97 to FR-100): FR-10
  takes each Role's starting count from the Floor's template. There are
  no templates yet, so the Development team (1 Manager, coder, reviewer
  and QA; 0 docs and designer) is the default, as the issue says. #145
  will migrate the per-Role counts to library Roles.
- While setting up Postgres here, `work/queue.test.ts`'s "two coders
  share four issues…" Postgres case raced when Postgres ran with
  `fsync=off`. It raced at the commit before this slice too. With default
  durability it passed every time.

## Notes, and disagreements with the canon

- **FR-27 says each Floor names one or more required reviewers.** A Floor
  whose reviewer count is lowered to 0 has none, and its review rounds
  then raise the existing "no required reviewer" Notice. The PATCH still
  refuses an empty list, and a Floor with reviewers always requires at
  least one.
- **"Removes idle Agents first"** is read as idle first, newest first.
  That may remove the Role's first Agent (the template for copies) while
  newer ones stay busy. The next copy then follows the oldest staying
  Agent.
- **The Manager's Remove** is shown disabled rather than hidden, so the
  rule is visible. The API refuses it too.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  210 passed (210)
      Tests  2532 passed | 321 skipped (2853)
   Duration  32.96s (tests 41%, import 37%, environment 12%, transform 8%, setup 2%)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  210 passed (210)
      Tests  2832 passed | 21 skipped (2853)
   Duration  100.31s (tests 87%, import 7%, environment 3%, transform 2%)
```

The integration tests, in memory and Postgres 18:

```text
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in memory > raising the coder count to 3 creates two copies with distinct names, Avatars and Gateway Keys
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in memory > lowering it removes idle Agents first and lets a busy one finish
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in memory > adds an Agent of any Role but the Manager's, and removes one; never the Manager
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in memory > sets a Floor's required reviewers among its reviewer Agents
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in Postgres 18 > raising the coder count to 3 creates two copies with distinct names, Avatars and Gateway Keys
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in Postgres 18 > lowering it removes idle Agents first and lets a busy one finish
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in Postgres 18 > adds an Agent of any Role but the Manager's, and removes one; never the Manager
 ✓ |@ai-office/server| src/agents/team.test.ts > a Floor's team through the API, in Postgres 18 > sets a Floor's required reviewers among its reviewer Agents
```

`pnpm e2e` (the Floor admin's specs, and the total):

```text
  ✓   7 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (12.1s)
  ✓  10 [chromium] › tests/floor-admin.spec.ts:184:1 › sets coders to 3 and warns when the concurrency limit is lower (6.2s)
  ✓   8 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (18.4s)
  ✓  12 [chromium] › tests/floor-admin.spec.ts:110:1 › adds a second coder; removing the Manager is refused (6.1s)
  ✓  13 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (12.2s)
  ✓  14 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (6.3s)
  ✓  11 [chromium] › tests/floor-admin.spec.ts:24:1 › edits each of a Floor's settings, and they are kept (12.3s)
  30 passed (1.2m)
```
