# Issue #56: Early escalation of stalled Review Loops — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commits.

## What was built

- **Stall rules** (`packages/orchestrator/src/review/stall.ts`, PRD FR-28).
  From round 2, a round that still has blocking comments, below the Round
  Cap, has stalled when:
  - **its blocking comments mostly repeat the previous round's**: more than
    half (`repeatShare`, 0.5) of them repeat one of the previous round's
    blocking comments, meaning on the same file with a word similarity
    (Jaccard, lower-cased, punctuation ignored) of at least 0.6
    (`repeatSimilarity`); or
  - **the diff between rounds is below a size threshold**: the coder's fix,
    from the previous round's head commit to this round's, adds and deletes
    fewer than 3 lines in all (`minFixLines`; a one-line edit counts 2).
- **Escalation is the same as reaching the cap** (`createEscalation`, in
  `review/escalation.ts`, now used for both): the issue moves to
  `needs-human`, its pull request is labelled `needs-human`, and an action
  Notice links each round. Its title states the reason, such as "Review
  Loop stalled: PR #2 (#1) escalated at round 2 of 3: its blocking comment
  repeats round 1's." or "…: the fix since round 1 changed only 2 lines,
  and blocking comments remain." The round's outcome is `stalled`; no
  Handoff goes back to the coder.
- **The diff between rounds** comes from GitHub's compare API:
  `RepositoryClient.compareCommits(base, head)` lists the files that differ,
  with each one's added and deleted lines. It is implemented by the App
  client (`GET /repos/{owner}/{repo}/compare/{base}...{head}`), the fake
  GitHub (by the smallest line diff, so counts match GitHub's), and the fake
  served over HTTP.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (1319 passed, 243 skipped).
- [x] **Scenario tests: repeated comments escalate at round 2; a tiny diff
      escalates.** In `packages/orchestrator/src/review/loop.test.ts`, the
      whole loop (intake → work queue → real coder flow with real
      Sandcastle `run()` in the fake sandbox and a local bare repository as
      GitHub's remote → reviewer flow with a fake model for two required
      reviewers):
  - **Repeated comments escalate at round 2:** a reviewer sends the same
    blocking comment in rounds 1 and 2 (reworded punctuation). The coder
    ran twice, not a third time; the issue is `needs-human` and the pull
    request has `needs-human`; one action Notice, "Review Loop stalled: PR
    #2 (#1) escalated at round 2 of 3: its blocking comment repeats round
    1's.", links Round 1 and Round 2 (that reviewer's reviews); one Handoff
    back to the coder only; four work items, all finished.
  - **A tiny diff escalates:** the coder's second run changes one line (2
    lines of diff), and round 2 has a new, different blocking comment. The
    issue and pull request are `needs-human`, with the one Notice "Review
    Loop stalled: PR #2 (#1) escalated at round 2 of 3: the fix since round
    1 changed only 2 lines, and blocking comments remain.", linking both
    rounds.
  - The existing scenarios still pass: approval at round 2, the Round Cap of
    3 with different comments and real fixes each round (not escalated
    early), and nits alone approving.
  - **Mutation checks** (each reverted): turning off the repeat rule failed
    only the repeated-comments scenario; turning off the tiny-diff rule
    failed only the tiny-diff scenario.

Also covered:

- `review/stall.test.ts`: word similarity; most (2 of 3) repeating stalls,
  half does not; the same words on another file, or repeating an earlier
  nit, are not repeats; the size threshold's edge (2 stalls, 3 does not);
  no stall without blocking comments; the reasons as the Notice says them.
- `packages/github/src/contract.test.ts`: comparing two commits (one file
  added between them; two from the base; none from a commit to itself),
  against the in-memory fake and the App client over HTTP;
  `fake.test.ts`: modified and removed files counted by the smallest diff,
  and a 404 for an unknown commit.

## Not verifiable in this sandbox

- **Real GitHub:** the contract suite's compare test against the real App
  on `ai-office-sandbox` is skipped without `GITHUB_APP_ID` (#18). It was
  checked only against the fake, which follows GitHub's documented compare
  response (`files[].filename`, `status`, `additions`, `deletions`).
- **Real reviewers** on real AI Accounts repeating themselves in a real
  Review Loop.

## Notes, and disagreements with the canon

- **Thresholds are fixed in code**, not Floor settings: FR-7 lists the Round
  Cap as a Floor setting, not these. They are exported constants in
  `stall.ts`.
- **The Decision Model is not used** (FR-17 asks it "Is this Review Loop
  stalled or repeating?" when it is configured): that is #109, out of
  scope. These are the deterministic rules FR-17 falls back to.
- **At the Round Cap**, a round that would also count as stalled is
  reported as "Round Cap reached", the harder limit.
- **Compare limits:** GitHub's compare API lists at most 300 files, so a fix
  touching more is counted from those 300, far above the threshold anyway.

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
 Test Files  133 passed (133)
      Tests  1319 passed | 243 skipped (1562)
```

The new and changed tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > commentSimilarity > is the share of words two comments share, ignoring case and punctuation 3ms
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > stallOf > finds a round whose blocking comments mostly repeat the previous round's 2ms
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > stallOf > does not count half, nits, or the same words on another file 1ms
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > stallOf > finds a fix that barely changed the diff 0ms
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > stallOf > finds no stall in a round without blocking comments 0ms
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > changedLines > adds up each file's added and deleted lines 0ms
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > describeStall > says why, for the Notice 0ms
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > sends blocking comments back to the coder with a Handoff, and moves on to QA when round 2 approves 528ms
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > hands the pull request to the Owner when round 3, the Round Cap, still has blocking comments 645ms
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > escalates at round 2, before the Round Cap, when its blocking comments repeat round 1's 428ms
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > escalates early when the fix between rounds barely changes the diff 395ms
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > approves on nits alone, without sending the work back 227ms
 ✓ |@ai-office/github| src/fake.test.ts > the fake GitHub's scenario API > compares two commits by the smallest diff of each file's lines 2ms
 ✓ |@ai-office/github| src/fake.test.ts > the fake GitHub's scenario API > keeps each commit's files, and compares a pull request's branches 3ms
 ✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > compares two commits, counting each file's lines 1ms
 ✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > compares two commits, counting each file's lines 8ms
 ↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > compares two commits, counting each file's lines
```
