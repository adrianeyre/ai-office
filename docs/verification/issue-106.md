# Issue #106: OpenRouter, DeepSeek, Z.ai, Minimax and Kimi accounts — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `b202b5a`: every commit of the issue except this
document.

## What was built

- **Five AI Providers** (`packages/shared/src/agents.ts`; PRD FR-15):
  `aiProviders` gains **OpenRouter**, **DeepSeek**, **Z.ai**, **Minimax**
  and **Kimi**, after Claude, ChatGPT, Grok and Gemini. Each runs
  **opencode** in sandboxes (`aiProviderAgentTools`; FR-16), as Grok and
  Gemini do, and takes no effort level. Like ChatGPT, Grok and Gemini, none
  has a default Model until the Owner chooses one from the catalogue, so
  no Agent can use one before then. The Floor admin's Agent editor and AI
  Settings' **AI Providers** card list them (both read `aiProviders` or the
  API).
- **Five API-key AI Account kinds** (`aiAccountKinds` in
  `packages/shared/src/ai-accounts.ts`; FR-35). Each speaks OpenAI's
  formats to its own API, with the key as a bearer token, and takes an
  optional custom endpoint in place of the host:

  | Kind (label) | AI Provider | API | Serves |
  | --- | --- | --- | --- |
  | OpenRouter API key | OpenRouter | `https://openrouter.ai/api/v1` | Chat Completions, Responses, Messages (translated) |
  | DeepSeek API key | DeepSeek | `https://api.deepseek.com` (no `/v1`) | Chat Completions, Responses, Messages |
  | Z.ai API key | Z.ai | `https://api.z.ai/api/paas/v4` | Chat Completions, Messages |
  | MiniMax API key | Minimax | `https://api.minimax.io/v1` | Chat Completions, Responses, Messages |
  | Kimi API key (Moonshot AI) | Kimi | `https://api.moonshot.ai/v1` | Chat Completions, Responses, Messages |

  None is sent `count_tokens`, which none of their APIs has, and Z.ai is
  sent no Responses. `POST /api/ai-accounts` takes
  `"aiProvider":"OpenRouter" | "DeepSeek" | "Z.ai" | "Minimax" | "Kimi"`
  with `"accountType":"api_key"`. None has a subscription to sign in to.
  No database migration was needed: `ai_accounts.ai_provider` is free
  text, and the account type is `api_key`.
- **Routing by Model** (`aiProviderOfModel`; FR-38). `deepseek-*` goes to
  DeepSeek, `glm-*` to Z.ai, `MiniMax-*` to Minimax, and `kimi-*` and
  `moonshot-*` to Kimi. OpenRouter's `vendor/model` names
  (`anthropic/claude-sonnet-4.5`, `openrouter/auto`) go to OpenRouter,
  whatever the vendor; before this they were read as the vendor's
  (Claude's). The analytics' breakdown by AI Provider uses the same names.
  A Model's family (FR-38's capacity filter) is still the vendor Model's.
- **Each with its model catalogue** (FR-41,
  `packages/gateway/src/models/catalogue.ts`):
  - OpenRouter's (`/api/v1/models?limit=1000`), DeepSeek's (`/models`),
    Minimax's (`/v1/models`) and Kimi's (`/v1/models`) lists. A list's
    `name` is now read as the name to show (OpenRouter's, DeepSeek's).
    Context windows come from OpenRouter's and Kimi's `context_length` and
    DeepSeek's `context_window`; Minimax's list gives none.
  - **Z.ai**, whose API documents no models endpoint: its kind carries the
    Models Z.ai documents (`documentedModels`), with names and context
    windows. These are its catalogue, served without a request, while the
    Owner has an unpaused Z.ai account (`CatalogueSource.documentedModels`):
    GLM-5.3, 5.2, 5.3-FlashX, 5.3-Flash, 5.1, 5, 4.7 and 4.6.
  - `GET /api/ai-providers` lists each AI Provider's Models, and
    `PUT /api/ai-providers/:aiProvider` sets its default from them
    (`/api/ai-providers/Z.ai` included).
