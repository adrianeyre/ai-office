# Issue #331: [fix] I2-5 — The app creates the sandboxes' work directory 0755, so any local user on the host, or anything sharing the bind mount, reads every Floor's clone — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker, no Postgres, no second host account; umask `0022`). The fix
is commit `e3bb3ec`,
`fix(security): I2-5 the sandboxes' work directory is private to the app's user`,
on top of `8fef8bd` (#329's). Its blocker, the I2 probe (#287), is in the
tree: `docs/pen-testing/assessments/I2.md` and
`docker/sandbox-dir.pen-test.test.ts`.

This is the remediation of finding **I2-5** (`severity:low` on the
intended deployment, higher on a shared host). The full output of the
checks, run once on the finished tree for all five fixes, is in
[#323's note](issue-323.md#real-output-of-the-checks).

## What was fixed

The app made its work directory with `mkdir(workDir, { recursive: true })`
and no mode. That is the runner's (`runs`), the fact finder's (`facts`)
and the Manager chat's (`manager-chat`), with the root above them. So it
took the umask, `0755` on a stock host, and any local user, or anything
sharing the bind mount, could enter it and read every Floor's clone:
the Owner's private source, history and Agent-written worktrees.

#329 and this fix touch the same code, and agree: `makeWorkDir`
(`packages/orchestrator/src/sandbox/work-dir.ts`), which #329 added to
refuse a link or another user's directory, now also:

- makes the directory, and any directory missing above it, `0700`. The
  mode is given to `mkdir`, so it holds whatever the umask, since a
  umask only removes bits;
- makes an existing directory of its user's `0700` if it had group or
  other access, as every work directory made before this fix has.

The root (`SANDBOX_WORK_DIR`, checked as the server starts) and each
run's own directory are made with it. Every clone is beneath them, so
none can be reached by another user, whatever its own mode.

Under compose, the `sandbox-dir` service now ends with
`chmod 0700 "$dir"`, after its `chown -h`, whether it made the directory
or found it the app's. #329's checks have already refused a link there,
so the `chmod` reaches nothing a link points at.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "I2-5: the
      sandboxes' work directory is private to its owner (no group or
      other access)" is an `it`. Its assertion is unchanged:
      `mode & 0o077` is `0`. It now makes the directory with the app's
      `makeWorkDir`, not with a `mkdir` written in the test.
- [x] **The "pins today" test becomes a regression test; neither is
      deleted.** "regression (I2-5): the work directory the app creates
      is no longer traversable or readable by other local users (not
      0755)": `mode & 0o055` is now `0`.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "holds since I2-5: the root above it, and a directory made before
        the fix, are private too, so no clone beneath is reachable";
      - "holds since I2-5: the sandbox-dir service leaves the directory
        private to the app's user, whether it made it or found it". This
        runs the service's own script on a fresh path, and again after a
        `chmod 0755`;
      - `work-dir.test.ts`: "makes the directory, and any missing above
        it, private to this user" and "makes this user's own directory
        private if it was not, as one made before was".

      Mutation check: with `work-dir.ts` and `docker-compose.yml`
      stashed, the four I2-5 tests in the probe file fail. With the fix,
      all pass.
- [x] **The assessment's findings table marks `I2-5` fixed.** The row
      reads **fixed** (issue #331), with the commit's subject.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See
      [#323's note](issue-323.md#real-output-of-the-checks).

### The tests, verbose

```
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-5: the clones' permissions on the host > regression (I2-5): the work directory the app creates is no longer traversable or readable by other local users (not 0755)
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-5: the clones' permissions on the host > I2-5: the sandboxes' work directory is private to its owner (no group or other access)
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-5: the clones' permissions on the host > holds since I2-5: the root above it, and a directory made before the fix, are private too, so no clone beneath is reachable
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-5: the clones' permissions on the host > holds since I2-5: the sandbox-dir service leaves the directory private to the app's user, whether it made it or found it
✓ |@ai-office/orchestrator| src/sandbox/work-dir.test.ts > makeWorkDir > makes the directory, and any missing above it, private to this user
✓ |@ai-office/orchestrator| src/sandbox/work-dir.test.ts > makeWorkDir > makes this user's own directory private if it was not, as one made before was
```

## Decisions

These are for the Owner to review.

1. **The work directories are `0700`, not each clone.** A clone made
   beneath (`git clone`, Sandcastle's worktrees, the Skills and memory
   directories) keeps the mode Git or Node gives it. No other user can
   reach it through its `0700` parent, which is what "private to the
   app's user" needs. Re-moding every file Git writes would add work to
   every run for no reader it keeps out.
2. **An existing directory is made private, not refused.** Every Office
   that ran before this fix has a `0755` work directory of its own user's.
   Making it `0700` in place is the migration, and nothing breaks.
3. **The sandboxes still reach their mounts.** The host's Docker mounts
   each run's directories by path, as root. The sandbox runs as the
   app's user: UID 1000 under compose, and under `pnpm dev` the UID the
   images were built for, which Sandcastle already requires to match. So
   it still reads and writes them. The Manager chat's read-only clone
   and tools, and each run's Skills and memory, are mounted the same way.

## Noticed, out of scope

- Nothing new beyond #329's note.

## What could not be verified here

There is no Docker or second host account here. These are for the host:

- the directory's mode after `docker compose up` on a stock Linux host;
- that a second local user cannot list or read a Floor's clone beneath
  it;
- that an Agent's sandbox still works its clone, now that the
  directories above are `0700`.

Here the modes were checked with the sandbox's umask of `0022`, on
directories made by `makeWorkDir` and by the service's own script.
