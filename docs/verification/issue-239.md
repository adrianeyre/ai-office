# Issue #239: [fix] P2-1 — The Manager session's allowed `git diff --no-index` reads any file in the container, including the Gateway Key — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model). The fix is commit `b2e269a`,
`fix(security): P2-1 the Manager's session has no shell, and reads only its clone`,
on top of `bc210f8`. Its blocker, the P2 probe (#205), is in the tree:
`docs/pen-testing/assessments/P2.md` and the probe test it names,
`packages/orchestrator/src/models/agent-tool-session.pen-test.test.ts`.

This is the remediation of finding **P2-1** (`severity:high`, H18). P2-2
(#241), P2-3 (#243) and P2-4 (#245) are their own commits and notes.

## What was fixed

The Manager chat's agent session was "read-only" by a command prefix.
Claude Code's allow-rules `Bash(git log:*)`, `Bash(git show:*)` and
`Bash(git diff:*)` let `git diff --no-index /proc/self/environ /dev/null`
print the process's environment, which holds the Manager's Gateway Key.
Its unscoped `Read`, `Grep` and `Glob` rules let its own file tools read
anywhere in the container too.

**The session now has no shell.** It reads through AI Office's own
**repository tools** (`packages/orchestrator/src/manager/repository-tools.ts`),
a small MCP server with no dependencies. Before each turn, AI Office
writes it to `<SANDBOX_WORK_DIR>/manager-chat/<floor>/tools` and mounts
that directory read-only at `/home/agent/ai-office`. The agent tool starts
it as `node /home/agent/ai-office/repository-tools.ts /home/agent/workspace`
and talks to it over standard input and output. It serves `read_file`,
`list_files`, `search`, `git_log`, `git_show` and `git_diff`, and each
tool:

- runs `git` with `execFile`, never a shell, with arguments AI Office
  builds;
- takes a revision only if it looks like one (a name, a hash, `~`, `^`,
  `@{…}`, a range for `git_log`). It never takes one that starts with `-`,
  holds `:` or is absolute;
- takes a path only if it is relative, has no `.` or `..` segment and
  does not start with `-`. The path is passed literally
  (`--literal-pathspecs`) after `--`;
- always puts `--` after its revisions, even when no path is given. Without
  `--`, `git diff a b` compares two files, outside the repository too,
  when `a` and `b` are not revisions. This was found while testing:
  `git diff a.txt ../outside.txt` printed the outside file;
- reads the clone's objects at its default branch (`git show HEAD:path`,
  `ls-tree`, `grep … HEAD`), never its files. A symlink in the repository
  is therefore read as the link it is, never as the file it points to;
- runs Git with an environment of its own (`gitToolEnvironment`). It has
  none of the tool's variables, so no Gateway Key, and no system or
  global config. `--no-ext-diff --no-textconv` are always set, and
  `core.fsmonitor`, `core.hooksPath` and `diff.external` are neutralised.

**Claude Code** (`claudeSessionArgs`):

- is given `Read`, `Grep`, `Glob`, `WebSearch` and `WebFetch`, but not
  `Bash`;
- is allowed `Read(//home/agent/workspace/**)`,
  `Read(//home/agent/attachments/**)`, `WebSearch`, `WebFetch` and the
  repository tools' `git_log`, `git_show` and `git_diff`;
- refuses `Bash`, `Read(//proc/**)`, `Read(//sys/**)` and
  `Read(//home/agent/.claude/**)`, plus the write tools it already refused;
- gets the repository tools through `--mcp-config`, beside
  `--strict-mcp-config`.

**Codex** (`codexSessionArgs`) has its shell turned off
(`features.shell_tool=false`, `features.unified_exec=false`). It is given
the repository tools through `mcp_servers.repository.*` and stays
`--sandbox read-only`.

The Manager's prompt now says it reads the history through its repository
tools and has no shell.

### Sibling paths with the same flaw, fixed and tested

1. **Claude Code's built-in read-only commands.** With `Bash` offered,
   Claude Code runs its own read-only set (`cat`, `grep`, `head`,
   read-only `git`, …) without asking, in every mode, `dontAsk` included,
   so `cat /proc/1/environ` needed no allow-rule at all. `Bash` is no
   longer offered, and it is refused. Tested: "regression (P2-1): no Bash
   rule is allowed and no shell is given …".
2. **Unscoped `Read`/`Grep`/`Glob` allow-rules.** These let the file tools
   read `/proc/self/environ` directly. They now cover only the clone and
   the turn's images, and `/proc`, `/sys` and the tool home are refused.
   Tested: "P2-1: no file tool may read the process's environment …".
3. **Codex's shell.** Codex's read-only sandbox stops writes, not reads:
   any command it ran could read `/proc/1/environ`. The shell is off.
   Tested: "regression (P2-1): Codex's env carries the Gateway Key too,
   and Codex has no shell to read it with".
4. **The Manager's one-call answers through Codex**
   (`agentToolModelClient`, used when only a ChatGPT subscription can
   serve a Manager's call). This ran `codex exec` with its shell on as
   well, and now runs with it off. Tested in `agent-tool-client.test.ts`.
5. **`git diff` reading two files when its arguments are not revisions**,
   and **a symlink in the clone pointing out of it.** Both are closed by
   the tools' `--` and object-only reads. Tested in
   `repository-tools.test.ts`.

## Decisions

These need a decision the PRD and ADRs don't make. I took the most
conservative option that keeps the product working; they are recorded
here for the Owner.

- **The history is read through AI Office's tools, not a shell.** FR-24
  says the session "may only read, search and list files, read the
  history (`git log`, `git show`, `git diff`), and search and fetch the
  web". That still holds, through `git_log`, `git_show` and `git_diff`.
  The PRD is unchanged. The guide (`docs/guide/events-and-chat.md`) now
  describes the tools.
- **Codex reads files through the tools too.** With its shell off, Codex
  reads the clone with `read_file`, `list_files` and `search`, which read
  the default branch's objects. It can no longer run, say, `rg` or
  `ls -la`. It never could change anything.
- **A path that begins with `-` is refused** by the repository tools,
  even though it is passed after `--`. A repository file whose name starts
  with `-` cannot be read through them.
- **The Gateway Key stays in the tool's environment.** Claude Code and
  Codex need it to reach the Gateway. The fix is that nothing the session
  may run can read it, not that it is gone. Keeping it out of the
  container would take a per-turn credential minted by the Gateway, which
  is a larger design (see #195 for the key's scope).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "P2-1: no
      Bash command the session may run can read a file outside the clone"
      is an `it` with its assertion unchanged, and it passes (output
      below). P2-2's `it.fails` used the same allow-rules, so it began to
      pass with this commit. Vitest fails an `it.fails` that passes, so it
      became an `it` here too. #241 records it.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** All three pins remain, each
      now asserting the old behaviour is gone:
      - *"the three git prefixes are the only Bash allowed …"* now asserts
        that no `Bash` rule is allowed, `Bash` is neither offered nor
        allowed, and the file tools are scoped.
      - *"real git prints an outside file"* still shows that Git itself
        prints it. It then asserts that every way the session's tools
        could ask for that file is refused before Git runs.
      - *"the Gateway Key is in the session's environment"* (Claude Code
        and Codex) still asserts that the key is there. It now also
        asserts that nothing the session runs can read it: no shell,
        `/proc` refused, Git's environment holding none of the tool's.

      No test was deleted. The file has 9 tests after this commit, up
      from 7, and 11 at the branch head (P2-2's commit adds two).
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. `repository-tools.test.ts` adds 23 tests, which run the real
      tools on a real repository and the real server as a separate Node
      process over stdio, with a fake Gateway Key in its environment that
      never appears in an answer. `agent-tool-session.test.ts`,
      `agent-tool-client.test.ts` and `chat-sessions.test.ts` pin the new
      flags and the read-only tools mount.
- [x] **The assessment's findings table marks `P2-1` fixed.**
      `docs/pen-testing/assessments/P2.md`: **fixed** (issue #239), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` has three failures, and all three were
      already failing before this fix and lie outside it (see below).

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

- **Real Claude Code and Codex reading these flags.** There is no live
  agent tool or Docker here. The arguments are pinned by tests, and the
  MCP server is tested as a separate process speaking JSON-RPC over
  stdio. These were not run inside a sandbox image:
  - Claude Code's `--mcp-config`, `Read(//…)` and deny rules under
    `dontAsk`;
  - Codex's `features.shell_tool=false`, `features.unified_exec=false`
    and `mcp_servers.*`.

  The flag names come from each tool's own documentation (Claude Code's
  permissions page; Codex's configuration reference). A Codex version that
  ignored an unknown feature key would keep its shell. **Retest on the
  pen-test stack:** position 3's harness would run
  `git diff --no-index /proc/self/environ /dev/null`, `cat /proc/1/environ`
  and a `Read` of `/proc/self/environ` inside a live Manager session for
  each tool, and should get a refusal.
- **Node in the sandbox image running the `.ts` server.** The images pin
  Node 26.10.0, which strips types by default, and the test spawns the
  file with this sandbox's Node 26.10.0. The image itself was not run.
- **Egress.** `WebFetch` still reaches any host (S2-1). What the session
  can read is now the clone, the turn's images and the web.

## Noticed, out of scope

- `pnpm test`'s cross-reference test fails on eight P1 (#194) probe files
  merged at `a3c8bcf` without their assessment (`P1.md` is not in the
  tree). This was the case before this fix, which touches none of them.
- `agent-tool-session.pen-test.test.ts` failed ESLint at `bc210f8`
  (`use-unknown-in-catch-callback-variable`, a typed `catch` variable).
  It is fixed in this commit, since the file was being edited anyway.
