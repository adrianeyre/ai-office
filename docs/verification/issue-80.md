# Issue #80: Manager dispatch and per-Floor concurrency — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `61b44af` (every code
commit of the issue, plus the README), after `pnpm install
--frozen-lockfile`. The Postgres and Playwright runs were made in the
working tree at the same code. This builds on #25 (the work queue and the
office-wide limit) and #79 (the Manager's triage, whose issue priority the
queue starts work by).

## What was built

### The Manager's dispatch rules (`packages/orchestrator`, `manager/dispatch.ts`)

Plain code, no model (PRD FR-23: "dispatch rules are plain code"). Both
functions are pure, and exported from `@ai-office/orchestrator`.

- `sandboxRoles`: the Role whose Agents work each sandbox stage
  (`needs-code` → coder, `needs-qa` → QA, `needs-docs` → docs). It moved
  here from the work queue.
- `chooseAgent(stage, agents, active, paused)`: the Agent for new work. It
  is the Floor's enabled Agent in the stage's Role with the least work
  (queued or running), preferring one not paused at a Token Cap, and the
  oldest among equals. It is null for a review round (no one Agent's) or
  when no Agent fits. This is #25's rule, now in the Manager.
- `rebalance(agents, active, paused)`: the waiting work on a Floor to move
  to a free Agent.
  - **A free Agent** is enabled, not paused at a Token Cap, and has
    nothing queued or running.
  - **Work that can move** waits for an Agent that cannot start it: one
    busy with other work, paused at a Token Cap, paused in the Agent
    editor, or removed. Work no Agent fitted when it was queued can move
    too.
  - **Each free Agent takes one piece** of its Role's waiting work, in the
    order work starts: issue priority, then oldest. It never crosses
    Roles, and never touches review rounds.

### The work queue (`packages/orchestrator`, `work/queue.ts`, `work/store.ts`)

- **New work** is dispatched with `chooseAgent`. Each assignment is an
  `issue.assigned` event: the event was already in the schema and the
  Activity Feed's text, but nothing emitted it until now.
- **Moving waiting work.** Each time the queue looks for work to start, it
  first applies `rebalance`, Floor by Floor. Each move goes through the
  store's new `reassign(id, from, to)`, which only moves work still queued
  for `from`, so a race with another claim loses nothing. Each move is an
  `issue.assigned` event plus `agent.queue_changed` for both Agents (their
  desks' ticket piles, FR-62).
- **The per-Floor limit (FR-22).** `claimNext` starts sandbox work only
  while fewer than the office-wide limit run in all, and fewer than the
  Floor's own `concurrencyLimit` (when set) run on that Floor. Review
  rounds use no sandbox, so they start whatever the limits. Both stores
  do this: in memory, and in SQL (a count of the Floor's running sandbox
  work against `floors.concurrency_limit`, inside #25's advisory-locked
  claim transaction). The limit is read at each claim, so a change applies
  at the next look. The setting, its validation (1 to 100, or none) and
  its field in the Floor admin already existed; until now nothing
  enforced it.
- **Agents paused in the Agent editor.** Their sandbox work is now held,
  as work for an Agent paused at a Token Cap already was, so no work
  starts for them. Before this, `claimNext` ignored `enabled`, so work
  queued for an Agent before it was paused would still start. That work
  now moves to a free Agent of the Role, or waits until the Agent is
  resumed.

### `apps/server`

`startOffice` wakes the work queue on these events, so the change applies
at once rather than at the queue's 30-second poll:

- `config.changed` for a Floor (its limit, its priority), for an Agent
  (enabled, …), or for `sandboxes.concurrencyLimit`;
- `agent.created`;
- `agent.removed`.

### Docs

README, "The work queue": the per-Floor limit, and the dispatch rules.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker the Postgres tests
      skip with the reason (1470 passed, 283 skipped). Against Postgres
      18.4 (below), 1734 passed and 19 skipped.
- [x] **Scenario tests: two coders share four issues; the Floor limit
      holds.** These are in `packages/orchestrator/src/work/queue.test.ts`,
      and each runs twice: with the queue in memory and in Postgres 18.
      Each case uses `web-shop`, with two coders (its own plus one added),
      and the blog with one. The work is a controllable stand-in for the
      sandbox that records which Agent did each issue and the most sandbox
      work seen running on each Floor.
  - **"two coders share four issues, the next going to whichever coder
    is free"** (office limit 3, no Floor limit):
    1. Four issues are queued on `web-shop`. The `issue.assigned` events
       read #1 → Ada, #2 → Grace, #3 → Ada, #4 → Grace. #1 and #2 run;
       #3 and #4 wait.
    2. Ada finishes #1 and starts her #3.
    3. Ada finishes #3 while Grace is still on #2. Dispatch moves #4 to
       Ada (`issue.assigned` #4 → Ada), and it starts.
    4. Grace's queue length goes 1, 0, 1, 0, and nothing is left active
       at the end.
  - **"the Floor limit holds: two coders share four issues one at a time
    while the office has room"** (office limit 3, `web-shop` Floor limit
    1):
    - The four `web-shop` issues and a blog issue are queued. `web-shop`
      runs one sandbox, and the blog's issue starts beside it. A wake and
      50 ms later, still only #1 and #20 have started, though Grace is
      free and the office has room.
    - After each finish, exactly one `web-shop` piece of work is running.
    - The most seen running on `web-shop` is 1.
    - The coders shared the issues two each: Ada did #1 and #3, Grace #2
      and #4.
  - Companion cases:
    - **"reads the Floor limit afresh, and the office limit holds over a
      higher Floor limit":** at a Floor limit of 1, #2 waits. Raised to 2,
      it starts at once. With an office limit of 1 and a Floor limit of
      5, only one runs.
    - **"moves waiting work to a free Agent: one the Owner adds, or
      another when its own is paused in the Agent editor":** the blog's
      one coder has #1 running and #2 and #3 waiting. A second coder
      joins, takes #2 and starts it. The first coder is then paused in
      the editor: when it finishes #1, its waiting #3 does not start for
      it, and once the second coder is free, #3 moves there and starts.
  - **The rules themselves:** `packages/orchestrator/src/manager/
    dispatch.test.ts` has 10 unit tests of `chooseAgent` and `rebalance`.
    They cover least work, oldest among equals, four issues in turn two
    each, paused Agents, review rounds, moving work from a busy, paused,
    disabled, removed or missing Agent, one piece per free Agent in
    priority order, keeping to the Role, and an Agent paused at a Token
    Cap not counting as free.
  - Every #25 and #79 case of the queue still passes unchanged in both
    stores. One existing test changed: `coder.test.ts` lists every event
    of an issue's run in order, and it now has `issue.assigned` after
    `issue.picked_up`.

**Negative checks.** Each sabotage was reverted afterwards (the file was
restored from a copy). Each was run on `src/work` and `src/manager/dispatch`
of `orchestrator`, in memory and in Postgres:

| Sabotage | Failed |
| --- | --- |
| The memory store ignores the Floor limit | 2 tests: "the Floor limit holds…" and "reads the Floor limit afresh…" |
| The SQL claim ignores the Floor limit | 2 tests: the same two, in Postgres |
| No rebalancing (waiting work never moves) | 4 tests: "two coders share four issues…" and "moves waiting work…", in each store |
| Work for an Agent paused in the editor is not held | 2 tests: "moves waiting work…", in each store |
| New work always goes to the first coder (no least-work choice) | 9 tests, including both scenarios and #25's limit tests |

The first run of the SQL sabotage failed only "the Floor limit holds…".
"reads the Floor limit afresh…" could pass its first step on a race, as
it only waited for #1 to start. It now also checks, after a wake and 50
ms, that #2 has not started; with that change the sabotage fails it in
Postgres too (as the table shows).

### Not verified by a test

- **The server's wake on a change.** No server-level test runs
  `startOffice` with a working sandbox runner. The e2e harness's stand-in
  runner fails each task at once, so no limit can be seen there. The
  wiring is covered by `pnpm typecheck` and by the queue's own `wake()`
  cases. Without it, a new limit still applies at the queue's next poll
  (at most 30 seconds).

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against an embedded Postgres 18.4
  instead, and run in CI.
- **Real sandboxes:** two coders in real Docker sandboxes, through real
  Sandcastle runs, are for the host. Here, work was a stand-in.

## Notes and things outside this issue's scope

- **Assignments are events, not issue comments.** FR-23 says "every
  Manager decision is logged as a comment on the issue". Dispatch is in
  the Activity Feed (`issue.assigned`). On the issue, the progress
  comment names the Agent once work starts. A comment for every
  assignment, and every move, would add GitHub writes for little gain,
  so none is posted. If one is wanted, it belongs with the progress
  comment and its batching.
- **A Floor limit above the office's** is accepted (the schema allows 1 to
  100, the office 1 to 50) and simply has no effect, as FR-22's "lower
  per-Floor limit" implies. Refusing it, or warning in the Floor admin,
  could come with FR-10's warning (below).
- **FR-10's warning** ("the Floor admin warns when a Floor has more
  sandbox Agents than its limits let run at once") is not built. It
  belongs with team sizes.
- **Roles and routing (ADR 0003, FR-23).** Choosing a work Role from each
  Role's routing description, `role:<name>` labels, and asking the Owner
  when it cannot tell all come with Roles as data (Phase 8). Today's
  Roles are fixed, one per stage, so `sandboxRoles` maps a stage to its
  one Role. The rules are written against stages, so a Role library can
  replace that map.
- **Work paused at a Token Cap can move.** Work put back in the queue
  while its Agent is paused at a Token Cap can now go to a free coder.
  The coder carries on from the pushed branch (`ai-office/<issue>-…`),
  as any coder would.
- **Plans (#83)** are out of scope. A Plan's assignments would set the
  Agent when work is queued, and need a way to pin it, so `rebalance`
  leaves it alone.
- **Label names.** The code still calls the work stage `needs-code`, while
  the PRD and ADR 0003 say `needs-work`. That rename comes with Floor
  Templates and is not part of this issue.

## Output

### Fresh clone at `61b44af`

```text
$ pnpm install --frozen-lockfile
Done in 1.1s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  145 passed (145)
      Tests  1470 passed | 283 skipped (1753)
test exit=0
```

### Against the embedded Postgres 18.4

```text
$ SCRATCH_PG_URL=… pnpm vitest run --project @ai-office/orchestrator src/work src/manager src/intake src/coder
 Test Files  10 passed (10)
      Tests  160 passed (160)

$ SCRATCH_PG_URL=… pnpm test
 Test Files  145 passed (145)
      Tests  1734 passed | 19 skipped (1753)
exit=0
```

The 19 skips are those of #79: the real-App GitHub contract (no
`GITHUB_APP_ID`), and the Docker image and compose checks.

### The new tests (verbose, in memory and Postgres)

```text
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > choosing the Agent for new work > gives it to the Agent in the stage's Role with the least work, the oldest among equals 1ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > choosing the Agent for new work > gives four issues in turn to two coders, two each 1ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > choosing the Agent for new work > passes over Agents paused in the Agent editor, and those paused at a Token Cap while another can work 0ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > choosing the Agent for new work > gives no one Agent a review round, nor work no Agent's Role fits 0ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > moving waiting work to a free Agent > moves nothing while each waiting piece of work's Agent can start it 0ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > moving waiting work to a free Agent > moves work waiting behind a busy Agent to a free one in the Role 0ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > moving waiting work to a free Agent > moves work whose Agent is paused, in the editor or at a Token Cap, has gone, or never was 1ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > moving waiting work to a free Agent > gives each free Agent one piece, in the order work starts: issue priority, then oldest 0ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > moving waiting work to a free Agent > keeps to the stage's Role, and leaves review rounds alone 0ms
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > moving waiting work to a free Agent > does not count an Agent paused at a Token Cap as free 0ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > two coders share four issues, the next going to whichever coder is free 116ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > the Floor limit holds: two coders share four issues one at a time while the office has room 257ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > reads the Floor limit afresh, and the office limit holds over a higher Floor limit 154ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > moves waiting work to a free Agent: one the Owner adds, or another when its own is paused in the Agent editor 204ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > two coders share four issues, the next going to whichever coder is free 1679ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > the Floor limit holds: two coders share four issues one at a time while the office has room 403ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > reads the Floor limit afresh, and the office limit holds over a higher Floor limit 306ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > moves waiting work to a free Agent: one the Owner adds, or another when its own is paused in the Agent editor 355ms
Tests  42 passed (42)
```

### `pnpm e2e` (embedded Postgres 18.4, Chromium)

The server now emits `issue.assigned` as it queues work, and wakes the
queue on changes. The existing suites still pass:

```text
Running 22 tests using 8 workers
  ✓   8 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (5.7s)
  ✓  11 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (3.8s)
  ✓   2 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (5.8s)
  … (19 more ✓)
  22 passed (15.4s)
e2e exit=0
```

### How Postgres and Chromium were run here

There is no Docker in this sandbox, so I used the method of the earlier
issues.

- **Postgres:** `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, outside the repository, on port 54329.
  - For the unit and integration tests, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at that
    server through `SCRATCH_PG_URL`, with database names unique per
    worker. It was reverted with `git checkout`, and nothing from it is
    committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium:** installed with `playwright install chromium`. Its missing
  shared libraries were extracted from Debian bookworm's packages into
  `/tmp/chromelibs`, outside the repository, and used through
  `LD_LIBRARY_PATH`.
