# Issue #83: Batch command drafts a Plan — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `77d123e` (every
commit of the issue), after `pnpm install --frozen-lockfile`. The Postgres
runs were made in that clone; the Playwright and sabotage runs in the
working tree. This builds on #78 (the Manager chat, whose "complete issues
1 to 5" it carries out), #80 (the Manager's dispatch, whose rules share a
Plan's issues out) and #82 (the status reports, earlier on this branch).

## What was built

### The data (`packages/shared` `batches.ts`; `packages/db`; `packages/events`)

- **`planDraftSchema`**: the Plan the Manager's Model must answer, one
  JSON object: a `summary`, and `issues`, every issue of the Batch once, in
  the order to work them, each with `dependsOn` (issue numbers), `files`
  (likely to change, at most 20), `agent` (a coder's name, or null) and a
  `note`.
- **`planSchema`**, a Plan as AI Office keeps and serves it: `batchId`,
  `version`, `draftedBy` (`model` or `rules`), `agentId` (the Manager),
  `summary`, `items` (each `issue`, `title`, `dependsOn`, `files`,
  `agentId`, `note`, in order), `overlaps` (pairs of issues and the files
  they share), `parallel` (groups of issues that run at once, in the order
  they run), `leftOut` (issues named but not in the Batch, with why) and
  `createdAt`. **`batchSchema`**: `id`, `floorId`, `issues` (as named),
  `status` (`awaiting_approval` or `in_progress`), `agentId`, `createdAt`,
  `startedAt`, `started` (issues whose work started) and its latest `plan`.
- **Migration `0038_batches_and_plans`**: `batches` (1 to 50 issues; a
  status check; `started_at` set exactly when `in_progress`), `plans`
  (primary key Batch and version, so each version is its own row and the
  earlier ones are kept; `drafted_by` checked) and `batch_issues` (each
  issue started once).
- **Events** `batch.planned` (Batch, Plan version, Manager, who drafted it,
  the issues in order) and `batch.started` (the issues started with it),
  with their text in the Activity Feed under a new "Batches" filter group.

### The Plan in plain code (`packages/orchestrator` `batches/plan.ts`)

- **`planFromDraft(draft, issues, team, leftOut)`** checks the draft
  against the Batch and says what is wrong, in sentences the Model can act
  on: an issue not in the Batch, planned twice or missing; a dependency on
  itself, on an issue outside the Batch, or on one that comes later; an
  `agent` who is not one of the Floor's enabled coders. Then it completes
  the Plan:
  - file paths normalised (`./src/a.ts`, `/src/a.ts` and `src\a.ts` are
    `src/a.ts`) and de-duplicated;
  - **overlaps**: two issues sharing a likely file run one after another,
    the later depending on the earlier, unless it already does through
    others (PRD FR-25 (5));
  - **assignments**: an issue given to no coder goes to the one with the
    least work, counting the work queued or running and what the Plan has
    given out so far, preferring coders not paused at a Token Cap: the
    dispatch rule of #80 (`chooseAgentByLoad`, which `chooseAgent` now
    calls, unchanged);
  - **parallel groups**: each issue's group follows every group holding an
    issue it depends on.
- **`planByRules`**: AI Office's own Plan when the Model gives none (FR-17):
  the issues in the order named, no dependencies, shared out across the
  coders, with a summary saying why the rules planned.

### The prompt (`batches/prompt.ts`)

`planPrompt` names the Manager, the Floor and the Batch, each enabled
coder with its AI Provider, Model and how much work it has, and how to
plan. Each issue is quoted between `<issue>` markers it cannot close
(`quoted`), cut to share 100,000 characters between them (at least 2,000
each), and was redacted before it got there. The answer is read with the
reviewers' `parseAnswer`.

### Batches (`batches/batches.ts`, `batches/store.ts`)

`createBatches({ floors, agents, github, models, store, work, pipeline,
queue, events, notices, triage, settings, … })` gives `create`, `command`
(the chat's answer), `held`, `check`, `start` and `stop`.

1. **Reading the issues.** With the Manager's own GitHub client
   (`managerGitHub`, which only reads, labels and comments). An issue that
   was not found, is closed, is not the Owner's (opened by someone else and
   not labelled `ai-office` by the Owner: PRD §4, the check intake makes,
   now exported as `fromOwner`), waits in another open Batch, or is already
   in the pipeline is left out, with why. With none left, no Batch is made,
   and the answer lists why for each.
