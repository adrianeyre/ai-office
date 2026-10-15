# Issue #122: Manager chat: `/clear`, `/compact` and auto-compaction — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) in this branch's working tree, after the issue's code commits.

The blockers are built on this branch:

- **#78**, the Manager chat ([`issue-78.md`](issue-78.md)).
- **#94**, Grilling Sessions ([`issue-94.md`](issue-94.md)). A session's
  settled decisions, open questions and glossary terms are stored as
  structured data in `grilling_sessions`, and put into every prompt of the
  session from there.
- **#120**, Context Usage ([`issue-120.md`](issue-120.md)). Each Agent's
  Context Usage comes from the Gateway's record of its latest call, per
  session. The Fresh Start threshold (#121) is per Floor and per Agent.

## What was built

### Shared and the database (`manager-chat.ts`, migration `0048_context_usage_skills_and_grilling`)

- **Two message kinds:**
  - `clear`: the conversation was cleared;
  - `summary`: it was compacted. Its `compaction` records the trigger
    (`owner` or `auto`), the Manager's Context Usage then (0 to 1, or
    null), the last message it replaced (`upTo`) and how many it replaced.
- **`readChatControl`** reads `/clear` and `/compact [what to keep]`.
- **Database:** `manager_chat_messages.compaction`, present exactly on a
  `summary`. A summary written at the threshold answers nothing
  (`reply_to` null, as a daily report may).

### The orchestrator (`manager/chat.ts`, `manager/compaction.ts`, `manager/store.ts`, `manager/prompt.ts`)

- **Where the conversation starts** (`ManagerChatStore.conversationStart`,
  `latest(floorId, limit, after)`): after the latest `clear`, or after the
  `upTo` of the latest `summary`. The Model is given the latest 50
  messages from there. With a summary, it is in the prompt under "Earlier
  in this conversation". `clear` and `summary` messages are never turns.
- **`/clear`**, read before Skills and commands, is answered at once in
  plain code: "Cleared the conversation: Mira starts afresh from here.
  Decisions, Plans and Batches are kept." In a Grilling Session, the
  answer adds that the session goes on. No model is called and nothing
  else is touched. Skills loaded before it are unloaded.
- **`/compact [what to keep]`** has the Manager's own Model summarise the
  conversation (FR-89), through the AI Gateway with its Gateway Key.
  - The summariser is given a transcript since the last clear or
    compaction, starting from the previous summary if there is one.
    Credentials are redacted from it. Earlier `/clear` and `/compact`
    messages, and their answers, are left out.
  - The summary answers the `/compact` and replaces everything up to it.
    With nothing to summarise, a hint says so.
  - Skills loaded since the last clear stay loaded.
