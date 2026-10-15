# Issue #38: Load balancing: session and least-used strategies — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`0f8a5cf`).

## What was built

### The strategy interface and two strategies (`packages/gateway/src/balancing/balancing.ts`)

- **`Strategy`**: `choose(candidates, { sessionKey }, now)`. The candidates
  come in the Owner's order (priority, then oldest first). Paused accounts
  and those that cannot serve the request (a subscription for anything but
  Claude Code, or one whose token has expired) are already left out.
- **Priority is respected by every strategy.** Each chooses only within
  `bestTier`, the candidates with the lowest priority number there is. An
  account of a worse priority serves only when no account of a better one
  can. A tie goes to the first in the Owner's order.
- **`sessionStrategy(sessions, windowMs)`.**
  - A session stays on the account it started on until its window ends.
  - A new session, or one whose window ended, starts on the account with
    the fewest live sessions, for a new window.
  - A session whose account can no longer serve it (paused, say) moves,
    and its new window starts then.
  - A request in no session goes where a new session would, without being
    kept.
- **`leastUsedStrategy(usage)`**: the account that used the fewest input
  and output tokens in the last five hours (`leastUsedWindowMs`).
- **`createUsageTracker`** keeps those tokens for the window.
  - The server feeds it each request as request history records it.
  - At start, the server seeds it from the last five hours of
    `gateway_requests` (`accountUsageSince`).
- **`createLoadBalancer({ settings, usage })`** asks the settings on every
  request, so a change applies from the next one. It keeps the session
  table in memory.

### Sessions

- An Agent session is a sandbox run. The runner now adds
  `x-ai-office-session: <sandbox id>` to `ANTHROPIC_CUSTOM_HEADERS`, beside
  #36's issue and pull request headers.
- The Gateway's session key is the caller's Gateway Key id plus that
  header. Without the header, it is the key alone, so each Owner tool is
  one session.

### The forced-account header (FR-38)

- `x-ai-office-account: <name or id>` is checked before any strategy (FR-38's
  order of checks). Its account serves the request whatever its priority or
  the strategy.
- If that account does not exist, is paused or cannot serve this request,
  the request is refused with `503` naming why. It is not served from
  another account: a probe must reach the account it names.
- The header is honoured only from an **Owner tool's** Gateway Key (manual
  routing and internal probes). From an Agent it is ignored, because
  sandboxes are untrusted.
- All of AI Office's own headers (`x-ai-office-*`, now `aiOfficeHeaders`,
  renamed from #36's `gatewayAttributionHeaders`) are dropped before
  forwarding.

### Chosen at runtime in Admin

- `office_settings` gains `gateway_strategy` and
  `gateway_session_window_minutes` (migration `0020_load_balancing`, with
  check constraints). The default is `session` for 300 minutes; the window
  can be 1 minute to 7 days.
- `GET` and `PUT /api/office/load-balancing` read and set them. Each change
  is a `config.changed` event (`loadBalancing.strategy`,
  `loadBalancing.sessionWindowMinutes`). The server re-reads the settings on
  that event and applies them from the next request, with no restart.
- Admin's **Load balancing** card: a radio choice of strategy, each with
  what it does, and the session window in minutes.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 979 passed, 174 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1138 passed, 15
      skipped (the Docker image and compose checks), and green twice in a
      row before the last code commit.
