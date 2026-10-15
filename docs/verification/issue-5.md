# Issue #5: CI on Linux: lint, typecheck, test — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0)
against a fresh `git clone` of this branch at the workflow commit
(`b227701`), running the same commands the workflow runs.

## What was built

`.github/workflows/ci.yml`, one job on `ubuntu-latest`:

1. `actions/checkout` (read-only token, credentials not persisted).
2. `actions/setup-node` with `node-version-file: package.json`. The action
   reads `devEngines.runtime` (then `engines.node`), so Node 26.10.0 comes
   from the existing pin, not a second copy in the workflow.
3. `pnpm/action-setup` with no `version`, so it uses `packageManager`
   (`pnpm@12.10.0`), and `cache: true`, which caches the pnpm store keyed on
   `pnpm-lock.yaml`. Its README states support for pnpm v12.
4. `pnpm install --frozen-lockfile`, then `pnpm lint`, `pnpm typecheck` and
   `pnpm test` as separate steps.

It triggers on pushes to `main` and on every pull request (a pushed branch
with a pull request is covered by `pull_request`, so pushes to other branches
aren't run twice). Each action is pinned to the commit SHA of its latest
release, with the tag in a comment: `actions/checkout` v7.0.1,
`actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0. `permissions` is
`contents: read`. A newer push to the same ref cancels the older run.
`ubuntu-latest` has Docker, so nothing extra is needed for later
Testcontainers tests.

## Acceptance criteria

### Verified in the sandbox

- [x] **Workflow file is valid (`actionlint` or equivalent check passes).**
      Downloaded actionlint v1.7.12 from its GitHub release (sha256 checked
      against the published checksums) and ShellCheck v0.11.0, so the `run:`
      steps are shell-checked too. `actionlint -verbose` reports 0 errors and
      exits 0. Negative check: in a copy with `runs-on: ubuntu-latst`,
      actionlint reports `label "ubuntu-latst" is unknown` and exits 1, so it
      really is validating the file. The workflow is also Prettier-clean
      (covered by `pnpm lint`).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone after `pnpm install --frozen-lockfile`, the same
      sequence the workflow runs (output below).

### Verified on the host

- [ ] **The workflow runs green on the pull request for this issue.** Not
      verifiable here: the sandbox cannot push or open a pull request.

## Output

```text
$ /tmp/dl-actionlint/actionlint -verbose      (ShellCheck 0.11.0 on PATH)
verbose: Linting .github/workflows/ci.yml
verbose: Using project at /home/agent/workspace
verbose: Found 0 parse errors in 0 ms for .github/workflows/ci.yml
verbose: Rule "pyflakes" was disabled: exec: "pyflakes": executable file not found in $PATH
verbose: Found total 0 errors in 4 ms for .github/workflows/ci.yml
actionlint exit=0

$ actionlint   (negative check, copy with runs-on: ubuntu-latst)
.github/workflows/ci.yml:22:14: label "ubuntu-latst" is unknown. available labels are ... [runner-label]
negative exit=1

--- fresh clone /tmp/clone5 @ b227701 ---
$ pnpm install --frozen-lockfile
Done in 67ms using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/orchestrator typecheck: Done
packages/github typecheck: Done
packages/shared typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  8 passed (8)
      Tests  8 passed (8)
test exit=0
```

## Not verifiable in this sandbox

- **The workflow running green on GitHub Actions** for this issue's pull
  request (needs a push; the sandbox can't push).
- **pnpm store caching** taking effect (a cache save on the first run and a
  restore on the second) can only be seen in real runs.
- **Docker on the runner.** Taken from GitHub's documentation of the
  `ubuntu-latest` image; nothing in CI uses it yet.
- **Action inputs.** Because the actions are pinned by SHA, actionlint has no
  metadata for them and doesn't check input names. The `with:` inputs
  (`persist-credentials`, `node-version-file`, `cache`) were checked by hand
  against each action's README at the pinned release.
- actionlint's `pyflakes` rule was disabled (pyflakes isn't installed); it only
  applies to Python `run:` steps, and this workflow has none.

## Notes

- actionlint and ShellCheck were downloaded to `/tmp` only for this check.
  They are not dependencies of the workspace or steps in the workflow.
  Linting workflows in CI could be a later addition.
