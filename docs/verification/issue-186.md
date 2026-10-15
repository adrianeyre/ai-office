# Issue #186: [pen-test] S1 — Host-side git in Agent-written worktrees (H1) — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no network beyond the registry and the model). The
probe was assessed at commit `fa56e24` (the branch head; the worktree was
clean). `pnpm lint`, `pnpm typecheck` and `pnpm test` were run in the
working tree with the probe's four files added.

This issue is a **probe**, not a fix: it answers H1, produces an assessment
and committed probe tests, and changes no production code.

## What was produced

- **Assessment** `docs/pen-testing/assessments/S1.md`: a verdict on every
  "What to probe" bullet, the commit it was assessed at, a dated answer to
  H1, and a Findings table (S1-1, S1-2) with each finding's one-line
  statement, attacker position, hypothesis, claimed severity against the
  PRD's definitions, the probe test that shows it, and what the fix must
  make true.
- **Three probe test files**, beside the code they probe, driving the real
  `runGit` with the real argument vectors the host-side call sites use,
  against real git repositories in temp dirs:
  - `packages/orchestrator/src/git/command.pen-test.test.ts`
  - `packages/orchestrator/src/git/publish.pen-test.test.ts`
  - `packages/orchestrator/src/sandbox/sandcastle-git.pen-test.test.ts`

### H1 is CONFIRMED (2026-10-11)

From a worktree whose `.git` an Agent has written (position 3), AI Office's
own host-side git (`runGit`, via `saveUncommitted` on a Fresh Start and via
the Grilling flow) and Sandcastle's own git (`execGit`, worktree management
and merge-back) execute code the Agent planted — `core.fsmonitor` on
`git status`, `.git/hooks/post-commit` and `reference-transaction` on
`git commit --no-verify`, `filter.*.clean` on `git add`, `post-checkout` on
`git worktree add`, `post-merge` on `git merge`. `runGit` neutralises only
system and global config, never the repository's own; `execGit` neutralises
none. `--no-verify` skips only `pre-commit` and `commit-msg`. This runs in
the app container, which holds the Docker socket, the GitHub App key and
every AI Account. Two findings, both claimed **critical**.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      `docs/pen-testing/assessments/S1.md` gives a verdict table for every
      vector (`core.fsmonitor`, `core.hooksPath`/hooks, `post-commit`,
      `post-checkout`, `reference-transaction`, `core.sshCommand`,
      `diff.external`, `filter.*.clean/smudge`, `include.path`/`includeIf`,
      `uploadpack.packObjectsHook`), for each host-side call site and the
      config/flags it trusts, for `--no-verify`, for Sandcastle's own git,
      and for what the app container would hand over.
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.** S1-1 has three `it.fails` (core.fsmonitor,
      post-commit, filter.*.clean) each beside a pinning `it` in
      `command.pen-test.test.ts`; S1-2 has two `it.fails` (post-checkout,
      post-merge) each beside a pinning `it` in
      `sandcastle-git.pen-test.test.ts`. Both are named in the table.
- [x] **Nothing in production code changes.** The diff adds only four files:
      three `*.pen-test.test.ts` and two docs. `git diff --cached --stat`:
      `docs/pen-testing/assessments/S1.md`,
      `packages/orchestrator/src/git/command.pen-test.test.ts`,
      `packages/orchestrator/src/git/publish.pen-test.test.ts`,
      `packages/orchestrator/src/sandbox/sandcastle-git.pen-test.test.ts`
      (this note added after).
- [x] **`pnpm lint`, `pnpm typecheck` pass; `pnpm test` — see below.**
- [x] **The assessment says plainly whether H1 is confirmed, with a dated
      answer.** "H1 is CONFIRMED (2026-10-11)", PRD success criterion 2.

## Real output of the checks

### `pnpm lint` — exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck` — exit 0

```
$ tsc && pnpm --recursive typecheck
… db/shared/events/github/communications/gateway/orchestrator/web/server/e2e
packages/orchestrator typecheck: Done
e2e typecheck: Done
[exited with code 0]
```

### `pnpm test` — the probe's own tests pass; the suite carries pre-existing failures

The whole-repo run (`vitest run`, 248.68s) finished:

```
 Test Files  5 failed | 382 passed (387)
      Tests  6 failed | 4293 passed | 5 expected fail | 566 skipped (4870)
```

The **5 expected-fail** are this probe's `it.fails` (they pass by failing,
as the findings workflow intends). **None of the 6 failures is in a file
this probe added**, and none is in `@ai-office/orchestrator`, where all
four of its files live. Run alone, the orchestrator project is fully green:

```
# cd packages/orchestrator && pnpm exec vitest run   → exit 0
 Test Files  115 passed (115)
      Tests  1143 passed | 5 expected fail | 252 skipped (1400)
```

The 6 failures are pre-existing or environmental, unrelated to S1:

1. **Five `@ai-office/web` tests** — `whiteboard.test.tsx`,
   `agent-settings-page.test.tsx`, `floors.test.tsx` and two in
   `role-library.test.tsx` — each failed as `Test timed out in 5000ms`
   (actual 5011–6702 ms) under the CPU contention of the full parallel
   run. Run on their own they pass:

   ```
   # cd apps/web && pnpm exec vitest run \
   #   src/whiteboard.test.tsx src/agent-settings-page.test.tsx \
   #   src/floors.test.tsx src/role-library.test.tsx   → exit 0
    Test Files  4 passed (4)
         Tests  45 passed (45)
   ```

2. **One `deployment` test** — `docker/deployment.test.ts > docker-compose.yml
   > publishes only the app, on 127.0.0.1 unless told otherwise` — a real
   assertion failure in the committed tree at `fa56e24`: the test expects
   only the app's port to be published, but `docker-compose.yml` also
   publishes `127.0.0.1:1455:1455` (the OAuth callback). This probe changes
   neither `docker-compose.yml` nor anything under `docker/`, so the result
   is identical to baseline. It is in the port-exposure area of H3/H14,
   which S1 explicitly excludes (owned by #193), and is noted here only to
   account for the suite's exit code.

   ```
   FAIL  |deployment| docker/deployment.test.ts > docker-compose.yml >
     publishes only the app, on 127.0.0.1 unless told otherwise
   - "${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}:${AI_OFFICE_PORT:-3045}:3045",
   + "127.0.0.1:1455:1455",
   ```

No test was skipped, deleted or weakened to reach this state; the probe's
own tests and the whole orchestrator project pass cleanly.

## What could not be exercised here

- **End-to-end detonation** (planted hook → Docker socket → root on host)
  needs Docker, absent in this sandbox. The probe proves the exec
  deterministically at the git layer; the socket-to-root step is read from
  `docker-compose.yml` and is not in doubt. The live route is in the
  assessment's "Could not be exercised here".
- **Sandcastle's full worktree manager** (its Effect runtime and a
  configured sandbox run) was not driven here; S1-2 pins `execGit`'s exact
  environment and subcommands as read from the installed package
  (`@ai-hero/sandcastle`).
