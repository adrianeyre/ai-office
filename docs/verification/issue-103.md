# Issue #103: Model mappings, forced Models and extra usage — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `3e6db48`: every commit of the issue except this
document.

## What was built

- **Model mappings and aliases** (PRD FR-41): a name callers ask for, sent to
  the AI Provider as another Model.
  - **Schemas** (`packages/shared/src/model-mappings.ts`):
    `modelMappingRequestSchema` (`{"from","to","aiProvider","accountType"}`),
    `modelMappingSchema`, `modelMappingListSchema` and
    `modelMappingErrorCodes`. With `aiProvider` and `accountType` both null
    a mapping is an **alias**, for every AI Account. With both set, it
    applies to one **kind of AI Account** (an AI Provider and an account
    type, as `aiAccountKinds` lists them), and its Model must be that AI
    Provider's (or of none the Gateway knows). Half a kind, a kind that does
    not exist, a mapping to itself and a name with spaces are refused.
  - **Precedence** (`modelSentTo`, `mappedModel` and `aliasedModel` in the
    same file). An AI Account is sent, most specific first:
    1. its forced Model;
    2. the Model of the Combo slot serving the request (FR-40);
    3. its kind's mapping of the name as asked;
    4. its kind's mapping of the alias's Model;
    5. the alias's Model;
    6. the Model asked for.

    Each step is taken once: aliases and mappings never chain.
  - **Storage:** the `gateway_model_mappings` table, unique on (kind, name
    asked for), in migration `0054_gateway_model_mappings`.
  - **The mappings** (`packages/gateway/src/models/mappings.ts`): add, list,
    change and delete, each a `config.changed` event naming what changed
    (`modelMappings.added`, `.changed`, `.deleted`), never the Models. At
    most 200. A name already mapped for that kind (or as an alias) is
    refused. They are read once and kept in memory, since every request
    asks; only this module changes them.
