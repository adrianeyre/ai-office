# Issue #267: [fix] P1-11 — A reviewer's approval passes the Review Loop for changes it was never shown — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`cf8547c`,
`fix(security): P1-11 an approval counts only for a pull request the reviewer was shown in full`,
on top of P1-10's `6d881c9` (#265). Its blocker, the P1 probe (#194), is
in the tree: `docs/pen-testing/assessments/P1.md` and
`packages/orchestrator/src/review/reviewer.pen-test.test.ts`.

This is the remediation of finding **P1-11** (`severity:medium`, H8,
H10).

## What was fixed

The work Agent decides what its pull request holds, and so what the
reviewer is shown of it. The reviewer's prompt carried at most 100,000
characters of the diff, and 30,000 of each file up to 150,000 in all. A
change placed after enough padding (GitHub lists a pull request's files
by path) was in no prompt. The reviewer approved what it saw, the round
passed on to QA, and the approval was recorded for the head that held
the hidden change, which the Merge Policy then counted.

**Now an approval counts only for a pull request the reviewer was shown
in full:**

- **Checked before any reviewer is asked.** `notShownInFull`
  (`review/prompt.ts`) checks that the prompt can carry the whole diff:
  every changed file's diff, as GitHub gives it, and no more than the
  100,000 characters a prompt holds.
- **A pull request too large to show goes to the Owner.** If its diff is
  longer, or GitHub shows no diff of one of its files (binary, or too
  large), the review round labels it `needs-human` and raises an action
  Notice: "Too large to review: PR #N (#I) cannot be shown to a reviewer
  in full (its diff is 1,234,567 characters, more than the 100,000 a
  reviewer is shown), so it is yours to review." No reviewer is asked,
  and no approval is recorded for it.
- **The Merge Policy's gate says the same**, whatever approvals the pull
  request has. `ownerOnly` (`merge/owner-only.ts`), which already sends
  what CI runs and what later Agents read to the Owner, adds "no
  reviewer can be shown it in full (…)". So an approval recorded any
  other way, such as before this check existed, never merges it.
- **A pull request that fits is reviewed as before.** Its approval
  counts.

The guide's **Reviews** and **Merge Policy** sections
(`docs/guide/issue-pipeline.md`) say the same.

### Sibling paths with the same flaw, fixed and tested

- **A file GitHub shows no diff of.** GitHub leaves out `patch` for a
  binary file and for a large one, and the reviewer saw only "(No diff
  shown: a binary file, or too large.)". That is a change it was never
  shown, so it goes to the Owner too. Tested in `review/prompt.test.ts`
  ("is not when GitHub shows no diff of a file, binary or too large").
- **A diff spread over many files** is measured as the prompt carries it,
  whole. Tested: "is not when the diff is longer than a prompt carries,
  however it is spread over files".
- **The Merge Policy's own count of approvals.** Tested in
  `merge/owner-only.test.ts`: "sends a pull request to the Owner when no
  reviewer can be shown it in full, whenever an approval was given
  (P1-11)".
- **A round restarted at a head with verdicts already recorded** runs the
  check before it concludes, so it goes to the Owner too.

## Decisions

- **The diff, not the files, is what must be shown in full.** The diff
  holds every change. The files are the changed files' text, given for
  context, and are still cut to fit. Requiring the whole of every changed
  file would send every pull request that touches a large file (a lock
  file, a catalogue) to the Owner for a one-line change.
- **A binary file sends the pull request to the Owner.** A text model
  cannot be shown it. On an Online store or Design system Floor, a pull
  request that adds an image now always goes to the Owner, as "send to
  me", the default Merge Policy, already does. The Owner may want binary
  files that CI checks (images, say) treated otherwise, which would need
  a decision of its own.
- **The Owner, not a split review.** Splitting a pull request too large to
  show into several prompts was the other option. It costs a reviewer
  several calls, and no reviewer would see the whole change at once.
  The issue says such a pull request goes to the Owner.
