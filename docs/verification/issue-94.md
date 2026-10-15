# Issue #94: Grilling Session: rounds, question cards and pause/resume — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) in this branch's working tree, after the issue's code commits.

The blocker, #93 (running Skills from the Manager chat), is built on this
branch ([`issue-93.md`](issue-93.md)): `/name` loads a Skill into the
Manager's session, and `/grilling` is one more Skill, AI Office's own.

## What was built

### Shared and the database (`packages/shared/src/grilling.ts`, migration `0048_context_usage_skills_and_grilling`)

- **Structured data** (the comment on the issue, for #122 and FR-88). A
  session's questions, settled decisions and glossary terms are kept as
  structured data, not only as chat text:
  - `grillingQuestionSchema`: number (across the session), the round it
    was asked in (null while it waits for its prerequisites), text,
    recommended answer, `dependsOn`, status (`open`, `answered`,
    `withdrawn`), the answer, and whether the recommended one was
    accepted;
  - `grillingDecisionSchema`: number, text (kept word for word), the
    questions it settles, and its round;
  - `grillingTermSchema`: term, definition, and words to avoid.
- **`grilling_sessions`**: one row per session, with `questions`,
  `decisions` and `terms` as JSONB, `status` (`active`, `paused` or
  `ended`), `round`, `awaiting_confirmation`, and when it started, was
  paused and ended. Checks keep the status and its timestamps in step,
  and a partial unique index allows one active session per Floor.
- **Chat messages** gain `grilling` (`{sessionId, round}`, null outside a
  session): `grilling_session_id` and `grilling_round`. There is a new
  message kind, `grilling`, for what AI Office says of a session in plain
  code.
- **A Floor's Skill may be `built-in`** (`floorSkillSources`).
- **Plain code**:
  - `readGrillingAnswers` reads `3: CSV`, `3.`, `Q3)`, `#3 -`, `3:
    recommended`, `recommended to all`, and a bare `recommended`;
  - `composeGrillingAnswers` is what the cards send;
  - `readGrillingControl` reads "pause the session", "resume the session",
    "resume session 3" and "confirm";
  - `grillingTurnSchema` is the JSON a Manager's turn must match.

### The orchestrator (`packages/orchestrator/src/grilling/`, `manager/chat.ts`)

- **The built-in Skill** (`grilling/skill.ts`): a `SKILL.md` with the
  grilling instructions, on every Floor (`withBuiltInSkills` in
  `skills/floor.ts`). No office or repository Skill of its name overrides
  it, and it is never mounted into a sandbox. The Manager is not offered
  it to choose for itself.
- **The rules, in plain code** (`grilling/session.ts`):
  - `applyTurn` numbers new questions on and keeps only `dependsOn` that
    point back. It withdraws moot questions, records decisions and terms
    (a term defined again replaces the earlier one), and settles every
    answered question as a decision (its question and answer, where the
    Model named none).
  - It then asks the next round: every open question whose prerequisites
    are answered or withdrawn. When none is ready but some wait, it asks
    them all. With none left, it asks the Owner to confirm.
  - `applyAnswers` records answers to the current round's questions.
- **The prompt** (`grilling/prompt.ts`): `grillingSessionSection` writes
  the session from its stored data. It gives the topic, every settled
  decision word for word, the glossary terms, and the open questions with
  their recommended answers and prerequisites. It is in the Manager's
  prompt for every message while the session runs. A turn adds the
  answers just given and the JSON to write. An answer that cannot be kept
  is asked for once more with what was wrong.
- **The chat**:
  - `/grilling [topic]` starts a session, keeping the Owner's message with
    the built-in Skill and a turn writing round 1.
  - Answers are recorded in plain code. A part-answered round is noted
    ("Noted your answer to 1. Still open in round 1: 2."), with no model
    call. A completed round has the Model write the next.
  - "confirm" ends the session once no open questions remain.
  - "pause the session" and "resume the session" (or "resume session N")
    pause and resume it. Resuming shows the open round's cards again.
  - A second `/grilling`, a bare "recommended" with several open, a number
    not in the round, and "confirm" with questions open are each answered
    with a hint.
  - Anything else goes to the Model, with the session in its prompt.
    Commands still work.
  - A turn's JSON is not streamed to listeners. Everything kept is
    redacted.
- `grillingSessions(floorId)` and `grillingSession(floorId, id)` read
  them, the latter with every chat message of the session
  (`ManagerChatStore.ofGrillingSession`).

### The server (`apps/server/src/manager-chat/routes.ts`)

- `GET /api/floors/:floorId/grilling-sessions` lists a Floor's sessions.
- `GET /api/floors/:floorId/grilling-sessions/:sessionId` gives one in
  full, with its messages, or `404 grilling_session_not_found`.
- Both need a signed-in session. The store is wired into the chat in
  `server.ts` and `app.ts`.

### The web app (`apps/web/src/grilling.tsx`, `manager-chat.tsx`)

- **Question cards.** A round's message shows its preamble, then its
  questions as cards. Each card shows the question, the recommended answer
  and, once answered, the answer (or **Recommended**). While it is the
  running session's latest message for the round, each open card has its
  own answer box (labelled "Your answer to question N") and an **Accept
  recommended** button (`aria-pressed`). **Send answers** sends what was
  written or accepted as one message, and **Recommended to all** accepts
  the rest of the round.
- **The session bar** above the chat shows the running session, its round,
  how many questions are open and decisions settled. It has **Pause
  session**, and **Confirm and end** once no open questions remain.
- **Grilling Sessions** beside the chat lists every session with its
  status. **Read** opens one in full: decisions, terms, each round's
  questions and answers, questions not yet asked, and the conversation.
  **Resume** resumes a paused one.
- The Available Skills list marks `/grilling` **Built in**. The Floor
  admin's per-Role Skill switches leave it out.

The guide documents it under
[Grilling Sessions](../guide/events-and-chat.md#grilling-sessions).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
  exit 0 (output below). Without Docker the Postgres tests skip with the
  reason: 2835 passed, 381 skipped.
  - In the first full run, `scene/floor-layout.test.ts` (the 3D waypoint
    search for 10 and 11 Agents) timed out at 5 s under the full suite's
    load. It passes alone (77/77, 17 s), and the next full run passed
    whole. It does not touch anything this issue changed.
- [x] **Scenario test with a fake model: two rounds, accept-all, end on
  confirmation, resume after pause.**
  `packages/orchestrator/src/grilling/scenario.test.ts` drives the Manager
  chat end to end, in memory and in Postgres 18 (both passing). It uses a
  Floor added from the fake GitHub, the real Floor Skills (so `/grilling`
  is the built-in Skill), and a scripted Model writing JSON turns.
  - **Starting.** `/grilling CSV export for orders` keeps the Owner's
    message with `skill: {name: "grilling", source: "built-in"}`. Round 1
    asks questions 1 and 2. Question 3 depends on 1, so it waits
    (`round: null`). The kept text is checked line by line, with a
    credential in a recommended answer redacted. The prompt holds the
    built-in Skill, the session section and "Start the session". No
    delta of the JSON reached listeners.
  - **Answering part of a round.** "1: Orders and refunds, one row each"
    is noted in plain code, with no model call.
  - **Pause.** "pause the session" pauses it and says where it stands. The
    next message ("Is it sunny?") is the Manager's own: no session in its
    prompt, no `grilling` on either message.
  - **Resume.** "resume the session" resumes it. The message carries
    round 1 again, so its cards come back.
  - **Accept-all.** "recommended to all" accepts question 2, and the
    Model's turn is asked for. Its prompt lists both answers, Q2 marked
    "(the recommended one)".
  - **Round 2.** It asks question 3 (its prerequisite now settled) and
    the new question 4. Decision 1 is the Model's. Decision 2 was settled
    by AI Office from question 2's answer. The term is kept.
  - **No open questions.** "Recommended to all." accepts round 2, and the
    turn leaves nothing open. The chat asks to "confirm". The prompt's
    "Settled decisions" section is checked to be exactly decisions 1 and
    2, word for word.
  - **End on confirmation.** "Confirm" ends the session: `ended`, 4
    decisions and 1 term. No further model call is made.
  - **Kept.** The session's 14 messages are read back in order, with the
    paused-time aside left out. After it ends, messages are the Manager's
    own again.

  The second case covers the hints:
  - `/grilling` while one runs, a bare "recommended" with two questions
    open, a question not in the round, and "confirm" with questions open;
  - a question about the round answered by the Model with the session's
    open questions in its prompt ("Q3, not yet asked (asked once Q1 is
    settled)");
  - "status" still a command;
  - an answer without JSON asked for once more, with the retry message;
  - "resume session 9" not found, and "resume session 1" resuming it.

Also:

- `packages/orchestrator/src/grilling/session.test.ts` (6 tests):
  - numbering, and keeping only prerequisites that point back;
  - withdrawal releasing a waiting question;
  - asking every waiting question when none can be ready;
  - every answer settled as a decision;
  - term replacement;
  - a bare "recommended" taken only with one question open.
- `packages/shared/src/grilling.test.ts` (8 tests): every answer form,
  continuation lines, the cards' message read back, and the controls,
  leaving the Floor's own `pause` and `resume` alone.
- `apps/server/src/manager-chat/routes.test.ts` (1 new): a session
  through the API, from `/grilling` to "confirm":
  - the list and the full session, with its question, decision and six
    messages;
  - 404 for another id, a non-number and an unknown Floor;
  - 401 signed out.
- `apps/web/src/manager-chat.test.tsx` (4 new):
  - the cards, with an answer typed into one, another accepted, and
    "Send answers" sending `1: JSON, and CSV later\n2: recommended`;
  - an answered card taking no more answers, and "Recommended to all";
  - Resume, and Read with the decisions and the questions;
  - the session bar's Confirm and end and Pause session.
- `packages/orchestrator/src/skills/floor.test.ts` (1 new): the built-in
  Skill on a Floor whose office library and repository both have a
  `grilling` Skill. The list and the Floor admin's list include it with
  every Role off. Sandboxes are never given it.
- Updated for the built-in Skill (each now also checks it): the Floor's
  Skill lists (`skills/floor.test.ts`, `skills/floor-routes.test.ts`), the
  unknown-Skill hint naming `/grilling` (`skills-scenario.test.ts`,
  `routes.test.ts`), and the Manager choosing `[use skill: grilling]`,
  which is now left out because it is not offered
  (`skills-scenario.test.ts`).

**Negative checks.** Each sabotage was run, then reverted with `git
checkout`, after which the tests were green again. Run over
`grilling/*.test.ts` and `shared/src/grilling.test.ts`:

| Sabotage | Failed |
| --- | --- |
| "recommended to all" is never read | 3 tests |
| An answer the Model names no decision for is not settled | 2 tests |
| Waiting questions are never asked once their prerequisites settle | 4 tests |
| The prompt's settled decisions lose their text | 1 test |
| Pausing is not kept | 2 tests |

### How Postgres was run here

As for #92 and #93:
- **The server:** `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4), in `/tmp/pg18`, outside the repository.
- **The harness patch:** a scratch edit to
  `packages/db/src/testing/postgres.ts` (`SCRATCH_PG_URL`, database
  names unique per worker). It was applied for each run and reverted with
  `git checkout`, never committed.

Migration `0048_context_usage_skills_and_grilling` applied with the rest.

The whole suite against it: 3194 passed, 21 skipped, 1 failed. The
failure was `work/queue.test.ts` "starts review rounds whatever the
sandbox limit…": issue 4 started before the test expected it to. That is
the work queue's timing under the full suite's load. The file passed 38/38
three times in a row on its own against the same Postgres. It does not
touch anything this issue changed.

### Not verifiable in this sandbox

- **Testcontainers**: the Postgres tests' Testcontainers path needs Docker;
  they ran against the embedded Postgres 18.4 instead, and run in CI.
- **A real Model running a session.** The scripted Model writes the JSON
  turns. Two things need the host with a real AI Account (PRD §9: CI
  never calls a live AI Provider):
  - whether a real Manager's Model keeps to the form and the prerequisites
    rule;
  - whether its questions are good ones.

  An answer that does not match is asked for once more, then kept as an
  error the Owner can retry by sending a message.
- **The browser.** The cards, bar and list were tested in jsdom (Testing
  Library), not in Chromium: Playwright's browser and its system libraries
  are not installed in this sandbox, and no end-to-end test was added.

## Output

### `pnpm lint`

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
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
 Test Files  246 passed (246)
      Tests  2835 passed | 381 skipped (3216)
exit=0
```

### `pnpm test` against the embedded Postgres 18.4

```text
 FAIL  |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > starts review rounds whatever the sandbox limit, for no one Agent, holding them while a required reviewer is paused
AssertionError: expected [ 1, 3, 2, 4, 5 ] to deeply equal [ 1, 3, 2, 5 ]
 Test Files  1 failed | 245 passed (246)
      Tests  1 failed | 3194 passed | 21 skipped (3216)

$ SCRATCH_PG_URL=… pnpm exec vitest run packages/orchestrator/src/work/queue.test.ts   (three times)
      Tests  38 passed (38)
      Tests  38 passed (38)
      Tests  38 passed (38)
```

### The scenario and API tests (verbose, against the embedded Postgres 18.4)

```text
✓ … grilling/session.test.ts > applyTurn > numbers questions on, and asks those whose prerequisites are settled
✓ … grilling/session.test.ts > applyTurn > withdraws moot questions, and asks a waiting one once its prerequisite is withdrawn
✓ … grilling/session.test.ts > applyTurn > asks every waiting question when none can ever be ready
✓ … grilling/session.test.ts > applyTurn > settles every answer as a decision, and replaces a term defined again
✓ … grilling/session.test.ts > applyAnswers > records answers in the Owner's words or the recommended ones
✓ … grilling/session.test.ts > applyAnswers > takes a bare 'recommended' only when one question is open
✓ … grilling/scenario.test.ts > Grilling Sessions in the Manager chat, in memory > two rounds, a pause and a resume, recommended to all, and the session ends on confirmation
✓ … grilling/scenario.test.ts > Grilling Sessions in the Manager chat, in memory > a session's questions are answered in plain code, and what cannot be read is refused with a hint
✓ … grilling/scenario.test.ts > Grilling Sessions in the Manager chat, in Postgres > two rounds, a pause and a resume, recommended to all, and the session ends on confirmation
✓ … grilling/scenario.test.ts > Grilling Sessions in the Manager chat, in Postgres > a session's questions are answered in plain code, and what cannot be read is refused with a hint
✓ … manager-chat/routes.test.ts > Grilling Sessions > lists a Floor's sessions and reads one with its decisions and every message
✓ … manager-chat/routes.test.ts > kept in Postgres 18 > keeps each Floor's chat across a restart
Tests  20 passed (20)
```

## Notes

- **Plain code and the Model.** As with the Manager chat's commands
  (FR-24), the Model writes questions and judgements, and plain code does
  everything that can be checked. That means numbering, which questions a
  round may ask, recording answers, and saying when no open questions
  remain. Those rules (FR-78) are therefore deterministic and tested.
- **Every answer becomes a decision.** A decision the Model writes names
  the questions it settles. Any answered question none names is settled
  as its question and answer, so nothing the Owner decided is only in the
  chat's text.
- **Answers go through the chat.** The cards and the bar's buttons send
  ordinary chat messages, so typed and clicked answers are read the same
  way and the transcript shows them. They send "3: recommended",
  "recommended to all", "pause the session" and "resume session N".
  Pausing and resuming therefore have no REST route.
- **"pause" alone** is still the Floor's own command (FR-24). Pausing a
  session needs "the session" (or "grilling").
- **Out of scope here**, as the issue says:
  - fact-finding in a read-only sandbox (#95, FR-79);
  - the documents on a branch and their pull request (#96, FR-80);
  - the proposed issues (#97, FR-81);
  - the Manager in the meeting room and the whiteboard (FR-83).
- **PRD and ADRs.** No disagreement found. The session's model calls go
  through the AI Gateway with the Manager's Gateway Key (ADR 0001).

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

- **Not in configuration export** (#113): Grilling Sessions are what AI
  Office records, like chats and Batches, so they stay out of it; the
  guide says so.
- **In 3D** (FR-83, still for later): the other side's meetings
  (`scene/away-pose.ts`) are the only thing that takes the Manager to the
  meeting room so far.

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

The Grilling Session tests:

```text
 Test Files  3 passed (3)
      Tests  16 passed | 2 skipped (18)
```
