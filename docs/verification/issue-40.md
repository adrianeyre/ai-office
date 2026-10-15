# Issue #40: Usage windows, pause thresholds and force-reset — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`d70ad61`).

## What was built

### Usage windows (`packages/gateway/src/limits/usage-windows.ts`)

- `usageWindowsOf(headers)` reads a Claude subscription's five-hour and
  weekly windows from each answer, served or not:
  - `anthropic-ratelimit-unified-5h-utilization` and `-5h-reset`;
  - `anthropic-ratelimit-unified-7d-utilization` and `-7d-reset`.

  Utilization is a fraction (1 is full), kept as a percentage to a tenth.
  The reset is in seconds since the epoch. A window reported only in part,
  or unreadably, is left out. API-key answers report none.
- The Gateway passes the readings with each outcome. `AiAccounts.report`
  stores them on the account (migration `0022_usage_windows`:
  `five_hour_utilization`, `five_hour_resets_at`, `weekly_utilization`,
  `weekly_resets_at`). A check constraint keeps each window's two columns
  both set or both null.
- **Usage history.** Each reading that differs from the last stored one by
  a whole percent, or has a new reset time, is kept in `ai_account_usage`
  (account, window, utilization, reset, observed). Rows go with their
  account (`ON DELETE CASCADE`).
  - Readings are only stored on change, so the history stays small, and
    each request costs no write.
  - What was last stored is kept in memory, so a request costs no read
    either.

### Pause thresholds

- `ai_accounts` gains `five_hour_pause_threshold` and
  `weekly_pause_threshold` (1–100, null for none). They are set with `PATCH
  /api/ai-accounts/:id` (`fiveHourPauseThreshold`, `weeklyPauseThreshold`),
  and each change is a `config.changed` event naming it.
- `limitOf(account, at)` gives a stored limit (#39) first. Otherwise, an
  unreset window at or past its threshold holds the account back as
  `usage_threshold`, until the latest such window resets.
- Selection treats it as **throttling**, after overloads in FR-38's order.
  With nothing else to serve, the Gateway answers 529 ("…has reached its
  usage pause threshold"), with `retry-after` until the reset.
- Crossing a threshold, by a reading or by setting one, is an
  `ai_account.limit_changed` event. So is the window resetting, told by
  the minute's check. So #39's "No AI Account left" Notice covers accounts
  paused at their thresholds too.

### Force-reset

`POST /api/ai-accounts/:id/reset-limits` (`AiAccounts.resetLimits`) clears
the account's rate-limit state:

- its stored limit (rate-limited, overloaded or circuit open);
- its circuit breaker's count of failures;
- its usage windows, until its AI Provider reports them again.

The Gateway uses it from the next request. Its thresholds and its history
are kept. It is a `config.changed` event (`aiAccounts.limitsReset`), and
an `ai_account.limit_changed` event saying it serves again.

### API and web

- `GET /api/ai-accounts` carries each account's `usage` (`fiveHour` and
  `weekly`: utilization and reset, null once the window has reset) and its
  two thresholds. `GET /api/ai-accounts/:id/usage` gives the last week's
  readings, newest first (at most 500).
- **Admin's AI Accounts card:**
  - each window as a meter with its share and reset, and where the
    account pauses;
  - **Usage history**, a table of the readings;
  - **Edit**, with the two threshold fields (empty for none);
  - **Reset limits**, while the account is held back or has windows.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 1048 passed, 184 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1217 passed, 15
      skipped.
- [x] **Unit tests: windows computed from recorded headers; threshold
      pauses the account; force-reset clears it.**

  **Windows from recorded headers.**
  - `src/limits/usage-windows.test.ts` reads
    `fixtures/limits/anthropic-subscription-usage.json`: five-hour 82%
    resetting 14:00, weekly 36.4% resetting Monday 09:00. It also checks
    that an answer without windows reports none, that partial or unreadable
    windows are left out, and that use past 100% is kept.
  - `src/limits/thresholds.test.ts`, in memory and in Postgres 18, stores
    them and keeps each change in the history. The same reading again, or
    82.5%, adds nothing; 83% adds one row. It also reads them through a
    real Gateway, from a served answer and from a 429 alike.

  **The threshold pauses the account.** In memory and Postgres 18:
  - At 80% of the five-hour window, the account is held back until 14:00.
    The event says so, and the next request goes to the second account.
    At 14:00 it serves again, and the minute's check tells it.
  - A weekly threshold set below current use pauses it at once, and
    removing the threshold lets it go.
  - Through a real Gateway with one account: once it reports 82% against
    an 80% threshold, the next request gets `529` "…has reached its usage
    pause threshold" with `retry-after: 5400`. No AI Provider is reached.

  **Force-reset clears it.** In memory and Postgres 18:
  - An account rate-limited, with a threshold reached, is cleared: no
    limit, no windows, thresholds kept, history kept. It is chosen again,
    with both events.
  - Through the Gateway, it serves again at once after the 529.
  - An unknown account is `ai_account_not_found` (404 from the API).
  - Deleting an account deletes its history.

  **Mutation checks** (each reverted):

  | Mutation | Tests failed |
  | --- | --- |
  | Thresholds never reached | 3 |
  | Force-reset keeps the windows | 2 |

Also covered:

- `apps/server/src/ai-accounts/routes.test.ts` (memory and Postgres 18):
  - thresholds set through `PATCH`, and 0, 101 and 50.5 refused with 400;
  - usage and the `usage_threshold` limit shown;
  - the history read;
  - `reset-limits`, and 404s for an unknown account.
- `apps/web/src/ai-accounts-card.test.tsx`:
  - the meter, the summary and the limit badge;
  - the history table;
  - setting the weekly threshold and removing the five-hour one (the
    `PATCH` body);
  - Reset limits;
  - refusing a 120% threshold.

### Not verifiable in this sandbox

- **Real headers.** The `anthropic-ratelimit-unified-*` headers are
  undocumented by Anthropic. The fixture was written by hand to the shape
  Claude Code is understood to read: utilization as a fraction, reset in
  epoch seconds. #45, recording real provider responses, is open, and there
  is no subscription here. If a real subscription reports differently, only
  `usageWindowsOf` changes.
- **The usage endpoints.** The issue allows windows "from provider headers
  or usage endpoints". Only headers are read. Polling a usage endpoint
  (such as the one Claude Code's `/usage` calls) would need a real account
  to record against.
- The Testcontainers path of the Postgres tests. They ran against the
  embedded Postgres 18.3, as in #39.
- The Playwright suite (`pnpm e2e`) was not run.

## Notes, and disagreements with the canon

- **A threshold pause is throttling (529).** FR-38 separates the capacity
  filter (429) from usage throttling (529). A threshold is the Owner's own
  pacing of a window, not the AI Provider's refusal, so it sits with
  throttling, after overloads. Pacing proper (#100) belongs there too.
- **Force-reset forgets the windows.** Otherwise an account paused at its
  threshold would stay paused, and the reset would do nothing. The next
  answer reports the windows again. If use is still over the threshold,
  the account pauses again; that is the AI Provider's truth, not a stale
  state.
- **Windows that reset are shown as none.** Nothing is known of a new
  window until an answer reports it. The history keeps the old one.
- **History is kept indefinitely for now.** The retention jobs (PRD §7,
  usage metadata 90 days) are #112.

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
 Test Files  101 passed (101)
      Tests  1048 passed | 184 skipped (1232)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  101 passed (101)
      Tests  1217 passed | 15 skipped (1232)
   Duration  40.82s (tests 85%, import 11%, transform 2%, environment 2%)
```
