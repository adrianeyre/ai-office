# Issue #203: [fix] S1-2 — Sandcastle's host-side git runs an Agent-written worktree's hooks — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no network beyond the registry and the model). The fix
is commit `fbd4c71`,
`fix(security): S1-2 Sandcastle's host-side git runs nothing an Agent's repository names`,
on top of `93f7a02`. Its blockers are in the tree: the S1 probe (#186:
`docs/pen-testing/assessments/S1.md` and
`packages/orchestrator/src/sandbox/sandcastle-git.pen-test.test.ts`) and
the S1-1 fix it builds on (#201: `dd458e7`, `runGit` in
`packages/orchestrator/src/git/command.ts`).

This is the remediation of finding **S1-2** (`severity:critical`, H1)
only. Sandcastle itself is not changed: the fix is in how AI Office runs
it.

## What was fixed

Sandcastle (`@ai-hero/sandcastle` 0.12.0) runs Git **in the app's
process**, in the clone whose `.git` the Agent's sandbox has had mounted
read-write. Reading its installed `dist/` shows these calls in one run
with the `branch` strategy, the one the sandbox runner uses:

| When | Commands (on the host) |
|---|---|
| Before the sandbox | `rev-parse --abbrev-ref HEAD`; `worktree prune`; `worktree list`; then either `worktree add [-b] <path> <branch>`, or, reusing a worktree, `status --porcelain`, `symbolic-ref`, `fetch origin <branch>`, `rev-parse`, `merge --ff-only origin/<branch>` |
| While the sandbox runs | `config user.name` / `user.email`; `rev-parse HEAD`; after the Agent, `rev-list <base>..refs/heads/<branch>` |
| After the sandbox has stopped | `status --porcelain` (keep a dirty worktree), `worktree remove --force` |

All of these run `git` **from the PATH**, with the app's whole
environment (`execFile("git", …, { env: { ...process.env, LC_ALL: "C" } })`
for worktree management, and `exec("git …")` for the rest). That is the
only part of them AI Office can choose. So:

- **A guarded `git` first on the app's PATH.**
  `guardSandcastleGit()` (`sandbox/sandcastle-git.ts`) puts
  `packages/orchestrator/src/git/bin/git` first on `process.env.PATH`,
  once. `createSandboxRunner` and `createSandboxFactFinder` call it, so it
  is in place before any Sandcastle run. That `git` is a two-line shell
  script that runs `git/guard.ts` with Node. The guard runs the real Git
  **exactly as `runGit` does since S1-1**, through the same code
  (`gitEnvironment`, now exported from `command.ts`). It reads the
  repository first (following `-C`), empties each driver it names, and
  refuses one that names a remote's program. It turns hooks,
  `core.fsmonitor`, `diff.external`, credential helpers and signing off
  on Git's command line, and allows only the `file` and `https`
  transports. Git's environment is `runGit`'s; of the caller's, only the
  locale and a commit's identity are kept. Git's output, error messages
  and exit status pass through unchanged, so Sandcastle still reads them
  (it matches `invalid reference` when it makes a new branch).
  `runGit` takes the guard out of its PATH, so AI Office's own Git never
  runs it twice.
- **`core.alternateRefsCommand`** is now set again too (to `true`, which
  lists no refs). The S1-1 note left it out because no call site fetched
  *into* an Agent's repository. Sandcastle's `fetch origin <branch>` on a
  reused worktree does exactly that, and the new test showed it ran there
  even through the guard. It is in `runGit`'s list, so it also covers
  any future call site of AI Office's own.

### Sibling path: fact-finding's merge-back

Fact-finding (Grilling Sessions and chat research, `grilling/fact-finding.ts`)
ran Sandcastle with the **`head`** strategy, in the clone itself. There,
once the Agent has committed, Sandcastle *merges it back* on the host:
`git checkout --detach` in the sandbox, then `git merge "<branch>"` and
`git branch -D` on the host, **before** it stops the sandbox. The guard
covers that merge's hooks and its static settings. But it empties drivers
by reading the config *first*, which is only sound while nothing writes
the repository (the same reason the S1-1 fix made a Fresh Start stop its
sandbox before saving). A process the Agent left running in its sandbox
could change the config between the guard's read and Git's.

Fact-finding now works on a branch of its own (`ai-office/fact-<sandbox>`,
from the default branch), deleted with the clone. With the `branch`
strategy, the only host Git Sandcastle runs while a sandbox is alive is
`config`, `rev-parse` and `rev-list`. None of those reads attributes or
runs a driver, and the rest is turned off whatever the config says. The
answer is still thrown away when the Agent changed anything: the branch's
head must still be the default branch's, and a worktree Sandcastle kept
(it keeps one only when something is left uncommitted) must be clean.

