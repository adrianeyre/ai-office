# Issue #24: Sandbox runner — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) on this branch, after the issue's last code commit.

## What was built

- **A read-only token** (`packages/github`).
  `RepositoryClient.readOnlyToken()` mints an installation token
  scoped to the one repository, with read permissions only (`contents`,
  `issues`, `pull_requests`, `checks`). The fake records each
  token's permissions, and its HTTP server refuses changes made with a
  read-only token (403, as GitHub does). The contract suite checks the
  token can read an issue but not comment on it.
- **Events** (`packages/events`): `sandbox.text` and
  `sandbox.tool_call`, each cut to 8000 characters.
- **The runner** (`packages/orchestrator/src/sandbox/`).
  `createSandboxRunner({ github, events, sandbox, modelEnvironment,
  workDir })` runs one task with `@ai-hero/sandcastle`'s `run()`:
  - **Clone:** the Floor's repository is cloned on the host at its
    default branch, with the read-only token. The token is passed to Git
    through `GIT_CONFIG_*` variables, so it appears neither on the
    command line nor in `.git/config` (which Sandcastle mounts into the
    sandbox). If GitHub already has the issue's branch, it is fetched
    too, so work carries on from it.
  - **Branch:** `branchStrategy: { type: "branch", branch:
    "ai-office/<issue>-<slug>", baseBranch: <default branch> }`.
  - **Environment:** only allow-listed keys. These are `GIT_AUTHOR_*`
    and `GIT_COMMITTER_*` (from #23's `gitEnvironment`), `GH_TOKEN`
    (the read-only token), and the model credential
    (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
    `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_OAUTH_TOKEN`). Two guards
    enforce this:
    - **The provider wrapper:** `allowListed(provider)` wraps the
      sandbox provider so its `create` sees only those keys.
    - **The repository's own `.sandcastle/.env`:** it is deleted from
      the clone. Sandcastle copies every key that file names from the
      host's `process.env`, so a repository could otherwise pull
      `DATABASE_URL` or `SESSION_SECRET` into its sandbox.
  - **Setup:** the Floor's setup command runs as a sandbox
    `onSandboxReady` hook (15 minutes at most).
  - **Prompt:** passed inline, which Sandcastle never shell-expands, so
    `` !`cmd` `` in issue text is never run.
  - **Events:** `onAgentStreamEvent` text and tool calls are published
    in order, between `sandbox.started` and `sandbox.stopped`
    (`finished`, `failed`, `cancelled` or `timed_out`).
  - **Result:** the commits on the branch, the usage (from Claude Code's
    `result` line), and the clone, for AI Office to push from later.
    `discard()` deletes the clone.
  - **Stopping:** a task `signal` cancels the run, and after
    `timeoutMs` (an hour by default) it times out. Either way Sandcastle
    closes the sandbox (Docker's `rm -f`), the clone is deleted, and a
    `SandboxRunError` names the outcome.
  - **Docker:** `dockerSandbox(imageName)` builds the Docker provider
    for production.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All
      three exit 0 (output below).
- [x] **Unit tests with a fake sandbox provider.**
      `packages/orchestrator/src/sandbox/runner.test.ts` runs the real
      Sandcastle `run()` with `createFakeSandbox()`, a bind-mount
      provider whose container is the host. A script stands in for Claude
      Code and prints its stream-json. A local bare repository stands in
      for GitHub's Git remote, and the fake GitHub for its API.
      - **The environment contains only allow-listed keys:** the
        sandbox's environment is exactly the six expected keys. This
        holds even though the host's `process.env` has
        `DATABASE_URL` and `SESSION_SECRET`, the repository commits a
        `.sandcastle/.env` naming them, and the provider adds a key of
        its own. `GH_TOKEN`'s scope on the fake GitHub is
        `readOnlyPermissions`, and the token is not in the clone's
        `.git/config`.
        - **Mutation check:** I disabled the allow-list filter by hand
          and this test failed, then restored it.
        - **The wrapper alone:** `environment.test.ts` checks it drops
          `DATABASE_URL`, `SESSION_SECRET` and `PATH` given straight
          to `create`.
      - **Events are emitted in order:** exactly `sandbox.started`
        (with the branch) → text → tool call (`Bash`, `pnpm test`) →
        text → `sandbox.stopped` (`finished`).
        - **Commits:** the returned commit is the branch head, authored
          and committed as the Floor's identity, and its parent is the
          default branch.
        - **Usage:** it matches the stream's `result` line.
      - **Cancellation stops the run:** aborting on the first
        `sandbox.text` rejects with `SandboxRunError`
        (`cancelled`), closes the sandbox, and records
        `sandbox.stopped` (`cancelled`). The clone is deleted. A
        1.5 s `timeoutMs` gives `timed_out` the same way.
      - **Also covered:**
        - the setup command runs before the agent;
        - work continues from a previously pushed issue branch;
        - the prompt reaches the agent verbatim, and its
          `` !`touch pwned` `` is never run;
        - an AI Provider without its agent tool fails without starting
          a sandbox;
        - branch slugs are cut to 40 characters, with accents dropped
          (a bug in the first slug code was caught by this test and
          fixed).

### Verified on the host

- [ ] **A real run against `ai-office-sandbox`** that produces commits
      on the named branch and a stream of events. **Not verifiable
      here:** it needs Docker, the Claude Code image (#26), the GitHub
      App and `adrianeyre/ai-office-sandbox` (#18, an Owner action not
      done yet), and a model credential.

### Also not verifiable in this sandbox

- **`readOnlyToken()` against real GitHub** (the contract suite's
  real-App run) needs the App from #18.

## Notes, and disagreements with the canon

- **The model credential (ADR 0001, PRD §7).** The issue asks for "the
  model credential for now", but ADR 0001 says sandboxes never hold a
  real AI Account credential, only the Gateway's URL and a Gateway Key.
  The allow-list already takes `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN`, so #36 can switch to the Gateway without
  changing it. Until #36, a sandbox given an `ANTHROPIC_API_KEY` does
  hold an AI Account credential, which goes against the ADR. Nothing
  wires the runner to a real credential yet.
- **Sandcastle and the host's Git identity.** Sandcastle copies the
  host's `git config user.name` and `user.email` into the sandbox's
  global Git config. Commits still carry the Floor's identity, because
  the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables override config.
  The tests check the author and committer.
- **Before the server runs sandboxes (#30), on the host:**
  - **Missing tools:** the app image (`Dockerfile`, `node:slim`)
    needs `git` and the `docker` CLI.
  - **Matching paths:** `workDir` must be a path that is the same
    inside the app container and on the Docker host. The sandbox's bind
    mounts are resolved by the host's Docker, not inside the container.
- **A housekeeping slip, fixed.** An online `pnpm add` created a pnpm
  store inside the workspace, and a broad `git add` committed it. I
  amended the commit before going on, and `.gitignore` now lists
  `.pnpm-store/`. The 409 MB of unreachable objects stay in the host
  repository's object store until Git's garbage collection prunes them.

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
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  57 passed (57)
      Tests  602 passed | 75 skipped (677)
   Start at  00:57:45
   Duration  6.16s (import 50%, tests 32%, transform 9%, environment 7%)
```
