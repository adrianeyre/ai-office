# Issue #57: QA Agent stage and per-PR caps — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commits (`db0f277` to
`e500603`).

## What was built

- **The QA flow** (`createQaFlow`, `packages/orchestrator/src/qa/qa.ts`;
  PRD FR-19, FR-28). Work at `needs-qa` is done by the Floor's QA Agent
  (the work queue already assigned `needs-qa` work to the `qa` Role) in a
  sandbox on the pull request's branch (the runner carries on from the
  pushed branch):
  - it holds the issue, takes the reviewers' Handoff (emitted as a
    `handoff` event to the QA Agent, and quoted in its prompt);
  - its prompt (`qaPrompt`) asks it to run the Floor's test command (or
    find the checks when there is none), add tests where the change has
    none and commit them without changing the code under test, and, when
    the repository has a web UI, exercise it with Playwright; and to end
    with a `<qa-report>` block (`Result: pass|fail`, `Summary:`, `Steps:`),
    read by `parseQaReport`;
  - the tests it committed are pushed by AI Office as the Owner's commits
    with its `Agent:` trailer (`createPushRun`, now shared with the coder
    flow), and the App comments the result on the pull request ("**QA
    passed**"/"**QA failed** by …, QA round N of 3", the summary, tests
    added, and the steps to reproduce);
  - each round is kept in `qa_reports` (migration `0028_qa_reports`) and
    recorded as a `qa.reported` event, which the Activity Feed shows with a
    link to the comment.
- **Pass** moves the issue on (`stageAfter`): to `needs-docs` when the Floor
  has a docs Agent (queued), otherwise `ready-to-merge`, with QA's Handoff
  kept for the next stage.
- **Fail** goes back to `needs-code` as a Handoff to the coder (what failed,
  how to reproduce it, rounds of QA left); the coder's next prompt has a "QA
  feedback to fix" section quoting what QA found and the steps; its fix is
  reviewed again (a new round), then checked by QA again.
- **Caps** (`qa/caps.ts`): QA's own Round Cap is 3; the overall cap per
  pull request counts rounds of review and QA together and is the Floor's
  Round Cap plus QA's minus one (5 by default). A QA failure at either
  escalates as the Round Cap does (`createEscalation`): `needs-human` on the
  issue and the pull request, and an action Notice ("QA Round Cap reached:
  …" or "Overall cap reached: …") linking every round of review and QA in
  order.
- **Review approval** now queues QA's work, and skips QA (to `needs-docs` or
  `ready-to-merge`) on a Floor without a QA Agent.
- No QA result: an action Notice "Agent blocked: … gave no QA result on PR
  #N", the issue is let go at `needs-qa`. A QA Agent paused at a Token Cap
  keeps what it committed and its work waits, as the coder's does.
- `IssueComment.htmlUrl` (GitHub client, fake and served fake), for the
  comment links.
- The pipeline's scenario harness (`src/work/scenario.ts`, for tests) runs
  intake, the coder, the reviewers and QA from one work queue; the Review
  Loop scenarios use it too.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (1341 passed, 243 skipped).
