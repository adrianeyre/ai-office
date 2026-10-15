# Issue #95: Grilling: fact-finding in a read-only sandbox — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) in this branch's working tree, after the issue's last
code commit (`b87fe50`).

The blockers are on main:
- #24's sandbox runner ([`issue-24.md`](issue-24.md)) gives the GitHub App's
  read-only token, the clone and the allow-listed environment that this
  issue reuses.
- #94's Grilling Session ([`issue-94.md`](issue-94.md)) is extended here,
  not rebuilt: its turns, rounds, store, prompt section and chat.

## What was built

The Manager finds facts itself rather than asking the Owner (PRD FR-79).
While it writes a turn, it may name **facts to find** instead of asking
questions. AI Office finds each one in the Floor's code, docs and issues,
in a read-only sandbox, by the Manager or by an Agent it sends. It keeps
the answers with the session and asks the Model for its turn again. The
Model then knows them, so it asks the Owner only for decisions.

### Shared, the database and events

- **`grillingTurnSchema`** (`packages/shared/src/grilling.ts`) gains
  `facts`: up to `maxGrillingFactsPerTurn` (5). Each has a `question` and
  an optional `agent`, the name of a Floor Agent to send.
- **`grillingFactSchema`**: number (across the session), question, answer
  (word for word, cut to `maxGrillingFactLength`, 4000), status (`found`,
  or `failed`, the answer then saying why), the Agent that found it, the
  round it was found at, and when. `grillingSessionSchema` has `facts`.
- **`grilling_sessions.facts`**: JSONB, `NOT NULL DEFAULT '[]'`
  (migration `0061_grilling_facts`), so sessions kept before it read back
  with none.
- **Events** (`packages/events`): `grilling.fact_finding_started` and
  `grilling.fact_finding_stopped`. They carry the Floor, the Agent sent,
  the session and the sandbox, and the outcome: `found`, `unanswered`,
  `failed`, `cancelled` or `timed_out`. They hold no question text. The
  Activity Feed lists them under **Sandboxes** and describes them.

### The read-only sandbox (`packages/orchestrator/src/grilling/fact-finding.ts`)

`createSandboxFactFinder({ github, events, sandbox, gateway, workDir, … })`
finds one fact per sandbox, with Sandcastle's `run()`:

