# Issue #85: Kickoff and Wrap-up meetings — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, after the issue's last code
commit (`4818513`, the guide; the code is in `f4a4882`, `0416885` and
`5b39b75`).

The blockers are built on this branch: #74, the Handoff walks
([`issue-74.md`](issue-74.md)), whose waypoint routes and walking poses
the meeting walks reuse; and #84, the whiteboard
([`issue-84.md`](issue-84.md)), whose panel now shows the Kickoff and the
Wrap-up. #83's Batches and Plans and #125's Communications Agent are
built on too.

## What was built

### The data (`packages/shared` `batches.ts`; `packages/events`; `packages/db`)

- `batchStatuses` gains **`finished`**. A Batch carries
  `acknowledgements`, `finishedAt` and `wrapUp`.
- **`acknowledgementSchema`**: an assigned Agent's acknowledgement at the
  Kickoff: the Plan version presented, `ok` or `concern` (its text, at
  most 300 characters, redacted), by its `model` or AI Office's `rules`.
- **`wrapUpSchema`**: a finished Batch's results: each issue in the
  Plan's order with its title, outcome (`merged`, `closed`, `blocked`,
  `not_started`), pull request, coder, Review Loop and QA rounds, tokens
  and estimated cost; the issues left out; and the totals. #130 builds
  its report from it.
- **Events**: `batch.kickoff_started` (the version presented, the
  Manager, the Agents assigned), `batch.acknowledged` (one per Agent),
  `batch.kickoff_ended` (how many concerns) and `batch.finished` (the
  Agents assigned, the issues and the counts and tokens). The Activity
  Feed reads them under "Batches".
- **Migration `0046_communications`**: `batches.finished_at` and
  `batches.wrap_up`, the status check widened to `finished` (with checks
  that a finished Batch has both, and that only a Batch awaiting approval
  has no `started_at`), and `batch_acknowledgements`, whose primary key
  (Batch, Agent) keeps one acknowledgement per Agent per Batch.

### The Kickoff (`packages/orchestrator` `batches/kickoff.ts`, `batches.ts`)

- After a Batch's first Plan is kept, the Manager holds the Kickoff:
  `batch.kickoff_started`, then each coder the Plan assigns, in the
  Plan's order, one after another, is asked once through its **own Model
  and Gateway Key** (`models.complete`, 200 tokens at most), then
  `batch.kickoff_ended`. Only then is the Owner asked to approve the Plan
  (plan approval on), or does its work start (off).
- **The prompt** (`kickoffPrompt`) gives the Plan: its summary and each
  issue's number, title (quoted as data), coder ("you" for its own),
  dependencies, likely files and the Manager's note; never an issue's
  body. It asks for exactly `OK`, or `CONCERN:` and one sentence, and
  says Agents do not converse.
- **Read in plain code** (`parseAcknowledgement`): "OK" in any case, with
  or without a full stop, is OK; anything else is one concern: its first
  line, on one line, without a `CONCERN:` label, cut to 300 characters,
  redacted.
- **AI Office's rules** acknowledge "OK" for an Agent that is paused,
  paused at a Token Cap, has no Model, or whose call fails.
- **Once per Agent**: the store refuses a second acknowledgement, and
  replans and approval hold no second Kickoff. A Kickoff that fails
  part-way leaves the Batch as it is.

### The Wrap-up (`batches/wrap-up.ts`, `batches.ts`)

- **When a Batch finishes** (`batchOutcomes`): every issue of its latest
  Plan is closed, blocked at `needs-human`, or not started because an
  issue it depends on is blocked (or never starts). An issue being
  worked, at `ready-to-merge` awaiting the Owner, or able to start keeps
  it in progress; so does one it cannot read, or one with conflicting
  stage labels.
- **The results** (`wrapUpOf`): outcomes from GitHub (a closed issue is
  `merged` if AI Office merged its pull request, per its
  `pull_request.merged` event, or GitHub says its pull request was
  merged); the pull request from `pull_request.opened`; rounds from the
  most `review.posted` and `qa.reported` rounds since the Batch was made;
  tokens and estimated cost from the AI Gateway's request history for that
  Floor and issue since the Batch was made (the server passes
  `requestHistory.tokenUsage`).
- **Finishing** (`finish`, and the minute's `check`; a merge or an issue
  moved to `needs-human` triggers a check at once): the results are kept
  and the Batch marked `finished` (only from `in_progress`, so once),
  `batch.finished` is published, and an **info Notice** gives the
  results: "Batch 3 finished on web-shop: 2 of 5 issues merged, 1 closed,
  1 blocked, 1 not started; 250k tokens", linking the Wrap-up on the
  whiteboard and each pull request.
