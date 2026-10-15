# Issue #255: [fix] P1-5 — Intake's Owner label approves an issue's text, but the author can edit it afterwards and every Stage works the edit — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`db79155`,
`fix(security): P1-5 every Stage works the issue text the Owner approved`,
on top of P1-4's `e3ea51a` (#253). Its blocker, the P1 probe (#194), is
in the tree: `docs/pen-testing/assessments/P1.md` and
`packages/orchestrator/src/intake/intake.pen-test.test.ts`.

This is the remediation of finding **P1-5** (`severity:medium`, new).

## What was fixed

FR-8 makes the Owner's `ai-office` label the control on someone else's
issue. The label approved the text as the Owner read it. But anyone who
can edit the issue (on a private repository, a collaborator) could change
it afterwards, and every Stage read it afresh with `getIssue`. In the
probe, Mallory opens a benign issue, the Owner labels it, and Mallory
rewrites it. The coder, both reviewers and QA were all given the rewrite.

**Every Stage now works the text the Owner approved:**

- **GitHub gives an issue's versions.** `RepositoryClient.issueVersions`
  (`@ai-office/github`) answers each version of an issue's title and
  body, oldest first: as opened, then after each edit. Each has who wrote
  it, when, and whether the App did. GitHub's REST API keeps only the
  latest body, so the App client reads the history from GitHub's GraphQL
  API in one query. Body edits come from `userContentEdits`, the first of
  them the body as opened, and title changes from `RENAMED_TITLE_EVENT`
  timeline items. `toIssueVersions` builds the versions from the answer
  and never makes up what it does not know:
  - an edit deleted from the history, or older than the hundred GitHub
    gives, is `body: null`;
  - a history that does not end at the issue's current text gives that
    text to nobody known.

  The in-memory fake records each version, and its issue history now has
  a strictly increasing clock. The HTTP fake serves the GraphQL query.
  `editIssue` takes the editor (`actor`), and `forgetIssueVersion` stands
  in for a deleted edit.
- **The version the Owner approved** (`intake/approved.ts`) is the latest
  one that is either:
  - the Owner's own;
  - the App's, as for an issue AI Office filed for a chat request or a
    Grilling Session;
  - anyone's, written before the Owner's latest `ai-office` label.

  An edit by anyone else after that label is not approved until the
  Owner removes the label and adds it again. A version written in the
  same second as the label, or one GitHub no longer has, leaves nothing
  approved.
- **Every Stage is given it.** The server and the test scenario pass the
  coder, reviewer, QA, docs and designer flows a GitHub wrapped in
  `withApprovedIssues`. Its `getIssue` answers with the approved title and
  body (labels and state as GitHub has them now), or throws
  `UnapprovedIssueError`.
- The guide's intake section (`docs/guide/issue-pipeline.md`, "Only the
  text the Owner approved") says the same.

### Sibling paths with the same flaw, fixed and tested

- **The Manager's triage.** Intake gave it the issue as `listIssues` had
  it. Now it gets the approved text, and intake ignores an issue with
  none. Tested in `intake/approved.test.ts`.