- **Clone:** the Floor's default branch, cloned with the GitHub App's
  **read-only** token (`readOnlyToken()`, #24), passed to Git through its
  environment. The repository's own `.sandcastle/.env` is deleted, as in
  the runner.
- **Environment:** the allow-listed keys only (`allowListed`,
  `sandboxEnvironment`). It holds the sent Agent's way to the AI Gateway,
  with its **own Gateway Key** (ADR 0001), and `GH_TOKEN`, the read-only
  token, so `gh` can read issues and pull requests. It holds **no Git
  identity**: `sandboxEnvironment`'s `identity` is now optional. Its model
  calls name the sandbox as their session and **no issue**:
  `ModelAttribution.issue` is now optional. One of the Owner's AI Account
  credentials is refused, as for every sandbox.
- **Agent tool:** the sent Agent's (Claude Code, Codex or opencode, FR-16).
  The prompt is inline, so it is never shell-expanded. It asks for the
  answer between `<fact>` and `</fact>`, naming what was read.
- **No branch:** `branchStrategy: { type: "head" }`, in the clone itself.
  Nothing from it is ever pushed.
- **Read-only, checked:** after the run, AI Office compares the clone's
  `HEAD` with the default branch's and reads `git status`. If the
  repository changed (a commit, or a file left changed), the answer is
  **not kept**, because it may describe the sandbox's own changes.
- **Deleted:** the clone and its log are removed whatever happened.
- **Never rejects:** a fact that cannot be found is `failed`, saying why.
  That covers a failing sandbox, cancellation, a 10-minute timeout and no
  `<fact>`.

### The chat (`manager/chat.ts`, `grilling/prompt.ts`, `grilling/session.ts`)

- **Offered while it may be used.** With a fact finder, a turn's
  instructions add `facts`. They say: never ask the Owner what the
  repository can answer; you (the Manager) or the Agent you name finds it;
  nothing else in an answer listing `facts` is kept. They list the Agents
  it may send (`sendableAgents`): enabled, staying sandbox Agents (coder,
  QA, docs, designer), never a reviewer, which has no sandbox (FR-20).
  Without a fact finder (`app.ts`, or no GitHub App or
  `SANDBOX_GATEWAY_URL`) nothing changes.
- **A turn that names facts:**
  1. The chat says what is being found and by whom: "Before round 1,
     finding 2 facts in the repository rather than asking you: … (Ada,
     sent by Evelyn)". An Agent that cannot be sent is noted, and the
     Manager finds that fact itself.
  2. Every fact is found at once, each Agent with its own Model.
  3. `recordFacts` keeps them with the session, numbered on.
  4. The chat says what was found ("Found in the repository: F1. … ").
  5. The Model is asked for its turn again, with the facts in the session
     section.

  A turn may do this twice (`maxFactPasses`). The third time it is not
  offered, and any facts it names are left out.
- **The session section** (FR-88) gains "Facts found in the repository",
  each answer word for word. It says those are not to be asked of the
  Owner, and that one not found may be asked if it matters. Like the
  decisions, it is written from stored data into every prompt of the
  session, so compaction never loses it.
- **The built-in Skill** adds "Find facts yourself: …".
- **Kept and redacted:** the facts to find and the answers are redacted
  before they are kept or shown. Both chat messages answer the Owner's
  message, as the `manager_chat_messages_reply_to` check requires.

### The server and the web app

- `apps/server/src/server.ts` builds the fact finder with Docker sandboxes
  on `SANDBOX_NETWORK`, the Agent's Gateway Key, the AI Account check and
  `<SANDBOX_WORK_DIR>/facts`. It does this when the GitHub App and
  `SANDBOX_GATEWAY_URL` are set, and passes it to the Manager chat.
- `GET /api/floors/:floorId/grilling-sessions/:sessionId` includes
  `facts`.
- The session dialog (**Read**) shows "Facts found in the repository",
  each with its answer, or "Not found:" and why.
- The guide documents it under
  [Grilling Sessions](../guide/events-and-chat.md#grilling-sessions).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
  exit 0 (output below). Without Docker the Postgres tests skip with the
  reason: 3768 passed, 493 skipped. `db:generate` finds nothing more to
  generate.
- [x] **Scenario test: a factual question is answered from the repository
  without asking the Owner.**
  `packages/orchestrator/src/grilling/fact-finding-scenario.test.ts`
  drives the Manager chat end to end, in memory and in Postgres 18.4 (both
  passing, below). Its parts:
  - a Floor added from the fake GitHub, with its real Development team;
  - a scripted Model writing JSON turns;
  - the **real** `createSandboxFactFinder`, running the **real** Sandcastle
    `run()` with the fake bind-mount sandbox (the host stands in for
    Docker), against a local bare repository standing in for GitHub's
    remote. Its `docs/stack.md` says "Orders are kept in Postgres 18, in
    the `orders` table." The script standing in for the agent tool runs
    `grep` and `ls` in the clone and answers from their output, so each
    answer really comes from the repository.

  The first case, step by step:
  - **The turn.** `/grilling CSV export for orders`: the Model's first
    turn names two facts. "Which database are orders kept in?" is its own;
    "Does the shop already export orders as CSV?" goes to the coder. The
    same turn also carries the database question as a question for the
    Owner, which is not kept.
  - **Found.** Each fact is found in its own sandbox. The facts are kept:
    - F1, by the Manager: "Orders are kept in Postgres 18, in the `orders`
      table. (docs/stack.md)";
    - F2, by the coder: "No file under src/ mentions CSV: orders.ts only
      lists orders. There is no export yet."
  - **Asked again.** The Model's second prompt holds them word for word
    under "Facts found in the repository" (checked line by line). Its first
    prompt offered `facts`, named the coder, left out the reviewer, and
    carried the Skill's "Find facts yourself:".
  - **Not asked of the Owner.** Round 1 asks the Owner only "Which records
    does the export hold?" and "Who may run an export?" (checked word for
    word). No message but AI Office's own fact-finding notes mentions the
    database question.
  - **The chat.** The session's messages, in order, are the Owner's,
    "Before round 1, finding 2 facts…", "Found in the repository: …", and
    the round. Each of the last three answers the Owner's message.
  - **Read-only.** Each sandbox was given its own Agent's Gateway Key (the
    Manager's and the coder's), the GitHub App's read-only token (checked
    with the fake's `tokenScope`) and no Git identity, and was closed. The
    remote's `main` is unchanged. Two `grilling.fact_finding_started` and
    two `grilling.fact_finding_stopped` (`found`) events were published,
    and no turn JSON was streamed.

  The second case covers the rest:
  - a fact for the reviewer, which has no sandbox, and one for an unknown
    "Zed", both found by the Manager and noted in the chat;
  - a second round of fact-finding;
  - a third turn no longer offered `facts`, whose facts are left out while
    its question is asked.

