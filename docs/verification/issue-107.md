# Issue #107: Qwen, Ollama, compatible endpoints and outbound proxy — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `55d3674`: every commit of the issue except this
document. The Postgres tests were also run against a throwaway local
Postgres 18.4 (see [The Postgres side](#the-postgres-side)).

## What was built

- **Four AI Providers** (`packages/shared/src/agents.ts`,
  `ai-providers.ts`; PRD FR-15, FR-16): **Qwen**, **Ollama**,
  **Anthropic-compatible** and **OpenAI-compatible**, after Kimi. Qwen,
  Ollama and OpenAI-compatible run **opencode** in sandboxes;
  Anthropic-compatible runs **Claude Code**. None takes an effort level,
  and none has a default Model until the Owner chooses one from the
  catalogue.
- **A new account type, `endpoint`** (`aiAccountTypes`): an endpoint the
  Owner names, with a key only if it asks for one. Migration
  `0057_ai_accounts_endpoints_outbound_proxy.sql` lets it through the
  `ai_accounts`, `gateway_model_mappings` and `model_catalogue` checks.
- **Five AI Account kinds** (`aiAccountKinds`; FR-35):

  | Kind (label) | AI Provider | Type | API | Serves |
  | --- | --- | --- | --- | --- |
  | Qwen sign-in (Qwen Code's free tier) | Qwen | `oauth` (device login + PKCE) | the `resource_url` its login names (`https://portal.qwen.ai`) + `/v1` | opencode's Chat Completions only |
  | Ollama (your own server) | Ollama | `endpoint`, no key | `http://localhost:11434/v1`, or the Owner's URL | Chat Completions, Messages (translated) |
  | Ollama Cloud API key | Ollama | `api_key` | `https://ollama.com/v1` | Chat Completions, Messages (translated) |
  | Anthropic-compatible endpoint | Anthropic-compatible | `endpoint`, URL required, key optional | the Owner's URL + `/v1/messages` (as `ANTHROPIC_BASE_URL`) | Messages; Chat Completions and Responses translated; no `count_tokens` |
  | OpenAI-compatible endpoint | OpenAI-compatible | `endpoint`, URL required, key optional | the Owner's URL, `/v1` included (as `OPENAI_BASE_URL`) | Chat Completions, Responses; Messages translated |

  - **Qwen's sign-in** (`qwenOAuth` in
    `packages/gateway/src/accounts/oauth.ts`) is Qwen Code's: its public
    client, a device code asked for with a PKCE challenge
    (`devicePkce`), the tokens with its verifier. Each answer's
    `resource_url` (`apiUrlOf`) becomes the account's endpoint, and a
    refresh that names another moves it. It serves only opencode
    (`servesOnly`), after a terms warning, as Grok's subscription does.
    Its catalogue is the Models Qwen Code names (`documentedModels`).
  - **No key is not an empty key.** An endpoint added without one is
    sent no credential header at all (`authHeaders`, used by the Gateway,
    the catalogue, keep-alive and auto-refresh). Its empty credential is
    never told to the redactor, and `holdsCredential` does not take it to
    be in every value (which would have refused every sandbox).
  - **Anthropic-compatible endpoints** are sent their key both as
    `x-api-key` and as a bearer token (`bearerToo`): most document
    `ANTHROPIC_AUTH_TOKEN`, some `ANTHROPIC_API_KEY`.
  - **The recorded path** of a request is now its whole path on the host,
    so an endpoint's own path shows (`/openai/v1/chat/completions`). It is
    unchanged for every earlier kind, whose URLs have no path.
- **Routing** (FR-38, FR-40, FR-41; `aiProviderTakes`):
  - `aiProviderOfModel` gains Ollama's `model:tag` (`qwen3-coder:30b`,
    `gpt-oss:120b`, but not Bedrock's `-v1:0`) and Qwen's `qwen*`, `qwq-*`,
    `coder-model` and `vision-model`.
  - A compatible endpoint is sent **any** Model, may be forced any, and
    may be given any in a Combo's slot or a mapping. Every other AI
    Provider is held to its own Models, and to those no AI Provider
    claims, as before.
  - **A Model no AI Provider claims by name** goes only to the Owner's
    compatible endpoints while one of them can serve it; with none, to any
    account as before. Without this, an unknown Model asked of a
    compatible endpoint would go to a Claude account of better priority
    and come back `404`.
  - The AI Providers API lists a compatible endpoint's Models as its own,
    whoever's they are by name.
- **The model catalogue** (FR-41): each compatible endpoint is asked for
  its own list, and the catalogue lists the Models of every endpoint of a
  kind together (one that cannot be reached leaves the others'). vLLM's
  `max_model_len` is read as a context window.
- **The outbound HTTP proxy** (FR-35, FR-45):
  - `createUpstreamFetch` (`packages/gateway/src/upstream.ts`) is the one
    `fetch` for everything upstream. While a proxy is set it sends each
    request through undici's `ProxyAgent` (a new dependency of the
    Gateway, `undici@^8.11.2`, the major Node 26 bundles), with the
    proxy's username and password as `proxy-authorization`. The AI Office
    host itself (`localhost`, `127.0.0.0/8`, `::1`) and the hosts the
    Owner lists are reached directly (`bypassesProxy`). The proxy is asked
    for on every request, so a change applies to the next one.
  - The server gives it to the Gateway (`buildGateway`'s new `fetch`), the
    AI Accounts (sign-ins, token refreshes, usage, auto-refresh, Vertex
    AI's token exchange), the model catalogue, published prices and
    prompt-cache keep-alive. It reads the proxy at start and on each
    `outboundProxy.*` change.
  - The office settings keep it in `office_settings`: URL, username, the
    password **sealed** with `ENCRYPTION_KEY` (a check holds it to
    `aio1:…`) and the hosts to bypass it for. The password is registered
    with the redactor once opened and never handed back.
  - `GET` and `PUT /api/office/outbound-proxy` (Owner only). The answer
    is `{url, username, hasPassword, noProxy}`; an absent password keeps
    the stored one (for the same username), null removes it, and a null
    URL turns the proxy off.
- **AI Settings**: **Add an AI Account** offers the five kinds (Qwen's
  sign-in like Grok's; an endpoint's key optional, its URL hint saying
  where it goes), and a new **Outbound proxy** card.
- **Guide:** sections on Qwen sign-ins, Ollama and Ollama Cloud,
  compatible endpoints and the outbound proxy in
  [`docs/guide/ai-gateway.md`](../guide/ai-gateway.md). The fixtures are
  described in `packages/gateway/fixtures/README.md`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below).
      - **Without Docker:** 3231 passed, 407 skipped (the
        Postgres tests, with the reason). Before this issue (`b202b5a`,
        per #106's verification) it was 3084 passed, 403 skipped. The four
        new skips are the Postgres runs of this issue's new cases (the
        proxy's settings, its API, the server end to end, and the new
        kinds' Models through the AI Providers API); they did run, against
        a local Postgres (below).
      - **Nothing skipped, deleted or weakened.** These existing
        expectations changed with the API, as #106's did:
        - the AI Providers API lists thirteen AI Providers, not nine
          (`apps/server/src/ai-providers/routes.test.ts`), and its
          agent-tool check says Claude Code for Anthropic-compatible too;
        - the Agent editor offers the four new AI Providers, each "(no
          default Model yet)", disabled (`apps/web/src/floors.test.tsx`);
        - the API-key error is now "Only Claude, Grok, Gemini, OpenRouter,
          DeepSeek, Z.ai, Minimax, Kimi and Ollama API keys can be added so
          far." and the account-type one "Add an API key, an endpoint, an
          AWS Bedrock or a Google Vertex AI account here; …"
          (`packages/shared`, `apps/server/src/ai-accounts/routes.test.ts`,
          `cloud.test.ts`);
        - the orchestrator's per-AI-Provider tables (`agent-tools.test.ts`)
          hold the four new ones, and the keys no sandbox may hold gain
          `DASHSCOPE_API_KEY` and `OLLAMA_API_KEY`.
      - **The API-key contract** (`api-key-contract.ts`) now also takes an
        endpoint type, with a key or none, a path of its own, and "any
        Model". The five earlier types' 115 tests pass unchanged through
        it; for a type that is sent any Model, its "serve only its own
        Models" test is replaced by one for its own routing rule (an `if`,
        not a skip).
- [x] **Contract tests per type.** One file per type in
      `packages/gateway/src/providers/` (`qwen.test.ts`, `ollama.test.ts`,
      `ollama-cloud.test.ts`, `openai-compatible.test.ts`,
      `anthropic-compatible.test.ts`; 56 tests), each replaying
      its fixtures (`fixtures/<type>/`, written by hand) through a real
      Gateway serving from a real account of that type, added through
      `AiAccounts` (or signed in through a fake OAuth server shaped like
      Qwen's), the AI Provider's answer in 7-byte chunks. For each fixture:
      - the account receives its own path (the Owner's endpoint path
        included: `/openai/v1/…`, `/anthropic/v1/messages`), the very body
        and its credential as that type sends it (a bearer token; both
        headers for Anthropic-compatible; **no header at all** for Ollama
        and keyless endpoints), never the Gateway Key;
      - the caller gets the answer byte for byte;
      - the record has the status, endpoint, streaming, Model and tokens
        (cache reads apart), and no cost (none of these Models is priced);
      - recorder mode saves the path as sent, and never the key.

      Each type is also checked, through the Gateway, to:
      - serve the other format's agent tool, translated (Claude Code's
        Messages to Chat Completions; opencode's Chat Completions to an
        Anthropic-compatible endpoint's Messages);
      - route as its kind says: Ollama and Qwen only their own Models; a
        compatible endpoint any Model, and one no AI Provider claims before
        a Claude account of better priority, while a Claude Model still
        goes to Claude;
      - serve Qwen only to opencode (Claude Code's Messages and another
        tool's requests get `503`), sign in with PKCE, follow
        `resource_url` at sign-in and on refresh;
      - send no `count_tokens` (and no Responses where the kind has none);
      - fall back to a second account after each documented failure,
        holding the first back as it says:

        | Type | Failures |
        | --- | --- |
        | Qwen | `429 insufficient_quota`, rate-limited 60 s (the default) |
        | Ollama | `500` (runner died), a failure that holds nothing back; a `404` (Model not pulled) is passed back, as the request's fault |
        | Ollama Cloud | `429` (usage limit), 60 s; `502`, a failure |
        | OpenAI-compatible | `429` with `retry-after: 7`, 7 s; `502`, a failure |
        | Anthropic-compatible | `429` with `retry-after: 15`, 15 s; `529`, overloaded 30 s |

      - hold the key as a secret: never listed, found by `holdsCredential`
        (so kept out of sandboxes) and told to the redactor; an endpoint
        without one tells nothing and holds nothing.
- [x] **Proxy honoured in tests.** `packages/gateway/src/upstream.test.ts`
      runs a fake HTTP proxy (`startFakeProxy` in `test-support.ts`: plain
      forwarding and `CONNECT` tunnels) that forwards to local servers
      under names nothing else resolves (`api.kimi.test`,
      `chat.qwen.test`, `openrouter.test`), so a request that arrives went
      through it. With the proxy set:
      - a request through an AI Account reaches the AI Provider only
        through the proxy, with the proxy's `proxy-authorization`; the AI
        Provider gets the account's key and nothing of the proxy's;
      - model lists, Qwen's device sign-in and token refresh, and
        OpenRouter's published prices go through it too;
      - a change applies to the next request: off (unreachable, `502`), on
        (`200`), off again (`502`), and a new proxy gets the next request;
      - `localhost`, `127.0.0.1`, `::1` and the listed hosts are sent
        directly; any other host through the proxy.

      End to end (`apps/server/src/main.test.ts`, Postgres): the running
      server, its proxy set through `PUT /api/office/outbound-proxy`,
      sends the Gateway's next request through it, its password sealed in
      `office_settings` and in no event; turned off, the next goes
      directly. Also covered: the proxy's settings in the orchestrator
      (sealed, kept for the same username, changes named never valued),
      its API (`apps/server/src/office/routes.test.ts`: the password in no
      answer, problem, event or log line) and its schema and bypass rules
      (`packages/shared/src/outbound-proxy.test.ts`).

  Also covered:
  - routing (`src/accounts/compatible-endpoints.test.ts`): unclaimed
    Models to an endpoint before Claude, to Claude when the endpoint is
    paused; any Model forced on, or in a Combo slot for, an endpoint, and
    only Ollama's on Ollama;
  - each kind's catalogue (`src/models/catalogue.test.ts`): Ollama's and
    Ollama Cloud's lists, two OpenAI-compatible endpoints' lists merged,
    an Anthropic-compatible one's in Anthropic's shape, keyless lists
    asked without a credential, Qwen's documented Models with no request,
    and one endpoint failing leaving the other's;
  - each kind through the API (`apps/server/src/ai-accounts/providers.test.ts`,
    `ai-providers/routes.test.ts`): Qwen's sign-in, an Ollama Cloud key,
    the Owner's Ollama with no key, compatible endpoints with a key or
    none and refused without a URL, never echoing or logging a key; and
    their Models listed as their own, with defaults set from them;
  - the kinds, routing by name and the request schema
    (`packages/shared/src/ai-accounts.test.ts`);
  - the agent tools (`agent-tools.test.ts`): Claude Code for an
    Anthropic-compatible endpoint, with its Model and no effort;
  - AI Settings (`apps/web/src/ai-accounts-card.test.tsx`,
    `outbound-proxy-card.test.tsx`): each kind in **Add an AI Account**
    and Qwen's device sign-in; the proxy card sending the password once,
    clearing it, keeping or removing it, turning the proxy off and saying
    what is wrong.

  **Mutation checks** (each applied alone, the tests named run, then the
  file restored):

  | Mutation | Tests run | Failed |
  | --- | --- | --- |
  | A keyless endpoint's empty key kept as a secret (`secretsOf` unfiltered) | Ollama, Anthropic- and OpenAI-compatible contracts | 2 |
  | A keyless endpoint sent an empty key (`authHeaders`) | Ollama, Anthropic-compatible, catalogue | 7 |
  | Unclaimed Models not sent to endpoints first | both compatible contracts, routing | 3 |
  | Compatible endpoints held to Models by name (`aiProviderTakes`) | both compatible contracts, routing, AI Providers API, shared | 15 |
  | Ollama's `model:tag` names not Ollama's | Ollama, Ollama Cloud, shared, routing | 19 |
  | No PKCE challenge on Qwen's device code | Qwen contract | 8 |
  | A sign-in's `resource_url` ignored | Qwen contract, accounts API | 7 |
  | A refresh's `resource_url` ignored | Qwen contract | 1 |
  | Anthropic-compatible sent `x-api-key` only | Anthropic-compatible, catalogue | 5 |
  | A later endpoint's list replacing the first's | catalogue | 4 |
  | The endpoint's own path left out of the record | both compatible contracts | 9 |
  | The AI Office host sent through the proxy | proxy, shared | 2 |
  | The proxy's credentials not sent | proxy | 1 |
  | The Gateway not using its `fetch` (global `fetch`) | proxy | 3 |
  | The proxy's password stored in clear | office settings, office API | 2 |
  | The server's Gateway not given the proxy's `fetch` | server end to end (Postgres) | 1 |
  | The server not reading the proxy again when it changes | server end to end (Postgres) | 1 |

### Verified on the host

- [ ] **A real Qwen sign-in, Ollama server, Ollama Cloud key and
      compatible endpoints serve through the Gateway, and a real proxy
      carries them.** Not done here: there is no such account, server or
      proxy in the sandbox. The issue lists no host check, but these are
      worth making before relying on them.

## Not verifiable in this sandbox

- **The AI Providers' real answers.** The fixtures were written by hand
  (#45 is open), from Qwen Code's source, Ollama's OpenAI-compatibility
  and Cloud documentation, and the Anthropic and OpenAI formats, as of
  2026-10-10. No request was made to any of these services. To check on
  the host:
  - **Qwen:** that the device and token endpoints still take Qwen Code's
    client and PKCE as here; the shape of `resource_url`; that the portal
    accepts `qwen3-coder-plus` and `qwen3-coder-flash` as well as
    `coder-model` and `vision-model`; the body of its quota `429`, and
    whether a daily quota should hold the account back longer than a
    minute.
  - **Ollama Cloud:** that `https://ollama.com/v1/chat/completions` and
    `/v1/models` serve OpenAI's formats with a bearer key (Ollama documents
    its native `/api/…` for the cloud), and its usage-limit `429` body.
  - **Ollama:** that streamed answers carry usage with
    `stream_options.include_usage`.
- **HTTPS through the proxy.** The tests' AI Providers are plain HTTP, so
  the proxy forwards them as proxied requests. For `https://` AI
  Providers undici's `ProxyAgent` opens a `CONNECT` tunnel; the fake proxy
  handles `CONNECT`, but no test sends TLS through it (there is no
  certificate authority here). Check with a real proxy on the host.
- **opencode and Claude Code** are not installed here: their
  configuration for each new AI Provider is checked, not that they run.
  Claude Code with a non-Claude Model name through an Anthropic-compatible
  endpoint should be tried on the host.
- The Playwright suite (`pnpm e2e`) was not run (no Docker). No e2e test
  names an AI Provider.

### The Postgres side

Without Docker, `postgresTest` skips with its reason, so the migration and
the database stores this issue changes would go unrun here. To run them
anyway, Postgres 18.4 was started from the `@embedded-postgres/linux-x64`
binaries in `/tmp` (outside the repository), and
`packages/db/src/testing/postgres.ts` was patched **for that run only, and
not committed**, to use it (`preparePostgresServer`, which the harness
already has) in place of a container. Every test file then ran one at a
time against it:

```text
$ LOCAL_PG_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm exec vitest run --fileParallelism=false
 FAIL  |@ai-office/gateway| src/request-log.test.ts > databaseRequestLog against Postgres 18 > stores a record in gateway_requests
AssertionError: expected [ { id: 1, …(24) } ] to deeply equal [ { id: 1, …(23) } ]
+     "keepAlive": false,
 Test Files  1 failed | 271 passed (272)
      Tests  1 failed | 3612 passed | 21 skipped (3634)
```

It ran on the tree of `bcbe988` (the server's commit) while the web app's
changes were being made, which touch no Postgres code.

- **Every Postgres test of this issue passed**: the migration (every
  database test file migrates a template through `0049`), the proxy's
  store and settings, the office API's case, the AI Providers API's case,
  and the server end to end with the proxy (`main.test.ts`, also run on
  its own at the end, 6 passed).
- **The one failure predates this issue.** `databaseRequestLog`'s test
  expects a `gateway_requests` row without the `keep_alive` column that
  prompt-cache keep-alive added. Run the same way on `fb93e41` (#106's last
  commit, in a scratch worktree), it fails identically. It is outside this
  issue and was left alone; CI, which runs the Postgres tests, would fail
  on it.
- The 21 skips are not Postgres tests (with the local server none is
  skipped). 13 of them are the GitHub contract suite's real-App half, as
  `GITHUB_APP_ID` is unset.

## Notes, and disagreements with the canon

These are outside the issue's "What to build", or for the Owner to decide.

- **Qwen's own agent tool is Qwen Code**, which AI Office does not run
  (PRD FR-16 lists Claude Code, Codex and opencode). FR-35 says a
  subscription is used only through "the AI Provider's own agent tool";
  as for Grok, the Qwen sign-in serves only opencode, the agent tool AI
  Office runs for Qwen, and its terms warning says so. Adding Qwen Code as
  an agent tool would be a separate issue.
- **PRD FR-16's table** could list the four new AI Providers' agent tools.
- **"Ollama and Ollama Cloud"** are one AI Provider here, Ollama, with two
  kinds: their Models share names (`model:tag`), and the Owner's own
  server can run Ollama's cloud Models too.
- **Compatible endpoints are AI Providers.** An Agent must have an AI
  Provider to use one, so "Anthropic-compatible" and "OpenAI-compatible"
  are each one, for every endpoint of that format. GLOSSARY's AI Provider
  is "a family of AI models"; these are families by format, not by maker.
  The glossary could say so.
- **A compatible endpoint is sent any Model, Claude's included,** in
  priority order with that AI Provider's own accounts. If an endpoint at
  a better priority lacks the Model, its `404` is sent back, not retried
  elsewhere. Routing by each endpoint's own catalogue would be a
  follow-up.
- **Analytics by AI Provider** still groups by Model name, so a compatible
  endpoint's requests show under whoever's name the Model has, or
  "Other". Grouping by the account's AI Provider would be a follow-up.
- **Prompt-cache keep-alive** treats an Anthropic-compatible endpoint like
  any Anthropic-format account: kept warm while keep-alive is on. Whether
  an endpoint caches prompts at all is its own.
- **No prices.** None of the new kinds' Models is in the pricing table:
  Qwen's sign-in is free, the Owner's Ollama costs nothing per token,
  Ollama Cloud is paid by plan, and an endpoint's prices are its owner's.
  Their costs show as unknown; the Owner can set prices per Model.
- **Qwen's API key** (DashScope / Model Studio) is not an account kind
  here: the brief names Qwen (OAuth). It would be a small follow-up on the
  OpenAI-compatible kinds' pattern.
- **The proxy covers the AI Gateway's upstream traffic** (FR-35's
  context). AI Office's own GitHub requests, Skill imports and
  Connections are not sent through it.
- **`docker compose`** reaches Ollama on the host at
  `host.docker.internal`, which Linux Docker resolves only with an
  `extra_hosts: host-gateway` entry; whether the compose file should add
  one is for the Owner.
- **A forced-Model mismatch message** reads "… is a Ollama account": the
  existing message's "a" before the AI Provider.

## A mishap in this run, repaired

To compare with `fb93e41`, a scratch worktree was added, then removed with
`git worktree remove` followed by `git worktree prune`. Inside the
sandbox, the Sandcastle worktrees' host paths
(`/home/eyread01/projects/b/temp3/.sandcastle/worktrees/…`) do not
exist, so the prune deleted their registrations in
`/home/eyread01/projects/b/temp3/.git/worktrees/`: this run's
(`sandcastle-20261010-103722-3fc209`) and, it appears, that of another
run whose branch `sandcastle/20261010-112517-d0e14c` had been created at
11:25 with `git worktree add -b`. No branch, commit or working file was
touched: refs and objects live in the shared repository.

Both registrations were recreated by hand as `git worktree add` writes
them (`HEAD` naming the branch, `commondir`, `gitdir` with the host path
Sandcastle uses), each index read from its branch's tip. `git status` and
`git worktree list` work again here. **For the other run:** anything it
had staged but not committed is now unstaged; its working files are as
they were. Its `HEAD` reflog, and this run's, start afresh. The Owner
may want to check that run. Any `git worktree prune` run from inside a
sandbox would do the same, so none should be.

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
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`, without Docker:

```text
Test Files  273 passed (273)
Tests  3231 passed | 407 skipped (3638)
Start at  11:33:42
Duration  45.72s (tests 40%, import 36%, environment 13%, transform 8%, setup 2%)
exit 0
```

The contract tests and the proxy's, verbose:

```text
$ pnpm exec vitest run packages/gateway/src/providers/qwen.test.ts packages/gateway/src/providers/ollama.test.ts packages/gateway/src/providers/ollama-cloud.test.ts packages/gateway/src/providers/openai-compatible.test.ts packages/gateway/src/providers/anthropic-compatible.test.ts packages/gateway/src/upstream.test.ts --reporter=verbose
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > the Ollama fixtures > each have an expectation, and each expectation a fixture
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > the Ollama fixtures > each have an expectation, and each expectation a fixture
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > Qwen's sign-in > is Qwen Code's device login, proved with PKCE
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > Qwen's sign-in > adds an account once the Owner approves its code, reached where the login says
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > Qwen's sign-in > reads where each answer says its API is
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > the Anthropic-compatible fixtures > each have an expectation, and each expectation a fixture
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > the OpenAI-compatible fixtures > each have an expectation, and each expectation a fixture
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > the Ollama fixtures > chat-completions-model-not-found.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > Qwen's sign-in > refreshes its tokens ahead of expiry, following its API if it moves
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > the Qwen fixtures > each have an expectation, and each expectation a fixture
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > the Ollama fixtures > chat-completions-rate-limited.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > the Anthropic-compatible fixtures > messages-overloaded.json passes through unchanged to the endpoint's own path, with its usage recorded
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > the Anthropic-compatible fixtures > messages-rate-limited.json passes through unchanged to the endpoint's own path, with its usage recorded
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > the Ollama fixtures > chat-completions-runner-failed.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > the Ollama fixtures > chat-completions-streaming.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > the Ollama fixtures > chat-completions.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > Ollama AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > the Ollama fixtures > chat-completions-streaming.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > the Ollama fixtures > chat-completions-unavailable.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > the Ollama fixtures > chat-completions.json passes through unchanged to Ollama's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > Ollama AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > Ollama AI Accounts > serve only Ollama's Models, and no other AI Provider's
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > the Qwen fixtures > chat-completions-quota-exceeded.json passes through unchanged from opencode to Qwen's API, with its usage recorded
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > the Qwen fixtures > chat-completions-streaming.json passes through unchanged from opencode to Qwen's API, with its usage recorded
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > the Qwen fixtures > chat-completions.json passes through unchanged from opencode to Qwen's API, with its usage recorded
 ✓ |@ai-office/gateway| src/upstream.test.ts > the outbound proxy > carries every request through an AI Account, with the proxy's credentials and the account's key
 ✓ |@ai-office/gateway| src/upstream.test.ts > the outbound proxy > applies a change to the next request, without a restart
 ✓ |@ai-office/gateway| src/upstream.test.ts > the outbound proxy > reaches the AI Office host itself, and each host the Owner lists, directly
 ✓ |@ai-office/gateway| src/upstream.test.ts > the outbound proxy > carries model lists through it
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > the OpenAI-compatible fixtures > chat-completions-bad-gateway.json passes through unchanged to OpenAI-compatible's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > the OpenAI-compatible fixtures > chat-completions-rate-limited.json passes through unchanged to OpenAI-compatible's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > the OpenAI-compatible fixtures > chat-completions-streaming.json passes through unchanged to OpenAI-compatible's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > the OpenAI-compatible fixtures > chat-completions.json passes through unchanged to OpenAI-compatible's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > the Anthropic-compatible fixtures > messages-streaming.json passes through unchanged to the endpoint's own path, with its usage recorded
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > the Anthropic-compatible fixtures > messages.json passes through unchanged to the endpoint's own path, with its usage recorded
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > Anthropic-compatible endpoints > serve opencode too, translated from Chat Completions to Messages
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > Anthropic-compatible endpoints > are sent any Model, and those no AI Provider claims before any other account
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > Anthropic-compatible endpoints > count no tokens, which few such endpoints can
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > Qwen AI Accounts > serve opencode only: not Claude Code, nor any other tool
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > Qwen AI Accounts > fall back when the free quota runs out, holding the account back
 ✓ |@ai-office/gateway| src/providers/qwen.test.ts > Qwen AI Accounts > hold their tokens as secrets: never listed, and kept out of sandboxes
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > Ollama AI Accounts > count no tokens, and serve no Responses, which their API lacks
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > Ollama AI Accounts > fall back after Ollama's chat-completions-rate-limited.json, which holds the account back as rate_li…
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > Ollama AI Accounts > fall back after Ollama's chat-completions-unavailable.json, a failure, which holds nothing back
 ✓ |@ai-office/gateway| src/providers/ollama-cloud.test.ts > Ollama Cloud > Ollama AI Accounts > hold the key as a secret: never listed, and kept out of sandboxes
 ✓ |@ai-office/gateway| src/upstream.test.ts > the outbound proxy > carries sign-ins and token refreshes through it
 ✓ |@ai-office/gateway| src/upstream.test.ts > the outbound proxy > carries published prices through it
 ✓ |@ai-office/gateway| src/upstream.test.ts > the outbound proxy > uses a new connection once the proxy changes, letting the old one go
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > Ollama AI Accounts > serve only Ollama's Models, and no other AI Provider's
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > Ollama AI Accounts > count no tokens, and serve no Responses, which their API lacks
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > Ollama AI Accounts > fall back after Ollama's chat-completions-runner-failed.json, a failure, which holds nothing back
 ✓ |@ai-office/gateway| src/providers/ollama.test.ts > Ollama > Ollama AI Accounts > hold no credential, and keep nothing else out of sandboxes
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > Anthropic-compatible endpoints > fall back after messages-rate-limited.json, which holds the endpoint back as rate_limited
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > Anthropic-compatible endpoints > fall back after messages-overloaded.json, which holds the endpoint back as overloaded
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > Anthropic-compatible endpoints > hold the key as a secret: never listed, and kept out of sandboxes
 ✓ |@ai-office/gateway| src/providers/anthropic-compatible.test.ts > Anthropic-compatible endpoints > send an endpoint added without a key no credential at all
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > the OpenAI-compatible fixtures > responses.json passes through unchanged to OpenAI-compatible's API, with its usage and cost recorded
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > OpenAI-compatible AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > OpenAI-compatible AI Accounts > are sent any Model, and those no AI Provider claims before any other account
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > OpenAI-compatible AI Accounts > count no tokens, which their API cannot
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > OpenAI-compatible AI Accounts > fall back after OpenAI-compatible's chat-completions-rate-limited.json, which holds the account back as rate_li…
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > OpenAI-compatible AI Accounts > fall back after OpenAI-compatible's chat-completions-bad-gateway.json, a failure, which holds nothing back
 ✓ |@ai-office/gateway| src/providers/openai-compatible.test.ts > OpenAI-compatible endpoints > OpenAI-compatible AI Accounts > hold the key as a secret: never listed, and kept out of sandboxes
 Test Files  6 passed (6)
      Tests  63 passed (63)
```
