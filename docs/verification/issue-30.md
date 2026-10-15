# Issue #30: Coder flow end to end, issue to pull request — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) on this branch, after the issue's last code commit.

## What was built

- **The coder flow** (`createCoderFlow` in
  `packages/orchestrator/src/coder/coder.ts`). It is the work queue's
  `ExecuteWork` for work at `needs-code`:
  1. **Hold.** It reads the issue and its stage from GitHub, and the
     queued coder Agent holds it (`in-progress`).
  2. **Prompt** (`coderPrompt`). The prompt has the issue, quoted
     between `<issue>` markers that the issue text cannot close (it is
     untrusted). It also has the Floor's settings (repository, branch,
     default branch, setup and test commands), the commit rules
     (Conventional Commits, `Refs #N`, the `Agent:` trailer, never
     push) and the Agent's extra instructions. It holds no credential.
  3. **Run.** The sandbox runner from #24 runs it, in the Claude Code
     image from #26 (`dockerSandbox()`), with the Floor's Git identity
     from #23.
  4. **Push as the App** (`publishBranch`, in
     `packages/orchestrator/src/git/publish.ts`).
     - The Agent's branch is fetched into a fresh repository of AI
       Office's own (hooks off, no global or system config), so nothing
       the Agent wrote into its clone's `.git/config` or hooks runs with
       the installation token that can write.
     - Each new commit is made again with `git commit-tree`: same tree
       and author date, authored and committed as the Floor's identity,
       with `withAgentTrailer`'s `Agent:` line (FR-68, FR-69). This
       holds whatever author the Agent set. Commits that already follow
       the rules keep their sha.
     - Commits upstream before the run are left alone. The runner now
       returns them as `upstream`, read from the clone before the Agent
       ran.
     - The push gives the token to Git through `GIT_CONFIG_*`. Git on
       the host now runs through one helper (`git/command.ts`), which
       `clone.ts` uses too, so errors carry Git's last line, never the
       token.
  5. **Pull request.** One per issue (FR-21): it is opened as the App,
     titled after the issue, with `Closes #N` and a link to the Agent's
     live view. A later run on the issue reuses the open one.
  6. **Move on.** `needs-code → needs-review` through the pipeline, which
     releases `in-progress`.
  7. **Notice.** An info Notice, "PR #N opened: <issue title>", links
     the issue, the pull request and the Agent.
  - **Failures.** If the sandbox fails, a run makes no commits, the push
    is refused or the coder is missing, the issue is let go at
    `needs-code` and the Agent's status becomes `blocked` with the
    reason. An action Notice, "Agent blocked: <Agent> on #N:
    <reason>", is raised. Cancellation (the server stopping) lets the
    issue go without a Notice, and the queue runs the work again on
    restart.
- **Events** (`packages/events`): `branch.pushed` and
  `pull_request.opened`, shown in the Activity Feed (a "Pull requests"
  type group; the pull request links to GitHub). The flow also
  publishes `agent.status_changed` (`working`, `idle`, `blocked`).
