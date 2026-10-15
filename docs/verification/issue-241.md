# Issue #241: [fix] P2-2 — The same allow-rules permit `git diff --output=FILE` and `git log --output=FILE`, which write a file to any writable path — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model). The fix is commit `a0dcede`,
`fix(security): P2-2 nothing the Manager's session may use writes a file`,
on top of P2-1's `b2e269a` (#239). Its blocker, the P2 probe (#205), is in
the tree: `docs/pen-testing/assessments/P2.md` and
`packages/orchestrator/src/models/agent-tool-session.pen-test.test.ts`.

This is the remediation of finding **P2-2** (`severity:medium`, H18).

## What was fixed

`git diff --output=FILE` and `git log --output=FILE` began an allowed
prefix (`Bash(git diff:*)`, `Bash(git log:*)`). The "read-only" session
could therefore write files anywhere its container let it, including the
read-write tool-home mount (`/home/agent/.claude` or `.codex`), which
persists across turns and restarts.

**P2-1's fix (#239) took away the shell those commands ran in.** Claude
Code is given no `Bash`, Codex's shell is off, and the history is read
through AI Office's repository tools. That alone closes the exercised
vectors. This commit closes the write side in depth:

- **Claude Code refuses writing any path at all:** `Edit(//**)` is added
  to its deny rules. An `Edit` rule covers every built-in tool that writes
  a file. Per Claude Code's permissions documentation, it also covers the
  target of an output redirect (`> file`, `>> file`, `2> file`) and of
  `tee`. `Edit`, `Write`, `MultiEdit` and `NotebookEdit` stay refused,
  and none is offered.
- **The repository tools accept no option.** A revision, a path or
  anything else that begins with `-` is refused before Git runs. (A path
  starting with `-` was harmless after `--`, but it is refused anyway.)
  The one exception is a search pattern, which is given after `-e` as the
  pattern.
- **The repository tools' Git commands write nothing.** `show`,
  `ls-tree`, `grep`, `log` and `diff` run with no write option set. `GIT_OPTIONAL_LOCKS=0` stops Git from refreshing or locking
  the index. The clone is mounted read-only in any case.
- **Codex** stays `--sandbox read-only` and has no shell.

The tool home is still mounted read-write, because the agent tool itself
keeps its sessions there (FR-24: a session survives a restart). That is
the tool writing its own state, not a command the session may run.

### Sibling paths with the same flaw, fixed and tested

- **Output redirects and `tee`**, which a shell prefix-rule never bound.
  There is no shell, and `Edit(//**)` refuses them too.
- **Every repository tool given an option in every argument it takes**
  (`--output=…`, `-o…`, `--open-files-in-pager=…`). All are refused, and
  only a search pattern is let through, as the pattern after `-e`. Tested:
  "P2-2: no repository tool can be given an option …".
- **The index and lock files**, which even a read-only Git command may
  write. Tested by running every tool on a real repository and comparing
  every file's size and mtime, `.git` included, before and after.

## Decisions

