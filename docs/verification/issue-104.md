# Issue #104: Prompt-cache keep-alive — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `56a2531`: every commit of the issue except this
document.

## What was built

- **Keep-alive** (`packages/gateway/src/keep-alive/keep-alive.ts`; PRD
  FR-39):
  - **What it keeps.** The Gateway shows it each Agent's Messages request
    that an Anthropic-format AI Account served (`GatewayOptions.keepAlive`,
    from `finish` in `packages/gateway/src/gateway.ts`). For each Agent
    session (its Gateway Key and the session it names, FR-37) and Model, it
    keeps the latest such request that has a cache breakpoint: as sent to
    the account, with its path, its headers (never a credential) and its
    attribution. Owner tools' requests, `count_tokens`, refused or failed
    answers, and requests to OpenAI-format accounts are not kept.
  - **The minimal request** (`keepAliveRequestOf`). The request again with
    `max_tokens: 0` and `stream` removed. Anthropic answers such a request
    with nothing generated, reading the cache (which starts its TTL again)
    and billing a cache read. Requests that `max_tokens: 0` is refused with
    (`thinking.type: "enabled"`, `output_config.format`, a forced
    `tool_choice`) are never kept warm. The cache's TTL is the shortest of
    the request's breakpoints: an hour only when every one asks for `1h`.
  - **When.** The server runs a round every 15 seconds (`keepAliveRoundMs`,
    `apps/server/src/server.ts`). A session is due a minute before its cache
    would expire (`keepAliveLeadMs`): its TTL after the start of the last
    request that read or wrote it, its Agent's own or a served keep-alive.
  - **Only active sessions; stops after idle.** A session whose Agent has
    made no request of its own for the **idle time** (30 minutes by
    default) is let go. So is one whose cache expired before it was kept
    warm, one whose keep-alive was not served, and one whose Agent is paused
    at a Token Cap (`capCheck`). An Agent's next request starts it again.
  - **Bounded per account.** Each AI Account is sent at most
    **maxPerAccountPerHour** keep-alives in any rolling hour (60 by
    default). Slots are taken before anything is awaited, so neither a
    round's other sessions nor an overlapping round go past the bound. An
    account that cannot serve now is not sent one
    (`AiAccounts.keepAliveAccount`, `packages/gateway/src/accounts/accounts.ts`:
    gone, paused, held back, exhausted for the Model's family, signed out or
    with an expired token). Its sessions wait, without taking a slot.
  - **Sent as the agent tool's request was:** to the same account, at the
    same path (`/v1/messages?beta=true`), with the same headers, and the
    account's credential and beta flags added as for any request. The
    answer is told to the accounts like any answer (a rate limit holds the
    account back, a failure counts towards its circuit breaker, usage
    windows are stored).
- **Visible in analytics and request history:**
  - Each keep-alive is a request in `gateway_requests`, attributed to its
    Agent, Floor, Gateway Key and issue, with its tokens, estimated cost and
    timings, and the new `keep_alive` column set (migration
    `0055_gateway_prompt_cache_keep_alive`).
  - The analytics' totals (series, points and breakdown items) carry
    `keepAliveRequests` and `keepAliveCostUsd`
    (`packages/shared/src/analytics.ts`, rolled up in
    `packages/gateway/src/history/store.ts` and
    `packages/gateway/src/analytics/analytics.ts`). The Analytics page has a
    **Keep-alives** tile (count, and what they cost) and a **Prompt-cache
    keep-alives** chart over time.
  - The request list marks each **(keep-alive)**, and its page says what it
    was (`keepAlive` in `gatewayRequestSummarySchema`).
- **The setting, end to end:** off by default.
  - `promptCacheKeepAliveSettingsSchema` (`{"enabled", "idleMinutes",
    "maxPerAccountPerHour"}`, 5–480 minutes, 1–600 an hour) in
    `packages/shared/src/prompt-cache-keep-alive.ts`.
  - Three `office_settings` columns (`gateway_keep_alive`,
    `gateway_keep_alive_idle_minutes`,
    `gateway_keep_alive_max_per_account_per_hour`, with a check constraint)
    in the same migration.
  - The office settings store (`packages/orchestrator/src/office/settings.ts`).
  - `GET` and `PUT /api/office/prompt-cache-keep-alive`
    (`apps/server/src/office/routes.ts`, owner only). Changes are
    `config.changed` events naming what changed (`keepAlive.enabled`,
    `keepAlive.idleMinutes`, `keepAlive.maxPerAccountPerHour`), which the
    server reads again.
  - AI Settings' **Prompt-cache keep-alive** card
    (`apps/web/src/keep-alive-card.tsx`), with the AI Providers' terms
    warning (see Notes).
