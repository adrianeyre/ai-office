# Issue #81: Manager watchdog and decision log — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `3378dbf` (every code
commit of the issue, plus the README), after `pnpm install
--frozen-lockfile`. The Postgres, Playwright and sabotage runs were made in
the working tree at the same code. This builds on #55 (the Review Loop and
its Round Cap) and #80 (the Manager's dispatch, whose rules the watchdog
reuses to find a free Agent).

## What was built

### The Manager's authority (`packages/shared` `watchdog.ts`; `packages/orchestrator` `manager/authority.ts`)

- `managerActions`: `retry`, `reassign`, `relabel`, `pause`, `escalate`
  (PRD FR-23: "the Manager may pause, reassign, relabel and escalate", and
  the brief's "nudge (retry)"). `forbiddenManagerActions`: `merge`,
  `change_repository_settings`, `raise_cap`.
- **The permission check**, `assertManagerMay(action)`: anything not in
  `managerActions` is refused with a `ManagerAuthorityError` (`code:
  "not_permitted"`, `action`). Every decision passes it before anything is
  done, whoever asked: the watchdog's own decisions go through the same
  `act()` as any other request.
- **Beneath the check**, the Manager never holds what would let it do
  more:
  - `managerGitHub(app)`: its GitHub App client reads, labels issues and
    comments. `mergePullRequest` is refused as `merge`; a write
    `installationToken` and `ensureLabel` (the repository's labels) as
    `change_repository_settings`; closing issues, branches, pull requests
    and reviews as `github_*`. TypeScript makes every `RepositoryClient`
    method be listed, so a new one must be classified.
  - `assertManagerMayMove(to)`: it moves an issue only back to
    `needs-code` or out to `needs-human`, never forward (such as
    `needs-review` → `ready-to-merge`), so it cannot carry work past
    review towards a merge.
  - It is given no Token Cap service, so there is nothing it could raise.

### The watchdog (`packages/orchestrator`, `manager/watchdog.ts`)

`createWatchdog({ floors, agents, github, queue, work, reviews, notices,
events, decisions, pausedAgents, limits, redactor, now })` gives `check()`,
`act(request)`, `start()` and `stop()`. Plain code, no model. Every minute
it looks over each Floor in use:

- **Stalled work.** Work running with no sign of progress for the stall
  timeout (20 minutes by default): since it started, or since the last
  `sandbox.*`, `model_call.completed`, `review.posted`, `branch.pushed` or
  `handoff` event on its issue. It is stopped and **reassigned** to a free
  Agent of its Role (`freeAgent`, in `dispatch.ts`: enabled, not paused at
  a Token Cap, nothing queued or running), or **retried** for the same
  Agent when none is free. The third stall of an issue's work at a stage
  (counted since it was last handed to the Owner) **escalates** instead:
  the work is cancelled, the issue moved to `needs-human`, and an action
  Notice raised.
- **Repeated failures.** An issue whose latest work at a stage `failed`,
  that is still open at that stage and held by no one, with nothing queued
  again: retried, or reassigned to another free Agent of its Role; at 3
  failures in a row, escalated as above. Oldest failures first.
- **An Agent that keeps failing.** An Agent whose last 3 ended tasks all
  failed, on more than one issue, is **paused** (`enabled: false`, a
  `config.changed` event, as the Agent editor does), with an action
  Notice. Its failed work is then retried by others, never by it.
- **Loops near their cap.** An issue sent back to `needs-code` by a Review
  Loop round with one round left before the Floor's Round Cap is
  **escalated** with an action Notice; the loop carries on.

**The decision log.** Each decision is:

1. checked (`assertManagerMay`), then skipped if its condition was already
   decided;
2. carried out;
3. kept in `manager_decisions` (migration `0031_manager_decisions`), keyed
   by the condition it answered (one stalled run of a piece of work, one
   failure, one round), unique per Floor, so it is taken once, across
   restarts too; its reason is redacted;
4. posted as a comment on the issue (starting `<!-- ai-office:manager
   -->`, redacted; a comment GitHub refuses never undoes the decision);
5. published as a `manager.decision` event.

A refused request is a `manager.action_refused` event and a
`ManagerAuthorityError`, and changes nothing.

### The work queue (`work/queue.ts`, `work/store.ts`)

- `enqueue` takes an optional `agentId`: the Agent the Manager names,
  rather than the dispatch rules' choice.
- `interrupt(id, { requeue, agentId })` stops running work and waits for it
  to end: back in the queue (for another Agent when named, with an
  `issue.assigned` event), or ended as `cancelled`.
- `WorkQueueStore.recent(floorId, limit)`: a Floor's latest work, newest
  first, in memory and in SQL (with a new index, `work_queue_floor_idx`).

### Events and the Activity Feed (`packages/events`, `apps/web`)

`manager.decision` (version 1: Floor, issue, the Manager, `action`,
`trigger` `stalled`/`failing`/`near_cap`, `stage`, and the `fromAgentId`,
`toAgentId` and `to` stage where they apply) and `manager.action_refused`
(Floor, issue, the Manager, the `action`). The Activity Feed lists both
under a new **Manager** group, as "Grace reassigned #4 (needs-code) from
Ada to Alan, as it had stalled." and "Grace was refused "merge" on #4: a
Manager may never merge, change repository settings or raise a cap."

### `apps/server`

`startOffice` starts the watchdog once Agents can work issues (the GitHub
App and a sandbox runner), with the work queue, the Agents paused at Token
Caps and the redactor, and stops it before the queue on close.

### Docs

README: "The Manager's watchdog" (what it spots, its authority, its
decision log).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker the Postgres tests
      skip with the reason (1488 passed, 293 skipped). Against Postgres
      18.4 (below), 1762 passed and 19 skipped.
- [x] **Scenario tests: a stuck task is reassigned; attempts to merge or
      raise caps are refused.** In
      `packages/orchestrator/src/manager/watchdog.test.ts`, 8 scenarios,
      each run in memory and in Postgres 18. Each uses the real work queue
      with a stand-in for the sandbox that ends only when told to (or when
      stopped), the fake GitHub, real Notices, a Floor with a Manager and
      two coders (Ada and Alan), and a clock the test moves.
  - **"a stuck task is reassigned to a free coder, with its decision on
    the issue and in the Activity Feed":**
    1. #1 is queued and starts for Ada. At 10 minutes, and at 30 minutes
       with output at 15, `check()` decides nothing.
    2. At 36 minutes (21 with no progress) it decides `reassign`,
       `stalled`, from Ada to Alan. The same work item is stopped for Ada
       and starts for Alan (`ran`: Ada, then Alan; `issue.assigned`: Ada,
       then Alan; the item is `running` for Alan).
    3. The issue has one decision comment: "### Manager: reassigned",
       "<Manager> (the Manager) gave this issue's work at `needs-code` to
       Alan, from Ada.", and "> Ada's work on it at needs-code showed no
       progress for 20 minutes".
    4. There is exactly one `manager.decision` event, checked field by
       field, and one record in the decision log. A second check decides
       nothing, and no Notice was raised.
  - **"attempts to merge or raise caps are refused, and nothing is merged
    or raised":** with an open pull request for the issue:
    - `act()` with `merge`, `raise_cap` and `change_repository_settings`
      each rejects with a `ManagerAuthorityError` (`not_permitted`, the
      action);
    - `relabel` to `ready-to-merge` (from `needs-review`) is refused as
      `relabel_to_ready-to-merge`;
    - the Manager's GitHub client itself refuses `mergePullRequest`,
      `installationToken` and `ensureLabel`;
    - afterwards the pull request is not merged; the office's, Floor's,
      Agents' and issues' Token Caps are exactly as before; the labels are
      unchanged; there is no decision, no comment and no
      `manager.decision` event;
    - four `manager.action_refused` events, one per refused request, name
      the action, the Manager and the issue;
    - what the Manager may do, it does: `relabel` back to `needs-code`
      moves the issue, with its comment.

  The other scenarios:

  - **stalled again and again** (Alan paused, so no coder is free):
    retried twice for Ada, then escalated: nothing left running, labels
    `ai-office`, `needs-human`, one action Notice ("<Manager> escalated
    #1: its work at needs-code stalled 3 times, the last after 20 minutes
    with no progress") linked to Ada, three comments, and nothing more an
    hour later;
  - **failing again and again**: Ada fails → reassigned to Alan; Alan
    fails → reassigned to Ada ("failed 2 times in a row"); a third
    failure → `needs-human` and the Notice; nothing decided while the
    retry runs, or after;
  - **left alone**: failed work whose issue the Owner moved to
    `needs-human`, closed, or that worked at a later attempt;
  - **an Agent paused**: Ada fails three issues; she is paused
    (`enabled` false, `config.changed`), with an action Notice; the three
    issues are tried again (`reassign` to Alan, then `retry` twice, by
    dispatch), and nothing is queued for Ada. Once the Owner resumes her,
    the old failures do not pause her again;
  - **near the Round Cap**: round 1 of 3 sending the issue back decides
    nothing; round 2 escalates once, with the Notice "… round 2 of its
    Review Loop asked for changes, so one round is left before its Round
    Cap of 3", and leaves the issue at `needs-code`;
  - **credentials**: a key in a decision's reason reaches neither the
    comment, the Notice nor the decision log.

  Also: `authority.test.ts` (4 tests: the allowed actions, the refused
  ones and the message, the two stages the Manager may move to, and its
  GitHub client allowing reads, labels and comments and refusing the
  rest); `dispatch.test.ts`, `freeAgent`; `queue.test.ts`, two cases in
  each store ("the Manager can stop running work: queued again for
  another Agent, or cancelled" and "queues work for the Agent named, and
  reads a Floor's latest work newest first"); the Activity Feed's text
  for both events; and both events in `schema.test.ts`'s examples.

- [x] **In the real server** (beyond the criteria): the whole Playwright
      suite passes (22 tests, output below), with `startOffice` starting
      the watchdog.

**Negative checks.** Each sabotage was reverted afterwards (`git
checkout`). Each was run on `src/manager/watchdog` and
`src/manager/authority` of `orchestrator`, in memory and in Postgres:

| Sabotage | Failed |
| --- | --- |
| No permission check (`assertManagerMay` does nothing) | 3 tests: the refusals, and "attempts to merge or raise caps are refused…" in each store |
| The Manager's GitHub client lets a merge through | 3 tests: the client's refusals, and "attempts to merge…" in each store |
| The Manager may move an issue anywhere | 3 tests: the two stages, and "attempts to merge…" in each store |
| Stalled work is never spotted | 4 tests: "a stuck task is reassigned…" and "work that keeps stalling…", in each store |
| Stalled work is retried, never reassigned | 2 tests: "a stuck task is reassigned…", in each store |
| Progress events are ignored (stall timed from the start only) | 2 tests: "a stuck task is reassigned…", in each store |
| The decision log never says a condition was decided | 4 tests: "an Agent … is paused" and "a Review Loop … escalated, once", in each store |
| Decision comments are not redacted | 2 tests: "never writes a credential…", in each store |
| Failing work is never escalated | 2 tests: "work that keeps failing…", in each store |

The first run of the "Agent paused" scenario also found a real bug: in one
check, the same free coder was chosen for several failed issues, because
the work was read before any decision was taken. Each check now counts
the Agents it has chosen as busy, and takes the oldest failure first.

### Not verified by a test

- **The server's timer.** No server-level test waits the watchdog's
  minute. `startOffice`'s wiring is covered by `pnpm typecheck` and by the
  Playwright suite starting the server with it; the decisions themselves
  are covered by `check()` in the scenarios.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against an embedded Postgres 18.4
  instead, and run in CI.
- **Real sandboxes and real GitHub.** Stalls and failures were a stand-in
  sandbox's; a real Sandcastle run that hangs, and the real App's
  comments, labels and refused merges, are for the host. The comment and
  label calls are the same `createComment`, `addLabels` and `removeLabel`
  the triage and the pipeline already make.

## Notes

- **Plain code (FR-23).** Timeouts, caps and the decisions themselves are
  rules; no model is asked. The limits (20 minutes, 3 failures, 2 stall
  restarts, 3 failed tasks for an Agent) are `defaultWatchdogLimits`, and
  `createWatchdog`'s `limits` option overrides them; they are not Owner
  settings yet.
- **What "stuck" means.** No progress for the timeout, rather than a time
  in the stage: a long run that keeps working is left alone (the sandbox
  runner already stops one after an hour). When each issue last showed
  progress is kept in memory; after a restart, running work is queued
  again anyway, and starts its clock afresh.
- **Which decisions raise a Notice.** Escalations and pauses raise action
  Notices: the Owner must act. Retries and reassignments are the comment
  and the Activity Feed only, as FR-49 lists no Notice for them.
- **One permission check for every source.** `act()` is public so that
  later sources of Manager decisions (the Manager chat, the Decision
  Model) pass the same check; nothing calls it today but the watchdog.
- **"Pause" pauses an Agent.** FR-23's "the Manager may pause" is read as
  pausing an Agent, as the Agent editor does; work on an issue is
  stopped only as part of a reassign, retry or escalation.
- **Failures from before the watchdog.** On its first check the watchdog
  retries failed work still waiting at its stage, including issues whose
  "Agent blocked" Notice predates it.

## Outside this issue

- **The progress comment's wording.** When the watchdog stops work, the
  coder flow's progress comment ends with its existing "stopped" summary
  ("AI Office stopped; the work starts again when it does"), as on a
  shutdown. The decision comment beneath it says what happened. A summary
  naming the Manager would need the coder flow to know why it was
  aborted.
- **A "Resume" action on the pause Notice.** FR-48 lists "resume" among
  one-click actions; the Owner resumes a paused Agent in the Agent editor
  for now.
- **Other caps to watch.** FR-28's QA Round Cap and overall cap per pull
  request, and FR-86's Fresh Start cap, do not exist yet; the watchdog
  watches the review Round Cap only. FR-28's early escalation of a round
  whose blocking comments repeat the last round's needs judgement (FR-17:
  "Is this Review Loop stalled or repeating?"), which is the Decision
  Model's (#109) or the Manager's Model's.
- **The pull request on escalation.** The Round Cap labels both the issue
  and its pull request `needs-human`; the watchdog's escalation labels the
  issue only, as it may stop work before any pull request exists.
- **`needs-code` vs `needs-work`.** As in #79 and #80, the code keeps
  `needs-code`; ADR 0003's rename should be its own issue.
- **GitHub writes.** Each decision is one comment. Decisions are rare
  (each condition once), so this stays well within FR-21's limits.

## Output

### Fresh clone at `3378dbf`

```text
$ pnpm install --frozen-lockfile
Done in 1.1s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  147 passed (147)
      Tests  1488 passed | 293 skipped (1781)
test exit=0
```

### Against the embedded Postgres 18.4

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  147 passed (147)
      Tests  1762 passed | 19 skipped (1781)
exit=0
```

The 19 skips are those of #80: the real-App GitHub contract (no
`GITHUB_APP_ID`), and the Docker image and compose checks.

### The new tests (verbose)

In memory (`pnpm vitest run --project @ai-office/orchestrator src/manager
src/work --reporter=verbose`):

```text
✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > finding a free Agent for the Manager's watchdog > is the oldest enabled Agent of the Role with no work, not paused, other than the one named
✓ |@ai-office/orchestrator| src/manager/authority.test.ts > the Manager's authority > lets it retry, reassign, relabel, pause and escalate
✓ |@ai-office/orchestrator| src/manager/authority.test.ts > the Manager's authority > refuses merging, changing repository settings, raising caps and anything else
✓ |@ai-office/orchestrator| src/manager/authority.test.ts > the Manager's authority > moves an issue only back to needs-code or out to needs-human
✓ |@ai-office/orchestrator| src/manager/authority.test.ts > the Manager's authority > holds a GitHub client that reads, labels issues and comments, and refuses the rest
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > work that keeps stalling is retried while no other coder is free, then handed to the Owner
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > work that keeps failing goes to another coder, then to the Owner after three failures
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > leaves alone failed work whose issue moved on, was closed or finished later
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > an Agent whose last three tasks failed, on more than one issue, is paused
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > a Review Loop with one round left before its Round Cap is escalated, once
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > attempts to merge or raise caps are refused, and nothing is merged or raised
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > never writes a credential into its comments
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > the Manager can stop running work: queued again for another Agent, or cancelled
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > queues work for the Agent named, and reads a Floor's latest work newest first
```

In Postgres 18.4 (`SCRATCH_PG_URL=… pnpm vitest run --project
@ai-office/orchestrator src/manager/watchdog src/work --reporter=verbose`):

```text
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed 2123ms
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > work that keeps stalling is retried while no other coder is free, then handed to the Owner 1878ms
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > work that keeps failing goes to another coder, then to the Owner after three failures 616ms
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > leaves alone failed work whose issue moved on, was closed or finished later 621ms
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > an Agent whose last three tasks failed, on more than one issue, is paused 655ms
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > a Review Loop with one round left before its Round Cap is escalated, once 549ms
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > attempts to merge or raise caps are refused, and nothing is merged or raised 361ms
✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > never writes a credential into its comments 313ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > the Manager can stop running work: queued again for another Agent, or cancelled 434ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > queues work for the Agent named, and reads a Floor's latest work newest first 183ms
      Tests  52 passed (52)
```

### The sabotage runs

```text
## No permission check (assertManagerMay does nothing)
  ['Tests  3 failed | 17 passed (20)']
  × refuses merging, changing repository settings, raising caps and anything else 4ms
  × attempts to merge or raise caps are refused, and nothing is merged or raised 7ms
  × attempts to merge or raise caps are refused, and nothing is merged or raised 100ms
## The Manager's GitHub client lets a merge through
  ['Tests  3 failed | 17 passed (20)']
  × holds a GitHub client that reads, labels issues and comments, and refuses the rest 16ms
  × attempts to merge or raise caps are refused, and nothing is merged or raised 16ms
  × attempts to merge or raise caps are refused, and nothing is merged or raised 141ms
## The Manager may move an issue anywhere (no relabel limit)
  ['Tests  3 failed | 17 passed (20)']
  × moves an issue only back to needs-code or out to needs-human 9ms
  × attempts to merge or raise caps are refused, and nothing is merged or raised 13ms
  × attempts to merge or raise caps are refused, and nothing is merged or raised 146ms
## Stalled work is never spotted
  ['Tests  4 failed | 16 passed (20)']
  × a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed 78ms
  × work that keeps stalling is retried while no other coder is free, then handed to the Owner 55ms
  × a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed 1746ms
  × work that keeps stalling is retried while no other coder is free, then handed to the Owner 204ms
## Stalled work is retried, never reassigned
  ['Tests  2 failed | 18 passed (20)']
  × a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed 91ms
  × a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed 2040ms
## Progress events are ignored (stall timed from the start only)
  ['Tests  2 failed | 18 passed (20)']
  × a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed 86ms
  × a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed 1751ms
## The decision log never says a condition was decided
  ['Tests  4 failed | 16 passed (20)']
  × an Agent whose last three tasks failed, on more than one issue, is paused 119ms
  × a Review Loop with one round left before its Round Cap is escalated, once 3ms
  × an Agent whose last three tasks failed, on more than one issue, is paused 413ms
  × a Review Loop with one round left before its Round Cap is escalated, once 167ms
## Decision comments are not redacted
  ['Tests  2 failed | 18 passed (20)']
  × never writes a credential into its comments 12ms
  × never writes a credential into its comments 261ms
## Failing work is never escalated
  ['Tests  2 failed | 18 passed (20)']
  × work that keeps failing goes to another coder, then to the Owner after three failures 70ms
  × work that keeps failing goes to another coder, then to the Owner after three failures 406ms
```

### `pnpm e2e` (embedded Postgres 18.4, Chromium)

```text
Running 22 tests using 8 workers
  ✓   2 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (9.4s)
  ✓   6 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (9.3s)
  ✓   8 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (9.0s)
  … (19 more ✓)
  22 passed (26.7s)
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
    worker. It was reverted with `git checkout` after each run, and
    nothing from it is committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium:** installed with `playwright install chromium`. Its missing
  shared libraries were extracted from Debian bookworm's packages into
  `/tmp/chromelibs`, outside the repository, and used through
  `LD_LIBRARY_PATH`.
