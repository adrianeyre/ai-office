# Issue #49: Pricing table and cost estimation — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit of
the issue (`170e7a5`), after `pnpm install --frozen-lockfile`.

## What was built

- **`packages/gateway/pricing.json`:** per-Model prices in US dollars per
  million tokens of input, output, cache writes and cache reads, for
  Claude's current Models (Fable 5.1 and 5, Opus 5.5, 5, 4.8, 4.7 and 4.6,
  Sonnet 5.5, 5 and 4.6, Haiku 5.5 and 4.5) at Anthropic's first-party
  prices as of 2026-10-06, cache writes at the five-minute rate (1.25 ×
  input). It is checked with a schema when read.
- **Cost estimation** (`src/pricing/pricing.ts`): `estimateCost(price,
  usage)` prices each token type at its own price; null when the response
  counted no tokens. `createPricing` resolves a Model's price from the
  Owner's override, else a published price, else the table; unknown
  Models have no price. Estimates come from memory, so the Gateway adds no
  database query per request.
- **Every request record gets an estimated cost:**
  `gateway_requests.estimated_cost_usd` (migration `0016_model_prices`),
  from the Model the caller asked for.
- **Overridable per Model in admin:** `model_prices` keeps the Owner's
  overrides (and published prices). `GET /api/gateway/prices`,
  `PUT /api/gateway/prices/:model` (four non-negative amounts, nothing
  else) and `DELETE /api/gateway/prices/:model`; each change is a
  `config.changed` event naming the Model. Admin's **Model prices** card
  lists every priced Model with where its price comes from (Pricing table,
  Published, Yours), edits a price, prices a Model in no table, and goes
  back to the default.
- **Refreshed automatically where an AI Provider publishes prices:**
  `openRouterPrices()` reads OpenRouter's public Models list (per-token
  prices, converted per million; variable and per-request prices left
  out). The server reads stored prices at start (falling back to the table
  if the database cannot be read), and refreshes published prices at start
  and every 24 hours. A source that fails keeps its last prices.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below): 845 passed, 144 skipped without
      Docker; 974 passed, 15 skipped against Postgres 18.
- [x] **Unit tests: cost computed per token type; admin override wins.**
      `packages/gateway/src/pricing/pricing.test.ts`:
  - `prices each token type at its own price`: a million tokens of each
    type alone costs exactly its price (input $4, output $20, cache write
    $5, cache read $0.20 for Opus 5.5), and a mixed request sums them.
  - `is null when nothing was counted, and counts a missing type as none`.
  - `lets the Owner's override win over the table and published prices`:
    table < published < override, the override survives a refresh and a
    restart, and removing it brings back the published price; events name
    the Model, never the price.
  - `refreshes published prices, keeping a failed source's last ones`,
    OpenRouter's list parsed from a stand-in, the table's validity, and a
    request through the Gateway recorded with `estimatedCostUsd: 0.016`
    (1 000 × $4 + 500 × $20 + 10 000 × $0.20 per million), or null for an
    unpriced Model.
  - The store cases run in memory and in Postgres 18.

  `apps/server/src/pricing/routes.test.ts` (memory and Postgres 18): the
  list, setting and removing an override (404 when there is none), a Model
  name with a slash (`openai/gpt-5.5`), and refusing a price that is not
  four non-negative amounts. `apps/web/src/model-prices-card.test.tsx` (3
  tests): the card's list, editing and going back to the default, and
  pricing a new Model after the form's own checks.

  **Negative checks** (each reverted afterwards):
  - Cache writes priced at the input price: 1 test failed.
  - The override ignored: 4 tests failed.

The Playwright suite still passes (17 tests).

**A test fix along the way:** the first test of the Activity Feed and
Notice Board component test files sometimes timed out under the full
parallel run (as in #41's verification). Alone, that first render takes
about 300 ms, against about 40 ms for later tests, because it also
transforms the page's modules, and the Admin page grew with this batch.
Testing Library's default wait for `findBy…`/`waitFor` is one second, so
the web test setup now gives waits five seconds
(`test(web): give Testing Library's waits five seconds`). No assertion
changed. Afterwards the web suite passed four runs in a row, and the full
suite in the clone above.

### Not verifiable in this sandbox

- OpenRouter's real Models list. It was read from a stand-in in the shape
  of its documented response; no OpenRouter AI Account can be added yet,
  so the server fetches nothing today.
- Real requests' costs against a real AI Account's invoice.
- **Prices of other AI Providers' Models.** The table holds Claude's only;
  I had no verified current prices for others. Their costs are null until
  the Owner prices them in Admin or their AI Provider publishes them.
- **Tiered prices** are not modelled: Claude Haiku 5.5 costs more above
  100K-token prompts, and one-hour cache writes cost more than five-minute
  ones; the table holds the base prices.
- The Testcontainers path of the Postgres tests (no Docker); they ran
  against the embedded Postgres 18.3 as for #35.

## Output

`pnpm lint` (fresh clone):

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
 Test Files  86 passed (86)
      Tests  845 passed | 144 skipped (989)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  86 passed (86)
      Tests  974 passed | 15 skipped (989)
```

`pnpm e2e` (tail):

```text
  17 passed (11.4s)
```
