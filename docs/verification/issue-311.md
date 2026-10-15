# Issue #311: [fix] I1-6 — release.yml runs pnpm install and semantic-release in a job holding contents, issues and pull-requests write — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0,
git 2.39.5; no Docker, no GitHub Actions runner). The fix is commit
`cf7d473`,
`fix(security): I1-6 no release job that runs dependency code holds a write token`,
on top of `f973b4f` (I1-5's fix, #309). Its blocker, the I1 probe (#197),
is in the tree: `docs/pen-testing/assessments/I1.md` and
`test/ci-workflows.pen-test.test.ts`.

This is the remediation of finding **I1-6** (`severity:low`, H20). The
full output of the checks, run once on the finished tree for all four
fixes, is in [#307's note](issue-307.md#real-output-of-the-checks).

The issue's "What the fix must make true" repeats the assessment's
"could not be exercised" line for I1-6 (confirm on a real release that
`GITHUB_TOKEN` is in the environment while dependency code runs). The
fix was made against the assessment's property for I1-6: "No job that
runs third-party dependency code holds a write token; the release that
needs one runs that step with the narrowest scope and nothing untrusted
alongside it", which is also the probe's `it.fails`. After the fix, no
job that runs dependency code has a `GITHUB_TOKEN` to find; the canary
check on a real release is below, under what could not be verified.

## What was fixed

`release.yml` had one job, holding `contents`, `issues` and
`pull-requests: write`, that ran `pnpm install` (and the install scripts
it allows) and then `pnpm exec semantic-release` with `GITHUB_TOKEN` in
its environment. Any package in that tree could push to `main`, move
tags, and write issues and pull requests.

It is two jobs now:

- **`release`** (`contents: read`, no `GITHUB_TOKEN`) installs the
  dependencies and runs `release/plan.ts`: semantic-release in dry-run,
  with only the commit analyser and the release-notes generator
  (`.releaserc.json`, which also says `"dryRun": true`). semantic-release
  checks it may push (`git push --dry-run`) and fetches from the origin
  address; for the length of the run, the clone's own Git configuration
  sends that address to the clone itself (`url.<clone>.insteadOf`), so
  neither needs a credential, and the notes' links still name the
  repository on GitHub. The version, commit and notes are the job's
  outputs.
- **`publish`** (`contents: write` only) needs `release` and runs only
  if it planned a version. It checks out, sets up Node with GitHub's own
  actions, installs nothing, and runs `release/publish.ts`, which imports
  nothing but Node's own modules. That script treats the plan as
  untrusted: the version must be a plain `x.y.z` above every `v*` tag
  (so no tag is ever moved), the commit the one checked out, and the
  notes at most 125,000 characters with no NUL. It then sets
  `package.json`'s version, puts the notes on top of `CHANGELOG.md` as
  `@semantic-release/changelog` did, commits as `github-actions[bot]`
  with `chore(release): <version> [skip ci]` and the notes, tags
  `v<version>`, pushes the commit and the tag together (`--atomic`, the
  token in Git's environment as an `extraheader`, never on its command
  line), and creates the GitHub release through the REST API.
- What `release` hands on reaches the script through `env:`, never as a
  `${{ … }}` inside `run:`, so a planted version or note cannot become a
  shell command.

### Sibling paths

- **Every workflow, every job:** a test now checks that no job in any
  workflow that runs third-party code (a package manager,
  semantic-release, or an action not GitHub's own) holds a write scope.
  `ci.yml` and `pages.yml`'s jobs pass it; `pages.yml`'s own write scopes
  are I1-7's fix.
- **Script injection between jobs:** no workflow writes an expression
  into a `run:` script.
- **Unused plugins removed:** `@semantic-release/changelog` and
  `@semantic-release/git` did the writing the old job did; with
  `publish.ts` doing it, they are gone from `package.json` and the
  lockfile (deletions only).
- **`packages/shared/src/version.ts`**'s comments said semantic-release
  sets the version and tags; they now name the release workflow.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "no job
      that runs third-party dependency code holds a write token" is an
      `it`, its body unchanged. It looks at the `release` job, which
      still installs (`pnpm install`) and runs semantic-release, so it
      passes because that job holds no write scope, not because the job
      is missing (the regression test below checks it is there).
- [x] **The "pins today" tests become regression tests; neither is
      deleted.**
      - "regression (I1-6): the release job still installs and runs
        semantic-release, but holds contents: read only, and no
        GITHUB_TOKEN";
      - "regression (I1-6): the top-level permissions are contents: read,
        and the only write grant is the publish job's contents: write"
        (the job grants, in full: `release` read, `publish`
        `contents: write`).
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "no job in any workflow that runs third-party code holds a write
        scope";
      - "the publish job runs only GitHub's own actions and
        release/publish.ts, with its token in the environment";
      - "no workflow writes an expression into a script, so what the
        release job hands on cannot become a command";
      - `test/release.test.ts`: what `publish.ts` accepts and refuses
        (versions such as `1.2.3\nversion=9.9.9` and `1.2.3 && curl …`, a
        version at or below a tag, another commit, oversized or NUL
        notes); that it imports only `node:` modules; end to end against
        a bare remote and a fake GitHub API (the release commit on top of
        the planned commit, the tag on it, the changelog and version, one
        `POST /repos/owner/repo/releases`), and that a refused plan pushes
        nothing and asks GitHub nothing; and `plan.ts` end to end with the
        origin at `https://github.com/owner/repo` and no credential
        (version 1.1.0, the compare link, nothing tagged, the Git
        configuration left as it was), and with nothing to release.
      Mutation check: see [below](#mutation-check).
- [x] **The assessment's findings table marks `I1-6` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #311) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on the five tests that failed
      before this work and the same after (see
      [#307's note](issue-307.md#noticed-out-of-scope)); every other test
      passes.

### The probe tests, verbose (I1-6)

```
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-6 (H20): release.yml runs dependency code with a write token > regression (I1-6): the release job still installs and runs semantic-release, but holds contents: read only, and no GITHUB_TOKEN
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-6 (H20): release.yml runs dependency code with a write token > regression (I1-6): the top-level permissions are contents: read, and the only write grant is the publish job's contents: write
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-6 (H20): release.yml runs dependency code with a write token > no job that runs third-party dependency code holds a write token
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-6 siblings: every workflow, the publish job, and what passes between jobs > no job in any workflow that runs third-party code holds a write scope
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-6 siblings: every workflow, the publish job, and what passes between jobs > the publish job runs only GitHub's own actions and release/publish.ts, with its token in the environment
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-6 siblings: every workflow, the publish job, and what passes between jobs > no workflow writes an expression into a script, so what the release job hands on cannot become a command
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > accepts a plain version above every tag, for the commit checked out
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > refuses anything but a plain version
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > refuses a version at or below one already tagged, so no tag is ever moved
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > refuses a release planned for another commit
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > refuses notes that are not plain text of a bounded size
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > sets package.json's own version, never a nested one, keeping its layout
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > puts the notes on top of the changelog, as semantic-release's changelog did
✓ |repository| test/release.test.ts > release/publish.ts checks what it is handed > imports nothing but Node's own modules, so no dependency code runs beside the token
✓ |repository| test/release.test.ts > release/publish.ts, end to end > commits the version and notes, tags and pushes them together, and creates the release
✓ |repository| test/release.test.ts > release/publish.ts, end to end > pushes nothing and creates no release when what it is handed fails its checks
✓ |repository| test/release.test.ts > release/plan.ts, end to end > works out the next version and its notes with no credential, pointing semantic-release's Git at the clone itself
✓ |repository| test/release.test.ts > release/plan.ts, end to end > plans nothing when there is nothing to release
```

`release/plan.ts` was also run with plain `node`, as the workflow runs
it, in a throwaway repository (a `fix:` commit after `v1.0.0`, origin
`https://github.com/owner/repo`, `GITHUB_OUTPUT` set): it printed
`Planned release 1.0.1 of 0fd5dfd…`, wrote `version=1.0.1`, `git-head=…`
and the notes between a random delimiter to the outputs file, and left
no `insteadOf` in the clone's configuration.

### Mutation check

- With the old `release.yml` put back, five tests fail: both regression
  tests, the former `it.fails`, "no job in any workflow that runs
  third-party code holds a write scope" and the publish-job test.
- With `${{ needs.release.outputs.version }}` written into the publish
  step's `run:`, two fail: the publish-job test and "no workflow writes
  an expression into a script".

Put back, all pass.

## Decisions

For the Owner to review.

1. **semantic-release still decides the version, in a job that cannot
   write.** Reimplementing Conventional Commits analysis in first-party
   code would have removed dependency code from the release entirely,
   but it is a large, error-prone rewrite of a solved problem. Running it
   read-only and checking its answer in a job that runs none of it keeps
   the behaviour.
2. **What the read-only job hands on is untrusted.** A compromised
   dependency there could still choose the release's notes (they land in
   `CHANGELOG.md` and the release body, as text) or a higher version. It
   cannot push code, move or delete a tag, or force-push: the version
   must be above every tag, the commit is the one checked out, and the
   push is the release commit on top of it and one new tag, atomically.
3. **No more release comments on issues and pull requests.**
   `@semantic-release/github` commented "released in vX" and labelled
   them, which needed `issues` and `pull-requests: write`. Doing it from
   `publish.ts` would need the list of included issues from the
   untrusted job; the scopes are dropped instead. The GitHub release and
   the changelog still list every change with links.
4. **No more semantic-release Git notes.** semantic-release recorded each
   tag's channel in `refs/notes/semantic-release`; with one release
   branch and no channels, a tag without a note is read as the default
   channel, which is what every release here is.
5. **The release commit is by `github-actions[bot]`**, not
   `semantic-release-bot`, since semantic-release no longer makes it.
6. **The redirect is in the clone's Git configuration**, not the
   environment: semantic-release runs one of its Git commands
   (`ls-remote` in `lib/branches/expand.js`) without the environment it
   is given. The redirect is removed again when the plan ends, whether
   it succeeds or not.
7. **New code at the repository root, `release/`,** for the two scripts,
   type-checked and linted with the rest (`tsconfig.json` includes it)
   and tested in the `repository` project.

## Noticed, out of scope

- **The `release` job still installs the whole workspace**
  (`pnpm install --frozen-lockfile`), all of which can run in it. With a
  read-only token that is the CI jobs' footing too. Installing only the
  root's development dependencies would shrink it further.
- The five tests that fail before and after: see
  [#307's note](issue-307.md#noticed-out-of-scope).

## What could not be verified here

There is no GitHub Actions runner here. On a merge to `main`:

- **The canary the issue names:** a step or dependency in the `release`
  job that prints whether `GITHUB_TOKEN` (or `GH_TOKEN`) is set should
  find neither, and the job's token should be refused a push.
- **The whole release:** `release` plans a version against the real
  tags with a read-only checkout, and `publish` pushes the release commit
  and tag to `main` and creates the release. Branch protection that
  forbids direct pushes to `main` refuses both the old job's push and
  this one, unless the Actions bot is allowed.
- **Large notes as a job output:** outputs are limited to 1 MB per job;
  the notes of one release are far smaller, and `publish.ts` refuses
  more than 125,000 characters.
