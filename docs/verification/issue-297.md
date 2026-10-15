# Issue #297: [fix] W1-5 — An Agent's commit messages are pushed as written, so commits authored as the Owner carry trailers the Agent wrote — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no GitHub, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`4f04ed5`,
`fix(security): W1-5 a commit the App pushes names only the Agent AI Office says made it`,
on top of W1-4's `32a44e5` (#295). Its blocker, the W1 probe (#196), is
in the tree: `docs/pen-testing/assessments/W1.md` and
`packages/orchestrator/src/git/push-run.pen-test.test.ts`.

This is the remediation of finding **W1-5** (`severity:low`, new,
position 3).

## What was fixed

`publishBranch` makes each of the Agent's new commits again as the
Owner, with the Agent's trailer (FR-68, FR-69). But it kept the message
as the Agent wrote it, so trailers the Agent wrote were pushed in
commits authored as the Owner:

- `Agent: Grace (reviewer, ChatGPT gpt-5)`, naming another Agent;
- `Co-authored-by: <anyone>`, which GitHub shows as a co-author.

AI Office's own trailer was added last, so history could not be relied
on to say which Agent made a commit.

**Now the App's trailer is the only line naming who made a commit**
(`packages/orchestrator/src/git/identity.ts`):

- `withoutWhoMadeIt(message)` drops every line naming who made the
  commit: `Agent:`, and any `*-by:` line (`Co-authored-by:`,
  `Signed-off-by:`, `Reviewed-by:`, `Acked-by:`…). It matches in any case
  and with space before the colon, and drops their folded continuation
  lines too. The subject line is kept: Git never reads it as a trailer.
- `withAgentTrailer` drops them before it adds the Agent's trailer, at
  the end of the message's own trailer block (such as `Refs:`) or in a
  new one.
- Every other line is kept as the Agent wrote it. A message with no such
  line is left byte for byte as it was, so a commit already as the Owner
  with only its own trailer is not made again.

The guide's **Git identity** (`docs/guide/floors-and-agents.md`) and the
issue pipeline's push step (`docs/guide/issue-pipeline.md`) say so.

### Sibling paths with the same flaw, fixed and tested

- **A sign-off or a review naming the Owner, or anyone.** A
  `Signed-off-by:` in a commit authored as the Owner says the Owner
  certified it. Dropped with the rest. Tested in
  `push-run.pen-test.test.ts`, "W1-5: a sign-off or review trailer naming
  the Owner, or anyone, is dropped too, in every commit pushed, and the
  Agent's own trailer is written once", over two commits.
- **Every commit AI Office makes again as the Owner.** These are each
  new commit `publishBranch` pushes (coder, QA, docs and designer, which
  all push through `createPushRun`), and those `commitFile` makes. Both
  go through `withAgentTrailer`. A rebase replays commits already
  stamped.
- **The rules on their own.** Tested in `git/identity.test.ts`: "is the
  only line naming who made the commit: another Agent, a co-author or a
  sign-off the Agent wrote is dropped (W1-5)", and "leaves a message
  naming nobody as it was, the subject line included". The existing test
  "joins a trailer block the message already ends with" kept a
  `Co-Authored-By:` beside the Agent's trailer, which is the flaw. It now
  joins `Refs:` and `See-also:` trailers, with the same expectation of
  where the Agent's trailer goes.
- **Pull request bodies** are AI Office's own text (`Closes #N`, "Worked
  by …"), not the Agent's, so no Agent-written line reaches a merge
  commit through them.

## Decisions

- **Every `*-by:` line, not only `Co-authored-by:`.** The issue names
  `Agent:` and `Co-authored-by:`. But any `*-by:` trailer names a person
  as having had a part in a commit authored as the Owner, and
  `Signed-off-by:` asserts the Owner's own sign-off. No legitimate
  Agent's commit needs one.
- **Dropped, not quoted.** Lines that could be rewritten so Git no longer
  reads them as trailers would still read as claims to a person. Dropping
  them is simplest and loses nothing AI Office relies on.
