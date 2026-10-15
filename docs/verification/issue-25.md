# Issue #25: Office-wide sandbox concurrency limit and queue — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **Storage** (migration `0012_work_queue`):
  - **`work_queue`:** one row per piece of work. A row holds the
    Floor, the issue, the stage, the Agent it waits for, its status
    (`queued`, `running`, `finished`, `failed` or
    `cancelled`), and when it was queued, started and ended. A partial
    unique index keeps an issue active at most once per stage.
  - **`floors.priority`:** 0 to 10, higher first, 0 by default.
  - **`office_settings.sandbox_concurrency_limit`:** null for the
    default, 3.
- **Settings:**
  - **The office-wide limit:** `GET` and `PUT
    /api/office/sandboxes` (`{ concurrencyLimit }`, 1 to 50) and
    Admin's **Sandboxes** card. A change records `config.changed`.
  - **Floor priority:** in each Floor's settings (`PATCH
    /api/floors/:floorId`) and its admin page.
- **The queue** (`packages/orchestrator/src/work/`).
  `createWorkQueue({ store, agents, events, limit, execute })`:
  - **Assignment:** each piece of work is queued for the Floor's
    enabled Agent in the stage's Role (`needs-code` → coder,
    `needs-qa` → QA, `needs-docs` → docs), choosing the one with the
    least work. Stages that run no sandbox, such as review (FR-20), are
    refused.
  - **Starting work:** the store's `claimNext(limit)` starts the next
    piece only while fewer than `limit` are running. The limit is read
    from the office settings before each start, so a change applies at
    once (`wake()`), or within 30 seconds. Order is by Floor priority,
    then age. Floors in use only, and an Agent works one task at a time.
  - **Postgres claims:** one transaction under an advisory lock, so
    concurrent claims cannot pass the limit.
  - **Events:** `agent.queue_changed` is emitted each time the number
    of tasks waiting for an Agent changes (for its desk's ticket pile,
    FR-62).
  - **Restarts:** work left `running` by a server that stopped is
    queued again on `start()`.
  - **Stopping:** `stop()` cancels running work (it ends
    `cancelled`).
  - **Stores:** a memory store for tests, and a database store.
- **The server.** Intake now queues picked-up issues in `work_queue`,
  through the queue, instead of in memory. Nothing executes work yet
  (doing the work is #30), so the server queues work without starting
  it.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All
      three exit 0 (output below).
- [x] **Scenario test: with a limit of 1, a second task waits and starts
      when the first finishes.**
      `packages/orchestrator/src/work/queue.test.ts`, "with a limit of
      1, a second task waits and starts when the first finishes":
      - **Setup:** two issues are queued on `web-shop` for its two
        different coders, so only the limit can hold the second back.
        Work is a controllable stand-in for the sandbox.
      - **While the first runs:** the second stays `queued`.
      - **When the first finishes:** the second starts.
      - **Afterwards:** nothing is left active.

      Companion cases:
      - **Limit 2:** both start at once.
      - **Raising the limit:** waiting work starts.
      - **Order:** with `blog` at priority 5, its newer work starts
        before `web-shop`'s older work, and `web-shop`'s two then
        start oldest first.
      - **One task per Agent:** the `blog` coder's three tasks run one
        at a time with a limit of 3, and `agent.queue_changed` goes 1,
        0, 1, 2, 1, 0.
      - **Also covered:** an issue is queued once per stage, and only at
        sandbox stages; work left running by a stopped server starts
        again; stopping cancels running work; work on an archived Floor
        does not start.
      - **Mutation check:** I made the memory store ignore the limit by
        hand. The limit-1 scenario and three others failed, and I
        restored it.
      - **Reliability:** the file passed 15 runs in a row. (It was flaky
        at first: my test named a second coder "Grace", which the
        default team's random names can also pick.)

      Also covered: the API's limit (default, set, refusals) and the
      Admin card (`sandboxes-card.test.tsx`), and Floor priority in the
      Floor API and admin page.

### Not verifiable in this sandbox

- **The Postgres 18 variants.** All eight queue scenarios, the settings
  tests, the API tests, and migration `0012` run in Postgres too. They
  need Docker, so they are skipped here with the reason, and run in CI
  and on the host. The database store's SQL is only type-checked here:
  the advisory-locked claim, the `NOT EXISTS` busy-Agent filter, and
  `ON CONFLICT DO NOTHING` against the partial unique index.

## Notes

- **Floor priority** is not one of FR-7's settings. The issue orders the
  queue by it, so it was added as a Floor setting (0 to 10).
- **Per-Agent queues.** The issue asks for queue length per Agent, so
  work is assigned to an Agent when it is queued, by a plain-code rule:
  the least busy enabled Agent in the Role. The Manager's dispatch (#80)
  can replace the rule; the per-Floor limit is #80 too.
- **One task per Agent.** An Agent works one task at a time, so a Floor
  with one coder runs one coding task at once, whatever the office-wide
  limit.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/gateway typecheck: Done
e2e typecheck: Done
apps/web typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/server typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  59 passed (59)
      Tests  616 passed | 85 skipped (701)
   Start at  01:07:13
   Duration  6.28s (import 50%, tests 32%, transform 10%, environment 8%)
```
