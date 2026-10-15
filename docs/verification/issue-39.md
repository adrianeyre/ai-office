# Issue #39: Rate limits: retries, circuit breaker, fallback and error codes — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`91d918a`).

## What was built

### Reading an AI Provider's answer (`packages/gateway/src/limits/detect.ts`)

`outcomeOf({status, headers, body}, now)` says what an answer means for the
AI Account that gave it:

- **served** for a 2xx;
- **rate-limited** for a 429, or an error body of type `rate_limit_error`,
  `rate_limit_exceeded` or Google's `RESOURCE_EXHAUSTED`;
- **overloaded** for a 529, an `overloaded_error` (whatever the status), or
  a 503 that says `UNAVAILABLE` or "overloaded" (Gemini);
- **failed** for any other 5xx or a 408;
- **refused** for other 4xx: the request's fault.

The reset is the latest of everything that says it is exhausted:
`retry-after` (seconds or an HTTP date), `retry-after-ms`, Anthropic's
`anthropic-ratelimit-*-reset` for the limits whose `-remaining` is 0 (and a
subscription's `anthropic-ratelimit-unified-reset`, unless its status is
not `rejected`), OpenAI's `x-ratelimit-reset-*` durations (`1m30s`,
`250ms`) for the limits with nothing remaining, and Google's `RetryInfo`
`retryDelay`. With none of these, 60 s for a rate limit and 30 s for an
overload. No limit is believed past eight days.

### Retries and fallback (`packages/gateway/src/gateway.ts`)

Each request runs a loop of choose an account, send, read the answer:

- An answer that is rate-limited or overloaded is reported, which holds the
  account back. The next attempt goes to another account **at once**, and
  the held-back account is never sent the same request again.
- A failure (5xx, or an AI Provider that cannot be reached) is reported too.
  The next attempt goes to an untried account at once if there is one.
  Otherwise it goes back to one already tried after `delayMs ×
  multiplier^(n−1)` (500 ms, then 1 s, by default).
- Attempts are capped (3 by default). When they run out, or nothing else
  can be tried, the caller gets the last answer, in its own format.
- A refused (4xx) answer is sent back at once.
- A forced account (`x-ai-office-account`, Owner tools only) is tried
  exactly once, even while held back, so it works as a probe.
- One `gateway_requests` record per request, naming the account that gave
  the final answer. Each failed attempt is logged (live log stream).

### Holding accounts back (`packages/gateway/src/accounts/accounts.ts`)

- `ai_accounts` gains `limit_reason` (`rate_limited`, `overloaded` or
  `circuit_open`) and `limited_until` (migration `0021_rate_limits`, with
  check constraints that both are set or neither).
- **Circuit breaker.** Failures in a row are counted per account in memory.
  At the threshold (5) the circuit opens for the cooldown (60 s). After
  that, it is half-open: one request may try it, and a failure opens it
  again at once. Any answer (served or refused) closes it.
- **Selection** follows FR-38's order of checks, among the unpaused accounts
  that can serve:
  - accounts with an open circuit are left out; with none left, an
    `AccountsUnavailableError` 503;
  - then the rate-limited, a **capacity** exclusion; with none left, 429;
  - then the overloaded, **throttling**; with none left, 529.

  Each error carries when the first account is back, and the Gateway sends
  it as `retry-after`. With no account at all, `undefined`, which the
  Gateway answers with 503 as before.
- Serving lifts a stored limit. `checkLimits()` (every minute, with the
  token refresh) lifts those whose time has passed.
- Each change is an `ai_account.limit_changed` event: account, AI Provider,
  reason, until, and whether the AI Provider still has an unpaused account
  that is not held back (`providerAvailable`).

### The Notice (`packages/orchestrator/src/ai-accounts/no-account-left.ts`)

When an event says an AI Provider has no account left, one action Notice
is raised per AI Provider: "No Claude AI Account left: Team was the last".
Its **Open AI Accounts** action links to `/admin?aiProvider=Claude`, which
brings that AI Provider's accounts into view. Taking the action while
nothing serves fails, and the Notice stays. When an account of that AI
Provider serves again, the Notice is closed as acted on.

### Configuration, API and web

- **Retry settings.** `office_settings` gains the attempts, delay,
  multiplier, threshold and cooldown, each null for its default.
  - `GET` and `PUT /api/office/retries` read and set them, validated by
    `gatewayRetrySettingsSchema`. Each change is a `config.changed` event
    (`retries.*`), and the server reads it again then, so it applies from
    the next request.
- **Admin.** The **Retries** card sets them. The **AI Accounts** card
  shows "Rate-limited until …", "Overloaded until …" or "Failing (circuit
  open) until …", live from the events.
- **Activity Feed.** It tells each limit and lifting.
- **API.** `GET /api/ai-accounts` carries `limitReason` and `limitedUntil`
  while a limit has not run out.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 1033 passed, 177 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1195 passed, 15
      skipped (the Docker image and compose checks).