- **The author date is still the Agent's.** The finding also names the
  author date the Agent chose. The issue's "what the fix must make true"
  is about trailers alone, and the date names nobody. Keeping each
  commit's author date is a deliberate part of `publishBranch`, tested in
  `publish.test.ts`: a commit already as the Owner, with its trailer, is
  not made again, and so keeps the dates it has. Replacing every author
  date with the time of the push would re-make every commit and lose
  when the work was done. The regression test still shows the Agent's
  date, and says it is decided here. The Owner may want the date checked
  (say, no later than the push) as a decision of its own.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "the
      commit the App pushes names only the Agent that made it: no other
      Agent: or Co-authored-by: trailer the Agent wrote" is an `it` and
      passes, with its body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** *"pins today: the Agent's
      trailers naming another Agent and a co-author, and its author date,
      are pushed in a commit authored as the Owner"* is now "regression
      (W1-5): the Agent's trailers naming another Agent and a co-author
      are no longer pushed in a commit authored as the Owner: its only
      trailer is AI Office's". It pushes the same forged commit and
      asserts:
  - Git's `%(trailers:only,unfold)` is the one line `Agent: Ada (coder,
    Claude claude-opus-5-5)`;
  - the whole message is `feat: a basket` and that trailer.

  Its check of the author date stays as it was (2001), with a comment
  that the date is kept by decision (above). No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above.
- [x] **The assessment's findings table marks `W1-5` fixed.**
      `docs/pen-testing/assessments/W1.md`: **fixed** (issue #297), with
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

### W1-5's tests on their own

```
 ✓ |@ai-office/orchestrator| src/git/push-run.pen-test.test.ts > W1-5: what the Agent writes in a commit's metadata > holds: the author and committer are the Owner, whoever the Agent said they were, and its own trailer is added (FR-68, FR-69)
 ✓ |@ai-office/orchestrator| src/git/push-run.pen-test.test.ts > W1-5: what the Agent writes in a commit's metadata > the commit the App pushes names only the Agent that made it: no other Agent: or Co-authored-by: trailer the Agent wrote
 ✓ |@ai-office/orchestrator| src/git/push-run.pen-test.test.ts > W1-5: what the Agent writes in a commit's metadata > regression (W1-5): the Agent's trailers naming another Agent and a co-author are no longer pushed in a commit authored as the Owner: its only trailer is AI Office's
 ✓ |@ai-office/orchestrator| src/git/push-run.pen-test.test.ts > W1-5: what the Agent writes in a commit's metadata > W1-5: a sign-off or review trailer naming the Owner, or anyone, is dropped too, in every commit pushed, and the Agent's own trailer is written once
 ✓ |@ai-office/orchestrator| src/git/identity.test.ts > the Agent: trailer > joins a trailer block the message already ends with
 ✓ |@ai-office/orchestrator| src/git/identity.test.ts > the Agent: trailer > is the only line naming who made the commit: another Agent, a co-author or a sign-off the Agent wrote is dropped (W1-5)
```

`publish.test.ts`, the coder, QA, docs, designer and memory flows,
which all push or commit through these functions, pass unchanged
(`pnpm vitest run src/git src/coder src/qa src/docs src/design
src/memory src/sandbox` in `packages/orchestrator`: "Tests  498 passed |
8 expected fail | 20 skipped (526)", with W1-5's changes, before they
were committed).

## What could not be verified here

There is no GitHub here: the pushes went to a local bare repository
standing in for the Floor's. On the pen-test stack, have a target
Floor's Agent end a commit with `Co-authored-by: …` and
`Agent: Someone (reviewer, …)` (position 2 or 3). Then check on GitHub
that the pushed commit shows no co-author, and that its only trailer is
the Agent's own.

## Noticed, out of scope

- **The six `repository` and `deployment` tests that fail on the base
  commit** (see [issue #289's note](issue-289.md#noticed-out-of-scope)).
- **The committer date** is the Agent's too, for a commit that is not
  made again. Like the author date, it names nobody.
