# Issue #196: [pen-test] W1 — GitHub App and webhooks — verification

Checks were run in the Sandcastle sandbox: Node 26.10.0, pnpm 12.10.0,
git 2.39.5. There was no Docker, Postgres, GitHub or live model, and no
network beyond the registry and the model. The probe was assessed at
commit `c4860a2`, the branch head with a clean worktree. `pnpm lint`,
`pnpm typecheck` and `pnpm test` were run at `081591b`, with the probe's
tests and assessment committed.

This issue is a **probe**, not a fix. It answers H12, produces an
assessment and committed probe tests, and changes no production code.

## Blockers

The issue names none. What W1 uses exists in the tree:

- the fake GitHub, in memory and served over HTTP (`@ai-office/github/testing`);
- the webhook route and receiver;
- the cross-reference test (`test/pen-testing.test.ts`).

## What was produced

- **Assessment** `docs/pen-testing/assessments/W1.md`. It records the
  commit it was assessed at, and has a verdict on each of the five "What
  to probe" bullets:
  - the signature;
  - replay, as a table of the merge, intake, label and close states;
  - the events and actions handled, and the installation and repository
    match;
  - installation tokens: permissions, repositories, lifetime, where held,
    and the sandbox's read-only token;
  - the App's write path: the branch, the repository, the ref pushed, the
    commits' metadata, and the ref merged by policy and on the Owner's
    approval.

  Its **Findings** table (W1-1 to W1-6) gives, for each finding:
  - a one-line statement fit for `[finding] W1-<n> — …`;
  - the attacker position;
  - the hypothesis it confirms, or "new";
  - the claimed severity, with why, against the PRD's definitions;
  - the probe tests;
  - what the fix must make true.

  It also says what could not be exercised here, and how the pen-test
  stack would exercise it.
- **Six probe test files**, beside the code they probe:
  - `packages/github/src/webhooks.pen-test.test.ts`: the signature, with
    `timingSafeEqual` spied on.
  - `apps/server/src/webhooks/routes.pen-test.test.ts`: the real Fastify
    app through `inject`, with real intake over two Floors (W1-1, W1-4).
  - `packages/orchestrator/src/webhooks/webhooks.pen-test.test.ts`: replay
    against the real Merge Policy flow waiting for CI, and the events
    table.
  - `packages/github/src/app.pen-test.test.ts`: the real App client
    minting from the fake GitHub over HTTP (W1-2, W1-3).
  - `packages/orchestrator/src/git/push-run.pen-test.test.ts`: the real
    `createPushRun` from a hostile Agent clone into a local bare
    repository (W1-5).
  - `packages/orchestrator/src/merge/approve.pen-test.test.ts`: the real
    merge flow and Notices: auto-merge's pinned head, and "Approve and
    merge" (W1-6).
- **Lint fixes to P2's probe tests** (`081591b`). `pnpm lint` failed
  before this probe began, in three files from `e104412`:
  - an unnecessary type assertion in `requests.pen-test.test.ts`;
  - a `catch` callback not typed `unknown` in
    `agent-tool-session.pen-test.test.ts`;
  - Prettier's wrapping and quotes in those and
    `apps/server/src/manager-chat/routes.pen-test.test.ts`.

  No assertion changed. Those tests still give 10 passed and 4 expected
  fail.

### The findings

| ID | Statement | Severity |
|---|---|---|
| W1-1 | A webhook delivery is acted on every time it is sent: nothing remembers a delivery, `X-GitHub-Delivery` is neither signed nor checked, and each replay runs intake over every Floor (H12) | low |
| W1-2 | The App's own installation tokens ask GitHub for no permissions, so each carries every permission the installation was granted; the listing token covers every repository (new) | low |
| W1-3 | One read-only token serves every sandbox of a Floor for 55 minutes and is never revoked; the guide says each sandbox gets its own (new) | medium |
| W1-4 | Nothing limits the deliveries one caller sends to the public webhook route (new) | low |
| W1-5 | An Agent's own `Agent:` and `Co-authored-by:` trailers, and its author date, reach commits authored as the Owner (new) | low |
| W1-6 | "Approve and merge" merges whatever the branch holds when the Owner clicks, not the head the Notice was raised for (new) | medium |

What holds, each kept holding by a plain `it`:

- The signature is HMAC-SHA256 over the bytes as sent, under any content
  type, compared with `timingSafeEqual`. Missing, malformed, doubled and
  wrongly keyed headers are refused. With no secret, or webhooks off, the
  route answers 404.
- A delivery says only when to look:
  - no replay merges while GitHub's CI runs, or after it failed, or
    merges twice;
  - no signed payload naming the Owner takes in an issue GitHub does not
    say is the Owner's.
- The sandbox's token is minted for one repository, read only, and is
  never the token that writes.
