# Issue #96: Grilling: live documents and the closing pull request — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) in this branch's working tree, after the issue's last
code commit (`0f03915`).

The blocker, #95 ([`issue-95.md`](issue-95.md)), is on this branch. It
and #94 ([`issue-94.md`](issue-94.md)) are extended here, not rebuilt:
the session's turns, store, prompt section, chat and dialog. The GitHub App
commit path is memory curation's (#53's `commitFile`), generalised.

## What was built

As decisions settle, the Manager keeps the Floor's documents current on a
branch of the session's own, and when the session ends the GitHub App
opens one pull request with all of them (PRD FR-80). The whiteboard shows
the live outline and the decisions settled so far.

### Shared, the database and events

- **`grillingTurnSchema`** (`packages/shared/src/grilling.ts`) gains:
  - `outline`: sections of the PRD, `{heading, text}`;
  - `adrs`: `{title, decision, options, consequences, hardToReverse,
    surprising, tradeOff}`;
  - `processes`: `{title, text}`.

  Each defaults to empty. The three reasons an ADR gives may be left
  empty, but then plain code leaves the ADR out (below), rather than
  refusing the whole turn.
- **The session** keeps `outline`, `adrs`, `processes` and `documents`:
  the branch, the files and commit last written, when, the pull request,
  and why the last write failed (`grillingDocumentsSchema`, null until
  first written).
- **Paths:** `grillingBranch(id)` is `ai-office/grilling-<id>`.
  `grillingPrdDirectory`, `grillingAdrDirectory`, `grillingGlossaryPath`
  and `grillingProcessDirectory` are the PRD's paths, as FR-80 names them.
- **`grilling_sessions`:** `outline`, `adrs` and `processes` are JSONB
  `NOT NULL DEFAULT '[]'`, and `documents` is JSONB, nullable (migration
  `0062_grilling_documents`). Sessions kept before it read back with none.
- **Events:** `grilling.documents_written` (Floor, Manager, session,
  branch, commit, how many files changed) and
  `grilling.pull_request_opened` (Floor, Manager, session, branch, pull
  request, URL). Neither holds document text. The Activity Feed lists them
  under **Pull requests** and describes them.

### The rules (`grilling/session.ts`)

`applyTurn` also merges the documents' parts. A section, ADR or process doc
replaces the one of the same heading or title (case aside) in place, and
the rest are added last. An ADR is kept only if `hardToReverse`,
`surprising` and `tradeOff` are all non-blank (`adrWarranted`). The ones
left out are named in `leftOut`.

### The documents (`grilling/documents.ts`)

Plain code writes each file from the stored session:

- **The PRD:** `docs/product-requirements-document/<topic>.md`. It has a
  title, a Draft status, a glossary link, the outline section by section,
  then "Decisions" with every settled decision word for word. If the Floor
  already has a PRD of that name on its default branch, the session writes
  `<topic>-grilling-<id>.md` beside it rather than replace it.
- **The glossary:** `GLOSSARY.md`, read from the branch the commit builds
  on. Each term settled replaces the entry of its name (its `**Term**:`
  line to the next blank line, case aside), or is added at the end, under
  a `## <topic>` heading written once. Without a glossary, a new one. The
  repository's `**Term**:` / definition / `_Avoid_:` form is kept.
- **ADRs:** `docs/architectural-decision-record/NNNN-<title>.md`, written
  as the Floor's ADRs are (the decision, **Considered Options**,
  **Consequences**). They are numbered on from the directory's highest.
  A file the session wrote keeps its number, and one of the Floor's own
  ADRs is never rewritten, even one with the same title (`0f03915`).
- **Process docs:** `docs/processes/<title>.md`.

`createGrillingDocuments({ github, events, notices, gitIdentity,
scratchDir, pushUrl })` gives `write` and `propose`:

- **`write`:**
  1. It builds on the session's branch once it has been written, and on
     the default branch before that.
  2. It commits with `commitFiles` (`git/commit-file.ts`, generalised from
     `commitFile`): a fresh bare repository, the files put into the
     fetched tree, one commit as the Floor's Git identity with the
     Manager's `Agent:` trailer (ADR 0002), pushed with the App's
     installation token.
  3. If nothing changed, nothing is committed or pushed, and no event is
     published.
  4. It **never rejects**: a failure is answered with the documents as
     they were and `problem` saying why.
