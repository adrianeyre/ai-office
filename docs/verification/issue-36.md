# Issue #36: Sandboxes reach models only through the AI Gateway — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`f8f7d4e`).

## What was built

Most of the wiring (the Gateway's URL and the Agent's own Gateway Key in
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`) arrived with #35. This issue
removes what was left of #24's direct credential path, adds attribution, and
makes "no AI Account credential" something the code checks rather than a
convention.

### The sandbox's environment (`packages/orchestrator/src/sandbox/environment.ts`)

- **No key for an AI Account's credential.** `modelEnvironmentKeys` is now
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS`.
  `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` (#24's temporary path)
  are gone from the allow-list, so they are dropped wherever they come from
  (the host's environment, the repository's `.sandcastle/.env`, the
  provider).
- **Only a Gateway Key.** The runner's `modelEnvironment` option is replaced
  by `gateway: (agent) => Promise<{ url, key }>`. `gatewayModelEnvironment`
  refuses a key that is not shaped like a Gateway Key (`aio_gk_…`), with a
  `SandboxEnvironmentError` naming the variable, never the value.
- **Attribution (FR-42).** `ANTHROPIC_CUSTOM_HEADERS` makes Claude Code send
  `x-ai-office-issue: <N>` on every model call, and
  `x-ai-office-pull-request: <PR>` once the issue has an open pull request.
  The runner looks the pull request up on GitHub (`listPullRequests({ head:
  branch })`) when it starts.
- **Refused under any key.** `sandboxEnvironment` and the provider wrapper
  (`allowListed`, at `create` and for the provider's own environment) refuse
  any value, under any key, shaped like an AI Provider's credential: the
  central redactor's Anthropic key or token, OpenAI, xAI, Google API key,
  Google OAuth, AWS and JWT patterns. The runner also checks every value with
  `isAiAccountCredential`, which the server wires to
  `AiAccounts.holdsCredential`: it opens each of the Owner's AI Accounts
  (paused or not) and refuses a value holding any of their credentials,
  whatever their shape (a custom endpoint's key need not look like
  anything). A refused sandbox is never started; the run fails with
  `SandboxRunError` (`failed`).

### The Gateway (`packages/gateway`)

- Reads `x-ai-office-issue` and `x-ai-office-pull-request` (names in
  `gatewayAttributionHeaders`, `packages/shared`): positive numbers of up to
  nine digits; anything else is null.
- Records them in `gateway_requests.issue` and `pull_request` (migration
  `0018_request_attribution`, with an index on Floor, issue and id).
- Never forwards them to the AI Provider.
- Request history's API returns `issue` and `pullRequest`, and the web app
  shows them with the caller ("Codex for #4, PR #7").

### Reaching the Gateway from the sandbox's Docker network

- `SANDBOX_NETWORK` (new, optional): the Docker network sandboxes join.
  `dockerSandbox({ network })` passes it to Sandcastle's Docker provider.
- `docker-compose.yml` adds an `ai-office-sandboxes` network that the app
  joins (Postgres does not) and sets `SANDBOX_NETWORK` to it, so there
  `SANDBOX_GATEWAY_URL=http://app:4000`. `SANDBOX_GATEWAY_URL` stays opt-in
  (`${SANDBOX_GATEWAY_URL:-}`).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (935 passed, 154 skipped). Against Postgres 18: 1074 passed and
      15 skipped (the Docker image and compose checks).
- [x] **Unit test: the sandbox environment contains no AI Account credential
      under any key name.**
  - `packages/orchestrator/src/sandbox/environment.test.ts`:
    - `has no key for an AI Account's credential`: the model keys are
      exactly the three above, and none of `ANTHROPIC_API_KEY`,
      `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `XAI_API_KEY` or
      `GEMINI_API_KEY` is allowed.
    - `takes only a Gateway Key, never …`: eight credential shapes (Anthropic
      API key and subscription token, OpenAI, xAI, Google API key, Google
      OAuth token, AWS access key, a JWT as ChatGPT's OAuth tokens are) are
      each refused as the token, and the refusal does not carry them.
    - `is refused when it holds … under …`: each of the eight shapes in each
      of six places a value reaches a sandbox (`GIT_AUTHOR_NAME`,
      `GIT_AUTHOR_EMAIL`, `GH_TOKEN`, `ANTHROPIC_BASE_URL`,
      `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`): 48 cases, each
      refused naming the key.
    - `… one of the Owner's AI Account credentials, whatever its shape, under
      any key`: an opaque custom-endpoint key in each of those places.
    - `never starts a sandbox whose environment holds an AI Provider's
      credential, under any key`: the provider wrapper itself refuses.
  - `packages/orchestrator/src/sandbox/runner.test.ts`, with real Sandcastle
    `run()` and the fake sandbox:
    - `gives the sandbox only the allow-listed environment`: exactly eight
      keys, although the host's environment has `ANTHROPIC_API_KEY` and
      `OPENAI_API_KEY` and the repository's `.sandcastle/.env` asks for them.
    - `never gives the sandbox an AI Account's credential, under any key`:
      the host's environment and the provider's hold the Owner's credentials
      and a subscription token; no value in the started sandbox contains any
      of them, or `sk-ant-`, `sk-proj-` or `xai-`.
    - `never starts a sandbox given an AI Account's credential for its key`
      / `… a key that is not a Gateway Key`, and `… holds one of the Owner's
      AI Account credentials, whatever its shape` (as the Git identity): no
      sandbox is started, and the error names the key, not the value.
    - `gives the sandbox the AI Gateway's URL and its own Agent's Gateway
      Key, attributing its calls to the issue` and `names the issue's open
      pull request too, once it has one`.
  - **Mutation checks** (each reverted): disabling the shape check failed 49
    tests; putting `ANTHROPIC_API_KEY` back on the allow-list failed 2.

Also covered:

- `packages/gateway/src/keys/keys.test.ts` (in memory, and in Postgres 18):
  an Agent's request with `x-ai-office-issue: 4` and
  `x-ai-office-pull-request: 7` is recorded with its Agent, Floor, issue 4
  and pull request 7; an Owner tool's without them, or with malformed values
  (`4 OR 1=1`, `0`), records nulls; the AI Provider never receives the
  headers.
- `packages/gateway/src/request-log.test.ts` (Postgres 18): the columns are
  stored.
- `packages/gateway/src/accounts/accounts.test.ts`: `holdsCredential` finds
  an account's credential, paused or not, inside a longer value, and not a
  Gateway Key or an unknown key.
- `apps/server/src/gateway-requests/routes.test.ts`: the API returns
  `issue` and `pullRequest`.
- `apps/web/src/gateway-requests.test.tsx`: the list shows "Codex for #4,
  PR #7".
- `apps/server/src/config.test.ts`: `SANDBOX_NETWORK` is read, and a value
  that is not a network name (`--network host`) is refused.
- `docker/deployment.test.ts`: compose's `sandboxes` network is named
  `ai-office-sandboxes`, the app is on it with `SANDBOX_NETWORK` set, and
  Postgres is not.

### Verified on the host

- [ ] **A real coder run on `ai-office-sandbox` appears in the Gateway's
      request records attributed to the Agent and issue.** Not verifiable
      here: it needs Docker, the Claude Code image, the GitHub App and the
      `adrianeyre/ai-office-sandbox` repository (#18, an Owner action not
      yet done) and a real AI Account. To check on the host: run the server
      with `SANDBOX_GATEWAY_URL` (and `SANDBOX_NETWORK` if used), label an
      issue `ai-office`, then filter **Gateway** by the coder Agent; each
      request should show "for #<issue>".

### Also not verifiable in this sandbox

- That Claude Code really sends `ANTHROPIC_CUSTOM_HEADERS` as headers (its
  documented `Name: Value`, newline-separated format). The fake agent tool
  stands in for Claude Code.
- Docker attaching a sandbox to `SANDBOX_NETWORK`, and `http://app:4000`
  resolving there (`docker compose config` and the compose stack need
  Docker).
- The Testcontainers path of the Postgres tests (no Docker). They ran
  against an embedded Postgres 18.3 instead (below).

## How Postgres was run here

As in earlier issues: `@embedded-postgres/linux-x64@18.3.0-beta.16`,
unpacked in `/tmp/pgdl` (outside the repository), on port 54329. A scratch
edit to `packages/db/src/testing/postgres.ts` pointed `postgresTest` at it,
with database names unique to each test file; it was reverted with
`git checkout` and nothing from it is committed.

## Notes, and disagreements with the canon

- **Compose still cannot run sandboxes.** As noted for #24 and #30, the app
  image has neither `git` nor the `docker` CLI, and `SANDBOX_WORK_DIR` must
  be the same path in the container and on the Docker host. This issue
  makes the Gateway reachable from the sandbox network, but Agents still
  work only when the server runs outside compose.
- **Attribution headers are the caller's word.** The Agent and Floor come
  from the Gateway Key and cannot be forged; the issue and pull request are
  what the caller says. A sandbox could change them, but only for its own
  Agent's requests.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  89 passed (89)
      Tests  935 passed | 154 skipped (1089)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  89 passed (89)
      Tests  1074 passed | 15 skipped (1089)
   Start at  07:20:34
   Duration  38.77s (tests 89%, import 8%, environment 2%, transform 1%)
```
