# Issue #46: Model catalogue and AI Providers admin — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`5a9b311`).

## What was built

### The model catalogue (`packages/gateway/src/models/`, FR-41)

- **Per kind of AI Account.** The catalogue holds each kind's Models (an AI
  Provider and an account type), as its AI Provider's models endpoint lists
  them.
- **Which account asks.** `AiAccounts.catalogueSources()` gives one opened
  account of each kind: the first unpaused one in the Owner's order. A
  subscription is used only while its token is valid. Each asks with its
  own credential, as it would serve:
  - an API key as `x-api-key` (Anthropic) or a bearer token;
  - a subscription's token with its `anthropic-beta` flag, or its ChatGPT
    account.
- **Each AI Provider's shape.** `fetchModels` and `modelsInList` read:
  - Anthropic's `/v1/models`, a page at a time (`limit`, `after_id`,
    `has_more`, up to 20 pages);
  - xAI's and Google's OpenAI-compatible `/models` (`data[].id`, Google's
    ids without `models/`);
  - ChatGPT's Codex backend
    (`/backend-api/codex/models?client_version=…`, `models[].slug`, with
    `context_window`). This uses a new optional `modelsPath` on account
    kinds.

  Display names and context windows are kept when the list gives them.
  Anything that is not a Model name is skipped.
- **Refresh.** `createModelCatalogue().refresh()` replaces each kind's
  list.
  - A kind that fails (unreachable, non-2xx, unreadable, empty) keeps its
    last list. The report says why, never with the answer's body or a
    credential.
  - One refresh runs at a time.
- **Storage.** The catalogue is kept in the new `model_catalogue` table
  (migration `0023_model_catalogue`).
- **When.** The server refreshes it when it starts, once a day (beside
  published prices), and on demand.

### AI Providers and their default Models (FR-15)

- **Storage.** `ai_provider_settings` (same migration) keeps the Owner's
  default Model per AI Provider.
- **Setting one.** `createAiProviders` (orchestrator) does it.
  - The Model must be in that AI Provider's catalogue, otherwise
    `model_not_in_catalogue`. An unknown AI Provider is
    `ai_provider_not_found`.
  - Each change is a `config.changed` event naming the setting
    (`aiProviders.Grok.defaultModel`), never the Model.
- **Until the Owner chooses.** Claude's default is `claude-opus-5-5`, so a
  new Floor's Claude team works from the start. ChatGPT, Grok and Gemini
  have none.
- **A default Model is required before an Agent can use an AI Provider.**
  `Agents.add` refuses an Agent on an AI Provider with no default Model
  (`model_required`). This holds even when the Agent names a Model of its
  own.
- **The Owner's defaults are what Agents use.** `modelOf` takes the
  defaults, and they reach:
  - the Agents API;
  - `agent.created` events, for new Floors' teams too;
  - the coder flow's `Agent:` commit trailer.
- **The catalogue an AI Provider chooses from** (`catalogueModelsOf`) is
  the Models its kinds of AI Account list, less any the Gateway would route
  to another AI Provider by name.

### API

- `GET /api/ai-providers` lists Claude, ChatGPT, Grok and Gemini, each
  with:
  - its agent tool;
  - its default Model (or null);
  - its catalogue Models (name, display name, context window, account
    types);
  - when they were fetched.
- `PUT /api/ai-providers/:aiProvider` with `{"defaultModel"}` answers
  `204`, `400` (`model_not_in_catalogue`, or a bad body) or `404`.
- `POST /api/model-catalogue/refresh` answers `{"refreshed","failed"}` by
  kind.

All three need a signed-in session (`access: "owner"`, checked by the
route-access test).

### Web

Admin's new **AI Providers** card, above **AI Accounts**:
- one form per AI Provider: its agent tool, how many Models were fetched
  and when, and a **Default Model** select of its catalogue Models, with
  context windows;
- a current default that the catalogue does not list is shown as "(not in
  the catalogue)";
- an AI Provider with no default says no Agent can use it until one is
  chosen. With no Models either, it says to add an AI Account and refresh;
- **Refresh the model catalogue** reports what each kind listed, or why it
  kept its last list.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 1115 passed, 203 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1303 passed, 15
      skipped.
