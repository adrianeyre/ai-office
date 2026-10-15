# Issue #100: Usage throttling and model-capacity routing — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `e952e2d` (every code commit of the issue and the
README).

## What was built

- **The pipeline** (`packages/gateway/src/balancing/balancing.ts`, `route`).
  After any forced account (unchanged, and still first), a request is
  routed in FR-38's order:
  1. **Strategy selection:** the load balancer ranks the candidates (#99's
     `rank`).
  2. **The model-capacity filter** leaves out what is exhausted for the
     request's model family.
  3. **Usage throttling** leaves out what is held back or ahead of its
     pace.

  The first account left serves; one not yet tried for the request is
  preferred. The strategy is then told which (`served`), so a session
  whose account was filtered out moves.

  When a check leaves none, `AccountsUnavailableError` says which:
  - **429** for capacity;
  - **529** for throttling;
  - each with `retryAt`, when the first account it left out is back, which
    the Gateway sends as `retry-after`.

  No candidates at all is `undefined`, which the Gateway answers with
  **503**, as before. Accounts whose circuit breaker is open are still left
  out first, and a list of only those is a 503.
- **`AiAccounts.select`** (`accounts.ts`) builds the two checks:
  - **capacity:** rate-limited outright (as before), or exhausted for
    `modelFamilyOf(request.model)`;
  - **throttling:** overloaded or at its usage pause threshold (as before),
    or, with a pacing gate on, ahead of its five-hour or weekly pace.
- **Model families** (`packages/shared`, `modelFamilyOf`): Claude's tier
  (`claude-opus`, `claude-sonnet`, `claude-haiku`, whatever the version or
  date). Any other Model is its own family, without a pinned date
  (`gpt-4o-2024-08-06` is `gpt-4o`).
- **A rate limit for one family** (`limits/detect.ts`, `limitedModelFamily`):
  - The `rate_limited` outcome carries `modelFamily` when the answer
    scopes the limit to one family. That is Google's `QuotaFailure` with a
    `model` in its `quotaDimensions`, or a Claude subscription's
    `anthropic-ratelimit-unified-representative-claim` ending in
    `_opus`, `_sonnet` or `_haiku`.
  - `report` then records the account as exhausted for that family until
    the reset, in memory, and does not limit the whole account. Its other
    families keep being served.
  - **Reset limits** forgets these exhaustions too.
- **Usage throttling's pacing gates** (`aheadOfPace`):
  - An account is ahead of its pace while its window's utilization is more
    than the share of the window gone by plus 10 points
    (`pacingHeadroomPercent`). It is held back until the pace reaches it,
    never past the window's reset.
  - The five-hour and weekly gates are optional and off by default.
  - `GET` and `PUT /api/office/usage-throttling` read and set
    `{"fiveHourPacing","weeklyPacing"}`. They are kept in `office_settings`
    (migration `0034_usage_throttling`), each change is a `config.changed`
    event, and the server reads them afresh on that event.
  - Accounts without windows (API keys) are never paced.
- **Admin:** a **Usage throttling** card with the two gates.
- **Fixtures** (hand-written, see below):
  `fixtures/limits/anthropic-opus-weekly-limit.json` and
  `fixtures/limits/gemini-model-quota.json`, described in
  `fixtures/README.md`.
- **README:** the **Load balancing** section now lists the checks after the
  strategy and their errors; **Rate limits** points to it.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below): 1462 passed, 265 skipped (the Postgres cases,
      without Docker).
- [x] **Unit tests for the full pipeline order and each error.**
  - `packages/gateway/src/balancing/pipeline.test.ts` (`route`, with
    drain-soonest strict ranking Team, Work, Key):
    - **Order:**
      - With no exclusion, the strategy's first serves.
      - With Team out of capacity, Work (next by the strategy) serves; with
        Work also throttled, Key serves.
      - Throttling is never asked about an account capacity left out.
      - An account both out of capacity and throttled is a 429, not a 529.
      - A session whose account is filtered out moves, and the strategy
        records where.
    - **429:** capacity leaves none. The message is the first-ranked
      account's, and `retryAt` is the earliest reset.
    - **529:** throttling leaves none of what capacity left. `retryAt` counts
      only the throttled accounts.
    - **503:** no candidates give `undefined`.
    - An untried account is preferred.
    - **Pacing:** within pace with headroom; ahead until the pace catches
      up (an hour in with 35% used: back at 1 h 15 m); weekly; never past
      the reset; nothing for a window that has reset.
  - `packages/gateway/src/limits/capacity.test.ts`, through a real Gateway
    over HTTP with real `AiAccounts`:
    - **Detection:** the Opus weekly limit gives `modelFamily:
      "claude-opus"` until Monday 09:00, and Google's quota gives
      `"gemini-2.5-pro"` with its 23 s `RetryInfo`. A `five_hour` claim
      limits the whole account.
    - **Capacity, one family only:** an Opus request falls over to Second,
      and Opus is then never sent to First, whose `limitReason` stays null.
      With Second paused, Opus is a 429 while Sonnet and Haiku are served
      by First.
    - **429:** both accounts out of Opus gives
      `{"type":"rate_limit_error","message":"…has no capacity left for claude-opus models."}`
      with `retry-after` until the weekly reset, and neither account is
      asked. Sonnet is still served; after **Reset limits**, Opus is too.
    - **Throttling:**
      - pacing is off by default;
      - the five-hour gate holds back First (70% used, 40% of the window
        gone), so Second serves;
      - alone, First is a 529 until 13:00, then serves;
      - the weekly gate with both accounts ahead gives a 529,
        `overloaded_error`, "…is ahead of its weekly pace.", with
        `retry-after` until Second's pace catches up;
      - an API key is never paced.
    - **Order end to end:** out of capacity on one and ahead of pace on the
      other is a 529; out of capacity on both is a 429.
    - **503:** no AI Account gives a 503.
  - The existing `limits.test.ts` cases (429 for rate limits, 529 for
    overloads, capacity before throttling, 503 with no account, OpenAI's
    error format) pass unchanged on the new pipeline.
  - `packages/shared/src/load-balancing.test.ts`: model families, and the
    settings schema.
  - `apps/server/src/office/routes.test.ts`: `GET`/`PUT
    /api/office/usage-throttling`, one `config.changed` per change, and 400
    for bad bodies.
  - `apps/web/src/usage-throttling-card.test.tsx`: the card is off by
    default and saves the five-hour gate with the CSRF token.

