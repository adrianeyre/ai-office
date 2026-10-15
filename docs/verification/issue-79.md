# Issue #79: Manager triage — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `8eaebdc` (every code
commit of the issue, plus the README), after `pnpm install
--frozen-lockfile`. The Postgres and Playwright runs were made in the
working tree at the same code. This builds on #78 (the Manager chat, its
Manager prompt and `ModelClient`) and #22.

## What was built

### Types and the event (`packages/shared` `triage.ts`, `packages/events`, `apps/web`)

- `issuePriorities`: `low`, `normal` (the default) and `high`.
- `triageVerdictSchema`: the one JSON object the Manager's Model must
  answer with: `clear` (a boolean), `priority`, a `reason` (up to 1,000
  characters) and `questions` (up to 5, each up to 500). An unclear issue
  needs at least one question, and a clear one asks none.
- `triageActions.workAsItIs` (`work_issue_as_it_is`): the action on an
  unclear issue's Notice.
- `issue.triaged` (version 1): Floor, issue, the Manager, `outcome`
  (`clear` or `unclear`), `priority`, and `judgedBy` (`model`, `rules` or
  `owner`). The Activity Feed lists it under Issues, as "Issue triaged":
  "Ada triaged #4: clear to work, high priority." or "…: not clear enough
  to work, so it waits for the Owner.", with "(by AI Office's rules)" or
  "(the Owner's choice)" when the Model did not judge.

### The database (`packages/db`, migration `0030_triage`)

- `issue_triage`, one row per issue (primary key Floor and issue): its
  latest triage. `status` (`clear` or `waiting`), `priority`, `judged_by`,
  the Manager (`agent_id`), `fingerprint` (a SHA-256 of the issue's title
  and body as judged) and the waiting Notice (`notice_id`), with checks on
  each enumeration.
- `work_queue.priority` (`high`, `normal` or `low`; default `normal`).

### Dispatch by priority (`packages/orchestrator`, `work/`)

`createWorkQueue` takes `issuePriority(floorId, issue)` and stores it with
each piece of work it queues (every stage, so review, QA and docs work
keeps the issue's priority). Waiting work starts by its Floor's priority,
then its issue's, then oldest first: in memory, and in SQL (`ORDER BY
floors.priority DESC, CASE work_queue.priority … DESC, created_at, id`).

### Triage (`packages/orchestrator`, `manager/triage.ts`, `triage-prompt.ts`, `triage-store.ts`)

`createTriage({ floors, agents, github, models, defaultModels, notices,
events, store, redactor })` gives `check(floor, issue)`, `priority(floorId,
issue)` and `stop()`. Intake (`createIntake`'s new `triage` option) calls
`check` for each of the Owner's issues not yet in the pipeline, before
moving it to `needs-code`. Its report gains `waiting`.

- **Unchanged since the last triage** (same fingerprint): the last
  decision stands. No model is asked, and no Notice or comment is added.
- **The judgement:**
  1. An issue with no description is unclear by plain code, with no model
     call.
  2. Otherwise the Floor's Manager's Model judges, with `models.complete`
     as the Manager (its own Gateway Key, so it is attributed to the
     Manager and the issue and counts against the Manager's Token Caps;
     ADR 0001). The prompt (`triagePrompt`) defines clear enough to work
     (acceptance criteria present, scope bounded: one change for one
     Agent, branch and pull request), the priorities, and the answer's
     form. The issue is quoted between `<issue>` markers it cannot close,
     and cut at 30,000 characters. The Manager's extra instructions end
     it.
  3. An answer that is not a triage (`parseTriage`, which uses the same
     reading as reviewers' verdicts, now `parseAnswer` in
     `review/verdict.ts`) is sent back once, saying what is wrong.
  4. When the Model cannot be asked (a paused Manager, no Model, any
     refusal or error from the Gateway) or answers twice with no valid
     triage, AI Office's rules judge (FR-17): clear, at `normal`
     priority, only when the issue lists acceptance criteria (a line
     naming them, or a task list).
- **Clear:** kept as `clear` with its priority, an `issue.triaged` event,
  a comment on the issue ("### Triage: clear to work", who judged, the
  priority and the reason), and intake moves it to `needs-code` and queues
  it, at that priority.
- **Unclear:** an action Notice, "Unclear issue needs your input: #N
  title", linking the issue and the Manager, offering **Work it as it
  is**; kept as `waiting` with the Notice; an event; and a comment
  ("### Triage: waiting for the Owner") with the reason, the numbered
  questions, and how to go on. The issue stays out of the pipeline (only
  `ai-office`), with nothing queued.
- **The Owner edits the issue** (title or body): the next check triages it
  again, and the earlier Notice is dismissed.
- **Work it as it is:** the triage becomes `clear`, judged by the Owner,
  at the priority the Manager set; an event and a comment. The next
  intake check picks it up without asking the model.
- **Comments** start with `<!-- ai-office:triage -->` and are redacted. A
  comment GitHub refuses is reported (`onError`) and never stops triage.

### `apps/server`

`startOffice` creates the triage whenever the GitHub App is configured,
gives it to intake, and gives the work queue `issuePriority` from it. It
logs (without content) a comment it could not write.

### Tests and the fake GitHub

- `FakeGitHub.editIssue(repository, issue, { title, body })`, so a
  scenario can have the Owner edit an issue.
- `e2e/tests/agent-editor.spec.ts`: its two issues now list acceptance
  criteria, since an issue reaches its coder only once triaged clear.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker the Postgres tests
      skip with the reason (1456 passed, 279 skipped). Against Postgres
      18.4 (below), 1716 passed and 19 skipped.
- [x] **Scenario tests with a fake model: a clear issue proceeds; a vague
      one raises a Notice and waits.**
      `packages/orchestrator/src/manager/triage.test.ts`, 9 scenarios, each
      run in memory and in Postgres 18. Each uses `createFakeModel` for the
      Manager's Model, the fake GitHub, Notices, and intake and the work
      queue wired as the server wires them:
  - **a clear issue proceeds:** intake reports it picked up; its labels
    are `ai-office`, `needs-code`; its work is queued at the `high`
    priority the Manager set; the one model request is the Manager's
    (`agentId`, `claude-opus-5-5`, `issue`), with the triage prompt and
    the issue's task list; the comment says it is clear, at **high**
    priority, with the reason; one `issue.triaged` event; no Notice; a
    second check asks no model.
  - **a vague issue raises a Notice and waits:** intake reports it
    `waiting`; its labels stay `ai-office` alone and nothing is queued;
    one open action Notice, titled "Unclear issue needs your input: #1
    Make the shop better", linking the issue and the Manager, offering
    "Work it as it is"; the comment carries the reason and both questions,
    numbered; an `unclear` event. A second check leaves it waiting with no
    new model request, Notice or comment.
  - the waiting issue, once edited, is triaged again and proceeds, and its
    stale Notice is dismissed;
  - the Owner's **Work it as it is** clears it, comments, and the next
    check picks it up at the Manager's priority without asking the model;
  - an issue with no description waits, with no model request;
  - when the Gateway refuses (503), the rules judge: the issue with
    acceptance criteria proceeds at `normal`, the one without waits;
  - an answer that is not a triage is sent back once (with the problem);
    an unclear answer with no questions, twice, leaves it to the rules;
  - a paused Manager makes no model call;
  - a credential in the Model's answer never reaches the comment.

  Also: `triage-prompt.test.ts` (5 tests: the prompt, quoting, cutting,
  and reading answers), the work queue's new case "starts waiting work by
  Floor priority, then issue priority, then oldest first" (memory and
  Postgres), `fake.test.ts` (editing an issue) and the Activity Feed's
  text for `issue.triaged`.

- [x] **In the real server** (beyond the criteria): the whole Playwright
      suite passes (22 tests, output below). Its agent-editor test runs
      intake through `startOffice`. There, with no Claude AI Account, the
      Manager's call is refused by the Gateway and the rules let the
      issues (with acceptance criteria) through. With the criteria removed,
      the same test fails because the issue waits: `pollIntake()` picks up
      `0`, not `1`.

**Negative checks** (each reverted afterwards with `git checkout`), on the
tests in `src/manager`, `src/work` and `src/intake` of `orchestrator`:

| Sabotage | Failed |
| --- | --- |
| Intake picks up an issue whatever triage decides | 5 tests |
| The work queue ignores the issue's priority | 1 test (the priority order) |
| A stale Notice is never closed when the issue is triaged again | 1 test |
| Triage comments are not redacted | 1 test (credentials) |
| A waiting, unchanged issue is triaged again at every check | 2 tests |
| (Playwright) the agent-editor issues have no acceptance criteria | the test: `Expected: 1`, `Received: 0` |

### How Postgres and Chromium were run here

There is no Docker in this sandbox, so I used the method of the earlier
issues.

- **Postgres:** `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, outside the repository, on port 54329.
  - For the unit and integration tests, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at that
    server through `SCRATCH_PG_URL`, with database names unique per worker.
    It was reverted with `git checkout`, and nothing from it is committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium:** installed with `playwright install chromium`. Its missing
  shared libraries (including `libcups2` for full Chromium, which the
  notice-alerts test uses) were extracted from Debian bookworm's packages
  into `/tmp/chromelibs`, outside the repository, and used through
  `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against the embedded Postgres 18.4
  instead, and run in CI.
- **A real AI Provider.** The Manager's Model is a fake model in the
  scenarios, and the Gateway (with no AI Account) refuses it in the
  Playwright run; no live model was called (PRD §9). How well a real Model
  judges issues against this prompt is for the host.
- **Real GitHub.** Comments and labels went to the fake GitHub; the real
  App's comment on an issue is the same `createComment` the progress
  comments use.

## Notes

- **Where triage sits.** It is part of intake: an issue is triaged after
  the Owner check and before it enters the pipeline, so "the issue waits"
  means it stays out of the pipeline, with only its `ai-office` label and
  nothing queued. No new label was added: FR-18's labels are the
  pipeline's, and `needs-human` means "handed to the Owner" from within
  it, which only the Owner moves out of. The wait is visible on the issue
  (the comment), on the Notice Board, and in the Activity Feed.
- **How a waiting issue moves on.** Editing the issue's title or body is
  the Owner's answer: the fingerprint changes and it is triaged again.
  Comments on the issue are not read, since only the Owner's issue text is
  intake's input. **Work it as it is** on the Notice is the override.
  Dismissing the Notice leaves the issue waiting.
- **Plain code where it can (FR-23), and rules when no model judges
  (FR-17).** An empty description is never sent to a model. A Manager
  that cannot be asked does not block the Floor: the rules judge
  conservatively (acceptance criteria present), and the comment says the
  rules judged and why. A paused Manager makes no model call, as no new
  work goes to a paused Agent; its Floor's issues are judged by the rules.
  A Gateway refusal at a Token Cap is the same: the Manager's cap is
  respected, and no cap is raised.
- **Priority.** Three levels, which the Model chooses from the prompt's
  definitions (`high` for broken, insecure or blocking; `low` for
  nice-to-haves). It orders work within a Floor, after the Floor's own
  priority, so a Floor's priority still comes first across Floors.
- **Every decision is a comment and an event** (FR-23, FR-52), including
  the Owner's "Work it as it is".
- **Untrusted text.** The issue is quoted as untrusted in the prompt. The
  Model's reason and questions reach a comment on the Owner's own
  repository only after redaction, flattened to one line per question.
  The Notice title carries the issue's title, cut to 200 characters and
  redacted as every Notice title is.

## Outside this issue

- **`needs-code` vs `needs-work`.** ADR 0003 renames `needs-code` to
  `needs-work`, but the code, the README and the existing labels still use
  `needs-code`. This issue keeps `needs-code` to stay consistent with the
  pipeline as built. The rename should be its own issue.
- **The Decision Model** (FR-17) is #109, as the brief says. When it is
  on, `judge` in `manager/triage.ts` is where it would take the Manager's
  Model's place.
- **Issues named to the Manager** ("complete issues 1 to 5", FR-8) are not
  triaged yet. Batches (#83) do not exist, and only intake's issues are
  triaged. A Batch's issues should go through the same `Triage.check`.
- **Dispatch's other half** (FR-23: choosing the work Role from routing
  descriptions, `role:<name>` labels, asking the Owner when it cannot
  tell) is not part of triage and is not built here.
- **A priority label the Owner sets** (such as `priority:high`) is not
  read. Only the Manager (or the rules' `normal`) sets the priority.
- **Waiting issues on the wall board.** FR-50 lists issues in progress on
  the Floor's wall board; waiting issues could be shown there once it
  exists.
- **"Work it as it is" waits for the next intake check** (60 seconds by
  default) rather than picking the issue up at once, so it never races
  with a check in progress.
- **Re-prioritising.** An issue's priority is copied to its work as the
  work is queued. A later triage (after an edit) applies to work queued
  after it, not to work already waiting.

## Output

### Fresh clone (`/tmp/clone79`, `8eaebdc`)

```text
$ pnpm install --frozen-lockfile
Done in 1.2s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  144 passed (144)
      Tests  1456 passed | 279 skipped (1735)
test exit=0
```

### Against the embedded Postgres 18.4

```text
$ SCRATCH_PG_URL=… pnpm --filter @ai-office/orchestrator exec vitest run src/manager/triage.test.ts src/work src/intake
 Test Files  3 passed (3)
      Tests  51 passed (51)

$ SCRATCH_PG_URL=… pnpm test
 Test Files  144 passed (144)
      Tests  1716 passed | 19 skipped (1735)
exit 0
```

The 19 skips are those of #78: the real-App GitHub contract (no
`GITHUB_APP_ID`), and the Docker image and compose checks.

### The triage tests (verbose, in memory)

```text
✓ |@ai-office/orchestrator| src/manager/triage-prompt.test.ts > the triage prompt > asks whether the issue is clear enough to work, and its priority, as one JSON object 2ms
✓ |@ai-office/orchestrator| src/manager/triage-prompt.test.ts > the triage prompt > quotes the issue so it cannot close its markers 1ms
✓ |@ai-office/orchestrator| src/manager/triage-prompt.test.ts > the triage prompt > says when the issue has no description, and cuts a long one 0ms
✓ |@ai-office/orchestrator| src/manager/triage-prompt.test.ts > reading the Manager's triage > accepts a clear issue with no questions, and an unclear one with some, fenced or not 3ms
✓ |@ai-office/orchestrator| src/manager/triage-prompt.test.ts > reading the Manager's triage > says what is wrong with an answer that is not a triage 1ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > a clear issue proceeds: into the pipeline, queued at the priority the Manager set, with its decision on the issue 16ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > a vague issue raises an action Notice, is commented on with the Manager's questions, and waits 4ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > a waiting issue is triaged again once the Owner edits it, and its stale Notice is closed 3ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > the Owner can have a waiting issue worked as it is, from its Notice 2ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > an issue with no description waits, by plain code, without a model call 1ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > when the Manager's Model cannot be asked, AI Office's rules judge: clear only with acceptance criteria 2ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > an answer that is not a triage is sent back once; a second one leaves it to the rules 4ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > a paused Manager is asked nothing; the rules judge 1ms
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > credentials never reach the issue's comments 1ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > starts waiting work by Floor priority, then oldest first 203ms
✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > starts waiting work by Floor priority, then issue priority, then oldest first 254ms
```

### `pnpm e2e` (embedded Postgres 18.4, Chromium)

```text
Running 22 tests using 8 workers
  ✓   8 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (7.3s)
  ✓  14 [chromium] › tests/manager-chat.spec.ts:101:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (3.5s)
  ✓  22 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (2.8s)
  … (19 more ✓)
  22 passed (16.3s)
```

With the agent-editor issues' acceptance criteria removed (reverted
afterwards):

```text
Running 1 test using 1 worker
    Expected: 1
    Received: 0
        at /home/agent/workspace/e2e/tests/agent-editor.spec.ts:123:37
  1 failed
```
