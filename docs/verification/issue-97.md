# Issue #97: Grilling: draft issues, approve and file — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) in this branch's working tree, after the issue's last
code commit (`6bde11d`). The full Postgres run was made at `e547890`. The
one commit after it only sorts the blockers listed in the chat's message
of filed issues, as the issue bodies already did ("blocked by #2, #3").
This issue's own tests were run against Postgres again at `6bde11d`.

The blocker, #96 ([`issue-96.md`](issue-96.md)), is on this branch. It,
#95 and #94 are extended here, not rebuilt: the session's store, its
"confirm" (which opens the documents' pull request), the chat and the
session dialog.

## What was built

Once a session's documents are proposed, the Manager drafts the GitHub
issues that build it (PRD FR-81, §5 scenario 8). They are vertical
slices, each with:
- "What to build";
- acceptance criteria;
- the drafts it is blocked by;
- the PRD sections and ADRs it cites.

The Owner edits, reorders, merges and drops them, then approves them. The
GitHub App then files them in dependency order, labelled `ai-office`,
each one's "Blocked by" naming the issues filed for the drafts it waits
on. They are then ready to become a Batch. Starting the Batch is left to
the Owner, as the issue says.

### Shared, the database and events

- **`packages/shared/src/grilling-issues.ts`**:
  - `grillingIssueDraftSchema`: `id` (the draft's own number, kept
    through edits), `title`, `whatToBuild`, `acceptanceCriteria` (at least
    one), `blockedBy` (draft ids), `prdSections`, `adrs`, and `filed`
    (`{number, url}` once filed).
  - `grillingIssuesSchema`: the drafts in the Owner's order, `draftedAt`,
    `approvedAt` and `problem` (why filing last stopped).
  - `grillingIssuesTurnSchema`: the Model's draft, with `blockedBy` as
    positions in its list.
  - `grillingIssueDraftsRequestSchema`: the Owner's edited drafts.
  - Plain-code rules that the server, the web app and the orchestrator
    share:
    - `issueFilingOrder`: each draft after those it is blocked by,
      otherwise in the Owner's order; nothing for a cycle.
    - `issueDraftsProblem`: a repeated id, a draft blocked by itself or by
      one not in the list, or a cycle.
    - `mergeIssueDrafts`: in the kept draft's place, both texts, every
      criterion and citation once, everything either was blocked by, and
      drafts blocked by the merged one moved to the kept one.
    - `dropIssueDraft`: those blocked by the dropped draft then wait on
      what it waited on.
    - `moveIssueDraft`.
- **Chat controls** (`readGrillingControl`): "draft the issues of session
  3" and "file the issues of session 3", with variants ("approve the
  issues", "redraft issues for session #2"). Without a number they mean
  the latest ended session. `draftGrillingIssuesText` and
  `fileGrillingIssuesText` are what the web app sends.
- **`grilling_sessions.issues`**: JSONB, nullable (migration
  `0063_grilling_issues`). Sessions kept before it read back with none.
- **Event `grilling.issue_filed`**: Floor, Manager, session, issue,
  title, URL, and the issues it is blocked by. The Activity Feed lists it
  under **Issues** and describes it.
- New error codes: `grilling_issues_not_editable` and
  `grilling_issues_invalid`.

### The orchestrator (`grilling/issues.ts`, `manager/chat.ts`)

- **Drafting.**
  - After "confirm" has opened the documents' pull request and ended the
    session, the same background answer asks the Manager's Model for the
    issues. With the GitHub App set, that is the `issues` option.
  - The prompt holds the session section and "## Draft the issues": it
    asks for vertical slices in build order, and names the outline
    headings and ADR titles they may cite.
  - An answer that is not a draft is sent back once. After that, the chat
    says why and how to ask again.
  - `draftIssues` keeps the answer as drafts numbered 1 on:
    - only earlier issues count as blockers;
    - citations must be the session's own outline headings and ADR
      titles, spelled as the session has them; others are left out;
    - everything is redacted.
  - The chat lists the drafts and says how to approve them.
  - "draft the issues of session N" drafts them again, in place of the
    old drafts, until one is filed.
- **Editing.** `ManagerChat.saveGrillingIssues` keeps the Owner's edited
  list, redacted. It refuses:
  - drafts that cannot be filed (`grilling_issues_invalid`);
  - a session with no drafts, or with one filed already
    (`grilling_issues_not_editable`);
  - any edit while the Manager answers (`reply_in_progress`).
- **Filing.**
  - "file the issues of session N" is checked in plain code first: the
    session must have ended, have drafts, not all filed, and no problem.
  - `createGrillingIssues().file` then:
    - makes sure the `ai-office` label exists;
    - files each unfiled draft in `issueFilingOrder`, labelled
      `ai-office`;
    - writes each body with **Context** (the session and its pull
      request), **What to build**, **Acceptance criteria** (`- [ ]`),
      **Blocked by** (`- #N` for the issues filed for its blockers,
      ascending, or "None: it can start at once."), and **Cites** (the
      PRD's path and sections, each ADR's path and title).
  - Each issue is saved with its draft as soon as it is filed, then
    `grilling.issue_filed` is published. So when GitHub fails partway,
    filing stops with `problem` set, and filing again files only the
    rest.
  - The chat lists the issues, with their blockers and links, and ends
    with the command that makes them a Batch ("complete issues 2 to 4").
- **Ready to become a Batch, without starting one.**
  - Intake leaves the App's issues alone. Their author is the App's bot,
    so `fromOwner` is false, and they are never picked up on their own.
  - `createBatches` gains an `approved` option: the issues the App filed
    on the Owner's approval (`approvedIssues`, read from the Floor's
    sessions). A Batch takes them as the Owner's. Any other issue the App
    opened is still left out.

