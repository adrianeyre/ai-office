# Issue #313: [fix] I1-7 — pages.yml grants pages: write and id-token: write to every job, the build job included — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no GitHub Actions runner). The fix is commit `5e0b3f3`,
`fix(security): I1-7 only the Pages deploy job holds pages: write and id-token: write`,
on top of `cf7d473` (I1-6's fix, #311), with which it agrees: write scopes
are a job's own, never a workflow's. Its blocker, the I1 probe (#197), is
in the tree: `docs/pen-testing/assessments/I1.md` and
`test/ci-workflows.pen-test.test.ts`.

This is the remediation of finding **I1-7** (`severity:low`, H20). The
full output of the checks, run once on the finished tree for all four
fixes, is in [#307's note](issue-307.md#real-output-of-the-checks).

## What was fixed

`pages.yml` granted `pages: write` and `id-token: write` at the top, so
the `build` job, which only runs `node site/build.ts` and uploads an
artifact, held a token that could publish the site and mint an OIDC
token it never used.

- The workflow is `contents: read`.
- `build` has `contents: read` and `pages: read`: Configure Pages reads
  the site's settings and writes nothing.
- `deploy` alone has `pages: write` and `id-token: write`, the two
  `actions/deploy-pages` needs.

### Sibling paths

- **Every workflow:** a test checks that no workflow grants a write scope
  at the top, and that the only jobs holding one are `pages.yml`'s
  `deploy` and `release.yml`'s `publish` (I1-6). `ci.yml` was already
  `contents: read` throughout.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "the Pages
      build job holds no pages or id-token write scope it does not use"
      is an `it`, its assertion unchanged.
- [x] **The "pins today" test becomes a regression test; it is not
      deleted.** "regression (I1-7): pages: write and id-token: write are
      no longer top-level; only the deploy job holds them" (top-level
      `contents: read`; `build` `contents: read, pages: read`; `deploy`
      `pages: write, id-token: write`).
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "no workflow grants a write scope workflow-wide";
      - "every job that holds a write scope says so itself, and the Pages
        build job holds none".
      Mutation check: with the old `pages.yml` put back, four tests fail
      (the regression test, the former `it.fails` and both siblings); put
      back, all pass.
- [x] **The assessment's findings table marks `I1-7` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #313) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on the five tests that failed
      before this work and the same after (see
      [#307's note](issue-307.md#noticed-out-of-scope)); every other test
      passes.

### The probe tests, verbose (I1-7)

```
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-7 (H20): pages.yml grants deploy scopes to the build job > regression (I1-7): pages: write and id-token: write are no longer top-level; only the deploy job holds them
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-7 (H20): pages.yml grants deploy scopes to the build job > the Pages build job holds no pages or id-token write scope it does not use
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-7 siblings: write scopes are a job's own, in every workflow > no workflow grants a write scope workflow-wide
✓ |repository| test/ci-workflows.pen-test.test.ts > I1-7 siblings: write scopes are a job's own, in every workflow > every job that holds a write scope says so itself, and the Pages build job holds none
```

The rest of the file, the CI hygiene line ("Confirm, don't re-test") and
I1-6's tests included, passes: `Tests  14 passed (14)`.

## Decisions

For the Owner to review.

1. **`pages: read` for the build job.** Configure Pages asks GitHub for
   the Pages site's settings. A job-level `permissions:` replaces the
   workflow's entirely, so without `pages: read` the build job would have
   no Pages scope at all, and the read may be refused. Its output is not
   used by `site/build.ts`, so removing the step was the alternative;
   keeping it with a read scope changes nothing about what is built.
2. **`deploy` holds no `contents: read`.** It checks nothing out; Deploy
   Pages publishes the artifact `build` uploaded, which it reaches with
   the run's own artifact token, as GitHub's example for the action
   shows.

## Noticed, out of scope

- The five tests that fail before and after: see
  [#307's note](issue-307.md#noticed-out-of-scope).

## What could not be verified here

There is no GitHub Actions runner here. On the next push to `main` that
changes the site (or a manual run): the `build` job's Configure Pages
step should succeed with `pages: read`, and `deploy` should publish
with only `pages: write` and `id-token: write`. If Configure Pages is
refused, give `build` nothing more than it needs, or drop the step,
rather than putting the write scopes back at the top.