- **Memory curation** (`memory/curation.ts`) treats a finished Batch as
  ended (it leaves `open()`), as well as one in progress with every issue
  closed, as before.

### Communications (`packages/communications`)

As #125's notes said it would, `batch.finished` joins the work-complete
triggers (FR-92): "Batch 3 finished: 2 of 5 issues merged, 1 closed, 1
blocked, 1 not started", linking the Wrap-up on the whiteboard; "Work
complete" at "links only". Digests count Batches finished apart from pull
requests merged ("1 pull request merged, 1 Batch finished"), with the
outcome `finished`.

### The server and the web app

- `GET /api/floors/:floorId/batches` (and one Batch) answer each Batch
  with its `acknowledgements`, `finishedAt` and `wrapUp`.
- **The whiteboard** (`whiteboard.tsx`) shows "Kickoff: 1 concern" with
  each Agent's acknowledgement (a concern marked with an amber edge), and
  a finished Batch's **Wrap-up**: "Wrap-up: 2 of 5 merged", when, tokens
  and estimated cost, a table of each issue (outcome, pull request,
  rounds, tokens, estimated cost) and what is blocked. It stays live on
  the new events.
- **The meeting room** (`scene/meeting-walks.ts`, `scene/meeting-room.tsx`,
  `desk-agents.tsx`, `floor.tsx`, `office-view.tsx`): at
  `batch.kickoff_started` the assigned Agents stand, walk the waypoint
  graph to the meeting room, onto the walkway in front of the table's
  chairs (or behind them), and sit, the front row first, the Manager
  standing at the whiteboard; at `batch.kickoff_ended` they walk back and
  sit at their desks. `batch.finished` gathers them again, for 20 s once
  seated. Each stays at least 6 s. An Agent on a Handoff walk finishes it
  first; a Handoff from an Agent in the meeting room is handed over at
  once; only meetings that begin while the Floor is shown are walked;
  with reduced motion no one walks.

### Docs

The guide: "The Kickoff" and "The Wrap-up" in
[`batches-and-memory.md`](../guide/batches-and-memory.md), "Kickoffs and
Wrap-ups in the meeting room" in [`web-app.md`](../guide/web-app.md), and
work complete in [`notices-and-skills.md`](../guide/notices-and-skills.md).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below); `pnpm build` passes too. Without Docker the
      Postgres tests skip with the reason (2878 passed, 402 skipped).
- [x] **Scenario test: one acknowledgement per Agent.**
      `packages/orchestrator/src/batches/batches.test.ts` (fake model,
      fake GitHub, the real triage, pipeline, intake, Notices and work
      queue), "the Kickoff: each Agent the Plan assigns acknowledges it
      once through its own Model, OK or one concern, before the Plan
      awaits approval": "complete issues 1 to 5" in the Manager chat with
      plan approval on. The events are exactly `batch.planned`,
      `batch.kickoff_started` (Alan and Ada, the Plan's coders, in its
      order), two `batch.acknowledged` (Alan's concern, its pasted
      Anthropic key redacted and its second line dropped; Ada's "OK."),
      `batch.kickoff_ended` (1 concern), and only then the "Plan awaiting
      approval" Notice. The store keeps exactly one acknowledgement each,
      compared in full. Each coder was asked once, alone, with its own
      Gateway Key, Model and 200 tokens; the prompt is checked (its role,
      the Batch, "The Plan gives you #3", the plan lines, titles quoted)
      and holds neither an issue's body nor the key. A second
      acknowledgement is refused by the store, and approving holds no
      second Kickoff. "at the Kickoff, an Agent whose Model cannot be
      asked …": Ada's failing call gives "OK" by AI Office's rules; Alan's
      rambling answer is one concern of exactly 300 characters, its first
      line only.
- [x] **Scenario test: Wrap-up summary content.** Same file, "the
      Wrap-up: once every issue is closed or blocked the Batch finishes
      …": plan approval off, #1, #3 and #5 start (#2 after #1, #4 after #2).
      #1's pull request takes two review rounds and one QA round and AI
      Office merges it: #2 starts, nothing finishes. The Owner closes #3
      with no pull request; #5's pull request is merged on GitHub itself
      (no event); #2's takes three review rounds: still not finished
      while #2 is worked. #2 moves to `needs-human`: the check finishes the
      Batch. Its `wrapUp` is compared in full: #1 merged (its PR, 2 review
      and 1 QA rounds, 150,000 tokens, $1.50 from two usage rows), #3
      closed (no PR), #2 blocked (its PR, 3 rounds), #4 not started, #5
      merged (via GitHub), totals 2 merged, 1 closed, 1 blocked, 1 not
      started, 250,000 tokens, $2.50; another Floor's #1 and a row with no
      issue are not counted; usage is asked from the Batch's creation to
      now. `batch.finished` is compared in full; the info Notice reads
      "Batch 1 finished on web-shop: 2 of 5 issues merged, 1 closed, 1
      blocked, 1 not started; 250k tokens", linking the Wrap-up and the
      three pull requests. It no longer holds issues or shows as open, and
      neither a later check, a restart's check nor `finish` finishes it
      again (one event, one Notice).

      **Sabotage:** with the "still in progress" guard removed, the
      Wrap-up test fails (the Batch finishes early), as do two older
      scenarios; with the store's once-per-Agent check removed, the
      Kickoff test fails. Both restored; 52 passed.