### The server and the web app

- `apps/server/src/server.ts`:
  - builds the filer when the GitHub App is set and passes it to the
    Manager chat;
  - gives Batches `approved`.
- **`PUT /api/floors/:floorId/grilling-sessions/:sessionId/issues`**
  keeps the edited drafts and answers the session. Errors: `400` for an
  invalid body or `grilling_issues_invalid`, `404`, `409` for
  `grilling_issues_not_editable` or `reply_in_progress`.
- `GET …/grilling-sessions/:id` includes `issues`.
- **The session dialog** (**Read**) has an **Issues** part:
  - Before any issue is filed, each draft has editable fields for its
    title, "What to build", acceptance criteria (one per line) and
    **Blocked by** checkboxes. It shows the citations, and has **Move
    up**/**Move down**, **Drop** and **Merge it into**.
  - Drafts that cannot be filed say why, and **Approve and file** is
    disabled until they can be.
  - **Approve and file N issues** saves any edits, then sends "file the
    issues of session N" in the chat.
  - **Save edits**, **Undo edits** and **Draft again**.
  - Once issues are filed, each is linked, with the problem if filing
    stopped, and **File the rest**.
- The guide documents it under
  [Grilling Sessions](../guide/events-and-chat.md#grilling-sessions).
  [Batches](../guide/batches-and-memory.md) and
  [intake](../guide/issue-pipeline.md) say how these issues are treated.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
  exit 0 at `6bde11d` (output below). Without Docker the Postgres tests
  skip with the reason: 3801 passed, 498 skipped. `db:generate` finds
  nothing more to generate. Two earlier full runs of `pnpm test`, at
  `e547890`, each had one failure, both in 3D scene tests (below), while
  the machine's load average was 43 to 69 on 16 cores. This issue changes
  nothing under `apps/web/src/scene`. The run after them passed, and so
  did the run at `6bde11d`.
- [x] **Scenario test: edited drafts are filed in order with correct
  Blocked by links.**
  `packages/orchestrator/src/grilling/issues-scenario.test.ts` drives the
  Manager chat end to end, in memory and in Postgres 18.4 (all four
  passing, below). Its parts:
  - a Floor added from the fake GitHub;
  - the real documents writer, pushing with real Git to a local bare
    remote;
  - the real `createGrillingIssues`, filing on the fake GitHub;
  - a scripted Model.

  The first case, step by step:
  - **The session ends.** One turn settles the outline ("Problem",
    "Requirements") and an ADR. "confirm" opens pull request #1, then the
    Model drafts five issues.
  - **The draft.**
    - The chat lists them, numbered, with their blockers ("2. Build the
      CSV (blocked by 1)"). The full text is checked.
    - The prompt said what may be cited.
    - In the kept drafts:
      - the self-reference and the later blocker ("blocked by 4, 5") are
        gone;
      - "requirements" is spelled "Requirements";
      - "Pricing" and the ADR "Use Kafka" are left out;
      - a credential is `[REDACTED]`.
    - Nothing is on GitHub yet.
  - **The Owner's edits.**
    - Making the button blocked by "Name the columns" is a cycle, and is
      refused (`grilling_issues_invalid`).
    - The button's title and criteria are edited.
    - "Name the columns" is merged into "Build the CSV".
    - "Schedule exports" is dropped.
    - "Email the export" is moved to the top and also blocked by the
      button.
    - The saved order is checked: `[4, 1, 2]`.
  - **"file the issues of session 1".**
    - GitHub has exactly three issues, #2, #3 and #4, in dependency
      order, not the list's: the button, then the CSV, then the email,
      which was first in the list. Each is labelled `ai-office`, opened
      by the App and open.
    - The bodies of #2 and #3 are checked in full. #3 has "Blocked by
      - #2", both texts of the merge, every criterion once, and Cites
      with the PRD's and the ADR's paths.
    - #4 has "Blocked by - #2 - #3".
    - No body holds the credential, and the dropped draft was never
      filed.
    - The chat's reply is checked in full, ending: say "complete issues 2
      to 4".
    - Three `grilling.issue_filed` events, in order, with their blockers.
    - The session records each issue against its draft, and `approvedAt`.
  - **Ready to become a Batch.** `fromOwner` is false for each, so intake
    leaves them alone. `approvedIssues` holds 2, 3 and 4.
  - **Filed once.** "file the issues…" again is a hint naming them, and
    saving edits is refused. Still three issues.

  The second case covers failures:
  - **A bad draft.** The Model answers twice with no issues. The chat
    says why and how to ask again, and nothing is kept. Filing is refused
    with how to draft them. "draft the issues" then drafts three.
  - **GitHub fails after one issue.** The reply is an error naming #2 and
    why the rest were not filed (checked in full). The session keeps #2
    against its draft and the problem. Drafting again is refused.
  - **"file the issues of session 1" again** files only the other two,
    #3 blocked by #2 and #4 blocked by #3: three issues in all, none
    filed twice. The problem clears.

Also:

- `packages/shared/src/grilling-issues.test.ts` (7 tests): the filing
  order and cycles; every problem `issueDraftsProblem` names; the
  request schema refusing an empty list, a blank title or no criteria;
  merging (including into a draft blocked by the merged one), dropping and
  moving.
- `packages/shared/src/grilling.test.ts` (1 new): the drafting and
  filing controls, and "file the issues about the basket" left as a
  message.
- `grilling/issues.test.ts` (5 tests):
  - the prompt;
  - `draftIssues` (blockers, citations, case);
  - the Batch command for contiguous, scattered and single numbers;
  - a body with nothing to cite and no pull request;
  - the filer: dependency order, a save after each issue, the label
    made, events with blockers, and a cycle refused.
- `batches/batches.test.ts` (1 new, in memory and in Postgres):
  - The App files two issues. Intake ignores both.
  - "complete issues 1 to 2" takes the one the Owner approved (#1) into
    the Batch, and leaves the other (#2) out ("someone else opened
    it…").
- `apps/server/src/manager-chat/routes.test.ts` (1 new): the `PUT` route:
  - `409` before the drafts exist;
  - an edited, reordered list kept;
  - `400` for a cycle, an unknown blocker, no criteria, or no drafts;
  - `404` for no session, `401` signed out.
- `apps/web/src/manager-chat.test.tsx` (2 new):
  - The editor: a cycle disables approval and says why. Then a title and
    a criterion are edited, one draft merged, one dropped and one moved.
    **Approve and file 2 issues** sends the edited drafts with the CSRF
    token, then "file the issues of session 1".
  - Filed issues are linked, with the problem, and **File the rest**.
- `packages/events/src/schema.test.ts` (extended) and the Activity
  Feed's test: the new event has an example, a label and a group.

**Negative checks.** Each sabotage was made with a script, run against
the shared and orchestrator tests above (the scenario, `issues.test.ts`,
`grilling-issues.test.ts` and `batches.test.ts`), then reverted with
`git checkout`. After that the same run was green again: 30 passed, 18
skipped.

| Sabotage | Failed |
| --- | --- |
| Filed in the Owner's order, not dependency order | 5 tests |
| Blocked by never names the issues filed | 3 tests |
| Issues filed without the `ai-office` label | 1 test |
| The Owner's edits are not kept | 1 test |
| Filing again files the issues already filed | 1 test |
| A Batch ignores the issues the Owner approved | 1 test |
| Merging leaves drafts blocked by the merged draft | 1 test |
| The Model's draft is kept with later blockers | 2 tests |

### How Postgres was run here

As for #92–#96:
- **The server:** `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4), unpacked in `/tmp`, outside the repository.
- **The harness patch:** a scratch edit to
  `packages/db/src/testing/postgres.ts` (`SCRATCH_PG_URL`, database names
  unique per test file). It was applied for these runs and reverted with
  `git checkout`, never committed.

Every migration applied, `0063_grilling_issues` included.

The whole suite against it: 4272 passed, 26 skipped, 1 failed. The
failure is **`batches/batches.test.ts`**, "at the Kickoff, an Agent whose
Model cannot be asked…", in Postgres. #95 and #96 recorded the same
failure. It fails at #96's last commit `f872bd8`, before any of this
issue's changes, with the same harness patch (below).

### Not verifiable in this sandbox

- **The real GitHub.** No GitHub access here. Filing issues, the label
  and the issue bodies as GitHub renders them were checked against the
  fake GitHub. It is verified on the host.
- **A real Model.** The scripted Model writes the drafts. These need the
  host with a real AI Account, as CI never calls a live AI Provider:
  - whether a real Manager's drafts are good vertical slices;
  - whether its acceptance criteria are testable.
- **Testcontainers.** The Postgres tests ran against the embedded
  Postgres 18.4 instead. They run in CI.
- **The browser.** The draft editor was tested in jsdom, not in Chromium.

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
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm --filter @ai-office/db db:generate`

```text
No schema changes, nothing to migrate 😴
```

### `pnpm test` (no Docker: the Postgres tests skip)

```text
 Test Files  335 passed (335)
      Tests  3801 passed | 498 skipped (4299)
test exit=0
```

Two earlier runs at `e547890`, each with one 3D scene test failing
while the machine was loaded (load average 43 to 69 on 16 cores):

```text
 FAIL  |@ai-office/web| src/scene/meeting-room.test.tsx > meetings on a Floor > a Kickoff over at once still gathers them for a moment; a Wrap-up gathers them for a while by itself
AssertionError: expected 0.5000000000000004 to be less than 0.000001
      Tests  1 failed | 3800 passed | 498 skipped (4299)

 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 10 Agents' Floor clear of furniture and walls
Error: Test timed out in 5000ms.
      Tests  1 failed | 3800 passed | 498 skipped (4299)

$ pnpm exec vitest run apps/web/src/scene/meeting-room.test.tsx   (five times)
      Tests  5 passed (5)
      Tests  5 passed (5)
      Tests  5 passed (5)
      Tests  5 passed (5)
      Tests  5 passed (5)
```

### `pnpm test` against the embedded Postgres 18.4 (at `e547890`)

```text
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
AssertionError: expected [ { …(6) } ] to have a length of 2 but got 1
 Test Files  1 failed | 334 passed (335)
      Tests  1 failed | 4272 passed | 26 skipped (4299)

$ git switch --detach f872bd8   # before this issue, with the same harness patch
$ SCRATCH_PG_URL=… pnpm exec vitest run packages/orchestrator/src/batches/batches.test.ts
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
      Tests  1 failed | 29 passed (30)
```

### This issue's tests (verbose, against the embedded Postgres 18.4, at `e547890`)

```text
 ✓ |@ai-office/shared| src/grilling-issues.test.ts > issueFilingOrder > files each draft after those it is blocked by, otherwise in the Owner's order
 ✓ |@ai-office/shared| src/grilling-issues.test.ts > issueFilingOrder > answers nothing for drafts blocked by each other in a cycle
 ✓ |@ai-office/shared| src/grilling-issues.test.ts > issueDraftsProblem > says why drafts cannot be filed
 ✓ |@ai-office/shared| src/grilling-issues.test.ts > issueDraftsProblem > is checked on what the Owner sends, with every issue's parts
 ✓ |@ai-office/shared| src/grilling-issues.test.ts > editing the drafts > drops a draft, those blocked by it then waiting on what it waited on
 ✓ |@ai-office/shared| src/grilling-issues.test.ts > editing the drafts > merges one draft into another, in the other's place
 ✓ |@ai-office/shared| src/grilling-issues.test.ts > editing the drafts > moves a draft up and down, within the list
 ✓ |@ai-office/shared| src/grilling.test.ts > readGrillingControl > reads drafting and filing an ended session's issues
 ✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > covers Floor, Agent, issue, Manager decision, Batch, memory, sandbox, Grilling Session fact-finding, documents and issues, branch, pull request, review, QA, design review, Handoff, model call, Notice, cap, AI Account, config, Connection, Skill and sign-in events
 ✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > parses a grilling.issue_filed event
 ✓ |@ai-office/orchestrator| src/grilling/issues.test.ts > drafting the issues > asks for vertical slices, saying what the session lets them cite
 ✓ |@ai-office/orchestrator| src/grilling/issues.test.ts > drafting the issues > keeps the draft: earlier blockers only, and only the session's own citations
 ✓ |@ai-office/orchestrator| src/grilling/issues.test.ts > drafting the issues > writes the Batch command for the issues filed
 ✓ |@ai-office/orchestrator| src/grilling/issues.test.ts > filing the issues > writes each body without documents to cite
 ✓ |@ai-office/orchestrator| src/grilling/issues.test.ts > filing the issues > files the drafts in dependency order, records each as it goes, and refuses drafts in a cycle
 ✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > an issue the GitHub App filed as the Owner approved it in a Grilling Session goes into a Batch; one of the App's the Owner did not approve does not
 ✓ |@ai-office/orchestrator| src/grilling/issues-scenario.test.ts > a Grilling Session's issues, in memory > the Manager drafts the issues once the documents are proposed, and the Owner's edited drafts are filed in dependency order with the right Blocked by links
 ✓ |@ai-office/orchestrator| src/grilling/issues-scenario.test.ts > a Grilling Session's issues, in memory > a draft the Model cannot write is asked for again, and filing that stops partway files only the rest the next time
 ✓ |@ai-office/server| src/manager-chat/routes.test.ts > Grilling Sessions > keeps the Owner's edits to an ended session's draft issues, refusing drafts that cannot be filed
 ✓ |@ai-office/web| src/manager-chat.test.tsx > Grilling Sessions in the Manager chat > edits, reorders, merges and drops an ended session's draft issues, then approves them to be filed
 ✓ |@ai-office/web| src/manager-chat.test.tsx > Grilling Sessions in the Manager chat > links an ended session's filed issues, and files the rest after a failure
 ✓ |@ai-office/orchestrator| src/grilling/issues-scenario.test.ts > a Grilling Session's issues, in Postgres > the Manager drafts the issues once the documents are proposed, and the Owner's edited drafts are filed in dependency order with the right Blocked by links
 ✓ |@ai-office/orchestrator| src/grilling/issues-scenario.test.ts > a Grilling Session's issues, in Postgres > a draft the Model cannot write is asked for again, and filing that stops partway files only the rest the next time
 ✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > an issue the GitHub App filed as the Owner approved it in a Grilling Session goes into a Batch; one of the App's the Owner did not approve does not
```

That run covered every test in these files: 216 passed, and 1 failed,
the Kickoff test above:
- `grilling/` (#94's, #95's and #96's scenarios in Postgres included) and
  `batches/batches.test.ts`;
- the shared grilling tests and `events/src/schema.test.ts`;
- `manager-chat/routes.test.ts`;
- `manager-chat.test.tsx`, `whiteboard.test.tsx` and
  `activity-feed.test.tsx`.

Again at `6bde11d`, `grilling/issues.test.ts` and the scenario:

```text
 ✓ |@ai-office/orchestrator| src/grilling/issues-scenario.test.ts > a Grilling Session's issues, in Postgres > the Manager drafts the issues once the documents are proposed, and the Owner's edited drafts are filed in dependency order with the right Blocked by links
 ✓ |@ai-office/orchestrator| src/grilling/issues-scenario.test.ts > a Grilling Session's issues, in Postgres > a draft the Model cannot write is asked for again, and filing that stops partway files only the rest the next time
      Tests  9 passed (9)
```

## Notes

- **Plain code files; the Model writes the words.** The Model gives the
  drafts as structured data. AI Office keeps them and writes each body
  from them. It also decides the filing order, the "Blocked by" numbers
  and what may be cited. Approval is the Owner's chat message, "file the
  issues of session N", sent by **Approve and file**. So it sits in the
  session's history like "confirm", and the Manager answers it like any
  other message (the chat's messages each answer one of the Owner's).
- **"In dependency order".** This is read as: each issue is filed after
  every issue it is blocked by, so its "Blocked by" can name real issue
  numbers. Otherwise the Owner's order is kept. Drafts blocked by each
  other in a cycle can never be filed, so they cannot be saved or
  approved.
- **"Ready to become a Batch" and PRD §4.** PRD §4 says "An issue by
  another author is never picked up unless the Owner applies the
  `ai-office` label personally". The App is the author of these issues,
  so they are read this way:
  - **Intake** still ignores them (author: the App's bot). Nothing starts
    on its own, which is also this issue's "Out of scope".
  - **A Batch** takes them as the Owner's, because the Owner approved
    their exact text before the App filed them.

  The exception is narrow: only issue numbers recorded against a
  session's approved drafts on the same Floor. No other issue the App
  opens counts (tested). The Owner may want this reading confirmed, or
  §4 to name the exception. It is flagged here rather than the PRD being
  changed.
- **PRD and ADRs.**
  - ADR 0002: the GitHub App files the issues.
  - ADR 0001: the one new model call (the draft) goes through the
    Manager's own model client, like its turns.
  - ADR 0003: does not apply.

  Apart from the §4 reading above, no disagreement found.
- **Outside this issue's scope**, noticed while building it:
  - **Adding a draft by hand.** The editor edits, reorders, merges and
    drops, as the issue says. A new draft comes only from **Draft
    again**.
  - **Editing citations.** The PRD sections and ADRs a draft cites are
    shown and kept through merges, but not edited in the editor.
  - **GitHub's own issue dependencies.** "Blocked by" is written as
    `- #N` links in the body, the form the Floor's issues use. GitHub's
    issue-dependency API is not used.
  - **Batch plans and "Blocked by".** A Batch's Plan reads the bodies
    through the Manager's Model. AI Office's rules-only Plan (when the
    Model cannot be asked) does not parse "Blocked by" from the bodies.
  - **A crash mid-filing.** Each issue is saved as soon as GitHub answers.
    A crash between GitHub's answer and that save would file that one
    issue again on the next try. Nothing is published or recorded for it
    in the meantime.
  - **No GitHub App.** Without it, ending a session drafts no issues,
    since nothing could file them, and "draft the issues…" says so.
  - **A Notice for filed issues.** None is raised. The Owner is in the
    chat when approving, and each issue is in the Activity Feed.
  - **In 3D (FR-83).** The meeting room's whiteboard does not show the
    drafts. That is FR-83's own work.
