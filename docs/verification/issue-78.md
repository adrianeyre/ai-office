# Issue #78: Manager chat with plain-code commands — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `3eb2b0d` (every code
commit of the issue, plus the README), after `pnpm install
--frozen-lockfile`. The Postgres and Playwright runs were made in the
working tree at the same code.

## What was built

### The commands (`packages/orchestrator`, `manager/commands.ts`)

`readManagerCommand(text)` reads one of the Owner's messages in plain code,
before anything reaches a model (PRD FR-24). It answers one of three things:

- **`command`**, with the command and what was understood, in words:
  - `complete` and `skip` take issue lists: ranges (`1 to 5`, `1-5`, `1–5`,
    `1 through 5`, `1 thru 5`), lists (`1, 3 and 4`, `1,3,4`, `1 3 4`,
    `#1 & #3`), and both together (`1 to 3, 7 and 9-10`). `issue` or
    `issues` is optional. Each issue is kept once, in the Owner's order.
  - `move <issue> up|down`.
  - `pause` and `resume`, on their own.
  - Case, a trailing full stop or `!`, and a leading or trailing "please"
    do not matter.
  - What was understood names every issue, ranges expanded: "Understood:
    complete 5 issues: #1, #2, #3, #4 and #5."
- **`refused`**, with a hint, for a message made only of a command's words
  and numbers that is not a command it can carry out:
  - **Typos.** Each word that is not a command word is compared with the
    command words (optimal string alignment distance: 1 edit for words up to
    5 letters, 2 from 6). If the corrected message would be a command, it
    is refused with `I did not understand that. Did you mean "complete
    issues 1 to 5"?`, plus what else is wrong when the corrected one is
    incomplete ("skp" → `Did you mean "skip"? Say which issues to skip…`).
  - **Lists it cannot read.** A range that runs backwards, issue 0, a number
    no issue has, more than 50 issues, a range or list left unfinished, a
    verb without its issues (`skip`), `move 5` without a direction, or
    `pause 4`. Each says what to type instead.
- **`message`** for anything else, even a sentence that starts with a
  command's word ("skip the flaky test in issue 4", "Pause for a moment: why
  is #4 blocked?", "complete issues 1 to 5?"). It goes to the Manager's
  Model.

The commands and their types (`managerCommandSchema`) are in
`packages/shared` (`manager-chat.ts`), with the chat's message, request,
response and stream frame schemas.

### Streamed model calls (`packages/orchestrator`, `models/client.ts`)

