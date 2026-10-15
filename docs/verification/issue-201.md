# Issue #201: [fix] S1-1 — Host-side git runs code an Agent planted in the worktree's git config, hooks or attributes — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no network beyond the registry and the model). The fix
is commit `dd458e7`,
`fix(security): S1-1 host-side git runs nothing an Agent's repository names`,
on top of `8e9d713` (the S1 probe, #186). Its blocker, the probe itself, is
in the tree: `docs/pen-testing/assessments/S1.md` and the three
`*.pen-test.test.ts` files it names.

This is the remediation of finding **S1-1** (`severity:critical`, H1) only.
S1-2 (Sandcastle's own `execGit`) is a separate finding and stays open.

## What was fixed

Every host-side git call AI Office makes goes through `runGit`
(`packages/orchestrator/src/git/command.ts`), so the fix is there and holds
for every call site, present and future:

- **Settings set again on Git's command line** (`GIT_CONFIG_COUNT`/`KEY`/
  `VALUE`, which win over the repository's `.git/config` and anything it
  includes): `core.hooksPath=/dev/null` (every hook, `--no-verify` or not,
  including `post-commit`, `reference-transaction` and `post-checkout`),
  `core.fsmonitor=false`, `diff.external=` (empty), `core.askPass=` (empty),
  `credential.helper=` (empty, which resets the list), `commit.gpgSign`,
  `tag.gpgSign`, `log.showSignature` and `merge.verifySignatures` all
  `false`. The environment also sets `GIT_EDITOR=:`,
  `GIT_SEQUENCE_EDITOR=:` and `GIT_PAGER=cat`.
- **Drivers, whose names the repository chooses** (`filter.<x>.clean`,
  `smudge`, `process`, `required`; `diff.<x>.command`, `textconv`;
  `merge.<x>.driver`; `credential.<url>.helper`): before each command,
  `runGit` reads which of these the repository's config names
  (`git config --null --get-regexp`, which follows `include.path` and
  `includeIf`), and empties each one (`required` is set to `false`). A
  `.gitattributes` or `.git/info/attributes` that names such a driver then
  runs nothing. Reading config runs no program. If the read fails for any
  reason except "nothing matched" (exit 1), the command is not run.
- **Transports:** `GIT_ALLOW_PROTOCOL=file:https`, the only two AI Office
  uses, so `core.sshCommand`, `core.gitProxy`, `ext::` and remote helpers
  (including through `url.<x>.insteadOf`) are never reached. A caller can
  still narrow it, as Skill import already does.
- **A remote's own programs** (`remote.<name>.uploadpack`, `receivepack`,
  `vcs`) cannot be overridden, because Git keeps the *first* value it reads
  for these. This was found while testing: an override left the
  repository's own value in force. So `runGit` refuses to run in a
  repository that names one: *"Git could not … : the repository names a
  program for a remote (remote.origin.uploadpack)"*.

### Sibling path: the Fresh Start's live worktree

The driver names can only be read safely if nothing writes the repository
between reading them and running the command. `saveUncommitted`
(`sandbox/runner.ts`) is the one call site that ran while the Agent's
sandbox was still running: it saved the work in progress *first* and
stopped the sandbox *after*. An Agent that kept writing could have added a
new driver in that window. The Fresh Start now stops the sandbox first, and
saves the work in progress once `runSandcastle` has returned. Every other
call site on an Agent-written repository already ran after its sandbox had
stopped: fact-finding's `status` after the Grilling run, `changedFiles`,
the Fresh Start summary, and `branchCommits`.

`publishBranch` was already safe: it fetches into a fresh bare repository
with hooks off. It is now also covered for a future `file://` fetch, which
goes through `upload-pack`. Git honours `uploadpack.packObjectsHook` only
from system, global or command-line config, and `runGit` reads neither
system nor global config.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** The three
      `it.fails` in `command.pen-test.test.ts` (core.fsmonitor, post-commit,
      filter.*.clean) are now `it`. Their bodies are unchanged apart from
      Prettier's reflow, and all three pass (output below).
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** The four pins (core.fsmonitor
      on `status`, post-commit and reference-transaction on
      `commit --no-verify`, clean filter on `add --all`) are now
      `regression (S1-1): … no longer runs …`. Each now asserts that the
      marker is `null`, where it used to assert that the marker was written.
      No test was deleted (21 tests in the file, up from 10).
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `command.pen-test.test.ts`, new `describe("S1-1 · no other setting
        the repository can write runs a program")`: smudge filter on
        checkout; `process` filter; filter pulled in by `include.path`;
        filter pulled in by `includeIf`; filter assigned by
        `.git/info/attributes`; `diff.external` on `git diff` and
        `git show`; a diff driver's `textconv` and `command` on `show` and
        `log -p`; `core.sshCommand` (ssh refused); `gpg.program` with
        `commit.gpgSign`; a merge driver on `git merge`; and
        `remote.origin.uploadpack` on `git fetch origin` (refused).
      - `publish.pen-test.test.ts`: a `file://` fetch from the Agent's clone
        runs no `uploadpack.packObjectsHook`.
      - `fresh-start.test.ts`: *"stops the sandbox before it saves the work
        in progress"*. At the moment the sandbox is killed, the fake Agent
        reads the branch head synchronously; the test asserts that nothing
        has been committed yet, and that the work in progress is still saved
        afterwards. Run against the old `runner.ts`, it **fails**:
        `expected 'b871b2f…' to be '5db27f4…'`. Against the fix, it passes.
