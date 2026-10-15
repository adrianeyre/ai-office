# Issue #101: Auto-fallback to the preferred account and auto-refresh — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `0377a24`: every commit of the issue except this
document.

## What was built

- **Back to the preferred account** (`packages/gateway/src/balancing/balancing.ts`;
  PRD FR-39, §5 scenario 6):
  - A session now keeps to its account only among the accounts of that
    account's priority (`stickyFirst`). Before, it kept to its account
    ahead of everything, so a session that fell back to a worse priority
    stayed there for its whole window. `limits.test.ts` said so: "moving
    sessions back is FR-39's fallback back, which comes later".
  - A session that fell back because every better account was held back
    (rate-limited, overloaded, at a pause threshold, failing) stays on its
    account only while they are. Once one can serve again (its limit
    reset, or its circuit breaker's cooldown ended), the session's next
    request moves back to it, and starts a new session window there. New
    sessions go there too, as they already did.
  - Among accounts of one priority, sessions keep to their own account as
    before. A fallen-back session is not swapped between two accounts of
    the worse priority either.
  - This applies to every strategy that keeps sessions: `session`,
    `session_affinity` and `drain_soonest`.
- **Auto-refresh** (`packages/gateway/src/limits/auto-refresh.ts`,
  `AiAccounts.refreshWindows` in `packages/gateway/src/accounts/accounts.ts`;
  FR-39):
  - Every minute, with the token refresh and the limit check
    (`apps/server/src/server.ts`), the Gateway looks for AI Accounts whose
    five-hour or weekly usage window reset more than a minute ago (the
    safety buffer, `autoRefreshBufferMs`).
  - Each gets one minimal request: Messages, one output token, from
    `claude-haiku-5-5`, presented as the account presents every request
    (its key, or its bearer token and `oauth-2025-04-20` beta flag).
  - Its answer goes through the same `report` path as any answer. The new
    window is stored and shown, a rate limit holds the account back, a
    failure counts towards the circuit breaker, and a served answer lifts
    a limit still stored.
  - **Once per window.** The reset each window was refreshed after is kept
    in memory and marked before the request is sent. A window gets one
    request whether or not it is served, and a window that a real request
    already restarted gets none.
  - Accounts that are paused, held back, signed out or with an expired
    token wait for a later minute. Accounts that report no windows (API
    keys) are never sent one.
  - Each request is an `ai_account.window_refreshed` event
    (`packages/events/src/schema.ts`). The Activity Feed lists it under
    **AI Accounts** with a sentence (`apps/web/src/event-text.ts`).
- **The setting, end to end:** off by default.
  - `autoRefreshSettingsSchema` (`packages/shared/src/auto-refresh.ts`).
  - The `office_settings.gateway_auto_refresh` column (migration
    `0052_gateway_auto_refresh`).
  - The office settings store (`packages/orchestrator/src/office/settings.ts`).
  - `GET` and `PUT /api/office/auto-refresh` (`apps/server/src/office/routes.ts`),
    whose changes are `config.changed` events (`autoRefresh.enabled`).
  - The server reads it at start and on each change.
  - Admin's **Auto-refresh** card (`apps/web/src/auto-refresh-card.tsx`),
    with a warning about the AI Providers' terms (see Notes).
- **README:** "Back to the preferred account" under **Load balancing**, and
  a new **Auto-refresh** section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck exit 0. `pnpm test` exits 0 (output below). Under heavy
      load on the sandbox's host it did not at first; see "Test timeouts
      under load" below.
- [x] **Unit tests with a fake clock: sessions return after reset.**
      `packages/gateway/src/balancing/balancing.test.ts`, "the fallback back
      to a preferred account (FR-39)". These drive `route()`, the FR-38
      pipeline the Gateway uses, with a clock passed in. The preferred
      account is rate-limited until 12:30, so the model-capacity filter
      leaves it out until then.
  - For `session`, `session_affinity` and `drain_soonest`, a session falls
    back to the priority-2 account at 12:00 and stays there at 12:15 and
    12:29:59.999. At 12:30 it is back on the preferred account, a new
    session goes there too, and the moved session holds it for a whole new
    window.
  - Two sessions that fell back to two priority-2 accounts each keep their
    own until the reset, then both return.
  - Sessions are still not moved between accounts of the best priority.
  - Through the whole Gateway (`limits.test.ts`, fake clock and fake AI
    Provider), a session whose first account was rate-limited or
    overloaded now moves back to it once its reset passes. This replaces
    the old expectation that it stayed on the second.
- [x] **Unit tests with a fake clock: refresh fires once per window.**
      `packages/gateway/src/limits/auto-refresh.test.ts`, with a fake clock
      and a fake AI Provider (`fetch`) behind a Claude subscription:
  - Nothing is sent before the reset at 14:00, nor within the minute's
    buffer (14:00:59.999). At 14:01 exactly one request is sent: its URL,
    headers (bearer token, beta flag) and body are checked. The new window
    (resetting 19:01) is stored, and the `ai_account.window_refreshed`
    event is told.
  - It runs every minute from 14:02 to 19:01: no second request. At 19:02,
    the next window's one request.
  - Once per window even when not served: an unreachable AI Provider (the
    error does not contain the token) and a `429` (which holds the account
    back) each get one request, and none again for that window.
  - The weekly window, when it resets on its own, gets its one request.
  - Off, nothing is sent. Turned on, a window that reset meanwhile gets
    its one request.
  - A rate limit that ends at the reset (the "limit resets" case) is
    refreshed at reset plus the buffer, and the served answer lifts it.
  - A window that an Agent's request already restarted gets none.
  - Paused, signed-out and held-back accounts wait, then get their one
    request. An API key without windows is never sent one.
- Also covered: the setting's schema
  (`packages/shared/src/auto-refresh.test.ts`); the settings store
  (`packages/orchestrator/src/office/settings.test.ts`); the API, including
  its `400`s and its `config.changed` events
  (`apps/server/src/office/routes.test.ts`); the Admin card
  (`apps/web/src/auto-refresh-card.test.tsx`); and the Activity Feed's
  sentences (`apps/web/src/activity-feed.test.tsx`). The routes' access
  test (`route-access.test.ts`) passes with the new routes declared
  `owner`.

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

`pnpm test`:

```text
start load 15.38 38.23 51.10
 Test Files  233 passed (233)
      Tests  2727 passed | 368 skipped (3095)
exit 0
```

The issue's tests (`--reporter=verbose`, excerpt):

```text
 ✓ src/balancing/balancing.test.ts > the fallback back to a preferred account (FR-39) > moves a session that fell back to a worse priority back once the preferred account resets (session)
 ✓ src/balancing/balancing.test.ts > the fallback back to a preferred account (FR-39) > moves a session that fell back to a worse priority back once the preferred account resets (session_affinity)
 ✓ src/balancing/balancing.test.ts > the fallback back to a preferred account (FR-39) > moves a session that fell back to a worse priority back once the preferred account resets (drain_soonest)
 ✓ src/balancing/balancing.test.ts > the fallback back to a preferred account (FR-39) > keeps a fallen-back session on its own account among those of its priority
 ✓ src/balancing/balancing.test.ts > the fallback back to a preferred account (FR-39) > does not move a session between accounts of the best priority
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > starts a new window a minute after the old one resets, once per window
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > is sent once per window even when it is not served
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > reads a refused answer like any other, holding a rate-limited account back
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > refreshes the weekly window too, once it resets
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > sends nothing while it is off, and refreshes a window that reset once it is on
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > starts a rate-limited account's next window once its limit resets, lifting it
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > does not refresh a window a request has already started
 ✓ src/limits/auto-refresh.test.ts > auto-refresh > waits while an account is paused, held back or signed out, and leaves accounts without windows be
 ✓ src/limits/limits.test.ts > a rate-limited or overloaded AI Account > is held back until its reset, and the request falls back to the second account (rate_limited)
 ✓ src/limits/limits.test.ts > a rate-limited or overloaded AI Account > is held back until its reset, and the request falls back to the second account (overloaded)
 ✓ src/limits/limits.test.ts > retries and the circuit breaker > tries the next account at once after a failure, and goes back to one with a wait
 ✓ src/auto-refresh.test.ts > auto-refresh's settings > are off by default, and only say whether it is on
 ✓ src/auto-refresh.test.ts > auto-refresh's settings > wait a minute after a window's reset
 ✓ src/office/settings.test.ts > office settings, kept in memory > auto-refreshes no usage window until the Owner turns it on
 ✓ src/office/routes.test.ts > the office's settings, in memory > auto-refreshes no usage window by default, and turns auto-refresh on at runtime
 ✓ src/auto-refresh-card.test.tsx > auto-refresh in Admin > is off by default, and warns about the AI Providers' terms
 ✓ src/auto-refresh-card.test.tsx > auto-refresh in Admin > turns auto-refresh on
 ✓ src/activity-feed.test.tsx > event text > lists every event type in exactly one group
 ✓ src/activity-feed.test.tsx > event text > says what auto-refresh did to an AI Account's usage windows
```

### Test timeouts under load

The sandbox shares its host, whose load average was between 50 and 108 on
16 cores for most of this work. Under that load, four runs of `pnpm test` on
this branch failed 3, 3, 2 and 1 web tests (the last with
`--maxWorkers=4`). Every failure was `Error: Test timed out in 5000ms.`,
with no failed assertion. Each run failed a different set: the 3D Floor's
waypoint checks (`src/scene/floor-layout.test.ts`), the whiteboard and the
Avatar editor (`src/floors.test.tsx`). This branch changes none of those
files. Run together on their own, they pass:

```text
$ pnpm vitest run --project @ai-office/web src/scene/floor-layout.test.ts src/whiteboard.test.tsx src/floors.test.tsx
 Test Files  3 passed (3)
      Tests  104 passed (104)
```

Even alone under that load, the waypoint cases take 0.8 to 2.6 s each
against the 5 s limit, so the full suite's contention pushes them over.

To check that this is the host and not the branch, `main` (`47b77b5`) was
checked out in a worktree (with this checkout's installed dependencies) and
its own `pnpm test` was run under the same load. It failed 11 web tests, all
timeouts:

```text
 FAIL  |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in Admin > imports a Grok CLI login, and clears it from the page
 FAIL  |@ai-office/web| src/floors.test.tsx > the Floor admin page > adds an Agent in a Role, copied from its first, then opens its editor (§5 scenario 7)
 FAIL  |@ai-office/web| src/floors.test.tsx > the Floor admin page > removes an Agent after asking; a busy one leaves once its task ends; never the Manager
 FAIL  |@ai-office/web| src/git-identity-card.test.tsx > the Git identity in Admin > shows the default, the Owner's noreply identity
 FAIL  |@ai-office/web| src/manager-chat.test.tsx > the Manager chat > streams the Manager's reply in, a piece at a time
 FAIL  |@ai-office/web| src/retries-card.test.tsx > retries in Admin > shows the defaults
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 8 Agents' Floor clear of furniture and walls
 …(9, 10, 11 and 12 Agents likewise)
Error: Test timed out in 5000ms.
 Test Files  6 failed | 224 passed (230)
      Tests  11 failed | 2695 passed | 366 skipped (3072)
exit 1
```

The passing run above is plain `pnpm test`, started once the host's load
had dropped below 16. No test was skipped, deleted or given a longer
timeout. The waypoint tests' 5 s limit is tight on a busy machine; that is
outside this issue.

## Not verifiable in this sandbox

- **Postgres 18 (Docker):** migration `0042` and the settings cases in
  Postgres (`settings.test.ts`, `routes.test.ts`) skip here with the
  reason. They run on the host and in CI.
- **Playwright (`pnpm e2e`):** it needs Docker for Postgres, so it was not
  run. No end-to-end test was added: the slice is the Gateway's behaviour,
  covered at the unit and API level.
- **A real Claude subscription:** whether Anthropic serves the minimal
  request as sent is unverified, and so is whether its answer starts a new
  five-hour window and reports it. Anthropic does not document using a
  subscription's OAuth token outside Claude Code (see Notes), may require
  more of such a request (Claude Code's system prompt, say), and the
  subscription's catalogue may not list `claude-haiku-5-5`. That needs the
  host, with a real subscription and auto-refresh turned on.

## Notes

These are outside the issue's "What to build", or for the Owner to decide.

- **The PRD disagrees with itself here.** FR-39 asks for auto-refresh
  using a minimal request. FR-35 says subscription accounts are "only used
  through the AI Provider's own agent tool, as that provider's terms
  require". So far only Claude subscriptions report usage windows, so every
  auto-refresh request is AI Office's own request on a subscription, not
  Claude Code's. I did not change the PRD. Instead, auto-refresh is **off
  by default**, and the Admin card says plainly what turning it on means.
  The PRD should say which requirement wins. Raise this on the issue,
  since this run has no GitHub access.
- **Sessions move back mid-way.** A session that returns to the preferred
  account loses its prompt cache on the account it fell back to. That is
  the fallback back's purpose ("moves back when the first resets", §5
  scenario 6). Keeping the cache warm is keep-alive's (#104).
- **Priority changes now move sessions too.** Stickiness never outranks a
  better priority, so when the Owner raises an account's priority (or adds
  one with a better priority), sessions on worse accounts move to it on
  their next request. That matches the README's existing promise ("accounts
  of a worse priority serve only when none of a better one can … Changes
  apply from the next request"), but it is a change in behaviour.
- **A single failure of the preferred account.** It does not hold the
  account back (the circuit opens after 5 in a row). So a session's next
  request tries the preferred account again, rather than staying where the
  retry served it. `limits.test.ts`'s "tries the next account at once after
  a failure" case now expects the third attempt on the first account, for
  this reason. The circuit breaker bounds how often that happens.
- **Auto-refresh requests are not in the request history or analytics**
  (`gateway_requests`): no Agent or Owner tool made them, and the record
  has no way to say "the AI Gateway itself" (FR-42). They are in the
  Activity Feed. Counting their (one output token) usage in analytics
  would need a new kind of caller.
- **Once per window is per process.** The record of windows already
  refreshed is kept in memory, like sessions and model-family exhaustions.
  After a restart, a window that reset unrefreshed is refreshed then, and
  one whose refresh failed before the restart is tried once more.
- **ChatGPT subscriptions** report their limit only as a `429`'s
  `resets_in_seconds`, not as usage windows, so auto-refresh never applies
  to them. If they come to report windows, auto-refresh's request is
  Anthropic Messages only, and they are left out (`apiFormat` check).

## After merging `main` (#165, #166)

`main` moved the AI Providers, AI Accounts and the AI Gateway's settings from
Admin to a new **AI Settings** page, and the README's how-it-works sections to
`docs/guide/`. So the **Auto-refresh** card is on AI Settings, after usage
throttling, and the README's two additions are in `docs/guide/ai-gateway.md`.
`main`'s new prompt-cache TTL setting and this issue's auto-refresh setting
each have their own `config.changed` listener in `apps/server/src/server.ts`.