- **`propose`:**
  1. It writes a last time.
  2. It opens the pull request from the branch into the default branch,
     or answers the one already open from it, never a second.
  3. A new pull request is recorded with `grilling.pull_request_opened`
     and an info Notice.
  4. Its body lists the files, the decisions, the terms and why each ADR
     is one, and says merging is the Owner's.
  5. It rejects on failure.

### The chat (`manager/chat.ts`, `grilling/prompt.ts`, `grilling/skill.ts`)

- **After every turn kept,** the documents are written at once, before
  the round's message is kept. That message's preamble says what was
  updated ("Updated on ai-office/grilling-1: GLOSSARY.md and …"), why the
  documents could not be written if they could not, and each ADR left out.
- **"confirm"** with the documents' writer is answered in the background
  (`close`). The session ends only once the pull request is open, and the
  message links it. If it cannot be opened, the session stays open and
  awaiting confirmation, `documents.problem` says why, and the chat says
  "reply "confirm" to try again". Without a writer (`app.ts`, or no GitHub
  App), "confirm" ends the session as before.
- **The session section** gains "The documents": the branch, the PRD's
  outline word for word, and the ADRs and process docs by title. The turn
  instructions describe `outline`, `adrs` (only for decisions hard to
  reverse, surprising and a real trade-off, saying why for each) and
  `processes`. The built-in Skill gains "## Documents".
- **Redacted:** every part of a turn's documents is redacted before it is
  kept, so nothing committed or put in the pull request holds a
  credential.

### The server and the web app

