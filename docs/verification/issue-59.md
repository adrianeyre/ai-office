# Issue #59: Escalate conflicts between Roles — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commits (`258944b` to
`12f7485`).

**Blocked by #57** (the QA Agent stage and per-PR caps): its work exists on
this branch (`createQaFlow`, `qa/caps.ts`, `docs/verification/issue-57.md`),
so this slice builds on it.

## What was built

- **The two shapes of conflict** (`packages/orchestrator/src/review/conflict.ts`;
  PRD FR-30). Both are deterministic rules:
  - **QA against the reviewers** (`qaConflictOf`), checked when QA fails:
    QA's previous round also failed, its failure repeats that one (the
    summary and steps share at least 60% of their words, the stall rule's
    `commentSimilarity` and `repeatSimilarity`), and every reviewer approved
    in both of the last two review rounds, the ones before each of those
    rounds of QA. This is "QA fails something every reviewer approved twice
    in a row".
  - **The reviewers against QA** (`reviewConflictOf`), checked when a review
    round has blocking comments: the previous round was approved by every
    reviewer and then failed by QA, and more than half of this round's
    blocking comments are on files the coder changed since QA checked the
    branch (GitHub's compare of the head QA checked and the new head). This
    is "reviewers reject what QA required".
- **Stopping the loop.** Either conflict escalates as a cap does
  (`createEscalation`): the issue moves to `needs-human`, its pull request is
  labelled `needs-human`, no Handoff goes back to the coder and nothing more
  is queued. The action Notice's title says what happened, such as "Review
  Loop conflict between Roles: QA failed PR #2 (#1) in QA round 2 as in round
  1, though every reviewer approved it twice in a row." It links every round
  of review and QA (`everyRoundLinks`).
- **Both positions side by side.** A Notice has a new `positions` field, at
  most two `{ label, text, url? }`, in the order they arose
  (`noticePositionSchema` in `@ai-office/shared`; the `notices.positions`
  column, migration `0035_notice_positions`; the Notice API). For a conflict,
  `conflictPositions` gives each side in its own words, linked to where it
  was said:
  - **QA against the reviewers:** "Reviewers: approved in rounds 1 and 2"
    (each reviewer's summary, linking a review), then "QA: failed in QA
    rounds 1 and 2" (QA's summary and steps to reproduce, linking its
    comment).
  - **Reviewers against QA:** "QA: failed in QA round 1" first, then
    "Reviewers: changes requested in round 2" (their summaries and blocking
    comments).

  Each text is cut to 1,500 characters. Positions are redacted, as titles
  and links are, before they are stored or sent.
- **On the Notice Board** (`NoticeItem`, so also the phone's 2D Office), the
  positions are a list of two cards. Using a container query, they sit side
  by side wherever the Notice is at least 28rem wide, and one above the other
  where it is narrower. Each card is headed by its label, which links to
  where that side said it.
- **Precedence.** The caps come first: QA's Round Cap, then the overall cap,
  then a conflict when QA fails. When a review round has blocking comments,
  the Round Cap comes first, then a conflict, then the stall rules. The new
  outcomes are `"conflict"` in `QaOutcome` and `RoundOutcome`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (2469 passed, 307 skipped).
- [x] **Scenario test: the conflict escalates instead of looping.**
      `packages/orchestrator/src/review/conflict-loop.test.ts` runs end to end
      through the same harness as the Review Loop and QA scenarios: intake,
      the work queue, the real coder and QA flows with real Sandcastle
      `run()` in the fake sandbox (scripts stand in for Claude Code), a local
      bare repository as GitHub's remote, and the real reviewer flow with a
      fake model for two required reviewers.
  - **QA against the reviewers:** QA fails the same way every time, and the
    reviewers were given three approvals each, so they would approve every
    round. The loop stopped after two rounds of each:
    - the coder ran twice, not a third time;
    - the work ended `needs-code`, `needs-review`, `needs-qa`, twice over;
    - only QA's first failure was handed back to the coder;
    - the issue and the pull request are `needs-human`.

    There is one action Notice, with the title above. It links Review round
    1, QA round 1, Review round 2 and QA round 2 (QA's comments), and its
    `positions` are exactly the reviewers' approval (both summaries, linking
    Grace's round 2 review), then QA's failure (summary and steps, linking
    its round 2 comment).
  - **Reviewers against QA:** round 1 approves and QA fails it. The coder's
    fix changes `src/basket.ts`, and in round 2 Grace blocks that change.
    The coder ran twice, QA once, nothing was queued after round 2, and the
    issue and the pull request are `needs-human`. There is one Notice, "…in
    round 2, the reviewers rejected the fix QA required of PR #2 (#1) in QA
    round 1.". Its positions are QA's failure first, then Grace's blocking
    comment.
  - **Not a conflict:** after a QA failure, a blocking comment on the
    README, which the fix did not touch, is the Review Loop's own business.
    The coder fixes it, QA passes, the issue reaches `ready-to-merge`, and
    no action Notice is raised.
  - **Mutation checks** (each reverted):
    - turning off the QA-against-reviewers rule failed only that scenario;
    - turning off the reviewers-against-QA rule failed only that scenario;
    - dropping the requirement that QA's failure repeats failed only QA's
      Round Cap scenario, where QA finds something new each round;
    - counting any blocking comment after a QA failure failed only the
      "not a conflict" scenario;
    - checking the conflict before the caps failed the overall-cap
      scenario (run against `qa-loop.test.ts`, where it was the only
      failure), in which the last two review rounds approved and QA's
      failure repeated.

Also covered:

- `review/conflict.test.ts`: each rule's edges, including:
  - the same failure in other words;
  - QA's first round, or a pass before;
  - a reviewer asking for changes in either round;
  - a new finding;
  - half of the blocking comments on the fix, which is not most;
  - no QA failure, or a previous round that asked for changes;
  - the titles, the positions in order, and cutting long text.
- `notices/notices.test.ts`:
  - a Notice keeps its two positions in order (in memory; the same case runs
    on Postgres in CI);
  - a credential in a position's label, text or URL is redacted;
  - a third position, or one with a non-web URL, is refused.
- `notices/routes.test.ts`: the API sends `positions`.
- `notice-board.test.tsx`: a conflict's two positions as a two-column list,
  each headed by its label (linked when it has a URL), and none on a Notice
  that is not a conflict.

## Not verifiable in this sandbox

- **Postgres** (Docker): migration `0035_notice_positions` applied to
  Postgres 18, and the Postgres runs of the Notice store and API tests, are
  skipped here with the reason. The migration was written by `drizzle-kit
  generate` from `schema.ts`.
- **How the two columns look**, in a browser and in the 3D Office's Notice
  Board panel. jsdom does no layout, so the test checks only that the
  container query's class is there. Playwright was not run for this slice.
- **Real reviewers and a real QA Agent** disagreeing on a real pull request,
  on real AI Accounts, with GitHub's real compare API (the contract suite's
  real App target is skipped without `GITHUB_APP_ID`, #18).

## Notes, and disagreements with the canon

- **§5 scenario 4** says that when QA keeps failing on a flaky test, "after
  the third round" the pull request is labelled `needs-human`. With FR-30 and
  this issue, a flaky test that QA fails the same way while every reviewer
  approves is a conflict at QA's second round. It reaches the Owner one
  round earlier, with both positions. QA's Round Cap of 3 is still reached
  when QA's failure is new each round, so its scenario test now gives QA a
  different finding each round. The test's assertions are unchanged; only
  its input changed, because its old input is exactly the conflict this
  issue asks for. That old input is now the first conflict scenario.
- **Why the failure must repeat.** Without that condition, any two QA
  failures in a row with approvals between them would be a conflict. Every
  path to QA's Round Cap passes through that, so QA's Round Cap could never
  be reached at the default caps. "Fails something every reviewer approved
  twice in a row" is read as the same thing failing twice.
- **The reviewers against QA escalate the first time,** not twice in a row.
  With the default Round Cap of 3, a second rejection in a row would come in
  round 3, where the Round Cap already escalates. To count only a rejection
  of what QA required, the blocking comments must be mostly on what the fix
  changed. This rule cannot tell a principled objection from a bug in the
  fix; the Decision Model (#109, out of scope; FR-17) could judge that.
- **Thresholds are fixed in code**, as the stall rule's are: the 60% word
  similarity and "more than half" are `repeatSimilarity` and `repeatShare`
  from `stall.ts`.
- **No one-click action** on the Notice. FR-48 lists none that fits ("approve
  and merge" would bypass the Merge Policy), and the cap Notices have none
  either. The Owner decides on GitHub and moves the issue out of
  `needs-human`, as for any escalation.

## Noticed, out of scope

- **ADR 0003** renames `needs-code` to `needs-work`, but the code still uses
  `needs-code`, as earlier notes say.
- **Escalations are not Manager decisions.** Caps, stalls and conflicts
  escalate in plain code without a `manager.decision` event or a comment on
  the issue. The Activity Feed shows them only as the `needs-human` label
  change and the Notice. FR-23 says every Manager decision is logged on the
  issue; whether these count as the Manager's is not settled.

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
 Test Files  205 passed (205)
      Tests  2469 passed | 307 skipped (2776)
```

The new and changed tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > qaConflictOf > finds QA failing, as before, what every reviewer approved twice in a row
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > qaConflictOf > finds none in QA's first round, or when QA passed the round before
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > qaConflictOf > finds none when a reviewer asked for changes in either of the last two rounds
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > qaConflictOf > finds none when QA found something new: that is the coder's to fix
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > reviewConflictOf > finds the reviewers rejecting the coder's fix for what QA required
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > reviewConflictOf > finds none when the blocking comments are mostly elsewhere: half is not most
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > reviewConflictOf > finds none unless the previous round approved and QA then failed it
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > describeConflict > says who disagrees, about what, for the Notice's title
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > conflictPositions > puts the reviewers' approval first, then QA's failure with its steps
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > conflictPositions > puts QA's failure first, then the reviewers' blocking comments on the fix
 ✓ |@ai-office/orchestrator| src/review/conflict.test.ts > conflictPositions > cuts what a side said to what a Notice holds
 ✓ |@ai-office/orchestrator| src/review/conflict-loop.test.ts > conflicts between Roles > escalates, instead of looping, when QA fails again what every reviewer approved twice in a row
 ✓ |@ai-office/orchestrator| src/review/conflict-loop.test.ts > conflicts between Roles > escalates when the reviewers reject the coder's fix for what QA required
 ✓ |@ai-office/orchestrator| src/review/conflict-loop.test.ts > conflicts between Roles > keeps looping when the reviewers' blocking comments after a QA failure are on something else
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > hands the pull request to the Owner at QA's Round Cap
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > hands the pull request to the Owner at the overall cap on its rounds of review and QA
 ✓ |@ai-office/orchestrator| src/notices/notices.test.ts > Notices, kept in memory > keeps a conflict's two positions, in order
 ✓ |@ai-office/orchestrator| src/notices/notices.test.ts > Notices, kept in memory > never stores or publishes a credential in a title, link or position
 ↓ |@ai-office/orchestrator| src/notices/notices.test.ts > Notices, kept in Postgres 18 > keeps a conflict's two positions, in order 0ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ↓ |@ai-office/orchestrator| src/notices/notices.test.ts > Notices, kept in Postgres 18 > never stores or publishes a credential in a title, link or position 0ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/orchestrator| src/notices/notices.test.ts > raising a Notice > shows at most two positions, the two sides of a conflict
 ✓ |@ai-office/server| src/notices/routes.test.ts > the Notice API, in memory > lists the open Notices of every Floor, or of one
 ↓ |@ai-office/server| src/notices/routes.test.ts > the Notice API, in Postgres 18 > lists the open Notices of every Floor, or of one 2ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/web| src/notice-board.test.tsx > the Notice Board > lists every Floor's open Notices with their links and actions
 ✓ |@ai-office/web| src/notice-board.test.tsx > the Notice Board > shows a conflict between Roles with both positions side by side
```