- **The server** (`apps/server/src/server.ts`). With the GitHub App
  configured and `SANDBOX_GATEWAY_URL` set, the work queue starts and
  runs the coder flow in Docker sandboxes. `SANDBOX_WORK_DIR` says
  where clones go. Sandboxes get `ANTHROPIC_BASE_URL` (the Gateway) and
  `ANTHROPIC_AUTH_TOKEN` set to `noGatewayKey`, a placeholder that is
  not a credential (the Gateway drops callers' credentials), never an
  AI Account's key (ADR 0001).
- **The fake GitHub:** `pushCommit(…, { sha })` takes the sha of a
  commit really pushed to a bare repository standing in for GitHub's
  Git remote.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm test` ran green three times in a row
      after the fix noted below.
- [x] **Scenario test with the fake GitHub and a fake sandbox: issue
      labelled → branch pushed → pull request opened with the right
      author and trailer → Notice raised.**
      `packages/orchestrator/src/coder/coder.test.ts` wires the real
      parts:
      - intake → the work queue (in memory) → the coder flow → the
        sandbox runner;
      - real Sandcastle `run()` with `createFakeSandbox()` (the host
        stands in for Docker, a script for Claude Code);
      - a local bare repository as GitHub's Git remote, the fake GitHub
        as its API.

      The Owner opens issue #1 labelled `ai-office` and intake runs.
      The fake agent makes two commits. The first is authored and
      committed as "Mallory" with no trailer; the second already
      follows the rules. The test then checks:
      - **The branch:** `ai-office/1-add-a-basket` is on the remote
        with exactly two new commits. Each is authored and committed as
        `adrianeyre <21265837+adrianeyre@users.noreply.github.com>`,
        its message ends with `Agent: <coder> (coder, Claude
        claude-opus-5-5)`, and "Mallory" appears nowhere. `main` is
        untouched.
      - **The pull request:** exactly one, by `ai-office[bot]` (the
        App), from the pushed head sha into `main`, with `Closes #1`
        and the live-view link in its body.
      - **The issue:** labelled `ai-office` and `needs-review` only (no
        `in-progress`).
      - **The Notice:** one open info Notice, "PR #2 opened: Add a
        basket!", with the issue and pull request links and the coder's
        id, and no actions.
      - **The events, in order:** `issue.picked_up`, the label moves,
        `agent.status_changed`, `sandbox.started`/`stopped`,
        `branch.pushed` (sha = the pull request's head, 2 commits),
        `pull_request.opened`, the move to `needs-review`,
        `notice.raised`.

      The same file also covers:
      - **The prompt** carries the issue, the branch, `pnpm test`,
        `Refs #1` and the trailer. It has no model key and no `ghs_` or
        `ghp_` token. The issue's own `</issue>` cannot close the
        quote.
      - **The Agent's Git config and hooks never run with the
        token.** The agent adds a `url.<evil>.insteadOf <remote>` rule
        and a `pre-push` hook to its clone. The branch still reaches
        the real remote, the "evil" remote stays empty and the hook
        never runs. **Mutation check:** I made `publishBranch` push
        straight from the Agent's clone. The push then went to the
        evil remote and this test failed. I restored the code.
      - **Failures raise "Agent blocked":**
        - **No commits:** an action Notice "Agent blocked: <coder> on
          #1: <coder> finished without committing anything.", the
          issue back at `needs-code` with nothing in progress, no pull
          request, the work `failed`, and `agent.status_changed`
          `blocked`.
        - **A refused push** (to a missing remote): the reason starts
          "Git could not push ai-office/1-add-a-basket:" and contains
          no `ghs_`, `x-access-token` or `Authorization`.
        - **A crashed agent:** the reason contains "The sandbox for
          issue #1 failed".
      - **Unit tests:**
        - `git/publish.test.ts`: content and author dates are kept;
          commits that already follow the rules keep their sha; it
          carries on from a branch pushed before without touching its
          commits; a non-fast-forward push fails with Git's reason and
          no token.
        - `coder/prompt.test.ts`: the prompt's sections; the issue
          cannot close its quote (in any letter case); there is no
          setup or test command; a test command of several lines.
        - `sandbox/environment.test.ts`: the Gateway's model
          environment.
        - `config.test.ts`: `SANDBOX_*`.
        - `activity-feed.test.tsx`: `pull_request.opened`'s text and
          link.

### Verified on the host

- [ ] **On `ai-office-sandbox`, a labelled issue becomes an
      App-opened pull request authored as the Owner.** **Not verifiable
      here.** It needs:
      - the GitHub App and `adrianeyre/ai-office-sandbox` (#18, an Owner
        action not done yet);
      - Docker and the Claude Code image (`pnpm sandbox:build`);
      - the server run outside compose (see below), with
        `SANDBOX_GATEWAY_URL` set to an address where sandbox
        containers reach the AI Gateway, `GATEWAY_HOST` letting them
        reach it, and `ANTHROPIC_API_KEY` for the Gateway's AI Account.

## Not verifiable in this sandbox

- **Docker:** a real Claude Code run in a sandbox container, and the
  Postgres-backed tests (skipped here with their reason, as before).
- **Real GitHub:** pushing over HTTPS with an installation token, and
  the App opening the pull request.
- **A real model:** Claude Code reaching a model through the AI Gateway
  with the `noGatewayKey` placeholder. The Gateway drops callers'
  credentials (its own tests cover that), but no real call was made
  here.

## Notes, and disagreements with the canon

- **A fix found by the full suite.** `runGit` wrote to Git's standard
  input even when Git does not read it, so a Git that exited first
  caused `EPIPE` errors (12 unhandled errors in the first full run;
  every test still passed). It now writes only when there is input, and
  ignores errors on that pipe, since Git's exit status decides the
  result.
- **ADR 0001 and Gateway Keys.** Sandboxes reach models only through the
  Gateway, as the ADR requires. Gateway Keys do not exist yet (#36), so
  a sandbox sends a fixed placeholder that is not a credential, and the
  Gateway still has no authentication. Making it reachable from sandbox
  containers (`GATEWAY_HOST`) exposes an unauthenticated Gateway to
  whatever else can reach that address until #36. This is the Owner's
  choice when they set `SANDBOX_GATEWAY_URL`, and `.env.example` says
  so.
- **Compose.** The app image (`Dockerfile`, `node:slim`) still lacks
  `git` and the `docker` CLI, and `SANDBOX_WORK_DIR` must be the same
  path inside the container and on the Docker host (noted in #24).
  Neither `SANDBOX_*` variable is passed through `docker-compose.yml`,
  so under compose Agents do not work issues yet. The README says so.
- **A blocked issue stays at `needs-code`.** After "Agent blocked",
  nothing retries the issue on its own: intake skips issues already in
  the pipeline, and the work is recorded as failed. Retrying (from the
  Notice, say) is not part of this issue. `needs-human` was not used,
  because only the Owner may move an issue out of it.
- **Later work updates the pull request.** If an open pull request
  already exists for the branch (a later run on the issue), it is
  reused and the info Notice says "updated". The Review Loop that sends
  issues back is #54.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  73 passed (73)
      Tests  714 passed | 103 skipped (817)
```

The new tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ src/coder/coder.test.ts > the coder flow > turns a labelled issue into an App-opened pull request authored as the Owner, and raises a Notice
 ✓ src/coder/coder.test.ts > the coder flow > asks the Agent with the issue, the Floor's settings and the commit rules, and no credential
 ✓ src/coder/coder.test.ts > the coder flow > pushes from AI Office's own repository: the Agent's Git config and hooks never run with the token
 ✓ src/coder/coder.test.ts > the coder flow > raises an action Notice when the Agent commits nothing, letting the issue go
 ✓ src/coder/coder.test.ts > the coder flow > says why when the push fails, without the token
 ✓ src/coder/coder.test.ts > the coder flow > raises an action Notice when the sandbox fails
 ✓ src/git/publish.test.ts > publishBranch > makes the new commits as the Owner with the trailer, keeping their content and dates
 ✓ src/git/publish.test.ts > publishBranch > leaves commits that already follow the rules as they are
 ✓ src/git/publish.test.ts > publishBranch > carries on from a branch pushed before, touching none of its commits
 ✓ src/git/publish.test.ts > publishBranch > fails, saying where, when the remote refuses the push
 ✓ src/coder/prompt.test.ts > the coder's prompt > (4 tests)
 ✓ src/sandbox/environment.test.ts > a sandbox's environment > reaches models through the AI Gateway, without an AI Account's credential
 ✓ src/config.test.ts > loadConfig > reads where sandboxes work and how they reach the AI Gateway
 ✓ src/activity-feed.test.tsx > event text > links an opened pull request to itself on GitHub
```