- **Each with its pricing** (FR-43):
  - `packages/gateway/pricing.json` gains the published prices of
    DeepSeek's, Z.ai's, Minimax's and Kimi's Models as of 2026-10-10 (18
    Models). Its `source` says where each came from and how they were
    flattened (see the notes below).
  - OpenRouter's prices come from its published Models list
    (`openRouterPrices`, from #49). That list is fetched once the Owner has
    an unpaused OpenRouter account, which can now be added.
- **What their answers say** (`packages/gateway/src/translate/`,
  `src/limits/detect.ts`):
  - **Cache writes.** The prompt tokens OpenRouter and Kimi report as
    written to the cache (`prompt_tokens_details.cache_write_tokens`) are
    now counted as cache writes, apart from the rest of the input.
    Previously every OpenAI-format answer counted none.
  - **Overload as a 429.** Kimi's `engine_overloaded_error` and Z.ai's
    business code `1305` now hold the account back as **overloaded**
    (until `retry-after`, else 30 s), not as rate-limited. DeepSeek's
    `503` "Server overloaded" already counted as overloaded.
  - **402.** A `402`, which OpenRouter and DeepSeek send when an account
    has no credit left, is now a **failure**. The request goes on to
    another account (and the failure counts towards the circuit breaker),
    where before it was sent back as the request's fault.
- **Guide:** an **OpenRouter, DeepSeek, Z.ai, MiniMax and Kimi accounts**
  section in [`docs/guide/ai-gateway.md`](../guide/ai-gateway.md), with
  updates to AI Accounts, Model prices, Rate limits and AI Providers. Each
  fixture set is described in `packages/gateway/fixtures/README.md`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below).
      - **Without Docker:** 3084 passed, 403 skipped (the Postgres tests,
        with the reason). Before this issue (`240ce2b`, per #105's
        verification) it was 2929 passed, 402 skipped. The one new skip is
        the Postgres run of the new AI Providers API case.
      - **Nothing skipped, deleted or weakened.** No test was skipped,
        deleted or weakened. These existing expectations changed with the
        API:
        - `apps/server/src/ai-providers/routes.test.ts` lists all nine AI
          Providers, not four (the test's name says "every AI Provider"
          for "the four AI Providers").
        - The Floor admin's Agent editor (`apps/web/src/floors.test.tsx`)
          offers the five new AI Providers, each "(no default Model yet)",
          disabled.
        - The API-key error for an AI Provider without keys is now "Only
          Claude, Grok, Gemini, OpenRouter, DeepSeek, Z.ai, Minimax and
          Kimi API keys can be added so far."
          (`apps/server/src/ai-accounts/routes.test.ts`).
        - The orchestrator's "an AI Provider without an agent tool" tests
          (`agent-tools.test.ts`, `runner.test.ts`) used DeepSeek as their
          example of one. DeepSeek now has opencode, so they use Mistral
          and check the same refusal.
      - **Every AI Provider in the orchestrator's table.** Its
        per-AI-Provider table now holds the five new ones. So each is
        checked to run opencode with only its Gateway Key, to refuse every
        credential shape (OpenRouter, DeepSeek or Kimi, and Z.ai keys added
        to the shapes), and to hold none of `OPENROUTER_API_KEY`,
        `DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`, `MINIMAX_API_KEY` or
        `MOONSHOT_API_KEY`.
      - **The pricing table's invariant held.** Its own test (cache writes
        cost at least the input price) caught MiniMax's listed $0.375 cache
        write on MiniMax-M2.7-highspeed, whose input costs $0.60. MiniMax
        charges cache writes apart only on its Anthropic-format API, so
        the table prices them as input; the invariant was kept.

      **Mutation checks** (each reverted; the five contract tests, the
      catalogue's and the AI Providers API's, 126 tests):

      | Mutation | Tests failed |
      | --- | --- |
      | A `402` refused again, not a failure | 4 |
      | `cache_write_tokens` not read | 3 |
      | OpenRouter's `vendor/model` read as the vendor's | 10 |
      | Kimi's `engine_overloaded_error` not read as an overload | 1 |
      | DeepSeek's API under `/v1` | 10 |
      | Z.ai's documented Models left out of its catalogue | 2 |