- **Guide:** a **Prompt-cache keep-alive** section, and keep-alives under
  **Analytics**, in `docs/guide/ai-gateway.md`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Each exits 0;
      the real output is below.
- [x] **Unit tests with a fake clock: keep-alive fires only for active
      sessions and stops after idle.**
      `packages/gateway/src/keep-alive/keep-alive.test.ts` drives
      `createPromptCacheKeepAlive` with a fake clock, a fake AI Provider
      (`fetch`) and fake AI Accounts, running rounds as the server does:
  - **Fires for an active session, at the right time.** An Agent's request
    at 12:00 (five-minute TTL): nothing at 12:00, 12:02 or 12:03:59.999.
    At 12:04 exactly one keep-alive goes. Its URL, headers (the agent
    tool's, the subscription's bearer token and merged beta flags) and body
    (`max_tokens: 0`, no `stream`) are checked. Its request-history record
    (attribution, `keepAlive: true`, cache-read tokens, cost) is checked,
    and holds no credential. The next is due at 12:08, not 12:07:59.999.
  - **Stops after idle.** Rounds every 15 seconds for an hour after one
    request: keep-alives at 12:04, 08, 12, 16, 20, 24 and 28, then the
    session is let go and nothing more is sent. With a 10-minute idle time:
    12:04 and 12:08 only. After being let go, the Agent's next request
    starts it again.
  - **Only active sessions.** An Agent asking every three minutes until
    12:30 is never sent one while it asks; only its pause is bridged
    (12:34, 38, 42). Sessions never seen with a cached request (no
    breakpoint, a thinking budget) get nothing. With keep-alive off nothing
    is kept, and turning it off lets every session go.
  - **Bounded per account.** Three sessions on one account and one on
    another, at 2 an hour: two go to the first and one waits (then expires
    and is let go); over the hour the first account gets exactly 2.
  - Also: the latest request is the one sent, not one that finished late;
    an account that cannot serve makes its session wait (without using the
    bound, even with two sessions waiting on it) and then go; an Agent at a Token Cap is let go; a `429` or an
    unreachable AI Provider is told to the accounts, recorded, and lets the
    session go; an hour's cache is kept warm only when the idle time
    outlasts it (at 12:59).
- Also covered:
  - The minimal request's shape and TTL, and the requests it refuses
    (same file).
  - Through the whole Gateway (same file, a fake AI Provider over HTTP):
    an Agent's served Messages request is observed with its session, issue,
    account, path and headers (neither key in them). An Owner tool's
    request, `count_tokens` and a refused answer are not.
  - `AiAccounts.keepAliveAccount`: paused, rate-limited, signed-out,
    expired-token and family-exhausted accounts get none
    (`packages/gateway/src/keep-alive/accounts.test.ts`).
  - Analytics rows count keep-alives apart
    (`packages/gateway/src/history/history.test.ts`). The analytics API's
    totals, points and breakdown carry them
    (`apps/server/src/analytics/routes.test.ts`), as does the request list
    API (`apps/server/src/gateway-requests/routes.test.ts`).
  - The settings' schema (`packages/shared/src/prompt-cache-keep-alive.test.ts`),
    the settings store (`packages/orchestrator/src/office/settings.test.ts`)
    and the API, with its `400`s and `config.changed` events
    (`apps/server/src/office/routes.test.ts`).
  - The AI Settings card, the Analytics tile and chart, and the request
    list's marker (`apps/web/src/keep-alive-card.test.tsx`,
    `analytics-page.test.tsx`, `gateway-requests.test.tsx`).

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
$ tsc && pnpm --recursive typecheck
…
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test` (plain, started once the host's load had dropped below 16; see
"Test timeouts under load"):

```text
start load 14.77 29.56 32.23
 Test Files  252 passed (252)
      Tests  2855 passed | 400 skipped (3255)