- **Refusing a path that begins with `-`**, although it would be safe
  after `--` (see #239's note). A repository file whose name starts with
  `-` cannot be read through the tools.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "P2-2: no
      Bash command the session may run can write a file" became an `it` in
      P2-1's commit `b2e269a`, with its assertions unchanged. That commit
      removed the `Bash(git diff:*)`/`Bash(git log:*)` rules both probes
      exercise, so the `it.fails` passed, and Vitest fails an `it.fails`
      that passes. It passes (output below).
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
      - *"the allow-rules permit `--output`"* (shared with P2-1's pin) now
        asserts that `git diff --output=…` and `git log --output=…` no
        longer pass the allow-rules.
      - *"real git writes the file"* still shows that Git itself writes
        with `--output`. It now asserts that the session's tools refuse
        `--output` for `git_diff` (both sides), `git_log` and `git_show`,
        and that running every tool leaves every file unchanged.

      No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. One more test, "P2-2: no tool the session may use writes a
      file, anywhere, the tool home included", pins Claude Code's deny
      rules and Codex's read-only, shell-less flags.
- [x] **The assessment's findings table marks `P2-2` fixed.**
      `docs/pen-testing/assessments/P2.md`: **fixed** (issue #241), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` has three failures, all of them already
      failing before this fix and outside it (see below).

## Real output of the checks

The three checks were run on the branch head after every fix (`705f392`).

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: three failures, all already failing before these fixes, none in them

```
 FAIL  |repository| test/pen-testing.test.ts > the pen-test cross-reference > finds every probe test holding an it.fails referenced by an assessment
AssertionError: expected [ …(8) ] to deeply equal []
+   "packages/orchestrator/src/context/fresh-start.pen-test.test.ts",
+   "packages/orchestrator/src/decision-model/decision-model.pen-test.test.ts",
+   "packages/orchestrator/src/intake/intake.pen-test.test.ts",
+   "packages/orchestrator/src/memory/role-review.pen-test.test.ts",
+   "packages/orchestrator/src/merge/merge.pen-test.test.ts",
+   "packages/orchestrator/src/review/prompt.pen-test.test.ts",
+   "packages/orchestrator/src/sandbox/runner.pen-test.test.ts",
+   "packages/orchestrator/src/skills/skills.pen-test.test.ts",

 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/

 Test Files  3 failed | 438 passed (441)
      Tests  3 failed | 4855 passed | 51 expected fail | 603 skipped (5512)
   Duration  257.52s
test exit 1
```

- **The two `@ai-office/web` failures** are the ones #205 recorded. The
  root `CHANGELOG.md`'s top entry is `## 1.0.0` with no release date,
  and none of these fixes touches it or `apps/web`.
- **The cross-reference failure** names eight P1 (#194) probe files that
  hold an `it.fails` and that no assessment references. They came onto
  the branch with the P1 probe's merge (`a3c8bcf`), and `P1.md` is not in
  `docs/pen-testing/assessments/`. At `bc210f8`, before these fixes, all
  eight are in the tree, each holds an `it.fails`, and none is referenced
  (`git grep` of each path at `bc210f8` in the assessments finds nothing).
  None of these fixes touches them. No P2 probe file holds an `it.fails`
  any more.
- **The 51 expected fails** are other probes' open findings (A1, S2, P1).
  None of them is P2's.
- **The skips** are the Postgres and Docker tests, skipped with their
  reason in this sandbox.

No test was skipped, deleted or weakened to reach this state.

### The probe and the tools on their own

```
# vitest run agent-tool-session.pen-test.test.ts, repository-tools.test.ts,
#   agent-tool-session.test.ts, agent-tool-client.test.ts, chat-sessions.test.ts
✓ agent-tool-session.pen-test.test.ts > … > regression (P2-1): no Bash rule is allowed and no shell is given; only WebFetch still sends
✓ agent-tool-session.pen-test.test.ts > … > regression (P2-1, P2-2): commands that read outside the clone and write files no longer pass the allow-rules
✓ agent-tool-session.pen-test.test.ts > … > P2-1: no Bash command the session may run can read a file outside the clone
✓ agent-tool-session.pen-test.test.ts > … > P2-1: no file tool may read the process's environment, the kernel's files or the tool's own state
✓ agent-tool-session.pen-test.test.ts > … > P2-2: no Bash command the session may run can write a file
✓ agent-tool-session.pen-test.test.ts > … > P2-2: no tool the session may use writes a file, anywhere, the tool home included
✓ agent-tool-session.pen-test.test.ts > … > P2-2: no repository tool can be given an option, and none of their Git commands is one that writes
✓ agent-tool-session.pen-test.test.ts > … > regression (P2-1): git diff --no-index still prints a file outside the repository, but the session's tools cannot ask for it
✓ agent-tool-session.pen-test.test.ts > … > regression (P2-2): git diff --output still writes a file, but the session's tools cannot ask for it, and running them writes nothing
✓ agent-tool-session.pen-test.test.ts > … > regression (P2-1): Claude Code's env carries the Gateway Key, which it needs, but nothing the session runs can read /proc/self/environ
✓ agent-tool-session.pen-test.test.ts > … > regression (P2-1): Codex's env carries the Gateway Key too, and Codex has no shell to read it with
 Test Files  5 passed (5)
      Tests  63 passed | 1 skipped (64)

# vitest run repository-tools.test.ts
      Tests  24 passed (24)
```

The one skip is `chat-sessions.test.ts`'s Docker case.

## What could not be verified here

- **Claude Code honouring `Edit(//**)`** for its tools and for redirect
  targets, and **Codex honouring `features.shell_tool=false`**, were not
  run in a live tool. There is no agent tool or Docker here; the flags
  are pinned by tests. **Retest on the pen-test stack:** position 3's
  harness would try `git diff --output=/home/agent/.claude/x`, `> file`
  and a `Write` from inside a live Manager session for each tool. Each
  should be refused, and the tool home should show no new file.

## Noticed, out of scope

- `pnpm test`'s cross-reference test fails on eight P1 (#194) probe files
  merged without their assessment. This was the case before this fix; see
  #239's note.
