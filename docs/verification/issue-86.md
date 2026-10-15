# Issue #86: Mid-Batch changes and sequencing overlapping work — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, git
2.39.5, no Docker) against a fresh `git clone` of this branch at `3201c96`
(every commit of the issue but this note), after `pnpm install
--frozen-lockfile`. The sabotage runs and the repeat runs were made in the
working tree, holding the same code. This builds on #84 (Plan approval,
editing and replanning on the whiteboard, earlier on this branch,
[`issue-84.md`](issue-84.md)) and #83 (a Batch command drafts a Plan,
[`issue-83.md`](issue-83.md)).

## What was built

### Rebasing onto merged work before review (FR-25.5; `packages/orchestrator` `git/publish.ts`, `git/push-run.ts`, `coder/coder.ts`, `review/handoff.ts`)

- **`publishBranch`** takes `rebaseOnto` (the default branch). After each
  new commit is made again as the Owner (as before), it fetches the
  default branch from GitHub and, if that is not already under the
  branch, replays the branch's commits since the two parted onto it with
  `git rebase --onto`, in a worktree of AI Office's own fresh repository
  (hooks off; no system or global Git config), committing as the Floor's
  Git identity and keeping each commit's author and author date. The
  rebased branch is pushed with `--force-with-lease` on what GitHub had.
  It answers `rebase`: `up_to_date`, `rebased` (and the base commit) or
  `conflict` (and the files).
- **Never over someone else's work.** If GitHub's branch holds a commit the
  Agent's work was not built on, there is no rebase and no force: the
  plain push is refused, as before.
- **A conflicting rebase** is aborted and the branch is pushed as the
  Agent left it. The coder's Handoff to the reviewers (`coderHandoff`)
  then starts its risks with "It could not be rebased onto main, which has
  changed since the work began: src/basket.ts conflict. It is reviewed as
  it is, and needs main merged in before it can merge."
- **Only the coder's delivery to review rebases** (`push(…, true)` in
  `deliver`). The push at a Token Cap pause, and QA's and the docs Agent's
  pushes, do not.
- **`branch.pushed`** (`packages/events`) gains an optional `rebase`
  (`outcome`, `onto`, `base`, and `files` for a conflict). The Activity
  Feed (`apps/web` `event-text.ts`) reads it as "…, rebased onto main at
  fedcba9.", "…, already on main." or "…, not rebased onto main:
  src/basket.ts, src/total.ts conflict."

### Mid-Batch changes (FR-24, FR-25.4; `packages/orchestrator` `batches/plan.ts`, `batches/batches.ts`, `manager/chat.ts`; `apps/server` `server.ts`)