exit 0
```

The keep-alive tests, verbose:

```text
$ pnpm exec vitest run packages/gateway/src/keep-alive --reporter=verbose
 ✓ |@ai-office/gateway| src/keep-alive/accounts.test.ts > the AI Account a keep-alive goes to > is the account, ready to send to, while it can serve 8ms
 ✓ |@ai-office/gateway| src/keep-alive/accounts.test.ts > the AI Account a keep-alive goes to > is none while it is paused, held back or signed out 1ms
 ✓ |@ai-office/gateway| src/keep-alive/accounts.test.ts > the AI Account a keep-alive goes to > is none while it is exhausted for the Model's family, but not for others 2ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > a request's keep-alive > is the request as sent, with max_tokens 0 and not streamed 3ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > a request's keep-alive > lasts an hour only when every breakpoint does 1ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > a request's keep-alive > is none for a request with nothing cached, or that max_tokens 0 cannot be sent with 1ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > keeps an active session's cache warm a minute before it would expire 7ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > stops once the session has been idle for the idle time 7ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > is not sent while the Agent's own requests keep the cache warm 3ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > sends the session's latest request, not one that finished late 1ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > starts again with the Agent's next request after it was let go 1ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > keeps nothing warm for sessions it never saw a cached request from 0ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > does nothing while off, and lets every session go when turned off 1ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > sends each AI Account at most its number of keep-alives in any hour 2ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > waits while the account cannot serve, and lets go an Agent paused at a Token Cap 1ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > gives back the slots of sessions that waited for their account 0ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > lets the session go when a keep-alive is not served, telling the accounts 3ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > prompt-cache keep-alive > keeps an hour's cache warm only when the idle time outlasts it 1ms
 ✓ |@ai-office/gateway| src/keep-alive/keep-alive.test.ts > keep-alive through the Gateway > is shown each Agent's served Messages request, and nothing else 171ms
 Test Files  2 passed (2)
      Tests  19 passed (19)
```

### Test timeouts under load

As in #101, the sandbox shares a host whose load average was 20 to 50 on 16
cores for most of this work. Two earlier runs of plain `pnpm test` (at
`ebf7319`, before the fix commit) each failed one web test, both
`Error: Test timed out in 5000ms.` in the 3D Floor's waypoint checks, with
no failed assertion:

```text
start load 20.09 19.84 23.41
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 9 Agents' Floor clear of furniture and walls
Error: Test timed out in 5000ms.
 Test Files  1 failed | 251 passed (252)
      Tests  1 failed | 2853 passed | 400 skipped (3254)
exit 1

start load 49.01 32.82 27.83
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 10 Agents' Floor clear of furniture and walls
Error: Test timed out in 5000ms.
 Test Files  1 failed | 251 passed (252)
      Tests  1 failed | 2853 passed | 400 skipped (3254)
exit 1
```

This issue changes nothing under `apps/web/src/scene/`
(`git diff fceaa5d --stat -- apps/web/src/scene` is empty). Run on its own
the file passes (`Test Files 1 passed (1)`, `Tests 77 passed (77)`). The
passing run above is plain `pnpm test` at `56a2531`. No test was skipped,
deleted or given a longer timeout.

## Not verifiable in this sandbox

- **Anthropic's real answer to `max_tokens: 0`.** The sandbox has no AI
  Account, so no keep-alive reached Anthropic. That such a request is
  accepted, generates nothing and reads (so refreshes) the cache comes from
  Anthropic's prompt-caching documentation (cache pre-warming and
  keep-alive), and is what the fake AI Provider answers. Its rejected
  combinations are the ones the Gateway never sends. Checking it for real
  means turning keep-alive on with a real AI Account and watching
  `cache_read_input_tokens` on the keep-alives and on the Agent's next
  request after a pause.
- **The Postgres side.** Without Docker, the database tests (the
  `keep_alive` column, the `FILTER` sums in `analyticsRows`, the settings
  columns and their check constraint) are skipped with their reason. The
  migration was generated by `drizzle-kit` from the schema. CI, which runs
  Postgres, fails rather than skips them.

## Notes, and disagreements with the canon

These are outside the issue's "What to build", or for the Owner to decide.

- **FR-35 against FR-39 again.** As with auto-refresh (#101), a keep-alive
  is the agent tool's own request, but the AI Gateway sends it, while
  FR-35 allows a subscription only through its AI Provider's agent tool.
  Keep-alive is **off by default**, and the card says plainly what turning
  it on means. The PRD should say which requirement wins. Raise this on the
  issue, since this run has no GitHub access.
- **Keep-alives count towards Token Caps.** They are an Agent's requests in
  `gateway_requests`, so their input and output tokens count (FR-31). They
  are a few uncached input tokens and no output: cache reads, nearly all of
  a keep-alive, are not counted. An Agent paused at a cap is let go.
- **Sessions are kept in memory.** Each holds the latest request's body, so
  a long conversation costs memory until its session is let go (idle time,
  at most 8 hours). A restart lets every session go; the Agent's next
  request starts its session again.
- **Thinking budgets are never kept warm.** `max_tokens: 0` is refused with
  `thinking.type: "enabled"`, and a keep-alive with any other thinking
  setting would write a different cache. Current Claude models use adaptive
  thinking, which is kept warm.
- **Keep-alives are not Activity Feed events.** They are model calls, which
  the request history and analytics record; one every four minutes per
  paused Agent would flood the feed.