- **Batches.** A Batch drafted its Plan and replanned from the issues'
  text read afresh, and triaged and started each issue from it. All of
  these now use the approved text. An issue with none is left out of the
  Plan, saying why. Tested in `batches.test.ts` ("P1-5: plans each issue
  from the text the Owner approved…").
- **The docs Agent and the designer**, which the assessment read from the
  code, use the same wrapped GitHub. The docs Agent is tested end to end:
  "P1-5: nor is the docs Agent given the edit".
- **An issue the Owner opened, edited by someone else.** The label was
  never the control there. Tested: "P1-5: nor are the Agents given an
  edit by someone else to an issue the Owner opened".
- **Issues the App filed** (chat requests, Grilling Sessions). The App's
  version is approved and an edit since is not. Tested in
  `approved.test.ts`.
- **The Owner still decides.** Labelling the issue again approves the
  edit: "P1-5: once the Owner labels it again, having read the edit, the
  edit is what the Agents work".

## Decisions

- **Agents work the approved version, rather than the issue leaving
  intake.** The property allows either. This one keeps the work going on
  what the Owner read, and the probe's `it.fails` asks for it: the coder
  is given the benign text. The other option (an edit takes the issue out
  of intake) still happens where no version can be told apart. Re-labelling
  is how the Owner approves an edit.
- **The Owner's and the App's own versions are always approved.** The
  Owner wrote theirs. The App writes an issue only for the Owner's chat
  request or Grilling Session, which already counted as the Owner's
  (ADR 0004, FR-81).
- **A version in the label's second is not approved.** GitHub's
  timestamps are to the second, so an edit made in the same second as the
  label cannot be put before or after it. Neither version is safe to
  assume, so nothing is approved until the Owner labels the issue again.
- **When a Stage meets an issue with no approved version, its work
  fails.** That piece of work ends `failed` in the work queue, as any
  thrown error does, and raises no Notice of its own. That only happens
  when an issue already in the pipeline loses its approved version (an
  edit in the label's second, or a deleted history), so it is rare.
  Intake and Batches, which come first, ignore such an issue or leave it
  out instead, saying why.
- **One GraphQL query per `getIssue` in a Stage.** That is one more call
  per Stage and issue. It needs no new App permission, since reading
  issues was already granted.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "is what
      the Agents work: an edit by the issue's author after the Owner
      labelled it is not worked" in `intake/intake.pen-test.test.ts` is an
      `it` and passes, with its body unchanged. Its setup function passes
      the editor to `editIssue` explicitly (`actor: "mallory"`, the
      fake's default for the issue's author anyway). It also gained
      options for the sibling tests, and the default does what it did
      before.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** The pin *"intake takes the
      issue on the Owner's label, and the coder, both reviewers and QA
      are given the author's later edit"* is now "regression (P1-5):
      intake still takes the issue on the Owner's label, but the coder,
      both reviewers and QA are given the text the Owner labelled, not
      the author's later edit". For each Agent it asserts that the edit is
      absent and the benign text present. No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. The GitHub contract suite has "keeps every version of an
      issue's title and body…" against both fakes (and the real App, when
      configured), and `issue-versions.test.ts` covers what the GraphQL
      answer leaves unknown.
- [x] **The assessment's findings table marks `P1-5` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #255), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on `@ai-office/web` tests
      outside this fix: the two known changelog tests, and two timeouts
      under the host's load that pass on their own.

## Real output of the checks

The three checks were run on the branch head after all four fixes
(`b7431c6`). The full output, and why the failures are not these fixes',
is in [#253's note](issue-253.md#real-output-of-the-checks). In short:

```
lint exit 0
typecheck exit 0
 FAIL  |@ai-office/web| src/role-library.test.tsx > the Role library page > makes a Role, opens it, and edits it, saying how many Agents the change reaches
 FAIL  |@ai-office/web| src/role-library.test.tsx > the Role library page > duplicates a Role and opens the copy; deletes one no Agent fills after asking
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  3 failed | 443 passed (446)
      Tests  4 failed | 4941 passed | 37 expected fail | 606 skipped (5588)
test exit 1
```

The full run right after this commit (`db79155`) had only the two
changelog failures:
`Tests  2 failed | 4935 passed | 40 expected fail | 606 skipped (5583)`.

### P1-5's tests on their own

```
# vitest run intake/ batches.test.ts contract.test.ts issue-versions.test.ts --reporter=verbose (P1-5's tests)
✓ src/issue-versions.test.ts > an issue's versions, from GitHub's GraphQL answer > is the issue as it is when it was never edited
✓ src/issue-versions.test.ts > an issue's versions, from GitHub's GraphQL answer > puts body edits and renames in the order they were made, each a version
✓ src/issue-versions.test.ts > an issue's versions, from GitHub's GraphQL answer > does not know a version whose edit was deleted, nor the body as opened once GitHub gives no more of the history
✓ src/issue-versions.test.ts > an issue's versions, from GitHub's GraphQL answer > gives what the issue says now to nobody known, when the history does not end there
✓ src/issue-versions.test.ts > an issue's versions, from GitHub's GraphQL answer > is nothing when there is no such issue
✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > keeps every version of an issue's title and body, oldest first, the first written by the App that opened it
✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > keeps every version of an issue's title and body, oldest first, the first written by the App that opened it
✓ src/intake/approved.test.ts > the version of an issue the Owner approved > is the latest written before the Owner's latest ai-office label, or by the Owner
✓ src/intake/approved.test.ts > the version of an issue the Owner approved > is never one someone else wrote, without the Owner's label, nor one written in the label's second
✓ src/intake/approved.test.ts > the version of an issue the Owner approved > is the App's, for an issue AI Office filed, and nothing GitHub no longer has
✓ src/intake/approved.test.ts > a Stage's GitHub, with the issues' approved text > answers getIssue with the approved title and body, the rest as GitHub has it, and refuses an issue with none
✓ src/intake/approved.test.ts > intake, with an issue edited after the Owner's label > gives the Manager's triage the text the Owner labelled
✓ src/intake/approved.test.ts > intake, with an issue edited after the Owner's label > ignores one whose approved text GitHub no longer has, until the Owner labels it again
✓ src/batches/batches.test.ts > Batches and their Plans, in memory > P1-5: plans each issue from the text the Owner approved, never an edit by someone else since; one whose approved text GitHub no longer has is left out
✓ src/batches/batches.test.ts > Batches and their Plans, in memory > an issue the GitHub App filed as the Owner approved it in a Grilling Session goes into a Batch; one of the App's the Owner did not approve does not
✓ src/intake/intake.pen-test.test.ts > who an issue is from > ignores an issue someone else opened and labelled
✓ src/intake/intake.pen-test.test.ts > who an issue is from > ignores it when someone else takes the label off and puts it back after the Owner labelled it
✓ src/intake/intake.pen-test.test.ts > who an issue is from > ignores the issues the GitHub App files, as the Manager does for its chat: they enter work only through their Batch
✓ src/intake/intake.pen-test.test.ts > who an issue is from > takes an issue the Owner opened, or labelled personally
✓ src/intake/intake.pen-test.test.ts > P1-5: what the Owner's label approved > is what the Agents work: an edit by the issue's author after the Owner labelled it is not worked
✓ src/intake/intake.pen-test.test.ts > P1-5: what the Owner's label approved > regression (P1-5): intake still takes the issue on the Owner's label, but the coder, both reviewers and QA are given the text the Owner labelled, not the author's later edit
✓ src/intake/intake.pen-test.test.ts > P1-5: what the Owner's label approved > P1-5: nor is the docs Agent given the edit
✓ src/intake/intake.pen-test.test.ts > P1-5: what the Owner's label approved > P1-5: nor are the Agents given an edit by someone else to an issue the Owner opened
✓ src/intake/intake.pen-test.test.ts > P1-5: what the Owner's label approved > P1-5: once the Owner labels it again, having read the edit, the edit is what the Agents work
✓ src/intake/intake.pen-test.test.ts > P1-5: what the Owner's label approved > holds: no comment on the issue reaches any Agent's prompt
 Test Files  7 passed (7)
      Tests  84 passed | 32 skipped (116)
```

(Lines from these files that do not concern P1-5 are left out. The 32
skipped are the Postgres variants and the contract suite against the
real App.)

## What could not be verified here

- **GitHub's own GraphQL answer.** The query, and the reading that
  `userContentEdits`' `diff` is each version's whole text, with the body
  as opened first when `includesCreatedEdit` is true, are from GitHub's
  schema and observed behaviour, not seen here (no GitHub). The contract
  suite has the test for it, "keeps every version of an issue's title and
  body…", against the real App. It runs when `GITHUB_APP_ID` is set, and
  there the edits are the App's own. If GitHub's answer differed, the
  likely failure is a version that cannot be read. That is not approved,
  so the issue would not be worked, rather than the wrong text being
  worked.
- **The designer** uses the same wrapped GitHub as the other sandbox
  Stages, but no test here runs it end to end on an edited issue.

## Noticed, out of scope

- **Notices still name the issue as it is now.** The Manager's watchdog
  and the Merge Policy read the issue afresh for its labels, state and
  the title in a Notice. That is text shown to the Owner, not given to a
  model.
- **The Manager's chat session can read an issue's page itself**, with
  its web fetch tool, and see whatever it says now. That is the chat's
  reach (P2), not a Stage's.
- **No Notice says an issue was edited after the Owner's approval.**
  Intake counts an issue with no approved version as ignored, giving no
  reason, and a Batch leaves it out of its Plan, saying why. An Activity
  Feed event for "edited since you approved it, not worked" would tell
  the Owner sooner, but it is new behaviour, not this fix.
