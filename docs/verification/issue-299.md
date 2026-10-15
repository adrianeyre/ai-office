# Issue #299: [fix] W1-6 — "Approve and merge" merges whatever the branch holds when the Owner clicks, not the head the Notice was raised for — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no GitHub, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`a579b6a`,
`fix(security): W1-6 Approve and merge merges only the head the Notice was raised for`,
on top of W1-5's `4f04ed5` (#297). Its blocker, the W1 probe (#196), is
in the tree: `docs/pen-testing/assessments/W1.md` and
`packages/orchestrator/src/merge/approve.pen-test.test.ts`.

This is the remediation of finding **W1-6** (`severity:medium`, new,
position 3).

## What was fixed

On a "send to me" Floor (the default), the Owner's **Approve and merge**
called `mergePullRequest(number)` with no `sha`. So GitHub merged
whatever the branch held when the Owner clicked, not the head the Notice
was raised for. Anything pushed since the Owner was asked, an Agent's
later work pushed by the App included, was merged on an approval given
before it existed. The guide said the App merges "as the Owner approved
it". The Notice was raised once per pull request, and nothing closed it
when the issue left `ready-to-merge`. So if the issue went round again,
the stale Notice merged the newer head, unreviewed if the Owner clicked
before review ended.

**Now the Owner approves one head**
(`packages/orchestrator/src/merge/merge.ts`):

- **The Notice names it.** Its "Approve and merge" action carries the
  head it was raised for (`sha`, a new optional field of a Notice's
  action in `@ai-office/shared`).
- **Only that head is merged.** The App passes the head to GitHub, which
  refuses the merge (409) if the branch moves as it merges.
- **A moved branch is asked about again.** If the head is not the one
  the Notice names, nothing is merged. The Notice is closed, and a new
  one asks about the new head: "PR #N awaiting your approval: its branch
  moved on to abc1234 since you were last asked." The same happens when
  GitHub refuses the merge because the head moved as it merged.
- **A Notice whose issue has left `ready-to-merge` offers no merge.**
  Clicking it merges nothing and closes it, saying where the issue is.
- **One Notice per head.** When the pull request is sent to the Owner
  again for another head (it went round the Review Loop and came back),
  the Notice for the old head is closed. One for the same head is not
  raised twice, as before.
- **Closed, not acted on.** A Notice action's handler may now throw a
  `NoticeOutdatedError` (`notices/notices.ts`). Nothing was done, so the
  Notice is closed as dismissed, not acted on (`notice.dismissed`), and
  the Owner is told: "The action was not taken, and the Notice is closed:
  Nothing was merged: …".

