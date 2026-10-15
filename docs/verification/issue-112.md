# Issue #112: Retention jobs and settings — verification

Retention was built on `wip/issues-112-113` before `main` gained PR #165
(AI Settings page, Claude usage windows, prompt-cache TTL and storage
clean-up), then merged onto this branch (`a9d9f7a`) and reconciled with
main's storage clean-up. Checks were run in the Sandcastle sandbox
(Node 26.10.0, pnpm 12.10.0, no Docker) at `865484d`, the last code
commit.

The blockers are built on this branch: #29, the Activity Feed
([`issue-29.md`](issue-29.md)), whose `events` table retention trims;
and #53, request history ([`issue-53.md`](issue-53.md)), whose bodies
and records it deletes, and whose **Keep request and response bodies**
switch (now in AI Settings' **Request history** card) is the "switch to
stop storing bodies".

## What was built

- **Settings** (`retentionSettingsSchema` in `@ai-office/shared`, columns
  in `office_settings`): request and response bodies 7 days, requests'
  records and usage 90, the Activity Feed and Notices 365 (PRD §7), each
  whole days up to 3,650 and bodies no longer than requests. `GET` and
  `PUT /api/office/retention`; each change is a `config.changed` event
  (`retention.*`).
- **Admin's Retention card** (`apps/web/src/retention-card.tsx`), placed
  beside main's **Storage** card in Admin (main moved the AI cards to AI
  Settings; retention and storage are office settings about stored
  history). It points to the body-storage switch in AI Settings.
- **The job** (`createRetention` in `@ai-office/orchestrator`): each
  rule's cutoff from the periods in force and a clock; each rule runs on
  its own. The server runs it at start, every hour and at once when a
  period changes, and logs what each run deleted.
- **What each rule deletes**: bodies (`gateway_request_bodies`, the
  requests stay); requests and usage (`gateway_requests` with their
  bodies, and `ai_account_usage`); activity (`events`, Notices closed
  before the cutoff, `sign_in_events`).
- **Aggregates that survive** (`gateway_usage_days`): deleting requests
  adds what they used to each UTC day's totals per AI Account, Model,
  Floor, Agent, issue and Owner tool, in the same statement. Token
  accounting (`tokenUsage`, which Token Caps read) and, after the merge,
  Analytics by the day add those days to the records still kept.

### Reconciled with main's storage clean-up