2. **Drafting.** The Manager's Model, through the AI Gateway with the
   Manager's Gateway Key (`models.complete`, at most 8,192 tokens). An
   answer that is not a Plan, or does not fit the Batch, is sent back once
   with the problem; a second such answer, a paused Manager, a Manager with
   no Model, or a call that fails, and AI Office's rules plan instead.
3. **Keeping.** The Batch and its Plan, version 1, in one transaction
   (`BatchStore.create`); `addPlan` keeps each later version (the next
   number, its Batch's row locked meanwhile), `plans` lists them all, and
   `latestPlan` is the Batch's Plan. A `batch.planned` event follows.
4. **Plan approval on** (the Floor's setting, on by default): the Batch is
   `awaiting_approval`, and nothing starts.
5. **Plan approval off**: the Batch is `in_progress` and work starts at
   once. In the Plan's order, each issue whose dependencies are all closed
   goes through the Manager's triage into the pipeline at `needs-code`, and
   its work is queued for the coder its Plan gives it to (`pickUpIssue`,
   intake's own pick-up, now exported, with an Agent). It is recorded in
   `batch_issues`. Then a `batch.started` event and an info Notice, "Batch
   started on web-shop: 5 issues, work started on #1, #3 and #5", linking
   the chat and the issues.
6. **The rest wait.** `check()`, every minute, starts each waiting issue of
   every Batch in progress once its dependencies are closed (a merged pull
   request closes its issue), skipping archived Floors. An issue closed
   meanwhile needs no work; one already in the pipeline counts as started;
   one triage finds unclear waits for the Owner and is tried again. Starts
   are made one at a time, so none starts twice, across restarts too.
7. **Intake** leaves the issues an open Batch holds (awaiting approval, or
   not started yet) alone: `held` (a new intake option).

### The chat and the server (`manager/chat.ts`, `apps/server`)

- The chat's `carryOut` may now answer undefined (the command is not
  available yet: "skip", "move", "pause", "resume"), and a failure is kept
  as an `error` answer saying why, after which the chat takes the next
  message. The fallback sentences now read "Changing a Batch is not
  available yet" (and "a Plan"), since Batches exist.
- The server makes the Batches when the GitHub App is configured, carries
  out "complete issues …" with them (without the App, it says the Manager
  reads issues through it), passes `held` to intake, and runs the minute's
  check, stopped before the work queue on close.
- `GET /api/floors/:floorId/batches` (newest first, each with its latest
  Plan and started issues) and `GET /api/floors/:floorId/batches/:batchId`
  (with every version of its Plan); `404 floor_not_found` and
  `batch_not_found`; a signed-in session only.
- The chat's answer is the Plan: who drafted which version, the summary,
  each issue in order with its coder, dependencies, overlaps, likely files
  and note, the parallel groups, what was left out, and what started (or
  that the Batch awaits approval).

### A fix on the way (`manager/triage.ts`)

Starting a Batch's issue goes through the Manager's triage, and the
scenario test's check that no model request holds a credential found that
**triage quoted the issue's title and body unredacted** in the Manager's
prompt (since #79): a key pasted into an issue reached a model, against
PRD FR-5. The issue's text is now redacted before it is quoted; its
fingerprint is still of the text as written. A new triage test fails
without the fix (`1 failed | 9 passed`) and passes with it.

### Docs

README: "Batches and Plans" (new), the Manager chat's commands, intake's
"Batches" rule, and triage's redaction.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `77d123e` (output below). Without Docker
      the Postgres tests skip with the reason (1910 passed, 317 skipped).
      Against Postgres 18.4, 2207 passed and 20 skipped (the real-App
      GitHub contract and the Docker image and compose checks).
- [x] **Scenario test with a fake model: the Plan is stored with all
      fields; plan approval off starts work.**
      `packages/orchestrator/src/batches/batches.test.ts`, 6 scenarios, each
      in memory and in Postgres 18, with the fake model
      (`createFakeModel`), the fake GitHub, the real Manager chat, triage,
      pipeline, intake, Notices and work queue (with a stand-in sandbox that
      records each start). The main one: web-shop (a Manager and two coders)
      has #1 to #5, #6 closed and #7 opened and labelled by someone else; #1
      quotes an Anthropic key; #2 is labelled `ai-office`. Plan approval is
      turned off, and the Owner types "complete issues 1 to 7". The fake
      model answers the Plan: #1 (second coder), #3 (first coder), #2 after
      #1, #4 and #5, with likely files where #2 and #4 share
      `src/checkout.ts`.
  1. **The Manager's request**: from the Manager, `claude-opus-5-5`, 8,192
     tokens; names the Batch (#1 to #5) and the coders with their work;
     quotes #1 to #5 and not #6 or #7; the key reads `[REDACTED]`, and no
     model request (Plan or triage) holds it.
  2. **Stored with all its fields**, compared in full: the Batch (issues
     1 to 5, `in_progress`, its Manager, created and started now), and its
     one Plan: version 1, drafted by the model, its Manager, its summary;
     the items in order (#1, #3, #2, #4, #5), each with its title,
     dependencies (#4 after #2, added for the shared file), normalised
     files, coder (the Plan's for #1 and #3, then shared out) and note; the
     overlaps (#1 and #2 on `src/basket.ts`, #2 and #4 on
     `src/checkout.ts`); the parallel groups `[[1, 3, 5], [2], [4]]`; and
     #6 ("it is closed") and #7 left out.
  3. **Plan approval off starts work**: #1, #3 and #5 went through triage
     into the pipeline (`needs-code` on GitHub, `issue.picked_up`), queued
     for the Plan's coders, the opposite of what dispatch would have chosen
     first: the sandbox started #1 for the second coder and #3 for the
     first, and #5 waits for its coder; #2, #4, #6 and #7 have no stage.
     `batch_issues` holds #1, #3 and #5; `batch.planned` and `batch.started`
     say so; and the info Notice "Batch started on web-shop: 5 issues, work
     started on #1, #3 and #5" links the chat and the three issues.
  4. **The chat's answer**, checked in full: the Plan, line by line, and
     "Plan approval is off for this Floor, so work has started on #1, #3
     and #5. #2 starts once #1 is closed. #4 starts once #2 is closed."
  5. **Intake leaves the Batch's issues**: `held` is {#2, #4}; an intake
     poll picks up nothing (#2 is labelled `ai-office`) and ignores #7.
  6. Nothing more starts until #1 is closed; then `check()` starts #2 for
     its Plan's coder; after a restart (a new instance on the same stores)
     nothing starts twice and #4 still waits; once #2 is closed, #4 starts
     and the Batch holds nothing. Six model requests in all: the Plan and
     five triages.

  The other scenarios: **plan approval on** (the Batch `awaiting_approval`,
  the Plan kept, nothing labelled, queued, triaged or announced; intake and
  `check()` start nothing; another Batch cannot take its issues, "it waits
  in Batch 1"); **an invalid answer is sent back once** (the retry carries
  the first answer and the problem), then **AI Office's rules plan**, saying
  why; **a paused Manager, or a refused call**, is planned by the rules, the
  paused one with no model call; **no Batch** when none of the issues can be
  worked (in the pipeline, closed, not the Owner's, not found), saying why
  for each, with no model call or event; **versions**: `addPlan` keeps
  version 2 beside version 1, the latest is the Batch's Plan and decides
  what it holds, and an issue is started (or a Batch marked in progress)
  once.

  Also: `plan.test.ts` (8 tests: the completed Plan, overlaps sequenced and
  not doubled, shared-out assignments and Token Cap pauses, no coder, every
  problem with a draft, the rules' Plan, parallel groups); `prompt.test.ts`
  (4 tests: the coders and their work, quoting that cannot be broken out
  of, cutting, reading answers); `chat.test.ts` (a command not carried out
  yet, and one that fails, in memory and Postgres);
  `apps/server/src/batches/routes.test.ts` (the list and one Batch with
  every version, other Floors' Batches, 404s and 401, in memory and
  Postgres); `triage.test.ts` (the fix above).

- [x] **In the real server** (beyond the criteria): a new Playwright test,
      `e2e/tests/batch.spec.ts`. The Owner turns plan approval off in the
      Floor's settings, opens #1 and #2, and types "complete issues 1 and 2"
      in the Manager chat. With no AI Account, the Manager's Model cannot be
      asked, so AI Office's rules plan and triage: the answer shows "Batch
      1: … drafted its Plan (version 1) by AI Office's rules", the issues
      with their coders, "In parallel: #1 and #2." and that work started;
      both tasks reach the (stand-in) sandboxes; `GET
      /api/floors/web-shop/batches` holds the Batch, `in_progress`, both
      started, with its Plan's fields; the Notice Board shows "Batch started
      on web-shop: 2 issues, work started on #1 and #2"; and the Activity
      Feed "Batch 1 started: work started on #1 and #2." The existing chat
      test now expects the answer to "complete issues 1 to 3" on a
      repository without them ("No Batch was made …"). The whole suite
      passes (24 tests, output below).

**Negative checks.** Each sabotage was applied to the working tree, run on
`src/batches` of `orchestrator` in memory and in Postgres (24 tests), and
reverted with `git checkout` (`git diff` empty afterwards).

| Sabotage | Failed |
| --- | --- |
| Overlapping issues are not sequenced | 3: the main scenario in each store, and "runs issues that share a likely file one after another" |
| Plan approval is ignored (always in progress) | 4: "with plan approval on…" and "a Plan is versioned…", in each store |
| Dependencies are ignored when starting | 2: the main scenario, in each store |
| Intake does not leave held issues alone | 4: the main scenario and "with plan approval on…", in each store |
| Issue text is not redacted for the Plan's prompt | 2: the main scenario, in each store |
| Started work is queued by dispatch, not for the Plan's coder | 2: the main scenario, in each store |
| Other authors' issues are not left out | 4: the main scenario and "no Batch is made…", in each store |
| A new Plan version reuses the last number | 1: "a Plan is versioned…" (in memory; in Postgres the store computes it) |

The first run found a gap in the tests, not the code: queueing a started
issue for whichever coder dispatch chose went unnoticed, because the
scenario's Plan gave each issue to the coder dispatch would have chosen
anyway (`Tests  24 passed (24)`). The Plan now gives #1 and #3 to the other
coders, and the sabotage fails it.

### Not verified by a test

- **The server's minute timer.** No server-level test waits a minute for
  `check()`; it is covered by the scenario, which calls it, and the
  server's wiring by `pnpm typecheck` and the Playwright test, where the
  same Batches start the work.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against an embedded Postgres 18.4
  instead, and run in CI.
- **A real Model's Plan.** The Model's answers were the fake model's (in
  the e2e test, there is no AI Account, so the rules planned). How well a
  real Manager's Model orders issues and guesses their files can only be
  seen on the host.
- **The real GitHub App.** Issues were the fake GitHub's. The Batch reads
  issues with `getIssue` and `labelEvents`, which triage and intake already
  make against the real App.

## Notes

- **"Done" is "closed".** An issue waiting on others starts once each is
  closed on GitHub, as a merged pull request with `Closes #N` closes it
  (FR-21), so its branch starts from their merged work (FR-25 (5)). With
  the Merge Policy "send to me", that is when the Owner merges.
- **The Plan's coder is where work starts, not a reservation.** Each
  started issue is queued for its Plan's coder; the work queue's dispatch
  still moves waiting work to a free coder (#80), as it does for all work.
- **The Manager's file guesses come from issue text only.** It cannot read
  the repository here, as the prompt says; overlaps are only as good as its
  guesses. A file listing of the repository in the prompt would help.
- **The chat waits for the Plan.** "complete issues …" is answered once
  the Plan is drafted (one model call, two at most), as "status" is
  answered once written; the chat takes no other message meanwhile.
- **Where the Plan is shown.** In the chat's answer and over the API, for
  now; the whiteboard is not built yet.

## Outside this issue

- **Approving and editing a Plan** (#84). With plan approval on, a Batch
  waits, and nothing can approve it yet: the chat says so, and to turn plan
  approval off to have Batches start. There is no "Plan awaiting approval"
  Notice (FR-49) yet either; it belongs with approval. "skip" and "move"
  still change nothing.
- **Kickoff, the whiteboard, Wrap-up, mid-Batch replanning** (FR-25 (2),
  (4), (6)). A Batch never finishes yet: it stays `in_progress` once all
  its issues have started. That holds nothing back: a new Batch leaves out
  only the issues an open Batch has not started yet, and a started issue is
  left out because it is in the pipeline (or closed).
- **An ordered list of work Roles per issue** (FR-25 (1), ADR 0003) needs
  Roles as data on Stages (Phase 8); a Plan gives each issue one coder.
- **Manager decisions as issue comments** (FR-23). The Plan is in the chat,
  the Activity Feed and the Notice; no comment is written on each issue.
- **Issue text in sandbox prompts is not redacted.** Found while fixing
  triage: the coder's prompt (`coderPrompt`, from `coder/coder.ts`) quotes
  the issue's body as it is, so a credential pasted into an issue reaches
  the coder's model (and the reviewers' prompts, which quote the issue,
  look the same). The same redaction should be applied there.
- **A flaky work-queue test in Postgres.** `src/work/queue.test.ts` > "two
  coders share four issues, the next going to whichever coder is free",
  in Postgres, failed once in a full verbose run here, then 5 of 6 times
  run alone, and 5 of 6 times run alone on the base commit `599df5b`,
  before any of this issue's changes. Its `agent.queue_changed` counts
  depend on timing (`[1, 2, 1, 0]` against `[1, 0, 1, 0]`). It passes in
  memory, and passed in the full Postgres run above.
- **`needs-code` vs `needs-work`.** As in #79 to #82, the code keeps
  `needs-code`; ADR 0003's rename should be its own issue.

## Output

### Fresh clone at `77d123e`

```text
$ pnpm install --frozen-lockfile
Done in 1.4s using pnpm v12.10.0

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
 Test Files  186 passed (186)
      Tests  1910 passed | 317 skipped (2227)
test exit=0
```

### Against the embedded Postgres 18.4 (same clone)

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  186 passed (186)
      Tests  2207 passed | 20 skipped (2227)
exit=0
```

The 20 skips, from a verbose run:

```text
     12  ↓ |@ai-office/github| src/contract.test.ts
      2  ↓ |deployment| docker/deployment.test.ts
      6  ↓ |deployment| docker/sandbox-images.test.ts
```

### The new tests (verbose, Postgres 18.4)

`SCRATCH_PG_URL=… pnpm vitest run --project @ai-office/orchestrator
--project @ai-office/server --project @ai-office/events src/batches
src/manager/chat.test.ts src/manager/triage.test.ts src/schema.test.ts
--reporter=verbose`, the tests this issue added or changed:

```text
✓ |@ai-office/orchestrator| src/batches/prompt.test.ts > the Plan prompt > names the Batch, the Floor's coders with their work, and how to plan
✓ |@ai-office/orchestrator| src/batches/prompt.test.ts > the Plan prompt > quotes each issue between markers it cannot close
✓ |@ai-office/orchestrator| src/batches/prompt.test.ts > the Plan prompt > cuts long issues to share the room between them
✓ |@ai-office/orchestrator| src/batches/prompt.test.ts > the Plan prompt > reads a draft, in a code fence or not, and says what is wrong with one that is not
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > a Plan from the Manager's draft > keeps the order, dependencies, files, coders and notes, and works out the parallel groups
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > a Plan from the Manager's draft > runs issues that share a likely file one after another
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > a Plan from the Manager's draft > does not add a dependency an issue already has through others
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > a Plan from the Manager's draft > shares issues given to no coder across the least busy, preferring those not paused at a Token Cap
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > a Plan from the Manager's draft > gives an issue to no one when the Floor has no coder
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > a Plan from the Manager's draft > says what is wrong with a draft that does not fit the Batch
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > AI Office's rules > plan the issues in the order named, all at once, shared across the coders
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > parallel groups > put each issue after every group holding one it depends on
✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > covers Floor, Agent, issue, Manager decision, Batch, sandbox, branch, pull request, review, QA, Handoff, model call, Notice, cap, AI Account, config, Skill and sign-in events
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > credentials pasted into an issue never reach the Manager's Model
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > "complete issues 1 to 7": the Manager drafts a Plan, kept with all its fields, and with plan approval off work starts at once
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > with plan approval on, the Plan is kept and nothing starts: the Batch holds its issues
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > when the Manager's Model gives no valid Plan, it is asked once more, then AI Office's rules draft one
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > a paused Manager, or one whose Model cannot be asked, has its Plan drafted by AI Office's rules
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > no Batch is made when none of the issues can be worked, saying why for each
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > a Plan is versioned: a new version is kept beside the earlier, and the latest is the Batch's Plan
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > "complete issues 1 to 7": the Manager drafts a Plan, kept with all its fields, and with plan approval off work starts at once
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > with plan approval on, the Plan is kept and nothing starts: the Batch holds its issues
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > when the Manager's Model gives no valid Plan, it is asked once more, then AI Office's rules draft one
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > a paused Manager, or one whose Model cannot be asked, has its Plan drafted by AI Office's rules
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > no Batch is made when none of the issues can be worked, saying why for each
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > a Plan is versioned: a new version is kept beside the earlier, and the latest is the Batch's Plan
✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in Postgres 18 > credentials pasted into an issue never reach the Manager's Model
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in memory > lists a Floor's Batches with their latest Plan, and gives one with every version
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in memory > answers 404 for a Floor or a Batch that does not exist, and 401 without a session
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in Postgres 18 > lists a Floor's Batches with their latest Plan, and gives one with every version
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in Postgres 18 > answers 404 for a Floor or a Batch that does not exist, and 401 without a session
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > carries a command out when it can, saying what it did
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > says nothing changed for a command it cannot carry out yet, and why one failed
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > carries a command out when it can, saying what it did
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > says nothing changed for a command it cannot carry out yet, and why one failed
 Test Files  7 passed (7)
      Tests  122 passed (122)
```

### The triage fix, with and without

```text
## without the fix in triage.ts
     × credentials pasted into an issue never reach the Manager's Model
      Tests  1 failed | 9 passed | 10 skipped (20)
## with it
 Test Files  4 passed (4)
      Tests  28 passed | 16 skipped (44)
```

### The sabotage runs (memory and Postgres)

```text
## overlaps
      Tests  3 failed | 21 passed (24)
## approval
      Tests  4 failed | 20 passed (24)
## dependencies
      Tests  2 failed | 22 passed (24)
## intake
      Tests  4 failed | 20 passed (24)
## redaction
      Tests  2 failed | 22 passed (24)
## assignment
      Tests  2 failed | 22 passed (24)
## leftout
      Tests  4 failed | 20 passed (24)
## versions
      Tests  1 failed | 23 passed (24)
```

Before the scenario was strengthened, the `assignment` sabotage gave
`Tests  24 passed (24)`.

### The flaky work-queue test, on the base commit `599df5b`

```text
      Tests  36 passed (36)
     × two coders share four issues, the next going to whichever coder is free 407ms
     × two coders share four issues, the next going to whichever coder is free 390ms
     × two coders share four issues, the next going to whichever coder is free 402ms
     × two coders share four issues, the next going to whichever coder is free 396ms
     × two coders share four issues, the next going to whichever coder is free 420ms
```

### `pnpm e2e` (embedded Postgres 18.4, Chromium)

Run in the working tree, holding the code as committed at `c2c8cb5`; the
two commits after it change unit tests only.

```text
Running 24 tests using 8 workers
  ✓   9 [chromium] › tests/batch.spec.ts:13:1 › "complete issues 1 and 2" with plan approval off: the Plan is kept, shown in the chat, and work starts (5.2s)
  ✓  14 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (5.2s)
  ✓  24 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (3.4s)
  … (21 more ✓)
  24 passed (18.2s)
exit=0
```

A first run had 23 passed and `notice-alerts.spec.ts` failed to launch
Chromium (`libcups.so.2: cannot open shared object file`): that test uses
the full browser, not the headless shell. With the library added (below),
the whole suite passed.

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