`ModelClient` gains `stream(request, { onText, signal })`. The Gateway
client sends the same Messages request as `complete`, with `stream: true`
and the Agent's own Gateway Key (ADR 0001), and reads the Gateway's
server-sent events: each `text_delta` goes to `onText` as it arrives, and
the whole reply resolves at `message_stop`. An `error` event, or a stream
that ends before `message_stop`, is a `ModelCallError`; a refusal before
streaming (a Token Cap's 403, say) carries the Gateway's status and
message, as `complete` does. An answer that comes back whole is taken all at
once. The reviewer flow is unchanged.

### `manager_chat_messages` (`packages/db`, migration `0029_manager_chat`)

Each Floor's conversation, oldest first by `id`:

- `kind`: `owner` (the Owner's words), `command` (what a command was
  understood as, with `command` as JSON), `hint` (a refused command),
  `reply` (the Manager's Model's answer) or `error` (why it did not answer);
- `reply_to`: the Owner's message a Manager's message answers;
- `agent_id`: the Manager who answered; `model`: the Model asked;
- checks: the kinds; the Owner's messages and only theirs answer nothing
  and name no Agent; only a `command` message has a command.

### The chat (`packages/orchestrator`, `manager/chat.ts`)

`createManagerChat({ store, floors, agents, models, defaultModels,
carryOut, redactor })`, with `history`, `after`, `send`, `subscribe` and
`stop`. `memoryManagerChatStore` and `databaseManagerChatStore` are part of
`OfficeStores`.

- **A command** is kept with the Owner's message and answered at once:
  what was understood, then what was done. `carryOut` is where Batches
  (#83) will act on it; until then the answer says that nothing changed
  ("Batches are not available yet, so nothing was started."). No model is
  called.
- **A refused command** is answered with its hint. No model is called.
- **Anything else** goes to the Floor's Manager's Model (its own, or its AI
  Provider's default) through `models.stream`, as the Manager
  (`agentId`), so the Gateway attributes it to the Manager and its Floor and
  counts it against its Token Caps.
  - **The prompt** (`managerSystemPrompt`, `manager/prompt.ts`) names the
    Manager, its Floor, repository and default branch, its team (name,
    Role, AI Provider, Model, paused), what a Manager may never do (merge,
    change repository settings, raise a cap), the commands AI Office reads
    itself, and that it cannot see the repository from the chat. The
    Manager's extra instructions end it.
  - **The conversation** (`conversation`) is the last 50 messages: the
    Owner's as the user's turns, the Manager's (commands' answers too) as
    the assistant's, turns in a row joined, errors left out, starting with
    the Owner and at most 100,000 characters.
  - **As it is written**, each piece is told to listeners (`delta`), and a
    new listener or the history starts from the text so far. Once finished
    it is kept and told (`message`).
  - **Why it did not answer** is kept as an `error` message: the Gateway's
    refusal ("Ada could not answer: The AI Gateway answered 403: …"), an
    empty answer, a paused Manager (no call is made), a Manager whose AI
    Provider has no default Model, or AI Office stopping mid-reply.
- **One at a time.** While the Manager answers, the Floor's next message is
  refused with `reply_in_progress`.
- **Floors.** An unknown Floor is `floor_not_found`; an archived Floor's
  chat can be read but not added to (`floor_archived`).
- **Credentials.** The Owner's words, and every answer, go through the
  server's redactor before they are kept or sent, so a key pasted into the
  chat reaches neither the database nor a model.

### `apps/server` (`manager-chat/routes.ts`)

Every route needs a session, and CSRF to send; the route-access test covers
them.

- `GET /api/floors/:floorId/manager-chat`: the Manager (id, name, AI
  Provider, Model), the latest 200 messages and the reply being written.
- `POST /api/floors/:floorId/manager-chat/messages` with `{"text"}` (1 to
  8,000 characters, trimmed): `201 {"message","reply"}`, `reply` null while
  the Model's reply streams. `400 invalid_request`, `404 floor_not_found`,
  `409 floor_archived`, `409 reply_in_progress`. The log line names the
  Floor and the kind of answer, never the Owner's words.
- `GET /api/floors/:floorId/manager-chat/stream`: server-sent events, with
  the event stream's heartbeat and session re-check (`openSse`, which gains
  `sendData` for frames without an id).
  - `message` frames carry a kept message, with its id as the event id;
    `pending` (a reply's text so far) and `delta` frames carry no id, so a
    reconnection resumes after the last message.
  - With `Last-Event-ID` (or `?lastEventId=`) it subscribes first and holds
    what arrives, replays the messages after that id, sends the reply being
    written from its text so far (unless the replay held its answer), then
    what it held, skipping what it sent.
  - Closing the server ends open streams, then stops replies being written,
    keeping why.
- `buildApp` takes `models` (the server passes its own Gateway's client,
  now made before the app) and `redactor`, and makes the chat from
  `stores.managerChat`.

### `apps/web` (`manager-chat.tsx`)

- **`/floors/<floor>/manager`**, linked from the Floor admin as **Chat with
  the Manager**: "Chat with *name*", the Manager's Floor, AI Provider and
  Model, and a note on an archived Floor.
- **`ManagerChatPanel`**, for the glass office to reuse:
  - the conversation, the Owner's messages on the right; commands' answers
    marked **Command**, hints **Not understood**, errors in red;
  - the reply being written, growing as each piece arrives, with a cursor;
  - a box labelled "Message *name*": Enter sends, Shift+Enter starts a new
    line; Send is disabled while the Manager answers;
  - the commands AI Office reads, listed under the box;
  - the server's refusal, said in an alert; the connection's state ("Live",
    "Connecting…", "Reconnecting…") or "*name* is answering…".
- **The stream** opens once the chat is read, resuming after its last
  message, and reconnects with growing waits when the browser gives up.
  `withFrame` applies each frame; a piece of a reply already kept changes
  nothing.

The README has a **Manager chat** section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker the Postgres tests
      skip with the reason (1438 passed, 269 skipped). Against Postgres 18
      (below), 1688 passed and 19 skipped.
- [x] **Unit tests for the command parser (ranges, lists, typos refused
      with a hint).** `packages/orchestrator/src/manager/commands.test.ts`
      (45 tests):
  - **ranges:** `1 to 5`, `1-5`, `1 - 5`, `1–5`, `1 through 5`, `1 thru 5`,
    `#1 to #5`, without "issues", any case, with "please" and a full stop;
    a range of one; ranges and single issues together, each issue once;
    refused: a range that runs backwards, more than 50 issues, an
    unfinished range or list, issue 0, numbers no issue has;
  - **lists:** `1, 3 and 4`, `1,3,4`, `1 3 4`, `#1, #3, and #4`,
    `1 & 3 & 4`, one issue; the Owner's order kept; `skip` with one issue,
    a list or a range; `move` up and down (and refused without a direction
    or with extra numbers); `pause` and `resume` alone (refused with an
    issue);
  - **typos refused with a hint:** `compleet`, `complte`, `compelte`,
    `isues`, `thorugh`, `skp`, `mvoe`, `dwon`, `puase`, `resme`, `Paused.`,
    each answered `I did not understand that. Did you mean "…"?`; a
    misspelt and incomplete command says both;
  - **left for the model:** questions and sentences that start with a
    command's word, number words, an empty message;
  - what was understood, in words, and the edit distance.

  The same reading is exercised through the chat
  (`manager/chat.test.ts`, in memory and in Postgres 18: commands and
  hints answered with no model request), the API
  (`manager-chat/routes.test.ts`) and the browser (below).
- [x] **Playwright: a reply streams in.** `e2e/tests/manager-chat.spec.ts`,
      in real Chromium against the built app, Postgres 18 and the server's
      own AI Gateway, with an AI Account (an Anthropic API key) whose custom
      endpoint is a fake AI Provider in the test:
  - it adds the AI Account in Admin, adds the Floor, and opens **Chat with
    the Manager** from the Floor admin;
  - `complete issues 1 to 3` is answered at once with what was understood,
    and `compleet issues 1 to 3` with the hint; the AI Provider has had no
    request;
  - "What should we work on first?" goes to the Model. The fake AI Provider
    sends the first half of its answer ("Start with ") and holds the rest:
    **the page shows "Start with" while the rest is held**, with "*name* is
    answering…" and Send disabled;
  - the AI Provider got the AI Account's key (not the Manager's Gateway
    Key), `stream: true`, the Manager's Model and prompt, and the
    conversation so far;
  - released, the whole reply replaces the one being written, and the
    stream is "Live";
  - after a reload, all six messages are there;
  - the Gateway's request history attributes the call to the Manager and
    its Floor, streamed, 200;
  - the server's log says the Owner wrote to the Manager, without the
    Owner's words or the key.

  The whole suite passed: 22 tests (output below).

**Negative checks** (each reverted afterwards with `git checkout`), across
the 86 tests of this issue in `orchestrator`, `server` and `web`, and the
Playwright test:

| Sabotage | Failed |
| --- | --- |
| Typos are never corrected (`correction` answers nothing) | 14 unit tests |
| A range that runs backwards is accepted | 2 unit tests |
| Every message goes to the model (`readManagerCommand` reads nothing) | 50 unit tests |
| The chat never publishes a reply's pieces, only the reply once kept | 4 unit tests, and the Playwright test: `Expected substring: "Start with"`, `Received string: "Ole-Johan is writing ▍"` |

### How Postgres and Chromium were run here

There is no Docker in this sandbox, so I used the method of the earlier
issues.

- **Postgres:** `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, outside the repository, on port 54329.
  - For the unit and integration tests, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at that
    server through `SCRATCH_PG_URL`, with database names unique per worker.
    It was reverted with `git checkout` each time, and nothing from it is
    committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium:** installed with `playwright install chromium`. Its missing
  shared libraries were extracted from Debian bookworm's packages into
  `/tmp/chromelibs`, outside the repository, and used through
  `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against the embedded Postgres 18.4
  instead, and run in CI.
- **A real AI Provider.** The reply streamed from a fake AI Provider behind
  the real Gateway; no live model was called (PRD §9: CI never calls one).
  How a real Model answers the Manager's prompt is for the host.
- **The glass office.** The brief opens the chat from a 2D route "and later
  the glass office"; the 3D office does not exist yet. `ManagerChatPanel`
  is ready for it.

## Notes

- **"Confirmation of what it understood".** I read it as the chat saying
  back, in plain code, exactly what it understood (every issue named, ranges
  expanded), before anything else happens, rather than a yes/no dialogue:
  nothing a command does exists yet, so there is nothing to confirm before.
  If #83 wants a confirm step before starting a Batch, `carryOut` is where
  it goes.
- **Commands change nothing yet.** "complete issues…", "skip", "move",
  "pause" and "resume" are read and answered, and the answer says nothing
  changed: Batches and Plans are #83, and nothing pauses a whole Floor yet.
  The command is kept with its answer (`command` JSON), so #83 can act on
  it through `carryOut`.
- **What counts as a command.** Only a message made entirely of a command's
  words, issue numbers and separators is a command (or a refused one).
  "skip the flaky test in issue 4" or "complete issues 1 to 5?" go to the
  Model, so the Owner can still talk about skipping or completing. The
  Manager's prompt lists the commands' exact wording, so it can tell the
  Owner what to type.
- **Typo tolerance is narrow on purpose.** One edit for words up to five
  letters, two from six, and only towards `complete`, `skip`, `move`,
  `pause`, `resume`, `issue(s)`, `through` and `down`. "Some issues are
  stuck" is not refused: corrected, it would still not be a command.
- **One message at a time.** A second message (command or not) while the
  Manager answers is refused (`409 reply_in_progress`), so the conversation
  and the Model's turns stay in order.
- **Paused Manager.** A Manager turned off in the Agent editor does not
  answer (no model call), as no new work goes to a paused Agent; commands
  are still answered, since they are plain code.
- **The model only sees the chat.** The Manager cannot read the
  repository, issues or pull requests from the chat, and its prompt says
  so. Fact-finding is FR-79 (Grilling Sessions).
- **Words, not pronouns.** The chat names the Manager rather than using
  pronouns, so FR-14 is never at stake.

## Outside this issue

- **Context Usage, `/clear`, `/compact` and auto-compaction** for the
  Manager chat (FR-84, FR-87) are not built. The chat gives the Model its
  last 50 messages, at most 100,000 characters, and keeps everything.
- **Skills in the chat** (`/skill-name`, autocomplete; FR-24, FR-74) are
  #93, as the brief says.
- **Manager decisions in the Activity Feed** (FR-52): commands do not act
  yet, so the chat publishes no events. When #83 makes them act, their
  decisions should be events.
- **A restart mid-reply** leaves the Owner's message unanswered: replies
  being written are kept in memory. Stopping the server cleanly keeps an
  `error` saying AI Office stopped; a crash keeps nothing for that reply.
- **Pieces are not redacted.** The finished reply is redacted before it is
  kept; the pieces streamed meanwhile are not, since a credential could be
  split across two. Nothing secret is in the Manager's prompt, so there is
  none for it to repeat.
- **Older messages.** The page shows the latest 200; paging back further
  is not built.

## Output

### Fresh clone (`/tmp/clone78`, `3eb2b0d`)

```text
$ pnpm install --frozen-lockfile
Done in 2.7s using pnpm v12.10.0

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
 Test Files  142 passed (142)
      Tests  1438 passed | 269 skipped (1707)
test exit=0
```

### Against the embedded Postgres 18.4

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  142 passed (142)
      Tests  1688 passed | 19 skipped (1707)
test exit=0
```

The 19 skips, with their reasons: the real-App GitHub contract (#18, no
`GITHUB_APP_ID`), and the Docker image and compose checks.

```text
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > finds the repository among the App's installations
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > mints an installation token for the repository
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > mints a read-only token that can read but not write
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > opens, finds, lists and closes an issue
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > creates labels, and adds and removes them
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > records who added and removed an issue's labels
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > comments on an issue, and lists the comments oldest first
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > edits a comment in place, by its id
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > creates, finds and deletes a branch
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > opens a pull request, reviews it, sees CI finish and merges it
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > fails with GitHub's status for what does not exist
↓ |deployment| docker/sandbox-images.test.ts > hadolint, on the claude image > finds nothing to fault in the Dockerfile [hadolint is not installed (spawn hadolint ENOENT); Docker is not available (spawn docker ENOENT)]
↓ |deployment| docker/sandbox-images.test.ts > hadolint, on the codex image > finds nothing to fault in the Dockerfile [hadolint is not installed (spawn hadolint ENOENT); Docker is not available (spawn docker ENOENT)]
↓ |deployment| docker/sandbox-images.test.ts > hadolint, on the opencode image > finds nothing to fault in the Dockerfile [hadolint is not installed (spawn hadolint ENOENT); Docker is not available (spawn docker ENOENT)]
↓ |deployment| docker/sandbox-images.test.ts > with Docker, the claude image > builds, and runs claude --version as agent [AI_OFFICE_SANDBOX_IMAGE_E2E is not 1 (building the images downloads each agent tool and takes minutes)]
↓ |deployment| docker/sandbox-images.test.ts > with Docker, the codex image > builds, and runs codex --version as agent [AI_OFFICE_SANDBOX_IMAGE_E2E is not 1 (building the images downloads each agent tool and takes minutes)]
↓ |deployment| docker/sandbox-images.test.ts > with Docker, the opencode image > builds, and runs opencode --version as agent [AI_OFFICE_SANDBOX_IMAGE_E2E is not 1 (building the images downloads each agent tool and takes minutes)]
↓ |deployment| docker/deployment.test.ts > with Docker > docker compose config validates the file [Docker Compose is not available (spawn docker ENOENT; spawn docker-compose ENOENT)]
↓ |deployment| docker/deployment.test.ts > with Docker > docker compose up gives a healthy app and database, and keeps data across a restart [AI_OFFICE_COMPOSE_E2E is not 1 (bringing the stack up builds the image and takes minutes)]
Test Files  142 passed (142)
Tests  1688 passed | 19 skipped (1707)
```

This issue's tests, verbose, against Postgres (timings removed):

```text
✓ |@ai-office/orchestrator| src/manager/prompt.test.ts > managerSystemPrompt > names the Manager, its Floor, its team and the commands AI Office reads
✓ |@ai-office/orchestrator| src/manager/prompt.test.ts > managerSystemPrompt > ends with the Owner's extra instructions for the Manager
✓ |@ai-office/orchestrator| src/manager/prompt.test.ts > conversation > gives the Owner's turns as the user's, and the Manager's as the assistant's
✓ |@ai-office/orchestrator| src/manager/prompt.test.ts > conversation > starts with the Owner, leaving the oldest turns out to fit
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues 1 to 5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues 1-5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues 1 - 5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues 1–5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues 1 through 5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues 1 thru 5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues #1 to #5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete 1 to 5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "Complete Issues 1 To 5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "  complete issues 1 to 5.  " as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "please complete issues 1 to 5" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads "complete issues 1 to 5, please" as issues 1 to 5
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > reads a range of one
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > joins ranges and single issues, each issue once
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > refuses a range that runs backwards, saying which way it goes
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > refuses more than 50 issues in one command
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > refuses an unfinished range or list
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > ranges > refuses issue 0 and numbers no issue has
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads "complete issues 1, 3 and 4"
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads "complete issues 1,3,4"
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads "complete issues 1 3 4"
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads "complete issues #1, #3, and #4"
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads "complete issues 1 & 3 & 4"
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads "complete issue 4"
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads "complete #4"
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > keeps the Owner's order, each issue once
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads skip with one issue, a list or a range
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads move up and down
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > lists > reads pause and resume on their own
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "compleet issues 1 to 5" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "complte issues 1 to 5" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "compelte 1-5" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "complete isues 1 to 5" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "complete issues 1 thorugh 5" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "skp 4" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "mvoe 5 up" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "move 5 dwon" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "puase" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "resme" with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > refuses "Paused." with a hint
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > says what is also wrong with a misspelt command
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > typos > leaves sentences alone, even ones that start with a command's word
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > what it understood > names every issue, with ranges expanded
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > what it understood > lists issues as people write them
✓ |@ai-office/orchestrator| src/manager/commands.test.ts > editDistance > counts insertions, deletions, substitutions and swaps as one edit
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient > calls the Gateway's Messages API with the Agent's Gateway Key, attributed to its issue and pull request
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient > fails with the Gateway's status and message, such as a Token Cap's refusal
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient > fails without calling when the Agent has no Gateway Key, or the Gateway cannot be reached
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient, streamed > gives each piece of text as the Gateway passes it on, then the whole reply
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient, streamed > reads frames with Windows line endings
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient, streamed > fails with the Gateway's status and message before anything streams
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient, streamed > fails on an error event, or a stream that ends before the answer
✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient, streamed > takes an answer that came whole, all at once
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > answers a command in plain code with what it understood, and no model sees it
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > refuses a misspelt command with a hint, and no model sees it
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > carries a command out when it can, saying what it did
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > streams anything else from the Manager's Model, then keeps the reply
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > gives the Model the conversation so far
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > keeps why the Model did not answer, and takes the next message
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > a paused Manager does not answer, but commands still are
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > keeps credentials out of what it keeps and sends
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > refuses an unknown Floor, and messages to an archived one
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > stopping keeps why a reply was left unfinished
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > reads messages after one it was given, a Floor at a time
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > answers a command in plain code with what it understood, and no model sees it
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > refuses a misspelt command with a hint, and no model sees it
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > carries a command out when it can, saying what it did
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > streams anything else from the Manager's Model, then keeps the reply
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > gives the Model the conversation so far
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > keeps why the Model did not answer, and takes the next message
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > a paused Manager does not answer, but commands still are
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > keeps credentials out of what it keeps and sends
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > refuses an unknown Floor, and messages to an archived one
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > stopping keeps why a reply was left unfinished
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > reads messages after one it was given, a Floor at a time
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > the table refuses a message that answers nothing, or a command without one
✓ |@ai-office/server| src/manager-chat/routes.test.ts > sending > answers a command at once, in plain code, with what it understood
✓ |@ai-office/server| src/manager-chat/routes.test.ts > sending > refuses an empty, overlong or malformed message
✓ |@ai-office/server| src/manager-chat/routes.test.ts > sending > refuses an unknown Floor, an archived one, and a message while the Manager answers
✓ |@ai-office/server| src/manager-chat/routes.test.ts > sending > needs a session, and the CSRF token to send
✓ |@ai-office/server| src/manager-chat/routes.test.ts > the stream > streams the Manager's reply a piece at a time, then the reply as kept
✓ |@ai-office/server| src/manager-chat/routes.test.ts > the stream > resumes after the last message a client has, from a reply's text so far
✓ |@ai-office/server| src/manager-chat/routes.test.ts > the stream > is a 404 for a Floor that does not exist
✓ |@ai-office/server| src/manager-chat/routes.test.ts > kept in Postgres 18 > keeps each Floor's chat across a restart
✓ |@ai-office/web| src/manager-chat.test.tsx > the Manager chat > names the Manager and shows the conversation so far
✓ |@ai-office/web| src/manager-chat.test.tsx > the Manager chat > sends a command, and shows what it was understood as at once
✓ |@ai-office/web| src/manager-chat.test.tsx > the Manager chat > streams the Manager's reply in, a piece at a time
✓ |@ai-office/web| src/manager-chat.test.tsx > the Manager chat > says why a message was refused
✓ |@ai-office/web| src/manager-chat.test.tsx > withFrame > starts a reply from its text so far, then adds each piece
✓ |@ai-office/web| src/manager-chat.test.tsx > withFrame > adds each message once, in order, ending its pending reply
Tests  94 passed (94)
```

### `pnpm e2e` (embedded Postgres 18.4, Chromium)

```text
$ E2E_POSTGRES_URL=… pnpm e2e
✓   5 [chromium] › tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests
✓   7 [chromium] › tests/agent-live-view.spec.ts:107:1 › the live view follows new output, and pauses while the Owner reads back
✓   3 [chromium] › tests/activity.spec.ts:81:1 › the Activity Feed loads older events as it scrolls
✓   6 [chromium] › tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it
✓   1 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in
✓   4 [chromium] › tests/agent-live-view.spec.ts:10:1 › an Agent's events stream into its live view
✓   2 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor
✓   8 [chromium] › tests/agent-editor.spec.ts:52:1 › an Agent's new AI Provider and Model are what its next task uses
✓  16 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it
✓  10 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it
✓  12 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens
✓  14 [chromium] › tests/manager-chat.spec.ts:101:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in
✓  11 [chromium] › tests/gateway-keys.spec.ts:15:1 › makes a Gateway Key for a tool, uses it, then revokes it
✓  15 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed
✓   9 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page
✓  13 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked
✓  17 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page
✓  18 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in
✓  19 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out
✓  21 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session
✓  20 [chromium] › tests/skills.spec.ts:35:1 › writes a Skill, and uploads one that is reviewed before it is enabled
✓  22 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not
  22 passed (27.0s)
e2e exit=0
```