- **One retention vocabulary.** Main's `storageCategoryInfo` and the
  branch's retention settings had different minimums and suggestions.
  Both now read one table, `historyKindRetention`, and
  `defaultRetentionSettings` (`packages/shared/src/retention.ts`). Each
  kind of history names the rule that deletes it and the days it always
  keeps; Storage suggests that rule's PRD §7 default; a rule's minimum is
  the most any kind it deletes keeps (`retentionMinDays`), and the
  database's check on `office_settings` holds the same bounds:

  | Kind (Storage) | Rule | Always kept | Default / suggested |
  | --- | --- | --- | --- |
  | Activity | Activity Feed and Notices | 30 days (was 7 in Storage) | 365 |
  | Request and response bodies | Bodies | 0 (was 1 in retention) | 7 |
  | Gateway requests | Requests and usage | 32 (was 1 in retention) | 90 |
  | Usage history | Requests and usage | 0 | 90 |
  | Sign-in history | Activity Feed and Notices | 1 | 365 (was 90 in Storage) |

  Activity keeps 30 days because the wall board and merges read an
  issue's `issue.picked_up`, `pull_request.opened` and `cap.reached`
  events, from whenever its work started. Requests keep 32 days because
  hourly Analytics read up to 31 days of requests themselves. Bodies keep
  0 so Storage can still delete every body at once (main's test).
- **One delete path, one trigger mechanism.** Both features delete events
  and requests through `deleteEventsBefore` and
  `deleteGatewayRequestsBefore` in `@ai-office/db`. The event log's
  single `events_refuse_change()` (migration `0044_retention`) lets
  through a `DELETE` of events older than the cutoff the deleting
  transaction names in `ai_office.events_retention_cutoff`, and refuses
  updates, truncation and every other delete. Main's storage clean-up now
  names its cutoff too, so migration 0043's `ai_office.events_pruning`
  flag (which let a transaction delete *any* event) is retired: one
  mechanism, the stricter one, serves both kinds of delete. A test checks
  the flag no longer opens the log.
- **Token Caps and Analytics after either delete.** Main's clean-up of
  Gateway requests used a plain `DELETE`, which would have dropped what
  Token Caps count; it now goes through the same roll-up. Analytics read
  up to 366 days of `gateway_requests` alone, so after 90 days of
  retention a year's range undercounted; `gateway_usage_days` now also
  keeps the AI Account, Model, errors and added-up latency, and day
  buckets add it. Hour buckets count only kept requests (an hourly range
  is at most 31 days, inside the 32 always kept, for recent ranges).
- **Migrations.** Main's `0042_prompt_cache_ttl` and `0043_events_pruning`
  stay. The branch's `0042_retention` was dropped and regenerated with
  `pnpm --filter @ai-office/db db:generate` as `0044_retention`, its
  snapshot including main's changes, with the trigger SQL appended by
  hand. `drizzle-kit generate` then finds nothing more (output below).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 at `865484d` (output below).
- [x] **Integration tests with a fake clock for each retention rule.**
      `apps/server/src/retention.test.ts` wires the real stores to
      `retentionTargets` and `createRetention` with a fake clock, one case
      per rule, each in memory and in Postgres 18:
  - **Bodies, 7 days:** at exactly 7 days nothing goes; 1 ms later the
    older request's bodies go and the newer one's stay.
  - **Requests and usage, 90 days:** at 91 days the requests, bodies and
    usage reading go, and a fresh usage tally still counts Ada's day,
    month and issue.
  - **Activity Feed and Notices, 365 days:** 1 ms past a year the old
    events, the dismissed Notice and the sign-in go; the open Notice stays.
  - **The Owner's periods:** bodies kept at 7 days go once the Owner sets 1.

  The in-memory runs pass here; the Postgres 18 runs are skipped for want
  of Docker (below). The job's own fake-timer tests
  (`packages/orchestrator/src/retention/retention.test.ts`) pass too.
  Added with the merge and passing here: the shared table agrees between
  Storage and retention (`packages/shared/src/retention.test.ts`), and
  Analytics' day buckets are unchanged by deleting requests, in two parts
  of a day (`packages/gateway/src/history/history.test.ts`, in memory).

Main's storage tests all pass: those that named Storage's old activity
minimum (7 days) now name 30, and the branch's retention tests that named
1 day for bodies and under 32 for requests now name the shared minimums.
No assertion was dropped.

### Not verifiable in this sandbox

- **Every Postgres 18 run** (Testcontainers needs Docker), skipped here
  with the reason, to be run on the host. In particular:
  - the four retention cases in `apps/server/src/retention.test.ts`;
  - `packages/orchestrator/src/storage/storage.test.ts` (main's clean-up,
    now also checking the day's roll-up in `gateway_usage_days` and that
    `SET LOCAL ai_office.events_pruning = 'on'` no longer lets a delete
    through);
  - `packages/events/src/store.test.ts` (the cutoff delete, and the log
    still append-only otherwise);
  - `packages/gateway/src/history/history.test.ts` in Postgres: the
    roll-up `INSERT … ON CONFLICT … NULLS NOT DISTINCT` with the new
    columns, and Analytics merging `gateway_usage_days` into day buckets;
  - migration `0044_retention` applying on Postgres 18 after 0043
    (`packages/db/src/migrate.test.ts`).

  The SQL of the roll-up, the analytics query and the trigger has been
  type-checked and generated here, never executed.
- **The admin pages in a browser** (`pnpm e2e`): the Retention card on
  Admin, beside Storage, for `e2e/tests/accessibility.spec.ts` on the
  host. The README's `admin-storage.png` screenshot (`pnpm screenshots`)
  predates the Retention card, which now sits between the prompt-cache
  TTL and Storage; it needs retaking on the host.
- **The `docker compose` stack** running the hourly job against a real
  database.

## Notes

- **Sign-ins are suggested at a year** in Storage (main suggested 90),
  because they fall under the Activity Feed's rule as the feed records
  each sign-in too. PRD §7 names no period for them.
- **Usage history** (AI Accounts' readings) keeps no minimum, as main
  had it, and is not rolled up: Analytics' usage-window history shows
  only the readings kept.
- **Open Notices stay**, however old; a closed one goes a period after
  it closed (FR-48).
- **Connection delivery logs** (90 days in PRD §7) arrive with
  Connections.
- No disagreement with the PRD or an ADR was found.
- In one full `pnpm test` run right after the merge, three CPU-heavy web
  tests (`floors.test.tsx`, `floor-layout.test.ts`) timed out at 5 s
  under load; they pass alone (102 of 102), and in the final run.

## Output of the checks

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  247 passed (247)
      Tests  2837 passed | 394 skipped (3231)
   Start at  08:46:01
   Duration  43.98s (tests 41%, import 35%, environment 12%, transform 9%, setup 2%)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴

$ pnpm exec vitest run --reporter=verbose <retention, storage and history tests>
 ✓ |@ai-office/shared| src/retention.test.ts > retention's settings > default to 7 days of bodies, 90 of metadata and a year of activity
 ✓ |@ai-office/shared| src/retention.test.ts > retention's settings > are whole days, within bounds
 ✓ |@ai-office/shared| src/retention.test.ts > retention's settings > keep bodies no longer than the requests they belong to
 ✓ |@ai-office/shared| src/retention.test.ts > each kind of history > keeps the same minimum, and suggests retention's default, in Storage
 ✓ |@ai-office/shared| src/retention.test.ts > each kind of history > is suggested for PRD §7's periods
 ✓ |@ai-office/shared| src/retention.test.ts > a retention cutoff > is that many whole days before now
 ✓ |@ai-office/orchestrator| src/retention/retention.test.ts > retention's job > deletes bodies older than 7 days, records older than 90 and activity older than a year, by default
 ✓ |@ai-office/orchestrator| src/retention/retention.test.ts > retention's job > uses the periods the Owner set, read afresh each run
 ✓ |@ai-office/orchestrator| src/retention/retention.test.ts > retention's job > runs every rule even when one fails
 ✓ |@ai-office/orchestrator| src/retention/retention.test.ts > retention's job > runs at start, then every hour, with the clock as it is then
 ✓ |@ai-office/orchestrator| src/retention/retention.test.ts > retention's job > tells why a scheduled run could not start, and runs again later
 ↓ |@ai-office/orchestrator| src/storage/storage.test.ts > storage, in Postgres 18 > tells each kind's rows, size and oldest, and deletes only what is older [skipped: no Docker]
 ↓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > reads the log back newest first, a page at a time (the Activity Feed) [skipped: no Docker]
 ↓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > stores published events in order and delivers them to subscribers [skipped: no Docker]
 ↓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > redacts a secret placed in a payload in the stored row [skipped: no Docker]
 ↓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > reads back the events after an id, by Floor, Agent, issue and type [skipped: no Docker]
 ↓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > is append-only [skipped: no Docker]
 ✓ |@ai-office/events| src/store.test.ts > retention of events kept in memory > deletes the events before a cutoff, and only those
 ↓ |@ai-office/events| src/store.test.ts > retention of events in Postgres 18 > deletes the events before a cutoff, and only those [skipped: no Docker]
 ↓ |@ai-office/events| src/store.test.ts > retention of events in Postgres 18 > is still append-only outside retention [skipped: no Docker]
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > keeps the bodies sealed while body storage is on
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > keeps no bodies while body storage is off
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > keeps headers without credentials, and the timings
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > cuts a body longer than it keeps, and says so
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > redacts credentials in a body as it reads it back
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > searches, filters and pages, newest first
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > tells subscribers of new requests that match their filter
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > adds up the tokens of the requests in a period per Floor, Agent, issue and Owner tool, as their records say
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > deletes the bodies of requests started before a cutoff, keeping the requests (retention)
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > deletes requests started before a cutoff, still counting what they used, by the day (retention)
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > still adds up deleted requests for analytics, by the day (retention and the storage clean-up)
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > adds up requests per hour or day, AI Account, Model and caller for analytics, with their errors and latency
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > keeps the bodies sealed while body storage is on [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > keeps no bodies while body storage is off [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > keeps headers without credentials, and the timings [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > cuts a body longer than it keeps, and says so [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > redacts credentials in a body as it reads it back [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > searches, filters and pages, newest first [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > tells subscribers of new requests that match their filter [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > adds up the tokens of the requests in a period per Floor, Agent, issue and Owner tool, as their records say [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > deletes the bodies of requests started before a cutoff, keeping the requests (retention) [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > deletes requests started before a cutoff, still counting what they used, by the day (retention) [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > still adds up deleted requests for analytics, by the day (retention and the storage clean-up) [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > adds up requests per hour or day, AI Account, Model and caller for analytics, with their errors and latency [skipped: no Docker]
 ↓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > refuses a body that is not sealed [skipped: no Docker]
 ✓ |@ai-office/server| src/retention.test.ts > retention, kept in memory > deletes request and response bodies after 7 days, keeping the requests
 ✓ |@ai-office/server| src/retention.test.ts > retention, kept in memory > deletes requests' records and usage readings after 90 days, and Token Caps still count them
 ✓ |@ai-office/server| src/retention.test.ts > retention, kept in memory > deletes Activity Feed events, closed Notices and sign-ins after a year, keeping open Notices
 ✓ |@ai-office/server| src/retention.test.ts > retention, kept in memory > uses the periods the Owner sets in the office admin
 ↓ |@ai-office/server| src/retention.test.ts > retention, kept in Postgres 18 > deletes request and response bodies after 7 days, keeping the requests [skipped: no Docker]
 ↓ |@ai-office/server| src/retention.test.ts > retention, kept in Postgres 18 > deletes requests' records and usage readings after 90 days, and Token Caps still count them [skipped: no Docker]
 ↓ |@ai-office/server| src/retention.test.ts > retention, kept in Postgres 18 > deletes Activity Feed events, closed Notices and sign-ins after a year, keeping open Notices [skipped: no Docker]
 ↓ |@ai-office/server| src/retention.test.ts > retention, kept in Postgres 18 > uses the periods the Owner sets in the office admin [skipped: no Docker]
 ✓ |@ai-office/web| src/retention-card.test.tsx > retention in Admin > shows the defaults: 7 days, 90 days and a year
 ✓ |@ai-office/web| src/storage-card.test.tsx > the prompt-cache TTL in Admin > leaves TTLs as sent by default, and sets one with its button
 ✓ |@ai-office/web| src/retention-card.test.tsx > retention in Admin > sets each period
 ✓ |@ai-office/web| src/storage-card.test.tsx > storage in Admin > shows each history's size, and deletes the oldest once confirmed
 ✓ |@ai-office/web| src/storage-card.test.tsx > storage in Admin > deletes every request body when asked for 0 days
 ✓ |@ai-office/web| src/storage-card.test.tsx > storage in Admin > formats sizes
 ✓ |@ai-office/web| src/retention-card.test.tsx > retention in Admin > says what is wrong with periods it cannot take
 Test Files  8 passed (8)
      Tests  35 passed | 25 skipped (60)
```

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `e713845`, after the merge (`9629801`) and its follow-ups:
`0ae986e` (two stray `.orig` files removed), `945c595` (retention deletes
Connections' delivery logs) and `e713845` (a test of the Batches' prompt
check).

- **Migrations.** This branch keeps `0044_retention` and
  `0045_github_webhooks`. The merged branch's `0044_communications`,
  `0045_push_connections`, `0046_connection_detail_quiet_hours_digests`,
  `0047_batch_kickoff_wrap_up` and `0048_publishing_destinations` are
  replaced by one regenerated `0046_communications`, with their header
  comments, and `0047_connection_delivery_retention` follows it.
  `drizzle-kit generate` finds nothing more to generate. Neither migration
  has been applied to a real Postgres here (no Docker).

- **Connection delivery logs** (90 days in PRD §7), which this issue left
  to arrive with Connections, are now a fourth rule, **Connection
  deliveries** (`945c595`):
  - `connectionDeliveriesDays`, 90 by default and at least 1, in
    `retentionSettingsSchema`, Admin's Retention card and
    `office_settings.retention_connection_deliveries_days` (migration
    `0047_connection_delivery_retention`, within the same
    `office_settings_retention` check).
  - `deleteConnectionDeliveriesBefore` in `@ai-office/db` deletes only
    finished deliveries (delivered, failed or summarised). Retention calls
    it through the Communications store, and Storage calls it directly
    with its new **Connection deliveries** kind. A pending delivery is the
    outbound queue (FR-94), not its log, and stays however old.
  - The existing tests now cover the fourth rule: its default, its bounds,
    its cutoff in the job, its `config.changed` key, the Storage kind and
    its minimum, and the card's field. A new end-to-end case (memory, and
    Postgres on the host) deletes three finished deliveries and keeps the
    held one, which is still due.
- Storage's message for a minimum of one day now reads "the last day is
  always kept" rather than "the last 1 days".

### Output of the checks

```text
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  266 passed (266)
      Tests  3067 passed | 435 skipped (3502)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 435 skipped tests need what the sandbox lacks: 409 Postgres 18 and
3 Mailpit through Testcontainers (Docker), 10 Docker, hadolint or Caddy
for the deployment, and 13 the real GitHub App. They run on the host and
in CI.

The retention and Storage tests:

```text
 ✓ |@ai-office/shared| src/retention.test.ts > retention's settings > default to 7 days of bodies, 90 of metadata, a year of activity and 90 days of delivery logs
 ✓ |@ai-office/orchestrator| src/retention/retention.test.ts > retention's job > deletes bodies older than 7 days, records older than 90, activity older than a year and delivery logs older than 90 days, by default
 Test Files  6 passed (6)
      Tests  23 passed | 6 skipped (29)
```
