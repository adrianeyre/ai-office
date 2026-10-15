# Issue #191: [pen-test] E5 — Findings workflow: templates and triage runbook — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GitHub token). `pnpm lint`, `pnpm typecheck` and `pnpm test`
ran in a fresh `git clone` of this branch at `47fe63c`, after `pnpm
install --frozen-lockfile`, and `pnpm test` also in the working tree at
the same code. The commit after it, `ed6c4f0`, changes three words of
Markdown, which neither ESLint (`docs/` is ignored) nor Prettier (`*.md`
is ignored) reads.

**Blockers.** The issue names none. The PRD's
[Sequence](../product-requirements-document/pen-testing.md#sequence) puts
E5 with E3 "before the window opens", after the PRD and its labels, and
depends on no other Enablement issue. The PRD (`21eac51`) is on this
branch, and the issue says the labels exist. No earlier pen-testing slice
is on the branch: `feat/pen-testing` and `feat/pen-testing-e` are at
`fa56e24`, the PRD's merge, as this branch was.

## What was built

### Issue templates (`.github/ISSUE_TEMPLATE/`, new)

- **`pen-test-finding.md`**: titled `[finding] <ID> — <one-line
  statement>`, labelled `prd:pen-testing`. Its body has a section for each
  thing the PRD's Findings workflow and the issue name:
  - **Found at:** the commit, the probe issue and the assessment;
  - **Attacker position:** by the PRD's numbers and names (1–5);
  - **How to reproduce:** the probe test by path, its `it.fails` and its
    pin, and `pnpm test <path>`;
  - **Hypothesis:** `H<n>` it confirms, or "New";
  - **What it contradicts:** the FR or ADR, cited;
  - **Claimed severity:** as the assessment claims it, with the premise it
    was rated against, so it can be re-rated.

  Its guidance comment says the ID is `<probe ID>-<n>`, that one
  `severity:*` label is added by hand (a template can apply a label but
  not choose one of four), carried over without re-judging, and that no
  credential goes in the issue.
- **`pen-test-remediation.md`**: one fix per finding, titled
  `[remediation] <finding ID> — <what the fix makes true>`, labelled
  `prd:pen-testing` (plus the finding's severity, by hand). It links the
  finding, the triage date and target date, the decisions the fix depends
  on (taken first, in an issue or an ADR, as the PRD's Sequence says), and
  the probe test, its `it.fails` and its pin. Its acceptance criteria:
  the `it.fails` becomes an `it`; the pin becomes a regression test;
  neither is deleted, skipped or weakened; `pnpm lint`, `pnpm typecheck`
  and `pnpm test` pass. A **Retest** section records the fixing commit, the
  retest and the commit that updated the register.

### `docs/pen-testing/triage-runbook.md` (new)

- **Labels:** `prd:pen-testing`, the four `severity:*` labels with their
  targets and the gate each blocks, and `wontfix`. Documented, not
  created.
- **From assessment to finding:** each finding filed within one day of
  its assessment (PRD success criterion 4), with the template's title,
  labels and fields; the assessment links every probe test holding an
  `it.fails`.
- **Triage, within one day** of filing, by the Owner: reproduce at the
  named commit, check the issue is complete, then confirm (the clock
  starts; file the remediation), close as a duplicate, or ask the probe
  for what is missing.
- **Severities and their targets:** the PRD's table verbatim (critical 2,
  high 10, medium 30 calendar days after triage; low best effort), when a
  target is met, and the two gates as they follow from the labels.
- **Re-rating when a premise changes:** before each gate and whenever a
  premise changes; never because a fix is hard. A comment with the old and
  new severity, the premise and the date; the label swapped on finding and
  remediation; the target recalculated.
- **`wontfix`:** only after the Owner's written rationale in the issue
  (what, why or which control, whether it is a waiver for the
  public-release gate, when it is revisited). A critical cannot be accepted
  for the exposure gate. The `it.fails` stays.
- **Retest:** the tests are turned, never deleted; the remediation's Retest
  section is filled in; the PRD's register gets a dated line under the
  hypothesis (`**Retest:**`, `**Accepted:**` or `**Disproved:**`), and a
  new finding a row in a "Findings beyond the register" table after H17.
  The opening estimates stay as written.

### `docs/pen-testing/README.md` (new) and `assessments/`

The index: the PRD, the runbook, both templates and the assessments,
with a table of assessments (probe, assessment, pinned commit, findings,
retest), empty for now; the labels; and how the cross-reference test
works. `docs/pen-testing/assessments/README.md` holds the directory and
points back to the index. The root README's Documentation table links the
index.

### The cross-reference test (`test/pen-testing.test.ts`, new)

A new root Vitest project, `repository` (`vitest.config.ts`), includes
`test/**/*.test.ts`, so `pnpm test` runs it; the root `tsconfig.json`
includes `test/**/*.ts`, so `pnpm typecheck` and the type-aware ESLint
cover it.

- It finds every `*.pen-test.test.ts` and `*.pen-test.integration.test.ts`
  with Node's `fs.glob`, skipping `node_modules`, `dist`, `build`,
  `coverage`, `test-results`, `playwright-report` and (as `glob` does)
  dot directories, so a Sandcastle worktree is never searched.
- A file "holds an `it.fails`" when its text matches
  `\b(?:it|test)\.(?:\w+\.)*fails\b`: `it.fails`, `test.fails`,
  `it.concurrent.fails`.
- It is referenced when its path from the repository root appears in the
  text of any `.md` under `docs/pen-testing/assessments/`, so a relative
  Markdown link counts and a bare file name does not.
- The repository check expects no unreferenced file. Today no probe test
  exists, so it passes with nothing to check; six tests on fixture trees
  in a temporary directory show what it catches and what it ignores.

## Acceptance criteria

- [x] **Templates, runbook and index exist and agree with the PRD.**
      Checked by reading each against the PRD's Findings workflow,
      Sequence, Gates and Success criteria:

  | PRD | Where |
  | --- | --- |
  | Title `[finding] <ID> — <one-line statement>`; `prd:pen-testing`; one `severity:*` | finding template front matter and comment; runbook "Labels" |
  | Body: commit, attacker position, reproduction as the probe test, hypothesis or new; links to the probe issue | finding template sections |
  | Finding IDs `<probe ID>-<n>` | finding template comment; runbook; index |
  | Severity claimed in the assessment, carried over without re-judging; re-assessed when a premise changes (loopback → exposure gate) | finding template "Claimed severity"; runbook "Re-rating" |
  | Targets 2 / 10 / 30 / best effort calendar days after triage | runbook table (the PRD's, verbatim); remediation template "Target" |
  | `wontfix` only after the Owner's written rationale in the issue | runbook "`wontfix`" |
  | One fix per finding; decisions first; `it.fails` → `it`, pin → regression test, neither deleted | remediation template; runbook "Retest" |
  | Filed within one day of the assessment (success criterion 4) | runbook "From assessment to finding" |
  | Register updated with what was fixed, by which commit and when | runbook "Retest", 3 |
  | Exposure: every critical remediated; public release: above low remediated or waived | runbook "Severities and their targets" |

  The front matter of both templates parses as YAML (`title` and `labels`
  quoted, since they start with `[` or hold `:`), checked with the
  `yaml` package: `labels` is `["prd:pen-testing"]` in each. GitHub's
  rendering of them could not be seen here (below).
- [x] **The cross-reference test passes.** 7 passed (verbose output
      below). **Negative check:** with an unreferenced
      `packages/shared/src/sabotage.pen-test.test.ts` holding an
      `it.fails` added to the working tree, the repository check failed
      naming it; with an assessment `X1.md` linking it as
      `../../../packages/shared/src/sabotage.pen-test.test.ts`, it passed.
      Both files were removed and `git status` was clean.
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck exit 0. `pnpm test` exits 1, on one test that fails the
      same way at `fa56e24`, before this issue, and that this issue does not
      touch:
  - `docker/deployment.test.ts` › "publishes only the app, on 127.0.0.1
    unless told otherwise" expects the app's `ports` to be the app port
    alone, but `docker-compose.yml` has published `127.0.0.1:1455:1455`
    (the ChatGPT sign-in callback) since `171357e`, which did not update
    the test. Run at `fa56e24` in a separate worktree: `1 failed | 44
    passed | 10 skipped`, the same assertion. It is not changed here: it is
    outside this issue, and the listener is H14's surface, which the
    S-series probes own.
  - In the fresh clone, three web tests also timed out under the full
    suite's load (`app.test.tsx` and `whiteboard.test.tsx` at 5 s,
    `idle-behaviours.test.ts` at 30 s). They passed in the working-tree
    run, and alone in the fresh clone (3 files, 84 passed). This issue
    changes nothing they load.

  Without the deployment test, every test passes: 385 files, **4295
  passed, 1 failed, 566 skipped** in the working tree (the skips are the
  Postgres and Docker tests, with the reason). The 7 new tests are among
  the passes.

## Not verifiable in this sandbox

- **The labels on GitHub.** There is no `GH_TOKEN`, so that
  `prd:pen-testing` and the four `severity:*` labels exist is taken from
  the issue, and `wontfix` from GitHub's defaults. If a repository has
  lost `wontfix`, the Owner adds it before the first acceptance.
- **The templates in GitHub's "New issue" chooser**, and that GitHub
  applies `prd:pen-testing` from them: seen only once pushed.
- **Docker**: the Testcontainers path of the Postgres tests (skipped
  here), as in every earlier note. Nothing in this issue needs Postgres.

## Notes

- **Integration probe tests are covered too.** The issue names
  `*.pen-test.test.ts`; the PRD names `*.pen-test.integration.test.ts` as
  well, and an `it.fails` there is as unexplained, so the test checks both.
- **Choices the PRD leaves open**, written into the runbook and templates
  for the Owner to change:
  - the remediation title, `[remediation] <finding ID> — …`;
  - re-rating's target: raised, the new severity's days from the
    re-rating or the old target if sooner; lowered, the new days from the
    original triage;
  - the register's line formats and the "Findings beyond the register"
    table.
- **Where the test lives.** It is a check of the repository, not of a
  package, so it is a root project beside `deployment`, under a new
  `test/` directory rather than in `docs/`, which ESLint ignores as prose.

## Noticed, out of scope

- **`pnpm test` is red on main** from `docker/deployment.test.ts` (above),
  so CI's "Lint, typecheck, test" job would fail on main and on this
  branch until the test or the compose file is brought into line. Whether
  `127.0.0.1:1455:1455` belongs in the expected ports is a decision for
  the Owner, and it bears on H14.
- **Three web tests time out under the full suite's load** in a fresh
  clone (above), on a 16-CPU sandbox.

## Output

### `pnpm lint` and `pnpm typecheck`, fresh clone at `47fe63c`

```text
$ pnpm install --frozen-lockfile
Done in 5.1s using pnpm v12.10.0
install exit=0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test`, working tree at the same code

```text
$ pnpm test
 FAIL  |deployment| docker/deployment.test.ts > docker-compose.yml > publishes only the app, on 127.0.0.1 unless told otherwise
AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]

- Expected
+ Received

  [
    "${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}:${AI_OFFICE_PORT:-3045}:3045",
+   "127.0.0.1:1455:1455",
  ]

 ❯ docker/deployment.test.ts:179:23

 Test Files  1 failed | 384 passed (385)
      Tests  1 failed | 4295 passed | 566 skipped (4862)
test exit=1
```

### `pnpm test`, fresh clone at `47fe63c`

```text
$ pnpm test
 FAIL  |deployment| docker/deployment.test.ts > docker-compose.yml > publishes only the app, on 127.0.0.1 unless told otherwise
 FAIL  |@ai-office/web| src/app.test.tsx > the app layout > navigates between pages in the browser
 FAIL  |@ai-office/web| src/whiteboard.test.tsx > the whiteboard > opens on the Batch a Notice names; the Owner moves, drops and annotates its issues, saves them to be replanned, then approves
 FAIL  |@ai-office/web| src/scene/idle-behaviours.test.ts > the trip to an idle activity > for each of 21 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
$ grep -E "Test timed out|Error:" test.log | sort | uniq -c   # the errors, counted
      1 AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
      1 Error: Test timed out in 30000ms.
      2 Error: Test timed out in 5000ms.
$ tail test.log
 Test Files  4 failed | 381 passed (385)
      Tests  4 failed | 4292 passed | 566 skipped (4862)
test exit=1

$ pnpm exec vitest run src/app.test.tsx src/whiteboard.test.tsx src/scene/idle-behaviours.test.ts   # apps/web, fresh clone
 Test Files  3 passed (3)
      Tests  84 passed (84)
```

### The deployment test before this issue, at `fa56e24`

```text
$ pnpm exec vitest run --project deployment   # a worktree at fa56e24
     × publishes only the app, on 127.0.0.1 unless told otherwise 9ms
      Tests  1 failed | 44 passed | 10 skipped (55)
```

### This issue's tests (verbose), fresh clone

```text
$ pnpm exec vitest run --project repository --reporter=verbose
 ✓ |repository| test/pen-testing.test.ts > the pen-test cross-reference > finds every probe test holding an it.fails referenced by an assessment 49ms
 ✓ |repository| test/pen-testing.test.ts > unreferencedProbeTests > names a probe test holding an it.fails that no assessment references 7ms
 ✓ |repository| test/pen-testing.test.ts > unreferencedProbeTests > accepts one referenced by its path from the root, or by a relative link containing it 5ms
 ✓ |repository| test/pen-testing.test.ts > unreferencedProbeTests > does not take a file's name alone, or a reference outside the assessments, as a reference 4ms
 ✓ |repository| test/pen-testing.test.ts > unreferencedProbeTests > needs no reference for a probe test with no it.fails, such as one whose fix has landed 2ms
 ✓ |repository| test/pen-testing.test.ts > unreferencedProbeTests > counts it.fails behind a modifier, but not other tests' names 2ms
 ✓ |repository| test/pen-testing.test.ts > unreferencedProbeTests > ignores other tests, dependencies, build output and dot directories 4ms
      Tests  7 passed (7)
```

### Negative check, working tree

```text
$ pnpm exec vitest run --project repository   # with an unreferenced sabotage.pen-test.test.ts
     × finds every probe test holding an it.fails referenced by an assessment 54ms
- Expected
+ Received
- []
+ [
+   "packages/shared/src/sabotage.pen-test.test.ts",
+ ]
      Tests  1 failed | 6 passed (7)

$ pnpm exec vitest run --project repository   # with assessments/X1.md linking it
      Tests  7 passed (7)
```