**Beyond the criteria:**

- `batches/meetings.test.ts` (18 tests): parsing acknowledgements; when a
  Batch has finished (every outcome, and every way it is not: worked,
  `ready-to-merge`, able to start, unreadable, conflicting labels); an
  issue's record from its events; tokens in words.
- `memory/curation.test.ts`: a finished Batch with a blocked issue still
  open is curated once, as ended.
- `communications.test.ts`: `batch.finished` delivered to a webhook as
  work complete (titles and summaries, and links only), and not to a
  Connection without work complete; `digests.test.ts`: the Digest counts.
- `apps/server` `batches/routes.test.ts`: the API's Batch with its
  acknowledgements, `finishedAt` and `wrapUp`, compared in full.
- `apps/web` `whiteboard.test.tsx`: the Kickoff's acknowledgements
  (concern marked) and a finished Batch's Wrap-up table, cell by cell.
- `scene/meeting-walks.test.ts` (14 tests): who goes where (the Manager
  at the whiteboard; seats in order, the front row first; facing the
  table; ten at most); for teams of 2, 6 and 12, every Agent's way from
  its desk to its place, sampled every 5 cm, stays at least 0.2 m from
  anything standing (once off its chairs); the timing (stand, walk at
  walking pace, sit, stay until the end, walk back, never faster than
  walking pace; the 6 s minimum; the Manager stands); signals from
  events; Kickoff and Wrap-up ending; waiting for a Handoff walk; staying
  for the next meeting; another Floor's ignored; reduced motion.
- `scene/meeting-room.test.tsx` (5 tests, React Three Fiber's test
  renderer): the Agents walk to their places and back in the rendered
  Floor; a Wrap-up ends by itself; a Handoff from an Agent in the meeting
  is not walked; reduced motion; earlier meetings are not replayed.

### Verified on the host

- [ ] **Both meetings play smoothly in the office.** Needs a browser with
      WebGL: the walks are checked as data and in the test renderer here,
      not seen.

## Not verifiable in this sandbox

- **Postgres 18** (no Docker): the Postgres runs of `batches.test.ts`
  (the three new scenarios included), `curation.test.ts`,
  `routes.test.ts` and `communications.test.ts`, and so migration `0047`
  itself (its checks, `markFinished`'s conditional update,
  `finishedSince`, and `batch_acknowledgements`' primary key). They are
  written to run there and skip with the reason here.
- **Playwright** (`pnpm e2e`, needs Docker and Chromium). The existing
  whiteboard flow should be unchanged: with no AI Account the Kickoff's
  calls are refused by the AI Gateway and AI Office's rules acknowledge
  for the coders, before the Plan awaits approval.
- **Real AI accounts**: the Kickoff's calls through the real AI Gateway
  (the fake model stands in).
- The look and frame rate of the meetings (above).

## Notes

- The Kickoff runs before the Plan awaits approval (or before its work
  starts, with plan approval off), so a Batch's command waits for each
  assigned coder's short acknowledgement (one after another, so the
  whiteboard fills in live). Each is at most 200 tokens.
- "Batch finished" includes blocked issues (FR-25.6 presents "anything
  blocked"), so a Batch does not wait for the Owner to unblock it. A pull
  request awaiting the Owner's approval at `ready-to-merge` does keep it
  in progress, as the Owner's merge is still to come.
- Under heavy host load (load average above 40 on 16 cores) the existing
  `floor-layout.test.ts` path tests can exceed vitest's 5 s timeout, as
  #88's verification recorded. That happened in one full run here (2
  tests timed out at 5.2 s and 5.8 s); alone they pass (77 passed), and
  the next full run passed in full (below).

## Output

```text
$ pnpm lint   (tail)
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ cat /proc/loadavg; nproc
61.83 45.07 32.95 24/29042 35136
16
$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  244 passed (244)
      Tests  2878 passed | 402 skipped (3280)
exit=0

$ pnpm build   (tail)
✓ built in 883ms
exit=0
```

The new scenarios (verbose, in memory):