- [x] **Contract tests per type.** There is one file per type in
      `packages/gateway/src/providers/` (`openrouter.test.ts`,
      `deepseek.test.ts`, `zai.test.ts`, `minimax.test.ts`,
      `kimi.test.ts`; 59 tests). Each holds its type to the contract in
      `api-key-contract.ts`. Every fixture in `fixtures/<type>/` is
      replayed through a real Gateway, serving from a real API-key account
      of that type (added through `AiAccounts.add`, its key sealed), with
      the AI Provider's answer in 7-byte chunks. For each fixture:
      - the account receives the AI Provider's own path
        (`/api/v1/chat/completions`, `/chat/completions`,
        `/api/paas/v4/chat/completions`, `/v1/…`), the very body, and the
        key as a bearer token, never `x-api-key` or the Gateway Key;
      - the caller gets the answer byte for byte;
      - the record has the status, endpoint, streaming, Model, input,
        output, cache-read and cache-write tokens, and the **estimated cost
        at the type's prices**: the pricing table's for DeepSeek, Z.ai,
        Minimax and Kimi; for OpenRouter, its published prices read from
        its Models list fixture, with a Model it does not price at `null`;
      - recorder mode saves the path as sent, and never the key.

      A coverage test pairs every fixture with its expectation. Each type
      is also checked, through the Gateway, to:
      - serve Claude Code's Messages, translated to Chat Completions and
        back with its usage;
      - serve only its own Models, with a Claude account of better
        priority left alone, a Claude Model going to Claude and a Grok
        Model getting `503`. For OpenRouter, the Model asked for is
        `anthropic/claude-sonnet-4.5`;
      - send no `count_tokens` (and, for Z.ai, no Responses), answering
        `503`;
      - fall back to a second account after each documented failure,
        holding the first back as it says:

        | Type | Failures |
        | --- | --- |
        | OpenRouter | `429` 12 s (`retry-after`); `402`, a failure that holds nothing back |
        | DeepSeek | `429` 60 s; `503` overloaded 30 s; `402`, a failure |
        | Z.ai | `429` code 1302, rate-limited 60 s; `429` code 1305, overloaded 30 s |
        | Minimax | `429 rate_limit_error`, 60 s |
        | Kimi | `429 rate_limit_reached_error`, 20 s; `429 engine_overloaded_error`, overloaded 5 s |

      - never list the key, while `holdsCredential` finds it (so it is kept
        out of sandboxes) and it is told to the redactor once opened.

  Also covered:
  - each type's catalogue (`src/models/catalogue.test.ts`): the four
    lists from their fixtures (`fixtures/models/openrouter.json`,
    `deepseek.json`, `minimax.json`, `kimi.json`), at their paths with the
    account's key, and Z.ai's documented Models with no request at all,
    only while a Z.ai account is unpaused;
  - each AI Provider's Models and default Model through the API
    (`apps/server/src/ai-providers/routes.test.ts`): OpenRouter's
    `anthropic/claude-sonnet-4.5` listed as OpenRouter's, not Claude's;
  - each key added through `POST /api/ai-accounts`, and with a custom
    endpoint, never sent back or logged, and no subscription
    (`apps/server/src/ai-accounts/providers.test.ts`);
  - the answers' meanings (`src/limits/detect.test.ts`);
  - the table's new prices, and a price for every documented Z.ai Model
    (`src/pricing/pricing.test.ts`);
  - the kinds, routing by Model and the request schema
    (`packages/shared/src/ai-accounts.test.ts`);
  - each kind in AI Settings' **Add an AI Account** form, with its API as
    the placeholder and the key cleared once sent
    (`apps/web/src/ai-accounts-card.test.tsx`).

### Verified on the host

- [ ] **A real key of each type serves requests through the Gateway.** Not
      done here: there are no OpenRouter, DeepSeek, Z.ai, MiniMax or Kimi
      keys in the sandbox, and no AI Account of any kind. The issue lists
      no host check, but these are worth making before relying on them.

## Not verifiable in this sandbox

