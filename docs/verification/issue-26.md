# Issue #26: Claude Code sandbox image — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **`docker/sandbox-claude/Dockerfile`**, on `.sandcastle/Dockerfile`'s
  pattern:
  - `node:${NODE_VERSION}-bookworm` with `NODE_VERSION=26.10.0`;
  - pnpm `12.10.0`;
  - `git`, `curl`, `jq`, `ca-certificates`, and `gh` from GitHub's
    apt repository;
  - Claude Code from its native installer, run as `agent` (Claude Code
    refuses root), with `CLAUDE_CODE_VERSION` (`stable` by default).
    The installer's own `claude --version` runs at build time;
  - the base image's `node` user renamed to `agent`, with
    `AGENT_UID` and `AGENT_GID` build arguments, and `USER
    ${AGENT_UID}:${AGENT_GID}`;
  - `WORKDIR /home/agent/workspace` (where Sandcastle mounts the
    worktree) and `ENTRYPOINT ["sleep", "infinity"]`.
- **A version tag:** `claudeSandboxImage = "ai-office/sandbox-claude:1"`
  (`packages/orchestrator/src/sandbox/images.ts`).
  `dockerSandbox()` (#24) now runs this tag by default.
- **A build script:** `pnpm sandbox:build` (`docker/sandbox-claude/build.ts`)
  runs `docker build --tag ai-office/sandbox-claude:1` with the running
  user's UID and GID (root becomes 1000), or `AGENT_UID`, `AGENT_GID`
  and `CLAUDE_CODE_VERSION` from the environment.
- **Tests:** `docker/sandbox-claude/image.test.ts`, in the
  `deployment` Vitest project:
  - **Static checks:**
    - Node and pnpm match the root `package.json`'s pins;
    - git, gh, pnpm and Claude Code are installed;
    - there is exactly one `USER`, the numeric `agent` one, and
      Claude Code is installed after it;
    - the worktree path is the working directory;
    - the build arguments are right.
  - **Version guard:** the Dockerfile's SHA-256 is recorded against the
    tag's version, so changing the Dockerfile without bumping the tag
    fails the suite. A server should never run sandboxes from a stale
    image under the same tag.
  - **hadolint:** run if installed, else `hadolint/hadolint:v2.15.1`
    (pinned by digest) on Docker, else skipped with the reason (failing
    in CI, which has Docker, so CI always lints it).
  - **With Docker:** with `AI_OFFICE_SANDBOX_IMAGE_E2E=1`, the test
    builds the image and runs `whoami`, `claude --version`, `git`,
    `gh`, `pnpm` and `node` in it. It expects `agent` and the
    pinned versions.

## Acceptance criteria

### Verified in the sandbox

- [x] **The Dockerfile lints (hadolint).** hadolint 2.15.1's static
      binary was downloaded to `/tmp` (not committed) and reports
      nothing, at its default threshold, which includes info-level
      findings.
      - **DL3008 (unpinned apt packages):** ignored inline on the two
        apt steps, with the reason in the Dockerfile. Debian drops exact
        package versions as security updates land, so pins would break
        rebuilds; the versions come with the pinned base image.
      - **The test, run:** with that binary on `PATH`, the suite's
        hadolint test runs and passes.
      - **Mutation check:** deleting the `SHELL … pipefail` line made
        it fail (DL4006), and the version guard failed too. I restored
        the line.

      ```text
Haskell Dockerfile Linter 2.15.1
exit code 0
      ```

      ```text
✓ |deployment| docker/sandbox-claude/image.test.ts > the Claude Code sandbox image's Dockerfile > uses the Node and pnpm versions pinned in package.json
✓ |deployment| docker/sandbox-claude/image.test.ts > the Claude Code sandbox image's Dockerfile > installs git, gh, pnpm and Claude Code
✓ |deployment| docker/sandbox-claude/image.test.ts > the Claude Code sandbox image's Dockerfile > runs as a non-root agent user with the UID and GID it is built with
✓ |deployment| docker/sandbox-claude/image.test.ts > the Claude Code sandbox image's Dockerfile > has a new image version whenever it changes
✓ |deployment| docker/sandbox-claude/image.test.ts > pnpm sandbox:build > tags the image as the orchestrator runs it, for the running user
✓ |deployment| docker/sandbox-claude/image.test.ts > pnpm sandbox:build > takes the IDs and Claude Code's version from the environment
✓ |deployment| docker/sandbox-claude/image.test.ts > pnpm sandbox:build > never gives the agent user root's IDs
✓ |deployment| docker/sandbox-claude/image.test.ts > hadolint > finds nothing to fault in the Dockerfile
↓ |deployment| docker/sandbox-claude/image.test.ts > with Docker > builds, and runs claude --version as agent [AI_OFFICE_SANDBOX_IMAGE_E2E is not 1 (building the image downloads Claude Code and takes minutes)]
Tests  8 passed | 1 skipped (9)
      ```
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All
      three exit 0 (output below). Without hadolint on `PATH` and
      without Docker, `pnpm test` skips the hadolint check with that
      reason. It ran with hadolint on `PATH` as shown above.

### Verified on the host

- [ ] **The image builds, and `claude --version` runs as `agent`.**
      **Not verifiable here:** there is no Docker in this sandbox. On the
      host, run:

      ```bash
      AI_OFFICE_SANDBOX_IMAGE_E2E=1 pnpm vitest run --project deployment docker/sandbox-claude
      ```

      or `pnpm sandbox:build`, then `docker run --rm --entrypoint sh
      ai-office/sandbox-claude:1 -c 'whoami && claude --version'`.

## Notes

- **Which user's IDs.** "Host-aligned UID/GID" means the user that runs
  AI Office, since it creates the worktrees the sandbox mounts.
  - **Running directly on the host:** that is the build script's
    default, the user running it.
  - **In compose:** the app runs as `node` (1000:1000), so build with
    `AGENT_UID=1000 AGENT_GID=1000`. Sandcastle's Docker provider
    checks that the image's UID matches the running process's.
- **Claude Code's version.** It is a build argument, not pinned in the
  Dockerfile: the default `stable` channel gets updates from a rebuild.
  Set `CLAUDE_CODE_VERSION` for a fixed version.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/gateway typecheck: Done
e2e typecheck: Done
apps/web typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/server typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  60 passed (60)
      Tests  623 passed | 87 skipped (710)
   Start at  01:10:48
   Duration  6.61s (import 49%, tests 33%, transform 10%, environment 8%)
```