- **Forced Models:** `ai_accounts.forced_model`, set with `PATCH
  /api/ai-accounts/:id` `{"forcedModel"}` (null for none). It must be the
  account's own AI Provider's (`forced_model_mismatch`), or of none the
  Gateway knows (a custom endpoint's).
- **Routing** (`AiAccounts.select` in
  `packages/gateway/src/accounts/accounts.ts`, and `packages/gateway/src/gateway.ts`):
  - An alias is resolved first, so the request is routed as its Model: to
    that AI Provider's accounts, through that family's Combo.
  - Whether an account can serve is judged by the Model it would be sent
    (before its forced Model). So a kind's mapping of another AI Provider's
    name lets that kind serve it.
  - The model-capacity check goes by the family of the Model each account
    would be sent, its forced Model included.
  - The chosen account carries the Model it is sent (`ChosenAccount.model`),
    which replaces the body's `model`. A forced account (`x-ai-office-account`)
    is sent its own forced or mapped Model too.
  - The request history records the Model that served.
- **Extra usage**, for the kinds whose AI Provider offers it. That is only
  the Claude subscription (`extraUsage: true` in `aiAccountKinds`;
  `offersExtraUsage`).
  - **The toggle:** `ai_accounts.extra_usage`, off by default, set with
    `PATCH /api/ai-accounts/:id` `{"extraUsage"}`. Any other kind is refused
    with `extra_usage_not_offered`. The API sends `extraUsage: null` where
    it is not offered.
  - **While it is off,** an account is held back with the new limit reason
    `extra_usage` ("At its plan's limit (extra usage off)") until its plan's
    limit resets. Two things trigger this:
    - a usage window at 100% (`limitOf`);
    - a served answer that says it was served on extra usage
      (`anthropic-ratelimit-unified-status: rejected` with
      `-overage-status: allowed` or `allowed_warning`), held until
      `anthropic-ratelimit-unified-reset`, or an hour when it does not say
      (`extraUsageUntil` in `packages/gateway/src/limits/detect.ts`).

    It is a capacity exclusion: a `429` when nothing else can serve.
  - **Turning it on** lifts a stored `extra_usage` limit at once.
  - The `ai_accounts_limit_reason` check now allows `extra_usage`. A new
    check allows `extra_usage = true` only on Claude subscriptions.
- **API:**
  - `apps/server/src/model-mappings/routes.ts`: `GET` and
    `POST /api/gateway/model-mappings`, and `PUT` and
    `DELETE /api/gateway/model-mappings/:id`, all `owner` access. A taken
    name or too many mappings is a `409`, an unknown mapping a `404`, and
    an invalid body a `400`.
  - The AI Accounts API sends `forcedModel` and `extraUsage`, and maps
    the two new error codes to `400`.
- **Web:**
  - A **Model mappings** card on AI Settings, after Combos
    (`apps/web/src/model-mappings-card.tsx`). It lists each mapping as
    `from → to` with what it applies to, and offers **Edit** and
    **Delete** (after asking). Its form has "Asked for", "Sent as" (with
    the catalogue's Models offered) and "Applies to" (every AI Account, or
    one kind).
  - In the AI Accounts card, each account's **Edit** form has **Forced
    Model**. A Claude subscription's form also has **Extra usage**. Each
    row says "Always sent …" and "Extra usage on/off".
- **Guide:** "Model mappings, aliases and forced Models" and "Extra usage"
  sections in `docs/guide/ai-gateway.md`. A fixture
  (`limits/anthropic-extra-usage.json`) is described in the fixtures'
  README.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres cases are skipped with
      the reason, as before.
- [x] **Unit tests for mapping precedence.**
  - **Pure precedence** (`packages/shared/src/model-mappings.test.ts`, 8
    cases on `modelSentTo`, `mappedModel` and `aliasedModel`):
    - the Model asked for when nothing applies;
    - an alias for every kind;
    - a kind's own mapping of the name as asked, before the alias;
    - then the kind's mapping of the alias's Model;
    - a kind's mapping only for that kind;
    - one step each, never a chain (`a→b→c` gives `b`; `a→b`, kind
      `b→d→e` gives `d`);
    - a Combo slot's Model before any mapping;
    - the forced Model before everything, even a slot's, and even when the
      request names no Model.
  - **The same precedence through a real Gateway**
    (`packages/gateway/src/models/routing.test.ts`, real AI Accounts and
    fake AI Providers). With alias `opus → claude-opus-5-5`, the Claude
    API keys' mapping `claude-opus-5-5 → claude-sonnet-5-5` and a forced
    `claude-haiku-5-5`, the AI Provider receives in turn:
    - `claude-haiku-5-5` (forced);
    - `claude-sonnet-5-5` once the forced Model is removed;
    - `claude-opus-5-5` once the mapping is deleted;
    - an unmapped Model as asked.

    Each request is recorded with that Model. Also through the Gateway:
    - a kind's own mapping of `opus` beats the alias, and a subscriptions'
      mapping does not touch an API key;
    - the forced Model beats a Combo slot's, which beats a mapping;
    - an alias for `grok-4` is routed to the Grok account, past a Claude
      account of higher priority, and translated back;
    - a Claude API keys' mapping of `gpt-5-codex` lets a Claude account
      serve it (a `503` before);
    - capacity goes by the family sent: an account out of Opus serves Opus
      requests once forced to Sonnet;
    - an account forced by the Owner's header gets its forced Model.
  - **Mutation checks** (each reverted):

    | Mutation | Tests failed |
    | --- | --- |
    | The Combo slot's Model before the forced Model | 1 (shared), 1 (gateway) |
    | The alias before the kind's own mapping | 1 (shared) |
    | No kind's mapping of the alias's Model | 2 (shared), 1 (gateway) |
    | Accounts judged by the Model asked for, not the one sent | 2 (gateway) |
    | A served-on-extra-usage answer ignored | 1 (gateway) |
    | A full window does not hold back | 3 (gateway) |

- Also covered:
  - **The mappings module** (`packages/gateway/src/models/mappings.test.ts`,
    in memory; its Postgres cases skip here):
    - add, change and delete, with their events and no Model in them;
    - order: aliases first, then by kind and name;
    - one per kind, plus one alias;
    - at most 200.
  - **Extra usage** (`packages/gateway/src/limits/extra-usage.test.ts`):
    - the detection, with an hour when no reset is given;
    - off by default: served on extra usage, the account is held until
      14:00, the event says so, and the next request goes to the other
      subscription;
    - a full window holds it back before any extra usage is spent;
    - turned on, it serves at once and is not held back again, then off
      again it is;
    - refused for an API key;
    - a `429` with the reset when every account is held back;
    - through a real Gateway: the request served on extra usage gets its
      `200`, and the next goes to the other subscription.
  - **The API** (`apps/server/src/model-mappings/routes.test.ts`):
    - add, change and delete, each applying to the AI Accounts at once,
      with a forced Model on top;
    - the `400`s, `404`s and `409`;
    - `forced_model_mismatch` and `extra_usage_not_offered`, with their
      messages.

    The route-access test passes with the new routes declared `owner`. The
    AI Accounts API's full-body tests now expect `forcedModel: null`, and
    `extraUsage: null` (API key) or `false` (a new subscription).
  - **Web:**
    - `apps/web/src/model-mappings-card.test.tsx` adds an alias and a
      subscriptions' mapping (exact bodies), edits one into another kind
      (a `PUT`), deletes one after asking, and shows refusals from the
      form and from the API.
    - `apps/web/src/ai-accounts-card.test.tsx` forces a Model and turns
      a subscription's extra usage on (exact `PATCH`), then empties the
      forced Model (`null`). An API key has no extra usage checkbox. A
      refused forced Model is shown.

### Real output

`pnpm lint` (at `3e6db48`):

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck`:

```text
$ tsc && pnpm --recursive typecheck
…
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test` (load average about 29 at the start):

```text
 Test Files  248 passed (248)
      Tests  2823 passed | 397 skipped (3220)
exit 0
```

Before this issue: 242 files, 2783 passed and 385 skipped. The 12 new
skips are the Postgres cases of the new tests.

The issue's tests (`--reporter=verbose`; Postgres cases skipped, see below):

```text
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > is the Model asked for, when nothing maps or forces it
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > is an alias's Model, for every kind of AI Account
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > is the account's kind's mapping before the alias, for the name as asked
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > then the kind's mapping of the alias's Model
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > applies a kind's mapping only to accounts of that kind
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > follows one alias and one kind's mapping, never a chain
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > is a Combo slot's Model before any mapping
 ✓ |@ai-office/shared| src/model-mappings.test.ts > the Model an AI Account is sent > is the account's forced Model before everything else
 ✓ |@ai-office/shared| src/model-mappings.test.ts > a model mapping > is an alias with no kind of AI Account, or for one kind
 ✓ |@ai-office/shared| src/model-mappings.test.ts > a model mapping > refuses half a kind, a kind that does not exist, and itself
 ✓ |@ai-office/shared| src/model-mappings.test.ts > a model mapping > maps a kind's requests only to its own AI Provider's Models
 ✓ |@ai-office/shared| src/model-mappings.test.ts > an AI Account's forced Model and extra usage > are offered where the AI Provider offers extra usage: a Claude subscription
 ✓ |@ai-office/shared| src/model-mappings.test.ts > an AI Account's forced Model and extra usage > are changed like any other setting, and null forces nothing
 ✓ |@ai-office/gateway| src/models/mappings.test.ts > model mappings, kept in memory > adds, changes and deletes a mapping, telling which changed, never to what
 ✓ |@ai-office/gateway| src/models/mappings.test.ts > model mappings, kept in memory > lists aliases first, then by kind and the name asked for
 ✓ |@ai-office/gateway| src/models/mappings.test.ts > model mappings, kept in memory > maps a name once per kind of AI Account, and once as an alias
 ✓ |@ai-office/gateway| src/models/mappings.test.ts > model mappings, kept in memory > keeps at most the most mappings there may be
 ✓ |@ai-office/gateway| src/limits/extra-usage.test.ts > an answer served on extra usage > says so, until its plan's limit resets
 ✓ |@ai-office/gateway| src/limits/extra-usage.test.ts > extra usage, kept in memory > is off by default: served on extra usage, an account serves nothing more until its plan's limit resets
 ✓ |@ai-office/gateway| src/limits/extra-usage.test.ts > extra usage, kept in memory > holds back an account whose window is full before any extra usage is spent
 ✓ |@ai-office/gateway| src/limits/extra-usage.test.ts > extra usage, kept in memory > turned on, lets an account go on serving past its plan's limits, at once
 ✓ |@ai-office/gateway| src/limits/extra-usage.test.ts > extra usage, kept in memory > is offered only where the AI Provider offers it
 ✓ |@ai-office/gateway| src/limits/extra-usage.test.ts > extra usage, kept in memory > answers 429 once every account is at its plan's limit with extra usage off
 ✓ |@ai-office/gateway| src/limits/extra-usage.test.ts > extra usage, through the Gateway > serves the request on extra usage, then sends the next to another subscription
 ✓ |@ai-office/gateway| src/models/routing.test.ts > the Model an AI Account is sent, in order of precedence > is the forced Model, then the kind's mapping, then the alias, then the Model asked for
 ✓ |@ai-office/gateway| src/models/routing.test.ts > the Model an AI Account is sent, in order of precedence > is a kind's own mapping of the name asked for, before the alias's
 ✓ |@ai-office/gateway| src/models/routing.test.ts > the Model an AI Account is sent, in order of precedence > is the forced Model before a Combo slot's, which comes before a mapping
 ✓ |@ai-office/gateway| src/models/routing.test.ts > routing by the Model sent > routes an alias as the Model it stands for, to that AI Provider's accounts
 ✓ |@ai-office/gateway| src/models/routing.test.ts > routing by the Model sent > lets a kind's mapping serve a Model of another AI Provider
 ✓ |@ai-office/gateway| src/models/routing.test.ts > routing by the Model sent > judges an account's capacity by the family of the Model it is sent
 ✓ |@ai-office/gateway| src/models/routing.test.ts > routing by the Model sent > sends an account the Owner forces with a header its own forced Model
 ✓ |@ai-office/gateway| src/models/routing.test.ts > an AI Account's forced Model > is one of its own AI Provider's, and is told as a change
 ✓ |@ai-office/server| src/auth/route-access.test.ts > every route > requires a session or is an explicit exemption
 ✓ |@ai-office/server| src/auth/route-access.test.ts > every route > that requires a session answers 401 without one
 ✓ |@ai-office/server| src/model-mappings/routes.test.ts > the model mappings API, kept in memory > adds a mapping, changes it and deletes it, each applying at once
 ✓ |@ai-office/server| src/model-mappings/routes.test.ts > the model mappings API, kept in memory > refuses a mapping that does not make sense, saying why
 ✓ |@ai-office/server| src/model-mappings/routes.test.ts > the model mappings API, kept in memory > refuses a forced Model of another AI Provider, and extra usage where none is offered
 ✓ |@ai-office/web| src/model-mappings-card.test.tsx > Model mappings in AI Settings > says when there are none, and adds an alias and a mapping for one kind of AI Account
 ✓ |@ai-office/web| src/model-mappings-card.test.tsx > Model mappings in AI Settings > changes a mapping, and deletes one once the Owner confirms
 ✓ |@ai-office/web| src/model-mappings-card.test.tsx > Model mappings in AI Settings > says why a mapping was refused, by the form or by the API
 ✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > forces a Model, and turns a Claude subscription's extra usage on
 ✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > shows why a forced Model was refused
```

## Not verifiable in this sandbox

- **Postgres 18 (Docker):** these skip here with the reason, and run on
  the host and in CI:
  - migration `0054_gateway_model_mappings`, including its unique index on
    `coalesce(ai_provider, '')`, `coalesce(account_type, '')` and
    `from_model`, and the two checks;
  - `databaseModelMappingStore`;
  - the Postgres cases of `mappings.test.ts`, `extra-usage.test.ts` and
    `model-mappings/routes.test.ts`.

  They were written against the same cases as the memory store, but were
  not run.
- **Playwright (`pnpm e2e`)** needs Docker, so it was not run, and no
  end-to-end test was added. The slice is covered at the Gateway (real
  HTTP, fake AI Providers), API and component levels.
- **The README's AI Settings screenshot** (`docs/images/ai-settings.png`)
  was not retaken (`pnpm screenshots` needs Docker). It does not show the
  Model mappings card or the new account fields.
- **Real AI Providers.** No request went to a real AI Provider:
  - The extra-usage headers (`anthropic-ratelimit-unified-status`,
    `-overage-status`, `-reset`) are what Claude Code reads. Anthropic does
    not document them, and the fixture was written by hand. Whether a real
    subscription past its limit reports them like this, and its window as
    `1.0`, should be checked on the host (#45 records real fixtures).
  - A real Claude Code session that has its Model replaced mid-session
    was not tried.

## Notes, and disagreements with the canon

These are outside the issue's "What to build", or for the Owner to decide.
This run has no GitHub access, so raise them on the issue.

- **What "extra usage" means here.** AI Office cannot turn Anthropic's extra
  usage on or off: that is a setting of the Owner's Claude account. The
  toggle decides whether the **AI Gateway** lets an account go on past its
  plan's limits. Off by default, it holds the account back at a full
  window, or at the first answer served on extra usage. That one answer was
  already billed: the Gateway learns it only from the answer. This is my
  reading of FR-41's "an 'extra usage' toggle where the AI Provider offers
  it".
- **Only Claude subscriptions offer it.** ChatGPT plans can now buy credits
  for Codex beyond their limits, which may count as extra usage too. That
  is not done: ChatGPT's Codex backend reports no usage windows to AI
  Office yet, and `aiAccountKinds` can mark it later (`extraUsage: true`).
- **"Per account type"** is read as per kind of AI Account (AI Provider
  plus account type, as the AI Accounts card labels them). Mapping all
  `api_key` accounts at once would cross AI Providers. An alias is the
  "every kind" case.
- **The forced Model beats a Combo slot's Model.** A Combo names (account,
  Model) pairs, and a forced Model says "whatever was asked". Forcing was
  read as the stronger of the two. Saving a Combo whose slot names another
  Model for a forced account is not refused, and the slot is sent the
  forced Model. The other choice is to let the slot win, or to refuse such
  slots.
- **A forced Model narrows the Model, not the requests.** An account forced
  to Sonnet does not start serving another AI Provider's requests: which
  requests it can serve is judged by the mapped Model, before forcing. A
  kind's mapping, unlike a forced Model, can make a kind serve another AI
  Provider's name.
- **Names match exactly:** no wildcards or patterns, and no case folding.
  An alias is one step; a chain is not followed.
- **The answer names the Model that served.** It is not rewritten to the
  name the caller asked for. An agent tool that checks it may notice.
- **Auto-refresh** (FR-39) still sends its minimal request with its own
  small Model, not the account's forced Model.
- **GLOSSARY.md** has no entries for "model mapping", "alias", "extra
  usage" or "account type". I left the glossary unchanged; it may want
  them, as with "Combo" (#102).