- **The AI Providers' real answers.** The fixtures were written by hand
  (#45 is open), from each AI Provider's documentation as of 2026-10-10:
  - openrouter.ai/docs;
  - api-docs.deepseek.com;
  - docs.z.ai;
  - platform.minimax.io/docs;
  - platform.kimi.ai/docs.

  While researching, each API was also sent one request with a deliberately
  invalid key, to see the shape of its `401`. No credential was used, and
  none of those answers is in a fixture. To check on the host:
  - **DeepSeek:** the body of its `429`, `503` and `402` (it documents the
    statuses, not the bodies; the fixtures use OpenAI's shape). A `503`
    whose message does not say "overloaded" would count as a failure, not
    an overload.
  - **MiniMax:** the HTTP status of its chat errors. It documents
    `base_resp` business codes (1002 rate limit, 1008 insufficient
    balance, …) and, elsewhere, `429 rate_limit_error`. If it answers
    `200` with an error in `base_resp`, the Gateway counts it as served.
  - **Kimi:** where a streamed answer's usage comes. The fixture puts it
    on a last chunk of its own, as OpenAI does with `include_usage`; if it
    comes inside the last choice, no usage is recorded.
  - **OpenRouter:** that `/api/v1/models` honours `limit=1000` (it pages
    500 by default and lists 458 Models today); and its errors after
    streaming starts, which come as `200` with `finish_reason: "error"`
    and count as served.
  - **Z.ai:** that it truly lists no Models (`/api/paas/v4/models` is
    undocumented), and its `1305` overload body.
- **opencode with these AI Providers.** opencode is not installed here.
  Its configuration for each is checked, not that it runs. OpenRouter's
  Models contain a slash (`ai-office/anthropic/claude-sonnet-4.5` as
  opencode's model): check that opencode splits only at the first.
- **The Postgres side.** Without Docker, the database tests are skipped
  with their reason. This issue adds no migration: the new kinds are
  `api_key` rows whose `ai_provider` is free text. CI, which runs
  Postgres, fails rather than skips them.
- The Playwright suite (`pnpm e2e`) was not run (no Docker). No e2e test
  names an AI Provider.

## Notes, and disagreements with the canon

These are outside the issue's "What to build", or for the Owner to decide.

- **PRD FR-16's table** lists an agent tool for Claude, ChatGPT, Grok and
  Gemini only. These five AI Providers run **opencode** here, which
  reaches any Model through the Gateway's OpenAI-compatible API; the table
  could say so.
- **"Minimax" or "MiniMax".** The AI Provider is named as the PRD writes
  it (`Minimax`); the account kind's label uses the company's own
  spelling (**MiniMax API key**).
- **Flattened prices.** The pricing table holds one price per Model, so:
  - DeepSeek's are its **peak-hour** prices; off-peak (most of the week)
    is half.
  - MiniMax-M3's are for prompts up to 512K tokens; longer ones cost
    twice as much. MiniMax shows M3's prices as "50% off" its list prices.
  - Kimi's kimi-k3 cache writes are at the five-minute rate; one-hour
    writes cost twice as much.
  - OpenRouter's conditional prices (`pricing.overrides`, such as
    DeepSeek's peak hours) are not read.

  Costs are estimates, for information only (FR-31). OpenRouter's answers
  also carry the actual `cost` they billed, which the Gateway does not
  use yet.
- **OpenRouter's prices arrive late.** Published prices are refreshed when
  the server starts and once a day, so after the first OpenRouter account
  is added its prices arrive within 24 hours. As for every kind, its
  catalogue arrives at the next daily refresh unless the Owner presses
  **Refresh the model catalogue**. Refreshing both when an account is
  added would be a small follow-up.
- **Any `vendor/model` name is OpenRouter's.** Later kinds that name
  Models with a slash (FR-35's "any OpenAI-compatible endpoint", such as
  Hugging Face-style names) will need the rule narrowed. Before this,
  such names were read as the vendor's.
- **A `402` is a failure for every AI Provider**, not just these two; none
  of the earlier ones is documented to send one.
- **Z.ai:**
  - Its documented Models live in the code, so a new GLM Model needs a
    pull request.
  - The GLM **Coding Plan** (`/api/coding/paas/v4`) is not supported: a
    custom endpoint replaces only the host, and the kind's path is added
    to it.
  - GLM-4.7's and GLM-4.6's context windows are not documented, so are
    null.
- **Minimax:**
  - Its Models list gives no context windows, so a Minimax Agent has no
    Context Usage (FR-84).
  - By default MiniMax's Models put their reasoning inside `<think>` tags
    in the answer's text.
- **Attribution headers.** OpenRouter's optional `HTTP-Referer` and
  `X-OpenRouter-Title` are not sent.
- **Anthropic-compatible endpoints.** DeepSeek, Z.ai, MiniMax, Kimi and
  OpenRouter also offer Anthropic-compatible Messages endpoints. These
  kinds use OpenAI's formats and translate Claude Code's Messages, as
  Gemini's does.
- Qwen, Ollama and Ollama Cloud are #107.

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
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`, without Docker:

```text
Test Files  264 passed (264)
Tests  3084 passed | 403 skipped (3487)
Start at  10:32:37
Duration  49.21s (tests 40%, import 37%, environment 13%, transform 9%, setup 2%)
exit 0
```

The contract tests, verbose:

```text
$ pnpm exec vitest run packages/gateway/src/providers/openrouter.test.ts packages/gateway/src/providers/deepseek.test.ts packages/gateway/src/providers/zai.test.ts packages/gateway/src/providers/minimax.test.ts packages/gateway/src/providers/kimi.test.ts --reporter=verbose
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > the DeepSeek fixtures > each have an expectation, and each expectation a fixture
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > the DeepSeek fixtures > chat-completions-insufficient-balance.json passes through unchanged to DeepSeek's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > the DeepSeek fixtures > chat-completions-overloaded.json passes through unchanged to DeepSeek's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > the DeepSeek fixtures > chat-completions-rate-limited.json passes through unchanged to DeepSeek's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > the DeepSeek fixtures > chat-completions-streaming.json passes through unchanged to DeepSeek's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > the DeepSeek fixtures > chat-completions.json passes through unchanged to DeepSeek's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > the DeepSeek fixtures > responses.json passes through unchanged to DeepSeek's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > DeepSeek AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > DeepSeek AI Accounts > serve only DeepSeek's Models, and no other AI Provider's
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > DeepSeek AI Accounts > count no tokens, which their API cannot
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > DeepSeek AI Accounts > fall back after DeepSeek's chat-completions-rate-limited.json, which holds the account back as rate_li…
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > DeepSeek AI Accounts > fall back after DeepSeek's chat-completions-overloaded.json, which holds the account back as overloa…
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > DeepSeek AI Accounts > fall back after DeepSeek's chat-completions-insufficient-balance.j…, a failure, which holds nothing back
✓ |@ai-office/gateway| src/providers/deepseek.test.ts > DeepSeek > DeepSeek AI Accounts > hold the key as a secret: never listed, and kept out of sandboxes
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > the Kimi fixtures > each have an expectation, and each expectation a fixture
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > the Kimi fixtures > chat-completions-overloaded.json passes through unchanged to Kimi's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > the Kimi fixtures > chat-completions-rate-limited.json passes through unchanged to Kimi's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > the Kimi fixtures > chat-completions-streaming.json passes through unchanged to Kimi's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > the Kimi fixtures > chat-completions.json passes through unchanged to Kimi's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > the Kimi fixtures > responses.json passes through unchanged to Kimi's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > Kimi AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > Kimi AI Accounts > serve only Kimi's Models, and no other AI Provider's
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > Kimi AI Accounts > count no tokens, which their API cannot
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > Kimi AI Accounts > fall back after Kimi's chat-completions-rate-limited.json, which holds the account back as rate_li…
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > Kimi AI Accounts > fall back after Kimi's chat-completions-overloaded.json, which holds the account back as overloa…
✓ |@ai-office/gateway| src/providers/kimi.test.ts > Kimi > Kimi AI Accounts > hold the key as a secret: never listed, and kept out of sandboxes
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > the Minimax fixtures > each have an expectation, and each expectation a fixture
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > the Minimax fixtures > chat-completions-rate-limited.json passes through unchanged to Minimax's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > the Minimax fixtures > chat-completions-streaming.json passes through unchanged to Minimax's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > the Minimax fixtures > chat-completions.json passes through unchanged to Minimax's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > the Minimax fixtures > responses.json passes through unchanged to Minimax's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > Minimax AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > Minimax AI Accounts > serve only Minimax's Models, and no other AI Provider's
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > Minimax AI Accounts > count no tokens, which their API cannot
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > Minimax AI Accounts > fall back after Minimax's chat-completions-rate-limited.json, which holds the account back as rate_li…
✓ |@ai-office/gateway| src/providers/minimax.test.ts > Minimax > Minimax AI Accounts > hold the key as a secret: never listed, and kept out of sandboxes
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > the OpenRouter fixtures > each have an expectation, and each expectation a fixture
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > the OpenRouter fixtures > chat-completions-no-credits.json passes through unchanged to OpenRouter's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > the OpenRouter fixtures > chat-completions-rate-limited.json passes through unchanged to OpenRouter's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > the OpenRouter fixtures > chat-completions-streaming.json passes through unchanged to OpenRouter's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > the OpenRouter fixtures > chat-completions.json passes through unchanged to OpenRouter's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > the OpenRouter fixtures > responses.json passes through unchanged to OpenRouter's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > OpenRouter AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > OpenRouter AI Accounts > serve only OpenRouter's Models, and no other AI Provider's
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > OpenRouter AI Accounts > count no tokens, which their API cannot
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > OpenRouter AI Accounts > fall back after OpenRouter's chat-completions-rate-limited.json, which holds the account back as rate_li…
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > OpenRouter AI Accounts > fall back after OpenRouter's chat-completions-no-credits.json, a failure, which holds nothing back
✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > OpenRouter AI Accounts > hold the key as a secret: never listed, and kept out of sandboxes
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > the Z.ai fixtures > each have an expectation, and each expectation a fixture
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > the Z.ai fixtures > chat-completions-overloaded.json passes through unchanged to Z.ai's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > the Z.ai fixtures > chat-completions-rate-limited.json passes through unchanged to Z.ai's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > the Z.ai fixtures > chat-completions-streaming.json passes through unchanged to Z.ai's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > the Z.ai fixtures > chat-completions.json passes through unchanged to Z.ai's API, with its usage and cost recorded
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > Z.ai AI Accounts > serve Claude Code too, translated from Messages to Chat Completions
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > Z.ai AI Accounts > serve only Z.ai's Models, and no other AI Provider's
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > Z.ai AI Accounts > count no tokens, and serve no Responses, which their API lacks
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > Z.ai AI Accounts > fall back after Z.ai's chat-completions-rate-limited.json, which holds the account back as rate_li…
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > Z.ai AI Accounts > fall back after Z.ai's chat-completions-overloaded.json, which holds the account back as overloa…
✓ |@ai-office/gateway| src/providers/zai.test.ts > Z.ai > Z.ai AI Accounts > hold the key as a secret: never listed, and kept out of sandboxes
Test Files  5 passed (5)
Tests  59 passed (59)
```

The catalogue, prices, answers and kinds (the files' other cases filtered
out by `-t`):

```text
$ pnpm exec vitest run packages/gateway/src/models/catalogue.test.ts packages/gateway/src/limits/detect.test.ts packages/gateway/src/pricing/pricing.test.ts packages/shared/src/ai-accounts.test.ts -t "OpenRouter|DeepSeek|Kimi|Z.ai|402" --reporter=verbose
✓ |@ai-office/shared| src/ai-accounts.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi API keys > are each an AI Provider's own API, in OpenAI's formats
✓ |@ai-office/shared| src/ai-accounts.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi API keys > serve Chat Completions and Messages, Responses where their API has it, and count no tokens
✓ |@ai-office/shared| src/ai-accounts.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi API keys > route each AI Provider's Models to it by name
✓ |@ai-office/shared| src/ai-accounts.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi API keys > route OpenRouter's vendor/model names to OpenRouter, whatever the vendor
✓ |@ai-office/shared| src/ai-accounts.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi API keys > are added with a key, like any other
✓ |@ai-office/gateway| src/limits/detect.test.ts > what an AI Provider's answer says about its account > failed, for an account out of credit (OpenRouter's and DeepSeek's 402)
✓ |@ai-office/gateway| src/limits/detect.test.ts > what an AI Provider's answer says about its account > Kimi, Z.ai and DeepSeek > are overloaded on Kimi's 429 engine_overloaded_error, until retry-after
✓ |@ai-office/gateway| src/limits/detect.test.ts > what an AI Provider's answer says about its account > Kimi, Z.ai and DeepSeek > are overloaded on Z.ai's 429 with business code 1305, rate-limited on its 1302
✓ |@ai-office/gateway| src/limits/detect.test.ts > what an AI Provider's answer says about its account > Kimi, Z.ai and DeepSeek > are overloaded on DeepSeek's 503 Server Overloaded
✓ |@ai-office/gateway| src/limits/detect.test.ts > what an AI Provider's answer says about its account > Kimi, Z.ai and DeepSeek > are rate-limited on Kimi's 429 rate_limit_reached_error
✓ |@ai-office/gateway| src/pricing/pricing.test.ts > the pricing table > prices DeepSeek's, Z.ai's, Minimax's and Kimi's Models, and every one Z.ai documents
✓ |@ai-office/gateway| src/pricing/pricing.test.ts > OpenRouter's published prices > reads its Models list, per token, as prices per million tokens
✓ |@ai-office/gateway| src/pricing/pricing.test.ts > OpenRouter's published prices > fails when the list cannot be had
✓ |@ai-office/gateway| src/models/catalogue.test.ts > the model catalogue of OpenRouter, DeepSeek, Z.ai, Minimax and Kimi > refreshes each from its AI Provider's list, and Z.ai's from its documented Models
✓ |@ai-office/gateway| src/models/catalogue.test.ts > the model catalogue of OpenRouter, DeepSeek, Z.ai, Minimax and Kimi > lists Z.ai's documented Models only while it has an unpaused account
Test Files  4 passed (4)
Tests  15 passed | 56 skipped (71)
```

The API, the web app and the agent tools (filtered by `-t`; the agent tool's
checks shown for Kimi, one of nine AI Providers it runs them for):

```text
$ pnpm exec vitest run apps/server/src/ai-accounts/providers.test.ts apps/web/src/ai-accounts-card.test.tsx -t "OpenRouter|DeepSeek|Z.ai|MiniMax|Kimi" --reporter=verbose
✓ |@ai-office/server| src/ai-accounts/providers.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi AI Accounts through the API > adds OpenRouter's API key, which is never sent back or logged
✓ |@ai-office/server| src/ai-accounts/providers.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi AI Accounts through the API > adds DeepSeek's API key, which is never sent back or logged
✓ |@ai-office/server| src/ai-accounts/providers.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi AI Accounts through the API > adds Z.ai's API key, which is never sent back or logged
✓ |@ai-office/server| src/ai-accounts/providers.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi AI Accounts through the API > adds Minimax's API key, which is never sent back or logged
✓ |@ai-office/server| src/ai-accounts/providers.test.ts > OpenRouter, DeepSeek, Z.ai, Minimax and Kimi AI Accounts through the API > adds Kimi's API key, which is never sent back or logged
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds the kind “OpenRouter API key”
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds the kind “DeepSeek API key”
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds the kind “Z.ai API key”
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds the kind “MiniMax API key”
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds the kind “Kimi API key (Moonshot AI)”
Test Files  2 passed (2)
Tests  10 passed | 29 skipped (39)
$ pnpm exec vitest run apps/server/src/ai-providers/routes.test.ts apps/web/src/floors.test.tsx packages/orchestrator/src/sandbox/agent-tools.test.ts packages/orchestrator/src/sandbox/runner.test.ts -t "every AI Provider|sets each a default|AI Provider, Model, effort|every other|without an agent tool|Kimi's tool|Kimi's environment" --reporter=verbose
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > is Claude Code for Claude, Codex for ChatGPT, opencode for every other
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > gives Kimi's tool an environment with no key for an AI Account's credential
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never an Anthropic API key
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never an Anthropic subscription token
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never an OpenAI key
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never an xAI key
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never a Google API key
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never a Google OAuth token
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never a ChatGPT OAuth token (a JWT)
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never an OpenRouter key
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never a DeepSeek or Kimi key
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > takes only a Gateway Key for Kimi's tool, never a Z.ai key
✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > refuses Kimi's environment when a credential is slipped into it
✓ |@ai-office/orchestrator| src/sandbox/runner.test.ts > the sandbox runner > fails, starting no sandbox, for an AI Provider without an agent tool
✓ |@ai-office/server| src/ai-providers/routes.test.ts > AI Providers through the API, kept in memory > lists every AI Provider, with Claude's default Model and an empty catalogue
✓ |@ai-office/server| src/ai-providers/routes.test.ts > AI Providers through the API, kept in memory > lists OpenRouter's, DeepSeek's, Z.ai's, Minimax's and Kimi's Models, and sets each a default from them
✓ |@ai-office/web| src/floors.test.tsx > the Floor admin page > edits an Agent's AI Provider, Model, effort, instructions and status
Test Files  4 passed (4)
Tests  17 passed | 157 skipped (174)
```
