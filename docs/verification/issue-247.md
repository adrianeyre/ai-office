# Issue #247: [fix] P1-1 — The Merge Policy merges commits made after the reviewers approved (QA's, the designer's, docs'), so on an auto-merge Floor they reach the default branch unreviewed — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`e64ecc6`,
`fix(security): P1-1 the Merge Policy merges only a head every required reviewer approved`,
on top of `1bb3183`. Its blocker, the P1 probe (#194), is in the tree:
`docs/pen-testing/assessments/P1.md` and
`packages/orchestrator/src/merge/merge.pen-test.test.ts`.

This is the remediation of finding **P1-1** (`severity:high`, H8). P1-2
(#249) and P1-3 (#251) were fixed in the same run, in the same gate, on
top of this commit.

## What was fixed

On an auto-merge Floor the gate (`heldBack` in `merge/gate.ts`) asked
whether every required reviewer approved in the latest round of the
Review Loop. It never asked which head they approved. QA's tests, the
designer's fixes and the docs Agent's changes are all pushed after the
approval, and the App merged them with no reviewer having seen them.
CI, the gate's other layer, runs what those commits say.

**An approval now counts only for the head it merges:**

- `GateInput` has a required `head`, the head commit the App would merge.
  `approvedBefore` names the required reviewers who approved in the latest
  round but at another head. `heldBack` holds the pull request back for
  them: "commits were pushed after Grace and Quinta approved it".
- **The commits after it are reviewed too.** When that is all that stands
  in the way, and the Review Loop has a round left (`roundLeft`: within
  the Round Cap and the overall cap of review and QA), the Merge Policy
  sends the issue back to `needs-review` and queues its reviewers' work.
  The reviewers get the Handoff that brought the issue to `ready-to-merge`
  (the docs Agent's, QA's or the designer's), re-addressed to them.
  Every required reviewer reviews the head in a new round.
- **Their approval brings it straight back to `ready-to-merge`.** QA and
  docs have passed already, and the new commits are theirs. The review
  flow knows the round was the Merge Policy's because the issue's latest
  move to `needs-review` in the Activity Feed came from `ready-to-merge`
  (`sentBackToReview`). Blocking comments send it to the coder as usual,
  and the fix goes through review, QA and docs again.
- **With no round left**, the pull request goes to the Owner with an
  action Notice: "PR #2 awaiting your approval: not merged automatically,
  as commits were pushed after Grace approved it."
- **A head pushed while CI ran** on the approved one is judged afresh,
  gate and all, before the App merges. The merge itself still names the
  head it was judged on (`sha`), so a later push is refused (409) and goes
  to the Owner.
- The pipeline allows one new move, `ready-to-merge → needs-review`
  (`transitions`). Nothing else can make it: `ready-to-merge` still cannot
  move to `needs-work`, `needs-qa` or `needs-docs`.

`createMergeFlow` takes the pipeline and the work queue (`pipeline`,
`queue`). The server and the test scenario pass both. Without a
pipeline it makes its own from `github` and `events`.

### Sibling paths with the same flaw, fixed and tested

- **The Owner's `ai-office:auto-merge` label on a "send to me" Floor**
  goes through the same gate, so a later commit goes back to review there
  too. Tested: "P1-1: the Owner's ai-office:auto-merge label on a
  send-to-me Floor goes through the same gate".
- **A head pushed while the gate waited for CI.** Before the fix, the
  gate's reviewer conditions were checked once, before the wait, against
  whatever head the pull request had then. Tested: "P1-1: a head pushed
  while CI ran on the approved one is judged afresh, and goes back to its
  reviewers".
- **The stall rule.** A round the Merge Policy sent back follows an
  approval, not a fix of blocking comments. Without this, the "fix since
  round 1 changed only 1 line" rule escalated the first blocking comment
  on QA's one-line test to the Owner as a stalled loop. The rule is not
  applied to such a round. Tested end to end: "P1-1, end to end: a
  second round that asks for changes › sends the fix through QA again
  before the App merges it".

## Decisions

- **Review again, rather than always going to the Owner.** The finding
  allows either. Sending every such pull request to the Owner would stop
  auto-merge on any Floor whose QA Agent adds a test or whose docs Agent
  writes anything, which is most of them. The probe's own end-to-end test
  also asks for a merge whose head the reviewers approved, which only a
  second review gives. So the reviewers review the later commits, and the
  Owner gets the pull request only when the Review Loop has no round left.
- **A new pipeline move, `ready-to-merge → needs-review`.** The pipeline
  test listed it among the illegal moves. It is now among the legal ones,
  and `ready-to-merge → needs-qa` and `→ needs-docs` were added to the
  illegal list in its place. That changes the specification the test
  states, it does not weaken it. PRD FR-18's pipeline and the README's
  one-line summary of it do not show the move back; neither was changed,
  as the PRD is canon. The guide's diagram and text show it
  (`docs/guide/issue-pipeline.md`).
- **After the second round's approval, QA and docs are not run again.**
  The commits under review are QA's and docs' own. Running them again
  would push more commits and need another review. A fix after blocking
  comments goes through every stage again, as before.
- **How the review flow knows the round was the Merge Policy's.** It reads
  the issue's latest `issue.label_changed` to `needs-review` from the
  Activity Feed. When retention has deleted it, the round is treated as
  any other and QA and docs run again: slower, never less safe. Adding a
  marker to the stored Handoff or the work item would need a schema
  change, and this needs none.
- **The Handoff the reviewers get** is the one that brought the issue to
  `ready-to-merge`, re-addressed to `needs-review`. It describes the later
  commits in their author's words and is quoted as untrusted, as every
  Handoff is.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** Both are
      `it`s, and both pass:
      "is never merged by policy: the gate merges only a head every
      required reviewer approved" (body unchanged), and "end to end: on an
      auto-merge Floor, everything merged was a head the reviewers
      approved" (body unchanged). Their shared helper,
      `mergedAfterQaAndDocs`, now gives each reviewer a second `approve()`.
      The fix asks the reviewers to review the later commits, and the fake
      model has no answer for a request nobody scripted. The assertions are
      as the probe wrote them.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
      - *"pins today: the App merges the new head, which no reviewer saw,
        once CI passes on it"* is now "regression (P1-1): the App no longer
        merges a new head no reviewer saw, though CI passed on it; it goes
        back to its reviewers". It asserts the pull request is not merged,
        the issue is at `needs-review` with the reviewers' work queued, and
        no Notice was raised.
      - *"pins today, end to end: QA's test and the docs Agent's commit are
        merged by the App, though no reviewer saw either"* is now
        "regression (P1-1), end to end: QA's test and the docs Agent's
        commit are reviewed before the App merges them". It asserts rounds
        `[1, 1, 2, 2]`, and that round 2 reviewed the merged head, which
        holds `test: the basket, QA round 1` and `docs: the basket`. It
        also asserts that QA and docs each ran once, and that the moves
        ended `needs-docs → ready-to-merge → needs-review →
        ready-to-merge`.

      No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above, plus `gate.test.ts` ("holds back a pull request whose head is
      not the one its reviewers approved (P1-1)", "knows whether the
      Review Loop has a round left") and "P1-1: with no round left in the
      Review Loop, it goes to the Owner, saying why".
- [x] **The assessment's findings table marks `P1-1` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #247), with
      the commit's subject (the hash is filled at merge). The probe table
      in `docs/pen-testing/README.md` was not edited, as the brief asks.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` has two failures, both in
      `@ai-office/web`, both failing before this fix and outside it (see
      below).

## Real output of the checks

The three checks were run on the branch head after all three fixes
(`31c1963`).

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: two failures, both already failing before these fixes, neither in them

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/

 Test Files  2 failed | 442 passed (444)
      Tests  2 failed | 4912 passed | 42 expected fail | 603 skipped (5559)
   Duration  253.29s (tests 66%, import 22%, transform 6%, environment 5%, setup 1%)
test exit 1
```

- **The two `@ai-office/web` failures** are the ones #205 and #245
  recorded. The root `CHANGELOG.md`'s top entry is `## 1.0.0` with no
  release date. None of these fixes touches it or `apps/web`. The same
  two failed in a run at `1bb3183`, before any fix:
  `Tests  2 failed | 4877 passed | 54 expected fail | 603 skipped (5536)`.
- **Expected fails went from 54 to 42**: the twelve `it.fails` of P1-1
  (2), P1-2 (4) and P1-3 (6) are now `it`s. The 42 left are other
  probes' open findings.
- **The cross-reference test passes.** `merge.pen-test.test.ts` and
  `corpus.pen-test.test.ts` now hold no `it.fails`, and the test needs no
  reference for those.
- **The skips** are the Postgres and Docker tests, skipped with their
  reason in this sandbox.

No test was skipped, deleted or weakened to reach this state.

### The probe and the gate on their own (P1-1's tests)

```
# vitest run merge.pen-test.test.ts gate.test.ts pipeline.test.ts --reporter=verbose
✓ gate.test.ts > the Merge Policy's gate > holds back a pull request whose head is not the one its reviewers approved (P1-1)
✓ gate.test.ts > the Merge Policy's gate > knows whether the Review Loop has a round left
✓ pipeline.test.ts > the pipeline's transitions > go forward through the stages, back to code, back to review from ready-to-merge, or out to a human
✓ pipeline.test.ts > the pipeline's transitions > refuse skipping review, going backwards, standing still or leaving needs-human
✓ merge.pen-test.test.ts > P1-1: a commit made after the reviewers approved > is never merged by policy: the gate merges only a head every required reviewer approved
✓ merge.pen-test.test.ts > P1-1: a commit made after the reviewers approved > regression (P1-1): the App no longer merges a new head no reviewer saw, though CI passed on it; it goes back to its reviewers
✓ merge.pen-test.test.ts > P1-1: a commit made after the reviewers approved > P1-1: with no round left in the Review Loop, it goes to the Owner, saying why
✓ merge.pen-test.test.ts > P1-1: a commit made after the reviewers approved > P1-1: a head pushed while CI ran on the approved one is judged afresh, and goes back to its reviewers
✓ merge.pen-test.test.ts > P1-1: a commit made after the reviewers approved > P1-1: the Owner's ai-office:auto-merge label on a send-to-me Floor goes through the same gate
✓ merge.pen-test.test.ts > P1-1: a commit made after the reviewers approved > end to end: on an auto-merge Floor, everything merged was a head the reviewers approved
✓ merge.pen-test.test.ts > P1-1: a commit made after the reviewers approved > regression (P1-1), end to end: QA's test and the docs Agent's commit are reviewed before the App merges them
✓ merge.pen-test.test.ts > P1-1, end to end: a second round that asks for changes > sends the fix through QA again before the App merges it
✓ merge.pen-test.test.ts > what holds in the Merge Policy > an ai-office:auto-merge label someone else added does not merge on a send-to-me Floor
✓ merge.pen-test.test.ts > what holds in the Merge Policy > an ai-office:manual label, whoever added it, sends it to the Owner
✓ merge.pen-test.test.ts > what holds in the Merge Policy > a send-to-me Floor never merges without the Owner, however the Review Loop went
```

The whole `@ai-office/orchestrator` project passed on its own after this
commit, before P1-2's: `Test Files  144 passed (144)`,
`Tests  1391 passed | 28 expected fail | 281 skipped (1700)`.

## What could not be verified here

- **GitHub itself.** The fake GitHub stands in for it. That GitHub
  refuses a merge whose head is no longer the `sha` given (a 409) is
  documented behaviour, and an existing merge test covers the fake's
  version of it. On the pen-test stack: an auto-merge Floor with a docs
  Agent should show a second review round on the pull request, of the
  docs commit, before the App's merge.
- **Live reviewers re-reviewing.** The second round's verdicts come from
  the fake model. That a real reviewer reads QA's test or the docs
  Agent's change and catches what it hides needs a live model, and is
  P1's subject (#194) more broadly.

## Noticed, out of scope

- **"Approve and merge" merges whatever the head is when the Owner
  clicks.** The Notice was raised for one head, and the App merges with no
  `sha`. The Owner is the human of last resort and decides on GitHub,
  which shows the current head. But nothing ties their click to the head
  the Notice named, and nothing in AI Office pushes after
  `ready-to-merge` today.
- **The stall rule's "tiny fix" after a QA failure.** When review
  approved, QA failed, and the coder's small fix draws a blocking
  comment, the fix is measured against the approved round as if it were
  a Review Loop fix. That is unchanged here; only the Merge Policy's
  second round is exempt.
- **P1-11 still applies to the second round.** A reviewer's prompt cuts
  the diff and the files at its limits, so the second round can approve a
  head it was not shown in full. That is P1-11's own remediation.