- [x] **The assessment's findings table marks `S1-1` fixed.**
      `docs/pen-testing/assessments/S1.md` has a new Status column: S1-1
      **fixed** (issue #201) with the commit's subject (hash filled at
      merge); S1-2 open.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` has one failure, and it is pre-existing
      and unrelated: the same `docker/deployment.test.ts` assertion the #186
      note recorded at `fa56e24`. This fix changes neither
      `docker-compose.yml` nor anything under `docker/`
      (`git diff --stat HEAD -- docker docker-compose.yml` is empty). See
      below.

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

### `pnpm test`: one pre-existing failure, none from this fix

```
 FAIL  |deployment| docker/deployment.test.ts > docker-compose.yml > publishes only the app, on 127.0.0.1 unless told otherwise
AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
  [
    "${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}:${AI_OFFICE_PORT:-3045}:3045",
+   "127.0.0.1:1455:1455",
  ]

 Test Files  1 failed | 386 passed (387)
      Tests  1 failed | 4314 passed | 2 expected fail | 566 skipped (4883)
```

The **2 expected fail** are S1-2's `it.fails` in
`sandcastle-git.pen-test.test.ts`, untouched (it drives git with
Sandcastle's own environment, not `runGit`). Before this fix the count was
5, and the difference is S1-1's three. The #186 run also had five
`@ai-office/web` timeouts under load; none happened in this run.

The orchestrator project alone, where every changed file lives:

```
# cd packages/orchestrator && pnpm exec vitest run
 Test Files  115 passed (115)
      Tests  1159 passed | 2 expected fail | 252 skipped (1413)
```

The S1 probe files and the Fresh Start tests, verbose:

```
✓ command.pen-test.test.ts > … > regression (S1-1): `git status --porcelain` no longer runs the repo's core.fsmonitor program
✓ command.pen-test.test.ts > … > runGit must not run a program the repository's config names (core.fsmonitor)
✓ command.pen-test.test.ts > … > regression (S1-1): `git commit --no-verify` no longer runs the repo's post-commit hook
✓ command.pen-test.test.ts > … > --no-verify must stop any hook the repo plants (post-commit)
✓ command.pen-test.test.ts > … > regression (S1-1): `git commit --no-verify` no longer runs the reference-transaction hook
✓ command.pen-test.test.ts > … > regression (S1-1): `git add --all` no longer runs a clean filter the repo defines
✓ command.pen-test.test.ts > … > runGit must not run a filter the repo's config + .gitattributes define (filter.*.clean)
✓ command.pen-test.test.ts > … > holds: `--no-verify` does skip the pre-commit hook
✓ command.pen-test.test.ts > … > holds today: `git show --name-only --format=` does not run diff.external
✓ command.pen-test.test.ts > … > holds today: no host-side call uses the ssh transport, so core.sshCommand is unreached
✓ command.pen-test.test.ts > S1-1 · … > does not run a smudge filter on checkout
✓ command.pen-test.test.ts > S1-1 · … > does not run a long-running process filter
✓ command.pen-test.test.ts > S1-1 · … > does not run a filter that `include.path` pulls in
✓ command.pen-test.test.ts > S1-1 · … > does not run a filter that `includeIf` pulls in
✓ command.pen-test.test.ts > S1-1 · … > does not run a filter that `.git/info/attributes` assigns
✓ command.pen-test.test.ts > S1-1 · … > does not run diff.external when a command makes a patch
✓ command.pen-test.test.ts > S1-1 · … > does not run a diff driver's textconv or command
✓ command.pen-test.test.ts > S1-1 · … > does not run core.sshCommand: no SSH transport is allowed
✓ command.pen-test.test.ts > S1-1 · … > does not run a signing program on commit
✓ command.pen-test.test.ts > S1-1 · … > does not run a merge driver
✓ command.pen-test.test.ts > S1-1 · … > does not run a remote's upload-pack program on fetch
✓ publish.pen-test.test.ts > … > holds: publishBranch runs neither post-commit nor uploadpack.packObjectsHook from the Agent clone
✓ publish.pen-test.test.ts > … > holds (S1-1): a fetch from the Agent clone by `file://` URL runs no uploadpack.packObjectsHook it names
✓ fresh-start.test.ts > … > makes a Fresh Start when Context Usage crosses 85%, resuming on the same branch with the Agent's summary
✓ fresh-start.test.ts > … > stops the sandbox before it saves the work in progress
✓ fresh-start.test.ts > … > makes a Fresh Start by hand mid-task
✓ fresh-start.test.ts > … > escalates at the fourth Fresh Start: the Agent is paused and the Owner gets an action Notice
 Test Files  4 passed (4)
      Tests  29 passed | 2 expected fail (31)
