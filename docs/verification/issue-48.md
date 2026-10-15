# Issue #48: Codex and opencode sandbox images; agent tool follows the AI Provider — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`64fb927`).

## What was built

### The agent tool follows the AI Provider (FR-16)

`agentToolSetup(agent, gatewayAccess, attribution)`
(`packages/orchestrator/src/sandbox/agent-tools.ts`) picks the agent tool
from `aiProviderAgentTools`: Claude → Claude Code, ChatGPT → Codex, Grok
and Gemini → opencode. It returns the tool, Sandcastle's agent provider
for it, and the model environment the sandbox gets. An AI Provider with
no agent tool is refused before anything is cloned. The sandbox runner
uses it, and asks for the sandbox of that tool (`sandbox(environment,
tool)`). `dockerSandbox()` runs each tool's image (`sandboxImages`).

How each tool reaches models, only through the AI Gateway with the
Agent's own Gateway Key (ADR 0001):

| Tool | Environment | How it is pointed at the Gateway |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS` | Unchanged from #26 and #36 |
| Codex | `OPENAI_BASE_URL` (`<gateway>/v1`), `AI_OFFICE_GATEWAY_KEY`, `AI_OFFICE_ISSUE`, `AI_OFFICE_PULL_REQUEST`, `AI_OFFICE_SESSION` | `codex exec` is given `-c` overrides: `model_provider="ai_office"`, a provider with `wire_api="responses"`, `env_key="AI_OFFICE_GATEWAY_KEY"`, `env_http_headers` mapping AI Office's headers to their variables, and `base_url` from `$OPENAI_BASE_URL` (expanded by the sandbox's shell). The effort (`minimal` to `high`) is `model_reasoning_effort`. |
| opencode | `OPENCODE_CONFIG_CONTENT` | A configuration whose only provider (`enabled_providers`) is `ai-office`: `@ai-sdk/openai-compatible` at `<gateway>/v1` with the Gateway Key and AI Office's headers, with the Agent's Model as its only Model (`model` and `small_model`). The tool runs `--model ai-office/<model>`. |

Every value is checked as before: the key must be a Gateway Key (the
refusal names the variable it was to go in, never the value), the
allow-list holds the new keys and nothing else, and no key for an AI
Account's credential (`OPENAI_API_KEY`, `CODEX_API_KEY`, `XAI_API_KEY`,
`GEMINI_API_KEY`, `GOOGLE_API_KEY`, …) is in it.

Usage: Codex's `turn.completed` usage comes back through Sandcastle as
the run's usage. opencode reports none (`usage: null`); the Gateway
counts every call regardless.

### The images

`docker/sandbox-codex/Dockerfile` and `docker/sandbox-opencode/Dockerfile`
follow `docker/sandbox-claude/Dockerfile` (#26): Node 26.10.0 and pnpm
12.10.0, `git`, `gh`, `jq`, a non-root `agent` user with the running
user's UID and GID, the worktree at `/home/agent/workspace`, `sleep
infinity`. Codex is `npm install --global @openai/codex@${CODEX_VERSION}`
and opencode `opencode-ai@${OPENCODE_VERSION}` (both `latest` by
default), each checked with `--version` during the build. Tags:
`ai-office/sandbox-codex:1` and `ai-office/sandbox-opencode:1`.

`pnpm sandbox:build` (now `docker/sandbox-build.ts`) builds all three, or
those named (`pnpm sandbox:build codex`). The Claude image's checks moved
to `docker/sandbox-images.test.ts` and now run on each image (Node and
pnpm pins, git/gh/pnpm, the non-root user, no credential, a new tag
version on any change, hadolint, and the opt-in build).

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. Output below.
- [x] Unit tests: each AI Provider maps to the right tool and
      environment, with no AI Account credential.
      `packages/orchestrator/src/sandbox/agent-tools.test.ts` (45 tests):
  - Claude → Claude Code, ChatGPT → Codex, Grok and Gemini → opencode,
    and each tool's image; an unknown AI Provider has none.
  - Each tool's exact environment, and its command as Sandcastle builds
    it. For Codex, the command is parsed by a real `sh` with the
    sandbox's environment, and the `-c` overrides Codex receives are
    checked word for word (the Gateway's URL expanded from
    `OPENAI_BASE_URL`). opencode's configuration is checked whole.
  - The prompt reaches Codex on standard input, and opencode as one inert
    word (shell metacharacters in it run nothing).
  - For each AI Provider: every key is on the allow-list, no AI Account
    credential key is present, and only one value holds the Gateway Key.
  - For each AI Provider and each of seven credential shapes, a
    non-Gateway Key is refused, naming the variable, never the value.
  - A credential slipped into any of a tool's variables is refused.

  `packages/orchestrator/src/sandbox/runner.test.ts` adds runs with real
  Sandcastle and the fake sandbox: a ChatGPT Agent runs Codex in the Codex
  sandbox, with exactly the Codex environment, its effort, its commit and
  its usage; Grok and Gemini Agents run opencode with the Gateway as their
  only provider. The test that a ChatGPT Agent was refused ("without its
  agent tool yet") now checks the same refusal for an AI Provider that has
  no tool (DeepSeek), as ChatGPT has one now.

### Verified on the host

- [ ] A coder run with each of ChatGPT, Grok and Gemini completes on
      `ai-office-sandbox`. **Not verifiable here**: it needs Docker, the
      real GitHub App and `ai-office-sandbox` repository (Owner action
      #18, open), and real ChatGPT, Grok and Gemini AI Accounts.

## Not verifiable in this sandbox

- **Building the images** (`AI_OFFICE_SANDBOX_IMAGE_E2E=1`): no Docker.
  The three opt-in build tests are skipped with the reason.
- **hadolint** on the three Dockerfiles: neither hadolint nor Docker is
  here, so those checks are skipped with the reason (CI runs them).
- **Codex and opencode themselves.** Neither tool is installed here, so
  the tests check what they are given (the command, the `-c` overrides
  and the configuration), not that the real tools accept it. Things to
  check on the host:
  - that `codex exec` honours the `-c model_providers.ai_office.*`
    overrides (custom provider, `env_key`, `env_http_headers`) and sends
    a `codex_exec/…` user agent, so a ChatGPT subscription can serve it;
  - that opencode reads `OPENCODE_CONFIG_CONTENT`, uses its bundled
    `@ai-sdk/openai-compatible` (or can fetch it from the sandbox
    network), and sends an `opencode/…` user agent, so a Grok
    subscription can serve it.
- **Real AI Accounts and recorded provider responses** (#45, open).

## Notes

- The issue names `OPENAI_BASE_URL` for Codex. Codex's built-in OpenAI
  provider reads it, but cannot send extra headers, and the issue and
  session headers are what Token Caps per issue (#50, #51) and session
  load balancing (FR-37) depend on. So Codex gets a model provider of AI
  Office's own whose `base_url` is the same `OPENAI_BASE_URL`, and the
  key goes in `AI_OFFICE_GATEWAY_KEY`, not `OPENAI_API_KEY`. That name
  is never set on a host, so nothing the host has can get in under it.
- opencode's configuration carries the Gateway Key in its JSON, as
  opencode reads it. It is still a Gateway Key, checked by shape, and the
  variable is checked for AI Account credentials like any other.
- The Claude image and its tag (`ai-office/sandbox-claude:1`) are
  unchanged.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck` (tail):

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`:

```text
 Test Files  116 passed (116)
      Tests  1214 passed | 225 skipped (1439)
   Start at  11:02:36
   Duration  33.61s (import 45%, tests 35%, transform 11%, environment 7%, setup 1%)
exit 0
```

The skipped tests need Docker (Postgres through Testcontainers, the
compose stack, hadolint's image, the image builds) and say so.

`pnpm vitest run packages/orchestrator/src/sandbox docker/sandbox-images.test.ts`:

```text
 Test Files  5 passed (5)
      Tests  155 passed | 6 skipped (161)
```

Skipped there, with their reasons:

```text
↓ hadolint, on the claude image > finds nothing to fault in the Dockerfile [hadolint is not installed (spawn hadolint ENOENT); Docker is not available (spawn docker ENOENT)]
↓ hadolint, on the codex image > … (the same)
↓ hadolint, on the opencode image > … (the same)
↓ with Docker, the claude image > builds, and runs claude --version as agent [AI_OFFICE_SANDBOX_IMAGE_E2E is not 1 (building the images downloads each agent tool and takes minutes)]
↓ with Docker, the codex image > builds, and runs codex --version as agent [the same]
↓ with Docker, the opencode image > builds, and runs opencode --version as agent [the same]
```