- [x] **Contract tests with recorded 429/529 fixtures: fallback to the
      second account; correct errors when all are exhausted.**
      `packages/gateway/src/limits/limits.test.ts` (17 tests) replays
      `fixtures/limits/anthropic-rate-limited.json` (429 with Anthropic's
      rate-limit headers), `anthropic-overloaded.json` (529) and
      `anthropic-served.json` through a real Gateway, serving from real AI
      Accounts (memory store) on fake AI Providers.

  **Fallback:**
  - For both 429 and 529, the request falls back to the second account, at
    once and without a wait. The caller gets the second account's answer
    byte for byte, and the record names the second account.
  - The first account is held back until the fixture's reset: 12:01:00
    for the 429 (the exhausted input-tokens limit, later than
    `retry-after: 40`), and 30 s for the 529. The event says the AI
    Provider is still available.
  - Until the reset the next request goes straight to the second account.
    After it, a new session uses the first again, and serving lifts the
    limit and tells it.
  - The minute's check lifts an expired limit, and a translated (Chat
    Completions) request falls back the same way.

  **Exhausted:**
  - With both rate-limited, the caller gets the last account's own 429
    (with its `retry-after`), and the event says no account is left. The
    next request reaches no AI Provider: it gets the Gateway's 429
    `rate_limit_error` with `retry-after: 45` (the soonest reset, 15 s
    later), in Anthropic's or OpenAI's format as the caller speaks.
  - With both overloaded: 529, then the Gateway's 529 `overloaded_error`
    with `retry-after: 30`.
  - With one rate-limited and one overloaded: 529 (capacity is checked
    before throttling).
  - With no account: 503.

  **Retries and the circuit breaker:**
  - Four attempts with a 100 ms delay and multiplier 3 wait 100, 300 and
    900 ms.
  - A failure goes on to the next account at once, then back with a wait.
  - A retry that is served answers the caller.
  - A 400 is not retried, and one attempt means no fallback.
  - The circuit opens after three failures (configurable), giving `503`
    with `retry-after: 60` without reaching the AI Provider. Half-open
    after the cooldown, one failure reopens it; a success closes it and
    the count starts again.
  - An AI Provider that cannot be reached counts as a failure.
  - A forced account is probed once even while held back, and a served
    probe lifts the limit.

  **Detection:** `src/limits/detect.test.ts` (25 tests) covers each
  provider's statuses, headers and bodies, as listed above.

  **Mutation checks** (each reverted):

  | Mutation | Tests failed |
  | --- | --- |
  | No retries at all (`canRetry = false`) | 11 |
  | The capacity filter skipped (rate-limited accounts chosen) | 3 |

Also covered:

- `packages/orchestrator/src/ai-accounts/no-account-left.test.ts`:
  - one Notice per AI Provider;
  - its action fails while nothing serves;
  - it is closed when an account serves again;
  - no Notice while another account serves.
- `packages/orchestrator/src/office/settings.test.ts` (memory and Postgres
  18): the retry defaults, setting them, and events naming only what
  changed.
- `apps/server/src/office/routes.test.ts` (memory and Postgres 18): the
  retries API, its event, and ten malformed bodies each refused with
  `400`.
- `apps/server/src/ai-accounts/routes.test.ts` (memory and Postgres 18): a
  current limit is shown, and an expired one is not.
- `apps/web/src/retries-card.test.tsx`: the defaults, setting them, and
  refusing 0 attempts.
- `apps/web/src/ai-accounts-card.test.tsx`: the limit badge, live from
  `ai_account.limit_changed`, and `?aiProvider=` bringing the accounts into
  view.

### Not verifiable in this sandbox

- **Recorded provider responses.** The fixtures were written by hand from
  Anthropic's documented formats (rate-limit headers, `rate_limit_error`,
  `overloaded_error`), because #45 is open and there is no AI Account here.
  The OpenAI-compatible and Google formats are covered by unit tests from
  their documented formats. Re-recording real 429s and 529s is for the host.
- **The subscription's unified rate-limit headers**
  (`anthropic-ratelimit-unified-*`) are undocumented. They are read as Claude
  Code is understood to send them. A real subscription should be checked on
  the host.
- The Testcontainers path of the Postgres tests. They ran against an
  embedded Postgres 18.3 (`@embedded-postgres/linux-x64@18.3.0-beta.16` in
  `/tmp/pg18`, port 54329), with a scratch, reverted edit pointing
  `postgresTest` at it, as in earlier issues.
- The Playwright suite (`pnpm e2e`) was not run; nothing in it covers the
  new cards.

## Notes, and disagreements with the canon

- **Which error when nothing is left.** FR-38 names three errors. They are
  mapped as follows:
  - a rate limit is the **capacity** exclusion (429);
  - an AI Provider's overload is **throttling** (529), as Anthropic's own
    529 is. Usage throttling proper (pacing, #100) and #40's usage pause
    thresholds will join this 529 step;
  - accounts that are all failing (circuits open) are **no account**
    (503).
- **The caller gets the AI Provider's own answer when it has one.** It is
  the most precise, and keeps its `retry-after`. The Gateway's own
  429/529/503 is for requests that find every account already held back.
- **Limits are per account, not per model family.** FR-38's capacity filter
  speaks of model families. This issue asks to mark the account limited,
  and that is what is stored. Splitting by family would need the model
  catalogue (FR-41).
- **Sessions do not move back** when the first account's limit resets. That
  is FR-39's automatic fallback back (#101). New sessions do use it again.
- **The circuit breaker's counts are in memory.** An open circuit is stored
  like any limit, so it survives a restart. The count of failures before it
  opens does not.

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
 Test Files  99 passed (99)
      Tests  1033 passed | 177 skipped (1210)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  99 passed (99)
      Tests  1195 passed | 15 skipped (1210)
   Duration  41.88s (tests 86%, import 9%, transform 3%, environment 2%)
```