- `apps/server/src/server.ts` builds the writer when the GitHub App is set
  (scratch in `SANDBOX_WORK_DIR`, Notices, the Floor's Git identity) and
  passes it to the Manager chat. `GET …/grilling-sessions/:id` includes
  `outline`, `adrs`, `processes` and `documents`.
- **The whiteboard** (`Whiteboard`, on its page and in the 3D meeting
  room's panel) shows the running session above the Plans: its title, **The
  outline**, **Decisions settled so far** and **The documents** (the
  branch and files, the pull request, any problem). It refetches on
  `grilling.documents_written` and `grilling.pull_request_opened`.
- **The session dialog** (**Read**) shows the documents: where they are
  kept, the pull request's link, the outline, the ADRs and the process
  docs.
- The guide documents it under
  [Grilling Sessions](../guide/events-and-chat.md#grilling-sessions) and
  [the whiteboard](../guide/batches-and-memory.md#the-whiteboard-approving-editing-and-replanning-a-plan).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
  exit 0 (output below). Without Docker the Postgres tests skip with the
  reason: 3781 passed, 495 skipped. `db:generate` finds nothing more to
  generate.
- [x] **Scenario test: settled terms reach the glossary immediately; one
  pull request at the end.**
  `packages/orchestrator/src/grilling/documents-scenario.test.ts` drives
  the Manager chat end to end, in memory and in Postgres 18.4 (all four
  passing, below). Its parts:
  - a Floor added from the fake GitHub;
  - the real `createGrillingDocuments`, pushing with real Git to a local
    bare repository standing in for GitHub's remote. The remote is seeded
    with a `GLOSSARY.md` holding "Order" and "Basket", and ADR `0001`;
  - `gitBackedGitHub`, so the fake GitHub sees what is pushed (it now also
    catches up before `listDirectory`);
  - a scripted Model writing three JSON turns.

  The first case, step by step:
  - **Round 1.** `/grilling CSV export for orders`. The turn writes the
    outline's "Problem". The PRD is on `ai-office/grilling-1` (checked
    line by line), and the glossary is untouched since no term is settled.
    The message says "Updated on ai-office/grilling-1: <PRD>.". No pull
    request exists.
  - **Round 2: the glossary at once.** "recommended to all". The turn
    settles the term "Export", with a credential in its definition. As
    soon as the round's reply is kept, the remote's branch has it under
    `## CSV export for orders`, redacted, with `_Avoid_: dump, report`. The
    whole file is checked. The session is still **active** and **no pull
    request** exists. The PRD has both sections and both decisions word for
    word.
  - **The commits.** There is one per turn on top of `main`. Author and
    committer are the Owner (`adrianeyre <21265837+…>`), with the
    trailer `Agent: Noam (manager, Claude claude-opus-5-5)`. The Model's
    next prompt holds "### The documents" and the outline word for word.
  - **Round 3: more documents, and an ADR left out.**
    - "Order" is defined again and replaced in place, above "Basket".
    - ADR `0002-exports-are-built-while-the-owner-waits.md` is written in
      the ADRs' form.
    - `docs/processes/running-an-export.md` is written.
    - An ADR without its three reasons is left out, and the message says
      so. Its full text is checked.
    - Still no pull request. Three `grilling.documents_written` events
      have been published.
  - **"confirm": one pull request.**
    - Exactly one pull request exists, open or closed:
      `docs: Grilling Session 1 on CSV export for orders`, from
      `ai-office/grilling-1` into `main`.
    - Its files are the PRD, `GLOSSARY.md`, the ADR and the process doc.
      Its body gives the ADR's reasons and never the credential.
    - The reply links it and ends the session. The session's `documents`
      name the branch, the files and the pull request.
    - One `grilling.pull_request_opened` event and one info Notice record
      it.
    - `main` is unchanged on the remote, and no file holds the
      credential.

  The second case covers GitHub failing:
  - The first write fails (the installation token is refused). Round 1 is
    still asked, and its message says the documents could not be written
    and why. `documents.problem` is kept, and no branch exists.
  - The next turn writes everything settled so far, and the problem
    clears.
  - Opening the pull request fails. The reply is an error, the session
    stays **active** and awaiting confirmation with the problem kept, and
    no pull request exists.
  - "confirm" again opens it, exactly one, and the session ends.

Also:

- `grilling/documents.test.ts` (6 tests):
  - names from titles, accents folded (this caught a real bug: combining
    accents were kept);
  - the glossary merged in place, under one heading, created when there
    is none, and with a `$&` in a definition left as written;
  - ADR numbering: on from the highest, a file the session wrote keeping
    its number, and the Floor's own ADR of the same title never reused;
  - the PRD's text;
  - the writer leaving the Floor's own PRD be, committing nothing (and
    publishing nothing) when nothing changed, and building on its last
    commit;
  - `propose` answering the open pull request rather than opening a
    second.
- `grilling/session.test.ts` (2 new): the documents' parts merged in place
  by heading or title, and ADRs without all three reasons left out.
- `apps/web/src/whiteboard.test.tsx` (1 new): the running session's
  outline (as headings), decisions and branch above the Plans. A
  `grilling.documents_written` event brings in a new decision and a
  rewritten section.
- `apps/web/src/manager-chat.test.tsx` (extended): **Read** shows where the
  documents are kept, the pull request's link, the outline, the ADR and
  the process doc.
- `packages/events/src/schema.test.ts` (extended) and the Activity Feed's
  test: the new events have examples, labels and a group.
- `memory/curation.test.ts` and `git/` still pass on the generalised
  `commitFiles`, which `commitFile` now calls.

**Negative checks.** Each sabotage was run over `grilling/`, then reverted
with `git checkout`, after which the tests were green again (30 passed, 6
skipped):

| Sabotage | Failed |
| --- | --- |
| Terms are never written into the glossary | 3 tests |
| Turns never write the documents (only "confirm" does) | 2 tests |
| `propose` ignores an open pull request and opens another | 1 test |
| ADRs are kept without their three reasons | 2 tests |
| "confirm" ends the session without opening the pull request | 2 tests |
| A commit is made even when nothing changed | 1 test |

### How Postgres was run here

As for #92–#95:
- **The server:** `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4), unpacked in `/tmp`, outside the repository.
- **The harness patch:** a scratch edit to
  `packages/db/src/testing/postgres.ts` (`SCRATCH_PG_URL`, database names
  unique per test file). It was applied for each run and reverted with
  `git checkout`, never committed.

Every migration applied, `0062_grilling_documents` included.

The whole suite against it: 4248 passed, 26 skipped, 2 failed. Neither
failure touches anything this issue changed:
- **`batches/batches.test.ts`**, "at the Kickoff, an Agent whose Model
  cannot be asked…", in Postgres. This is the failure #95 recorded. It
  fails at the base commit `5bc1a95`, before any of this issue's changes,
  two runs out of two, and three out of three here.
- **`work/queue.test.ts`**, "two coders share four issues…", in Postgres.
  It is the work queue's timing under the full suite's load, like the one
  #94 recorded. Run on its own against the same Postgres, it passed three
  times out of three.

### Not verifiable in this sandbox

- **The real GitHub.** No GitHub access here. Pushing over HTTPS with a
  real installation token, and GitHub opening the pull request and listing
  its files, were checked against the fake GitHub and a local bare remote.
  The push path is memory curation's, which is verified the same way. It
  is verified on the host.
- **A real Model.** The scripted Model writes the turns. These need the
  host with a real AI Account, as CI never calls a live AI Provider:
  - whether a real Manager keeps an outline worth reading;
  - whether it writes ADRs only when warranted, beyond the three reasons
    plain code requires.
- **Testcontainers.** The Postgres tests ran against the embedded Postgres
  18.4 instead. They run in CI.
- **The browser and the 3D scene.** The whiteboard and dialog were tested
  in jsdom, not in Chromium. The meeting room opens the same `Whiteboard`
  panel, but that was not drawn here.

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
 Test Files  332 passed (332)
      Tests  3781 passed | 495 skipped (4276)
test exit=0
```

### `pnpm test` against the embedded Postgres 18.4

```text
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
AssertionError: expected [ { …(6) } ] to have a length of 2 but got 1
 FAIL  |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > two coders share four issues, the next going to whichever coder is free
AssertionError: expected [ 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
 Test Files  2 failed | 330 passed (332)
      Tests  2 failed | 4248 passed | 26 skipped (4276)

$ SCRATCH_PG_URL=… pnpm exec vitest run packages/orchestrator/src/work/queue.test.ts packages/orchestrator/src/batches/batches.test.ts   (three times)
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, …
      Tests  1 failed | 69 passed (70)
      Tests  1 failed | 69 passed (70)
      Tests  1 failed | 69 passed (70)

$ git switch --detach 5bc1a95   # the base, before this issue, with the same harness patch
$ SCRATCH_PG_URL=… pnpm exec vitest run packages/orchestrator/src/batches/batches.test.ts   (twice)
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, …
      Tests  1 failed | 29 passed (30)
      Tests  1 failed | 29 passed (30)
```

### This issue's tests (verbose, against the embedded Postgres 18.4)

```text
✓ … src/grilling/session.test.ts > applyTurn and the documents > replaces outline sections, ADRs and process docs of the same heading or title in place, and adds the rest
✓ … src/grilling/session.test.ts > applyTurn and the documents > leaves out an ADR that does not say why it is hard to reverse, surprising and a real trade-off
✓ … src/schema.test.ts > officeEventSchema > covers Floor, Agent, issue, Manager decision, Batch, memory, sandbox, Grilling Session fact-finding and documents, branch, pull request, review, QA, design review, Handoff, model call, Notice, cap, AI Account, config, Connection, Skill and sign-in events
✓ … src/schema.test.ts > officeEventSchema > parses a grilling.documents_written event
✓ … src/grilling/documents.test.ts > the documents' files > names files from their titles
✓ … src/grilling/documents.test.ts > the documents' files > writes a session's terms into the glossary: in place of an entry of the name, or under the session's heading
✓ … src/grilling/documents.test.ts > the documents' files > numbers new ADRs on from the directory's highest, keeps the number of one the session wrote, and never rewrites one of the Floor's own
✓ … src/grilling/documents.test.ts > the documents' files > writes the PRD from the outline, then the decisions word for word
✓ … src/grilling/documents.test.ts > the documents' writer > leaves the Floor's own PRD be, commits only what changed, and builds on the session's branch
✓ … src/grilling/documents.test.ts > the documents' writer > opens one pull request, and answers the one already open from the branch
✓ … src/grilling/documents-scenario.test.ts > a Grilling Session's live documents, in memory > settled terms reach the glossary as soon as their turn is kept, the documents grow on one branch, and one pull request opens when the session ends
✓ … src/grilling/documents-scenario.test.ts > a Grilling Session's live documents, in memory > when GitHub fails, the round is still asked and the documents are written next time; the session ends only once its one pull request is open
✓ … src/whiteboard.test.tsx > the whiteboard > shows the running Grilling Session's live outline and the decisions settled so far, and follows its documents as they are written
✓ … src/manager-chat.test.tsx > Grilling Sessions in the Manager chat > pauses the running session, resumes a paused one, and reads one in full, with the facts found and its documents
✓ … src/grilling/documents-scenario.test.ts > a Grilling Session's live documents, in Postgres > settled terms reach the glossary as soon as their turn is kept, the documents grow on one branch, and one pull request opens when the session ends
✓ … src/grilling/documents-scenario.test.ts > a Grilling Session's live documents, in Postgres > when GitHub fails, the round is still asked and the documents are written next time; the session ends only once its one pull request is open
 Test Files  14 passed (14)
      Tests  190 passed (190)
```

The 190 are every test in:
- `grilling/` (#94's and #95's scenarios in Postgres included), `git/` and
  `memory/curation.test.ts`;
- `events/src/schema.test.ts` and `manager-chat/routes.test.ts`;
- `manager-chat.test.tsx`, `whiteboard.test.tsx` and
  `activity-feed.test.tsx`.

## Notes

- **Plain code writes the files; the Model writes the words.** The Model
  gives the outline's sections, the ADRs and the process docs as
  structured parts. AI Office writes every file from the stored session,
  so writing again changes nothing unless the session did. Merging terms
  into the glossary and numbering ADRs are deterministic and tested. A
  commit is made only when a file changed.
- **When the documents are written.** Turns are where decisions and terms
  settle (#94 settles every answer as a decision when the next turn is
  applied). So the documents are written after every turn kept, before
  its round is shown. Answering part of a round writes nothing, because
  nothing settles until the round is complete.
- **"Offered only for…" (FR-80).** An ADR has to say why it is hard to
  reverse, why it is surprising, and what it traded off. One that does not
  is left out, and the chat says so. The reasons go in the pull request's
  body for the Owner, who decides by merging. That is how "offered" is
  read here.
- **Ending waits for the pull request.** "confirm" ends the session only
  once its one pull request is open, so a session never ends with its
  documents unproposed. A failure keeps it open for another "confirm". A
  pull request already open from the branch is used rather than opening a
  second. The Manager never merges.
- **PRD and ADRs.**
  - ADR 0002: the GitHub App pushes and opens the pull request, and the
    commits are the Owner's with the Manager's `Agent:` trailer.
  - ADR 0001: no new model calls are made.
  - ADR 0003: does not apply.

  No disagreement found.
- **Outside this issue's scope**, noticed while building it:
  - **The Floor's existing PRD is not edited.** A session writes a PRD of
    its own, named for its topic, beside any PRD the Floor has. Merging a
    feature into a long existing PRD, section by section, would need the
    Model to rewrite parts of a file it has not read. Whether a session
    should instead update the product's PRD is a decision for the Owner.
  - **A process doc of an existing name is replaced whole,** for the Owner
    to review in the pull request. The Model knows such a doc only if it
    found it as a fact (#95).
  - **The glossary may conflict.** If the default branch's `GLOSSARY.md`
    changes while a session runs, the pull request may conflict there.
    Nothing rebases the session's branch.
  - **The whiteboard's liveness without the GitHub App.** It refetches on
    the documents' events, which need the App. Without it, the whiteboard
    is brought up to date only when the session's query is refreshed: the
    Manager chat refreshes it on each of the session's messages.
  - **In 3D (FR-83).** The whiteboard panel shows the outline and
    decisions, but the meeting room does not yet show the Manager sitting
    there, the current round's questions or "in session". That is FR-83's
    own work.
  - **After the session ends,** nothing more is written to its branch.
    Changes asked for in review are the Owner's to make on the pull
    request.
  - **Issues (#97, FR-81)** are out of scope here, as the issue says.
