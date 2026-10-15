# Issue #253: [fix] P1-4 — A Role memory entry one issue's Agent proposes reaches every later Agent of that Role on the Floor, unquoted and "to follow", on the Manager's Model's say-so alone — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`e3ea51a`,
`fix(security): P1-4 only the Owner accepts a Role memory entry`,
on top of `7acc5eb`. Its blocker, the P1 probe (#194), is in the tree:
`docs/pen-testing/assessments/P1.md` and
`packages/orchestrator/src/memory/role-review.pen-test.test.ts`.

This is the remediation of finding **P1-4** (`severity:medium`, H9).
P1-5 (#255), P1-6 (#257) and P1-7 (#259) were fixed in the same run, on
top of this commit.

## What was fixed

Agents propose entries for their Role's memory at the end of a task.
Every hour the Manager's review asked the Manager's Model to accept or
reject each one, and an accepted entry reached every later Agent of the
Role on the Floor. Sandbox Agents got it mounted as `ROLE.md`, unquoted,
and the prompt said to "follow them". The only approver was a model
reading the very proposal it was deciding on. So one hostile issue could
steer every later coder on the Floor.

**Only the Owner accepts a Role memory entry now**
([ADR 0005](../architectural-decision-record/0005-only-the-owner-accepts-role-memory.md)):

- **A new status, `recommended`** (`roleMemoryStatuses` in
  `@ai-office/shared`). When the Manager decides "accept" in
  `SharedMemory.decide`, the entry becomes `recommended`, with the
  Manager's reason. It is not `accepted`, and `forAgent` gives only
  `accepted` entries, so no Agent reads it. The Manager's "reject" still
  rejects.
- **Only the Owner accepts.** They can accept or reject a proposal or a
  recommended entry, in the Floor admin or through the API, as before.
  The Manager cannot decide again on an entry it recommended: that is
  `409 role_memory_decided`.
- **The database holds to it.** `role_memory_decided` now also refuses
  an `accepted` or `removed` entry the Owner did not decide, and a
  `recommended` one the Manager did not. It is in `schema.ts`, the one
  migration and its snapshot. `db:generate` wrote the same SQL; only its
  id and timestamp differed, so the hand-edited files were kept.
- **The Manager is asked once.** Its review (`role-review.ts`) asks only
  about `proposed` entries. What it recommended waits for the Owner, not
  for it. Its prompt now says the Owner accepts what the memory keeps,
  and that an entry it accepts is recommended to the Owner.
  `RoleReviewOutcome.accepted` is now `recommended`.
- **The Owner sees it.** The Floor admin's **Role memory** card lists
  recommended entries among those waiting, with "the Manager recommends
  it: <reason>", and Accept and Reject buttons. The bookshelf counts them
  among the proposals waiting. `memory.role_changed` has a `recommended`
  change ("Grace recommended "…" for the coder memory: …").
- The words follow: `ROLE.md` now says "Role memory, accepted by the
  Owner.", and an Agent proposing an entry is told "The Owner decides
  what your Role's memory keeps, on the Floor's Manager's
  recommendation." The guide's **Office-wide and Role memory** section
  (`docs/guide/batches-and-memory.md`) says the same.

### Sibling paths with the same flaw, fixed and tested

- **QA's and the docs Agent's proposals, and reviewers' Role memory.**
  These are the same `decide` and `forAgent`, so a recommended entry
  reaches no QA, docs or reviewer Agent either, mounted or quoted.
  Tested: "P1-4: nor does QA's or the docs Agent's, and no reviewer is
  given one either, mounted or quoted".
- **Any caller of `decide` as the Manager, not only the hourly review.**
  Tested: "P1-4: the Manager cannot accept one, whatever calls on it to".
- **The database itself.** It refuses an `accepted` entry not decided by
  the Owner. This runs in the Postgres variants of `shared.test.ts` and
  `routes.test.ts`, which are skipped here (no Docker) and run in CI.

## Decisions

FR-55 says Role memory is "accepted by the Manager or the Owner". The
issue asked for a decision first. It is
[ADR 0005](../architectural-decision-record/0005-only-the-owner-accepts-role-memory.md).
The Owner should review these:

- **The Owner accepts; the Manager recommends.** I took this over the
  property's other option, fencing Role memory as untrusted data in every
  prompt. A fence lowers the odds that a model obeys hostile text, but
  the text still arrives in every later prompt. Role memory exists to be
  followed, so a human approval is the control that matches it. The probe's
  `it.fails` asks for it too: the entry must reach no later Agent at all.
- **The Manager's review stays**, rejecting and recommending. A rejection
  only keeps text out, and a recommendation changes nothing until the
  Owner acts, so neither widens what reaches an Agent. It still saves the
  Owner reading proposals that plainly only concern one issue.
- **No Notice for a recommendation.** The Floor admin and the bookshelf
  show what waits, as they showed proposals before. A Notice every hour
  per Floor would be noise. The Owner can ask for one later.
- **An existing database needs `pnpm db:reset`.** AI Office keeps its
  schema as one migration (README). A database created before this commit
  keeps the old `role_memory_status` check, which refuses `recommended`.
  The Manager's review would then fail, and be reported through
  `onError`, until the database is recreated. Entries the Manager
  accepted before are lost with the reset. On a database that is not
  reset they stay accepted, because nothing rewrites them.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "reaches
      no later Agent until the Owner has accepted it" in
      `memory/role-review.pen-test.test.ts` is an `it` and passes, with
      its body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** The pin *"the Manager's
      Model accepts it, and the next coder, on another issue, finds it in
      ROLE.md, unquoted, told to follow it"* is now "regression (P1-4):
      the Manager's Model only recommends it, and the next coder, on
      another issue, finds no ROLE.md and no word of it, until the Owner
      accepts it". It asserts four things:
      - the entry is `recommended` by the Manager, not `accepted`;
      - the next coder's sandbox mounts only `OFFICE.md`;
      - the next prompt has neither the old mounted section nor the
        canary;
      - once the Owner accepts the entry, the coders get it.

      No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. The unit tests were changed to the new behaviour, not
      loosened:
      - `shared.test.ts`: the Manager recommends, the Owner accepts, a
        recommendation is not decided twice, and a full memory still
        refuses the Owner;
      - `shared-scenario.test.ts`: the next coder gets the lesson only
        after the Owner accepts it;
      - `routes.test.ts`, `role-memory-card.test.tsx` and
        `activity-feed.test.tsx`: what the Owner sees.
- [x] **The assessment's findings table marks `P1-4` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #253), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on two known `@ai-office/web`
      tests that also failed before this run. On the final run it also
      failed on two `role-library.test.tsx` tests, which timed out under
      the host's load and pass on their own. See below.

## Real output of the checks

The three checks were run on the branch head after all four fixes
(`b7431c6`).

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/gateway typecheck$ tsc
packages/communications typecheck$ tsc
packages/orchestrator typecheck$ tsc
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: four failures, none in these fixes

```
 FAIL  |@ai-office/web| src/role-library.test.tsx > the Role library page > makes a Role, opens it, and edits it, saying how many Agents the change reaches
Error: Test timed out in 5000ms.
 FAIL  |@ai-office/web| src/role-library.test.tsx > the Role library page > duplicates a Role and opens the copy; deletes one no Agent fills after asking
AssertionError: expected [ …(3) ] to deeply equal [ …(2) ]
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/
 Test Files  3 failed | 443 passed (446)
      Tests  4 failed | 4941 passed | 37 expected fail | 606 skipped (5588)
   Duration  226.26s (tests 65%, import 21%, environment 7%, transform 6%, setup 1%)
test exit 1
```

- **The changelog failures** are the ones #205, #245 and #247 recorded.
  The root `CHANGELOG.md`'s top entry is `## 1.0.0`, with no release
  date. No fix here touches it.
- **The `role-library.test.tsx` failures are load, not these fixes.** The
  first hit vitest's 5-second timeout, and the second followed from it.
  The file passes on its own: `Tests  3 passed (3)`. The host was shared,
  with a load average of 30 to 45 on 16 cores. A second run of the
  `@ai-office/web` project alone timed out on other files instead
  (`floors.test.tsx`, `manager-chat.test.tsx`, `whiteboard.test.tsx`),
  and those four files pass together on their own:
  `Test Files  4 passed (4)`, `Tests  69 passed (69)`. The full run after
  P1-5 (`db79155`) had only the two changelog failures:
  `Tests  2 failed | 4935 passed | 40 expected fail | 606 skipped (5583)`.
  Another run, after P1-4, also had `scene/idle-behaviours.test.ts` time
  out. It times out the same way with the fixes stashed.
- **Expected fails went from 42 (#251's run) to 37.** The five `it.fails`
  of P1-4 (1), P1-5 (1), P1-6 (1) and P1-7 (2) are now `it`s. The 37 left
  are other probes' open findings.
- **The skips** are the Postgres and Docker tests, skipped with their
  reason in this sandbox.

No test was skipped, deleted or weakened to reach this state.

### P1-4's tests on their own

```
# vitest run role-review.pen-test.test.ts shared.test.ts shared-scenario.test.ts routes.test.ts role-memory-card.test.tsx --reporter=verbose (P1-4's tests)
✓ src/memory/shared.test.ts > office-wide and Role memory, in memory > the Manager recommends and rejects its Agents' proposals with reasons, through its own Model, and only the Owner accepts one (ADR 0005); what the memory says already is rejected without asking
✓ src/memory/shared.test.ts > office-wide and Role memory, in memory > a full Role memory takes no more: the Owner is told to remove an entry first, and the Manager's recommendation leaves the proposal waiting for them
✓ src/role-memory-card.test.tsx > a Floor's Role memory in its admin > lists what the Manager recommends among the proposals waiting for the Owner, with its reason: only the Owner accepts (ADR 0005)
✓ src/memory/routes.test.ts > office-wide and Role memory's API, in memory > lists what the Manager recommends as waiting for the Owner, who alone accepts it (ADR 0005)
✓ src/memory/shared-scenario.test.ts > office-wide and Role memory > is mounted read-only into every sandbox and quoted in every reviewer's prompt; Agents propose Role memory, a secret is refused, the Manager recommends and the Owner accepts
✓ src/memory/role-review.pen-test.test.ts > P1-4: an entry an Agent proposes for its Role's memory > reaches no later Agent until the Owner has accepted it
✓ src/memory/role-review.pen-test.test.ts > P1-4: an entry an Agent proposes for its Role's memory > regression (P1-4): the Manager's Model only recommends it, and the next coder, on another issue, finds no ROLE.md and no word of it, until the Owner accepts it
✓ src/memory/role-review.pen-test.test.ts > P1-4: an entry an Agent proposes for its Role's memory > P1-4: nor does QA's or the docs Agent's, and no reviewer is given one either, mounted or quoted
✓ src/memory/role-review.pen-test.test.ts > P1-4: an entry an Agent proposes for its Role's memory > P1-4: the Manager cannot accept one, whatever calls on it to
✓ src/memory/role-review.pen-test.test.ts > P1-4: an entry an Agent proposes for its Role's memory > holds: the Manager's review quotes the proposal between markers it cannot close
 Test Files  5 passed (5)
      Tests  31 passed | 13 skipped (44)
```

(The 13 skipped are the Postgres variants.)

## What could not be verified here

- **The database's check constraint.** The Postgres variants of
  `shared.test.ts` and `routes.test.ts` need Docker. They run the same
  cases against Postgres 18 in CI, and they will exercise the new
  `role_memory_decided` check there.
- **A live Manager's Model.** The review was answered by the fake model.
  That the Manager's Model can no longer put an entry in front of an
  Agent does not depend on what it answers.

## Noticed, out of scope

- **FR-55's wording.** `ai-office.md` still says Role memory is
  "accepted by the Manager or the Owner". ADR 0005 narrows that. The PRD
  is left as it is, as the brief asks, and the Owner should bring FR-55
  in line.
- **An entry the Owner accepted is still mounted as `ROLE.md`, unquoted,
  "to follow".** It is now the Owner's decision, so following it is what
  they chose. FR-56 still calls memory untrusted, and whether the sandbox
  Stages should also be given Role memory fenced, as reviewers are, is a
  separate question.
- **Configuration import accepts the Role memory it brings as the
  Owner's.** It is the Owner's own export, so this is as before.