### Real output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck`:

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`:

```text
 Test Files  152 passed (152)
      Tests  1462 passed | 265 skipped (1727)
exit 0
```

The pipeline and error tests (`--reporter=verbose`, excerpt):

```text
 ✓ src/load-balancing.test.ts > a Model's family > is Claude's tier, whatever its version or date
 ✓ src/load-balancing.test.ts > a Model's family > is another Model itself, without a date it is pinned to
 ✓ src/load-balancing.test.ts > usage throttling's settings > are both pacing gates, off by default
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > serves the strategy's first choice when no check leaves it out
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > filters after the strategy ranks: the next in the strategy's order serves, not the Owner's first
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > answers 429 when the model-capacity filter leaves none, until the first is back
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > answers 529 when throttling leaves none of what capacity left
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > checks capacity before throttling: an account both out of capacity and throttled is a 429
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > answers nothing for no candidates at all, which the AI Gateway answers with a 503
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > prefers an account not yet tried for the request, among those the checks left
 ✓ src/balancing/pipeline.test.ts > the routing pipeline > moves a session whose account a check leaves out, and tells the strategy where it went
 ✓ src/balancing/pipeline.test.ts > pacing a usage window > lets a window be used as fast as it goes by, plus the headroom
 ✓ src/balancing/pipeline.test.ts > pacing a usage window > holds back a window ahead of its pace until the pace catches up
 ✓ src/balancing/pipeline.test.ts > pacing a usage window > paces a weekly window over its week
 ✓ src/balancing/pipeline.test.ts > pacing a usage window > says nothing of a window that has already reset
 ✓ src/limits/capacity.test.ts > a rate limit for one model family > is told apart from one for the whole account
 ✓ src/limits/capacity.test.ts > the model-capacity filter > leaves out an account exhausted for the request's model family, and only for that family
 ✓ src/limits/limits.test.ts > when every AI Account is exhausted > answers 429 for rate limits: the last account's own answer, then the Gateway's, until the soonest reset
 ✓ src/limits/limits.test.ts > when every AI Account is exhausted > answers 529 for overloads (throttling)
 ✓ src/limits/capacity.test.ts > the model-capacity filter > answers 429 when every account is exhausted for that family, until the first is back
 ✓ src/limits/capacity.test.ts > usage throttling > is off until the Owner turns a pacing gate on
 ✓ src/limits/capacity.test.ts > usage throttling > holds back an account ahead of its five-hour pace, which serves again once the pace catches up
 ✓ src/limits/capacity.test.ts > usage throttling > answers 529 when every account is ahead of its pace, until the first catches up
 ✓ src/limits/capacity.test.ts > usage throttling > never paces an account that reports no windows
 ✓ src/limits/capacity.test.ts > usage throttling > comes after the model-capacity filter: out of capacity on one, ahead of pace on the other, is a 529
 ✓ src/limits/capacity.test.ts > when no AI Account can serve at all > answers 503
 ✓ src/limits/limits.test.ts > when every AI Account is exhausted > checks capacity before throttling: rate-limited and overloaded is 529
 ✓ src/limits/limits.test.ts > when every AI Account is exhausted > answers in OpenAI's format to an OpenAI client
 ✓ src/limits/limits.test.ts > when every AI Account is exhausted > answers 503 when there is no account at all
 ✓ src/limits/limits.test.ts > when every AI Account is exhausted > still lets an Owner tool force a held-back account, once, as a probe
 ✓ src/usage-throttling-card.test.tsx > usage throttling in Admin > paces no window by default
 ✓ src/usage-throttling-card.test.tsx > usage throttling in Admin > turns the five-hour gate on, saving at once
 ✓ src/office/routes.test.ts > the office's settings, in memory > paces no usage window by default, and turns the pacing gates on at runtime
```

## Not verifiable in this sandbox

- **Postgres 18 (Docker):** migration `0031` and the office-settings cases in
  Postgres skip here with the reason. They run on the host and in CI.
- **Real provider responses (#45):** the two model-family fixtures were
  written by hand. Google's `QuotaFailure` `quotaDimensions.model` follows
  Google's documented error model. The Claude subscription's
  `anthropic-ratelimit-unified-representative-claim` values (`seven_day_opus`
  and so on) are not documented by Anthropic. Recording real 429s from both
  is #45's work. If the header turns out to differ, such a limit is treated
  as account-wide, which is the behaviour before this issue.
- **Real AI Accounts:** pacing against a real subscription's reported
  windows can only be seen on the host.

## Notes

- Exhaustion for a model family is kept in memory, like sessions: after a
  restart the AI Provider says so again on the first request. It is not
  shown in the AI Accounts card, and does not raise the "No AI Account
  left" Notice, which still follows account-wide limits.
- The PRD gives no pacing formula. Here it is an even pace plus 10 points
  of headroom, so a window is not throttled at its very start. Both gates
  are off by default ("optional"), and an account's hard pause thresholds
  (FR-36) work as before.