Also:

- `grilling/fact-finding.test.ts` (8 tests): the fact finder with real
  Sandcastle, the fake sandbox and a local bare remote.
  - **Found from the repository.** The answer is read from the `<fact>`
    tags. The environment is exactly `ANTHROPIC_AUTH_TOKEN`,
    `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` and `GH_TOKEN`, even
    though the host has `DATABASE_URL` and `SESSION_SECRET` and the
    repository commits a `.sandcastle/.env` naming them. `GH_TOKEN` has
    `readOnlyPermissions`. The headers name only the session (the
    sandbox's id). The prompt is checked, the work directory is empty
    afterwards, and the events are checked exactly.
  - **A sandbox that commits a change** has its answer refused. The bare
    remote's `main` and branches are unchanged, and the clone is gone.
  - **A file left changed** without a commit: refused too.
  - **No `<fact>`:** "Mo finished without an answer.", `unanswered`.
  - **A sandbox that cannot start** (given the Owner's AI Account key in
    place of a Gateway Key): failed, saying why, never with the key. No
    sandbox started.
  - **Cancelled** (the sandbox killed) and **timed out**: each is `failed`
    with its own reason and outcome.
  - **`readFact`:** reads the last answer and cuts a long one.
- `grilling/session.test.ts` (2 new): `recordFacts` numbering facts on at
  the latest round; the turn schema reading `facts` (at most five, an
  optional Agent, never empty).
- `sandbox/environment.test.ts` (1 new): a read-only sandbox's environment
  has no Git identity and names no issue (Claude Code's headers and
  Codex's variables).
- `apps/web/src/manager-chat.test.tsx` (extended): **Read** shows a found
  fact with its answer, and one not found with "Not found:".
- `packages/events/src/schema.test.ts` (extended) and the Activity Feed's
  test: the new event family has an example, a label and a group.

**Negative checks.** Each sabotage was run over `grilling/` and
`sandbox/environment.test.ts`, then reverted with `git checkout`, after
which the tests were green again (85 passed, 4 skipped):

| Sabotage | Failed |
| --- | --- |
| A changed repository goes undetected | 2 tests |
| A turn that names facts is applied at once, nothing looked up | 2 tests |
| The facts found are not kept with the session | 2 tests |
| The session section leaves the facts out | 2 tests |
| A named Agent is never sent: always the Manager | 1 test |
| The read-only sandbox is given a Git identity | 2 tests |

### How Postgres was run here

As for #92–#94:
- **The server:** `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4), unpacked in `/tmp`, outside the repository.
- **The harness patch:** a scratch edit to
  `packages/db/src/testing/postgres.ts` (`SCRATCH_PG_URL`, database names
  unique per test file). It was applied for each run and reverted with
  `git checkout`, never committed.

Every migration applied, `0061_grilling_facts` included.

It caught a real bug, which is fixed (`b87fe50`). In the first run the
fact-finding chat messages had no `replyTo`, which the
`manager_chat_messages_reply_to` check refuses and the memory store does
not. Both Postgres cases failed then, and pass now.

The whole suite against it: 4234 passed, 26 skipped, 1 failed. The failure
is `batches/batches.test.ts` "at the Kickoff, an Agent whose Model cannot
be asked is acknowledged for by AI Office's rules…" in Postgres
(`expected [ { …(6) } ] to have a length of 2 but got 1`). It also fails
at the base commit `e3d7876`, before any of this issue's changes, two runs
out of two. It fails three runs out of three on this branch. It does not
touch anything this issue changed, so it is left alone and noted below.

### Not verifiable in this sandbox

- **Docker and the real agent tools.** No Docker here, so no real
  sandbox image ran:
  - the fact finder ran with the fake bind-mount provider, with a script
    standing in for Claude Code;
  - whether `gh` in the real image reads issues with the read-only token;
  - whether a real agent tool keeps to the `<fact>` form.

  Real Sandcastle runs are verified on the host (PRD §9).
- **A real Model.** The scripted Model writes the turns. These need the
  host with a real AI Account, as CI never calls a live AI Provider:
  - whether a real Manager names facts rather than asking them;
  - whether it delegates sensibly.
- **Testcontainers.** The Postgres tests ran against the embedded Postgres
  18.4 instead. They run in CI.
- **The browser.** The dialog was tested in jsdom, not in Chromium.

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
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm --filter @ai-office/db db:generate`

```text
No schema changes, nothing to migrate 😴
generate exit=0
```

### `pnpm test` (no Docker: the Postgres tests skip)

```text
 Test Files  330 passed (330)
      Tests  3768 passed | 493 skipped (4261)
test exit=0
```

### `pnpm test` against the embedded Postgres 18.4

```text
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
AssertionError: expected [ { …(6) } ] to have a length of 2 but got 1
 Test Files  1 failed | 329 passed (330)
      Tests  1 failed | 4234 passed | 26 skipped (4261)

$ git checkout e3d7876   # the base, before this issue, with the same harness patch
$ SCRATCH_PG_URL=… pnpm exec vitest run packages/orchestrator/src/batches/batches.test.ts   (twice)
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
      Tests  1 failed | 29 passed (30)
      Tests  1 failed | 29 passed (30)
```

### This issue's tests (verbose, against the embedded Postgres 18.4)

```text
✓ … grilling/session.test.ts > recordFacts > numbers facts on across the session, at the latest round asked
✓ … grilling/session.test.ts > recordFacts > reads a turn's facts, at most five, each with an optional Agent
✓ … sandbox/environment.test.ts > a sandbox's environment > holds no Git identity and names no issue for a read-only sandbox finding facts (FR-79)
✓ … grilling/fact-finding.test.ts > the sandbox fact finder > answers from the repository, read in a sandbox with a read-only token and no Git identity, then deletes the clone
✓ … grilling/fact-finding.test.ts > the sandbox fact finder > keeps no answer from a sandbox that changed the repository, and nothing of its changes reaches GitHub
✓ … grilling/fact-finding.test.ts > the sandbox fact finder > keeps no answer from a sandbox that left a file changed without committing it
✓ … grilling/fact-finding.test.ts > the sandbox fact finder > says when the Agent finished without an answer
✓ … grilling/fact-finding.test.ts > the sandbox fact finder > says why when the sandbox could not be started, never with a credential
✓ … grilling/fact-finding.test.ts > the sandbox fact finder > stops when it is cancelled, killing the sandbox
✓ … grilling/fact-finding.test.ts > the sandbox fact finder > kills a sandbox that runs out of time
✓ … grilling/fact-finding.test.ts > readFact > reads the last answer between the tags, cut to fit
✓ … grilling/fact-finding-scenario.test.ts > fact-finding in a Grilling Session, in memory > a factual question is answered from the repository, by the Manager and an Agent it sends, without asking the Owner
✓ … grilling/fact-finding-scenario.test.ts > fact-finding in a Grilling Session, in memory > a fact for an Agent that cannot be sent is found by the Manager, and a turn has facts found at most twice
✓ … grilling/fact-finding-scenario.test.ts > fact-finding in a Grilling Session, in Postgres > a factual question is answered from the repository, by the Manager and an Agent it sends, without asking the Owner
✓ … grilling/fact-finding-scenario.test.ts > fact-finding in a Grilling Session, in Postgres > a fact for an Agent that cannot be sent is found by the Manager, and a turn has facts found at most twice
✓ … events/src/schema.test.ts > officeEventSchema > covers Floor, Agent, issue, Manager decision, Batch, memory, sandbox, Grilling Session fact-finding, branch, pull request, review, QA, design review, Handoff, model call, Notice, cap, AI Account, config, Connection, Skill and sign-in events
 Test Files  9 passed (9)
      Tests  203 passed (203)
```

The 203 are every test in `grilling/`, `sandbox/environment.test.ts`,
`events/src/schema.test.ts`, `manager-chat/routes.test.ts`,
`manager-chat.test.tsx` and `activity-feed.test.tsx`, #94's Grilling
Session scenario in Postgres included.

## Notes

- **What "read-only" means here.** Inside the container the agent tool
  can still write files: agent tools need scratch space, and Sandcastle
  bind-mounts the clone. What makes the sandbox read-only for the Floor:
  - its GitHub token cannot write;
  - it has no Git identity, and nothing is pushed;
  - an answer from a changed repository is refused;
  - the clone is deleted.

  The PRD and ADRs do not disagree with this; ADR 0001 (Gateway Keys only)
  and the read-only token of FR-19 hold.
- **Token Caps** apply as for every model call: the sandbox's calls go
  through the Gateway with the sent Agent's own key (FR-33, FR-42).
- **Outside this issue's scope**, noticed while building it:
  - **Concurrency (FR-22).** Fact-finding sandboxes are not counted
    against the office-wide or per-Floor sandbox limit, which the work
    queue enforces for issue work only. One turn starts at most five at
    once. Whether they should queue behind issue work is a decision for
    the Owner.
  - **The Agent live view.** A fact-finding sandbox's text and tool calls
    are not streamed to the Agent's live view or monitor. Only its start
    and stop are in the Activity Feed: `sandbox.text` and friends require
    an issue, and fact-finding has none. A later event version could make
    `issue` optional.
  - **The Decision Model (FR-17)** does not screen a fact-finding
    sandbox's tool calls. The runner's `toolCallCheck` takes an issue's
    task.
  - **"Answering…" in the chat.** The web app clears a message's pending
    indicator at its first answer. While the facts are found, the chat
    therefore shows the "Before round N, finding…" message rather than
    "Evelyn is answering…".
  - **In 3D (FR-83).** Agents sent to find facts are not yet shown
    leaving their desks; the Manager is not yet in the meeting room.
  - **Fact-finding outside a turn.** It is offered only when a turn is
    written, not for the Model's free-form answers within a session.
  - **A pre-existing Postgres failure.** `batches/batches.test.ts` (the
    Kickoff acknowledgement case, above) fails in Postgres at the base
    commit. It is worth an issue of its own; CI's Testcontainers run
    should show it too.
- **PRD and ADRs.** No disagreement found.