```

No test was skipped, deleted or weakened to reach this state.

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **Override, not refuse, for drivers.** A repository that defines a
   filter, diff or merge driver still has Git run in it, with every such
   driver emptied, as if it were not defined. Refusing outright would make
   a Grilling Session fail, or a Fresh Start save nothing, for any Agent
   that set up, say, an LFS-style filter. Emptying runs nothing either way.
   A side effect: a `required` filter's content is staged unfiltered.
2. **Refuse, for a remote's programs.** `remote.<name>.uploadpack`,
   `receivepack` and `vcs` cannot be overridden, because Git keeps the first
   value it reads. So any git command in a repository that names one fails
   with a plain message. AI Office's own clones never set these.
3. **Only `file` and `https` transports by default**
   (`GIT_ALLOW_PROTOCOL`). AI Office clones, fetches and pushes over HTTPS;
   tests and `publishBranch` use local paths. Plain `http` is refused too.
   That matches ADR 0002's GitHub App over HTTPS, and nothing in the tree
   uses `http` for Git.
4. **A Fresh Start stops the sandbox, then saves.** The order used to be
   save, then stop. The Agent can no longer write anything the app's Git
   reads while that Git runs. What the Agent was writing at the moment it
   was stopped is saved as it lies, as before ("best effort"). One
   consequence for Sandcastle: when the sandbox stops, the worktree is now
   still dirty, so Sandcastle keeps it, and the next session reuses it
   rather than adding it afresh. Both paths are S1-2's (`git merge` on
   reuse, `git worktree add` afresh), so S1-2's exposure is neither widened
   nor narrowed.

## Noticed, out of scope

- **S1-2 is still open.** Sandcastle's `execGit` runs `git status`,
  `git worktree add` and `git merge` on the Agent-written repository with
  the whole process environment and none of these overrides. That includes
  Sandcastle's own `git status` on the dirty worktree when the sandbox
  stops at a Fresh Start. Until S1-2 is fixed, the H1 answer for the app
  container as a whole is still "confirmed".
- **`core.alternateRefsCommand`** names a program that runs when fetching
  *into* a repository that has alternates (`objects/info/alternates`, which
  an Agent can write). No call site fetches into an Agent's repository
  today. It is not overridden here, because an empty or `:` value has no
  well-defined meaning. A future call site that fetches into an Agent's
  clone should add it, or refuse a repository with alternates.
- The pre-existing `docker/deployment.test.ts` failure (port 1455) belongs
  to H3/H14 (#193), as the #186 note says.

## What could not be verified here

- **End-to-end in the real app container.** That needs Docker, which this
  sandbox doesn't have. The fix is proven at the git layer with the real
  `runGit`, and with real Sandcastle and a fake sandbox for the Fresh Start
  order. That Docker stops the container before `runSandcastle` returns
  is Sandcastle's behaviour and was not observed here. The fake sandbox's
  `close()` (which resolves `killed`) is what the ordering test exercises.
- **Git versions other than 2.39.5.** The app image (`node:26.10.0-slim`)
  ships a newer Debian git. The settings used here have kept their meaning
  across versions, but the tests ran only on 2.39.5.
- **`credential.<url>.helper` emptied** is not exercised by a test. It only
  runs on HTTP authentication against a matching URL, and there is no HTTP
  Git server in this sandbox. It is covered by the same mechanism as the
  tested drivers.