- **No reviewer is asked first.** An approval that cannot count would only
  cost tokens.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "does not
      pass the Review Loop: an approval counts only for a pull request
      the reviewer was shown in full" is an `it` and passes, with its
      body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** *"the diff and the files
      are cut before package.json, the reviewer approves what it saw, and
      the issue moves on to QA with an approval for the head that holds
      it"* is now "regression (P1-11): the diff and the files are no
      longer cut before package.json with the reviewer approving what it
      saw and the issue moving on to QA: no reviewer is asked, no
      approval is recorded, and the Owner is told why". It asserts that
      no prompt was sent, no verdict was recorded, the issue is at
      `needs-human` rather than `needs-qa`, and the Owner's action Notice
      says why. No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. Also new: "P1-11: a pull request a reviewer can be shown in
      full is reviewed as before, and its approval counts". The
      `owner-only.test.ts` helper gave every file a null patch, which the
      new check would rightly flag. It now gives a small patch, which
      none of those tests looked at. The test of GitHub's 3,000-file
      limit now asserts its own reason, since such a pull request is too
      large to show as well.
- [x] **The assessment's findings table marks `P1-11` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #267), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on two `deployment` tests of
      files under `docker/` that no commit here touches, and which fail
      the same way on the base commit (below). Every test of these fixes
      passes.

## Real output of the checks

The three checks were run on the branch head, `cf8547c` (all four
fixes), with this note and the others uncommitted in the tree:

```
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit 0
$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
$ pnpm test
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 Test Files  2 failed | 448 passed (450)
      Tests  2 failed | 5018 passed | 30 expected fail | 611 skipped (5661)
test exit 1
```

**The two failures are not these fixes'.** Both are in the `deployment`
project and read only files under `docker/`: the Caddyfile
(`reverse_proxy app:3045 {`, where the test expects the directive with
no block) and the pen-test stack's environment file (which holds
`127.0.0.1`). No commit here touches `docker/`, `.env.example` or
`docker-compose.yml` (`git diff --stat 27c394e HEAD -- docker/
.env.example docker-compose.yml` is empty), and the two tests fail the
same way on the base commit's files:

```
$ pnpm vitest run --project deployment docker/caddy/caddyfile.pen-test.test.ts docker/pen-test/compose.test.ts
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
      Tests  2 failed | 22 passed | 1 expected fail | 1 skipped (26)
```

The web app's tests, which an earlier run of this branch saw time out
under the host's load (`whiteboard.test.tsx` in one run here, passing on
its own, 6 of 6), all passed in this run.

### P1-11's tests on their own

```
 ✓ |@ai-office/orchestrator| src/review/prompt.test.ts > whether a reviewer can be shown a pull request in full (P1-11) > is so when every file's diff is shown and the diff fits a prompt
 ✓ |@ai-office/orchestrator| src/review/prompt.test.ts > whether a reviewer can be shown a pull request in full (P1-11) > is not when GitHub shows no diff of a file, binary or too large
 ✓ |@ai-office/orchestrator| src/review/prompt.test.ts > whether a reviewer can be shown a pull request in full (P1-11) > is not when the diff is longer than a prompt carries, however it is spread over files
 ✓ |@ai-office/orchestrator| src/merge/owner-only.test.ts > ownerOnly > sends a pull request to the Owner when no reviewer can be shown it in full, whenever an approval was given (P1-11)
 ✓ |@ai-office/orchestrator| src/review/reviewer.pen-test.test.ts > P1-11: a change the reviewer is never shown > does not pass the Review Loop: an approval counts only for a pull request the reviewer was shown in full
 ✓ |@ai-office/orchestrator| src/review/reviewer.pen-test.test.ts > P1-11: a change the reviewer is never shown > regression (P1-11): the diff and the files are no longer cut before package.json with the reviewer approving what it saw and the issue moving on to QA: no reviewer is asked, no approval is recorded, and the Owner is told why
 ✓ |@ai-office/orchestrator| src/review/reviewer.pen-test.test.ts > P1-11: a change the reviewer is never shown > P1-11: a pull request a reviewer can be shown in full is reviewed as before, and its approval counts
```

## What could not be verified here

- **GitHub leaving out a large file's `patch`.** The fake GitHub always
  gives a patch, so the review round was run end to end on a diff too
  long for the prompt, and the omitted patch was tested on
  `notShownInFull` and the Merge Policy's gate. On the pen-test stack, a
  pull request with a file of several thousand lines shows it.
- **A live model.** Nothing here needs one: no reviewer is asked.

## Noticed, out of scope

- **QA, docs and the designer** work in sandboxes on the whole branch, so
  they are not cut short. But their verdicts are not what the Merge
  Policy counts as review (FR-29).
- **Two `deployment` tests fail on the base commit too**: the Caddyfile's
  `reverse_proxy` now has a block, and the pen-test stack's environment
  file holds `127.0.0.1`, which their tests do not expect (see the
  checks above). They are outside this fix.
