# Issue #60: Merge Policy and the auto-merge gate — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`154d3b4` to
`00a375b`, then the README in `89d146a`).

**Blocked by #27 and #55.** Both are built on this branch, though their
issues are still open: the Notices and Notice Board (`createNotices`,
`docs/verification/issue-27.md`) and the Review Loop with its Round Cap
(`createReviewFlow`, `review_verdicts`, `docs/verification/issue-55.md`).
QA (#57), docs (#58) and the per-PR caps they brought are on the branch
too, so this slice builds on all of them.

## What was built

- **The Merge Policy's work** (`packages/orchestrator/src/merge/merge.ts`,
  `createMergeFlow`; PRD FR-29, FR-49, §5 scenario 3). Whichever stage
  passes a pull request last now queues work at `ready-to-merge`: the
  reviewer flow (no QA or docs Agent), QA (no docs Agent) and docs.
  `queuedStages` includes `ready-to-merge`. Like a review round, the work
  is for no Agent and uses no sandbox, so it starts whatever the limits are
  and survives a crash in `work_queue`. It reads the issue's labels
  first, and does nothing if the issue has moved or its pull request is
  merged already.
  - **Send to me** (each Floor's default since #20): an action Notice,
    exactly "PR #N awaiting your approval". It links the issue, the pull
    request, its CI run (`ciRunUrl`) and each round of review and QA
    (`everyRoundLinks`), and offers **Approve and merge**
    (`approve_and_merge`). It is raised once: a second run finds it open.
  - **Auto-merge.** The gate (`gate.ts`: `heldBack`, `ciOf`, `ciHeldBack`,
    all plain rules) lets the App merge only when:
    - every required reviewer approved in the latest round (a reviewer
      made required since has not);
    - no blocking comments remain from that round;
    - CI passed on the head commit. Every check run passed (`success`,
      `neutral` or `skipped`, by each check's latest run), and every check
      the base branch requires ran;
    - no cap was exceeded: review rounds within the Floor's Round Cap, QA
      rounds within QA's, both together within the overall cap, and no
      `cap.reached` event naming the issue.

    It waits for CI to finish: every 30 s for up to 30 min, and up to
    5 min for a first check to start when none is required. A failed
    check is final at once. A condition other than CI that fails sends the
    pull request to the Owner without waiting for CI. When every condition
    holds, the App merges the head CI passed on (`sha`), with a merge
    commit. An info Notice records the merge: "PR #N merged automatically:
    every required reviewer approved and CI passed." Otherwise the pull
    request goes to the Owner as for "send to me", with the reason in the
    title, such as "PR #2 awaiting your approval: not merged automatically,
    as CI check "test" failed.", and a link to the failed run. A merge
    GitHub refuses goes to the Owner the same way, with the reason (a head
    that moved is a 409, "its head commit changed as it was being merged").
  - **Labels.** `ai-office:manual` sends the pull request to the Owner (the
    title ends "(ai-office:manual)"). `ai-office:auto-merge` has it merged
    automatically, still through the gate, but only when the Owner added
    the label: the latest `labeled` event for it is by the Owner's GitHub
    login from Admin's Intake settings. Otherwise it is not followed, and
    the Notice says so. With both labels, the Owner decides. Intake now
    creates both labels on each Floor's repository (`pipelineLabels`).
  - **Approve and merge.** The App merges with a merge commit, as the
    Owner approved it. The gate is not asked again, though GitHub's branch
    protection still is. If the pull request was closed, or GitHub refuses
    the merge, the action fails, so the Notice stays with the reason. If
    the Owner already merged it on GitHub, the Notice just closes.
  - **Each merge** is a `pull_request.merged` event (`by`: `app` or
    `owner`; new in `@ai-office/events`, shown in the Activity Feed with a
    link to the pull request), and an info Notice saying who merged it
    (FR-49).
- **The GitHub App client** (`@ai-office/github`).
  - `RepositoryClient.requiredChecks(branch)` gives the checks a branch
    requires, by name. It reads the branch's protection
    (`required_status_checks`, from `GET /branches/:branch`) and its
    rulesets' `required_status_checks` rules (`GET /rules/branches/:branch`).
  - A `CheckRun` now has its `htmlUrl`.
  - The fake implements both, with `requireChecks(…)` in its scenario API,
    and serves them over HTTP. The Manager's restricted client
    (`managerGitHub`) passes `requiredChecks` through, as it does the other
    reads.
- **The watchdog** leaves running `ready-to-merge` work alone. That work
  waits on CI, not on an Agent, and bounds its own wait, so 20 quiet
  minutes are not a stall.
- **Server** (`startOffice`): the Merge Policy runs at `ready-to-merge`
  whenever the GitHub App is configured, and the docs flow queues it. The
  "Approve and merge" handler is registered then, even when no sandbox
  can run.
- **Web:** the Activity Feed's text and link for `pull_request.merged`.
  The wall board refreshes on it, and its queues include `ready-to-merge`.
- **README:** "The Merge Policy", and its mentions in the labels, the work
  queue, docs, the watchdog and the GitHub App client.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 on the committed tree (output below). Without Docker the Postgres
      tests skip with the reason (2512 passed, 309 skipped).
- [x] **Scenario tests: each gate condition blocks auto-merge; label
      overrides; the Notice action merges.** Three layers:
  - **End to end** (`src/merge/merge-loop.test.ts`, 6 cases). These run
    the shared scenario harness: intake → the work queue → the real coder
    and QA flows (real Sandcastle `run()` in the fake sandbox, a local bare
    repository as GitHub's remote) → the reviewer flow (two required
    reviewers on a fake model) → the Merge Policy. CI "finishes" on the
    pull request's head during the gate's first wait, on the test's own
    clock.
    - *Send to me:* the issue ends at `ready-to-merge` with one action
      Notice, "PR #2 awaiting your approval". It carries the issue and pull
      request, the links Review round 1 and QA round 1, and Approve and
      merge. Nothing waited for CI. Acting on it merged PR #2 and closed
      issue #1 (`Closes #1`). It published `pull_request.merged` `by:
      owner`, closed the action Notice and raised "PR #2 merged, as you
      approved it."
    - *Auto-merge after a two-round Review Loop* (round 1 asks for a
      change): the gate waited once for CI (the required check `test`),
      then the App merged it. One `pull_request.merged` `by: app`, the info
      Notice, no action Notice.
    - *CI fails:* not merged. The Notice says `CI check "test" failed`, its
      `ciRunUrl` is the run, and it offers Approve and merge.
    - *A required check never runs* (`e2e`): not merged, after 60 looks
      (30 min).
    - *Labels:* the Owner's `ai-office:auto-merge` on a send-to-me Floor
      merges, and `ai-office:manual` on an auto-merge Floor sends it to the
      Owner without waiting for CI.
  - **Each condition of the gate** (`src/merge/merge.test.ts`, 23 cases).
    These run the flow on its own against the fake GitHub, with verdicts,
    reports and events seeded. Each condition on its own holds an
    otherwise mergeable pull request back. In each case: not merged, no
    `pull_request.merged`, and exactly one action Notice with the reason
    in its title. The conditions are:
    - a required reviewer that has not approved;
    - a blocking comment left;
    - a failed check (linked, and not waited on);
    - CI still running after 30 min;
    - a required check that never ran;
    - no CI at all (after 5 min);
    - the Round Cap lowered below the rounds run;
    - a `cap.reached` for the issue (another issue's does not count);
    - several conditions at once (each named; no wait for CI);
    - a merge GitHub refuses because the head moved.

    The rest of the 23: both labels in every combination, including the
    auto-merge label by someone else (not followed, and the Notice says
    so); Approve and merge (merges; a closed pull request keeps the Notice
    with "PR #2 was closed without being merged."; one already merged on
    GitHub just closes it); and nothing done for an issue that moved or a
    pull request already merged.
  - **The rules** (`src/merge/gate.test.ts`, 9 cases): approvals by round,
    reviewers added later, no required reviewer, blocking comments, each
    cap, Token Caps by name, every failing conclusion, a check run again
    (its latest counts), running and missing checks, and no CI.
  - **Mutation checks** (each reverted; failing tests listed):
    - ignoring who added `ai-office:auto-merge`: 1;
    - ignoring `ai-office:manual`: 3;
    - not waiting for running CI: 4;
    - ignoring blocking comments: 2;
    - ignoring Token Caps: 2;
    - ignoring the Round Cap: 2;
    - ignoring required checks: 4;
    - ignoring unapproved reviewers: 5;
    - treating a failed check as passed: 5;
    - the watchdog stalling `ready-to-merge` work: its new case.

Also covered:

- `packages/github/src/contract.test.ts`: a new case, "lists the checks a
  branch requires before a merge". It runs against the in-memory fake and
  against the real App client over the fake's HTTP (protection and
  rulesets), and a 404 for no such branch. Each check run has an `https`
  page.
- `work/queue.test.ts`: `ready-to-merge` is queued for no Agent, and
  `needs-human` is still refused.
- `wall-board.test.ts`: the queues include `ready-to-merge`.
- `manager/watchdog.test.ts`: "leaves the Merge Policy's work alone while it
  waits on CI".
- `apps/web/src/activity-feed.test.tsx`: the merged event's text, `app`
  and `owner`, and its link.
- The scenarios of #55, #57, #58 and #59 (`review/loop.test.ts`,
  `qa/qa-loop.test.ts`, `docs/docs-loop.test.ts`,
  `review/conflict-loop.test.ts`) now run on through the Merge Policy.
  Those that end at `ready-to-merge` expect what now happens there: work
  `ready-to-merge finished`, and on the default send-to-me Floor, the
  single action Notice "PR #2 awaiting your approval" where they expected
  none. Their other assertions are unchanged.

### Verified on the host

- [ ] **On `ai-office-sandbox` both policies work end to end.** Not
      verifiable here: no `GITHUB_APP_ID`, no Docker for sandboxes, no real
      AI Accounts. To verify on the host:
  - with the Floor at **Send to me**, take an issue through to
    `ready-to-merge` and check for "PR #N awaiting your approval" with its
    links, then **Approve and merge**;
  - set the Floor to **Merge automatically** with the default branch
    requiring CI (and no approval count), and check that the App merges
    once CI passes, and that a failing check or `ai-office:manual` sends
    it to the Owner instead.

  The contract suite's real-App target runs the new `requiredChecks` case
  when `GITHUB_APP_ID` is set.

## Not verifiable in this sandbox

- **Postgres** (Docker): the Postgres runs of the queue, wall-board and
  watchdog tests are skipped here with the reason. No migration was
  needed: `work_queue_stage` already allowed `ready-to-merge`, and
  `floors.merge_policy` exists since #20.
- **The real GitHub API** for required checks: whether a token without
  administration access sees `protection.required_status_checks` in
  `GET /branches/:branch` on github.com and on GitHub Enterprise Server.
  The client tolerates `protection` being absent, and reads rulesets too.
- **A browser:** the Notice's "Approve and merge" button is the Notice
  Board's generic action button (#27). It was not exercised in Playwright
  for this slice.

## Notes, and disagreements with the canon

- **"Required CI checks pass"** means: every check run on the head commit
  passed, and every check the base branch requires ran and passed. A
  check that is not required but failed still holds back auto-merge.
  Commit statuses (the older Statuses API, which some CI still uses) are
  not read. A required context reported only as a status counts as never
  run, so the pull request goes to the Owner, which is the safe side.
- **"No cap was exceeded"** includes Token Caps: any `cap.reached` on the
  issue's work holds back auto-merge, even if the Owner raised the cap and
  the work carried on. ADR 0002 names only the Round Cap, and PRD FR-29
  says "every cap was respected". This is the stricter reading.
- **Approvals are the latest round's, not the final head's.** QA's tests
  and the docs Agent's commits land after review by design (FR-18), so
  the gate checks that every required reviewer approved the last round,
  not the head merged. CI is checked on the head that is merged.
- **Merge commits.** PRD and ADRs name no merge method. Squash or rebase
  would rewrite the Agents' commits, which ADR 0002 has authored as the
  Owner with an `Agent:` trailer, so the App merges with a merge commit.
- **`ai-office:auto-merge` counts only when the Owner added it.** The
  issue says the labels override per issue. PRD §4 refuses to act on
  anyone else's say-so, so another collaborator's label does not waive
  the Owner's approval. Anyone's `ai-office:manual` is followed, since it
  only asks for the Owner.
- **Approve and merge does not pin the head.** A Notice keeps no commit,
  so a commit pushed after the Notice is merged with the rest. No Agent
  pushes at `ready-to-merge`, and GitHub's branch protection still
  applies.
- **An info Notice for the Owner's merges too.** FR-49 lists "pull request
  merged (by whom: App or Owner)", so the Owner's merge from the Notice is
  recorded as the App's is.

## Noticed, out of scope

- **A graceful stop appears to drop running work.** On `queue.stop()`,
  running work ends as `cancelled`, and `requeueRunning()` at the next
  start queues only work left `running`. Work stopped by a restart (not a
  crash) is therefore not queued again, for every stage. This predates
  #60, but the gate can wait up to 30 min on CI, so it is more likely to
  be running at a restart. An issue stopped there stays at
  `ready-to-merge` with nothing queued.
- **A pull request the Owner merges directly on GitHub** leaves its
  "awaiting your approval" Notice open until it is acted on (which then
  just closes it) or dismissed. Nothing watches GitHub for merges.
- **Branch protection setup docs** are #62.
- **The pipeline still calls the work stage `needs-code`**, where ADR 0003
  renames it `needs-work`. That is unchanged here.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  208 passed (208)
      Tests  2512 passed | 309 skipped (2821)
```

The new tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ src/merge/gate.test.ts > the Merge Policy's gate > lets through a pull request every required reviewer approved, within every cap
 ✓ src/merge/gate.test.ts > the Merge Policy's gate > holds back a pull request a required reviewer has not approved in the latest round
 ✓ src/merge/gate.test.ts > the Merge Policy's gate > holds back a pull request with blocking comments in its latest round
 ✓ src/merge/gate.test.ts > the Merge Policy's gate > holds back a pull request past any cap
 ✓ src/merge/gate.test.ts > CI on the head commit > (5 tests)
 ✓ src/merge/merge.test.ts > auto-merge > merges once every required reviewer approved and CI passed, recording it in an info Notice
 ✓ src/merge/merge.test.ts > auto-merge > waits for CI to finish on the head, then merges
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request a required reviewer has not approved
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request with blocking comments left
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request whose CI failed, linking the failed run
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request whose CI never finishes, after half an hour
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request a required check never ran on
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request no CI ran on, after waiting for one to start
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request past the Round Cap
 ✓ src/merge/merge.test.ts > auto-merge > holds back a pull request whose work reached a Token Cap
 ✓ src/merge/merge.test.ts > auto-merge > names every condition that failed, and does not wait for CI when another did
 ✓ src/merge/merge.test.ts > auto-merge > sends the pull request to the Owner when GitHub refuses the merge
 ✓ src/merge/merge.test.ts > send to me > raises an action Notice linking the pull request, its issue, its CI run and each round, once
 ✓ src/merge/merge.test.ts > send to me > merges the pull request when the Owner approves it from the Notice
 ✓ src/merge/merge.test.ts > send to me > keeps the Notice, saying why, when the pull request cannot be merged
 ✓ src/merge/merge.test.ts > send to me > closes the Notice without merging again when the Owner merged on GitHub
 ✓ src/merge/merge.test.ts > labels override the Floor's Merge Policy > sends the pull request to the Owner with ai-office:manual on an auto-merge Floor
 ✓ src/merge/merge.test.ts > labels override the Floor's Merge Policy > merges automatically with the Owner's ai-office:auto-merge on a send-to-me Floor
 ✓ src/merge/merge.test.ts > labels override the Floor's Merge Policy > still applies the gate to a pull request labelled ai-office:auto-merge
 ✓ src/merge/merge.test.ts > labels override the Floor's Merge Policy > follows ai-office:auto-merge only when the Owner added it
 ✓ src/merge/merge.test.ts > labels override the Floor's Merge Policy > sends the pull request to the Owner when it has both labels
 ✓ src/merge/merge.test.ts > the work at ready-to-merge > does nothing for an issue that is no longer ready to merge
 ✓ src/merge/merge.test.ts > the work at ready-to-merge > does nothing for a pull request merged already
 ✓ src/merge/merge-loop.test.ts > the Merge Policy > sends the pull request to the Owner by default, and merges it when the Owner approves it from the Notice
 ✓ src/merge/merge-loop.test.ts > the Merge Policy > merges automatically once CI on the head passes, on an auto-merge Floor
 ✓ src/merge/merge-loop.test.ts > the Merge Policy > sends the pull request to the Owner, saying why, when CI fails on an auto-merge Floor
 ✓ src/merge/merge-loop.test.ts > the Merge Policy > sends the pull request to the Owner when a required check never runs
 ✓ src/merge/merge-loop.test.ts > the Merge Policy > merges automatically on a send-to-me Floor when the Owner labelled the issue ai-office:auto-merge
 ✓ src/merge/merge-loop.test.ts > the Merge Policy > sends the pull request to the Owner on an auto-merge Floor when the issue is labelled ai-office:manual
 ✓ src/manager/watchdog.test.ts > the Manager's watchdog, in memory > leaves the Merge Policy's work alone while it waits on CI
 ↓ src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > leaves the Merge Policy's work alone while it waits on CI [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
```
