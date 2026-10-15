# Issue #249: [fix] P1-2 — A pull request that changes what CI runs (package.json scripts, test config, .npmrc, CI scripts) is merged by policy like any other — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`b8d085b`,
`fix(security): P1-2 a pull request that changes what CI runs goes to the Owner`,
on top of P1-1's `e64ecc6` (#247). Its blocker, the P1 probe (#194), is
in the tree: `docs/pen-testing/assessments/P1.md`,
`packages/orchestrator/src/merge/merge.pen-test.test.ts` and
`docker/pen-test/corpus.pen-test.test.ts`.

This is the remediation of finding **P1-2** (`severity:medium`, H8).

## What was fixed

The Merge Policy's gate asked whether the reviewers approved, no
blocking comments remained, CI passed and every cap held. It never asked
what the pull request changes. So a pull request that changed
`package.json`'s scripts, `vitest.config.ts`, `.npmrc` or a CI script
merged like any other. Yet CI runs what the pull request itself says, so
CI passing is no check on it, and the reviewers are a model the
pull request's text may have fooled.

**A pull request that changes what CI runs now goes to the Owner, on any
Floor:**

- The gate reads the files the pull request changes at its head
  (`listPullRequestFiles`, every page) and judges them with plain rules,
  `runByCi` and `ownerOnly` in the new `merge/owner-only.ts`. A match
  sends the pull request to the Owner whatever its reviewers and CI say,
  and whatever its label: "PR #2 awaiting your approval: not merged
  automatically, as it changes what CI runs."
- **What counts**, matched on every path the pull request changes, a
  renamed file's old path too, at any depth and in any case:
  - CI definitions and Git hooks: `.github/`, `.gitlab-ci.yml`,
    `.circleci/`, `.buildkite/`, `.gitlab/`, `Jenkinsfile`, `.travis.yml`,
    `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.husky/`,
    `.pre-commit-config.yaml`, `.gitmodules`;
  - scripts: anything under `scripts/`, `script/`, `ci/`, `.ci/` or
    `bin/`, and any `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.bat` or
    `.cmd` file;
  - dependencies and the toolchain: `package.json`, every lock file,
    `pnpm-workspace.yaml`, `.pnpmfile.cjs`, every `.…rc` file (`.npmrc`,
    `.yarnrc.yml`, `.eslintrc.cjs`, `.prettierrc`…), `.nvmrc`,
    `.node-version`, `.tool-versions`, `.yarn/`, `turbo.json`, `nx.json`,
    `lerna.json`, Deno's and Bun's, and their counterparts for Python,
    Ruby, Rust, Go, the JVM, PHP and dbt, plus `Makefile`, `justfile`,
    `Taskfile`, `Dockerfile` and compose files;
  - tools' settings: every `*.config.*` and `*.workspace.*` file and
    `tsconfig*.json` / `jsconfig*.json`.
- The guide says the same (`docs/guide/issue-pipeline.md`, The Merge
  Policy).

### Sibling paths with the same flaw, fixed and tested

- **A workspace package's own `package.json`, a workflow, a lock file, a
  script outside `scripts/`, and a path in another case.** Tested: "P1-2:
  so is one that changes a workspace package's scripts, a workflow, a lock
  file or a script CI calls" (`packages/api/package.json`,
  `.github/workflows/ci.yml`, `pnpm-lock.yaml`, `tools/release.sh`,
  `Package.JSON`), each beside a harmless change.
