# Issue #82: Floor status reports — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `49107df` (every code
commit of the issue, plus the README), after `pnpm install
--frozen-lockfile`. The Postgres, Playwright and sabotage runs were made in
the working tree at the same code. This builds on #78 (the Manager chat),
#80 (the work queue's dispatch) and #81 (the watchdog, and the Manager's
GitHub client, which the report reads GitHub with).

## What was built

### The command, and the report in the chat (`packages/shared`, `packages/db`, `packages/orchestrator` `manager/commands.ts`, `chat.ts`, `store.ts`)

- **"status"** (also "report" and "status report") is a plain-code
  command, `{ kind: "report" }`, read by `readManagerCommand` like the
  others: "Status." and "status report, please" are read; "status 4" is
  refused with a hint; "stauts" and "reprot" are typos with a "Did you
  mean"; "What is the status?" and "Report the flaky test as a bug" are
  left for the Manager's Model. It is listed beside the chat with the other
  commands, and in the Manager's system prompt.
- **The chat's answer** to it is the report itself, written by the chat's
  new `report` option, and kept as a new message kind, `report`, answering
  the Owner's message. No model is asked. If the report cannot be written,
  the answer is an `error` message saying why, and the chat takes the next
  message. Without a `report` option, it says no report can be written.
- **`postReport(floorId, text, replyTo?)`** keeps a report and tells the
  chat's listeners (so it streams into an open chat). With no `replyTo`
  it answers nothing: the daily report.
- **Migration `0037_floor_status_reports`**: `manager_chat_messages` takes
  the `report` kind, and a `report` may answer nothing. Every other kind
  keeps its rule, and a report still needs the Manager (`agent_id`).
  `ManagerChatStore.latestDailyReport(floorId)` reads the latest report
  that answers nothing.
- The Manager's later chat turns see each report as one of its own
  (assistant) turns, as they see command answers, so the Owner can ask
  about it.

### The report (`packages/orchestrator`, `manager/report.ts`)

`createStatusReports({ floors, agents, work, github, notices, chat,
chatStore, usage, pausedAgents, publicUrl, redactor, dailyHourUtc, now })`
gives `compose(floorId)`, `write(floorId, { replyTo })`, `check()`,
`start()` and `stop()`. Plain code, no model. A report has:

- **In flight:** each issue with work queued or running (its Agent, and
  how long it has run or waited), then each open `ai-office` issue at a
  stage on GitHub with no work queued ("with no work queued").
- **Blocked:** queued work waiting for an Agent that is paused in the Agent
  editor or at a Token Cap (for a review round, a paused required
  reviewer), and an issue whose latest work at the stage GitHub puts it at
  failed, with nothing queued again.
- **Needing you:** the Floor's open action Notices (by their titles), and
  issues at `needs-human`, or at `ready-to-merge` when the Floor's Merge
  Policy is "send to me", unless a Notice already names them.
- **Tokens used:** the Floor's tokens (input plus output, as Token Caps
  count them) today and this month, UTC, from the same usage tally the
  Token Caps read.

GitHub is read only through `managerGitHub` (one `listIssues` for the
`ai-office` label per report). Closed issues, and issues with no stage
label (such as an unclear one waiting for the Owner, which its action
Notice covers instead), are left out. When GitHub cannot be read, or the
App is not configured, the report comes from the work queue and the
Notices alone, and its last line says so.

`write` keeps the report in the Floor's Manager chat (`postReport`) and
raises an **info Notice** from the Manager: "Status report on web-shop: 3
in flight, 2 blocked, 3 needing you, 1,500 tokens today", linking the
report in the chat (`PUBLIC_URL` + `/floors/<floor>/manager`), then up to
nine of its issues: those needing the Owner first, then the blocked ones,
then those in flight. A Notice that cannot be raised does not undo the
chat message.

**Daily.** `check()` runs every minute. From 09:00 UTC each day, each Floor
in use with a Manager gets its report, once: it is not written again while
the latest daily report in `manager_chat_messages` is from that day's
09:00 or later, across restarts. A requested report does not count. A
Floor with nothing in flight, blocked or needing the Owner, and no tokens
used today, is not sent one.