- [x] **Unit tests for each strategy, priority ordering, paused accounts
      skipped, forced account honoured.**

  **Each strategy** (`packages/gateway/src/balancing/balancing.test.ts`):
  - **Session:**
    - sessions stick for the window and new ones spread across the best
      priority;
    - a session is chosen afresh once its window ends;
    - a session moves when its account is paused, and stays put when the
      account is resumed;
    - a worse priority is used only when nothing better can serve;
    - a request in no session is not kept.
  - **Least-used:**
    - it chooses the fewest tokens within the best priority, a tie going
      to the first in the Owner's order;
    - an unused account of a worse priority is not chosen;
    - tokens leave the count five hours after they were used.
  - **The load balancer:**
    - it follows the settings as they change, between strategies and
      windows;
    - it balances by session for five hours by default.

  **Priority, paused and forced accounts**, through real AI Accounts, in
  memory and in Postgres 18 (`routing.test.ts`):
  - with every priority-1 account paused, the priority-2 account serves,
    and with all paused, nothing does;
  - reprioritising changes the order;
  - least-used, once chosen, keeps to the best priority and skips a paused
    account;
  - a forced account is honoured over priority and the strategy, by name
    or by id, and the session stays where it was;
  - a forced account that does not exist or is paused is a
    `ForcedAccountError` saying which.

  **Through a real Gateway** (`routing.test.ts`):
  - an Owner tool's `x-ai-office-account: Spare` is served by Spare, with
    the header not forwarded;
  - an unknown forced account is a `503` with its reason, reaching no AI
    Provider;
  - an Agent's forced account is ignored;
  - two sandbox sessions of one Agent go to the two priority-1 accounts and
    each stays there, an Owner tool's requests stay on one, and no
    `x-ai-office-session` is forwarded.

  **Mutation checks** (each reverted):

  | Mutation | Tests failed |
  | --- | --- |
  | Priority ignored (`bestTier` returning every candidate) | 8 |
  | Paused accounts not skipped | 2 |
  | The forced account ignored | 3 |
  | Sessions not sticky | 6 |
  | Least-used inverted | 4 |

Also covered:

- `packages/orchestrator/src/office/settings.test.ts` (memory and Postgres
  18): the defaults, setting, and events naming only what changed.
- `apps/server/src/office/routes.test.ts` (memory and Postgres 18): the API,
  its event, and five malformed bodies each refused with `400`.
- `apps/web/src/load-balancing-card.test.tsx`: the defaults shown, switching
  to least-used with a 90-minute window, and refusing a window of 0.
- `packages/orchestrator/src/sandbox/*.test.ts`: the sandbox's custom
  headers carry its session.

### Verified on the host

None listed for this issue. The PRD's phase 2 exit criterion, "two Claude
accounts share load", would show on the host with two real accounts and
several sandbox runs. It needs real AI Accounts, Docker and the GitHub App
(#18).

### Not verifiable in this sandbox

- Claude Code sending `x-ai-office-session` from `ANTHROPIC_CUSTOM_HEADERS`
  (as for #36's headers); a fake agent tool stands in.
- The Testcontainers path of the Postgres tests; they ran against an
  embedded Postgres 18.3, as in #36 and #37.

## A fix to #37 found on the way

The first full run against Postgres failed once in #37's "refreshes tokens
ahead of expiry, once at a time". It was a real race: an overlapping refresh
round could use a refresh token another round had used up. It is fixed in
its own commit (`4656672`, `Refs #37`) and described in `issue-37.md`.

## Notes, and disagreements with the canon

- **Priority with balancing.** #34 served "the lowest priority, a tie going
  to the oldest". Strategies now spread requests across accounts that share
  the lowest priority, which is what lets two accounts share load. Giving
  accounts different priorities keeps the old strict order.
- **Sessions are in memory.** A restart starts every session afresh, on the
  account with the fewest sessions. Nothing is lost but stickiness.
- **Least-used counts input and output tokens**, as Token Caps do (FR-31).
  Cache reads and writes are not counted.
- **Forced accounts respect pausing.** The issue asks that paused accounts
  be respected, so a paused account cannot be forced. Rate-limit states for
  probes (#99, #100) are separate from pausing.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  95 passed (95)
      Tests  979 passed | 174 skipped (1153)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  95 passed (95)
      Tests  1138 passed | 15 skipped (1153)
   Start at  07:57:12
   Duration  35.88s (tests 87%, import 9%, environment 2%, transform 1%)
```
