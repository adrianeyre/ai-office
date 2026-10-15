# Issue #235: [fix] S2-4 — Sandboxes start with Docker's defaults only — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `49c3fe9`,
`fix(security): S2-4 every container AI Office starts for an Agent drops every capability, cannot gain privileges, has bounded memory and processes and a read-only root`,
on top of `0511196`. S2-5's fix (#237, `31f3e93`) follows it and builds
on the same file. Its blocker, the S2 probe (#193), is in the tree:
`docs/pen-testing/assessments/S2.md` and
`packages/orchestrator/src/sandbox/docker-run.pen-test.test.ts`.

This is the remediation of finding **S2-4** (`severity:medium`, new).

## What was fixed

A sandbox was started with nothing beyond Docker's defaults: Docker's
default capability set (`NET_RAW` among it), no `no-new-privileges`, no
memory or PID limit, and a writable root filesystem. `docker inspect`
would show an empty `HostConfig.CapDrop`, an empty `SecurityOpt`,
`Memory: 0`, `PidsLimit: null` and `ReadonlyRootfs: false`.

- **One set of flags for every container AI Office starts for an Agent:**
  `sandboxHardening` in `packages/orchestrator/src/sandbox/docker.ts` (new):
  - `--cap-drop ALL`;
  - `--security-opt no-new-privileges`;
  - `--memory 4g` and `--pids-limit 4096`;
  - `--read-only`, with `--mount type=volume,target=/home/agent` and
    `--mount type=volume,target=/tmp`. These are anonymous volumes, which
    Docker fills from the image and removes with the container.
- **A task's sandbox and a Grilling Session's fact-finding**
  (`dockerSandbox`) are started by `dockerProvider`, AI Office's own
  Sandcastle bind-mount provider (`createBindMountSandboxProvider`).
  Sandcastle 0.12.0's Docker provider builds its `docker run` from a fixed
  list of options and has no way to pass these flags. The new provider
  keeps what that one did: the same `-v` mounts with the `z` label, the
  environment plus `HOME`, `--user` AI Office's uid:gid, `-w` the
  worktree, the image-user check and `docker exec` for each command, with
  output streamed line by line. It removes the container with
  `docker rm --force --volumes`, so its volumes go with it, also when AI
  Office exits while it runs.
- **A Manager chat session and a subscription's model call**
  (`dockerToolRunner`) take the same `sandboxHardening`. `--rm` already
  removes their volumes with them.

### Sibling paths

- **Both `docker run`s are the only containers AI Office starts for an
  Agent** (`grep` for `"docker"` across `apps/` and `packages/`). Both take
  the one array, and a test checks it is passed whole, before the image.
- **The pen-test stack's teardown** removed sandboxes with
  `docker rm --force`, which would now leave their home and `/tmp` volumes
  behind. It now passes `--volumes` (`docker/pen-test/stack.ts`,
  `docs/pen-testing/stack.md`).
- **The guide** (`docs/guide/issue-pipeline.md`, "How a sandbox is
  started") says what each flag does and where a sandbox can write.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** All four
      under "S2-4" in `docker-run.pen-test.test.ts`, each run for both
      `docker run`s: "drops every capability the agent tool does not
      need", "sets no-new-privileges", "limits its memory and its number of
      processes" and "runs on a read-only root filesystem, writable only
      where it works". Their bodies are unchanged. The describe is renamed
      from "no hardening beyond Docker's defaults" to "hardening beyond
      Docker's defaults".
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (S2-4): it no
      longer starts with Docker's defaults: --cap-drop ALL,
      no-new-privileges, a memory and a process limit and --read-only are
      each passed once, and nothing adds back what they take". Each value
      the pin expected to be empty is now `not.toEqual([])`, then the exact
      value.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "sibling (S2-4): both docker runs take the one sandboxHardening, so
        they cannot drift apart, and it comes before the image, where Docker
        reads flags".
      - "sibling (S2-4): it writes only to its home and /tmp, each an
        anonymous volume of its own, and to what is mounted for its work".
      - "sibling (S2-4): is removed with its home and /tmp volumes when it
        closes", and for a chat session, "…is removed with its volumes when
        it ends".
      - `docker.test.ts` (new): the provider's `exec` streams each line as
        it comes, passes stdin, the working directory and the exit code
        through, copies files in and out, and refuses an image built for
        another user or a missing mount. A failed `docker run` leaves
        nothing behind.
      - `stack.test.ts`: teardown removes sandboxes `--volumes`.
      With `sandboxHardening` emptied, 17 of `docker-run.pen-test.test.ts`'s
      tests failed: the four `it`s, the regression test and the siblings,
      for both runs. Restored, all pass.
- [x] **The assessment's findings table marks `S2-4` fixed.**
      `docs/pen-testing/assessments/S2.md`: **fixed** (issue #235) with the
      commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on ten tests, all in
      `@ai-office/web`, which this run did not touch. Two are the
      pre-existing changelog failures and eight are timeouts on a host
      running at a load average of 65; see below. Every test of
      `@ai-office/orchestrator` and `docker/` passes.

## Real output of the checks

Run once on the finished tree, at `31f3e93`, after both fixes of this run
(#235, #237); issue-237.md points here.

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/events typecheck: Done
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: ten failures, none in what this run changed

```
 FAIL  |@ai-office/web| src/analytics-page.test.tsx > the analytics dashboards > charts each AI Account's usage windows over the range
 FAIL  |@ai-office/web| src/analytics-page.test.tsx > the analytics dashboards > charts each total over time, with a legend, a tooltip on hover and keys, and a table
 FAIL  |@ai-office/web| src/analytics-page.test.tsx > the analytics dashboards > charts the prompt-cache keep-alives over time
 FAIL  |@ai-office/web| src/floors.test.tsx > the Floor admin page > edits every part of an Agent's Avatar, and saves the Avatar alone
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 FAIL  |@ai-office/web| src/scene/idle-behaviours.test.ts > the trip to an idle activity > for each of 12 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
 FAIL  |@ai-office/web| src/scene/idle-behaviours.test.ts > the trip to an idle activity > for each of 21 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
 FAIL  |@ai-office/web| src/scene/idle-behaviours.test.ts > the trip to an idle activity > for each of 9 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/whiteboard.test.tsx > the whiteboard > opens on the Batch a Notice names; the Owner moves, drops and annotates its issues, saves them to be replanned, then approves
 Test Files  6 failed | 420 passed (426)
      Tests  10 failed | 4920 passed | 603 skipped (5533)
test exit 1
```

All ten are in `@ai-office/web`, and no file under `apps/web` changed in
this run (`git diff --name-only 0511196` lists none). They are of two
kinds:

- **Two pre-existing failures.** `legal.test.tsx` and `site-footer.test.tsx`
  expect `CHANGELOG.md`'s first release heading to carry a date
  (`expected '1.0.0' to match /^1.0.0 \(/`). They failed the same way
  before this run, as issue-227.md and issue-233.md record.
- **Eight timeouts.** Each is `Error: Test timed out in 5000ms` (or
  `30000ms`). The host was shared with other runs: `uptime` gave a load
  average of 65 on 16 CPUs during the suite. Run again on their own,
  `analytics-page`, `floors` and `whiteboard` pass:

  ```
   Test Files  1 failed | 3 passed (4)
        Tests  1 failed | 94 passed (95)
   18:16:18 up 96 days,  2:14,  0 user,  load average: 52.18, 59.43, 41.41
  ```

  The one left, "for each of 21 Agents and each place…", still times out
  on its own under that load (32 s against the 30 s the test sets itself,
  `Error: Test timed out in 30000ms.`, no assertion failure). It is
  CPU-bound path-finding in the 3D scene, which nothing here touches.
  It was not changed.

There are no expected fails left: there were 9 before this run, and all 9
were these findings' `it.fails` (S2-4's four, each run for both `docker
run`s, and S2-5's one). The 603 skipped are the Postgres-backed tests (no
Docker here).

### The probe tests and the provider, verbose (S2-4)

```
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > streams each line of a command's output as it comes, and keeps it
✓ stack.test.ts > teardown > lists what it removes: sandboxes, containers, networks, the volume, the work directory, the credentials package and the secrets
✓ stack.test.ts > teardown > removes them all, down with its volumes, and says what it removed
✓ stack.test.ts > teardown > counts the sandbox relay as the stack's, not as a sandbox, though it is on the sandboxes network
✓ stack.test.ts > teardown > removes by name a volume down left behind, and fails if one is still there
✓ stack.test.ts > teardown > deletes no directory stand-up did not make
✓ stack.test.ts > teardown > says when there was nothing to remove
✓ stack.test.ts > teardown > takes the stack down without its env file, the values compose needs only placeholders
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > passes stdin, the working directory and the exit code through
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > works in the worktree's mount, as AI Office's own user
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > copies files in and out with docker cp
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > refuses an image that is not built, or runs as another user
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > refuses a mount whose host path is missing, rather than let Docker make it as root
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > removes what a failed docker run left, with its volumes, and says why it failed
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > removes the network it made when the sandbox relay cannot join it, and starts nothing
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > what holds > is not privileged, shares no host namespace and passes no device
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > what holds > leaves Docker's default seccomp and AppArmor profiles on
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > what holds > never mounts the Docker socket or anything of the host's but its own directories
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > what holds > joins a sandboxes' network of its own, not the host's
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-4: hardening beyond Docker's defaults > drops every capability the agent tool does not need
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-4: hardening beyond Docker's defaults > sets no-new-privileges
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-4: hardening beyond Docker's defaults > limits its memory and its number of processes
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-4: hardening beyond Docker's defaults > runs on a read-only root filesystem, writable only where it works
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-4: hardening beyond Docker's defaults > regression (S2-4): it no longer starts with Docker's defaults: --cap-drop ALL, no-new-privileges, a memory and a process limit and --read-only are each passed once, and nothing adds back what they take
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-4: hardening beyond Docker's defaults > sibling (S2-4): both docker runs take the one sandboxHardening, so they cannot drift apart, and it comes before the image, where Docker reads flags
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-4: hardening beyond Docker's defaults > sibling (S2-4): it writes only to its home and /tmp, each an anonymous volume of its own, and to what is mounted for its work
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > what holds > is not privileged, shares no host namespace and passes no device
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > what holds > leaves Docker's default seccomp and AppArmor profiles on
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > what holds > never mounts the Docker socket or anything of the host's but its own directories
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > what holds > joins a sandboxes' network of its own, not the host's
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-4: hardening beyond Docker's defaults > drops every capability the agent tool does not need
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-4: hardening beyond Docker's defaults > sets no-new-privileges
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-4: hardening beyond Docker's defaults > limits its memory and its number of processes
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-4: hardening beyond Docker's defaults > runs on a read-only root filesystem, writable only where it works
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-4: hardening beyond Docker's defaults > regression (S2-4): it no longer starts with Docker's defaults: --cap-drop ALL, no-new-privileges, a memory and a process limit and --read-only are each passed once, and nothing adds back what they take
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-4: hardening beyond Docker's defaults > sibling (S2-4): both docker runs take the one sandboxHardening, so they cannot drift apart, and it comes before the image, where Docker reads flags
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-4: hardening beyond Docker's defaults > sibling (S2-4): it writes only to its home and /tmp, each an anonymous volume of its own, and to what is mounted for its work
✓ src/sandbox/docker-run.pen-test.test.ts > S2: who a task's sandbox runs as, and what it mounts > runs as AI Office's own user, never root
✓ src/sandbox/docker-run.pen-test.test.ts > S2: who a task's sandbox runs as, and what it mounts > mounts its own clone's worktree and .git read-write, and its Skills read-only, and nothing of any other run
✓ src/sandbox/docker-run.pen-test.test.ts > S2: who a task's sandbox runs as, and what it mounts > sibling (S2-4): is removed with its home and /tmp volumes when it closes
✓ src/sandbox/docker-run.pen-test.test.ts > S2: who a task's sandbox runs as, and what it mounts > starts with only the allow-listed environment, plus HOME, whatever else Sandcastle gathers
✓ src/sandbox/docker-run.pen-test.test.ts > S2: a Manager chat session's mounts > mounts the read-only clone read-only, and the tool's own state read-write
✓ src/sandbox/docker-run.pen-test.test.ts > S2: a Manager chat session's mounts > sibling (S2-4): is removed with its volumes when it ends
✓ src/sandbox/docker-run.pen-test.test.ts > S2: a Manager chat session's mounts > passes only the allow-listed environment's names, never the app's
```

## Decisions

1. **AI Office starts the container itself rather than through
   Sandcastle's Docker provider.** Sandcastle 0.12.0's `docker()` takes no
   flags beyond its own options, none of which is any of these. Upgrading
   Sandcastle would also move the harness that runs this work (the root
   `package.json`), and no version was checked to have them. `dockerProvider`
   keeps that provider's behaviour, except for three things:
   - `docker rm --force --volumes` instead of `docker stop` then `rm`. The
     images' PID 1 is `sleep infinity`, which ignores `SIGTERM`, so `stop`
     always waited its 10 seconds anyway.
   - It does not port Sandcastle's `docker exec --user 0:0 mkdir` for the
     parents of file mounts. AI Office mounts only directories, and with
     `--cap-drop ALL` root could not `chown` them anyway.
   - It does not port the check for an existing container of the same
     name. Names are random UUIDs.
2. **The home and `/tmp` are anonymous volumes, not `tmpfs`.** A `tmpfs`
   at `/home/agent` would hide what the image put there: Claude Code is in
   `~/.local/bin`, and the Skills folders are made as `agent`. Docker
   would also make the mount points of the Skills and memory under it as
   root, so Claude Code could not write `~/.claude`. A volume is filled
   from the image, ownership included. It is on disk, not counted against
   the memory limit, and `docker cp` reaches it. The cost: Docker copies the
   image's home into each new volume, which for the Claude image includes
   Claude Code's binary. That happens for each sandbox, Manager chat turn
   and subscription model call.
3. **The limits are 4 GB and 4096 processes, fixed in code, not settings.**
   The EC2 sizes in `deploying-to-ec2.md` (8 GiB for one sandbox, 16 GiB
   for the default three) leave room for 4 GB each. 4096 counts threads
   too, which a Floor's browser tests use many of, and still bounds a fork
   bomb well under Docker's and the kernel's limits. An Owner whose Floor
   needs more cannot raise them without a code change; that would be a
   new setting.
4. **Two "what holds" tests were changed, and say why.**
   - "never mounts the Docker socket or anything of the host's but its own
     directories" now admits the two anonymous volumes. It asserts they
     are exactly `type=volume,target=/home/agent` and `…/tmp`, and every
     other mount is still under AI Office's work directory.
   - "mounts the read-only clone read-only, and the tool's own state
     read-write" lists the chat session's mounts exactly, so it now lists
     the two volumes too.
   A volume with no `source=` is no host path, and a named one (which
   every sandbox would share) would fail the new sibling test. The task
   sandbox's describe label was "Sandcastle's Docker provider" and is now
   "dockerSandbox".
5. **`--security-opt no-new-privileges`**, Docker's own spelling, which the
   probe asserts. Compose's `no-new-privileges:true` on the relay is the
   same option.

## Noticed, out of scope

- **A task sandbox's environment is on Docker's command line.** Like
  Sandcastle's provider before it, `dockerProvider` passes `-e KEY=value`.
  So the read-only `GH_TOKEN` and the Agent's Gateway Key are in the
  `docker run` process's arguments for the moment it runs, visible to
  other users of the host in `ps`. `dockerToolRunner` passes names only.
  Changing that would change the "starts with only the allow-listed
  environment" probe's shape, so it was left.
- **No CPU limit (`--cpus`).** The finding did not ask for one. One
  sandbox can still take every CPU, as the timeouts above show other
  processes can.
- **A crashed AI Office leaves its sandboxes running** (on `SIGKILL`), as
  before. Their volumes go when they are removed.

## What could not be verified here

There is no Docker here, so the flags were checked as the exact
`docker run` the stand-in `docker` recorded. Not tried:

- **The issue's statement itself:** `docker inspect` of a running sandbox
  should now show `HostConfig.CapDrop: ["ALL"]`,
  `SecurityOpt: ["no-new-privileges"]`, `Memory: 4294967296`,
  `PidsLimit: 4096` and `ReadonlyRootfs: true`, with two anonymous volumes
  in `Mounts`.
- That each agent tool works on a read-only root: Claude Code, Codex and
  opencode, a Floor's setup command (`npm install`, `pnpm install`), `git`
  and `gh`, writing only to the worktree, the home and `/tmp`.
- That Docker copies the image's `/home/agent` into the anonymous volume
  with `agent`'s ownership when binds are mounted beneath it, as its
  documentation says it does.
- How long that copy takes for the Claude image, on each start.