- [x] **Test: catalogue refresh from fixtures.**

  Five hand-written model-list fixtures are in `fixtures/models/`:
  - Anthropic's two pages;
  - xAI's list;
  - Google's list;
  - ChatGPT's Codex backend's list.

  **Gateway** (`src/models/catalogue.test.ts`). Fake AI Providers serve
  the fixtures to five real AI Accounts: an Anthropic key, a Claude
  subscription and a ChatGPT subscription (both signed in through the fake
  OAuth servers), an xAI key and a Gemini key.
  - **One refresh** fills every kind, with the right Models, display names
    and context windows:
    - both of Anthropic's pages, in order;
    - Google's ids without `models/`;
    - `gpt-5-codex` with 272,000 tokens.

    Each list was asked for at the fixture's path. Each used its account's
    own credential:
    - `x-api-key` with `anthropic-version`;
    - a bearer token with `oauth-2025-04-20` for the Claude subscription;
    - bearer tokens for the others;
    - `chatgpt-account-id` for ChatGPT.
  - **Failures.** A `503` and a `401` keep those kinds' last lists. The
    report names the status, not the body, which held a key.
  - **Who is not asked.** Neither a paused account nor an expired
    subscription is asked.
  - **One at a time.** Two refreshes at once share one run.
  - **Shapes.** `modelsInList` reads each shape, skips non-Models and
    refuses non-lists.
  - **Postgres 18.** The store replaces one kind and keeps the others.

  **Server** (`apps/server/src/ai-providers/routes.test.ts`, each case in
  memory and in Postgres 18):
  - Before a refresh: four AI Providers, Claude's default only, empty
    catalogues.
  - `POST /api/model-catalogue/refresh` from Anthropic's and xAI's
    fixtures reports 4 and 3 Models, then lists them under Claude and
    Grok.
  - No key appears in the log.

  **Real server.** A smoke run of `apps/server/src/main.ts` against an
  embedded Postgres 18 (migrations applied with `pnpm db:migrate`'s script)
  and a fake xAI serving `xai.json`. Through the real API with `curl`:
  - setup and sign-in;
  - `GET /api/ai-providers`, with empty catalogues;
  - `PUT …/Grok` with `grok-4`: `400 model_not_in_catalogue`;
  - an xAI key added at the fake (`201`);
  - a refresh, with `{"refreshed":[{"aiProvider":"Grok","accountType":
    "api_key","models":3}],"failed":[]}`;
  - `PUT …/Grok` with `grok-4`: `204`, and Grok then listed with its
    default and three Models;
  - signed out, `401`;
  - the key nowhere in the server's log.
- [x] **Test: a default Model is required before an Agent can use an AI
      Provider.**

  **Orchestrator** (`src/agents/agents.test.ts`, in memory and in Postgres
  18):
  - A Grok reviewer is refused with `model_required`, and so are a Grok
    reviewer with `grok-4` of its own and a ChatGPT coder with
    `gpt-5-codex`. The message says to choose a default in the office
    admin's AI Providers. The Floor still has 4 Agents.
  - Once Grok's default is set to `grok-4`, a Grok reviewer is added, and
    its `agent.created` names `grok-4`.
  - With Claude's default set to `claude-sonnet-5-5`, a new Floor's four
    Agents and a later coder all use it. The Gemini docs Agent in the
    existing case is added once Gemini has a default.

  `src/ai-providers/ai-providers.test.ts` (in memory and in Postgres 18):
  - the initial defaults;
  - setting defaults, with their `config.changed` events;
  - a Model another AI Provider's catalogue lists, one listed nowhere, and
    an unknown AI Provider are each refused, with no event. Once the
    catalogue lists the Model, it is taken.

  **Server.** Through the API:
  - Grok's default is refused until the catalogue lists it, then set
    (`204`);
  - another AI Provider's Model (`400`), an unknown AI Provider (`404`) and
    three malformed bodies (`400`) are refused;
  - with Claude's default set to `claude-sonnet-5-5` through the API, a new
    Floor's Agents are listed with it.

  **Web** (`apps/web/src/ai-providers-card.test.tsx`):
  - The four AI Providers with their agent tools.
  - Claude's default is shown as "(not in the catalogue)" before a
    refresh.
  - ChatGPT's "No default Model: no Agent can use ChatGPT until you choose
    one", with no select until it has Models.
  - Refreshing reports each kind, including one that kept its last list.
  - Choosing ChatGPT's `gpt-5-codex` (offered with its context window), and
    then Claude's `claude-sonnet-5-5`, sends the right `PUT`s with the CSRF
    token. The warning goes away.

  **Mutation checks** (each reverted):

  | Mutation | Tests failed |
  | --- | --- |
  | An Agent's own Model gets round a missing default | 1 |
  | A default Model not checked against the catalogue | 1 (orchestrator), 1 (server) |
  | Google's `models/` prefix kept | 2 |
  | Only the first page of Anthropic's list read | 2 (gateway), 1 (server) |

### Not verifiable in this sandbox

- **Recorded provider responses.** The model lists were written by hand
  from the documented formats, as #45 is open. The least certain is
  ChatGPT's Codex backend: its `/models` path, the `client_version` it
  needs (`0.47.0` is sent), and its `models[].slug` shape. They are what
  Codex is reported to use. Real lists from each AI Provider should be
  checked on the host.
- **Real AI Accounts.** No real Anthropic, xAI, Google or ChatGPT account
  was asked for its Models. A refresh against each is for the host.
- **The daily schedule** is a 24-hour `setInterval` beside the price
  refresh. The smoke run showed the refresh at start (it finds no account
  then). The once-a-day timer itself was not waited for.
- The Playwright suite (`pnpm e2e`) was not run (no Docker). The new card
  is covered by the Vitest/Testing Library test above. It was not
  rendered in a browser.
- The Postgres 18 run used an embedded Postgres 18.3, as for earlier
  issues: `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp`. A
  scratch, uncommitted change pointed `postgresTest` at it, giving each
  test file its own template database.

## Notes, and disagreements with the canon

- **"A default Model is required before an Agent can use an AI
  Provider"** is read strictly. An Agent with a Model of its own is
  refused too, until its AI Provider has a default. Before this issue,
  such an Agent was let through. The existing test for it was changed to
  the stricter rule, and the Gemini Agent in another case now gets a
  Gemini default first. FR-11's "Model (defaults to the AI Provider's
  default)" and scenario 7 (pick Gemini, override the Model) both assume
  the AI Provider has a default.