- The App pushes the one branch AI Office names, to the Floor's
  repository, whatever the Agent's clone holds. The branch is
  `ai-office/<issue>-<slug>` whatever the title says. Auto-merge names
  the head CI passed on.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      Each of the five bullets is a section of `W1.md`, and each part of
      a bullet has its own verdict: HOLDS, FINDING, or "by reading". What
      needs GitHub is listed with the check to make on the stack.
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.**
  - There are seven `it.fails`: W1-1 ×1, W1-2 ×2, W1-3 ×1, W1-4 ×1,
    W1-5 ×1 and W1-6 ×1. Each sits beside a passing pin, and the table
    names the file and both tests.
  - Each `it.fails` was flipped to `it` once, in all four files at once,
    to see that it fails on its own assertion about the property. All
    seven failed with an `AssertionError`, such as
    `expected { started: [ 'intake' ] } to deeply equal { started: [] }`,
    `expected [ 401 ] to include 429` and
    `expected undefined to deeply equal { metadata: 'read' }`. None
    failed with a setup error:

    ```
     Test Files  4 failed (4)
          Tests  7 failed | 21 passed (28)
    ```

    They were then put back as `it.fails`, and the six files run:

    ```
     Test Files  6 passed (6)
          Tests  36 passed | 7 expected fail (43)
    ```

  - The cross-reference test (`repository` project) finds each of the
    four files holding an `it.fails` linked from `W1.md`.
- [x] **Nothing in production code changes.** `git diff c4860a2 --stat`
      lists only probe tests and the assessment (this note was added
      after):

  ```
   .../src/manager-chat/routes.pen-test.test.ts       |   2 +-
   apps/server/src/webhooks/routes.pen-test.test.ts   | 405 +++++++++++++++++++
   docs/pen-testing/assessments/W1.md                 | 429 +++++++++++++++++++++
   packages/github/src/app.pen-test.test.ts           | 161 ++++++++
   packages/github/src/webhooks.pen-test.test.ts      | 150 +++++++
   .../orchestrator/src/git/push-run.pen-test.test.ts | 300 ++++++++++++++
   .../src/manager/requests.pen-test.test.ts          |   8 +-
   .../src/merge/approve.pen-test.test.ts             | 209 ++++++++++
   .../src/models/agent-tool-session.pen-test.test.ts |   4 +-
   .../src/webhooks/webhooks.pen-test.test.ts         | 342 ++++++++++++++++
   10 files changed, 2006 insertions(+), 4 deletions(-)
  ```

- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails with **two pre-existing
      failures**, the same two that #192's, #193's and #194's notes
      recorded. Both are in `@ai-office/web`, outside this probe's diff.
      Every probe test passes. See below.

## Real output of the checks

### `pnpm lint`: exit 0

This is after the P2 lint fixes in `081591b`. Before them it failed
with 2 ESLint errors, and then a Prettier warning, all in P2's files.

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck`: exit 0

```
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

### `pnpm test`: exit 1. The probe's tests pass, and the suite carries two pre-existing failures

The whole-repository run (`vitest run`, 249.84 s) finished:

```
 Test Files  2 failed | 445 passed (447)
      Tests  2 failed | 4866 passed | 65 expected fail | 600 skipped (5533)
```

The **65 expected fail** are the earlier probes' `it.fails` and this
probe's 7. They pass by failing, as the findings workflow intends. The
skips are the Postgres and Docker tests, skipped with their reason in
this sandbox.

**Neither failure is in a file this probe added, or in a project it
touches.** The projects its files live in are green on their own, as is
the cross-reference test (`repository`):

```
# pnpm exec vitest run --project @ai-office/github --project @ai-office/server --project @ai-office/orchestrator --project repository
 Test Files  216 passed (216)
      Tests  1933 passed | 58 expected fail | 456 skipped (2447)
```

Both failures read the root `CHANGELOG.md`. Its first heading is
`## 1.0.0`, with no release date, while the tests expect
`1.0.0 (YYYY-MM-DD)`. This probe changes neither the changelog nor
`apps/web`:

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/

# cd apps/web && pnpm exec vitest run src/site-footer.test.tsx src/legal/legal.test.tsx
 Test Files  2 failed (2)
      Tests  2 failed | 14 passed (16)
```

No test was skipped, deleted or weakened to reach this state.

## What could not be exercised here

- **GitHub itself.** The fake GitHub stands in for its REST API and its
  webhooks. Three of GitHub's behaviours come from its documentation and
  were not run:
  - a token minted with no `permissions` carries the installation's
    granted permissions (the fake gives it `appPermissions`);
  - GitHub signs only the body;
  - how **Redeliver** sets `X-GitHub-Delivery`.

  On the pen-test stack's own App, `W1.md` says how to confirm W1-1,
  W1-2, W1-3 and W1-6, and the real signature and events.
- **Exhausting GitHub's rate limit** by replays (W1-1), and the route's
  cost under load (W1-4). Denial of service is out of scope, so each was
  shown at 5 replays and 200 forged deliveries, not beyond.
- **A real sandbox's `GH_TOKEN`**, compared across two sandboxes and used
  after one stops (W1-3). The stack check is in `W1.md`.
- **Docker and Postgres.** Neither was needed: the stores were in memory,
  and Git ran on this machine against local bare repositories.