- **`changedOrder(order, started, change)`** (plain code) applies "skip …"
  or "move N up/down" to a Plan's order. The issues whose work has started
  come first, as they were. Only the issues still to start are skipped, or
  swapped with their neighbour still to start. It refuses, saying why:
  an issue not in the Plan; one that has started ("#3's work has started,
  so it is not skipped: work that has started carries on"); moving the
  first issue still to start up, or the last down; skipping every issue.
- **`replanMidBatch`** (AI Office's rules): each started issue exactly as
  it was. The rest keep their likely files, coder (while still an enabled
  coder) and note, plus the dependencies still before them. Overlaps are
  sequenced again in the new order (`sequenceOverlaps` now takes `pinned`
  issues, which get no new dependency). Then the parallel groups.
- **`Batches.change(floorId, change)`** finds the Floor's open Batch whose
  latest Plan holds the issues (`batch_not_found` if none; issues in two
  Batches at once are refused). Then, holding that Batch:
  - **awaiting approval:** the change becomes an edit like the
    whiteboard's, through the same replan as `edit` (factored out as
    `replanEdit`): the Manager's Model, or the rules, and a skipped issue
    is left out "you skipped it";
  - **in progress**, while starting is held: the rules replan as above,
    kept as the next version with `editedFrom`, `batch.planned` published,
    and whatever the new version lets start starts (through triage). A
    skipped issue is left out ("you skipped it while the Batch was under
    way"), so the Batch no longer holds it and it never starts.
- **`Batches.changeCommand`** answers in words for the chat: "Batch 1: you
  skipped #4, so Tony replanned it as version 2 by AI Office's rules.",
  the Plan with started issues marked "(started)", then "The work already
  started on #1, #3 and #5 carries on, none of it restarted." and "Work
  started now on #4." when something started. The Plan lines are shared
  with the "complete issues …" answer (`planLines`).
- **Starting a Batch's issues reads its latest Plan** while starting is
  held (`startReady`, under `exclusive`), so a change and the minute's
  check never race on a stale version.
- **The chat**: the server's `carryOut` sends "skip" and "move" to
  `changeCommand`. The fallback for a chat with no Batches is now "Batches
  are not available here, so nothing changed."

### The fake sandbox (`sandbox/fake-sandbox.ts`)

Each fake sandbox now has a throwaway HOME of its own, removed when it
closes. Before, sandboxes running at once shared one, so Sandcastle's
`git config --global` in each could race for the same lock file. The
overlap scenario runs two coders at once and hit this in 3 of 6 runs
under load (below).

### Docs

README: "From issue to pull request" (rebased onto merged work first; a
conflicting rebase), "The Manager chat" ("skip" and "move"), "Batches and
Plans" (overlapping issues run one after another), and a new "Changing a
Batch mid-way: "skip" and "move"".

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `3201c96` (output below). Without Docker
      the Postgres tests skip with the reason (2306 passed, 341 skipped).
      Against an embedded Postgres 18.4 the full suite passed: 2627 passed
      and 20 skipped (the real-App GitHub contract and the Docker image
      and compose checks, as in #84).
- [x] **Scenario test: skip mid-Batch.**
      `packages/orchestrator/src/batches/batches.test.ts`, in memory and
      in Postgres 18.4, with the real triage, pipeline, work queue,
      Notices and Manager chat (fake model, fake GitHub). "complete issues
      1 to 5" with plan approval off starts #1, #3 and #5; #2 waits for
      #1 and #4 for #2. Then "skip 4" in the chat:
      1. Version 2, by AI Office's rules, compared in full: #1, #3 and #5
         first, each item identical to version 1's; then #2, still after
         #1; #4 left out "you skipped it while the Batch was under way";
         `editedFrom: 1`; `batch.planned` with `editedFrom`. The Batch now
         holds only #2.
      2. Nothing was restarted: the same work queued and running, no new
         triage, no model call, one `batch.started`, still in progress.
      3. The chat's answer, compared in full.
      4. Refusals that change nothing: "skip 3" (started), "move 2 up"
         (already the first still to start), "skip 9" and "skip 4" again
         (in no open Batch). There are still exactly two versions.
      5. #1 is merged: `check()` starts #2. #2 is merged: nothing starts,
         as #4 was skipped.

      Beside it: **"move 4 up" mid-Batch** (#4 moves above #2, which it
      overlaps: #4 drops its dependency on #2 and starts at once, for its
      coder, and #2 now waits for #1 and #4), and **"skip" before
      approval** (an edit the Manager replans, with the Manager paused so
      by the rules; still awaiting approval, nothing started).
- [x] **Scenario test: overlapping issues serialise and rebase.**
      `packages/orchestrator/src/batches/overlap.test.ts`, end to end
      through the real Batches, coder flow, sandbox runner (fake sandbox,
      scripted coders), branch publishing and work queue, on a local bare
      repository standing in for GitHub's remote (the fake GitHub kept in
      step with it). A stand-in for review records each branch as review
      receives it. Batch: #1 (basket, `src/basket.ts`), #2 (its total, also
      `src/basket.ts`), #3 (footer):
      1. The Plan has the overlap `[1, 2]` on `src/basket.ts`, so #2
         depends on #1, with parallel groups `[[1, 3], [2]]`; #1 and #3
         start.
      2. #1 and #3 reach review on main as it was (`rebase: up_to_date`).
         #2 has no label, and `check()` starts nothing while #1 is open.
      3. The Owner merges #1. Only then does `check()` start #2, and its
         coder finds #1's basket in its clone.
      4. While #2's coder works, the Owner merges #3, so main moves on.
      5. At review, main (#3's merge) is under #2's branch: its one commit's
         parent is that merge. The branch has the README, the basket with
         the total, and the footer. `branch.pushed` says `rebase: {outcome:
         "rebased", onto: "main", base: <#3's merge>}`. The commit is still
         the Owner's with Alan's `Agent:` trailer, and nothing is left of
         the checkouts.

      Its second case: someone changes `src/basket.ts` on main while #2 is
      worked. The rebase conflicts, so #2 goes to review on the main it
      began from, `branch.pushed` names `src/basket.ts`, and the reviewers'
      Handoff carries the warning.

**Beyond the criteria**, the behaviour is covered by:

- `git/publish.test.ts`: replaying a branch (one commit pushed before,
  one new) onto work merged since, as the Owner, keeping authors' dates,
  over what GitHub had; no rebase needed; a conflict, pushed as it was
  and naming the file; and a branch changed on GitHub meanwhile, which is
  not replaced (the push fails, without the token, and GitHub keeps their
  commit).
- `batches/plan.test.ts`: `changedOrder` (skips and moves, started
  issues first, interleaved started issues, before approval) and its
  refusals; `replanMidBatch` compared in full (started issues as they
  were, even two that share a file, given no new dependency; a moved
  issue re-sequenced; a paused coder's issue shared out again).
- `review/handoff.test.ts`: the conflict warning, and none after a
  rebase. `apps/web` `activity-feed.test.tsx`: the three `branch.pushed`
  texts. `events` `schema.test.ts` parses `branch.pushed` with `rebase`.
- **Changed tests.** `coder/coder.test.ts` > "says why when the push
  fails, without the token" now expects "Git could not fetch main: …":
  with an unreachable remote, reading main to rebase onto it is now the
  first remote step. It still checks the reason is shown and holds no
  token. `manager/chat.test.ts` and `apps/server`
  `manager-chat/routes.test.ts` expect the new fallback text for "skip"
  and "move" from a chat without Batches.

**Negative checks.** Each sabotage was applied to the working tree, run,
and reverted with `git checkout` (`git status` clean afterwards). The
`batches` runs were in memory, `batches.test.ts` and `plan.test.ts`
together.

| Sabotage | Failed |
| --- | --- |
| The coder's delivery does not rebase | both cases of `overlap.test.ts` |
| Overlaps are not sequenced | both cases of `overlap.test.ts` (the second by timing out: #2 starts at once and its coder waits for a merge that never comes) |
| A started issue may be skipped or moved (`changedOrder` told nothing started) | the "skip 4" and "move 4 up" mid-Batch scenarios |
| Started issues are not kept first | `changedOrder`'s test and the "skip 4" scenario |
| Started issues are given new dependencies by overlaps | `replanMidBatch`'s test |
| A mid-Batch change starts nothing | the "move 4 up" scenario |
| Skipped issues are not left out | the "skip 4" scenario |

**The flaky fake sandbox, before and after.** The first run of the new
tests next to the Postgres suite failed once. Six runs of `overlap.test.ts`
with the other sandbox tests (`src/git src/coder src/qa src/docs`) failed
three times: twice an issue never reached review (`expected [ 1 ] to
deeply equal [ 1, 3 ]`), once "couldn't find remote ref
ai-office/1-add-a-basket". Logging the Agents' statuses showed why:

```text
"status":"blocked","issue":3,"reason":"The sandbox for issue #3 failed: Command failed (exit 255): git config --global user.email \"adrian.eyre@hotmail.co.uk\" error: could not lock config f…"
```

With a home per sandbox (`3201c96`), ten runs of `overlap.test.ts` with
`src/git src/coder src/qa src/docs src/sandbox src/review src/work
src/memory` all passed:

```text
run 1:       Tests  307 passed | 33 skipped (340)
run 2:       Tests  307 passed | 33 skipped (340)
run 3:       Tests  307 passed | 33 skipped (340)
run 4:       Tests  307 passed | 33 skipped (340)
run 5:       Tests  307 passed | 33 skipped (340)
run 6:       Tests  307 passed | 33 skipped (340)
run 7:       Tests  307 passed | 33 skipped (340)
run 8:       Tests  307 passed | 33 skipped (340)
run 9:       Tests  307 passed | 33 skipped (340)
run 10:       Tests  307 passed | 33 skipped (340)
```

### Not verified by a test

- **The real GitHub and its Git remote.** The rebase and the lease were
  run against local bare repositories (`file://`-style paths), not
  `github.com` over HTTPS with an installation token. The token reaches
  `fetch`, `ls-remote` and `push` through the same `runGit` environment as
  the existing push, but that path was not exercised against GitHub here.
- **The Git in AI Office's image.** The sandbox has git 2.39.5. The rebase
  uses only `fetch`, `merge-base`, `worktree add/remove`, `rebase --onto`
  and `push --force-with-lease`, all far older than that, but the image's
  own Git was not run here.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests needs
  Docker. The suite ran against an embedded Postgres 18.4 instead (below),
  and runs in CI.
- **Playwright** was not run for this issue. No page or e2e flow changed;
  the only web change is the Activity Feed's text for `branch.pushed`,
  covered by its unit test. The e2e suite has no test of "skip", "move"
  or pushed branches.

## Notes

- **Mid-Batch replans use AI Office's rules, not the Manager's Model.**
  The Owner's command says exactly what changes. The issues started must
  stay exactly as they are. Everything else (dependencies still before,
  overlaps, assignments) is the Plan's own plain-code rules (FR-23: dispatch
  rules are plain code). Before approval, where the whole Plan is still a
  proposal, a chat change is an edit the Manager replans, as the
  whiteboard's are.
- **Every branch is rebased before review, not only the later issue of an
  overlap.** The rebase is a no-op unless the default branch has moved on.
  The PRD's risk row ("Parallel Agents produce merge conflicts … rebase on
  merged work") applies to parallel issues as much as to overlapping ones.
- **Started issues come first in a mid-Batch version.** A not-started
  issue placed before a started one it shares a file with would otherwise
  run beside it. Putting started issues first, in their order, keeps the
  overlap sequencing sound, and matches what actually ran first.
- **"move" swaps with the neighbouring issue still to start**, skipping
  over started ones, so it always changes what starts next.

## Outside this issue

- **A conflicting rebase goes to review as it is.** The reviewers are
  warned, but the work is not sent back to the coder to merge the default
  branch and resolve the conflict. Such a branch cannot merge on GitHub
  until someone does. Sending it back (a round of its own, within the caps)
  would close the loop.
- **Skipping a started issue does not stop it.** "skip" refuses issues
  whose work has started. Stopping work in progress (cancelling its
  sandbox, letting the issue go) is not built.
- **QA's and the docs Agent's pushes are not rebased.** They come after
  review and push onto the branch review saw. A branch whose default
  branch moves on during QA or docs is not brought up to date before it
  merges.
- **The whiteboard still edits only Plans awaiting approval**, as FR-58
  says. Mid-Batch changes are made from the chat, and the whiteboard shows
  their versions ("replanned by AI Office's rules after your edits to
  version 1"); the summary says it was under way.
- **Batches never finish** (as #83 and #84 noted), so every Batch stays
  "open", and `change` looks through all of a Floor's Batches for the one
  holding an issue (the newest wins).
- **Annotations do not reach the coder**, "pause" and "resume" are not
  carried out, Kickoff acknowledgements and Wrap-up are not built, and the
  code keeps `needs-code` rather than ADR 0003's `needs-work`: all as #84
  noted.
- **Leftover fake homes.** Before this issue the fake sandbox never removed
  its HOME, so earlier test runs left `ai-office-fake-home-*` directories
  in the system's temporary directory. They are removed now as each
  sandbox closes.

## Output

### Fresh clone at `3201c96`

```text
$ git log --oneline -1
3201c96 fix(orchestrator): each fake sandbox has a home of its own
$ pnpm install --frozen-lockfile
Done in 581ms using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  202 passed (202)
      Tests  2306 passed | 341 skipped (2647)
test exit=0
```

### Against the embedded Postgres 18.4 (same clone)

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  202 passed (202)
      Tests  2627 passed | 20 skipped (2647)
pg test exit=0
```

An earlier run of both, from a fresh clone at `60e0c9c` (before the fake
sandbox fix), also passed: 2306 passed and 341 skipped without Docker;
2627 passed and 20 skipped in Postgres.

### The new and changed tests (verbose)

In memory, at `60e0c9c`, `pnpm vitest run --project @ai-office/orchestrator
--project @ai-office/web --project @ai-office/events src/git/publish.test.ts
src/batches src/review/handoff.test.ts src/coder/coder.test.ts
src/activity-feed.test.tsx src/schema.test.ts --reporter=verbose`, the
tests this issue added or changed. That run was the one next to the
Postgres suite where the overlap scenario's second case failed, as
described above; it passes since `3201c96`:

```text
✓ |@ai-office/orchestrator| src/git/publish.test.ts > publishBranch > rebasing onto the default branch first > replays the branch onto work merged since it began, as the Owner, over what GitHub had
✓ |@ai-office/orchestrator| src/git/publish.test.ts > publishBranch > rebasing onto the default branch first > pushes as before when the branch already has the default branch under it
✓ |@ai-office/orchestrator| src/git/publish.test.ts > publishBranch > rebasing onto the default branch first > pushes the branch as it was, naming the files, when the rebase conflicts
✓ |@ai-office/orchestrator| src/git/publish.test.ts > publishBranch > rebasing onto the default branch first > does not replace a branch that changed on GitHub meanwhile
✓ |@ai-office/orchestrator| src/review/handoff.test.ts > coderHandoff > warns the reviewers when the branch could not be rebased onto the default branch
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > changing a Batch while its work is under way > skips or moves only issues still to start, putting those started first
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > changing a Batch while its work is under way > says why a change does not fit
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > changing a Batch while its work is under way > by AI Office's rules: the issues started exactly as they were, the rest re-sequenced in the new order
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > "skip 4" mid-Batch: AI Office's rules replan it without restarting the work that started, and #4 never starts
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > "move 4 up" mid-Batch: #4 now comes before #2, which it overlaps, so #4 starts at once and #2 waits for it
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > "skip" before approval is an edit of the Plan, which the Manager replans; nothing starts
✓ |@ai-office/orchestrator| src/batches/overlap.test.ts > overlapping issues in a Batch > run one after another, and the later branch is rebased onto the work merged meanwhile before review
✓ |@ai-office/orchestrator| src/coder/coder.test.ts > the coder flow > says why when the push fails, without the token
✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > parses a branch.pushed event
✓ |@ai-office/web| src/activity-feed.test.tsx > event text > says whether a pushed branch was rebased onto the default branch before review
```

The Batch scenarios in Postgres 18.4 (working tree at `3201c96`), by name:

```text
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > "skip 4" mid-Batch: AI Office's rules replan it without restarting the work that started, and #4 never starts 280ms
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > "move 4 up" mid-Batch: #4 now comes before #2, which it overlaps, so #4 starts at once and #2 waits for it 263ms
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > "skip" before approval is an edit of the Plan, which the Manager replans; nothing starts 253ms
      Tests  22 passed (22)
```

`overlap.test.ts` keeps its Batches in memory: it is about Git and the
pipeline, not the stores, whose Postgres behaviour the cases above cover.

### How Postgres was run here

There is no Docker in this sandbox, so I used the method of the earlier
issues: `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL 18.4) in
`/tmp/pg18`, outside the repository, on port 54329, with Ubuntu's
`libicu60` extracted beside it for its ICU libraries. A scratch edit to
`packages/db/src/testing/postgres.ts` pointed `postgresTest` at that
server through `SCRATCH_PG_URL`, with database names unique per worker.
It was reverted with `git checkout` after each run, and nothing from it
is committed.
