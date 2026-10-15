# Issue #55: Review Loop with Round Cap and Handoff summaries — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) on this branch, after the issue's last code commit
(`45da7a8`).

## What was built

- **Verdicts kept by round** (`review_verdicts`, migration
  `0026_review_loop`; `ReviewLoopStore` in
  `packages/orchestrator/src/review/store.ts`, in memory and in Postgres).
  One row per required reviewer per round, with the head commit reviewed,
  the verdict, its comments and the review's URL. `review.posted` now names
  its `round`, and the Activity Feed says it.
- **The round** (`createReviewFlow`). A round is every required reviewer's
  verdict on one head commit of the pull request: the round under way at
  the head (after a restart, or a reviewer that failed, only the reviewers
  without a verdict there review again), or the next one. When every
  reviewer has one:
  - **All approve, no blocking comments** (nits alone approve): the issue
    moves `needs-review → needs-qa`.
  - **Blocking comments, round below the Floor's Round Cap** (3 by
    default): the reviewers' Handoff is kept, the issue moves
    `needs-review → needs-code`, and the coder's fix is queued.
  - **Blocking comments at the Round Cap:** the issue moves to
    `needs-human`, the pull request is labelled `needs-human` too (FR-28),
    and an action Notice, "Round Cap reached: PR #N (#issue) still has
    blocking comments after 3 rounds.", links the issue, the pull request
    and each round.
- **The coder's fix** (`createCoderFlow`). When the issue's last round had
  blocking comments, the coder's prompt has a "Review feedback to fix"
  section with those comments only (no nits), each with its file, line and
  reviewer, and the reviewers' Handoff, quoted between `<review>` markers
  it cannot close. The runner already carries on from the pushed branch, so
  the coder works the same branch, and the delivery reuses the open pull
  request ("PR #N updated") and queues the next round.