The sandbox runner already used `branch`. Its post-sandbox `status` runs
after Sandcastle has stopped the sandbox, and its pre-sandbox calls run
before the session's sandbox starts. A Fresh Start's next session starts
only after `runSandcastle` has returned (S1-1's ordering).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** Both
      `it.fails` in `sandcastle-git.pen-test.test.ts` (post-checkout on
      `git worktree add`, post-merge on `git merge`) are now `it`, with
      their bodies unchanged. A `beforeAll` installs the guard as AI Office
      does, then the same `execGit` (Sandcastle's exact environment and
      subcommands) runs them. Both pass (output below).
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** The two pins are now
      `regression (S1-2): … no longer runs …`. They assert that the marker
      is absent where they used to assert that it was written, and that
      the worktree was still made and the merge still happened. No test
      was deleted: the file has 11 tests, up from 4.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `sandcastle-git.pen-test.test.ts`, new `describe("S1-2 ·
        Sandcastle's other host-side Git runs nothing the repository
        names")`: `core.fsmonitor` on `status` (reuse and clean-up); a
        smudge filter on `worktree add`; a clean filter on `status`; the
        fast-forward of a reused worktree from origin (`fetch`, then
        `merge --ff-only`) with `post-merge`, `post-checkout` and
        `reference-transaction` hooks and a smudge filter planted;
        `core.alternateRefsCommand` on a fetch into a repository with
        alternates; and a `remote.origin.uploadpack` refused on `fetch`.
      - `sandcastle-git.pen-test.test.ts`, new `describe("S1-2 · real
        Sandcastle, twice on one clone, as AI Office drives it")`. This is
        real Sandcastle `run` with the fake sandbox provider through
        `allowListed`, as the runner uses it. In its first session the
        Agent commits, leaves work uncommitted, then plants four hooks and
        `core.fsmonitor` in the clone's `.git`. A second session reuses
        that worktree. Nothing planted runs in either session.
      - `grilling/fact-finding.test.ts`: *"works on a branch of its own,
        so Sandcastle merges nothing back with Git on the host while the
        sandbox runs (S1-2)"*. Run against the old `fact-finding.ts`
        (`git stash` of it alone), it **fails**: `expected 'main' to match
        /^ai-office\/fact-sbx-[0-9a-f-]+$/`. Against the fix, it passes.
      - `sandbox/sandcastle-git.test.ts`: the guard goes first on the
        PATH, once. Both the runner and the fact finder install it. The
        PATH `runGit` gives Git does not have it.
      - **Each test detects the flaw.** With `guardSandcastleGit`
        temporarily turned into a no-op (then restored), every one of the
        11 tests in the probe file **fails**. The first such run gave
        `9 failed | 1 passed`: the clean-filter test passed with or
        without the guard, because a change of size spares Git reading
        the file through the filter. Its file now keeps its size and
        gets a newer mtime, and it fails without the guard. The
        `alternateRefsCommand` test failed without the guard, and at first
        *with* it too, which is how that setting was found. With the
        guard, all 11 pass.
- [x] **The assessment's findings table marks `S1-2` fixed.**
      `docs/pen-testing/assessments/S1.md`: S1-2 **fixed** (issue #203),
      with the commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (below). There are no expected failures left: the two that
      remained after #201 were S1-2's.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: exit 0

```
 Test Files  403 passed (403)
      Tests  4534 passed | 597 skipped (5131)
test exit 0
```

The skipped tests are the Postgres (Testcontainers) and Docker suites,
which skip without Docker, as in every earlier note. The #201 note's one
failure (`docker/deployment.test.ts`, port 1455) no longer occurs, at
`93f7a02` as well: this fix changes nothing under `docker/`.

The S1 probe files, the guard's tests, fact-finding and the Fresh Start
tests, verbose (`pnpm exec vitest run --reporter=verbose …` in
`packages/orchestrator`):

```
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1 · Sandcastle's host-side git runs the Agent-written repo's hooks > regression (S1-2): Sandcastle's `git worktree add` no longer runs the repo's post-checkout hook
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1 · Sandcastle's host-side git runs the Agent-written repo's hooks > Sandcastle's worktree management must not run a hook the Agent planted (post-checkout)
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1 · Sandcastle's host-side git runs the Agent-written repo's hooks > regression (S1-2): Sandcastle's `git merge` no longer runs the repo's post-merge hook
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1 · Sandcastle's host-side git runs the Agent-written repo's hooks > Sandcastle's merge-back must not run a hook the Agent planted (post-merge)
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1-2 · Sandcastle's other host-side Git runs nothing the repository names > does not run core.fsmonitor when it reads a worktree's status (reuse and clean-up)
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1-2 · Sandcastle's other host-side Git runs nothing the repository names > does not run a smudge filter when `git worktree add` checks a branch out
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1-2 · Sandcastle's other host-side Git runs nothing the repository names > does not run a clean filter when it reads a worktree's status
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1-2 · Sandcastle's other host-side Git runs nothing the repository names > runs no hook or filter when it fast-forwards a reused worktree from origin (fetch, then `merge --ff-only`)
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1-2 · Sandcastle's other host-side Git runs nothing the repository names > does not run core.alternateRefsCommand when it fetches into a repository with alternates
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1-2 · Sandcastle's other host-side Git runs nothing the repository names > refuses to fetch for a repository that names a remote's upload-pack program
 ✓ sandbox/sandcastle-git.pen-test.test.ts > S1-2 · real Sandcastle, twice on one clone, as AI Office drives it > runs none of the hooks or programs an Agent planted in its first session, in either session
 ✓ sandbox/sandcastle-git.test.ts > guardSandcastleGit > puts AI Office's `git` first on the PATH, once
 ✓ sandbox/sandcastle-git.test.ts > guardSandcastleGit > is installed by the sandbox runner before any Sandcastle run
 ✓ sandbox/sandcastle-git.test.ts > guardSandcastleGit > is installed by the fact finder before any Sandcastle run
 ✓ sandbox/sandcastle-git.test.ts > guardSandcastleGit > is skipped by AI Office's own Git, which runs Git itself
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > answers from the repository, read in a sandbox with a read-only token and no Git identity, then deletes the clone
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > keeps no answer from a sandbox that changed the repository, and nothing of its changes reaches GitHub
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > works on a branch of its own, so Sandcastle merges nothing back with Git on the host while the sandbox runs (S1-2)
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > keeps no answer from a sandbox that left a file changed without committing it
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > says when the Agent finished without an answer
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > says why when the sandbox could not be started, never with a credential
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > stops when it is cancelled, killing the sandbox
 ✓ grilling/fact-finding.test.ts > the sandbox fact finder > kills a sandbox that runs out of time
 ✓ grilling/fact-finding.test.ts > readFact > reads the last answer between the tags, cut to fit
 ✓ git/command.pen-test.test.ts > S1 · runGit runs no code the repository's own config/hooks define > regression (S1-1): `git status --porcelain` no longer runs the repo's core.fsmonitor program
 ✓ git/command.pen-test.test.ts > S1 · runGit runs no code the repository's own config/hooks define > runGit must not run a program the repository's config names (core.fsmonitor)
 ✓ git/command.pen-test.test.ts > S1 · runGit runs no code the repository's own config/hooks define > regression (S1-1): `git commit --no-verify` no longer runs the repo's post-commit hook
 ✓ git/command.pen-test.test.ts > S1 · runGit runs no code the repository's own config/hooks define > --no-verify must stop any hook the repo plants (post-commit)
 ✓ git/command.pen-test.test.ts > S1 · runGit runs no code the repository's own config/hooks define > regression (S1-1): `git commit --no-verify` no longer runs the reference-transaction hook
 ✓ git/command.pen-test.test.ts > S1 · runGit runs no code the repository's own config/hooks define > regression (S1-1): `git add --all` no longer runs a clean filter the repo defines
 ✓ git/command.pen-test.test.ts > S1 · runGit runs no code the repository's own config/hooks define > runGit must not run a filter the repo's config + .gitattributes define (filter.*.clean)
 ✓ git/command.pen-test.test.ts > S1 · vectors that do not fire through AI Office's current call sites > holds: `--no-verify` does skip the pre-commit hook
 ✓ git/command.pen-test.test.ts > S1 · vectors that do not fire through AI Office's current call sites > holds today: `git show --name-only --format=` does not run diff.external
 ✓ git/command.pen-test.test.ts > S1 · vectors that do not fire through AI Office's current call sites > holds today: no host-side call uses the ssh transport, so core.sshCommand is unreached
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a smudge filter on checkout
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a long-running process filter
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a filter that `include.path` pulls in
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a filter that `includeIf` pulls in
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a filter that `.git/info/attributes` assigns
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run diff.external when a command makes a patch
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a diff driver's textconv or command
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run core.sshCommand: no SSH transport is allowed
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a signing program on commit
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a merge driver
 ✓ git/command.pen-test.test.ts > S1-1 · no other setting the repository can write runs a program > does not run a remote's upload-pack program on fetch
 ✓ git/publish.pen-test.test.ts > S1 · publish.ts does not run the Agent clone's hooks > holds: publishBranch runs neither post-commit nor uploadpack.packObjectsHook from the Agent clone
 ✓ git/publish.pen-test.test.ts > S1 · publish.ts does not run the Agent clone's hooks > holds (S1-1): a fetch from the Agent clone by `file://` URL runs no uploadpack.packObjectsHook it names
 ✓ sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > makes a Fresh Start when Context Usage crosses 85%, resuming on the same branch with the Agent's summary
 ✓ sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > stops the sandbox before it saves the work in progress
 ✓ sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > makes a Fresh Start by hand mid-task
 ✓ sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > escalates at the fourth Fresh Start: the Agent is paused and the Owner gets an action Notice
 Test Files  6 passed (6)
      Tests  51 passed (51)
```

No test was skipped, deleted or weakened to reach this state.

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **Guard Sandcastle's Git through the PATH, process-wide.** Sandcastle
   gives no way to choose its Git or its environment per call. It reads
   `process.env` each time it runs Git, and several sandboxes run at once.
   So the app's PATH keeps AI Office's `git` first from the first runner
   or fact finder onwards. Anything else in the app process that runs a
   bare `git` gets the same protection. Nothing in AI Office does: its own
   Git goes through `runGit`, which skips the guard. Sandboxes don't see
   it: their environment is allow-listed, and a container has its own
   PATH. The other options were patching Sandcastle (out of the issue's
   scope) or a sandbox provider that copies the repository in and out
   rather than mounting `.git` (a far larger change). This one can be
   reviewed in two short files.
2. **The guard's Git environment is `runGit`'s, not the caller's.** Git
   that Sandcastle runs no longer sees the app's environment (its
   secrets included). It keeps only `LC_ALL`, `LANG` and the
   `GIT_AUTHOR_*` / `GIT_COMMITTER_*` identity. In the `branch` strategy
   Sandcastle makes no commit on the host, so it needs nothing more.
3. **Node runs the guard from the source tree.** `bin/git` runs
   `node …/guard.ts`, as the image already runs `node apps/server/src/main.ts`
   from sources. It needs `node` on the PATH, which the app image has. If
   it were missing, Sandcastle's Git would fail loudly, never run
   unguarded. Each Sandcastle Git call costs one Node start (tens of
   milliseconds, about a dozen per session).
4. **Fact-finding works on a throwaway branch**, rather than in the clone
   itself. Nothing it does is kept either way. Its sandbox now sees the
   default branch's files at `.sandcastle/worktrees/ai-office-fact-<sandbox>`
   rather than at the clone's root, which Agents cannot tell apart.
5. **`core.alternateRefsCommand` is set to `true`.** It runs with the
   shell, so an empty value has no well-defined meaning (as the #201 note
   says). `true`, from the app's own PATH, lists no refs: Git then simply
   reads no alternate's refs.

## Noticed, out of scope

- **Nested repositories and S1-1's driver reading.** `runGit` (and so the
  guard) reads the drivers named by the config of the repository it runs
  in. Some Git commands also run Git inside a nested repository in the
  worktree (a submodule, or an embedded repository the Agent created).
  That nested Git inherits the command-line settings, but not the
  emptying of drivers named only in the nested repository's own config.
  While exploring this I saw a `status` reach such a driver. I did not
  pursue it further, as it is a gap in the S1-1 mechanism and wider than
  this issue's Sandcastle scope. It should be triaged as a finding of
  its own (likely critical by the PRD's definition), against both
  `runGit` and the guard. Candidate fixes: refuse to run in a worktree
  that holds a nested repository, or turn submodule recursion off on
  Git's command line and read nested configs too.
- **Sandcastle's other strategies.** In `head` and `merge-to-head`,
  Sandcastle runs `git merge "<branch>"` and `git branch -D "<branch>"` on
  the host through a shell, with the branch name read from inside the
  sandbox. AI Office no longer uses either strategy, but anyone adding one
  back should know that.
- **Sandcastle copies the host repository's `user.name` and `user.email`**
  into a shell command it runs in the sandbox. That runs inside the
  sandbox only, so it is no host exposure.

## What could not be verified here

- **End-to-end in the real app container.** That needs Docker, which this
  sandbox doesn't have. The fix is proven at the Git layer and with real
  Sandcastle driving a fake bind-mount sandbox (`fake-sandbox.ts`, whose
  "container" is the host, now without the app's guard on its PATH, as a
  container has its own Git). That Docker stops a container before
  Sandcastle's clean-up runs is Sandcastle's behaviour and was not
  observed here.
- **Git versions other than 2.39.5.** The app image's Debian Git is
  newer. The settings used keep their meaning across versions, but the
  tests ran only on 2.39.5.
- **A process left running in a live sandbox racing Git** was not staged.
  The argument that the `branch` strategy leaves no driver-reading Git
  call while a sandbox runs comes from reading Sandcastle 0.12.0's
  `dist/` (table above). An upgrade of Sandcastle should re-check it.