```text
 ✓ src/batches/batches.test.ts > Batches and their Plans, in memory > the Kickoff: each Agent the Plan assigns acknowledges it once through its own Model, OK or one concern, before the Plan awaits approval 7ms
 ✓ src/batches/batches.test.ts > Batches and their Plans, in memory > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern 4ms
 ✓ src/batches/batches.test.ts > Batches and their Plans, in memory > the Wrap-up: once every issue is closed or blocked the Batch finishes, keeping each issue's outcome, pull request, rounds, tokens and cost, and an info Notice gives the results 18ms
 ↓ src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > … [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]

$ vitest run (web) meeting-walks.test.ts meeting-room.test.tsx whiteboard.test.tsx
 Test Files  3 passed (3)
      Tests  22 passed (22)
$ vitest run (communications) communications.test.ts digests.test.ts
 Test Files  2 passed (2)
      Tests  30 passed | 15 skipped (45)
```

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `e713845`, after the merge (`9629801`) and its follow-ups:
`0ae986e` (two stray `.orig` files removed), `945c595` (retention deletes
Connections' delivery logs) and `e713845` (a test of the Batches' prompt
check).

- **Migrations.** This branch keeps `0044_retention` and
  `0045_github_webhooks`. The merged branch's `0044_communications`,
  `0045_push_connections`, `0046_connection_detail_quiet_hours_digests`,
  `0047_batch_kickoff_wrap_up` and `0048_publishing_destinations` are
  replaced by one regenerated `0046_communications`, with their header
  comments, and `0047_connection_delivery_retention` follows it.
  `drizzle-kit generate` finds nothing more to generate. Neither migration
  has been applied to a real Postgres here (no Docker).

- **The prompt check now goes through the shared rounds.** On this branch
  the Batches' minute loop became `createRounds` (`rounds.ts`), which
  GitHub webhooks also trigger (#114). The check this issue added on a
  merge or a `needs-human` label now asks those rounds for a round
  (`rounds.trigger()`) rather than running `check()` beside them, so it
  joins a round already running. A new test (`e713845`) shows a merge
  before `start()` checks nothing, one after it starts the next issue
  without waiting the minute, and a merge with a webhook's trigger at the
  same moment starts the issue after it once.
- **Meetings and idle behaviours (#110) in the scene.** Both move an
  Agent away from its chair, so `scene/away-pose.ts` decides what is
  shown: a meeting, then a Handoff walk, then an idle activity. An Agent
  gathered for a Kickoff or Wrap-up (or waiting to set off for one) is
  away on work, so its idle activity stops at once and none starts until
  the meeting is over. The meeting walks it from its desk. Tested in
  `away-pose.test.ts`. The on-screen look is to be checked on the host.

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
 Test Files  266 passed (266)
      Tests  3067 passed | 435 skipped (3502)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 435 skipped tests need what the sandbox lacks: 409 Postgres 18 and
3 Mailpit through Testcontainers (Docker), 10 Docker, hadolint or Caddy
for the deployment, and 13 the real GitHub App. They run on the host and
in CI.

The Batches, meeting and pose tests:

```text
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > is in its chair when nothing takes it away
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > shows a Handoff walk over an idle activity, at the walk's pace
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > shows a meeting over a Handoff walk
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > stops its idle activity at once when a Kickoff gathers it, and walks to the meeting from its desk
 ✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > once started, a merge checks the Batches at once, and a webhook's trigger at the same moment starts nothing twice
 ↓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > once started, a merge checks the Batches at once, and a webhook's trigger at the same moment starts nothing twice [skipped: no Docker]
 Test Files  8 passed (8)
      Tests  76 passed | 15 skipped (91)
```

## After merging `feat/issues-110-130-b` into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `97de0fe`, after merging `feat/issues-110-130-b` into the
integration branch (`d5ae18f`) and its follow-ups: `1b5254a`
(configuration export and import carry Fresh Start thresholds) and
`97de0fe` (a Kickoff acknowledgement is no working context).

- **Migrations.** The integration branch keeps `0044_retention` to
  `0047_connection_delivery_retention`. The merged branch's
  `0044_context_usage_and_fresh_starts`, `0045_manager_chat_skills`,
  `0046_grilling_sessions` and `0047_manager_chat_compaction` are replaced
  by one regenerated `0048_context_usage_skills_and_grilling`.
  `drizzle-kit generate` finds nothing more to generate. It has not been
  applied to a real Postgres here (no Docker).

- **Merged from `feat/issues-110-130-b`:** Context Usage (#120) counted
  each Kickoff acknowledgement, a call made as the assigned Agent with no
  session, as that Agent's working context. Only the Manager's calls now
  count without a session (`97de0fe`, with a test in
  `context/usage.test.ts`).

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

The meeting and Context Usage tests:

```text
 Test Files  2 passed (2)
      Tests  32 passed (32)
```