- [x] **Scenario tests: QA pass advances; QA fail returns to coder; overall
      cap escalates.** `packages/orchestrator/src/qa/qa-loop.test.ts`, end
      to end through real Sandcastle `run()` in the fake sandbox (scripts
      stand in for the coder's and the QA Agent's Claude Code) and a local
      bare repository as GitHub's remote:
  - **QA pass advances:** both reviewers approve; QA adds a test and
    passes. Checked: QA's prompt (QA round 1 of at most 3, `pnpm test`,
    adding tests, Playwright, the pull request's branch, the reviewers'
    Handoff, `<qa-report>`); its test commit is on the branch after the
    coder's, with QA's `Agent:` trailer; one comment "**QA passed** by …
    Tests added: 1 commit"; a `qa.reported` pass event linking it; the
    issue at `ready-to-merge` through `needs-review → needs-qa →
    ready-to-merge`; the `handoff` events coder → reviewers → QA; QA's
    Handoff kept for `ready-to-merge`; no action Notice.
  - **QA fail returns to coder:** QA fails in round 1 and passes in round
    2. The coder ran twice; its second prompt has "QA feedback to fix
    (after QA round 1 of 3)", what QA found, the steps, QA's Handoff ("2
    rounds of QA are left …") and no review feedback; QA's second prompt
    says round 2; comments "QA failed" (with "Steps to reproduce") then
    "QA passed"; the stages `needs-qa → needs-code → needs-review →
    needs-qa → ready-to-merge`; one Handoff QA → coder; no action Notice.
  - **Overall cap escalates:** review round 1 asks for changes; round 2
    approves and QA fails; round 3 approves and QA fails again: five
    rounds, neither the Round Cap nor QA's reached. The issue and the pull
    request are `needs-human`; one Notice "Overall cap reached: PR #2 (#1)
    still fails after 5 rounds of review and QA." linking Review round 1
    (the review asking for changes), Review round 2, QA round 1 (its
    comment), Review round 3, QA round 2.
  - Also: **QA's Round Cap** (three failures → "QA Round Cap reached: PR #2
    (#1) still fails QA after 3 rounds.", six rounds linked); **a Floor
    without a QA Agent** goes `needs-review → ready-to-merge`; **no
    report** blocks with a Notice and leaves the issue at `needs-qa`.
  - **Mutation checks** (each reverted): making the overall cap one larger
    failed only the overall-cap scenario; treating every result as a pass
    failed the fail, QA-cap and overall-cap scenarios.

Also covered: `qa/report.test.ts` (the last block, multi-line parts, "none"
steps, no block or no result, cut parts), `qa/prompt.test.ts` (no test
command, quoting of the issue and the Handoff, the Owner's instructions),
`qa/caps.test.ts` (the caps, counting rounds, links in order and the latest
ten), `coder/prompt.test.ts` (the QA feedback section, quoted),
`review/handoff.test.ts` (the coder's Handoff after a QA fix),
`progress/progress.test.ts` (the QA outcome), `pipeline.test.ts`
(`stageAfter`, each a legal move), `review/store.test.ts` (QA's results,
one per round), the events schema (`qa.reported`), the Activity Feed text,
and the GitHub contract (a comment's `htmlUrl`, in memory and over HTTP).

### Verified on the host

- [ ] **A real QA run on `ai-office-sandbox` runs its tests and comments the
      result.** Not verifiable here: it needs the GitHub App and the
      `ai-office-sandbox` repository (#18), Docker for the sandbox image,
      and a real AI Account for Claude Code. Nothing here was faked to stand
      in for it.

## Not verifiable in this sandbox

- **Postgres** (Docker): the Postgres run of the Review Loop store test
  (now with `qa_reports`) and migration `0028_qa_reports` applied to
  Postgres 18 are skipped here with the reason. The migration was written by
  `drizzle-kit generate` from `schema.ts`.
- **Docker sandboxes and a real agent tool:** the QA Agent really running
  the test command, writing tests and driving Playwright in the sandbox
  image (which does not install Playwright's browsers; the prompt suggests
  `pnpm dlx playwright`).
- **Real GitHub:** the real comment's `html_url` (the contract suite's real
  App target is skipped without `GITHUB_APP_ID`).

## Notes, and disagreements with the canon

- **QA's Round Cap and the overall cap are not Floor settings.** FR-7 lists
  only the Round Cap among a Floor's settings, so QA's cap is fixed at 3,
  the Round Cap's default, and the overall cap follows the Floor's Round
  Cap (Round Cap + 3 − 1).
- **Where the overall cap applies.** It is checked when QA fails. A review
  round sends work back only below the Round Cap, and QA has failed at most
  twice by then, so a review can never reach the overall cap first; a check
  there would never fire, so there is none.
- **Review rounds keep counting across QA.** After a QA failure the coder's
  fix starts a new review round numbered after the last, so the Round Cap
  counts every review of the pull request, as before.
- **"When the repository has a web UI"** is the QA Agent's judgement from
  the repository, as its prompt says; AI Office does not detect it.
- **Tests QA adds are not reviewed again** before the issue moves on; the
  Merge Policy (a later issue) decides what happens at `ready-to-merge`.
- **Role conflicts** (QA rejecting what reviewers approved, FR-30) are #59:
  here a QA failure simply returns to the coder, within the caps.
- **ADR 0003** renames `needs-code` to `needs-work`; the code still uses
  `needs-code`, as before this issue.

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
 Test Files  137 passed (137)
      Tests  1341 passed | 243 skipped (1584)
```

The new and changed tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ |@ai-office/orchestrator| src/qa/caps.test.ts > the caps beyond the Round Cap > give QA a Round Cap of 3, and a pull request one fewer than both caps' rounds
 ✓ |@ai-office/orchestrator| src/qa/caps.test.ts > the caps beyond the Round Cap > count each round of review once, and each round of QA
 ✓ |@ai-office/orchestrator| src/qa/caps.test.ts > the caps beyond the Round Cap > link each round, oldest first, preferring a review that asked for changes
 ✓ |@ai-office/orchestrator| src/qa/caps.test.ts > the caps beyond the Round Cap > link only the latest ten rounds
 ✓ |@ai-office/orchestrator| src/qa/report.test.ts > parseQaReport > reads the last <qa-report> block's result, summary and steps
 ✓ |@ai-office/orchestrator| src/qa/report.test.ts > parseQaReport > keeps no steps for a pass, or for none given
 ✓ |@ai-office/orchestrator| src/qa/report.test.ts > parseQaReport > finds no report without a block, or without a pass or fail
 ✓ |@ai-office/orchestrator| src/qa/report.test.ts > parseQaReport > cuts long parts
 ✓ |@ai-office/orchestrator| src/qa/prompt.test.ts > qaPrompt > asks for the tests, missing tests, a web UI with Playwright, and a report
 ✓ |@ai-office/orchestrator| src/qa/prompt.test.ts > qaPrompt > asks it to find the checks when the Floor names no test command
 ✓ |@ai-office/orchestrator| src/qa/prompt.test.ts > qaPrompt > quotes the issue and the reviewers' Handoff so neither can close its quote
 ✓ |@ai-office/orchestrator| src/coder/prompt.test.ts > the coder's prompt > gives what QA found failing and its Handoff when QA sent the work back, quoted
 ✓ |@ai-office/orchestrator| src/progress/progress.test.ts > progress comments > says what QA found, and where the issue went
 ✓ |@ai-office/orchestrator| src/pipeline/pipeline.test.ts > stageAfter > goes on to QA, then docs, then ready-to-merge, skipping a stage the Floor has no Agent for
 ✓ |@ai-office/orchestrator| src/review/store.test.ts > the Review Loop's store > in memory keeps verdicts by round, one per reviewer, QA's results, and the latest Handoff to each stage
 ↓ |@ai-office/orchestrator| src/review/store.test.ts > the Review Loop's store > in Postgres 18 keeps verdicts by round, one per reviewer, QA's results, and the latest Handoff to each stage 3ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > advances a pull request whose checks pass, with the tests QA added pushed and the result commented
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > sends blocking comments back to the coder with a Handoff, and moves on to QA when round 2 approves
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > returns a failing pull request to the coder with the steps that reproduce it, then advances when QA passes
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > hands the pull request to the Owner when round 3, the Round Cap, still has blocking comments
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > escalates at round 2, before the Round Cap, when its blocking comments repeat round 1's
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > escalates early when the fix between rounds barely changes the diff
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > hands the pull request to the Owner at QA's Round Cap
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > approves on nits alone, without sending the work back
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > hands the pull request to the Owner at the overall cap on its rounds of review and QA
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > is skipped on a Floor without a QA Agent
 ✓ |@ai-office/orchestrator| src/qa/qa-loop.test.ts > QA > blocks, leaving the issue at needs-qa, when QA gives no result
 ✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > covers Floor, Agent, issue, sandbox, branch, pull request, review, QA, Handoff, model call, Notice, cap, AI Account, config and sign-in events
 ✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > parses a qa.reported event
 ✓ |@ai-office/web| src/activity-feed.test.tsx > event text > says what QA found, and links its comment on GitHub
 ✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > comments on an issue, and lists the comments oldest first
 ✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > comments on an issue, and lists the comments oldest first
 ↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > comments on an issue, and lists the comments oldest first
```
