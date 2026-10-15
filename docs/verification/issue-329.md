# Issue #329: [fix] I2-4 — The root sandbox-dir service runs mkdir -p and chown on a path under world-writable /tmp with no symlink-safe or ownership check — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker, no Postgres, no second host account, not root; the test user
is UID 1017). The fix is commit `8fef8bd`,
`fix(security): I2-4 the sandboxes' work directory is taken only as the app's own, never through a link, and no longer defaults under /tmp`,
on top of `c1d7635` (#327's). Its blocker, the I2 probe (#287), is in the
tree: `docs/pen-testing/assessments/I2.md` and
`docker/sandbox-dir.pen-test.test.ts`.

This is the remediation of finding **I2-4** (`severity:low` on the
intended deployment, high on a multi-user host). The full output of the
checks, run once on the finished tree for all five fixes, is in
[#323's note](issue-323.md#real-output-of-the-checks).

## What was fixed

Under compose, the root `sandbox-dir` service ran
`mkdir -p "$SANDBOX_WORK_DIR" && chown 1000:1000 "$SANDBOX_WORK_DIR"` on
`AI_OFFICE_SANDBOX_DIR`, which was `/tmp/ai-office-sandboxes` by default.
Anyone on the host can write in `/tmp`, so:

- a local user who made the path first had it **adopted**, contents and
  all, and handed to the app's user;
- one who left a symbolic link there had the **root `chown` follow it**,
  and the app's clones made where they chose.

**Why a check inside the container is not enough.** Docker resolves a
link at a bind mount's path **on the host**, before the container starts.
Inside, the service sees the directory the link points at, never the
link. So the fix has two parts.

### The default moves out of `/tmp`

The compose default is now `${HOME}/.ai-office/sandboxes`, in the home
directory of whoever runs compose. No other local user can write there.
It is a directory of its own, so when Docker makes it (and any missing
parent) as root, it never makes `~/.local` or another shared directory
root's. The issue allows this route: "or it lives outside any
world-writable parent".

`.env.example`'s `AI_OFFICE_SANDBOX_DIR` line, which set
`/tmp/ai-office-sandboxes` explicitly, is now empty, so the default
applies. Its comment says the path must never be under a directory
others may write to, such as `/tmp`.

### The service takes only what the app may use

The service's script (`docker-compose.yml`) runs as root, and now:

- **refuses** a symbolic link (`test -h`) and anything that is not a
  directory;
- **refuses** a directory that belongs to another user (neither root nor
  the app's UID 1000). That is what a link to another user's directory
  would have Docker mount;
- **refuses** a directory of root's that is not empty, such as `/etc`
  behind a link. Docker makes a fresh one empty;
- **makes** a path that is not there with `mkdir`, never `-p`, so it
  fails if something appears first;
- **chowns** with `chown -h`, which never follows a link.

A refusal names the path and why ("… belongs to UID 1017, so it is not
taken for the sandboxes' clones. Remove it, or set AI_OFFICE_SANDBOX_DIR
to a directory of the app's own."). The service then exits non-zero, so
compose never starts the app, which waits for it to finish. The app's
user is `APP_UID` and `APP_GID` in the service's environment, both
`1000`, so tests can run the same script as another user.

### Sibling path: the app's own `mkdir -p`

The app made its work directory with `mkdir(workDir, { recursive: true })`.
That is the runner's, the fact finder's and the Manager chat's. Under
`pnpm dev` it is `/tmp/ai-office-sandboxes` by default, made as the
Owner's user, with the same flaw: a pre-made directory is adopted and a
link is followed.

`packages/orchestrator/src/sandbox/work-dir.ts`'s `makeWorkDir` now makes
it, or takes it only if it is this user's own directory. It refuses a
link (`lstat`, never followed), anything that is not a directory, or
another user's directory, with a `WorkDirError` that says why. Each of
the three makes its work directory with it. When the GitHub App is set,
the server also checks the root, `SANDBOX_WORK_DIR`, as it starts, and
refuses to start rather than clone into another user's directory:
"AI Office failed to start: The work directory … belongs to UID …".

## Acceptance criteria

- [x] **The finding's `it.fails` become `it`s and pass.**
      - "I2-4: the sandbox-dir service refuses to operate on a path a
        non-root user could have created or pointed elsewhere …". Its
        original assertion (`guarded || notInWorldWritableTmp`) is kept.
        It now reads the default from compose, not from a constant. It
        also asserts both halves: the script has `test -h`, `stat -c %u`
        and `chown -h`, and the default is `${HOME}/.ai-office/sandboxes`.
      - "I2-4: a pre-created or symlinked path is refused rather than
        adopted". `mkdirStep` now runs the **service's own script** from
        compose (`$$` read as `$`), not a `mkdir -p` written in the
        test. Against a link, it rejects.
- [x] **The "pins today" tests become regression tests; none is
      deleted.**
      - "regression (I2-4): it still runs as root on AI_OFFICE_SANDBOX_DIR,
        but no longer mkdir -p and chown through a link, and no longer
        defaults under the world-writable /tmp".
      - "regression (I2-4): a directory another user pre-created is
        refused, not adopted, and nothing is chowned". The planted file is
        still there and the directory is still its maker's.
      - "regression (I2-4): a symlink left at the path is refused, not
        followed, so nothing lands on the attacker's chosen target". This
        holds even when the link points at the app user's own directory.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "holds since I2-4: a path that is not there is made and given to
        the app's user, and the app's own directory from before is taken
        as it is";
      - "holds since I2-4: something that is not a directory, or a root
        directory with something in it (as a link to one would mount), is
        refused" (a file, and `/etc`);
      - "holds since I2-4: the app's own making of the work directory
        refuses a link or another user's directory too";
      - `packages/orchestrator/src/sandbox/work-dir.test.ts`: it makes
        missing directories, takes this user's own with its contents, and
        refuses a link (making nothing through it), a dangling link, a
        file, and another user's directory.

      The script was also run by hand against a fresh path, an existing
      own directory, another user's (`APP_UID=1000`), a link and a file,
      with the outcomes above.
- [x] **The assessment's findings table marks `I2-4` fixed.** The row
      reads **fixed** (issue #329), with the commit's subject.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See
      [#323's note](issue-323.md#real-output-of-the-checks).

Other tests that pinned the old default or command were updated to the
new ones, without loosening what they check:

- `docker/deployment.test.ts` now asserts `chown -h "$$APP_UID:$$APP_GID"`
  and the service's `APP_UID` and `APP_GID`, not `chown 1000:1000`. Its
  ".env.example lists every variable docker-compose.yml reads" leaves out
  `HOME`, which compose takes from the shell, never from `.env`.
- `docker/sandbox-isolation.pen-test.test.ts` reads the new default.

### The tests, verbose

```
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2: the sandbox-dir service, read from compose > regression (I2-4): it still runs as root on AI_OFFICE_SANDBOX_DIR, but no longer mkdir -p and chown through a link, and no longer defaults under the world-writable /tmp
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2: the sandbox-dir service, read from compose > holds: the same host path is bind-mounted into the app, read-write
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2: the sandbox-dir service, read from compose > I2-4: the sandbox-dir service refuses to operate on a path a non-root user could have created or pointed elsewhere (a symlink-safe, ownership-checked mkdir), or the directory does not sit under a world-writable parent
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-4: another local user got to the path first > regression (I2-4): a directory another user pre-created is refused, not adopted, and nothing is chowned
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-4: another local user got to the path first > regression (I2-4): a symlink left at the path is refused, not followed, so nothing lands on the attacker's chosen target
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-4: another local user got to the path first > I2-4: a pre-created or symlinked path is refused rather than adopted
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-4: another local user got to the path first > holds since I2-4: a path that is not there is made and given to the app's user, and the app's own directory from before is taken as it is
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-4: another local user got to the path first > holds since I2-4: something that is not a directory, or a root directory with something in it (as a link to one would mount), is refused
✓ |deployment| docker/sandbox-dir.pen-test.test.ts > I2-4: another local user got to the path first > holds since I2-4: the app's own making of the work directory refuses a link or another user's directory too
✓ |@ai-office/orchestrator| src/sandbox/work-dir.test.ts > makeWorkDir > takes this user's own directory as it is, its contents kept
✓ |@ai-office/orchestrator| src/sandbox/work-dir.test.ts > makeWorkDir > refuses a symbolic link, even to a directory of this user's, and makes nothing through it
✓ |@ai-office/orchestrator| src/sandbox/work-dir.test.ts > makeWorkDir > refuses a link to nowhere
✓ |@ai-office/orchestrator| src/sandbox/work-dir.test.ts > makeWorkDir > refuses something that is not a directory
✓ |@ai-office/orchestrator| src/sandbox/work-dir.test.ts > makeWorkDir > refuses a directory another user made
```

## Decisions

These are for the Owner to review.

1. **The default is `~/.ai-office/sandboxes`, from `HOME`.** It had to be
   an absolute path that is the same for the app's container and the
   host's Docker, shared by Docker Desktop on macOS (`/Users` is), a
   Linux-style path on Windows, and not under a directory others may
   write to.
   - `/var/lib/ai-office` is not shared by Docker Desktop on macOS, so
     the default would fail there.
   - `~/.local/state/…`, as the pen-test stack uses, would have Docker
     make `~/.local` root's where it is missing, breaking other tools.
   - Where `HOME` is not set (PowerShell on Windows), compose warns and
     uses `/.ai-office/sandboxes`, a Linux-style path in Docker Desktop's
     VM. The guide tells the Owner to set one there.
   - Under `sudo docker compose`, `HOME` is root's, which is no less safe.
2. **An existing `.env` keeps its path.** An Owner who copied the old
   `.env.example` still has `AI_OFFICE_SANDBOX_DIR=/tmp/ai-office-sandboxes`.
   The service takes that directory if it is already UID 1000's from
   before, so nothing breaks. But it is still under `/tmp`. The guide and
   `.env.example` now say why not, and the Owner should empty or move it.
3. **What a check inside the container cannot see.** Docker resolves a
   link at the path on the host. So if a path the Owner chose is under a
   world-writable directory, a link there to an **empty** directory of
   root's, or to one of UID 1000's, would still be taken: the first
   chowned to the app's user, the second used as it is. A link to
   another user's directory, or to a root directory with anything in it,
   is refused. Hence the default out of `/tmp`, and the guide's "never
   under a directory others may write to". Mounting the parent directory
   instead, to see the link itself, would need compose to compute the
   parent of a variable, which it cannot. Mounting the host's `/` into a
   root container was rejected as far wider than the problem.
4. **The server refuses to start** when the GitHub App is set and its
   work directory is a link or another user's. That is louder than
   failing each sandbox later, and an Office that cannot make clones
   safely cannot do its work anyway.
5. **`makeWorkDir` checks the path it is given, not every directory
   above it.** On macOS `/tmp` is itself a link (to `/private/tmp`), so
   refusing a link anywhere in the path would refuse the default. The
   root is checked at start, and each run's own directory (`runs`,
   `facts`, `manager-chat`) as it is made.

## Noticed, out of scope

- **A root removed while the server runs.** If something removes
  `pnpm dev`'s `/tmp/ai-office-sandboxes` while the server is running
  (a temp cleaner, say), and another local user makes it again before
  the next run, the run's own check of `runs` would not see that the
  root above it is theirs. The next start would refuse. Rechecking the
  root before every run would close that. It is not done here, as the
  default for `pnpm dev` is the system's temporary directory by design
  (`config.ts`), and moving it is a wider change.
- **The pen-test stack** (`docker/pen-test/`) has no `sandbox-dir`
  service. Its stand-up makes its work directory itself, `0700`, under
  the Owner's own state directory, so it was not affected.

## What could not be verified here

There is no Docker, no root and no second host account here. These are
for the host:

- Compose's nested default `${AI_OFFICE_SANDBOX_DIR:-${HOME}/.ai-office/sandboxes}`
  (the Compose specification allows nesting), checked with
  `docker compose config`. That check is in `docker/deployment.test.ts`,
  and is skipped here without Docker.
- The script in Alpine's BusyBox `sh` as root. Here it ran in the
  sandbox's `sh` as a non-root user, with `APP_UID` and `APP_GID` set to
  that user, and GNU coreutils ran its `stat -c %u`, `ls -A` and
  `chown -h`; BusyBox has each of these, which the host should confirm.
- Docker making the default and its parent as root, and the service
  taking it.
- Docker Desktop on macOS and Windows.
- The end-to-end attack, as a second, non-root local user. First, check
  they cannot make or link anything at the Owner's
  `~/.ai-office/sandboxes`, as the Owner's home is not theirs. Then, with
  `AI_OFFICE_SANDBOX_DIR` set under `/tmp`, have them pre-make it, or link
  it to their own directory, and see `docker compose up` stop with the
  service's refusal.