- **Auto-compaction**, before each model call (a reply, or a Grilling
  Session's turn):
  - The chat follows the Manager's Context Usage (`ContextUsage.subscribe`)
    for the chat's own calls.
  - If the latest one, in this conversation, reached the Manager's Fresh
    Start threshold (else its Floor's: 85% by default), the conversation
    before the message is compacted (`auto`, with that Context Usage).
    The Model then answers from the summary.
  - A failure is logged, and the Model answers from the conversation as it
    is.
- **Sessions** (FR-84): each conversation's calls name
  `manager-chat:<floor>:<id of its latest clear or summary>`, or `…:0`.
  Clearing or compacting ends the old session (`endSession`), so the gauge
  empties. The summary's own call names the session it replaces. Calls by
  the same Manager outside the chat (triage, Plans) name another session,
  so they never trigger compaction.
- **Grilling Sessions** (FR-88): the summariser is told the session's
  decisions, open questions and glossary terms are kept apart and given
  back word for word, so to summarise only the back-and-forth. The session
  section is written from `grilling_sessions` in every prompt, compacted
  or not.

### The server

`server.ts` and `app.ts` give the chat the Context Usage tracker. In
`app.ts` the request history and Context Usage are now made before the
chat.

### The web app (`manager-chat.tsx`)

- **The header** shows the Manager's Context Usage gauge (`role="meter"`,
  "Context Usage"), kept live by `agent.context_usage` events.
- **Dividers.** A `clear` is a separator labelled "Conversation cleared".
  A `summary` is a **Compacted** card ("Automatically, at 87% Context
  Usage: 2 earlier messages replaced by Mira's summary." or "With
  /compact"), with the summary folded in a `<details>`.
- The box's hint names `/clear` and `/compact`.

The guide documents it under
[Clearing and compacting](../guide/events-and-chat.md#clearing-and-compacting).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
  exit 0 (output below). Without Docker the Postgres tests skip with the
  reason: 2841 passed, 385 skipped.
- [x] **Scenario tests: `/clear` keeps Plans; `/compact` shortens history;
  auto-compaction fires at the threshold.**
  `packages/orchestrator/src/manager/compaction-scenario.test.ts` drives
  the Manager chat end to end, in memory and in Postgres 18 (8 tests, all
  passing). It uses a Floor added from the fake GitHub, a scripted Model,
  and a Context Usage the test reports.
  - **`/clear` keeps Plans.**
    - "complete issues 1 to 2" keeps Batch 1 with its Plan (through the
      chat's `carryOut`), then an exchange with the Model.
    - `/clear` is answered at once with `kind: "clear"`, with no Skill
      looked up and no model call.
    - The session `manager-chat:web-shop:0` is ended.
    - The Batch (`issues: [1, 2]`) and its Plan version 1 are still in the
      store.
    - The next call is given only the new message, names the new session
      `manager-chat:web-shop:<clear's id>`, and has no summary.
    - The page's history still has all 8 messages.
  - **`/compact` shortens history.**
    - `/compact` with nothing said is answered with a hint, and no model is
      called.
    - After two exchanges (one holding a credential), with the
      conversation reported at 41%, `/compact keep the order of work` is
      answered with the Manager's summary.
    - The summary's compaction is `{trigger: "owner", contextUsage: 0.41,
      upTo: <the /compact>, messages: 7}`.
    - The summarising call is the Manager's, naming the old session. Its
      transcript has the credential redacted and leaves out the earlier
      `/compact`, and its prompt passes on what to keep. The old session
      is ended.
    - The next reply's messages are only the new one. Its "Earlier in this
      conversation" is exactly the summary, and its session is new.
    - A second `/compact` starts from the first summary.
  - **Auto-compaction fires at the threshold.**
    - At 84.9% nothing happens.
    - A 97% from a call naming no chat session (a triage, say) does not
      count.
    - At 85% the next message is compacted first. The summary is
      `{trigger: "auto", contextUsage: 0.85, upTo: <the message before>,
      messages: 6}` with `replyTo: null`. It was written without the
      message being answered.
    - The reply is given only that message, with the summary in its
      prompt, and the old session is ended.
    - With the Manager's own threshold raised to 90%, 89% compacts
      nothing.
- [x] **A compacted Grilling Session still lists every settled decision
  word for word.** The scenario file's fourth case:
  - `/grilling CSV export`, then answers settle two decisions and a term,
    and round 2 asks Q3.
  - `/compact` keeps the summary in the session (`grilling: {sessionId:
    1}`). The summariser's prompt says the decisions, open questions and
    terms are kept apart and to summarise only the back-and-forth.
  - The next turn's messages are only "3: recommended", yet its prompt's
    "Settled decisions" section is exactly both decisions, word for word.
    It also has the glossary term, the answered Q3, the summary and the
    loaded `/grilling` Skill.
  - The stored session is unchanged.
  - `/clear` in the session says it goes on, and it stays `active`.

Also:

- `apps/server/src/manager-chat/routes.test.ts` (1 new): through the API,
  `/compact` streams in a `summary` with its compaction, asked for in a
  call naming `manager-chat:web-shop:0`. `/clear` is answered at once with
  `kind: "clear"`, without a model call.
- `apps/web/src/manager-chat.test.tsx`:
  - the header's Context Usage meter at 42% from the Floor's Context Usage
    (updated test);
  - the cleared divider, the compacted card with its folded summary and
    "Automatically, at 87% Context Usage: 2 earlier messages replaced by
    Mira's summary.", and the hint naming both commands (new test).

**Negative checks.** Each sabotage was run, then reverted from a copy, and
the file was compared byte for byte with it. Run over
`compaction-scenario.test.ts`, in memory:

| Sabotage | Failed |
| --- | --- |
| The Model is given the whole history, cleared or compacted | 4 tests |
| No auto-compaction | 1 test |
| The summary is not given to the Model | 3 tests |
| A compacted Grilling Session's prompt loses its stored decisions | 1 test |
| `/clear` and `/compact` are read as Skill names | 3 tests |

### How Postgres was run here

As for #94: the embedded PostgreSQL 18.4
(`@embedded-postgres/linux-x64@18.4.0-beta.17` in `/tmp/pg18`, outside
the repository), with the never-committed scratch edit to
`packages/db/src/testing/postgres.ts`, reverted after each run. Migration
`0048_context_usage_skills_and_grilling` applied with the rest.

The whole suite against it: 3203 passed, 21 skipped, 2 failed. The two
failures were `apps/web/src/scene/floor-layout.test.ts` (the 3D waypoint
search for 10 and 12 Agents), which timed out at 5 s under the full
suite's load. That test uses no database and touches nothing this issue
changed. It passes alone (77/77, 14 s), as it did in the run without
Docker, where the whole suite passed.

### Not verifiable in this sandbox

- **Testcontainers**: the Postgres tests' Testcontainers path needs Docker;
  they ran against the embedded Postgres 18.4 instead, and run in CI.
- **A real Model's summary, and real Context Usage.** The scripted Model
  writes the summaries, and the test reports Context Usage. Two things
  need the host with a real AI Account (PRD §9):
  - that a real Manager's summary keeps what it needs;
  - that the Gateway's measure of a real chat call crosses the threshold
    and the next message compacts.

  The path from the Gateway's request record to `ContextUsage` is #120's
  and is tested there.
- **The browser.** The header gauge and the dividers were tested in jsdom,
  not in Chromium: Playwright's browser is not installed in this sandbox.

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
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test` (no Docker: the Postgres tests skip)

```text
 Test Files  247 passed (247)
      Tests  2841 passed | 385 skipped (3226)
exit=0
```

### `pnpm test` against the embedded Postgres 18.4

```text
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 10 Agents' Floor clear of furniture and walls
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 12 Agents' Floor clear of furniture and walls
      1 Error: Test timed out in 5000ms.
 Test Files  1 failed | 246 passed (247)
      Tests  2 failed | 3203 passed | 21 skipped (3226)

$ pnpm exec vitest run apps/web/src/scene/floor-layout.test.ts
      Tests  77 passed (77)
   Duration  13.84s
```

### The scenario and API tests (verbose, against the embedded Postgres 18.4)

```text
✓ … compaction-scenario.test.ts > … in memory > /clear wipes the conversation the Model is given, and keeps the Floor's Batches and Plans
✓ … compaction-scenario.test.ts > … in memory > /compact replaces the older history with the Manager's own summary
✓ … compaction-scenario.test.ts > … in memory > the chat compacts itself once the Manager's Context Usage reaches its threshold
✓ … compaction-scenario.test.ts > … in memory > a compacted Grilling Session still has every settled decision, word for word
✓ … compaction-scenario.test.ts > … in Postgres > /clear wipes the conversation the Model is given, and keeps the Floor's Batches and Plans
✓ … compaction-scenario.test.ts > … in Postgres > /compact replaces the older history with the Manager's own summary
✓ … compaction-scenario.test.ts > … in Postgres > the chat compacts itself once the Manager's Context Usage reaches its threshold
✓ … compaction-scenario.test.ts > … in Postgres > a compacted Grilling Session still has every settled decision, word for word
✓ … manager-chat/routes.test.ts > clearing and compacting (FR-87) > answers /clear at once, and /compact with the Manager's summary
✓ … manager-chat/routes.test.ts > Grilling Sessions > lists a Floor's sessions and reads one with its decisions and every message
✓ … manager-chat/routes.test.ts > kept in Postgres 18 > keeps each Floor's chat across a restart
Tests  19 passed (19)
```

## Notes

- **"Wipes the conversation".** `/clear` wipes what the Manager's Model is
  given: nothing before it reaches a prompt again. The messages stay in
  `manager_chat_messages` and on the page, below a divider. A Grilling
  Session's transcript, and every session's full history (FR-82), depend
  on them.
- **When auto-compaction fires.** It is checked before each model call,
  against the Context Usage of the conversation's latest call. The
  Gateway records a call's usage once it ends, so the threshold crossed
  by one reply compacts before the next. A reply is never cut off midway.
- **Which threshold.** FR-87 says "the same threshold" as the automatic
  Fresh Start (FR-86). That is the Manager's own Fresh Start threshold,
  else its Floor's, 85% by default, set in the Agent editor and the
  Floor's settings (#121).
- **The summariser** is the Manager's own Model. FR-89's Decision Model
  option (off by default) arrives with the Decision Model itself (#109),
  which is not on this branch.
- **`/clear` and `/compact` come first**, so an office or repository Skill
  named `clear` or `compact` cannot be run from the chat.
- **PRD and ADRs.** No disagreement found. The summarising call goes
  through the AI Gateway with the Manager's Gateway Key, counted against
  its Token Caps (ADR 0001).

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

- **The Kickoff's acknowledgements** (#85) no longer count as an Agent's
  Context Usage (`97de0fe`). The Manager's own calls still do, so
  auto-compaction is unchanged.

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

The clearing and compacting tests:

```text
 Test Files  2 passed (2)
      Tests  19 passed | 4 skipped (23)
```