**Credentials.** Issue titles and Notice titles are redacted before they
are shortened (to 60 characters), so a credential the redactor knows only
by its value, such as an AI Account's, cannot be cut into a part it no
longer recognises. The chat and the Notices redact what they keep, as
before.

### `apps/server` and `apps/web`

- The server now makes the Manager chat itself (with the server's
  redactor, Models and default Models, as `buildApp` did), wires its
  `report` to the status reports, and passes it to `buildApp`. The status
  reports read the work queue, Notices, the usage tally, the Agents paused
  at Token Caps and, when configured, the GitHub App. Their daily check
  starts with the watchdog, and stops before the work queue on close.
- The chat page shows a report with a "Status report" badge; its text keeps
  its lines.

### Docs

README: "Status reports" under the Manager's watchdog, and "status" in the
Manager chat's commands and API.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker the Postgres tests
      skip with the reason (1497 passed, 298 skipped). Against Postgres
      18.4 (below), 1776 passed and 19 skipped.
- [x] **Scenario test: the report lists seeded in-flight and blocked
      issues.** `packages/orchestrator/src/manager/report.test.ts`, 4
      scenarios, each run in memory and in Postgres 18. Each uses the real
      work queue with a stand-in sandbox that ends only when told to, the
      fake GitHub, real Notices, the real Manager chat (with a model client
      that fails if it is ever called), and a clock the test sets. The
      seed, on web-shop (a Manager, coders Ada and Alan, a reviewer, QA):
      #1 and #2 running for Ada and Alan; #4 queued for Ada (the sandboxes
      are full); #5's review round waiting for the reviewer, paused at a
      Token Cap; #3's work failed, with an "Agent blocked" action Notice;
      #6 at `needs-human`; #7 at `ready-to-merge`; #8 failed then closed;
      #9 not in the pipeline; tokens on web-shop today, earlier this month
      and last month, on the blog, and from an Owner tool.
  - **"asked "status" in the chat, the Manager lists the in-flight and
    blocked issues, what needs the Owner and the tokens used":**
    1. `compose` lists in flight #1 (running, Ada), #2 (running, Alan) and
       #4 (queued, Ada); blocked #5 (`needs-review`) and #3
       (`needs-code`); needing the Owner #3, #6 and #7; tokens 1,500 today
       and 3,500 this month.
    2. The Owner sends "status". The answer is a `report` message replying
       to it, from the Manager, with no model and no command, whose text is
       checked in full: each section, each issue with its title, Agent,
       stage and time ("for 12 minutes"), why each blocked one is blocked
       ("its review waits for its required reviewers, and <reviewer> is
       paused at a Token Cap"; "its work at needs-code failed (Ada), and
       nothing is queued again"), and "Tokens used: 1,500 today, 3,500
       this month (UTC)." #8 and #9 are not in it.
    3. The chat holds the Owner's message and the report.
    4. An info Notice, "Status report on web-shop: 3 in flight, 2 blocked,
       3 needing you, 1,500 tokens today", from the Manager, with no
       actions, links the chat and #3, #6, #7, #5, #1, #2 and #4 in that
       order; and a `notice.raised` event says so.
  - **"the daily report is written at its hour, once a day, across
    restarts, and not for a quiet Floor":** at 08:47 and 08:59 nothing is
    written, though a report was asked for; at 09:00 web-shop's is
    written (answering nothing, listing #1 and the failed #3) and the
    quiet blog's is not; later that day, and after a restart (a new
    instance on the same stores), nothing more; the next day, after
    another restart, the next one.
  - **"without GitHub, the report comes from AI Office's own records, and
    says so":** in flight and blocked from the work queue, without titles;
    the closed #8 cannot be told apart, so it is listed; the last line says
    GitHub could not be read.
  - **"never writes a credential into the chat or the Notice":** an Anthropic
    key in an issue title, and a registered secret of no known shape in a
    title long enough to be shortened, reach neither the chat, the stored
    messages nor the Notices; the title reads "Change the passphrase
    [REDACTED] found in a log".

  Also: `commands.test.ts` (reading "status", "report" and "status
  report", the hints, the typos, and sentences left alone);
  `chat.test.ts` ("answers "status" with the Manager's status report, or
  why it could not write one", in memory and Postgres: the reply, its
  updates, no model call, a daily report answering nothing read back by
  `latestDailyReport`, a failing report kept as an `error`; the
  `notYet` answer without a `report`; and the table taking a `report`
  that answers nothing but not one without its Manager);
  `prompt.test.ts` (the Manager's prompt lists "status").

- [x] **In the real server** (beyond the criteria): a new Playwright test,
      `e2e/tests/status-report.spec.ts`. On a new Floor, #1 is picked up by
      intake and its task fails (the stand-in sandbox), and #2 is at
      `needs-human`. The Owner types "status" in the Manager chat: the
      report (with its "Status report" badge) lists "Blocked (1)" with #1
      and its coder, "Needing you (2)" with the "Agent blocked" Notice and
      #2, and the tokens; it is still there after a reload. On the Notice
      Board, the info Notice "Status report on web-shop: … 1 blocked, 2
      needing you, …" has only **Dismiss**, a link to the chat and "#2
      needs you". The whole Playwright suite passes (23 tests, output
      below).

**Negative checks.** Each sabotage of `manager/report.ts` was reverted
afterwards (the file restored from a copy, and `diff` showing nothing).
Each was run on `src/manager/report` and `src/manager/chat` of
`orchestrator`, in memory and in Postgres:

| Sabotage | Failed |
| --- | --- |
| Failed work is never listed as blocked | 4 tests: "asked "status"…" and "the daily report…", in each store |
| Work waiting for a paused Agent is not blocked | 2 tests: "asked "status"…", in each store |
| Issues at `needs-human` are not listed | 2 tests: "asked "status"…", in each store |
| Action Notices are not listed | 2 tests: "asked "status"…", in each store |
| The daily report ignores the last one written | 2 tests: "the daily report…", in each store |
| No info Notice is raised | 4 tests: "asked "status"…" and "the daily report…", in each store |
| Titles are shortened before they are redacted | 2 tests: "never writes a credential…", in each store |
| Other Floors' (and Owner tools') tokens are counted | 4 tests: "asked "status"…" and "the daily report…", in each store |

The first run of these found a gap in the tests, not the code: shortening
titles before redacting them went unnoticed, as the chat redacts the whole
text again and a key's shape still matched once cut. The credential
scenario now registers a secret of no known shape, as an AI Account's is,
and the sabotage fails it.

### Not verified by a test

- **The server's timer.** No server-level test waits for 09:00 UTC. The
  daily decision is `check()`, covered by the scenario on a set clock; the
  server's wiring is covered by `pnpm typecheck` and by the Playwright
  suite starting the server with it, where "status" is answered through
  the same `write`.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against an embedded Postgres 18.4
  instead, and run in CI.
- **The real GitHub App.** Issues were the fake GitHub's. The report makes
  one `listIssues` call with the `ai-office` label, which intake already
  makes against the real App.

## Notes

- **Plain code, not a model.** FR-23 lets the Manager use a model for
  summaries; this report needs none. Every fact in it is counted or read,
  so it is written from a template: it costs no tokens, works while the
  Manager is paused or capped or no AI Account is left, and no model reads
  issue text to write it (as §6.17 asks of the Communications Agent's
  reports). A model-written summary on top could come later.
- **"Blocked" is often brief.** The watchdog (#81) retries failed work
  within a minute, so a failure is usually blocked only until then; the
  report says what is true when it is written. An issue with an "Agent
  blocked" Notice is listed both as blocked and as needing the Owner, as
  both are true.
- **Daily at 09:00 UTC.** UTC, as Token Caps count days. The hour is
  `dailyHourUtc` (`defaultDailyReportHourUtc`), not yet an Owner setting,
  like the watchdog's limits. A server that is down at 09:00 writes the
  day's report when it starts, if it is still that day.
- **Quiet Floors.** A daily Notice saying a Floor has nothing on would
  only fill the Notice Board, so a quiet Floor is sent none; "status"
  always answers.
- **Where the report lives.** In the chat (`manager_chat_messages`) and
  the Notice; the Notice's `notice.raised` event puts it in the Activity
  Feed. There is no separate table or event type.

## Outside this issue

- **Report Notices pile up.** Each report is a new info Notice, and the
  previous one stays until the Owner dismisses it (FR-48). Replacing a
  Floor's previous report Notice with the new one would keep the board
  short, but would dismiss a Notice the Owner has not dismissed.
- **The Floor's wall board.** FR-50 and FR-57 put each Floor's issues in
  progress, queue lengths and tokens on its wall board in the 3D office,
  which does not exist yet. The report's `compose` gives the same data.
- **Issues listed by their labels.** The report lists any open issue with
  the `ai-office` label and a stage label, as the labels are the source of
  truth (FR-18). An issue someone other than the Owner labelled by hand
  would be listed, though intake would never pick it up. Its title is
  quoted in the chat, and so reaches the Manager's Model in later chat
  turns, as titles do in §6.17's reports.
- **"status?"** A question mark makes it a sentence for the Manager's
  Model, as with every command ("complete issues 1 to 5?"). The Model has
  no access to the Floor's state, so it can only point the Owner to
  "status".
- **Email and other Connections.** Delivery outside AI Office is a
  non-goal here; Connections and Digests (§6.17) come later.
- **`needs-code` vs `needs-work`.** As in #79 to #81, the code keeps
  `needs-code`; ADR 0003's rename should be its own issue.

## Output

### Fresh clone at `49107df`

```text
$ pnpm install --frozen-lockfile
Done in 981ms using pnpm v12.10.0

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

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  148 passed (148)
      Tests  1497 passed | 298 skipped (1795)
test exit=0
```

### Against the embedded Postgres 18.4

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  148 passed (148)
      Tests  1776 passed | 19 skipped (1795)
exit=0
```

The 19 skips are those of #81: the real-App GitHub contract (no
`GITHUB_APP_ID`), and the Docker image and compose checks.

### The new tests (verbose)

`SCRATCH_PG_URL=… pnpm vitest run --project @ai-office/orchestrator
src/manager/report src/manager/chat src/manager/commands src/manager/prompt
--reporter=verbose`, the tests about reports:

```text
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads status, report and status report as the status report 0ms
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "status reprot" with a hint 0ms
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > answers "status" with the Manager's status report, or why it could not write one 2ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in memory > asked "status" in the chat, the Manager lists the in-flight and blocked issues, what needs the Owner and the tokens used 90ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in memory > the daily report is written at its hour, once a day, across restarts, and not for a quiet Floor 61ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in memory > without GitHub, the report comes from AI Office's own records, and says so 55ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in memory > never writes a credential into the chat or the Notice 4ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in Postgres 18 > asked "status" in the chat, the Manager lists the in-flight and blocked issues, what needs the Owner and the tokens used 4973ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in Postgres 18 > the daily report is written at its hour, once a day, across restarts, and not for a quiet Floor 604ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in Postgres 18 > without GitHub, the report comes from AI Office's own records, and says so 629ms
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > answers "status" with the Manager's status report, or why it could not write one 420ms
✓ |@ai-office/orchestrator| src/manager/report.test.ts > the Manager's status reports, in Postgres 18 > never writes a credential into the chat or the Notice 398ms
      Tests  86 passed (86)
```

### The sabotage runs

```text
## Failed work is never listed as blocked
   Tests  4 failed | 29 passed (33)
## Work waiting for a paused Agent is not blocked
   Tests  2 failed | 31 passed (33)
## Issues at needs-human are not listed
   Tests  2 failed | 31 passed (33)
## Action Notices are not listed
   Tests  2 failed | 31 passed (33)
## The daily report ignores the last one written
   Tests  2 failed | 31 passed (33)
## No info Notice is raised
   Tests  4 failed | 29 passed (33)
## Titles are shortened before they are redacted
   × never writes a credential into the chat or the Notice 17ms
   × never writes a credential into the chat or the Notice 388ms
   Tests  2 failed | 31 passed (33)
## Other Floors' tokens are counted
   Tests  4 failed | 29 passed (33)
```

Before the credential scenario was strengthened, the same sabotage gave
`Tests  33 passed (33)`.

### `pnpm e2e` (embedded Postgres 18.4, Chromium)

```text
Running 23 tests using 8 workers
  ✓  15 [chromium] › tests/manager-chat.spec.ts:101:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (9.5s)
  ✓  22 [chromium] › tests/status-report.spec.ts:13:1 › "status" in the Manager chat: the report lists the blocked issue and those needing the Owner, and is an info Notice (8.2s)
  … (21 more ✓)
  23 passed (35.4s)
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