- **A file CI runs moved out of the way** (a rename's old path). Tested:
  "P1-2: so is one that moves a file CI runs out of the way", and in
  `owner-only.test.ts`.
- **The Owner's `ai-office:auto-merge` label on a "send to me" Floor**,
  which goes through the same gate. Tested: "P1-2: so is one the Owner
  labelled ai-office:auto-merge, on a send-to-me Floor".
- **A pull request too large for GitHub to list.** GitHub lists at most
  3,000 files, and what it leaves out could be anything, so such a pull
  request goes to the Owner. Tested in `owner-only.test.ts`.
- **A head that moves as the files are listed.** GitHub lists the files of
  whatever the head is at that moment, so the gate reads the pull request
  again afterwards. If the head moved, the pull request goes to the Owner
  ("its head commit changed as it was being checked"). The merge still
  names the head it judged, too. Read from the code; the fake GitHub
  cannot push between two calls of one judgement without a stand-in.
- **The corpus.** E2's `package.json` and `scripts/ci-setup.sh`, together
  and each on its own. Tested in `corpus.pen-test.test.ts`.

What holds is tested too: "holds: a pull request that changes the code
and its tests only still merges by policy".

## Decisions

- **A fixed list of the files that say what CI runs, not the code it
  tests.** CI runs the code under test and the tests themselves too, but
  those are what the reviewers review, and treating them as CI would end
  auto-merge for every pull request. The list is the commands, what CI
  installs and how its tools are set up. It errs wide. Anything under
  `scripts/` or `bin/`, any shell script, and every lock file count, so a
  pull request that adds a dependency goes to the Owner. A Floor's own
  setup and test commands are its settings, which only the Owner changes,
  not files in a pull request.
- **The Notice says why, but not which file.** File paths are text the
  work Agent writes (P1-6). Notices reach the Communications Agent's
  Connections, so the title names the rule, not the path. The pull request
  on GitHub shows the files.
- **Rules, not reading the repository's CI.** Working out what a workflow
  calls means parsing YAML and shell. That parse could be fooled, and it
  would miss what a package script calls in turn. The rules are plain,
  and the guide lists them for the Owner.
- **On any Floor, whatever its label**, as the finding asks. A "send to
  me" Floor already sent every pull request to the Owner. Only the
  auto-merge path changes.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** All four
      are `it`s and pass, with their bodies unchanged: the three "is sent
      to the Owner, not merged by policy (<path>)" in
      `merge.pen-test.test.ts` (`package.json`, `vitest.config.ts`,
      `.npmrc`), and "are sent to the Owner, not merged by policy, as they
      change what CI runs" in `corpus.pen-test.test.ts`.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
      - *"pins today: each is merged by the App, as any approved pull
        request with passing CI is"* is now "regression (P1-2): none is
        merged by the App any more, though approved with passing CI: each
        goes to the Owner, saying why". For each file it asserts the pull
        request is not merged and the Notice is "… not merged
        automatically, as it changes what CI runs."
      - The corpus's *"pins today: the App merges them, as any approved
        pull request with passing CI"* is now "regression (P1-2): the App
        no longer merges them, together or each on its own, approved with
        passing CI".

      No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above, and `merge/owner-only.test.ts` ("what CI runs (P1-2)", 43
      paths that count and 9 that do not).
- [x] **The assessment's findings table marks `P1-2` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #249), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` has two failures, both in
      `@ai-office/web`, both failing before this fix and outside it (see
      below).

## Real output of the checks

The three checks were run on the branch head after all three fixes
(`31c1963`). The full output, and why the two failures are not these
fixes', is in [#247's note](issue-247.md#real-output-of-the-checks).
In short:

```
lint exit 0
typecheck exit 0
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  2 failed | 442 passed (444)
      Tests  2 failed | 4912 passed | 42 expected fail | 603 skipped (5559)
test exit 1
```

Both failures are the root `CHANGELOG.md`'s undated `## 1.0.0` entry,
and they failed the same way before any fix (at `1bb3183`). No test was
skipped, deleted or weakened to reach this state.

After this commit, before P1-3's, the orchestrator and deployment
projects passed on their own: `Test Files  158 passed (158)`,
`Tests  1573 passed | 31 expected fail | 294 skipped (1898)`.

### The probe and the rules on their own (P1-2's tests)

```
# vitest run merge.pen-test.test.ts corpus.pen-test.test.ts owner-only.test.ts --reporter=verbose
✓ owner-only.test.ts > what CI runs (P1-2) > is its definitions, scripts, dependencies and tools' settings, at any depth and in any case
✓ owner-only.test.ts > what CI runs (P1-2) > is not the code under test, its tests or its documentation
✓ owner-only.test.ts > ownerOnly > names nothing for a pull request that changes no such file
✓ owner-only.test.ts > ownerOnly > names what CI runs, once, however many such files change
✓ owner-only.test.ts > ownerOnly > counts a renamed file's old path: moving package.json away changes what CI runs
✓ owner-only.test.ts > ownerOnly > sends a pull request to the Owner when GitHub cannot list every file it changes
✓ corpus.pen-test.test.ts > P1-2: the corpus's package.json and CI script, in an Agent's pull request > are sent to the Owner, not merged by policy, as they change what CI runs
✓ corpus.pen-test.test.ts > P1-2: the corpus's package.json and CI script, in an Agent's pull request > regression (P1-2): the App no longer merges them, together or each on its own, approved with passing CI
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > is sent to the Owner, not merged by policy (package.json)
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > is sent to the Owner, not merged by policy (vitest.config.ts)
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > is sent to the Owner, not merged by policy (.npmrc)
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > regression (P1-2): none is merged by the App any more, though approved with passing CI: each goes to the Owner, saying why
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > P1-2: so is one that changes a workspace package's scripts, a workflow, a lock file or a script CI calls
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > P1-2: so is one the Owner labelled ai-office:auto-merge, on a send-to-me Floor
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > P1-2: so is one that moves a file CI runs out of the way
✓ merge.pen-test.test.ts > P1-2: a pull request that changes what CI runs > holds: a pull request that changes the code and its tests only still merges by policy
```

## What could not be verified here

- **CI secrets in GitHub Actions.** As the assessment says, a
  same-repository push runs the target repository's CI with its secrets
  *before* any merge. This fix stops such a change from reaching the
  default branch by policy. It does not stop the push's own CI run, which
  is the repository's CI configuration's to limit (for example, secrets
  only on the default branch, or on a protected environment). On the
  pen-test stack: the corpus's `issue-ci-secret` and `package-json`
  items, on an auto-merge Floor, should now end with "PR #N awaiting
  your approval: not merged automatically, as it changes what CI runs."
- **GitHub's 3,000-file cap.** The fake GitHub has no cap. The rule is
  tested on the list `ownerOnly` is given.

## Noticed, out of scope

- **CI runs on the push, before review.** See above. Nothing in AI Office
  can stop it, but the setup guide
  (`docs/processes/setting-up-a-floor.md`) could tell the Owner to give
  CI's secrets only to the default branch. That is a documentation
  change for the I series or the Owner.
- **The Floor Templates' Floors.** Online store, Website & marketing,
  Content & blog and the others run their checks as npm scripts that
  their first suggested issue sets up. That issue's pull request changes
  `package.json`, so it now always goes to the Owner, on any Floor. This
  is intended, and the Owner may want to know before setting such a Floor
  to auto-merge.