- **Handoffs** (FR-26), each `{ changed, check, risks }`, kept in `handoffs`
  and emitted as a `handoff` event when its receiving Agents take it:
  - **Coder → each reviewer**, as a round starts; also put in the
    reviewers' prompts, quoted. The coder's prompt asks it to end with a
    `<handoff>` block (`Changed:`, `Check:`, `Risks:`); the runner now
    returns the agent's last text (`SandboxRun.lastText`) and
    `parseHandoff` reads the block. Parts it leaves out are filled in from
    its commits' subjects (`publishBranch` now returns them, read in AI
    Office's own repository, never the Agent's clone), the issue, or the
    comments it was fixing.
  - **Reviewers → coder**, as the coder starts its fix
    (`reviewersHandoff`): who asked for changes and who approved, the
    blocking comments, the nits left aside, and the rounds left.
  - **Reviewers → QA**, on approval (`approvalHandoff`): kept for QA to
    take (#57), with the coder's summary and the nits left aside.
- **Notice links** (`notices.links`): up to ten `{ label, url }` links,
  redacted and checked like the others, sent by the API and listed on the
  Notice Board.
- **The work queue** adds work queued for a stage whose work is still
  running once that work ends: a round can send the issue back to the coder
  before the coder's own work item has ended (the review is fast), and the
  one-active-per-stage rule would otherwise drop the fix. Found by the
  scenario test below.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (1307 passed, 242 skipped).
- [x] **Scenario tests: approve on round 2; hit the Round Cap of 3; nits
      alone approve.** `packages/orchestrator/src/review/loop.test.ts` runs
      the whole loop: intake → the work queue (in memory) → the real coder
      flow, with real Sandcastle `run()` in the fake sandbox (a script
      stands in for Claude Code, committing a new take of `src/basket.ts`
      each run and ending with a `<handoff>` block) and a local bare
      repository as GitHub's Git remote → the reviewer flow, with a fake
      model for the Floor's two required reviewers (Claude and ChatGPT) →
      back to the coder, and so on, each flow queueing the next. The fake
      GitHub follows the remote's files, so reviewers see the real diff.
  - **Approve on round 2:** round 1, one reviewer approves with a nit, the
    other requests changes with one blocking comment; round 2, both approve
    (one with a nit). Checked:
    - the coder ran twice; the second prompt has "Review feedback to fix
      (after round 1 of 3)", the blocking comment with its file, line and
      reviewer, and the reviewers' Handoff ("Round 1 of 3: Quinta requested
      changes; <reviewer> approved.", "Fix this blocking comment, and only
      it: …", "1 nit was left aside. 2 rounds are left …"), and not the
      round-1 nit; the first prompt has no feedback;
    - both runs' commits are on the one branch, with one pull request;
    - four reviews, `review.posted` rounds 1, 1, 2, 2; round 2's reviewer
      prompt names "round 2 of at most 3", has the coder's Handoff ("What
      changed: The basket, take 2.") and the new file;
    - the issue ends at `needs-qa`, through `needs-code → needs-review →
      needs-code → needs-review → needs-qa`;
    - `handoff` events, in order: coder → each reviewer, the requesting
      reviewer → coder (`needs-code`), coder → each reviewer again; each
      with non-empty `changed`, `check` and `risks`; the first is exactly
      the coder's own block. The kept Handoff to QA says who approved in
      round 2 and lists the nit left aside;
    - no action Notice; four work items, all finished.
  - **Round Cap of 3:** one reviewer requests changes every round. The coder
    ran three times and not a fourth (its third prompt says "One round is
    left …"); six reviews, rounds 1–3; the issue and the pull request are
    labelled `needs-human`; one action Notice "Round Cap reached: PR #2 (#1)
    still has blocking comments after 3 rounds." with the issue, the pull
    request and `links` Round 1, Round 2, Round 3, each that round's
    changes-requested review on GitHub; two Handoffs back to the coder.
  - **Nits alone approve:** both reviewers approve with nits only in round
    1. The coder ran once, the issue is at `needs-qa`, no Handoff went back
    to the coder, the Handoff to QA lists all three nits, no action Notice.
  - **Mutation checks** (each reverted): making the Round Cap check `<=`
    failed the Round Cap test (a fourth coder run); letting nits into the
    coder's comments failed the round-2 test.

Also covered:

- `review/handoff.test.ts`: parsing the last `<handoff>` block (any case,
  list markers, multi-line parts, empty parts left out, long parts cut);
  the coder's Handoff from its own words, or filled in; the reviewers'
  Handoff (blocking only, nits counted, rounds left); the Handoff to QA.
- `coder/prompt.test.ts`: the Handoff it asks for; the feedback section,
  between the issue and how to work, whose `</review>` cannot be closed by
  a comment.
- `review/prompt.test.ts`: the round, and the coder's Handoff quoted so it
  cannot close `</handoff>`.
- `review/store.test.ts`: verdicts in round order, one per reviewer per
  round (a second replaces the first), and the latest Handoff to each stage.
- `work/queue.test.ts`: work queued while the same stage's work runs is
  added when it finishes, and not when it is requeued.
- `notices/notices.test.ts`: links kept and redacted, and refused when not
  web addresses; `apps/web/src/notice-board.test.tsx`: a "Round 1" link on
  the board; `apps/server/src/notices/routes.test.ts`: the API sends
  `links`.
- `reviewer.test.ts` (#54's): a round with blocking comments now sends the
  issue back to `needs-code`, and `review.posted` carries round 1.
- `sandbox/runner.test.ts`: the run returns the agent's last text;
  `git/publish.test.ts`: the new commits' subjects.

## Not verifiable in this sandbox

- **Postgres** (Docker): the Postgres runs of the store test, the queue's
  new cases and the Notices tests, and migration `0026_review_loop` applied
  to Postgres 18, are skipped here with the reason. The migration was
  written by `drizzle-kit generate` from `schema.ts`.
- **A real Review Loop on GitHub:** reviewers on real AI Accounts reviewing
  a real coder's pull request on `ai-office-sandbox` (#18 and real AI
  Accounts), Claude Code really ending with a `<handoff>` block, and the
  `needs-human` label on a real pull request.
- **Docker / a browser:** the Notice Board's links were checked with
  Testing Library, not in a browser.

## Notes, and disagreements with the canon

- **Where the issue goes on approval.** The issue says `needs-qa`, and the
  issue moves there whatever the Floor's team. QA (#57) is out of scope, so
  nothing yet queues QA work: an approved issue waits at `needs-qa`, with
  its Handoff kept for QA to take.
- **When a Handoff event is emitted.** A Handoff is emitted when its
  receiving Agents take the issue: the reviewers as the round starts, the
  coder as its fix starts (the work queue chooses the coder only when the
  fix is queued, so the event can name it then). FR-59's walk then follows
  the event. The Handoff to QA is kept, not yet emitted: no QA Agent takes
  it until #57.
- **The coder's fix may go to another coder.** The fix is queued like any
  `needs-code` work, for the Floor's coder with the least work; on a Floor
  with several coders that may not be the one who wrote the first version.
  The reviewers' Handoff carries what it needs.
- **Early escalation** for repeated blocking comments or a barely changed
  diff (FR-28's second bullet) is stall detection, #56, out of scope.
- **The overall cap per pull request and QA's Round Cap** (FR-28) belong
  with QA (#57).
- **The Round Cap is read when a round ends**, so lowering it below the
  rounds already run hands the pull request to the Owner at the next round
  with blocking comments.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  132 passed (132)
      Tests  1307 passed | 242 skipped (1549)
```

The new tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ src/review/loop.test.ts > the Review Loop > sends blocking comments back to the coder with a Handoff, and moves on to QA when round 2 approves
 ✓ src/review/loop.test.ts > the Review Loop > hands the pull request to the Owner when round 3, the Round Cap, still has blocking comments
 ✓ src/review/loop.test.ts > the Review Loop > approves on nits alone, without sending the work back
 ✓ src/review/handoff.test.ts > parseHandoff / coderHandoff / reviewersHandoff / approvalHandoff (7 tests)
 ✓ src/coder/prompt.test.ts > the coder's prompt > asks for the coder's Handoff to the reviewers
 ✓ src/coder/prompt.test.ts > the coder's prompt > gives the reviewers' blocking comments and Handoff when they sent the work back, quoted
 ✓ src/review/prompt.test.ts > the reviewer's prompt > names the round, and quotes the coder's Handoff
 ✓ src/review/store.test.ts > the Review Loop's store > in memory keeps verdicts by round, one per reviewer, and the latest Handoff to each stage
 ✓ src/work/queue.test.ts > the work queue, in memory > queues work for a stage whose work is still running once that work ends
 ✓ src/notices/notices.test.ts > Notices, kept in memory > raises an action Notice with its links and actions, as an event
 ✓ src/notices/notices.test.ts > raising a Notice > refuses links that are not web addresses
 ↓ src/review/store.test.ts > the Review Loop's store > in Postgres 18 keeps verdicts by round, … [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ↓ src/work/queue.test.ts > the work queue, in Postgres 18 > queues work for a stage whose work is still running once that work ends [Docker is not available …]
```