- **Claude starts with `claude-opus-5-5`** rather than nothing. FR-10 gives
  every new Floor Claude Agents. Without a Claude default, no Floor could
  be added until the Owner had added a Claude account and refreshed the
  catalogue. The Owner can change it once the catalogue lists Claude's
  Models. Until then it is shown as "(not in the catalogue)".
- **No Agent API to add or edit Agents yet** (that is #47). The rule is
  enforced in the orchestrator's `Agents.add`, which #47's routes will use.
  Through the API it is seen in the Agents' Models.
- **Model mappings and aliases** (#103) are out of scope. The catalogue
  lists Models as each AI Provider names them.
- **Context windows** are stored when an AI Provider says, for FR-84's
  Context Usage later. Anthropic's list does not give them.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  111 passed (111)
      Tests  1115 passed | 203 skipped (1318)
   Duration  23.04s (import 41%, tests 39%, transform 11%, environment 8%, setup 1%)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  111 passed (111)
      Tests  1303 passed | 15 skipped (1318)
   Duration  49.00s (tests 87%, import 9%, environment 2%, transform 1%)
```

Smoke run of the real server (embedded Postgres 18, fake xAI), through
`curl`:

```text
setup 204
login 200
{"error":"model_not_in_catalogue","message":"Grok's model catalogue has no \"grok-4\": refresh the catalogue, or add an AI Account that lists it."}
add account 201
--- refresh:
{"refreshed":[{"aiProvider":"Grok","accountType":"api_key","models":3}],"failed":[]}
set Grok default 204
--- after (Grok):
{"aiProvider":"Grok","agentTool":"opencode","defaultModel":"grok-4","models":[{"model":"grok-4",…},{"model":"grok-4-fast-reasoning",…},{"model":"grok-code-fast-1",…}],"catalogueFetchedAt":"2026-10-09T09:39:58.118Z"}
signed out 401
```