The issue pipeline guide (**Approve and merge**), the Notices guide (an
action's `sha` and `NoticeOutdatedError`) and the setup guide's
troubleshooting table say so.

### Sibling paths with the same flaw, fixed and tested

Each is in `merge/approve.pen-test.test.ts`, beside the probe's tests:

- **A head pushed as the App merges** (between reading the pull request
  and merging it): GitHub refuses it, and the Owner is asked about the
  new head. Tested: "W1-6: a head pushed as the App merges is refused by
  GitHub, not merged, and asked about".
- **The issue gone round again with its Notice open.** Tested: "W1-6: a
  Notice whose issue has left ready-to-merge offers no merge, and is
  closed".
- **Sent to the Owner again for a new head.** Tested: "W1-6: sent to the
  Owner again for a new head, the Notice for the old head is closed and
  one asks about the new head".
- **A Notice raised before this fix**, which names no head. It merges
  nothing, and asks about the head there is. Tested: "W1-6: a Notice
  raised before it named its head merges nothing, and asks about the
  head there is".
- **The Notices on their own.** Tested in `notices/notices.test.ts`:
  "closes a Notice whose handler finds it out of date, as dismissed and
  not acted on, saying why (W1-6)".
- `merge.test.ts` and `merge-loop.test.ts`, which check a raised
  Notice's actions exactly, now expect the head among them.

## Decisions

- **The head is kept on the action, not in a new column.** A Notice's
  actions are stored as JSON, so `sha` needs no migration, and the
  action is what acts on it. It is optional, so every other action is as
  it was.
- **A moved branch is asked about again, not sent back to review.** The
  assessment says the Owner is asked again about the new head, and on a
  "send to me" Floor the Owner reviews the pull request. The new
  Notice's title says the branch moved on, and since when, so the Owner
  knows to look again. Sending it back to review instead would be a
  change to the Review Loop, which the Owner may want as a decision of
  its own.
- **A Notice raised before this fix is treated as for a head nobody
  named.** Merging the head there is would be the old behaviour. So it
  merges nothing and asks about the head there is.
- **The probe's `it` reads "no file on main" as empty text.** Its
  assertion, `expect(await setup.basketOnMain()).not.toContain(…)`, was
  only ever run on a main the head had been merged into. With nothing
  merged, `basket.ts` is not on main and the helper answers `undefined`,
  which `toContain` refuses as an argument. It now reads
  `(await setup.basketOnMain()) ?? ""`, with a comment. The property is
  unchanged (main holds no `evil.example`), and the regression test
  asserts `toBeUndefined()` outright.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "merges
      only the head the Notice was raised for: a head pushed since is not
      merged on that approval" is an `it` and passes. Its body is
      unchanged but for reading a missing file as empty text (see
      Decisions).
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** *"pins today: the App
      merges whatever the branch holds when the Owner clicks, a head
      pushed after the Notice included"* is now "regression (W1-6): the
      App no longer merges whatever the branch holds when the Owner
      clicks: a head pushed after the Notice is not merged, and a new
      Notice asks about it". It pushes the same later head and asserts:
  - the click fails with the reason, naming both heads;
  - nothing is on main and the pull request is unmerged;
  - the old Notice is dismissed, not acted on;
  - one open Notice asks about the new head, with `sha` the new head;
  - approving that one merges the head it names.

  No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above.
- [x] **The assessment's findings table marks `W1-6` fixed.**
      `docs/pen-testing/assessments/W1.md`: **fixed** (issue #299), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on six `repository` and
      `deployment` tests that fail the same way on the base commit
      (below). Every test of these fixes passes.

## Real output of the checks

The three checks were run on the tree of all six fixes (W1-6 then
uncommitted, since committed as `a579b6a` unchanged), before these notes
were written:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
$ pnpm test
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 Test Files  4 failed | 473 passed (477)
      Tests  6 failed | 5325 passed | 55 expected fail | 611 skipped (5997)
test exit 1
```

**The six failures are not these fixes'.** They read only
`.env.example`, `docker-compose.yml` and files under `docker/`, which no
commit here touches (`git diff --stat 20b619d HEAD -- docker
.env.example docker-compose.yml test` is empty), and the same six fail
on the base commit, `20b619d`, run in a scratch worktree
(`pnpm vitest run --project repository --project deployment`: "Tests  6
failed | 202 passed | 14 expected fail | 13 skipped (235)"). The full
listing, and what each asserts, is in
[issue #289's note](issue-289.md#real-output-of-the-checks).

### W1-6's tests on their own

```
 ✓ |@ai-office/orchestrator| src/merge/approve.pen-test.test.ts > W1-6: what 'Approve and merge' merges > merges the head the Notice was raised for, when nothing has moved
 ✓ |@ai-office/orchestrator| src/merge/approve.pen-test.test.ts > W1-6: what 'Approve and merge' merges > merges only the head the Notice was raised for: a head pushed since is not merged on that approval
 ✓ |@ai-office/orchestrator| src/merge/approve.pen-test.test.ts > W1-6: what 'Approve and merge' merges > regression (W1-6): the App no longer merges whatever the branch holds when the Owner clicks: a head pushed after the Notice is not merged, and a new Notice asks about it
 ✓ |@ai-office/orchestrator| src/merge/approve.pen-test.test.ts > W1-6: what 'Approve and merge' merges > W1-6: a head pushed as the App merges is refused by GitHub, not merged, and asked about
 ✓ |@ai-office/orchestrator| src/merge/approve.pen-test.test.ts > W1-6: what 'Approve and merge' merges > W1-6: a Notice whose issue has left ready-to-merge offers no merge, and is closed
 ✓ |@ai-office/orchestrator| src/merge/approve.pen-test.test.ts > W1-6: what 'Approve and merge' merges > W1-6: sent to the Owner again for a new head, the Notice for the old head is closed and one asks about the new head
 ✓ |@ai-office/orchestrator| src/merge/approve.pen-test.test.ts > W1-6: what 'Approve and merge' merges > W1-6: a Notice raised before it named its head merges nothing, and asks about the head there is
 ✓ |@ai-office/orchestrator| src/notices/notices.test.ts > raising a Notice > closes a Notice whose handler finds it out of date, as dismissed and not acted on, saying why (W1-6)
 ✓ |@ai-office/orchestrator| src/merge/merge.test.ts > send to me > raises an action Notice linking the pull request, its issue, its CI run and each round, once
 ✓ |@ai-office/orchestrator| src/merge/merge-loop.test.ts > the Merge Policy > sends the pull request to the Owner, saying why, when CI fails on an auto-merge Floor
```

## What could not be verified here

There is no GitHub here. The fake refuses a merge whose expected head is
not the pull request's, as GitHub does. On the pen-test stack, on a
"send to me" Floor:

- Let an issue reach `ready-to-merge`, push a commit to its branch, then
  choose **Approve and merge**. Before this fix, the merge commit's
  second parent was the new head. Now nothing should be merged: the
  Notice closes with the reason, and a new Notice asks about the new
  head. Approving that one should merge a commit whose second parent is
  the head it names.
- How the web app's Notice Board shows such a click was not driven in a
  browser here (no display). The act route answers `502 action_failed`
  with the reason, and `notice.dismissed` is published for the closed
  Notice, as when the Owner dismisses one.

## Noticed, out of scope

- **The six `repository` and `deployment` tests that fail on the base
  commit** (see [issue #289's note](issue-289.md#noticed-out-of-scope)).
- **A Notice whose issue leaves `ready-to-merge` stays on the board until
  it is clicked, or the pull request is sent to the Owner again.** Its
  merge is refused, as the fix requires. Closing it the moment the
  pipeline moves the issue would mean the pipeline knowing about Notices,
  which it does not today.
